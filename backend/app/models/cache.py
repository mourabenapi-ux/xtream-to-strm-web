from sqlalchemy import Column, String, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from app.db.base_class import Base

class MovieCache(Base):
    __tablename__ = "movie_cache"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, nullable=False, index=True)
    stream_id = Column(Integer, index=True)
    name = Column(String)
    category_id = Column(String)
    container_extension = Column(String)
    tmdb_id = Column(String, nullable=True)

class SeriesCache(Base):
    __tablename__ = "series_cache"

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, nullable=False, index=True)
    series_id = Column(Integer, index=True)
    name = Column(String)
    category_id = Column(String)
    tmdb_id = Column(String, nullable=True)
    # The provider's own change stamp for this series, stored verbatim.
    # Without it a cached series was only ever re-fetched when its *name*
    # changed, so an ongoing show never gained the episodes added each week.
    last_modified = Column(String, nullable=True)
    # When we last pulled this series' episode list. Providers are not
    # reliable about bumping last_modified, so this drives a periodic
    # re-fetch (SERIES_REFRESH_HOURS) that does not depend on them.
    last_refreshed = Column(DateTime, nullable=True)

class EpisodeCache(Base):
    __tablename__ = "episode_cache"

    id = Column(Integer, primary_key=True, index=True) # This is the stream_id of the episode
    subscription_id = Column(Integer, nullable=False, index=True)
    series_id = Column(Integer, index=True) # This refers to the series_id from provider, not our DB id
    season_num = Column(Integer)
    episode_num = Column(Integer)
    title = Column(String, nullable=True)
    container_extension = Column(String)
