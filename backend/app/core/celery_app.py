from celery import Celery
from app.core.config import settings

celery_app = Celery("worker", broker=settings.REDIS_URL, backend=settings.REDIS_URL)

celery_app.conf.update(
    task_track_started=True,
    # Prefork workers never return peak memory to the OS. EPG parsing and catalogue
    # fetching both spike hard, so workers are recycled to keep RSS flat.
    worker_max_tasks_per_child=20,
    worker_max_memory_per_child=400_000,  # KB, ~400 MB
)

# Configure Celery Beat schedule
celery_app.conf.beat_schedule = {
    'check-schedules-every-minute': {
        'task': 'app.tasks.sync.check_schedules_task',
        'schedule': 60.0,
    },
    'check-auto-downloads-every-hour': {
        'task': 'app.tasks.downloads.check_auto_downloads',
        'schedule': 3600.0,  # Run every hour
    },
    'process-download-queue-every-5-mins': {
        'task': 'app.tasks.downloads.process_download_queue',
        'schedule': 300.0,  # Run every 5 minutes
    },
    'check-epg-refresh-every-hour': {
        'task': 'app.tasks.epg.check_epg_refresh_schedule',
        'schedule': 3600.0,  # Check every hour
    },
}
celery_app.conf.timezone = settings.TIMEZONE

# Import tasks to register them
from app.tasks import sync  # noqa
from app.tasks import m3u_sync  # noqa
from app.tasks import downloads  # noqa
from app.tasks import epg  # noqa
