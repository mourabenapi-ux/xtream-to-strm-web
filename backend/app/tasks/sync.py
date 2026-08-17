import asyncio
import hashlib
import os
from app.core.celery_app import celery_app
from sqlalchemy.orm import Session
from app.db.session import SessionLocal
from app.models.subscription import Subscription
from app.models.sync_state import SyncState, SyncStatus, SyncType
from app.models.selection import SelectedCategory
from app.models.cache import MovieCache, SeriesCache, EpisodeCache
from app.models.schedule import Schedule, SyncType as ScheduleSyncType
from app.models.schedule_execution import ScheduleExecution, ExecutionStatus
from app.services.catalog import get_catalog
from app.services.file_manager import FileManager
from app.services.tmdb_overrides import load_overrides, normalise_id
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

# How long a series' episode list may go without being re-read from the
# provider. Overridable with the SERIES_REFRESH_HOURS setting.
_DEFAULT_SERIES_REFRESH_HOURS = 12


def _provider_stamp(series: dict):
    """The provider's change marker for a series, or None if it offers one.

    Xtream Codes exposes `last_modified` on the `get_series` listing. Not
    every provider fills it, and some never bump it when a new episode lands,
    so it is used as a cheap "definitely changed" signal only — never as
    proof that nothing changed. That is what the periodic refresh is for.
    """
    for key in ("last_modified", "last_modified_date"):
        value = series.get(key)
        if value not in (None, "", "0", 0):
            return str(value)
    return None


def _needs_episode_refresh(cached, stamp, refresh_after: timedelta) -> bool:
    """Whether this series' episode list must be pulled again.

    An ongoing series never gained its new episodes because the only triggers
    were "new to us" and "the name changed" — neither of which fires when a
    provider appends S01E09 to a series we already know.
    """
    if stamp is not None and (cached.last_modified or None) != stamp:
        return True

    # No usable stamp, or the stamp has not moved: fall back on age. A row
    # that predates this column has last_refreshed = None and is refreshed
    # once, which is exactly the repair an existing library needs.
    if cached.last_refreshed is None:
        return True

    return (datetime.utcnow() - cached.last_refreshed) >= refresh_after


class SyncAborted(Exception):
    """Refuse to act on a provider response that cannot be trusted.

    Deletion is driven by absence: anything cached but missing from the
    provider's list is removed. That makes an empty or truncated response
    indistinguishable from "the provider dropped everything" — and on
    2026-08-16 it wiped a 94-title library when `get_vod_streams()` returned
    `[]` three times running while `get_vod_categories()` answered normally.

    Only an empty *selection* may empty a library, because that is the user
    saying so. A silent provider may not.
    """


def _guard_against_empty_catalogue(media: str, fetched: list, kept: list,
                                   selected_ids: set, cached_count: int) -> None:
    """Abort before the deletion pass when the catalogue looks untrustworthy."""
    if not cached_count or not selected_ids:
        # Nothing to lose, or the user deliberately deselected everything.
        return

    if not fetched:
        raise SyncAborted(
            f"The provider returned an empty {media} catalogue while {cached_count} "
            f"{media} are known. Refusing to delete the library — nothing was changed. "
            "Retry when the provider responds normally."
        )

    if not kept:
        raise SyncAborted(
            f"None of the selected {media} categories matched any of the "
            f"{len(fetched)} items the provider returned, while {cached_count} "
            f"{media} are known. Refusing to delete the library — nothing was "
            "changed. Check the category selection, or clear it deliberately to "
            "empty this library."
        )

# Default download locations, used when a subscription leaves the column unset.
_DEFAULT_DOWNLOAD_DIRS = ("/output/downloads/movies", "/output/downloads/series")


# Bump when the generator's naming or folder shape changes, so existing
# libraries are rebuilt instead of keeping files no future sync would revisit.
# "3": duplicate catalogue entries now get a numbered suffix instead of
# overwriting each other, so affected libraries must be rewritten once.
_GENERATOR_VERSION = "3"


def _layout_signature(media_type: str, settings: dict, use_category_folders: bool) -> str:
    """Fingerprint of everything that decides where a file goes and what it is called.

    Changing PREFIX_REGEX, CLEAN_NAME or the category/season folder switches
    used to leave the library in its old shape forever: the cache still matched
    the provider, so nothing was ever rewritten, and the settings screen quietly
    lied about the layout on disk. When this fingerprint moves, every cached
    item is rebuilt once.
    """
    keys = [
        "PREFIX_REGEX", "FORMAT_DATE_IN_TITLE", "CLEAN_NAME",
        "SERIES_USE_SEASON_FOLDERS", "SERIES_INCLUDE_NAME_IN_FILENAME",
    ]
    parts = [_GENERATOR_VERSION, media_type, f"cat={use_category_folders}"]
    parts += [f"{k}={settings.get(k)!r}" for k in keys]
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _disambiguate_paths(items, id_key: str, path_of) -> dict:
    """Suffix to append to each item whose path another item already claims.

    The provider lists some titles under several stream ids — "AF-FR - REMORDS
    (2020)" twice, for one — and every one of them resolved to the same file,
    so the last written silently replaced the rest. Measured: 94 cached movies
    produced 93 files, with no error anywhere.

    The first entry keeps the bare name and the others become "(2)", "(3)".
    Rank is taken from the sorted provider id, never from the order the
    catalogue happened to arrive in: the provider does not guarantee a stable
    order, and ranking by arrival would rename files on disk at random between
    two syncs.

    This is computed from the catalogue listing, before the per-item metadata
    fetch. If that fetch later gives two entries different tmdb ids they will
    land in distinct folders anyway, and one keeps a harmless "(2)".
    """
    by_path = {}
    for item in items:
        by_path.setdefault(path_of(item), []).append(int(item[id_key]))

    suffixes = {}
    for ids in by_path.values():
        if len(ids) < 2:
            continue
        for rank, item_id in enumerate(sorted(ids)):
            if rank:
                suffixes[item_id] = f"({rank + 1})"
    return suffixes


def _apply_tmdb_overrides(overrides, items: list, id_key: str) -> int:
    """Put the user's corrected TMDB ids into the catalogue listing.

    Done here, on the listing, rather than at the point each item is written:
    the id decides the folder name, and the folder name is what
    ``_disambiguate_paths`` reasons about below. Correcting it later would leave
    two titles fighting over one path again.

    The entries it touches are marked, so the per-item metadata fetch — which
    runs after this and carries the provider's own tmdb_id — knows not to
    overwrite an answer the user has already given.
    """
    if not overrides:
        return 0

    applied = 0
    for item in items:
        value, overridden = overrides.resolve(
            item.get(id_key), item.get("name"), item.get("tmdb"))
        if not overridden:
            continue
        # Both spellings: the NFO and path writers read `tmdb` and fall back to
        # `tmdb_id`, so clearing an id means clearing both.
        item["tmdb"] = value
        item["tmdb_id"] = value
        item["_tmdb_override"] = True
        applied += 1
    return applied


def _tmdb_override_moved(item: dict, cached) -> bool:
    """Whether a correction has changed since this item was last written.

    Nothing else would notice: the provider's name and container are unchanged,
    so the item looks up to date while its folder is named after the old id.
    """
    return (bool(item.get("_tmdb_override"))
            and normalise_id(cached.tmdb_id) != normalise_id(item.get("tmdb")))


def _record_outcome(sync_state: SyncState, attempted: int, succeeded: int, collisions: int = 0) -> None:
    """Report what the sync actually wrote, not what it set out to write.

    `items_added` used to be `len(to_add_update)` — the size of the *to-do*
    list — and the status was hardcoded to SUCCESS whatever happened per item.
    A run where all 8 series aborted mid-write therefore reported "success,
    8 added" with an empty library. `error_message` was also never cleared, so
    a stale failure stayed attached to later green runs.
    """
    failed = attempted - succeeded
    sync_state.items_added = succeeded

    notes = []
    if failed > 0:
        notes.append(f"{failed} of {attempted} item(s) failed to write. See the logs for the cause.")
    if collisions > 0:
        notes.append(
            f"{collisions} title(s) share a filename with another and were overwritten — "
            "the provider lists them more than once."
        )

    if failed > 0 and succeeded == 0:
        sync_state.status = SyncStatus.FAILED
    elif notes:
        sync_state.status = SyncStatus.PARTIAL
    else:
        sync_state.status = SyncStatus.SUCCESS

    sync_state.error_message = " ".join(notes) if notes else None


def _set_progress(db: Session, sync_state: SyncState, phase, done=None, total=None) -> None:
    """Publish where the run has got to, so the UI can show a bar and not a spinner.

    Committed on every call: this is read by the API from another process, so a
    value that stays in this session's transaction is invisible to the user.
    """
    sync_state.progress_phase = phase
    if done is not None:
        sync_state.progress_done = done
    if total is not None:
        sync_state.progress_total = total
    db.commit()


def _clear_progress(sync_state: SyncState) -> None:
    """Drop the live counters once the run is over.

    Left behind, they would make a finished sync look like it stopped at 87%.
    The caller commits — this always runs next to a status change.
    """
    sync_state.progress_phase = None
    sync_state.progress_done = 0
    sync_state.progress_total = 0


def _protected_roots(db: Session, subscription_id: int, own_root: str) -> set:
    """Directories the disk sweep must never enter.

    Nothing stops two subscriptions from being pointed at overlapping output
    directories, and the downloader writes real media files (not just .strm)
    under its own. A sweep driven by one catalogue knows nothing about the
    others' files, so it would read them as stale and delete them.
    """
    roots = set(_DEFAULT_DOWNLOAD_DIRS)
    own = os.path.abspath(own_root)

    for sub in db.query(Subscription).all():
        candidates = (
            sub.movies_dir,
            sub.series_dir,
            sub.download_movies_dir,
            sub.download_series_dir,
        )
        for path in candidates:
            if path:
                roots.add(path)

    # Everything except the library currently being swept.
    return {os.path.abspath(p) for p in roots} - {own}

async def process_movies(db: Session, xc, fm: FileManager, subscription_id: int):
    """`xc` is whatever ``get_catalog`` returned — an Xtream client or an M3U
    catalogue. They answer the same calls, so this function never asks."""
    # Get settings
    from app.models.settings import SettingsModel
    settings = {s.key: s.value for s in db.query(SettingsModel).all()}
    prefix_regex = settings.get("PREFIX_REGEX")
    format_date = settings.get("FORMAT_DATE_IN_TITLE") == "true"
    clean_name = settings.get("CLEAN_NAME") == "true"
    use_category_folders = settings.get("MOVIE_USE_CATEGORY_FOLDERS", "true") == "true"

    # Update status
    sync_state = db.query(SyncState).filter(
        SyncState.subscription_id == subscription_id,
        SyncState.type == SyncType.MOVIES
    ).first()
    
    if not sync_state:
        sync_state = SyncState(subscription_id=subscription_id, type=SyncType.MOVIES)
        db.add(sync_state)
    
    sync_state.status = SyncStatus.RUNNING
    sync_state.last_sync = datetime.now()
    sync_state.progress_phase = "Reading the provider catalogue"
    sync_state.progress_done = 0
    sync_state.progress_total = 0
    db.commit()

    try:
        # Fetch Categories. Keys are normalised to str for the same reason as
        # the selection filter below: a missed lookup silently becomes
        # "Uncategorized" and sends the item to a different folder.
        categories = await xc.get_vod_categories()
        cat_map = {str(c['category_id']): c['category_name'] for c in categories}

        # Fetch All Movies
        all_movies = await xc.get_vod_streams()

        # Filter by selected categories. The filter is applied unconditionally:
        # an empty selection means "I want nothing from this subscription", not
        # "give me everything". Guarding this with `if selected_cats:` turned a
        # cleared selection into a full-catalogue sync — 178 000 movies instead
        # of none. With the filter always on, an empty selection yields an empty
        # list, and the deletion pass below removes what was generated before.
        selected_cats = db.query(SelectedCategory).filter(
            SelectedCategory.subscription_id == subscription_id,
            SelectedCategory.type == "movie"
        ).all()

        # Both sides are normalised: the provider is not consistent about
        # returning category ids as strings or numbers, and a type mismatch here
        # would silently mean "nothing selected" — i.e. delete the library.
        selected_ids = {str(s.category_id) for s in selected_cats}
        fetched_movies = all_movies
        all_movies = [m for m in all_movies if str(m.get('category_id')) in selected_ids]

        corrected = _apply_tmdb_overrides(
            load_overrides(db, subscription_id, "movie"), all_movies, "stream_id")
        if corrected:
            logger.info(f"{corrected} movie(s) use a hand-corrected TMDB id.")

        # Current Cache
        cached_movies = {m.stream_id: m for m in db.query(MovieCache).filter(MovieCache.subscription_id == subscription_id).all()}

        _guard_against_empty_catalogue(
            "movies", fetched_movies, all_movies, selected_ids, len(cached_movies)
        )
        
        to_add_update = []
        to_delete = []

        current_ids = set()

        signature = _layout_signature("movies", settings, use_category_folders)
        layout_changed = (sync_state.layout_signature or "") != signature
        if layout_changed:
            logger.info(f"Movie layout signature changed for subscription {subscription_id}; rebuilding.")

        # Which entries need a "(2)" so they stop overwriting each other.
        movie_suffixes = _disambiguate_paths(
            all_movies, "stream_id",
            lambda m: fm.get_movie_target_info(
                m, cat_map.get(str(m.get('category_id')), "Uncategorized"),
                prefix_regex, format_date, clean_name, use_category_folders
            )["target_dir"],
        )
        if movie_suffixes:
            logger.info(
                f"{len(movie_suffixes)} movie(s) share a name with another entry "
                f"and were given a numbered suffix."
            )

        def _movie_paths(stream_id, name, tmdb_id, category_id):
            info = fm.get_movie_target_info(
                {"name": name, "tmdb": tmdb_id},
                cat_map.get(str(category_id), "Uncategorized"),
                prefix_regex, format_date, clean_name, use_category_folders,
                disambiguator=movie_suffixes.get(stream_id, ""),
            )
            base = os.path.join(info["target_dir"], info["filename_base"])
            return f"{base}.strm", f"{base}.nfo"

        for movie in all_movies:
            stream_id = int(movie['stream_id'])
            current_ids.add(stream_id)

            # Check if changed
            cached = cached_movies.get(stream_id)
            if not cached:
                to_add_update.append(movie)
            elif cached.name != movie['name'] or cached.container_extension != movie['container_extension']:
                to_add_update.append(movie)
            elif _tmdb_override_moved(movie, cached):
                # The user corrected this title's TMDB id since it was written.
                to_add_update.append(movie)
            elif layout_changed:
                # The naming or folder rules moved since this item was written.
                to_add_update.append(movie)
            elif not all(os.path.exists(p) for p in
                         _movie_paths(stream_id, cached.name, cached.tmdb_id, cached.category_id)):
                # The cache says this movie is up to date but the files are not
                # there: deleted by hand, or written under a layout the settings
                # have since changed. Rebuild it rather than trust the cache —
                # without this the sweep would remove the old files and nothing
                # would ever write the new ones.
                to_add_update.append(movie)

        # Detect deletions
        for stream_id, cached in cached_movies.items():
            if stream_id not in current_ids:
                to_delete.append(cached)

        # Where each still-wanted cached movie lives *right now*, captured before
        # the cache rows are rewritten below. Used to keep the files of a movie
        # that is unchanged, or whose refresh fails, so a transient provider
        # error cannot make the sweep erase good files.
        pre_sync_paths = {
            stream_id: _movie_paths(stream_id, cached.name, cached.tmdb_id, cached.category_id)
            for stream_id, cached in cached_movies.items()
            if stream_id in current_ids
        }

        # Process Deletions
        if to_delete:
            _set_progress(db, sync_state, f"Removing {len(to_delete)} title(s)")
        for movie in to_delete:
            cat_name = cat_map.get(str(movie.category_id), "Uncategorized")
            target_info = fm.get_movie_target_info(
                {"name": movie.name, "tmdb": movie.tmdb_id}, 
                cat_name, prefix_regex, format_date, clean_name, use_category_folders
            )
            
            # 1. New Structure removal.
            # Removes the movie's own {tmdb-…} folder, or just its .strm/.nfo
            # when it lives directly in a shared directory. This used to
            # rmtree target_dir unconditionally, which erased the entire
            # library for any untagged movie when category folders are off.
            await fm.remove_media_target(target_info)

            # 2. Old Structure removal (fallback)
            safe_name = fm.sanitize_name(movie.name)
            old_path = f"{target_info['cat_dir']}/{safe_name}.strm"
            old_nfo = f"{target_info['cat_dir']}/{safe_name}.nfo"
            await fm.delete_file(old_path)
            await fm.delete_file(old_nfo)

            await fm.delete_directory_if_empty(target_info['cat_dir'])
            
            db.delete(movie)
        
        # Process Additions/Updates with Parallel Fetching
        try:
            parallelism = int(settings.get("SYNC_PARALLELISM_MOVIES", "10"))
        except ValueError:
            parallelism = 10
            
        batch_size = parallelism
        semaphore = asyncio.Semaphore(batch_size)

        async def process_single_movie(movie):
            async with semaphore:
                try:
                    stream_id = int(movie['stream_id'])
                    name = movie['name']
                    ext = movie['container_extension']
                    cat_id = movie['category_id']
                    tmdb_id = movie.get('tmdb')

                    # Fetch detailed info for Metadata
                    try:
                        detailed_info = await xc.get_vod_info(str(stream_id))
                        if detailed_info and 'info' in detailed_info:
                            movie['info'] = detailed_info['info'] # Inject info for NFO generator
                            # Update TMDB if found — unless the user has already
                            # said what this title is. The provider's answer is
                            # exactly the one being corrected.
                            if (detailed_info['info'].get('tmdb_id')
                                    and not movie.get('_tmdb_override')):
                                tmdb_id = detailed_info['info'].get('tmdb_id')
                                movie['tmdb'] = tmdb_id # Update for object
                    except Exception as e:
                        # logger.warning(f"Failed to fetch info for movie {stream_id}: {e}")
                        pass

                    cat_name = cat_map.get(str(cat_id), "Uncategorized")
                    target_info = fm.get_movie_target_info(
                        movie, cat_name, prefix_regex, format_date, clean_name,
                        use_category_folders,
                        disambiguator=movie_suffixes.get(stream_id, ""),
                    )

                    fm.ensure_directory(target_info["cat_dir"])
                    if target_info["target_dir"] != target_info["cat_dir"]:
                        fm.ensure_directory(target_info["target_dir"])
                    
                    strm_path = os.path.join(target_info["target_dir"], f"{target_info['filename_base']}.strm")
                    nfo_path = os.path.join(target_info["target_dir"], f"{target_info['filename_base']}.nfo")
                    
                    url = xc.get_stream_url("movie", str(stream_id), ext)
                    
                    await fm.write_strm(strm_path, url)
                    
                    nfo_content = fm.generate_movie_nfo(movie, prefix_regex, format_date, clean_name)
                    await fm.write_nfo(nfo_path, nfo_content)

                    # Update Cache
                    # We need to lock DB access or handle it after gather?
                    # Ideally accumulate results and bulk update, but for safety lets return data
                    return {
                        'action': 'update_cache',
                        # The paths actually written, so the sweep keeps exactly
                        # these and treats the movie's former folder as stale.
                        'paths': {strm_path, nfo_path},
                        'strm': strm_path,
                        'data': {
                            'stream_id': stream_id,
                            'name': name,
                            'category_id': cat_id,
                            'container_extension': ext,
                            'tmdb_id': str(tmdb_id) if tmdb_id else None
                        }
                    }

                except Exception as e:
                    logger.error(f"Error processing movie {movie.get('name')}: {e}")
                    # Report the failure rather than swallowing it: the sweep
                    # must keep this movie's existing files instead of deleting
                    # what it just failed to rewrite.
                    try:
                        failed_id = int(movie['stream_id'])
                    except (KeyError, TypeError, ValueError):
                        failed_id = None
                    return {'action': 'failed', 'stream_id': failed_id}

        # Execute in chunks to avoid memory explosion if list is huge
        # But for 10 concurrent, direct gather is fine usually.
        # Let's process in batches of 50 to update DB incrementally
        total_processed = 0
        chunk_size = 50

        # Everything the library is still supposed to contain when this sync ends.
        keep_files = set()
        reprocessed_ids = set()
        strm_by_id = {}

        _set_progress(db, sync_state, "Writing movies", done=0, total=len(to_add_update))

        for i in range(0, len(to_add_update), chunk_size):
            chunk = to_add_update[i:i + chunk_size]
            results = await asyncio.gather(*[process_single_movie(m) for m in chunk])

            for res in results:
                if res and res['action'] == 'update_cache':
                    d = res['data']
                    keep_files |= res['paths']
                    reprocessed_ids.add(d['stream_id'])
                    strm_by_id[d['stream_id']] = res['strm']
                    cached = cached_movies.get(d['stream_id'])
                    if not cached:
                        cached = MovieCache(subscription_id=subscription_id, stream_id=d['stream_id'])
                        db.add(cached)

                    cached.name = d['name']
                    cached.category_id = d['category_id']
                    cached.container_extension = d['container_extension']
                    cached.tmdb_id = d['tmdb_id']

            # Counted as attempted, not as succeeded: the bar tracks how far
            # through the to-do list the run is, and a failed item is done with.
            sync_state.progress_done = i + len(chunk)
            db.commit() # Commit every chunk

        # Movies left untouched this run — unchanged, or a refresh that failed —
        # keep the files they already have. Everything else under the library is
        # stale by definition, including the folders a rename orphaned.
        for stream_id, paths in pre_sync_paths.items():
            if stream_id not in reprocessed_ids:
                keep_files.update(paths)
                strm_by_id.setdefault(stream_id, paths[0])

        _set_progress(db, sync_state, "Cleaning up the library")

        await fm.sweep_generated_files(
            keep_files,
            protected_roots=_protected_roots(db, subscription_id, fm.output_dir)
        )

        # Two catalogue entries that sanitise to the same filename write to the
        # same file: the second silently replaces the first and one title is
        # simply absent from the library. Seen live — the provider lists
        # "AF-FR - REMORDS (2020)" under two different stream ids.
        owners = {}
        for movie in all_movies:
            path = strm_by_id.get(int(movie['stream_id']))
            if path:
                owners.setdefault(path, []).append(movie.get('name'))
        collisions = {p: names for p, names in owners.items() if len(names) > 1}
        for path, names in collisions.items():
            logger.warning(f"Filename collision on {os.path.basename(path)}: {names}")

        sync_state.items_deleted = len(to_delete)
        _record_outcome(
            sync_state,
            attempted=len(to_add_update),
            succeeded=len(reprocessed_ids),
            collisions=sum(len(n) - 1 for n in collisions.values()),
        )
        # Only a clean run may claim the new layout: recording it after a
        # partial one would leave the failed items in the old shape forever.
        if sync_state.status == SyncStatus.SUCCESS:
            sync_state.layout_signature = signature
        _clear_progress(sync_state)
        db.commit()

    except SyncAborted as e:
        # A deliberate refusal, not a crash — no traceback, and nothing on disk
        # was touched because the guard runs before the deletion pass.
        logger.warning(f"Movie sync aborted for subscription {subscription_id}: {e}")
        sync_state.status = SyncStatus.FAILED
        sync_state.error_message = str(e)
        _clear_progress(sync_state)
        db.commit()
    except Exception as e:
        logger.exception("Error syncing movies")
        sync_state.status = SyncStatus.FAILED
        sync_state.error_message = str(e)
        _clear_progress(sync_state)
        db.commit()
        raise

async def process_series(db: Session, xc, fm: FileManager, subscription_id: int):
    """See ``process_movies``: `xc` is any catalogue adapter."""
    # Get settings
    from app.models.settings import SettingsModel
    settings_rows = db.query(SettingsModel).all()
    settings = {s.key: s.value for s in settings_rows}
    
    prefix_regex = settings.get("PREFIX_REGEX")
    format_date = settings.get("FORMAT_DATE_IN_TITLE") == "true"
    clean_name = settings.get("CLEAN_NAME") == "true"
    
    use_season_folders = settings.get("SERIES_USE_SEASON_FOLDERS", "true") == "true"
    include_series_name = settings.get("SERIES_INCLUDE_NAME_IN_FILENAME", "false") == "true"
    use_category_folders = settings.get("SERIES_USE_CATEGORY_FOLDERS", "true") == "true"

    # Update status
    sync_state = db.query(SyncState).filter(
        SyncState.subscription_id == subscription_id,
        SyncState.type == SyncType.SERIES
    ).first()
    
    if not sync_state:
        sync_state = SyncState(subscription_id=subscription_id, type=SyncType.SERIES)
        db.add(sync_state)
    
    sync_state.status = SyncStatus.RUNNING
    sync_state.last_sync = datetime.utcnow()
    sync_state.progress_phase = "Reading the provider catalogue"
    sync_state.progress_done = 0
    sync_state.progress_total = 0
    db.commit()

    try:
        categories = await xc.get_series_categories()
        cat_map = {str(c['category_id']): c['category_name'] for c in categories}

        all_series = await xc.get_series()

        # Applied unconditionally — see the matching comment in process_movies:
        # an empty selection means nothing is wanted, so everything cached for
        # this subscription falls into the deletion pass below.
        selected_cats = db.query(SelectedCategory).filter(
            SelectedCategory.subscription_id == subscription_id,
            SelectedCategory.type == "series"
        ).all()

        selected_ids = {str(s.category_id) for s in selected_cats}
        fetched_series = all_series
        all_series = [s for s in all_series if str(s.get('category_id')) in selected_ids]

        corrected = _apply_tmdb_overrides(
            load_overrides(db, subscription_id, "series"), all_series, "series_id")
        if corrected:
            logger.info(f"{corrected} series use a hand-corrected TMDB id.")

        cached_series = {s.series_id: s for s in db.query(SeriesCache).filter(SeriesCache.subscription_id == subscription_id).all()}

        _guard_against_empty_catalogue(
            "series", fetched_series, all_series, selected_ids, len(cached_series)
        )
        
        to_add_update = []
        to_delete = []
        current_ids = set()

        signature = _layout_signature("series", settings, use_category_folders)
        layout_changed = (sync_state.layout_signature or "") != signature
        if layout_changed:
            logger.info(f"Series layout signature changed for subscription {subscription_id}; rebuilding.")

        # Two series listed under one name would otherwise share a folder and
        # interleave their episodes — the same defect as the movie side.
        series_suffixes = _disambiguate_paths(
            all_series, "series_id",
            lambda s: fm.get_series_target_info(
                s, cat_map.get(str(s.get('category_id')), "Uncategorized"),
                prefix_regex, format_date, clean_name, use_category_folders
            )["series_dir"],
        )
        if series_suffixes:
            logger.info(
                f"{len(series_suffixes)} series share a name with another entry "
                f"and were given a numbered suffix."
            )

        def _series_dir(series_id, name, tmdb_id, category_id):
            return fm.get_series_target_info(
                {"name": name, "tmdb": tmdb_id},
                cat_map.get(str(category_id), "Uncategorized"),
                prefix_regex, format_date, clean_name, use_category_folders,
                disambiguator=series_suffixes.get(series_id, ""),
            )["series_dir"]

        try:
            refresh_hours = float(settings.get("SERIES_REFRESH_HOURS",
                                               _DEFAULT_SERIES_REFRESH_HOURS))
        except (TypeError, ValueError):
            refresh_hours = _DEFAULT_SERIES_REFRESH_HOURS
        refresh_after = timedelta(hours=max(refresh_hours, 0))

        for series in all_series:
            series_id = int(series['series_id'])
            current_ids.add(series_id)

            cached = cached_series.get(series_id)
            if not cached:
                to_add_update.append(series)
            elif cached.name != series['name'] or layout_changed:
                to_add_update.append(series)
            elif _tmdb_override_moved(series, cached):
                # The user corrected this show's TMDB id since it was written.
                to_add_update.append(series)
            elif _needs_episode_refresh(cached, _provider_stamp(series), refresh_after):
                # An episode list is only ever discovered by asking for it.
                to_add_update.append(series)
            elif not os.path.isdir(_series_dir(series_id, cached.name, cached.tmdb_id, cached.category_id)):
                # Folder gone — deleted by hand, or the layout settings changed.
                # Rebuild rather than trust the cache. See the movie equivalent.
                to_add_update.append(series)

        for series_id, cached in cached_series.items():
            if series_id not in current_ids:
                to_delete.append(cached)

        # Where each still-wanted cached series lives right now, captured before
        # the cache rows are rewritten. A series is kept as a whole directory:
        # unless it was reprocessed this run, its episode list is unknown, so
        # its folder must survive the sweep untouched.
        pre_sync_dirs = {
            series_id: _series_dir(series_id, cached.name, cached.tmdb_id, cached.category_id)
            for series_id, cached in cached_series.items()
            if series_id in current_ids
        }

        # Deletions
        if to_delete:
            _set_progress(db, sync_state, f"Removing {len(to_delete)} series")
        for series in to_delete:
            cat_name = cat_map.get(str(series.category_id), "Uncategorized")
            target_info = fm.get_series_target_info(
                {"name": series.name, "tmdb": series.tmdb_id},
                cat_name, prefix_regex, format_date, clean_name, use_category_folders
            )
            
            # A series normally owns its folder, so this is still a recursive
            # removal — but it is now refused if the path ever collapses onto
            # a shared directory (which an empty sanitized title would cause).
            await fm.remove_media_target(target_info, dir_key="series_dir")

            await fm.delete_directory_if_empty(target_info["cat_dir"])
            db.delete(series)

        # Process Additions/Updates Parallel
        try:
            parallelism = int(settings.get("SYNC_PARALLELISM_SERIES", "5"))
        except ValueError:
            parallelism = 5

        batch_size = parallelism
        semaphore = asyncio.Semaphore(batch_size)

        async def process_single_series(series):
            async with semaphore:
                try:
                    series_id = int(series['series_id'])
                    name = series['name']
                    cat_id = series['category_id']
                    tmdb_id = series.get('tmdb')

                    # Fetch Episodes and Info. Every field is coerced: this
                    # provider returns `[]` where an object is promised, and an
                    # unguarded `.get` on it aborts the series mid-write.
                    info_response = await xc.get_series_info(str(series_id))
                    if not isinstance(info_response, dict):
                        info_response = {}
                    series_info = fm._as_dict(info_response.get('info'))
                    episodes_data = info_response.get('episodes', {})

                    if not isinstance(episodes_data, dict):
                        episodes_data = {}

                    # Same rule as the movie side: a correction the user has
                    # made is not overwritten by the provider's own answer.
                    if series_info.get('tmdb_id') and not series.get('_tmdb_override'):
                         tmdb_id = series_info.get('tmdb_id')
                         series['tmdb'] = tmdb_id # For NFO

                    cat_name = cat_map.get(str(cat_id), "Uncategorized")
                    target_info = fm.get_series_target_info(
                        series, cat_name, prefix_regex, format_date, clean_name,
                        use_category_folders,
                        disambiguator=series_suffixes.get(series_id, ""),
                    )

                    if use_category_folders:
                        fm.ensure_directory(target_info["cat_dir"])

                    series_dir = target_info["series_dir"]
                    fm.ensure_directory(series_dir)

                    # Every file this series is made of. The sweep keeps exactly
                    # these, so an episode the provider dropped — or the whole
                    # former folder after a rename — is cleaned up.
                    written = set()

                    # Always create tvshow.nfo
                    nfo_path = f"{series_dir}/tvshow.nfo"
                    await fm.write_nfo(nfo_path, fm.generate_show_nfo(series, prefix_regex, format_date, clean_name))
                    written.add(nfo_path)

                    for season_key, episodes in episodes_data.items():
                        if not isinstance(episodes, list):
                            continue
                        try:
                            season_num = int(season_key)
                        except (TypeError, ValueError):
                            continue

                        # SEASON FOLDERS LOGIC
                        if use_season_folders:
                            season_dir_name = f"Season {season_num:02d}"
                            current_dir = f"{series_dir}/{season_dir_name}"
                        else:
                            current_dir = series_dir

                        fm.ensure_directory(current_dir)

                        for ep in episodes:
                            if not isinstance(ep, dict):
                                continue
                            ep_num = int(ep['episode_num'])
                            ep_id = ep['id']
                            container = ep['container_extension']
                            title = ep.get('title', '')
                            
                            # Clean Episode Title
                            # 1. Provide a hook to remove Series Name if it's prefixed
                            # Just minimal heuristic: if title starts with series name, strip it
                            # But risky. Let's rely on standard logic for now.
                            
                            formatted_ep = f"S{season_num:02d}E{ep_num:02d}"
                            safe_ep_title = ""

                            if title:
                                # Remove extension if present in title
                                if title.lower().endswith(f".{container}"):
                                    title = title[:-len(container)-1]

                                # Drop what the path and the S00E00 prefix
                                # already say. Both the provider's raw series
                                # name and our cleaned one are tried.
                                title = fm.clean_episode_title(
                                    title,
                                    (name, target_info['cleaned_title'], target_info['safe_series_name']),
                                    clean_name,
                                )
                                safe_ep_title = fm.sanitize_name(title) if title else ""

                            if include_series_name:
                                 filename_base = f"{target_info['safe_series_name']} - {formatted_ep}"
                            else:
                                 filename_base = formatted_ep
                                 
                            if safe_ep_title:
                                 filename = f"{filename_base} - {safe_ep_title}"
                            else:
                                 filename = filename_base
                            
                            strm_path = f"{current_dir}/{filename}.strm"
                            url = xc.get_stream_url("series", str(ep_id), container)
                            await fm.write_strm(strm_path, url)
                            written.add(strm_path)

                            # Episode NFO
                            ep_nfo_path = f"{current_dir}/{filename}.nfo"
                            ep_nfo_content = fm.generate_episode_nfo(ep, name, season_num, ep_num)
                            await fm.write_nfo(ep_nfo_path, ep_nfo_content)
                            written.add(ep_nfo_path)

                    return {
                        'action': 'update_cache',
                        'paths': written,
                        'data': {
                            'series_id': series_id,
                            'name': name,
                            'category_id': cat_id,
                            'tmdb_id': str(tmdb_id) if tmdb_id else None,
                            # Recorded only on success, so a failed refresh is
                            # retried on the next run instead of being written
                            # off as up to date.
                            'last_modified': _provider_stamp(series),
                        }
                    }
                except Exception as e:
                     logger.error(f"Error processing series {series.get('name')}: {e}")
                     # Signal the failure so the sweep keeps this series' folder
                     # rather than deleting what it just failed to rewrite.
                     try:
                         failed_id = int(series['series_id'])
                     except (KeyError, TypeError, ValueError):
                         failed_id = None
                     return {'action': 'failed', 'series_id': failed_id}

        chunk_size = 20
        keep_files = set()
        reprocessed_ids = set()

        _set_progress(db, sync_state, "Writing series", done=0, total=len(to_add_update))

        for i in range(0, len(to_add_update), chunk_size):
            chunk = to_add_update[i:i + chunk_size]
            results = await asyncio.gather(*[process_single_series(s) for s in chunk])

            for res in results:
                if res and res['action'] == 'update_cache':
                    d = res['data']
                    keep_files |= res['paths']
                    reprocessed_ids.add(d['series_id'])
                    cached = cached_series.get(d['series_id'])
                    if not cached:
                        cached = SeriesCache(subscription_id=subscription_id, series_id=d['series_id'])
                        db.add(cached)

                    cached.name = d['name']
                    cached.category_id = d['category_id']
                    cached.tmdb_id = d['tmdb_id']
                    cached.last_modified = d['last_modified']
                    cached.last_refreshed = datetime.utcnow()

            sync_state.progress_done = i + len(chunk)
            db.commit()

        # A series not reprocessed this run — unchanged, or a failed refresh —
        # keeps its whole folder: we never asked the provider for its episode
        # list, so we cannot tell its files apart from stale ones.
        keep_trees = {
            series_dir
            for series_id, series_dir in pre_sync_dirs.items()
            if series_id not in reprocessed_ids
        }

        _set_progress(db, sync_state, "Cleaning up the library")

        await fm.sweep_generated_files(
            keep_files,
            keep_trees=keep_trees,
            protected_roots=_protected_roots(db, subscription_id, fm.output_dir)
        )

        sync_state.items_deleted = len(to_delete)
        _record_outcome(sync_state, attempted=len(to_add_update), succeeded=len(reprocessed_ids))
        if sync_state.status == SyncStatus.SUCCESS:
            sync_state.layout_signature = signature
        _clear_progress(sync_state)
        db.commit()

    except SyncAborted as e:
        logger.warning(f"Series sync aborted for subscription {subscription_id}: {e}")
        sync_state.status = SyncStatus.FAILED
        sync_state.error_message = str(e)
        _clear_progress(sync_state)
        db.commit()
    except Exception as e:
        logger.exception("Error syncing series")
        sync_state.status = SyncStatus.FAILED
        sync_state.error_message = str(e)
        _clear_progress(sync_state)
        db.commit()
        raise

def _record_source_run(db: Session, sub: Subscription) -> None:
    """Stamp the source itself with the outcome of the run that just ended.

    The per-type rows in `sync_state` stay authoritative — this is the one-line
    summary the sources screen shows, and, for an M3U source, what tells the
    parser its playlist was read recently enough.
    """
    states = db.query(SyncState).filter(SyncState.subscription_id == sub.id).all()
    if any(s.status == SyncStatus.FAILED for s in states):
        sub.sync_status = "error"
    elif any(s.status == SyncStatus.PARTIAL for s in states):
        sub.sync_status = "partial"
    else:
        sub.sync_status = "success"
    sub.last_sync = datetime.utcnow()
    db.commit()


@celery_app.task
def sync_movies_task(subscription_id: int, force: bool = False):
    db = SessionLocal()
    try:
        sub = db.query(Subscription).filter(Subscription.id == subscription_id).first()
        if not sub:
            logger.error(f"Subscription {subscription_id} not found")
            return "Subscription not found"

        if not sub.is_active:
            logger.info(f"Subscription {sub.name} is inactive")
            return "Subscription inactive"

        # The only line that knows an M3U source from an Xtream one.
        xc = get_catalog(db, sub, force_reparse=force)
        fm = FileManager(sub.movies_dir)

        sub.sync_status = "syncing"
        db.commit()

        asyncio.run(process_movies(db, xc, fm, subscription_id))
        _record_source_run(db, sub)
        return f"Movies synced successfully for {sub.name}"
    finally:
        db.close()

@celery_app.task
def sync_series_task(subscription_id: int, force: bool = False):
    db = SessionLocal()
    try:
        sub = db.query(Subscription).filter(Subscription.id == subscription_id).first()
        if not sub:
            logger.error(f"Subscription {subscription_id} not found")
            return "Subscription not found"

        if not sub.is_active:
            logger.info(f"Subscription {sub.name} is inactive")
            return "Subscription inactive"

        xc = get_catalog(db, sub, force_reparse=force)
        fm = FileManager(sub.series_dir)

        sub.sync_status = "syncing"
        db.commit()

        asyncio.run(process_series(db, xc, fm, subscription_id))
        _record_source_run(db, sub)
        return f"Series synced successfully for {sub.name}"
    finally:
        db.close()

@celery_app.task
def check_schedules_task():
    """Check schedules and trigger syncs if needed"""
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        # Get enabled schedules that are due
        schedules = db.query(Schedule).filter(
            Schedule.enabled == True,
            Schedule.next_run <= now
        ).all()
        
        for schedule in schedules:
            # Create execution record
            execution = ScheduleExecution(
                schedule_id=schedule.id,
                status=ExecutionStatus.RUNNING
            )
            db.add(execution)
            db.commit()
            
            try:
                # Trigger appropriate sync
                if schedule.type == ScheduleSyncType.MOVIES:
                    result = sync_movies_task.apply_async(args=[schedule.subscription_id])
                else:
                    result = sync_series_task.apply_async(args=[schedule.subscription_id])
                
                # Update execution status
                execution.status = ExecutionStatus.SUCCESS
                execution.completed_at = datetime.utcnow()
                
                # Get items processed from sync state
                sync_state = db.query(SyncState).filter(
                    SyncState.subscription_id == schedule.subscription_id,
                    SyncState.type == (SyncType.MOVIES if schedule.type == ScheduleSyncType.MOVIES else SyncType.SERIES)
                ).first()
                if sync_state:
                    execution.items_processed = (sync_state.items_added or 0) + (sync_state.items_deleted or 0)
                
            except Exception as e:
                logger.exception(f"Error executing scheduled sync for {schedule.type}")
                execution.status = ExecutionStatus.FAILED
                execution.error_message = str(e)
                execution.completed_at = datetime.utcnow()
            
            # Update schedule for next run
            schedule.last_run = now
            schedule.next_run = schedule.calculate_next_run()
            db.commit()
            
    finally:
        db.close()
