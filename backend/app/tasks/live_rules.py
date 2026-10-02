"""Keep rule groups topped up without anyone opening the editor.

A rule group (see services/playlist_tools.GroupRule) only helps if it grows on
its own: the whole point is that a new "beIN Sports" channel appears in the
player without a visit to the editor. Hourly, matching the Xtream catalogue
cache, which is when a provider's additions become visible here anyway.
"""
import asyncio
import logging

from app.core.celery_app import celery_app
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)


@celery_app.task
def refresh_live_rule_groups():
    import app.db.base  # noqa: F401  (registers every model before the query)
    from app.models.live import LivePlaylist, LivePlaylistBouquet
    from app.api.api_v1.endpoints.live_tools import refresh_rule_groups

    db = SessionLocal()
    try:
        playlist_ids = {
            pid for (pid,) in db.query(LivePlaylistBouquet.playlist_id)
            .filter(LivePlaylistBouquet.rule.isnot(None)).distinct()
        }
        for playlist_id in sorted(playlist_ids):
            playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
            if not playlist:
                continue
            try:
                report = asyncio.run(refresh_rule_groups(db, playlist))
                added = sum(g["added"] for g in report)
                if added:
                    logger.info("Rule groups of playlist %s: %s channel(s) added %s",
                                playlist_id, added, report)
            except Exception as e:
                db.rollback()
                logger.error("Rule refresh failed for playlist %s: %s", playlist_id, e)
    finally:
        db.close()
