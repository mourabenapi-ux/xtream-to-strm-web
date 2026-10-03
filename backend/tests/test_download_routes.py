"""Route order of the download API.

`/tasks/batch/pause` was swallowed by `/tasks/{task_id}/pause` ("batch" is not an
integer, so every batch pause / resume / retry answered 422 and the buttons of
the Download Manager failed). The single-task routes now use `{task_id:int}`.
"""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import deps
from app.api.endpoints import downloads


class _Query:
    def filter(self, *a, **k):
        return self

    def update(self, *a, **k):
        return 0

    def delete(self, *a, **k):
        return 0

    def first(self):
        return None


class _DB:
    def query(self, *a):
        return _Query()

    def commit(self):
        pass


class DownloadRouteOrderTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(downloads.router, prefix="/d")
        app.dependency_overrides[deps.get_db] = lambda: _DB()
        self._delay = downloads.process_download_queue.delay
        downloads.process_download_queue.delay = lambda *a, **k: None
        self.client = TestClient(app)

    def tearDown(self):
        downloads.process_download_queue.delay = self._delay

    def test_batch_actions_are_reachable(self):
        for action in ("pause", "resume", "retry", "delete"):
            with self.subTest(action=action):
                r = self.client.post(f"/d/tasks/batch/{action}", json=[1, 2])
                self.assertEqual(r.status_code, 200, r.text)

    def test_single_task_routes_still_match_integer_ids(self):
        for action in ("pause", "resume", "retry"):
            with self.subTest(action=action):
                r = self.client.post(f"/d/tasks/5/{action}")
                self.assertEqual(r.status_code, 404, r.text)  # unknown task, not 422


if __name__ == "__main__":
    unittest.main()
