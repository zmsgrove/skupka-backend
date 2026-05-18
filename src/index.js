require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

// Supabase клиент
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Wazzup конфиг
const WAZZUP_API_KEY = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL_ID = process.env.WAZZUP_CHANNEL_ID;
const WAZZUP_API = 'https://api.wazzup24.ru/v3';

// ─── Отправка сообщения через Wazzup ───────────────────────────────────────
async function sendMessage(chatId, phone, text) {
  try {
    await axios.post(
      `${WAZZUP_API}/message`,
      {
        channelId: WAZZUP_CHANNEL_ID,
        chatType: 'whatsapp',
        chatId: phone,
        text: text,
      },
      {
        headers: {
          'Authorization': `Bearer ${WAZZUP_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`✅ Сообщение отправлено: ${phone}`);
  } catch (err) {
    console.error('❌ Ошибка отправки Wazzup:', err?.response?.data || err.message);
  }
}

// ─── Сохранение входящего сообщения в БД ───────────────────────────────────
async function saveMessage(leadId, text, direction, messageId = null, senderName = null) {
  await supabase.from('messages').insert({
    lead_id: leadId,
    wazzup_message_id: messageId,
    direction,
    text,
    sender_name: senderName,
  });
}

// ─── Бот: обработка шагов ─────────────────────────────────────────────────
async function handleBotStep(phone, chatId, messageText, messageId) {
  const text = messageText.trim();

  // Получить текущую сессию
  const { data: session } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('phone', phone)
    .single();

  // Проверить есть ли уже завершённая заявка (статус done)
  if (session && session.step === 'done') {
    // Уже есть заявка — найти lead и сохранить сообщение
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('wazzup_chat_id', chatId)
      .single();

    if (lead) {
      await saveMessage(lead.id, text, 'in', messageId);
    }
    return;
  }

  // ── Шаг START: первое сообщение ──
  if (!session || session.step === 'start') {
    // Создать или обновить сессию
    await supabase.from('bot_sessions').upsert({
      phone,
      wazzup_chat_id: chatId,
      step: 'ask_name',
    }, { onConflict: 'phone' });

    await sendMessage(chatId, phone,
      `Здравствуйте! 👋 Вы обратились в *SKUPKA* — пункт скупки техники.\n\nДля оформления заявки ответьте на несколько вопросов.\n\nНапишите ваше *имя*:`
    );
    return;
  }

  // ── Шаг ASK_NAME: получили имя ──
  if (session.step === 'ask_name') {
    await supabase.from('bot_sessions').update({
      collected_name: text,
      step: 'ask_city',
    }).eq('phone', phone);

    await sendMessage(chatId, phone,
      `Приятно познакомиться, *${text}*! 😊\n\nНапишите ваш *город*:\n\n• Атырау\n• Актобе\n• Уральск`
    );
    return;
  }

  // ── Шаг ASK_CITY: получили город ──
  if (session.step === 'ask_city') {
    const cityMap = {
      'атырау': 'Атырау',
      'актобе': 'Актобе',
      'уральск': 'Уральск',
    };
    const cityKey = text.toLowerCase();
    const city = cityMap[cityKey];

    if (!city) {
      await sendMessage(chatId, phone,
        `❗ Пожалуйста, напишите один из городов:\n\n• *Атырау*\n• *Актобе*\n• *Уральск*`
      );
      return;
    }

    await supabase.from('bot_sessions').update({
      collected_city: city,
      step: 'ask_device',
    }).eq('phone', phone);

    await sendMessage(chatId, phone,
      `Отлично! Город *${city}* принят. ✅\n\nНапишите что за *техника* вы хотите продать?\n\n_Пример: iPhone 13 Pro, Samsung Galaxy S21, ноутбук Dell и т.д._`
    );
    return;
  }

  // ── Шаг ASK_DEVICE: получили технику — создаём заявку ──
  if (session.step === 'ask_device') {
    const device = text;
    const { collected_name: name, collected_city: city } = session;

    // Создать lead
    const { data: lead, error } = await supabase.from('leads').insert({
      client_name: name,
      phone: phone,
      device: device,
      city: city,
      status: 'new',
      wazzup_chat_id: chatId,
    }).select().single();

    if (error) {
      console.error('❌ Ошибка создания lead:', error);
      await sendMessage(chatId, phone,
        `Произошла ошибка. Пожалуйста, напишите нам позже.`
      );
      return;
    }

    // Обновить сессию
    await supabase.from('bot_sessions').update({
      step: 'done',
    }).eq('phone', phone);

    // Сохранить историю бота как первые сообщения
    await saveMessage(lead.id, `[БОТ] Имя: ${name}, Город: ${city}, Техника: ${device}`, 'in', messageId);

    await sendMessage(chatId, phone,
      `✅ Спасибо, *${name}*! Ваша заявка принята.\n\n📋 *Детали заявки:*\n• Город: ${city}\n• Техника: ${device}\n\nНаш специалист свяжется с вами в ближайшее время для оценки. ⏳`
    );
    return;
  }
}

// ─── WEBHOOK от Wazzup ─────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Wazzup ждёт быстрый ответ

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return;

    for (const msg of messages) {
      // Только входящие сообщения (от клиента)
      if (msg.status !== 'received') continue;
      if (msg.type !== 'text') continue;

      const phone = msg.chatId;
      const chatId = msg.chatId;
      const text = msg.text?.text || '';
      const messageId = msg.id;

      console.log(`📩 Входящее [${phone}]: ${text}`);

      await handleBotStep(phone, chatId, text, messageId);
    }
  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

// ─── API: получить все лиды ────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const { city } = req.query;
  let query = supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (city) query = query.eq('city', city);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ─── API: получить один лид с сообщениями и комментариями ──────────────────
app.get('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const { data: lead, error } = await supabase
    .from('leads').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error });

  const { data: messages } = await supabase
    .from('messages').select('*').eq('lead_id', id).order('created_at');

  const { data: comments } = await supabase
    .from('comments').select('*').eq('lead_id', id).order('created_at');

  res.json({ ...lead, messages: messages || [], comments: comments || [] });
});

// ─── API: обновить статус лида ─────────────────────────────────────────────
app.patch('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const { data, error } = await supabase
    .from('leads').update(updates).eq('id', id).select().single();

  if (error) return res.status(500).json({ error });

  // Если отправляем оценку клиенту
  if (updates.estimate_amount && updates.send_estimate) {
    const lead = data;
    const amount = new Intl.NumberFormat('ru-KZ').format(updates.estimate_amount);
    await sendMessage(lead.wazzup_chat_id, lead.phone,
      `Здравствуйте, *${lead.client_name}*! 👋\n\nМы оценили вашу технику: *${lead.device}*\n\n💰 Предварительная стоимость: *${amount} ₸*\n\nЕсли вас устраивает цена — приходите в наш пункт приёма.\nЕсли есть вопросы — напишите нам, мы готовы помочь! 😊`
    );
  }

  res.json(data);
});

// ─── API: добавить комментарий ─────────────────────────────────────────────
app.post('/api/leads/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { author, text } = req.body;

  const { data, error } = await supabase.from('comments').insert({
    lead_id: id,
    author,
    text,
  }).select().single();

  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ─── API: отправить сообщение клиенту из CRM ──────────────────────────────
app.post('/api/leads/:id/send', async (req, res) => {
  const { id } = req.params;
  const { text, author } = req.body;

  const { data: lead } = await supabase
    .from('leads').select('*').eq('id', id).single();

  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  await sendMessage(lead.wazzup_chat_id, lead.phone, text);

  // Сохранить исходящее сообщение
  await saveMessage(id, text, 'out', null, author);

  res.json({ ok: true });
});

// ─── Ping для keep-alive (Render не засыпал) ──────────────────────────────
app.get('/ping', (req, res) => res.send('pong'));

// ─── Настройка вебхука в Wazzup ────────────────────────────────────────────
app.post('/setup-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  try {
    await axios.patch(
      `${WAZZUP_API}/webhooks`,
      {
        webhooksUri: webhookUrl,
        subscriptions: {
          messagesAndStatuses: true,
          contactsAndDealsCreation: true
        }
      },
      { headers: { 'Authorization': `Bearer ${WAZZUP_API_KEY}` } }
    );
    res.json({ ok: true, message: 'Webhook настроен!' });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 SKUPKA Backend запущен на порту ${PORT}`);
});
