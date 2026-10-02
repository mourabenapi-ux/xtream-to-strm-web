"""Tests for the editor's automatic tools (playlist editor v2).

The cases mirror what was measured on the live install on 2026-10-02:
TF1 numbered 0 and France 3 numbered 1, "Info" spilling into "Cinéma",
"Sport" (622 channels) swallowing "MBC", 83 channels sharing the placeholder
guide id "TS", a duplicated group copying its channel numbers, and the header
search shadowed by the category route.
"""
import asyncio
import json
import os
import sys
import unittest
from unittest import mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.db.base  # noqa: F401
from app.db.base_class import Base
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel
from app.services import playlist_tools as tools
from app.services.organizer import load_profile


def G(id, name, numbers, start=None, end=None):
    return tools.GroupNumbers(id=id, name=name, channel_ids=[id * 1000 + i for i in range(len(numbers))],
                              numbers=list(numbers), start=start, end=end)


class NumberingTests(unittest.TestCase):
    def test_repair_keeps_valid_numbers_and_their_gaps(self):
        groups = [G(1, "TNT", [1, 3, 5]), G(2, "Info", [350, 351, 357])]
        self.assertEqual(tools.repair_numbers(groups), {})

    def test_zero_and_shifted_tnt_are_repaired_without_duplicates(self):
        # TF1 0, France 3 1, France 4 2 — what playlists 2 and 7 hold.
        groups = [G(1, "TNT", [0, 1, 2, 3]), G(2, "Info", [350, 351])]
        changes = tools.repair_numbers(groups)
        final = [changes.get(cid, n) for g in groups for cid, n in zip(g.channel_ids, g.numbers)]
        self.assertEqual(final, [1, 2, 3, 4, 350, 351])

    def test_overflowing_group_no_longer_interleaves(self):
        # Info 350..412 and Cinéma 400..480: after repair, strictly increasing.
        groups = [G(1, "Info", list(range(350, 413))), G(2, "Cinéma", [400, 402, 413, 480])]
        changes = tools.repair_numbers(groups)
        final = [changes.get(cid, n) for g in groups for cid, n in zip(g.channel_ids, g.numbers)]
        self.assertEqual(final, sorted(final))
        self.assertEqual(len(set(final)), len(final))

    def test_ranges_make_room_for_a_big_group(self):
        # Sport 622 channels from 100, MBC from 501: MBC must move past Sport.
        groups = [G(1, "Tunisie", list(range(1, 38))), G(2, "Sport", list(range(100, 722))),
                  G(3, "MBC", list(range(501, 609)))]
        ranges = tools.infer_ranges(groups)
        self.assertEqual(ranges[2][0], 100)
        self.assertGreaterEqual(ranges[3][0], 722)
        self.assertEqual(ranges[3][0] % 100, 0)
        self.assertEqual(ranges[2][1], ranges[3][0] - 1)
        changes = tools.repair_numbers(groups, ranges)
        final = [changes.get(cid, n) for g in groups for cid, n in zip(g.channel_ids, g.numbers)]
        self.assertEqual(final, sorted(final))
        self.assertTrue(all(n >= ranges[3][0] for n in final[-108:]))

    def test_reference_block_decides_a_start(self):
        groups = [G(1, "Généralistes & TNT", [0, 1]), G(2, "Info", [380, 381])]
        ranges = tools.infer_ranges(groups, {"Info": (350, 399)})
        self.assertEqual(ranges[2], (350, None))
        self.assertEqual(ranges[1][1], 349)

    def test_a_block_of_another_profile_does_not_move_a_group(self):
        # "Sport" is 300-399 in the detailed profile; a playlist that numbers
        # its Sport from 100 keeps 100.
        groups = [G(1, "Tunisie", [1, 2]), G(2, "Sport", list(range(100, 130)))]
        ranges = tools.infer_ranges(groups, {"Sport": [(300, 399), (1500, 2999)]})
        self.assertEqual(ranges[2][0], 100)
        self.assertEqual(tools.repair_numbers(groups, ranges), {})

    def test_a_group_too_spread_for_its_range_is_compacted(self):
        # 6 channels spread over 100..150 with a range ending at 110.
        groups = [G(1, "Sport", [100, 110, 120, 130, 140, 150], start=100, end=110), G(2, "MBC", [200])]
        changes = tools.repair_numbers(groups, {1: (100, 110), 2: (111, None)})
        final = [changes.get(cid, n) for cid, n in zip(groups[0].channel_ids, groups[0].numbers)]
        self.assertEqual(final, [100, 101, 102, 103, 104, 105])

    def test_declared_range_is_kept(self):
        groups = [G(1, "A", [5], start=10, end=19), G(2, "B", [30])]
        self.assertEqual(tools.infer_ranges(groups)[1], (10, 19))
        self.assertEqual(tools.repair_numbers(groups, tools.infer_ranges(groups)), {1000: 10})

    def test_issues_are_reported(self):
        groups = [G(1, "Info", [350, 351, 401]), G(2, "Cinéma", [400, 401])]
        issues = tools.numbering_issues(groups)
        self.assertIn(401, issues["duplicates"])
        self.assertEqual(issues["overlaps"][0]["names"], ["Info", "Cinéma"])
        self.assertEqual(tools.numbering_issues([G(1, "T", [0, 1])])["invalid"], [1000])

    def test_next_free_number_respects_the_range(self):
        self.assertEqual(tools.next_free_number([10, 11], 10, 19), 12)
        self.assertIsNone(tools.next_free_number(range(10, 20), 10, 19))


class ReferenceTests(unittest.TestCase):
    def test_tnt_gets_its_official_numbers(self):
        reference = load_profile("compact")
        group = G(1, "Généralistes & TNT", [0, 1, 2, 3], start=1, end=349)
        names = {group.channel_ids[0]: ("TF1", "TF1.fr"), group.channel_ids[1]: ("France 3", ""),
                 group.channel_ids[2]: ("M6 HD (1080p)", ""), group.channel_ids[3]: ("Chaîne Inconnue XYZ", "")}
        changes, ordered = tools.reference_numbers(group, names, reference, taken_elsewhere=[])
        final = {cid: changes.get(cid, n) for cid, n in zip(group.channel_ids, group.numbers)}
        self.assertEqual(final[group.channel_ids[0]], 1)
        self.assertEqual(final[group.channel_ids[1]], 3)
        self.assertEqual(final[group.channel_ids[2]], 6)
        # Unknown channel: after the last reference number, not on top of one.
        self.assertGreater(final[group.channel_ids[3]], 6)
        self.assertEqual(ordered[0], group.channel_ids[0])

    def test_unrecognised_channels_stay_inside_the_range(self):
        # 3 TNT channels + 40 unknown ones in a range ending at 30: the unknown
        # ones fill the gaps instead of spilling into the next group.
        reference = load_profile("compact")
        numbers = list(range(0, 43))
        group = G(1, "TNT", numbers, start=1, end=60)
        names = {cid: (f"Unknown Channel {i}", "") for i, cid in enumerate(group.channel_ids)}
        names[group.channel_ids[0]] = ("TF1", "")
        names[group.channel_ids[1]] = ("France 3", "")
        names[group.channel_ids[2]] = ("Arte", "")
        changes, _ = tools.reference_numbers(group, names, reference, taken_elsewhere=[])
        final = [changes.get(cid, n) for cid, n in zip(group.channel_ids, group.numbers)]
        self.assertTrue(all(1 <= n <= 60 for n in final), final)
        self.assertEqual(len(set(final)), len(final))

    def test_a_delayed_feed_never_takes_the_parent_number(self):
        reference = load_profile("compact")
        self.assertIsNone(tools.reference_lookup(reference, "TF1 +1", ""))

    def test_number_held_by_another_group_is_left_alone(self):
        reference = load_profile("compact")
        group = G(1, "TNT", [50])
        changes, _ = tools.reference_numbers(group, {group.channel_ids[0]: ("TF1", "")}, reference, [1])
        self.assertNotEqual(changes.get(group.channel_ids[0], 50), 1)

    def test_group_names_decide_between_profiles(self):
        refs = {n: load_profile(n) for n in ("detailed", "compact")}
        channels = [("TF1", "", "Généralistes & TNT"), ("France 24", "", "Info"), ("BFM TV", "", "Généralistes & TNT")]
        self.assertEqual(tools.best_reference(refs, channels), "compact")

    def test_group_names_identify_the_arabic_profile(self):
        refs = {n: load_profile(n) for n in ("detailed", "compact", "arabic")}
        groups = ["Tunisie", "Sport", "MBC & Rotana", "Info", "Divertissement", "Enfants", "Hors référence"]
        channels = [("beIN Sports 1", ""), ("RMC Sport 1", ""), ("Canal+ Sport", ""), ("Nessma", "")]
        self.assertEqual(tools.best_profile(refs, groups, channels), "arabic")
        self.assertEqual(tools.best_profile(refs, ["Généralistes & TNT", "Info", "Cinéma & Séries", "Découverte & Jeunesse"],
                                            [("TF1", "")]), "compact")

    def test_unknown_channels_keep_a_valid_number(self):
        reference = load_profile("compact")
        group = G(1, "Info", [350, 380], start=350, end=399)
        names = {group.channel_ids[0]: ("France 24", ""), group.channel_ids[1]: ("Some Local Info", "")}
        changes, _ = tools.reference_numbers(group, names, reference, taken_elsewhere=[])
        self.assertNotIn(group.channel_ids[1], changes)

    def test_best_profile_is_the_one_that_recognises_most(self):
        refs = {n: load_profile(n) for n in ("compact", "arabic")}
        self.assertEqual(tools.best_reference(refs, [("TF1", ""), ("France 2", ""), ("M6", "")]), "compact")


class RuleTests(unittest.TestCase):
    def test_keywords_ignore_accents_and_case(self):
        rule = tools.GroupRule(include=["bein sport"], exclude=["4k"])
        self.assertTrue(rule.matches(1, "5", "AR: beIN SPORTS 1 HD"))
        self.assertFalse(rule.matches(1, "5", "AR: beIN SPORTS 1 4K"))
        self.assertFalse(rule.matches(1, "5", "Canal+ Sport"))

    def test_rule_must_narrow_something(self):
        self.assertFalse(tools.GroupRule(subscription_ids=[1]).is_usable())
        self.assertIsNone(tools.GroupRule.parse(json.dumps({"subscription_ids": [1]})))
        self.assertIsNotNone(tools.GroupRule.parse(json.dumps({"category_ids": ["7"]})))

    def test_category_and_provider_filters(self):
        rule = tools.GroupRule(subscription_ids=[1], category_ids=["7"])
        self.assertTrue(rule.matches(1, "7", "x"))
        self.assertFalse(rule.matches(2, "7", "x"))
        self.assertFalse(rule.matches(1, "8", "x"))


class ReplacementTests(unittest.TestCase):
    def test_same_provider_new_id_is_preferred(self):
        catalogues = {
            1: [{"stream_id": 900, "name": "AR: Tarab HD", "category_id": "3"}],
            2: [{"stream_id": 5, "name": "Tarab", "category_id": "9"},
                {"stream_id": 6, "name": "Tarab +1", "category_id": "9"}],
        }
        found = tools.replacement_candidates("Tarab", 1, catalogues, in_playlist=[])
        self.assertEqual([(c.subscription_id, c.stream_id) for c in found], [(1, "900"), (2, "5")])

    def test_already_in_playlist_ranks_last(self):
        catalogues = {2: [{"stream_id": 5, "name": "Tarab"}, {"stream_id": 7, "name": "Tarab FHD"}]}
        found = tools.replacement_candidates("Tarab", 1, catalogues, in_playlist=[(2, "5")])
        self.assertEqual(found[0].stream_id, "7")


# ---------------------------------------------------------------------------
# Endpoints, on an in-memory database
# ---------------------------------------------------------------------------

def run(coro):
    return asyncio.run(coro)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.playlist = LivePlaylist(name="P", use_channel_numbers=True)
        self.db.add(self.playlist)
        self.db.flush()
        self.tnt = LivePlaylistBouquet(playlist_id=self.playlist.id, custom_name="Généralistes & TNT", order=0)
        self.info = LivePlaylistBouquet(playlist_id=self.playlist.id, custom_name="Info", order=1)
        self.db.add_all([self.tnt, self.info])
        self.db.flush()
        self.rows = []
        for i, (name, n) in enumerate([("TF1", 0), ("France 3", 1), ("France 4", 2)]):
            self.rows.append(LivePlaylistChannel(bouquet_id=self.tnt.id, subscription_id=1,
                                                 stream_id=str(10 + i), custom_name=name, order=n))
        for i, n in enumerate([350, 380, 400]):
            self.rows.append(LivePlaylistChannel(bouquet_id=self.info.id, subscription_id=1,
                                                 stream_id=str(20 + i), custom_name=f"Info {i}", order=n))
        self.db.add_all(self.rows)
        self.db.commit()

    def numbers(self):
        self.db.expire_all()
        return {c.custom_name: c.order for c in self.db.query(LivePlaylistChannel).all()}

    def test_fix_numbering_sets_ranges_and_repairs(self):
        from app.api.api_v1.endpoints import live_tools
        result = live_tools.fix_numbering(self.playlist.id, live_tools.NumberingFixIn(), self.db)
        numbers = self.numbers()
        self.assertEqual([numbers["TF1"], numbers["France 3"], numbers["France 4"]], [1, 2, 3])
        self.assertEqual(numbers["Info 0"], 350)
        self.db.refresh(self.info)
        self.assertEqual(self.info.number_start, 350)
        self.assertGreater(result["changed"], 0)

    def test_reference_numbering_gives_tnt_numbers(self):
        from app.api.api_v1.endpoints import live_tools

        async def fake_resolve(db, playlist, dropped=None):
            return [{"channel_id": c.id, "name": c.custom_name, "epg_id": ""}
                    for b in playlist.bouquets for c in b.channels]

        with mock.patch.object(live_tools, "resolve_playlist_channels", fake_resolve):
            result = run(live_tools.reference_numbering(
                self.playlist.id, live_tools.ReferenceNumberingIn(bouquet_ids=[self.tnt.id]), self.db))
        numbers = self.numbers()
        self.assertEqual((numbers["TF1"], numbers["France 3"], numbers["France 4"]), (1, 3, 4))
        self.assertIsNotNone(result["profile"])

    def test_dedupe_keeps_the_first(self):
        from app.api.api_v1.endpoints import live_tools
        self.db.add(LivePlaylistChannel(bouquet_id=self.info.id, subscription_id=1, stream_id="10",
                                        custom_name="TF1 copy", order=999))
        self.db.commit()
        self.assertEqual(live_tools.dedupe_channels(self.playlist.id, self.db)["removed"], 1)
        self.assertNotIn("TF1 copy", self.numbers())

    def test_detach_and_exclude(self):
        from app.api.api_v1.endpoints import live_tools
        ids = [self.rows[0].id]
        live_tools.set_guide_mode(self.playlist.id, live_tools.GuideActionIn(channel_ids=ids, action="detach"), self.db)
        live_tools.set_excluded(self.playlist.id, live_tools.ExcludeIn(channel_ids=ids), self.db)
        self.db.refresh(self.rows[0])
        self.assertEqual(self.rows[0].epg_channel_id, "-")
        self.assertTrue(self.rows[0].is_excluded)

    def test_rule_group_adds_new_matches_once_and_respects_hidden_rows(self):
        from app.api.api_v1.endpoints import live_tools
        sport = LivePlaylistBouquet(playlist_id=self.playlist.id, custom_name="beIN", order=2,
                                    number_start=500, number_end=599,
                                    rule=tools.GroupRule(include=["bein"], subscription_ids=[1]).to_json())
        self.db.add(sport)
        self.db.flush()
        self.db.add(LivePlaylistChannel(bouquet_id=sport.id, subscription_id=1, stream_id="31",
                                        custom_name="beIN 2", order=500, is_excluded=True))
        self.db.commit()
        catalogue = {1: [{"stream_id": 30, "name": "beIN Sports 1", "category_id": "4"},
                         {"stream_id": 31, "name": "beIN Sports 2", "category_id": "4"},
                         {"stream_id": 32, "name": "Canal+", "category_id": "4"}]}

        async def fake_catalogues(db, subs):
            return catalogue

        with mock.patch.object(live_tools, "_catalogues", fake_catalogues):
            first = run(live_tools.refresh_rule_groups(self.db, self.playlist))
            second = run(live_tools.refresh_rule_groups(self.db, self.playlist))
        self.assertEqual(first[0]["added"], 1)
        self.assertEqual(second[0]["added"], 0)
        added = self.db.query(LivePlaylistChannel).filter_by(bouquet_id=sport.id, stream_id="30").one()
        self.assertEqual(added.order, 501)

    def test_duplicate_group_gets_fresh_numbers(self):
        from app.api.api_v1.endpoints import live
        live.duplicate_bouquet(self.playlist.id, self.info.id, self.db)
        orders = [c.order for c in self.db.query(LivePlaylistChannel).all()]
        self.assertEqual(len(orders), len(set(orders)))

    def test_organizer_diff_and_update(self):
        from app.api.api_v1.endpoints import organizer as org
        plan = [org.ApplyChannelIn(number=1, name="TF1", group="Généralistes & TNT", subscription_id=1, stream_id="10"),
                org.ApplyChannelIn(number=2, name="France 2", group="Généralistes & TNT", subscription_id=1, stream_id="99"),
                org.ApplyChannelIn(number=1500, name="beIN", group="Sport", subscription_id=1, stream_id="77")]
        diff = org.diff_organization(org.DiffIn(playlist_id=self.playlist.id, channels=plan), self.db)
        self.assertEqual({a["stream_id"] for a in diff["add"]}, {"99", "77"})
        self.assertEqual(diff["renumber"][0]["to_number"], 1)
        self.assertEqual(len(diff["remove"]), 5)
        result = org.update_organization(org.UpdateIn(
            playlist_id=self.playlist.id, add=plan[1:], renumber=[org.RenumberIn(
                channel_id=diff["renumber"][0]["channel_id"], number=1, group="Généralistes & TNT")],
            config={"profile": "compact"}), self.db)
        self.assertEqual((result["added"], result["renumbered"], result["removed"]), (2, 1, 0))
        numbers = self.numbers()
        self.assertEqual(numbers["TF1"], 1)
        self.assertNotEqual(numbers["France 2"], numbers["France 3"])  # 2 was free? France 3 had 1
        self.db.refresh(self.playlist)
        self.assertIn("compact", self.playlist.organizer_config)
        self.assertIn("Sport", [b.custom_name for b in self.playlist.bouquets])


class ResolverTests(unittest.TestCase):
    def test_ts_placeholder_and_detached_publish_no_id(self):
        from app.api.api_v1.endpoints import live
        self.assertEqual(live._clean_epg_id("TS"), "")
        self.assertEqual(live._clean_epg_id("TF1.fr"), "TF1.fr")

    def test_search_route_is_declared_before_the_category_route(self):
        from app.api.api_v1.endpoints import live
        paths = [r.path for r in live.router.routes]
        self.assertLess(paths.index("/streams/search"), paths.index("/streams/{category_id}"))


if __name__ == "__main__":
    unittest.main()


class SearchTests(unittest.TestCase):
    def test_numbers_match_whole_and_decorations_fold(self):
        from app.api.api_v1.endpoints.live_tools import _matcher
        score = _matcher("france 2")
        self.assertIsNotNone(score("FR| FRANCE 2 HD"))
        self.assertIsNone(score("France 24"))
        self.assertIsNotNone(_matcher("tf1 hd")("FR: TF1 ᴴᴰ"))
        self.assertLess(score("France 2"), score("FR| FRANCE 2 HD (Backup VIP Channel)"))
