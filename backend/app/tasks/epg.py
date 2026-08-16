from app.core.celery_app import celery_app
from app.services.epg import epg_service
from app.db.session import SessionLocal
from app.models.epg import EPGSourceGlobal
import asyncio
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)

@celery_app.task(bind=True)
def refresh_epg_task(self, source_id: int):
    """Refresh a single EPG source."""
    logger.info(f"Starting background refresh for EPG source {source_id}...")
    db = SessionLocal()
    try:
        source = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.id == source_id).first()
        if not source:
            logger.error(f"EPG Source {source_id} not found")
            return
            
        if not source.is_active:
            logger.info(f"EPG Source {source_id} is inactive, skipping refresh")
            return
            
        # Run async background fetch. The session is passed so an 'xtream'
        # source can look up its subscription to build the guide URL.
        asyncio.run(epg_service.fetch_and_cache_epg(source, db_session=db))

        # Update metadata
        source.last_updated = datetime.utcnow()
        # Update channel count from Redis
        source.channel_count = epg_service.redis.scard(f"epg:src:{source.id}:channels")

        db.commit()
        if source.channel_count:
            logger.info(f"✅ EPG Source '{source.name}' refreshed. Found {source.channel_count} channels.")
        else:
            # Not an exception, but not a success either — this is the state an
            # 'xtream' source sat in permanently while reporting nothing wrong.
            logger.warning(
                f"⚠️ EPG Source '{source.name}' refreshed but cached 0 channels. "
                "Check its URL, file path or subscription."
            )
    except Exception as e:
        logger.error(f"❌ Failed to refresh EPG source {source_id}: {e}")
        db.rollback()
    finally:
        db.close()

@celery_app.task
def refresh_all_active_epg_sources():
    """Trigger refresh for all active global EPG sources."""
    db = SessionLocal()
    try:
        sources = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.is_active == True).all()
        logger.info(f"Queuing refresh for {len(sources)} active EPG sources...")
        for source in sources:
            refresh_epg_task.delay(source.id)
    finally:
        db.close()

@celery_app.task
def check_epg_refresh_schedule():
    """Check which EPG sources need a refresh based on their interval."""
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        sources = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.is_active == True).all()
        
        refresh_count = 0
        for source in sources:
            should_refresh = False
            if not source.last_updated:
                should_refresh = True
            else:
                elapsed_hours = (now - source.last_updated).total_seconds() / 3600
                if elapsed_hours >= source.refresh_interval_hours:
                    should_refresh = True
            
            if should_refresh:
                refresh_epg_task.delay(source.id)
                refresh_count += 1
        
        if refresh_count > 0:
            logger.info(f"Scheduled refresh triggered for {refresh_count} EPG sources.")
    finally:
        db.close()
