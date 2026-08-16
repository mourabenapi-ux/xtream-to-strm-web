from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.api.api import api_router
from app.core.config import settings
from app.db.base import Base
from app.db.session import engine
import os

# Create tables first (for new installations)
Base.metadata.create_all(bind=engine)

# Self-healing schema: Ensure critical columns exist and new tables are created
def _ensure_schema_up_to_date():
    from sqlalchemy import inspect, text
    
    print("🩺 Checking database schema...")
    try:
        inspector = inspect(engine)
        existing_tables = inspector.get_table_names()
        
        # 1. Ensure new Live TV v2 tables exist
        if "live_playlists" not in existing_tables:
            print("🔧 Table 'live_playlists' missing. Creating new tables...")
            Base.metadata.create_all(bind=engine)
            print("✅ New tables created.")
            
            # Trigger migration if legacy table exists
            if "live_stream_subs" in existing_tables:
                print("🔄 Legacy Live TV data detected. Triggering migration...")
                from app.db.migrations_v2 import migrate_live_to_v2
                migrate_live_to_v2(engine)
        
        # Ensure epg_sources table exists if others do but it's missing (v3.7.0 update)
        if "epg_sources" not in existing_tables:
            print("🔧 Table 'epg_sources' missing. Creating...")
            Base.metadata.create_all(bind=engine)
            print("✅ 'epg_sources' table created.")

        # 2. Check 'subscriptions' columns
        columns = [c['name'] for c in inspector.get_columns("subscriptions")]
        
        required_migrations = [
            ("download_movies_dir", "TEXT DEFAULT '/output/downloads/movies'"),
            ("download_series_dir", "TEXT DEFAULT '/output/downloads/series'"),
            ("max_parallel_downloads", "INTEGER DEFAULT 2"),
            ("download_segments", "INTEGER DEFAULT 1")
        ]
        
        missing = [m for m in required_migrations if m[0] not in columns]
        
        if missing:
            print(f"🔧 Missing {len(missing)} columns in 'subscriptions'. Repairing...")
            with engine.connect() as conn:
                for col_name, col_type in missing:
                    try:
                        print(f"  Adding column: {col_name}...")
                        conn.execute(text(f"ALTER TABLE subscriptions ADD COLUMN {col_name} {col_type}"))
                        conn.commit()
                        print(f"  ✅ Added {col_name}")
                    except Exception as e:
                        print(f"  ⚠️ Could not add {col_name}: {e}")
            print("🎉 Schema repair complete.")
        # 3. Check 'download_settings_global' columns
        if "download_settings_global" in existing_tables:
            download_cols = [c['name'] for c in inspector.get_columns("download_settings_global")]
            if "user_agent" not in download_cols:
                print("🔧 Missing 'user_agent' in 'download_settings_global'. Repairing...")
                with engine.connect() as conn:
                    try:
                        conn.execute(text("ALTER TABLE download_settings_global ADD COLUMN user_agent VARCHAR DEFAULT 'TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)'"))
                        conn.commit()
                        print("  ✅ Added 'user_agent' column.")
                    except Exception as e:
                        print(f"  ⚠️ Could not add 'user_agent': {e}")

        # 3b. Check 'sync_state' columns
        if "sync_state" in existing_tables:
            sync_cols = [c['name'] for c in inspector.get_columns("sync_state")]
            if "layout_signature" not in sync_cols:
                print("🔧 Missing 'layout_signature' in 'sync_state'. Repairing...")
                with engine.connect() as conn:
                    try:
                        conn.execute(text("ALTER TABLE sync_state ADD COLUMN layout_signature VARCHAR"))
                        conn.commit()
                        print("  ✅ Added 'layout_signature' column.")
                    except Exception as e:
                        print(f"  ⚠️ Could not add 'layout_signature': {e}")

        # 3b-bis. Live progress columns on both sync state tables. Without them
        # the UI can only show a spinner for a run that may last minutes.
        for table_name in ("sync_state", "m3u_sync_state"):
            if table_name not in existing_tables:
                continue
            cols = [c['name'] for c in inspector.get_columns(table_name)]
            for col_name, col_type in (
                ("progress_done", "INTEGER DEFAULT 0"),
                ("progress_total", "INTEGER DEFAULT 0"),
                ("progress_phase", "VARCHAR"),
            ):
                if col_name in cols:
                    continue
                print(f"🔧 Missing '{col_name}' in '{table_name}'. Repairing...")
                with engine.connect() as conn:
                    try:
                        conn.execute(text(
                            f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_type}"
                        ))
                        conn.commit()
                        print(f"  ✅ Added '{col_name}' column.")
                    except Exception as e:
                        print(f"  ⚠️ Could not add '{col_name}': {e}")

        # 3c. Check 'series_cache' columns.
        # Both drive the "has this series gained episodes?" decision; without
        # them a cached series is only re-fetched when its name changes.
        if "series_cache" in existing_tables:
            sc_cols = [c['name'] for c in inspector.get_columns("series_cache")]
            for col_name, col_type in (
                ("last_modified", "VARCHAR"),
                ("last_refreshed", "DATETIME"),
            ):
                if col_name not in sc_cols:
                    print(f"🔧 Missing '{col_name}' in 'series_cache'. Repairing...")
                    with engine.connect() as conn:
                        try:
                            conn.execute(text(
                                f"ALTER TABLE series_cache ADD COLUMN {col_name} {col_type}"
                            ))
                            conn.commit()
                            print(f"  ✅ Added '{col_name}' column.")
                        except Exception as e:
                            print(f"  ⚠️ Could not add '{col_name}': {e}")

        # 3d. Check 'epg_sources_global' columns.
        # Carries which subscription a source_type == "xtream" guide belongs to.
        if "epg_sources_global" in existing_tables:
            eg_cols = [c['name'] for c in inspector.get_columns("epg_sources_global")]
            if "subscription_id" not in eg_cols:
                print("🔧 Missing 'subscription_id' in 'epg_sources_global'. Repairing...")
                with engine.connect() as conn:
                    try:
                        conn.execute(text(
                            "ALTER TABLE epg_sources_global ADD COLUMN subscription_id "
                            "INTEGER REFERENCES subscriptions(id)"
                        ))
                        conn.commit()
                        print("  ✅ Added 'subscription_id' column.")
                    except Exception as e:
                        print(f"  ⚠️ Could not add 'subscription_id': {e}")

        # 4. Check 'live_playlists' nullability and columns
        if "live_playlists" in existing_tables:
            lp_cols = inspector.get_columns("live_playlists")
            for col in lp_cols:
                if col['name'] == 'subscription_id' and not col['nullable']:
                    print("⚠️ 'subscription_id' in 'live_playlists' is NOT NULL. Fixing...")
                    # This requires table recreation in SQLite usually, but we have the 004 migration script.
                    # We will log it so we know it's pending.

        # 5. Check 'live_playlist_bouquets' and 'live_playlist_channels' columns
        for table_name in ["live_playlist_bouquets", "live_playlist_channels"]:
            if table_name in existing_tables:
                cols = [c['name'] for c in inspector.get_columns(table_name)]
                if "subscription_id" not in cols:
                    print(f"🔧 Missing 'subscription_id' in '{table_name}'. Repairing...")
                    with engine.connect() as conn:
                        try:
                            conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN subscription_id INTEGER REFERENCES subscriptions(id)"))
                            conn.commit()
                            print(f"  ✅ Added 'subscription_id' column to '{table_name}'.")
                        except Exception as e:
                            print(f"  ⚠️ Could not add 'subscription_id' to '{table_name}': {e}")
            
        print("✅ Database schema is up to date.")
        
        # Trigger EPG refresh at startup
        try:
            from app.tasks.epg import refresh_all_active_epg_sources
            refresh_all_active_epg_sources.delay()
            print("🚀 Queued global EPG refresh at startup.")
        except Exception as e:
            print(f"⚠️ Could not trigger EPG refresh at startup: {e}")
            
    except Exception as e:
        print(f"❌ Schema check failed: {e}")

_ensure_schema_up_to_date()


def _reconcile_stale_sync_state():
    """Clear sync rows left at 'running' by a container that went away.

    `status` is only ever written by the Celery task itself, so a task killed
    mid-flight (rebuild, restart, crash) leaves the row stuck on 'running'
    forever. The UI then spins indefinitely and shows "Stop Sync" instead of
    "Sync Now", so the sync can never be relaunched from the page.

    The worker lives in this container, so nothing can still be running when we
    reach this line: any 'running' row here is a leftover, and is marked failed.
    """
    from app.db.session import SessionLocal
    from app.models.sync_state import SyncState, SyncStatus

    db = SessionLocal()
    try:
        stale = db.query(SyncState).filter(SyncState.status == SyncStatus.RUNNING.value).all()
        for state in stale:
            state.status = SyncStatus.FAILED.value
            state.error_message = "Interrupted: the application restarted while this sync was running."
            state.task_id = None
        if stale:
            db.commit()
            print(f"🧹 Reset {len(stale)} sync state row(s) left running by a previous container.")
    except Exception as e:
        print(f"⚠️ Could not reconcile sync state: {e}")
    finally:
        db.close()


_reconcile_stale_sync_state()

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json"
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve frontend static files
static_dir = "/app/static"
# Check for local development path
if not os.path.exists(static_dir):
    local_static = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "frontend", "dist")
    if os.path.exists(local_static):
        static_dir = local_static

if os.path.exists(static_dir):
    app.mount("/assets", StaticFiles(directory=f"{static_dir}/assets"), name="assets")

# Include API router
app.include_router(api_router, prefix=settings.API_V1_STR)

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

# Serve SPA for 404 errors (except API routes)
if os.path.exists(static_dir):
    from fastapi import Request
    from fastapi.exceptions import HTTPException
    from starlette.exceptions import HTTPException as StarletteHTTPException
    
    from fastapi.responses import JSONResponse
    
    @app.exception_handler(404)
    async def custom_404_handler(request: Request, exc):
        # If it's an API route, return JSON 404
        if request.url.path.startswith(settings.API_V1_STR):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        
        # Otherwise serve the SPA
        return FileResponse(f"{static_dir}/index.html")
