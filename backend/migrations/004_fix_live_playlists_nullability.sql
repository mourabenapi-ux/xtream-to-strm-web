-- Migration: Fix live_playlists.subscription_id nullability
-- Description: Recreates live_playlists table to remove NOT NULL constraint from subscription_id.

-- 1. Create new table
CREATE TABLE live_playlists_new (
    id INTEGER NOT NULL, 
    subscription_id INTEGER, 
    name VARCHAR NOT NULL, 
    description VARCHAR, 
    created_at DATETIME, 
    PRIMARY KEY (id), 
    FOREIGN KEY(subscription_id) REFERENCES subscriptions (id)
);

-- 2. Copy data
INSERT INTO live_playlists_new (id, subscription_id, name, description, created_at)
SELECT id, subscription_id, name, description, created_at FROM live_playlists;

-- 3. Drop old table
DROP TABLE live_playlists;

-- 4. Rename new table
ALTER TABLE live_playlists_new RENAME TO live_playlists;
