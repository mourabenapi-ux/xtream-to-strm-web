"""Sync status and triggers for an M3U source.

These read and write the one `sync_state` table, so an M3U source now reports
partial runs, progress and errors exactly like an Xtream subscription does. The
routes are unchanged so the existing screen keeps working; the response still
calls the source `m3u_source_id`, which is now the source's own id.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List
from app.db.session import get_db
from app.models.subscription import SourceKind, Subscription
from app.models.sync_state import SyncState
from app.schemas import M3USyncStatusResponse, SyncTriggerResponse
from app.tasks.sync import sync_movies_task, sync_series_task

router = APIRouter()


def _sync_state(db: Session, source_id: int, sync_type: str) -> SyncState:
    state = db.query(SyncState).filter(
        SyncState.subscription_id == source_id,
        SyncState.type == sync_type
    ).first()

    if not state:
        state = SyncState(subscription_id=source_id, type=sync_type)
        db.add(state)
        db.commit()
        db.refresh(state)

    return state


@router.get("/status", response_model=List[M3USyncStatusResponse])
def get_sync_status(db: Session = Depends(get_db)):
    m3u_ids = [s.id for s in db.query(Subscription.id).filter(
        Subscription.kind == SourceKind.M3U.value
    ).all()]

    states = db.query(SyncState).filter(
        SyncState.subscription_id.in_(m3u_ids)
    ).all() if m3u_ids else []

    return [
        M3USyncStatusResponse(
            id=state.id,
            m3u_source_id=state.subscription_id,
            type=state.type,
            status=state.status,
            last_sync=state.last_sync,
            items_added=state.items_added,
            items_deleted=state.items_deleted,
            error_message=state.error_message,
            progress_done=state.progress_done or 0,
            progress_total=state.progress_total or 0,
            progress_phase=state.progress_phase,
        ) for state in states
    ]

@router.post("/movies/{source_id}", response_model=SyncTriggerResponse)
def trigger_movie_sync(source_id: int, db: Session = Depends(get_db)):
    task = sync_movies_task.delay(source_id)
    sync_state = _sync_state(db, source_id, "movies")
    sync_state.task_id = task.id
    sync_state.status = "running"
    db.commit()
    return SyncTriggerResponse(message="Movie sync started", task_id=task.id)

@router.post("/series/{source_id}", response_model=SyncTriggerResponse)
def trigger_series_sync(source_id: int, db: Session = Depends(get_db)):
    task = sync_series_task.delay(source_id)
    sync_state = _sync_state(db, source_id, "series")
    sync_state.task_id = task.id
    sync_state.status = "running"
    db.commit()
    return SyncTriggerResponse(message="Series sync started", task_id=task.id)

@router.post("/stop/{source_id}/{sync_type}")
def stop_sync(source_id: int, sync_type: str, db: Session = Depends(get_db)):
    """Stop a running sync task"""
    from app.core.celery_app import celery_app

    sync_state = db.query(SyncState).filter(
        SyncState.subscription_id == source_id,
        SyncState.type == sync_type
    ).first()

    if not sync_state or not sync_state.task_id:
        return {"message": "No running task found"}

    # Revoke the task
    celery_app.control.revoke(sync_state.task_id, terminate=True)

    # Update status. The killed worker never clears its own counters, so a
    # stopped sync would otherwise stay frozen at whatever bar it reached.
    sync_state.status = "idle"
    sync_state.task_id = None
    sync_state.progress_phase = None
    sync_state.progress_done = 0
    sync_state.progress_total = 0
    db.commit()

    return {"message": f"{sync_type.capitalize()} sync stopped successfully"}
