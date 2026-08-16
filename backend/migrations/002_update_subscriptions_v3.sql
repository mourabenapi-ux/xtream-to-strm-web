-- Migration: Upgrade schema to v3.0.0
-- Date: 2026-02-08
-- Description: Adds missing columns to subscriptions table for the download module

-- Add download_movies_dir column
ALTER TABLE subscriptions ADD COLUMN download_movies_dir TEXT DEFAULT '/output/downloads/movies';

-- Add download_series_dir column
ALTER TABLE subscriptions ADD COLUMN download_series_dir TEXT DEFAULT '/output/downloads/series';

-- Add max_parallel_downloads column
ALTER TABLE subscriptions ADD COLUMN max_parallel_downloads INTEGER DEFAULT 2;

-- Add download_segments column
ALTER TABLE subscriptions ADD COLUMN download_segments INTEGER DEFAULT 1;

-- Initialize values for existing subscriptions
UPDATE subscriptions 
SET download_movies_dir = '/output/downloads/movies', 
    download_series_dir = '/output/downloads/series', 
    max_parallel_downloads = 2, 
    download_segments = 1
WHERE download_movies_dir IS NULL;
