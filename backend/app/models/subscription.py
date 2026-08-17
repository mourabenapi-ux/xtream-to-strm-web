"""The one source table.

An Xtream subscription and an M3U playlist are the same object for everything
downstream — selection, .strm writing, downloads, live playlists, EPG. The only
thing that genuinely differs is *how the catalogue is obtained*, and that lives
in the adapters of ``app.services.catalog``. So both live here, told apart by
``kind``, with the connection fields of the other format left empty.

The table keeps its historical name ``subscriptions`` on purpose: every other
table points at ``subscriptions.id`` (live playlists, caches, downloads, sync
state, EPG). Renaming it would have meant re-keying all of them, which is the
one operation that can lose data. Nothing was re-keyed.
"""

from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.sql import func
from app.db.base_class import Base
import enum


class SourceKind(str, enum.Enum):
    XTREAM = "xtream"
    M3U = "m3u"


class M3USourceType(str, enum.Enum):
    URL = "url"
    FILE = "file"


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    kind = Column(String, nullable=False, index=True, default=SourceKind.XTREAM.value)

    # --- Xtream connection (empty strings on an M3U source) ---------------
    # Kept NOT NULL: the column already exists that way on every install, and
    # relaxing it in SQLite means rebuilding a table half the schema points at.
    xtream_url = Column(String, nullable=False, default="")
    username = Column(String, nullable=False, default="")
    password = Column(String, nullable=False, default="")

    # --- M3U connection (NULL on an Xtream source) ------------------------
    source_type = Column(String, nullable=True)      # "url" or "file"
    url = Column(String, nullable=True)              # playlist URL
    file_path = Column(String, nullable=True)        # uploaded playlist
    output_dir = Column(String, nullable=True)       # base dir, M3U legacy

    # --- Output layout (both kinds) ---------------------------------------
    movies_dir = Column(String, nullable=False, default="")
    series_dir = Column(String, nullable=False, default="")

    # Download specific settings
    download_movies_dir = Column(String, default="/output/downloads/movies")
    download_series_dir = Column(String, default="/output/downloads/series")
    max_parallel_downloads = Column(Integer, default=2)
    download_segments = Column(Integer, default=1)

    is_active = Column(Boolean, default=True)

    # Coarse status the sources screen shows at a glance. The authoritative,
    # per-type state (with progress and partial runs) is in ``sync_state``.
    sync_status = Column(String, default="idle")
    last_sync = Column(DateTime, nullable=True)

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # The id this source had in the old ``m3u_sources`` table. It is what makes
    # migration 007 idempotent (it re-runs at every boot) and what maps the old
    # m3u_* child rows onto their new source id. NULL on Xtream sources.
    legacy_m3u_source_id = Column(Integer, nullable=True, index=True)

    @property
    def is_m3u(self) -> bool:
        return self.kind == SourceKind.M3U.value
