"""Settings of the dashboard and of its integrations, in the `settings` table.

Stored as plain key/value rows like the rest of the configuration. Secrets
(the Jellyfin API key, the Telegram bot token, an ntfy access token) are never
sent back to the browser: the API answers whether one is set, not what it is.
"""
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.settings import SettingsModel

DEFAULTS: Dict[str, str] = {
    # Base of the player URLs shown in the UI, e.g. http://192.168.1.20.
    # Empty: the address the browser used to reach the app.
    "PUBLIC_BASE_URL": "",
    # The playlist the "On air" panel, tonight's guide and the TV wall show.
    "DASHBOARD_PLAYLIST_ID": "",
    # Capture one image per channel for the TV wall (free sources only).
    "TVWALL_ENABLED": "true",
    "JELLYFIN_URL": "",
    "JELLYFIN_API_KEY": "",
    "NOTIFY_NTFY_URL": "",
    "NOTIFY_NTFY_TOKEN": "",
    "NOTIFY_TELEGRAM_TOKEN": "",
    "NOTIFY_TELEGRAM_CHAT_ID": "",
    "NOTIFY_WEBHOOK_URL": "",
    # Lowest severity that is pushed: "warning" or "danger".
    "NOTIFY_MIN_SEVERITY": "warning",
    # Also push a line when a download completes.
    "NOTIFY_DOWNLOAD_DONE": "false",
}

SECRETS = {"JELLYFIN_API_KEY", "NOTIFY_NTFY_TOKEN", "NOTIFY_TELEGRAM_TOKEN"}


def load(db: Session) -> Dict[str, str]:
    """Every dashboard setting, defaults filled in, secrets included."""
    rows = db.query(SettingsModel).filter(SettingsModel.key.in_(list(DEFAULTS))).all()
    values = dict(DEFAULTS)
    for row in rows:
        values[row.key] = row.value if row.value is not None else ""
    return values


def public_view(values: Dict[str, str]) -> Dict[str, Any]:
    """What the browser may see: secrets replaced by whether they are set."""
    out: Dict[str, Any] = {}
    for key, value in values.items():
        if key in SECRETS:
            out[f"HAS_{key}"] = bool(value)
        else:
            out[key] = value
    return out


def save(db: Session, updates: Dict[str, Optional[str]]) -> Dict[str, str]:
    """Partial update. None leaves a key alone, "" clears it.

    A secret sent back empty is left alone too: the form never receives the
    stored value, so an untouched password field must not erase it. Clearing a
    secret is an explicit ``CLEAR`` sentinel.
    """
    for key, value in updates.items():
        if key not in DEFAULTS or value is None:
            continue
        value = str(value).strip()
        if key in SECRETS:
            if value == "":
                continue
            if value == "CLEAR":
                value = ""
        if key in ("PUBLIC_BASE_URL", "JELLYFIN_URL"):
            value = value.rstrip("/")
        row = db.query(SettingsModel).filter(SettingsModel.key == key).first()
        if row is None:
            db.add(SettingsModel(key=key, value=value))
        else:
            row.value = value
    db.commit()
    return load(db)


def notifications_configured(values: Dict[str, str]) -> bool:
    return bool(values.get("NOTIFY_NTFY_URL")
                or (values.get("NOTIFY_TELEGRAM_TOKEN") and values.get("NOTIFY_TELEGRAM_CHAT_ID"))
                or values.get("NOTIFY_WEBHOOK_URL"))


def as_bool(values: Dict[str, str], key: str) -> bool:
    return str(values.get(key, "")).lower() in ("1", "true", "yes", "on")
