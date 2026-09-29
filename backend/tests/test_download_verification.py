"""A download is marked completed only when it is proven good.

Each test runs the real `download_media_task` against a local fake provider that
misbehaves in one specific way, with real video files built by FFmpeg, and checks
the final status and the file left on disk. Needs FFmpeg, so it runs in the image.
"""
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import app.db.base  # noqa: E402,F401  (maps every model)
from app.db.base_class import Base  # noqa: E402
from app.models.downloads import DownloadTask, DownloadStatus, DownloadSettingsGlobal  # noqa: E402
from app.models.subscription import Subscription  # noqa: E402
from app.tasks import downloads  # noqa: E402

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
_real_sleep = time.sleep


def _encode(path: Path, bitrate: str) -> bytes:
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", bitrate, "-g", "50",
        "-c:a", "aac", str(path),
    ], check=True)
    return path.read_bytes()


def _zero_middle(data: bytes, size: int = 32 * 1024) -> bytes:
    mid = len(data) // 2
    return data[:mid] + bytes(size) + data[mid + size:]


class FakeProvider(http.server.BaseHTTPRequestHandler):
    """Serves `server.body` with Range support.

    `server.plan` lists what goes wrong on each successive *download* request
    (a GET without a range end); verification reads (bytes=a-b) are answered
    honestly, as a real provider would. Faults:
      cut        - sends half the body, then drops the connection
      other      - answers with another copy of the film of the same length
      misaligned - answers a resume from 4 KB earlier than asked (honest header)
      damaged    - 32 KB in the middle arrive as zeros
    `server.mode` changes the server itself: "no_range" ignores Range,
    "no_length" also omits Content-Length.
    """
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, headers, payload):
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def do_GET(self):
        srv = self.server
        rng = self.headers.get("Range")
        is_download = not rng or rng.endswith("-")
        fault = srv.plan.pop(0) if is_download and srv.plan else None
        if fault == "busy":
            # This provider's temporary block after sustained traffic.
            self._send(460, {"Content-Length": "0"}, b"")
            return
        if fault in ("page", "page_as_video"):
            # What this provider really did once after a drop: 200 OK, 9,699 bytes.
            page = b"<html>" + b"x" * 9687 + b"</html>"
            kind = "text/html" if fault == "page" else "video/mp4"
            self._send(200, {"Content-Type": kind, "Content-Length": str(len(page))}, page)
            return
        body = {"other": srv.other, "damaged": _zero_middle(srv.body)}.get(fault, srv.body)

        if srv.mode or not rng:
            headers = {} if srv.mode == "no_length" else {"Content-Length": str(len(body))}
            payload = body[: len(body) // 2] if fault == "cut" else body
            self._send(200, headers, payload)
            return

        start, _, end = rng.split("=", 1)[1].partition("-")
        start = int(start)
        end = int(end) if end else len(body) - 1
        if start >= len(body):
            self._send(416, {"Content-Range": f"bytes */{len(body)}", "Content-Length": "0"}, b"")
            return
        if fault == "misaligned":
            start -= 4096
        chunk = body[start: end + 1]
        payload = chunk[: len(chunk) // 2] if fault == "cut" else chunk
        self._send(206, {"Content-Range": f"bytes {start}-{start + len(chunk) - 1}/{len(body)}",
                         "Content-Length": str(len(chunk))}, payload)


@unittest.skipUnless(HAVE_FFMPEG, "needs FFmpeg (run inside the app image)")
class DownloadVerificationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.good = _encode(cls.tmp / "good.mkv", "1M")
        other = _encode(cls.tmp / "other.mkv", "700k")
        # Another node's copy, padded to the same length: the sneakiest resume.
        cls.other = (other + bytes(len(cls.good)))[: len(cls.good)]

        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/movie/u/p/1.mkv"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.server.body = self.good
        self.server.other = self.other
        self.server.plan = []
        self.server.mode = None
        self.out = Path(tempfile.mkdtemp(dir=self.tmp))
        self.target = self.out / "Film (2020).mkv"

        engine = create_engine(f"sqlite:///{self.out / 'db.sqlite'}")
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine)
        db = self.Session()
        db.add(Subscription(id=1, name="test", xtream_url="http://x", username="u", password="p"))
        db.add(DownloadSettingsGlobal(default_max_retries=3, connection_timeout_seconds=10))
        db.add(DownloadTask(id=1, subscription_id=1, media_type="movie", media_id=1,
                            title="Film", url=self.url, status=DownloadStatus.PENDING))
        db.commit()
        db.close()

        self.requeued = []
        patches = [
            mock.patch.object(downloads, "SessionLocal", self.Session),
            mock.patch.object(downloads, "_resolve_target_path",
                              lambda *a, **k: {"path": self.target, "sidecars": []}),
            mock.patch.object(downloads, "_beat", lambda *a: None),
            mock.patch.object(downloads, "_clear_heartbeat", lambda *a: None),
            mock.patch.object(downloads.time, "sleep", lambda s: _real_sleep(min(s, 0.02))),
            mock.patch.object(downloads.download_media_task, "apply_async",
                              lambda args, countdown=0: self.requeued.append(args[0])),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_until_settled(self):
        """Run the task the way the worker would, retries included."""
        downloads.download_media_task.apply(args=[1])
        while self.requeued:
            self.requeued.pop()
            downloads.download_media_task.apply(args=[1])
        db = self.Session()
        task = db.get(DownloadTask, 1)
        db.expunge(task)
        db.close()
        return task

    def assertCompletedAndExact(self, task):
        self.assertEqual(task.status, DownloadStatus.COMPLETED, task.error_message)
        self.assertEqual(self.target.read_bytes(), self.good)

    # --- must end completed, with exactly the provider's bytes ----------------

    def test_clean_download_completes(self):
        self.assertCompletedAndExact(self.run_until_settled())

    def test_connection_cut_then_resumed(self):
        self.server.plan = ["cut"]
        self.assertCompletedAndExact(self.run_until_settled())

    def test_resume_from_another_copy_is_caught_and_redone(self):
        self.server.plan = ["cut", "other"]
        self.assertCompletedAndExact(self.run_until_settled())

    def test_misaligned_resume_is_caught_and_redone(self):
        self.server.plan = ["cut", "misaligned"]
        self.assertCompletedAndExact(self.run_until_settled())

    def test_bytes_damaged_in_transit_are_redownloaded(self):
        self.server.plan = ["damaged"]
        self.assertCompletedAndExact(self.run_until_settled())

    def test_many_drops_resume_in_place_without_using_retries(self):
        self.server.plan = ["cut"] * 6
        task = self.run_until_settled()
        self.assertCompletedAndExact(task)
        self.assertEqual(task.retry_count or 0, 0)

    def test_provider_unreachable_after_a_drop_reconnects_without_using_retries(self):
        self.server.plan = ["cut"]
        real_stream = downloads.httpx.Client.stream
        calls = {"n": 0}

        def flaky(client, method, url, **kw):
            calls["n"] += 1
            if calls["n"] in (2, 3):  # the two reconnections right after the drop
                raise downloads.httpx.ConnectError("[Errno -5] No address associated with hostname")
            return real_stream(client, method, url, **kw)

        with mock.patch.object(downloads.httpx.Client, "stream", flaky):
            task = self.run_until_settled()
        self.assertCompletedAndExact(task)
        self.assertEqual(task.retry_count or 0, 0)

    def test_provider_block_is_waited_out_without_using_retries(self):
        self.server.plan = ["cut"] + ["busy"] * 5
        with mock.patch.object(downloads, "BUSY_DELAY", 0.05):
            task = self.run_until_settled()
        self.assertCompletedAndExact(task)
        self.assertEqual(task.retry_count or 0, 0)

    def test_error_page_on_resume_never_overwrites_the_film(self):
        self.server.plan = ["cut", "page"]
        self.assertCompletedAndExact(self.run_until_settled())

    def test_error_page_labelled_as_video_is_refused(self):
        self.server.plan = ["cut", "page_as_video"]
        self.assertCompletedAndExact(self.run_until_settled())

    def test_error_page_on_first_request_is_never_completed(self):
        self.server.plan = ["page_as_video"] * 2
        task = self.run_until_settled()
        # The page is refused by the verification (the provider's real file is
        # larger), then the real film arrives on the last attempt.
        self.assertCompletedAndExact(task)

    def test_error_page_on_every_attempt_ends_failed(self):
        self.server.plan = ["page_as_video"] * 3
        self.assertEqual(self.run_until_settled().status, DownloadStatus.FAILED)

    def test_no_range_support_still_completes(self):
        self.server.mode = "no_range"
        self.server.plan = ["cut"]
        self.assertCompletedAndExact(self.run_until_settled())

    # --- must never end completed --------------------------------------------

    def test_damaged_source_is_reported_and_kept(self):
        self.server.body = _zero_middle(self.good)
        task = self.run_until_settled()
        self.assertEqual(task.status, DownloadStatus.FAILED)
        self.assertIn("provider's file is itself damaged", task.error_message)
        self.assertEqual(self.target.read_bytes(), self.server.body, "the copy is kept")

    def test_unknown_size_is_never_completed(self):
        self.server.mode = "no_length"
        task = self.run_until_settled()
        self.assertEqual(task.status, DownloadStatus.FAILED)
        self.assertTrue(self.target.exists(), "the file is kept")

    def test_every_attempt_corrupted_ends_failed(self):
        self.server.plan = ["damaged"] * 3 + ["other"] * 3
        # A different corruption each time, so it never looks like a damaged source.
        orig = _zero_middle
        sizes = iter([16 * 1024, 48 * 1024, 80 * 1024])
        with mock.patch(__name__ + "._zero_middle", lambda d, size=None: orig(d, next(sizes, 8192))):
            task = self.run_until_settled()
        self.assertEqual(task.status, DownloadStatus.FAILED)


if __name__ == "__main__":
    unittest.main()
