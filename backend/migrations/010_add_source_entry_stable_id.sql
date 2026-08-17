-- Migration: stable ids for M3U catalogue lines
-- Date: 2026-08-17
-- Description: source_entries.id is an autoincrement primary key, and a reparse
-- of a playlist deletes every row of the source before re-inserting it. Each
-- reparse therefore minted brand new ids for the same channels, once an hour.
-- Anything that had stored one pointed at a row that no longer existed: a live
-- playlist built by the organiser resolved zero channels the next hour and
-- served an empty M3U, and every series looked modified on every sync.
--
-- stable_id is derived from the source and the line's URL, so it is the same on
-- every parse. It is what the rest of the app now stores and looks up.
--
-- Left nullable: the rows already in the table get theirs from the catalogue
-- adapter, which backfills whatever it reads without one.
--
-- This runner re-applies every migration at each boot, and skips the ADD COLUMN
-- once the column is there.

ALTER TABLE source_entries ADD COLUMN stable_id BIGINT;

CREATE INDEX IF NOT EXISTS ix_source_entries_stable_id ON source_entries (stable_id);
