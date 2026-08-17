"""Reading and correcting the TMDB id of a synced title.

The list this serves is the *library*, not the provider's catalogue: the rows of
``movie_cache`` / ``series_cache`` are what has actually been written to disk,
so what the screen shows is what Jellyfin is reading right now. A correction is
stored separately (see ``app.models.tmdb_override``) and takes effect on the
next sync of that source, which is also what renames the folder on disk.
"""

from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api import deps
from app.models.cache import MovieCache, SeriesCache
from app.models.subscription import Subscription
from app.models.tmdb_override import TmdbMediaType, TmdbOverride
from app.schemas import TmdbOverrideResponse, TmdbOverrideUpsert
from app.services.tmdb_overrides import name_key, normalise_id

router = APIRouter()

_MEDIA_TYPES = (TmdbMediaType.MOVIE, TmdbMediaType.SERIES)


def _check_media_type(media_type: str) -> str:
    if media_type not in _MEDIA_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"media_type must be one of {', '.join(_MEDIA_TYPES)}")
    return media_type


def _check_tmdb_id(value: Optional[str]) -> Optional[str]:
    """A TMDB id is a bare number. Anything else is a mistake worth refusing.

    Users paste whole URLs — "themoviedb.org/movie/550-fight-club" — and a
    silently stored one would produce a folder Jellyfin cannot match, which
    looks exactly like the problem being fixed.
    """
    cleaned = normalise_id(value)
    if cleaned is None:
        return None
    if not cleaned.isdigit():
        raise HTTPException(
            status_code=400,
            detail=(f"'{cleaned}' is not a TMDB id. Paste only the number — "
                    "for https://www.themoviedb.org/movie/550-fight-club "
                    "that is 550."))
    return cleaned


@router.get("/library")
def list_library(
    subscription_id: int = Query(...),
    media_type: str = Query(...),
    q: Optional[str] = Query(None),
    only_overridden: bool = Query(False),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(deps.get_db),
) -> Any:
    """The titles this source has written, with the id each one carries."""
    _check_media_type(media_type)
    if not db.query(Subscription).filter(Subscription.id == subscription_id).first():
        raise HTTPException(status_code=404, detail="Subscription not found")

    if media_type == TmdbMediaType.MOVIE:
        rows = db.query(MovieCache).filter(
            MovieCache.subscription_id == subscription_id).all()
        items = [(str(r.stream_id), r.name, r.tmdb_id) for r in rows]
    else:
        rows = db.query(SeriesCache).filter(
            SeriesCache.subscription_id == subscription_id).all()
        items = [(str(r.series_id), r.name, r.tmdb_id) for r in rows]

    overrides = {
        str(o.item_id): o
        for o in db.query(TmdbOverride).filter(
            TmdbOverride.subscription_id == subscription_id,
            TmdbOverride.media_type == media_type,
        ).all()
    }

    if q:
        needle = q.strip().lower()
        items = [i for i in items if needle in (i[1] or "").lower()]

    results = []
    for item_id, name, current in items:
        override = overrides.get(item_id)
        results.append({
            "item_id": item_id,
            "name": name or "",
            # What the last sync wrote — i.e. the id the folder on disk carries.
            "current_tmdb_id": normalise_id(current),
            "override_tmdb_id": normalise_id(override.tmdb_id) if override else None,
            "override_id": override.id if override else None,
            "has_override": override is not None,
            # True while the correction has been made but no sync has yet
            # rewritten the folder. This is what tells the user to run a sync.
            "pending": (override is not None
                        and normalise_id(override.tmdb_id) != normalise_id(current)),
        })

    if only_overridden:
        results = [r for r in results if r["has_override"]]

    results.sort(key=lambda r: (r["name"] or "").lower())

    total = len(results)
    start = (page - 1) * page_size
    return {
        "items": results[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size,
        "override_count": len(overrides),
        "pending_count": sum(1 for r in results if r["pending"]),
    }


@router.get("", response_model=List[TmdbOverrideResponse])
def list_overrides(
    subscription_id: Optional[int] = Query(None),
    db: Session = Depends(deps.get_db),
) -> Any:
    """Every correction on record, newest first."""
    query = db.query(TmdbOverride)
    if subscription_id:
        query = query.filter(TmdbOverride.subscription_id == subscription_id)
    return query.order_by(TmdbOverride.updated_at.desc()).all()


@router.put("", response_model=TmdbOverrideResponse)
def upsert_override(
    payload: TmdbOverrideUpsert,
    db: Session = Depends(deps.get_db),
) -> Any:
    """Set the TMDB id of one title, replacing any previous answer.

    A null id is a valid answer: it means "this title has no TMDB entry", and
    stops the provider's wrong one from being used. Deleting the row is the way
    to hand the decision back to the provider.
    """
    _check_media_type(payload.media_type)
    if not db.query(Subscription).filter(
            Subscription.id == payload.subscription_id).first():
        raise HTTPException(status_code=404, detail="Subscription not found")

    tmdb_id = _check_tmdb_id(payload.tmdb_id)

    override = db.query(TmdbOverride).filter(
        TmdbOverride.subscription_id == payload.subscription_id,
        TmdbOverride.media_type == payload.media_type,
        TmdbOverride.item_id == str(payload.item_id),
    ).first()

    if not override:
        override = TmdbOverride(
            subscription_id=payload.subscription_id,
            media_type=payload.media_type,
            item_id=str(payload.item_id),
        )
        db.add(override)

    override.tmdb_id = tmdb_id
    override.label = payload.label
    override.name_key = name_key(payload.label)

    db.commit()
    db.refresh(override)
    return override


@router.delete("/{override_id}")
def delete_override(
    override_id: int,
    db: Session = Depends(deps.get_db),
) -> Any:
    """Drop a correction; the provider's id applies again from the next sync."""
    override = db.query(TmdbOverride).filter(
        TmdbOverride.id == override_id).first()
    if not override:
        raise HTTPException(status_code=404, detail="Override not found")
    db.delete(override)
    db.commit()
    return {"status": "success"}
