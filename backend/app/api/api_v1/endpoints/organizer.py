"""Propose, then materialise, an automatic organisation of the live channels.

Two endpoints, and the split between them is the whole point: ``/preview`` reads
the providers and returns a plan without writing a single row, ``/apply`` writes
what the user validated. Nothing is ever reorganised as a side effect of looking
at it.

``/apply`` always creates a **new** playlist. The existing ones are never touched,
so the proposal can be compared on the television against what it replaces, and
rejected by deleting one playlist.
"""

from typing import Any, Dict, List, Optional

import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api import deps
from app.models.epg import EPGSourceGlobal, PlaylistEPGSource
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel
from app.models.subscription import Subscription
from app.services.organizer import (
    BACKUP_GROUP, DEFAULT_PROFILE, PROFILES, OrganizeOptions,
    Reference, SourceStream, load_profile, organize, plan_to_dict,
)
from app.services.catalog import get_catalog

logger = logging.getLogger(__name__)

router = APIRouter()


class ScopeIn(BaseModel):
    """Which categories of which subscription to organise."""

    subscription_id: int
    category_ids: List[str] = Field(default_factory=list)  # empty = every category


class OptionsIn(BaseModel):
    quality_preference: List[str] = Field(
        default_factory=lambda: ["4K", "FHD", "HD", "SD", "8K"]
    )
    keep_backups: bool = True
    separate_timeshift: bool = True
    fuzzy_threshold: int = Field(default=90, ge=60, le=100)
    subscription_priority: List[int] = Field(default_factory=list)
    include_unmatched: bool = True

    def to_options(self) -> OrganizeOptions:
        return OrganizeOptions(
            quality_preference=self.quality_preference,
            keep_backups=self.keep_backups,
            separate_timeshift=self.separate_timeshift,
            fuzzy_threshold=self.fuzzy_threshold,
            subscription_priority=self.subscription_priority,
            include_unmatched=self.include_unmatched,
        )


class PreviewIn(BaseModel):
    scopes: List[ScopeIn]
    options: OptionsIn = Field(default_factory=OptionsIn)
    # "detailed" (eleven thematic blocks) or "compact" (eight bouquets plus the
    # family rules). Same 502 channels behind both.
    profile: str = DEFAULT_PROFILE


def _profile(name: Optional[str]) -> Reference:
    """The requested reference, or a 422 naming the ones that exist."""
    try:
        return load_profile(name)
    except KeyError:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown profile '{name}'. Available: {sorted(PROFILES)}",
        )


class ApplyChannelIn(BaseModel):
    """One channel of the validated plan, as the preview described it."""

    number: int
    name: str
    group: str
    tvg_id: str = ""
    subscription_id: int
    stream_id: str


class ApplyIn(BaseModel):
    playlist_name: str
    description: Optional[str] = None
    channels: List[ApplyChannelIn]
    group_order: List[str] = Field(default_factory=list)
    # Omitted = link every active source. A playlist with no source serves an
    # empty guide, which reads as a broken organisation rather than a missing
    # link, so the default has to be "the same guides as everything else".
    epg_source_ids: Optional[List[int]] = None
    # What the screen was asked (profile, scopes, options). Stored on the
    # playlist so the organiser can be re-run against it later.
    config: Optional[Dict[str, Any]] = None


async def _collect_streams(db: Session, scopes: List[ScopeIn]) -> List[SourceStream]:
    """Read the selected categories from every source involved.

    Each source is fetched once and filtered locally: asking the provider per
    category multiplies the round trips by the number of categories, and these
    catalogues run to 900 of them.

    An M3U playlist is read here exactly like an Xtream subscription — its group
    titles are its categories, and its channels carry the URL the playlist gave.
    """
    collected: List[SourceStream] = []
    for scope in scopes:
        sub = db.query(Subscription).filter(Subscription.id == scope.subscription_id).first()
        if not sub:
            raise HTTPException(status_code=404,
                                detail=f"Subscription {scope.subscription_id} not found")
        client = get_catalog(db, sub)
        try:
            categories = await client.get_live_categories()
            streams = await client.get_live_streams()
        except (httpx.ConnectTimeout, httpx.ReadTimeout):
            raise HTTPException(status_code=504,
                                detail=f"Provider {sub.name} timed out")
        except (httpx.ConnectError, httpx.RequestError) as e:
            raise HTTPException(status_code=502,
                                detail=f"Provider {sub.name} unreachable: {e}")
        except Exception as e:
            # An M3U source fails in its own ways — a playlist that 404s, an
            # uploaded file that is gone. Same outcome for the caller.
            raise HTTPException(status_code=502,
                                detail=f"Could not read {sub.name}: {e}")

        names = {str(c.get("category_id")): c.get("category_name", "") for c in categories}
        wanted = {str(c) for c in scope.category_ids}
        for raw in streams:
            category_id = str(raw.get("category_id"))
            if wanted and category_id not in wanted:
                continue
            collected.append(
                SourceStream.from_provider(raw, scope.subscription_id,
                                           names.get(category_id, ""))
            )
    return collected


@router.get("/profiles")
def list_profiles() -> Any:
    """The reference profiles on offer, with what each one produces.

    The bouquet count is what the screen needs to make the choice meaningful, and
    it can only be read off the file, so it is counted here rather than written
    down twice.
    """
    result = []
    for name in PROFILES:
        reference = load_profile(name)
        result.append({
            "name": name,
            "version": reference.version,
            "blocks": [b["group"] for b in reference.blocks],
            "block_count": len(reference.blocks),
            "family_count": len(reference.families),
            "channels": len(reference.channels),
            "is_default": name == DEFAULT_PROFILE,
        })
    return result


@router.get("/reference")
def get_reference(
    group: Optional[str] = Query(None),
    profile: str = Query(DEFAULT_PROFILE),
    db: Session = Depends(deps.get_db),
) -> Any:
    """The reference list itself — what the engine organises towards."""
    reference = _profile(profile)
    channels = [c for c in reference.channels if not group or c.group == group]
    return {
        "version": reference.version,
        "profile": profile,
        "blocks": reference.blocks,
        "families": [
            {"id": f.id, "group": f.group, "start": f.start, "label": f.label}
            for f in reference.families
        ],
        "total": len(reference.channels),
        "channels": [
            {
                "number": c.number, "group": c.group, "name": c.name,
                "tvg_id": c.tvg_id, "logo": c.logo, "source": c.source,
                "has_guide": c.has_guide, "aliases": c.aliases,
            }
            for c in channels
        ],
    }


@router.post("/preview")
async def preview_organization(
    payload: PreviewIn,
    db: Session = Depends(deps.get_db),
) -> Any:
    """Compute the proposed organisation. Writes nothing."""
    if not payload.scopes:
        raise HTTPException(status_code=422, detail="Select at least one subscription")

    streams = await _collect_streams(db, payload.scopes)
    if not streams:
        raise HTTPException(
            status_code=422,
            detail="The selected categories hold no stream. Nothing to organise.",
        )

    plan = organize(streams, _profile(payload.profile), payload.options.to_options())
    result = plan_to_dict(plan)
    result["source_stream_count"] = len(streams)
    return result


@router.post("/apply")
def apply_organization(
    payload: ApplyIn,
    db: Session = Depends(deps.get_db),
) -> Any:
    """Write the validated plan into a **new** playlist.

    Refuses an empty plan rather than creating an empty playlist: an empty
    selection means nothing was wanted, and the caller almost certainly lost
    its state between the preview and the apply.
    """
    if not payload.channels:
        raise HTTPException(status_code=422,
                            detail="The plan holds no channel — nothing was applied.")

    name = (payload.playlist_name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A playlist name is required")

    known_subs = {s.id for s in db.query(Subscription.id).all()}
    unknown = {c.subscription_id for c in payload.channels} - known_subs
    if unknown:
        raise HTTPException(status_code=422,
                            detail=f"Unknown subscription(s): {sorted(unknown)}")

    # This playlist's orders *are* channel numbers — that is the whole point of
    # the organisation — so it publishes them.
    playlist = LivePlaylist(name=name, description=payload.description,
                            use_channel_numbers=True,
                            organizer_config=json.dumps(payload.config) if payload.config else None)
    db.add(playlist)
    db.flush()  # need the id before the bouquets

    # Group order: what the caller validated, then anything it did not mention,
    # with the Secours group last whatever happens.
    groups: Dict[str, List[ApplyChannelIn]] = {}
    for channel in payload.channels:
        groups.setdefault(channel.group, []).append(channel)

    # Deduplicated on the way in: the caller sends the preview's group order,
    # which already contains the Secours group, and appending it again wrote
    # every one of its channels a second time.
    ordered_names: List[str] = []
    for group_name in list(payload.group_order) + list(groups):
        if group_name in groups and group_name != BACKUP_GROUP \
                and group_name not in ordered_names:
            ordered_names.append(group_name)
    if BACKUP_GROUP in groups:
        ordered_names.append(BACKUP_GROUP)

    created_channels = 0
    for position, group_name in enumerate(ordered_names):
        bouquet = LivePlaylistBouquet(
            playlist_id=playlist.id,
            subscription_id=None,   # the channels carry their own origin
            category_id=None,       # a virtual group: only what we put in it
            custom_name=group_name,
            order=position,
        )
        db.add(bouquet)
        db.flush()

        for channel in sorted(groups[group_name], key=lambda c: c.number):
            db.add(LivePlaylistChannel(
                bouquet_id=bouquet.id,
                subscription_id=channel.subscription_id,
                stream_id=str(channel.stream_id),
                custom_name=channel.name,
                # The channel number is the order: it is what the M3U serves and
                # what a player displays, so the two must not be able to diverge.
                order=channel.number,
                epg_channel_id=channel.tvg_id or None,
                is_excluded=False,
            ))
            created_channels += 1

    if payload.epg_source_ids is None:
        sources = db.query(EPGSourceGlobal).filter(
            EPGSourceGlobal.is_active == True  # noqa: E712 — SQLAlchemy needs ==
        ).all()
    else:
        sources = db.query(EPGSourceGlobal).filter(
            EPGSourceGlobal.id.in_(payload.epg_source_ids)
        ).all()

    for position, source in enumerate(sources):
        db.add(PlaylistEPGSource(playlist_id=playlist.id, epg_source_id=source.id,
                                 priority=len(sources) - position))

    db.commit()
    db.refresh(playlist)

    logger.info("Organizer: playlist %s (%s) created with %s groups, %s channels, "
                "%s EPG source(s)", playlist.id, name, len(ordered_names),
                created_channels, len(sources))
    return {
        "status": "success",
        "playlist_id": playlist.id,
        "playlist_name": playlist.name,
        "groups": len(ordered_names),
        "channels": created_channels,
        "epg_sources_linked": len(sources),
    }


# ---------------------------------------------------------------------------
# Re-running the organiser against a playlist it already built
# ---------------------------------------------------------------------------

@router.get("/config/{playlist_id}")
async def get_organizer_config(playlist_id: int, db: Session = Depends(deps.get_db)) -> Any:
    """What the organiser was asked when it built (or last updated) this playlist.

    Playlists built before the settings were stored get an inferred config:
    the provider categories their channels come from, and the profile that
    recognises most of them. ``inferred`` says which case it is.
    """
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.organizer_config:
        try:
            return {"config": json.loads(playlist.organizer_config), "inferred": False}
        except ValueError:
            pass

    from app.api.api_v1.endpoints.live import resolve_playlist_channels
    from app.services.playlist_tools import best_profile
    served = await resolve_playlist_channels(db, playlist)
    if not served:
        return {"config": None, "inferred": True}
    scopes: Dict[int, set] = {}
    for channel in served:
        if channel.get("category_id"):
            scopes.setdefault(channel["subscription_id"], set()).add(channel["category_id"])
    references = {name: load_profile(name) for name in PROFILES}
    profile = best_profile(
        references, [b.custom_name for b in playlist.bouquets],
        [(c["name"], c["epg_id"], c.get("bouquet", "")) for c in served]) or DEFAULT_PROFILE
    return {
        "config": {
            "profile": profile,
            "scopes": [{"subscription_id": sid, "category_ids": sorted(ids)} for sid, ids in scopes.items()],
        },
        "inferred": True,
    }


class DiffIn(BaseModel):
    playlist_id: int
    channels: List[ApplyChannelIn]


def _rows_by_key(playlist: LivePlaylist):
    out = {}
    for bouquet in playlist.bouquets:
        for channel in bouquet.channels:
            out.setdefault((channel.subscription_id, str(channel.stream_id)), (bouquet, channel))
    return out


@router.post("/diff")
def diff_organization(payload: DiffIn, db: Session = Depends(deps.get_db)) -> Any:
    """Compare a fresh proposal with an existing playlist. Writes nothing.

    * ``add``      — channels of the proposal the playlist does not hold;
    * ``remove``   — channels of the playlist the proposal no longer has
                     (often channels added by hand: the screen leaves them
                     unticked by default);
    * ``renumber`` — channels in both, whose number or group differs.
    """
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == payload.playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    rows = _rows_by_key(playlist)
    used = {c.order for b in playlist.bouquets for c in b.channels}
    groups = {b.custom_name for b in playlist.bouquets}
    planned = set()
    add, renumber = [], []
    for ch in payload.channels:
        key = (ch.subscription_id, str(ch.stream_id))
        planned.add(key)
        if key not in rows:
            add.append({**ch.model_dump(), "group_exists": ch.group in groups,
                        "number_free": ch.number not in used})
            continue
        bouquet, row = rows[key]
        if row.order != ch.number or bouquet.custom_name != ch.group:
            renumber.append({"channel_id": row.id, "name": row.custom_name or ch.name,
                             "from_number": row.order, "to_number": ch.number,
                             "from_group": bouquet.custom_name, "to_group": ch.group})
    remove = [
        {"channel_id": row.id, "name": row.custom_name or f"Channel {row.stream_id}",
         "group": bouquet.custom_name, "number": row.order}
        for key, (bouquet, row) in rows.items()
        if key not in planned and not row.is_excluded
    ]
    return {"add": add, "remove": remove, "renumber": renumber,
            "unchanged": len(payload.channels) - len(add) - len(renumber)}


class RenumberIn(BaseModel):
    channel_id: int
    number: int
    group: str


class UpdateIn(BaseModel):
    playlist_id: int
    add: List[ApplyChannelIn] = Field(default_factory=list)
    remove_channel_ids: List[int] = Field(default_factory=list)
    renumber: List[RenumberIn] = Field(default_factory=list)
    config: Optional[Dict[str, Any]] = None


@router.post("/update")
def update_organization(payload: UpdateIn, db: Session = Depends(deps.get_db)) -> Any:
    """Apply the ticked part of a diff to an existing playlist. One transaction.

    Renames, guide mappings and numbers the user set by hand are kept on every
    channel the diff does not explicitly touch. A group the proposal needs and
    the playlist lacks is created before the Secours group.
    """
    playlist = db.query(LivePlaylist).filter(LivePlaylist.id == payload.playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    by_name = {b.custom_name: b for b in playlist.bouquets}

    def group(name: str) -> LivePlaylistBouquet:
        if name in by_name:
            return by_name[name]
        ordered = sorted(playlist.bouquets, key=lambda b: b.order)
        backup = by_name.get(BACKUP_GROUP)
        position = backup.order if backup is not None else (ordered[-1].order + 1 if ordered else 0)
        for b in ordered:
            if b.order >= position:
                b.order += 1
        bouquet = LivePlaylistBouquet(playlist_id=playlist.id, custom_name=name, order=position)
        db.add(bouquet)
        db.flush()
        playlist.bouquets.append(bouquet)
        by_name[name] = bouquet
        return bouquet

    rows = {c.id: (b, c) for b in playlist.bouquets for c in b.channels}
    used = {c.order for _, c in rows.values()}
    existing = {(c.subscription_id, str(c.stream_id)) for _, c in rows.values()}

    removed = 0
    for channel_id in payload.remove_channel_ids:
        if channel_id in rows:
            used.discard(rows[channel_id][1].order)
            db.delete(rows[channel_id][1])
            removed += 1

    # A ticked renumbering takes its proposed number. A channel that held that
    # number and was not itself ticked is displaced to the next free number of
    # its group, rather than doubled or silently overwritten.
    moving = {item.channel_id for item in payload.renumber if item.channel_id in rows}
    owner = {c.order: c for cid, (_, c) in rows.items()
             if cid not in moving and cid not in payload.remove_channel_ids}
    displaced = []
    moved = 0
    for item in payload.renumber:
        if item.channel_id not in rows:
            continue
        _, row = rows[item.channel_id]
        target = group(item.group)
        holder = owner.pop(item.number, None)
        if holder is not None:
            displaced.append(holder)
        row.order, row.bouquet_id = item.number, target.id
        moved += 1
    used = {c.order for cid, (_, c) in rows.items()
            if cid not in payload.remove_channel_ids and c not in displaced}
    for row in displaced:
        number = row.order + 1
        while number in used:
            number += 1
        row.order = number
        used.add(number)

    added = 0
    for ch in payload.add:
        key = (ch.subscription_id, str(ch.stream_id))
        if key in existing:
            continue
        target = group(ch.group)
        number = ch.number
        while number in used:
            number += 1
        used.add(number)
        existing.add(key)
        db.add(LivePlaylistChannel(
            bouquet_id=target.id, subscription_id=ch.subscription_id,
            stream_id=str(ch.stream_id), custom_name=ch.name, order=number,
            epg_channel_id=ch.tvg_id or None, is_excluded=False,
        ))
        added += 1

    if payload.config:
        playlist.organizer_config = json.dumps(payload.config)
    db.commit()
    logger.info("Organizer: playlist %s updated: +%s, -%s, %s renumbered",
                playlist.id, added, removed, moved)
    return {"status": "success", "playlist_id": playlist.id,
            "added": added, "removed": removed, "renumbered": moved,
            "displaced": len(displaced)}
