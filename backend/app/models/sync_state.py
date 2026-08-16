from sqlalchemy import Column, String, Integer, DateTime, Enum
import enum
from datetime import datetime
from app.db.base_class import Base

class SyncStatus(str, enum.Enum):
    IDLE = "idle"
    RUNNING = "running"
    SUCCESS = "success"
    # Some items could not be written while others were. Reporting these as
    # SUCCESS is how a sync that produced nothing at all still showed green.
    PARTIAL = "partial"
    FAILED = "failed"

class SyncType(str, enum.Enum):
    MOVIES = "movies"
    SERIES = "series"

class SyncState(Base):
    __tablename__ = "sync_state"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, nullable=False, index=True)
    type = Column(String, nullable=False)  # movies or series
    last_sync = Column(DateTime, nullable=True)
    status = Column(String, nullable=False, default=SyncStatus.IDLE)
    items_added = Column(Integer, nullable=False, default=0)
    items_deleted = Column(Integer, nullable=False, default=0)
    error_message = Column(String, nullable=True)
    task_id = Column(String, nullable=True)  # Celery task ID for cancellation
    # Fingerprint of the naming/folder rules the files on disk were written with.
    # When it no longer matches the current settings, every cached item is
    # rebuilt once — otherwise a settings change never reaches the library.
    layout_signature = Column(String, nullable=True)
