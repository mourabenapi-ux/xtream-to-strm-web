from sqlalchemy import Column, Integer, String, Boolean
from app.db.base_class import Base

class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, index=True, nullable=False)
    xtream_url = Column(String, nullable=False)
    username = Column(String, nullable=False)
    password = Column(String, nullable=False)
    movies_dir = Column(String, nullable=False)
    series_dir = Column(String, nullable=False)
    
    # Download specific settings
    download_movies_dir = Column(String, default="/output/downloads/movies")
    download_series_dir = Column(String, default="/output/downloads/series")
    max_parallel_downloads = Column(Integer, default=2)
    download_segments = Column(Integer, default=1)
    
    is_active = Column(Boolean, default=True)
