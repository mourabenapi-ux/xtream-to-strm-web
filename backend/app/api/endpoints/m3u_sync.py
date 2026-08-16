from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import List
from app.db.session import get_db
from app.models.m3u_sync_state import M3USyncState
from app.schemas import M3USyncStatusResponse, SyncTriggerResponse
from app.tasks.m3u_sync import sync_m3u_source_task

router = APIRouter()

@router.get("/status", response_model=List[M3USyncStatusResponse])
def get_sync_status(db: Session = Depends(get_db)):
    states = db.query(M3USyncState).all()
    return [
        M3USyncStatusResponse(
            id=state.id,
            m3u_source_id=state.m3u_source_id,
            type=state.type,
            status=state.status,
            last_sync=state.last_sync,
            items_added=state.items_added,
            items_deleted=state.items_deleted,
            error_message=state.error_message
        ) for state in states
    ]

@router.post("/movies/{source_id}", response_model=SyncTriggerResponse)
def trigger_movie_sync(source_id: int, db: Session = Depends(get_db)):
    task = sync_m3u_source_task.delay(source_id, sync_types=['movies'])
    # Save task_id to sync_state
    sync_state = db.query(M3USyncState).filter(
        M3USyncState.m3u_source_id == source_id,
        M3USyncState.type == "movies"
    ).first()
    
    if not sync_state:
        sync_state = M3USyncState(m3u_source_id=source_id, type="movies")
        db.add(sync_state)
        db.commit()
        db.refresh(sync_state)
        
    sync_state.task_id = task.id
    sync_state.status = "running"
    db.commit()
    return SyncTriggerResponse(message="Movie sync started", task_id=task.id)

@router.post("/series/{source_id}", response_model=SyncTriggerResponse)
def trigger_series_sync(source_id: int, db: Session = Depends(get_db)):
    task = sync_m3u_source_task.delay(source_id, sync_types=['series'])
    # Save task_id to sync_state
    sync_state = db.query(M3USyncState).filter(
        M3USyncState.m3u_source_id == source_id,
        M3USyncState.type == "series"
    ).first()
    
    if not sync_state:
        sync_state = M3USyncState(m3u_source_id=source_id, type="series")
        db.add(sync_state)
        db.commit()
        db.refresh(sync_state)

    sync_state.task_id = task.id
    sync_state.status = "running"
    db.commit()
    return SyncTriggerResponse(message="Series sync started", task_id=task.id)

@router.post("/stop/{source_id}/{sync_type}")
def stop_sync(source_id: int, sync_type: str, db: Session = Depends(get_db)):
    """Stop a running sync task"""
    from app.core.celery_app import celery_app
    
    sync_state = db.query(M3USyncState).filter(
        M3USyncState.m3u_source_id == source_id,
        M3USyncState.type == sync_type
    ).first()
    
    if not sync_state or not sync_state.task_id:
        return {"message": "No running task found"}
    
    # Revoke the task
    celery_app.control.revoke(sync_state.task_id, terminate=True)
    
    # Update status
    sync_state.status = "idle"
    sync_state.task_id = None
    db.commit()
    
    return {"message": f"{sync_type.capitalize()} sync stopped successfully"}
