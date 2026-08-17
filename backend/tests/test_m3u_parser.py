"""Reading an M3U line, in the shapes real playlists are written in.

A channel that the parser mishandles is not a degraded channel — it is a channel
nobody can select, because it never reaches the catalogue at all. Both defects
pinned here were silent: no error, no warning, just a shorter list. On
iptv-org's French playlist they cost 29 channels out of 459, TF1 among them.
"""
import os
import sys
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.services.m3u_parser import M3UParser

# The User-Agent iptv-org attaches to several channels. Quoted, and containing
# the comma that used to be read as the start of the channel name.
_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36')


class TestDirectivesBetweenAnEntryAndItsUrl(unittest.TestCase):
    """An EXTINF is routinely followed by player directives before the URL."""

    def setUp(self):
        self.parser = M3UParser()

    def test_an_extvlcopt_line_does_not_swallow_the_channel(self):
        entries = self.parser.parse_content(
            '#EXTM3U\n'
            f'#EXTINF:-1 tvg-id="TF1.fr@SD" group-title="Entertainment",TF1 (576p)\n'
            f'#EXTVLCOPT:http-user-agent={_UA}\n'
            'http://p.tv/tf1.m3u8\n'
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "TF1 (576p)")
        self.assertEqual(entries[0]["url"], "http://p.tv/tf1.m3u8")

    def test_several_directives_in_a_row_are_all_stepped_over(self):
        entries = self.parser.parse_content(
            '#EXTM3U\n'
            '#EXTINF:-1 tvg-id="M6.fr",M6\n'
            '#KODIPROP:inputstream.adaptive.license_type=clearkey\n'
            '#EXTHTTP:{"cookie":"x"}\n'
            '#EXTGRP:Generalistes\n'
            'http://p.tv/m6.m3u8\n'
        )
        self.assertEqual([e["url"] for e in entries], ["http://p.tv/m6.m3u8"])

    def test_an_entry_with_no_url_does_not_consume_the_next_one(self):
        """A truncated line must cost one channel, not two."""
        entries = self.parser.parse_content(
            '#EXTM3U\n'
            '#EXTINF:-1 tvg-id="Broken.fr",Broken\n'
            '#EXTINF:-1 tvg-id="Arte.fr",Arte\n'
            'http://p.tv/arte.m3u8\n'
        )
        self.assertEqual([e["title"] for e in entries], ["Arte"])

    def test_a_trailing_entry_without_a_url_is_dropped_quietly(self):
        entries = self.parser.parse_content(
            '#EXTM3U\n'
            '#EXTINF:-1 tvg-id="Arte.fr",Arte\n'
            'http://p.tv/arte.m3u8\n'
            '#EXTINF:-1 tvg-id="Broken.fr",Broken\n'
        )
        self.assertEqual([e["title"] for e in entries], ["Arte"])


class TestTheChannelName(unittest.TestCase):
    """The name is what follows the first comma *outside* the attributes."""

    def setUp(self):
        self.parser = M3UParser()

    def test_a_comma_inside_an_attribute_is_not_the_start_of_the_name(self):
        entry = self.parser._parse_extinf(
            f'#EXTINF:-1 tvg-id="TF1.fr@SD" http-user-agent="{_UA}" '
            f'group-title="Entertainment",TF1 (576p)'
        )
        self.assertEqual(entry["title"], "TF1 (576p)")
        self.assertEqual(entry["tvg_id"], "TF1.fr@SD")
        self.assertEqual(entry["group_title"], "Entertainment")

    def test_a_comma_inside_the_name_is_kept(self):
        entry = self.parser._parse_extinf(
            '#EXTINF:-1 tvg-id="X.fr",Canal, la chaine'
        )
        self.assertEqual(entry["title"], "Canal, la chaine")

    def test_a_line_without_a_name_yields_no_name_rather_than_a_wrong_one(self):
        entry = self.parser._parse_extinf('#EXTINF:-1 tvg-id="X.fr"')
        self.assertEqual(entry["title"], "")


if __name__ == "__main__":
    unittest.main()
