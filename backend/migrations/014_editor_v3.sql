-- Migration: playlist editor v3
-- Date: 2026-10-02
-- Description: short URLs and named versions.
--
-- short_name: an alias chosen by the user (for example "fr"), so the player
-- URLs become /p/fr.m3u and /p/fr.xml. They are typed with a TV remote.
--
-- live_playlist_versions: a named copy of a playlist's groups and channels,
-- as JSON, restorable at any time. The editor also saves one by itself before
-- every tool that rewrites many channels.
--
-- This runner re-applies every file at boot and splits on the statement
-- terminator, so this comment block must never contain one.

ALTER TABLE live_playlists ADD COLUMN short_name VARCHAR;
CREATE TABLE IF NOT EXISTS live_playlist_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    name VARCHAR NOT NULL,
    automatic BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    channel_count INTEGER NOT NULL DEFAULT 0,
    snapshot TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_live_playlists_short_name ON live_playlists (short_name)
