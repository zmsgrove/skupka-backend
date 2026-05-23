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

// ─── НОВЫЙ БОТ — только 1 вопрос (город) ────────────────────────────────
async function handleBotStep(phone, chatId, messageText, messageId, waName) {
  const text = messageText.trim();
  const { data: session } = await supabase
    .from('bot_sessions').select('*').eq('phone', phone).maybeSingle();

  console.log('🔍 Step:', session?.step, '| Text:', text);

  // Сессия завершена
  if (session && session.step === 'done') {
    const { create, lead: existingLead } = await shouldCreateNewLead(phone);

    if (!create && existingLead) {
      await saveMessage(existingLead.id, text, 'in', messageId);
      await supabase.rpc('increment_unread', { lead_id: existingLead.id });
      return;
    }

    // Нужна новая заявка — сбрасываем
    await supabase.from('bot_sessions').update({
      step: 'ask_city', first_message: text,
    }).eq('phone', phone);

    const msg = `Здравствуйте! 👋 Вы обратились в *SKUPKA* — магазин по продаже и скупке техники.\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`;
    await sendMessage(chatId, phone, msg);
    return;
  }

  // Новый пользователь — сохраняем первое сообщение и спрашиваем город
  if (!session) {
    await supabase.from('bot_sessions').insert({
      phone, wazzup_chat_id: chatId,
      step: 'ask_city',
      first_message: text,
      collected_name: null, collected_city: null,
    });
    const msg = `Здравствуйте! 👋 Вы обратились в *SKUPKA* — магазин по продаже и скупке техники.\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`;
    await sendMessage(chatId, phone, msg);
    return;
  }

  // Шаг ask_city
  if (session.step === 'ask_city') {
    const normalized = text.toLowerCase().trim().replace(/ё/g,'е').replace(/[^а-яa-z]/g,'');
    const city = CITY_MAP[normalized];
    if (!city) {
      await sendMessage(chatId, phone,
        `❗ Пожалуйста, напишите один из городов:\n\n• *Атырау*\n• *Актобе*\n• *Уральск*`
      );
      return;
    }

    // Берём имя из WhatsApp или ставим номер
    const clientName = waName || `Клиент ${phone.slice(-4)}`;
    const deviceDesc = session.first_message || '—';

    const { data: lead, error } = await supabase.from('leads').insert({
      client_name: clientName,
      wa_name: waName || null,
      phone, device: deviceDesc,
      city, status: 'new',
      wazzup_chat_id: chatId, unread_count: 0,
    }).select().single();

    if (error) { console.error('❌ Lead error:', error); return; }

    await supabase.from('bot_sessions').update({
      step: 'done', collected_city: city,
    }).eq('phone', phone);

    // Сохраняем переписку
    await saveMessage(lead.id, session.first_message || text, 'in', null);
    await saveMessage(lead.id, `Здравствуйте! 👋 Вы обратились в SKUPKA — магазин по продаже и скупке техники.\n\nНапишите ваш город:\n• Атырау\n• Актобе\n• Уральск`, 'out', null, 'Бот SKUPKA');
    await saveMessage(lead.id, city, 'in', messageId);

    const confirmMsg = `✅ Спасибо! Ваша заявка принята.\n\n📋 *Детали:*\n• Город: ${city}\n• Описание: ${deviceDesc}\n\nНаш специалист свяжется с вами в ближайшее время! ⏳`;
    await sendMessage(chatId, phone, confirmMsg);
    await saveMessage(lead.id, confirmMsg, 'out', null, 'Бот SKUPKA');

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
      const waName = msg.contact?.name || null;
      if (msg.type === 'image') {
        const text = `📷 [Фото] ${msg.contentUri}`;
        const { create, lead } = await shouldCreateNewLead(phone);
        if (!create && lead) {
          await saveMessage(lead.id, text, 'in', messageId);
          await supabase.rpc('increment_unread', { lead_id: lead.id });
        }
        continue;
      }
      const text = (typeof msg.text === 'object' ? msg.text?.text : msg.text) || '';
      console.log(`📩 [${phone}] (${waName}): ${text}`);
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
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: `Ты CRM ассистент компании SKUPKA — компании по скупке техники
в Казахстане (города: Атырау, Актобе, Уральск).
Помогаешь сотрудникам оценивать технику и отвечаешь на вопросы.
Общаешься только на русском языке.
При поиске цен ищи на: Каспи, Сулпак, Технодом, Ozon KZ, WB KZ (новый)
и OLX.kz, Каспи б/у (бу).
Рекомендуй цену выкупа — обычно 60-70% от цены БУ.
Будь дружелюбным и профессиональным. ${extra||''}`,
      messages,
    });
    res.json({ response: response.content[0].text });
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
