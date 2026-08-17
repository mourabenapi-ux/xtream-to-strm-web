import re
import requests
from typing import List, Dict, Optional
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

class M3UParser:
    """Parser for M3U/M3U8 playlist files"""
    
    def __init__(self):
        self.entries = []
    
    def parse_from_url(self, url: str) -> List[Dict]:
        """Fetch and parse M3U from URL"""
        try:
            response = requests.get(url, timeout=30, headers={"User-Agent": "TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)"})
            response.raise_for_status()
            content = response.text
            return self.parse_content(content)
        except Exception as e:
            logger.error(f"Error fetching M3U from URL {url}: {e}")
            raise
    
    def parse_from_file(self, file_path: str) -> List[Dict]:
        """Parse M3U from file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            return self.parse_content(content)
        except Exception as e:
            logger.error(f"Error reading M3U file {file_path}: {e}")
            raise
    
    def parse_content(self, content: str) -> List[Dict]:
        """Parse M3U content and extract entries"""
        entries = []
        lines = content.strip().split('\n')
        
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            
            # Skip empty lines and comments that aren't EXTINF
            if not line or (line.startswith('#') and not line.startswith('#EXTINF')):
                i += 1
                continue
            
            # Look for EXTINF line
            if line.startswith('#EXTINF'):
                # Parse EXTINF metadata
                entry = self._parse_extinf(line)
                
                # Next non-empty line should be the URL
                i += 1
                while i < len(lines) and not lines[i].strip():
                    i += 1
                
                if i < len(lines):
                    url = lines[i].strip()
                    if url and not url.startswith('#'):
                        entry['url'] = url
                        
                        # Refine entry_type based on URL pattern (more reliable for Xtream Codes)
                        if '/series/' in url:
                            entry['entry_type'] = 'series'
                        elif '/movie/' in url:
                            entry['entry_type'] = 'movie'
                            
                        entries.append(entry)
            
            i += 1
        
        logger.info(f"Parsed {len(entries)} entries from M3U content")
        return entries
    
    def _parse_extinf(self, line: str) -> Dict:
        """Parse EXTINF line and extract metadata"""
        entry = {
            'title': '',
            'logo': None,
            'group_title': None,
            'tvg_id': None,
            'tvg_name': None,
            'entry_type': 'live',
            'catchup': None,
            'catchup_days': None,
            'catchup_source': None,
        }

        entry.update(self._parse_catchup(line))

        # Extract tvg-id
        tvg_id_match = re.search(r'tvg-id="([^"]*)"', line)
        if tvg_id_match:
            entry['tvg_id'] = tvg_id_match.group(1)
        
        # Extract tvg-name
        tvg_name_match = re.search(r'tvg-name="([^"]*)"', line)
        if tvg_name_match:
            entry['tvg_name'] = tvg_name_match.group(1)
        
        # Extract tvg-logo or logo
        logo_match = re.search(r'tvg-logo="([^"]*)"', line)
        if not logo_match:
            logo_match = re.search(r'logo="([^"]*)"', line)
        if logo_match:
            entry['logo'] = logo_match.group(1)
        
        # Extract group-title
        group_match = re.search(r'group-title="([^"]*)"', line)
        if group_match:
            entry['group_title'] = group_match.group(1)
        
        # Extract title (usually after the last comma)
        title_match = re.search(r',(.+)$', line)
        if title_match:
            entry['title'] = title_match.group(1).strip()
        
        # Determine entry type
        # Default to live, will be refined based on URL in parse_content
        entry['entry_type'] = 'live'

        return entry

    # Replay is declared by the provider, never guessed. Three spellings are in
    # circulation for the same thing, so all three are read and normalised into
    # one shape; nothing is invented when a playlist stays silent.
    _CATCHUP_MODE = re.compile(r'\bcatchup="([^"]*)"')
    _CATCHUP_SOURCE = re.compile(r'\bcatchup-source="([^"]*)"')
    # `catchup-days` is the modern tag. `tvg-rec` and `timeshift` are the older
    # ones Kodi popularised and several panels still emit.
    _CATCHUP_DAYS = re.compile(r'\b(?:catchup-days|tvg-rec|timeshift)="([^"]*)"')

    def _parse_catchup(self, line: str) -> Dict:
        """What one EXTINF line says about replay, or nothing if it says nothing."""
        mode_match = self._CATCHUP_MODE.search(line)
        source_match = self._CATCHUP_SOURCE.search(line)
        days_match = self._CATCHUP_DAYS.search(line)

        days = None
        if days_match:
            try:
                days = int(float(days_match.group(1).strip()))
            except (TypeError, ValueError):
                days = None
            if days is not None and days <= 0:
                # `tvg-rec="0"` is a provider saying "no archive here".
                days = None

        mode = (mode_match.group(1).strip() if mode_match else "") or None
        source = (source_match.group(1).strip() if source_match else "") or None

        # A day count on its own is still an offer of replay. "default" is the
        # type those older tags always meant: append the source template, or
        # the provider's own default when there is none.
        if not mode and (days or source):
            mode = "default"

        return {'catchup': mode, 'catchup_days': days, 'catchup_source': source}


def parse_m3u_url(url: str) -> List[Dict]:
    """Helper function to parse M3U from URL"""
    parser = M3UParser()
    return parser.parse_from_url(url)


def parse_m3u_file(file_path: str) -> List[Dict]:
    """Helper function to parse M3U from file"""
    parser = M3UParser()
    return parser.parse_from_file(file_path)
