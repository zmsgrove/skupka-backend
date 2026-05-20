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

// ─── Расширенный список городов ───────────────────────────────────────────
const CITY_MAP = {
  // Уральск / Орал
  'ура':'Уральск', 'ора':'Уральск', 'оra':'Уральск',
  'орал':'Уральск', 'уралл':'Уральск', 'уралс':'Уральск',
  'урал':'Уральск', 'уральс':'Уральск', 'уральск':'Уральск',
  'уралск':'Уральск', 'уральк':'Уральск', 'оралл':'Уральск',
  'орол':'Уральск', 'oral':'Уральск', 'ural':'Уральск',
  // Атырау
  'аты':'Атырау', 'атыр':'Атырау', 'атыра':'Атырау',
  'атырай':'Атырау', 'атырао':'Атырау', 'атырав':'Атырау',
  'атырау':'Атырау', 'атырауу':'Атырау', 'atyrau':'Атырау',
  'aтырау':'Атырау', 'гурьев':'Атырау',
  // Актобе / Актюбинск
  'акт':'Актобе', 'акто':'Актобе', 'актоб':'Актобе',
  'актобе':'Актобе', 'актобэ':'Актобе', 'актобее':'Актобе',
  'актбое':'Актобе', 'актюб':'Актобе', 'актюбе':'Актобе',
  'актюбинск':'Актобе', 'актюбэ':'Актобе', 'aqtobe':'Актобе',
  'актобе':'Актобе',
};

// ─── Рабочее время ────────────────────────────────────────────────────────
function isWorkingHours() {
  const now = new Date();
  // Казахстан UTC+5
  const kzHour = (now.getUTCHours() + 5) % 24;
  return kzHour >= 9 && kzHour < 21;
}

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

async function saveMessage(leadId, text, direction, messageId = null, senderName = null) {
  await supabase.from('messages').insert({
    lead_id: leadId, wazzup_message_id: messageId,
    direction, text, sender_name: senderName,
  });
}

// ─── Telegram ─────────────────────────────────────────────────────────────
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown',
    });
    console.log('📱 TG отправлено');
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
    `🕐 *Время:* ${time}`
  );
}

// ─── Бот ──────────────────────────────────────────────────────────────────
async function handleBotStep(phone, chatId, messageText, messageId) {
  const text = messageText.trim();
  const { data: session } = await supabase
    .from('bot_sessions').select('*').eq('phone', phone).maybeSingle();
  console.log('🔍 Step:', session?.step, '| Text:', text);

  // Сессия завершена — показываем меню выбора
  if (session && session.step === 'done') {
    // Ищем последнюю карточку клиента
    const { data: lastLead } = await supabase
      .from('leads').select('id').eq('phone', phone)
      .eq('is_deleted', false).order('created_at', { ascending: false }).limit(1).single();

    // Если клиент отвечает на меню выбора
    if (text === '1') {
      // Новая заявка — сбрасываем сессию
      await supabase.from('bot_sessions').update({
        step: 'ask_name', collected_name: null, collected_city: null,
      }).eq('phone', phone);
      const msg = `Здравствуйте! 👋 Вы обратились в *SKUPKA* — магазин по продаже и скупке техники.\n\nДля заявки ответьте на несколько вопросов.\n\nНапишите ваше *имя*:`;
      await sendMessage(chatId, phone, msg);
      if (lastLead) await saveMessage(lastLead.id, msg, 'out', null, 'Бот SKUPKA');
      return;
    }

    if (text === '2') {
      // Вопрос по существующей заявке
      const msg = `Хорошо! Ваш вопрос получен, специалист свяжется с вами в ближайшее время 🙏`;
      await sendMessage(chatId, phone, msg);
      if (lastLead) {
        await saveMessage(lastLead.id, messageText, 'in', messageId);
        await saveMessage(lastLead.id, msg, 'out', null, 'Бот SKUPKA');
        await supabase.rpc('increment_unread', { lead_id: lastLead.id });
      }
      return;
    }

    // Любое другое сообщение — показываем меню
    const menuMsg = `Здравствуйте! Вы уже обращались к нам ранее. 😊\n\nВыберите:\n*1* — Оформить новую заявку\n*2* — Вопрос по существующей заявке\n\nНапишите цифру *1* или *2*`;
    await sendMessage(chatId, phone, menuMsg);
    if (lastLead) {
      await saveMessage(lastLead.id, text, 'in', messageId);
      await saveMessage(lastLead.id, menuMsg, 'out', null, 'Бот SKUPKA');
      await supabase.rpc('increment_unread', { lead_id: lastLead.id });
    }
    return;
  }

  // Новый пользователь
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
    await supabase.from('bot_sessions')
      .update({ collected_name: text, step: 'ask_city' }).eq('phone', phone);
    await sendMessage(chatId, phone,
      `Приятно познакомиться, *${text}*! 😊\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`
    );
    return;
  }

  if (session.step === 'ask_city') {
    const normalized = text.toLowerCase().trim()
      .replace(/ё/g,'е').replace(/[^а-яa-z]/g,'');
    const city = CITY_MAP[normalized];
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
      status: 'new', wazzup_chat_id: chatId, unread_count: 0,
    }).select().single();
    if (error) { console.error('❌ Lead error:', error); return; }

    await supabase.from('bot_sessions').update({ step: 'done' }).eq('phone', phone);

    // Сохраняем всю переписку бота
    await saveMessage(lead.id, `Здравствуйте! 👋 Вы обратились в SKUPKA — магазин по продаже и скупке техники.\n\nДля заявки ответьте на несколько вопросов.\n\nНапишите ваше имя:`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, name, 'in', null);
    await saveMessage(lead.id, `Приятно познакомиться, ${name}! 😊\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, city, 'in', null);
    await saveMessage(lead.id, `Отлично! ✅\n\nНапишите что за технику вы хотите продать?`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, text, 'in', messageId);

    const confirmMsg = `✅ Спасибо, *${name}*! Ваша заявка принята.\n\n📋 *Детали:*\n• Город: ${city}\n• Техника: ${text}\n\nНаш специалист свяжется с вами в ближайшее время! ⏳`;
    await sendMessage(chatId, phone, confirmMsg);
    await saveMessage(lead.id, confirmMsg, 'out', null, 'Бот SKUPKA');

    // TG уведомление о новой заявке
    await sendTelegramNewLead(lead);
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

// ─── STATS API ────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { city, period, from, to } = req.query;
  const now = new Date();

  let startDate = new Date(now); startDate.setHours(0,0,0,0);
  let endDate = new Date(now); endDate.setHours(23,59,59,999);

  if (period === 'week') {
    startDate = new Date(now); startDate.setDate(now.getDate()-7); startDate.setHours(0,0,0,0);
  } else if (period === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === 'custom' && from && to) {
    startDate = new Date(from); startDate.setHours(0,0,0,0);
    endDate = new Date(to); endDate.setHours(23,59,59,999);
  }

  let query = supabase.from('leads').select('*').eq('is_deleted', false).eq('is_archived', false);
  if (city) query = query.eq('city', city);
  const { data: all } = await query;
  if (!all) return res.json({});

  const inPeriod = all.filter(l => {
    const d = new Date(l.updated_at || l.created_at);
    return d >= startDate && d <= endDate;
  });

  const byCity = {};
  ['Атырау','Актобе','Уральск'].forEach(c => {
    const cl = inPeriod.filter(l => l.city === c);
    const succ = cl.filter(l => l.status === 'success');
    const amount = succ.reduce((s,l) => s+(Number(l.estimate_amount)||0), 0);
    byCity[c] = {
      total: cl.length, success: succ.length,
      fail: cl.filter(l=>l.status==='fail').length,
      inProgress: cl.filter(l=>l.status==='in_progress').length,
      waiting: cl.filter(l=>l.status==='waiting').length,
      amount, conversion: cl.length>0?Math.round(succ.length/cl.length*100):0,
      avgCheck: succ.length>0?Math.round(amount/succ.length):0,
    };
  });

  const successAll = inPeriod.filter(l=>l.status==='success');
  const totalAmount = successAll.reduce((s,l)=>s+(Number(l.estimate_amount)||0),0);

  const byDay = {};
  for (let i=29; i>=0; i--) {
    const d = new Date(now); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
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

  const overdue = all.filter(l =>
    l.status==='in_progress' &&
    (Date.now()-new Date(l.updated_at||l.created_at).getTime()) > 10*3600*1000
  ).length;

  res.json({
    total: inPeriod.length, success: successAll.length,
    fail: inPeriod.filter(l=>l.status==='fail').length,
    new: inPeriod.filter(l=>l.status==='new').length,
    inProgress: all.filter(l=>l.status==='in_progress').length,
    waiting: all.filter(l=>l.status==='waiting').length,
    totalAmount, avgCheck: successAll.length>0?Math.round(totalAmount/successAll.length):0,
    conversion: inPeriod.length>0?Math.round(successAll.length/inPeriod.length*100):0,
    byCity, byDay, failReasons, overdue,
    periodLabel: period==='week'?'Неделя':period==='month'?'Месяц':period==='custom'?`${from} — ${to}`:'Сегодня',
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

// ─── CRON: утренняя сводка в 09:00 ───────────────────────────────────────
app.post('/cron/morning-report', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped: 'not working hours' });

  const { data: all } = await supabase.from('leads').select('*')
    .eq('is_deleted', false).eq('is_archived', false);
  if (!all) return res.json({ ok: true });

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const yesterdayStart = new Date(yesterday); yesterdayStart.setHours(0,0,0,0);
  const yesterdayEnd = new Date(yesterday); yesterdayEnd.setHours(23,59,59,999);

  const newLeads = all.filter(l => l.status === 'new');
  const inProgress = all.filter(l => l.status === 'in_progress');
  const waiting = all.filter(l => l.status === 'waiting');
  const overdueInProgress = inProgress.filter(l =>
    (Date.now()-new Date(l.updated_at||l.created_at).getTime()) > 10*3600*1000
  );
  const yesterdaySuccess = all.filter(l => {
    const d = new Date(l.updated_at||l.created_at);
    return l.status==='success' && d>=yesterdayStart && d<=yesterdayEnd;
  });
  const yesterdayFail = all.filter(l => {
    const d = new Date(l.updated_at||l.created_at);
    return l.status==='fail' && d>=yesterdayStart && d<=yesterdayEnd;
  });
  const yesterdayAmount = yesterdaySuccess.reduce((s,l)=>s+(Number(l.estimate_amount)||0),0);

  const byCity = {};
  ['Атырау','Актобе','Уральск'].forEach(c => {
    byCity[c] = all.filter(l=>l.city===c && ['new','in_progress','waiting'].includes(l.status)).length;
  });

  const fmt = n => new Intl.NumberFormat('ru-KZ').format(Math.round(n));

  let msg = `☀️ *Доброе утро! Сводка SKUPKA CRM*\n\n`;
  msg += `🆕 Новые: *${newLeads.length}* заявок ждут обработки\n`;
  msg += `⚡ В работе: *${inProgress.length}* заявок`;
  if (overdueInProgress.length > 0) msg += ` _(${overdueInProgress.length} просрочено!)_`;
  msg += `\n`;
  msg += `🏪 Ждём на филиал: *${waiting.length}* заявок\n`;
  msg += `\n`;
  msg += `📊 *Вчера:*\n`;
  msg += `✅ Успешно: *${yesterdaySuccess.length}* сделок на *${fmt(yesterdayAmount)} ₸*\n`;
  msg += `❌ Провал: *${yesterdayFail.length}*\n`;
  msg += `\n`;
  msg += `📍 *Активные по городам:*\n`;
  msg += `• Атырау: ${byCity['Атырау']}\n`;
  msg += `• Актобе: ${byCity['Актобе']}\n`;
  msg += `• Уральск: ${byCity['Уральск']}`;

  await tg(msg);
  res.json({ ok: true });
});

// ─── CRON: каждые 30 минут — необработанные новые ────────────────────────
app.post('/cron/check-new', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped: 'not working hours' });

  const { data: newLeads } = await supabase.from('leads').select('*')
    .eq('status', 'new').eq('is_deleted', false).eq('is_archived', false)
    .order('created_at', { ascending: true });

  if (!newLeads || newLeads.length === 0) return res.json({ ok: true, count: 0 });

  const now = Date.now();
  const fmt = (ms) => {
    const mins = Math.floor(ms/60000);
    if (mins < 60) return `${mins}мин`;
    const h = Math.floor(mins/60), m = mins%60;
    return m>0 ? `${h}ч ${m}мин` : `${h}ч`;
  };

  let msg = `🆕 *Необработанные заявки!*\n\n`;
  newLeads.slice(0,10).forEach(l => {
    const age = fmt(now - new Date(l.created_at).getTime());
    msg += `• ${l.client_name} — ${l.device} — ${l.city} — _${age}_\n`;
  });
  if (newLeads.length > 10) msg += `_...и ещё ${newLeads.length-10}_\n`;
  msg += `\nВсего: *${newLeads.length}* заявок ждут обработки`;

  await tg(msg);
  res.json({ ok: true, count: newLeads.length });
});

// ─── CRON: каждые 2 часа — просроченные в работе ────────────────────────
app.post('/cron/check-overdue', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped: 'not working hours' });

  const { data: inProgress } = await supabase.from('leads').select('*')
    .eq('status', 'in_progress').eq('is_deleted', false).eq('is_archived', false);

  if (!inProgress) return res.json({ ok: true });

  const overdue = inProgress.filter(l =>
    (Date.now()-new Date(l.updated_at||l.created_at).getTime()) > 10*3600*1000
  );

  if (overdue.length === 0) return res.json({ ok: true, count: 0 });

  const fmt = (ms) => {
    const h = Math.floor(ms/3600000);
    const m = Math.floor((ms%3600000)/60000);
    return m>0 ? `${h}ч ${m}мин` : `${h}ч`;
  };

  let msg = `🔴 *Заявки зависли в работе 10ч+!*\n\n`;
  overdue.slice(0,10).forEach(l => {
    const age = fmt(Date.now()-new Date(l.updated_at||l.created_at).getTime());
    msg += `• ${l.client_name} — ${l.device} — ${l.city} — _${age}_\n`;
  });
  msg += `\nТребуют внимания: *${overdue.length}* заявок`;

  await tg(msg);
  res.json({ ok: true, count: overdue.length });
});

// ─── CRON: в 12:00 — просрочка в "Ждём на филиал" ────────────────────────
app.post('/cron/check-waiting', async (req, res) => {
  if (!isWorkingHours()) return res.json({ skipped: 'not working hours' });

  const { data: waiting } = await supabase.from('leads').select('*')
    .eq('status', 'waiting').eq('is_deleted', false).eq('is_archived', false)
    .not('visit_date', 'is', null);

  if (!waiting) return res.json({ ok: true });

  const now = new Date();
  const overdue = waiting.filter(l => {
    if (!l.visit_date) return false;
    const visitEnd = new Date(l.visit_date); visitEnd.setHours(23,59,59,999);
    return now > visitEnd;
  });

  if (overdue.length === 0) return res.json({ ok: true, count: 0 });

  const fmt = (ms) => {
    const days = Math.floor(ms/86400000);
    const h = Math.floor((ms%86400000)/3600000);
    if (days>0) return h>0?`${days}д ${h}ч`:`${days}д`;
    return `${h}ч`;
  };

  let msg = `🏪 *Клиенты не пришли на филиал!*\n\n`;
  overdue.slice(0,10).forEach(l => {
    const visitDate = new Date(l.visit_date).toLocaleDateString('ru-RU');
    const overdueDuration = fmt(now - new Date(l.visit_date).getTime());
    msg += `• ${l.client_name} — ${l.device} — ${l.city}\n`;
    msg += `  Ожидали: ${visitDate}, просрочка _${overdueDuration}_\n`;
  });
  msg += `\nУточните у клиентов — придут ли?`;

  await tg(msg);
  res.json({ ok: true, count: overdue.length });
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
  console.log(`♻️ Revived ${fails.length}`);
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
