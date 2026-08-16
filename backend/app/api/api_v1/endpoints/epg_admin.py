from typing import Any, List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.api import deps
from app.models.epg import EPGSourceGlobal, PlaylistEPGSource
from app import schemas
from sqlalchemy import func

router = APIRouter()

_SOURCE_TYPES = ("url", "file", "xtream")


def _validate_source(db: Session, source_type: str, source_url, file_path, subscription_id):
    """Refuse a source that can never produce a guide.

    'xtream' was accepted with no further checks and then silently did
    nothing: the source appeared in the list, refreshed without complaint,
    and cached zero channels forever. Whatever cannot work is rejected at the
    point the user can still fix it.
    """
    if source_type not in _SOURCE_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown source type '{source_type}'. Expected one of: {', '.join(_SOURCE_TYPES)}.",
        )

    if source_type == "url" and not source_url:
        raise HTTPException(status_code=422, detail="A URL source needs a source URL.")

    if source_type == "file" and not file_path:
        raise HTTPException(status_code=422, detail="A file source needs a file path.")

    if source_type == "xtream":
        if source_url:
            # An explicit URL overrides the derived one; nothing else to check.
            return
        if not subscription_id:
            raise HTTPException(
                status_code=422,
                detail=(
                    "A provider guide needs a subscription: its XMLTV URL is built "
                    "from that subscription's server and credentials."
                ),
            )
        from app.models.subscription import Subscription
        sub = db.query(Subscription).filter(Subscription.id == subscription_id).first()
        if not sub:
            raise HTTPException(
                status_code=422, detail=f"Subscription {subscription_id} does not exist."
            )
        if not sub.xtream_url:
            raise HTTPException(
                status_code=422,
                detail=f"Subscription '{sub.name}' has no server URL, so no guide URL can be built.",
            )


@router.get("/", response_model=List[schemas.EPGSourceGlobalResponse])
def read_epg_sources(
    db: Session = Depends(deps.get_db),
    skip: int = 0,
    limit: int = 100,
) -> Any:
    """Retrieve all global EPG sources with usage statistics."""
    sources = db.query(EPGSourceGlobal).offset(skip).limit(limit).all()
    
    # Calculate usage counts
    res = []
    for source in sources:
        usage_count = db.query(PlaylistEPGSource).filter(
            PlaylistEPGSource.epg_source_id == source.id
        ).count()
        
        # Pydantic will handle the mapping
        s_dict = {
            "id": source.id,
            "name": source.name,
            "source_type": source.source_type,
            "source_url": source.source_url,
            "file_path": source.file_path,
            "subscription_id": source.subscription_id,
            "is_active": source.is_active,
            "refresh_interval_hours": source.refresh_interval_hours,
            "created_at": source.created_at,
            "last_updated": source.last_updated,
            "channel_count": source.channel_count,
            "used_by_playlists_count": usage_count
        }
        res.append(s_dict)
    
    return res

@router.post("/", response_model=schemas.EPGSourceGlobalResponse)
def create_epg_source(
    *,
    db: Session = Depends(deps.get_db),
    source_in: schemas.EPGSourceGlobalCreate,
) -> Any:
    """Create new global EPG source."""
    _validate_source(db, source_in.source_type, source_in.source_url,
                     source_in.file_path, source_in.subscription_id)
    source = EPGSourceGlobal(**source_in.model_dump())
    db.add(source)
    db.commit()
    db.refresh(source)
    
    # Trigger initial refresh in background
    try:
        from app.tasks.epg import refresh_epg_task
        refresh_epg_task.delay(source.id)
    except Exception as e:
        print(f"Warning: Could not trigger initial refresh: {e}")
        
    return source

@router.put("/{source_id}", response_model=schemas.EPGSourceGlobalResponse)
def update_epg_source(
    *,
    db: Session = Depends(deps.get_db),
    source_id: int,
    source_in: schemas.EPGSourceGlobalUpdate,
) -> Any:
    """Update global EPG source."""
    source = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.id == source_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="EPG Source not found")
    
    update_data = source_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(source, field, value)

    # Validated after the merge, on the resulting state: a partial update that
    # only flips source_type must still be checked against the existing URL,
    # file path and subscription.
    _validate_source(db, source.source_type, source.source_url,
                     source.file_path, source.subscription_id)

    db.commit()
    db.refresh(source)
    return source

@router.delete("/{source_id}")
def delete_epg_source(
    *,
    db: Session = Depends(deps.get_db),
    source_id: int,
) -> Any:
    """Delete global EPG source if not used by any playlist."""
    source = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.id == source_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="EPG Source not found")
    
    # Check usage
    usage_count = db.query(PlaylistEPGSource).filter(
        PlaylistEPGSource.epg_source_id == source_id
    ).count()
    
    if usage_count > 0:
        raise HTTPException(
            status_code=400, 
            detail=f"Cannot delete source: Used by {usage_count} playlists. Unlink them first."
        )
    
    db.delete(source)
    db.commit()
    return {"status": "success"}

@router.post("/{source_id}/refresh")
def refresh_source(
    *,
    db: Session = Depends(deps.get_db),
    source_id: int,
) -> Any:
    """Trigger manual refresh of a global EPG source."""
    source = db.query(EPGSourceGlobal).filter(EPGSourceGlobal.id == source_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="EPG Source not found")
    
    try:
        from app.tasks.epg import refresh_epg_task
        refresh_epg_task.delay(source.id)
        return {"status": "success", "message": "Refresh task queued"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to queue refresh task: {e}")
