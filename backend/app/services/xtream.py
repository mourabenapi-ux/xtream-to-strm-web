import logging
import json
import httpx
from typing import Dict, List, Optional, Any
from tenacity import retry, stop_after_attempt, wait_exponential
from app.core.redis import redis_conn

logger = logging.getLogger(__name__)

DEFAULT_USER_AGENT = "TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)"

class XtreamClient:
    def __init__(self, url: str, username: str, password: str):
        self.base_url = url.rstrip("/")
        self.username = username
        self.password = password
        self.api_url = f"{self.base_url}/player_api.php"

    def _get_params(self, action: str, **kwargs) -> Dict[str, str]:
        params = {
            "username": self.username,
            "password": self.password,
            "action": action
        }
        params.update(kwargs)
        return params

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    async def _request(self, action: str, **kwargs) -> Any:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True, headers={"User-Agent": DEFAULT_USER_AGENT, "Icy-MetaData": "1", "Connection": "close"}) as client:
            params = self._get_params(action, **kwargs)
            try:
                response = await client.get(self.api_url, params=params)
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP error for {action}: {e}")
                raise
            except Exception as e:
                logger.error(f"Error fetching {action}: {e}")
                raise

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    def _request_sync(self, action: str, **kwargs) -> Any:
        with httpx.Client(timeout=60.0, follow_redirects=True, headers={"User-Agent": DEFAULT_USER_AGENT, "Icy-MetaData": "1", "Connection": "close"}) as client:
            params = self._get_params(action, **kwargs)
            try:
                response = client.get(self.api_url, params=params)
                response.raise_for_status()
                return response.json()
            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP error for {action}: {e}")
                raise
            except Exception as e:
                logger.error(f"Error fetching {action}: {e}")
                raise

    async def get_vod_categories(self) -> List[Dict]:
        cache_key = f"xtream:vod_categories:{self.username}"
        cached = redis_conn.get(cache_key)
        if cached:
            return json.loads(cached)
            
        data = await self._request("get_vod_categories")
        redis_conn.setex(cache_key, 3600, json.dumps(data))
        return data

    def get_vod_categories_sync(self) -> List[Dict]:
        return self._request_sync("get_vod_categories")

    async def get_vod_streams(self, category_id: Optional[str] = None) -> List[Dict]:
        cat_id = category_id or "all"
        cache_key = f"xtream:vod_streams:{self.username}:{cat_id}"
        cached = redis_conn.get(cache_key)
        if cached:
            return json.loads(cached)

        kwargs = {}
        if category_id:
            kwargs["category_id"] = category_id
            
        data = await self._request("get_vod_streams", **kwargs)
        redis_conn.setex(cache_key, 1800, json.dumps(data)) # 30 min for VOD listing
        return data

    def get_vod_streams_sync(self, category_id: Optional[str] = None) -> List[Dict]:
        kwargs = {}
        if category_id:
            kwargs["category_id"] = category_id
        return self._request_sync("get_vod_streams", **kwargs)

    async def get_series_categories(self) -> List[Dict]:
        cache_key = f"xtream:series_categories:{self.username}"
        cached = redis_conn.get(cache_key)
        if cached:
            return json.loads(cached)
            
        data = await self._request("get_series_categories")
        redis_conn.setex(cache_key, 3600, json.dumps(data))
        return data

    def get_series_categories_sync(self) -> List[Dict]:
        return self._request_sync("get_series_categories")

    async def get_series(self, category_id: Optional[str] = None) -> List[Dict]:
        cat_id = category_id or "all"
        cache_key = f"xtream:series:{self.username}:{cat_id}"
        cached = redis_conn.get(cache_key)
        if cached:
            return json.loads(cached)

        kwargs = {}
        if category_id:
            kwargs["category_id"] = category_id
            
        data = await self._request("get_series", **kwargs)
        redis_conn.setex(cache_key, 1800, json.dumps(data)) # 30 min for series listing
        return data

    def get_series_sync(self, category_id: Optional[str] = None) -> List[Dict]:
        kwargs = {}
        if category_id:
            kwargs["category_id"] = category_id
        return self._request_sync("get_series", **kwargs)

    async def get_series_info(self, series_id: str) -> Dict:
        return await self._request("get_series_info", series_id=series_id)

    def get_series_info_sync(self, series_id: str) -> Dict:
        return self._request_sync("get_series_info", series_id=series_id)

    async def get_vod_info(self, vod_id: str) -> Dict:
        return await self._request("get_vod_info", vod_id=vod_id)

    def get_vod_info_sync(self, vod_id: str) -> Dict:
        return self._request_sync("get_vod_info", vod_id=vod_id)

    async def get_live_categories(self) -> List[Dict]:
        cache_key = f"xtream:categories:{self.username}"
        cached = redis_conn.get(cache_key)
        if cached:
            return json.loads(cached)
            
        data = await self._request("get_live_categories")
        redis_conn.setex(cache_key, 3600, json.dumps(data))
        return data

    def get_live_categories_sync(self) -> List[Dict]:
        return self._request_sync("get_live_categories")

    async def get_live_streams(self, category_id: Optional[str] = None) -> List[Dict]:
        cat_id = category_id or "all"
        cache_key = f"xtream:streams:{self.username}:{cat_id}"
        cached = redis_conn.get(cache_key)
        if cached:
            return json.loads(cached)

        kwargs = {}
        if category_id:
            kwargs["category_id"] = category_id
            
        data = await self._request("get_live_streams", **kwargs)
        redis_conn.setex(cache_key, 3600, json.dumps(data))
        return data

    def get_live_streams_sync(self, category_id: Optional[str] = None) -> List[Dict]:
        kwargs = {}
        if category_id:
            kwargs["category_id"] = category_id
        return self._request_sync("get_live_streams", **kwargs)

    def get_stream_url(self, stream_type: str, stream_id: str, extension: str) -> str:
        # stream_type: "movie" or "series"
        return f"{self.base_url}/{stream_type}/{self.username}/{self.password}/{stream_id}.{extension}"
