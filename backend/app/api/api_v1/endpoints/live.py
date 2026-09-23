from typing import Any, Dict, List, Optional
import logging
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session
from app.api import deps
from app.models.subscription import SourceKind, Subscription
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel, LiveStreamSubscription
from app.models.epg import EPGSourceGlobal, PlaylistEPGSource
from app.models import live as models
from app.services.catalog import get_catalog
from app.services.epg import epg_service
from app import schemas
from datetime import datetime

logger = logging.getLogger(__name__)

router = APIRouter()

@router.get("/categories", response_model=List[Any])
async def get_live_categories(
    db: Session = Depends(deps.get_db),
    subscription_id: int = Query(...)
) -> Any:
    """Get all live categories from the source — Xtream categories, or the
    group titles of an M3U playlist, which are the same thing to a caller."""
    sub = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    client = get_catalog(db, sub)
    try:
        categories = await client.get_live_categories()
        return categories
    except (httpx.ConnectTimeout, httpx.ReadTimeout):
        raise HTTPException(status_code=504, detail="Provider connection timed out")
    except (httpx.ConnectError, httpx.RequestError) as e:
        raise HTTPException(status_code=502, detail=f"Provider connection failed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch categories: {str(e)}")

@router.get("/streams/{category_id}", response_model=Any)
async def get_live_streams(
    category_id: str,
    subscription_id: int = Query(...),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
    db: Session = Depends(deps.get_db)
) -> Any:
    """Get live streams for a specific category from the source, with pagination."""
    sub = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    client = get_catalog(db, sub)
    try:
        streams = await client.get_live_streams(category_id)
        
        total = len(streams)
        start = (page - 1) * page_size
        end = start + page_size
        paginated = streams[start:end]
        
        return {
            "items": paginated,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": (total + page_size - 1) // page_size
        }
    except (httpx.ConnectTimeout, httpx.ReadTimeout):
        raise HTTPException(status_code=504, detail="Provider connection timed out")
    except (httpx.ConnectError, httpx.RequestError) as e:
        raise HTTPException(status_code=502, detail=f"Provider connection failed: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch streams: {str(e)}")

# --- Playlist Management ---

@router.get("/playlists", response_model=List[schemas.LivePlaylist])
def list_playlists(
    db: Session = Depends(deps.get_db),
    subscription_id: Optional[int] = Query(None)
) -> Any:
    """List all live playlists, optionally filtered by subscription."""
    query = db.query(LivePlaylist)
    if subscription_id:
        query = query.filter(LivePlaylist.subscription_id == subscription_id)
    return query.all()

@router.post("/playlists", response_model=schemas.LivePlaylist)
def create_playlist(
    playlist_in: schemas.LivePlaylistCreate,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Create a new live playlist."""
    playlist = LivePlaylist(**playlist_in.model_dump())
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return playlist

@router.get("/playlists/{playlist_id}", response_model=schemas.LivePlaylistDetail)
def get_playlist(
    playlist_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Get detailed information for a specific playlist."""
    from sqlalchemy.orm import joinedload
    playlist = db.query(LivePlaylist).options(
        joinedload(LivePlaylist.bouquets).joinedload(LivePlaylistBouquet.channels),
        joinedload(LivePlaylist.epg_source_links)
    ).filter(LivePlaylist.id == playlist_id).first()
    
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist

@router.get("/playlists/{playlist_id}/channel-names")
async def get_playlist_channel_names(
    playlist_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Resolve the provider's own name for every channel in the playlist.

    A stored channel only holds a stream_id plus an optional custom_name, so
    the editor has nothing readable to show for channels the user never
    renamed. This resolves names the same way the M3U export does, but as a
    separate call so opening the editor is not blocked on the provider.

    Returns {channel_id: name}. Channels the provider no longer serves are
    simply absent, and the caller falls back to the stream id.
    """
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Group channels by the subscription they came from, so each provider is
    # queried once no matter how many channels reference it.
    channels_by_sub: dict[int, list] = {}
    for bouquet in playlist.bouquets:
        for channel in bouquet.channels:
            sub_id = channel.subscription_id or bouquet.subscription_id or playlist.subscription_id
            if sub_id:
                channels_by_sub.setdefault(sub_id, []).append(channel)

    names: dict[str, str] = {}
    for sub_id, channels in channels_by_sub.items():
        sub = db.query(Subscription).filter(Subscription.id == sub_id).first()
        if not sub:
            continue
        try:
            streams = await get_catalog(db, sub).get_live_streams()
        except Exception as e:
            # A dead provider must not break the editor; those channels keep
            # falling back to their stream id.
            logger.warning(f"Could not resolve channel names for sub {sub_id}: {e}")
            continue

        streams_map = {str(s.get("stream_id")): s.get("name") for s in streams}
        for channel in channels:
            name = streams_map.get(str(channel.stream_id))
            if name:
                names[str(channel.id)] = name

    return names

@router.put("/playlists/{playlist_id}", response_model=schemas.LivePlaylist)
def update_playlist(
    playlist_id: int,
    playlist_in: schemas.LivePlaylistUpdate,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Update playlist basic info."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    update_data = playlist_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(playlist, field, value)
    
    db.commit()
    db.refresh(playlist)
    return playlist

@router.delete("/playlists/{playlist_id}")
def delete_playlist(
    playlist_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Delete a playlist."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    db.delete(playlist)
    db.commit()
    return {"status": "success"}

@router.post("/playlists/{playlist_id}/bouquets", response_model=List[schemas.LivePlaylistBouquet])
def add_playlist_bouquets(
    playlist_id: int,
    bouquets_in: List[schemas.LivePlaylistBouquetBase],
    db: Session = Depends(deps.get_db)
) -> Any:
    """Add or update multiple bouquets in a playlist."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    results = []
    for b_in in bouquets_in:
        existing = None
        if b_in.id:
            existing = db.query(LivePlaylistBouquet).filter_by(id=b_in.id, playlist_id=playlist_id).first()
        elif b_in.category_id:
            # For smart groups, check by category_id as fallback
            existing = db.query(LivePlaylistBouquet).filter_by(
                playlist_id=playlist_id, 
                category_id=b_in.category_id
            ).first()
        
        if existing:
            existing.custom_name = b_in.custom_name
            existing.order = b_in.order
            results.append(existing)
        else:
            # Create new (virtual or smart)
            bouquet = LivePlaylistBouquet(
                playlist_id=playlist_id,
                **b_in.model_dump(exclude={'id'})
            )
            db.add(bouquet)
            results.append(bouquet)
    
    db.commit()
    for r in results: db.refresh(r)
    return results

@router.patch("/playlists/{playlist_id}/bouquets/reorder")
def reorder_playlist_bouquets(
    playlist_id: int,
    updates: List[dict],
    db: Session = Depends(deps.get_db)
) -> Any:
    """Reorder bouquets within a playlist. Expects [{id: int, order: int}, ...]."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    for item in updates:
        bouquet = db.query(LivePlaylistBouquet).filter_by(
            id=item["id"], playlist_id=playlist_id
        ).first()
        if bouquet:
            bouquet.order = item["order"]

    db.commit()
    return {"status": "success", "updated": len(updates)}

@router.delete("/playlists/{playlist_id}/bouquets/{bouquet_id}")
def remove_playlist_bouquet(
    playlist_id: int,
    bouquet_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Remove a bouquet from a playlist."""
    bouquet = db.query(LivePlaylistBouquet).filter_by(id=bouquet_id, playlist_id=playlist_id).first()
    if not bouquet:
        raise HTTPException(status_code=404, detail="Bouquet not found")
    db.delete(bouquet)
    db.commit()
    return {"status": "success"}

@router.post("/channels/{channel_id}/move", response_model=schemas.LivePlaylistChannel)
def move_playlist_channel(
    channel_id: int,
    move_in: schemas.LivePlaylistChannelMove,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Move a channel to a different bouquet or update its order."""
    channel = db.query(LivePlaylistChannel).filter(LivePlaylistChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    
    channel.bouquet_id = move_in.new_bouquet_id
    channel.order = move_in.new_order
    db.commit()
    db.refresh(channel)
    return channel

@router.post("/bouquets/{bouquet_id}/channels/add", response_model=schemas.LivePlaylistChannel)
def add_channel_to_bouquet(
    bouquet_id: int,
    channel_in: schemas.LivePlaylistChannelBase,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Add a specific stream to a virtual or existing bouquet."""
    bouquet = db.query(LivePlaylistBouquet).filter(LivePlaylistBouquet.id == bouquet_id).first()
    if not bouquet:
        raise HTTPException(status_code=404, detail="Bouquet not found")
    
    channel = LivePlaylistChannel(
        bouquet_id=bouquet_id,
        **channel_in.model_dump()
    )
    db.add(channel)
    db.commit()
    db.refresh(channel)
    return channel

@router.post("/playlists/{playlist_id}/bouquets/{bouquet_id}/channels", response_model=List[schemas.LivePlaylistChannel])
def update_bouquet_channels(
    playlist_id: int,
    bouquet_id: int,
    channels_in: List[schemas.LivePlaylistChannelBase],
    db: Session = Depends(deps.get_db)
) -> Any:
    """Update channel overrides (naming, ordering, exclusion) for a bouquet."""
    bouquet = db.query(LivePlaylistBouquet).filter_by(id=bouquet_id, playlist_id=playlist_id).first()
    if not bouquet:
        raise HTTPException(status_code=404, detail="Bouquet not found")
    
    results = []
    for c_in in channels_in:
        # Check if override already exists
        existing = db.query(LivePlaylistChannel).filter_by(
            bouquet_id=bouquet_id,
            stream_id=c_in.stream_id
        ).first()
        
        if existing:
            update_data = c_in.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                setattr(existing, field, value)
            results.append(existing)
        else:
            channel = LivePlaylistChannel(
                bouquet_id=bouquet_id,
                **c_in.model_dump()
            )
            db.add(channel)
            results.append(channel)
            
    db.commit()
    for r in results: db.refresh(r)
    return results

@router.delete("/playlists/{playlist_id}/channels/{channel_id}")
def remove_playlist_channel(
    playlist_id: int,
    channel_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Remove a channel from a playlist bouquet."""
    channel = db.query(LivePlaylistChannel).join(LivePlaylistBouquet).filter(
        LivePlaylistChannel.id == channel_id,
        LivePlaylistBouquet.playlist_id == playlist_id
    ).first()
    
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
        
    db.delete(channel)
    db.commit()
    return {"status": "success"}

@router.post("/playlists/{playlist_id}/channels/{channel_id}/rename", response_model=schemas.LivePlaylistChannel)
def rename_playlist_channel(
    playlist_id: int,
    channel_id: int,
    update_in: schemas.LivePlaylistChannelUpdate,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Rename a channel in a playlist bouquet."""
    channel = db.query(LivePlaylistChannel).join(LivePlaylistBouquet).filter(
        LivePlaylistChannel.id == channel_id,
        LivePlaylistBouquet.playlist_id == playlist_id
    ).first()
    
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
        
    if update_in.custom_name is not None:
        channel.custom_name = update_in.custom_name
        
    db.commit()
    db.refresh(channel)
    return channel

@router.post("/playlists/{playlist_id}/channels/bulk")
def bulk_remove_playlist_channels(
    playlist_id: int,
    bulk_in: schemas.LivePlaylistChannelBulkDelete,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Remove multiple channels from a playlist."""
    # Use subquery to avoid join in delete which is not supported by all DBs
    bouquet_ids = db.query(LivePlaylistBouquet.id).filter(LivePlaylistBouquet.playlist_id == playlist_id)
    db.query(LivePlaylistChannel).filter(
        LivePlaylistChannel.id.in_(bulk_in.channel_ids),
        LivePlaylistChannel.bouquet_id.in_(bouquet_ids)
    ).delete(synchronize_session=False)
    
    db.commit()
    return {"status": "success"}

@router.post("/playlists/{playlist_id}/bouquets/{bouquet_id}/duplicate", response_model=schemas.LivePlaylistBouquet)
def duplicate_bouquet(
    playlist_id: int,
    bouquet_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Duplicate a bouquet and all its channels."""
    source = db.query(LivePlaylistBouquet).filter_by(id=bouquet_id, playlist_id=playlist_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Bouquet not found")
    
    # Create new bouquet
    new_bouquet = LivePlaylistBouquet(
        playlist_id=playlist_id,
        category_id=source.category_id,
        subscription_id=source.subscription_id,
        custom_name=f"{source.custom_name} (Copy)" if source.custom_name else "Copy",
        order=db.query(LivePlaylistBouquet).filter_by(playlist_id=playlist_id).count()
    )
    db.add(new_bouquet)
    db.flush() # Get new_bouquet.id
    
    # Duplicate channels
    for ch in source.channels:
        new_ch = LivePlaylistChannel(
            bouquet_id=new_bouquet.id,
            stream_id=ch.stream_id,
            subscription_id=ch.subscription_id,
            custom_name=ch.custom_name,
            order=ch.order,
            is_excluded=ch.is_excluded,
            epg_channel_id=ch.epg_channel_id
        )
        db.add(new_ch)
    
    db.commit()
    db.refresh(new_bouquet)
    return new_bouquet

# --- EPG Source Management v4.0.0 ---

@router.get("/playlists/{playlist_id}/epg-sources", response_model=List[Any])
def get_playlist_epg_sources(
    playlist_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Get all EPG sources linked to a playlist."""
    links = db.query(PlaylistEPGSource).filter(PlaylistEPGSource.playlist_id == playlist_id).all()
    results = []
    for link in links:
        # Convert to Pydantic first to handle serialization properly
        p_link = schemas.PlaylistEPGSourceResponse.model_validate(link)
        link_data = p_link.model_dump()
        # Add root-level is_active for old frontend compatibility 
        # (old frontend filters by s.is_active on the list items)
        link_data["is_active"] = p_link.epg_source.is_active
        results.append(link_data)
    return results

@router.post("/playlists/{playlist_id}/epg-sources", response_model=schemas.PlaylistEPGSourceResponse)
def link_epg_source(
    playlist_id: int,
    link_in: schemas.PlaylistEPGSourceCreate,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Link a global EPG source to a playlist."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    # Check if already linked
    existing = db.query(PlaylistEPGSource).filter_by(
        playlist_id=playlist_id, 
        epg_source_id=link_in.epg_source_id
    ).first()
    if existing:
        return existing
    
    link = PlaylistEPGSource(
        playlist_id=playlist_id,
        epg_source_id=link_in.epg_source_id,
        priority=link_in.priority
    )
    db.add(link)
    db.commit()
    db.refresh(link)
    return link

@router.put("/epg-sources/links/{link_id}", response_model=schemas.PlaylistEPGSourceResponse)
def update_epg_link(
    link_id: int,
    priority: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Update priority of a playlist-EPG link."""
    link = db.query(PlaylistEPGSource).filter(PlaylistEPGSource.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    
    link.priority = priority
    db.commit()
    db.refresh(link)
    return link

@router.delete("/epg-sources/links/{link_id}")
def unlink_epg_source(
    link_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Unlink a global EPG source from a playlist."""
    link = db.query(PlaylistEPGSource).filter(PlaylistEPGSource.id == link_id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    db.delete(link)
    db.commit()
    return {"status": "success"}

@router.post("/epg-mapping/{channel_id}", response_model=schemas.LivePlaylistChannel)
def update_channel_epg_mapping(
    channel_id: int,
    mapping_in: schemas.EPGMappingUpdate,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Update EPG mapping for a specific channel."""
    channel = db.query(LivePlaylistChannel).filter(LivePlaylistChannel.id == channel_id).first()
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    
    channel.epg_channel_id = mapping_in.epg_channel_id
    db.commit()
    db.refresh(channel)
    return channel

@router.get("/epg-sources/{source_id}/search", response_model=Any)
def search_epg_channels(
    source_id: int,
    query: str = Query(...),
    db: Session = Depends(deps.get_db)
) -> Any:
    """Search for channels within an EPG source."""
    return epg_service.search_channels(source_id, query)

@router.get("/epg/search", response_model=Any)
def global_epg_search(
    q: str = Query(...),
    db: Session = Depends(deps.get_db)
) -> Any:
    """Search for channels across all active global EPG sources."""
    from app.models.epg import EPGSourceGlobal
    sources = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.is_active == True).all()
    results = []
    for src in sources:
        src_results = epg_service.search_channels(src.id, q)
        for r in src_results:
            results.append({
                "epg_id": r["id"],
                "name": r["name"],
                "icon": r["icon"],
                "source_name": src.name
            })
    return results[:100]

@router.post("/playlists/{playlist_id}/epg-auto-match")
async def auto_match_epg(
    playlist_id: int,
    release_shared: bool = False,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Trigger fuzzy matching for unmapped channels in a playlist.

    `release_shared` first unmaps channels that share one EPG id — the damage
    the previous matching algorithm left behind — so they can be matched
    again. Off by default: two channels on one id can also be a deliberate
    choice, and this cannot tell the difference.
    """
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Returns a report, not a bare count: "0 matched" and "there is no EPG
    # source to match against" are different answers and used to look alike.
    report = await epg_service.auto_match_channels(playlist, db, release_shared=release_shared)
    return {"status": "success", **report}

@router.get("/playlists/{playlist_id}/channels/{channel_id}/epg-debug", response_model=schemas.EPGMatchDebugResponse)
async def debug_epg_match(
    playlist_id: int,
    channel_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Get EPG match candidates for a specific channel for debugging."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    channel = db.query(LivePlaylistChannel).join(LivePlaylistBouquet).filter(
        LivePlaylistChannel.id == channel_id,
        LivePlaylistBouquet.playlist_id == playlist_id
    ).first()
    
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
        
    sub = playlist.subscription
    client = get_catalog(db, sub)

    target_name = channel.custom_name
    if not target_name:
        # Fetch stream name from Xtream if no custom name
        try:
            # We fetch all live streams once (cached in client usually or handled by provider)
            # For simplicity, we assume we need the name from the provider.
            streams = await client.get_live_streams()
            stream = next((s for s in streams if str(s.get("stream_id")) == str(channel.stream_id)), None)
            if stream:
                target_name = stream.get("name")
        except:
            target_name = f"Stream {channel.stream_id}"
            
    candidates = await epg_service.get_epg_match_candidates(playlist, target_name)
    
    return {
        "target_name": target_name,
        "candidates": candidates
    }

@router.post("/epg-sources/{source_id}/refresh")
async def refresh_epg_source(
    source_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Trigger a refresh for a global EPG source."""
    source = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.id == source_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="EPG Source not found")
    
    await epg_service.fetch_and_cache_epg(source, db_session=db)

    # Report what the refresh actually cached. This used to answer
    # "EPG refresh started" unconditionally — including for an 'xtream'
    # source, which did nothing at all.
    channel_count = epg_service.redis.scard(f"epg:src:{source.id}:channels")
    source.channel_count = channel_count
    source.last_updated = datetime.utcnow()
    db.commit()

    if not channel_count:
        return {
            "status": "empty",
            "channel_count": 0,
            "message": (
                "The refresh completed but cached no channels. Check the source "
                "URL, file path, or — for a provider guide — that the subscription "
                "is set and still valid."
            ),
        }

    return {
        "status": "success",
        "channel_count": channel_count,
        "message": f"{channel_count} channel(s) cached.",
    }

@router.get("/streams/search", response_model=Any)
async def search_live_streams(
    subscription_id: int,
    q: str = Query(...),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    grouped: bool = Query(True),
    db: Session = Depends(deps.get_db)
) -> Any:
    """Search for live streams across all categories in a source with pagination."""
    sub = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    client = get_catalog(db, sub)
    try:
        all_streams = await client.get_live_streams()
        categories = await client.get_live_categories()
        
        cat_map = {str(c.get("category_id")): c.get("category_name") for c in categories}
        
        query = q.lower()
        results = []
        
        for s in all_streams:
            if query in s.get("name", "").lower():
                results.append({
                    "stream_id": s.get("stream_id"),
                    "name": s.get("name"),
                    "category_id": str(s.get("category_id")),
                    "category_name": cat_map.get(str(s.get("category_id")), "Unknown"),
                    "stream_icon": s.get("stream_icon"),
                    "epg_channel_id": s.get("epg_channel_id")
                })
        
        total = len(results)
        start = (page - 1) * page_size
        end = start + page_size
        page_results = results[start:end]

        if not grouped:
            return {
                "items": page_results,
                "total": total,
                "page": page,
                "page_size": page_size,
                "pages": (total + page_size - 1) // page_size
            }

        grouped_data = {}
        for r in page_results:
            cid = str(r["category_id"])
            cname = r["category_name"]
            if cid not in grouped_data:
                grouped_data[cid] = {"category_id": cid, "category_name": cname, "streams": []}
            grouped_data[cid]["streams"].append(r)
            
        return {
            "items": list(grouped_data.values()),
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": (total + page_size - 1) // page_size
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

def _as_positive_int(value: Any) -> int:
    """A count from a provider, which may arrive as "7", 7, "" or None."""
    try:
        number = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _catchup_of(stream: dict, sub: Optional[Subscription]) -> dict:
    """What replay this stream offers, or {} when it offers none.

    Catch-up is the one thing a generated playlist cannot reconstruct: the
    archive lives on the provider's own endpoint, under a URL only the provider
    defines. So nothing is invented here — an M3U source's tags are passed
    through exactly as written, and an Xtream source gets the `xc` type, which
    is precisely "the archive is reachable through this panel's timeshift
    endpoint" and which the player derives from the stream URL we already
    publish. A channel whose source says nothing gets no tags at all.
    """
    mode = (stream.get("catchup") or "").strip()
    source = (stream.get("catchup_source") or "").strip()
    days = _as_positive_int(stream.get("tv_archive_duration"))
    archived = str(stream.get("tv_archive") or "").strip().lower() not in (
        "", "0", "none", "null", "false")

    if not (mode or source or days or archived):
        return {}

    if not mode:
        mode = "default" if (sub and sub.kind == SourceKind.M3U.value) else "xc"

    return {"catchup": mode, "catchup_days": days, "catchup_source": source}


def _catchup_attributes(channel: dict) -> str:
    """The catch-up part of an #EXTINF line, with a trailing space, or "".

    Quotes inside a source template would close the attribute early and corrupt
    every tag after it, so they are percent-encoded rather than trusted.
    """
    mode = channel.get("catchup")
    if not mode:
        return ""

    attributes = [f'catchup="{str(mode).replace(chr(34), "%22")}"']
    if channel.get("catchup_days"):
        attributes.append(f'catchup-days="{channel["catchup_days"]}"')
    if channel.get("catchup_source"):
        source = str(channel["catchup_source"]).replace(chr(34), "%22")
        attributes.append(f'catchup-source="{source}"')
    return " ".join(attributes) + " "


def _clean_epg_id(value: Any) -> str:
    """Normalise a tvg-id coming from a provider or from a channel override.

    Xtream returns a JSON null for an unmapped channel, which ``.get(key, "")``
    does not catch — the id then reached the M3U as the literal string "None",
    and every player went looking for a channel by that name in the guide.
    """
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in ("none", "null") else text


async def resolve_playlist_channels(
    db: Session, playlist: LivePlaylist, dropped: Optional[List[dict]] = None
) -> List[dict]:
    """Resolve the channels a playlist actually serves, in broadcast order.

    Single source of truth for the M3U, the XMLTV guide and the validation
    report. Those three used to walk the playlist independently — the M3U from
    the provider's stream list, the guide from the stored channel rows — so the
    playlist advertised tvg-ids for channels the guide never described, and the
    validation counted rows nobody was served. Anything that describes what a
    player receives must go through here.

    Pass ``dropped`` to collect the channels that are configured but cannot be
    served — a stream the provider no longer lists, or a subscription that did
    not answer. They vanish from the playlist either way; the list is what makes
    the loss reportable instead of silent.
    """
    sub_ids = set()
    if playlist.subscription_id:
        sub_ids.add(playlist.subscription_id)
    for b in playlist.bouquets:
        if b.subscription_id:
            sub_ids.add(b.subscription_id)
        for c in b.channels:
            if c.subscription_id:
                sub_ids.add(c.subscription_id)

    subscription_data = {}
    for sid in sub_ids:
        sub = db.query(Subscription).filter(Subscription.id == sid).first()
        if not sub:
            continue
        client = get_catalog(db, sub)
        try:
            streams_list = await client.get_live_streams()
            subscription_data[sid] = {
                "sub": sub,
                # Kept so the URL can be asked of the same object that listed
                # the stream: an Xtream URL is rebuilt from credentials, an M3U
                # one is whatever the playlist wrote.
                "client": client,
                "streams_list": streams_list,
                "streams_map": {str(s.get("stream_id")): s for s in streams_list},
            }
        except Exception as e:
            logger.error(f"Failed to fetch streams for sub {sid}: {e}")

    resolved: List[dict] = []

    for bouquet in sorted(playlist.bouquets, key=lambda x: x.order):
        b_sub_id = bouquet.subscription_id or playlist.subscription_id
        # A smart group is defined by a provider category, so it cannot be read
        # without knowing whose category it is. A virtual group is defined by the
        # channels put in it, and each of those carries its own subscription —
        # requiring one on the bouquet too silently served an empty playlist for
        # every multi-provider group built by the organiser.
        if not bouquet.category_id:
            resolvable = any(
                (c.subscription_id or b_sub_id) in subscription_data
                for c in bouquet.channels
            )
        else:
            resolvable = bool(b_sub_id) and b_sub_id in subscription_data

        if not resolvable:
            if dropped is not None:
                for c in bouquet.channels:
                    dropped.append({
                        "stream_id": str(c.stream_id),
                        "name": c.custom_name or "",
                        "bouquet": bouquet.custom_name or "",
                        "reason": "subscription_unavailable",
                    })
            continue

        data = subscription_data.get(b_sub_id) or {"streams_list": [], "streams_map": {}}
        group_title = bouquet.custom_name or (
            f"Category {bouquet.category_id}" if bouquet.category_id else "Custom Group"
        )

        bouquet_streams = []  # (stream_data, override_row, sub_id)

        if bouquet.category_id:
            # Smart group: the whole provider category, minus explicit exclusions.
            overrides = {str(c.stream_id): c for c in bouquet.channels}
            for s in data["streams_list"]:
                if str(s.get("category_id")) != str(bouquet.category_id):
                    continue
                override = overrides.get(str(s.get("stream_id")))
                if override and override.is_excluded:
                    continue
                bouquet_streams.append((s, override, b_sub_id))
        else:
            # Virtual group: only the channels explicitly added to it.
            for channel in sorted(bouquet.channels, key=lambda x: x.order):
                if channel.is_excluded:
                    continue
                c_sub_id = channel.subscription_id or b_sub_id
                s = (subscription_data.get(c_sub_id) or {}).get("streams_map", {}).get(
                    str(channel.stream_id)
                )
                if s:
                    bouquet_streams.append((s, channel, c_sub_id))
                elif dropped is not None:
                    dropped.append({
                        "stream_id": str(channel.stream_id),
                        "name": channel.custom_name or "",
                        "bouquet": group_title,
                        "reason": ("subscription_unavailable"
                                   if c_sub_id not in subscription_data
                                   else "stream_gone_from_provider"),
                    })

        bouquet_streams.sort(key=lambda x: x[1].order if x[1] else 999)

        for stream, override, s_sub_id in bouquet_streams:
            client = subscription_data[s_sub_id]["client"]
            override_id = _clean_epg_id(override.epg_channel_id) if override else ""
            resolved.append({
                **_catchup_of(stream, subscription_data[s_sub_id].get("sub")),
                "number": override.order if override else None,
                "stream_id": str(stream.get("stream_id")),
                "name": (override.custom_name if (override and override.custom_name)
                         else stream.get("name")) or "",
                "logo": stream.get("stream_icon") or "",
                # An explicit mapping wins; otherwise fall back to what the
                # provider declares for this stream.
                "epg_id": override_id or _clean_epg_id(stream.get("epg_channel_id")),
                "epg_id_source": "override" if override_id else "provider",
                "group_title": group_title,
                "bouquet": group_title,
                "subscription_id": s_sub_id,
                "url": client.get_stream_url("live", str(stream.get("stream_id")), "ts"),
            })

    return resolved


@router.get("/playlist.xml")
async def get_playlist_epg(
    db: Session = Depends(deps.get_db),
    playlist_id: str = Query(...)
) -> Any:
    """Serve the custom XMLTV guide for a specific playlist."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.public_id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Describe exactly the channels the M3U advertises, using the same ids.
    channels = await resolve_playlist_channels(db, playlist)
    xml_content = epg_service.generate_playlist_xmltv(playlist, channels)
    return Response(content=xml_content, media_type="application/xml")

@router.get("/playlist.m3u")
async def generate_m3u_playlist(
    request: Request,
    db: Session = Depends(deps.get_db),
    playlist_id: str = Query(...)
):
    """Generate M3U playlist based on specific playlist configuration."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.public_id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    channels = await resolve_playlist_channels(db, playlist)

    # Absolute EPG URL: a relative one resolves against the player's own base,
    # so nothing could fetch the guide without the user pasting a second URL.
    epg_url = str(request.url_for("get_playlist_epg").include_query_params(playlist_id=playlist.public_id))
    m3u_content = [f'#EXTM3U x-tvg-url="{epg_url}"']

    for channel in channels:
        name = channel["name"]
        # tvg-chno only where the playlist says its orders are real channel
        # numbers. Emitting it everywhere would hand a player the positions
        # 0, 1, 2… of every existing playlist as if they were the numbering.
        chno = ""
        if playlist.use_channel_numbers and channel.get("number"):
            chno = f'tvg-chno="{channel["number"]}" '
        extinf = (
            f'#EXTINF:-1 {chno}{_catchup_attributes(channel)}'
            f'tvg-id="{channel["epg_id"]}" tvg-name="{name}" '
            f'tvg-logo="{channel["logo"]}" group-title="{channel["group_title"]}",{name}'
        )
        m3u_content.append(extinf)
        m3u_content.append(channel["url"])

    return Response(content="\n".join(m3u_content), media_type="text/plain")

@router.get("/playlists/{playlist_id}/m3u/preview")
async def preview_m3u_playlist(
    playlist_id: int,
    request: Request,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Get the exact M3U content served to players, as JSON."""
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    resp = await generate_m3u_playlist(request=request, db=db, playlist_id=playlist.public_id)
    return {"content": resp.body.decode()}

@router.get("/playlists/{playlist_id}/validation")
async def get_playlist_validation(
    playlist_id: int,
    db: Session = Depends(deps.get_db)
) -> Any:
    """Report on what a player will actually receive from this playlist.

    This counted stored channel rows before, which is not what is served: a smart
    group has no row unless a channel is overridden, so the report both invented
    channels nobody receives and hid the ones with no guide. It now walks the
    resolved list and checks each tvg-id against the linked EPG sources, which is
    the same join the player performs.
    """
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    dropped: List[dict] = []
    channels = await resolve_playlist_channels(db, playlist, dropped=dropped)
    source_ids = epg_service.active_source_ids(playlist)

    missing_epg = []      # no tvg-id at all
    unmatched_epg = []    # tvg-id present, but no linked source describes it
    guided = 0
    by_epg_id: Dict[str, List[str]] = {}

    for ch in channels:
        entry = {
            "stream_id": ch["stream_id"],
            "name": ch["name"],
            "bouquet": ch["bouquet"],
            "epg_id": ch["epg_id"],
            "epg_id_source": ch["epg_id_source"],
        }
        if not ch["epg_id"]:
            missing_epg.append(entry)
        else:
            by_epg_id.setdefault(ch["epg_id"], []).append(ch["name"])
            if epg_service.channel_is_covered(source_ids, ch["epg_id"]):
                guided += 1
            else:
                unmatched_epg.append(entry)

    # One id shared by several channels is legitimate for a duplicated channel,
    # and a sure sign of a bad auto-match beyond that: every one of them then
    # shows the same schedule in the player, while the mapping counter reads
    # like a perfect score.
    shared_epg_ids = [
        {"epg_id": epg_id, "channel_count": len(names), "channels": names[:10]}
        for epg_id, names in sorted(by_epg_id.items(), key=lambda kv: -len(kv[1]))
        if len(names) > 1
    ]

    return {
        "total_channels": len(channels),
        "mapped_channels": len(channels) - len(missing_epg),
        "guided_channels": guided,
        # How many channels the playlist advertises replay for. Silent before,
        # and the one number that says whether the catch-up tags survived the
        # trip from the provider to the player.
        "catchup_channels": sum(1 for ch in channels if ch.get("catchup")),
        "epg_sources_linked": len(source_ids),
        "missing_count": len(missing_epg),
        "missing_channels": missing_epg[:50],
        "unmatched_count": len(unmatched_epg),
        "unmatched_channels": unmatched_epg[:50],
        "shared_epg_id_count": len(shared_epg_ids),
        "shared_epg_ids": shared_epg_ids[:20],
        "dropped_count": len(dropped),
        "dropped_channels": dropped[:50],
    }

# Legacy compatibility (optional)
@router.get("/config", response_model=schemas.LiveConfig)
def get_live_config_legacy(
    db: Session = Depends(deps.get_db),
    subscription_id: int = Query(...)
) -> Any:
    config = db.query(LiveStreamSubscription).filter(LiveStreamSubscription.subscription_id == subscription_id).first()
    if not config:
        return schemas.LiveConfig(id=0, subscription_id=subscription_id, included_categories=[], excluded_streams=[])
    return config
