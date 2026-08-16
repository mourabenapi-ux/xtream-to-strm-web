-- EPG Refactoring v4.0.0
-- Create new global EPG tables

CREATE TABLE IF NOT EXISTS epg_sources_global (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    file_path TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_updated DATETIME,
    channel_count INTEGER DEFAULT 0,
    refresh_interval_hours INTEGER DEFAULT 24
);

CREATE TABLE IF NOT EXISTS playlist_epg_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    epg_source_id INTEGER NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES live_playlists (id),
    FOREIGN KEY (epg_source_id) REFERENCES epg_sources_global (id)
);
