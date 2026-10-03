"""What the dashboard remembers between two looks at it.

Three small tables, all written in the background:

``app_conditions`` — the problems that are true *right now* ("MBA serves no
channel", "disk at 98 %"). The monitor recomputes them every few minutes and
diffs the result against this table: a new row is a problem that appeared, a
deleted row one that went away. The dashboard banner is this table.

``app_events`` — the journal: syncs, guide refreshes, downloads, and every
condition that appeared or cleared. It is also what notifications are sent
from, so a phone alert and the journal line are one and the same record.

``player_fetches`` — when a player last downloaded a playlist or its guide,
and which player it was. The only proof the app has that the television
really picked up a change.
"""
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, UniqueConstraint

from app.db.base_class import Base


class Severity:
    """Plain strings rather than an Enum column: SQLite turns an Enum into a
    CHECK constraint that cannot be altered without rebuilding the table."""
    INFO = "info"
    WARNING = "warning"
    DANGER = "danger"

    ORDER = {INFO: 0, WARNING: 1, DANGER: 2}


class AppCondition(Base):
    __tablename__ = "app_conditions"

    id = Column(Integer, primary_key=True, index=True)
    # Stable identity of the problem, e.g. "playlist:5:dead". The same key
    # coming back on the next pass is the same problem, not a new one.
    key = Column(String, unique=True, index=True, nullable=False)
    severity = Column(String, nullable=False, default=Severity.WARNING)
    title = Column(String, nullable=False)
    detail = Column(Text, nullable=True)
    # JSON: {"kind": "repair_dead", "label": "Repair", "playlist_id": 1} or null.
    action = Column(Text, nullable=True)
    # In-app route that shows the problem in full.
    link = Column(String, nullable=True)
    since = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen = Column(DateTime, default=datetime.utcnow, nullable=False)
    # How many consecutive passes have seen it. A notification waits for the
    # second one, so a guide that is empty for the 30 s of a restart does not
    # wake anybody up.
    seen_count = Column(Integer, default=1, nullable=False)
    # No push is due for it: already sent, or open when notifications were
    # switched on. Not proof that anything was sent.
    notified = Column(Boolean, default=False, nullable=False)
    # A notification really went out.
    pushed = Column(Boolean, default=False, nullable=False, server_default="0")


class AppEvent(Base):
    __tablename__ = "app_events"

    id = Column(Integer, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True, nullable=False)
    # sync, guide, download, condition, resolved, player, system
    kind = Column(String, nullable=False, index=True)
    severity = Column(String, nullable=False, default=Severity.INFO)
    title = Column(String, nullable=False)
    detail = Column(Text, nullable=True)
    link = Column(String, nullable=True)
    # Whether a notification went out for it, and the error if it failed.
    notified = Column(Boolean, default=False, nullable=False)
    notify_error = Column(String, nullable=True)


class PlayerFetch(Base):
    __tablename__ = "player_fetches"
    __table_args__ = (UniqueConstraint("playlist_id", "kind", "client", name="uq_player_fetch"),)

    id = Column(Integer, primary_key=True, index=True)
    playlist_id = Column(Integer, index=True, nullable=False)
    kind = Column(String, nullable=False)          # "m3u" or "xml"
    client = Column(String, nullable=False)        # "TiviMate", "VLC", "Browser"…
    user_agent = Column(String, nullable=True)
    address = Column(String, nullable=True)
    first_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    count = Column(Integer, default=1, nullable=False)
