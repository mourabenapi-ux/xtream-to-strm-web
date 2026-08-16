from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from app.api import deps
from app.db.session import SessionLocal
from app.models.schedule import Schedule, SyncType, Frequency
from app.models.schedule_execution import ScheduleExecution, ExecutionStatus
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

router = APIRouter()

# Schemas
class ScheduleConfig(BaseModel):
    type: SyncType
    enabled: bool
    frequency: Frequency
    last_run: Optional[datetime] = None
    next_run: Optional[datetime] = None
    
    class Config:
        from_attributes = True

class ScheduleUpdate(BaseModel):
    enabled: bool
    frequency: Frequency

class ExecutionHistoryItem(BaseModel):
    id: int
    schedule_id: int
    started_at: datetime
    completed_at: Optional[datetime]
    status: ExecutionStatus
    items_processed: int
    error_message: Optional[str]
    
    class Config:
        from_attributes = True

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/config/{subscription_id}", response_model=List[ScheduleConfig])
async def get_schedule_config(
    subscription_id: int,
    db: Session = Depends(get_db)
):
    """Get all schedule configurations for a subscription"""
    schedules = db.query(Schedule).filter(Schedule.subscription_id == subscription_id).all()
    
    # Ensure we have entries for both types
    if not schedules:
        # Create default schedules for this subscription
        for sync_type in [SyncType.MOVIES, SyncType.SERIES]:
            schedule = Schedule(
                subscription_id=subscription_id,
                type=sync_type,
                enabled=False,
                frequency=Frequency.DAILY
            )
            db.add(schedule)
        db.commit()
        schedules = db.query(Schedule).filter(Schedule.subscription_id == subscription_id).all()
    
    return schedules

@router.put("/config/{subscription_id}/{sync_type}", response_model=ScheduleConfig)
async def update_schedule_config(
    subscription_id: int,
    sync_type: SyncType,
    update: ScheduleUpdate,
    db: Session = Depends(get_db)
):
    """Update schedule configuration for a specific sync type and subscription"""
    schedule = db.query(Schedule).filter(
        Schedule.subscription_id == subscription_id,
        Schedule.type == sync_type
    ).first()
    
    if not schedule:
        # Create if doesn't exist
        schedule = Schedule(
            subscription_id=subscription_id,
            type=sync_type
        )
        db.add(schedule)
    
    schedule.enabled = update.enabled
    schedule.frequency = update.frequency
    
    # Calculate next run if enabled
    if update.enabled:
        schedule.next_run = schedule.calculate_next_run()
    else:
        schedule.next_run = None
    
    db.commit()
    db.refresh(schedule)
    
    return schedule

@router.get("/history/{subscription_id}", response_model=List[ExecutionHistoryItem])
async def get_execution_history(
    subscription_id: int,
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    sync_type: Optional[SyncType] = None,
    db: Session = Depends(get_db)
):
    """Get execution history for a subscription with optional filtering by sync type"""
    query = db.query(ScheduleExecution).join(Schedule).filter(
        Schedule.subscription_id == subscription_id
    )
    
    if sync_type:
        query = query.filter(Schedule.type == sync_type)
    
    executions = query.order_by(ScheduleExecution.started_at.desc()).offset(offset).limit(limit).all()
    
    return executions
