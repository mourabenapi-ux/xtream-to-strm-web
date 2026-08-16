-- Migration: Add connection parameters to download_settings_global
-- Date: 2026-02-06
-- Description: Adds max_redirects and connection_timeout_seconds columns

-- Add max_redirects column with default value of 10
ALTER TABLE download_settings_global 
ADD COLUMN max_redirects INTEGER DEFAULT 10;

-- Add connection_timeout_seconds column with default value of 30
ALTER TABLE download_settings_global 
ADD COLUMN connection_timeout_seconds INTEGER DEFAULT 30;

-- Update existing rows to have the default values (if any exist)
UPDATE download_settings_global 
SET max_redirects = 10, connection_timeout_seconds = 30
WHERE max_redirects IS NULL OR connection_timeout_seconds IS NULL;
