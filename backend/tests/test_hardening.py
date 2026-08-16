"""Tests for the decisions that place, rename and refresh generated files.

These cover the three defects fixed on 2026-08-16 that silently produced wrong
content rather than an error: an ongoing series that never gained episodes,
duplicate catalogue entries overwriting each other, and EPG ids handed to
several channels at once.
"""
import unittest
from unittest.mock import MagicMock
import sys
import os
from datetime import datetime, timedelta

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.services.file_manager import FileManager
from app.tasks.sync import (
    _disambiguate_paths, _needs_episode_refresh, _provider_stamp,
)


class TestSeriesEpisodeRefresh(unittest.TestCase):
    """An ongoing series must be re-read, or new episodes never appear."""

    def _cached(self, last_modified=None, last_refreshed=None):
        c = MagicMock()
        c.last_modified = last_modified
        c.last_refreshed = last_refreshed
        return c

    def test_provider_stamp_read_from_listing(self):
        self.assertEqual(_provider_stamp({"last_modified": "1700000000"}), "1700000000")
        self.assertEqual(_provider_stamp({"last_modified_date": "1700000000"}), "1700000000")

    def test_provider_stamp_absent_or_useless(self):
        # "0" and "" are how providers spell "I am not tracking this".
        for value in ({}, {"last_modified": None}, {"last_modified": ""}, {"last_modified": "0"}):
            self.assertIsNone(_provider_stamp(value))

    def test_stamp_moved_forces_refresh(self):
        cached = self._cached(last_modified="100", last_refreshed=datetime.utcnow())
        self.assertTrue(_needs_episode_refresh(cached, "200", timedelta(hours=12)))

    def test_stamp_unchanged_and_recent_is_skipped(self):
        cached = self._cached(last_modified="100", last_refreshed=datetime.utcnow())
        self.assertFalse(_needs_episode_refresh(cached, "100", timedelta(hours=12)))

    def test_never_refreshed_is_always_refreshed(self):
        # Rows predating the column: refreshed once, which is the repair an
        # existing library needs.
        cached = self._cached(last_modified="100", last_refreshed=None)
        self.assertTrue(_needs_episode_refresh(cached, "100", timedelta(hours=12)))

    def test_stale_refresh_forces_refresh_without_a_stamp(self):
        # The provider offers no stamp, so age is the only safe trigger.
        cached = self._cached(last_refreshed=datetime.utcnow() - timedelta(hours=13))
        self.assertTrue(_needs_episode_refresh(cached, None, timedelta(hours=12)))

    def test_fresh_refresh_without_a_stamp_is_skipped(self):
        cached = self._cached(last_refreshed=datetime.utcnow() - timedelta(hours=1))
        self.assertFalse(_needs_episode_refresh(cached, None, timedelta(hours=12)))


class TestDisambiguatePaths(unittest.TestCase):
    """Two catalogue entries must never resolve to one file."""

    def test_unique_paths_get_no_suffix(self):
        items = [{"stream_id": 1}, {"stream_id": 2}]
        result = _disambiguate_paths(items, "stream_id", lambda i: f"/lib/{i['stream_id']}")
        self.assertEqual(result, {})

    def test_collision_suffixes_all_but_the_first(self):
        items = [{"stream_id": 7}, {"stream_id": 3}, {"stream_id": 9}]
        result = _disambiguate_paths(items, "stream_id", lambda i: "/lib/REMORDS")
        # Lowest id keeps the bare name.
        self.assertNotIn(3, result)
        self.assertEqual(result[7], "(2)")
        self.assertEqual(result[9], "(3)")

    def test_rank_is_stable_whatever_the_arrival_order(self):
        path_of = lambda i: "/lib/REMORDS"
        forward = _disambiguate_paths([{"stream_id": 3}, {"stream_id": 7}], "stream_id", path_of)
        reverse = _disambiguate_paths([{"stream_id": 7}, {"stream_id": 3}], "stream_id", path_of)
        # The provider does not guarantee list order; ranking by arrival would
        # rename files on disk between two otherwise identical syncs.
        self.assertEqual(forward, reverse)

    def test_separate_collision_groups_are_numbered_independently(self):
        items = [
            {"stream_id": 1}, {"stream_id": 2},   # -> /lib/A
            {"stream_id": 5}, {"stream_id": 6},   # -> /lib/B
        ]
        result = _disambiguate_paths(
            items, "stream_id",
            lambda i: "/lib/A" if i["stream_id"] < 5 else "/lib/B",
        )
        self.assertEqual(result, {2: "(2)", 6: "(2)"})


class TestDisambiguatorReachesThePath(unittest.TestCase):
    """The suffix must change the folder *and* the filename, or nothing moves."""

    def setUp(self):
        self.fm = FileManager("/lib")

    def test_movie_folder_and_filename_both_carry_it(self):
        plain = self.fm.get_movie_target_info(
            {"name": "REMORDS"}, "Films", use_category_folders=False)
        second = self.fm.get_movie_target_info(
            {"name": "REMORDS"}, "Films", use_category_folders=False, disambiguator="(2)")

        self.assertNotEqual(plain["target_dir"], second["target_dir"])
        self.assertNotEqual(plain["filename_base"], second["filename_base"])
        self.assertIn("(2)", second["filename_base"])

    def test_movie_suffix_precedes_the_tmdb_tag(self):
        info = self.fm.get_movie_target_info(
            {"name": "REMORDS", "tmdb": "550"}, "Films",
            use_category_folders=False, disambiguator="(2)")
        # Jellyfin reads {tmdb-…}; text after it is not reliably ignored.
        self.assertTrue(info["filename_base"].endswith("{tmdb-550}"))
        self.assertIn("(2)", info["filename_base"])

    def test_series_folder_carries_it(self):
        plain = self.fm.get_series_target_info(
            {"name": "Cool Series"}, "Drama", use_category_folders=False)
        second = self.fm.get_series_target_info(
            {"name": "Cool Series"}, "Drama", use_category_folders=False, disambiguator="(2)")
        self.assertNotEqual(plain["series_dir"], second["series_dir"])
        self.assertIn("(2)", second["safe_series_name"])

    def test_empty_disambiguator_changes_nothing(self):
        a = self.fm.get_movie_target_info({"name": "REMORDS"}, "Films")
        b = self.fm.get_movie_target_info({"name": "REMORDS"}, "Films", disambiguator="")
        self.assertEqual(a["target_dir"], b["target_dir"])
        self.assertEqual(a["filename_base"], b["filename_base"])


class TestReleaseSharedEPGIds(unittest.TestCase):
    """One EPG id describes one channel; several holders means most are wrong."""

    def _playlist(self, *epg_ids):
        channels = []
        for epg_id in epg_ids:
            ch = MagicMock()
            ch.epg_channel_id = epg_id
            channels.append(ch)
        bouquet = MagicMock()
        bouquet.channels = channels
        playlist = MagicMock()
        playlist.bouquets = [bouquet]
        return playlist, channels

    def test_shared_ids_are_released(self):
        from app.services.epg import EPGService
        playlist, channels = self._playlist("A.fr", "A.fr", "A.fr")
        db = MagicMock()
        result = EPGService.release_shared_epg_ids(playlist, db)
        self.assertEqual(result["released"], 3)
        self.assertTrue(all(c.epg_channel_id is None for c in channels))
        db.commit.assert_called_once()

    def test_unique_mappings_survive(self):
        from app.services.epg import EPGService
        playlist, channels = self._playlist("A.fr", "B.fr", None)
        db = MagicMock()
        result = EPGService.release_shared_epg_ids(playlist, db)
        self.assertEqual(result["released"], 0)
        self.assertEqual(channels[0].epg_channel_id, "A.fr")
        self.assertEqual(channels[1].epg_channel_id, "B.fr")
        db.commit.assert_not_called()

    def test_only_the_shared_group_is_released(self):
        from app.services.epg import EPGService
        playlist, channels = self._playlist("A.fr", "A.fr", "B.fr")
        db = MagicMock()
        EPGService.release_shared_epg_ids(playlist, db)
        self.assertIsNone(channels[0].epg_channel_id)
        self.assertIsNone(channels[1].epg_channel_id)
        # A hand-made unique mapping is not collateral damage.
        self.assertEqual(channels[2].epg_channel_id, "B.fr")


class _FakeRedis:
    """Just enough Redis to serve one EPG source's channel pool."""

    def __init__(self, source_id, channels):
        self._members = {f"epg:src:{source_id}:channels": set(channels)}
        self._hashes = {
            f"epg:src:{source_id}:channel:{cid}": {"name": name}
            for cid, name in channels.items()
        }

    def smembers(self, key):
        return self._members.get(key, set())

    def hgetall(self, key):
        return self._hashes.get(key, {})


class TestAutoMatchAssignment(unittest.IsolatedAsyncioTestCase):
    """The matcher must be accurate *and* refuse to reuse an id.

    Reproduces the shape of the original defect: 18 channels were all handed
    `APlusInternational.fr`, and that was reported as 18 successes.
    """

    SOURCE_ID = 77
    GUIDE = {
        "TF1.fr": "TF1",
        "M6.fr": "M6",
        "ARTE.fr": "Arte",
        "AB1.fr": "AB1",          # short name: exact equality must still work
        "BFMTV.fr": "BFM TV",
    }

    def _service(self):
        from app.services.epg import EPGService
        svc = EPGService.__new__(EPGService)
        svc.redis = _FakeRedis(self.SOURCE_ID, self.GUIDE)
        return svc

    def _playlist(self, names):
        channels = []
        for i, nm in enumerate(names):
            c = MagicMock()
            c.custom_name = nm
            c.epg_channel_id = None
            c.subscription_id = None
            c.stream_id = 1000 + i
            channels.append(c)
        bouquet = MagicMock()
        bouquet.channels = channels
        bouquet.subscription_id = None
        link = MagicMock()
        link.priority = 1
        link.epg_source = MagicMock()
        link.epg_source.id = self.SOURCE_ID
        link.epg_source.is_active = True
        playlist = MagicMock()
        playlist.subscription_id = None   # no provider fetch
        playlist.bouquets = [bouquet]
        playlist.epg_source_links = [link]
        return playlist, channels

    async def test_exact_names_map_to_their_own_id(self):
        svc = self._service()
        playlist, channels = self._playlist(list(self.GUIDE.values()))
        report = await svc.auto_match_channels(playlist, MagicMock())
        self.assertEqual(report["matched_count"], len(self.GUIDE))
        self.assertEqual([c.epg_channel_id for c in channels], list(self.GUIDE.keys()))

    async def test_short_name_still_matches_exactly(self):
        # "AB1" cleans to 3 characters. A length floor on the exact path made
        # a channel fail to find its own entry in the guide.
        svc = self._service()
        playlist, channels = self._playlist(["AB1"])
        report = await svc.auto_match_channels(playlist, MagicMock())
        self.assertEqual(report["matched_count"], 1)
        self.assertEqual(channels[0].epg_channel_id, "AB1.fr")

    async def test_one_id_is_never_given_to_two_channels(self):
        svc = self._service()
        playlist, channels = self._playlist(["TF1"] * 6)
        report = await svc.auto_match_channels(playlist, MagicMock())
        assigned = [c.epg_channel_id for c in channels if c.epg_channel_id]
        self.assertEqual(report["matched_count"], 1)
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(report["rejected_already_claimed"], 5)

    async def test_unrelated_names_match_nothing(self):
        # A wrong guide is worse than no guide: the channel then shows a
        # plausible schedule that is not its own.
        svc = self._service()
        playlist, channels = self._playlist(
            ["Wataniya Tunisia 1", "Zaytoona TV", "Jawhara FM"])
        report = await svc.auto_match_channels(playlist, MagicMock())
        self.assertEqual(report["matched_count"], 0)
        self.assertTrue(all(c.epg_channel_id is None for c in channels))

    async def test_no_source_linked_says_so(self):
        svc = self._service()
        playlist, _ = self._playlist(["TF1"])
        playlist.epg_source_links = []
        report = await svc.auto_match_channels(playlist, MagicMock())
        self.assertEqual(report["matched_count"], 0)
        self.assertIn("no active EPG source", report["message"])


class _GuideRedis:
    """Redis stub covering the calls generate_playlist_xmltv makes."""

    def __init__(self, sources):
        # sources: {source_id: {epg_id: [programme_start_ts, ...]}}
        self.sources = sources

    def sismember(self, key, member):
        src = int(key.split(":")[2])
        return member in self.sources.get(src, {})

    def zcount(self, key, lo, hi):
        parts = key.split(":")
        src, epg_id = int(parts[2]), parts[4]
        return len(self.sources.get(src, {}).get(epg_id, []))

    def zrangebyscore(self, key, lo, hi):
        import json as _json
        parts = key.split(":")
        src, epg_id = int(parts[2]), parts[4]
        return [
            _json.dumps({"start": s, "stop": s + 3600, "title": f"P{i}"})
            for i, s in enumerate(self.sources.get(src, {}).get(epg_id, []))
        ]

    def hgetall(self, key):
        return {"name": "Chan"}


class TestGuideSourceFallback(unittest.TestCase):
    """A source that lists a channel but has no schedule must not block one that does."""

    def _playlist(self, links):
        source_links = []
        for src_id, priority in links:
            link = MagicMock()
            link.priority = priority
            link.epg_source = MagicMock()
            link.epg_source.id = src_id
            link.epg_source.is_active = True
            source_links.append(link)
        playlist = MagicMock()
        playlist.id = 1
        playlist.epg_source_links = source_links
        return playlist

    def _generate(self, sources, links):
        from app.services.epg import EPGService
        import time
        svc = EPGService.__new__(EPGService)
        svc.redis = _GuideRedis(sources)
        playlist = self._playlist(links)
        return svc.generate_playlist_xmltv(
            playlist, channels=[{"epg_id": "TF1.fr", "name": "TF1"}]
        )

    def test_falls_back_to_the_source_that_has_programmes(self):
        import time
        now = time.time()
        # Source 9 is top priority and lists the channel with no schedule —
        # exactly what the provider's own XMLTV does. Source 1 holds the data.
        xml = self._generate(
            sources={9: {"TF1.fr": []}, 1: {"TF1.fr": [now + 60, now + 3660]}},
            links=[(9, 10), (1, 1)],
        )
        self.assertEqual(xml.count("<programme"), 2)

    def test_priority_still_decides_between_sources_that_both_have_data(self):
        import time
        now = time.time()
        xml = self._generate(
            sources={9: {"TF1.fr": [now + 60]}, 1: {"TF1.fr": [now + 60, now + 3660]}},
            links=[(9, 10), (1, 1)],
        )
        self.assertEqual(xml.count("<programme"), 1)

    def test_channel_is_still_described_when_nobody_has_programmes(self):
        # The M3U advertises this tvg-id, so it must resolve to something.
        xml = self._generate(
            sources={9: {"TF1.fr": []}, 1: {"TF1.fr": []}},
            links=[(9, 10), (1, 1)],
        )
        self.assertEqual(xml.count("<channel "), 1)
        self.assertEqual(xml.count("<programme"), 0)


if __name__ == "__main__":
    unittest.main()
