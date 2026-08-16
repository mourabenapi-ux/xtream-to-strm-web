from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.base_class import Base

class EPGSourceGlobal(Base):
    """Global EPG source (independent of playlists)"""
    __tablename__ = "epg_sources_global"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)  # e.g., "XMLTV France Premium"
    source_type = Column(String, nullable=False)  # "url", "file", "xtream"
    source_url = Column(String, nullable=True)
    file_path = Column(String, nullable=True)
    # Only for source_type == "xtream": whose provider guide to fetch. The
    # URL is derived from the subscription rather than stored, so credentials
    # live in exactly one place and a password change propagates by itself.
    subscription_id = Column(Integer, ForeignKey("subscriptions.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_updated = Column(DateTime, nullable=True)
    channel_count = Column(Integer, default=0)  # Cached count from Redis
    refresh_interval_hours = Column(Integer, default=24)  # Configurable frequency
    
    # Relations
    playlist_links = relationship("PlaylistEPGSource", back_populates="epg_source", cascade="all, delete-orphan")

class PlaylistEPGSource(Base):
    """Many-to-Many link between Playlists and Global EPG Sources"""
    __tablename__ = "playlist_epg_sources"
    
    id = Column(Integer, primary_key=True, index=True)
    playlist_id = Column(Integer, ForeignKey("live_playlists.id"), nullable=False)
    epg_source_id = Column(Integer, ForeignKey("epg_sources_global.id"), nullable=False)
    priority = Column(Integer, default=0)  # Local priority for THIS playlist
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relations
    playlist = relationship("LivePlaylist", back_populates="epg_source_links")
    epg_source = relationship("EPGSourceGlobal", back_populates="playlist_links")
