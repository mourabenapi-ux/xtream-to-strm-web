from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List
from app.api import deps
from app.models.downloads import DownloadTask, DownloadStatus, DownloadSettings, MonitoredMedia, DownloadSettingsGlobal, DownloadStatistics
from app.models.subscription import Subscription
from app.services.catalog import get_catalog
from app.tasks.downloads import download_media_task, process_download_queue, check_auto_downloads
from app import schemas
import asyncio
from datetime import datetime

router = APIRouter()

@router.get("/tasks", response_model=List[dict])
def get_download_tasks(
    db: Session = Depends(deps.get_db),
    status: str = None,
    media_type: str = None,
    q: str = None,
):
    """Get download tasks with filtering and search"""
    query = db.query(DownloadTask)
    if status:
        query = query.filter(DownloadTask.status == status)
    if media_type:
        query = query.filter(DownloadTask.media_type == media_type)
    if q:
        query = query.filter(DownloadTask.title.ilike(f"%{q}%"))
    
    # Sort by priority then creation date
    tasks = query.order_by(
        DownloadTask.priority.desc(),
        DownloadTask.created_at.desc()
    ).all()
    
    return [
        {
            "id": t.id,
            "title": t.title,
            "media_type": t.media_type,
            "status": t.status,
            "progress": t.progress,
            "file_size": t.file_size,
            "downloaded_bytes": t.downloaded_bytes,
            "save_path": t.save_path,
            "error_message": t.error_message,
            "created_at": t.created_at,
            "started_at": t.started_at,
            "completed_at": t.completed_at,
            "priority": t.priority,
            "retry_count": t.retry_count,
            "next_retry_at": t.next_retry_at,
            "current_speed_kbps": t.current_speed_kbps,
            "estimated_time_remaining": t.estimated_time_remaining,
        }
        for t in tasks
    ]

async def resolve_container_extension(
    db: Session,
    xc,
    subscription_id: int,
    media_type: str,
    media_id: int | str,
) -> str:
    """Resolve the real container extension for a media item.

    Providers reject a stream URL built with the wrong extension (HTTP 551),
    so this must never be guessed. Falls back to mp4 when unknown.
    """
    from app.models.cache import MovieCache, EpisodeCache

    if media_type == "movie":
        cached = db.query(MovieCache).filter(
            MovieCache.subscription_id == subscription_id,
            MovieCache.stream_id == int(media_id)
        ).first()
        if cached and cached.container_extension:
            return cached.container_extension

        # Not in cache: look it up in the provider listing (Redis-cached)
        try:
            movies = await xc.get_vod_streams()
            media = next((m for m in movies if str(m.get('stream_id')) == str(media_id)), None)
            if media and media.get('container_extension'):
                return media['container_extension']
        except Exception:
            pass
    else:
        cached = db.query(EpisodeCache).filter(
            EpisodeCache.subscription_id == subscription_id,
            EpisodeCache.id == int(media_id)
        ).first()
        if cached and cached.container_extension:
            return cached.container_extension

    return "mp4"

@router.post("/queue")
async def queue_download(
    subscription_id: int,
    media_type: str,
    media_id: int | str,
    title: str = None,
    trigger_queue: bool = True,
    container_extension: str = None,
    db: Session = Depends(deps.get_db),
):
    """Queue a media item for download"""
    # Get subscription
    subscription = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if not subscription:
        raise HTTPException(status_code=404, detail="Subscription not found")
    
    # Get settings for naming
    from app.models.settings import SettingsModel
    settings_dict = {s.key: s.value for s in db.query(SettingsModel).all()}
    prefix_regex = settings_dict.get("PREFIX_REGEX")
    format_date = settings_dict.get("FORMAT_DATE_IN_TITLE") == "true"
    clean_name = settings_dict.get("CLEAN_NAME") == "true"
    
    from app.services.file_manager import FileManager
    fm = FileManager("") # Output dir doesn't matter for clean_title
    
    # Read the item from whichever kind of source it came from
    xc = get_catalog(db, subscription)

    # The provider returns HTTP 551 on a wrong extension, so resolve the real one
    ext = container_extension or await resolve_container_extension(
        db, xc, subscription_id, media_type, media_id
    )

    if title:
        # If title is provided directly (e.g. from frontend), use it
        # Still resolve URL if not provided (though we don't have url param yet)
        url = xc.get_stream_url(media_type if media_type == "movie" else "series", str(media_id), ext)
    elif media_type == "movie":
        from app.models.cache import MovieCache
        movie_cache = db.query(MovieCache).filter(MovieCache.subscription_id == subscription_id, MovieCache.stream_id == int(media_id)).first()
        
        raw_title = f"Movie_{media_id}"
        if movie_cache:
            raw_title = movie_cache.name
        else:
            movies = await xc.get_vod_streams()
            media = next((m for m in movies if m['stream_id'] == str(media_id) or m['stream_id'] == int(media_id)), None)
            if media:
                raw_title = media.get('name', raw_title)
        
        # Apply naming rules
        title = fm.clean_title(raw_title, prefix_regex, format_date, clean_name)
        url = xc.get_stream_url("movie", str(media_id), ext)

    elif media_type == "episode":
        from app.models.cache import EpisodeCache, SeriesCache
        episode_cache = db.query(EpisodeCache).filter(EpisodeCache.subscription_id == subscription_id, EpisodeCache.id == int(media_id)).first()
        
        series_name = "Unknown Series"
        ep_info = f"S??E??"
        ep_title = ""
        
        if episode_cache:
            series_cache = db.query(SeriesCache).filter(SeriesCache.subscription_id == subscription_id, SeriesCache.series_id == episode_cache.series_id).first()
            if series_cache:
                series_name = fm.clean_title(series_cache.name, prefix_regex, format_date, clean_name)
            
            ep_info = f"S{episode_cache.season_num:02d}E{episode_cache.episode_num:02d}"
            ep_title = episode_cache.title or ""
            if ep_title:
                # Remove extension if present
                if ep_title.lower().endswith(".mp4"):
                    ep_title = ep_title[:-4]
                ep_title = f" - {ep_title}"
        
        title = f"{series_name} - {ep_info}{ep_title}"
        url = xc.get_stream_url("series", str(media_id), ext)

    else:
        raise HTTPException(status_code=400, detail="Invalid media_type")
    
    # Check if already in queue or downloaded
    existing = db.query(DownloadTask).filter(
        DownloadTask.subscription_id == subscription_id,
        DownloadTask.media_id == int(media_id),
        DownloadTask.media_type == media_type
    ).first()
    
    if existing and existing.status in [DownloadStatus.PENDING, DownloadStatus.DOWNLOADING, DownloadStatus.COMPLETED]:
        return {"id": existing.id, "title": existing.title, "status": existing.status, "message": "Already in list"}
    
    # Create download task
    download = DownloadTask(
        subscription_id=subscription_id,
        media_type=media_type,
        media_id=int(media_id),
        title=title,
        url=url,
        status=DownloadStatus.PENDING,
    )
    db.add(download)
    db.commit()
    db.refresh(download)
    
    # Trigger queue processor
    if trigger_queue:
        process_download_queue.delay()
    
    return {"id": download.id, "title": title, "status": download.status}

@router.post("/queue/bulk")
async def queue_bulk_download(
    data: schemas.DownloadBulkQueueCreate,
    db: Session = Depends(deps.get_db),
):
    """Queue multiple media items for download"""
    created_tasks = []
    
    # Pre-fetch subscription for series expansion or optimization
    subscription = db.query(Subscription).filter(Subscription.id == data.subscription_id).first()
    if not subscription:
        raise HTTPException(status_code=404, detail="Subscription not found")
        
    xc = None
    if data.media_type == "series":
        xc = get_catalog(db, subscription)
    
    for i, media_id in enumerate(data.media_ids):
        title = data.titles[i] if data.titles and i < len(data.titles) else None
        extension = (
            data.container_extensions[i]
            if data.container_extensions and i < len(data.container_extensions)
            else None
        )
        try:
            if data.media_type == "series":
                # Expand series into episodes (Expansion uses its own title generation)
                if not xc:
                    xc = get_catalog(db, subscription)
                
                try:
                    series_info = await xc.get_series_info(str(media_id))
                    info = series_info.get('info', {})
                    series_name_raw = info.get('name', info.get('title', str(media_id)))
                    episodes_map = series_info.get('episodes', {})

                    # Get rules for cleaning
                    from app.models.settings import SettingsModel
                    settings_dict = {s.key: s.value for s in db.query(SettingsModel).all()}
                    prefix_regex = settings_dict.get("PREFIX_REGEX")
                    format_date = settings_dict.get("FORMAT_DATE_IN_TITLE") == "true"
                    clean_name = settings_dict.get("CLEAN_NAME") == "true"
                    
                    from app.services.file_manager import FileManager
                    fm = FileManager("")
                    series_name = fm.clean_title(series_name_raw, prefix_regex, format_date, clean_name)
                    
                    series_tasks = []
                    for season_key, season_episodes in episodes_map.items():
                        for ep in season_episodes:
                            ep_id = ep.get('id')
                            if ep_id:
                                try:
                                    # Build explicit title
                                    season_num = int(season_key) if str(season_key).isdigit() else 0
                                    ep_num = int(ep.get('episode_num', 0)) if str(ep.get('episode_num')).isdigit() else 0
                                    ep_info = f"S{season_num:02d}E{ep_num:02d}"
                                    
                                    ep_title = ep.get('title', '')
                                    if ep_title:
                                        if ep_title.lower().endswith(".mp4"):
                                            ep_title = ep_title[:-4]
                                        ep_title = f" - {ep_title}"
                                    
                                    title_ep = f"{series_name} - {ep_info}{ep_title}"
                                    
                                    # Queue each episode (trigger_queue=False for bulk)
                                    # The episode payload already carries the real container
                                    result = await queue_download(
                                        data.subscription_id, "episode", ep_id,
                                        title=title_ep, trigger_queue=False,
                                        container_extension=ep.get('container_extension'),
                                        db=db,
                                    )
                                    series_tasks.append(result)
                                except Exception as e:
                                    series_tasks.append({"media_id": ep_id, "error": str(e)})
                    
                    created_tasks.extend(series_tasks)
                    
                except Exception as e:
                     created_tasks.append({"media_id": media_id, "error": f"Failed to expand series: {str(e)}"})
            else:
                # Regular download (movie or single episode)
                result = await queue_download(
                    data.subscription_id, data.media_type, media_id,
                    title=title, trigger_queue=False,
                    container_extension=extension, db=db,
                )
                created_tasks.append(result)
                
        except Exception as e:
            created_tasks.append({"media_id": media_id, "error": str(e)})
    
    # Trigger queue processor ONCE at the end
    process_download_queue.delay()
    
    return {"queued": len(created_tasks), "tasks": created_tasks}

@router.delete("/tasks/{task_id}")
def cancel_download(
    task_id: int,
    db: Session = Depends(deps.get_db),
):
    """Cancel or delete a download task"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.status == DownloadStatus.DOWNLOADING:
        if task.task_id:
            from app.core.celery_app import celery_app
            celery_app.control.revoke(task.task_id, terminate=True)
        task.status = DownloadStatus.CANCELLED
        db.commit()
    else:
        db.delete(task)
        db.commit()
    
    return {"message": "Task cancelled/deleted"}

@router.post("/tasks/{task_id}/retry")
def retry_download(
    task_id: int,
    db: Session = Depends(deps.get_db),
):
    """Retry a failed or cancelled download"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task.status = DownloadStatus.PENDING
    task.error_message = None
    task.retry_count = 0
    task.next_retry_at = None
    db.commit()
    
    process_download_queue.delay()
    return {"message": "Task reset to pending"}

@router.post("/tasks/{task_id}/pause")
def pause_download(
    task_id: int,
    db: Session = Depends(deps.get_db),
):
    """Pause a downloading task"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.status == DownloadStatus.DOWNLOADING:
        task.status = DownloadStatus.PAUSED
        task.paused_at = datetime.now()
        db.commit()
        return {"message": "Task paused"}
    
    raise HTTPException(status_code=400, detail="Only downloading tasks can be paused")

@router.post("/tasks/{task_id}/resume")
def resume_download(
    task_id: int,
    db: Session = Depends(deps.get_db),
):
    """Resume a paused task"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    if task.status == DownloadStatus.PAUSED:
        task.status = DownloadStatus.PENDING
        db.commit()
        process_download_queue.delay()
        return {"message": "Task resumed"}
    
    raise HTTPException(status_code=400, detail="Only paused tasks can be resumed")

@router.put("/tasks/{task_id}/priority")
def update_priority(
    task_id: int,
    priority: int,
    db: Session = Depends(deps.get_db),
):
    """Update task priority manual value"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task.priority = priority
    db.commit()
    return {"message": "Priority updated", "priority": task.priority}

@router.post("/tasks/{task_id}/move-up")
def move_up_priority(
    task_id: int,
    db: Session = Depends(deps.get_db),
):
    """Increase task priority"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task.priority = (task.priority or 0) + 1
    db.commit()
    return {"message": "Priority increased", "priority": task.priority}

@router.post("/tasks/{task_id}/move-down")
def move_down_priority(
    task_id: int,
    db: Session = Depends(deps.get_db),
):
    """Decrease task priority"""
    task = db.query(DownloadTask).filter(DownloadTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task.priority = max(0, (task.priority or 0) - 1)
    db.commit()
    return {"message": "Priority decreased", "priority": task.priority}

# Batch Operations
@router.post("/tasks/batch/delete")
def batch_delete_tasks(task_ids: List[int], db: Session = Depends(deps.get_db)):
    db.query(DownloadTask).filter(DownloadTask.id.in_(task_ids)).delete(synchronize_session=False)
    db.commit()
    return {"message": f"Deleted {len(task_ids)} tasks"}

@router.post("/tasks/batch/retry")
def batch_retry_tasks(task_ids: List[int], db: Session = Depends(deps.get_db)):
    db.query(DownloadTask).filter(DownloadTask.id.in_(task_ids)).update(
        {"status": DownloadStatus.PENDING, "error_message": None, "retry_count": 0, "next_retry_at": None},
        synchronize_session=False
    )
    db.commit()
    process_download_queue.delay()
    return {"message": f"Retrying {len(task_ids)} tasks"}

@router.post("/tasks/batch/pause")
def batch_pause_tasks(task_ids: List[int], db: Session = Depends(deps.get_db)):
    db.query(DownloadTask).filter(
        DownloadTask.id.in_(task_ids),
        DownloadTask.status == DownloadStatus.DOWNLOADING
    ).update({"status": DownloadStatus.PAUSED, "paused_at": datetime.now()}, synchronize_session=False)
    db.commit()
    return {"message": f"Paused tasks"}

@router.post("/tasks/batch/resume")
def batch_resume_tasks(task_ids: List[int], db: Session = Depends(deps.get_db)):
    db.query(DownloadTask).filter(
        DownloadTask.id.in_(task_ids),
        DownloadTask.status == DownloadStatus.PAUSED
    ).update({"status": DownloadStatus.PENDING}, synchronize_session=False)
    db.commit()
    process_download_queue.delay()
    return {"message": f"Resumed tasks"}

@router.get("/monitored")
def get_monitored_media(db: Session = Depends(deps.get_db)):
    """Get all monitored media items"""
    items = db.query(MonitoredMedia).all()
    return items

@router.post("/monitored")
def add_monitored_media(
    item: schemas.MonitoredMediaCreate,
    db: Session = Depends(deps.get_db),
):
    """Add a category or series to monitored list"""
    existing = db.query(MonitoredMedia).filter(
        MonitoredMedia.subscription_id == item.subscription_id,
        MonitoredMedia.media_id == item.media_id,
        MonitoredMedia.media_type == item.media_type
    ).first()
    
    if existing:
        existing.is_active = True
        db.commit()
        return existing
    
    new_item = MonitoredMedia(
        subscription_id=item.subscription_id,
        media_type=item.media_type,
        media_id=item.media_id,
        title=item.title
    )
    db.add(new_item)
    db.commit()
    db.refresh(new_item)
    return new_item

@router.put("/monitored/{item_id}")
def update_monitored_media(
    item_id: int,
    update: schemas.MonitoredMediaUpdate,
    db: Session = Depends(deps.get_db),
):
    """Pause or resume a watch without destroying it.

    is_active was already stored and honoured by the check task, but nothing
    could set it back to False, so pausing a watch meant deleting it.
    """
    item = db.query(MonitoredMedia).filter(MonitoredMedia.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    if update.is_active is not None:
        item.is_active = update.is_active

    db.commit()
    db.refresh(item)
    return item

@router.delete("/monitored/{item_id}")
def remove_monitored_media(item_id: int, db: Session = Depends(deps.get_db)):
    """Remove an item from monitored list"""
    item = db.query(MonitoredMedia).filter(MonitoredMedia.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    
    db.delete(item)
    db.commit()
    return {"message": "Success"}

@router.post("/monitored/check")
def trigger_monitoring_check():
    """Manually trigger the monitoring check"""
    check_auto_downloads.delay()
    return {"message": "Monitoring check triggered"}

# Global Settings
@router.get("/settings", response_model=schemas.DownloadSettingsGlobalResponse)
def get_global_settings_endpoint(db: Session = Depends(deps.get_db)):
    settings = db.query(DownloadSettingsGlobal).first()
    if not settings:
        settings = DownloadSettingsGlobal()
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings

@router.put("/settings", response_model=schemas.DownloadSettingsGlobalResponse)
def update_global_settings(
    settings_in: schemas.DownloadSettingsGlobalUpdate,
    db: Session = Depends(deps.get_db)
):
    settings = db.query(DownloadSettingsGlobal).first()
    if not settings:
        settings = DownloadSettingsGlobal()
        db.add(settings)
    
    update_data = settings_in.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(settings, field, value)
    
    db.commit()
    db.refresh(settings)
    return settings

# Statistics
@router.get("/stats", response_model=List[schemas.DownloadStatisticsResponse])
def get_download_statistics(
    days: int = 7,
    db: Session = Depends(deps.get_db)
):
    return db.query(DownloadStatistics).order_by(
        DownloadStatistics.date.desc()
    ).limit(days).all()


@router.get("/browse/{subscription_id}")
async def browse_media(
    subscription_id: int,
    media_type: str,
    cat_id: str = None,
    q: str = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: Session = Depends(deps.get_db),
):
    """Browse available media from a subscription for downloading.

    Catalogues reach six figures, so nothing is ever returned wholesale:
      - no cat_id and no q -> the category index only (name + item count)
      - cat_id and/or q    -> one page of matching items
    """
    subscription = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if not subscription:
        raise HTTPException(status_code=404, detail="Subscription not found")

    xc = get_catalog(db, subscription)

    if media_type == "movies":
        categories = await xc.get_vod_categories()
        entries = await xc.get_vod_streams()
        id_key, cover_key = "stream_id", "stream_icon"
    elif media_type == "series":
        categories = await xc.get_series_categories()
        entries = await xc.get_series()
        id_key, cover_key = "series_id", "cover"
    else:
        raise HTTPException(status_code=400, detail="Invalid media_type")

    cat_map = {str(c['category_id']): c['category_name'] for c in categories}

    # Category index: small payload, always the first thing the UI asks for
    if not cat_id and not q:
        counts = {}
        for entry in entries:
            counts[str(entry.get('category_id'))] = counts.get(str(entry.get('category_id')), 0) + 1

        index = [
            {"cat_id": cid, "name": cat_map.get(cid, "Uncategorized"), "count": count}
            for cid, count in counts.items()
        ]
        index.sort(key=lambda c: c["name"].lower())
        return {"categories": index, "total_items": len(entries)}

    # Item page
    matching = entries
    if cat_id:
        matching = [e for e in matching if str(e.get('category_id')) == str(cat_id)]
    if q:
        needle = q.lower()
        matching = [e for e in matching if needle in (e.get('name') or '').lower()]

    total = len(matching)
    start = (page - 1) * page_size
    page_entries = matching[start:start + page_size]

    return {
        "items": [
            {
                "id": e[id_key],
                "name": e.get('name', ''),
                "cover": e.get(cover_key, ''),
                "cat_id": str(e.get('category_id')),
                "cat_name": cat_map.get(str(e.get('category_id')), 'Uncategorized'),
                "container_extension": e.get('container_extension'),
            }
            for e in page_entries
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size,
    }

@router.get("/browse/{subscription_id}/series/{series_id}")
async def get_series_details(
    subscription_id: int,
    series_id: str,
    db: Session = Depends(deps.get_db),
):
    """Get detailed info for a specific series including seasons and episodes"""
    subscription = db.query(Subscription).filter(Subscription.id == subscription_id).first()
    if not subscription:
        raise HTTPException(status_code=404, detail="Subscription not found")
    
    xc = get_catalog(db, subscription)
    
    try:
        data = await xc.get_series_info(series_id)
        # Xtream API usually returns { "seasons": [...], "episodes": { "1": [...], "2": [...] } }
        # We want to format this nicely for the frontend
        
        episodes_map = data.get('episodes', {})
        seasons = []
        
        # Sort season numbers
        sorted_season_nums = sorted([int(k) for k in episodes_map.keys()])
        
        for season_num in sorted_season_nums:
            season_episodes = episodes_map.get(str(season_num), [])
            formatted_episodes = []
            for ep in season_episodes:
                formatted_episodes.append({
                    "id": ep.get('id'),
                    "episode_num": ep.get('episode_num'),
                    "title": ep.get('title'),
                    "container_extension": ep.get('container_extension', 'mp4'),
                    "duration": ep.get('duration')
                })
            
            # Sort episodes by number
            formatted_episodes.sort(key=lambda x: int(x['episode_num']) if str(x['episode_num']).isdigit() else 0)
            
            seasons.append({
                "season_number": season_num,
                "episodes": formatted_episodes
            })
            
        return {
            "info": data.get('info', {}),
            "seasons": seasons
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch series info: {str(e)}")
