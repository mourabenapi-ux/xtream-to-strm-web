#!/usr/bin/env python3
"""Derive the compact reference profile from the canonical one.

The canonical file (``fr_channel_reference.json``, 502 channels) stays the single
authority on *what a channel is* — its number in the ARCOM order, its guide id,
its aliases. This script only decides *where it goes*: it collapses the eleven
thematic blocks into eight bouquets and renumbers each channel inside its new
block, keeping the relative order of the original.

It also writes the ``families`` section, which the canonical file does not have.
That section is the reason the compact profile exists. Measured on a live
catalogue of 2 147 channels, the canonical profile leaves 1 799 of them in a
single "Hors référence" bouquet — and 92 % of those are three families no
reference will ever name one by one:

* 507 numbered pay-per-view slots (SOCCER, MAX ×2, DAZN, FFF),
* 794 African channels (AFR| ×10 and CANAL+ AFRICA),
* 349 twenty-four-hour film loops (LUXPLAY, PREMIUM PLAY, NETFLIX, 24/7 BEIN).

Only ~149 are French channels the reference genuinely misses. So the families
route by the provider's *own* category — it has already sorted its catalogue, and
that beats a keyword guess on the channel name — while the reference keeps the
last word wherever it recognises a channel.

Run from ``backend/``:

    python scripts/build_compact_profile.py

Numbering plan (each bouquet leaves room for the rule-placed channels *after* the
ones the reference knows, so a player sorting on the number shows the real
channels first and the bulk families below):

    1– 349  Généralistes & TNT     TNT 1–26 · généralistes 30–99 · divers 100–129
                                   régionales 130–229 · par règle 240–349
  350– 399  Info                   référence 350–369 · par règle 380–399
  400– 999  Cinéma & Séries        référence 400–449 · par règle 460–499
                                   boucles 24/7 500–999
 1000–1299  Découverte & Jeunesse  docs 1000–1049 (+règle 1050) · jeunesse 1100–1149
                                   (+règle 1150)
 1300–1449  Musique                référence 1300–1349 · par règle 1350–1449
 1500–2999  Sport                  référence 1500–1549 · multiplex 1600–1799
                                   par règle 2000–2999
 3000–4999  Événements & PPV       un bloc par famille PPV
 5000–7999  Monde & Outre-mer      Caraïbes 5000 · Afrique 6000
 8000+      Hors référence
 9000+      Décalées, dans le bouquet Secours
20000+      Secours / Alternatives
"""

from __future__ import annotations

import json
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DATA = Path(__file__).resolve().parent.parent / "app" / "data"
SOURCE = DATA / "fr_channel_reference.json"
TARGET = DATA / "fr_channel_reference_compact.json"

G_GEN = "Généralistes & TNT"
G_INFO = "Info"
G_CINE = "Cinéma & Séries"
G_DISC = "Découverte & Jeunesse"
G_MUSIC = "Musique"
G_SPORT = "Sport"
G_PPV = "Événements & PPV"
G_WORLD = "Monde & Outre-mer"

# Which of the eleven canonical blocks lands where, and at which number. ``None``
# keeps the channel's own number, which is how the ARCOM order 1–26 and the
# curated 30–99 block survive the merge untouched.
PLACEMENT: "OrderedDict[str, Any]" = OrderedDict([
    ("TNT",                           (G_GEN, None)),
    ("Généralistes & Divertissement", (G_GEN, None)),
    ("Divers",                        (G_GEN, 100)),
    ("Régionales & Locales",          (G_GEN, 130)),
    ("Info",                          (G_INFO, 350)),
    ("Cinéma & Séries",               (G_CINE, 400)),
    ("Découverte",                    (G_DISC, 1000)),
    ("Jeunesse",                      (G_DISC, 1100)),
    ("Musique",                       (G_MUSIC, 1300)),
    ("Sport",                         (G_SPORT, 1500)),
    ("Multiplex & Événements",        (G_SPORT, 1600)),
])

BLOCKS: List[Dict[str, Any]] = [
    {"group": G_GEN,   "start": 1,    "end": 349},
    {"group": G_INFO,  "start": 350,  "end": 399},
    {"group": G_CINE,  "start": 400,  "end": 999},
    {"group": G_DISC,  "start": 1000, "end": 1299},
    {"group": G_MUSIC, "start": 1300, "end": 1449},
    {"group": G_SPORT, "start": 1500, "end": 2999},
    {"group": G_PPV,   "start": 3000, "end": 4999},
    {"group": G_WORLD, "start": 5000, "end": 7999},
]

# Order is the grammar of this section: the first rule that matches wins, so the
# narrow ones come first. Each ``start`` owns a range wide enough for its family
# to grow — a collision only costs a number, because the engine bumps duplicates,
# but it also scrambles the order inside the bouquet.
FAMILIES: List[Dict[str, Any]] = [
    # A provider hides five delayed Ligue 1 feeds inside an ordinary sport
    # category and says so in the name only. Category *and* name, hence first.
    {"id": "only_events", "group": G_PPV, "start": 3900,
     "when": {"category_regex": r"SPORT", "name_regex": r"ONLY\s*EVENTS"},
     "label": "", "number_from": "sequence"},

    # The pay-per-view blocks. ``trailing`` reads the slot number the provider
    # already puts at the end of every name, and ``label`` replaces the visible
    # half — "Next | Palerme vs. Lecce | 2026-08-17" is frozen into the playlist
    # and wrong by tomorrow, "DAZN PPV 9" is right for as long as the slot exists.
    {"id": "max_ppv_vip", "group": G_PPV, "start": 3200,
     "when": {"category_regex": r"MAX\s*PPV\s*VIP"},
     "label": "Max PPV VIP", "number_from": "trailing"},
    {"id": "max_ppv", "group": G_PPV, "start": 3000,
     "when": {"category_regex": r"MAX\s*PPV"},
     "label": "Max PPV", "number_from": "trailing"},
    {"id": "soccer_ppv", "group": G_PPV, "start": 3400,
     "when": {"category_regex": r"SOCCER\s*PPV"},
     "label": "Soccer PPV", "number_from": "trailing"},
    {"id": "dazn_ppv", "group": G_PPV, "start": 3650,
     "when": {"category_regex": r"DAZN\s*PPV"},
     "label": "DAZN PPV", "number_from": "trailing"},
    {"id": "fff_ppv", "group": G_PPV, "start": 3800,
     "when": {"category_regex": r"FFF\s*TV\s*PPV"},
     "label": "", "number_from": "sequence"},

    # Another market entirely. Grouped, not dropped: the perimeter is chosen in
    # the Auto Organizer screen, and if these categories are not selected the
    # bouquet simply never appears.
    {"id": "caribbean", "group": G_WORLD, "start": 5000,
     "when": {"category_regex": r"CARIBBEAN|CARAIBE"},
     "label": "", "number_from": "sequence"},
    {"id": "africa", "group": G_WORLD, "start": 6000,
     "when": {"category_regex": r"^\s*AFR?[\s_:|.\-]|AFRICA|AFRIQUE"},
     "label": "", "number_from": "sequence"},

    # Twenty-four-hour film and series loops. They belong with cinema, but after
    # it: 500 onwards, so Canal+ Cinéma and the rest of the reference keep 400–449
    # and stay at the top of the bouquet.
    {"id": "vod_loops", "group": G_CINE, "start": 500,
     "when": {"category_regex": r"LUXPLAY|PREMIUM\s*PLAY|NETFLIX|24/7|DISNEY\+|CANALPLAY"},
     "label": "", "number_from": "sequence"},
    {"id": "cinema", "group": G_CINE, "start": 460,
     "when": {"category_regex": r"CINEMA|CINÉMA|SERIE|SÉRIE|FILM"},
     "label": "", "number_from": "sequence"},

    {"id": "kids", "group": G_DISC, "start": 1150,
     "when": {"category_regex": r"ENFANT|KIDS|JEUNESSE|JUNIOR"},
     "label": "", "number_from": "sequence"},
    {"id": "docs", "group": G_DISC, "start": 1050,
     "when": {"category_regex": r"DOCUMENTAIRE|DOCU|DECOUVERTE|DÉCOUVERTE"},
     "label": "", "number_from": "sequence"},
    {"id": "music", "group": G_MUSIC, "start": 1350,
     "when": {"category_regex": r"MUSIQUE|MUSIC|RADIO"},
     "label": "", "number_from": "sequence"},
    {"id": "sport", "group": G_SPORT, "start": 2000,
     "when": {"category_regex":
              r"SPORT|EQUIPE|ÉQUIPE|LIGUE1|LIGUE\s*1|DAZN|FOOT|CANAL\+\s*LIVE|TENNIS|GOLF"},
     "label": "", "number_from": "sequence"},
    {"id": "info", "group": G_INFO, "start": 380,
     "when": {"category_regex": r"\bINFO\b|NEWS|ACTUALITE"},
     "label": "", "number_from": "sequence"},

    # The sweep. Everything the provider filed as generic French goes to the
    # first bouquet rather than to a tail nobody reads.
    {"id": "general", "group": G_GEN, "start": 240,
     "when": {"category_regex": r"FRANCE|GENERAL|GÉNÉRAL|PRIME|HEVC|\bVIP\b|DIVERS"},
     "label": "", "number_from": "sequence"},
]


def build() -> Dict[str, Any]:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))

    unknown = {c["group"] for c in source["channels"]} - set(PLACEMENT)
    if unknown:
        raise SystemExit(f"Canonical groups with no placement: {sorted(unknown)}")

    # Renumber inside each new block, in the canonical order, so a channel keeps
    # its neighbours.
    channels: List[Dict[str, Any]] = []
    for old_group, (new_group, start) in PLACEMENT.items():
        members = sorted((c for c in source["channels"] if c["group"] == old_group),
                         key=lambda c: c["number"])
        for offset, channel in enumerate(members):
            entry = dict(channel)
            entry["group"] = new_group
            entry["number"] = channel["number"] if start is None else start + offset
            entry["canonical_number"] = channel["number"]
            channels.append(entry)
    channels.sort(key=lambda c: c["number"])

    numbers = [c["number"] for c in channels]
    if len(set(numbers)) != len(numbers):
        raise SystemExit("Two channels ended up on the same number")
    for channel in channels:
        block = next(b for b in BLOCKS if b["group"] == channel["group"])
        if not block["start"] <= channel["number"] <= block["end"]:
            raise SystemExit(f"{channel['name']} ({channel['number']}) "
                             f"falls outside {channel['group']}")

    counts: Dict[str, int] = {}
    for channel in channels:
        counts[channel["group"]] = counts.get(channel["group"], 0) + 1

    return {
        "version": source["version"],
        "profile": "compact",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "derived_from": SOURCE.name,
        "sources": source.get("sources", {}),
        "notes": {
            "why": "Huit bouquets au lieu de quatorze, et un « Hors référence » "
                   "quasi vide : les familles placent en bloc ce que la référence "
                   "ne nommera jamais chaîne par chaîne.",
            "merges": "TNT + Généralistes + Divers + Régionales = un bouquet ; "
                      "Découverte + Jeunesse = un bouquet ; les décalées (+1) "
                      "vont dans Secours au lieu d'un bouquet à elles.",
            "families": "Consultées seulement quand la référence n'a pas reconnu "
                        "la chaîne. Une chaîne placée par règle reste comptée comme "
                        "non reconnue : le placement n'est pas une identification.",
        },
        "blocks": [dict(b, count=counts.get(b["group"], 0)) for b in BLOCKS],
        "families": FAMILIES,
        "tail_starts_at": 8000,
        "timeshift_starts_at": 9000,
        "timeshift_group": "Secours / Alternatives",
        "backup_starts_at": 20000,
        "channels": channels,
    }


if __name__ == "__main__":
    document = build()
    TARGET.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n",
                      encoding="utf-8")
    print(f"{TARGET.name}: {len(document['channels'])} channels, "
          f"{len(document['blocks'])} blocks, {len(document['families'])} families")
    for block in document["blocks"]:
        print(f"  {block['group']:26s} {block['start']:5d}-{block['end']:5d}  "
              f"reference={block['count']:4d}")
