"""The M3U half of the sources screen.

Kept as its own router because the *creation* of an M3U source genuinely
differs — a URL or an uploaded file, instead of credentials — but everything it
reads and writes is now the one `subscriptions` table. Listing, syncing and
deleting are the same operations as for an Xtream subscription.
"""

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Form
from sqlalchemy.orm import Session
from typing import List, Optional
from app.db.session import get_db
from app.models.selection import SelectedCategory
from app.models.source_entry import SourceEntry
from app.models.subscription import M3USourceType, SourceKind, Subscription
from app.models.sync_state import SyncState
from app.tasks.sync import sync_movies_task, sync_series_task
from pathlib import Path
import logging
import os
import shutil

router = APIRouter()
logger = logging.getLogger(__name__)

# Schema classes (inline for simplicity)
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class M3USourceCreate(BaseModel):
    name: str
    url: str
    movies_dir: Optional[str] = None
    series_dir: Optional[str] = None
    output_dir: Optional[str] = None

class M3USourceResponse(BaseModel):
    id: int
    name: str
    source_type: str
    url: Optional[str]
    file_path: Optional[str]
    output_dir: Optional[str]
    movies_dir: Optional[str]
    series_dir: Optional[str]
    is_active: bool
    sync_status: Optional[str] = "idle"
    last_sync: Optional[datetime]
    created_at: Optional[datetime]

    class Config:
        from_attributes = True

class M3UEntryResponse(BaseModel):
    id: int
    title: str
    group_title: Optional[str]
    entry_type: str

    class Config:
        from_attributes = True


def _get_m3u_source(db: Session, source_id: int) -> Subscription:
    source = db.query(Subscription).filter(
        Subscription.id == source_id,
        Subscription.kind == SourceKind.M3U.value,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="M3U source not found")
    return source


def _reject_duplicate_name(db: Session, name: str, exclude_id: int = None) -> None:
    """`subscriptions.name` is unique across both kinds now, so an M3U source
    can collide with an Xtream subscription. Say so rather than let the insert
    fail with an opaque integrity error."""
    query = db.query(Subscription).filter(Subscription.name == name)
    if exclude_id is not None:
        query = query.filter(Subscription.id != exclude_id)
    if query.first():
        raise HTTPException(status_code=400, detail="A source with this name already exists")


def _own_directories(db: Session, source: Subscription) -> List[str]:
    """The output directories this source alone is responsible for.

    Anything another source also points at — or that is an ancestor of another
    source's directory — is excluded: deleting it would take that source's
    library with it.
    """
    others = set()
    for sub in db.query(Subscription).filter(Subscription.id != source.id).all():
        for path in (sub.movies_dir, sub.series_dir, sub.output_dir,
                     sub.download_movies_dir, sub.download_series_dir):
            if path:
                others.add(os.path.abspath(path))

    own = []
    for path in (source.movies_dir, source.series_dir, source.output_dir):
        if not path or not os.path.isdir(path):
            continue
        absolute = os.path.abspath(path)
        if absolute in own:
            continue
        clash = next(
            (o for o in others
             if o == absolute or o.startswith(absolute + os.sep)),
            None,
        )
        if clash:
            logger.warning(
                "Not removing %s with source %s: another source writes to %s",
                absolute, source.name, clash,
            )
            continue
        own.append(absolute)

    # A directory nested inside another one already listed is removed with it.
    return [p for p in own
            if not any(p != q and p.startswith(q + os.sep) for q in own)]


@router.get("/", response_model=List[M3USourceResponse])
def list_m3u_sources(db: Session = Depends(get_db)):
    """List all M3U sources"""
    return db.query(Subscription).filter(
        Subscription.kind == SourceKind.M3U.value
    ).all()


@router.post("/url", response_model=M3USourceResponse)
def create_m3u_source_from_url(source: M3USourceCreate, db: Session = Depends(get_db)):
    """Create M3U source from URL"""
    _reject_duplicate_name(db, source.name)

    output_dir = source.output_dir or f"/output/m3u/{source.name}"

    db_source = Subscription(
        name=source.name,
        kind=SourceKind.M3U.value,
        source_type=M3USourceType.URL.value,
        url=source.url,
        xtream_url="", username="", password="",
        output_dir=output_dir,
        movies_dir=source.movies_dir or f"{output_dir}/movies",
        series_dir=source.series_dir or f"{output_dir}/series",
        is_active=True,
    )

    db.add(db_source)
    db.commit()
    db.refresh(db_source)

    # Do NOT trigger sync - user must select groups first
    return db_source


@router.post("/upload")
async def upload_m3u_file(
    name: str = Form(...),
    file: UploadFile = File(...),
    movies_dir: Optional[str] = Form(None),
    series_dir: Optional[str] = Form(None),
    db: Session = Depends(get_db)
):
    """Upload M3U file and create source"""
    _reject_duplicate_name(db, name)

    # Validate file extension
    if not file.filename.endswith(('.m3u', '.m3u8')):
        raise HTTPException(status_code=400, detail="File must be .m3u or .m3u8")

    # Create uploads directory if it doesn't exist
    upload_dir = Path("/app/uploads/m3u")
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Save uploaded file
    file_path = upload_dir / f"{name}.m3u"
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Blank form fields arrive as "", which must fall back to the defaults.
    output_dir = f"/output/m3u/{name}"

    db_source = Subscription(
        name=name,
        kind=SourceKind.M3U.value,
        source_type=M3USourceType.FILE.value,
        file_path=str(file_path),
        xtream_url="", username="", password="",
        output_dir=output_dir,
        movies_dir=(movies_dir or "").strip() or f"{output_dir}/movies",
        series_dir=(series_dir or "").strip() or f"{output_dir}/series",
        is_active=True,
    )

    db.add(db_source)
    db.commit()
    db.refresh(db_source)

    return {"id": db_source.id, "name": db_source.name, "message": "File uploaded successfully"}


@router.post("/{source_id}/sync")
def trigger_m3u_sync(source_id: int, force: bool = False, db: Session = Depends(get_db)):
    """Trigger sync for M3U source"""
    source = _get_m3u_source(db, source_id)

    movies = sync_movies_task.delay(source.id, force=force)
    series = sync_series_task.delay(source.id, force=force)

    return {"message": "Sync started", "task_id": movies.id,
            "task_ids": {"movies": movies.id, "series": series.id}}


@router.get("/{source_id}/entries", response_model=List[M3UEntryResponse])
def get_m3u_entries(source_id: int, db: Session = Depends(get_db)):
    """Get entries for M3U source"""
    return db.query(SourceEntry).filter(SourceEntry.subscription_id == source_id).all()


@router.delete("/{source_id}")
def delete_m3u_source(source_id: int, db: Session = Depends(get_db)):
    """Delete M3U source and everything derived from it"""
    source = _get_m3u_source(db, source_id)

    db.query(SourceEntry).filter(SourceEntry.subscription_id == source_id).delete()
    db.query(SelectedCategory).filter(SelectedCategory.subscription_id == source_id).delete()
    db.query(SyncState).filter(SyncState.subscription_id == source_id).delete()

    # The generated library. This used to be a bare rmtree of output_dir, which
    # erases whatever else happens to live there — nothing stops two sources
    # from being pointed at the same folder, and the downloader writes real
    # media under its own. So a directory another source still claims is left
    # alone and reported instead of deleted.
    for directory in _own_directories(db, source):
        try:
            shutil.rmtree(directory)
            logger.info("Removed %s with source %s", directory, source.name)
        except Exception as e:
            logger.warning("Could not remove %s: %s", directory, e)

    # Delete uploaded file if exists
    if source.file_path and os.path.exists(source.file_path):
        os.remove(source.file_path)

    db.delete(source)
    db.commit()

    return {"message": "M3U source deleted successfully"}


@router.put("/{source_id}")
def update_m3u_source(
    source_id: int,
    updates: M3USourceCreate,
    db: Session = Depends(get_db)
):
    """Update M3U source"""
    source = _get_m3u_source(db, source_id)

    if updates.name and updates.name != source.name:
        _reject_duplicate_name(db, updates.name, exclude_id=source_id)
        source.name = updates.name

    if updates.url and source.source_type == M3USourceType.URL.value:
        source.url = updates.url

    if updates.movies_dir:
        source.movies_dir = updates.movies_dir
    if updates.series_dir:
        source.series_dir = updates.series_dir

    db.commit()
    db.refresh(source)

    return source
