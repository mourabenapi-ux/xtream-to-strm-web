import redis
from app.core.config import settings

# Global redis connection pool
redis_conn = redis.from_url(settings.REDIS_URL, decode_responses=True)

def get_redis():
    return redis_conn
