-- Migration: playlist editor v2
-- Date: 2026-10-02
-- Description: what the editor needs to keep a playlist healthy on its own.
--
-- number_start / number_end: the channel-number range a group owns. Without a
-- range, appending to a group took the number after its last channel and
-- spilled into the next group, which then interleaved with it in the player.
--
-- rule: a JSON filter (provider, categories, keywords). A group carrying one
-- is topped up with the matching channels the provider adds, so it no longer
-- freezes on the day it was built. NULL keeps the group fully manual.
--
-- organizer_config: the profile, scopes and options the Auto Organizer used,
-- so it can be re-run against the same playlist and show a diff.
--
-- reviewed_at: when the user last acknowledged the "what changed" report.
--
-- live_catalog_seen: when each provider stream was first noticed, which is
-- what "new since your last review" is measured against. M3U sources carry no
-- date of their own.
--
-- This runner re-applies every file at boot and splits on the statement
-- terminator, so this comment block must never contain one.

ALTER TABLE live_playlist_bouquets ADD COLUMN number_start INTEGER;
ALTER TABLE live_playlist_bouquets ADD COLUMN number_end INTEGER;
ALTER TABLE live_playlist_bouquets ADD COLUMN rule TEXT;
ALTER TABLE live_playlists ADD COLUMN organizer_config TEXT;
ALTER TABLE live_playlists ADD COLUMN reviewed_at DATETIME;
CREATE TABLE IF NOT EXISTS live_catalog_seen (
    subscription_id INTEGER NOT NULL,
    stream_id VARCHAR NOT NULL,
    first_seen DATETIME NOT NULL,
    PRIMARY KEY (subscription_id, stream_id)
);
