-- SKUPKA CRM v4 — запусти в Supabase SQL Editor

-- Обновить constraint статусов
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new','in_progress','waiting','success','fail'));

-- Новые поля
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS visit_date TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS revived_from_fail BOOLEAN DEFAULT FALSE;

-- Поле pinned для комментариев
ALTER TABLE comments ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;

-- Функция increment_unread
CREATE OR REPLACE FUNCTION increment_unread(lead_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE leads SET unread_count = COALESCE(unread_count,0) + 1 WHERE id = lead_id;
END;
$$ LANGUAGE plpgsql;

-- Индексы
CREATE INDEX IF NOT EXISTS idx_leads_is_deleted ON leads(is_deleted);
CREATE INDEX IF NOT EXISTS idx_leads_is_archived ON leads(is_archived);
CREATE INDEX IF NOT EXISTS idx_leads_status_city ON leads(status, city);
