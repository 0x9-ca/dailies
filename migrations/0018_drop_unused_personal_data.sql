-- Remove personal data the app no longer uses.
-- email_login_tokens: left over from the retired email login (emails, IPs, user agents).
-- users.avatar_url: provider avatars were stored on login but never displayed; the column stays, emptied.

DROP TABLE IF EXISTS email_login_tokens;

UPDATE users SET avatar_url = NULL WHERE avatar_url IS NOT NULL;
