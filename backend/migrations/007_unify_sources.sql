-- Migration: fold the M3U sources into the one `subscriptions` table
-- Date: 2026-08-17
-- Description: An Xtream subscription and an M3U playlist only differ by how
-- their catalogue is fetched. Everything downstream (selection, .strm writing,
-- downloads, live playlists, EPG) treats them the same, so they now live in one
-- table told apart by `kind`, read through one adapter interface, and written
-- by one sync.
--
-- `subscriptions` is extended rather than replaced, and keeps its name: every
-- other table points at subscriptions.id, so nothing had to be re-keyed. The
-- old m3u_sources / m3u_entries / m3u_selections / m3u_sync_state tables are
-- left in place and untouched -- their content is copied into the unified
-- tables, so a rollback is a matter of ignoring the new rows.
--
-- This runner re-applies every migration at each boot, so every statement below
-- is written to be a no-op the second time.

-- 1. The discriminator, and the M3U connection fields.
ALTER TABLE subscriptions ADD COLUMN kind VARCHAR NOT NULL DEFAULT 'xtream';
ALTER TABLE subscriptions ADD COLUMN source_type VARCHAR;
ALTER TABLE subscriptions ADD COLUMN url VARCHAR;
ALTER TABLE subscriptions ADD COLUMN file_path VARCHAR;
ALTER TABLE subscriptions ADD COLUMN output_dir VARCHAR;
ALTER TABLE subscriptions ADD COLUMN sync_status VARCHAR DEFAULT 'idle';
ALTER TABLE subscriptions ADD COLUMN last_sync DATETIME;
ALTER TABLE subscriptions ADD COLUMN created_at DATETIME;
ALTER TABLE subscriptions ADD COLUMN updated_at DATETIME;
ALTER TABLE subscriptions ADD COLUMN legacy_m3u_source_id INTEGER;

CREATE INDEX IF NOT EXISTS ix_subscriptions_kind ON subscriptions (kind);
CREATE INDEX IF NOT EXISTS ix_subscriptions_legacy_m3u_source_id ON subscriptions (legacy_m3u_source_id);

UPDATE subscriptions SET kind = 'xtream' WHERE kind IS NULL OR kind = '';

-- 2. Copy every M3U source in as a source of kind 'm3u'.
-- Guarded by legacy_m3u_source_id, which is what makes the re-run a no-op.
-- The Xtream connection columns are NOT NULL on installs that predate this
-- migration, hence the empty strings rather than NULLs.
-- A name already taken by an Xtream subscription gets the " (M3U)" suffix:
-- subscriptions.name is UNIQUE and the two tables had separate namespaces.
INSERT INTO subscriptions (
    name, kind, xtream_url, username, password,
    source_type, url, file_path, output_dir,
    movies_dir, series_dir,
    download_movies_dir, download_series_dir, max_parallel_downloads, download_segments,
    is_active, sync_status, last_sync, created_at, updated_at, legacy_m3u_source_id
)
SELECT
    CASE WHEN EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.name = m.name)
         THEN m.name || ' (M3U)' ELSE m.name END,
    'm3u', '', '', '',
    LOWER(m.source_type), m.url, m.file_path, m.output_dir,
    COALESCE(m.movies_dir, m.output_dir || '/movies'),
    COALESCE(m.series_dir, m.output_dir || '/series'),
    '/output/downloads/movies', '/output/downloads/series', 2, 1,
    m.is_active, COALESCE(m.sync_status, 'idle'), m.last_sync, m.created_at, m.updated_at,
    m.id
FROM m3u_sources m
WHERE NOT EXISTS (
    SELECT 1 FROM subscriptions s WHERE s.legacy_m3u_source_id = m.id
);

-- 3. The parsed playlist, in a table of its own rather than the old
-- m3u_entries. The old table's entry_type carries a CHECK constraint that
-- allows only MOVIE and SERIES, and SQLite cannot drop a constraint without
-- rebuilding the table -- while the whole point of this work is to stop
-- throwing the live entries away. This is a cache: it refills on the next
-- parse, so nothing is migrated into it.
CREATE TABLE IF NOT EXISTS source_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
    title VARCHAR NOT NULL,
    url VARCHAR NOT NULL,
    group_title VARCHAR,
    logo VARCHAR,
    tvg_id VARCHAR,
    tvg_name VARCHAR,
    entry_type VARCHAR NOT NULL DEFAULT 'live',
    series_key VARCHAR,
    season INTEGER,
    episode INTEGER,
    container VARCHAR
);

CREATE INDEX IF NOT EXISTS ix_source_entries_subscription_id ON source_entries (subscription_id);
CREATE INDEX IF NOT EXISTS ix_source_entries_entry_type ON source_entries (entry_type);
CREATE INDEX IF NOT EXISTS ix_source_entries_series_key ON source_entries (series_key);

-- 4. The M3U group selections become ordinary selected categories, where the
-- category id is the group title. Both columns are plain text on both sides.
INSERT INTO selected_categories (subscription_id, category_id, type, name)
SELECT s.id, sel.group_title, LOWER(sel.selection_type), sel.group_title
FROM m3u_selections sel
JOIN subscriptions s ON s.legacy_m3u_source_id = sel.m3u_source_id
WHERE NOT EXISTS (
    SELECT 1 FROM selected_categories sc
    WHERE sc.subscription_id = s.id
      AND sc.category_id = sel.group_title
      AND sc.type = LOWER(sel.selection_type)
);

-- 5. Same for the per-type sync state, so an M3U source keeps its history and
-- gains the columns the Xtream side already had (partial runs, layout).
INSERT INTO sync_state (
    subscription_id, type, last_sync, status, items_added, items_deleted,
    error_message, progress_done, progress_total
)
SELECT s.id, st.type, st.last_sync, 'idle', COALESCE(st.items_added, 0),
       COALESCE(st.items_deleted, 0), st.error_message, 0, 0
FROM m3u_sync_state st
JOIN subscriptions s ON s.legacy_m3u_source_id = st.m3u_source_id
WHERE NOT EXISTS (
    SELECT 1 FROM sync_state ss
    WHERE ss.subscription_id = s.id AND ss.type = st.type
);
