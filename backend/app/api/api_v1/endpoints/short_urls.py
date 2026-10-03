"""Short player URLs: /p/<alias>.m3u and /p/<alias>.xml.

The two URLs a player needs are typed with a TV remote. The long form
(/api/v1/live/playlist.m3u?playlist_id=e0892501) is 50 characters of
punctuation; /p/fr.m3u is nine. <alias> is the playlist's short name when it
has one, else its public id, so every playlist has a short URL from day one.
The long URLs keep working.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.api import deps
from app.api.api_v1.endpoints.live import m3u_text, resolve_playlist_channels
from app.models.live import LivePlaylist
from app.services.epg import epg_service
from app.services.events import record_player_fetch

router = APIRouter()


def _find(db: Session, key: str) -> LivePlaylist:
    key = (key or "").strip().lower()
    playlist = (db.query(LivePlaylist).filter(LivePlaylist.short_name == key).first()
                or db.query(LivePlaylist).filter(LivePlaylist.public_id == key).first())
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


@router.get("/p/{key}.m3u")
async def short_m3u(key: str, request: Request, db: Session = Depends(deps.get_db)):
    playlist = _find(db, key)
    record_player_fetch(db, playlist, "m3u", request)
    channels = await resolve_playlist_channels(db, playlist)
    # The guide URL inside the playlist is short too, on the same alias.
    epg_url = str(request.url_for("short_xml", key=key))
    return Response(content=m3u_text(playlist, channels, epg_url), media_type="text/plain")


@router.get("/p/{key}.xml", name="short_xml")
async def short_xml(key: str, request: Request, db: Session = Depends(deps.get_db)):
    playlist = _find(db, key)
    record_player_fetch(db, playlist, "xml", request)
    channels = await resolve_playlist_channels(db, playlist)
    return Response(content=epg_service.generate_playlist_xmltv(playlist, channels),
                    media_type="application/xml")
