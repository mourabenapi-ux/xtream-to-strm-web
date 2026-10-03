-- Migration: dashboard v2
-- Date: 2026-10-03
-- Description: what the dashboard remembers between two looks at it.
--
-- app_conditions: the problems true right now, recomputed every few minutes.
-- A row that appears is a problem that started, a row that goes away one
-- that cleared. The dashboard banner reads this table.
--
-- app_events: the journal (syncs, guide refreshes, downloads, conditions) and
-- the record notifications are sent from.
--
-- player_fetches: when a player last downloaded a playlist or its guide, and
-- which player. The only proof that the television picked up a change.
--
-- The application also creates these tables at startup. This file is here so
-- an install that only runs the SQL runner ends with the same schema.
-- This runner re-applies every file at boot and splits on the statement
-- terminator, so this comment block must never contain one.

CREATE TABLE IF NOT EXISTS app_conditions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key VARCHAR NOT NULL UNIQUE,
    severity VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    detail TEXT,
    action TEXT,
    link VARCHAR,
    since DATETIME NOT NULL,
    last_seen DATETIME NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    notified BOOLEAN NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL,
    kind VARCHAR NOT NULL,
    severity VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    detail TEXT,
    link VARCHAR,
    notified BOOLEAN NOT NULL DEFAULT 0,
    notify_error VARCHAR
);
CREATE INDEX IF NOT EXISTS ix_app_events_created_at ON app_events (created_at);
CREATE TABLE IF NOT EXISTS player_fetches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    kind VARCHAR NOT NULL,
    client VARCHAR NOT NULL,
    user_agent VARCHAR,
    address VARCHAR,
    first_at DATETIME NOT NULL,
    last_at DATETIME NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT uq_player_fetch UNIQUE (playlist_id, kind, client)
)
