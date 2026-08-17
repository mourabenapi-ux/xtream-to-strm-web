-- Migration: keep what a source says about replay
-- Date: 2026-08-17
-- Description: An M3U line can carry catchup="xc", catchup-days="7" and a
-- catchup-source template, and an Xtream stream carries tv_archive and
-- tv_archive_duration. All of it was dropped at parse time, so the playlist we
-- generate for a player advertised no replay at all -- the single feature a
-- catalogue cannot rebuild on its own, because only the provider knows the URL.
-- These columns hold the M3U side verbatim. The Xtream side needs no storage,
-- because its listing is read live.
--
-- NOTE: this file must not contain a statement separator anywhere above the
-- SQL, not even inside a comment. The runner splits each file on that
-- character, so one in a comment cuts the block in half and the fragments are
-- executed as SQL -- which is how the first ALTER below was silently lost on
-- the first version of this migration.
--
-- This runner re-applies every migration at each boot, so every statement below
-- is written to be a no-op the second time.

ALTER TABLE source_entries ADD COLUMN catchup VARCHAR;
ALTER TABLE source_entries ADD COLUMN catchup_days INTEGER;
ALTER TABLE source_entries ADD COLUMN catchup_source VARCHAR;
