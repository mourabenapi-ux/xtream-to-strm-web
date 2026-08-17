"""What an M3U playlist turns into once it is read as a catalogue.

The whole unification rests on one claim: that an M3U source can answer the same
questions as an Xtream one. These tests pin the parts of that claim which have no
provider to fall back on — deciding what a line *is*, grouping episodes into
shows, and keeping a show's id stable between two syncs.
"""
import os
import sys
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.models.source_entry import EntryType
from app.services import catalog
from app.services.catalog import _split_episode, _stable_id, classify


def line(title, url, group="FR | GENERAL"):
    return {"title": title, "url": url, "group_title": group}


class TestClassify(unittest.TestCase):
    """A playlist line says what it is through its URL, or through its title."""

    def test_xtream_style_urls_are_authoritative(self):
        self.assertEqual(
            classify(line("Le Parrain", "http://p.tv/movie/u/p/123.mkv"))["entry_type"],
            EntryType.MOVIE)
        self.assertEqual(
            classify(line("Kaamelott", "http://p.tv/series/u/p/456.mp4"))["entry_type"],
            EntryType.SERIES)

    def test_a_live_channel_is_the_default(self):
        """This is the case the old parser threw away: no extension, no
        /movie/, no numbering — a channel."""
        for url in ("http://p.tv/live/u/p/8.ts",
                    "http://p.tv/u/p/8",
                    "http://p.tv/hls/tf1.m3u8"):
            self.assertEqual(classify(line("FR | TF1 HD", url))["entry_type"],
                             EntryType.LIVE, url)

    def test_a_numbered_title_is_a_series_even_without_a_typed_url(self):
        """Hand-written playlists have neither /series/ nor a panel behind
        them, so the title is the only thing that can say so."""
        facts = classify(line("Kaamelott S02E14", "http://p.tv/x/9.mkv"))
        self.assertEqual(facts["entry_type"], EntryType.SERIES)
        self.assertEqual(facts["series_key"], "Kaamelott")
        self.assertEqual((facts["season"], facts["episode"]), (2, 14))

    def test_a_video_extension_without_numbering_is_a_movie(self):
        facts = classify(line("Le Parrain (1972)", "http://p.tv/x/9.mkv"))
        self.assertEqual(facts["entry_type"], EntryType.MOVIE)
        self.assertEqual(facts["container"], "mkv")

    def test_the_container_falls_back_rather_than_being_empty(self):
        self.assertEqual(classify(line("TF1", "http://p.tv/u/p/8"))["container"], "ts")
        self.assertEqual(
            classify(line("Film", "http://p.tv/movie/u/p/8"))["container"], "mp4")


class TestSplitEpisode(unittest.TestCase):

    def test_the_common_spellings(self):
        for title, expected in (
            ("Kaamelott S01E02", ("Kaamelott", 1, 2)),
            ("Kaamelott S01 E02", ("Kaamelott", 1, 2)),
            ("Kaamelott - s1.e2", ("Kaamelott", 1, 2)),
            ("Kaamelott 1x02", ("Kaamelott", 1, 2)),
        ):
            self.assertEqual(_split_episode(title), expected, title)

    def test_a_plain_title_is_not_an_episode(self):
        self.assertIsNone(_split_episode("Le Parrain (1972)"))
        self.assertIsNone(_split_episode("RMC Sport 5"))

    def test_a_year_is_not_a_season(self):
        """"(2020)" must not be read as season 20, episode 20 — that would
        scatter every movie in the playlist across fake shows."""
        self.assertIsNone(_split_episode("Remords (2020)"))


class TestStableId(unittest.TestCase):

    def test_the_same_show_keeps_its_id(self):
        """A show has no id in an M3U. If ours moved between two syncs, every
        series folder would be rewritten each time."""
        first = _stable_id(3, "FR | SERIES", "Kaamelott")
        second = _stable_id(3, "FR | SERIES", "Kaamelott")
        self.assertEqual(first, second)

    def test_different_shows_get_different_ids(self):
        self.assertNotEqual(_stable_id(3, "G", "Kaamelott"),
                            _stable_id(3, "G", "Engrenages"))

    def test_the_same_show_on_two_sources_is_two_shows(self):
        self.assertNotEqual(_stable_id(3, "G", "Kaamelott"),
                            _stable_id(4, "G", "Kaamelott"))

    def test_it_fits_in_a_database_integer(self):
        self.assertLess(_stable_id("anything"), 2 ** 63 - 1)


class _Entry:
    """A `source_entries` row, without a database."""

    _next_id = 1

    def __init__(self, title, entry_type, group="G", series_key=None,
                 season=None, episode=None, url="http://p.tv/x", container="mp4",
                 logo="", tvg_id="", catchup=None, catchup_days=None,
                 catchup_source=None):
        self.id = _Entry._next_id
        _Entry._next_id += 1
        # The id the catalogue hands out. Distinct from the primary key on
        # purpose: the real one survives a reparse, the primary key does not.
        self.stable_id = _stable_id("test", self.id)
        self.title = title
        self.entry_type = entry_type
        self.group_title = group
        self.series_key = series_key
        self.season = season
        self.episode = episode
        self.url = url
        self.container = container
        self.logo = logo
        self.tvg_id = tvg_id
        self.catchup = catchup
        self.catchup_days = catchup_days
        self.catchup_source = catchup_source


class _Catalog(catalog.M3UCatalog):
    """An M3UCatalog over a fixed set of rows — no playlist, no database."""

    def __init__(self, entries, subscription_id=1):
        self.subscription_id = subscription_id
        self._entries = entries
        self._url_by_id = {e.stable_id: e.url for e in entries}
        self._loaded = True

    def ensure_parsed(self, force=False):
        return len(self._entries)


class TestSeriesGrouping(unittest.TestCase):

    def setUp(self):
        self.entries = [
            _Entry("Kaamelott S01E01", EntryType.SERIES, series_key="Kaamelott",
                   season=1, episode=1),
            _Entry("Kaamelott S01E02", EntryType.SERIES, series_key="Kaamelott",
                   season=1, episode=2),
            _Entry("Kaamelott S02E01", EntryType.SERIES, series_key="Kaamelott",
                   season=2, episode=1),
            _Entry("Engrenages S01E01", EntryType.SERIES, series_key="Engrenages",
                   season=1, episode=1),
        ]
        self.catalog = _Catalog(self.entries)

    def test_episodes_become_shows_not_one_show_each(self):
        """The old M3U sync wrote every episode as a show of its own, so a
        four-episode series produced four one-file libraries."""
        shows = self.catalog.get_series_sync()
        self.assertEqual({s["name"] for s in shows}, {"Kaamelott", "Engrenages"})

    def test_seasons_are_kept_apart_and_ordered(self):
        show = next(s for s in self.catalog.get_series_sync()
                    if s["name"] == "Kaamelott")
        info = self.catalog.get_series_info_sync(str(show["series_id"]))

        self.assertEqual(sorted(info["episodes"]), ["1", "2"])
        self.assertEqual([e["episode_num"] for e in info["episodes"]["1"]], [1, 2])
        self.assertEqual(len(info["episodes"]["2"]), 1)

    def test_the_change_stamp_moves_when_an_episode_appears(self):
        """`last_modified` is what tells the sync to re-read a show. Without it
        an ongoing series never gains next week's episode."""
        before = next(s for s in self.catalog.get_series_sync()
                      if s["name"] == "Kaamelott")["last_modified"]

        self.entries.append(_Entry("Kaamelott S02E02", EntryType.SERIES,
                                   series_key="Kaamelott", season=2, episode=2))
        after = next(s for s in self.catalog.get_series_sync()
                     if s["name"] == "Kaamelott")["last_modified"]

        self.assertNotEqual(before, after)


class TestCatalogueShape(unittest.TestCase):
    """The adapter has to answer in the shape the rest of the app expects."""

    def setUp(self):
        self.entries = [
            _Entry("FR | TF1 HD", EntryType.LIVE, group="FR | TNT",
                   url="http://p.tv/live/8.ts", tvg_id="TF1.fr"),
            _Entry("FR | M6 HD", EntryType.LIVE, group="FR | TNT",
                   url="http://p.tv/live/9.ts"),
            _Entry("Le Parrain", EntryType.MOVIE, group="FR | FILMS",
                   url="http://p.tv/movie/10.mkv", container="mkv"),
        ]
        self.catalog = _Catalog(self.entries)

    def test_groups_are_categories(self):
        self.assertEqual([c["category_id"] for c in self.catalog.get_live_categories_sync()],
                         ["FR | TNT"])
        self.assertEqual([c["category_id"] for c in self.catalog.get_vod_categories_sync()],
                         ["FR | FILMS"])

    def test_a_live_stream_carries_what_the_organiser_reads(self):
        stream = self.catalog.get_live_streams_sync()[0]
        for key in ("stream_id", "name", "category_id", "epg_channel_id", "stream_icon"):
            self.assertIn(key, stream)
        self.assertEqual(stream["epg_channel_id"], "TF1.fr")

    def test_replay_survives_the_read(self):
        """The adapter used to answer `tv_archive: 0` for every channel.

        That single constant is what cost the playlist its catch-up: whatever
        the source declared, the generated M3U said there was no archive.
        """
        catalog_with_replay = _Catalog([
            _Entry("TF1 HD", EntryType.LIVE, group="FR | TNT",
                   url="http://p.tv/live/8.ts", catchup="xc", catchup_days=7),
            _Entry("M6 HD", EntryType.LIVE, group="FR | TNT",
                   url="http://p.tv/live/9.ts"),
        ])
        with_replay, without = catalog_with_replay.get_live_streams_sync()

        self.assertEqual(with_replay["tv_archive"], 1)
        self.assertEqual(with_replay["tv_archive_duration"], 7)
        self.assertEqual(with_replay["catchup"], "xc")
        self.assertEqual(without["tv_archive"], 0)

    def test_the_stream_url_is_the_one_the_playlist_gave(self):
        """Nothing to rebuild: an M3U line *is* its URL."""
        stream = self.catalog.get_live_streams_sync()[0]
        self.assertEqual(
            self.catalog.get_stream_url("live", str(stream["stream_id"]), "ts"),
            "http://p.tv/live/8.ts")

    def test_an_unknown_id_resolves_to_nothing_rather_than_a_wrong_url(self):
        self.catalog.db = None  # any DB lookup here would be a bug
        self.assertEqual(self.catalog.get_stream_url("live", "not-an-id", "ts"), "")


class TestIdsSurviveAReparse(unittest.TestCase):
    """The ids the catalogue hands out must not move when the playlist is re-read.

    A reparse deletes every row of the source and re-inserts it. While the id
    was the autoincrement primary key, that renumbered the whole catalogue once
    an hour, and everything holding one — a live playlist above all — resolved
    nothing afterwards and served an empty M3U.
    """

    def setUp(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from app.models.source_entry import SourceEntry

        engine = create_engine("sqlite://")
        SourceEntry.__table__.create(engine)
        self.db = sessionmaker(bind=engine)()
        self.SourceEntry = SourceEntry

        self.lines = [
            line("TF1 HD", "http://p.tv/live/8.ts", "FR | TNT"),
            line("M6 HD", "http://p.tv/live/9.ts", "FR | TNT"),
            line("Le Parrain", "http://p.tv/movie/u/p/10.mkv", "FR | FILMS"),
        ]

        class _Subscription:
            id = 1
            name = "test"
            last_sync = None
            source_type = "url"
            url = "http://p.tv/list.m3u"

        self.catalog = catalog.M3UCatalog(self.db, _Subscription())
        self.catalog._read_playlist = lambda: self.lines

    def tearDown(self):
        self.db.close()

    def _reparse(self):
        existing = self.db.query(self.SourceEntry).count()
        self.catalog._parse_into_rows(existing)
        return {s["name"]: s["stream_id"]
                for s in self.catalog.get_live_streams_sync()}

    def test_a_channel_keeps_its_id_across_two_parses(self):
        before = self._reparse()
        keys_before = {e.id for e in self.db.query(self.SourceEntry)
                       if e.subscription_id == 1}

        # Another source holding the high row ids is what made the renumbering
        # visible in production: the delete frees this source's keys, and the
        # re-insert takes fresh ones above everyone else's.
        self.db.add(self.SourceEntry(id=9000, subscription_id=2, title="x",
                                     url="http://q.tv/1.ts", entry_type="live"))
        self.db.commit()

        after = self._reparse()
        keys_after = {e.id for e in self.db.query(self.SourceEntry)
                      if e.subscription_id == 1}

        self.assertEqual(before, after)
        # The primary keys really were renumbered — the ids above held anyway.
        self.assertFalse(keys_before & keys_after)

    def test_a_channel_still_resolves_to_its_url_after_a_reparse(self):
        before = self._reparse()
        self._reparse()
        self.assertEqual(
            self.catalog.get_stream_url("live", str(before["TF1 HD"]), "ts"),
            "http://p.tv/live/8.ts")

    def test_two_lines_sharing_a_url_get_two_ids(self):
        """A feed listed under two groups is two rows, and neither may shadow
        the other."""
        self.lines.append(line("TF1 HD", "http://p.tv/live/8.ts", "FR | GENERAL"))
        streams = self._reparse()
        ids = [e.stable_id for e in self.db.query(self.SourceEntry)]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(streams), 2)  # keyed by name, the two TF1 collapse

    def test_a_row_parsed_before_the_column_existed_is_given_an_id(self):
        self._reparse()
        for entry in self.db.query(self.SourceEntry):
            entry.stable_id = None
        self.db.commit()

        self.catalog._load_rows()

        ids = [e.stable_id for e in self.db.query(self.SourceEntry)]
        self.assertTrue(all(ids))
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
