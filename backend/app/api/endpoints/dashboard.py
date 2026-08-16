from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Dict, List, Any
from app.db.session import get_db
from app.models.subscription import Subscription
from app.models.m3u_source import M3USource
from app.models.m3u_entry import M3UEntry, EntryType
from app.models.sync_state import SyncState, SyncStatus
from app.models.schedule import Schedule
from app.models.cache import MovieCache, SeriesCache
from datetime import datetime, timedelta
import logging
import shutil
import os
from app.core.config import settings
from app.core.celery_app import celery_app
from app.core.redis import get_redis
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel
from app.models.epg import EPGSourceGlobal, PlaylistEPGSource
from app.models.downloads import DownloadTask, DownloadStatus

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/stats")
def get_dashboard_stats(db: Session = Depends(get_db)) -> Dict[str, Any]:
    """Get overall dashboard statistics"""
    
    # Source statistics
    xtream_total = db.query(Subscription).count()
    xtream_active = db.query(Subscription).filter(Subscription.is_active == True).count()
    
    m3u_total = db.query(M3USource).count()
    m3u_active = db.query(M3USource).filter(M3USource.is_active == True).count()
    
    # Content statistics from M3U entries
    m3u_movies = db.query(M3UEntry).filter(M3UEntry.entry_type == EntryType.MOVIE).count()
    m3u_series = db.query(M3UEntry).filter(M3UEntry.entry_type == EntryType.SERIES).count()
    
    # Content statistics from Xtream Cache
    xtream_movies = db.query(MovieCache).count()
    xtream_series = db.query(SeriesCache).count()
    
    movies_count = m3u_movies + xtream_movies
    series_count = m3u_series + xtream_series
    
    # Sync status
    recent_syncs = db.query(SyncState).order_by(
        SyncState.last_sync.desc()
    ).limit(5).all()
    
    # In-progress syncs. The status strings must come from SyncStatus: this
    # filtered on "syncing"/"error", which the model never writes, so both
    # KPIs were permanently zero however busy or broken the app was.
    syncing = db.query(SyncState).filter(
        SyncState.status == SyncStatus.RUNNING
    ).count()

    # Error count (last 24h). PARTIAL counts too — a run where half the items
    # failed to write is not a state the dashboard should render as healthy.
    yesterday = datetime.now() - timedelta(days=1)
    errors_24h = db.query(SyncState).filter(
        SyncState.status.in_([SyncStatus.FAILED, SyncStatus.PARTIAL]),
        SyncState.last_sync >= yesterday
    ).count()
    
    # Success rate (last 30 days)
    thirty_days_ago = datetime.now() - timedelta(days=30)
    total_syncs = db.query(SyncState).filter(
        SyncState.last_sync >= thirty_days_ago
    ).count()
    successful_syncs = db.query(SyncState).filter(
        SyncState.status == "success",
        SyncState.last_sync >= thirty_days_ago
    ).count()
    
    success_rate = (successful_syncs / total_syncs * 100) if total_syncs > 0 else 0
    
    # Live TV statistics
    live_playlists_count = db.query(LivePlaylist).count()
    epg_sources_count = db.query(EPGSourceGlobal).count()
    
    # Active downloads
    active_downloads = db.query(DownloadTask).filter(
        DownloadTask.status == DownloadStatus.DOWNLOADING
    ).count()
    
    # System Health
    # 1. Disk Usage
    disk_path = settings.OUTPUT_DIR if hasattr(settings, 'OUTPUT_DIR') else "/"
    if not os.path.exists(disk_path):
        disk_path = "/"
    
    total, used, free = shutil.disk_usage(disk_path)
    disk_usage_pct = round((used / total) * 100, 1)
    
    # 2. Redis Status
    redis_status = "offline"
    try:
        redis_client = get_redis()
        if redis_client.ping():
            redis_status = "online"
    except:
        pass
        
    # 3. Celery Status
    celery_active = 0
    try:
        inspect = celery_app.control.inspect()
        active = inspect.active()
        if active:
            celery_active = len(active)
    except:
        pass

    return {
        "sources": {
            "total": xtream_total + m3u_total,
            "xtream": xtream_total,
            "m3u": m3u_total,
            "active": xtream_active + m3u_active,
            "inactive": (xtream_total - xtream_active) + (m3u_total - m3u_active)
        },
        "total_content": {
            "movies": movies_count,
            "series": series_count,
            "total": movies_count + series_count,
            "live_playlists": live_playlists_count,
            "epg_sources": epg_sources_count
        },
        "sync_status": {
            "in_progress": syncing,
            "errors_24h": errors_24h,
            "success_rate": round(success_rate, 1),
            "active_downloads": active_downloads
        },
        "system_health": {
            "disk": {
                "total_gb": round(total / (1024**3), 1),
                "used_gb": round(used / (1024**3), 1),
                "free_gb": round(free / (1024**3), 1),
                "usage_pct": disk_usage_pct
            },
            "redis": redis_status,
            "celery_workers": celery_active
        }
    }


@router.get("/recent-activity")
def get_recent_activity(
    limit: int = 10,
    db: Session = Depends(get_db)
) -> List[Dict[str, Any]]:
    """Get recent sync activity"""
    
    recent_syncs = db.query(SyncState).order_by(
        SyncState.last_sync.desc()
    ).limit(limit).all()
    
    activity = []
    for sync in recent_syncs:
        # Determine source name and type
        source_name = "Unknown"
        source_type = "unknown"
        
        # The column is `type`; `sync_type` does not exist on SyncState and
        # raised AttributeError here, taking the whole endpoint down.
        if sync.type in ("movies", "series"):
            # XtreamTV sync
            sub = db.query(Subscription).filter(
                Subscription.id == sync.subscription_id
            ).first()
            if sub:
                source_name = sub.name
                source_type = "xtream"
        
        # Calculate duration if we have both start and update times
        duration = None
        if sync.last_sync and sync.last_sync:
            # Estimate duration (this is approximate)
            duration = 0  # We don't track start time currently
        
        activity.append({
            "id": sync.id,
            "source_name": source_name,
            "source_type": source_type,
            "sync_type": sync.type,
            "status": sync.status,
            "items_processed": (sync.items_added or 0) + (sync.items_deleted or 0),
            "timestamp": sync.last_sync.isoformat() if sync.last_sync else None,
            "duration": duration,
            # Shown for partial runs too — that is precisely when the message
            # explains which items failed. Gating on "error" hid it always,
            # since the model writes "failed".
            "error_message": sync.error_message
        })
    
    return activity


@router.get("/scheduled-syncs")
def get_scheduled_syncs(db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    """Get upcoming scheduled syncs"""
    
    # The column is `enabled`; `Schedule.is_active` does not exist and made
    # this endpoint a guaranteed 500. Same family as the `sync_type` slips
    # above — the dashboard was written against field names the models never had.
    schedules = db.query(Schedule).filter(
        Schedule.enabled == True
    ).all()
    
    scheduled = []
    for schedule in schedules:
        # Get source name
        source_name = "Unknown"
        source_type = "unknown"
        
        if schedule.subscription_id:
            sub = db.query(Subscription).filter(
                Subscription.id == schedule.subscription_id
            ).first()
            if sub:
                source_name = sub.name
                source_type = "xtream"
        
        # Use the schedule's own next_run rather than recomputing it: this
        # branch only knew hourly/daily/weekly, so five_minutes, six_hours and
        # twelve_hours schedules always reported "no next run".
        next_run = schedule.next_run
        if next_run is None and schedule.last_run:
            next_run = schedule.calculate_next_run()

        scheduled.append({
            "id": schedule.id,
            "source_name": source_name,
            "source_type": source_type,
            # `sync_type` does not exist on Schedule either — the column is `type`.
            "sync_type": schedule.type,
            "frequency": schedule.frequency,
            "next_run": next_run.isoformat() if next_run else None,
            "last_run": schedule.last_run.isoformat() if schedule.last_run else None
        })
    
    return scheduled


@router.get("/content-by-source")
def get_content_by_source(db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    """Get content breakdown by source"""
    
    result = []
    
    # XtreamTV sources
    subscriptions = db.query(Subscription).all()
    for sub in subscriptions:
        # Count from Cache
        movies_count = db.query(MovieCache).filter(
            MovieCache.subscription_id == sub.id
        ).count()
        
        series_count = db.query(SeriesCache).filter(
            SeriesCache.subscription_id == sub.id
        ).count()
        
        result.append({
            "source_name": sub.name,
            "source_type": "xtream",
            "movies": movies_count,
            "series": series_count,
            "total": movies_count + series_count
        })
    
    # M3U sources
    m3u_sources = db.query(M3USource).all()
    for source in m3u_sources:
        movies = db.query(M3UEntry).filter(
            M3UEntry.m3u_source_id == source.id,
            M3UEntry.entry_type == EntryType.MOVIE
        ).count()
        
        series = db.query(M3UEntry).filter(
            M3UEntry.m3u_source_id == source.id,
            M3UEntry.entry_type == EntryType.SERIES
        ).count()
        
        result.append({
            "source_name": source.name,
            "source_type": "m3u",
            "movies": movies,
            "series": series,
            "total": movies + series
        })
    
    return result
@router.get("/live-playlists-detail")
def get_live_playlists_detail(db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    """Get detailed information for all live playlists for the dashboard"""
    playlists = db.query(LivePlaylist).all()
    result = []
    
    for pl in playlists:
        total_channels = 0
        mapped_channels = 0
        for b in pl.bouquets:
            for ch in b.channels:
                total_channels += 1
                if ch.epg_channel_id:
                    mapped_channels += 1
        
        coverage = round((mapped_channels / total_channels * 100), 1) if total_channels > 0 else 0
        
        result.append({
            "id": pl.id,
            "name": pl.name,
            "description": pl.description,
            "channel_count": total_channels,
            "epg_coverage": coverage,
            "epg_sources_count": len(pl.epg_source_links),
            "m3u_url": f"/api/v1/live/playlist.m3u?playlist_id={pl.id}",
            "epg_url": f"/api/v1/live/playlist.xml?playlist_id={pl.id}"
        })
    
    return result


@router.get("/active-tasks")
def get_active_tasks(db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    """Get currently running tasks (sync, downloads)"""
    tasks = []
    
    # 1. Sync tasks
    syncing = db.query(SyncState).filter(SyncState.status == SyncStatus.RUNNING).all()
    for s in syncing:
        tasks.append({
            "id": f"sync_{s.id}",
            "type": "sync",
            "name": f"Sync {s.type}",
            "progress": 0, # We don't have fine-grained progress for sync yet
            "status": "running"
        })
        
    # 2. Download tasks
    downloads = db.query(DownloadTask).filter(
        DownloadTask.status == DownloadStatus.DOWNLOADING
    ).all()
    for d in downloads:
        tasks.append({
            "id": f"download_{d.id}",
            "type": "download",
            "name": d.title,
            "progress": d.progress,
            "speed_kbps": d.current_speed_kbps,
            "eta_seconds": d.estimated_time_remaining,
            "status": "running"
        })
        
    return tasks
