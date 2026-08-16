import sqlite3
import os
import logging
from datetime import datetime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def migrate_data():
    # Discover DB path (similar logic to apply_migrations.py)
    raw_url = os.environ.get("DATABASE_URL", "sqlite:////db/xtream.db")
    db_path = raw_url.replace("sqlite:////", "/").replace("sqlite:///", "")
    db_path = os.path.normpath(db_path)
    
    if not os.path.exists(db_path):
        # Try relative path for local dev
        db_path = "db/xtream.db"
        if not os.path.exists(db_path):
            logger.error(f"DB not found at {db_path}")
            return

    logger.info(f"Using DB at {db_path}")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # Check if old table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='epg_sources'")
        if not cursor.fetchone():
            logger.info("Old epg_sources table not found. Skipping migration.")
            return

        # Fetch old data
        cursor.execute("SELECT id, playlist_id, source_type, source_url, file_path, priority, last_updated, is_active FROM epg_sources")
        old_rows = cursor.fetchall()
        
        if not old_rows:
            logger.info("No EPG data to migrate.")
            return

        logger.info(f"Found {len(old_rows)} EPG records to migrate.")

        # Deduplicate by (source_url, source_type) or (file_path, source_type)
        unique_globals = {} # (source_url/file_path, type) -> global_id
        
        for row in old_rows:
            old_id, playlist_id, s_type, s_url, f_path, priority, last_upd, is_active = row
            
            key = (s_url or f_path, s_type)
            
            if key not in unique_globals:
                # Create a global entry
                name = f"EPG Source {len(unique_globals) + 1}"
                if s_url:
                    if "github" in s_url: name = "GitHub XMLTV"
                    elif "iptv-org" in s_url: name = "IPTV-org EPG"
                    else: name = f"Remote URL ({s_url[:20]}...)"
                elif f_path:
                    name = f"File: {os.path.basename(f_path)}"
                
                cursor.execute("""
                    INSERT INTO epg_sources_global (name, source_type, source_url, file_path, is_active, last_updated)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (name, s_type, s_url, f_path, is_active, last_upd))
                
                global_id = cursor.lastrowid
                unique_globals[key] = global_id
                logger.info(f"Created global EPG source: {name} (ID: {global_id})")
            else:
                global_id = unique_globals[key]

            # Create link
            cursor.execute("""
                INSERT INTO playlist_epg_sources (playlist_id, epg_source_id, priority)
                VALUES (?, ?, ?)
            """, (playlist_id, global_id, priority))
            logger.info(f"Linked playlist {playlist_id} to global EPG {global_id} (Priority: {priority})")

        conn.commit()
        logger.info("✅ EPG data migration complete.")
        
        # Optional: Rename old table instead of deleting to be safe
        # cursor.execute("ALTER TABLE epg_sources RENAME TO epg_sources_backup")
        # conn.commit()

    except Exception as e:
        logger.error(f"Migration error: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    migrate_data()
