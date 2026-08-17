"""Deciding which TMDB id a title actually gets.

One rule, applied in one place: if the user has corrected a title, their answer
wins over everything the provider says — the catalogue listing *and* the
per-item metadata fetch, which is the one that used to overwrite it last.

Everything that writes a library or a download resolves through here, so the
.strm library, the NFO and the downloaded file cannot end up under three
different ids for the same film.
"""

from __future__ import annotations

import re
from typing import Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.tmdb_override import TmdbOverride

_NOT_ALNUM = re.compile(r"[^a-z0-9]+")

# Values a provider uses to say "no id" while still sending a field.
_EMPTY = {"", "0", "none", "null", "false", "-1"}


def normalise_id(value) -> Optional[str]:
    """A TMDB id as a string, or None when there is not really one."""
    if value is None:
        return None
    text = str(value).strip()
    return None if text.lower() in _EMPTY else text


def name_key(name: Optional[str]) -> str:
    """A title reduced to what two spellings of it have in common.

    Case, punctuation and spacing all move between two readings of the same
    catalogue; the letters and digits do not.
    """
    return _NOT_ALNUM.sub("", (name or "").lower())


class OverrideMap:
    """The corrections that apply to one source and one media type."""

    def __init__(self, by_id: Dict[str, TmdbOverride],
                 by_name: Dict[str, TmdbOverride]):
        self._by_id = by_id
        self._by_name = by_name

    def __bool__(self) -> bool:
        return bool(self._by_id)

    def __len__(self) -> int:
        return len(self._by_id)

    def find(self, item_id, name: Optional[str] = None) -> Optional[TmdbOverride]:
        """The correction for this item, matched by id and then by title.

        The title fallback exists for the M3U side: its catalogue is re-parsed
        into fresh rows, so an entry's id is not the same thing between two
        syncs while its title is. It is only ever consulted when no id matches,
        and only for titles that name exactly one correction.
        """
        if item_id is not None:
            found = self._by_id.get(str(item_id))
            if found is not None:
                return found
        return self._by_name.get(name_key(name)) if name else None

    def resolve(self, item_id, name: Optional[str],
                provider_value) -> Tuple[Optional[str], bool]:
        """(the id to use, whether it came from a correction)."""
        found = self.find(item_id, name)
        if found is None:
            return normalise_id(provider_value), False
        return normalise_id(found.tmdb_id), True


def load_overrides(db: Session, subscription_id: int,
                   media_type: str) -> OverrideMap:
    """Every correction for one source and media type, read once per sync."""
    rows = db.query(TmdbOverride).filter(
        TmdbOverride.subscription_id == subscription_id,
        TmdbOverride.media_type == media_type,
    ).all()

    by_id = {str(row.item_id): row for row in rows}

    # A title claimed by two corrections cannot be resolved by title, and
    # guessing between them would silently tag the wrong film. Those keep their
    # id match and lose the fallback.
    counts: Dict[str, int] = {}
    for row in rows:
        if row.name_key:
            counts[row.name_key] = counts.get(row.name_key, 0) + 1
    by_name = {row.name_key: row for row in rows
               if row.name_key and counts[row.name_key] == 1}

    return OverrideMap(by_id, by_name)


def resolve_one(db: Session, subscription_id: int, media_type: str, item_id,
                name: Optional[str], provider_value) -> Tuple[Optional[str], bool]:
    """The same decision for a single item, for callers with no batch to load."""
    return load_overrides(db, subscription_id, media_type).resolve(
        item_id, name, provider_value)
