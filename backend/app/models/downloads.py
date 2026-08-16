from sqlalchemy import Column, String, Integer, DateTime, Enum, Float, Boolean
import enum
from datetime import datetime
from app.db.base_class import Base

class DownloadStatus(str, enum.Enum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    CANCELLED = "cancelled"

class MediaType(str, enum.Enum):
    MOVIE = "movie"
    EPISODE = "episode"

class DownloadTask(Base):
    __tablename__ = "download_tasks"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, nullable=False, index=True)
    media_type = Column(String, nullable=False)  # movie or episode
    media_id = Column(Integer, nullable=False)  # ID from Xtream API
    title = Column(String, nullable=False)
    url = Column(String, nullable=False)
    save_path = Column(String, nullable=True)  # Final file path
    
    status = Column(String, nullable=False, default=DownloadStatus.PENDING)
    progress = Column(Float, nullable=False, default=0.0)  # 0.0 to 100.0
    file_size = Column(Integer, nullable=True)  # Total bytes
    downloaded_bytes = Column(Integer, nullable=False, default=0)
    
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    
    error_message = Column(String, nullable=True)
    task_id = Column(String, nullable=True)  # Celery task ID for cancellation
    priority = Column(Integer, nullable=False, default=0)  # Higher = more priority

    # Retry management
    retry_count = Column(Integer, default=0)
    max_retries = Column(Integer, default=3)
    next_retry_at = Column(DateTime, nullable=True)
    retry_delay_seconds = Column(Integer, default=60)

    # Pause/Resume
    paused_at = Column(DateTime, nullable=True)
    resume_token = Column(String, nullable=True)

    # Bandwidth & Speed
    speed_limit_kbps = Column(Integer, nullable=True)
    current_speed_kbps = Column(Float, default=0)
    estimated_time_remaining = Column(Integer, nullable=True)

    # Scheduling
    scheduled_start_at = Column(DateTime, nullable=True)
    scheduled_end_at = Column(DateTime, nullable=True)

    # Metadata
    file_hash = Column(String, nullable=True)
    thumbnail_url = Column(String, nullable=True)

class MonitoredMedia(Base):
    __tablename__ = "monitored_media"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, nullable=False, index=True)
    media_type = Column(String, nullable=False)  # "category_movie", "category_series", "series"
    media_id = Column(String, nullable=False)  # Category ID or Series ID
    title = Column(String, nullable=False)
    
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    last_check = Column(DateTime, nullable=True)

class DownloadSettings(Base):
    __tablename__ = "download_settings"
    
    id = Column(Integer, primary_key=True)
    key = Column(String, unique=True, nullable=False)
    value = Column(String, nullable=False)

class DownloadSettingsGlobal(Base):
    __tablename__ = "download_settings_global"
    
    id = Column(Integer, primary_key=True)
    
    # Bandwidth
    global_speed_limit_kbps = Column(Integer, default=1024)  # 1mb/s = 1024 kb/s
    per_download_speed_limit_kbps = Column(Integer, nullable=True)
    
    # Scheduling
    quiet_hours_enabled = Column(Boolean, default=True)
    quiet_hours_start = Column(String, default="00:00")
    quiet_hours_end = Column(String, default="08:00")
    pause_during_quiet_hours = Column(Boolean, default=True)
    
    # Download modes
    download_mode = Column(String, default="parallel")  # parallel, sequential, intelligent
    
    # Retry
    default_max_retries = Column(Integer, default=3)
    retry_delay_base_seconds = Column(Integer, default=60)
    retry_delay_multiplier = Column(Float, default=2.0)
    
    # Connection settings
    max_redirects = Column(Integer, default=10)  # Maximum HTTP redirects to follow
    connection_timeout_seconds = Column(Integer, default=30)  # Connection timeout
    
    # History
    keep_completed_days = Column(Integer, default=30)
    keep_failed_days = Column(Integer, default=7)
    
    # Auto-cleanup
    auto_cleanup_enabled = Column(Boolean, default=True)
    
    # Network
    user_agent = Column(String, nullable=True, default="TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)")
    
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

class DownloadStatistics(Base):
    __tablename__ = "download_statistics"
    
    id = Column(Integer, primary_key=True)
    date = Column(String, nullable=False, unique=True)  # YYYY-MM-DD
    
    total_downloads = Column(Integer, default=0)
    completed_downloads = Column(Integer, default=0)
    failed_downloads = Column(Integer, default=0)
    cancelled_downloads = Column(Integer, default=0)
    
    total_bytes_downloaded = Column(Float, default=0) # Float to avoid overflow
    average_speed_kbps = Column(Float, default=0)
    
    created_at = Column(DateTime, default=datetime.now)
