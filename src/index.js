require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use((req, res, next) => { console.log(`➡️ ${req.method} ${req.url}`); next(); });
app.use(cors({ origin:'*', methods:['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.options('*', cors());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const WAZZUP_API_KEY = process.env.WAZZUP_API_KEY;
const WAZZUP_CHANNEL_ID = process.env.WAZZUP_CHANNEL_ID;
const WAZZUP_API = 'https://api.wazzup24.ru/v3';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CITY_ADDRESSES = {
  'Атырау': 'Каныша Сатпаева 32',
  'Актобе': 'Абулхаир Хана 21',
  'Уральск': 'Северо-Восток 47 или Курмангазы 162',
};

// ─── Отправка в WhatsApp ──────────────────────────────────────────────────
async function sendMessage(chatId, phone, text) {
  try {
    await axios.post(`${WAZZUP_API}/message`,
      { channelId: WAZZUP_CHANNEL_ID, chatType: 'whatsapp', chatId: phone, text },
      { headers: { 'Authorization': `Bearer ${WAZZUP_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Отправлено: ${phone}`);
  } catch (err) { console.error('❌ Wazzup error:', err?.response?.data || err.message); }
}

// ─── Сохранение сообщения в БД ────────────────────────────────────────────
async function saveMessage(leadId, text, direction, messageId = null, senderName = null) {
  await supabase.from('messages').insert({
    lead_id: leadId, wazzup_message_id: messageId,
    direction, text, sender_name: senderName,
  });
}

// ─── Отправка + сохранение (для бота) ────────────────────────────────────
async function botSend(leadId, chatId, phone, text) {
  await sendMessage(chatId, phone, text);
  if (leadId) await saveMessage(leadId, text, 'out', null, 'Бот SKUPKA');
}

// ─── Telegram уведомление ─────────────────────────────────────────────────
async function sendTelegramNotification(lead) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const cityEmoji = { 'Атырау': '🟡', 'Актобе': '🔵', 'Уральск': '🟣' };
  const text = `${cityEmoji[lead.city] || '🟢'} *Новая заявка!*\n\n` +
    `👤 *Имя:* ${lead.client_name}\n` +
    `📱 *Техника:* ${lead.device}\n` +
    `🏙️ *Город:* ${lead.city}\n` +
    `📞 *Телефон:* ${lead.phone}\n` +
    `🕐 *Время:* ${now}`;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown',
    });
    console.log('📱 TG уведомление отправлено');
  } catch (err) { console.error('❌ TG error:', err?.response?.data || err.message); }
}

// ─── Бот: шаги ───────────────────────────────────────────────────────────
async function handleBotStep(phone, chatId, messageText, messageId) {
  const text = messageText.trim();
  const { data: session } = await supabase
    .from('bot_sessions').select('*').eq('phone', phone).maybeSingle();
  console.log('🔍 Step:', session?.step, '| Text:', text);

  // Уже завершённая сессия — сохраняем входящее сообщение
  if (session && session.step === 'done') {
    const { data: lead } = await supabase
      .from('leads').select('id').eq('wazzup_chat_id', chatId).single();
    if (lead) {
      await saveMessage(lead.id, text, 'in', messageId);
      await supabase.rpc('increment_unread', { lead_id: lead.id });
    }
    return;
  }

  // Новый пользователь
  if (!session) {
    await supabase.from('bot_sessions').insert({
      phone, wazzup_chat_id: chatId, step: 'ask_name',
      collected_name: null, collected_city: null,
    });
    const msg = `Здравствуйте! 👋 Вы обратились в *SKUPKA* — магазин по продаже и скупке техники.\n\nДля заявки ответьте на несколько вопросов.\n\nНапишите ваше *имя*:`;
    await sendMessage(chatId, phone, msg);
    // Сохраняем без lead_id — создадим запись когда получим все данные
    return;
  }

  if (session.step === 'ask_name') {
    await supabase.from('bot_sessions')
      .update({ collected_name: text, step: 'ask_city' }).eq('phone', phone);
    const msg = `Приятно познакомиться, *${text}*! 😊\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`;
    await sendMessage(chatId, phone, msg);
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
      await sendMessage(chatId, phone, `❗ Пожалуйста, напишите один из городов:\n\n• *Атырау*\n• *Актобе*\n• *Уральск*`);
      return;
    }
    await supabase.from('bot_sessions')
      .update({ collected_city: city, step: 'ask_device' }).eq('phone', phone);
    const msg = `Отлично! ✅\n\nНапишите что за технику вы хотите продать?\n\nПример: iPhone 13 Pro, Samsung Galaxy S21`;
    await sendMessage(chatId, phone, msg);
    return;
  }

  if (session.step === 'ask_device') {
    const { collected_name: name, collected_city: city } = session;

    // Создаём карточку
    const { data: lead, error } = await supabase.from('leads').insert({
      client_name: name || 'Неизвестно',
      phone, device: text, city: city || 'Атырау',
      status: 'new', wazzup_chat_id: chatId, unread_count: 0,
    }).select().single();

    if (error) { console.error('❌ Lead error:', error); return; }

    await supabase.from('bot_sessions').update({ step: 'done' }).eq('phone', phone);

    // Сохраняем всю переписку бота в чат карточки
    await saveMessage(lead.id, `Здравствуйте! 👋 Вы обратились в SKUPKA — магазин по продаже и скупке техники.\n\nДля заявки ответьте на несколько вопросов.\n\nНапишите ваше имя:`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, name, 'in', null);
    await saveMessage(lead.id, `Приятно познакомиться, ${name}! 😊\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, city, 'in', null);
    await saveMessage(lead.id, `Отлично! ✅\n\nНапишите что за технику вы хотите продать?`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, text, 'in', messageId);

    // Подтверждение клиенту
    const confirmMsg = `✅ Спасибо, *${name}*! Ваша заявка принята.\n\n📋 *Детали:*\n• Город: ${city}\n• Техника: ${text}\n\nНаш специалист свяжется с вами в ближайшее время! ⏳`;
    await saveMessage(lead.id, confirmMsg, 'out', null, 'Бот SKUPKA');
    await sendMessage(chatId, phone, confirmMsg);

    // Telegram уведомление
    await sendTelegramNotification(lead);

    return;
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.status !== 'inbound') continue;
      if (msg.type !== 'text' && msg.type !== 'image') continue;
      const phone = msg.chatId, chatId = msg.chatId, messageId = msg.messageId;
      if (msg.type === 'image') {
        const text = `📷 [Фото] ${msg.contentUri}`;
        const { data: session } = await supabase
          .from('bot_sessions').select('*').eq('phone', phone).maybeSingle();
        if (session?.step === 'done') {
          const { data: lead } = await supabase
            .from('leads').select('id').eq('wazzup_chat_id', chatId).single();
          if (lead) {
            await saveMessage(lead.id, text, 'in', messageId);
            await supabase.rpc('increment_unread', { lead_id: lead.id });
          }
        }
        continue;
      }
      const text = (typeof msg.text === 'object' ? msg.text?.text : msg.text) || '';
      console.log(`📩 [${phone}]: ${text}`);
      await handleBotStep(phone, chatId, text, messageId);
    }
  } catch (err) { console.error('❌ Webhook error:', err); }
});

// ─── LEADS API ────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const { city, archived } = req.query;
  let query = supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (city) query = query.eq('city', city);
  if (archived === 'true') query = query.eq('is_archived', true).eq('is_deleted', false);
  else query = query.eq('is_archived', false).eq('is_deleted', false);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const { data: lead, error } = await supabase.from('leads').select('*').eq('id', id).single();
  if (error) return res.status(404).json({ error });
  const { data: messages } = await supabase.from('messages').select('*').eq('lead_id', id).order('created_at');
  const { data: comments } = await supabase.from('comments').select('*').eq('lead_id', id).order('created_at');
  res.json({ ...lead, messages: messages || [], comments: comments || [] });
});

app.patch('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const { send_estimate, ...updates } = req.body;
  console.log('📝 PATCH:', id, JSON.stringify(updates));
  const { data, error } = await supabase.from('leads').update(updates).eq('id', id).select().single();
  if (error) { console.error('❌ PATCH error:', error); return res.status(500).json({ error }); }
  if (updates.estimate_amount && send_estimate) {
    const amount = new Intl.NumberFormat('ru-KZ').format(updates.estimate_amount);
    const address = CITY_ADDRESSES[data.city] || 'наш пункт приёма';
    const msg = `Спасибо за ожидание, *${data.client_name}*! 👋\n\nМы оценили вашу технику: *${data.device}*\n\n💰 Предварительная стоимость: *${amount} ₸*\n\nЕсли устраивает — ждём по адресу: *${address}*\n\nЕсть вопросы — пишите! 😊`;
    await sendMessage(data.wazzup_chat_id, data.phone, msg);
    await saveMessage(id, msg, 'out', null, 'Сотрудник');
  }
  res.json(data);
});

app.delete('/api/leads/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('leads')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/leads/:id/restore', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('leads')
    .update({ is_deleted: false, deleted_at: null }).eq('id', id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/leads/:id/read', async (req, res) => {
  await supabase.from('leads').update({ unread_count: 0 }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/leads/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { author, text, pinned } = req.body;
  const { data, error } = await supabase.from('comments')
    .insert({ lead_id: id, author, text, pinned: pinned || false }).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.patch('/api/comments/:id', async (req, res) => {
  const { data, error } = await supabase.from('comments')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/leads/:id/send', async (req, res) => {
  const { id } = req.params;
  const { text, author } = req.body;
  const { data: lead } = await supabase.from('leads').select('*').eq('id', id).single();
  if (!lead) return res.status(404).json({ error: 'Not found' });
  await sendMessage(lead.wazzup_chat_id, lead.phone, text);
  await saveMessage(id, text, 'out', null, author);
  res.json({ ok: true });
});

// ─── STATS API ────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { city } = req.query;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);

  let query = supabase.from('leads').select('*').eq('is_deleted', false).eq('is_archived', false);
  if (city) query = query.eq('city', city);
  const { data: all } = await query;
  if (!all) return res.json({});

  const today = all.filter(l => {
    const d = new Date(l.updated_at || l.created_at);
    return d >= todayStart && d <= todayEnd;
  });

  const byCity = {};
  ['Атырау','Актобе','Уральск'].forEach(c => {
    const cl = today.filter(l => l.city === c);
    const succ = cl.filter(l => l.status === 'success');
    const amount = succ.reduce((s,l) => s+(Number(l.estimate_amount)||0), 0);
    byCity[c] = {
      total: cl.length, success: succ.length,
      fail: cl.filter(l => l.status==='fail').length,
      inProgress: cl.filter(l => l.status==='in_progress').length,
      waiting: cl.filter(l => l.status==='waiting').length,
      amount, conversion: cl.length>0 ? Math.round(succ.length/cl.length*100) : 0,
      avgCheck: succ.length>0 ? Math.round(amount/succ.length) : 0,
    };
  });

  const successAll = today.filter(l => l.status==='success');
  const totalAmount = successAll.reduce((s,l) => s+(Number(l.estimate_amount)||0), 0);

  // По дням (30 дней)
  const byDay = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
    const key = d.toISOString().split('T')[0];
    const dayLeads = all.filter(l => {
      const ld = new Date(l.created_at); ld.setHours(0,0,0,0);
      return ld.toISOString().split('T')[0] === key;
    });
    byDay[key] = {
      total: dayLeads.length,
      success: dayLeads.filter(l=>l.status==='success').length,
      amount: dayLeads.filter(l=>l.status==='success').reduce((s,l)=>s+(Number(l.estimate_amount)||0),0),
    };
  }

  const failReasons = {};
  all.filter(l=>l.status==='fail'&&l.fail_comment).forEach(l => {
    failReasons[l.fail_comment] = (failReasons[l.fail_comment]||0)+1;
  });

  const overdue = all.filter(l => l.status==='in_progress' &&
    (Date.now()-new Date(l.updated_at||l.created_at).getTime()) > 10*3600*1000
  ).length;

  res.json({
    total: today.length, success: successAll.length,
    fail: today.filter(l=>l.status==='fail').length,
    new: today.filter(l=>l.status==='new').length,
    inProgress: all.filter(l=>l.status==='in_progress').length,
    waiting: all.filter(l=>l.status==='waiting').length,
    totalAmount, avgCheck: successAll.length>0?Math.round(totalAmount/successAll.length):0,
    conversion: today.length>0?Math.round(successAll.length/today.length*100):0,
    byCity, byDay, failReasons, overdue,
  });
});

// ─── EXPORT API ───────────────────────────────────────────────────────────
app.get('/api/export', async (req, res) => {
  const { city, from, to } = req.query;
  let query = supabase.from('leads').select('*').eq('is_deleted', false).order('created_at', { ascending: false });
  if (city) query = query.eq('city', city);
  if (from) query = query.gte('created_at', new Date(from).toISOString());
  if (to) { const toDate = new Date(to); toDate.setHours(23,59,59,999); query = query.lte('created_at', toDate.toISOString()); }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ─── CRON: возврат из провала ─────────────────────────────────────────────
app.post('/cron/revive-fails', async (req, res) => {
  const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate()-14);
  const { data: fails } = await supabase.from('leads').select('*')
    .eq('status','fail').eq('is_deleted',false).lt('updated_at', twoWeeksAgo.toISOString());
  if (!fails||fails.length===0) return res.json({ revived: 0 });
  for (const lead of fails) {
    await supabase.from('leads').update({
      status:'in_progress', fail_comment:null, revived_from_fail:true,
      updated_at: new Date().toISOString(),
    }).eq('id', lead.id);
    await supabase.from('comments').insert({
      lead_id: lead.id, author:'Система', pinned:true,
      text:'♻️ Повторный контакт — клиент ранее был в провале. Свяжитесь и уточните актуальность.',
    });
  }
  console.log(`♻️ Revived ${fails.length} leads`);
  res.json({ revived: fails.length });
});

// ─── CRON: архивирование ──────────────────────────────────────────────────
app.post('/cron/archive-old', async (req, res) => {
  const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3);
  await supabase.from('leads').update({ is_archived: true })
    .in('status',['success','fail']).lt('updated_at', threeMonthsAgo.toISOString())
    .eq('is_archived',false).eq('is_deleted',false);
  res.json({ ok: true });
});

app.get('/ping', (req, res) => res.send('pong'));

app.post('/setup-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  try {
    await axios.patch(`${WAZZUP_API}/webhooks`,
      { webhooksUri: webhookUrl, subscriptions: { messagesAndStatuses:true, contactsAndDealsCreation:true } },
      { headers: { 'Authorization': `Bearer ${WAZZUP_API_KEY}` } }
    );
    res.json({ ok: true, message: 'Webhook настроен!' });
  } catch (err) { res.status(500).json({ error: err?.response?.data||err.message }); }
});

app.use((err, req, res, next) => { console.error('💥 Error:', err); res.status(500).json({ error: err.message }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 SKUPKA Backend на порту ${PORT}`));
