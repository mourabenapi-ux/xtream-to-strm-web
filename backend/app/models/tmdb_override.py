"""A TMDB id the user has corrected by hand.

The provider's own tmdb_id is the only thing the library has to identify a
title, and IPTV catalogue names are bad enough that it is regularly wrong or
absent. A wrong id is worse than none: Jellyfin then shows the wrong poster and
the wrong synopsis with full confidence, and there is nothing in the .strm
library to argue with.

This table is that argument. It is deliberately *not* a column on
``movie_cache`` / ``series_cache``: those are caches, rewritten by every sync
and deleted the moment the provider stops listing an item, so a correction
stored there would evaporate on the first provider hiccup. A correction is user
input and outlives the catalogue.
"""

from datetime import datetime

from sqlalchemy import (Column, DateTime, ForeignKey, Integer, String,
                        UniqueConstraint)

from app.db.base_class import Base


class TmdbMediaType:
    """Values of ``TmdbOverride.media_type``."""

    MOVIE = "movie"
    SERIES = "series"


class TmdbOverride(Base):
    __tablename__ = "tmdb_overrides"
    __table_args__ = (
        UniqueConstraint("subscription_id", "media_type", "item_id",
                         name="uq_tmdb_override_item"),
    )

    id = Column(Integer, primary_key=True, index=True)
    subscription_id = Column(Integer, ForeignKey("subscriptions.id"),
                             nullable=False, index=True)
    media_type = Column(String, nullable=False, index=True)

    # The provider's stream_id for a movie, series_id for a show — the same key
    # the caches and the sync are written against.
    item_id = Column(String, nullable=False, index=True)

    # The title reduced to a comparable form, and the title as it read when the
    # correction was made. The first is a second way to find this row when the
    # id no longer matches: an M3U catalogue is re-parsed into fresh rows, so
    # its ids move between two syncs while its titles do not. The second is
    # only ever displayed.
    name_key = Column(String, nullable=True, index=True)
    label = Column(String, nullable=True)

    # NULL means "this title has no TMDB id" — a deliberate answer, not an
    # absent one. Deleting the row is what hands the decision back to the
    # provider.
    tmdb_id = Column(String, nullable=True)

    updated_at = Column(DateTime, default=datetime.utcnow,
                        onupdate=datetime.utcnow)
