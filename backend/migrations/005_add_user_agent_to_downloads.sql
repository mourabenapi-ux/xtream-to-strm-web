-- Migration: Add user_agent to download_settings_global
-- Date: 2026-02-19
-- Description: Adds user_agent column for customized network requests.

-- Add user_agent column with default value
ALTER TABLE download_settings_global 
ADD COLUMN user_agent VARCHAR DEFAULT 'TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)';

-- Update existing rows to have the default value if it's null
UPDATE download_settings_global 
SET user_agent = 'TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)'
WHERE user_agent IS NULL;
