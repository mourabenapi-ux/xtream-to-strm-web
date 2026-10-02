import secrets
from sqlalchemy import Column, Integer, String, ForeignKey, JSON, DateTime, Boolean, Text
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.base_class import Base

class LivePlaylist(Base):
    __tablename__ = "live_playlists"

    id = Column(Integer, primary_key=True, index=True)
    # Identifier used in the player-facing M3U/EPG URLs. `id` is a bare SQLite
    # rowid: deleting the highest-numbered playlist and creating a new one can
    # hand that new playlist the very id a TiviMate URL still points at, so the
    # old bookmarked link silently starts serving someone else's channels.
    # public_id is random, generated once, and never reassigned.
    public_id = Column(String(8), unique=True, index=True, nullable=True,
                       default=lambda: secrets.token_hex(4))
    subscription_id = Column(Integer, ForeignKey("subscriptions.id"), nullable=True) # Default sub
    name = Column(String, nullable=False)
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Publish each channel's order as tvg-chno, so a player shows the numbering
    # the playlist was built with instead of applying its own. Off by default:
    # on a playlist whose orders are plain 0,1,2… positions, broadcasting them
    # as channel numbers would renumber a working setup for no reason.
    use_channel_numbers = Column(Boolean, default=False, nullable=False,
                                 server_default="0")
    # What the Auto Organizer was asked for (profile, scopes, options), as JSON,
    # so it can be re-run against this playlist and show what would change.
    organizer_config = Column(Text, nullable=True)
    # When the user last acknowledged the "what changed since" report.
    reviewed_at = Column(DateTime, nullable=True)
    
    # Relations
    subscription = relationship("Subscription")
    bouquets = relationship("LivePlaylistBouquet", back_populates="playlist", cascade="all, delete-orphan")
    epg_source_links = relationship("PlaylistEPGSource", back_populates="playlist", cascade="all, delete-orphan")
    # Old epg_sources (keeping for migration)
    epg_sources = relationship("EPGSource", back_populates="playlist", cascade="all, delete-orphan")

class LivePlaylistBouquet(Base):
    __tablename__ = "live_playlist_bouquets"

    id = Column(Integer, primary_key=True, index=True)
    playlist_id = Column(Integer, ForeignKey("live_playlists.id"), nullable=False)
    subscription_id = Column(Integer, ForeignKey("subscriptions.id"), nullable=True) # Origin sub
    category_id = Column(String, nullable=True)  # Xtream category ID (null for virtual groups)
    custom_name = Column(String, nullable=True)
    order = Column(Integer, default=0)
    # The channel numbers this group owns, on a numbered playlist. Appending
    # stays inside them, so one group can no longer spill into the next.
    number_start = Column(Integer, nullable=True)
    number_end = Column(Integer, nullable=True)
    # JSON filter that keeps the group topped up with the provider's matching
    # channels (see services/playlist_tools.py). NULL = a manual group.
    rule = Column(Text, nullable=True)
    
    # Relations
    playlist = relationship("LivePlaylist", back_populates="bouquets")
    channels = relationship("LivePlaylistChannel", back_populates="bouquet", cascade="all, delete-orphan")

class LivePlaylistChannel(Base):
    __tablename__ = "live_playlist_channels"

    id = Column(Integer, primary_key=True, index=True)
    bouquet_id = Column(Integer, ForeignKey("live_playlist_bouquets.id"), nullable=False)
    subscription_id = Column(Integer, ForeignKey("subscriptions.id"), nullable=True) # Origin sub
    stream_id = Column(String, nullable=False)  # Xtream stream ID
    custom_name = Column(String, nullable=True)
    order = Column(Integer, default=0)
    is_excluded = Column(Boolean, default=False)
    
    # Mapping EPG (v3.7.0). NULL inherits the provider's id, NO_GUIDE ("-")
    # deliberately publishes none: a provider id shared by dozens of unrelated
    # channels ("TS") is worse than no id at all.
    epg_channel_id = Column(String, nullable=True)
    
    # Relations
    bouquet = relationship("LivePlaylistBouquet", back_populates="channels")

class LiveCatalogSeen(Base):
    """When a provider stream was first noticed — the yardstick for "new"."""
    __tablename__ = "live_catalog_seen"

    subscription_id = Column(Integer, primary_key=True)
    stream_id = Column(String, primary_key=True)
    first_seen = Column(DateTime, nullable=False, default=datetime.utcnow)


# Legacy model for migration (to be deleted after migration)
class LiveStreamSubscription(Base):
    __tablename__ = "live_stream_subs"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, ForeignKey("subscriptions.id"), unique=True, nullable=False)
    included_categories = Column(JSON, default=list)
    excluded_streams = Column(JSON, default=list)
    
    subscription = relationship("Subscription")

class EPGSource(Base):
    __tablename__ = "epg_sources"

    id = Column(Integer, primary_key=True, index=True)
    playlist_id = Column(Integer, ForeignKey("live_playlists.id"), nullable=False)
    source_type = Column(String, nullable=False)  # "xtream", "url", "file"
    source_url = Column(String, nullable=True)
    file_path = Column(String, nullable=True)
    priority = Column(Integer, default=0)
    last_updated = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)

    # Relations
    playlist = relationship("LivePlaylist", back_populates="epg_sources")
