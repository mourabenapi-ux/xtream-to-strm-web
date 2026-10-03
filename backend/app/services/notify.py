"""Push a line to the user's phone: ntfy, Telegram, or any webhook.

Three senders because they cover the realistic cases with no account on our
side: ntfy needs only a topic URL, Telegram a bot, and a webhook reaches Home
Assistant, Gotify bridges, Discord relays and the like. Each one fails on its
own: a Telegram outage does not stop the ntfy line.
"""
import logging
from typing import Dict, List, Optional
from urllib.parse import urlsplit

import httpx

from app.models.dashboard import Severity

logger = logging.getLogger(__name__)

_NTFY_PRIORITY = {Severity.DANGER: 4, Severity.WARNING: 3, Severity.INFO: 2}
_NTFY_TAGS = {Severity.DANGER: "rotating_light", Severity.WARNING: "warning",
              Severity.INFO: "information_source"}
_PREFIX = {Severity.DANGER: "🔴", Severity.WARNING: "🟠", Severity.INFO: "🔵"}


def should_push(values: Dict[str, str], severity: str) -> bool:
    floor = values.get("NOTIFY_MIN_SEVERITY") or Severity.WARNING
    return Severity.ORDER.get(severity, 0) >= Severity.ORDER.get(floor, 1)


def _ntfy(values: Dict[str, str], title: str, message: str, severity: str,
          link: Optional[str]) -> None:
    url = values["NOTIFY_NTFY_URL"]
    parts = urlsplit(url)
    topic = parts.path.strip("/")
    if not parts.scheme or not topic:
        raise ValueError("The ntfy URL must look like https://ntfy.sh/your-topic")
    # JSON publishing: titles with accents do not fit in an HTTP header.
    body = {"topic": topic, "title": title, "message": message or title,
            "priority": _NTFY_PRIORITY.get(severity, 3), "tags": [_NTFY_TAGS.get(severity, "bell")]}
    if link:
        body["click"] = link
    headers = {}
    if values.get("NOTIFY_NTFY_TOKEN"):
        headers["Authorization"] = f"Bearer {values['NOTIFY_NTFY_TOKEN']}"
    response = httpx.post(f"{parts.scheme}://{parts.netloc}", json=body, headers=headers, timeout=10)
    response.raise_for_status()


def _telegram(values: Dict[str, str], title: str, message: str, severity: str,
              link: Optional[str]) -> None:
    text = f"{_PREFIX.get(severity, '')} {title}".strip()
    if message:
        text += f"\n{message}"
    if link:
        text += f"\n{link}"
    response = httpx.post(
        f"https://api.telegram.org/bot{values['NOTIFY_TELEGRAM_TOKEN']}/sendMessage",
        json={"chat_id": values["NOTIFY_TELEGRAM_CHAT_ID"], "text": text,
              "disable_web_page_preview": True},
        timeout=10,
    )
    if response.status_code >= 400:
        # Telegram explains itself in "description"; the URL holds the token.
        try:
            reason = response.json().get("description")
        except ValueError:
            reason = None
        raise RuntimeError(reason or f"HTTP {response.status_code}")


def _webhook(values: Dict[str, str], title: str, message: str, severity: str,
             link: Optional[str]) -> None:
    response = httpx.post(values["NOTIFY_WEBHOOK_URL"], json={
        "app": "xtream-to-strm", "title": title, "message": message,
        "severity": severity, "link": link,
    }, timeout=10)
    response.raise_for_status()


def send(values: Dict[str, str], title: str, message: str = "", severity: str = Severity.WARNING,
         link: Optional[str] = None) -> List[Dict[str, str]]:
    """Send on every configured channel. Returns one result per channel."""
    results: List[Dict[str, str]] = []
    senders = []
    if values.get("NOTIFY_NTFY_URL"):
        senders.append(("ntfy", _ntfy))
    if values.get("NOTIFY_TELEGRAM_TOKEN") and values.get("NOTIFY_TELEGRAM_CHAT_ID"):
        senders.append(("telegram", _telegram))
    if values.get("NOTIFY_WEBHOOK_URL"):
        senders.append(("webhook", _webhook))
    for name, sender in senders:
        try:
            sender(values, title, message, severity, link)
            results.append({"channel": name, "ok": "true"})
        except Exception as e:  # one broken channel must not silence the others
            error = str(e)
            # Never echo a Telegram token back through an error string.
            if values.get("NOTIFY_TELEGRAM_TOKEN"):
                error = error.replace(values["NOTIFY_TELEGRAM_TOKEN"], "<token>")
            logger.warning("Notification via %s failed: %s", name, error)
            results.append({"channel": name, "ok": "false", "error": error[:300]})
    return results
