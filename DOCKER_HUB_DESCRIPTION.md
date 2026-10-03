# Xtream to STRM v4.8.0
- Jellyfin Media Management

Transform your Xtream Codes subscriptions and M3U playlists into Jellyfin-compatible media files with this modern, production-ready web application.

## 🎯 What It Does

Automatically generates `.strm` stream files and `.nfo` metadata files following Jellyfin's naming conventions, enabling seamless integration with your Jellyfin media server.

## 🆕 What's new in v4.8.0

- **New dashboard**: on air and tonight's guide, a wall of live captures (free channels only), every playlist with dead channels, *real* guide coverage and short player URLs, every source with its expiry and connections in use, the Jellyfin libraries, and an activity journal. It reads a snapshot refreshed every 5 minutes, so it opens instantly.
- **Problem bell** in the header of every screen, plus **phone alerts** through ntfy, Telegram or a webhook (a problem is pushed on its second sighting, and "resolved" follows). Configure it in Administration → Integrations.
- **Ctrl+K search** from every screen.
- **Phone layout**: drawer menu, screens sized to the visible area, a readable Download Manager and Logs.
- **Fixed**: batch pause / resume / retry in the Download Manager always failed (HTTP 422); the "last 7 days" chart spanned months and is now folded behind a summary line; the dashboard showed 100 % guide coverage on empty guides; series "last sync" was shown two hours early.

Back up your `db/` volume before upgrading: migrations 015 and 016 add three tables and a column, nothing is removed.

## Earlier in v4.7.x and v4.6.x

- **4.7.0**: playlist health, Ctrl+K in the editor, channel numbering, rule groups, short player URLs (`/p/<name>.m3u`), Auto Organizer can update an existing playlist.
- **4.6.0**: playlist editor overhaul (numbering kept on reorder, server-side undo/redo).

## Earlier in v4.5.x

- **4.5.5**: deleting an EPG source still linked to playlists now unlinks it for you (after a confirmation that says how many playlists are affected) instead of refusing.
- **4.5.4**: a download is marked completed only when proven good: exact size, 16 byte samples re-read from the provider, and a full FFmpeg read without error. A badly stitched file is discarded and re-downloaded from scratch.
- **4.5.3**: a separate "Refreshed" counter distinguishes a series' periodic recheck from a real addition.
- **4.5.1 / 4.5.2**: stable playlist links that survive a restart; a fresh `git clone` + `docker build` now produces the published image.
- **4.5.0**: Arabic organizer profile and stable playlist links.
- **4.2.0**: hardening release (sync selection, EPG, downloads, stability).

### ⚠️ Upgrading from v4.0.0 or earlier

1. **Back up your `db/` volume first** — the container adds columns on start.
2. **An empty bouquet selection now means "delete", not "sync everything".** Tick what you want before the first sync.
3. **The first sync rebuilds the library once** (naming rules changed). Later runs are incremental again.

## ✨ Key Features

- **Global EPG Library**: Define EPG sources once and link them to any playlist with priority-based auto-matching.
- **Dashboard**: what is on air, every playlist and source at a glance, an activity journal, and a problem bell that can also alert your phone.
- **Live TV Composer v2**: Drag-and-drop channel organization with virtual bouquets, undo/redo, health checks, numbering tools, rule groups and short player URLs.
- **Compact Mode**: High-density toggle that reduces row sizes and hides secondary info for large channel lists.
- **Multi-Source Support**: Xtream Codes API and M3U playlists (URL or file upload).
- **Download Manager**: Browse, download, and auto-monitor media with intelligent queue management.
- **Selective Sync**: Choose specific categories/groups for movies and series.
- **Rich Metadata**: NFO files with TMDB integration and configurable formatting.
- **Real-time Logs**: Streaming application logs directly in the browser.
- **Security**: Runs as non-root user (`appuser`) with protected admin routes.

## 🚀 Quick Start

```bash
docker run -d \
  -p 8000:8000 \
  -v $(pwd)/output:/output \
  -v $(pwd)/db:/db \
  --name xtream-to-strm \
  mourabena2ui/xtream-to-strm-web:4.8.0
```

Tags: `4.8.0` (pin this), `4.8`, `latest`.

Access the web interface at **http://localhost:8000**

## 📋 Docker Compose

```yaml
services:
  app:
    image: mourabena2ui/xtream-to-strm-web:4.8.0
    container_name: xtream_app
    ports:
      - "8000:8000"
    volumes:
      - ./output:/output
      - ./db:/db
    restart: unless-stopped
```

## 📁 Generated Files

**Movies:**
```
/output/movies/Movie Name (2024)/
├── Movie Name (2024).strm
└── Movie Name (2024).nfo
```

**Series:**
```
/output/series/Series Name/
├── Season 01/
│   ├── S01E01 - Episode Title.strm
│   └── S01E01 - Episode Title.nfo
└── tvshow.nfo
```

## 🔧 Tech Stack

- Python 3.11 + FastAPI
- React 18 + TypeScript
- Celery + Redis
- SQLite

## 📖 Documentation

Full documentation: [GitHub Repository](https://github.com/mourabenapi-ux/xtream-to-strm-web)

## 📄 License

MIT License - Free for personal and commercial use

## 💬 Support

- GitHub Issues: https://github.com/mourabenapi-ux/xtream-to-strm-web/issues
- Buy Me a Coffee: https://www.buymeacoffee.com/mourabena

---

**Made with ❤️ for the Jellyfin community**

v4.8.0 | [GitHub](https://github.com/mourabenapi-ux/xtream-to-strm-web) | [Docker Hub](https://hub.docker.com/r/mourabena2ui/xtream-to-strm-web)
