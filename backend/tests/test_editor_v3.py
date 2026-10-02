"""Tests for editor v3: versions, short names, bulk rename, short URLs,
reference-missing, the M3U refactor and the guide's now/next."""
import asyncio
import json
import os
import sys
import unittest
from unittest import mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.db.base  # noqa: F401
from app.db.base_class import Base
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel, LivePlaylistVersion
from app.api.api_v1.endpoints import live, live_tools, short_urls
from app import schemas


def run(coro):
    return asyncio.run(coro)


class Base_(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.p = LivePlaylist(name="P", use_channel_numbers=True, public_id="abcd1234")
        self.db.add(self.p)
        self.db.flush()
        self.g = LivePlaylistBouquet(playlist_id=self.p.id, custom_name="TNT", order=0, number_start=1, number_end=99)
        self.db.add(self.g)
        self.db.flush()
        self.rows = [LivePlaylistChannel(bouquet_id=self.g.id, subscription_id=1, stream_id=str(i),
                                         custom_name=f"FR| Chaine {i} HD", order=i) for i in (1, 2, 3)]
        self.db.add_all(self.rows)
        self.db.commit()


class VersionTests(Base_):
    def test_save_and_restore_puts_everything_back(self):
        live_tools.create_version(self.p.id, live_tools.VersionIn(name="Avant"), self.db)
        self.rows[0].order = 50
        self.db.delete(self.rows[2])
        self.g.number_end = 10
        self.db.commit()
        version = self.db.query(LivePlaylistVersion).filter_by(automatic=False).one()
        live_tools.restore_version(self.p.id, version.id, self.db)
        self.db.expire_all()
        group = self.db.query(LivePlaylistBouquet).filter_by(playlist_id=self.p.id).one()
        self.assertEqual(group.number_end, 99)
        self.assertEqual(sorted(c.order for c in group.channels), [1, 2, 3])
        # The state before the restore was kept, so the restore can be undone.
        self.assertTrue(self.db.query(LivePlaylistVersion).filter_by(automatic=True).count() >= 1)

    def test_automatic_versions_are_pruned_named_ones_kept(self):
        live_tools.create_version(self.p.id, live_tools.VersionIn(name="Mine"), self.db)
        for i in range(live_tools.AUTOMATIC_VERSIONS_KEPT + 5):
            live_tools.save_version(self.db, self.p, f"auto {i}", automatic=True)
        self.db.commit()
        self.assertEqual(self.db.query(LivePlaylistVersion).filter_by(automatic=True).count(),
                         live_tools.AUTOMATIC_VERSIONS_KEPT)
        self.assertEqual(self.db.query(LivePlaylistVersion).filter_by(automatic=False).count(), 1)

    def test_fix_numbering_saves_a_version_first(self):
        live_tools.fix_numbering(self.p.id, live_tools.NumberingFixIn(), self.db)
        self.assertEqual(self.db.query(LivePlaylistVersion).filter_by(automatic=True).count(), 1)


class ShortNameTests(Base_):
    def test_short_name_is_cleaned_and_unique(self):
        other = LivePlaylist(name="Other", public_id="ffff0000")
        self.db.add(other)
        self.db.commit()
        live.update_playlist(self.p.id, schemas.LivePlaylistUpdate(short_name="  FR "), self.db)
        self.assertEqual(self.p.short_name, "fr")
        with self.assertRaises(HTTPException) as clash:
            live.update_playlist(other.id, schemas.LivePlaylistUpdate(short_name="fr"), self.db)
        self.assertEqual(clash.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            live.update_playlist(other.id, schemas.LivePlaylistUpdate(short_name="a b/c"), self.db)
        live.update_playlist(self.p.id, schemas.LivePlaylistUpdate(short_name=""), self.db)
        self.assertIsNone(self.p.short_name)

    def test_short_url_finds_by_alias_or_public_id(self):
        self.p.short_name = "fr"
        self.db.commit()
        self.assertEqual(short_urls._find(self.db, "FR").id, self.p.id)
        self.assertEqual(short_urls._find(self.db, "abcd1234").id, self.p.id)
        with self.assertRaises(HTTPException):
            short_urls._find(self.db, "nope")

    def test_short_routes_are_registered(self):
        paths = [r.path for r in short_urls.router.routes]
        self.assertIn("/p/{key}.m3u", paths)
        self.assertIn("/p/{key}.xml", paths)


class RenameTests(Base_):
    def test_bulk_rename_in_one_go(self):
        result = live_tools.rename_bulk(self.p.id, live_tools.BulkRenameIn(renames=[
            live_tools.RenameItem(id=self.rows[0].id, custom_name="Chaine 1"),
            live_tools.RenameItem(id=self.rows[1].id, custom_name="  "),
        ]), self.db)
        self.assertEqual(result["renamed"], 2)
        self.db.expire_all()
        self.assertEqual(self.db.get(LivePlaylistChannel, self.rows[0].id).custom_name, "Chaine 1")
        self.assertIsNone(self.db.get(LivePlaylistChannel, self.rows[1].id).custom_name)


class M3UTests(Base_):
    def test_m3u_text_numbers_and_guide_url(self):
        channels = [{"name": "TF1", "number": 1, "epg_id": "TF1.fr", "logo": "", "group_title": "TNT",
                     "url": "http://x/1.ts"}]
        text = live.m3u_text(self.p, channels, "http://h/p/fr.xml")
        self.assertIn('x-tvg-url="http://h/p/fr.xml"', text)
        self.assertIn('tvg-chno="1"', text)


class ReferenceMissingTests(Base_):
    def test_france_2_is_found_at_the_provider(self):
        self.rows[0].custom_name = "TF1"
        self.db.commit()

        async def fake_resolve(db, playlist, dropped=None):
            return [{"channel_id": c.id, "name": c.custom_name, "epg_id": "", "bouquet": "Généralistes & TNT"}
                    for b in playlist.bouquets for c in b.channels]

        async def fake_catalogues(db, subs):
            return {1: [{"stream_id": 899, "name": "BE: FRANCE 2 FHD", "category_id": "8"},
                        {"stream_id": 900, "name": "FR| FRANCE 2 FHD", "category_id": "7"},
                        {"stream_id": 901, "name": "FR| FRANCE 2 SD", "category_id": "7"},
                        {"stream_id": 902, "name": "TF1 HD", "category_id": "7"}]}

        live_tools._INDEX_CACHE.clear()
        with mock.patch.object(live_tools, "resolve_playlist_channels", fake_resolve), \
                mock.patch.object(live_tools, "_catalogues", fake_catalogues):
            result = run(live_tools.reference_missing(self.p.id, "compact", self.db))
        names = {m["name"]: m for m in result["missing"]}
        self.assertIn("France 2", names)
        self.assertNotIn("TF1", names)
        self.assertEqual(names["France 2"]["number"], 2)
        self.assertEqual(names["France 2"]["candidates"][0]["stream_id"], "900")  # FR feed, FHD first


class BallTests(unittest.TestCase):
    def test_football_letter_is_an_o(self):
        from app.services.organizer import parse_name
        self.assertEqual(parse_name("AR: beIN SP⚽RTS 1 HD").canonical.lower(), "bein sports 1")
        self.assertNotIn("⚽", parse_name("AR| BEIN SPORTS ⚽").canonical)


class GuideNowTests(unittest.TestCase):
    def test_now_and_next_are_read(self):
        import time
        from app.services.epg import epg_service
        now = time.time()
        on_air = json.dumps({"title": "JT", "start": now - 60, "stop": now + 600})
        following = json.dumps({"title": "Météo", "start": now + 600, "stop": now + 900})
        pipe = mock.MagicMock()
        pipe.execute.return_value = [True, 2, [on_air], [following]]
        with mock.patch.object(epg_service, "redis", mock.MagicMock(pipeline=mock.MagicMock(return_value=pipe))):
            states = epg_service.guide_states([1], ["TF1.fr"])
        self.assertEqual(states["TF1.fr"]["state"], "live")
        self.assertEqual(states["TF1.fr"]["now"], "JT")
        self.assertEqual(states["TF1.fr"]["next"], "Météo")


if __name__ == "__main__":
    unittest.main()
