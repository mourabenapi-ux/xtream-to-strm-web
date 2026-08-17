"""Replay, from what the provider declares to what the player is told.

Catch-up is the one thing a generated playlist cannot rebuild on its own: the
archive lives behind a URL only the provider defines. Until now the chain
dropped it at the very first step — the parser ignored the tags and the
catalogue adapter hardcoded ``tv_archive: 0`` — so a channel that offered a week
of replay reached TiviMate as a plain live stream.

These tests pin the three places that information now has to survive: reading it,
deciding what it means, and writing it back out.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.api.api_v1.endpoints.live import _catchup_attributes, _catchup_of
from app.models.subscription import SourceKind
from app.services.m3u_parser import M3UParser


def _extinf(attributes):
    return f'#EXTINF:-1 tvg-id="TF1.fr" {attributes},TF1 HD'


class TestParseCatchupTags(unittest.TestCase):
    """Three spellings are in circulation for one idea; all three are read."""

    def setUp(self):
        self.parser = M3UParser()

    def test_modern_tags(self):
        entry = self.parser._parse_extinf(_extinf('catchup="xc" catchup-days="7"'))
        self.assertEqual(entry["catchup"], "xc")
        self.assertEqual(entry["catchup_days"], 7)

    def test_explicit_source_template_is_kept_verbatim(self):
        template = "http://p.tv/timeshift/u/p/${duration}/${start}/8.ts"
        entry = self.parser._parse_extinf(
            _extinf(f'catchup="default" catchup-source="{template}"'))
        self.assertEqual(entry["catchup_source"], template)

    def test_legacy_tags_imply_the_default_type(self):
        """`tvg-rec` and `timeshift` are older names for the same offer.

        A day count with no type is still an offer of replay; reading it as
        "nothing declared" is what silently lost the feature.
        """
        for attributes in ('tvg-rec="3"', 'timeshift="3"'):
            entry = self.parser._parse_extinf(_extinf(attributes))
            self.assertEqual(entry["catchup_days"], 3, attributes)
            self.assertEqual(entry["catchup"], "default", attributes)

    def test_zero_days_is_a_provider_saying_no(self):
        entry = self.parser._parse_extinf(_extinf('tvg-rec="0"'))
        self.assertIsNone(entry["catchup_days"])
        self.assertIsNone(entry["catchup"])

    def test_a_silent_line_declares_nothing(self):
        entry = self.parser._parse_extinf(_extinf('tvg-logo="tf1.png"'))
        self.assertIsNone(entry["catchup"])
        self.assertIsNone(entry["catchup_days"])
        self.assertIsNone(entry["catchup_source"])

    def test_catchup_days_is_not_mistaken_for_the_type(self):
        """`catchup-days="7"` must not be read as `catchup="7"`."""
        entry = self.parser._parse_extinf(_extinf('catchup-days="7"'))
        self.assertEqual(entry["catchup"], "default")
        self.assertEqual(entry["catchup_days"], 7)


def _sub(kind):
    sub = MagicMock()
    sub.kind = kind
    return sub


class TestCatchupDecision(unittest.TestCase):
    """What a stream's declaration means for the playlist we generate."""

    def test_xtream_archive_becomes_the_xc_type(self):
        """An Xtream panel only says "there is an archive".

        `xc` is precisely "reach it through this panel's timeshift endpoint",
        which the player derives from the stream URL we already publish. No URL
        is invented here.
        """
        catchup = _catchup_of(
            {"tv_archive": 1, "tv_archive_duration": 7},
            _sub(SourceKind.XTREAM.value))
        self.assertEqual(catchup["catchup"], "xc")
        self.assertEqual(catchup["catchup_days"], 7)

    def test_m3u_type_is_passed_through_untouched(self):
        catchup = _catchup_of(
            {"tv_archive": 1, "tv_archive_duration": 5, "catchup": "flussonic",
             "catchup_source": "http://p.tv/tf1/{utc}.ts"},
            _sub(SourceKind.M3U.value))
        self.assertEqual(catchup["catchup"], "flussonic")
        self.assertEqual(catchup["catchup_source"], "http://p.tv/tf1/{utc}.ts")

    def test_a_stream_offering_nothing_gets_nothing(self):
        self.assertEqual(
            _catchup_of({"tv_archive": 0, "tv_archive_duration": 0},
                        _sub(SourceKind.XTREAM.value)),
            {})

    def test_provider_string_values_are_understood(self):
        """Providers send "1" and "7" as strings as often as as numbers."""
        catchup = _catchup_of({"tv_archive": "1", "tv_archive_duration": "7"},
                              _sub(SourceKind.XTREAM.value))
        self.assertEqual(catchup["catchup_days"], 7)

    def test_a_null_archive_flag_is_not_an_archive(self):
        """Xtream returns JSON null for a channel with no archive."""
        self.assertEqual(
            _catchup_of({"tv_archive": None, "tv_archive_duration": None},
                        _sub(SourceKind.XTREAM.value)),
            {})


class TestCatchupAttributes(unittest.TestCase):
    """The EXTINF fragment handed to the player."""

    def test_nothing_is_emitted_for_a_channel_without_replay(self):
        self.assertEqual(_catchup_attributes({"name": "TF1"}), "")

    def test_type_and_days(self):
        self.assertEqual(
            _catchup_attributes({"catchup": "xc", "catchup_days": 7}),
            'catchup="xc" catchup-days="7" ')

    def test_source_template_is_included(self):
        rendered = _catchup_attributes(
            {"catchup": "default", "catchup_days": 3,
             "catchup_source": "http://p.tv/a?start=${start}"})
        self.assertIn('catchup-source="http://p.tv/a?start=${start}"', rendered)

    def test_a_quote_cannot_close_the_attribute_early(self):
        """A stray quote in a template would corrupt every tag after it."""
        rendered = _catchup_attributes(
            {"catchup": "default", "catchup_source": 'http://p.tv/a"b'})
        self.assertNotIn('a"b', rendered)
        self.assertIn("%22", rendered)


if __name__ == "__main__":
    unittest.main()
