"""Tests for what a player actually receives from a playlist.

``resolve_playlist_channels`` is the single source of truth behind the M3U, the
XMLTV guide and the validation report, and until now nothing covered it. The two
cases below are the ones the organiser broke on its first run: a group whose
channels each carry their own subscription served nothing at all, and the channel
numbering was invisible because no playlist could publish it.
"""
import asyncio
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.api.api_v1.endpoints.live import resolve_playlist_channels


def _subscription(sub_id, name):
    sub = MagicMock()
    sub.id = sub_id
    sub.name = name
    sub.xtream_url = f"http://provider{sub_id}.test"
    sub.username = "u"
    sub.password = "p"
    return sub


def _channel(stream_id, sub_id, name, order, epg_id=None):
    channel = MagicMock()
    channel.stream_id = str(stream_id)
    channel.subscription_id = sub_id
    channel.custom_name = name
    channel.order = order
    channel.is_excluded = False
    channel.epg_channel_id = epg_id
    return channel


def _bouquet(name, channels, order=0, category_id=None, subscription_id=None):
    bouquet = MagicMock()
    bouquet.custom_name = name
    bouquet.channels = channels
    bouquet.order = order
    bouquet.category_id = category_id
    bouquet.subscription_id = subscription_id
    return bouquet


class _FakeClient:
    """Two providers, each with its own small catalogue.

    Their stream ids overlap on purpose: provider ids are small integers, so a
    resolver that forgets which subscription a channel came from returns the
    other provider's stream without failing.
    """

    CATALOGUE = {
        1: [{"stream_id": 2, "name": "TF1 HD", "category_id": "10",
             "stream_icon": "tf1.png", "epg_channel_id": "TF1.fr"}],
        2: [{"stream_id": 2, "name": "M6 HD", "category_id": "20",
             "stream_icon": "m6.png", "epg_channel_id": "M6.fr"}],
    }

    def __init__(self, url, username, password):
        self.base_url = url
        self.sub_id = 1 if "provider1" in url else 2

    async def get_live_streams(self, category_id=None):
        return self.CATALOGUE[self.sub_id]

    def get_stream_url(self, stream_type, stream_id, extension):
        return f"{self.base_url}/{stream_type}/u/p/{stream_id}.{extension}"


def _fake_catalog(db, subscription, force_reparse=False):
    """Stand-in for `get_catalog`, which is what the resolver now asks.

    The resolver no longer builds an Xtream URL itself — it asks whichever
    adapter listed the stream for it, so that an M3U channel can answer with
    the URL its playlist gave.
    """
    return _FakeClient(subscription.xtream_url, subscription.username,
                       subscription.password)


class TestVirtualGroupResolution(unittest.TestCase):

    def test_virtual_group_without_any_subscription_still_serves(self):
        """The organiser's groups carry no subscription; the channels do.

        Requiring one on the bouquet made every such playlist serve an empty
        M3U — success, zero channels, no error anywhere.
        """
        playlist = MagicMock()
        playlist.subscription_id = None
        playlist.bouquets = [
            _bouquet("TNT", [_channel(2, 1, "TF1", 1), _channel(2, 2, "M6", 6)])
        ]
        db = MagicMock()
        subs = {1: _subscription(1, "Strong"), 2: _subscription(2, "Aziza")}
        db.query.return_value.filter.return_value.first.side_effect = [
            subs[1], subs[2]
        ]
        with patch("app.api.api_v1.endpoints.live.get_catalog", _fake_catalog):
            resolved = asyncio.run(resolve_playlist_channels(db, playlist))

        self.assertEqual(len(resolved), 2)
        self.assertEqual({c["name"] for c in resolved}, {"TF1", "M6"})

    def test_each_channel_keeps_its_own_provider(self):
        """Both channels are stream id 2 — one per provider. Neither may swap."""
        playlist = MagicMock()
        playlist.subscription_id = None
        playlist.bouquets = [
            _bouquet("TNT", [_channel(2, 1, "TF1", 1), _channel(2, 2, "M6", 6)])
        ]
        db = MagicMock()
        db.query.return_value.filter.return_value.first.side_effect = [
            _subscription(1, "Strong"), _subscription(2, "Aziza")
        ]
        with patch("app.api.api_v1.endpoints.live.get_catalog", _fake_catalog):
            resolved = asyncio.run(resolve_playlist_channels(db, playlist))

        by_name = {c["name"]: c for c in resolved}
        self.assertIn("provider1.test", by_name["TF1"]["url"])
        self.assertIn("provider2.test", by_name["M6"]["url"])
        self.assertEqual(by_name["TF1"]["epg_id"], "TF1.fr")
        self.assertEqual(by_name["M6"]["epg_id"], "M6.fr")

    def test_channel_number_is_exposed(self):
        """The M3U can only publish tvg-chno if the resolver reports the order."""
        playlist = MagicMock()
        playlist.subscription_id = 1
        playlist.bouquets = [_bouquet("TNT", [_channel(2, 1, "TF1", 1)])]
        db = MagicMock()
        db.query.return_value.filter.return_value.first.side_effect = [
            _subscription(1, "Strong")
        ]
        with patch("app.api.api_v1.endpoints.live.get_catalog", _fake_catalog):
            resolved = asyncio.run(resolve_playlist_channels(db, playlist))

        self.assertEqual(resolved[0]["number"], 1)

    def test_unreachable_subscription_is_reported_not_hidden(self):
        playlist = MagicMock()
        playlist.subscription_id = None
        playlist.bouquets = [_bouquet("TNT", [_channel(2, 99, "Ghost", 1)])]
        db = MagicMock()
        db.query.return_value.filter.return_value.first.side_effect = [None]
        dropped = []
        with patch("app.api.api_v1.endpoints.live.get_catalog", _fake_catalog):
            resolved = asyncio.run(
                resolve_playlist_channels(db, playlist, dropped=dropped)
            )

        self.assertEqual(resolved, [])
        self.assertEqual(len(dropped), 1)
        self.assertEqual(dropped[0]["reason"], "subscription_unavailable")


if __name__ == "__main__":
    unittest.main()
