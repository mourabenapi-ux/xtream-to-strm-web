from app.core.celery_app import celery_app
from sqlalchemy.orm import Session
from app.db.session import SessionLocal
from app.models.m3u_source import M3USource, SourceType
from app.models.m3u_entry import M3UEntry, EntryType
from app.models.m3u_selection import M3USelection, SelectionType
from app.models.m3u_sync_state import M3USyncState
from app.models.settings import SettingsModel
from app.services.m3u_parser import parse_m3u_url, parse_m3u_file
from app.services.file_manager import FileManager
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Set, Optional, Tuple
import shutil
import hashlib
import asyncio

logger = logging.getLogger(__name__)

# Constants
CONTENT_TYPE_MOVIES = "movies"
CONTENT_TYPE_SERIES = "series"
STRM_EXTENSION = ".strm"


# ============================================================================
# Helper Functions
# ============================================================================

def sanitize_name(name: str) -> str:
    """Sanitize name for filesystem compatibility"""
    return "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).strip()


def calculate_file_hash(file_path: str) -> Optional[str]:
    """Calculate MD5 hash of file for change detection"""
    try:
        with open(file_path, 'rb') as f:
            return hashlib.md5(f.read()).hexdigest()
    except Exception as e:
        logger.warning(f"Could not calculate hash for {file_path}: {e}")
        return None


def should_reparse_m3u(source: M3USource, existing_count: int, force: bool = False) -> bool:
    """Determine if M3U needs to be reparsed"""
    # Force update requested
    if force:
        logger.info(f"Force update requested for {source.name}, will reparse")
        return True

    # No cache exists, must parse
    if existing_count == 0:
        return True
    
    # For FILE sources, check hash if available
    if source.source_type == SourceType.FILE:
        current_hash = calculate_file_hash(source.file_path)
        if current_hash and hasattr(source, 'm3u_hash') and source.m3u_hash:
            if current_hash != source.m3u_hash:
                logger.info(f"M3U file hash changed for {source.name}, will reparse")
                return True
            else:
                logger.info(f"M3U file unchanged for {source.name}, using cache")
                return False
    
    # For URL sources, reparse if it's been > 1 hour since last sync
    if source.last_sync:
        time_since_sync = datetime.now() - source.last_sync
        if time_since_sync < timedelta(hours=1):
            logger.info(f"M3U URL recently synced for {source.name}, using cache")
            return False
    
    return True


def cleanup_deselected_groups(
    base_dir: str,
    selected_groups: Set[str],
    content_type: str,
    sync_types: Optional[list]
) -> int:
    """Remove directories for deselected groups and count deleted files"""
    if sync_types and content_type not in sync_types:
        return 0
    
    deleted_count = 0
    content_dir = Path(base_dir) / content_type
    
    if content_dir.exists():
        for group_dir in content_dir.iterdir():
            if group_dir.is_dir():
                is_selected = any(
                    sanitize_name(g) == group_dir.name 
                    for g in selected_groups
                )
                
                if not is_selected:
                    file_count = sum(1 for f in group_dir.glob(f'*{STRM_EXTENSION}'))
                    deleted_count += file_count
                    shutil.rmtree(group_dir)
                    logger.info(
                        f"Removed deselected {content_type} group: "
                        f"{group_dir.name} ({file_count} files)"
                    )
    
    return deleted_count


# ============================================================================
# Main Sync Task
# ============================================================================

@celery_app.task
def sync_m3u_source_task(source_id: int, sync_types: list = None, force: bool = False):
    """Sync M3U source - parse and generate STRM files"""
    db = SessionLocal()
    try:
        # Get M3U source
        source = db.query(M3USource).filter(M3USource.id == source_id).first()
        if not source:
            logger.error(f"M3U source {source_id} not found")
            return {"error": "Source not found"}
        
        # Get settings
        settings = {s.key: s.value for s in db.query(SettingsModel).all()}
        prefix_regex = settings.get("PREFIX_REGEX")
        format_date = settings.get("FORMAT_DATE_IN_TITLE") == "true"
        clean_name = settings.get("CLEAN_NAME") == "true"
        
        logger.info(f"Starting M3U sync for source: {source.name}")
        
        # Initialize FileManager
        fm = FileManager(source.output_dir)
        
        # OPTIMIZATION: Check if any groups are selected BEFORE parsing M3U
        selected_groups = db.query(M3USelection).filter(
            M3USelection.m3u_source_id == source_id
        ).all()
        
        # Get existing cached entries count
        existing_entries_count = db.query(M3UEntry).filter(
            M3UEntry.m3u_source_id == source_id
        ).count()
        
        # Update status to syncing
        source.sync_status = "syncing"
        
        # Update M3USyncState to running and RESET counters
        sync_states = []
        if sync_types:
            for stype in sync_types:
                state = db.query(M3USyncState).filter(
                    M3USyncState.m3u_source_id == source_id,
                    M3USyncState.type == stype
                ).first()
                if state:
                    state.status = "running"
                    state.error_message = None
                    # RESET counters at the start of each sync
                    state.items_added = 0
                    state.items_deleted = 0
                    sync_states.append(state)
        
        db.commit()
        
        # Early exit if no groups selected and entries already cached
        if not selected_groups and existing_entries_count > 0:
            logger.info(f"No groups selected and entries already cached for {source.name}, skipping")
            source.last_sync = datetime.utcnow()
            source.sync_status = "success"
            
            for state in sync_states:
                state.status = "success"
                state.last_sync = datetime.utcnow()
                state.task_id = None
            
            db.commit()
            return {
                "source_id": source_id,
                "source_name": source.name,
                "status": "success",
                "message": "No groups selected, skipped sync"
            }
        
        # OPTIMIZATION: Check if we need to reparse M3U
        needs_reparse = should_reparse_m3u(source, existing_entries_count, force)
        
        added_count = 0
        if needs_reparse:
            # Parse M3U content
            try:
                if source.source_type == SourceType.URL:
                    entries = parse_m3u_url(source.url)
                else:  # FILE
                    entries = parse_m3u_file(source.file_path)
            except Exception as e:
                logger.error(f"Error parsing M3U source {source.name}: {e}")
                source.sync_status = "error"
                
                for state in sync_states:
                    state.status = "failed"
                    state.error_message = str(e)
                    state.task_id = None
                    
                db.commit()
                return {"error": str(e)}
            
            logger.info(f"Parsed {len(entries)} entries from {source.name}")
            
            # Clear existing entries
            db.query(M3UEntry).filter(M3UEntry.m3u_source_id == source_id).delete()
            db.commit()
            
            # Create output directory
            Path(source.output_dir).mkdir(parents=True, exist_ok=True)
            
            # Process and cache entries
            for entry_data in entries:
                try:
                    # Determine entry type
                    entry_type_str = entry_data.get('entry_type', 'live')
                    if entry_type_str == 'movie':
                        entry_type = EntryType.MOVIE
                    elif entry_type_str == 'series':
                        entry_type = EntryType.SERIES
                    else:
                        # Skip LIVE entries entirely
                        continue
                    
                    # Save to database
                    db_entry = M3UEntry(
                        m3u_source_id=source_id,
                        title=entry_data.get('title', 'Unknown'),
                        url=entry_data['url'],
                        group_title=entry_data.get('group_title'),
                        logo=entry_data.get('logo'),
                        tvg_id=entry_data.get('tvg_id'),
                        tvg_name=entry_data.get('tvg_name'),
                        entry_type=entry_type
                    )
                    db.add(db_entry)
                    added_count += 1
                        
                except Exception as e:
                    logger.error(f"Error caching entry {entry_data.get('title')}: {e}")
                    continue
            
            # Commit cached entries
            db.commit()
            
            # Update hash if applicable
            if source.source_type == SourceType.FILE and hasattr(source, 'm3u_hash'):
                source.m3u_hash = calculate_file_hash(source.file_path)
                db.commit()
        else:
            logger.info(f"Using cached entries for {source.name}")
            added_count = existing_entries_count
        
        # If no groups selected, stop here (already cached)
        if not selected_groups:
            logger.info(f"No groups selected for {source.name}, skipping file generation")
            source.last_sync = datetime.utcnow()
            source.sync_status = "success"
            
            for state in sync_states:
                state.status = "success"
                state.last_sync = datetime.utcnow()
                state.task_id = None
                
            db.commit()
            return {
                "source_id": source_id,
                "source_name": source.name,
                "items_cached": added_count,
                "items_processed": 0,
                "status": "success",
                "message": "Entries cached but no groups selected for file generation"
            }
        
        # Build sets of selected groups for quick lookup
        selected_movie_groups = {
            sel.group_title for sel in selected_groups 
            if sel.selection_type == SelectionType.MOVIE
        }
        selected_series_groups = {
            sel.group_title for sel in selected_groups 
            if sel.selection_type == SelectionType.SERIES
        }
        
        use_category_folders = settings.get("SERIES_USE_CATEGORY_FOLDERS", "true") == "true"
        
        # CLEANUP PHASE: Remove directories for deselected groups
        movies_deleted = cleanup_deselected_groups(
            source.movies_dir or source.output_dir, selected_movie_groups, CONTENT_TYPE_MOVIES, sync_types
        )
        
        series_deleted = 0
        if use_category_folders:
            series_deleted = cleanup_deselected_groups(
                source.series_dir or source.output_dir, selected_series_groups, CONTENT_TYPE_SERIES, sync_types
            )
        
        # FILE GENERATION PHASE
        movies_files_created = 0
        series_files_created = 0
        
        # Process entries for file generation
        # We need an event loop for async FileManager methods
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        for entry in db.query(M3UEntry).filter(M3UEntry.m3u_source_id == source_id).all():
            try:
                # Filter by sync_types if provided
                if sync_types:
                    if entry.entry_type == EntryType.MOVIE and CONTENT_TYPE_MOVIES not in sync_types:
                        continue
                    if entry.entry_type == EntryType.SERIES and CONTENT_TYPE_SERIES not in sync_types:
                        continue

                group = entry.group_title or "Uncategorized"
                
                # Check if this group is selected and determine base directory
                if entry.entry_type == EntryType.MOVIE:
                    if group not in selected_movie_groups:
                        continue
                    # Movies always use categories: /output/movies/Category/MovieName.strm
                    base_dir = source.movies_dir or f"{source.output_dir}/movies"
                    safe_group = sanitize_name(group)
                    safe_title = sanitize_name(entry.title)
                    group_dir = Path(base_dir) / safe_group
                elif entry.entry_type == EntryType.SERIES:
                    if group not in selected_series_groups:
                        continue
                    base_dir = source.series_dir or f"{source.output_dir}/series"
                    safe_group = sanitize_name(group)
                    safe_title = sanitize_name(entry.title)
                    
                    if use_category_folders:
                        # /output/series/Category/SeriesName/
                        group_dir = Path(base_dir) / safe_group / safe_title
                    else:
                        # /output/series/SeriesName/
                        group_dir = Path(base_dir) / safe_title
                else:
                    continue
                
                group_dir.mkdir(parents=True, exist_ok=True)
                
                strm_path = group_dir / f"{safe_title}{STRM_EXTENSION}"
                nfo_path = group_dir / f"{safe_title}.nfo"
                
                # Check if STRM exists to count as new
                is_new = not strm_path.exists()
                
                # Create STRM file
                loop.run_until_complete(fm.write_strm(str(strm_path), entry.url))
                
                # Create NFO file
                data = {
                    "name": entry.title,
                    "cover": entry.logo,
                    # Add other fields if available in M3U entry
                }
                
                if entry.entry_type == EntryType.MOVIE:
                    nfo_content = fm.generate_movie_nfo(data, prefix_regex, format_date, clean_name)
                    if is_new:
                        movies_files_created += 1
                else:
                    nfo_content = fm.generate_show_nfo(data, prefix_regex, format_date, clean_name)
                    if is_new:
                        series_files_created += 1
                
                loop.run_until_complete(fm.write_nfo(str(nfo_path), nfo_content))
                        
            except Exception as e:
                logger.error(f"Error processing entry {entry.title}: {e}")
                continue
        
        loop.close()
        
        files_created = movies_files_created + series_files_created
        
        # Update source last_sync
        source.last_sync = datetime.utcnow()
        source.sync_status = "success"
        
        # Update sync states to success
        for state in sync_states:
            state.status = "success"
            state.last_sync = datetime.utcnow()
            if state.type == CONTENT_TYPE_MOVIES:
                state.items_added = movies_files_created
                state.items_deleted = movies_deleted
            elif state.type == CONTENT_TYPE_SERIES:
                state.items_added = series_files_created
                state.items_deleted = series_deleted
            state.task_id = None
            
        db.commit()
        
        logger.info(
            f"M3U sync completed for {source.name}: "
            f"{added_count} entries cached, {files_created} files created, "
            f"{movies_deleted + series_deleted} files deleted"
        )
        
        return {
            "source_id": source_id,
            "source_name": source.name,
            "items_cached": added_count,
            "items_processed": files_created,
            "status": "success"
        }
        
    except Exception as e:
        logger.error(f"Error in M3U sync task for source {source_id}: {e}")
        try:
            if 'source' in locals() and source:
                source.sync_status = "error"
                
                if sync_types:
                    for stype in sync_types:
                        state = db.query(M3USyncState).filter(
                            M3USyncState.m3u_source_id == source_id,
                            M3USyncState.type == stype
                        ).first()
                        if state:
                            state.status = "failed"
                            state.error_message = str(e)
                            state.task_id = None
                            
                db.commit()
        except:
            pass
        return {"error": str(e)}
    finally:
        db.close()
