"""Turn a provider's live catalogue into a proposed channel organisation.

The engine classifies nothing on its own. It normalises the provider's names,
merges the quality variants of a single channel, then *matches* what remains
against the reference list in ``app/data/fr_channel_reference.json`` and takes
its number, group and canonical name from there. Anything the reference does
not know keeps its own name and goes to the tail, never to a guessed group.

Nothing here touches the database or the network: it takes a list of streams
and returns a plan. That is deliberate — the classification rules are the part
most likely to be wrong, and they can only be argued about if they are testable
in isolation.

Three rules earned their place the hard way:

* **The provider prefix may be separated by anything.** One subscription writes
  ``FR: TF1 HD``, the other ``FR_CANAL_CINEMA_HD``. Missing the underscore form
  leaves ``fr`` glued to the name, which costs 67 merges and drops the reference
  hit rate from 92 % to 75 %.
* **A trailing number is part of the identity.** Fuzzy matching without that
  guard maps "RMC Sport 5" onto "RMC Sport 4" — 32 wrong channels in one pass,
  the same failure that once put 18 channels on a single EPG id.
* **A fuzzy match is never applied on its own.** It is reported for
  confirmation. Only exact matches — by tvg-id or by alias — are automatic.

A reference file may also declare **families**: ordered rules that place a whole
block of provider channels at once, and that are consulted *only* after the
per-channel lookup has failed. They exist because a catalogue holds families no
reference will ever name one by one — 507 numbered pay-per-view slots, 794
African channels, 349 twenty-four-hour film loops. Without them all of that
lands in a single "Hors référence" bouquet of 1 600 channels, which is not an
organisation. A family channel is still reported as unmatched: the reference
genuinely does not know it, and hiding that would turn a placement into a claim.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
REFERENCE_PATH = DATA_DIR / "fr_channel_reference.json"
COMPACT_PATH = DATA_DIR / "fr_channel_reference_compact.json"
ARABIC_PATH = DATA_DIR / "ar_channel_reference.json"

# The reference files the caller may ask for by name. "detailed" and "compact"
# hold the same 502 FR channels: "detailed" keeps the eleven thematic blocks,
# "compact" collapses them to eight and adds the family rules, which is what
# keeps the bouquet count down. "arabic" is a different catalogue: there is no
# ARCOM-style official numbering for pan-Arab channels, so it leans on the
# `families` mechanism (grouped by the provider's own AR| category, country
# first) with only the Tunisian flagships curated by hand.
PROFILES: Dict[str, Path] = {
    "detailed": REFERENCE_PATH, "compact": COMPACT_PATH, "arabic": ARABIC_PATH,
}
DEFAULT_PROFILE = "detailed"

# Where the reference stops and the engine takes over.
DEFAULT_TAIL_START = 1000
DEFAULT_BACKUP_START = 9000
DEFAULT_TIMESHIFT_START = 2000
BACKUP_GROUP = "Secours / Alternatives"
TAIL_GROUP = "Hors référence"
TIMESHIFT_GROUP = "Décalées (+1)"

# Ranked worst to best, so the index is the rank.
QUALITY_ORDER = ["SD", "HD", "FHD", "4K", "8K"]
DEFAULT_QUALITY_PREFERENCE = ["4K", "FHD", "HD", "SD", "8K"]

# iptv-org's own lists write the interlace flavour too ("1080i", not just
# "1080p") and use 576/360 for PAL SD and low-bandwidth feeds — "El Watania 1
# (1080i)" left "1080i" sitting in the canonical text, which then fails the
# trailing-number guard against the clean reference entry and gets refused
# outright rather than merged.
_QUALITY_PATTERNS: List[Tuple[str, str]] = [
    ("8K", r"8\s*k|⁸ᴷ"),
    ("4K", r"4\s*k|uhd|ᵁᴴᴰ|2160[pi]?"),
    ("FHD", r"fhd|1080[pi]?"),
    ("HD", r"\bhd\b|720[pi]?"),
    ("SD", r"\bsd\b|480[pi]?|576[pi]?|360p?"),
]

# Tags that describe the feed, not the channel: they must not reach the name.
_FLAG_PATTERN = re.compile(
    r"\b(h265|hevc|raw|vip|backup|ac3|multi|60fps|prime|alt|opt|option)\b", re.IGNORECASE
)

# A country/language prefix, whatever separates it from the name. ``afr`` comes
# before ``af`` only for the reader: one provider labels its African feeds ``AFR|``
# and the other ``AF|``, and missing the short form left 263 channels named
# "Af Canal+ Sport 1", none of which can match anything.
#
# ``sa``/``nm``/``ss``/``f`` are not countries: they are the AR| catalogue's own
# server/route tags ("SA: beIN SPORTS 1", "NM: beIN SPORTS 1", "F: ALWAN AFLAM 1"),
# the same shape as an unstripped "BE:" once was — missing them left ~15 identical
# beIN Sports numbers unmerged per quality tier.
_PREFIX_PATTERN = re.compile(
    r"^\s*(fr|afr|af|ar|en|be|ch|ca|tn|uk|us|de|es|it|pt|nl|tr|sa|nm|ss|f|"
    r"vip|prime|hevc|raw)"
    r"[\s_:\-|.]+",
    re.IGNORECASE,
)

# Superscript and decorative code points providers sprinkle over category names.
_DECORATION_PATTERN = re.compile(r"[²³¹⁰-₟ᴀ-ᵿ†-⯿]")

# Separator rows and service announcements a provider ships as if they were
# channels. They have no stream worth serving.
_JUNK_PATTERN = re.compile(
    r"^\s*[#=*\-_.]{2,}|[#=]{3,}|sav\s+abonnement|info\s+abonn|^\s*\|+\s*$"
    r"|^\s*(nouveau|new|update|maj)\s*[:\-]?\s*$",
    re.IGNORECASE,
)

# A delayed feed: "TF1 +1". Three forms, and the strictness differs on purpose.
#
# Detached ("TF1 +1", "TF1 + 1"), the plus must open a word, otherwise "CANAL+ 360"
# reads as Canal delayed by 360 hours — which is how "Canal+ Sport 360" ended up
# filed as a timeshift of Canal J.
#
# Glued ("TFX+1", "FR_CANAL_FAMILY+1"), no space is allowed between the plus and
# the digits, and the plus must follow a *letter*. Allowing a space would bring
# "CANAL+ 4" back; allowing a digit before would read "LIGUE1+ 8" — feed 8 of
# Ligue 1+ — as an eight-hour delay. Without this form the seventeen channels of
# one provider's cinema category never matched anything.
_TIMESHIFT_PATTERN = re.compile(
    r"(?:(?<=\s)|^)\+\s*(\d{1,2})\b"
    r"|(?<=[A-Za-z])\+(\d{1,2})\b"
    r"|\bplus\s*1\b",
    re.IGNORECASE,
)
_MAX_TIMESHIFT_HOURS = 24


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def match_key(value: str) -> str:
    """The key both sides of a comparison are reduced to.

    ``canal+`` becomes ``canalplus`` before punctuation is dropped, otherwise
    "Canal+ Sport" and "Canal Sport" — two different channels — collapse. The
    trailing space matters: providers write both "Canal+Sport" and "Canal+ Sport",
    and without it the two forms never meet.

    The keep-set is ``\\w`` (any Unicode letter or digit), not ``a-z0-9``: an
    Arabic-titled channel has no Latin letters left once accents are stripped,
    and reducing to ASCII only left every one of them keyed on nothing but a
    trailing digit — 26 unrelated series all became the same "channel" named
    ``"2"``. Latin text is unaffected because it is already lowercased ASCII by
    this point.
    """
    text = strip_accents(value).lower().replace("canal+", "canalplus ")
    text = re.sub(r"[_\W]+", " ", text)
    return " ".join(text.split())


def trailing_number(value: str) -> Optional[str]:
    """The number that closes a name, which identifies it: 'RMC Sport 5' → '5'.

    Normalised through ``int``, so a padded number is the same number: one
    provider writes "CANAL PLAY 08" and "EUROSPORT 04", and comparing the digits
    as text made those different channels from "Canal+ Play 8" and "Eurosport 4",
    rejected before the name was even scored. Unblocking the guard is all this
    does — the name still has to clear the threshold afterwards.
    """
    found = re.search(r"(\d+)\s*$", match_key(value))
    return str(int(found.group(1))) if found else None


def is_junk(name: str) -> bool:
    """True for separator rows and service notices, which are not channels."""
    if not (name or "").strip():
        return True
    return bool(_JUNK_PATTERN.search(strip_accents(name)))


@dataclass(frozen=True)
class SourceStream:
    """One live stream as the provider lists it."""

    subscription_id: int
    stream_id: str
    name: str
    category_id: str = ""
    category_name: str = ""
    epg_channel_id: str = ""
    logo: str = ""

    @classmethod
    def from_provider(cls, raw: Dict[str, Any], subscription_id: int,
                      category_name: str = "") -> "SourceStream":
        epg_id = raw.get("epg_channel_id")
        epg_id = "" if epg_id is None else str(epg_id).strip()
        # "TS" is a template placeholder, not an id: measured on the AR| Tunisia
        # categories, eight unrelated channels (Nessma, Attessia, Telvza, Carthage
        # Plus, Al Janoubia, Zaytoona, Al Insen, Al Mustakila) all carry the exact
        # same literal "TS". Keeping it would show a guide id that matches nothing.
        if epg_id.lower() in ("none", "null", "ts"):
            epg_id = ""
        return cls(
            subscription_id=subscription_id,
            stream_id=str(raw.get("stream_id", "")),
            name=str(raw.get("name") or ""),
            category_id=str(raw.get("category_id", "")),
            category_name=category_name,
            epg_channel_id=epg_id,
            logo=str(raw.get("stream_icon") or ""),
        )


@dataclass(frozen=True)
class ParsedName:
    """What a provider's channel name actually says, once decoded."""

    canonical: str          # the channel, without prefix, quality or feed tags
    quality: str            # "4K", "HD", … or "" when the name says nothing
    quality_rank: int       # index in QUALITY_ORDER, -1 when unknown
    timeshift: int          # hours of delay: 1 for "TF1 +1", 0 otherwise
    flags: Tuple[str, ...]  # RAW, VIP, H265 … kept for the report


def parse_name(raw_name: str) -> ParsedName:
    """Split a provider channel name into identity, quality and feed tags."""
    text = strip_accents(raw_name or "")
    text = _DECORATION_PATTERN.sub(" ", text)
    text = text.replace("_", " ")

    # Providers stack prefixes: "VIP: FR: TMC". Strip until none is left.
    while True:
        stripped = _PREFIX_PATTERN.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped

    timeshift = 0
    shift_match = _TIMESHIFT_PATTERN.search(text)
    if shift_match:
        digits = next((g for g in shift_match.groups() if g), None)
        hours = int(digits) if digits else 1
        if 0 < hours <= _MAX_TIMESHIFT_HOURS:
            timeshift = hours
            text = text[: shift_match.start()] + " " + text[shift_match.end():]

    quality, quality_rank = "", -1
    for label, pattern in _QUALITY_PATTERNS:
        found = re.search(pattern, text, flags=re.IGNORECASE)
        if not found:
            continue
        quality, quality_rank = label, QUALITY_ORDER.index(label)
        text = text[: found.start()] + " " + text[found.end():]
        break

    flags = tuple(sorted({f.upper() for f in _FLAG_PATTERN.findall(text)}))
    text = _FLAG_PATTERN.sub(" ", text)

    # `\w` (any Unicode letter/digit), not `A-Za-z0-9`: see match_key for why an
    # ASCII-only keep-set silently destroys every Arabic-titled channel name.
    canonical = re.sub(r"[^\w+&]+", " ", text)
    canonical = " ".join(canonical.split()).strip(" +&")
    return ParsedName(canonical=canonical, quality=quality, quality_rank=quality_rank,
                      timeshift=timeshift, flags=flags)


@dataclass
class ReferenceChannel:
    number: int
    group: str
    name: str
    tvg_id: str
    aliases: List[str]
    logo: str
    source: str
    has_guide: bool


def _family_pattern(source: str) -> re.Pattern:
    """Compile a family pattern so it reads the way it is written.

    Both sides go through ``strip_accents``, which also flattens the superscripts
    providers decorate their category names with — ``FR| MAX PPV ⱽᴵᴾ`` becomes
    ``FR| MAX PPV VIP``. So ``CINÉMA`` in the JSON matches ``CINEMA`` in the
    catalogue and the other way round, and nobody has to remember which.
    """
    return re.compile(strip_accents(source), re.IGNORECASE)


@dataclass
class ChannelFamily:
    """A rule that places a whole block of channels the reference cannot name.

    Every declared condition must hold — that is deliberate. One provider ships
    its five delayed Ligue 1 feeds inside an ordinary ``FR-SPORTS`` category and
    marks them in the *name* only ("( ONLY EVENTS )"); telling them apart needs
    the category and the name together. Two independent conditions are two
    families.
    """

    id: str
    group: str
    start: int
    category_pattern: Optional[re.Pattern] = None
    name_pattern: Optional[re.Pattern] = None
    label: str = ""
    number_from: str = "sequence"     # sequence | trailing

    @classmethod
    def from_document(cls, raw: Dict[str, Any]) -> "ChannelFamily":
        when = raw.get("when") or {}
        category = when.get("category_regex")
        name = when.get("name_regex")
        return cls(
            id=str(raw.get("id") or raw.get("group", "")),
            group=raw["group"],
            start=int(raw.get("start", DEFAULT_TAIL_START)),
            category_pattern=_family_pattern(category) if category else None,
            name_pattern=_family_pattern(name) if name else None,
            label=str(raw.get("label") or ""),
            number_from=str(raw.get("number_from") or "sequence"),
        )

    def matches(self, category: str, name: str) -> bool:
        if not (self.category_pattern or self.name_pattern):
            return False
        if self.category_pattern and not self.category_pattern.search(
                strip_accents(category or "")):
            return False
        if self.name_pattern and not self.name_pattern.search(strip_accents(name or "")):
            return False
        return True


class Reference:
    """The ordered channel list the engine matches against.

    Lookups go from certain to uncertain: the guide identifier, then the exact
    name or one of its aliases, then a fuzzy score that is only ever *proposed*.
    """

    def __init__(self, document: Dict[str, Any]):
        self.version: str = document.get("version", "")
        self.profile: str = document.get("profile", "")
        self.blocks: List[Dict[str, Any]] = document.get("blocks", [])
        self.tail_start: int = document.get("tail_starts_at", DEFAULT_TAIL_START)
        self.backup_start: int = document.get("backup_starts_at", DEFAULT_BACKUP_START)
        self.timeshift_start: int = document.get("timeshift_starts_at",
                                                 DEFAULT_TIMESHIFT_START)
        # A profile may send the delayed feeds to an existing bouquet rather than
        # spend one of its own on them.
        self.timeshift_group: str = document.get("timeshift_group", TIMESHIFT_GROUP)
        self.families: List[ChannelFamily] = [
            ChannelFamily.from_document(f) for f in document.get("families", [])
        ]
        self.channels: List[ReferenceChannel] = [
            ReferenceChannel(
                number=c["number"], group=c["group"], name=c["name"],
                tvg_id=c.get("tvg_id", ""), aliases=list(c.get("aliases") or []),
                logo=c.get("logo", ""), source=c.get("source", ""),
                has_guide=bool(c.get("has_guide", bool(c.get("tvg_id")))),
            )
            for c in document.get("channels", [])
        ]
        self.group_order: List[str] = [b["group"] for b in self.blocks]

        self._by_tvg_id: Dict[str, ReferenceChannel] = {}
        self._by_key: Dict[str, ReferenceChannel] = {}
        for channel in self.channels:
            if channel.tvg_id:
                self._by_tvg_id.setdefault(channel.tvg_id, channel)
            self._by_key.setdefault(match_key(channel.name), channel)
            for alias in channel.aliases:
                self._by_key.setdefault(match_key(alias), channel)
        self._keys: List[str] = list(self._by_key)

    def by_tvg_id(self, tvg_id: str) -> Optional[ReferenceChannel]:
        return self._by_tvg_id.get(tvg_id) if tvg_id else None

    def by_name(self, name: str) -> Optional[ReferenceChannel]:
        return self._by_key.get(match_key(name))

    def family_for(self, category: str, name: str) -> Optional[ChannelFamily]:
        """The first family rule that claims this channel, in declaration order.

        Order is the whole grammar of the section: the narrow rules are written
        first, so "( ONLY EVENTS )" inside ``FR-SPORTS`` is caught before the
        rule that sweeps the rest of that category into Sport.
        """
        for family in self.families:
            if family.matches(category, name):
                return family
        return None

    def fuzzy(self, name: str, threshold: int = 90
              ) -> Optional[Tuple[ReferenceChannel, int]]:
        """Best candidate above ``threshold``, or None.

        Rejects a candidate whose trailing number differs from the query's: a
        numbered channel is not a near-miss of its neighbour, it is a different
        channel, and accepting it silently is the worst outcome this engine can
        produce.
        """
        key = match_key(name)
        if not key:
            return None
        from rapidfuzz import fuzz, process

        found = process.extractOne(key, self._keys, scorer=fuzz.WRatio,
                                   score_cutoff=threshold)
        if not found:
            return None
        candidate = self._by_key[found[0]]
        if trailing_number(key) != trailing_number(candidate.name):
            return None
        return candidate, int(found[1])


@lru_cache(maxsize=4)
def load_reference(path: str = str(REFERENCE_PATH)) -> Reference:
    return Reference(json.loads(Path(path).read_text(encoding="utf-8")))


def load_profile(name: Optional[str] = None) -> Reference:
    """The reference file behind a profile name. Unknown names raise KeyError."""
    return load_reference(str(PROFILES[name or DEFAULT_PROFILE]))


@dataclass
class Variant:
    """One provider stream, parsed — a candidate feed for a channel."""

    stream: SourceStream
    parsed: ParsedName

    @property
    def has_guide_id(self) -> bool:
        return bool(self.stream.epg_channel_id)


@dataclass
class PlannedChannel:
    """One channel of the proposed playlist, and the feeds behind it."""

    name: str
    group: str
    number: int
    chosen: Variant
    backups: List[Variant] = field(default_factory=list)
    tvg_id: str = ""
    logo: str = ""
    match_method: str = "none"      # tvg_id | alias | fuzzy | none
    match_score: int = 0
    reference_name: str = ""
    has_guide: bool = False
    family: str = ""                # the rule that placed it, when no match
    is_backup: bool = False         # a discarded variant, not a channel of its own

    @property
    def needs_confirmation(self) -> bool:
        return self.match_method == "fuzzy"


@dataclass
class PlannedGroup:
    name: str
    channels: List[PlannedChannel] = field(default_factory=list)


@dataclass
class OrganizationPlan:
    groups: List[PlannedGroup] = field(default_factory=list)
    to_confirm: List[PlannedChannel] = field(default_factory=list)
    dropped_junk: List[str] = field(default_factory=list)
    reference_version: str = ""
    reference_profile: str = ""

    @property
    def channels(self) -> List[PlannedChannel]:
        return [c for g in self.groups for c in g.channels]

    def stats(self) -> Dict[str, int]:
        # Filtered on the flag, not on the group name: a profile is free to send
        # its delayed feeds into the Secours bouquet, and those are real channels
        # that must keep counting as such.
        channels = [c for c in self.channels if not c.is_backup]
        return {
            "groups": len([g for g in self.groups if g.name != BACKUP_GROUP]),
            "channels": len(channels),
            "backups": sum(len(c.backups) for c in channels),
            "matched_by_tvg_id": sum(1 for c in channels if c.match_method == "tvg_id"),
            "matched_by_alias": sum(1 for c in channels if c.match_method == "alias"),
            "to_confirm": len(self.to_confirm),
            "unmatched": sum(1 for c in channels if c.match_method == "none"),
            "placed_by_family": sum(1 for c in channels if c.family),
            "in_tail": sum(1 for c in channels if c.group == TAIL_GROUP),
            "with_guide": sum(1 for c in channels if c.has_guide),
            "junk_dropped": len(self.dropped_junk),
        }


@dataclass
class OrganizeOptions:
    quality_preference: Sequence[str] = tuple(DEFAULT_QUALITY_PREFERENCE)
    keep_backups: bool = True
    separate_timeshift: bool = True
    fuzzy_threshold: int = 90
    subscription_priority: Sequence[int] = ()   # earlier wins a tie
    include_unmatched: bool = True


def _quality_score(variant: Variant, preference: Sequence[str]) -> int:
    """Higher is better. An unknown quality ranks below every named one."""
    quality = variant.parsed.quality
    if not quality:
        return -1
    try:
        return len(preference) - list(preference).index(quality)
    except ValueError:
        return 0


def _pick_best(variants: List[Variant], options: OrganizeOptions) -> List[Variant]:
    """Order the feeds of one channel: the one to serve first, then the fallbacks.

    Quality decides, then whether the provider declares a guide id — between two
    identical feeds, the one that arrives with a tvg-id is worth more, because it
    is the one that will have a programme. Subscription order breaks the rest.
    """
    priority = list(options.subscription_priority)

    def sort_key(variant: Variant) -> Tuple[int, int, int, str]:
        sub_id = variant.stream.subscription_id
        sub_rank = priority.index(sub_id) if sub_id in priority else len(priority)
        return (
            -_quality_score(variant, options.quality_preference),
            0 if variant.has_guide_id else 1,
            sub_rank,
            variant.stream.name,
        )

    return sorted(variants, key=sort_key)


def _place_in_family(family: ChannelFamily, chosen: Variant, name: str,
                     family_next: Dict[str, int]) -> Tuple[str, int, str]:
    """The group, number and name a family rule gives a channel it claims.

    ``number_from: "trailing"`` reads the slot number the provider already put at
    the end of the name, which is the only stable thing about a pay-per-view feed:
    ``NO EVENT STREAMING NOW - | 8K EXCLUSIVE | FR: SOCCER PPV 61`` is slot 61
    today and slot 61 next month, while the visible half is a fixture that will
    have been played by tomorrow. With a ``label``, that is also the name served,
    so the bouquet does not go stale the moment it is written.
    """
    slot = trailing_number(chosen.stream.name) if family.number_from == "trailing" else None
    if slot is not None:
        number = family.start + int(slot)
        if family.label:
            name = f"{family.label} {int(slot)}"
    else:
        number = family_next.get(family.id, family.start)
        family_next[family.id] = number + 1
    return family.group, number, name


def _match(variants: List[Variant], reference: Reference, options: OrganizeOptions
           ) -> Tuple[Optional[ReferenceChannel], str, int]:
    """Resolve a set of variants to a reference channel.

    The guide id is tried across *all* variants: providers disagree about which
    of their feeds carries the id, and one is enough to identify the channel.
    """
    for variant in variants:
        found = reference.by_tvg_id(variant.stream.epg_channel_id)
        if found:
            return found, "tvg_id", 100

    canonical = variants[0].parsed.canonical
    found = reference.by_name(canonical)
    if found:
        return found, "alias", 100

    fuzzy = reference.fuzzy(canonical, options.fuzzy_threshold)
    if fuzzy:
        return fuzzy[0], "fuzzy", fuzzy[1]
    return None, "none", 0


def organize(streams: Iterable[SourceStream],
             reference: Optional[Reference] = None,
             options: Optional[OrganizeOptions] = None) -> OrganizationPlan:
    """Build the proposed organisation. Pure: no database, no network."""
    reference = reference or load_reference()
    options = options or OrganizeOptions()
    plan = OrganizationPlan(reference_version=reference.version,
                            reference_profile=reference.profile)

    # 1. Parse, dropping what is not a channel.
    variants: List[Variant] = []
    for stream in streams:
        if is_junk(stream.name):
            plan.dropped_junk.append(stream.name)
            continue
        parsed = parse_name(stream.name)
        if not parsed.canonical:
            plan.dropped_junk.append(stream.name)
            continue
        variants.append(Variant(stream=stream, parsed=parsed))

    # 2. Merge the variants of one channel, by name first.
    by_name: Dict[Tuple[str, int], List[Variant]] = {}
    for variant in variants:
        shift = variant.parsed.timeshift if options.separate_timeshift else 0
        by_name.setdefault((match_key(variant.parsed.canonical), shift), []).append(variant)

    # 3. Match, then merge again on the reference: two providers naming the same
    #    channel differently must end up as one entry, not two.
    resolved: Dict[Any, Dict[str, Any]] = {}
    for (name_key, shift), group in by_name.items():
        ordered = _pick_best(group, options)
        found, method, score = _match(ordered, reference, options)
        merge_key = (found.number, shift) if found else ("~" + name_key, shift)
        bucket = resolved.setdefault(merge_key, {
            "variants": [], "reference": found, "method": method,
            "score": score, "timeshift": shift,
        })
        bucket["variants"].extend(ordered)
        # Keep the most certain match of the merged set.
        if _method_rank(method) < _method_rank(bucket["method"]):
            bucket["method"], bucket["score"] = method, score

    # 4. Number and group.
    groups: Dict[str, PlannedGroup] = {}
    tail_number = reference.tail_start
    family_next: Dict[str, int] = {f.id: f.start for f in reference.families}
    planned: List[PlannedChannel] = []

    for bucket in resolved.values():
        ordered = _pick_best(bucket["variants"], options)
        chosen, backups = ordered[0], ordered[1:]
        found: Optional[ReferenceChannel] = bucket["reference"]
        shift = bucket["timeshift"]

        if found:
            # A delayed feed never takes the number of a real channel: letting
            # "TF1 +1" claim slot 2 pushed France 2 to 3 and every ARCOM number
            # after it by one. It gets its own block instead, in the same order.
            name = found.name if not shift else f"{found.name} +{shift}"
            group = found.group if not shift else reference.timeshift_group
            number = found.number if not shift else reference.timeshift_start + found.number
            # The reference's id wins when it has one. When it has none — C8, NRJ 12,
            # the OCS siblings, all real channels the user's guide stopped publishing —
            # the provider's own id is better than nothing: some other linked source may
            # well cover it, and dropping it would make the merge lose a guide the tail
            # would have kept.
            provider_id = next((v.stream.epg_channel_id for v in ordered
                                if v.stream.epg_channel_id), "")
            tvg_id = found.tvg_id or provider_id
            channel = PlannedChannel(
                name=name, group=group, number=number,
                chosen=chosen, backups=backups if options.keep_backups else [],
                tvg_id=tvg_id, logo=found.logo or chosen.stream.logo,
                match_method=bucket["method"], match_score=bucket["score"],
                reference_name=found.name,
                has_guide=found.has_guide or bool(tvg_id),
            )
        else:
            if not options.include_unmatched:
                continue
            name = chosen.parsed.canonical.title()
            family = reference.family_for(chosen.stream.category_name, name)
            if family:
                group, number, name = _place_in_family(family, chosen, name, family_next)
            else:
                group, number = TAIL_GROUP, tail_number
                tail_number += 1
            # An unrecognised delayed feed stays where it landed and only says so
            # in its name: the delay block is ordered by the parent's number, and
            # a channel with no parent has no place in it.
            if shift:
                name = f"{name} +{shift}"
            channel = PlannedChannel(
                name=name, group=group, number=number,
                chosen=chosen, backups=backups if options.keep_backups else [],
                tvg_id=chosen.stream.epg_channel_id, logo=chosen.stream.logo,
                match_method="none", has_guide=bool(chosen.stream.epg_channel_id),
                family=family.id if family else "",
            )
        planned.append(channel)

    # A timeshift feed takes the slot after its parent, which is free because
    # the reference never numbers two channels consecutively by accident.
    planned.sort(key=lambda c: (c.number, c.name))
    used: set = set()
    for channel in planned:
        while channel.number in used:
            channel.number += 1
        used.add(channel.number)

    for channel in planned:
        groups.setdefault(channel.group, PlannedGroup(name=channel.group)).channels.append(channel)
        if channel.needs_confirmation:
            plan.to_confirm.append(channel)

    # 5. The discarded variants become the Secours group, at the very end.
    #    ``setdefault``, not an assignment: a profile may already have sent its
    #    delayed feeds into that bouquet, and overwriting it would drop them
    #    without a word.
    if options.keep_backups:
        backup_group = groups.setdefault(BACKUP_GROUP, PlannedGroup(name=BACKUP_GROUP))
        number = reference.backup_start
        for channel in planned:
            for variant in channel.backups:
                label = variant.parsed.quality or "ALT"
                backup_group.channels.append(PlannedChannel(
                    name=f"{channel.name} ({label})", group=BACKUP_GROUP, number=number,
                    chosen=variant, tvg_id=channel.tvg_id, logo=channel.logo,
                    match_method=channel.match_method, reference_name=channel.reference_name,
                    has_guide=channel.has_guide, is_backup=True,
                ))
                number += 1
        if not backup_group.channels:
            groups.pop(BACKUP_GROUP, None)

    order = {name: index for index, name in enumerate(reference.group_order)}
    trailing = {TIMESHIFT_GROUP: len(order) + 1, TAIL_GROUP: len(order) + 2,
                BACKUP_GROUP: len(order) + 3}
    plan.groups = sorted(
        groups.values(),
        key=lambda g: (order.get(g.name, trailing.get(g.name, len(order))), g.name),
    )
    for group in plan.groups:
        group.channels.sort(key=lambda c: c.number)
    return plan


def _method_rank(method: str) -> int:
    return {"tvg_id": 0, "alias": 1, "fuzzy": 2, "none": 3}.get(method, 3)


def plan_to_dict(plan: OrganizationPlan) -> Dict[str, Any]:
    """Serialise a plan for the preview endpoint."""

    def channel_to_dict(channel: PlannedChannel) -> Dict[str, Any]:
        return {
            "number": channel.number,
            "name": channel.name,
            "group": channel.group,
            "tvg_id": channel.tvg_id,
            "logo": channel.logo,
            "has_guide": channel.has_guide,
            "match_method": channel.match_method,
            "match_score": channel.match_score,
            "reference_name": channel.reference_name,
            "family": channel.family,
            "needs_confirmation": channel.needs_confirmation,
            "stream": {
                "subscription_id": channel.chosen.stream.subscription_id,
                "stream_id": channel.chosen.stream.stream_id,
                "provider_name": channel.chosen.stream.name,
                "quality": channel.chosen.parsed.quality,
                "category_name": channel.chosen.stream.category_name,
            },
            "backups": [
                {
                    "subscription_id": v.stream.subscription_id,
                    "stream_id": v.stream.stream_id,
                    "provider_name": v.stream.name,
                    "quality": v.parsed.quality,
                }
                for v in channel.backups
            ],
        }

    return {
        "reference_version": plan.reference_version,
        "reference_profile": plan.reference_profile,
        "stats": plan.stats(),
        "groups": [
            {"name": g.name, "channels": [channel_to_dict(c) for c in g.channels]}
            for g in plan.groups
        ],
        "to_confirm": [channel_to_dict(c) for c in plan.to_confirm],
        "junk_dropped": plan.dropped_junk,
    }
