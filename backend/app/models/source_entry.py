"""One line of a parsed M3U playlist.

This is the M3U adapter's catalogue cache — the equivalent of what the Xtream
adapter gets by asking the provider's API. It replaces the old ``m3u_entries``,
which could only ever hold movies and series: its ``entry_type`` was declared as
an Enum, so SQLite gave it a CHECK constraint allowing MOVIE and SERIES only,
and the live channels had to be dropped at parse time. The type is plain text
here, which is what lets a live channel be kept.

Nothing is migrated from the old table: this is a cache, refilled by the next
parse of the playlist.
"""

from sqlalchemy import BigInteger, Column, Integer, String, ForeignKey
from app.db.base_class import Base


class EntryType:
    """Values of ``SourceEntry.entry_type``. Deliberately not an Enum column."""

    LIVE = "live"
    MOVIE = "movie"
    SERIES = "series"


class SourceEntry(Base):
    __tablename__ = "source_entries"

    id = Column(Integer, primary_key=True, index=True)

    # The id everything *outside* this table uses to name a line: a playlist
    # channel, a selected movie, an episode. Derived from the source and the
    # line's URL, so it survives a reparse.
    #
    # ``id`` cannot play that role. A reparse deletes every row of the source
    # and re-inserts it, which mints fresh autoincrement values; anything that
    # had stored one — a live playlist above all — was left pointing at rows
    # that no longer existed, and served nothing. Never expose ``id``.
    stable_id = Column(BigInteger, nullable=True, index=True)

    subscription_id = Column(Integer, ForeignKey("subscriptions.id"),
                             nullable=False, index=True)
    title = Column(String, nullable=False)
    url = Column(String, nullable=False)
    group_title = Column(String, nullable=True)
    logo = Column(String, nullable=True)
    tvg_id = Column(String, nullable=True)
    tvg_name = Column(String, nullable=True)
    entry_type = Column(String, nullable=False, index=True, default=EntryType.LIVE)

    # Filled at parse time for series episodes, so the adapter can group them
    # without re-running the title regex on every read. ``series_key`` is the
    # show's name as parsed out of the episode title.
    series_key = Column(String, nullable=True, index=True)
    season = Column(Integer, nullable=True)
    episode = Column(Integer, nullable=True)

    # Extension the URL ends with ("mp4", "mkv", "ts"…), kept because the
    # writers need one and the URL is not always re-read.
    container = Column(String, nullable=True)

    # What the playlist declares about replay for this line, kept verbatim.
    # The generated M3U hands these straight back to the player: a catch-up
    # URL is the provider's to define, and guessing one produces a channel
    # that shows a replay button and then fails to play anything.
    catchup = Column(String, nullable=True)         # "xc", "default", "shift"…
    catchup_days = Column(Integer, nullable=True)   # how far back it goes
    catchup_source = Column(String, nullable=True)  # explicit URL template
