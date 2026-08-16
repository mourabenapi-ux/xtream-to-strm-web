# Xtream to STRM v4.2.0
- Jellyfin Media Management

Transform your Xtream Codes subscriptions and M3U playlists into Jellyfin-compatible media files with this modern, production-ready web application.

## 🎯 What It Does

Automatically generates `.strm` stream files and `.nfo` metadata files following Jellyfin's naming conventions, enabling seamless integration with your Jellyfin media server.

## 🆕 What's new in v4.2.0

A hardening release, verified against a live provider and a 3 700-item library.

- **Sync**: an empty bouquet selection no longer syncs the whole catalogue; an empty provider response no longer wipes the library; deletion is disk-driven so renamed titles stop leaving orphans; duplicate titles get `(2)`/`(3)` instead of overwriting each other; ongoing series finally gain their new episodes.
- **EPG**: the provider's native XMLTV guide (`xmltv.php`) is implemented; timezone handling fixed; the now-playing slot works; auto-match rewritten (12/15 → 15/15 on a real 785-channel guide).
- **Downloads**: real container extension instead of a hardcoded `.mp4`; resumable on a mid-stream cut; frozen-queue recovery; NFOs written for downloads.
- **Stability**: EPG worker memory 1.5 GB → 93 MB (container 3.67 GB → 876 MB); all six dashboard endpoints were returning 500 and now work.

### ⚠️ Upgrading from v4.0.0

1. **Back up your `db/` volume first** — the container adds columns on start.
2. **An empty bouquet selection now means "delete", not "sync everything".** Tick what you want before the first sync.
3. **The first sync rebuilds the library once** (naming rules changed). Later runs are incremental again.

## ✨ Key Features

- **Global EPG Library**: Define EPG sources once and link them to any playlist with priority-based auto-matching.
- **Command Center Dashboard**: Real-time system health, active task monitoring, hero stats, and quick actions.
- **Live TV Composer v2**: Drag-and-drop channel organization with virtual bouquets, undo/redo, and compact mode.
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
  mourabena2ui/xtream-to-strm-web:4.2.0
```

Tags: `4.2.0` (pin this), `4.2`, `latest`.

Access the web interface at **http://localhost:8000**

## 📋 Docker Compose

```yaml
services:
  app:
    image: mourabena2ui/xtream-to-strm-web:4.2.0
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

v4.2.0 | [GitHub](https://github.com/mourabenapi-ux/xtream-to-strm-web) | [Docker Hub](https://hub.docker.com/r/mourabena2ui/xtream-to-strm-web)
