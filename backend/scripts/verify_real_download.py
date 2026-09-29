"""Run the real download task against the real provider, end to end, without
touching the app's database or library.

Usage (inside the app image, source mounted on /src, output dir mounted on /out):
    python scripts/verify_real_download.py <stream_id> <ext>

A throwaway SQLite database gets a copy of subscription 1 and one download
task; the file lands in /out. Prints the final status, the error if any, and
the file's size against the provider's.
"""
import logging
import sqlite3
import sys
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, "/src")
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import app.db.base  # noqa: E402,F401
from app.db.base_class import Base  # noqa: E402
from app.models.downloads import DownloadTask, DownloadStatus, DownloadSettingsGlobal  # noqa: E402
from app.models.subscription import Subscription  # noqa: E402
from app.tasks import downloads  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
logging.getLogger("httpx").setLevel(logging.WARNING)
sid, ext = sys.argv[1], sys.argv[2]
out = Path("/out")
target = out / f"real_{sid}.{ext}"

live = sqlite3.connect("/db/xtream.db")
base, user, pw = live.execute("select xtream_url,username,password from subscriptions where id=1").fetchone()
url = f"{base.rstrip('/')}/movie/{user}/{pw}/{sid}.{ext}"

engine = create_engine(f"sqlite:///{out / 'verify.sqlite'}")
Base.metadata.drop_all(engine)
Base.metadata.create_all(engine)
Session = sessionmaker(bind=engine)
db = Session()
db.add(Subscription(id=1, name="verify", xtream_url=base, username=user, password=pw))
db.add(DownloadSettingsGlobal(default_max_retries=3, connection_timeout_seconds=30, download_mode="sequential",
                              global_speed_limit_kbps=3000))
db.add(DownloadTask(id=1, subscription_id=1, media_type="movie", media_id=int(sid),
                    title="verify", url=url, status=DownloadStatus.PENDING))
db.commit()
db.close()

requeued = []
t0 = time.time()
with mock.patch.object(downloads, "SessionLocal", Session), \
        mock.patch.object(downloads, "_resolve_target_path", lambda *a, **k: {"path": target, "sidecars": []}), \
        mock.patch.object(downloads.download_media_task, "apply_async",
                          lambda args, countdown=0: requeued.append(countdown)):
    downloads.download_media_task.apply(args=[1])
    while requeued:
        wait = requeued.pop()
        print(f"retry scheduled in {wait}s", flush=True)
        time.sleep(wait)
        downloads.download_media_task.apply(args=[1])

db = Session()
task = db.get(DownloadTask, 1)
size = target.stat().st_size if target.exists() else 0
print(f"status={task.status} retries={task.retry_count} file={size:,} provider={task.file_size} "
      f"in {time.time() - t0:.0f}s error={(task.error_message or '').replace(user, 'USER').replace(pw, 'PASS')!r}")
