require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // fallback

const TG_CITY_CHATS = {
  'Атырау': process.env.TELEGRAM_CHAT_ID_ATYRAU || process.env.TELEGRAM_CHAT_ID,
  'Актобе': process.env.TELEGRAM_CHAT_ID_AKTOBE || process.env.TELEGRAM_CHAT_ID,
  'Уральск': process.env.TELEGRAM_CHAT_ID_URALSK || process.env.TELEGRAM_CHAT_ID,
};

const CITY_ADDRESSES = {
  'Атырау': 'Каныша Сатпаева 32',
  'Актобе': 'Абулхаир Хана 21',
  'Уральск': 'Северо-Восток 47 или Курмангазы 162',
};

const SHOP_ADDRESSES = {
  'Уральск': 'Курмангазы 162 и Северо-Восток 47',
  'Атырау': 'Каныша Сатпаева 32',
  'Актобе': 'Абулхаир хана 21',
};

const CITY_MAP = {
  'ура':'Уральск','ора':'Уральск','орa':'Уральск',
  'орал':'Уральск','уралл':'Уральск','уралс':'Уральск',
  'урал':'Уральск','уральс':'Уральск','уральск':'Уральск',
  'уралск':'Уральск','уральк':'Уральск','оралл':'Уральск',
  'орол':'Уральск','oral':'Уральск','ural':'Уральск',
  'аты':'Атырау','атыр':'Атырау','атыра':'Атырау',
  'атырай':'Атырау','атырао':'Атырау','атырав':'Атырау',
  'атырау':'Атырау','атырауу':'Атырау','atyrau':'Атырау',
  'гурьев':'Атырау',
  'акт':'Актобе','акто':'Актобе','актоб':'Актобе',
  'актобе':'Актобе','актобэ':'Актобе','актобее':'Актобе',
  'актбое':'Актобе','актюб':'Актобе','актюбе':'Актобе',
  'актюбинск':'Актобе','актюбэ':'Актобе','aqtobe':'Актобе',
};

function isWorkingHours() {
  const now = new Date();
  const kzHour = (now.getUTCHours() + 5) % 24;
  return kzHour >= 9 && kzHour < 21;
}

function isNightTime() {
  const kzHour = (new Date().getUTCHours() + 5) % 24;
  return kzHour >= 22 || kzHour < 9;
}

function detectLang(text) {
  return /[әіңғүұқөһ]/i.test(text) ? 'kz' : 'ru';
}

function kzTime() {
  const d = new Date(Date.now() + 5*3600*1000);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

async function parseClientMessage(text) {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role:'user', content:`Из сообщения клиента извлеки JSON без markdown:\n{"device":"модель или null","description":"состояние/АКБ/повреждения или null","city":"Атырау/Актобе/Уральск или null","language":"ru или kz"}\n\nСообщение: "${text.slice(0,300)}"` }],
    });
    const raw = (resp.content[0]?.text || '{}').replace(/```[a-z]*/g,'').replace(/```/g,'').trim();
    return JSON.parse(raw);
  } catch {
    return { device: null, description: null, city: null, language: detectLang(text) };
  }
}

async function sendTelegramNewLeadV2(lead, description, isNight) {
  const msg = `🏪 *SKUPKA CRM* — Новая заявка!\n\n` +
    `👤 *Клиент:* ${lead.client_name}\n` +
    `📱 *Техника:* ${lead.device}\n` +
    `📝 *Описание:* ${description || 'не указано'}\n` +
    `📍 *Город:* ${lead.city}\n` +
    `📞 *Телефон:* ${lead.phone}\n` +
    `🕐 *Время:* ${kzTime()}\n` +
    `💬 *Источник:* WhatsApp` +
    (isNight ? '\n🌙 *Ночная заявка*' : '');

  if (lead.city && TG_CITY_CHATS[lead.city]) {
    await tg(msg, lead.city);
  } else {
    for (const city of ['Атырау','Актобе','Уральск']) await tg(msg, city);
  }
}

function normalizeCityText(text) {
  const norm = text.toLowerCase().replace(/ё/g,'е').replace(/[^а-яa-zәіңғүұқөһ]/gi,'');
  if (CITY_MAP[norm]) return CITY_MAP[norm];
  for (const [key, val] of Object.entries(CITY_MAP)) {
    if (norm.includes(key) || key.startsWith(norm.slice(0,3))) return val;
  }
  return null;
}

async function sendMessage(chatId, phone, text) {
  try {
    await axios.post(`${WAZZUP_API}/message`,
      { channelId: WAZZUP_CHANNEL_ID, chatType: 'whatsapp', chatId: phone, text },
      { headers: { 'Authorization': `Bearer ${WAZZUP_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Отправлено: ${phone}`);
  } catch (err) { console.error('❌ Wazzup error:', err?.response?.data || err.message); }
}

async function saveMessage(leadId, text, direction, messageId = null, senderName = null) {
  if (!leadId) return;
  await supabase.from('messages').insert({
    lead_id: leadId, wazzup_message_id: messageId,
    direction, text, sender_name: senderName,
  });
}

async function tg(text, city) {
  if (!TG_TOKEN) return;
  const chatId = (city && TG_CITY_CHATS[city]) ? TG_CITY_CHATS[city] : TG_CHAT_ID;
  if (!chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'Markdown',
    });
  } catch (err) { console.error('❌ TG error:', err?.response?.data || err.message); }
}

async function sendTelegramNewLead(lead) {
  const cityEmoji = { 'Атырау':'🟡', 'Актобе':'🔵', 'Уральск':'🟣' };
  const now = new Date();
  const kzTime = new Date(now.getTime() + 5*60*60*1000);
  const time = kzTime.toTimeString().slice(0,5);
  await tg(
    `${cityEmoji[lead.city]||'🟢'} *Новая заявка!*\n\n` +
    `👤 *Имя:* ${lead.client_name}\n` +
    `📱 *Техника:* ${lead.device}\n` +
    `🏙️ *Город:* ${lead.city}\n` +
    `📞 *Телефон:* ${lead.phone}\n` +
    `🕐 *Время:* ${time}`,
    lead.city
  );
}

// ─── Проверка нужна ли новая заявка ──────────────────────────────────────
async function shouldCreateNewLead(phone) {
  const { data: lastLead } = await supabase
    .from('leads').select('*').eq('phone', phone)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(1).single();

  if (!lastLead) return { create: true, lead: null };

  const closedStatuses = ['success', 'fail'];
  if (closedStatuses.includes(lastLead.status) || lastLead.is_archived) {
    return { create: true, lead: lastLead };
  }

  const lastMessageTime = new Date(lastLead.updated_at || lastLead.created_at);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  if (lastMessageTime < twoDaysAgo) {
    return { create: true, lead: lastLead };
  }

  return { create: false, lead: lastLead };
}

// ─── УМНЫЙ БОТ v2.2.6 ────────────────────────────────────────────────────
// Requires bot_sessions columns: handed_over(bool), last_bot_reply_at(ts),
// msg_count_since_reply(int), lang(text), collected_device(text), collected_description(text)
async function handleBotStep(phone, chatId, messageText, messageId, waName) {
  const text = (messageText || '').trim();
  if (!text) return;

  const { data: session } = await supabase.from('bot_sessions').select('*').eq('phone', phone).maybeSingle();

  // Если бот передан сотруднику — молчим, только сохраняем
  if (session?.handed_over) {
    const { create, lead } = await shouldCreateNewLead(phone);
    if (!create && lead) {
      await saveMessage(lead.id, text, 'in', messageId);
      await supabase.rpc('increment_unread', { lead_id: lead.id });
    }
    return;
  }

  // Анти-спам: если клиент написал 5+ сообщений подряд без ответа — тихо сохраняем
  if (session) {
    const cnt = (session.msg_count_since_reply || 0) + 1;
    await supabase.from('bot_sessions').update({ msg_count_since_reply: cnt }).eq('phone', phone);
    if (cnt > 5) {
      const { create, lead } = await shouldCreateNewLead(phone);
      if (!create && lead) {
        await saveMessage(lead.id, text, 'in', messageId);
        await supabase.rpc('increment_unread', { lead_id: lead.id });
      }
      return;
    }
  }

  const lang = session?.lang || detectLang(text);
  console.log('🔍 Bot step:', session?.step, '| lang:', lang, '| text:', text.slice(0,60));

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const botReply = async (textRu, textKz) => {
    const out = lang === 'kz' ? (textKz || textRu) : textRu;
    await delay(2000);
    await sendMessage(chatId, phone, out);
    await supabase.from('bot_sessions').update({ last_bot_reply_at: new Date().toISOString(), msg_count_since_reply: 0 }).eq('phone', phone);
    return out;
  };

  // ── Сессия завершена (done) ──
  if (session?.step === 'done') {
    const { create, lead: existingLead } = await shouldCreateNewLead(phone);
    if (!create && existingLead) {
      // Активная карточка — сохраняем, не плодим
      await saveMessage(existingLead.id, text, 'in', messageId);
      await supabase.rpc('increment_unread', { lead_id: existingLead.id });
      return;
    }
    // Карточка закрыта — начинаем новый диалог
    await supabase.from('bot_sessions').update({ step: 'ask_device', first_message: text, collected_city: null, msg_count_since_reply: 0 }).eq('phone', phone);
    await botReply(
      `Привет! 👋 Хотите продать технику? Напишите что именно у вас есть.`,
      `Сәлем! 👋 Техника сатқыңыз келе ме? Қандай техника барын жазыңыз.`
    );
    return;
  }

  // ── Нет сессии — новый пользователь ──
  if (!session) {
    const parsed = await parseClientMessage(text);
    const detectedCity = parsed.city ? normalizeCityText(parsed.city) : null;
    const detectedLang = parsed.language || lang;
    const device = parsed.device || text.slice(0,200);

    await supabase.from('bot_sessions').insert({
      phone, wazzup_chat_id: chatId,
      step: detectedCity ? 'ask_city_confirm' : 'ask_city',
      first_message: text,
      collected_city: detectedCity || null,
      collected_name: waName || null,
      lang: detectedLang,
      msg_count_since_reply: 0,
    });

    if (detectedCity) {
      // Клиент написал и устройство, и город сразу — создаём лид
      await createLeadAndFinish({ phone, chatId, waName, firstMessage: text, device, description: parsed.description, city: detectedCity, lang: detectedLang, messageId });
      return;
    }

    await botReply(
      `Привет! 👋 Хотите продать технику? Отлично! В каком городе вам удобно — Атырау, Актобе или Уральск?`,
      `Сәлем! 👋 Техника сатқыңыз келе ме? Тамаша! Қай қалада ыңғайлы — Атырау, Ақтөбе немесе Орал?`
    );
    await supabase.from('bot_sessions').update({ step: 'ask_city' }).eq('phone', phone);
    return;
  }

  // ── Шаг ask_device (повторный клиент) ──
  if (session.step === 'ask_device') {
    const parsed = await parseClientMessage(text);
    const detectedCity = parsed.city ? normalizeCityText(parsed.city) : null;
    const detectedLang = parsed.language || lang;
    const device = parsed.device || text.slice(0,200);

    await supabase.from('bot_sessions').update({ lang: detectedLang }).eq('phone', phone);

    if (detectedCity) {
      await createLeadAndFinish({ phone, chatId, waName, firstMessage: session.first_message || text, device, description: parsed.description, city: detectedCity, lang: detectedLang, messageId });
      return;
    }

    await botReply(
      `Отлично! В каком городе вам удобно — Атырау, Актобе или Уральск?`,
      `Жақсы! Қай қалада ыңғайлы — Атырау, Ақтөбе немесе Орал?`
    );
    await supabase.from('bot_sessions').update({ step: 'ask_city', collected_device: device, collected_description: parsed.description || null }).eq('phone', phone);
    return;
  }

  // ── Шаг ask_city ──
  if (session.step === 'ask_city') {
    const city = normalizeCityText(text);
    if (!city) {
      await botReply(
        `Пожалуйста, напишите один из городов: Атырау, Актобе или Уральск`,
        `Қайтып жазыңыз: Атырау, Ақтөбе немесе Орал?`
      );
      return;
    }
    const device = session.collected_device || session.first_message || '—';
    const description = session.collected_description || null;
    await createLeadAndFinish({ phone, chatId, waName, firstMessage: session.first_message || text, device, description, city, lang, messageId });
  }
}

async function createLeadAndFinish({ phone, chatId, waName, firstMessage, device, description, city, lang, messageId }) {
  // Проверяем дубли
  const { create } = await shouldCreateNewLead(phone);
  if (!create) {
    const { data: ex } = await supabase.from('leads').select('id').eq('phone', phone).eq('is_deleted', false).order('created_at', { ascending:false }).limit(1).single();
    if (ex) { await saveMessage(ex.id, firstMessage || '(сообщение)', 'in', messageId); await supabase.rpc('increment_unread', { lead_id: ex.id }); }
    return;
  }

  const clientName = waName || `Клиент ${phone.slice(-4)}`;
  const isNight = isNightTime();

  const { data: lead, error } = await supabase.from('leads').insert({
    client_name: clientName, wa_name: waName || null,
    phone, device: device || firstMessage || '—', city,
    status: 'new', wazzup_chat_id: chatId, unread_count: 0,
  }).select().single();

  if (error) { console.error('❌ Lead insert error:', error); return; }

  await saveMessage(lead.id, firstMessage || '(первое сообщение)', 'in', null);

  const address = SHOP_ADDRESSES[city] || CITY_ADDRESSES[city] || 'наш магазин';
  let confirmMsg;
  if (lang === 'kz') {
    confirmMsg = isNight
      ? `Қабылданды! Қазір түнгі уақыт — маман таңертең хабарласады 🌙`
      : `Қабылданды! Маманымыз жақын арада хабарласады.\n📍 ${city} дүкені: *${address}*`;
  } else {
    confirmMsg = isNight
      ? `Принято! Сейчас ночное время — специалист свяжется с вами утром 🌙`
      : `Принято! Наш специалист свяжется с вами в ближайшее время.\n📍 Адрес магазина в ${city}: *${address}*`;
  }

  await new Promise(r => setTimeout(r, 2000));
  await sendMessage(chatId, phone, confirmMsg);
  await saveMessage(lead.id, confirmMsg, 'out', null, 'Бот SKUPKA');

  await supabase.from('bot_sessions').update({
    step: 'done', collected_city: city,
    last_bot_reply_at: new Date().toISOString(), msg_count_since_reply: 0,
  }).eq('phone', phone);

  await sendTelegramNewLeadV2(lead, description, isNight);
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.status !== 'inbound') continue;
      const phone = msg.chatId, chatId = msg.chatId, messageId = msg.messageId;
      const waName = msg.contact?.name || null;
      const msgType = msg.type || 'text';

      // Медиа — отвечаем заготовленными фразами через бот
      if (msgType === 'image' || msgType === 'picture') {
        const { data: sess } = await supabase.from('bot_sessions').select('handed_over').eq('phone', phone).maybeSingle();
        const { create, lead } = await shouldCreateNewLead(phone);
        if (!create && lead) {
          await saveMessage(lead.id, `📷 [Фото] ${msg.contentUri||''}`, 'in', messageId);
          await supabase.rpc('increment_unread', { lead_id: lead.id });
        }
        if (!sess?.handed_over) {
          await new Promise(r => setTimeout(r, 2000));
          await sendMessage(chatId, phone, 'Спасибо за фото! Напишите модель устройства текстом — так быстрее обработаем заявку 😊');
        }
        continue;
      }
      if (msgType === 'audio' || msgType === 'voice' || msgType === 'ptt') {
        const { data: sess } = await supabase.from('bot_sessions').select('handed_over').eq('phone', phone).maybeSingle();
        if (!sess?.handed_over) {
          await new Promise(r => setTimeout(r, 2000));
          await sendMessage(chatId, phone, 'Пожалуйста напишите текстом — так удобнее обработать заявку 😊');
        }
        continue;
      }
      if (msgType === 'sticker' || msgType === 'gif' || msgType === 'video') {
        const { data: sess } = await supabase.from('bot_sessions').select('handed_over').eq('phone', phone).maybeSingle();
        if (!sess?.handed_over) {
          await new Promise(r => setTimeout(r, 2000));
          await sendMessage(chatId, phone, 'Напишите пожалуйста текстом что хотите продать 😊');
        }
        continue;
      }
      if (msgType !== 'text') continue;

      const text = (typeof msg.text === 'object' ? msg.text?.text : msg.text) || '';
      if (!text.trim()) continue;
      console.log(`📩 [${phone}] (${waName}): ${text.slice(0,80)}`);
      await handleBotStep(phone, chatId, text, messageId, waName);
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
  const { data, error } = await supabase.from('leads').update(updates).eq('id', id).select().single();
  if (error) { console.error('❌ PATCH error:', error); return res.status(500).json({ error }); }
  // Сброс handed_over при закрытии карточки
  if (data && (updates.status === 'success' || updates.status === 'fail' || updates.is_archived || updates.is_deleted)) {
    const { error: botUpdateError } = await supabase
      .from('bot_sessions')
      .update({ handed_over: false })
      .eq('phone', data.phone);
    if (botUpdateError) console.error(botUpdateError);
  }
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
  const { data, error } = await supabase.from('leads')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/api/leads/:id/restore', async (req, res) => {
  const { data, error } = await supabase.from('leads')
    .update({ is_deleted: false, deleted_at: null })
    .eq('id', req.params.id).select().single();
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

// ─── STATS ────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { city, period, from, to } = req.query;
  const now = new Date();
  let startDate = new Date(now); startDate.setHours(0,0,0,0);
  let endDate = new Date(now); endDate.setHours(23,59,59,999);
  if (period === 'week') { startDate = new Date(now); startDate.setDate(now.getDate()-7); startDate.setHours(0,0,0,0); }
  else if (period === 'month') { startDate = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (period === 'custom' && from && to) { startDate = new Date(from); startDate.setHours(0,0,0,0); endDate = new Date(to); endDate.setHours(23,59,59,999); }

  let query = supabase.from('leads').select('*').eq('is_deleted', false).eq('is_archived', false);
  if (city) query = query.eq('city', city);
  const { data: all } = await query;
  if (!all) return res.json({});

  const inPeriod = all.filter(l => { const d = new Date(l.updated_at||l.created_at); return d>=startDate&&d<=endDate; });
  const byCity = {};
  ['Атырау','Актобе','Уральск'].forEach(c => {
    const cl = inPeriod.filter(l=>l.city===c);
    const succ = cl.filter(l=>l.status==='success');
    const amount = succ.reduce((s,l)=>s+(Number(l.estimate_amount)||0),0);
    byCity[c] = { total:cl.length, success:succ.length, fail:cl.filter(l=>l.status==='fail').length, inProgress:cl.filter(l=>l.status==='in_progress').length, waiting:cl.filter(l=>l.status==='waiting').length, amount, conversion:cl.length>0?Math.round(succ.length/cl.length*100):0, avgCheck:succ.length>0?Math.round(amount/succ.length):0 };
  });
  const successAll = inPeriod.filter(l=>l.status==='success');
  const totalAmount = successAll.reduce((s,l)=>s+(Number(l.estimate_amount)||0),0);
  const byDay = {};
  for (let i=29;i>=0;i--) { const d=new Date(now); d.setDate(d.getDate()-i); d.setHours(0,0,0,0); const key=d.toISOString().split('T')[0]; const dl=all.filter(l=>{const ld=new Date(l.created_at);ld.setHours(0,0,0,0);return ld.toISOString().split('T')[0]===key;}); byDay[key]={total:dl.length,success:dl.filter(l=>l.status==='success').length,amount:dl.filter(l=>l.status==='success').reduce((s,l)=>s+(Number(l.estimate_amount)||0),0)}; }
  const failReasons = {}; all.filter(l=>l.status==='fail'&&l.fail_comment).forEach(l=>{failReasons[l.fail_comment]=(failReasons[l.fail_comment]||0)+1;});
  const overdue = all.filter(l=>l.status==='in_progress'&&(Date.now()-new Date(l.updated_at||l.created_at).getTime())>10*3600*1000).length;

  // Вчерашние данные для трендов
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const ydStart = new Date(yesterday); ydStart.setHours(0,0,0,0);
  const ydEnd = new Date(yesterday); ydEnd.setHours(23,59,59,999);
  const ydLeads = all.filter(l=>{const d=new Date(l.created_at);return d>=ydStart&&d<=ydEnd;});
  const ydSuccess = ydLeads.filter(l=>l.status==='success');
  const trends = {
    new: inPeriod.filter(l=>l.status==='new').length - ydLeads.filter(l=>l.status==='new').length,
    success: successAll.length - ydSuccess.length,
    conversion: (inPeriod.length>0?Math.round(successAll.length/inPeriod.length*100):0) - (ydLeads.length>0?Math.round(ydSuccess.length/ydLeads.length*100):0),
  };

  res.json({
    total:inPeriod.length, success:successAll.length,
    fail:inPeriod.filter(l=>l.status==='fail').length,
    new:inPeriod.filter(l=>l.status==='new').length,
    inProgress:all.filter(l=>l.status==='in_progress').length,
    waiting:all.filter(l=>l.status==='waiting').length,
    totalAmount, avgCheck:successAll.length>0?Math.round(totalAmount/successAll.length):0,
    conversion:inPeriod.length>0?Math.round(successAll.length/inPeriod.length*100):0,
    byCity, byDay, failReasons, overdue, trends,
    inProgressAmount: all.filter(l=>l.status==='in_progress').reduce((s,l)=>s+(Number(l.estimate_amount)||0),0),
    waitingAmount: all.filter(l=>l.status==='waiting').reduce((s,l)=>s+(Number(l.estimate_amount)||0),0),
    updatedAt: new Date().toISOString(),
  });
});

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

// ─── CRON ─────────────────────────────────────────────────────────────────
app.post('/cron/morning-report', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped:true });
  const { data: all } = await supabase.from('leads').select('*').eq('is_deleted',false).eq('is_archived',false);
  if (!all) return res.json({ ok:true });
  const now = new Date();
  const yd = new Date(now); yd.setDate(yd.getDate()-1);
  const ydStart = new Date(yd); ydStart.setHours(0,0,0,0);
  const ydEnd = new Date(yd); ydEnd.setHours(23,59,59,999);
  const fmt = n => new Intl.NumberFormat('ru-KZ').format(Math.round(n));

  for (const city of ['Атырау','Актобе','Уральск']) {
    const cityLeads = all.filter(l => l.city === city);
    const newL   = cityLeads.filter(l => l.status==='new');
    const inP    = cityLeads.filter(l => l.status==='in_progress');
    const wait   = cityLeads.filter(l => l.status==='waiting');
    const overdue= inP.filter(l => (Date.now()-new Date(l.updated_at||l.created_at).getTime())>10*3600*1000);
    const ydSucc = cityLeads.filter(l => { const d=new Date(l.updated_at||l.created_at); return l.status==='success'&&d>=ydStart&&d<=ydEnd; });
    const ydFail = cityLeads.filter(l => { const d=new Date(l.updated_at||l.created_at); return l.status==='fail'&&d>=ydStart&&d<=ydEnd; });
    const ydAmount = ydSucc.reduce((s,l) => s+(Number(l.estimate_amount)||0), 0);
    const cityEmoji = { 'Атырау':'🟡', 'Актобе':'🔵', 'Уральск':'🟣' };

    let msg = `${cityEmoji[city]} *Доброе утро! Сводка SKUPKA — ${city}*\n\n`;
    msg += `🆕 Новые: *${newL.length}* заявок ждут обработки\n`;
    msg += `⚡ В работе: *${inP.length}*${overdue.length>0?` _(${overdue.length} просрочено!)_`:''}\n`;
    msg += `🏪 Ждём на филиал: *${wait.length}*\n\n`;
    msg += `📊 *Вчера:*\n✅ Успешно: *${ydSucc.length}* сделок на *${fmt(ydAmount)} ₸*\n❌ Провал: *${ydFail.length}*`;
    await tg(msg, city);
  }
  res.json({ ok:true });
});

app.post('/cron/check-new', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped:true });
  const { data: newLeads } = await supabase.from('leads').select('*').eq('status','new').eq('is_deleted',false).eq('is_archived',false).order('created_at',{ascending:true});
  if (!newLeads||newLeads.length===0) return res.json({ ok:true,count:0 });
  const fmt = ms => { const m=Math.floor(ms/60000); if(m<60)return`${m}мин`; const h=Math.floor(m/60),rm=m%60; return rm>0?`${h}ч ${rm}мин`:`${h}ч`; };

  for (const city of ['Атырау','Актобе','Уральск']) {
    const cityLeads = newLeads.filter(l => l.city === city);
    if (cityLeads.length === 0) continue;
    let msg = `🆕 *Необработанные заявки — ${city}!*\n\n`;
    cityLeads.slice(0,10).forEach(l => { msg += `• ${l.client_name} — ${l.device?.slice(0,30)} — _${fmt(Date.now()-new Date(l.created_at).getTime())}_\n`; });
    if (cityLeads.length>10) msg += `_...и ещё ${cityLeads.length-10}_\n`;
    msg += `\nВсего: *${cityLeads.length}* заявок ждут обработки`;
    await tg(msg, city);
  }
  res.json({ ok:true, count:newLeads.length });
});

app.post('/cron/check-overdue', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped:true });
  const { data: inP } = await supabase.from('leads').select('*').eq('status','in_progress').eq('is_deleted',false).eq('is_archived',false);
  if (!inP) return res.json({ ok:true });
  const overdue = inP.filter(l => (Date.now()-new Date(l.updated_at||l.created_at).getTime())>10*3600*1000);
  if (overdue.length===0) return res.json({ ok:true,count:0 });
  const fmt = ms => { const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000); return m>0?`${h}ч ${m}мин`:`${h}ч`; };

  for (const city of ['Атырау','Актобе','Уральск']) {
    const cityOverdue = overdue.filter(l => l.city === city);
    if (cityOverdue.length === 0) continue;
    let msg = `🔴 *Заявки зависли в работе 10ч+ — ${city}!*\n\n`;
    cityOverdue.slice(0,10).forEach(l => { msg += `• ${l.client_name} — ${l.device?.slice(0,30)} — _${fmt(Date.now()-new Date(l.updated_at||l.created_at).getTime())}_\n`; });
    msg += `\nТребуют внимания: *${cityOverdue.length}* заявок`;
    await tg(msg, city);
  }
  res.json({ ok:true, count:overdue.length });
});

app.post('/cron/check-waiting', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped:true });
  const { data: waiting } = await supabase.from('leads').select('*').eq('status','waiting').eq('is_deleted',false).eq('is_archived',false).not('visit_date','is',null);
  if (!waiting) return res.json({ ok:true });
  const now = new Date();
  const overdue = waiting.filter(l => { if(!l.visit_date)return false; const ve=new Date(l.visit_date); ve.setHours(23,59,59,999); return now>ve; });
  if (overdue.length===0) return res.json({ ok:true,count:0 });
  const fmt = ms => { const d=Math.floor(ms/86400000),h=Math.floor((ms%86400000)/3600000); return d>0?(h>0?`${d}д ${h}ч`:`${d}д`):`${h}ч`; };

  for (const city of ['Атырау','Актобе','Уральск']) {
    const cityOverdue = overdue.filter(l => l.city === city);
    if (cityOverdue.length === 0) continue;
    let msg = `🏪 *Клиенты не пришли на филиал — ${city}!*\n\n`;
    cityOverdue.slice(0,10).forEach(l => { const vd=new Date(l.visit_date).toLocaleDateString('ru-RU'); const od=fmt(now-new Date(l.visit_date).getTime()); msg+=`• ${l.client_name}\n  Ожидали: ${vd}, просрочка _${od}_\n`; });
    msg += `\nУточните у клиентов — придут ли?`;
    await tg(msg, city);
  }
  res.json({ ok:true, count:overdue.length });
});

app.post('/cron/revive-fails', async (req, res) => {
  const twoWeeksAgo=new Date();twoWeeksAgo.setDate(twoWeeksAgo.getDate()-14);
  const { data: fails }=await supabase.from('leads').select('*').eq('status','fail').eq('is_deleted',false).lt('updated_at',twoWeeksAgo.toISOString());
  if (!fails||fails.length===0) return res.json({ revived:0 });
  for (const lead of fails) {
    await supabase.from('leads').update({ status:'in_progress',fail_comment:null,revived_from_fail:true,updated_at:new Date().toISOString() }).eq('id',lead.id);
    await supabase.from('comments').insert({ lead_id:lead.id,author:'Система',pinned:true,text:'♻️ Повторный контакт — клиент ранее был в провале. Свяжитесь и уточните актуальность.' });
  }
  res.json({ revived:fails.length });
});

app.post('/cron/archive-old', async (req, res) => {
  const threeMonthsAgo=new Date();threeMonthsAgo.setMonth(threeMonthsAgo.getMonth()-3);
  await supabase.from('leads').update({ is_archived:true }).in('status',['success','fail']).lt('updated_at',threeMonthsAgo.toISOString()).eq('is_archived',false).eq('is_deleted',false);
  res.json({ ok:true });
});

// ─── CRM Ассистент ────────────────────────────────────────────────────────────
app.post('/api/assistant', async (req, res) => {
  try {
    const { messages, extra, intent } = req.body;
    const needsSearch = ['assess', 'price', 'device'].includes(intent);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: needsSearch ? 1024 : 300,
      system: `Ты CRM ассистент компании SKUPKA — компании по скупке техники
в Казахстане (города: Атырау, Актобе, Уральск).
Общаешься только на русском языке. Будь дружелюбным и профессиональным.

ИСТОЧНИКИ ЦЕН (строго в таком порядке приоритета):
1. OLX.kz — ГЛАВНЫЙ источник, реальный рынок
2. Kaspi.kz объявления — второй источник
3. Магазины (Каспи магазин, Сулпак, Технодом, Ozon KZ, WB KZ) — только для справки

ФОРМУЛА ОЦЕНКИ:
- Найти минимальную и медианную цену на OLX.kz по похожим объявлениям
- Брать медианную цену OLX как базу
- Учитывать состояние устройства:
  * АКБ ниже 80% — минус 10-15% от цены
  * Царапины/потёртости — минус 5-10%
  * Без комплекта — минус 5%
  * Ремонт был — минус 10-20%
  * Отличное состояние с комплектом — плюс 5%

ТАБЛИЦА МАРЖИ (цена выкупа = медианная OLX цена / (1 + маржа)):
- Телефоны: маржа 40%
- Ноутбуки, ТВ, PlayStation, Компьютеры: маржа 50%
- Кухонная техника: маржа 60%
- Строительные товары: маржа 80%
- Аксессуары (часы, наушники, планшеты): маржа 50%
- Всё остальное (велосипеды, автозапчасти и тд): маржа 60%

ФОРМАТ ОТВЕТА при оценке:
Отвечай кратко и по делу. Только важное:
1. Модель + ключевые характеристики (1-2 строки)
2. Цена OLX: мин / медиана
3. Корректировки если есть (кратко)
4. Цена выкупа — одна цифра жирным
Без лишних слов, без воды. Максимум 10-15 строк.
В конце добавляй: "Нужен подробный анализ? Напишите 'подробно'"
Если пользователь пишет 'подробно' — давай полный развёрнутый анализ.
${extra||''}`,
      messages,
      ...(needsSearch ? {
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      } : {})
    });
    const fullResponse = response.content
      .map(item => item.type === 'text' ? item.text : '')
      .filter(Boolean)
      .join('\n');
    res.json({ response: fullResponse });
  } catch (err) {
    console.error('Assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/ping', (req, res) => res.send('pong'));

app.post('/setup-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  try {
    await axios.patch(`${WAZZUP_API}/webhooks`, { webhooksUri:webhookUrl, subscriptions:{ messagesAndStatuses:true, contactsAndDealsCreation:true } }, { headers:{ 'Authorization':`Bearer ${WAZZUP_API_KEY}` } });
    res.json({ ok:true, message:'Webhook настроен!' });
  } catch (err) { res.status(500).json({ error:err?.response?.data||err.message }); }
});

app.use((err, req, res, next) => { console.error('💥 Error:', err); res.status(500).json({ error:err.message }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 SKUPKA Backend на порту ${PORT}`));
