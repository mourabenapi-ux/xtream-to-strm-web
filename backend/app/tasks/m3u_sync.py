"""Compatibility shim — the M3U sync is now the one sync.

This module used to hold a second, weaker copy of the whole sync: it had no
partial-run status, no layout signature, no empty-catalogue guard, no per-item
failure accounting, and it wrote every series episode as a show of its own. All
of that now comes free, because an M3U source goes through ``tasks.sync`` like
any other source, reading its catalogue through ``services.catalog``.

What is left here is the old task name, so that anything still referring to it —
a queued job, an older frontend build — keeps working.
"""

import logging

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.subscription import Subscription

logger = logging.getLogger(__name__)


def resolve_source(db, source_id: int):
    """The unified source for an id that may predate the unification.

    Callers written before migration 007 pass the id the source had in the old
    ``m3u_sources`` table, so both are accepted.
    """
    sub = db.query(Subscription).filter(Subscription.id == source_id).first()
    if sub:
        return sub
    return db.query(Subscription).filter(
        Subscription.legacy_m3u_source_id == source_id
    ).first()


@celery_app.task
def sync_m3u_source_task(source_id: int, sync_types: list = None, force: bool = False):
    # Imported here, not at module level: Celery loads this module from
    # `celery_app`, which `tasks.sync` imports first — at module level the two
    # would be a circular import and nothing would start.
    from app.tasks.sync import sync_movies_task, sync_series_task

    db = SessionLocal()
    try:
        sub = resolve_source(db, source_id)
        if not sub:
            logger.error("M3U source %s not found", source_id)
            return {"error": "Source not found"}
        subscription_id = sub.id
    finally:
        db.close()

    wanted = set(sync_types or ["movies", "series"])
    started = []
    if "movies" in wanted:
        sync_movies_task.delay(subscription_id, force=force)
        started.append("movies")
    if "series" in wanted:
        sync_series_task.delay(subscription_id, force=force)
        started.append("series")

    return {"source_id": subscription_id, "started": started}
