-- Migration: Add subscription_id to live playlist items
-- Description: Enables multi-subscription support by tracking the provider for each bouquet and channel.

-- 1. Update live_playlists to allow null subscription_id (for truly mixed playlists)
-- Note: SQLite doesn't support ALTER TABLE ALTER COLUMN. We might need to keep it as is if it was already there, 
-- but actually SQLAlchemy will handle the nullability in code. 
-- However, if we want to change existing constraint, it's complex in SQLite. 
-- For now, let's just add the missing columns.

-- 2. Add subscription_id to live_playlist_bouquets
ALTER TABLE live_playlist_bouquets ADD COLUMN subscription_id INTEGER REFERENCES subscriptions(id);

-- 3. Add subscription_id to live_playlist_channels
ALTER TABLE live_playlist_channels ADD COLUMN subscription_id INTEGER REFERENCES subscriptions(id);

-- 4. Data Migration: Set subscription_id for existing items based on their parent playlist
-- Existing bouquets
UPDATE live_playlist_bouquets 
SET subscription_id = (
    SELECT subscription_id FROM live_playlists 
    WHERE live_playlists.id = live_playlist_bouquets.playlist_id
)
WHERE subscription_id IS NULL;

-- Existing channels
UPDATE live_playlist_channels 
SET subscription_id = (
    SELECT b.subscription_id FROM live_playlist_bouquets b
    WHERE b.id = live_playlist_channels.bouquet_id
)
WHERE subscription_id IS NULL;
