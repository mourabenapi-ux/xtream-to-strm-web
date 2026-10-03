"""The dashboard: what the television and Jellyfin really receive, right now.

Everything expensive is computed in the background (``tasks/dashboard.py``)
and read here from the stored snapshot, so the page answers in milliseconds.
What changes by the minute — the programme on air, the journal, the last
time a player fetched a playlist — is read live.

The older ``/dashboard/stats`` family is still mounted for compatibility.
"""
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.api import deps
from app.core.redis import redis_conn
from app.models.dashboard import AppCondition, AppEvent, Severity
from app.models.live import LivePlaylist
from app.services import dashboard_settings, notify, overview
from app.services.epg import epg_service

router = APIRouter()


def _playlist(db: Session, playlist_id: int) -> LivePlaylist:
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


def _start_pass(force_accounts: bool = False) -> bool:
    """Queue a background pass unless one is already queued or running.

    Never computed inside the request: a pass takes 10 to 20 s, and the web
    server is the one that also answers TiviMate.
    """
    from app.tasks.dashboard import LOCK_KEY, QUEUED_KEY, refresh_overview
    if redis_conn.exists(LOCK_KEY) or not redis_conn.set(QUEUED_KEY, "1", nx=True, ex=90):
        return False
    refresh_overview.delay(force_accounts=force_accounts)
    return True


def _conditions(db: Session) -> List[Dict[str, Any]]:
    rows = db.query(AppCondition).all()
    rows.sort(key=lambda r: (-Severity.ORDER.get(r.severity, 0), r.since))
    return [{
        "key": r.key, "severity": r.severity, "title": r.title, "detail": r.detail,
        "action": json.loads(r.action) if r.action else None, "link": r.link,
        "since": overview.utc_iso(r.since), "notified": bool(r.pushed),
    } for r in rows]


def _events(db: Session, limit: int = 15, before_id: Optional[int] = None) -> List[Dict[str, Any]]:
    query = db.query(AppEvent)
    if before_id:
        query = query.filter(AppEvent.id < before_id)
    return [{
        "id": e.id, "at": overview.utc_iso(e.created_at), "kind": e.kind, "severity": e.severity,
        "title": e.title, "detail": e.detail, "link": e.link, "notified": e.notified,
    } for e in query.order_by(AppEvent.id.desc()).limit(limit).all()]


def _refreshing() -> bool:
    from app.tasks.dashboard import LOCK_KEY, QUEUED_KEY
    return bool(redis_conn.exists(LOCK_KEY) or redis_conn.exists(QUEUED_KEY))


@router.get("/conditions")
def get_conditions(db: Session = Depends(deps.get_db)) -> Any:
    """Just the open problems, for the notification bell in the page header.

    Two small reads (the stored conditions and the time of the last pass), so
    every screen can ask for it every 30 seconds. It never starts a pass.
    """
    snapshot_at = None
    raw = redis_conn.get(overview.SNAPSHOT_KEY)
    if raw:
        try:
            snapshot_at = json.loads(raw).get("computed_at")
        except ValueError:
            pass
    return {"computed_at": snapshot_at, "refreshing": _refreshing(), "conditions": _conditions(db)}


@router.get("/overview")
def get_overview(db: Session = Depends(deps.get_db)) -> Any:
    from app.api.endpoints.dashboard import get_active_tasks
    snapshot = overview.read_snapshot()
    pending = snapshot is None
    if pending:
        # First look after a restart: the page shows what it can and waits.
        _start_pass()
        snapshot = {}
    values = dashboard_settings.load(db)
    fetches = overview.player_fetches(db)
    playlists = []
    for pl in snapshot.get("playlists") or []:
        playlists.append({**pl, "key": pl.get("short_name") or pl.get("public_id") or str(pl["id"]),
                          "players": fetches.get(pl["id"], [])})
    return {
        "pending": pending,
        "refreshing": _refreshing(),
        "computed_at": snapshot.get("computed_at"),
        "duration_ms": snapshot.get("duration_ms"),
        "now": datetime.now(timezone.utc).isoformat(),
        "conditions": _conditions(db),
        "playlists": playlists,
        "featured_playlist_id": snapshot.get("featured_playlist_id"),
        "providers": snapshot.get("providers") or [],
        "guides": snapshot.get("guides") or [],
        "library": snapshot.get("library") or {},
        "system": snapshot.get("system") or {},
        "jellyfin": snapshot.get("jellyfin") or {"configured": False},
        "tasks": get_active_tasks(db),
        "events": _events(db),
        "settings": {
            "public_base_url": values.get("PUBLIC_BASE_URL") or "",
            "tvwall_enabled": dashboard_settings.as_bool(values, "TVWALL_ENABLED"),
            "notifications": dashboard_settings.notifications_configured(values),
        },
    }


@router.post("/refresh")
def refresh() -> Any:
    """Recompute everything now, provider accounts included. The page polls
    ``/overview`` until ``computed_at`` moves."""
    return {"started": _start_pass(force_accounts=True), "computed_at": (overview.read_snapshot() or {}).get("computed_at")}


@router.get("/events")
def get_events(limit: int = Query(30, ge=1, le=200), before_id: Optional[int] = None,
               db: Session = Depends(deps.get_db)) -> Any:
    return _events(db, limit, before_id)


# ---------------------------------------------------------------------------
# On air, tonight
# ---------------------------------------------------------------------------

def _ordered(channels: List[dict]) -> List[dict]:
    return sorted(channels, key=lambda c: (c.get("number") is None, c.get("number") or 0))


@router.get("/on-air")
def on_air(playlist_id: int, limit: int = Query(120, ge=1, le=400), db: Session = Depends(deps.get_db)) -> Any:
    """What each channel of a playlist is showing now, and next.

    The channel list comes from the last health pass; the programme is read
    live from the guide cache, so it changes with the clock, not with the pass.
    """
    playlist = _playlist(db, playlist_id)
    channels = _ordered(overview.read_served(playlist_id))[:limit]
    states = epg_service.guide_states(epg_service.active_source_ids(playlist),
                                      [c["epg_id"] for c in channels if c.get("epg_id")])
    wall = overview.wall_status(playlist_id)["channels"]
    out = []
    for c in channels:
        state = states.get(c.get("epg_id") or "", {"state": "none"}) if c.get("epg_id") else {"state": "none"}
        shot = wall.get(c.get("channel_id")) if c.get("channel_id") is not None else None
        out.append({
            "channel_id": c.get("channel_id"), "number": c.get("number"), "name": c["name"],
            "logo": c.get("logo"), "group": c.get("group"), "free": c.get("free"),
            "guide": state.get("state"), "now": state.get("now"), "now_start": state.get("now_start"),
            "now_stop": state.get("now_stop"), "next": state.get("next"), "next_start": state.get("next_start"),
            "picture": shot and {"ok": shot.get("ok"), "checked_at": shot.get("checked_at"),
                                 "error": shot.get("error")},
        })
    return {"playlist": {"id": playlist.id, "name": playlist.name}, "channels": out,
            "now": datetime.now(timezone.utc).timestamp()}


def _programmes(source_ids: List[int], epg_ids: List[str], start: float, end: float) -> Dict[str, List[dict]]:
    """Programmes overlapping [start, end] per id, from the first source that has any."""
    if not source_ids or not epg_ids:
        return {}
    pipe = epg_service.redis.pipeline()
    for epg_id in epg_ids:
        for sid in source_ids:
            pipe.zrangebyscore(f"epg:src:{sid}:prog:{epg_id}", start - 4 * 3600, end)
    answers = pipe.execute()
    out: Dict[str, List[dict]] = {}
    step = len(source_ids)
    for index, epg_id in enumerate(epg_ids):
        for raw_list in answers[index * step:(index + 1) * step]:
            items = []
            for raw in raw_list:
                try:
                    item = json.loads(raw)
                except ValueError:
                    continue
                if item.get("stop", 0) > start:
                    items.append(item)
            if items:
                out[epg_id] = sorted(items, key=lambda i: i.get("start", 0))
                break
    return out


def prime_time(items: List[dict], target: float) -> Optional[dict]:
    """The evening's main programme: the first one of 35 min or more that
    starts between 15 min before and 45 min after the target, else whatever
    is on 10 min after it. (At 21:00, TF1 runs the weather for ten minutes.)"""
    long_ones = [i for i in items if target - 900 <= i.get("start", 0) <= target + 2700
                 and i.get("stop", 0) - i.get("start", 0) >= 2100]
    if long_ones:
        return long_ones[0]
    moment = target + 600
    return next((i for i in items if i.get("start", 0) <= moment < i.get("stop", 0)), None)


@router.get("/tonight")
def tonight(playlist_id: int, at: str = Query("21:00", pattern=r"^\d{1,2}:\d{2}$"),
            limit: int = Query(80, ge=1, le=300), db: Session = Depends(deps.get_db)) -> Any:
    playlist = _playlist(db, playlist_id)
    hour, minute = (int(x) for x in at.split(":"))
    local_now = datetime.now(overview.LOCAL_TZ)
    target_dt = local_now.replace(hour=hour % 24, minute=minute % 60, second=0, microsecond=0)
    # After midnight "tonight" is still the evening that is about to come.
    target = target_dt.timestamp()
    channels = [c for c in _ordered(overview.read_served(playlist_id)) if c.get("epg_id")][:limit * 2]
    ids = list(dict.fromkeys(c["epg_id"] for c in channels))
    programmes = _programmes(epg_service.active_source_ids(playlist), ids, target, target + 3 * 3600)
    out = []
    for c in channels:
        items = programmes.get(c["epg_id"]) or []
        main = prime_time(items, target)
        if not main:
            continue
        after = next((i for i in items if i.get("start", 0) >= main.get("stop", 0)), None)
        out.append({
            "channel_id": c.get("channel_id"), "number": c.get("number"), "name": c["name"], "logo": c.get("logo"),
            "title": main.get("title"), "sub": main.get("sub"), "category": main.get("cat"),
            "icon": main.get("icon"), "start": main.get("start"), "stop": main.get("stop"),
            "desc": (main.get("desc") or "")[:280] if (main.get("desc") or "") not in ("NA",) else "",
            "then": after and {"title": after.get("title"), "start": after.get("start")},
        })
        if len(out) >= limit:
            break
    return {"playlist": {"id": playlist.id, "name": playlist.name}, "at": target, "channels": out}


# ---------------------------------------------------------------------------
# TV wall
# ---------------------------------------------------------------------------

def _wall_payload(db: Session, playlist_id: int, start_if_stale: bool) -> Dict[str, Any]:
    from app.tasks.dashboard import WALL_EVERY, WALL_LOCK_KEY, WALL_SIZE, capture_wall
    values = dashboard_settings.load(db)
    enabled = dashboard_settings.as_bool(values, "TVWALL_ENABLED")
    served = _ordered(overview.read_served(playlist_id))
    free = [c for c in served if c.get("free") and c.get("channel_id") is not None][:WALL_SIZE]
    status = overview.wall_status(playlist_id)
    meta = status["meta"] or {}
    finished = meta.get("finished_at")
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(finished)).total_seconds() if finished else None
    running = bool(redis_conn.exists(WALL_LOCK_KEY.format(playlist_id)))
    if enabled and free and start_if_stale and not running and (age is None or age > WALL_EVERY):
        capture_wall.delay(playlist_id)
        running = True
    channels = []
    for c in free:
        shot = status["channels"].get(c["channel_id"]) or {}
        channels.append({"channel_id": c["channel_id"], "number": c.get("number"), "name": c["name"],
                         "logo": c.get("logo"), "ok": shot.get("ok"), "error": shot.get("error"),
                         "seconds": shot.get("seconds"), "checked_at": shot.get("checked_at"),
                         "has_image": bool(shot.get("ok")) and bool(overview.redis_bin.exists(
                             overview.WALL_IMAGE_KEY.format(playlist_id, c["channel_id"])))})
    return {"enabled": enabled, "running": running, "finished_at": finished, "channels": channels,
            "paid_channels": sum(1 for c in served if not c.get("free"))}


@router.get("/wall")
def wall(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    _playlist(db, playlist_id)
    return _wall_payload(db, playlist_id, start_if_stale=True)


@router.post("/wall/refresh")
def wall_refresh(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    from app.tasks.dashboard import WALL_LOCK_KEY, capture_wall
    _playlist(db, playlist_id)
    if not redis_conn.exists(WALL_LOCK_KEY.format(playlist_id)):
        capture_wall.delay(playlist_id)
    payload = _wall_payload(db, playlist_id, start_if_stale=False)
    payload["running"] = True
    return payload


@router.get("/wall/{playlist_id}/{channel_id}.jpg")
def wall_image(playlist_id: int, channel_id: int) -> Response:
    data = overview.redis_bin.get(overview.WALL_IMAGE_KEY.format(playlist_id, channel_id))
    if not data:
        raise HTTPException(status_code=404, detail="No picture")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=60"})


# ---------------------------------------------------------------------------
# Quick search across every playlist
# ---------------------------------------------------------------------------

@router.get("/find")
def find(q: str = Query(..., min_length=1, max_length=60), db: Session = Depends(deps.get_db)) -> Any:
    """Where a channel is, in every playlist: number, group, what it shows now."""
    words = overview.normalize(q).split()
    if not words:
        return []
    numeric = all(w.isdigit() for w in words)
    hits: List[Dict[str, Any]] = []
    playlists = db.query(LivePlaylist).order_by(LivePlaylist.id).all()
    for playlist in playlists:
        matched = []
        for c in _ordered(overview.read_served(playlist.id)):
            # A number matches as a whole number: "france 2" is not "France 24".
            # The channel's own number only counts when the query is a number
            # alone ("332"): "france 2" must not return the channel numbered 2.
            text = overview.normalize(c["name"])
            if numeric:
                text += f" {c.get('number') or ''}"
            if all((re.search(rf"(^|\D){w}(\D|$)", text) if w.isdigit() else w in text) for w in words):
                matched.append(c)
                if len(matched) >= 8:
                    break
        if not matched:
            continue
        states = epg_service.guide_states(epg_service.active_source_ids(playlist),
                                          [c["epg_id"] for c in matched if c.get("epg_id")])
        for c in matched:
            state = states.get(c.get("epg_id") or "", {}) if c.get("epg_id") else {}
            hits.append({"playlist_id": playlist.id, "playlist": playlist.name,
                         "channel_id": c.get("channel_id"), "number": c.get("number"), "name": c["name"],
                         "logo": c.get("logo"), "group": c.get("group"), "now": state.get("now"),
                         "guide": state.get("state") or "none"})
    return hits[:40]


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@router.get("/settings")
def get_settings(db: Session = Depends(deps.get_db)) -> Any:
    values = dashboard_settings.load(db)
    return {**dashboard_settings.public_view(values),
            "playlists": [{"id": p.id, "name": p.name} for p in
                          db.query(LivePlaylist).order_by(LivePlaylist.id).all()]}


@router.put("/settings")
def put_settings(payload: Dict[str, Optional[str]] = Body(...), db: Session = Depends(deps.get_db)) -> Any:
    before = dashboard_settings.load(db)
    url = (payload.get("PUBLIC_BASE_URL") or "").strip()
    if url and not re.match(r"^https?://[^\s/]+", url):
        raise HTTPException(status_code=422, detail="The public address starts with http:// or https://")
    jf = (payload.get("JELLYFIN_URL") or "").strip()
    if jf and not re.match(r"^https?://[^\s/]+", jf):
        raise HTTPException(status_code=422, detail="The Jellyfin address starts with http:// or https://")
    if payload.get("NOTIFY_MIN_SEVERITY") not in (None, "", Severity.WARNING, Severity.DANGER):
        raise HTTPException(status_code=422, detail="Severity is warning or danger.")
    after = dashboard_settings.save(db, payload)
    # Switching notifications on must not replay every problem already open:
    # those are on the dashboard. Only what starts from now on is pushed.
    if not dashboard_settings.notifications_configured(before) and dashboard_settings.notifications_configured(after):
        for row in db.query(AppCondition).all():
            row.notified = True
        db.commit()
    if (before.get("JELLYFIN_URL"), before.get("JELLYFIN_API_KEY")) != (after.get("JELLYFIN_URL"), after.get("JELLYFIN_API_KEY")):
        redis_conn.delete(overview.JELLYFIN_KEY)
    return get_settings(db)


@router.post("/settings/test-notification")
def test_notification(db: Session = Depends(deps.get_db)) -> Any:
    values = dashboard_settings.load(db)
    if not dashboard_settings.notifications_configured(values):
        raise HTTPException(status_code=422, detail="No notification channel is configured.")
    link = (values.get("PUBLIC_BASE_URL") or "").rstrip("/") + "/" if values.get("PUBLIC_BASE_URL") else None
    return notify.send(values, "Test from Xtream to STRM", "Notifications reach this device.",
                       Severity.INFO, link)


@router.post("/settings/test-jellyfin")
async def test_jellyfin(db: Session = Depends(deps.get_db)) -> Any:
    values = dashboard_settings.load(db)
    snapshot = overview.read_snapshot() or {}
    result = await run_in_threadpool(overview.refresh_jellyfin, values, snapshot.get("library"), True)
    return result


# ---------------------------------------------------------------------------
# Jellyfin
# ---------------------------------------------------------------------------

@router.get("/jellyfin")
async def jellyfin(db: Session = Depends(deps.get_db)) -> Any:
    values = dashboard_settings.load(db)
    snapshot = overview.read_snapshot() or {}
    return await run_in_threadpool(overview.refresh_jellyfin, values, snapshot.get("library"), False)


_JF_ID = re.compile(r"^[0-9a-fA-F-]{8,40}$")


@router.get("/jellyfin/image/{item_id}")
async def jellyfin_image(item_id: str, db: Session = Depends(deps.get_db)) -> Response:
    if not _JF_ID.match(item_id):
        raise HTTPException(status_code=404, detail="Not found")
    key = f"dashboard:jfimg:{item_id}"
    data = overview.redis_bin.get(key)
    if data is None:
        values = dashboard_settings.load(db)
        if not values.get("JELLYFIN_URL") or not values.get("JELLYFIN_API_KEY"):
            raise HTTPException(status_code=404, detail="Not found")
        async with httpx.AsyncClient(base_url=values["JELLYFIN_URL"], timeout=10,
                                     headers=overview._jf_headers(values["JELLYFIN_API_KEY"])) as client:
            answer = await client.get(f"/Items/{item_id}/Images/Primary",
                                      params={"fillHeight": 360, "quality": 80})
        if answer.status_code != 200:
            raise HTTPException(status_code=404, detail="Not found")
        data = answer.content
        overview.redis_bin.setex(key, 86400, data)
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/jellyfin/scan")
async def jellyfin_scan(db: Session = Depends(deps.get_db)) -> Any:
    values = dashboard_settings.load(db)
    if not values.get("JELLYFIN_URL") or not values.get("JELLYFIN_API_KEY"):
        raise HTTPException(status_code=422, detail="Jellyfin is not configured.")
    async with httpx.AsyncClient(base_url=values["JELLYFIN_URL"], timeout=15,
                                 headers=overview._jf_headers(values["JELLYFIN_API_KEY"])) as client:
        answer = await client.post("/Library/Refresh")
    if answer.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Jellyfin answered HTTP {answer.status_code}.")
    redis_conn.delete(overview.JELLYFIN_KEY)
    return {"status": "started"}
