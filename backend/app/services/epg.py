import httpx
import json
import logging
import os
import tempfile
from lxml import etree
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional, Dict
from urllib.parse import quote
from app.models.live import LivePlaylist
from app.models.epg import EPGSourceGlobal, PlaylistEPGSource
from app.core.redis import get_redis
from app.core.config import settings

logger = logging.getLogger(__name__)

# Auto-match thresholds. These are deliberately strict: a wrong EPG id is
# worse than no EPG id, because the channel then displays a *plausible* but
# entirely unrelated schedule and nothing looks broken. See
# EPGService.auto_match_channels for what the old values cost.
_MIN_TARGET_LEN = 4          # shorter cleaned names carry no signal
_MIN_FUZZY = 88              # token_sort_ratio floor for a real match
_MIN_PARTIAL_FUZZY = 95      # containment matching must be near-certain
_MIN_PARTIAL_LEN = 8         # ...and only for targets long enough to mean it
_MIN_LENGTH_RATIO = 0.6      # "Nat" must not match "National Geographic"
_PRIORITY_WEIGHT = 5.0       # breaks ties only; never carries a weak match
_CANDIDATES_PER_SOURCE = 5   # fallbacks for channels that lose an id


class EPGService:
    def __init__(self):
        self.redis = get_redis()

    @staticmethod
    def xtream_guide_url(subscription) -> str:
        """The provider's own XMLTV endpoint for a subscription.

        Xtream Codes serves the guide at `xmltv.php` with the same credentials
        as the player API. This is the source whose channel ids match the
        stream ids exactly, which is why it is worth preferring over a
        third-party guide and fuzzy name matching.
        """
        base = (subscription.xtream_url or "").rstrip("/")
        return (
            f"{base}/xmltv.php"
            f"?username={quote(subscription.username or '')}"
            f"&password={quote(subscription.password or '')}"
        )

    def _resolve_source_url(self, source: EPGSourceGlobal, db_session=None) -> Optional[str]:
        """The URL to download for this source, whatever its type.

        `source_type == "xtream"` was declared in the model, accepted by the
        API and then fell through a bare `pass` — the source existed, showed
        up in the UI, refreshed without error, and cached nothing at all.
        """
        if source.source_type == "url":
            return source.source_url

        if source.source_type != "xtream":
            return None

        # An explicit URL wins: it lets a provider with a non-standard guide
        # path still be used as an "xtream" source.
        if source.source_url:
            return source.source_url

        if not source.subscription_id:
            logger.error(
                f"EPG source {source.id} is of type 'xtream' but names no "
                "subscription, so there is no provider to ask for a guide."
            )
            return None

        session = db_session
        own_session = False
        if session is None:
            from app.db.session import SessionLocal
            session = SessionLocal()
            own_session = True
        try:
            from app.models.subscription import Subscription
            sub = session.query(Subscription).filter(
                Subscription.id == source.subscription_id
            ).first()
            if not sub:
                logger.error(
                    f"EPG source {source.id} points at subscription "
                    f"{source.subscription_id}, which no longer exists."
                )
                return None
            return self.xtream_guide_url(sub)
        finally:
            if own_session:
                session.close()

    async def fetch_and_cache_epg(self, source: EPGSourceGlobal, db_session=None):
        """Fetch XMLTV from source and cache in Redis.

        The guide is streamed to a temporary file and parsed incrementally from
        there. Holding the whole document in memory costs well over a gigabyte on
        national guides, and a Celery worker never gives that memory back.
        """
        try:
            url = self._resolve_source_url(source, db_session)

            if url:
                # Credentials are in the xtream URL; log the endpoint only.
                logger.info(f"fetching EPG for source {source.id} ({source.source_type})")
                with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as tmp:
                    tmp_path = tmp.name
                    downloaded = 0
                    async with httpx.AsyncClient(
                        timeout=120.0,
                        follow_redirects=True,
                        headers={"User-Agent": "TiviMate/5.0.4 (Linux; Android 11; Mbox Build/RQ1A.210105.003)"},
                    ) as client:
                        async with client.stream("GET", url) as resp:
                            resp.raise_for_status()
                            async for chunk in resp.aiter_bytes(chunk_size=256 * 1024):
                                tmp.write(chunk)
                                downloaded += len(chunk)
                try:
                    logger.info(f"EPG source {source.id}: {downloaded:,} bytes downloaded")
                    self._parse_and_cache_file(source.id, tmp_path)
                finally:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

            elif source.source_type == "file" and source.file_path:
                logger.info(f"fetching EPG for source {source.id} from {source.file_path}")
                self._parse_and_cache_file(source.id, source.file_path)

            else:
                logger.error(
                    f"EPG source {source.id} ({source.source_type}) has nothing to "
                    "parse: no URL, no file, and no subscription to derive one from."
                )

        except Exception as e:
            logger.error(f"Failed to fetch/cache EPG: {e}")

    def _parse_and_cache_file(self, source_id: int, path: str):
        """Parse an XMLTV file incrementally and store channels and programs in Redis.

        Elements are dropped as soon as they are consumed, so peak memory stays flat
        whatever the size of the guide.
        """
        try:
            now = datetime.now().timestamp()
            channel_ids = []
            program_count = 0
            cleared_keys = set()

            pipe = self.redis.pipeline(transaction=False)
            pending = 0

            def flush():
                nonlocal pending
                if pending:
                    pipe.execute()
                    pending = 0

            context = etree.iterparse(
                path, events=("end",), tag=("channel", "programme"), recover=True
            )

            for _, elem in context:
                if elem.tag == "channel":
                    ch_id = elem.get("id")
                    if ch_id:
                        channel_ids.append(ch_id)
                        icon_elem = elem.find("icon")
                        pipe.hset(f"epg:src:{source_id}:channel:{ch_id}", mapping={
                            "name": elem.findtext("display-name") or "",
                            "icon": (icon_elem.get("src") if icon_elem is not None else "") or ""
                        })
                        pending += 1

                else:  # programme
                    ch_id = elem.get("channel")
                    start_str = elem.get("start")  # Format: 20260210110000 +0100
                    if ch_id and start_str:
                        start_ts = self._parse_xmltv_date(start_str)
                        stop_str = elem.get("stop")
                        stop_ts = self._parse_xmltv_date(stop_str) if stop_str else start_ts + 3600

                        if stop_ts >= now:  # Skip past programs
                            key = f"epg:src:{source_id}:prog:{ch_id}"
                            if key not in cleared_keys:
                                # Drop the previous refresh; the TTL is set at the end,
                                # since EXPIRE on a key that does not exist yet is a no-op
                                cleared_keys.add(key)
                                pipe.delete(key)
                                pending += 1

                            payload = json.dumps({
                                "start": start_ts,
                                "stop": stop_ts,
                                "title": elem.findtext("title"),
                                "desc": elem.findtext("desc") or "",
                            })
                            pipe.zadd(key, {payload: start_ts})
                            pending += 1
                            program_count += 1

                # Release this element and the preceding siblings already consumed
                elem.clear()
                parent = elem.getparent()
                if parent is not None:
                    while elem.getprevious() is not None:
                        del parent[0]

                if pending >= 1000:
                    flush()

            # Now that the sorted sets exist, give them their 24h TTL
            for key in cleared_keys:
                pipe.expire(key, 86400)
                pending += 1

            flush()
            del context

            if channel_ids:
                # Store the list of IDs for search/mapping
                self.redis.delete(f"epg:src:{source_id}:channels")
                self.redis.sadd(f"epg:src:{source_id}:channels", *channel_ids)

            logger.info(
                f"Successfully cached {len(channel_ids)} channels and "
                f"{program_count} programs for source {source_id}"
            )

        except Exception as e:
            logger.error(f"Error parsing XMLTV: {e}")

    def _parse_xmltv_date(self, date_str: str) -> float:
        """Parse an XMLTV date (``YYYYMMDDHHMMSS [+/-]HHMM``) into a POSIX timestamp.

        The offset is part of the value, not decoration. Dropping it left a naive
        datetime, and ``.timestamp()`` then re-read that wall clock in the server's
        own zone — every programme in the guide moved by the difference between the
        two zones. XMLTV leaves the meaning of a missing offset to the source, so
        UTC is assumed: guides that omit it are rare, and guessing local time would
        make the result depend on the container's TZ.
        """
        try:
            parts = date_str.strip().split()
            dt = datetime.strptime(parts[0][:14], "%Y%m%d%H%M%S")

            offset = parts[1] if len(parts) > 1 else ""
            if len(offset) == 5 and offset[0] in "+-":
                delta = timedelta(hours=int(offset[1:3]), minutes=int(offset[3:5]))
                tz = timezone(-delta if offset[0] == "-" else delta)
            else:
                tz = timezone.utc

            return dt.replace(tzinfo=tz).timestamp()
        except Exception:
            return 0.0

    def search_channels(self, source_id: int, query: str) -> List[dict]:
        """Search available channels in a source."""
        all_ids = self.redis.smembers(f"epg:src:{source_id}:channels")
        results = []
        query = query.lower()
        
        for ch_id in all_ids:
            details = self.redis.hgetall(f"epg:src:{source_id}:channel:{ch_id}")
            name = details.get("name", "").lower()
            if query in ch_id.lower() or query in name:
                results.append({
                    "id": ch_id,
                    "name": details.get("name"),
                    "icon": details.get("icon")
                })
        return results[:50] # Limit results

    def active_source_ids(self, playlist: LivePlaylist) -> List[int]:
        """Ids of the EPG sources linked to a playlist, highest priority first."""
        links = sorted(
            [l for l in playlist.epg_source_links if l.epg_source.is_active],
            key=lambda x: x.priority,
            reverse=True,
        )
        return [l.epg_source.id for l in links]

    def channel_is_covered(self, source_ids: List[int], epg_id: str) -> bool:
        """Whether any of these sources actually describes this channel id.

        A tvg-id that no linked guide contains looks mapped everywhere in the UI
        and still shows an empty programme list in the player.
        """
        if not epg_id:
            return False
        return any(
            self.redis.sismember(f"epg:src:{sid}:channels", epg_id) for sid in source_ids
        )

    def generate_playlist_xmltv(
        self, playlist: LivePlaylist, channels: Optional[List[Dict[str, Any]]] = None
    ) -> str:
        """Generate a custom XMLTV guide for a specific playlist.

        ``channels`` is the resolved channel list the M3U serves, each entry
        carrying the ``epg_id`` actually written as ``tvg-id``. It must be passed
        by any caller that also serves the M3U: this guide used to be built from
        the stored ``LivePlaylistChannel`` rows alone, so a channel whose id came
        from the provider was advertised in the playlist and described nowhere in
        the guide. The fallback below keeps the old behaviour for callers that
        have no resolved list to give.
        """
        logger.info(f"Generating custom XMLTV for playlist {playlist.id}")
        
        # 1. Start XML
        root = etree.Element("tv", generator_info_name="XtreamToSTRM EPG Proxy")
        
        # 2. Get active EPG sources for this playlist (linked sources sorted by priority)
        source_links = sorted(
            [link for link in playlist.epg_source_links if link.epg_source.is_active],
            key=lambda x: x.priority,
            reverse=True
        )
        if not source_links:
            return etree.tostring(root, encoding="utf-8", xml_declaration=True, pretty_print=True).decode()

        # 3. Determine which EPG ids this playlist actually advertises.
        # One id can be shared by several channels, and each must be described once.
        if channels is None:
            wanted = [
                {"epg_id": ch.epg_channel_id, "name": ch.custom_name}
                for b in playlist.bouquets
                for ch in b.channels
                if not ch.is_excluded
            ]
        else:
            wanted = channels

        seen_ids = set()
        selected_channels = []
        for entry in wanted:
            epg_id = (entry.get("epg_id") or "").strip()
            if not epg_id or epg_id in seen_ids:
                continue
            seen_ids.add(epg_id)
            selected_channels.append(entry)

        # 4. For each selected channel, fetch programs from prioritized sources
        import json
        now = datetime.now().timestamp()

        for entry in selected_channels:
            epg_id = entry["epg_id"].strip()

            # Highest-priority source that actually has *programmes* for this
            # channel — not merely one that lists it.
            #
            # Stopping at the first source that declares the channel meant a
            # guide which names a channel but carries no schedule for it (the
            # provider's own XMLTV does exactly that: it listed TF1.fr with
            # zero programmes) blocked the lower-priority guide that held 219
            # of them. The result was a valid, empty guide and no way to tell
            # why. Priority still decides between sources that both have data.
            target_source = None
            listing_only = None
            window_start = now - 12 * 3600

            for link in source_links:
                src = link.epg_source
                if not self.redis.sismember(f"epg:src:{src.id}:channels", epg_id):
                    continue
                if listing_only is None:
                    listing_only = src
                if self.redis.zcount(f"epg:src:{src.id}:prog:{epg_id}", window_start, "+inf"):
                    target_source = src
                    break

            if target_source is None:
                # Nobody has programmes. Still describe the channel, so the
                # tvg-id the M3U advertises resolves to something.
                if listing_only is None:
                    continue
                logger.info(
                    f"Playlist {playlist.id}: no source has programmes for "
                    f"'{epg_id}'; emitting the channel with an empty schedule."
                )
                target_source = listing_only

            # Add channel element
            chan_details = self.redis.hgetall(f"epg:src:{target_source.id}:channel:{epg_id}")
            chan_elem = etree.SubElement(root, "channel", id=epg_id)
            etree.SubElement(chan_elem, "display-name").text = (
                chan_details.get("name") or entry.get("name") or epg_id
            )
            if chan_details.get("icon"):
                etree.SubElement(chan_elem, "icon", src=chan_details.get("icon"))

            # Add programs
            prog_key = f"epg:src:{target_source.id}:prog:{epg_id}"
            # Programmes are scored by their start, so asking for [now, +inf)
            # skipped the one on air right now: the player showed an empty "now"
            # slot until it ended. Widen the window backwards, then filter on the
            # real stop time carried in the payload.
            progs = self.redis.zrangebyscore(prog_key, now - 12 * 3600, "+inf")
            for p_json in progs:
                p_data = json.loads(p_json)
                if p_data["stop"] < now:
                    continue
                p_elem = etree.SubElement(root, "programme", 
                    channel=epg_id,
                    start=self._format_xmltv_date(p_data["start"]),
                    stop=self._format_xmltv_date(p_data["stop"])
                )
                etree.SubElement(p_elem, "title").text = p_data["title"]
                if p_data.get("desc"):
                    etree.SubElement(p_elem, "desc").text = p_data["desc"]

        return etree.tostring(root, encoding="utf-8", xml_declaration=True, pretty_print=True).decode()

    def _format_xmltv_date(self, ts: float) -> str:
        """Format a POSIX timestamp as UTC, which is what the +0000 suffix claims.

        ``datetime.fromtimestamp(ts)`` returns local time; stamping it +0000 told
        every player the local wall clock was UTC, so the guide arrived shifted by
        the server's own offset.
        """
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y%m%d%H%M%S +0000")

    def clean_name(self, n: str):
        """Helper to clean channel names for better matching."""
        import re
        import unicodedata
        if not n: return ""
        n = unicodedata.normalize('NFKD', n).encode('ascii', 'ignore').decode('ascii')
        n = re.sub(r'^.*?[:|]\s*', '', n)
        n = re.sub(r'(\b)(HD|SD|FHD|4K|UHD|FR|EN|ES|DE|IT|VIP|BACKUP|H265|HEVC|REPLAY|AC3|RAW)(\b)', r'\1\3', n, flags=re.IGNORECASE)
        n = re.sub(r'[^a-zA-Z0-9]', ' ', n)
        return " ".join(n.split()).lower()

    async def get_epg_match_candidates(self, playlist: LivePlaylist, target_name: str, limit: int = 10):
        """Get best EPG match candidates for a given channel name across active sources."""
        from rapidfuzz import process, fuzz
        
        # 1. Get active linked sources sorted by priority
        source_links = sorted(
            [link for link in playlist.epg_source_links if link.epg_source.is_active],
            key=lambda x: x.priority,
            reverse=True
        )
        if not source_links: return []
        
        max_priority = max(link.priority for link in source_links) if source_links else 1
        if max_priority == 0: max_priority = 1
        
        clean_target = self.clean_name(target_name)
        if not clean_target: return []

        all_candidates = []
        
        for link in source_links:
            src = link.epg_source
            all_ids = self.redis.smembers(f"epg:src:{src.id}:channels")
            if not all_ids: continue
            
            s_pool = []
            for ch_id in all_ids:
                details = self.redis.hgetall(f"epg:src:{src.id}:channel:{ch_id}")
                if details.get("name"):
                    name = details.get("name")
                    s_pool.append({"name": name, "id": ch_id, "clean_name": self.clean_name(name)})
            
            if not s_pool: continue
            
            # Fuzzy match in this source
            s_clean_names = [x["clean_name"] for x in s_pool]
            results = process.extract(clean_target, s_clean_names, scorer=fuzz.token_sort_ratio, limit=limit)
            
            for score_data in results:
                name_val, score, idx = score_data
                priority_weight = (link.priority / max_priority) * 30.0
                composite_score = (score * 0.7) + priority_weight
                
                all_candidates.append({
                    "epg_id": s_pool[idx]["id"],
                    "display_name": s_pool[idx]["name"],
                    "fuzzy_score": score,
                    "priority": link.priority,
                    "composite_score": round(composite_score, 1),
                    "source_name": src.name
                })

        # Sort by composite score descending
        all_candidates.sort(key=lambda x: x["composite_score"], reverse=True)
        return all_candidates[:limit]

    @staticmethod
    def release_shared_epg_ids(playlist: LivePlaylist, db_session) -> dict:
        """Unmap channels that share one EPG id, so they can be matched again.

        An EPG id describes one channel's schedule, so several channels
        holding the same id means all but one are showing somebody else's
        programmes. The old auto-match produced exactly that at scale — 11
        Tunisian channels on a French channel's guide.

        This is never automatic: pointing two channels (an HD and an SD feed
        of the same station) at one id is a legitimate thing to do by hand,
        and this cannot tell that apart from the damage. The caller asks for
        it explicitly.
        """
        holders = {}
        for bouquet in playlist.bouquets:
            for channel in bouquet.channels:
                if channel.epg_channel_id:
                    holders.setdefault(channel.epg_channel_id, []).append(channel)

        released = 0
        for epg_id, channels in holders.items():
            if len(channels) < 2:
                continue
            for channel in channels:
                channel.epg_channel_id = None
                released += 1
            logger.info(f"Released EPG id '{epg_id}' held by {len(channels)} channels.")

        if released:
            db_session.commit()
        return {"released": released}

    async def auto_match_channels(self, playlist: LivePlaylist, db_session, strategy="composite",
                                  release_shared: bool = False):
        """
        Auto-match channels to EPG using fuzzy matching and priority weighting.

        Returns a report dict; `matched_count` is the field callers relied on.

        This used to map 18 of a playlist's 19 channels to the *same*
        `epg_channel_id` — Tunisian channels all carrying a French channel's
        schedule — and count it as 18 successes. Three things caused that:

        * nothing stopped two channels claiming one id, though an EPG id
          describes exactly one channel's schedule;
        * the `partial_token_sort_ratio` fallback matched any short name
          against any longer one containing it;
        * the final `composite_score >= 75` gate was unreachable. Priority
          alone contributes up to 30 points, so a fuzzy score of 65 already
          clears 75 — and the gates above had already demanded 85+. The
          threshold rejected nothing.

        Priority now breaks ties between candidates; it can no longer
        manufacture confidence a name comparison did not earn.

        Args:
            strategy: "composite" (Weight * Score) or "strict" (Priority first)
        """
        from rapidfuzz import process, fuzz
        from app.services.xtream import XtreamClient
        import re
        import unicodedata

        released = 0
        if release_shared:
            released = self.release_shared_epg_ids(playlist, db_session)["released"]

        def _report(matched=0, **extra):
            base = {
                "matched_count": matched,
                "considered": 0,
                "rejected_low_score": 0,
                "rejected_already_claimed": 0,
                "released_shared": released,
                "epg_sources_linked": 0,
                "message": None,
            }
            base.update(extra)
            return base

        # 1. Get active linked sources sorted by priority
        source_links = sorted(
            [link for link in playlist.epg_source_links if link.epg_source.is_active],
            key=lambda x: x.priority,
            reverse=True
        )
        if not source_links:
            # Reporting a bare 0 here read as "nothing matched", when the real
            # answer is "there is nothing to match against".
            return _report(message=(
                "This playlist has no active EPG source linked, so there is nothing "
                "to match against. Link a source first."
            ))

        max_priority = max(link.priority for link in source_links) if source_links else 1
        if max_priority == 0: max_priority = 1
        
        # 2. Build EPG pool per source for search
        # We process source by source to handle priority
        source_pools = [] # List of (source_id, priority, epg_names, epg_pool)
        for link in source_links:
            src = link.epg_source
            all_ids = self.redis.smembers(f"epg:src:{src.id}:channels")
            if not all_ids: continue
            
            s_names = []
            s_pool = []
            for ch_id in all_ids:
                details = self.redis.hgetall(f"epg:src:{src.id}:channel:{ch_id}")
                if details.get("name"):
                    name = details.get("name")
                    s_names.append(name)
                    s_pool.append({"name": name, "id": ch_id, "source_id": src.id})
            
            if s_names:
                source_pools.append({
                    "id": src.id,
                    "priority": link.priority,
                    "names": s_names,
                    "pool": s_pool
                })

        if not source_pools:
            return _report(
                epg_sources_linked=len(source_links),
                message=(
                    "The linked EPG source(s) have no channels in the cache. "
                    "Refresh the EPG source, then run the match again."
                ),
            )

        # Helper to clean channel names
        def clean_name(n: str):
            if not n: return ""
            n = unicodedata.normalize('NFKD', n).encode('ascii', 'ignore').decode('ascii')
            n = re.sub(r'^.*?[:|]\s*', '', n)
            n = re.sub(r'(\b)(HD|SD|FHD|4K|UHD|FR|EN|ES|DE|IT|VIP|BACKUP|H265|HEVC|REPLAY|AC3|RAW)(\b)', r'\1\3', n, flags=re.IGNORECASE)
            n = re.sub(r'[^a-zA-Z0-9]', ' ', n)
            return " ".join(n.split()).lower()

        # Pre-clean EPG names in each pool
        for sp in source_pools:
            sp["clean_names"] = [clean_name(name) for name in sp["names"]]

        # 3. Fetch stream names, per subscription.
        #
        # A playlist is not single-provider: a bouquet, and even an individual
        # channel, carries its own subscription_id — playlist 1 is attached to
        # subscription 1 while every one of its channels is a subscription 2
        # stream. Reading one provider's stream list for all of them is not
        # merely incomplete: provider stream ids are small integers, so id 2
        # exists in both catalogues and naming them in one flat map hands a
        # channel the *other* provider's guide id.
        from app.models.subscription import Subscription

        sub_ids = set()
        if playlist.subscription_id:
            sub_ids.add(playlist.subscription_id)
        for b in playlist.bouquets:
            if b.subscription_id:
                sub_ids.add(b.subscription_id)
            for c in b.channels:
                if c.subscription_id:
                    sub_ids.add(c.subscription_id)

        # Keyed by (subscription_id, stream_id) throughout.
        stream_map = {}
        # What the provider itself declares as each stream's guide id. When it
        # is filled and the id exists in a linked guide, that is an exact
        # answer and no name comparison should be allowed to override it —
        # this is the whole reason the provider's own XMLTV is worth having.
        provider_epg_ids = {}
        for sid in sub_ids:
            sub = db_session.query(Subscription).filter(Subscription.id == sid).first()
            if not sub:
                continue
            client = XtreamClient(sub.xtream_url, sub.username, sub.password)
            try:
                for s in await client.get_live_streams():
                    key = (sid, str(s.get("stream_id")))
                    stream_map[key] = s.get("name")
                    declared = s.get("epg_channel_id")
                    if declared and str(declared).lower() not in ("none", "null", ""):
                        provider_epg_ids[key] = str(declared)
            except Exception as e:
                logger.error(f"Failed to fetch streams for subscription {sid}: {e}")

        # Every guide id we actually hold data for, and which source it is in.
        known_epg_ids = {}
        for sp in source_pools:
            for entry in sp["pool"]:
                known_epg_ids.setdefault(entry["id"], (sp, entry["name"]))

        # 4. Score every channel against every source, keeping several
        # candidates each so a channel that loses an id to a better match can
        # still fall back instead of silently going unmatched.
        proposals = []
        considered = 0
        rejected_low_score = 0
        exact_count = 0

        for bouquet in playlist.bouquets:
            for channel in bouquet.channels:
                if channel.epg_channel_id: continue

                # Same precedence the M3U resolver uses: channel, then bouquet,
                # then playlist.
                chan_sub = (channel.subscription_id or bouquet.subscription_id
                            or playlist.subscription_id)
                key = (chan_sub, str(channel.stream_id))

                target_name = channel.custom_name or stream_map.get(key)
                declared = provider_epg_ids.get(key)

                # Exact path: the provider named this stream's guide id and we
                # hold that guide. Nothing a fuzzy comparison produces can
                # beat the provider's own answer, so it is not put up against
                # the other candidates — it is simply the answer.
                if declared and declared in known_epg_ids:
                    considered += 1
                    exact_count += 1
                    sp, epg_name = known_epg_ids[declared]
                    proposals.append({
                        "channel": channel,
                        "target_name": target_name or f"Stream {channel.stream_id}",
                        "candidates": [{
                            "epg_id": declared,
                            # Above any fuzzy composite, so the 1:1 resolution
                            # below always settles exact matches first.
                            "composite_score": 1000.0,
                            "fuzzy_score": 100,
                            "source_name": epg_name,
                        }],
                    })
                    continue

                if not target_name: continue

                clean_target = clean_name(target_name)
                if not clean_target: continue

                # An exact, normalised equality is unambiguous at any length,
                # so it is never subject to the length floor below. Requiring
                # 4 characters here cost real channels: "AB1", "AB3" and "3+"
                # failed to match their own entry in the guide.
                exact_only = len(clean_target) < _MIN_TARGET_LEN

                considered += 1
                candidates = []

                for sp in source_pools:
                    priority_weight = (sp["priority"] / max_priority) * _PRIORITY_WEIGHT
                    seen_idx = set()

                    def _offer(idx, score):
                        if idx in seen_idx:
                            return
                        seen_idx.add(idx)
                        candidates.append({
                            "epg_id": sp["pool"][idx]["id"],
                            # Priority only separates candidates that the name
                            # comparison already found acceptable.
                            "composite_score": score + priority_weight,
                            "fuzzy_score": score,
                            "source_name": sp["pool"][idx]["name"],
                        })

                    if clean_target in sp["clean_names"]:
                        _offer(sp["clean_names"].index(clean_target), 100)

                    if exact_only:
                        # Two or three characters fuzzy-match half a guide.
                        continue

                    for name_val, score, idx in process.extract(
                        clean_target, sp["clean_names"],
                        scorer=fuzz.token_sort_ratio, limit=_CANDIDATES_PER_SOURCE
                    ):
                        if score >= _MIN_FUZZY:
                            _offer(idx, score)

                    # Partial matching says "one name contains the other",
                    # which is true of "Nat" inside "National Geographic" and
                    # of most short names inside most long ones. It is kept
                    # for names that are genuinely prefixed or suffixed, but
                    # only when the target is long enough for the containment
                    # to be meaningful and the two names are comparable in
                    # length.
                    if len(clean_target) >= _MIN_PARTIAL_LEN:
                        for name_val, score, idx in process.extract(
                            clean_target, sp["clean_names"],
                            scorer=fuzz.partial_token_sort_ratio,
                            limit=_CANDIDATES_PER_SOURCE
                        ):
                            if score < _MIN_PARTIAL_FUZZY:
                                continue
                            shorter, longer = sorted((len(clean_target), len(name_val)))
                            if longer and shorter / longer < _MIN_LENGTH_RATIO:
                                continue
                            _offer(idx, score)

                if candidates:
                    candidates.sort(key=lambda c: c["composite_score"], reverse=True)
                    proposals.append({
                        "channel": channel,
                        "target_name": target_name,
                        "candidates": candidates,
                    })
                else:
                    rejected_low_score += 1

        # 5. Assign at most one channel per EPG id.
        # An EPG id describes one channel's schedule. Handing the same id to
        # 18 channels does not give 18 channels a guide — it gives 17 of them
        # somebody else's. Resolved greedily from the best score down, which
        # gives each id to the channel that matched it most convincingly.
        claimed = {
            ch.epg_channel_id
            for bouquet in playlist.bouquets
            for ch in bouquet.channels
            if ch.epg_channel_id
        }

        ranked = sorted(
            (
                (cand["composite_score"], idx, cand, p)
                for idx, p in enumerate(proposals)
                for cand in p["candidates"]
            ),
            key=lambda row: row[0],
            reverse=True,
        )

        assigned = set()
        match_count = 0
        rejected_already_claimed = 0

        for _score, idx, cand, p in ranked:
            if idx in assigned:
                continue
            if cand["epg_id"] in claimed:
                continue
            p["channel"].epg_channel_id = cand["epg_id"]
            claimed.add(cand["epg_id"])
            assigned.add(idx)
            match_count += 1
            logger.info(
                f"Auto-matched '{p['target_name']}' -> '{cand['source_name']}' "
                f"(Composite: {cand['composite_score']:.1f}, Fuzzy: {cand['fuzzy_score']})"
            )

        for idx, p in enumerate(proposals):
            if idx not in assigned:
                rejected_already_claimed += 1
                logger.info(
                    f"No free EPG id for '{p['target_name']}' — every candidate was "
                    f"a better match for another channel. Left unmapped."
                )

        if match_count > 0:
            db_session.commit()

        unmatched = considered - match_count
        fuzzy_matches = match_count - min(exact_count, match_count)
        return _report(
            matched=match_count,
            considered=considered,
            exact_matches=exact_count,
            rejected_low_score=rejected_low_score,
            rejected_already_claimed=rejected_already_claimed,
            epg_sources_linked=len(source_links),
            message=(
                f"{match_count} of {considered} channel(s) matched"
                + (f" ({exact_count} from the provider's own guide id, "
                   f"{fuzzy_matches} by name)." if exact_count else " by name.")
                + (f" {unmatched} left unmapped — map them by hand in the playlist editor."
                   if unmatched else "")
            ),
        )

epg_service = EPGService()
