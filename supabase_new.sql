-- Запусти в Supabase SQL Editor

-- Новый статус waiting + поле visit_date
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check 
  CHECK (status IN ('new', 'in_progress', 'waiting', 'success', 'fail'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS visit_date TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;

-- Функция для счётчика непрочитанных
CREATE OR REPLACE FUNCTION increment_unread(lead_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE leads SET unread_count = COALESCE(unread_count, 0) + 1 WHERE id = lead_id;
END;
$$ LANGUAGE plpgsql;
