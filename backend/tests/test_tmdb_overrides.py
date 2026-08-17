"""Which TMDB id a title ends up with.

A wrong id is worse than no id: Jellyfin shows the wrong poster and the wrong
synopsis with complete confidence. The correction the user makes therefore has
to beat every source the provider has — the catalogue listing *and* the
per-item metadata fetch, which is the one that runs last and used to have the
final word.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.models.tmdb_override import TmdbOverride
from app.services.tmdb_overrides import (load_overrides, name_key,
                                         normalise_id)
from app.tasks.sync import _apply_tmdb_overrides, _tmdb_override_moved


def _override(item_id, tmdb_id, label=None):
    return TmdbOverride(item_id=str(item_id), tmdb_id=tmdb_id, label=label,
                        name_key=name_key(label))


def _map(*overrides):
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = list(overrides)
    return load_overrides(db, subscription_id=1, media_type="movie")


class TestNormalisation(unittest.TestCase):

    def test_the_many_ways_a_provider_says_no_id(self):
        for value in (None, "", "0", "None", "null", "-1", "  "):
            self.assertIsNone(normalise_id(value), value)

    def test_an_id_survives_as_text(self):
        self.assertEqual(normalise_id(550), "550")
        self.assertEqual(normalise_id(" 550 "), "550")

    def test_titles_compare_on_their_letters_and_digits(self):
        self.assertEqual(name_key("FR - Le Parrain (1972)"),
                         name_key("fr le parrain 1972"))
        self.assertNotEqual(name_key("Le Parrain"), name_key("Le Parrain 2"))


class TestResolution(unittest.TestCase):

    def test_the_provider_wins_when_nothing_was_corrected(self):
        value, overridden = _map().resolve("12", "Fight Club", "999")
        self.assertEqual(value, "999")
        self.assertFalse(overridden)

    def test_a_correction_beats_the_provider(self):
        value, overridden = _map(_override(12, "550", "Fight Club")).resolve(
            "12", "Fight Club", "999")
        self.assertEqual(value, "550")
        self.assertTrue(overridden)

    def test_an_empty_correction_means_no_id_at_all(self):
        """A deliberate "this film is not on TMDB", not a missing answer.

        Without this the provider's wrong id would simply come back, because
        "no override value" and "no override" would look the same.
        """
        value, overridden = _map(_override(12, None, "Fight Club")).resolve(
            "12", "Fight Club", "999")
        self.assertIsNone(value)
        self.assertTrue(overridden)

    def test_the_title_finds_a_correction_when_the_id_has_moved(self):
        """An M3U catalogue is re-parsed into fresh rows, so ids do not persist.

        Keying only on the id would silently drop every correction made against
        an M3U source the next time its playlist was read.
        """
        value, overridden = _map(_override(12, "550", "Fight Club")).resolve(
            "88", "FIGHT CLUB", "999")
        self.assertEqual(value, "550")
        self.assertTrue(overridden)

    def test_an_ambiguous_title_is_not_guessed(self):
        """Two corrections under one title cannot be told apart by title.

        Picking either would tag one of the two films wrong, which is the exact
        failure this whole feature exists to fix.
        """
        overrides = _map(_override(12, "550", "Remords"),
                         _override(13, "551", "Remords"))
        value, overridden = overrides.resolve("88", "Remords", "999")
        self.assertEqual(value, "999")
        self.assertFalse(overridden)
        # Each still resolves on its own id.
        self.assertEqual(overrides.resolve("13", "Remords", "999")[0], "551")


class TestApplyToListing(unittest.TestCase):
    """The listing is corrected before anything reasons about folder names."""

    def test_both_id_keys_are_written(self):
        """The NFO and path writers read `tmdb`, falling back to `tmdb_id`.

        Clearing only one of them leaves the other to reinstate the wrong id.
        """
        movies = [{"stream_id": 12, "name": "Fight Club", "tmdb": "999",
                   "tmdb_id": "999"}]
        applied = _apply_tmdb_overrides(
            _map(_override(12, None, "Fight Club")), movies, "stream_id")

        self.assertEqual(applied, 1)
        self.assertIsNone(movies[0]["tmdb"])
        self.assertIsNone(movies[0]["tmdb_id"])
        self.assertTrue(movies[0]["_tmdb_override"])

    def test_untouched_entries_carry_no_mark(self):
        movies = [{"stream_id": 99, "name": "Heat", "tmdb": "949"}]
        self.assertEqual(
            _apply_tmdb_overrides(_map(_override(12, "550", "Fight Club")),
                                  movies, "stream_id"),
            0)
        self.assertEqual(movies[0]["tmdb"], "949")
        self.assertNotIn("_tmdb_override", movies[0])

    def test_no_overrides_is_a_no_op(self):
        movies = [{"stream_id": 12, "name": "Fight Club", "tmdb": "999"}]
        self.assertEqual(_apply_tmdb_overrides(_map(), movies, "stream_id"), 0)
        self.assertEqual(movies[0]["tmdb"], "999")


class TestRebuildDetection(unittest.TestCase):
    """A correction has to make the sync rewrite the item.

    Nothing else would notice: the provider's name and container have not moved,
    so the item reads as up to date while its folder still carries the old id.
    """

    def test_a_changed_correction_forces_a_rebuild(self):
        movie = {"tmdb": "550", "_tmdb_override": True}
        self.assertTrue(_tmdb_override_moved(movie, MagicMock(tmdb_id="999")))

    def test_an_already_applied_correction_does_not(self):
        movie = {"tmdb": "550", "_tmdb_override": True}
        self.assertFalse(_tmdb_override_moved(movie, MagicMock(tmdb_id="550")))

    def test_clearing_an_id_is_a_change_too(self):
        movie = {"tmdb": None, "_tmdb_override": True}
        self.assertTrue(_tmdb_override_moved(movie, MagicMock(tmdb_id="999")))
        self.assertFalse(_tmdb_override_moved(movie, MagicMock(tmdb_id=None)))

    def test_an_uncorrected_item_is_never_rebuilt_for_this(self):
        """The provider's listing id and the stored one differ all the time.

        The per-item fetch is what decides for those; treating that gap as a
        change would rewrite the entire library on every run.
        """
        movie = {"tmdb": "111"}
        self.assertFalse(_tmdb_override_moved(movie, MagicMock(tmdb_id="999")))


if __name__ == "__main__":
    unittest.main()
