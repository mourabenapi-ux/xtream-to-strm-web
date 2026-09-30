"""Tests for the writes the playlist editor relies on.

The editor applies every change on screen first and tells the server afterwards,
and its undo/redo replays older states. These cases pin the server half of that
contract: restoring a snapshot really reverts the database (including re-creating
deleted rows under their old ids), moving channels keeps their identity, and two
providers that share a stream id are never confused.
"""
import os
import sys
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.db.base  # noqa: F401  (registers every model on the metadata)
from app.db.base_class import Base
from app.models.live import LivePlaylist, LivePlaylistBouquet, LivePlaylistChannel
from app.api.api_v1.endpoints import live
from app import schemas


def _snapshot(playlist):
    """What the editor would send: the playlist as it stands in the database."""
    return schemas.LivePlaylistSnapshot(bouquets=[
        schemas.LiveSnapshotBouquet(
            id=b.id, subscription_id=b.subscription_id, category_id=b.category_id,
            custom_name=b.custom_name, order=b.order,
            channels=[schemas.LiveSnapshotChannel(
                id=c.id, stream_id=c.stream_id, subscription_id=c.subscription_id,
                custom_name=c.custom_name, order=c.order, is_excluded=c.is_excluded,
                epg_channel_id=c.epg_channel_id) for c in b.channels])
        for b in playlist.bouquets])


class LiveEditorTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.playlist = LivePlaylist(name="P")
        self.other = LivePlaylist(name="Other")
        self.db.add_all([self.playlist, self.other])
        self.db.flush()
        self.sport = LivePlaylistBouquet(playlist_id=self.playlist.id, custom_name="Sport", order=0)
        self.info = LivePlaylistBouquet(playlist_id=self.playlist.id, custom_name="Info", order=1)
        self.foreign = LivePlaylistBouquet(playlist_id=self.other.id, custom_name="Foreign", order=0)
        self.db.add_all([self.sport, self.info, self.foreign])
        self.db.flush()
        self.c1 = LivePlaylistChannel(bouquet_id=self.sport.id, stream_id="7", subscription_id=1,
                                      custom_name="A", order=0, epg_channel_id="a.fr")
        self.c2 = LivePlaylistChannel(bouquet_id=self.sport.id, stream_id="7", subscription_id=2,
                                      custom_name="B", order=1)
        self.c3 = LivePlaylistChannel(bouquet_id=self.info.id, stream_id="9", subscription_id=1,
                                      custom_name="C", order=0)
        self.f1 = LivePlaylistChannel(bouquet_id=self.foreign.id, stream_id="1", subscription_id=1,
                                      custom_name="F", order=0)
        self.db.add_all([self.c1, self.c2, self.c3, self.f1])
        self.db.commit()

    def _reload(self):
        self.db.expire_all()
        return self.db.get(LivePlaylist, self.playlist.id)

    # -- provider-aware identity ---------------------------------------------

    def test_same_stream_id_from_two_providers_is_two_channels(self):
        payload = [schemas.LivePlaylistChannelBase(stream_id="7", subscription_id=2,
                                                   custom_name="B renamed", order=5)]
        live.update_bouquet_channels(self.playlist.id, self.sport.id, payload, self.db)
        names = {(c.subscription_id, c.custom_name) for c in
                 self.db.query(LivePlaylistChannel).filter_by(bouquet_id=self.sport.id)}
        self.assertEqual(names, {(1, "A"), (2, "B renamed")})

    def test_adding_a_channel_twice_returns_the_same_row(self):
        body = schemas.LivePlaylistChannelBase(stream_id="9", subscription_id=1, custom_name="C")
        again = live.add_channel_to_bouquet(self.info.id, body, self.db)
        self.assertEqual(again.id, self.c3.id)
        self.assertEqual(self.db.query(LivePlaylistChannel).filter_by(bouquet_id=self.info.id).count(), 1)

    # -- moving --------------------------------------------------------------

    def test_move_keeps_identity_provider_and_guide_mapping(self):
        live.move_channels_to_bouquet(
            self.playlist.id,
            schemas.LiveChannelsMove(channel_ids=[self.c1.id, self.c2.id], target_bouquet_id=self.info.id),
            self.db)
        moved = {c.id: c for c in self._reload().bouquets[1].channels}
        self.assertEqual(set(moved), {self.c1.id, self.c2.id, self.c3.id})
        self.assertEqual(moved[self.c1.id].subscription_id, 1)
        self.assertEqual(moved[self.c1.id].epg_channel_id, "a.fr")
        self.assertEqual(moved[self.c1.id].custom_name, "A")
        self.assertEqual(sorted(c.order for c in moved.values()), [0, 1, 2])

    def test_move_on_a_numbered_playlist_keeps_the_channel_number(self):
        self.playlist.use_channel_numbers = True
        self.c1.order = 350
        self.db.commit()
        live.move_channels_to_bouquet(
            self.playlist.id,
            schemas.LiveChannelsMove(channel_ids=[self.c1.id], target_bouquet_id=self.info.id),
            self.db)
        self.assertEqual(self.db.get(LivePlaylistChannel, self.c1.id).order, 350)

    def test_move_cannot_reach_into_another_playlist(self):
        result = live.move_channels_to_bouquet(
            self.playlist.id,
            schemas.LiveChannelsMove(channel_ids=[self.f1.id], target_bouquet_id=self.info.id),
            self.db)
        self.assertEqual(result["moved"], 0)
        self.assertEqual(self.db.get(LivePlaylistChannel, self.f1.id).bouquet_id, self.foreign.id)

    def test_move_into_a_group_that_already_has_it_does_not_duplicate(self):
        twin = LivePlaylistChannel(bouquet_id=self.info.id, stream_id="7", subscription_id=1, order=1)
        self.db.add(twin)
        self.db.commit()
        live.move_channels_to_bouquet(
            self.playlist.id,
            schemas.LiveChannelsMove(channel_ids=[self.c1.id], target_bouquet_id=self.info.id),
            self.db)
        self.assertEqual(self.db.query(LivePlaylistChannel).filter_by(
            bouquet_id=self.info.id, stream_id="7", subscription_id=1).count(), 1)

    # -- reorder -------------------------------------------------------------

    def test_reorder_is_by_row_id(self):
        live.reorder_bouquet_channels(
            self.playlist.id, self.sport.id,
            [schemas.LiveChannelOrder(id=self.c1.id, order=1),
             schemas.LiveChannelOrder(id=self.c2.id, order=0)], self.db)
        order = {c.id: c.order for c in self._reload().bouquets[0].channels}
        self.assertEqual(order, {self.c1.id: 1, self.c2.id: 0})

    # -- snapshot (undo / redo) ---------------------------------------------

    def test_restore_brings_back_deleted_rows_under_their_old_ids(self):
        before = _snapshot(self._reload())
        ids_before = {c.id for b in self._reload().bouquets for c in b.channels}

        live.remove_playlist_bouquet(self.playlist.id, self.info.id, self.db)
        live.remove_playlist_channel(self.playlist.id, self.c1.id, self.db)
        self.assertEqual(len(self._reload().bouquets), 1)

        live.restore_playlist_snapshot(self.playlist.id, before, self.db)
        playlist = self._reload()
        self.assertEqual([b.custom_name for b in sorted(playlist.bouquets, key=lambda b: b.order)],
                         ["Sport", "Info"])
        self.assertEqual({c.id for b in playlist.bouquets for c in b.channels}, ids_before)
        restored = self.db.get(LivePlaylistChannel, self.c1.id)
        self.assertEqual((restored.custom_name, restored.epg_channel_id, restored.subscription_id),
                         ("A", "a.fr", 1))

    def test_restore_undoes_an_addition_and_a_move(self):
        before = _snapshot(self._reload())
        live.add_channel_to_bouquet(
            self.info.id,
            schemas.LivePlaylistChannelBase(stream_id="55", subscription_id=2, order=1), self.db)
        live.move_channels_to_bouquet(
            self.playlist.id,
            schemas.LiveChannelsMove(channel_ids=[self.c1.id], target_bouquet_id=self.info.id), self.db)

        live.restore_playlist_snapshot(self.playlist.id, before, self.db)
        playlist = self._reload()
        self.assertEqual(sorted(c.stream_id for c in playlist.bouquets[0].channels), ["7", "7"])
        self.assertEqual([c.stream_id for c in playlist.bouquets[1].channels], ["9"])

    def test_restore_undoes_a_rename(self):
        before = _snapshot(self._reload())
        live.rename_playlist_channel(self.playlist.id, self.c1.id,
                                     schemas.LivePlaylistChannelUpdate(custom_name="Changed"), self.db)
        live.restore_playlist_snapshot(self.playlist.id, before, self.db)
        self.assertEqual(self.db.get(LivePlaylistChannel, self.c1.id).custom_name, "A")

    def test_restore_refuses_rows_that_belong_to_another_playlist(self):
        snapshot = _snapshot(self._reload())
        snapshot.bouquets[0].channels[0].id = self.f1.id
        with self.assertRaises(HTTPException) as caught:
            live.restore_playlist_snapshot(self.playlist.id, snapshot, self.db)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.db.get(LivePlaylistChannel, self.f1.id).bouquet_id, self.foreign.id)

    def test_restore_never_touches_other_playlists(self):
        live.restore_playlist_snapshot(self.playlist.id, schemas.LivePlaylistSnapshot(bouquets=[]), self.db)
        self.assertEqual(self._reload().bouquets, [])
        self.assertIsNotNone(self.db.get(LivePlaylistChannel, self.f1.id))


if __name__ == "__main__":
    unittest.main()
