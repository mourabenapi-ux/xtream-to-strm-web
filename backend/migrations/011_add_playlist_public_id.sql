-- Migration: stable public id for live playlists
-- Date: 2026-09-23
-- Description: live_playlists.id is a bare SQLite rowid, not AUTOINCREMENT.
-- Deleting the playlist with the highest id and creating a new one hands that
-- new playlist the same id the old one had. The M3U and EPG URLs pasted by
-- hand into TiviMate are built from that raw id, so a reused id makes the
-- old bookmarked URL silently start serving a completely different playlist,
-- with no error.
--
-- public_id is random, 8 lowercase hex characters, generated once and never
-- reassigned. The player-facing playlist.m3u and playlist.xml endpoints now
-- key off it instead of the internal id.
--
-- This runner re-applies every migration at each boot, and skips the ADD
-- COLUMN once the column is there. The UPDATE only touches rows that do not
-- have a public_id yet, so re-running it is a no-op.

ALTER TABLE live_playlists ADD COLUMN public_id VARCHAR(8);

UPDATE live_playlists SET public_id = lower(hex(randomblob(4))) WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ix_live_playlists_public_id ON live_playlists (public_id);
