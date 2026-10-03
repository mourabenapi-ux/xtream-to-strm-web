"""Tests for the dashboard v2: the problems it raises and the alerts it sends.

The snapshot below mirrors what was measured on the live install on
2026-10-03: "MBA" whose 19 channels came from a deleted subscription, an
Arabic playlist with 343 channels and no programme at all, a disk at 97.7 %
that the app itself barely uses, a provider not synced for nine days with
every schedule off, two guide sources downloading the same file, and 79
cached titles left by the deleted subscription.
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.db.base  # noqa: F401
from app.api.api_v1.endpoints.home import prime_time
from app.db.base_class import Base
from app.models.dashboard import AppCondition, AppEvent, Severity
from app.services import notify, overview
from app.services.events import player_label
from app.tasks import dashboard as monitor

NOW = datetime(2026, 10, 3, 0, 0, tzinfo=timezone.utc)
GB = 1024 ** 3


def iso(delta_hours: float) -> str:
    return (NOW - timedelta(hours=delta_hours)).isoformat()


def playlist(pid, name, rows, served, dead=0, with_schedule=0, reasons=None, issues=None):
    return {"id": pid, "name": name, "rows": rows, "served": served, "dead": dead,
            "with_schedule": with_schedule, "dead_reasons": reasons or {}, "issues": issues or [],
            "error": None}


def measured_snapshot():
    return {
        "system": {"disk": {"total": 1357.2 * GB, "used": 1326.4 * GB, "free": 30.8 * GB,
                            "percent": 97.7, "app_bytes": 20 * 1024 ** 2},
                   "redis": {"online": True}, "workers": 1},
        "guides": [
            {"id": 1, "name": "XMLTV France", "active": True, "playlists": 3, "cached_channels": 785,
             "last_updated": iso(1), "refresh_hours": 6, "duplicate_of": None},
            {"id": 2, "name": "Remote URL (xmltvfr)", "active": True, "playlists": 2, "cached_channels": 785,
             "last_updated": iso(1), "refresh_hours": 24,
             "duplicate_of": {"id": 1, "name": "XMLTV France"}},
            {"id": 3, "name": "Strong - provider guide", "active": True, "playlists": 4,
             "cached_channels": 4417, "last_updated": iso(1), "refresh_hours": 24, "duplicate_of": None},
        ],
        "providers": [
            {"id": 1, "name": "Strong", "kind": "xtream", "is_active": True, "vod": True,
             "schedule_enabled": False,
             "syncs": {"movies": {"at": iso(9 * 24 + 14), "status": "success"},
                       "series": {"at": iso(9 * 24 + 16), "status": "success"}},
             "account": None},
            {"id": 4, "name": "iptv-org ARA", "kind": "m3u", "is_active": True, "vod": False,
             "schedule_enabled": False, "syncs": {"movies": None, "series": None}, "account": None},
        ],
        "playlists": [
            playlist(1, "MBA", 19, 0, dead=19, reasons={"subscription_unavailable": 19}),
            playlist(2, "FR-iptv-org", 424, 424, with_schedule=93),
            playlist(3, "AR-iptv-org", 0, 0),
            playlist(6, "AR - iptv-org", 348, 343, dead=5, with_schedule=0,
                     reasons={"stream_gone_from_provider": 5}),
            playlist(7, "iptv-org FRA - organised", 421, 421, with_schedule=93,
                     issues=[{"type": "invalid_number", "severity": "error", "fix": "fix_numbering",
                              "title": "1 channel(s) numbered 0", "count": 1},
                             {"type": "overlap", "severity": "warning", "fix": "fix_numbering",
                              "title": "“Info” and “Cinéma” overlap", "count": 2}]),
        ],
        "library": {"orphan_movies": 71, "orphan_series": 8, "downloads": {"failed_recent": []},
                    "strm": {"movies": 1080, "shows": 62}},
        "jellyfin": {"configured": False},
    }


def by_key(conditions):
    return {c["key"]: c for c in conditions}


class ConditionTests(unittest.TestCase):
    def test_measured_install(self):
        found = by_key(overview.compute_conditions(measured_snapshot(), NOW))

        self.assertEqual(found["playlist:1:dead"]["severity"], Severity.DANGER)
        self.assertIn("serves no channel", found["playlist:1:dead"]["title"])
        self.assertIn("source was deleted", found["playlist:1:dead"]["detail"])
        # Nothing to repair automatically when the provider itself is gone.
        self.assertIsNone(found["playlist:1:dead"]["action"])

        self.assertEqual(found["playlist:6:guide"]["severity"], Severity.WARNING)
        self.assertEqual(found["playlist:6:dead"]["action"]["kind"], "repair_dead")
        self.assertNotIn("playlist:2:guide", found)  # 93 channels do have a programme

        self.assertEqual(found["system:disk"]["severity"], Severity.WARNING)
        self.assertIn("This app's files take 20 MB", found["system:disk"]["detail"])

        stale = found["provider:1:stale"]
        self.assertIn("not synced for 9 days", stale["title"])
        self.assertEqual(stale["detail"], "No schedule is enabled.")
        self.assertEqual(stale["action"], {"kind": "sync", "label": "Sync now", "subscription_id": 1,
                                           "type": "all"})
        self.assertNotIn("provider:4:stale", found)  # a live-only source has no VOD to sync

        self.assertEqual(found["playlist:7:numbering"]["action"]["kind"], "fix_numbering")
        self.assertIn("numbered 0", found["playlist:7:numbering"]["detail"])
        self.assertNotIn("overlap", found["playlist:7:numbering"]["detail"])

        self.assertEqual(found["guide:2:duplicate"]["severity"], Severity.INFO)
        self.assertEqual(found["playlist:3:empty"]["severity"], Severity.INFO)
        self.assertIn("71 movies and 8 series", found["library:orphans"]["detail"])

    def test_most_serious_first(self):
        conditions = overview.compute_conditions(measured_snapshot(), NOW)
        orders = [Severity.ORDER[c["severity"]] for c in conditions]
        self.assertEqual(orders, sorted(orders, reverse=True))

    def test_an_unloaded_guide_hides_the_per_playlist_guide_alarms(self):
        # Right after a restart the guide cache is empty for half a minute:
        # one problem (the guide), not one per playlist.
        snapshot = measured_snapshot()
        snapshot["guides"][2]["cached_channels"] = 0
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertEqual(found["guide:3:empty"]["severity"], Severity.DANGER)
        self.assertEqual(found["guide:3:empty"]["action"], {"kind": "refresh_guide", "label": "Refresh",
                                                           "source_id": 3})
        self.assertNotIn("playlist:6:guide", found)
        self.assertNotIn("guide:3:stale", found)

    def test_a_guide_being_downloaded_is_not_an_alarm(self):
        snapshot = measured_snapshot()
        snapshot["guides"][2].update(cached_channels=0, refreshing=True)
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertEqual(found["guide:3:empty"]["severity"], Severity.INFO)
        self.assertIn("is loading", found["guide:3:empty"]["title"])
        self.assertIsNone(found["guide:3:empty"]["action"])
        self.assertNotIn("playlist:6:guide", found)

    def test_out_of_date_guide(self):
        snapshot = measured_snapshot()
        snapshot["guides"][0]["last_updated"] = iso(30)  # every 6 h, last one 30 h ago
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertEqual(found["guide:1:stale"]["detail"], "Last refreshed 30 hours ago.")

    def test_disk_thresholds(self):
        snapshot = measured_snapshot()
        snapshot["system"]["disk"].update(percent=98.4, free=4 * GB)
        self.assertEqual(by_key(overview.compute_conditions(snapshot, NOW))["system:disk"]["severity"],
                         Severity.DANGER)
        snapshot["system"]["disk"].update(percent=80.0, free=300 * GB)
        self.assertNotIn("system:disk", by_key(overview.compute_conditions(snapshot, NOW)))

    def test_provider_account(self):
        snapshot = measured_snapshot()
        account = {"status": "Active", "auth": 1, "days_left": 2.4,
                   "expires_at": (NOW + timedelta(days=2.4)).isoformat()}
        snapshot["providers"][0]["account"] = account
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertEqual(found["provider:1:expiry"]["severity"], Severity.DANGER)
        self.assertEqual(found["provider:1:expiry"]["title"], "Strong expires in 2 days")

        account.update(days_left=10.0, expires_at=(NOW + timedelta(days=10)).isoformat())
        self.assertEqual(by_key(overview.compute_conditions(snapshot, NOW))["provider:1:expiry"]["severity"],
                         Severity.WARNING)

        account.update(status="Expired", days_left=None)
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertEqual(found["provider:1:account"]["severity"], Severity.DANGER)
        self.assertNotIn("provider:1:expiry", found)

        snapshot["providers"][0]["account"] = {"error": "timed out"}
        self.assertEqual(by_key(overview.compute_conditions(snapshot, NOW))["provider:1:unreachable"]["detail"],
                         "timed out")

    def test_failed_sync_offers_a_retry_of_that_type(self):
        snapshot = measured_snapshot()
        snapshot["providers"][0]["syncs"]["series"] = {"at": iso(2), "status": "failed", "error": "HTTP 551"}
        found = by_key(overview.compute_conditions(snapshot, NOW))
        failed = found["provider:1:series:failed"]
        self.assertEqual(failed["severity"], Severity.DANGER)
        self.assertEqual(failed["action"]["type"], "series")
        self.assertNotIn("provider:1:stale", found)  # the newest run is two hours old

    def test_wall_failures_are_reported_only_when_recent(self):
        snapshot = measured_snapshot()
        snapshot["wall"] = {"playlist_id": 4, "playlist_name": "FR free-tv",
                            "meta": {"finished_at": iso(0.5)},
                            "channels": {"10": {"ok": True, "name": "TF1"},
                                         "11": {"ok": False, "name": "France 3"}}}
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertIn("1 channel of “FR free-tv” shows no picture", found["wall:4:failed"]["title"])
        snapshot["wall"]["meta"]["finished_at"] = iso(5)
        self.assertNotIn("wall:4:failed", by_key(overview.compute_conditions(snapshot, NOW)))

    def test_jellyfin_behind_the_files(self):
        snapshot = measured_snapshot()
        snapshot["jellyfin"] = {"configured": True, "ok": True, "libraries": [
            {"name": "Films IPTV", "role": "strm_movies", "count": 1000},
            {"name": "Séries IPTV", "role": "strm_series", "count": 62},
        ]}
        found = by_key(overview.compute_conditions(snapshot, NOW))
        self.assertEqual(found["jellyfin:Films IPTV:behind"]["action"]["kind"], "jellyfin_scan")
        self.assertNotIn("jellyfin:Séries IPTV:behind", found)
        snapshot["jellyfin"] = {"configured": True, "ok": False, "error": "Jellyfin refused the API key."}
        self.assertIn("jellyfin:unreachable", by_key(overview.compute_conditions(snapshot, NOW)))


class AlertTests(unittest.TestCase):
    """A problem is journalled when it appears, pushed once it survives a
    second pass, and pushed again as resolved only if it had been pushed."""

    def setUp(self):
        engine = create_engine("sqlite://")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.values = {"NOTIFY_NTFY_URL": "https://ntfy.sh/test", "NOTIFY_MIN_SEVERITY": "warning"}
        self.problem = {"key": "playlist:1:dead", "severity": Severity.DANGER, "title": "“MBA” serves no channel",
                        "detail": "All 19 channels are gone.", "action": None, "link": "/live-selection?playlist_id=1"}
        self.minor = {"key": "guide:2:duplicate", "severity": Severity.INFO, "title": "Duplicate guide",
                      "detail": None, "action": None, "link": "/epg-admin"}

    def tearDown(self):
        self.db.close()

    def run_pass(self, conditions, values=None):
        with mock.patch.object(monitor.notify, "send", return_value=[]) as send:
            stats = monitor.apply_conditions(self.db, conditions, self.values if values is None else values)
        return stats, [c.args[1] for c in send.call_args_list]

    def test_lifecycle(self):
        stats, pushed = self.run_pass([self.problem, self.minor])
        self.assertEqual(stats["new"], 2)
        self.assertEqual(pushed, [])  # first sighting: journal only
        self.assertEqual(self.db.query(AppEvent).filter(AppEvent.kind == "condition").count(), 2)

        _, pushed = self.run_pass([self.problem, self.minor])
        self.assertEqual(pushed, ["“MBA” serves no channel"])  # info never reaches the phone

        _, pushed = self.run_pass([self.problem, self.minor])
        self.assertEqual(pushed, [])  # once only

        stats, pushed = self.run_pass([self.minor])
        self.assertEqual(stats["cleared"], 1)
        self.assertEqual(pushed, ["Resolved: “MBA” serves no channel"])
        self.assertEqual(self.db.query(AppCondition).count(), 1)
        self.assertTrue(self.db.query(AppEvent).filter(AppEvent.kind == "resolved").count())

    def test_a_problem_open_when_notifications_were_switched_on_was_never_sent(self):
        # The settings endpoint marks open problems as handled so they are not
        # replayed. That is not a push, and clearing one must not announce a
        # resolution the phone never heard started.
        self.run_pass([self.problem], values={})
        row = self.db.query(AppCondition).one()
        row.notified = True
        self.db.commit()
        _, pushed = self.run_pass([self.problem])
        self.assertEqual(pushed, [])
        self.assertFalse(self.db.query(AppCondition).one().pushed)
        _, pushed = self.run_pass([])
        self.assertEqual(pushed, [])

    def test_a_pushed_problem_is_marked_as_sent(self):
        self.run_pass([self.problem])
        self.run_pass([self.problem])
        self.assertTrue(self.db.query(AppCondition).one().pushed)

    def test_a_blip_never_reaches_the_phone(self):
        self.run_pass([self.problem])
        _, pushed = self.run_pass([])
        self.assertEqual(pushed, [])

    def test_nothing_is_sent_without_a_channel(self):
        for _ in range(3):
            _, pushed = self.run_pass([self.problem], values={})
            self.assertEqual(pushed, [])

    def test_threshold(self):
        values = {**self.values, "NOTIFY_MIN_SEVERITY": "danger"}
        warning = {**self.problem, "key": "x", "severity": Severity.WARNING}
        self.run_pass([warning], values)
        _, pushed = self.run_pass([warning], values)
        self.assertEqual(pushed, [])
        self.assertTrue(notify.should_push(values, Severity.DANGER))
        self.assertFalse(notify.should_push({}, Severity.INFO))


class HelperTests(unittest.TestCase):
    def test_player_label(self):
        self.assertEqual(player_label("TiviMate/5.1.6 (Android 11; Mbox)"), "TiviMate")
        self.assertEqual(player_label("VLC/3.0.20 LibVLC/3.0.20"), "VLC")
        self.assertEqual(player_label("Mozilla/5.0 (Windows NT 10.0)"), "Browser")
        self.assertEqual(player_label("Lavf/60.3.100"), "FFmpeg")
        self.assertEqual(player_label(""), "Unknown")

    def test_prime_time_skips_the_weather(self):
        at = 1000.0
        items = [{"title": "Météo", "start": at, "stop": at + 600},
                 {"title": "The Voice Kids", "start": at + 600, "stop": at + 4500},
                 {"title": "The Voice Kids, la suite", "start": at + 4500, "stop": at + 8000}]
        self.assertEqual(prime_time(items, at)["title"], "The Voice Kids")
        shorts = [{"title": "Clip", "start": at - 300, "stop": at + 900}]
        self.assertEqual(prime_time(shorts, at)["title"], "Clip")
        self.assertIsNone(prime_time([], at))

    def test_library_role(self):
        dirs = {"strm_movies": ["/output/movies3"], "strm_series": ["/output/series3"],
                "downloads_movies": ["/output/downloads/movies"]}
        self.assertEqual(overview.library_role(["/media/iptv/movies3"], dirs), "strm_movies")
        self.assertEqual(overview.library_role(["D:\\Media\\downloads\\movies"], dirs), "downloads_movies")
        # "movies" alone is far too common to prove anything.
        self.assertIsNone(overview.library_role(["/media/movies"], dirs))

    def test_scan_tree(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "Show A", "Season 01"))
            os.makedirs(os.path.join(root, "Show B"))
            for path in ("Show A/Season 01/e1.strm", "Show A/Season 01/e2.strm", "Show B/e1.strm"):
                with open(os.path.join(root, path), "w") as f:
                    f.write("http://x")
            with open(os.path.join(root, "Show B", "e2.mkv"), "wb") as f:
                f.write(b"0" * 2048)
            result = overview.scan_tree(root)
        self.assertEqual(result["strm"], 3)
        self.assertEqual(result["shows"], 2)
        self.assertEqual(result["videos"], 1)
        self.assertGreaterEqual(result["bytes"], 2048)
        self.assertEqual(overview.scan_tree("/does/not/exist")["strm"], 0)

    def test_featured_playlist_prefers_a_real_guide(self):
        playlists = [{"id": 2, "served": 424, "schedule_percentage": 22},
                     {"id": 4, "served": 44, "schedule_percentage": 68},
                     {"id": 1, "served": 0, "schedule_percentage": 0}]
        self.assertEqual(overview.featured_playlist(playlists, ""), 4)
        self.assertEqual(overview.featured_playlist(playlists, "2"), 2)
        self.assertEqual(overview.featured_playlist(playlists, "99"), 4)


if __name__ == "__main__":
    unittest.main()
