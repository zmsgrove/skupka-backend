-- SKUPKA CRM - Supabase Schema
-- Запустить в Supabase → SQL Editor

-- Таблица заявок (карточки)
CREATE TABLE IF NOT EXISTS leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  device TEXT NOT NULL,
  city TEXT NOT NULL CHECK (city IN ('Атырау', 'Актобе', 'Уральск')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'success', 'fail')),
  estimate_amount NUMERIC DEFAULT NULL,
  contract_number TEXT DEFAULT NULL,
  success_comment TEXT DEFAULT NULL,
  fail_comment TEXT DEFAULT NULL,
  wazzup_chat_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица сообщений переписки
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  wazzup_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  sender_name TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица комментариев сотрудников
CREATE TABLE IF NOT EXISTS comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица состояния бота (для пошагового сбора данных)
CREATE TABLE IF NOT EXISTS bot_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  wazzup_chat_id TEXT NOT NULL,
  step TEXT NOT NULL DEFAULT 'start' CHECK (step IN ('start', 'ask_name', 'ask_city', 'ask_device', 'done')),
  collected_name TEXT DEFAULT NULL,
  collected_city TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_leads_city ON leads(city);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_comments_lead_id ON comments(lead_id);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_phone ON bot_sessions(phone);

-- Автообновление updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER bot_sessions_updated_at
  BEFORE UPDATE ON bot_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Включить Realtime для таблиц
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE comments;

-- ─── Добавить поле unread_count в leads ───────────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;

-- ─── Функция для увеличения счётчика непрочитанных ────────────────────────
CREATE OR REPLACE FUNCTION increment_unread(lead_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE leads SET unread_count = COALESCE(unread_count, 0) + 1 WHERE id = lead_id;
END;
$$ LANGUAGE plpgsql;
