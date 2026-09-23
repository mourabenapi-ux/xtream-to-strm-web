"""Tests for the automatic channel organiser.

The cases below are not hypothetical: every one of them is a real name served by
one of the two subscriptions, and the three "guard" classes cover the mistakes
this kind of code makes silently — merging two different channels, splitting one
channel in two, and accepting a fuzzy match that puts a channel on the wrong
number.
"""
import os
import sys
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.services.organizer import (
    BACKUP_GROUP, PROFILES, TAIL_GROUP, TIMESHIFT_GROUP, OrganizeOptions,
    Reference, SourceStream, is_junk, load_profile, load_reference, match_key,
    organize, parse_name, trailing_number,
)


def stream(name, subscription_id=1, stream_id="1", epg="", category=""):
    return SourceStream(subscription_id=subscription_id, stream_id=stream_id,
                        name=name, epg_channel_id=epg, category_name=category)


class TestParseName(unittest.TestCase):
    """The provider prefix, the quality and the feed tags must all come off."""

    def test_colon_prefix(self):
        parsed = parse_name("FR: TF1 HD")
        self.assertEqual(parsed.canonical, "TF1")
        self.assertEqual(parsed.quality, "HD")

    def test_underscore_prefix(self):
        """Aziza writes FR_CANAL_CINEMA_HD. Missing this costs 67 merges."""
        parsed = parse_name("FR_CANAL_CINEMA_HD")
        self.assertEqual(match_key(parsed.canonical), "canal cinema")
        self.assertEqual(parsed.quality, "HD")

    def test_dash_prefix(self):
        self.assertEqual(parse_name("FR-Bein Sports 1 SD").canonical, "Bein Sports 1")

    def test_stacked_prefixes(self):
        self.assertEqual(parse_name("VIP: FR: TMC").canonical, "TMC")

    def test_decorations_are_removed(self):
        parsed = parse_name("FR: CANAL+ LIVE 4 ᴴᴰ")
        self.assertEqual(match_key(parsed.canonical), "canalplus live 4")

    def test_quality_variants(self):
        self.assertEqual(parse_name("FR: TF1 4K").quality, "4K")
        self.assertEqual(parse_name("FR: TF1 (UHD)").quality, "4K")
        self.assertEqual(parse_name("FR-TF1 SD").quality, "SD")
        self.assertEqual(parse_name("FR: TF1").quality, "")

    def test_interlaced_and_low_res_tags_are_quality_not_name(self):
        """iptv-org writes '1080i', '576p' and '360p'; only 'p' was recognised.

        'El Watania 1 (1080i)' kept "1080i" in the canonical text, which then
        never matched the clean reference entry "El Watania 1": the trailing-
        number guard saw "1080i" has no trailing digit, disagreed with the
        reference's "1", and refused the merge outright.
        """
        self.assertEqual(parse_name("El Watania 1 (1080i)").canonical, "El Watania 1")
        self.assertEqual(parse_name("El Watania 1 (1080i)").quality, "FHD")
        self.assertEqual(parse_name("LBC (576p)").canonical, "LBC")
        self.assertEqual(parse_name("Al Alam (360p)").canonical, "Al Alam")

    def test_timeshift(self):
        parsed = parse_name("FR: TF1 +1 HD")
        self.assertEqual(parsed.timeshift, 1)
        self.assertEqual(parsed.canonical, "TF1")

    def test_canal_plus_keeps_its_plus(self):
        """'Canal+' is a name, not a one-hour delay."""
        parsed = parse_name("FR-Canal+Sport HD")
        self.assertEqual(parsed.timeshift, 0)
        self.assertEqual(match_key(parsed.canonical), "canalplus sport")

    def test_a_plus_inside_a_word_is_not_a_delay(self):
        """'CANAL+ 360' is a channel number, not 360 hours of delay."""
        parsed = parse_name("FR: CANAL+ 360 HD")
        self.assertEqual(parsed.timeshift, 0)
        self.assertEqual(match_key(parsed.canonical), "canalplus 360")

    def test_an_absurd_delay_is_refused(self):
        parsed = parse_name("FR: SOMETHING +99")
        self.assertEqual(parsed.timeshift, 0)

    def test_a_glued_plus_one_is_a_delay(self):
        """One provider writes the delay with no space at all."""
        for raw, expected in [("FR_CANAL_FAMILY+1", "canal family"),
                              ("FR-TFX+1", "tfx"),
                              ("FR: DISNEY CHANNEL+1 HEVC", "disney channel"),
                              ("FR_CINE_EMOTION+1", "cine emotion")]:
            parsed = parse_name(raw)
            self.assertEqual(parsed.timeshift, 1, raw)
            self.assertEqual(match_key(parsed.canonical), expected, raw)

    def test_a_digit_before_the_plus_is_not_a_delay(self):
        """'LIGUE1+ 8' is feed 8 of Ligue 1+, not eight hours of delay."""
        parsed = parse_name("FR: LIGUE1+ ᴮᴱ 8 ᴿᴬᵂ")
        self.assertEqual(parsed.timeshift, 0)
        self.assertTrue(match_key(parsed.canonical).endswith("8"))

    def test_feed_flags_leave_the_name(self):
        parsed = parse_name("PRIME: FRANCE 2 ᴿᴬᵂ")
        self.assertEqual(match_key(parsed.canonical), "france 2")

    def test_the_short_african_prefix_comes_off(self):
        """One provider labels its African feeds 'AFR|', the other 'AF|'."""
        self.assertEqual(match_key(parse_name("AF| 2S TV SENEGAL").canonical),
                         "2s tv senegal")
        self.assertEqual(match_key(parse_name("AFR: Maboke TV HD").canonical),
                         "maboke tv")

    def test_arabic_script_survives_normalisation(self):
        """An ASCII-only keep-set erases Arabic entirely, not just accents.

        Measured on the live AR| catalogue: 26 unrelated drama series named
        "AR: <arabic title> 1", "AR: <other arabic title> 1"... all reduced to
        the single key "1" once the Arabic letters were stripped, merging them
        into one fake "channel". The keep-set must be Unicode-letter-aware, not
        just wide enough for French accents.
        """
        one = parse_name("AR: العتاولة 1")
        other = parse_name("AR: جاك العلم 1")
        self.assertNotEqual(match_key(one.canonical), "1")
        self.assertNotEqual(match_key(one.canonical), match_key(other.canonical))

    def test_pure_arabic_name_is_not_dropped_as_junk(self):
        """No trailing digit, no Latin letters — canonical must not go empty."""
        parsed = parse_name("AR: قناة الجزيرة")
        self.assertNotEqual(parsed.canonical, "")


class TestJunk(unittest.TestCase):
    def test_separator_rows(self):
        self.assertTrue(is_junk("#### GÉNÉRAL HD/4K ####"))
        self.assertTrue(is_junk("=========="))
        self.assertTrue(is_junk("   "))

    def test_service_notices(self):
        self.assertTrue(is_junk("SAV ABONNEMENT"))

    def test_real_channel_is_not_junk(self):
        self.assertFalse(is_junk("FR: TF1 HD"))
        self.assertFalse(is_junk("FR-M6 HD"))


class TestTrailingNumberGuard(unittest.TestCase):
    """A number that closes a name identifies the channel."""

    def test_trailing_number(self):
        self.assertEqual(trailing_number("RMC Sport 5"), "5")
        self.assertEqual(trailing_number("beIN SPORTS MAX 10"), "10")
        self.assertIsNone(trailing_number("Arte"))

    def test_a_padded_number_is_the_same_number(self):
        """One provider writes "CANAL PLAY 08"; that is Canal+ Play 8."""
        self.assertEqual(trailing_number("VIP: CANAL PLAY 08"), "8")
        self.assertEqual(trailing_number("Canal+ Play 8"), "8")

    def test_a_padded_number_no_longer_blocks_the_fuzzy_match(self):
        """The padding used to be read as a different number and rejected outright.

        It only unblocks the guard — the name still has to score. That is why
        "CANAL PLAY 08" remains unmatched: ``canal play 08`` against
        ``canalplus play 8`` scores 82, and no number fix moves that.
        """
        reference = Reference({
            "channels": [
                {"number": 815, "group": "Sport", "name": "Eurosport 4",
                 "tvg_id": "", "aliases": [], "has_guide": False},
            ],
            "blocks": [{"group": "Sport", "start": 700, "end": 899}],
        })
        found = reference.fuzzy("Eurosport 04")
        self.assertIsNotNone(found, "04 et 4 doivent être le même numéro")
        self.assertEqual(found[0].name, "Eurosport 4")

    def test_fuzzy_refuses_a_different_number(self):
        reference = Reference({
            "channels": [
                {"number": 316, "group": "Sport", "name": "RMC Sport 4",
                 "tvg_id": "RMCSport4.fr", "aliases": [], "has_guide": True},
            ],
            "blocks": [{"group": "Sport", "start": 300, "end": 399}],
        })
        self.assertIsNone(reference.fuzzy("RMC Sport 5"))
        self.assertIsNone(reference.fuzzy("RMC Sport 15"))

    def test_fuzzy_accepts_a_genuine_near_miss(self):
        reference = Reference({
            "channels": [
                {"number": 400, "group": "Découverte", "name": "Chasse et Pêche",
                 "tvg_id": "ChasseEtPeche.fr", "aliases": [], "has_guide": True},
            ],
            "blocks": [{"group": "Découverte", "start": 400, "end": 499}],
        })
        found = reference.fuzzy("Chasse Peche")
        self.assertIsNotNone(found)
        self.assertEqual(found[0].name, "Chasse et Pêche")


class TestOrganize(unittest.TestCase):
    def setUp(self):
        self.reference = Reference({
            "version": "test",
            "tail_starts_at": 1000,
            "backup_starts_at": 9000,
            "blocks": [
                {"group": "TNT", "start": 1, "end": 27},
                {"group": "Sport", "start": 300, "end": 399},
            ],
            "channels": [
                {"number": 1, "group": "TNT", "name": "TF1", "tvg_id": "TF1.fr",
                 "aliases": ["tf1 hd", "tf1 4k"], "has_guide": True},
                {"number": 6, "group": "TNT", "name": "M6", "tvg_id": "M6.fr",
                 "aliases": [], "has_guide": True},
                {"number": 300, "group": "Sport", "name": "beIN SPORTS 1",
                 "tvg_id": "beINSPORTS1.fr", "aliases": ["bein sports 1"],
                 "has_guide": True},
            ],
        })

    def test_variants_merge_into_one_channel(self):
        plan = organize([
            stream("FR: TF1 4K", 1, "1"),
            stream("FR: TF1 HD", 1, "2"),
            stream("FR-TF1 SD", 2, "3"),
        ], self.reference)
        channels = [c for c in plan.channels if c.group != BACKUP_GROUP]
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0].number, 1)
        self.assertEqual(channels[0].name, "TF1")
        self.assertEqual(len(channels[0].backups), 2)

    def test_best_quality_is_served(self):
        plan = organize([
            stream("FR-TF1 SD", 2, "3"),
            stream("FR: TF1 4K", 1, "1"),
        ], self.reference)
        channel = [c for c in plan.channels if c.group != BACKUP_GROUP][0]
        self.assertEqual(channel.chosen.stream.stream_id, "1")

    def test_quality_preference_is_honoured(self):
        options = OrganizeOptions(quality_preference=["HD", "4K", "SD"])
        plan = organize([
            stream("FR: TF1 4K", 1, "1"),
            stream("FR: TF1 HD", 1, "2"),
        ], self.reference, options)
        channel = [c for c in plan.channels if c.group != BACKUP_GROUP][0]
        self.assertEqual(channel.chosen.parsed.quality, "HD")

    def test_guide_id_is_inherited_from_any_variant(self):
        """The 4K feed carries no tvg-id; the HD one does. One channel, one guide."""
        plan = organize([
            stream("FR: TF1 4K", 1, "1", epg=""),
            stream("FR: TF1 HD", 1, "2", epg="TF1.fr"),
        ], self.reference)
        channel = [c for c in plan.channels if c.group != BACKUP_GROUP][0]
        self.assertEqual(channel.tvg_id, "TF1.fr")
        self.assertEqual(channel.match_method, "tvg_id")
        self.assertTrue(channel.has_guide)

    def test_two_providers_naming_differently_still_merge(self):
        """'FR: beIN SPORTS 1 4K' and 'FR-Bein Sports 1 HD' are one channel."""
        plan = organize([
            stream("FR: BEIN SPORTS 1 4K", 1, "10"),
            stream("FR-Bein Sports 1 HD", 2, "20"),
        ], self.reference)
        channels = [c for c in plan.channels if c.group != BACKUP_GROUP]
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0].number, 300)

    def test_unknown_channel_goes_to_the_tail(self):
        plan = organize([stream("FR: NOVEGASY TV", 1, "77")], self.reference)
        channel = [c for c in plan.channels if c.group != BACKUP_GROUP][0]
        self.assertEqual(channel.group, TAIL_GROUP)
        self.assertGreaterEqual(channel.number, 1000)
        self.assertEqual(channel.match_method, "none")

    def test_nothing_is_guessed_into_a_group(self):
        """An unmatched channel never lands in a themed group."""
        plan = organize([stream("FR: SUPER FOOT SPORT TV", 1, "78")], self.reference)
        groups = {g.name for g in plan.groups}
        self.assertNotIn("Sport", groups)

    def test_timeshift_is_its_own_channel(self):
        plan = organize([
            stream("FR: TF1 HD", 1, "1"),
            stream("FR: TF1 +1 HD", 1, "2"),
        ], self.reference)
        names = sorted(c.name for c in plan.channels if c.group != BACKUP_GROUP)
        self.assertEqual(names, ["TF1", "TF1 +1"])

    def test_timeshift_never_steals_a_reference_number(self):
        """TF1 +1 must not take slot 2 and push France 2 — and M6 — down one."""
        plan = organize([
            stream("FR: TF1 HD", 1, "1"),
            stream("FR: TF1 +1 HD", 1, "2"),
            stream("FR: M6 HD", 1, "3"),
        ], self.reference)
        by_name = {c.name: c for c in plan.channels}
        self.assertEqual(by_name["TF1"].number, 1)
        self.assertEqual(by_name["M6"].number, 6)
        self.assertEqual(by_name["TF1 +1"].group, TIMESHIFT_GROUP)
        self.assertGreaterEqual(by_name["TF1 +1"].number, 2000)

    def test_timeshift_can_be_merged_away(self):
        options = OrganizeOptions(separate_timeshift=False)
        plan = organize([
            stream("FR: TF1 HD", 1, "1"),
            stream("FR: TF1 +1 HD", 1, "2"),
        ], self.reference, options)
        self.assertEqual(len([c for c in plan.channels if c.group != BACKUP_GROUP]), 1)

    def test_backups_group_is_last_and_numbered_apart(self):
        plan = organize([
            stream("FR: TF1 4K", 1, "1"),
            stream("FR: TF1 HD", 1, "2"),
        ], self.reference)
        self.assertEqual(plan.groups[-1].name, BACKUP_GROUP)
        self.assertGreaterEqual(plan.groups[-1].channels[0].number, 9000)

    def test_backups_can_be_dropped(self):
        plan = organize([
            stream("FR: TF1 4K", 1, "1"),
            stream("FR: TF1 HD", 1, "2"),
        ], self.reference, OrganizeOptions(keep_backups=False))
        self.assertNotIn(BACKUP_GROUP, {g.name for g in plan.groups})

    def test_junk_is_dropped_and_reported(self):
        plan = organize([
            stream("#### GÉNÉRAL HD/4K ####", 1, "9"),
            stream("FR: M6 HD", 1, "1"),
        ], self.reference)
        self.assertEqual(len([c for c in plan.channels if c.group != BACKUP_GROUP]), 1)
        self.assertEqual(len(plan.dropped_junk), 1)

    def test_numbers_are_unique(self):
        plan = organize([
            stream("FR: TF1 HD", 1, "1"),
            stream("FR: TF1 +1 HD", 1, "2"),
            stream("FR: M6 HD", 1, "3"),
            stream("FR: UNKNOWN ONE", 1, "4"),
            stream("FR: UNKNOWN TWO", 1, "5"),
        ], self.reference)
        numbers = [c.number for c in plan.channels]
        self.assertEqual(len(numbers), len(set(numbers)))

    def test_groups_follow_the_reference_order(self):
        plan = organize([
            stream("FR: BEIN SPORTS 1 HD", 1, "10"),
            stream("FR: TF1 HD", 1, "1"),
        ], self.reference)
        self.assertEqual([g.name for g in plan.groups][:2], ["TNT", "Sport"])

    def test_fuzzy_match_is_reported_not_applied_silently(self):
        plan = organize([stream("FR: BEIN SPORT 1", 1, "10")], self.reference)
        channel = [c for c in plan.channels if c.group != BACKUP_GROUP][0]
        if channel.match_method == "fuzzy":
            self.assertIn(channel, plan.to_confirm)
            self.assertTrue(channel.needs_confirmation)

    def test_stats_add_up(self):
        plan = organize([
            stream("FR: TF1 4K", 1, "1", epg="TF1.fr"),
            stream("FR: TF1 HD", 1, "2"),
            stream("FR: M6 HD", 1, "3", epg="M6.fr"),
            stream("#### SEP ####", 1, "4"),
        ], self.reference)
        stats = plan.stats()
        self.assertEqual(stats["channels"], 2)
        self.assertEqual(stats["backups"], 1)
        self.assertEqual(stats["junk_dropped"], 1)
        self.assertEqual(stats["matched_by_tvg_id"], 2)


class TestFamilies(unittest.TestCase):
    """The rules that place what the reference will never name one by one.

    They exist because a catalogue holds 507 numbered pay-per-view slots and 794
    African channels, and a bouquet of 1 600 unsorted channels is not an
    organisation. What they must never do is *claim* to have recognised anything.
    """

    def setUp(self):
        self.reference = Reference({
            "version": "test",
            "tail_starts_at": 8000,
            "backup_starts_at": 20000,
            "blocks": [
                {"group": "TNT", "start": 1, "end": 27},
                {"group": "Sport", "start": 300, "end": 399},
                {"group": "Événements & PPV", "start": 3000, "end": 4999},
            ],
            "families": [
                # Narrow first: the delayed feeds hide inside an ordinary category
                # and only the name gives them away.
                {"id": "only_events", "group": "Événements & PPV", "start": 3900,
                 "when": {"category_regex": "SPORT", "name_regex": r"ONLY\s*EVENTS"}},
                {"id": "soccer_ppv", "group": "Événements & PPV", "start": 3400,
                 "when": {"category_regex": r"SOCCER\s*PPV"},
                 "label": "Soccer PPV", "number_from": "trailing"},
                {"id": "sport", "group": "Sport", "start": 350,
                 "when": {"category_regex": "SPORT"}},
            ],
            "channels": [
                {"number": 1, "group": "TNT", "name": "TF1", "tvg_id": "TF1.fr",
                 "aliases": ["tf1 hd"], "has_guide": True},
            ],
        })

    def test_a_family_places_what_the_reference_does_not_know(self):
        plan = organize([stream("FR: W SPORT ᴴᴰ", 1, "10",
                                category="FR| FRANCE SPORT ⱽᴵᴾ")], self.reference)
        channel = plan.channels[0]
        self.assertEqual(channel.group, "Sport")
        self.assertEqual(channel.family, "sport")
        self.assertGreaterEqual(channel.number, 350)

    def test_a_family_channel_is_still_reported_unmatched(self):
        """Placing is not identifying — the reference genuinely does not know it."""
        plan = organize([stream("FR: W SPORT ᴴᴰ", 1, "10",
                                category="FR| FRANCE SPORT ⱽᴵᴾ")], self.reference)
        self.assertEqual(plan.channels[0].match_method, "none")
        self.assertEqual(plan.stats()["unmatched"], 1)
        self.assertEqual(plan.stats()["placed_by_family"], 1)
        self.assertEqual(plan.stats()["in_tail"], 0)

    def test_a_label_and_a_slot_number_survive_the_event(self):
        """The visible half of a PPV name is a fixture; the slot number is not."""
        plan = organize([
            stream("NO EVENT STREAMING NOW - | 8K EXCLUSIVE | FR: SOCCER PPV 61",
                   1, "61", category="FR| SOCCER PPV"),
            stream("Next | Palerme vs. Lecce | 2026-08-17 | FR: SOCCER PPV 9",
                   1, "9", category="FR| SOCCER PPV"),
        ], self.reference)
        by_number = {c.number: c.name for c in plan.channels}
        self.assertEqual(by_number[3461], "Soccer PPV 61")
        self.assertEqual(by_number[3409], "Soccer PPV 9")

    def test_the_first_matching_family_wins(self):
        """'( ONLY EVENTS )' inside FR-SPORTS must not be swept into Sport."""
        plan = organize([
            stream("FR-DAZN LIGUE 1 MATCH 5 ( ONLY EVENTS )", 1, "5",
                   category="FR-SPORTS"),
            stream("FR: W SPORT ᴴᴰ", 1, "6", category="FR-SPORTS"),
        ], self.reference)
        by_family = {c.family: c.group for c in plan.channels}
        self.assertEqual(by_family["only_events"], "Événements & PPV")
        self.assertEqual(by_family["sport"], "Sport")

    def test_a_category_no_family_claims_still_goes_to_the_tail(self):
        plan = organize([stream("FR: NOVEGASY", 1, "99",
                                category="FR| GÉNÉRAL HD/4K")], self.reference)
        self.assertEqual(plan.channels[0].group, TAIL_GROUP)
        self.assertEqual(plan.channels[0].family, "")
        self.assertEqual(plan.stats()["in_tail"], 1)

    def test_accents_do_not_have_to_be_spelled_the_same_way(self):
        """The pattern is written as a human would; both sides are flattened."""
        reference = Reference({
            "blocks": [{"group": "Cinéma", "start": 400, "end": 499}],
            "families": [{"id": "cine", "group": "Cinéma", "start": 460,
                          "when": {"category_regex": "CINÉMA"}}],
            "channels": [],
        })
        plan = organize([stream("FR: LOVE NATURE", 1, "1",
                                category="FR| CINEMA HD/4K")], reference)
        self.assertEqual(plan.channels[0].group, "Cinéma")


class TestProfiles(unittest.TestCase):
    """Both reference files must hold together, and say the same thing."""

    def test_every_profile_is_readable(self):
        for name in PROFILES:
            reference = load_profile(name)
            self.assertTrue(reference.channels, name)
            self.assertTrue(reference.blocks, name)

    def test_an_unknown_profile_is_refused(self):
        with self.assertRaises(KeyError):
            load_profile("bouquet-magique")

    def test_the_compact_profile_holds_the_same_channels(self):
        """It is a rearrangement, not a second catalogue to keep in sync."""
        detailed = load_profile("detailed")
        compact = load_profile("compact")
        self.assertEqual(len(detailed.channels), len(compact.channels))
        self.assertEqual({c.name for c in detailed.channels},
                         {c.name for c in compact.channels})
        self.assertEqual({c.tvg_id for c in detailed.channels},
                         {c.tvg_id for c in compact.channels})

    def test_the_compact_profile_declares_fewer_groups(self):
        detailed = load_profile("detailed")
        compact = load_profile("compact")
        self.assertLess(len(compact.blocks), len(detailed.blocks))
        self.assertLessEqual(len(compact.blocks), 8)
        self.assertTrue(compact.families, "les familles sont la raison d'être du profil")

    def test_the_compact_numbers_are_unique_and_inside_their_block(self):
        compact = load_profile("compact")
        numbers = [c.number for c in compact.channels]
        self.assertEqual(len(numbers), len(set(numbers)))
        bounds = {b["group"]: (b["start"], b["end"]) for b in compact.blocks}
        for channel in compact.channels:
            start, end = bounds[channel.group]
            self.assertTrue(start <= channel.number <= end,
                            f"{channel.name} ({channel.number}) hors de {channel.group}")

    def test_the_official_tnt_order_survives_the_merge(self):
        """Merging TNT into the généralistes must not renumber the ARCOM block."""
        by_number = {c.number: c.name for c in load_profile("compact").channels}
        self.assertEqual(by_number[1], "TF1")
        self.assertEqual(by_number[6], "M6")
        self.assertEqual(by_number[7], "Arte")
        self.assertEqual(by_number[21], "L'Équipe")

    def test_no_family_number_lands_outside_its_bouquet(self):
        compact = load_profile("compact")
        bounds = {b["group"]: (b["start"], b["end"]) for b in compact.blocks}
        for family in compact.families:
            start, end = bounds[family.group]
            self.assertTrue(start <= family.start <= end,
                            f"famille {family.id} démarre hors de {family.group}")

    def test_the_delayed_feeds_do_not_cost_a_bouquet(self):
        """The compact profile files them under Secours, and Secours survives it."""
        compact = load_profile("compact")
        self.assertEqual(compact.timeshift_group, BACKUP_GROUP)
        plan = organize([
            stream("FR: TF1 4K", 1, "1"),
            stream("FR: TF1 HD", 1, "2"),
            stream("FR-TFX+1", 1, "3"),
        ], compact)
        secours = [g for g in plan.groups if g.name == BACKUP_GROUP][0]
        names = {c.name for c in secours.channels}
        self.assertIn("TFX +1", names)
        self.assertTrue(any(n.startswith("TF1 (") for n in names),
                        "la variante écartée doit rester dans Secours")
        self.assertNotIn(TIMESHIFT_GROUP, {g.name for g in plan.groups})
        # A real channel, even filed under Secours, still counts as one.
        self.assertEqual(plan.stats()["channels"], 2)


class TestShippedReference(unittest.TestCase):
    """The reference that ships with the app must stay coherent."""

    def setUp(self):
        self.reference = load_reference()

    def test_numbers_are_unique_and_inside_their_block(self):
        numbers = [c.number for c in self.reference.channels]
        self.assertEqual(len(numbers), len(set(numbers)))
        bounds = {b["group"]: (b["start"], b["end"]) for b in self.reference.blocks}
        for channel in self.reference.channels:
            start, end = bounds[channel.group]
            self.assertTrue(start <= channel.number <= end,
                            f"{channel.name} ({channel.number}) hors de {channel.group}")

    def test_tnt_numbering_is_the_official_one(self):
        by_number = {c.number: c.name for c in self.reference.channels}
        self.assertEqual(by_number[1], "TF1")
        self.assertEqual(by_number[2], "France 2")
        self.assertEqual(by_number[6], "M6")
        self.assertEqual(by_number[7], "Arte")
        self.assertEqual(by_number[21], "L'Équipe")

    def test_channels_without_a_guide_are_flagged(self):
        without = [c for c in self.reference.channels if not c.has_guide]
        self.assertTrue(without, "des chaînes sans guide doivent exister (C8, NRJ12…)")
        for channel in without:
            self.assertEqual(channel.tvg_id, "")

    def test_no_alias_shadows_another_entry(self):
        """An alias must not resolve to a channel the reference lists separately.

        When it does, the first entry inserted captures the name and the other becomes
        unreachable — and the symptom is a channel served under someone else's name, not
        an error. One alias on entry 205 collapsed seven channels of the OCS bundle onto
        one, and 35 provider feeds with it.
        """
        for profile in PROFILES:
            reference = load_profile(profile)
            names = {match_key(c.name): c.name for c in reference.channels}
            for channel in reference.channels:
                for alias in channel.aliases:
                    other = names.get(match_key(alias))
                    self.assertFalse(
                        other and other != channel.name,
                        f"[{profile}] « {alias} » sur {channel.name} "
                        f"désigne {other}")

    def test_the_ocs_siblings_are_separate_channels(self):
        """The provider gives them five distinct guide ids, so they are five channels."""
        names = {c.name for c in load_reference().channels}
        for expected in ["OCS", "OCS Max", "OCS Choc", "OCS City", "OCS Géants",
                         "OCS Pulp", "Ciné+ Premier"]:
            self.assertIn(expected, names)

    def test_a_guideless_entry_keeps_the_provider_id(self):
        """Matching must never cost a channel the guide id it arrived with.

        C8, NRJ 12 and the OCS siblings have no id in the reference. Taking the
        reference's empty one would leave them with no programme at all, when the
        tail would have kept theirs.
        """
        reference = Reference({
            "blocks": [{"group": "Cinéma", "start": 200, "end": 299}],
            "channels": [
                {"number": 207, "group": "Cinéma", "name": "OCS Max", "tvg_id": "",
                 "aliases": ["ocs max"], "has_guide": False},
            ],
        })
        plan = organize([stream("FR_OCS_MAX", 2, "1", epg="OCSMax.fr")], reference)
        channel = plan.channels[0]
        self.assertEqual(channel.reference_name, "OCS Max")
        self.assertEqual(channel.tvg_id, "OCSMax.fr")
        self.assertTrue(channel.has_guide)

    def test_the_reference_id_still_wins_when_it_has_one(self):
        reference = Reference({
            "blocks": [{"group": "TNT", "start": 1, "end": 27}],
            "channels": [
                {"number": 1, "group": "TNT", "name": "TF1", "tvg_id": "TF1.fr",
                 "aliases": ["tf1 hd"], "has_guide": True},
            ],
        })
        plan = organize([stream("FR: TF1 HD", 1, "1", epg="TF1.provider")], reference)
        self.assertEqual(plan.channels[0].tvg_id, "TF1.fr")

    def test_real_provider_names_resolve(self):
        """A sample of names actually served, that must land on the right number."""
        cases = [
            ("FR: TF1 HD", "TF1.fr", 1),
            ("FR_FRANCE2+1", "France2.fr", 2),
            ("FR: BEIN SPORTS 1 4K", "", 300),
            ("FR-Canal+Sport HD", "", None),
        ]
        for name, epg, expected in cases:
            plan = organize([stream(name, 1, "1", epg=epg)], self.reference)
            channel = [c for c in plan.channels if c.group != BACKUP_GROUP][0]
            self.assertNotEqual(channel.match_method, "none",
                                f"{name} n'est pas reconnue par la référence")
            if expected is not None:
                self.assertEqual(channel.number, expected, f"{name} → {channel.number}")


if __name__ == "__main__":
    unittest.main()
