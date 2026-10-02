"""Pure helpers behind the playlist editor's automatic tools.

No database and no network here: the endpoints in
``api_v1/endpoints/live_tools.py`` load rows and provider catalogues, hand plain
values to these functions, and write back what they return. That keeps every
rule below testable on its own, which matters because each one rewrites a
channel number a television displays.

Vocabulary:

* a *group* is a playlist bouquet, in playlist order, with its channels in
  channel order;
* on a numbered playlist a channel's ``order`` **is** its channel number, so
  "renumbering" changes what the player shows, and must never produce two
  channels with one number or interleave two groups.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.services.organizer import (
    QUALITY_ORDER, Reference, match_key, parse_name, strip_accents,
)

# A pushed group starts on the next round number, so the player's numbering
# still reads as blocks (100, 200…) instead of starting at 723.
ROUND_TO = 100


# ---------------------------------------------------------------------------
# Numbering
# ---------------------------------------------------------------------------

@dataclass
class GroupNumbers:
    """One group as the numbering tools see it."""

    id: int
    name: str
    channel_ids: List[int]          # in display order
    numbers: List[int]              # same length, the current orders
    start: Optional[int] = None     # declared range, if any
    end: Optional[int] = None


def _round_up(value: int) -> int:
    return ((value + ROUND_TO - 1) // ROUND_TO) * ROUND_TO


def _block_for(group: GroupNumbers, blocks) -> Optional[int]:
    """The reference block start to use for this group, if any.

    Profiles disagree ("Info" is 100-199 in one, 350-399 in another), and a
    playlist may number a group its own way (Sport from 100). A block is only
    adopted when it already contains the group's first number: it then gives
    the round start of the block (Info 380 -> 350) without moving anything
    that was deliberately placed. An empty group takes the first block.
    """
    if not blocks:
        return None
    if isinstance(blocks, tuple):
        blocks = [blocks]
    positive = [n for n in group.numbers if n and n > 0]
    if not positive:
        return next((b[0] for b in blocks if b[0] is not None), None)
    first = min(positive)
    for start, end in blocks:
        if start is not None and start <= first and (end is None or first <= end):
            return start
    return None


def infer_ranges(groups: Sequence[GroupNumbers],
                 block_starts: Optional[Dict[str, Any]] = None
                 ) -> Dict[int, Tuple[int, Optional[int]]]:
    """A ``(start, end)`` range for every group, keeping the declared ones.

    A group without a range starts where its reference block starts (when its
    name is a block of a reference profile), else at its lowest current number.
    Starts must leave room for the previous group's channels: a group pushed by
    a bigger neighbour moves to the next round hundred. Each range then ends
    where the next one begins, and the last stays open.

    Measured case this exists for: "Sport" (622 channels from 100) and "MBC"
    (from 501) — without capacity, Sport's tail and MBC interleave in the
    player.
    """
    block_starts = block_starts or {}
    starts: List[int] = []
    previous_end_needed = 0          # first free number after the previous group
    for group in groups:
        if group.start is not None:
            start = group.start
        else:
            proposed = _block_for(group, block_starts.get(group.name))
            if proposed is None:
                positive = [n for n in group.numbers if n and n > 0]
                proposed = min(positive) if positive else previous_end_needed or 1
            start = max(proposed, 1)
            if start < previous_end_needed:
                start = _round_up(previous_end_needed)
        starts.append(start)
        previous_end_needed = max(previous_end_needed, start + len(group.channel_ids))

    ranges: Dict[int, Tuple[int, Optional[int]]] = {}
    for index, group in enumerate(groups):
        if group.start is not None and group.end is not None:
            ranges[group.id] = (group.start, group.end)
            continue
        end = group.end
        if end is None and index + 1 < len(groups):
            end = starts[index + 1] - 1
        ranges[group.id] = (starts[index], end)
    return ranges


def repair_numbers(groups: Sequence[GroupNumbers],
                   ranges: Optional[Dict[int, Tuple[int, Optional[int]]]] = None,
                   compact: bool = False) -> Dict[int, int]:
    """New number for every channel whose current one breaks the playlist.

    Walks the groups in order with a cursor. A channel keeps its number when it
    is above the cursor and inside its group's range (``compact`` turns that
    off and numbers every group 1-by-1 from its start). Otherwise it takes the
    cursor. Numbers therefore strictly increase across the playlist: no
    duplicate, no group interleaving with another, and the reference numbers a
    group already has (TF1 1, France 3 3…) survive with their gaps.

    A group whose kept gaps would push it past the end of its range is numbered
    1-by-1 instead: 622 Sport channels spread over 100-865 fit in 100-799 once
    the gaps go, and keeping them made Sport overflow into the next group.

    Returns only the channels that change.
    """
    ranges = ranges or {}
    changes: Dict[int, int] = {}
    cursor = 1

    def walk(group, start_cursor, end, squeeze):
        local = {}
        position = start_cursor
        for channel_id, number in zip(group.channel_ids, group.numbers):
            keep = (not squeeze and number is not None and number >= position
                    and (end is None or number <= end))
            new = number if keep else position
            local[channel_id] = new
            position = new + 1
        return local, position

    for group in groups:
        start, end = ranges.get(group.id, (group.start, group.end))
        if start is not None and start > cursor:
            cursor = start
        assigned, after = walk(group, cursor, end, compact)
        if not compact and end is not None and after - 1 > end:
            assigned, after = walk(group, cursor, end, True)
        for channel_id, number in zip(group.channel_ids, group.numbers):
            if assigned[channel_id] != number:
                changes[channel_id] = assigned[channel_id]
        cursor = after
    return changes


def positions(groups: Sequence[GroupNumbers]) -> Dict[int, int]:
    """Plain 0..n-1 per group, for a playlist that does not publish numbers."""
    changes: Dict[int, int] = {}
    for group in groups:
        for index, (channel_id, number) in enumerate(zip(group.channel_ids, group.numbers)):
            if number != index:
                changes[channel_id] = index
    return changes


def numbering_issues(groups: Sequence[GroupNumbers]) -> Dict[str, Any]:
    """What is wrong with a numbered playlist, without changing anything."""
    owners: Dict[int, List[int]] = {}
    for group in groups:
        for channel_id, number in zip(group.channel_ids, group.numbers):
            owners.setdefault(number, []).append(channel_id)
    duplicates = {n: ids for n, ids in owners.items() if len(ids) > 1}

    invalid = [cid for g in groups for cid, n in zip(g.channel_ids, g.numbers)
               if n is None or n < 1]

    spans = [(g, min(g.numbers), max(g.numbers)) for g in groups if g.numbers]
    overlaps = []
    for i, (a, a_lo, a_hi) in enumerate(spans):
        for b, b_lo, b_hi in spans[i + 1:]:
            if a_lo <= b_hi and b_lo <= a_hi:
                inside = sum(1 for n in b.numbers if a_lo <= n <= a_hi) \
                    + sum(1 for n in a.numbers if b_lo <= n <= b_hi)
                overlaps.append({"groups": [a.id, b.id], "names": [a.name, b.name],
                                 "ranges": [[a_lo, a_hi], [b_lo, b_hi]],
                                 "interleaved": inside})

    out_of_range = []
    for g in groups:
        if g.start is None and g.end is None:
            continue
        outside = [cid for cid, n in zip(g.channel_ids, g.numbers)
                   if (g.start is not None and n < g.start)
                   or (g.end is not None and n > g.end)]
        if outside:
            out_of_range.append({"group": g.id, "name": g.name, "channel_ids": outside})

    return {"duplicates": duplicates, "invalid": invalid,
            "overlaps": overlaps, "out_of_range": out_of_range}


def next_free_number(used: Iterable[int], start: int, end: Optional[int]) -> Optional[int]:
    """First number in ``[start, end]`` nobody uses, or None if the range is full."""
    taken = set(used)
    number = max(start, 1)
    while number in taken:
        number += 1
    if end is not None and number > end:
        return None
    return number


# ---------------------------------------------------------------------------
# Reference numbering
# ---------------------------------------------------------------------------

def channel_key(name: str) -> Tuple[str, int]:
    """Identity of a channel name: the decoded name and its delay, nothing else.

    "M6 HD (1080p)", "FR| M6 FHD" and "M6" are one channel; "TF1 +1" is not TF1.
    """
    parsed = parse_name(name or "")
    canonical = parsed.canonical
    # One pass strips one quality tag: "M6 HD (1080p)" comes back as "M6 HD".
    for _ in range(3):
        again = parse_name(canonical).canonical
        if again == canonical:
            break
        canonical = again
    return match_key(canonical), parsed.timeshift


def reference_lookup(reference: Reference, name: str, epg_id: str):
    """The reference entry for a channel: by guide id first, then by name."""
    found = reference.by_tvg_id(epg_id) if epg_id else None
    if found is None:
        key, shift = channel_key(name)
        if shift:
            return None          # a delayed feed never takes the parent's number
        found = reference.by_name(key) or reference.by_name(name)
    return found


def best_reference(references: Dict[str, Reference],
                   channels: Sequence[Tuple[str, ...]]) -> Optional[str]:
    """The profile that fits these channels best.

    Each entry is (name, epg_id) or (name, epg_id, group name). A recognised
    channel scores 1, and 1 more when the profile files it under the group the
    playlist has it in: two profiles recognise TF1 equally, only the one the
    playlist was built with also agrees on where it lives.
    """
    best, best_score = None, 0
    for profile, reference in references.items():
        score = 0
        for entry in channels:
            found = reference_lookup(reference, entry[0], entry[1])
            if found is None:
                continue
            score += 1
            if len(entry) > 2 and entry[2] and found.group == entry[2]:
                score += 1
        if score > best_score:
            best, best_score = profile, score
    return best


def best_profile(references: Dict[str, Reference], group_names: Iterable[str],
                 channels: Sequence[Tuple[str, ...]]) -> Optional[str]:
    """The profile a playlist was most likely built with.

    The group names decide first: a playlist whose groups are "Tunisie",
    "MBC & Rotana", "Enfants" came from the arabic profile even though the
    French profiles recognise more of its sport channels by name. Recognition
    (``best_reference``) only breaks a tie.
    """
    names = {n for n in group_names if n}
    overlap = {p: len(names & {b["group"] for b in r.blocks}) for p, r in references.items()}
    top = max(overlap.values(), default=0)
    if top == 0:
        return best_reference(references, channels)
    tied = {p: r for p, r in references.items() if overlap[p] == top}
    return best_reference(tied, channels) or next(iter(tied))


def reference_numbers(group: GroupNumbers, names: Dict[int, Tuple[str, str]],
                      reference: Reference, taken_elsewhere: Iterable[int]
                      ) -> Tuple[Dict[int, int], List[int]]:
    """Give a group's recognised channels their reference number.

    ``names`` maps channel id to (name, effective epg id). A recognised channel
    takes its reference number when no channel of another group holds it and
    it fits the group's range. The others keep their relative order and take
    the free numbers that follow the group's last reference number, so the
    group still reads top to bottom.

    Returns (changes, ids in their new display order).
    """
    blocked = set(taken_elsewhere)
    claimed: Dict[int, int] = {}
    used_here: set = set()
    for channel_id in group.channel_ids:
        name, epg = names.get(channel_id, ("", ""))
        found = reference_lookup(reference, name, epg)
        if found is None:
            continue
        number = found.number
        if number in blocked or number in used_here:
            continue
        if group.start is not None and number < group.start:
            continue
        if group.end is not None and number > group.end:
            continue
        claimed[channel_id] = number
        used_here.add(number)

    low = max(group.start or 1, 1)
    floor = max(claimed.values()) if claimed else low - 1
    taken = blocked | used_here
    assigned = dict(claimed)
    cursor = floor + 1

    def free_from(start: int) -> Optional[int]:
        number = start
        while number in taken:
            number += 1
        return number if group.end is None or number <= group.end else None

    # Unrecognised channels follow the last reference number. When the range
    # ends first, they fill the gaps the reference left (TNT numbers 1..27
    # leave plenty), and only then overflow: spilling past the range used to
    # push every following group hundreds of numbers further.
    # Numbers starting at 0 are positions, not channel numbers: nothing to keep.
    looks_like_positions = bool(group.numbers) and min(group.numbers) <= 0
    current = dict(zip(group.channel_ids, group.numbers))
    for channel_id in group.channel_ids:
        if channel_id in assigned or looks_like_positions:
            continue
        number = current.get(channel_id)
        if number and number > 0 and number not in taken \
                and (group.start is None or number >= group.start) \
                and (group.end is None or number <= group.end):
            assigned[channel_id] = number
            taken.add(number)

    for channel_id in group.channel_ids:
        if channel_id in assigned:
            continue
        number = free_from(cursor)
        if number is None:
            number = free_from(low)
        if number is None:
            number = cursor
            while number in taken:
                number += 1
        assigned[channel_id] = number
        taken.add(number)
        cursor = max(cursor, number + 1) if number >= cursor else cursor

    changes = {cid: n for cid, n in assigned.items() if current.get(cid) != n}
    ordered = sorted(group.channel_ids, key=lambda cid: assigned[cid])
    return changes, ordered


# ---------------------------------------------------------------------------
# Rule groups
# ---------------------------------------------------------------------------

@dataclass
class GroupRule:
    """A filter that keeps a group topped up with matching provider channels.

    Every non-empty criterion must hold. Keywords are compared without accents
    or case, against the provider's channel name. ``include`` matches when any
    keyword is found, ``exclude`` rejects when any is.
    """

    subscription_ids: List[int] = field(default_factory=list)
    category_ids: List[str] = field(default_factory=list)
    include: List[str] = field(default_factory=list)
    exclude: List[str] = field(default_factory=list)

    @classmethod
    def parse(cls, raw: Optional[str]) -> Optional["GroupRule"]:
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        rule = cls(
            subscription_ids=[int(s) for s in data.get("subscription_ids") or []],
            category_ids=[str(c) for c in data.get("category_ids") or []],
            include=[str(k).strip() for k in data.get("include") or [] if str(k).strip()],
            exclude=[str(k).strip() for k in data.get("exclude") or [] if str(k).strip()],
        )
        return rule if rule.is_usable() else None

    def is_usable(self) -> bool:
        """A rule must narrow something down: never "the whole catalogue"."""
        return bool(self.category_ids or self.include)

    def to_json(self) -> str:
        return json.dumps({
            "subscription_ids": self.subscription_ids, "category_ids": self.category_ids,
            "include": self.include, "exclude": self.exclude,
        })

    @staticmethod
    def _norm(text: str) -> str:
        return " ".join(strip_accents(text or "").lower().split())

    def matches(self, subscription_id: int, category_id: str, name: str) -> bool:
        if self.subscription_ids and subscription_id not in self.subscription_ids:
            return False
        if self.category_ids and str(category_id) not in self.category_ids:
            return False
        text = self._norm(name)
        if self.include and not any(self._norm(k) in text for k in self.include):
            return False
        if any(self._norm(k) in text for k in self.exclude):
            return False
        return True


# ---------------------------------------------------------------------------
# Replacements for a channel the provider no longer serves
# ---------------------------------------------------------------------------

@dataclass
class Candidate:
    subscription_id: int
    stream_id: str
    name: str
    category_id: str
    quality: str
    same_provider: bool
    in_playlist: bool

    def as_dict(self) -> Dict[str, Any]:
        return {
            "subscription_id": self.subscription_id, "stream_id": self.stream_id,
            "name": self.name, "category_id": self.category_id, "quality": self.quality,
            "same_provider": self.same_provider, "in_playlist": self.in_playlist,
        }


def replacement_candidates(name: str, subscription_id: Optional[int],
                           catalogues: Dict[int, List[dict]],
                           in_playlist: Iterable[Tuple[int, str]],
                           quality_preference: Sequence[str] = ("FHD", "HD", "4K", "SD", "8K"),
                           limit: int = 10) -> List[Candidate]:
    """Streams that carry the same channel as ``name``, best first.

    Same identity as the organiser uses (decoded name + delay). Ranked: the
    same provider first (providers renumber streams, and the "dead" channel is
    often the same feed under a new id), then a stream not already elsewhere
    in the playlist, then quality by preference. A Full-HD-first preference is
    the default: a replacement should play reliably before it plays in 4K.
    """
    key = channel_key(name)
    if not key[0]:
        return []
    present = {(int(s), str(i)) for s, i in in_playlist}
    rank = {q: i for i, q in enumerate(quality_preference)}
    found: List[Candidate] = []
    for sub_id, streams in catalogues.items():
        for stream in streams:
            stream_name = str(stream.get("name") or "")
            if channel_key(stream_name) != key:
                continue
            stream_id = str(stream.get("stream_id"))
            found.append(Candidate(
                subscription_id=sub_id, stream_id=stream_id, name=stream_name,
                category_id=str(stream.get("category_id") or ""),
                quality=parse_name(stream_name).quality,
                same_provider=(sub_id == subscription_id),
                in_playlist=((sub_id, stream_id) in present),
            ))
    found.sort(key=lambda c: (not c.same_provider, c.in_playlist,
                              rank.get(c.quality, len(rank)), c.name))
    return found[:limit]


def quality_rank(name: str) -> int:
    """Quality of a stream name as an index of QUALITY_ORDER (-1 = unknown)."""
    return parse_name(name).quality_rank if name else -1


__all__ = [
    "GroupNumbers", "infer_ranges", "repair_numbers", "positions", "numbering_issues",
    "next_free_number", "channel_key", "reference_lookup", "best_reference", "best_profile",
    "reference_numbers", "GroupRule", "Candidate", "replacement_candidates",
    "QUALITY_ORDER", "quality_rank",
]
