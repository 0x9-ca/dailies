-- IANA time zone (e.g. America/New_York) in which a server-time reset happens.
-- Only meaningful when reset_basis = 'server'; NULL means the reset time is treated as UTC.
ALTER TABLE games ADD COLUMN reset_timezone TEXT;
