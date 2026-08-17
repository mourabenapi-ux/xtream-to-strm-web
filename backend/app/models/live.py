from sqlalchemy import Column, Integer, String, ForeignKey, JSON, DateTime, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.base_class import Base

class LivePlaylist(Base):
    __tablename__ = "live_playlists"

    id = Column(Integer, primary_key=True, index=True)
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
    
    # Mapping EPG (v3.7.0)
    epg_channel_id = Column(String, nullable=True)
    
    # Relations
    bouquet = relationship("LivePlaylistBouquet", back_populates="channels")

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
