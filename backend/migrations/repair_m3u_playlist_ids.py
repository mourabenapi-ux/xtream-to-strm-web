"""Re-point live playlists at the M3U channels they lost.

One-off repair, for databases written before ``source_entries.stable_id``.

Until then an M3U channel was named by the autoincrement primary key of its
``source_entries`` row, and a reparse of the playlist — once an hour — deleted
every row of the source and re-inserted it under fresh keys. Every live playlist
channel that came from an M3U source was left pointing at a row that no longer
existed. The resolver dropped them all, and the generated M3U came out empty.

The stored ids are gone and cannot be recovered. What survives on each playlist
channel is its EPG id — which came from the source line's ``tvg-id`` — and its
name. They are tried in that order, and at every step a channel is re-pointed
only when exactly one live line of the same source answers, so an ambiguous
match is left alone rather than guessed at. Channels that match nothing keep
their dead id and stay dropped — they were already invisible, and the
auto-organiser can rebuild them.

Nothing else is touched: names, order, bouquets and exclusions are the user's.

    docker exec xtream_app python /app/migrations/repair_m3u_playlist_ids.py
    docker exec xtream_app python /app/migrations/repair_m3u_playlist_ids.py --apply

Without ``--apply`` it only reports what it would change.
"""
import argparse
import os
import sys
from collections import defaultdict

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.db import base  # noqa: F401  (registers every mapper)
from app.db.session import SessionLocal
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel
from app.models.source_entry import EntryType, SourceEntry
from app.models.subscription import SourceKind, Subscription
from app.services.organizer import parse_name


def _index(db, subscription_id):
    """The live lines of one source, under the three keys tried in turn.

    ``loose`` drops the ``@`` suffix some guides append to a channel id
    ("6ter.fr@SD"), which moves between two editions of the same playlist, and
    ignores case. ``named`` is the channel name as the organiser reads it —
    without the quality and feed decorations — which is what a playlist channel
    was named with, so it catches a line whose tvg-id was renamed under it.
    """
    exact, loose, named = defaultdict(list), defaultdict(list), defaultdict(list)
    for entry in db.query(SourceEntry).filter(
        SourceEntry.subscription_id == subscription_id,
        SourceEntry.entry_type == EntryType.LIVE,
    ):
        if entry.stable_id is None:
            continue
        if entry.tvg_id:
            exact[entry.tvg_id].append(entry)
            loose[entry.tvg_id.split("@")[0].lower()].append(entry)
        canonical = parse_name(entry.title or "").canonical.lower()
        if canonical:
            named[canonical].append(entry)
    return exact, loose, named


def repair(apply: bool) -> int:
    db = SessionLocal()
    try:
        m3u_ids = [s.id for s in db.query(Subscription).filter(
            Subscription.kind == SourceKind.M3U.value)]
        if not m3u_ids:
            print("No M3U source — nothing to repair.")
            return 0

        indexes = {sid: _index(db, sid) for sid in m3u_ids}
        alive = {sid: {str(e.stable_id)
                       for e in db.query(SourceEntry).filter(
                           SourceEntry.subscription_id == sid)}
                 for sid in m3u_ids}

        total_fixed = total_lost = 0

        for playlist in db.query(LivePlaylist).order_by(LivePlaylist.id):
            channels = db.query(LivePlaylistChannel).join(LivePlaylistBouquet).filter(
                LivePlaylistBouquet.playlist_id == playlist.id,
                LivePlaylistChannel.subscription_id.in_(m3u_ids),
            ).all()
            if not channels:
                continue

            fixed = lost = 0
            for channel in channels:
                sid = channel.subscription_id
                if str(channel.stream_id) in alive[sid]:
                    continue  # already points at a line that exists

                exact, loose, named = indexes[sid]
                key = channel.epg_channel_id or ""
                name = parse_name(channel.custom_name or "").canonical.lower()
                match = (exact.get(key)
                         or loose.get(key.split("@")[0].lower())
                         or (named.get(name) if name else None)
                         or [])
                if len(match) != 1:
                    lost += 1
                    continue

                if apply:
                    channel.stream_id = str(match[0].stable_id)
                fixed += 1

            print(f"playlist {playlist.id} ({playlist.name}): "
                  f"{len(channels)} from an M3U source, {fixed} re-pointed, "
                  f"{lost} left dropped")
            total_fixed += fixed
            total_lost += lost

        if apply:
            db.commit()
            print(f"\nApplied: {total_fixed} channels re-pointed, {total_lost} "
                  f"still unresolvable.")
        else:
            print(f"\nDry run: {total_fixed} channels would be re-pointed, "
                  f"{total_lost} would stay dropped. Re-run with --apply.")
        return total_fixed
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="write the changes (otherwise only report)")
    repair(parser.parse_args().apply)
