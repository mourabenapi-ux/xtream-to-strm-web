# Running and Upgrading the Docker Image

## Pull from Docker Hub

```bash
docker pull mourabena2ui/xtream-to-strm-web:4.2.0
```

Tags: `4.2.0` (pin this), `4.2`, `latest`.

## Run

```bash
docker run -d \
  --name xtream_app \
  -p 80:8000 \
  -v $(pwd)/output:/output \
  -v $(pwd)/db:/db \
  -e TZ=Europe/Paris \
  -e TIMEZONE=Europe/Paris \
  --restart unless-stopped \
  mourabena2ui/xtream-to-strm-web:4.2.0
```

Then open `http://<host>`.

`TIMEZONE` matters: it is what the EPG generator uses to place programmes. Set it to
your own zone, not the server's default.

> 🔐 There is no authentication on the web interface, and provider credentials are
> stored in clear text in `db/`. Keep the port on your LAN.

## Volumes

| Host path | Container path | Contents |
|---|---|---|
| `./db` | `/db` | SQLite database — subscriptions, selections, sync state. **Back this up.** |
| `./output` | `/output` | Generated `.strm` / `.nfo` library and downloaded files. |

## Upgrading from v4.0.x / v4.1.x to v4.2.0

Read this before pulling — v4.2.0 changes two behaviours.

**1. Back up the database.** The container adds columns to existing tables on first
start, and there is no downgrade path.

```bash
docker stop xtream_app
cp -a db db.backup-$(date +%Y%m%d)
```

**2. Check your bouquet selection.** In v4.0.0, a subscription with *no* bouquet ticked
synced the entire catalogue. In v4.2.0 an empty selection means *nothing is wanted*, and
the sync removes the generated library for that media type. Open **Bouquet Selection**
for each subscription and confirm what is ticked *before* running a sync.

**3. Expect one long first sync.** The naming rules changed (each movie gets its own
folder, duplicate titles get a `(2)` suffix, episode filenames are shortened), so the
layout signature triggers a single full rebuild of the library. Subsequent syncs are
incremental again.

Then upgrade:

```bash
docker pull mourabena2ui/xtream-to-strm-web:4.2.0
docker rm xtream_app
# re-run the `docker run` command above with the new tag
docker logs -f xtream_app
```

With Docker Compose, change the `image:` tag to `4.2.0` and run:

```bash
docker compose pull && docker compose up -d
```

## Rolling back

The previous images (`v4.1.6`, and the older `4.0.0`) are still on Docker Hub. Stop the container, restore the `db/` backup
you took in step 1, and start the old tag. Note that the library on disk will have been
rewritten in the v4.2.0 layout — the older image will regenerate it in its own layout on the next
sync.

## Building the image yourself

```bash
docker compose up -d --build
```

This uses `Dockerfile.single`: a Node stage builds the frontend, and the Python stage
serves it alongside the API, with Redis and Celery inside the same container.
