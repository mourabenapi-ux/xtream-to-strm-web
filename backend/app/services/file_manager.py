import logging
import os
import shutil
import aiofiles
import re
from typing import Dict, Iterable, Optional

logger = logging.getLogger(__name__)

class FileManager:
    # The only extensions this application ever creates in a library folder.
    # The disk sweep is restricted to these: anything else under the library was
    # put there by someone else and is never ours to delete.
    GENERATED_SUFFIXES = (".strm", ".nfo")

    def __init__(self, output_dir: str):
        self.output_dir = output_dir

    def sanitize_name(self, name: str) -> str:
        # Replace invalid characters with underscore
        sanitized = re.sub(r'[\\/:*?"<>|]', '_', name or '')

        # Leading/trailing dots and spaces are stripped by Windows and would
        # silently change the path we think we wrote to.
        sanitized = sanitized.strip().strip('.').strip()

        # Truncate to max 200 characters to ensure full path stays under 255
        # (leaving room for directory path, extension, etc.)
        max_length = 200
        if len(sanitized) > max_length:
            sanitized = sanitized[:max_length]

        # Never return an empty segment: os.path.join(parent, "") collapses to
        # the parent itself, which would point file and directory operations at
        # the shared library folder.
        return sanitized or "Unknown"


    def ensure_directory(self, path: str):
        os.makedirs(path, exist_ok=True)

    async def write_strm(self, path: str, url: str):
        async with aiofiles.open(path, 'w') as f:
            await f.write(url)

    async def write_nfo(self, path: str, content: str):
        async with aiofiles.open(path, 'w') as f:
            await f.write(content)

    async def delete_file(self, path: str):
        if os.path.exists(path):
            os.remove(path)

    async def delete_directory_if_empty(self, path: str):
        try:
            os.rmdir(path)
        except OSError:
            pass # Directory not empty

    async def remove_media_target(self, target_info: dict, dir_key: str = "target_dir") -> None:
        """Delete the files generated for a single movie or series.

        Only a directory that belongs to this item alone is removed
        recursively. When the item was written directly into a shared folder —
        no tmdb id, or category folders disabled — `target_dir` *is* the whole
        library directory, so only that item's own files are deleted.

        Removing the directory in that case wiped every other title in it.
        """
        target_dir = target_info[dir_key]

        if target_info.get("has_own_folder"):
            # Refuse the destructive path for anything that is still a shared
            # directory, whatever the flag claims.
            shared = {
                os.path.abspath(self.output_dir),
                os.path.abspath(target_info.get("base_parent_dir") or self.output_dir),
                os.path.abspath(target_info.get("cat_dir") or self.output_dir),
            }
            if os.path.abspath(target_dir) in shared:
                logger.error(
                    f"Refusing to remove shared directory {target_dir}; "
                    "deleting this item's files only."
                )
            elif os.path.exists(target_dir):
                shutil.rmtree(target_dir)
                return

        filename_base = target_info.get("filename_base") or target_info.get("folder_name")
        if not filename_base:
            return

        for extension in (".strm", ".nfo"):
            await self.delete_file(os.path.join(target_dir, f"{filename_base}{extension}"))

    @staticmethod
    def _as_dict(value) -> dict:
        """Coerce a provider field that is *supposed* to be an object.

        `payload.get('info', {})` only falls back when the key is missing, so a
        literal `"info": []` sails straight through and raises on the next
        `.get`. Measured on one provider: 89 of 98 episodes carried `"info": []`
        — every episode after the first — which aborted the whole series
        mid-write and lost every subscription's series sync while still
        reporting success.
        """
        if isinstance(value, dict):
            return value
        # A list of streams where a single object is expected: the first entry
        # is the one the schema describes.
        if isinstance(value, list) and value and isinstance(value[0], dict):
            return value[0]
        return {}

    @staticmethod
    def _is_within(path: str, root: str) -> bool:
        path = os.path.abspath(path)
        root = os.path.abspath(root)
        return path == root or path.startswith(root + os.sep)

    async def sweep_generated_files(
        self,
        keep_files: Iterable[str],
        keep_trees: Optional[Iterable[str]] = None,
        protected_roots: Optional[Iterable[str]] = None,
    ) -> Dict[str, int]:
        """Delete generated files under the library that this sync did not keep.

        The per-item deletion pass can only remove what the database remembers,
        under the name it remembers. A title renamed by the provider, or a cache
        row lost, leaves a folder no future sync can ever find again — measured
        at 219 orphans on the live library, and the reason an empty selection
        still left 173 folders behind.

        This closes that hole from the other side: whatever the walk finds that
        the sync did not account for is stale by definition. It makes the
        generator idempotent, so an empty selection really does empty the
        library.

        `keep_files` are the exact files this sync wrote or deliberately left
        alone; `keep_trees` are directories kept whole (a series that was not
        reprocessed, so its episode list is unknown); `protected_roots` are
        directories belonging to another subscription or to the downloader,
        which are never descended into.
        """
        root = os.path.abspath(self.output_dir)
        result = {"files_removed": 0, "dirs_removed": 0}

        # A library that is the filesystem root, or that does not exist, is a
        # configuration error — never a licence to walk it.
        if not os.path.isdir(root) or root == os.sep or os.path.dirname(root) == root:
            logger.error(f"Refusing to sweep {root!r}: not a usable library directory.")
            return result

        keep = {os.path.abspath(p) for p in keep_files}
        trees = {os.path.abspath(p) for p in (keep_trees or ())}
        protected = {os.path.abspath(p) for p in (protected_roots or ())}

        # A protected root that contains the library would make the whole sweep
        # a no-op; one *inside* it is the normal case and is skipped below.
        if any(self._is_within(root, p) for p in protected):
            logger.error(
                f"Refusing to sweep {root!r}: it sits inside a directory owned by "
                "another subscription or by the downloader."
            )
            return result

        # A kept tree that *is* the library turns the whole sweep into a silent
        # no-op. sanitize_name makes this unreachable, but say so if it happens.
        if root in trees:
            logger.warning(
                f"Sweep of {root!r} skipped: an item claims the library itself as "
                "its own folder."
            )
            return result

        def _skip(directory: str) -> bool:
            return (
                directory in protected
                or any(self._is_within(directory, t) for t in trees)
            )

        for dirpath, dirnames, filenames in os.walk(root, topdown=True):
            abs_dir = os.path.abspath(dirpath)
            if _skip(abs_dir):
                dirnames[:] = []  # do not descend
                continue

            for name in filenames:
                if not name.endswith(self.GENERATED_SUFFIXES):
                    continue
                full = os.path.join(abs_dir, name)
                if full in keep:
                    continue
                try:
                    os.remove(full)
                    result["files_removed"] += 1
                except OSError as e:
                    logger.warning(f"Could not remove stale file {full}: {e}")

        # Prune what the removals emptied, deepest first. rmdir only succeeds on
        # an empty directory, so a folder still holding anything survives.
        for dirpath, _dirnames, _filenames in os.walk(root, topdown=False):
            abs_dir = os.path.abspath(dirpath)
            if abs_dir == root or _skip(abs_dir):
                continue
            try:
                os.rmdir(abs_dir)
                result["dirs_removed"] += 1
            except OSError:
                pass  # not empty

        if result["files_removed"] or result["dirs_removed"]:
            logger.info(
                f"Swept {root}: removed {result['files_removed']} stale file(s) "
                f"and {result['dirs_removed']} empty folder(s)."
            )
        return result

    def clean_title(self, title: str, prefix_regex: Optional[str] = None, format_date: bool = False, clean_name: bool = False) -> str:
        """Centralized logic to clean media titles based on settings"""
        if not title:
            return "Unknown"
            
        # Strip language prefix
        regex = prefix_regex if prefix_regex else r'^(?:[A-Za-z0-9.-]+_|[A-Za-z]{2,}\s*-\s*)'
        try:
            title = re.sub(regex, '', title)
        except re.error:
            title = re.sub(r'^(?:[A-Za-z0-9.-]+_|[A-Za-z]{2,}\s*-\s*)', '', title)
            
        # Format date at end (e.g. "Movie_2024" -> "Movie (2024)")
        if format_date:
            title = re.sub(r'[_\s](\d{4})$', r' (\1)', title)
            
        # Clean name (underscores to spaces)
        if clean_name:
            title = title.replace('_', ' ')
            
        return title.strip()

    # "S01E02", "s1e2", "1x02" — the episode code, wherever the provider put it.
    # The boundaries exclude only letters and digits, not `_`: `\b` treats the
    # underscore as a word character, so it missed "Saha_Bro_S01E01" entirely.
    # Requiring a non-alphanumeric on both sides also keeps "1920x1080" intact.
    _EPISODE_CODE = re.compile(
        r'(?<![A-Za-z0-9])(?:s\s*\d{1,3}\s*[ex]\s*\d{1,4}|\d{1,3}x\d{1,4})(?![A-Za-z0-9])',
        re.IGNORECASE,
    )
    # Separator debris left behind once pieces are removed.
    _EDGE_JUNK = re.compile(r'^[\s\-–—_.:|]+|[\s\-–—_.:|]+$')

    def clean_episode_title(self, title: str, series_names: Iterable[str],
                            clean_name: bool = False) -> str:
        """Reduce a provider episode title to the episode's own name.

        Providers repeat everything they know in the title, so appending it raw
        after our own `S01E01 - ` produced names like
        `S01E01 - AMZ - 007_ Road to a Million - S01E01 - EPISODE ONE.strm`.
        The series name and the episode code are already carried by the path and
        the filename prefix, so both are stripped here.

        `PREFIX_REGEX` is deliberately *not* applied: it is tuned for stream
        names like "FR - Title" and happily eats the front of a real episode
        title ("Saha_Bro_S01E01" -> "Bro S01E01").
        """
        if not title:
            return ""

        cleaned = title
        # Longest first, so "Show - Season 2" is consumed before "Show".
        for name in sorted((n for n in series_names if n), key=len, reverse=True):
            pattern = re.compile(re.escape(name), re.IGNORECASE)
            if pattern.search(cleaned):
                cleaned = pattern.sub(" ", cleaned)

        cleaned = self._EPISODE_CODE.sub(" ", cleaned)
        cleaned = re.sub(r'\s{2,}', ' ', cleaned)
        cleaned = self._EDGE_JUNK.sub('', cleaned)

        if clean_name:
            cleaned = cleaned.replace('_', ' ')
            cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip()

        # A leftover that is only the episode number carries nothing the
        # filename does not already say.
        if re.fullmatch(r'\d{1,4}', cleaned or ''):
            return ""

        return cleaned

    def get_movie_target_info(self, movie_data: dict, cat_name: str, prefix_regex: Optional[str] = None, format_date: bool = False, clean_name: bool = False, use_category_folders: bool = True, disambiguator: str = "") -> dict:
        """Determine target directory and filename for a movie

        `disambiguator` is appended to the title when two catalogue entries
        would otherwise resolve to one path — the provider lists some titles
        under several stream ids, and the second silently overwrote the first
        (94 cached movies produced 93 files). The caller decides the value and
        must keep it stable across syncs; see _disambiguate_paths in
        tasks/sync.py.
        """
        name = movie_data.get('name', 'Unknown')
        o_name = movie_data.get('o_name')
        tmdb_id = movie_data.get('tmdb') or movie_data.get('tmdb_id', '')

        # Priority for cleaning: o_name > name
        title_to_clean = o_name or name
        cleaned_title = self.clean_title(title_to_clean, prefix_regex, format_date, clean_name)

        safe_cat = self.sanitize_name(cat_name)
        safe_title = self.sanitize_name(cleaned_title)
        if disambiguator:
            # Before the tmdb tag, never after: Jellyfin reads the tag, and
            # trailing text past it is not reliably ignored.
            safe_title = f"{safe_title} {disambiguator}"

        cat_dir = os.path.join(self.output_dir, safe_cat)
        
        if use_category_folders:
            base_parent_dir = cat_dir
        else:
            base_parent_dir = self.output_dir

        # Every movie gets its own folder, tmdb id or not. Untagged movies used
        # to be written straight into the shared parent, which left the library
        # a mix of `{tmdb-…}` folders and loose files — measured at 92 of 94
        # movies on one subscription, the shape Jellyfin matches least reliably.
        # A folder per movie is also what makes deletion safe: `has_own_folder`
        # is then always true, so removing a title never touches a shared dir.
        if tmdb_id and str(tmdb_id) not in ['0', 'None', 'null', '']:
            folder_name = f"{safe_title} {{tmdb-{tmdb_id}}}"
        else:
            folder_name = safe_title

        target_dir = os.path.join(base_parent_dir, folder_name)
        filename_base = folder_name

        return {
            "cat_dir": cat_dir,
            "target_dir": target_dir,
            "base_parent_dir": base_parent_dir,
            "filename_base": filename_base,
            # True only when target_dir belongs to this movie alone, and is
            # therefore safe to remove recursively. Callers must check this
            # before any rmtree: when it is False, target_dir is the whole
            # library folder.
            "has_own_folder": os.path.abspath(target_dir) != os.path.abspath(base_parent_dir),
            "cleaned_title": cleaned_title,
            "tmdb_id": tmdb_id if tmdb_id and str(tmdb_id) not in ['0', 'None', 'null', ''] else None
        }

    def get_series_target_info(self, series_data: dict, cat_name: str, prefix_regex: Optional[str] = None, format_date: bool = False, clean_name: bool = False, use_category_folders: bool = True, disambiguator: str = "") -> dict:
        """Determine target directory and base folder name for a series

        `disambiguator` behaves as in get_movie_target_info: two series the
        provider lists under one name would otherwise share a folder and
        interleave their episodes.
        """
        name = series_data.get('name', 'Unknown')
        o_name = series_data.get('o_name')
        tmdb_id = series_data.get('tmdb') or series_data.get('tmdb_id', '')

        title_to_clean = o_name or name
        cleaned_title = self.clean_title(title_to_clean, prefix_regex, format_date, clean_name)

        safe_cat = self.sanitize_name(cat_name)
        safe_title = self.sanitize_name(cleaned_title)
        if disambiguator:
            safe_title = f"{safe_title} {disambiguator}"

        if use_category_folders:
            base_parent_dir = os.path.join(self.output_dir, safe_cat)
        else:
            base_parent_dir = self.output_dir
            
        if tmdb_id and str(tmdb_id) not in ['0', 'None', 'null', '']:
            folder_name = f"{safe_title} {{tmdb-{tmdb_id}}}"
        else:
            folder_name = safe_title
            
        series_dir = os.path.join(base_parent_dir, folder_name)

        return {
            "cat_dir": os.path.join(self.output_dir, safe_cat),
            "series_dir": series_dir,
            "base_parent_dir": base_parent_dir,
            "folder_name": folder_name,
            # A series normally always gets its own folder, but an empty
            # sanitized title would collapse series_dir onto the parent.
            "has_own_folder": os.path.abspath(series_dir) != os.path.abspath(base_parent_dir),
            "cleaned_title": cleaned_title,
            "safe_series_name": safe_title,
            "tmdb_id": tmdb_id if tmdb_id and str(tmdb_id) not in ['0', 'None', 'null', ''] else None
        }

    def generate_movie_nfo(self, movie_data: dict, prefix_regex: Optional[str] = None, format_date: bool = False, clean_name: bool = False) -> str:
        """Generate NFO file for a movie with comprehensive metadata"""
        tmdb_id = movie_data.get('tmdb') or movie_data.get('tmdb_id', '')
        title = self.clean_title(movie_data.get('o_name') or movie_data.get('name', 'Unknown'), prefix_regex, format_date, clean_name)
        
        plot = movie_data.get('plot') or movie_data.get('description', '')
        year = movie_data.get('year') or movie_data.get('releasedate', '')
        rating = movie_data.get('rating') or movie_data.get('rating_5based', '')
        genre = movie_data.get('genre', '')
        director = movie_data.get('director', '')
        cast_list = movie_data.get('cast') or movie_data.get('actors', '')
        duration = movie_data.get('duration') or movie_data.get('episode_run_time', '')
        trailer = movie_data.get('youtube_trailer', '')
        cover = movie_data.get('movie_image') or movie_data.get('cover_big') or movie_data.get('stream_icon') or movie_data.get('backdrop_path_original', '')
        
        # Handle backdrop/fanart
        backdrop_path = movie_data.get('backdrop_path', [])
        fanart = backdrop_path[0] if isinstance(backdrop_path, list) and backdrop_path else ''
        
        nfo = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<movie>\n'
        
        nfo += f'  <title>{self._escape_xml(title)}</title>\n'
        nfo += f'  <originaltitle>{self._escape_xml(movie_data.get("o_name", ""))}</originaltitle>\n'
        
        # TMDB / IMDB IDs
        if tmdb_id and str(tmdb_id) not in ['0', 'None', 'null', '']:
            nfo += f'  <tmdbid>{tmdb_id}</tmdbid>\n'
            nfo += f'  <uniqueid type="tmdb" default="true">{tmdb_id}</uniqueid>\n'
        
        # Try to find IMDB ID in info if available
        # (This usually requires detailed info fetch)
        
        if plot:
            nfo += f'  <plot>{self._escape_xml(plot)}</plot>\n'
            nfo += f'  <outline>{self._escape_xml(plot[:200])}</outline>\n'
        
        if year:
            year_str = str(year)[:4] if len(str(year)) >= 4 else str(year)
            nfo += f'  <year>{year_str}</year>\n'
            nfo += f'  <premiered>{year_str}-01-01</premiered>\n'
        
        # Ratings
        if rating:
            try:
                r_val = float(rating)
                # If it was 5-based, convert
                if movie_data.get('rating_5based'):
                    r_val *= 2
                
                nfo += '  <ratings>\n'
                nfo += f'    <rating name="tmdb" default="true"><value>{r_val:.1f}</value></rating>\n'
                nfo += '  </ratings>\n'
                nfo += f'  <userrating>{int(round(r_val))}</userrating>\n'
            except (ValueError, TypeError):
                pass
        
        # Genre
        if genre:
            # Split by comma or slash
            for g in re.split(r'[,/]', str(genre)):
                g_str = g.strip()
                if g_str:
                    nfo += f'  <genre>{self._escape_xml(g_str)}</genre>\n'
        
        # Director
        if director:
            nfo += f'  <director>{self._escape_xml(director)}</director>\n'
        
        # Cast
        if cast_list:
            for actor in str(cast_list).split(','):
                actor_name = actor.strip()
                if actor_name:
                    nfo += f'  <actor><name>{self._escape_xml(actor_name)}</name></actor>\n'
        
        # Duration
        if duration:
            try:
                total_mins = 0
                if ':' in str(duration):
                    parts = str(duration).split(':')
                    total_mins = int(parts[0]) * 60 + int(parts[1])
                else:
                    total_mins = int(duration)
                nfo += f'  <runtime>{total_mins}</runtime>\n'
            except (ValueError, TypeError, IndexError):
                pass

        # Stream Details (Video/Audio)
        # Usually from detailed info 'info' dict
        info = self._as_dict(movie_data.get('info'))
        nfo += '  <fileinfo>\n    <streamdetails>\n'
        
        # Video
        nfo += '      <video>\n'
        nfo += f'        <codec>{self._escape_xml(movie_data.get("container_extension", ""))}</codec>\n'
        if info.get('videoing'): # Check if present
             pass # Use info from API if mapped
        if info.get('bitrate'):
             nfo += f'        <bitrate>{info.get("bitrate")}</bitrate>\n'
        nfo += '      </video>\n'
        
        # Audio
        audio = self._as_dict(info.get('audio'))
        if audio:
             nfo += '      <audio>\n'
             nfo += f'        <codec>{self._escape_xml(audio.get("codec", ""))}</codec>\n'
             nfo += '      </audio>\n'
             
        nfo += '    </streamdetails>\n  </fileinfo>\n'

        if trailer:
            nfo += f'  <trailer>plugin://plugin.video.youtube/?action=play_video&amp;videoid={trailer}</trailer>\n'
        
        if cover:
            nfo += f'  <thumb>{cover}</thumb>\n'
        
        if fanart:
            nfo += f'  <fanart><thumb>{fanart}</thumb></fanart>\n'
        elif cover:
            nfo += f'  <fanart><thumb>{cover}</thumb></fanart>\n'
            
        # MPAA
        mpaa = movie_data.get('mpaa') or info.get('mpaa')
        if mpaa:
             nfo += f'  <mpaa>{self._escape_xml(mpaa)}</mpaa>\n'
        
        nfo += '</movie>'
        return nfo


    def generate_show_nfo(self, series_data: dict, prefix_regex: Optional[str] = None, format_date: bool = False, clean_name: bool = False) -> str:
        """Generate NFO file for a TV show"""
        tmdb_id = series_data.get('tmdb') or series_data.get('tmdb_id', '')
        title = self.clean_title(series_data.get('o_name') or series_data.get('name', 'Unknown'), prefix_regex, format_date, clean_name)
        
        plot = series_data.get('plot') or series_data.get('description', '')
        year = series_data.get('year') or series_data.get('releaseDate', '')
        rating = series_data.get('rating') or series_data.get('rating_5based', '')
        genre = series_data.get('genre', '')
        cast_list = series_data.get('cast') or series_data.get('actors', '')
        director = series_data.get('director', '')
        cover = series_data.get('cover') or series_data.get('cover_big') or series_data.get('stream_icon') or series_data.get('backdrop_path_original', '')
        
        backdrop_path = series_data.get('backdrop_path', [])
        fanart = backdrop_path[0] if isinstance(backdrop_path, list) and backdrop_path else ''
        
        nfo = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<tvshow>\n'
        
        nfo += f'  <title>{self._escape_xml(title)}</title>\n'
        
        if tmdb_id and str(tmdb_id) not in ['0', 'None', 'null', '']:
             nfo += f'  <tmdbid>{tmdb_id}</tmdbid>\n'
             nfo += f'  <uniqueid type="tmdb" default="true">{tmdb_id}</uniqueid>\n'

        if plot:
            nfo += f'  <plot>{self._escape_xml(plot)}</plot>\n'
        
        if year:
            year_str = str(year)[:4] if len(str(year)) >= 4 else str(year)
            nfo += f'  <year>{year_str}</year>\n'
            nfo += f'  <premiered>{year_str}-01-01</premiered>\n'
        
        if rating:
            try:
                r_val = float(rating)
                if series_data.get('rating_5based'):
                    r_val *= 2
                
                nfo += '  <ratings>\n'
                nfo += f'    <rating name="tmdb" default="true"><value>{r_val:.1f}</value></rating>\n'
                nfo += '  </ratings>\n'
                nfo += f'  <userrating>{int(round(r_val))}</userrating>\n'
            except (ValueError, TypeError):
                pass
        
        if genre:
            for g in re.split(r'[,/]', str(genre)):
                g_str = g.strip()
                if g_str:
                    nfo += f'  <genre>{self._escape_xml(g_str)}</genre>\n'
        
        if director:
            nfo += f'  <director>{self._escape_xml(director)}</director>\n'
        
        if cast_list:
            for actor in str(cast_list).split(','):
                actor_name = actor.strip()
                if actor_name:
                    nfo += f'  <actor><name>{self._escape_xml(actor_name)}</name></actor>\n'
        
        if cover:
            nfo += f'  <thumb>{cover}</thumb>\n'
        
        if fanart:
            nfo += f'  <fanart><thumb>{fanart}</thumb></fanart>\n'
        elif cover:
            nfo += f'  <fanart><thumb>{cover}</thumb></fanart>\n'
        
        nfo += '</tvshow>'
        return nfo

    def generate_episode_nfo(self, episode_data: dict, series_name: str, season_num: int, episode_num: int) -> str:
        """Generate NFO file for an episode"""
        title = episode_data.get('title', '')
        if not title:
            title = f"Episode {episode_num}"
            
        ep_info = self._as_dict(episode_data.get('info'))
        plot = ep_info.get('plot') or episode_data.get('plot', '')
        duration = ep_info.get('duration') or episode_data.get('duration', '')
        
        nfo = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<episodedetails>\n'
        nfo += f'  <title>{self._escape_xml(title)}</title>\n'
        nfo += f'  <showtitle>{self._escape_xml(series_name)}</showtitle>\n'
        nfo += f'  <season>{season_num}</season>\n'
        nfo += f'  <episode>{episode_num}</episode>\n'
        
        if plot:
            nfo += f'  <plot>{self._escape_xml(plot)}</plot>\n'
            
        # Parse duration "HH:MM:SS" -> minutes
        if duration:
             try:
                total_mins = 0
                if ':' in str(duration):
                    parts = str(duration).split(':')
                    if len(parts) == 3:
                        total_mins = int(parts[0]) * 60 + int(parts[1])
                    elif len(parts) == 2:
                        total_mins = int(parts[0])
                elif str(duration).isdigit():
                     total_mins = int(duration)
                
                if total_mins > 0:
                    nfo += f'  <runtime>{total_mins}</runtime>\n'
             except (ValueError, TypeError):
                 pass

        # Stream Details
        # Usually from detailed info 'info' dict of the episode
        info = ep_info
        nfo += '  <fileinfo>\n    <streamdetails>\n'
        nfo += '      <video>\n'
        nfo += f'        <codec>{self._escape_xml(episode_data.get("container_extension", ""))}</codec>\n'
        if info.get('bitrate'):
             nfo += f'        <bitrate>{info.get("bitrate")}</bitrate>\n'
        nfo += '      </video>\n'
        nfo += '    </streamdetails>\n  </fileinfo>\n'

        nfo += '</episodedetails>'
        return nfo



    def _escape_xml(self, text: str) -> str:
        """Escape XML special characters"""
        if not text:
            return ''
        return (str(text)
                .replace('&', '&amp;')
                .replace('<', '&lt;')
                .replace('>', '&gt;')
                .replace('"', '&quot;')
                .replace("'", '&apos;'))
