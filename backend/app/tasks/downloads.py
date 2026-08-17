import os
import httpx
import logging
import time
import asyncio
import subprocess
import shlex
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

from app.core.celery_app import celery_app
from app.core.redis import redis_conn
from app.db.session import SessionLocal
from app.models.downloads import (
    DownloadTask, DownloadStatus, DownloadSettings, 
    MonitoredMedia, DownloadSettingsGlobal, DownloadStatistics
)
from app.models.subscription import Subscription
from app.models.cache import MovieCache, SeriesCache, EpisodeCache
from app.models.settings import SettingsModel
from app.services.catalog import get_catalog
from app.services.file_manager import FileManager
from app.services.tmdb_overrides import resolve_one

logger = logging.getLogger(__name__)

# Constants
CHUNK_SIZE = 64 * 1024  # 64KB for better throttling control
DB_REFRESH_INTERVAL = 5.0  # Refresh DB once every 5 seconds during download
HEARTBEAT_TTL = 120  # seconds a worker heartbeat stays valid in Redis
FFMPEG_MIN_COMPLETENESS = 0.90  # remuxing changes the size slightly, so allow some slack


class IncompleteDownloadError(Exception):
    """Fewer bytes arrived than the provider announced.

    Raised instead of reporting success so the task retries and resumes from the
    partial file, rather than archiving a truncated media file as complete.
    """


class WrongContainerExtension(Exception):
    """The provider serves this title in another container than the URL asked for.

    The task's URL has already been corrected when this is raised; the caller
    only has to resolve the target path again so the file is named after the
    container it really is.
    """

    def __init__(self, extension: str):
        super().__init__(f"provider serves this title as .{extension}")
        self.extension = extension

# --- Heartbeat ---
# A task stuck in DOWNLOADING means nothing on its own: the worker may be alive and
# streaming, or it may have died with the container. The heartbeat tells them apart,
# so we never requeue a live download (which would corrupt the file by writing it
# twice) and never leave a dead one blocking the queue.

def _heartbeat_key(download_id: int) -> str:
    return f"download:heartbeat:{download_id}"

def _beat(download_id: int):
    """Mark this download as still being worked on."""
    try:
        redis_conn.setex(_heartbeat_key(download_id), HEARTBEAT_TTL, "1")
    except Exception as e:
        logger.warning(f"Could not write heartbeat for {download_id}: {e}")

def _clear_heartbeat(download_id: int):
    try:
        redis_conn.delete(_heartbeat_key(download_id))
    except Exception:
        pass

def _another_download_is_live(db: Session, download_id: int) -> bool:
    """Is some other download actually streaming right now?

    Only a heartbeat counts: a row left in DOWNLOADING by a worker that died must
    not block the queue, which is exactly what `_recover_stalled_downloads` sorts
    out on its own schedule.
    """
    others = db.query(DownloadTask.id).filter(
        DownloadTask.status == DownloadStatus.DOWNLOADING,
        DownloadTask.id != download_id,
    ).all()
    for (other_id,) in others:
        try:
            if redis_conn.exists(_heartbeat_key(other_id)):
                return True
        except Exception:
            # Redis unreachable: assume it is live rather than open a second connection
            return True
    return False


def _recover_stalled_downloads(db: Session) -> int:
    """Requeue downloads whose worker is gone. Live downloads are left alone."""
    recovered = 0
    stuck = db.query(DownloadTask).filter(DownloadTask.status == DownloadStatus.DOWNLOADING).all()
    for task in stuck:
        try:
            alive = redis_conn.exists(_heartbeat_key(task.id))
        except Exception:
            # Redis unreachable: assume the worker is alive rather than risk a duplicate
            continue
        if alive:
            continue
        task.status = DownloadStatus.PENDING
        task.error_message = "Recovery: worker stopped, task requeued"
        recovered += 1

    if recovered:
        db.commit()
        logger.info(f"Recovered {recovered} stalled download(s)")
    return recovered

# --- Helper Functions ---

def get_global_settings(db: Session):
    settings = db.query(DownloadSettingsGlobal).first()
    if not settings:
        settings = DownloadSettingsGlobal()
        db.add(settings)
        db.commit()
        db.refresh(settings)
    return settings

def update_daily_stats(db: Session, success=True, bytes_downloaded=0.0):
    today = datetime.now().strftime("%Y-%m-%d")
    stats = db.query(DownloadStatistics).filter(DownloadStatistics.date == today).first()
    if not stats:
        stats = DownloadStatistics(date=today)
        db.add(stats)
    
    stats.total_downloads = (stats.total_downloads or 0) + 1
    if success:
        stats.completed_downloads = (stats.completed_downloads or 0) + 1
        stats.total_bytes_downloaded = (stats.total_bytes_downloaded or 0) + bytes_downloaded
    else:
        stats.failed_downloads = (stats.failed_downloads or 0) + 1
    
    db.commit()

def is_quiet_hours(settings: DownloadSettingsGlobal):
    if not settings.quiet_hours_start or not settings.quiet_hours_end:
        return False
    
    now = datetime.now().time()
    try:
        start = datetime.strptime(settings.quiet_hours_start, "%H:%M").time()
        end = datetime.strptime(settings.quiet_hours_end, "%H:%M").time()
    except:
        return False
    
    if start <= end:
        return start <= now <= end
    else: # Over midnight
        return now >= start or now <= end

def cleanup_old_tasks(db: Session, settings: DownloadSettingsGlobal):
    """Delete old completed/failed tasks based on retention settings"""
    if not settings.auto_cleanup_enabled:
        return
    
    # Completed tasks
    completed_limit = datetime.now() - timedelta(days=settings.keep_completed_days or 7)
    db.query(DownloadTask).filter(
        DownloadTask.status == DownloadStatus.COMPLETED,
        DownloadTask.completed_at < completed_limit
    ).delete()
    
    # Failed tasks
    failed_limit = datetime.now() - timedelta(days=settings.keep_failed_days or 7)
    db.query(DownloadTask).filter(
        DownloadTask.status == DownloadStatus.FAILED,
        DownloadTask.created_at < failed_limit
    ).delete()
    
    db.commit()

def _extension_from_url(url: str, default: str = ".mp4") -> str:
    """Extension the file will actually be served with, taken from the stream URL."""
    suffix = Path(urlparse(url).path).suffix
    return suffix if suffix else default


# Containers these providers actually serve, most common first. Anything else
# answers HTTP 551, which is what makes the probe below cheap and unambiguous.
CONTAINER_CANDIDATES = ("mkv", "mp4", "avi", "ts", "m4v")


def _url_with_extension(url: str, extension: str) -> str:
    parsed = urlparse(url)
    stem = parsed.path.rsplit(".", 1)[0] if Path(parsed.path).suffix else parsed.path
    return parsed._replace(path=f"{stem}.{extension}").geturl()


def _probe_container_extension(client: httpx.Client, url: str) -> Optional[str]:
    """Ask the provider which container it will actually serve for this stream.

    Episodes are queued from the catalogue listing, which does not always carry a
    container, and nothing falls back to the provider — so the URL was built with
    a guessed `.mp4` and the provider answered 551 on every attempt. One byte per
    candidate is enough to find the real one.
    """
    current = _extension_from_url(url).lstrip(".").lower()
    for extension in CONTAINER_CANDIDATES:
        if extension == current:
            continue
        try:
            with client.stream(
                "GET", _url_with_extension(url, extension), headers={"Range": "bytes=0-1"}
            ) as response:
                if response.status_code < 400:
                    return extension
        except Exception as e:
            logger.debug(f"Container probe .{extension} failed: {e}")
    return None


def _probe_total_size(client: httpx.Client, url: str) -> Optional[int]:
    """Total size of the remote file, from a one-byte ranged GET.

    HEAD is not trustworthy on these CDNs — it answers without a length, or with
    a wrong one — and believing it used to truncate an already finished file and
    start the whole download again.
    """
    try:
        with client.stream("GET", url, headers={"Range": "bytes=0-0"}) as response:
            content_range = response.headers.get("content-range", "")
            if "/" in content_range:
                total = content_range.rsplit("/", 1)[-1]
                if total.isdigit():
                    return int(total)
            if response.status_code == 200 and "content-length" in response.headers:
                return int(response.headers["content-length"])
    except Exception as e:
        logger.warning(f"Could not probe the size of {url}: {e}")
    return None


def _adopt_previous_partial(download: DownloadTask, save_path: Path) -> None:
    """Move the bytes an earlier attempt wrote to where this attempt will write.

    The target path is rebuilt from provider metadata on every attempt, and those
    lookups can fail on one attempt and succeed on the next — a category that
    resolves to "Uncategorized" once and to its real name later sends the retry
    to a different folder. The partial file was then never found, so the download
    restarted from zero every time and could never finish.
    """
    previous = Path(download.save_path) if download.save_path else None
    if not previous or previous == save_path or not previous.is_file():
        return

    try:
        save_path.parent.mkdir(parents=True, exist_ok=True)
        if save_path.is_file():
            # Both attempts left a file: the longer one is the one worth resuming.
            if save_path.stat().st_size >= previous.stat().st_size:
                previous.unlink()
                return
            save_path.unlink()
        previous.replace(save_path)
        logger.info(f"Resuming download {download.id} from {previous} at {save_path}")
    except OSError as e:
        logger.warning(f"Could not carry over the partial file for {download.id}: {e}")


# Where downloads land when a subscription does not name a directory of its own.
_DOWNLOAD_ROOTS = {"movie": "/output/downloads/movies", "episode": "/output/downloads/series"}


def _download_base_dir(db: Session, subscription: Subscription, media_type: str) -> str:
    """Download root for this subscription and media type.

    Every subscription used to fall back to the *same* directory, so two
    providers that both carry a title wrote it to one path and the second
    download silently replaced the first. Each subscription now gets its own
    subfolder, which also keeps the two Jellyfin libraries separable.

    A directory configured for this subscription alone is honoured as-is. One
    that another subscription also points at is *not*: that is the collision,
    whether it was typed in or inherited from the old defaults — which is the
    live case here, both subscriptions carry an explicit
    "/output/downloads/movies". Sharing gets the per-subscription subfolder
    too, so no title can be overwritten by the other provider's copy.
    """
    column = "download_movies_dir" if media_type == "movie" else "download_series_dir"
    explicit = getattr(subscription, column, None)

    if explicit:
        shared_with = db.query(Subscription).filter(
            getattr(Subscription, column) == explicit,
            Subscription.id != subscription.id,
        ).count()
        if not shared_with:
            return explicit
        root = explicit
        logger.info(
            f"Download dir {explicit!r} is shared with {shared_with} other "
            f"subscription(s); using a per-subscription subfolder."
        )
    else:
        root = _DOWNLOAD_ROOTS.get(media_type, _DOWNLOAD_ROOTS["episode"])

    own = FileManager("").sanitize_name(subscription.name or "").strip()
    return os.path.join(root, own or f"subscription-{subscription.id}")


def _write_sidecar_nfo(path: Path, content: Optional[str]) -> None:
    """Write a downloaded file's NFO next to it.

    The .strm library has always produced NFOs; downloads never did, so the
    same title was richly described in one Jellyfin library and bare in the
    other. A failure here must not fail the download — the media file is the
    deliverable, the NFO is metadata.
    """
    if not content:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    except Exception as e:
        logger.warning(f"Could not write NFO {path}: {e}")

def _resolve_target_path(db: Session, download: DownloadTask, subscription: Subscription, app_settings: Dict[str, Any]) -> Dict[str, Any]:
    """Determine final save path, create directories, and build the NFO sidecars.

    Returns `{"path": Path, "sidecars": [(Path, content), ...]}`. The NFOs are
    built here rather than after the download because this is where the
    provider metadata is already in hand; rebuilding it later would mean a
    second round of API calls for data we just discarded.
    """
    prefix_regex = app_settings.get("PREFIX_REGEX")
    format_date = app_settings.get("FORMAT_DATE_IN_TITLE") == "true"
    clean_name = app_settings.get("CLEAN_NAME") == "true"
    use_season_folders = app_settings.get("SERIES_USE_SEASON_FOLDERS", "true") == "true"
    include_series_name = app_settings.get("SERIES_INCLUDE_NAME_IN_FILENAME", "false") == "true"
    # Movies and series have separate settings, and both must be read: using the
    # series flag for a movie — or letting the movie call fall through to the
    # parameter default of True — laid the downloads out under a category folder
    # while the .strm library was flat, so the same title landed in two shapes.
    movie_use_category_folders = app_settings.get("MOVIE_USE_CATEGORY_FOLDERS", "true") == "true"
    series_use_category_folders = app_settings.get("SERIES_USE_CATEGORY_FOLDERS", "true") == "true"

    base_dir = _download_base_dir(db, subscription, download.media_type)
    fm = FileManager(base_dir)
    cat_name = "Uncategorized"
    xc = get_catalog(db, subscription)

    if download.media_type == "movie":
        movie_cache = db.query(MovieCache).filter(
            MovieCache.subscription_id == download.subscription_id,
            MovieCache.stream_id == int(download.media_id)
        ).first()
        
        category_id = movie_cache.category_id if movie_cache else None
        movie_name = movie_cache.name if movie_cache else download.title
        tmdb_id = movie_cache.tmdb_id if movie_cache else None

        # Fallback to API if cache is missing or incomplete
        if not movie_cache:
            try:
                logger.info(f"Movie cache missing for ID {download.media_id}. Fetching from API.")
                movies = xc.get_vod_streams_sync()
                media = next((m for m in movies if str(m['stream_id']) == str(download.media_id)), None)
                if media:
                    movie_name = media.get('name', movie_name)
                    category_id = media.get('category_id')
                    tmdb_id = media.get('tmdb')
            except Exception as e:
                logger.warning(f"Failed to fetch movie info from API: {e}")
        
        movie_name = movie_name.strip().strip('-').strip()

        if category_id:
            try:
                categories = xc.get_vod_categories_sync()
                cat_map = {str(c['category_id']): c['category_name'] for c in categories}
                cat_name = cat_map.get(str(category_id), "Uncategorized")
            except Exception as e: 
                logger.warning(f"Failed to fetch VOD categories: {e}")
        
        movie_data = {
            "name": movie_name,
            "tmdb": tmdb_id
        }

        # The full VOD record, for the same NFO the .strm library gets. Best
        # effort: a provider hiccup costs metadata, never the download.
        try:
            detailed = xc.get_vod_info_sync(str(download.media_id))
            if isinstance(detailed, dict):
                info = FileManager._as_dict(detailed.get('info'))
                if info:
                    movie_data['info'] = info
                    if info.get('tmdb_id'):
                        movie_data['tmdb'] = info['tmdb_id']
        except Exception as e:
            logger.warning(f"Failed to fetch VOD info for NFO ({download.media_id}): {e}")

        # Last word on the id, after every provider source has had its say. The
        # downloaded file has to land in the same {tmdb-…} folder the .strm
        # library uses, or Jellyfin sees two different films.
        movie_data['tmdb'], _ = resolve_one(
            db, download.subscription_id, "movie", download.media_id,
            movie_name, movie_data.get('tmdb'))

        target_info = fm.get_movie_target_info(movie_data, cat_name, prefix_regex, format_date, clean_name, movie_use_category_folders)

        save_dir = Path(target_info["target_dir"])
        save_dir.mkdir(parents=True, exist_ok=True)
        save_path = save_dir / f"{target_info['filename_base']}{_extension_from_url(download.url)}"

        return {
            "path": save_path,
            "sidecars": [(
                save_dir / f"{target_info['filename_base']}.nfo",
                fm.generate_movie_nfo(movie_data, prefix_regex, format_date, clean_name),
            )],
        }

    else: # episode
        episode_cache = db.query(EpisodeCache).filter(
            EpisodeCache.subscription_id == download.subscription_id,
            EpisodeCache.id == int(download.media_id)
        ).first()
        
        series_cache = None
        series_id = None
        season_num = 1
        ep_num = 1
        ep_title = ""

        if episode_cache:
            series_id = episode_cache.series_id
            season_num = episode_cache.season_num
            ep_num = episode_cache.episode_num
            ep_title = episode_cache.title
            
            series_cache = db.query(SeriesCache).filter(
                SeriesCache.subscription_id == download.subscription_id,
                SeriesCache.series_id == series_id
            ).first()
        else:
            # If no episode cache, try to parse from title
            logger.info(f"DEBUG_PATH: Episode cache missing for ID {download.media_id}. Title: '{download.title}'")
            import re
            
            # Robust regex for series titles
            m = re.search(r'^(.*?)(?:\s+-\s*|\s+)S(\d+)E(\d+)(?:\s*[- ]+\s*(.*))?$', download.title, re.IGNORECASE)
            if not m:
                logger.info("DEBUG_PATH: Main regex failed. Trying fallback.")
                m = re.search(r'S(\d+)E(\d+)\s+(.*)$', download.title, re.IGNORECASE)
                if m:
                    season_num = int(m.group(1))
                    ep_num = int(m.group(2))
                    series_name = m.group(3).strip().strip('-').strip()
                    logger.info(f"DEBUG_PATH: Fallback match: s={season_num} e={ep_num} name='{series_name}'")
            else:
                series_name = m.group(1).strip().strip('-').strip()
                season_num = int(m.group(2))
                ep_num = int(m.group(3))
                ep_title = m.group(4).strip() if m.group(4) else ""
                logger.info(f"DEBUG_PATH: Main match: name='{series_name}' s={season_num} e={ep_num} title='{ep_title}'")
                
            if 'series_name' in locals() and series_name and series_name != "Unknown Series":
                # Try to find a series by this name in cache to get category
                series_cache = db.query(SeriesCache).filter(
                    SeriesCache.subscription_id == download.subscription_id,
                    SeriesCache.name.ilike(series_name)
                ).first()
                
                if series_cache:
                    series_name = series_cache.name
                    category_id = series_cache.category_id
                    tmdb_id = series_cache.tmdb_id
                    logger.info(f"DEBUG_PATH: Name lookup SUCCESS: series='{series_name}' cat_id={category_id}")
                else:
                    logger.info(f"DEBUG_PATH: Name lookup FAILED in cache for '{series_name}'. Trying API.")
                    try:
                        api_series = xc.get_series_sync()
                        # Case-insensitive match in API results
                        s_data = next((s for s in api_series if s.get('name', '').lower() == series_name.lower()), None)
                        if s_data:
                            series_name = s_data.get('name', series_name)
                            category_id = s_data.get('category_id')
                            tmdb_id = s_data.get('tmdb')
                            logger.info(f"DEBUG_PATH: API Name match SUCCESS: series='{series_name}' cat_id={category_id}")
                        else:
                            logger.info(f"DEBUG_PATH: API Name match FAILED for '{series_name}'")
                    except Exception as e:
                        logger.warning(f"DEBUG_PATH: API series fetch failed: {e}")

        # Basic defaults if not resolved
        if 'series_name' not in locals(): series_name = "Unknown Series"
        if 'category_id' not in locals(): category_id = None
        if 'tmdb_id' not in locals(): tmdb_id = None
        
        logger.info(f"DEBUG_PATH: Final resolved: name='{series_name}' cat_id={category_id} tmdb={tmdb_id}")

        if series_cache:
            series_name = series_cache.name
            category_id = series_cache.category_id
            tmdb_id = series_cache.tmdb_id
        elif not category_id:
            # Try to fetch series info from API if we have series_id
            if series_id:
                try:
                    logger.info(f"Series cache missing for ID {series_id}. Fetching from API.")
                    series_list = xc.get_series_sync()
                    s_data = next((s for s in series_list if str(s['series_id']) == str(series_id)), None)
                    if s_data:
                        series_name = s_data.get('name', series_name)
                        category_id = s_data.get('category_id')
                        tmdb_id = s_data.get('tmdb')
                except Exception as e:
                    logger.warning(f"Failed to fetch series info from API: {e}")

        if category_id:
            try:
                categories = xc.get_series_categories_sync()
                cat_map = {str(c['category_id']): c['category_name'] for c in categories}
                cat_name = cat_map.get(str(category_id), "Uncategorized")
            except Exception as e:
                logger.warning(f"Failed to fetch series categories: {e}")
        
        # See the movie branch: the correction wins, so the episode lands in the
        # same show folder the .strm library writes.
        tmdb_id, _ = resolve_one(db, download.subscription_id, "series",
                                 series_id, series_name, tmdb_id)

        series_data = {
            "name": series_name,
            "tmdb": tmdb_id
        }
        target_info = fm.get_series_target_info(series_data, cat_name, prefix_regex, format_date, clean_name, series_use_category_folders)
        
        series_dir = Path(target_info["series_dir"])
        series_dir.mkdir(parents=True, exist_ok=True)
        
        # Determine filename
        current_dir = series_dir / f"Season {season_num:02d}" if use_season_folders else series_dir
        current_dir.mkdir(parents=True, exist_ok=True)
        
        formatted_ep = f"S{season_num:02d}E{ep_num:02d}"
        safe_series_name = target_info["safe_series_name"]
        
        if ep_title:
            if ep_title.lower().endswith(".mp4"):
                ep_title = ep_title[:-4]
            # Same reduction the .strm library applies. Without it the two
            # Jellyfin libraries disagree on every episode name: the download
            # kept "AMZ - 007_ Road to a Million - S01E01 - EPISODE ONE" where
            # the .strm side had already trimmed it to "EPISODE ONE".
            ep_title = fm.clean_episode_title(
                ep_title,
                (series_name, target_info['cleaned_title'], safe_series_name),
                clean_name,
            )
            safe_ep_title = fm.sanitize_name(ep_title) if ep_title else ""
        else:
            safe_ep_title = ""

        if include_series_name:
            filename_base = f"{safe_series_name} - {formatted_ep}"
        else:
            filename_base = formatted_ep

        ep_ext = _extension_from_url(download.url)
        filename = f"{filename_base} - {safe_ep_title}{ep_ext}" if safe_ep_title else f"{filename_base}{ep_ext}"
        stem = filename[:-len(ep_ext)] if ep_ext else filename

        return {
            "path": current_dir / filename,
            "sidecars": [
                # tvshow.nfo identifies the series for Jellyfin; the episode
                # NFO carries its own title and numbering.
                (series_dir / "tvshow.nfo",
                 fm.generate_show_nfo(series_data, prefix_regex, format_date, clean_name)),
                (current_dir / f"{stem}.nfo",
                 fm.generate_episode_nfo({"title": ep_title}, series_name, season_num, ep_num)),
            ],
        }

def _perform_download_stream(db: Session, download: DownloadTask, save_path: Path, settings: DownloadSettingsGlobal):
    """Core download logic with retry support, throttling, and optimized DB refresh."""
    existing_size = save_path.stat().st_size if save_path.exists() else 0
    download.downloaded_bytes = existing_size
    db.commit()

    # Client configuration
    client_timeout = settings.connection_timeout_seconds or 30
    max_redirects = settings.max_redirects or 10
    limits = httpx.Limits(max_connections=10, max_keepalive_connections=5)
    
    # User-Agent from settings
    ua = "TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)"
    if settings.user_agent:
        ua = settings.user_agent

    with httpx.Client(limits=limits, follow_redirects=True, max_redirects=max_redirects, 
                      headers={"User-Agent": ua, "Icy-MetaData": "1", "Connection": "close"},
                      timeout=httpx.Timeout(client_timeout, read=None)) as client:
        
        container_probed = False

        while True:
            headers = {'Range': f'bytes={existing_size}-'} if existing_size > 0 else {}
            try:
                with client.stream("GET", download.url, headers=headers) as response:
                    response.raise_for_status()
                    
                    # Handle 200 vs 206
                    if response.status_code == 200 and existing_size > 0:
                        logger.warning(f"Server ignored Range for {download.id}. Restarting.")
                        existing_size = 0
                        download.downloaded_bytes = 0
                        mode = 'wb'
                    else:
                        mode = 'ab' if existing_size > 0 else 'wb'

                    # Extract file size
                    if 'content-length' in response.headers:
                        if response.status_code == 206:
                            content_range = response.headers.get('content-range', '')
                            if '/' in content_range:
                                total_str = content_range.split('/')[-1]
                                if total_str != '*':
                                    download.file_size = int(total_str)
                        else:
                            download.file_size = int(response.headers['content-length'])
                    db.commit()

                    # Download loop
                    start_time = time.time()
                    last_db_refresh = time.time()
                    bytes_sampled = 0
                    sample_start = time.time()
                    speed_limit = download.speed_limit_kbps or settings.global_speed_limit_kbps
                    # The running total lives here, not on the ORM object. It used to be
                    # accumulated on `download.downloaded_bytes`, and the pause check
                    # below called `db.refresh()`, which reloads the row and throws away
                    # every byte counted since the last commit. Half a megabyte lost
                    # every five seconds added up to ~90 MB over a 2.9 GB film, so a
                    # download that had in fact finished was declared truncated, and the
                    # retry started it over.
                    downloaded = existing_size
                    expected_total = download.file_size

                    with open(save_path, mode) as f:
                        for chunk in response.iter_bytes(chunk_size=CHUNK_SIZE):
                            # Check pause/cancel every 5s, reading only the status column
                            # so nothing else on the row is reloaded over our own counter.
                            now = time.time()
                            if now - last_db_refresh >= DB_REFRESH_INTERVAL:
                                state = db.query(DownloadTask.status).filter(
                                    DownloadTask.id == download.id
                                ).scalar()
                                if state in [DownloadStatus.PAUSED, DownloadStatus.CANCELLED]:
                                    logger.info(f"Download {download.id} {state}")
                                    download.downloaded_bytes = downloaded
                                    db.commit()
                                    return False # Interrupted
                                _beat(download.id)
                                last_db_refresh = now

                            f.write(chunk)
                            downloaded += len(chunk)
                            bytes_sampled += len(chunk)

                            # Throttling
                            if speed_limit > 0:
                                expected = (downloaded - existing_size) / (speed_limit * 1024)
                                elapsed = time.time() - start_time
                                if elapsed < expected:
                                    time.sleep(expected - elapsed)

                            # Statistics Update (Non-blocking)
                            sample_elapsed = now - sample_start
                            if sample_elapsed >= 1.0:
                                download.downloaded_bytes = downloaded
                                download.current_speed_kbps = (bytes_sampled / 1024) / sample_elapsed
                                if expected_total:
                                    download.progress = min((downloaded / expected_total) * 100, 99.9)
                                    if download.current_speed_kbps > 0:
                                        rem = (expected_total - downloaded) / 1024
                                        download.estimated_time_remaining = int(rem / download.current_speed_kbps)
                                bytes_sampled = 0
                                sample_start = now
                                db.commit()

                    # What is on disk is the only figure worth checking against: the
                    # byte loop also ends when the provider drops the connection, and
                    # without this a truncated file would be reported as complete.
                    on_disk = save_path.stat().st_size if save_path.exists() else downloaded
                    download.downloaded_bytes = on_disk
                    db.commit()

                    if expected_total and on_disk < expected_total:
                        raise IncompleteDownloadError(
                            f"stream ended at {on_disk:,}/{expected_total:,} bytes "
                            f"({expected_total - on_disk:,} missing)"
                        )

                    return True # Success

            except httpx.HTTPStatusError as e:
                # Special handling for common IPTV/CDN non-standard codes
                if e.response.status_code == 551:
                    # 551 is used by providers both for a saturated account and for a
                    # stream requested with the wrong container extension. Ask which
                    # container this title is really served in before giving up.
                    if not container_probed:
                        container_probed = True
                        better = _probe_container_extension(client, download.url)
                        if better:
                            logger.info(
                                f"Download {download.id}: provider refused "
                                f"'{_extension_from_url(download.url)}', serving .{better} instead"
                            )
                            download.url = _url_with_extension(download.url, better)
                            db.commit()
                            raise WrongContainerExtension(better) from e

                    raise Exception(
                        f"Provider refused the stream (HTTP 551) for "
                        f"'{_extension_from_url(download.url)}' - wrong container extension "
                        f"or connection limit reached"
                    ) from e

                if e.response.status_code == 416:
                    # Range not satisfiable: either the file is already whole, or the
                    # provider changed it under us. Never assume the second - throwing
                    # away a finished file and restarting is the worst possible guess.
                    total = _probe_total_size(client, download.url)
                    if total and existing_size >= total:
                        download.file_size = total
                        download.downloaded_bytes = existing_size
                        db.commit()
                        return True
                    raise Exception(
                        f"Provider rejected the resume at byte {existing_size:,} "
                        f"(HTTP 416, remote size {total or 'unknown'}). "
                        f"Delete the partial file to start over."
                    ) from e
                raise e
            except (httpx.NetworkError, httpx.TimeoutException) as e:
                logger.error(f"Network error for {download.id}: {e}")
                raise e

def _perform_download_ffmpeg(db: Session, download: DownloadTask, save_path: Path, settings: DownloadSettingsGlobal):
    """Fallback download using FFmpeg (subprocess)."""
    logger.info(f"Starting FFmpeg fallback for {download.id}")
    
    # Update status to indicate fallback
    download.error_message = "Using FFmpeg Engine..."
    db.commit()

    ua = "TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)"
    
    # Build command
    # -headers option allows setting custom HTTP headers
    cmd = [
        "ffmpeg",
        "-user_agent", ua,
        "-headers", "Icy-MetaData: 1\r\n",
        "-i", download.url,
        "-c", "copy",
        "-y", # Overwrite
        str(save_path)
    ]
    
    # FFmpeg can run for hours. It is polled rather than waited on, so the task keeps
    # emitting heartbeats and still honours pause/cancel while it runs.
    deadline = time.time() + 7200  # 2 hours max, for safety
    last_beat = 0.0

    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as err_out:
        process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=err_out, text=True)
        try:
            while True:
                returncode = process.poll()
                if returncode is not None:
                    break

                if time.time() > deadline:
                    raise Exception("FFmpeg download timed out (2h limit)")

                now = time.time()
                if now - last_beat >= DB_REFRESH_INTERVAL:
                    _beat(download.id)
                    db.refresh(download)
                    if download.status in [DownloadStatus.PAUSED, DownloadStatus.CANCELLED]:
                        logger.info(f"Download {download.id} {download.status} during FFmpeg")
                        return False
                    if save_path.exists():
                        download.downloaded_bytes = save_path.stat().st_size
                        db.commit()
                    last_beat = now

                time.sleep(1)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

        if returncode != 0:
            err_out.seek(0)
            stderr_tail = err_out.read()[-800:]
            logger.error(f"FFmpeg failed (code {returncode}): {stderr_tail}")
            raise Exception(f"FFmpeg process returned {returncode}")

    # A file_size announced by the provider is never overwritten: it is the only
    # reference we can check the result against.
    if save_path.exists():
        produced = save_path.stat().st_size
        download.downloaded_bytes = produced

        expected_total = download.file_size
        if expected_total:
            if produced < expected_total * FFMPEG_MIN_COMPLETENESS:
                raise IncompleteDownloadError(
                    f"FFmpeg produced {produced:,} bytes, expected about {expected_total:,}"
                )
        else:
            download.file_size = produced

    return True

def _process_auto_downloads_sync(db: Session):
    """Synchronous logic for auto-downloads"""
    monitored_items = db.query(MonitoredMedia).filter(MonitoredMedia.is_active == True).all()
    for item in monitored_items:
        subscription = db.query(Subscription).filter(Subscription.id == item.subscription_id).first()
        if not subscription: continue
        
        xc = get_catalog(db, subscription)
        existing_ids = {str(t.media_id) for t in db.query(DownloadTask.media_id)
                       .filter(DownloadTask.subscription_id == item.subscription_id).all()}
        
        # Get naming rules for title cleaning
        settings_dict = {s.key: s.value for s in db.query(SettingsModel).all()}
        prefix_regex = settings_dict.get("PREFIX_REGEX")
        format_date = settings_dict.get("FORMAT_DATE_IN_TITLE") == "true"
        clean_name = settings_dict.get("CLEAN_NAME") == "true"
        fm = FileManager("")

        new_tasks = 0
        if item.media_type == "category_movie":
            try:
                movies = xc.get_vod_streams_sync(category_id=item.media_id)
                for movie in movies:
                    sid = str(movie['stream_id'])
                    if sid not in existing_ids:
                        raw_title = movie.get('name', f'Movie_{sid}')
                        title = fm.clean_title(raw_title, prefix_regex, format_date, clean_name)
                        db.add(DownloadTask(
                            subscription_id=item.subscription_id, media_type="movie", media_id=int(sid),
                            title=title,
                            url=xc.get_stream_url("movie", sid, movie.get('container_extension', 'mp4')),
                            status=DownloadStatus.PENDING
                        ))
                        new_tasks += 1
                        existing_ids.add(sid)
            except: pass
        
        elif item.media_type == "series":
            try:
                series_info = xc.get_series_info_sync(series_id=item.media_id)
                episodes = series_info.get('episodes', {})
                series_name = fm.clean_title(item.title, prefix_regex, format_date, clean_name)
                
                for season, eps in episodes.items():
                    for ep in eps:
                        sid = str(ep['id'])
                        if sid not in existing_ids:
                            ep_info = f"S{int(season):02d}E{int(ep.get('episode_num', 0)):02d}"
                            ep_title = ep.get('title', '')
                            if ep_title:
                                # Remove extension if present
                                if ep_title.lower().endswith(".mp4"):
                                    ep_title = ep_title[:-4]
                                ep_title = f" - {ep_title}"
                            
                            title = f"{series_name} - {ep_info}{ep_title}"
                            db.add(DownloadTask(
                                subscription_id=item.subscription_id, media_type="episode", media_id=int(sid),
                                title=title,
                                url=xc.get_stream_url("series", sid, ep.get('container_extension', 'mp4')),
                                status=DownloadStatus.PENDING
                            ))
                            new_tasks += 1
                            existing_ids.add(sid)
            except: pass

        elif item.media_type == "category_series":
            try:
                series_list = xc.get_series_sync(category_id=item.media_id)
                for s in series_list:
                    series_id = str(s['series_id'])
                    s_name_raw = s.get('name', s.get('title', f"Series_{series_id}"))
                    series_name = fm.clean_title(s_name_raw, prefix_regex, format_date, clean_name)
                    
                    try:
                        series_info = xc.get_series_info_sync(series_id=series_id)
                        episodes = series_info.get('episodes', {})
                        
                        for season, eps in episodes.items():
                            for ep in eps:
                                ep_sid = str(ep['id'])
                                if ep_sid not in existing_ids:
                                    ep_info = f"S{int(season):02d}E{int(ep.get('episode_num', 0)):02d}"
                                    ep_title = ep.get('title', '')
                                    if ep_title:
                                        if ep_title.lower().endswith(".mp4"):
                                            ep_title = ep_title[:-4]
                                        ep_title = f" - {ep_title}"
                                    
                                    title = f"{series_name} - {ep_info}{ep_title}"
                                    db.add(DownloadTask(
                                        subscription_id=item.subscription_id, media_type="episode", media_id=int(ep_sid),
                                        title=title,
                                        url=xc.get_stream_url("series", ep_sid, ep.get('container_extension', 'mp4')),
                                        status=DownloadStatus.PENDING
                                    ))
                                    new_tasks += 1
                                    existing_ids.add(ep_sid)
                    except:
                        continue
            except: pass
        
        item.last_check = datetime.now()
        db.commit()
        if new_tasks > 0:
            logger.info(f"Auto-download: Queued {new_tasks} items for {item.title}")

    if db.query(DownloadTask).filter(DownloadTask.status == DownloadStatus.PENDING).count() > 0:
        process_download_queue.delay()

# --- Celery Tasks ---

@celery_app.task(bind=True)
def download_media_task(self, download_id: int):
    """Modularized download task."""
    db = SessionLocal()
    try:
        download = db.query(DownloadTask).filter(DownloadTask.id == download_id).first()
        if not download or download.status in [DownloadStatus.COMPLETED, DownloadStatus.CANCELLED]:
            return
        
        settings = get_global_settings(db)
        subscription = db.query(Subscription).filter(Subscription.id == download.subscription_id).first()
        if not subscription: return

        # A retry is scheduled straight onto the worker and so never passed through
        # the queue's slot check. In sequential mode that let a retry run alongside
        # a live download; these providers allow one connection and answer the
        # second with HTTP 551 or by cutting it mid-stream. Hand the slot back
        # instead, and let the queue start it when it is free.
        if settings.download_mode == "sequential" and _another_download_is_live(db, download_id):
            download.status = DownloadStatus.PENDING
            download.error_message = "Waiting: another download is using the connection"
            db.commit()
            return

        # App settings for naming
        settings_dict = {s.key: s.value for s in db.query(SettingsModel).all()}
        
        # 1. Resolve Path (and the NFO sidecars, built from the same metadata)
        target = _resolve_target_path(db, download, subscription, settings_dict)
        save_path = target["path"]
        sidecars = target.get("sidecars") or []
        _adopt_previous_partial(download, save_path)

        # 2. Start Download
        download.status = DownloadStatus.DOWNLOADING
        download.started_at = datetime.now()
        download.task_id = self.request.id
        # Recorded now, not at the end: it is what lets the next attempt find the
        # bytes this one wrote, whatever the metadata resolves to next time.
        download.save_path = str(save_path)
        db.commit()
        _beat(download_id)

        # cool-down to allow previous connections (metadata fetch) to close fully on provider side
        time.sleep(15)

        used_ffmpeg = False
        try:
            try:
                success = _perform_download_stream(db, download, save_path, settings)
            except WrongContainerExtension as ext_error:
                # The URL is fixed; the file has to be named after the container it
                # really is, so the target is resolved again before retrying.
                target = _resolve_target_path(db, download, subscription, settings_dict)
                save_path = target["path"]
                sidecars = target.get("sidecars") or []
                _adopt_previous_partial(download, save_path)
                download.save_path = str(save_path)
                db.commit()
                logger.info(f"Retrying download {download_id} as .{ext_error.extension}")
                success = _perform_download_stream(db, download, save_path, settings)
        except Exception as e:
            partial_bytes = save_path.stat().st_size if save_path.exists() else 0
            if partial_bytes > 0:
                # Bytes already landed on disk. Retrying resumes them with a Range
                # request; handing over to FFmpeg would restart from zero and throw
                # the partial file away.
                logger.warning(
                    f"Download {download_id} interrupted at {partial_bytes:,} bytes ({e}). "
                    f"Will resume on retry."
                )
                raise
            logger.warning(f"Standard download failed before any data: {e}. Switching to FFmpeg.")
            used_ffmpeg = True
            success = _perform_download_ffmpeg(db, download, save_path, settings)

        if success:
            # Final guard: never archive a short file as complete. FFmpeg is exempt
            # because remuxing legitimately changes the size; it ran its own
            # tolerance check already.
            actual_bytes = save_path.stat().st_size if save_path.exists() else 0
            download.downloaded_bytes = actual_bytes
            if not used_ffmpeg and download.file_size and actual_bytes < download.file_size:
                raise IncompleteDownloadError(
                    f"file is truncated: {actual_bytes:,}/{download.file_size:,} bytes"
                )

            # Written only once the media file is known-complete, so a failed
            # or truncated download never leaves an NFO describing nothing.
            for nfo_path, nfo_content in sidecars:
                _write_sidecar_nfo(nfo_path, nfo_content)

            download.status = DownloadStatus.COMPLETED
            download.completed_at = datetime.now()
            download.progress = 100.0
            download.error_message = None
            download.save_path = str(save_path)
            db.commit()
            update_daily_stats(db, success=True, bytes_downloaded=float(download.downloaded_bytes))
            logger.info(f"Download {download_id} finished: {download.title}")

    except Exception as e:
        logger.error(f"Task {download_id} failed: {e}")
        try:
            db.refresh(download)
            download.retry_count = (download.retry_count or 0) + 1
            max_r = settings.default_max_retries or 3
            
            if download.retry_count < max_r:
                delay = 60 * (2 ** (download.retry_count - 1))
                download.status = DownloadStatus.PENDING
                download.next_retry_at = datetime.now() + timedelta(seconds=delay)
                download.error_message = f"Retry {download.retry_count}/{max_r}: {e}"
                db.commit()
                download_media_task.apply_async(args=[download_id], countdown=delay)
            else:
                download.status = DownloadStatus.FAILED
                download.error_message = str(e)
                db.commit()
                update_daily_stats(db, success=False)
        except Exception as retry_err:
            logger.error(f"Error handling retry: {retry_err}")
    finally:
        _clear_heartbeat(download_id)
        db.close()

@celery_app.task
def process_download_queue():
    """Background task that processes the download queue."""
    db = SessionLocal()
    try:
        settings = get_global_settings(db)

        # Free slots held by workers that no longer exist (e.g. after a restart),
        # otherwise a single dead task blocks the whole queue.
        _recover_stalled_downloads(db)

        if settings.download_mode == "sequential":
            total_active = db.query(DownloadTask).filter(DownloadTask.status == DownloadStatus.DOWNLOADING).count()
            if total_active >= 1: return
            
            subscriptions = db.query(Subscription).filter(Subscription.is_active == True).all()
            all_pending = []
            for sub in subscriptions:
                pending = db.query(DownloadTask).filter(
                    DownloadTask.subscription_id == sub.id,
                    DownloadTask.status == DownloadStatus.PENDING
                ).all()
                all_pending.extend(pending)
            
            if all_pending:
                # Highest priority first, then oldest first. Sorting the whole key in
                # reverse also reversed the date, so the queue ran newest-first: every
                # item queued after an episode pushed it further back, and a batch of
                # episodes was served in reverse while the first ones never came up.
                all_pending.sort(key=lambda x: (-(x.priority or 0), x.created_at))
                download = all_pending[0]
                if not download.scheduled_start_at or download.scheduled_start_at <= datetime.now():
                    # Mark as downloading immediately to reserve the slot
                    download.status = DownloadStatus.DOWNLOADING
                    download.started_at = datetime.now()
                    db.commit()
                    _beat(download.id)  # hold the slot until the worker takes over

                    download_media_task.delay(download.id)
            return

        subscriptions = db.query(Subscription).filter(Subscription.is_active == True).all()
        for sub in subscriptions:
            active_count = db.query(DownloadTask).filter(
                DownloadTask.subscription_id == sub.id,
                DownloadTask.status == DownloadStatus.DOWNLOADING
            ).count()
            
            max_parallel = sub.max_parallel_downloads or 2
            available_slots = max_parallel - active_count
            if available_slots > 0:
                pending_downloads = db.query(DownloadTask).filter(
                    DownloadTask.subscription_id == sub.id,
                    DownloadTask.status == DownloadStatus.PENDING
                ).order_by(DownloadTask.priority.desc(), DownloadTask.created_at.asc()).limit(available_slots).all()
                
                for download in pending_downloads:
                    if download.scheduled_start_at and download.scheduled_start_at > datetime.now():
                        continue
                    
                    # Mark as downloading immediately to reserve the slot
                    download.status = DownloadStatus.DOWNLOADING
                    download.started_at = datetime.now()
                    db.commit() # Commit each one to be safe for other concurrent processors
                    _beat(download.id)  # hold the slot until the worker takes over

                    download_media_task.delay(download.id)
    finally:
        db.close()

@celery_app.task
def check_auto_downloads():
    """Periodic task for auto-downloads, cleanup and recovery."""
    db = SessionLocal()
    try:
        settings = get_global_settings(db)
        # 1. Recovery (heartbeat-aware: live downloads are never touched)
        _recover_stalled_downloads(db)

        # 2. Cleanup
        cleanup_old_tasks(db, settings)
        
        # 3. Process auto-downloads
        _process_auto_downloads_sync(db)
    except Exception as e:
        logger.error(f"Error in check_auto_downloads: {e}")
    finally:
        db.close()
