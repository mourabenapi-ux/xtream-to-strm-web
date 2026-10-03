"""The journal, and the record of which player fetched which playlist.

Every background job writes one line here when it ends: a sync, a guide
refresh, a download. The dashboard shows them as "what happened while you were
away". Alerts are not sent from here but from the conditions the monitor
keeps (``tasks/dashboard.py``): a failed sync raises a condition, and that is
what reaches the phone, once.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.dashboard import AppEvent, PlayerFetch, Severity

logger = logging.getLogger(__name__)

# (substring of the lowercased User-Agent, label). First match wins, so the
# specific players come before the libraries they are built on.
_PLAYERS = (
    ("tivimate", "TiviMate"),
    ("ott navigator", "OTT Navigator"), ("ottnavigator", "OTT Navigator"),
    ("smarters", "IPTV Smarters"),
    ("televizo", "Televizo"),
    ("sparkle", "Sparkle"),
    ("perfect player", "Perfect Player"), ("perfectplayer", "Perfect Player"),
    ("iptvnator", "IPTVnator"),
    ("kodi", "Kodi"),
    ("jellyfin", "Jellyfin"),
    ("emby", "Emby"),
    ("plex", "Plex"),
    ("vlc", "VLC"),
    ("lavf", "FFmpeg"),
    ("curl/", "curl"),
    ("wget", "wget"),
    ("python", "Script"),
    ("okhttp", "Android app"), ("dalvik", "Android app"),
    ("mozilla", "Browser"),
)


def player_label(user_agent: Optional[str]) -> str:
    agent = (user_agent or "").lower()
    if not agent:
        return "Unknown"
    for needle, label in _PLAYERS:
        if needle in agent:
            return label
    return "Other player"


def record_event(db: Session, kind: str, title: str, severity: str = Severity.INFO,
                 detail: Optional[str] = None, link: Optional[str] = None,
                 push: bool = False) -> Optional[AppEvent]:
    """Write one journal line. Never raises: a journal that fails must not take
    down the job it describes. ``push`` also sends it to the phone, for the few
    events that are good news rather than conditions (a finished download)."""
    try:
        event = AppEvent(kind=kind, title=title[:300], severity=severity,
                         detail=(detail or None), link=link, created_at=datetime.utcnow())
        db.add(event)
        db.commit()
        if kind in ("sync", "download"):
            # The library just changed on disk: count it again on the next pass.
            from app.services.overview import invalidate_scan
            invalidate_scan()
        if push:
            from app.tasks.dashboard import push_event
            push_event.delay(event.id)
        return event
    except Exception as e:
        logger.warning("Could not record event %r: %s", title, e)
        try:
            db.rollback()
        except Exception:
            pass
        return None


def record_player_fetch(db: Session, playlist, kind: str, request) -> None:
    """Remember that a player downloaded this playlist (kind "m3u") or its
    guide ("xml"). Behind Docker every client has the same address, so the
    User-Agent is what tells the TV from a browser tab."""
    try:
        agent = request.headers.get("user-agent", "")[:300]
        client = player_label(agent)
        address = request.client.host if request.client else None
        now = datetime.utcnow()
        row = db.query(PlayerFetch).filter(
            PlayerFetch.playlist_id == playlist.id, PlayerFetch.kind == kind,
            PlayerFetch.client == client,
        ).first()
        if row is None:
            db.add(PlayerFetch(playlist_id=playlist.id, kind=kind, client=client,
                               user_agent=agent, address=address, first_at=now, last_at=now, count=1))
            db.commit()
            if client not in ("Browser", "Unknown", "curl", "wget", "Script"):
                what = "playlist" if kind == "m3u" else "guide"
                record_event(db, "player", f"{client} fetched the {what} of “{playlist.name}” for the first time",
                             detail=agent, link=f"/live-selection?playlist_id={playlist.id}")
        else:
            row.last_at, row.count = now, (row.count or 0) + 1
            row.user_agent, row.address = agent, address
            db.commit()
    except Exception as e:
        logger.warning("Could not record a player fetch: %s", e)
        try:
            db.rollback()
        except Exception:
            pass
