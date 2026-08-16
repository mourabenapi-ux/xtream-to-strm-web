import sqlite3
import os
import sys
import logging

# Configure logging to stdout so it appears in docker logs
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

def apply_migrations():
    logger.info("🚀 Starting database migration check...")
    
    # 1. Discover Database Path
    raw_url = os.environ.get("DATABASE_URL", "sqlite:////db/xtream.db")
    logger.info(f"Original DATABASE_URL: {raw_url}")
    
    db_path = raw_url
    if db_path.startswith("sqlite:///"):
        # Handle 3 vs 4 slashes
        if db_path.startswith("sqlite:////"):
            db_path = db_path.replace("sqlite:////", "/")
        else:
            db_path = db_path.replace("sqlite:///", "")
    
    # Clean up any potential double slashes
    db_path = os.path.normpath(db_path)
    
    # Try multiple common paths if the resolved one doesn't exist
    possible_paths = [
        db_path,
        "/db/xtream.db",
        "/app/db/xtream.db",
        "db/xtream.db"
    ]
    
    final_db_path = None
    for path in possible_paths:
        if os.path.exists(path):
            final_db_path = path
            break
            
    if not final_db_path:
        logger.error(f"❌ Could not find database file. Tried: {possible_paths}")
        logger.info("If you use a custom path, ensure DATABASE_URL is set correctly.")
        return

    logger.info(f"✅ Found database at: {final_db_path}")

    # 2. Discover Migrations
    # We check relative and absolute to be safe
    migrations_dirs = ["/app/migrations", "./migrations", "backend/migrations"]
    mig_dir = None
    for d in migrations_dirs:
        if os.path.exists(d) and any(f.endswith(".sql") for f in os.listdir(d)):
            mig_dir = d
            break
            
    if not mig_dir:
        logger.error(f"❌ Could not find migrations directory with .sql files in: {migrations_dirs}")
        return

    logger.info(f"📂 Using migrations from: {mig_dir}")
    sql_files = sorted([f for f in os.listdir(mig_dir) if f.endswith(".sql")])

    # 3. Apply Migrations
    conn = sqlite3.connect(final_db_path)
    cursor = conn.cursor()

    for sql_file in sql_files:
        logger.info(f"🔹 Applying {sql_file}...")
        try:
            with open(os.path.join(mig_dir, sql_file), 'r') as f:
                sql_script = f.read()
            
            # Use executescript for robust semicolon/comment handling
            # But we want to skip "already exists" errors, so we'll stick to statement splitting
            # or try/except block for EACH statement.
            statements = sql_script.split(';')
            for statement in statements:
                stmt = statement.strip()
                if not stmt:
                    continue
                try:
                    cursor.execute(stmt)
                    logger.info(f"  OK: {stmt[:60]}...")
                except sqlite3.OperationalError as e:
                    err_msg = str(e).lower()
                    if "duplicate column name" in err_msg or "already exists" in err_msg:
                        logger.info(f"  SKIP: Column already exists.")
                    else:
                        logger.warning(f"  ⚠️ SQL Warning: {e}")
            
            conn.commit()
            logger.info(f"✅ Finished {sql_file}")
        except Exception as e:
            logger.error(f"❌ Error in {sql_file}: {e}")
            conn.rollback()

    conn.close()
    logger.info("🎉 Database update complete.")

if __name__ == "__main__":
    apply_migrations()
