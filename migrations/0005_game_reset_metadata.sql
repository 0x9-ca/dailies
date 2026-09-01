ALTER TABLE games ADD COLUMN reset_basis TEXT CHECK (reset_basis IN ('local', 'server'));
ALTER TABLE games ADD COLUMN reset_time_minutes INTEGER CHECK (reset_time_minutes >= 0 AND reset_time_minutes <= 1439);
