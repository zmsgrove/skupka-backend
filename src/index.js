require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const WAZZUP_API_KEY = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL_ID = process.env.WAZZUP_CHANNEL_ID;
const WAZZUP_API = 'https://api.wazzup24.ru/v3';

const CITY_ADDRESSES = {
  'Атырау': 'Каныша Сатпаева 32',
  'Актобе': 'Абулхаир Хана 21',
  'Уральск': 'Северо-Восток 47 или Курмангазы 162',
};

async function sendMessage(chatId, phone, text) {
  try {
    await axios.post(
      `${WAZZUP_API}/message`,
      { channelId: WAZZUP_CHANNEL_ID, chatType: 'whatsapp', chatId: phone, text },
      { headers: { 'Authorization': `Bearer ${WAZZUP_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Сообщение отправлено: ${phone}`);
  } catch (err) {
    console.error('❌ Ошибка отправки Wazzup:', err?.response?.data || err.message);
  }
}

async function saveMessage(leadId, text, direction, messageId = null, senderName = null) {
  await supabase.from('messages').insert({
    lead_id: leadId, wazzup_message_id: messageId,
    direction, text, sender_name: senderName,
  });
}

async function saveImageToStorage(imageUrl, messageId) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const fileName = `photos/${messageId || Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from('chat-images')
      .upload(fileName, buffer, { contentType, upsert: true });
    if (error) { console.error('❌ Storage error:', error); return imageUrl; }
    const { data: urlData } = supabase.storage.from('chat-images').getPublicUrl(fileName);
    console.log('📸 Фото сохранено:', urlData.publicUrl);
    return urlData.publicUrl;
  } catch (err) {
    console.error('❌ Image save error:', err.message);
    return imageUrl;
  }
}

async function handleBotStep(phone, chatId, messageText, messageId) {
  const text = messageText.trim();
  const { data: session } = await supabase
    .from('bot_sessions').select('*').eq('phone', phone).maybeSingle();
  console.log('🔍 Session step:', session?.step, '| Text:', text);

  if (session && session.step === 'done') {
    const { data: lead } = await supabase
      .from('leads').select('id').eq('wazzup_chat_id', chatId).single();
    if (lead) await saveMessage(lead.id, text, 'in', messageId);
    return;
  }

  if (!session) {
    await supabase.from('bot_sessions').insert({
      phone, wazzup_chat_id: chatId, step: 'ask_name',
      collected_name: null, collected_city: null,
    });
    await sendMessage(chatId, phone,
      `Здравствуйте! 👋 Вы обратились в *SKUPKA* — магазин по продаже и скупке техники.\n\nДля заявки ответьте на несколько вопросов.\n\nНапишите ваше *имя*:`
    );
    return;
  }

  if (session.step === 'ask_name') {
    console.log('💾 Saving name:', text);
    await supabase.from('bot_sessions')
      .update({ collected_name: text, step: 'ask_city' }).eq('phone', phone);
    await sendMessage(chatId, phone,
      `Приятно познакомиться, *${text}*! 😊\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`
    );
    return;
  }

  if (session.step === 'ask_city') {
    const normalized = text.toLowerCase().trim().replace('ё', 'е').replace(/[^а-яa-z]/g, '');
    const cityMap = {
      'атырау': 'Атырау', 'атыра': 'Атырау',
      'актобе': 'Актобе', 'актоб': 'Актобе',
      'уральск': 'Уральск', 'уралск': 'Уральск', 'уральс': 'Уральск', 'урал': 'Уральск',
    };
    const city = cityMap[normalized];
    if (!city) {
      await sendMessage(chatId, phone,
        `❗ Пожалуйста, напишите один из городов:\n\n• *Атырау*\n• *Актобе*\n• *Уральск*`
      );
      return;
    }
    await supabase.from('bot_sessions')
      .update({ collected_city: city, step: 'ask_device' }).eq('phone', phone);
    await sendMessage(chatId, phone,
      `Отлично! ✅\n\nНапишите что за технику вы хотите продать?\n\nПример: iPhone 13 Pro, Samsung Galaxy S21`
    );
    return;
  }

  if (session.step === 'ask_device') {
    const { collected_name: name, collected_city: city } = session;
    const { data: lead, error } = await supabase.from('leads').insert({
      client_name: name || 'Неизвестно',
      phone, device: text, city: city || 'Атырау',
      status: 'new', wazzup_chat_id: chatId,
    }).select().single();
    if (error) { console.error('❌ Lead error:', error); return; }
    await supabase.from('bot_sessions').update({ step: 'done' }).eq('phone', phone);
    await saveMessage(lead.id, `Имя: ${name}, Город: ${city}, Техника: ${text}`, 'in', messageId);
    await sendMessage(chatId, phone,
      `✅ Спасибо, *${name}*! Ваша заявка принята.\n\n📋 *Детали:*\n• Город: ${city}\n• Техника: ${text}\n\nНаш специалист свяжется с вами в ближайшее время! ⏳`
    );
    return;
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.status !== 'inbound') continue;
      if (msg.type !== 'text' && msg.type !== 'image') continue;
      const phone = msg.chatId;
      const chatId = msg.chatId;
      const messageId = msg.messageId;
      if (msg.type === 'image') {
        const savedUrl = await saveImageToStorage(msg.contentUri, messageId);
        const text = `📷 [Фото] ${savedUrl}`;
        const { data: session } = await supabase
          .from('bot_sessions').select('*').eq('phone', phone).maybeSingle();
        if (session && session.step === 'done') {
          const { data: lead } = await supabase
            .from('leads').select('id').eq('wazzup_chat_id', chatId).single();
          if (lead) await saveMessage(lead.id, text, 'in', messageId);
        }
        continue;
      }
      const text = (typeof msg.text === 'object' ? msg.text?.text : msg.text) || '';
      console.log(`📩 Входящее [${phone}]: ${text}`);
      await handleBotStep(phone, chatId, text, messageId);
    }
  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

app.get('/api/leads', async (req, res) => {
  const { city } = req.query;
  let query = supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (city) query = query.eq('city', city);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

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

app.patch('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const { send_estimate, ...updates } = req.body;
  console.log('📝 PATCH lead:', id, JSON.stringify(updates));
  const { data, error } = await supabase
    .from('leads').update(updates).eq('id', id).select().single();
  if (error) { console.error('❌ PATCH error:', error); return res.status(500).json({ error }); }
  if (updates.estimate_amount && send_estimate) {
    const amount = new Intl.NumberFormat('ru-KZ').format(updates.estimate_amount);
    const address = CITY_ADDRESSES[data.city] || 'наш пункт приёма';
    await sendMessage(data.wazzup_chat_id, data.phone,
      `Спасибо за ожидание, *${data.client_name}*! 👋\n\nМы оценили вашу технику: *${data.device}*\n\n💰 Предварительная стоимость: *${amount} ₸*\n\nЕсли вас устраивает цена — ждем вас по адресу: *${address}*\n\nЕсли есть вопросы — напишите нам, мы готовы помочь! 😊`
    );
  }
  res.json(data);
});

app.post('/api/leads/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { author, text } = req.body;
  const { data, error } = await supabase.from('comments')
    .insert({ lead_id: id, author, text }).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/leads/:id/send', async (req, res) => {
  const { id } = req.params;
  const { text, author } = req.body;
  const { data: lead } = await supabase.from('leads').select('*').eq('id', id).single();
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  await sendMessage(lead.wazzup_chat_id, lead.phone, text);
  await saveMessage(id, text, 'out', null, author);
  res.json({ ok: true });
});

app.get('/ping', (req, res) => res.send('pong'));

app.post('/setup-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  try {
    await axios.patch(
      `${WAZZUP_API}/webhooks`,
      { webhooksUri: webhookUrl, subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: true } },
      { headers: { 'Authorization': `Bearer ${WAZZUP_API_KEY}` } }
    );
    res.json({ ok: true, message: 'Webhook настроен!' });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('💥 Server error:', err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 SKUPKA Backend запущен на порту ${PORT}`);
});
