"""The playlist editor's automatic tools: health, numbering, rules, repairs.

Everything a player receives is read through ``live.resolve_playlist_channels``,
the same walk that builds the M3U and the guide. The editor used to describe the
stored rows instead, and said "100 % guide" about a playlist on which 22 % of
the channels had a schedule. Pure rules live in ``services/playlist_tools.py``.
"""
from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api import deps
from app.api.api_v1.endpoints.live import NO_GUIDE, resolve_playlist_channels
from app.models.live import (
    LiveCatalogSeen, LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel, LivePlaylistVersion,
)
from app.models.subscription import Subscription
from app.services.catalog import get_catalog
from app.services.epg import epg_service
from app.services.organizer import PROFILES, load_profile, strip_accents
from app.services.playlist_tools import (
    GroupNumbers, GroupRule, best_profile, channel_key, infer_ranges,
    next_free_number, numbering_issues, positions, reference_lookup, reference_numbers,
    repair_numbers, replacement_candidates,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# Anything older than this counts as "already known" when a provider's
# catalogue is recorded for the first time, so the first report is not a list
# of the whole catalogue.
KNOWN_BEFORE = datetime(2000, 1, 1)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _playlist(db: Session, playlist_id: int) -> LivePlaylist:
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


def _groups(playlist: LivePlaylist) -> List[LivePlaylistBouquet]:
    return sorted(playlist.bouquets, key=lambda b: (b.order, b.id))


def _channels(bouquet: LivePlaylistBouquet) -> List[LivePlaylistChannel]:
    return sorted(bouquet.channels, key=lambda c: (c.order if c.order is not None else 0, c.id))


def _numbers(playlist: LivePlaylist) -> List[GroupNumbers]:
    return [
        GroupNumbers(
            id=b.id, name=b.custom_name or "", start=b.number_start, end=b.number_end,
            channel_ids=[c.id for c in _channels(b)],
            numbers=[c.order if c.order is not None else 0 for c in _channels(b)],
        )
        for b in _groups(playlist)
    ]


async def _catalogues(db: Session, sub_ids) -> Dict[int, List[dict]]:
    """Every live stream of these providers, read through the cached adapters."""
    out: Dict[int, List[dict]] = {}
    for sid in sorted({s for s in sub_ids if s}):
        sub = db.query(Subscription).filter(Subscription.id == sid).first()
        if not sub:
            continue
        try:
            out[sid] = await get_catalog(db, sub).get_live_streams()
        except Exception as e:  # a provider that does not answer is reported, not fatal
            logger.warning("Catalogue of %s unavailable: %s", sid, e)
    return out


def _block_starts() -> Dict[str, List[Tuple[int, int]]]:
    """Group name -> every (start, end) the reference profiles give it."""
    out: Dict[str, List[Tuple[int, int]]] = defaultdict(list)
    for name in PROFILES:
        try:
            for block in load_profile(name).blocks:
                if block.get("start") is not None:
                    out[block["group"]].append((block.get("start"), block.get("end")))
        except Exception:
            continue
    return out


def _apply_orders(db: Session, playlist: LivePlaylist, changes: Dict[int, int]) -> int:
    if not changes:
        return 0
    for bouquet in playlist.bouquets:
        for channel in bouquet.channels:
            if channel.id in changes:
                channel.order = changes[channel.id]
    return len(changes)


_FEED_TAGS = re.compile(
    r"\b(\d{3,4}p|sd|hd|fhd|uhd|lq|hq|4k|8k|raw|hevc|h265|alt|backup|vip|live)\b")


def _identity(name: str) -> str:
    """Channel identity for the shared-guide check: the decoded name without
    any feed tag, so "beIN 1 SD", "beIN 1 LQ" and "beIN 1 (ALT)" are one
    channel that may legitimately share an id, while "MTV Urheilu 1" and
    "MTV Urheilu 2" are two that must not."""
    key = channel_key(name)[0]
    return " ".join(_FEED_TAGS.sub(" ", key).split())


# ---------------------------------------------------------------------------
# Health: what the player really receives, and what is wrong with it
# ---------------------------------------------------------------------------

@router.get("/playlists/{playlist_id}/health")
async def playlist_health(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """The served playlist, channel by channel, plus a list of problems.

    Each issue names the channels it concerns and, when one exists, the action
    that fixes it (``fix``), so the screen can offer a one-click repair.
    """
    playlist = _playlist(db, playlist_id)
    dropped: List[dict] = []
    served = await resolve_playlist_channels(db, playlist, dropped=dropped)
    source_ids = epg_service.active_source_ids(playlist)
    states = epg_service.guide_states(source_ids, [c["epg_id"] for c in served])

    effective: Dict[str, Dict[str, Any]] = {}
    for ch in served:
        if ch.get("channel_id") is None:
            continue
        guide = states.get(ch["epg_id"], {"state": "none", "now": None}) if ch["epg_id"] \
            else {"state": "detached" if ch["epg_id_source"] == "detached" else "none", "now": None}
        effective[str(ch["channel_id"])] = {
            "served": True, "number": ch.get("number"), "name": ch["name"],
            "logo": ch["logo"], "epg_id": ch["epg_id"], "epg_source": ch["epg_id_source"],
            "guide": guide["state"], "now": guide["now"],
            "now_start": guide.get("now_start"), "now_stop": guide.get("now_stop"),
            "next": guide.get("next"), "next_start": guide.get("next_start"),
            "category_id": ch.get("category_id"), "subscription_id": ch["subscription_id"],
        }
    for d in dropped:
        if d.get("channel_id") is not None:
            effective[str(d["channel_id"])] = {"served": False, "dead": d["reason"],
                                               "name": d["name"]}

    issues: List[Dict[str, Any]] = []
    rows = [(b, c) for b in _groups(playlist) for c in _channels(b)]

    # 1. Channels the provider no longer serves.
    dead = [d for d in dropped if d.get("channel_id") is not None]
    if dead:
        issues.append({
            "type": "dead", "severity": "error",
            "title": f"{len(dead)} channel(s) no longer served by the provider",
            "detail": "They are missing from the player. Repair looks for the same channel "
                      "under a new id or at the other provider.",
            "channel_ids": [d["channel_id"] for d in dead], "fix": "repair_dead",
        })

    # 2. The same provider stream twice.
    seen: Dict[Tuple[Any, str], int] = {}
    doubles: List[int] = []
    for b, c in rows:
        key = (c.subscription_id or b.subscription_id or playlist.subscription_id, str(c.stream_id))
        if key in seen:
            doubles.append(c.id)
        else:
            seen[key] = c.id
    if doubles:
        issues.append({
            "type": "duplicate_stream", "severity": "warning",
            "title": f"{len(doubles)} channel(s) present twice",
            "detail": "The same provider stream appears more than once. The first one is kept.",
            "channel_ids": doubles, "fix": "dedupe",
        })

    # 3. Numbering, only where numbers are published.
    if playlist.use_channel_numbers:
        problems = numbering_issues(_numbers(playlist))
        broken: List[int] = list(problems["invalid"])
        for ids in problems["duplicates"].values():
            broken.extend(ids)
        for item in problems["out_of_range"]:
            broken.extend(item["channel_ids"])
        if problems["duplicates"]:
            issues.append({
                "type": "duplicate_number", "severity": "error",
                "title": f"{len(problems['duplicates'])} channel number(s) used twice",
                "detail": "Two channels with one number: the player keeps one of them.",
                "channel_ids": sorted({i for ids in problems['duplicates'].values() for i in ids}),
                "fix": "fix_numbering",
            })
        if problems["invalid"]:
            issues.append({
                "type": "invalid_number", "severity": "error",
                "title": f"{len(problems['invalid'])} channel(s) numbered 0",
                "detail": "Number 0 is not published, so the player numbers them itself.",
                "channel_ids": problems["invalid"], "fix": "fix_numbering",
            })
        for overlap in problems["overlaps"]:
            if not overlap["interleaved"]:
                continue
            issues.append({
                "type": "overlap", "severity": "warning",
                "title": f"“{overlap['names'][0]}” and “{overlap['names'][1]}” overlap",
                "detail": f"Ranges {overlap['ranges'][0][0]}-{overlap['ranges'][0][1]} and "
                          f"{overlap['ranges'][1][0]}-{overlap['ranges'][1][1]}: "
                          f"{overlap['interleaved']} channel(s) mixed together when sorted by number.",
                "bouquet_ids": overlap["groups"], "fix": "fix_numbering",
            })
        for item in problems["out_of_range"]:
            issues.append({
                "type": "out_of_range", "severity": "warning",
                "title": f"{len(item['channel_ids'])} channel(s) outside the range of “{item['name']}”",
                "channel_ids": item["channel_ids"], "bouquet_ids": [item["group"]],
                "fix": "fix_numbering",
            })

    # 4. Guide.
    by_id: Dict[str, List[str]] = defaultdict(list)
    for key, info in effective.items():
        if info.get("served") and info["epg_id"]:
            by_id[info["epg_id"]].append(key)
    shared = []
    for epg_id, keys in by_id.items():
        identities = {_identity(effective[k]["name"]) for k in keys}
        # Variants of one channel (HD, 4K, backup) may share an id. Different
        # channels on one id all show the same schedule.
        if len(keys) > 1 and len(identities) > 1:
            shared.append((epg_id, keys))
    if shared:
        ids = [int(k) for _, keys in shared for k in keys]
        issues.append({
            "type": "shared_epg", "severity": "warning",
            "title": f"{len(ids)} channels share {len(shared)} guide id(s) with other channels",
            "detail": "; ".join(f"{e} ×{len(k)}" for e, k in shared[:6]),
            "channel_ids": ids, "fix": None,
        })
    no_schedule = [int(k) for k, v in effective.items()
                   if v.get("served") and v["epg_id"] and v["guide"] in ("unknown", "listed")]
    if no_schedule:
        issues.append({
            "type": "guide_empty", "severity": "info",
            "title": f"{len(no_schedule)} channel(s) have a guide id but no programme",
            "detail": "None of the playlist's guide sources has a schedule for that id. "
                      "Map them to another id, or link another guide source.",
            "channel_ids": no_schedule, "fix": None,
        })
    no_id = [int(k) for k, v in effective.items()
             if v.get("served") and not v["epg_id"] and v["guide"] != "detached"]
    if no_id:
        issues.append({
            "type": "no_guide", "severity": "info",
            "title": f"{len(no_id)} channel(s) without a guide id",
            "detail": "Automatic matching proposes an id from the linked guide sources.",
            "channel_ids": no_id, "fix": "auto_match",
        })

    # 5. Groups.
    empty = [b.id for b in _groups(playlist) if not b.channels]
    if empty:
        issues.append({"type": "empty_group", "severity": "info",
                       "title": f"{len(empty)} empty group(s)", "bouquet_ids": empty, "fix": None})

    served_count = sum(1 for v in effective.values() if v.get("served"))
    live = sum(1 for v in effective.values() if v.get("served") and v.get("guide") == "live")
    with_id = sum(1 for v in effective.values() if v.get("served") and v.get("epg_id"))
    return {
        "channels": effective,
        "issues": issues,
        "stats": {
            "rows": len(rows), "served": served_count, "dead": len(dead),
            "excluded": sum(1 for _, c in rows if c.is_excluded),
            "with_guide_id": with_id, "with_schedule": live,
            "schedule_percentage": round(100 * live / served_count) if served_count else 0,
        },
    }


# ---------------------------------------------------------------------------
# Numbering
# ---------------------------------------------------------------------------

class NumberingFixIn(BaseModel):
    compact: bool = False
    set_ranges: bool = True


@router.post("/playlists/{playlist_id}/numbering/fix")
def fix_numbering(playlist_id: int, payload: NumberingFixIn = NumberingFixIn(),
                  db: Session = Depends(deps.get_db)) -> Any:
    """Give every group a range and every channel a unique number inside it.

    Keeps every number that is already valid (reference numbers keep their
    gaps), moves the rest. On a playlist that does not publish numbers, the
    order is a position and is simply rewritten 0..n-1.
    """
    playlist = _playlist(db, playlist_id)
    save_version(db, playlist, "Before “Fix the numbering”", automatic=True)
    groups = _numbers(playlist)
    if not playlist.use_channel_numbers:
        changed = _apply_orders(db, playlist, positions(groups))
        db.commit()
        return {"changed": changed, "ranges": {}}

    ranges = infer_ranges(groups, _block_starts())
    if payload.set_ranges:
        for bouquet in playlist.bouquets:
            start, end = ranges[bouquet.id]
            if bouquet.number_start is None:
                bouquet.number_start = start
            if bouquet.number_end is None:
                bouquet.number_end = end
        # Re-read with the stored ranges, so a declared range is what decides.
        groups = _numbers(playlist)
        ranges = {g.id: (g.start, g.end) for g in groups}
    changes = repair_numbers(groups, ranges, compact=payload.compact)
    changed = _apply_orders(db, playlist, changes)
    db.commit()
    return {"changed": changed,
            "ranges": {str(k): {"start": v[0], "end": v[1]} for k, v in ranges.items()}}


class ReferenceNumberingIn(BaseModel):
    bouquet_ids: Optional[List[int]] = None
    profile: Optional[str] = None


@router.post("/playlists/{playlist_id}/numbering/reference")
async def reference_numbering(playlist_id: int, payload: ReferenceNumberingIn = ReferenceNumberingIn(),
                              db: Session = Depends(deps.get_db)) -> Any:
    """Give the recognised channels their official number (TF1 1, France 2 2…).

    The profile is the one that recognises most of the playlist unless one is
    named. A number another group already holds is left alone; the whole
    playlist is then re-checked so nothing ends up doubled or interleaved.
    """
    playlist = _playlist(db, playlist_id)
    if not playlist.use_channel_numbers:
        raise HTTPException(status_code=422,
                            detail="This playlist does not publish channel numbers. Turn that on first.")
    served = await resolve_playlist_channels(db, playlist)
    names: Dict[int, Tuple[str, str]] = {
        ch["channel_id"]: (ch["name"], ch["epg_id"]) for ch in served if ch.get("channel_id")}
    for bouquet in playlist.bouquets:
        for channel in bouquet.channels:
            names.setdefault(channel.id, (channel.custom_name or "", ""))

    save_version(db, playlist, "Before “Number from the reference”", automatic=True)
    references = {name: load_profile(name) for name in PROFILES}
    group_of = {c.id: (b.custom_name or "") for b in playlist.bouquets for c in b.channels}
    profile = payload.profile or best_profile(
        references, [b.custom_name for b in playlist.bouquets],
        [(name, epg, group_of.get(cid, "")) for cid, (name, epg) in names.items()])
    if not profile or profile not in references:
        return {"profile": None, "changed": 0, "matched": 0}
    reference = references[profile]

    # Ranges first, as "Fix the numbering" does: a group's reference numbers
    # and its unrecognised channels must stay inside what the group owns.
    ranges = infer_ranges(_numbers(playlist), _block_starts())
    for bouquet in playlist.bouquets:
        start, end = ranges[bouquet.id]
        if bouquet.number_start is None:
            bouquet.number_start = start
        if bouquet.number_end is None:
            bouquet.number_end = end
    db.flush()

    wanted = set(payload.bouquet_ids or [b.id for b in playlist.bouquets])
    changes: Dict[int, int] = {}
    matched = 0
    for group in _numbers(playlist):
        if group.id not in wanted:
            continue
        elsewhere = [n for g in _numbers(playlist) if g.id != group.id for n in g.numbers]
        group_changes, _ = reference_numbers(group, names, reference, elsewhere)
        _apply_orders(db, playlist, group_changes)
        changes.update(group_changes)
        matched += sum(1 for cid in group.channel_ids
                       if reference_lookup(reference, *names.get(cid, ("", ""))))
    db.flush()
    # A reference number may now sit in another group's range: settle it.
    groups = _numbers(playlist)
    settle = repair_numbers(groups, {g.id: (g.start, g.end) for g in groups})
    _apply_orders(db, playlist, settle)
    changes.update(settle)
    db.commit()
    return {"profile": profile, "changed": len(changes), "matched": matched}


# ---------------------------------------------------------------------------
# Group settings: range and rule
# ---------------------------------------------------------------------------

class RuleIn(BaseModel):
    subscription_ids: List[int] = Field(default_factory=list)
    category_ids: List[str] = Field(default_factory=list)
    include: List[str] = Field(default_factory=list)
    exclude: List[str] = Field(default_factory=list)


class GroupSettingsIn(BaseModel):
    custom_name: Optional[str] = None
    number_start: Optional[int] = None
    number_end: Optional[int] = None
    rule: Optional[RuleIn] = None


@router.patch("/playlists/{playlist_id}/bouquets/{bouquet_id}/settings")
def update_group_settings(playlist_id: int, bouquet_id: int, payload: GroupSettingsIn,
                          db: Session = Depends(deps.get_db)) -> Any:
    """Name, number range and rule of a group. Only the fields sent change;
    sending ``null`` clears a range or a rule."""
    bouquet = db.query(LivePlaylistBouquet).filter_by(id=bouquet_id, playlist_id=playlist_id).first()
    if not bouquet:
        raise HTTPException(status_code=404, detail="Group not found")
    sent = payload.model_fields_set
    if "custom_name" in sent and payload.custom_name and payload.custom_name.strip():
        bouquet.custom_name = payload.custom_name.strip()
    if "number_start" in sent:
        bouquet.number_start = payload.number_start
    if "number_end" in sent:
        bouquet.number_end = payload.number_end
    if bouquet.number_start is not None and bouquet.number_end is not None \
            and bouquet.number_end < bouquet.number_start:
        raise HTTPException(status_code=422, detail="The range ends before it starts.")
    if "rule" in sent:
        if payload.rule is None:
            bouquet.rule = None
        else:
            rule = GroupRule(**payload.rule.model_dump())
            if not rule.is_usable():
                raise HTTPException(status_code=422,
                                    detail="A rule needs at least one category or one keyword.")
            bouquet.rule = rule.to_json()
    db.commit()
    db.refresh(bouquet)
    return {"id": bouquet.id, "custom_name": bouquet.custom_name,
            "number_start": bouquet.number_start, "number_end": bouquet.number_end,
            "rule": bouquet.rule}


# ---------------------------------------------------------------------------
# Channel-level fixes
# ---------------------------------------------------------------------------

class ChannelIdsIn(BaseModel):
    channel_ids: List[int]


class GuideActionIn(ChannelIdsIn):
    action: str  # "detach" | "inherit"


def _own_channels(db: Session, playlist_id: int, ids: List[int]) -> List[LivePlaylistChannel]:
    bouquet_ids = [b.id for b in db.query(LivePlaylistBouquet.id).filter_by(playlist_id=playlist_id)]
    if not ids or not bouquet_ids:
        return []
    return db.query(LivePlaylistChannel).filter(
        LivePlaylistChannel.id.in_(ids), LivePlaylistChannel.bouquet_id.in_(bouquet_ids)).all()


@router.post("/playlists/{playlist_id}/channels/guide")
def set_guide_mode(playlist_id: int, payload: GuideActionIn, db: Session = Depends(deps.get_db)) -> Any:
    """Detach channels from any guide id, or let them inherit the provider's again."""
    if payload.action not in ("detach", "inherit"):
        raise HTTPException(status_code=422, detail="action must be 'detach' or 'inherit'")
    rows = _own_channels(db, playlist_id, payload.channel_ids)
    for row in rows:
        row.epg_channel_id = NO_GUIDE if payload.action == "detach" else None
    db.commit()
    return {"updated": len(rows)}


class ExcludeIn(ChannelIdsIn):
    excluded: bool = True


@router.post("/playlists/{playlist_id}/channels/exclude")
def set_excluded(playlist_id: int, payload: ExcludeIn, db: Session = Depends(deps.get_db)) -> Any:
    """Hide channels from the player without deleting them (or show them again).

    In a rule group this is what "remove" does: a deleted row would be added
    back by the next refresh, a hidden one is remembered as unwanted.
    """
    rows = _own_channels(db, playlist_id, payload.channel_ids)
    for row in rows:
        row.is_excluded = payload.excluded
    db.commit()
    return {"updated": len(rows)}


@router.post("/playlists/{playlist_id}/channels/dedupe")
def dedupe_channels(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """Remove every second copy of the same provider stream, keeping the first."""
    playlist = _playlist(db, playlist_id)
    save_version(db, playlist, "Before “Remove duplicates”", automatic=True)
    seen = set()
    removed = 0
    for bouquet in _groups(playlist):
        for channel in _channels(bouquet):
            key = (channel.subscription_id or bouquet.subscription_id or playlist.subscription_id,
                   str(channel.stream_id))
            if key in seen:
                db.delete(channel)
                removed += 1
            else:
                seen.add(key)
    db.commit()
    return {"removed": removed}


@router.get("/playlists/{playlist_id}/channels/{channel_id}/replacements")
async def channel_replacements(playlist_id: int, channel_id: int,
                               db: Session = Depends(deps.get_db)) -> Any:
    """Streams that carry the same channel, for a channel that stopped playing."""
    playlist = _playlist(db, playlist_id)
    rows = _own_channels(db, playlist_id, [channel_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Channel not found")
    channel = rows[0]
    names = (await _channel_names(db, playlist)).get(channel.id) or channel.custom_name or ""
    catalogues = await _catalogues(db, [s.id for s in db.query(Subscription.id).all()])
    present = [(c.subscription_id or 0, str(c.stream_id)) for b in playlist.bouquets for c in b.channels]
    found = replacement_candidates(names, channel.subscription_id, catalogues, present)
    sub_names = {s.id: s.name for s in db.query(Subscription).all()}
    return [{**c.as_dict(), "subscription_name": sub_names.get(c.subscription_id, "")}
            for c in found
            if not (c.subscription_id == channel.subscription_id and c.stream_id == str(channel.stream_id))]


async def _channel_names(db: Session, playlist: LivePlaylist) -> Dict[int, str]:
    """Display name per row: the rename, else what the provider called it."""
    out: Dict[int, str] = {}
    pending = []
    for bouquet in playlist.bouquets:
        for channel in bouquet.channels:
            if channel.custom_name:
                out[channel.id] = channel.custom_name
            else:
                pending.append(channel)
    if pending:
        catalogues = await _catalogues(db, [c.subscription_id for c in pending])
        maps = {sid: {str(s.get("stream_id")): s.get("name") for s in streams}
                for sid, streams in catalogues.items()}
        for channel in pending:
            out[channel.id] = maps.get(channel.subscription_id, {}).get(str(channel.stream_id), "")
    return out


class ReplaceIn(BaseModel):
    subscription_id: int
    stream_id: str


@router.post("/playlists/{playlist_id}/channels/{channel_id}/replace")
def replace_channel_stream(playlist_id: int, channel_id: int, payload: ReplaceIn,
                           db: Session = Depends(deps.get_db)) -> Any:
    """Point a channel at another stream, keeping its number, name and guide."""
    rows = _own_channels(db, playlist_id, [channel_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Channel not found")
    row = rows[0]
    row.subscription_id = payload.subscription_id
    row.stream_id = str(payload.stream_id)
    db.commit()
    return {"id": row.id, "subscription_id": row.subscription_id, "stream_id": row.stream_id}


@router.post("/playlists/{playlist_id}/channels/repair-dead")
async def repair_dead_channels(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """Replace every dead channel by its best candidate, when there is one."""
    playlist = _playlist(db, playlist_id)
    dropped: List[dict] = []
    await resolve_playlist_channels(db, playlist, dropped=dropped)
    dead = [d for d in dropped if d.get("channel_id") and d["reason"] == "stream_gone_from_provider"]
    if not dead:
        return {"repaired": [], "unresolved": []}
    save_version(db, playlist, "Before “Repair dead channels”", automatic=True)
    catalogues = await _catalogues(db, [s.id for s in db.query(Subscription.id).all()])
    present = {(c.subscription_id or 0, str(c.stream_id)) for b in playlist.bouquets for c in b.channels}
    rows = {c.id: c for c in _own_channels(db, playlist_id, [d["channel_id"] for d in dead])}
    repaired, unresolved = [], []
    for d in dead:
        row = rows.get(d["channel_id"])
        if row is None:
            continue
        found = [c for c in replacement_candidates(d["name"] or row.custom_name or "",
                                                   row.subscription_id, catalogues, present)
                 if not c.in_playlist]
        if not found:
            unresolved.append({"channel_id": row.id, "name": d["name"]})
            continue
        best = found[0]
        row.subscription_id, row.stream_id = best.subscription_id, best.stream_id
        present.add((best.subscription_id, best.stream_id))
        repaired.append({"channel_id": row.id, "name": d["name"], "with": best.name,
                         "subscription_id": best.subscription_id})
    db.commit()
    return {"repaired": repaired, "unresolved": unresolved}


# ---------------------------------------------------------------------------
# Rule groups
# ---------------------------------------------------------------------------

async def refresh_rule_groups(db: Session, playlist: LivePlaylist) -> List[Dict[str, Any]]:
    """Add to each rule group the matching provider channels it does not hold.

    A row the user hid (``is_excluded``) counts as held, so a removed channel
    never comes back. New channels take the next free numbers of the group's
    range on a numbered playlist, or go to the end otherwise.
    """
    rules = [(b, GroupRule.parse(b.rule)) for b in _groups(playlist)]
    rules = [(b, r) for b, r in rules if r]
    if not rules:
        return []
    subs = set()
    for _, rule in rules:
        subs.update(rule.subscription_ids or [s.id for s in db.query(Subscription.id).all()])
    catalogues = await _catalogues(db, subs)
    used = [c.order for b in playlist.bouquets for c in b.channels if c.order is not None]
    report = []
    for bouquet, rule in rules:
        held = {(c.subscription_id, str(c.stream_id)) for c in bouquet.channels}
        tail = max([c.order for c in bouquet.channels if c.order is not None] + [-1])
        added = 0
        for sub_id in (rule.subscription_ids or sorted(catalogues)):
            for stream in catalogues.get(sub_id, []):
                key = (sub_id, str(stream.get("stream_id")))
                if key in held:
                    continue
                name = str(stream.get("name") or "")
                if not rule.matches(sub_id, str(stream.get("category_id") or ""), name):
                    continue
                if playlist.use_channel_numbers:
                    start = bouquet.number_start if bouquet.number_start is not None else tail + 1
                    number = next_free_number(used, max(start, tail + 1), bouquet.number_end)
                    if number is None:
                        number = next_free_number(used, tail + 1, None)
                else:
                    number = tail + 1
                tail = number
                used.append(number)
                held.add(key)
                db.add(LivePlaylistChannel(
                    bouquet_id=bouquet.id, subscription_id=sub_id, stream_id=key[1],
                    custom_name=name, order=number, is_excluded=False,
                ))
                added += 1
        report.append({"id": bouquet.id, "name": bouquet.custom_name, "added": added})
    db.commit()
    return report


@router.post("/playlists/{playlist_id}/rules/refresh")
async def refresh_rules(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    playlist = _playlist(db, playlist_id)
    return {"groups": await refresh_rule_groups(db, playlist)}


@router.post("/playlists/{playlist_id}/rules/preview")
async def preview_rule(playlist_id: int, rule: RuleIn, db: Session = Depends(deps.get_db)) -> Any:
    """What a rule would match right now, before it is saved."""
    _playlist(db, playlist_id)
    parsed = GroupRule(**rule.model_dump())
    if not parsed.is_usable():
        return {"total": 0, "sample": []}
    subs = parsed.subscription_ids or [s.id for s in db.query(Subscription.id).all()]
    catalogues = await _catalogues(db, subs)
    hits = [
        {"subscription_id": sid, "stream_id": str(s.get("stream_id")), "name": s.get("name")}
        for sid, streams in catalogues.items() for s in streams
        if parsed.matches(sid, str(s.get("category_id") or ""), str(s.get("name") or ""))
    ]
    return {"total": len(hits), "sample": hits[:30]}


# ---------------------------------------------------------------------------
# What changed at the providers since the last review
# ---------------------------------------------------------------------------

def _record_seen(db: Session, sub_id: int, streams: List[dict]) -> Dict[str, datetime]:
    """first_seen for every stream of a provider, recording the new ones now."""
    known = {row.stream_id: row.first_seen
             for row in db.query(LiveCatalogSeen).filter_by(subscription_id=sub_id)}
    first_time = not known
    stamp = KNOWN_BEFORE if first_time else datetime.utcnow()
    fresh = []
    for stream in streams:
        sid = str(stream.get("stream_id"))
        if sid not in known:
            known[sid] = stamp
            fresh.append({"subscription_id": sub_id, "stream_id": sid, "first_seen": stamp})
    if fresh:
        db.bulk_insert_mappings(LiveCatalogSeen, fresh)
        db.commit()
    return known


@router.get("/playlists/{playlist_id}/changes")
async def provider_changes(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """New provider channels in the categories this playlist draws from, and the
    channels it lost, since the user last reviewed it."""
    playlist = _playlist(db, playlist_id)
    dropped: List[dict] = []
    served = await resolve_playlist_channels(db, playlist, dropped=dropped)
    since = playlist.reviewed_at or playlist.created_at or KNOWN_BEFORE

    used: Dict[int, set] = defaultdict(set)
    for ch in served:
        if ch.get("category_id"):
            used[ch["subscription_id"]].add(ch["category_id"])
    for bouquet in playlist.bouquets:
        rule = GroupRule.parse(bouquet.rule)
        if rule:
            for sid in rule.subscription_ids:
                used[sid].update(rule.category_ids)

    present = {(c.subscription_id, str(c.stream_id)) for b in playlist.bouquets for c in b.channels}
    catalogues = await _catalogues(db, used.keys())
    sub_names = {s.id: s.name for s in db.query(Subscription).all()}
    new_items = []
    for sid, streams in catalogues.items():
        first_seen = _record_seen(db, sid, streams)
        try:
            categories = {str(c.get("category_id")): c.get("category_name")
                          for c in await get_catalog(db, db.query(Subscription).get(sid)).get_live_categories()}
        except Exception:
            categories = {}
        for stream in streams:
            category = str(stream.get("category_id") or "")
            stream_id = str(stream.get("stream_id"))
            if category not in used[sid] or (sid, stream_id) in present:
                continue
            seen_at = first_seen.get(stream_id)
            if seen_at and seen_at > since:
                new_items.append({
                    "subscription_id": sid, "subscription_name": sub_names.get(sid, ""),
                    "stream_id": stream_id, "name": stream.get("name"),
                    "stream_icon": stream.get("stream_icon"), "epg_channel_id": stream.get("epg_channel_id"),
                    "category_id": category, "category_name": categories.get(category, ""),
                    "first_seen": seen_at.isoformat(),
                })
    lost = [d for d in dropped if d.get("channel_id")]
    return {
        "since": since.isoformat() if since else None,
        "new_count": len(new_items), "new": new_items[:300],
        "lost_count": len(lost), "lost": lost[:100],
    }


@router.post("/playlists/{playlist_id}/changes/review")
def mark_reviewed(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    playlist = _playlist(db, playlist_id)
    playlist.reviewed_at = datetime.utcnow()
    db.commit()
    return {"reviewed_at": playlist.reviewed_at.isoformat()}


# ---------------------------------------------------------------------------
# Search every provider at once
# ---------------------------------------------------------------------------

def _norm(text: str) -> str:
    import unicodedata
    # NFKC first: providers decorate names with superscripts ("ᴴᴰ") and
    # symbols ("SP⚽RTS") that only compatibility folding brings back to text.
    folded = unicodedata.normalize("NFKC", text or "")
    return " ".join(strip_accents(folded).lower().replace("_", " ").split())


def _matcher(query: str):
    """Every word must appear; a number must appear as a whole number, so
    "france 2" finds France 2 and not France 24."""
    import re
    words = _norm(query).split()
    patterns = [re.compile(rf"(?<!\d){re.escape(w)}(?!\d)") if w.isdigit() else None for w in words]

    def score(name: str) -> Optional[int]:
        text = _norm(name)
        rank = 0
        for word, pattern in zip(words, patterns):
            if pattern is not None:
                if not pattern.search(text):
                    return None
            elif word not in text:
                return None
            elif not re.search(r"\b" + re.escape(word) + r"\b", text):
                rank += 5          # inside a longer word: weaker
        return rank + len(text) // 10   # shorter names first
    return score


@router.get("/search")
async def search_everywhere(q: str = Query(..., min_length=2), limit: int = Query(30, ge=1, le=200),
                            db: Session = Depends(deps.get_db)) -> Any:
    """Live channels whose name contains every word of ``q``, per provider.

    Accent- and case-insensitive. One call for all providers, so finding a
    channel no longer means guessing which provider and which of 900
    categories it is in.
    """
    score = _matcher(q)
    results = []
    for sub in db.query(Subscription).order_by(Subscription.id).all():
        try:
            client = get_catalog(db, sub)
            streams = await client.get_live_streams()
            categories = {str(c.get("category_id")): c.get("category_name")
                          for c in await client.get_live_categories()}
        except Exception as e:
            logger.warning("Search: %s unavailable: %s", sub.name, e)
            results.append({"subscription_id": sub.id, "subscription_name": sub.name,
                            "total": 0, "items": [], "error": str(e)})
            continue
        ranked = []
        for stream in streams:
            rank = score(str(stream.get("name") or ""))
            if rank is not None:
                ranked.append((rank, stream))
        ranked.sort(key=lambda item: item[0])
        hits = []
        for _, stream in ranked[:limit]:
            category = str(stream.get("category_id") or "")
            hits.append({
                "stream_id": str(stream.get("stream_id")), "name": stream.get("name"),
                "stream_icon": stream.get("stream_icon"),
                "epg_channel_id": stream.get("epg_channel_id"),
                "category_id": category, "category_name": categories.get(category, ""),
            })
        results.append({"subscription_id": sub.id, "subscription_name": sub.name,
                        "total": len(ranked), "items": hits})
    return results



# ---------------------------------------------------------------------------
# Named versions
# ---------------------------------------------------------------------------

AUTOMATIC_VERSIONS_KEPT = 20


def _snapshot(playlist: LivePlaylist) -> Dict[str, Any]:
    return {"use_channel_numbers": bool(playlist.use_channel_numbers), "bouquets": [
        {"custom_name": b.custom_name, "category_id": b.category_id, "subscription_id": b.subscription_id,
         "order": b.order, "number_start": b.number_start, "number_end": b.number_end, "rule": b.rule,
         "channels": [{"stream_id": str(c.stream_id), "subscription_id": c.subscription_id,
                       "custom_name": c.custom_name, "order": c.order, "is_excluded": bool(c.is_excluded),
                       "epg_channel_id": c.epg_channel_id} for c in _channels(b)]}
        for b in _groups(playlist)]}


def save_version(db: Session, playlist: LivePlaylist, name: str, automatic: bool = False) -> LivePlaylistVersion:
    """Store the playlist as it is now. Automatic versions are pruned to the
    last 20; the ones the user names are never deleted by the app."""
    snap = _snapshot(playlist)
    version = LivePlaylistVersion(
        playlist_id=playlist.id, name=name[:120], automatic=automatic, created_at=datetime.utcnow(),
        channel_count=sum(len(b["channels"]) for b in snap["bouquets"]), snapshot=json.dumps(snap))
    db.add(version)
    db.flush()
    if automatic:
        old = db.query(LivePlaylistVersion).filter_by(playlist_id=playlist.id, automatic=True) \
            .order_by(LivePlaylistVersion.created_at.desc()).offset(AUTOMATIC_VERSIONS_KEPT).all()
        for row in old:
            db.delete(row)
    return version


def _version_out(v: LivePlaylistVersion) -> Dict[str, Any]:
    return {"id": v.id, "name": v.name, "automatic": bool(v.automatic),
            "created_at": v.created_at.isoformat(), "channel_count": v.channel_count}


@router.get("/playlists/{playlist_id}/versions")
def list_versions(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    _playlist(db, playlist_id)
    rows = db.query(LivePlaylistVersion).filter_by(playlist_id=playlist_id) \
        .order_by(LivePlaylistVersion.created_at.desc()).all()
    return [_version_out(v) for v in rows]


class VersionIn(BaseModel):
    name: str


@router.post("/playlists/{playlist_id}/versions")
def create_version(playlist_id: int, payload: VersionIn, db: Session = Depends(deps.get_db)) -> Any:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the version a name.")
    version = save_version(db, _playlist(db, playlist_id), name)
    db.commit()
    return _version_out(version)


@router.post("/playlists/{playlist_id}/versions/{version_id}/restore")
def restore_version(playlist_id: int, version_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """Put the playlist back as it was in a version.

    The current state is saved first (as an automatic version), so a restore
    can itself be undone. Groups and channels are re-created: ids change,
    the player URLs do not.
    """
    playlist = _playlist(db, playlist_id)
    version = db.query(LivePlaylistVersion).filter_by(id=version_id, playlist_id=playlist_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    snap = json.loads(version.snapshot)
    save_version(db, playlist, f"Before restoring “{version.name}”", automatic=True)
    for bouquet in list(playlist.bouquets):
        db.delete(bouquet)
    db.flush()
    for b in snap.get("bouquets", []):
        bouquet = LivePlaylistBouquet(
            playlist_id=playlist.id, custom_name=b.get("custom_name"), category_id=b.get("category_id"),
            subscription_id=b.get("subscription_id"), order=b.get("order", 0),
            number_start=b.get("number_start"), number_end=b.get("number_end"), rule=b.get("rule"))
        db.add(bouquet)
        db.flush()
        for c in b.get("channels", []):
            db.add(LivePlaylistChannel(
                bouquet_id=bouquet.id, stream_id=c["stream_id"], subscription_id=c.get("subscription_id"),
                custom_name=c.get("custom_name"), order=c.get("order", 0),
                is_excluded=c.get("is_excluded", False), epg_channel_id=c.get("epg_channel_id")))
    if "use_channel_numbers" in snap:
        playlist.use_channel_numbers = snap["use_channel_numbers"]
    db.commit()
    return {"restored": version.name, "channels": version.channel_count}


@router.delete("/playlists/{playlist_id}/versions/{version_id}")
def delete_version(playlist_id: int, version_id: int, db: Session = Depends(deps.get_db)) -> Any:
    version = db.query(LivePlaylistVersion).filter_by(id=version_id, playlist_id=playlist_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    db.delete(version)
    db.commit()
    return {"deleted": version_id}


# ---------------------------------------------------------------------------
# Reference channels the playlist does not carry yet
# ---------------------------------------------------------------------------

_INDEX_CACHE: Dict[Tuple[int, int], Dict[str, Any]] = {}

# Provider prefixes that mean "this country's feed", per reference profile.
PROFILE_REGIONS = {"detailed": ("FR",), "compact": ("FR",), "arabic": ("TN", "AR")}


def _region(name: str) -> str:
    """'FR| TF1' -> 'FR', 'BE: FRANCE 2' -> 'BE', 'France 2' -> ''."""
    found = re.match(r"\s*([A-Za-z]{2,3})\s*[|:_-]", name or "")
    return found.group(1).upper() if found else ""


def _catalogue_index(sub_id: int, streams: List[dict]) -> Dict[str, Any]:
    """Streams of a provider by channel identity and by guide id.

    Parsing 57 000 names takes seconds, so the index is kept until the
    catalogue changes size.
    """
    key = (sub_id, len(streams))
    if key not in _INDEX_CACHE:
        for stale in [k for k in _INDEX_CACHE if k[0] == sub_id]:
            del _INDEX_CACHE[stale]
        by_key: Dict[Tuple[str, int], List[dict]] = defaultdict(list)
        by_tvg: Dict[str, List[dict]] = defaultdict(list)
        for stream in streams:
            name = str(stream.get("name") or "")
            if not name:
                continue
            by_key[channel_key(name)].append(stream)
            tvg = str(stream.get("epg_channel_id") or "").strip()
            if tvg:
                by_tvg[tvg].append(stream)
        _INDEX_CACHE[key] = {"key": by_key, "tvg": by_tvg}
    return _INDEX_CACHE[key]


@router.get("/playlists/{playlist_id}/reference-missing")
async def reference_missing(playlist_id: int, profile: Optional[str] = None,
                            db: Session = Depends(deps.get_db)) -> Any:
    """Reference channels absent from the playlist that a provider carries.

    Found by the organiser's own identity (decoded name and aliases) or by
    guide id, so "France 2" is found as "FR| FRANCE 2 FHD" at Strong. Each
    comes with its official number, its group and its guide id.
    """
    from app.services.playlist_tools import parse_name
    playlist = _playlist(db, playlist_id)
    served = await resolve_playlist_channels(db, playlist)
    references = {name: load_profile(name) for name in PROFILES}
    chosen = profile or best_profile(
        references, [b.custom_name for b in playlist.bouquets],
        [(c["name"], c["epg_id"], c.get("bouquet", "")) for c in served])
    if not chosen or chosen not in references:
        return {"profile": None, "missing": [], "without_source": 0}
    reference = references[chosen]

    present = set()
    for ch in served:
        found = reference_lookup(reference, ch["name"], ch["epg_id"])
        if found:
            present.add((found.number, found.name))
    for b in playlist.bouquets:
        for c in b.channels:
            found = reference_lookup(reference, c.custom_name or "", "")
            if found:
                present.add((found.number, found.name))

    sub_names = {s.id: s.name for s in db.query(Subscription).all()}
    catalogues = await _catalogues(db, list(sub_names))
    indexes = {sid: _catalogue_index(sid, streams) for sid, streams in catalogues.items()}
    preference = {"FHD": 0, "HD": 1, "4K": 2, "SD": 3, "": 4, "8K": 5}
    # The feed of the profile's country first: "BE: FRANCE 2" is France 2 as
    # relayed in Belgium, "FR: FRANCE 2" is the one a French playlist wants.
    home = PROFILE_REGIONS.get(chosen, ())
    tally: Dict[int, int] = defaultdict(int)
    for b in playlist.bouquets:
        for c in b.channels:
            if c.subscription_id:
                tally[c.subscription_id] += 1
    dominant = max(tally, key=tally.get) if tally else None

    missing, without_source = [], 0
    for rc in reference.channels:
        if (rc.number, rc.name) in present:
            continue
        keys = {channel_key(rc.name)} | {channel_key(a) for a in rc.aliases}
        seen, candidates = set(), []
        for sid, index in indexes.items():
            hits = [s for k in keys for s in index["key"].get(k, [])]
            if rc.tvg_id:
                hits += index["tvg"].get(rc.tvg_id, [])
            for stream in hits:
                ident = (sid, str(stream.get("stream_id")))
                if ident in seen:
                    continue
                seen.add(ident)
                name = str(stream.get("name") or "")
                quality = parse_name(name).quality
                candidates.append({"subscription_id": sid, "subscription_name": sub_names.get(sid, ""),
                                   "stream_id": ident[1], "name": name, "quality": quality,
                                   "stream_icon": stream.get("stream_icon"),
                                   "category_id": str(stream.get("category_id") or "")})
        if not candidates:
            without_source += 1
            continue
        candidates.sort(key=lambda c: (_region(c["name"]) not in home if home else False,
                                       c["subscription_id"] != dominant,
                                       preference.get(c["quality"], 4), len(c["name"])))
        missing.append({"number": rc.number, "name": rc.name, "group": rc.group, "tvg_id": rc.tvg_id,
                        "has_guide": rc.has_guide, "candidates": candidates[:6],
                        "candidate_count": len(candidates)})
    return {"profile": chosen, "missing": missing, "without_source": without_source}


# ---------------------------------------------------------------------------
# Bulk rename
# ---------------------------------------------------------------------------

class RenameItem(BaseModel):
    id: int
    custom_name: Optional[str] = None


class BulkRenameIn(BaseModel):
    renames: List[RenameItem]


@router.post("/playlists/{playlist_id}/channels/rename-bulk")
def rename_bulk(playlist_id: int, payload: BulkRenameIn, db: Session = Depends(deps.get_db)) -> Any:
    """Apply many renames in one transaction (the editor computes them)."""
    wanted = {r.id: (r.custom_name or "").strip() or None for r in payload.renames}
    rows = _own_channels(db, playlist_id, list(wanted))
    for row in rows:
        row.custom_name = wanted[row.id]
    db.commit()
    return {"renamed": len(rows)}


# ---------------------------------------------------------------------------
# Guide: what is on now and next, for any ids
# ---------------------------------------------------------------------------

class IdsIn(BaseModel):
    ids: List[str]


@router.post("/playlists/{playlist_id}/epg/now")
def epg_now(playlist_id: int, payload: IdsIn, db: Session = Depends(deps.get_db)) -> Any:
    """Programme on air and next for guide ids, from this playlist's sources.

    Lets the mapping dialog show *what each candidate is broadcasting*: the
    quickest way to tell the right "France 3" from a regional one.
    """
    playlist = _playlist(db, playlist_id)
    return epg_service.guide_states(epg_service.active_source_ids(playlist), payload.ids[:200])


# ---------------------------------------------------------------------------
# Stream test
# ---------------------------------------------------------------------------

async def _run(args: List[str], timeout: float) -> Tuple[int, bytes, bytes]:
    import asyncio
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, b"", b"timed out"
    return proc.returncode, out, err


@router.post("/playlists/{playlist_id}/channels/{channel_id}/probe")
async def probe_channel(playlist_id: int, channel_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """Open the stream like a player would: does it play, in what quality,
    how long until the first image, and what does that image show.

    One connection at a time: providers often allow a single stream per
    account, so a test can interrupt a television watching the same account.
    """
    import base64
    import time
    rows = _own_channels(db, playlist_id, [channel_id])
    if not rows:
        raise HTTPException(status_code=404, detail="Channel not found")
    row = rows[0]
    sub_id = row.subscription_id or row.bouquet.subscription_id or _playlist(db, playlist_id).subscription_id
    sub = db.query(Subscription).filter(Subscription.id == sub_id).first()
    if not sub:
        raise HTTPException(status_code=422, detail="This channel's provider no longer exists.")
    url = get_catalog(db, sub).get_stream_url("live", str(row.stream_id), "ts")
    agent: List[str] = []
    try:
        from app.models.downloads import DownloadSettingsGlobal
        settings_row = db.query(DownloadSettingsGlobal).first()
        if settings_row and getattr(settings_row, "user_agent", None):
            agent = ["-user_agent", settings_row.user_agent]
    except Exception:
        pass

    started = time.monotonic()
    code, out, err = await _run(
        ["ffprobe", "-v", "error", *agent, "-rw_timeout", "10000000",
         "-analyzeduration", "4000000", "-probesize", "4000000",
         "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,channels:format=bit_rate",
         "-of", "json", url], timeout=20)
    seconds = round(time.monotonic() - started, 1)
    if code != 0:
        message = (err.decode(errors="ignore").strip().splitlines() or ["no answer"])[-1]
        # The URL holds the account credentials: never echo it back.
        message = message.replace(url, "<stream>")
        return {"ok": False, "seconds": seconds, "error": message[:300]}
    info = json.loads(out or b"{}")
    # An HLS stream lists one video per variant (240p … 1080p): the player
    # picks the best one, so the report does too.
    videos = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    video = max(videos, key=lambda s: s.get("height") or 0) if videos else None
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)

    def fps(value: Optional[str]) -> Optional[float]:
        try:
            num, den = (value or "0/1").split("/")
            return round(int(num) / int(den), 2) if int(den) else None
        except ValueError:
            return None

    image = None
    code, out, _ = await _run(
        ["ffmpeg", "-v", "error", *agent, "-rw_timeout", "10000000", "-i", url,
         "-frames:v", "1", "-vf", "scale=480:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], timeout=25)
    if code == 0 and out:
        image = "data:image/jpeg;base64," + base64.b64encode(out).decode()
    bitrate = info.get("format", {}).get("bit_rate")
    return {
        "ok": True, "seconds": seconds,
        "video": video and {"codec": video.get("codec_name"), "width": video.get("width"),
                            "height": video.get("height"), "fps": fps(video.get("avg_frame_rate"))},
        "audio": audio and {"codec": audio.get("codec_name"), "channels": audio.get("channels")},
        "bitrate_kbps": int(bitrate) // 1000 if bitrate and str(bitrate).isdigit() else None,
        "image": image,
    }
