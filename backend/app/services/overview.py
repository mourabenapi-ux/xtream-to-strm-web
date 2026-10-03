"""Everything the dashboard shows, gathered and judged in one place.

The old dashboard counted what the app *intended*: a channel with a guide id
was "covered", a sync row from this month was a "success". This module reads
what is actually *delivered* — the same health check the playlist editor runs,
the guide cache the XMLTV is built from, the files on disk, the provider's own
account answer — and turns it into a short list of problems
(``compute_conditions``), each with the action that fixes it.

Collection is expensive (one health check per playlist, a disk walk, a call to
each provider), so it runs in the background every five minutes
(``tasks/dashboard.py``) and the page reads the stored snapshot.

Timestamps: the database mixes local and UTC naive datetimes (sync rows are
local, guide and event rows UTC). Everything leaves here as an ISO string with
its offset, so the browser never has to guess.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
import redis as redis_lib
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.redis import redis_conn
from app.models.cache import MovieCache, SeriesCache
from app.models.dashboard import PlayerFetch, Severity
from app.models.downloads import DownloadStatus, DownloadTask
from app.models.epg import EPGSourceGlobal
from app.models.live import LivePlaylist
from app.models.schedule import Schedule
from app.models.selection import SelectedCategory
from app.models.subscription import SourceKind, Subscription
from app.models.sync_state import SyncState, SyncStatus

logger = logging.getLogger(__name__)

LOCAL_TZ = ZoneInfo(settings.TIMEZONE)
# Images are bytes: the shared connection decodes every answer as text.
redis_bin = redis_lib.from_url(settings.REDIS_URL)

SNAPSHOT_KEY = "dashboard:snapshot"
SERVED_KEY = "dashboard:served:{}"          # channel list of one playlist, no URLs
ACCOUNT_KEY = "dashboard:account:{}"        # provider account answer
JELLYFIN_KEY = "dashboard:jellyfin"
WALL_KEY = "dashboard:wall:{}"              # hash channel_id -> JSON status
WALL_IMAGE_KEY = "dashboard:wallimg:{}:{}"  # JPEG bytes
WALL_META_KEY = "dashboard:wallmeta:{}"     # JSON: last run of the capture

ACCOUNT_EVERY = timedelta(minutes=15)
JELLYFIN_EVERY = timedelta(minutes=10)
VIDEO_EXT = {".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts", ".wmv", ".flv", ".mpg", ".mpeg", ".webm"}
_SEASON_DIR = re.compile(r"^(season|saison|s)\s*\d+$", re.I)


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------

def utc_iso(value: Optional[datetime]) -> Optional[str]:
    """A naive UTC datetime (``datetime.utcnow()``) as ISO with its offset."""
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


def local_iso(value: Optional[datetime]) -> Optional[str]:
    """A naive local datetime (``datetime.now()``) as ISO with its offset."""
    return value.replace(tzinfo=LOCAL_TZ).isoformat() if value else None


def _aware(value: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(value) if value else None


def _hours_since(iso: Optional[str], now: datetime) -> Optional[float]:
    moment = _aware(iso)
    return (now - moment).total_seconds() / 3600 if moment else None


def plural(count: int, word: str, many: Optional[str] = None) -> str:
    return f"{count:,} {word if count == 1 else (many or word + 's')}".replace(",", " ")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


# ---------------------------------------------------------------------------
# Files on disk
# ---------------------------------------------------------------------------

def scan_tree(root: str) -> Dict[str, int]:
    """What a folder really holds: .strm files, video files and their size,
    and the number of distinct shows (a season folder counts for its parent).

    Only video files are measured: on a Windows folder mounted into Docker,
    one size lookup per .strm made this walk ten times slower.
    """
    out = {"strm": 0, "videos": 0, "bytes": 0, "shows": 0}
    if not root or not os.path.isdir(root):
        return out
    shows = set()
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(entry.path)
                    continue
            except OSError:
                continue
            ext = os.path.splitext(entry.name)[1].lower()
            if ext == ".strm":
                out["strm"] += 1
                folder = current
                if _SEASON_DIR.match(os.path.basename(folder)):
                    folder = os.path.dirname(folder)
                if folder != root:
                    shows.add(folder)
            elif ext in VIDEO_EXT:
                out["videos"] += 1
                try:
                    out["bytes"] += entry.stat().st_size
                except OSError:
                    pass
    out["shows"] = len(shows)
    return out


SCAN_KEY = "dashboard:scan"
SCAN_EVERY = 30 * 60


def scan_dirs(dirs: List[str], force: bool = False) -> Dict[str, Dict[str, int]]:
    """``scan_tree`` per folder, kept 30 min. A finished sync or download
    drops the cache (``invalidate_scan``), so the counts follow the library."""
    if not force:
        raw = redis_conn.get(SCAN_KEY)
        if raw:
            cached = json.loads(raw)
            if all(d in cached for d in dirs):
                return {d: cached[d] for d in dirs}
    result = {d: scan_tree(d) for d in dirs}
    redis_conn.setex(SCAN_KEY, SCAN_EVERY, json.dumps(result))
    return result


def invalidate_scan() -> None:
    try:
        redis_conn.delete(SCAN_KEY)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

def _sync_row(state: Optional[SyncState]) -> Optional[Dict[str, Any]]:
    if not state:
        return None
    return {
        "at": local_iso(state.last_sync),
        "status": state.status,
        "added": state.items_added or 0,
        "deleted": state.items_deleted or 0,
        "refreshed": state.items_refreshed or 0,
        "error": state.error_message,
    }


def read_account(sub_id: int) -> Optional[Dict[str, Any]]:
    raw = redis_conn.get(ACCOUNT_KEY.format(sub_id))
    return json.loads(raw) if raw else None


async def refresh_accounts(db: Session, force: bool = False) -> None:
    """Ask every Xtream provider for its account state, at most every 15 min."""
    from app.services.catalog import get_catalog
    now = datetime.now(timezone.utc)
    for sub in db.query(Subscription).filter(Subscription.kind == SourceKind.XTREAM.value).all():
        if not sub.is_active:
            continue
        previous = read_account(sub.id)
        checked = _aware(previous.get("checked_at")) if previous else None
        if not force and checked and now - checked < ACCOUNT_EVERY:
            continue
        entry: Dict[str, Any] = {"checked_at": now.isoformat()}
        try:
            info = await get_catalog(db, sub).get_account_info()
            entry.update(info)
            if info.get("exp_date"):
                expiry = datetime.fromtimestamp(info["exp_date"], timezone.utc)
                entry["expires_at"] = expiry.isoformat()
                entry["days_left"] = round((expiry - now).total_seconds() / 86400, 1)
        except Exception as e:
            message = str(e)
            for secret in (sub.password, sub.username):
                if secret:
                    message = message.replace(secret, "***")
            entry["error"] = message[:200]
        redis_conn.setex(ACCOUNT_KEY.format(sub.id), 86400 * 7, json.dumps(entry))


def collect_providers(db: Session) -> List[Dict[str, Any]]:
    states: Dict[int, Dict[str, SyncState]] = defaultdict(dict)
    for state in db.query(SyncState).all():
        states[state.subscription_id][state.type] = state
    schedules: Dict[int, List[Schedule]] = defaultdict(list)
    for schedule in db.query(Schedule).all():
        schedules[schedule.subscription_id].append(schedule)
    selected = dict(db.query(SelectedCategory.subscription_id, func.count())
                    .group_by(SelectedCategory.subscription_id).all())
    movies = dict(db.query(MovieCache.subscription_id, func.count())
                  .group_by(MovieCache.subscription_id).all())
    series = dict(db.query(SeriesCache.subscription_id, func.count())
                  .group_by(SeriesCache.subscription_id).all())

    out = []
    for sub in db.query(Subscription).order_by(Subscription.id).all():
        own = schedules.get(sub.id, [])
        out.append({
            "id": sub.id,
            "name": sub.name,
            "kind": sub.kind or SourceKind.XTREAM.value,
            "is_active": bool(sub.is_active),
            # A source whose films and series are not selected is a live-only
            # source: an old or absent VOD sync is not a problem for it.
            "vod": bool(selected.get(sub.id)) or bool(movies.get(sub.id)) or bool(series.get(sub.id)),
            "movies": movies.get(sub.id, 0),
            "series": series.get(sub.id, 0),
            "syncs": {
                "movies": _sync_row(states[sub.id].get("movies")),
                "series": _sync_row(states[sub.id].get("series")),
            },
            "schedules": [{
                "type": str(getattr(s.type, "value", s.type)).lower(),
                "frequency": str(getattr(s.frequency, "value", s.frequency)).lower(),
                "enabled": bool(s.enabled),
                "next_run": local_iso(s.next_run) if s.enabled else None,
            } for s in own],
            "schedule_enabled": any(s.enabled for s in own),
            "account": read_account(sub.id) if sub.kind != SourceKind.M3U.value else None,
        })
    return out


# ---------------------------------------------------------------------------
# Guides
# ---------------------------------------------------------------------------

def collect_guides(db: Session) -> List[Dict[str, Any]]:
    sources = db.query(EPGSourceGlobal).order_by(EPGSourceGlobal.id).all()
    seen: Dict[Tuple[str, str], EPGSourceGlobal] = {}
    out = []
    for source in sources:
        identity = (source.source_type or "", (source.source_url or source.file_path or "").strip().lower()
                    if source.source_type != "xtream" else str(source.subscription_id))
        duplicate = seen.get(identity) if identity[1] else None
        if not duplicate and identity[1]:
            seen[identity] = source
        try:
            cached = redis_conn.scard(f"epg:src:{source.id}:channels")
        except Exception:
            cached = None
        out.append({
            "id": source.id,
            "name": source.name,
            "type": source.source_type,
            "active": bool(source.is_active),
            "channel_count": source.channel_count or 0,
            "cached_channels": cached,
            "last_updated": utc_iso(source.last_updated),
            "refresh_hours": source.refresh_interval_hours or 24,
            "playlists": len(source.playlist_links or []),
            # A download in progress (see tasks/epg.py): an empty cache is then
            # a guide on its way, not one that is missing.
            "refreshing": bool(redis_conn.exists(f"epg:refresh:lock:{source.id}")),
            "duplicate_of": {"id": duplicate.id, "name": duplicate.name} if duplicate else None,
        })
    return out


# ---------------------------------------------------------------------------
# Library: what the two Jellyfin libraries are fed with
# ---------------------------------------------------------------------------

def collect_library(db: Session) -> Dict[str, Any]:
    subs = db.query(Subscription).all()
    sub_ids = {s.id for s in subs}
    movies = dict(db.query(MovieCache.subscription_id, func.count())
                  .group_by(MovieCache.subscription_id).all())
    series = dict(db.query(SeriesCache.subscription_id, func.count())
                  .group_by(SeriesCache.subscription_id).all())

    strm_movie_dirs = sorted({s.movies_dir for s in subs if s.movies_dir})
    strm_series_dirs = sorted({s.series_dir for s in subs if s.series_dir})
    dl_movie_dirs = sorted({s.download_movies_dir for s in subs if s.download_movies_dir})
    dl_series_dirs = sorted({s.download_series_dir for s in subs if s.download_series_dir})

    scanned = scan_dirs(sorted(set(strm_movie_dirs + strm_series_dirs + dl_movie_dirs + dl_series_dirs)))

    def scan(dirs):
        total = {"strm": 0, "videos": 0, "bytes": 0, "shows": 0}
        for d in dirs:
            for key, value in scanned[d].items():
                total[key] += value
        return total

    strm_movies, strm_series = scan(strm_movie_dirs), scan(strm_series_dirs)
    dl_movies, dl_series = scan(dl_movie_dirs), scan(dl_series_dirs)

    counts = dict(db.query(DownloadTask.status, func.count()).group_by(DownloadTask.status).all())
    since = datetime.now() - timedelta(hours=24)
    failed_recent = db.query(DownloadTask).filter(
        DownloadTask.status == DownloadStatus.FAILED,
        func.coalesce(DownloadTask.completed_at, DownloadTask.started_at, DownloadTask.created_at) >= since,
    ).order_by(DownloadTask.id.desc()).limit(5).all()
    recent_done = db.query(DownloadTask).filter(DownloadTask.status == DownloadStatus.COMPLETED) \
        .order_by(DownloadTask.completed_at.desc()).limit(6).all()

    return {
        # Rows of a deleted source are not part of any library any more.
        "movies": sum(n for sid, n in movies.items() if sid in sub_ids),
        "series": sum(n for sid, n in series.items() if sid in sub_ids),
        "orphan_movies": sum(n for sid, n in movies.items() if sid not in sub_ids),
        "orphan_series": sum(n for sid, n in series.items() if sid not in sub_ids),
        "strm": {"movies": strm_movies["strm"], "episodes": strm_series["strm"],
                 "shows": strm_series["shows"], "bytes": strm_movies["bytes"] + strm_series["bytes"],
                 "dirs": {"movies": strm_movie_dirs, "series": strm_series_dirs}},
        "downloaded": {"movies": dl_movies["videos"], "episodes": dl_series["videos"],
                       "bytes": dl_movies["bytes"] + dl_series["bytes"],
                       "dirs": {"movies": dl_movie_dirs, "series": dl_series_dirs}},
        "downloads": {
            "queued": counts.get(DownloadStatus.PENDING.value, 0) + counts.get(DownloadStatus.PAUSED.value, 0),
            "running": counts.get(DownloadStatus.DOWNLOADING.value, 0),
            "completed": counts.get(DownloadStatus.COMPLETED.value, 0),
            "failed": counts.get(DownloadStatus.FAILED.value, 0),
            "failed_recent": [{"id": d.id, "title": d.title, "error": (d.error_message or "")[:160]}
                              for d in failed_recent],
            "recent": [{"id": d.id, "title": d.title, "at": local_iso(d.completed_at)} for d in recent_done],
        },
    }


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------

def collect_system(app_bytes: int, check_workers: bool = True) -> Dict[str, Any]:
    root = settings.OUTPUT_DIR if os.path.exists(settings.OUTPUT_DIR) else "/"
    total, used, free = shutil.disk_usage(root)
    db_path = settings.DATABASE_URL.replace("sqlite:///", "")
    try:
        db_bytes = os.path.getsize(db_path)
    except OSError:
        db_bytes = 0
    redis_state: Dict[str, Any] = {"online": False}
    try:
        if redis_conn.ping():
            info = redis_conn.info("memory")
            redis_state = {"online": True, "used_bytes": info.get("used_memory")}
    except Exception:
        pass
    workers = None
    if check_workers:
        try:
            from app.core.celery_app import celery_app
            replies = celery_app.control.inspect(timeout=1.0).ping() or {}
            workers = len(replies)
        except Exception:
            workers = 0
    return {
        "disk": {"total": total, "used": used, "free": free,
                 "percent": round(used / total * 100, 1) if total else 0,
                 "app_bytes": app_bytes + db_bytes},
        "redis": redis_state,
        "workers": workers,
    }


# ---------------------------------------------------------------------------
# Playlists
# ---------------------------------------------------------------------------

async def collect_playlists(db: Session) -> List[Dict[str, Any]]:
    """Run the editor's health check on every playlist and keep a summary.

    The resolved channel list of each playlist is stored apart (without the
    stream URLs, which carry credentials): the on-air panel, tonight's guide
    and the quick search all read it.
    """
    from app.api.api_v1.endpoints.live_tools import health_report
    from app.services.epg import epg_service

    kinds = {s.id: s.kind for s in db.query(Subscription).all()}
    out = []
    for playlist in db.query(LivePlaylist).order_by(LivePlaylist.id).all():
        entry: Dict[str, Any] = {
            "id": playlist.id, "name": playlist.name, "description": playlist.description,
            "short_name": playlist.short_name, "public_id": playlist.public_id,
            "numbered": bool(playlist.use_channel_numbers),
            "guide_sources": epg_service.active_source_ids(playlist),
        }
        served: List[dict] = []
        dropped: List[dict] = []
        try:
            report = await health_report(db, playlist, served_out=served, dropped_out=dropped)
            entry.update(report["stats"])
            entry["issues"] = [{"type": i["type"], "severity": i["severity"], "title": i["title"],
                                "fix": i.get("fix"),
                                "count": len(i.get("channel_ids") or i.get("bouquet_ids") or [])}
                               for i in report["issues"]]
            reasons: Dict[str, int] = defaultdict(int)
            for d in dropped:
                if d.get("channel_id") is not None:
                    reasons[d.get("reason") or "unknown"] += 1
            entry["dead_reasons"] = dict(reasons)
            channels = report["channels"]
            compact = []
            for ch in served:
                info = channels.get(str(ch.get("channel_id"))) or {}
                compact.append({
                    "channel_id": ch.get("channel_id"), "number": ch.get("number"),
                    "name": ch["name"], "logo": ch["logo"], "epg_id": ch["epg_id"],
                    "group": ch["group_title"], "subscription_id": ch["subscription_id"],
                    "stream_id": ch["stream_id"],
                    "free": kinds.get(ch["subscription_id"]) == SourceKind.M3U.value,
                    "guide": info.get("guide"),
                })
            entry["free_channels"] = sum(1 for c in compact if c["free"])
            redis_conn.setex(SERVED_KEY.format(playlist.id), 86400, json.dumps(compact))
            entry["error"] = None
        except Exception as e:
            logger.warning("Health of playlist %s failed: %s", playlist.id, e)
            entry.update({"rows": 0, "served": 0, "dead": 0, "with_schedule": 0,
                          "schedule_percentage": 0, "issues": [], "error": str(e)[:200]})
        out.append(entry)
    return out


def read_served(playlist_id: int) -> List[Dict[str, Any]]:
    raw = redis_conn.get(SERVED_KEY.format(playlist_id))
    return json.loads(raw) if raw else []


def player_fetches(db: Session) -> Dict[int, List[Dict[str, Any]]]:
    out: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for row in db.query(PlayerFetch).order_by(PlayerFetch.last_at.desc()).all():
        out[row.playlist_id].append({"kind": row.kind, "client": row.client, "last_at": utc_iso(row.last_at),
                                     "first_at": utc_iso(row.first_at), "count": row.count})
    return out


def featured_playlist(playlists: List[Dict[str, Any]], configured: str) -> Optional[int]:
    """The configured playlist, else the one with the best real guide."""
    ids = {p["id"] for p in playlists}
    try:
        if configured and int(configured) in ids:
            return int(configured)
    except ValueError:
        pass
    usable = [p for p in playlists if p.get("served")]
    if not usable:
        return None
    return max(usable, key=lambda p: (p.get("schedule_percentage", 0), p.get("served", 0)))["id"]


# ---------------------------------------------------------------------------
# Jellyfin
# ---------------------------------------------------------------------------

def _jf_headers(key: str) -> Dict[str, str]:
    return {"Authorization": f'MediaBrowser Client="xtream-to-strm", Device="server", '
                             f'DeviceId="xtream-to-strm", Version="1", Token="{key}"',
            "X-Emby-Token": key, "Accept": "application/json"}


def _tail(path: str, parts: int) -> str:
    segments = [s for s in re.split(r"[\\/]+", (path or "").strip().lower()) if s]
    return "/".join(segments[-parts:]) if len(segments) >= parts else ""


_GENERIC = {"movies", "films", "series", "tv", "shows", "media", "videos", "downloads"}


def library_role(locations: List[str], dirs: Dict[str, List[str]]) -> Optional[str]:
    """Which of our folders a Jellyfin library reads, by matching path tails.

    Jellyfin sees the folder under its own mount (/media/movies3), the app under
    another (/output/movies3); the tail is what they share. A one-segment
    match is only trusted when the name is specific ("movies3", not "movies").
    """
    for parts in (2, 1):
        for role, ours in dirs.items():
            for mine in ours:
                tail = _tail(mine, parts)
                if not tail or (parts == 1 and tail in _GENERIC):
                    continue
                if any(_tail(loc, parts) == tail for loc in locations):
                    return role
    return None


def fetch_jellyfin(values: Dict[str, str], library: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    url, key = values.get("JELLYFIN_URL"), values.get("JELLYFIN_API_KEY")
    now = datetime.now(timezone.utc).isoformat()
    if not url or not key:
        return {"configured": False, "checked_at": now}
    dirs = {}
    if library:
        dirs = {"strm_movies": library["strm"]["dirs"]["movies"], "strm_series": library["strm"]["dirs"]["series"],
                "downloads_movies": library["downloaded"]["dirs"]["movies"],
                "downloads_series": library["downloaded"]["dirs"]["series"]}
    try:
        with httpx.Client(base_url=url, headers=_jf_headers(key), timeout=10, follow_redirects=True) as client:
            info = client.get("/System/Info")
            if info.status_code in (401, 403):
                return {"configured": True, "ok": False, "checked_at": now,
                        "error": "Jellyfin refused the API key."}
            info.raise_for_status()
            system = info.json()
            folders = client.get("/Library/VirtualFolders").json()
            libraries = []
            for folder in folders:
                kind = (folder.get("CollectionType") or "").lower()
                item_type = {"movies": "Movie", "tvshows": "Series"}.get(kind)
                count = None
                if item_type and folder.get("ItemId"):
                    answer = client.get("/Items", params={"ParentId": folder["ItemId"], "Recursive": "true",
                                                          "IncludeItemTypes": item_type, "Limit": 0})
                    if answer.status_code == 200:
                        count = answer.json().get("TotalRecordCount")
                libraries.append({"name": folder.get("Name"), "type": kind or "mixed", "count": count,
                                  "locations": folder.get("Locations") or [],
                                  "role": library_role(folder.get("Locations") or [], dirs)})
            latest = client.get("/Items", params={
                "SortBy": "DateCreated", "SortOrder": "Descending", "Recursive": "true",
                "IncludeItemTypes": "Movie,Episode", "Limit": 60,
                "Fields": "DateCreated,ProductionYear", "EnableImageTypes": "Primary", "ImageTypeLimit": 1,
            }).json().get("Items", [])
        # One card per film, one per series however many episodes arrived.
        recent, seen = [], {}
        for item in latest:
            if item.get("Type") == "Episode" and item.get("SeriesId"):
                key_id = item["SeriesId"]
                if key_id in seen:
                    seen[key_id]["episodes"] += 1
                    continue
                card = {"id": key_id, "name": item.get("SeriesName") or item.get("Name"), "type": "series",
                        "year": None, "added_at": item.get("DateCreated"), "episodes": 1}
                seen[key_id] = card
            else:
                card = {"id": item.get("Id"), "name": item.get("Name"), "type": "movie",
                        "year": item.get("ProductionYear"), "added_at": item.get("DateCreated"), "episodes": 0}
            recent.append(card)
            if len(recent) >= 14:
                break
        return {"configured": True, "ok": True, "checked_at": now, "server": system.get("ServerName"),
                "version": system.get("Version"), "libraries": libraries, "recent": recent}
    except Exception as e:
        message = str(e).replace(key, "***")
        return {"configured": True, "ok": False, "checked_at": now, "error": message[:200]}


def read_jellyfin() -> Optional[Dict[str, Any]]:
    raw = redis_conn.get(JELLYFIN_KEY)
    return json.loads(raw) if raw else None


def refresh_jellyfin(values: Dict[str, str], library: Optional[Dict[str, Any]], force: bool = False) -> Dict[str, Any]:
    current = read_jellyfin()
    if current and not force:
        checked = _aware(current.get("checked_at"))
        same_target = current.get("configured") == bool(values.get("JELLYFIN_URL") and values.get("JELLYFIN_API_KEY"))
        if same_target and checked and datetime.now(timezone.utc) - checked < JELLYFIN_EVERY:
            return current
    result = fetch_jellyfin(values, library)
    redis_conn.setex(JELLYFIN_KEY, 86400, json.dumps(result))
    return result


# ---------------------------------------------------------------------------
# TV wall status (images are captured by tasks/dashboard.py)
# ---------------------------------------------------------------------------

def wall_status(playlist_id: int) -> Dict[str, Any]:
    raw = redis_conn.hgetall(WALL_KEY.format(playlist_id)) or {}
    meta_raw = redis_conn.get(WALL_META_KEY.format(playlist_id))
    channels = {int(k): json.loads(v) for k, v in raw.items()}
    return {"meta": json.loads(meta_raw) if meta_raw else None, "channels": channels}


# ---------------------------------------------------------------------------
# The verdict
# ---------------------------------------------------------------------------

def _gb(value: float) -> str:
    return f"{value / 1024 ** 3:.1f} GB" if value >= 1024 ** 3 else f"{value / 1024 ** 2:.0f} MB"


def compute_conditions(snapshot: Dict[str, Any], now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Every problem true right now, most serious first.

    Pure: reads the snapshot only, so the rules are testable on any data. Each
    condition has a stable ``key`` (the same problem on the next pass is the
    same key), a ``severity``, one-line ``title`` and ``detail``, and either an
    ``action`` the dashboard can run or a ``link`` to the screen that fixes it.
    """
    now = now or datetime.now(timezone.utc)
    out: List[Dict[str, Any]] = []

    def add(key, severity, title, detail=None, action=None, link=None):
        out.append({"key": key, "severity": severity, "title": title, "detail": detail,
                    "action": action, "link": link})

    # -- System ------------------------------------------------------------
    system = snapshot.get("system") or {}
    disk = system.get("disk") or {}
    if disk.get("total"):
        pct, free = disk.get("percent", 0), disk.get("free", 0)
        detail = f"{pct:.1f}% used, {_gb(free)} free. This app's files take {_gb(disk.get('app_bytes', 0))} of it."
        if pct >= 98 or free < 5 * 1024 ** 3:
            add("system:disk", Severity.DANGER, "Disk almost full", detail, link="/downloads/manager")
        elif pct >= 95:
            add("system:disk", Severity.WARNING, "Disk nearly full", detail, link="/downloads/manager")
    redis_state = system.get("redis") or {}
    if redis_state and not redis_state.get("online"):
        add("system:redis", Severity.DANGER, "The cache is offline",
            "Guides, tasks and the provider cache all depend on it.", link="/logs")
    if system.get("workers") == 0:
        add("system:workers", Severity.DANGER, "No background worker is running",
            "Syncs, guide refreshes and downloads are stopped.", link="/logs")

    # -- Guides --------------------------------------------------------------
    guides = snapshot.get("guides") or []
    linked_guides = {g["id"]: g for g in guides if g.get("active") and g.get("playlists")}
    cold = [g for g in linked_guides.values() if g.get("cached_channels") == 0]
    for g in cold:
        if g.get("refreshing"):
            # Right after a restart the cache is empty until the download ends.
            add(f"guide:{g['id']}:empty", Severity.INFO, f"Guide “{g['name']}” is loading",
                "The download is running. Players get its programmes once it ends.", link="/epg-admin")
            continue
        add(f"guide:{g['id']}:empty", Severity.DANGER, f"Guide “{g['name']}” is not loaded",
            "Players get no programme from it until it is refreshed.",
            action={"kind": "refresh_guide", "label": "Refresh", "source_id": g["id"]}, link="/epg-admin")
    for g in linked_guides.values():
        if any(c["id"] == g["id"] for c in cold):
            continue
        age = _hours_since(g.get("last_updated"), now)
        if age is None or age > 2 * (g.get("refresh_hours") or 24) + 1:
            if age is None:
                detail = "Never refreshed."
            elif age >= 48:
                detail = f"Last refreshed {age / 24:.0f} days ago."
            else:
                detail = f"Last refreshed {age:.0f} hours ago."
            add(f"guide:{g['id']}:stale", Severity.WARNING, f"Guide “{g['name']}” is out of date", detail,
                action={"kind": "refresh_guide", "label": "Refresh", "source_id": g["id"]}, link="/epg-admin")
    for g in guides:
        if g.get("duplicate_of"):
            add(f"guide:{g['id']}:duplicate", Severity.INFO,
                f"“{g['name']}” downloads the same guide as “{g['duplicate_of']['name']}”",
                "The file is fetched and stored twice.", link="/epg-admin")

    # -- Providers -----------------------------------------------------------
    for p in snapshot.get("providers") or []:
        if not p.get("is_active"):
            continue
        account = p.get("account") or {}
        if account.get("error"):
            add(f"provider:{p['id']}:unreachable", Severity.WARNING, f"{p['name']} does not answer",
                account["error"], link="/xtreamtv/subscriptions")
        elif account:
            status = (account.get("status") or "").lower()
            if account.get("auth") == 0 or (status and status != "active"):
                add(f"provider:{p['id']}:account", Severity.DANGER,
                    f"{p['name']}: account {account.get('status') or 'refused'}",
                    account.get("message") or "The provider refuses the credentials.",
                    link="/xtreamtv/subscriptions")
            days = account.get("days_left")
            if days is not None and days < 14:
                when = "today" if days < 1 else f"in {int(days)} day{'s' if int(days) != 1 else ''}"
                add(f"provider:{p['id']}:expiry", Severity.DANGER if days < 3 else Severity.WARNING,
                    f"{p['name']} expires {when}",
                    f"Subscription end: {_aware(account['expires_at']).astimezone(LOCAL_TZ):%d/%m/%Y}.",
                    link="/xtreamtv/subscriptions")
        if not p.get("vod"):
            continue
        for kind, label in (("movies", "Movies"), ("series", "Series")):
            row = (p.get("syncs") or {}).get(kind)
            if row and row.get("status") == SyncStatus.FAILED.value:
                add(f"provider:{p['id']}:{kind}:failed", Severity.DANGER, f"{label} sync of {p['name']} failed",
                    row.get("error") or "See the logs for the cause.",
                    action={"kind": "sync", "label": "Retry", "subscription_id": p["id"], "type": kind},
                    link="/xtreamtv/selection")
            elif row and row.get("status") == SyncStatus.PARTIAL.value:
                add(f"provider:{p['id']}:{kind}:partial", Severity.WARNING,
                    f"{label} sync of {p['name']} was incomplete", row.get("error"),
                    action={"kind": "sync", "label": "Retry", "subscription_id": p["id"], "type": kind},
                    link="/xtreamtv/selection")
        ages = [_hours_since((row or {}).get("at"), now) for row in (p.get("syncs") or {}).values()]
        ages = [a for a in ages if a is not None]
        if ages and min(ages) > 7 * 24:
            days = int(min(ages) // 24)
            detail = "No schedule is enabled." if not p.get("schedule_enabled") \
                else "A schedule is enabled but has not run."
            add(f"provider:{p['id']}:stale", Severity.WARNING,
                f"Movies and series of {p['name']} not synced for {days} days", detail,
                action={"kind": "sync", "label": "Sync now", "subscription_id": p["id"], "type": "all"},
                link="/xtreamtv/scheduling")

    # -- Playlists ----------------------------------------------------------
    guides_loaded = not cold
    for pl in snapshot.get("playlists") or []:
        name, pid = pl["name"], pl["id"]
        editor = f"/live-selection?playlist_id={pid}"
        if pl.get("error"):
            add(f"playlist:{pid}:error", Severity.WARNING, f"“{name}” could not be checked", pl["error"], link=editor)
            continue
        rows, served, dead = pl.get("rows", 0), pl.get("served", 0), pl.get("dead", 0)
        reasons = pl.get("dead_reasons") or {}
        gone = reasons.get("stream_gone_from_provider", 0)
        repair = {"kind": "repair_dead", "label": "Repair", "playlist_id": pid} if gone else None
        if rows == 0:
            add(f"playlist:{pid}:empty", Severity.INFO, f"“{name}” is empty", "It has no channel yet.", link=editor)
            continue
        if served == 0 and dead:
            why = ("their source was deleted" if reasons.get("subscription_unavailable", 0) == dead
                   else "the provider no longer lists them")
            add(f"playlist:{pid}:dead", Severity.DANGER, f"“{name}” serves no channel",
                f"All {dead} channels are gone: {why}.", action=repair, link=editor)
        elif dead:
            add(f"playlist:{pid}:dead", Severity.WARNING,
                f"{plural(dead, 'channel')} of “{name}” no longer {'plays' if dead == 1 else 'play'}",
                ("The provider stopped serving " + ("it" if dead == 1 else "them")
                 + ". Repair looks for the same channel elsewhere.")
                if gone else "Their source was deleted.", action=repair, link=editor)
        if served >= 5 and pl.get("with_schedule", 0) == 0 and guides_loaded:
            add(f"playlist:{pid}:guide", Severity.WARNING, f"“{name}” has no programme guide",
                f"None of its {served} channels has a programme. Link a guide that covers them.",
                link=f"/live-epg?playlist_id={pid}")
        numbering = [i for i in pl.get("issues") or []
                     if i.get("fix") == "fix_numbering" and i.get("severity") == "error"]
        if numbering:
            add(f"playlist:{pid}:numbering", Severity.WARNING, f"Channel numbers of “{name}” clash",
                "; ".join(i["title"] for i in numbering),
                action={"kind": "fix_numbering", "label": "Fix", "playlist_id": pid}, link=editor)

    # -- TV wall ------------------------------------------------------------
    wall = snapshot.get("wall") or {}
    checked = _hours_since((wall.get("meta") or {}).get("finished_at"), now)
    if wall.get("playlist_id") and checked is not None and checked < 3:
        failed = [c for c in (wall.get("channels") or {}).values() if not c.get("ok")]
        if failed:
            names = ", ".join(c.get("name") or "?" for c in failed[:5]) + ("…" if len(failed) > 5 else "")
            add(f"wall:{wall['playlist_id']}:failed", Severity.WARNING,
                f"{plural(len(failed), 'channel')} of “{wall.get('playlist_name')}” "
                f"{'shows' if len(failed) == 1 else 'show'} no picture",
                f"Tested by opening the stream: {names}.",
                link=f"/live-selection?playlist_id={wall['playlist_id']}")

    # -- Library ------------------------------------------------------------
    library = snapshot.get("library") or {}
    orphans = (library.get("orphan_movies") or 0) + (library.get("orphan_series") or 0)
    if orphans:
        add("library:orphans", Severity.INFO, "Titles of a deleted source are still stored",
            f"{plural(library.get('orphan_movies') or 0, 'movie')} and "
            f"{plural(library.get('orphan_series') or 0, 'series', 'series')}. They are no longer counted.")
    failed_downloads = (library.get("downloads") or {}).get("failed_recent") or []
    if failed_downloads:
        add("downloads:failed", Severity.WARNING,
            f"{plural(len(failed_downloads), 'download')} failed in the last 24 h",
            ", ".join(d["title"] for d in failed_downloads[:3]), link="/downloads/manager")

    jellyfin = snapshot.get("jellyfin") or {}
    if jellyfin.get("configured") and not jellyfin.get("ok"):
        add("jellyfin:unreachable", Severity.WARNING, "Jellyfin does not answer",
            jellyfin.get("error"), link="/admin")
    elif jellyfin.get("ok"):
        strm = library.get("strm") or {}
        for lib in jellyfin.get("libraries") or []:
            ours = {"strm_movies": strm.get("movies"), "strm_series": strm.get("shows")}.get(lib.get("role"))
            theirs = lib.get("count")
            if ours and theirs is not None and ours - theirs > max(3, ours * 0.02):
                add(f"jellyfin:{lib['name']}:behind", Severity.INFO,
                    f"Jellyfin shows {theirs} of {ours} titles in “{lib['name']}”",
                    "A library scan picks up the files written since the last one.",
                    action={"kind": "jellyfin_scan", "label": "Scan"})

    out.sort(key=lambda c: -Severity.ORDER.get(c["severity"], 0))
    return out


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------

async def build_snapshot(db: Session, values: Dict[str, str], force_accounts: bool = False,
                         check_workers: bool = True) -> Dict[str, Any]:
    started = time.monotonic()
    await refresh_accounts(db, force=force_accounts)
    playlists = await collect_playlists(db)
    library = collect_library(db)
    snapshot: Dict[str, Any] = {
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "providers": collect_providers(db),
        "guides": collect_guides(db),
        "playlists": playlists,
        "library": library,
        "system": collect_system(library["strm"]["bytes"] + library["downloaded"]["bytes"],
                                 check_workers=check_workers),
        "jellyfin": refresh_jellyfin(values, library),
    }
    featured = featured_playlist(playlists, values.get("DASHBOARD_PLAYLIST_ID", ""))
    snapshot["featured_playlist_id"] = featured
    if featured:
        wall = wall_status(featured)
        served = {c["channel_id"]: c for c in read_served(featured)}
        snapshot["wall"] = {
            "playlist_id": featured,
            "playlist_name": next((p["name"] for p in playlists if p["id"] == featured), ""),
            "meta": wall["meta"],
            "channels": {str(k): {**v, "name": (served.get(k) or {}).get("name") or v.get("name")}
                         for k, v in wall["channels"].items()},
        }
    snapshot["duration_ms"] = int((time.monotonic() - started) * 1000)
    redis_conn.setex(SNAPSHOT_KEY, 86400, json.dumps(snapshot))
    return snapshot


def read_snapshot() -> Optional[Dict[str, Any]]:
    raw = redis_conn.get(SNAPSHOT_KEY)
    return json.loads(raw) if raw else None
