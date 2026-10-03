"""The dashboard's background work.

``refresh_overview`` runs every five minutes: it rebuilds the snapshot the
page reads (``services/overview.py``), recomputes the list of problems, and
diffs it against the stored one. A problem that appears is written to the
journal; once it has survived two passes it is pushed to the phone; when it
clears, the journal says so, and so does the phone if it had been told.

``capture_wall`` opens each free channel of the featured playlist like a
player would and keeps one frame. It never touches a paid provider: those
allow one connection, and the capture would cut the television off.

``push_event`` sends one journal line to the configured channels.
"""
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

from app.core.celery_app import celery_app
from app.core.redis import redis_conn
from app.db.session import SessionLocal
from app.models.dashboard import AppCondition, AppEvent, Severity
from app.services import dashboard_settings, notify, overview
from app.services.events import record_event

logger = logging.getLogger(__name__)

LOCK_KEY = "dashboard:lock"
QUEUED_KEY = "dashboard:queued"
WALL_LOCK_KEY = "dashboard:wall:lock:{}"
WALL_SIZE = 12          # channels captured per playlist
WALL_EVERY = 15 * 60    # seconds before a capture is considered stale


def _link(values: Dict[str, str], path: str) -> str:
    base = (values.get("PUBLIC_BASE_URL") or "").rstrip("/")
    return f"{base}{path}" if base else ""


def apply_conditions(db, conditions: List[Dict[str, Any]], values: Dict[str, str],
                     now: datetime = None) -> Dict[str, int]:
    """Diff the problems found now against the stored ones.

    New → stored and journalled. Still there → counted; pushed on the second
    sighting, so a 30-second glitch (a guide reloading after a restart) never
    reaches the phone. Gone → deleted, journalled, and pushed as resolved if
    the phone had been told it started.
    """
    now = now or datetime.utcnow()
    stored = {c.key: c for c in db.query(AppCondition).all()}
    found = {c["key"]: c for c in conditions}
    pushes: List[Dict[str, Any]] = []
    stats = {"new": 0, "kept": 0, "cleared": 0, "pushed": 0}
    configured = dashboard_settings.notifications_configured(values)

    for key, cond in found.items():
        action = json.dumps(cond["action"]) if cond.get("action") else None
        row = stored.get(key)
        if row is None:
            row = AppCondition(key=key, severity=cond["severity"], title=cond["title"],
                               detail=cond.get("detail"), action=action, link=cond.get("link"),
                               since=now, last_seen=now, seen_count=1, notified=False)
            db.add(row)
            stats["new"] += 1
            record_event(db, "condition", cond["title"], severity=cond["severity"],
                         detail=cond.get("detail"), link=cond.get("link"))
        else:
            row.severity, row.title, row.detail = cond["severity"], cond["title"], cond.get("detail")
            row.action, row.link, row.last_seen = action, cond.get("link"), now
            row.seen_count = (row.seen_count or 0) + 1
            stats["kept"] += 1
        if (configured and not row.notified and row.seen_count >= 2
                and notify.should_push(values, row.severity)):
            pushes.append({"title": row.title, "detail": row.detail or "", "severity": row.severity,
                           "link": cond.get("link")})
            row.notified = True
            row.pushed = True

    for key, row in stored.items():
        if key in found:
            continue
        stats["cleared"] += 1
        record_event(db, "resolved", f"Resolved: {row.title}", severity=Severity.INFO, link=row.link)
        if configured and row.pushed:
            pushes.append({"title": f"Resolved: {row.title}", "detail": "", "severity": Severity.INFO,
                           "link": row.link})
        db.delete(row)
    db.commit()

    for push in pushes:
        notify.send(values, push["title"], push["detail"], push["severity"],
                    _link(values, push["link"] or "/") or None)
        stats["pushed"] += 1
    return stats


async def run_monitor(db, force_accounts: bool = False, check_workers: bool = True) -> Dict[str, Any]:
    values = dashboard_settings.load(db)
    snapshot = await overview.build_snapshot(db, values, force_accounts=force_accounts,
                                             check_workers=check_workers)
    conditions = overview.compute_conditions(snapshot)
    stats = apply_conditions(db, conditions, values)
    logger.info("Dashboard refreshed in %s ms: %s", snapshot.get("duration_ms"), stats)
    return snapshot


@celery_app.task
def refresh_overview(force_accounts: bool = False):
    # One pass at a time: the beat and a click on "refresh" can collide.
    if not redis_conn.set(LOCK_KEY, "1", nx=True, ex=180):
        redis_conn.delete(QUEUED_KEY)
        return "already running"
    redis_conn.delete(QUEUED_KEY)
    db = SessionLocal()
    try:
        asyncio.run(run_monitor(db, force_accounts=force_accounts))
        return "ok"
    finally:
        db.close()
        redis_conn.delete(LOCK_KEY)


@celery_app.task
def push_event(event_id: int):
    db = SessionLocal()
    try:
        event = db.query(AppEvent).filter(AppEvent.id == event_id).first()
        if not event:
            return
        values = dashboard_settings.load(db)
        if not dashboard_settings.notifications_configured(values):
            return
        results = notify.send(values, event.title, event.detail or "", event.severity,
                              _link(values, event.link or "/") or None)
        errors = [r.get("error") for r in results if r.get("ok") != "true"]
        event.notified = any(r.get("ok") == "true" for r in results)
        event.notify_error = "; ".join(e for e in errors if e)[:300] or None
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# TV wall
# ---------------------------------------------------------------------------

async def _grab(url: str, agent: List[str]) -> Dict[str, Any]:
    """One frame of a stream, as a small JPEG, the way the editor's test does."""
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", *agent, "-rw_timeout", "10000000", "-i", url,
        "-frames:v", "1", "-vf", "scale=400:-2", "-q:v", "6", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=25)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return {"ok": False, "error": "No picture within 25 s", "seconds": 25.0}
    seconds = round(time.monotonic() - started, 1)
    if proc.returncode != 0 or not out:
        message = (err.decode(errors="ignore").strip().splitlines() or ["no answer"])[-1]
        return {"ok": False, "error": message.replace(url, "<stream>")[:200], "seconds": seconds}
    return {"ok": True, "image": out, "seconds": seconds}


async def _capture(db, playlist_id: int) -> Dict[str, Any]:
    from app.api.api_v1.endpoints.live import resolve_playlist_channels
    from app.models.downloads import DownloadSettingsGlobal
    from app.models.live import LivePlaylist
    from app.models.subscription import SourceKind, Subscription

    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        return {"captured": 0}
    kinds = {s.id: s.kind for s in db.query(Subscription).all()}
    channels = await resolve_playlist_channels(db, playlist)
    free = [c for c in channels if kinds.get(c["subscription_id"]) == SourceKind.M3U.value
            and c.get("channel_id") is not None]
    free.sort(key=lambda c: (c.get("number") if c.get("number") is not None else 10 ** 9))
    chosen = free[:WALL_SIZE]
    agent: List[str] = []
    settings_row = db.query(DownloadSettingsGlobal).first()
    if settings_row and getattr(settings_row, "user_agent", None):
        agent = ["-user_agent", settings_row.user_agent]

    key = overview.WALL_KEY.format(playlist_id)
    started = datetime.now(timezone.utc).isoformat()
    redis_conn.setex(overview.WALL_META_KEY.format(playlist_id), 86400,
                     json.dumps({"started_at": started, "running": True, "total": len(chosen)}))
    ok = 0
    for ch in chosen:
        result = await _grab(ch["url"], agent)
        status = {"channel_id": ch["channel_id"], "name": ch["name"], "number": ch.get("number"),
                  "ok": result["ok"], "seconds": result.get("seconds"), "error": result.get("error"),
                  "checked_at": datetime.now(timezone.utc).isoformat()}
        if result["ok"]:
            ok += 1
            overview.redis_bin.setex(overview.WALL_IMAGE_KEY.format(playlist_id, ch["channel_id"]),
                                     6 * 3600, result["image"])
        redis_conn.hset(key, str(ch["channel_id"]), json.dumps(status))
    redis_conn.expire(key, 86400)
    # Channels no longer in the selection are dropped from the status.
    keep = {str(c["channel_id"]) for c in chosen}
    for stale in set(redis_conn.hkeys(key)) - keep:
        redis_conn.hdel(key, stale)
    redis_conn.setex(overview.WALL_META_KEY.format(playlist_id), 86400, json.dumps({
        "started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(),
        "running": False, "total": len(chosen), "ok": ok,
        "skipped_paid": sum(1 for c in channels if kinds.get(c["subscription_id"]) != SourceKind.M3U.value),
    }))
    return {"captured": ok, "total": len(chosen)}


@celery_app.task
def capture_wall(playlist_id: int):
    lock = WALL_LOCK_KEY.format(playlist_id)
    if not redis_conn.set(lock, "1", nx=True, ex=600):
        return "already running"
    db = SessionLocal()
    try:
        values = dashboard_settings.load(db)
        if not dashboard_settings.as_bool(values, "TVWALL_ENABLED"):
            return "disabled"
        return asyncio.run(_capture(db, playlist_id))
    finally:
        db.close()
        redis_conn.delete(lock)
