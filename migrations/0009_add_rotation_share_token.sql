-- Migration: Add rotation share token
-- Allow users to generate a shareable link for their rotation

ALTER TABLE users ADD COLUMN rotation_share_token TEXT DEFAULT NULL;
CREATE UNIQUE INDEX idx_users_rotation_share_token ON users(rotation_share_token) WHERE rotation_share_token IS NOT NULL;
