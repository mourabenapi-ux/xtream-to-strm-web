"""Group selection for an M3U source.

A `group-title` is an M3U's only notion of a category, so these groups are
stored as ordinary `selected_categories` rows — the very same table the Xtream
category selection writes to, with the group title standing in for the category
id. That is what lets one sync read one selection whatever the source is.

The routes keep their shape so the existing screen still fits them.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List
from app.db.session import get_db
from app.models.selection import SelectedCategory
from app.models.source_entry import EntryType, SourceEntry
from app.models.subscription import SourceKind, Subscription
from app.services.catalog import get_catalog
from app.tasks.sync import sync_movies_task, sync_series_task
from pydantic import BaseModel

router = APIRouter()

# The three types a group can hold. "movie" and "series" drive the .strm
# writing; "live" is what the playlists and the organiser read.
_TYPES = (EntryType.MOVIE, EntryType.SERIES, EntryType.LIVE)


# Schemas
class GroupInfo(BaseModel):
    group_title: str
    entry_type: str
    count: int
    selected: bool

class GroupSelectionItem(BaseModel):
    group_title: str
    entry_type: str
    count: int = 0
    selected: bool = False

class GroupSelectionRequest(BaseModel):
    groups: List[GroupSelectionItem]


def _get_source(db: Session, source_id: int) -> Subscription:
    source = db.query(Subscription).filter(
        Subscription.id == source_id,
        Subscription.kind == SourceKind.M3U.value,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="M3U source not found")
    return source


def _selected_keys(db: Session, source_id: int):
    return {
        (sel.category_id, sel.type)
        for sel in db.query(SelectedCategory).filter(
            SelectedCategory.subscription_id == source_id
        ).all()
    }


@router.get("/{source_id}/groups", response_model=List[GroupInfo])
def get_m3u_groups(source_id: int, db: Session = Depends(get_db)):
    """Every group the playlist holds, with what is currently ticked.

    The playlist is parsed on demand if it has never been read: the screen that
    calls this is the one where the first selection is made, and asking the user
    to run a sync before they are allowed to choose anything is how the old
    screen came up empty.
    """
    source = _get_source(db, source_id)

    entries = db.query(SourceEntry).filter(
        SourceEntry.subscription_id == source_id
    ).all()

    if not entries:
        try:
            get_catalog(db, source).ensure_parsed()
        except Exception as e:
            raise HTTPException(status_code=502,
                                detail=f"Could not read the playlist: {e}")
        entries = db.query(SourceEntry).filter(
            SourceEntry.subscription_id == source_id
        ).all()

    selected_set = _selected_keys(db, source_id)

    groups_dict = {}
    for entry in entries:
        group = entry.group_title or "Uncategorized"
        key = (group, entry.entry_type)

        if key not in groups_dict:
            groups_dict[key] = {
                "group_title": group,
                "entry_type": entry.entry_type,
                "count": 0,
                "selected": key in selected_set,
            }
        groups_dict[key]["count"] += 1

    return sorted(groups_dict.values(),
                  key=lambda g: (g["entry_type"], g["group_title"].lower()))


@router.get("/{source_id}/selected", response_model=List[GroupInfo])
def get_selected_groups(source_id: int, db: Session = Depends(get_db)):
    """Get only selected groups for M3U source"""
    _get_source(db, source_id)

    selections = db.query(SelectedCategory).filter(
        SelectedCategory.subscription_id == source_id
    ).all()

    result = []
    for sel in selections:
        count = db.query(SourceEntry).filter(
            SourceEntry.subscription_id == source_id,
            SourceEntry.group_title == sel.category_id,
            SourceEntry.entry_type == sel.type,
        ).count()

        result.append({
            "group_title": sel.category_id,
            "entry_type": sel.type,
            "count": count,
            "selected": True,
        })

    return result


@router.post("/{source_id}")
def save_group_selection(
    source_id: int,
    request: GroupSelectionRequest,
    selection_type: str = None,  # Optional: "movie", "series" or "live"
    db: Session = Depends(get_db)
):
    """Save selected groups for M3U source.

    An empty list is a deliberate "I want nothing of this type" — the sync then
    removes what it had generated — so it is saved as such rather than ignored.
    """
    _get_source(db, source_id)

    query = db.query(SelectedCategory).filter(
        SelectedCategory.subscription_id == source_id
    )

    if selection_type:
        if selection_type not in _TYPES:
            raise HTTPException(status_code=400,
                                detail=f"Invalid selection_type: {selection_type}")
        query = query.filter(SelectedCategory.type == selection_type)

    # Clear existing selections in scope
    query.delete()

    saved = 0
    for group_data in request.groups:
        if selection_type and group_data.entry_type != selection_type:
            continue  # Not in the scope this call is replacing.
        if group_data.entry_type not in _TYPES:
            continue

        db.add(SelectedCategory(
            subscription_id=source_id,
            category_id=group_data.group_title,
            name=group_data.group_title,
            type=group_data.entry_type,
        ))
        saved += 1

    db.commit()

    return {"message": f"Saved {saved} group selections"}


class SyncRequest(BaseModel):
    sync_types: List[str] = None  # ["movies", "series"] or None for all

@router.post("/{source_id}/sync")
def sync_m3u_groups(
    source_id: int,
    request: SyncRequest = None,
    db: Session = Depends(get_db)
):
    """Re-read the playlist and rewrite what the selection asks for."""
    source = _get_source(db, source_id)

    wanted = set(request.sync_types) if (request and request.sync_types) \
        else {"movies", "series"}

    task_ids = {}
    if "movies" in wanted:
        task_ids["movies"] = sync_movies_task.delay(source.id).id
    if "series" in wanted:
        task_ids["series"] = sync_series_task.delay(source.id).id

    return {"message": "Group sync started",
            "task_id": next(iter(task_ids.values()), None),
            "task_ids": task_ids}
