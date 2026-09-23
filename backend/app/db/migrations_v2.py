from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
from app.models.live import LivePlaylist, LivePlaylistBouquet, LiveStreamSubscription
import logging

logger = logging.getLogger(__name__)

def migrate_live_to_v2(engine):
    """
    Migrate data from LiveStreamSubscription to LivePlaylist and LivePlaylistBouquet.
    """
    print("🚀 Starting Live TV v2 migration...")
    
    with Session(engine) as session:
        try:
            # Check if legacy table has data
            inspector = inspect(engine)
            if "live_stream_subs" not in inspector.get_table_names():
                print("ℹ️ Legacy table 'live_stream_subs' not found. Skipping migration.")
                return

            legacy_subs = session.query(LiveStreamSubscription).all()
            if not legacy_subs:
                print("ℹ️ No legacy Live TV data to migrate.")
                return

            for l_sub in legacy_subs:
                # Check if already migrated (optional check)
                existing_playlist = session.query(LivePlaylist).filter_by(
                    subscription_id=l_sub.subscription_id, 
                    name="Default"
                ).first()
                
                if existing_playlist:
                    print(f"⏩ Subscription {l_sub.subscription_id} already has a 'Default' playlist. Skipping.")
                    continue

                print(f"📦 Migrating Subscription {l_sub.subscription_id}...")
                
                # Create Playlist
                playlist = LivePlaylist(
                    subscription_id=l_sub.subscription_id,
                    name="Default",
                    description="Playlist migrée depuis v3.1.0"
                )
                session.add(playlist)
                session.flush() # Get playlist ID

                # Create Bouquets
                if l_sub.included_categories:
                    for idx, cat_id in enumerate(l_sub.included_categories):
                        bouquet = LivePlaylistBouquet(
                            playlist_id=playlist.id,
                            category_id=str(cat_id),
                            order=idx
                        )
                        session.add(bouquet)
                
                # Note: excluded_streams are not migrated to LivePlaylistChannel 
                # because we don't know their category_id without an API call.
                # The user will need to re-exclude them in the new UI if needed,
                # or we could keep the legacy list as a fallback.
                
            session.commit()
            print("✅ Migration successful.")
            
        except Exception as e:
            session.rollback()
            print(f"❌ Migration failed: {e}")
            logger.error(f"Migration error: {e}")
