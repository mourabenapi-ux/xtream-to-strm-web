-- Migration: hand-corrected TMDB ids
-- Date: 2026-08-17
-- Description: The provider's tmdb_id is what the .strm library names its
-- folders with, and Jellyfin trusts it completely. When it is wrong the whole
-- entry is wrong -- poster, synopsis, year -- and nothing in the library can be
-- corrected without editing the provider's catalogue. This table holds the
-- user's answer, which wins over the provider's on the next sync.
--
-- Kept out of movie_cache / series_cache on purpose: those are caches, dropped
-- whenever the provider stops listing an item, so a correction stored there
-- would not survive a bad night from the provider.
--
-- This runner re-applies every migration at each boot, so every statement below
-- is written to be a no-op the second time.

CREATE TABLE IF NOT EXISTS tmdb_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    media_type VARCHAR NOT NULL,
    item_id VARCHAR NOT NULL,
    name_key VARCHAR,
    label VARCHAR,
    tmdb_id VARCHAR,
    updated_at DATETIME,
    CONSTRAINT uq_tmdb_override_item UNIQUE (subscription_id, media_type, item_id)
);

CREATE INDEX IF NOT EXISTS ix_tmdb_overrides_subscription_id ON tmdb_overrides (subscription_id);
CREATE INDEX IF NOT EXISTS ix_tmdb_overrides_media_type ON tmdb_overrides (media_type);
CREATE INDEX IF NOT EXISTS ix_tmdb_overrides_item_id ON tmdb_overrides (item_id);
CREATE INDEX IF NOT EXISTS ix_tmdb_overrides_name_key ON tmdb_overrides (name_key);
