# Xtream to STRM

<div align="center">

![Xtream to STRM Logo](frontend/public/Xtreamm-app_Full_Logo.jpg)

**A complete media management platform for Xtream Codes and M3U playlists**  
Generate `.strm` files, download content, and create dynamic M3U playlists for your media server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker Hub](https://img.shields.io/docker/v/mourabena2ui/xtream-to-strm-web?label=Docker%20Hub&logo=docker)](https://hub.docker.com/r/mourabena2ui/xtream-to-strm-web)
[![Docker Pulls](https://img.shields.io/docker/pulls/mourabena2ui/xtream-to-strm-web)](https://hub.docker.com/r/mourabena2ui/xtream-to-strm-web)
[![Version](https://img.shields.io/badge/version-4.5.2-blue.svg)](https://github.com/mourabenapi-ux/xtream-to-strm-web/releases)

</div>

---

## 🌟 Overview

Xtream to STRM is a complete, production-ready media management platform that offers **four powerful modules**:

1. **STRM Generator** - Transform Xtream Codes and M3U playlists into Jellyfin/Kodi-compatible `.strm` and `.nfo` files
2. **Download Manager** - Browse and download media directly to your server with intelligent queue management
3. **Live TV Server** - Generate dynamic M3U playlists from your Xtream subscriptions for IPTV players
4. **Auto-Monitoring** - Automatically detect and download new episodes from monitored series

Built with modern technologies, it provides an intuitive interface for managing your entire media workflow with advanced features like selective synchronization, parallel processing, intelligent metadata generation, and comprehensive administration tools.

## ✨ Key Features

### 🎬 Multi-Source Support
- **Xtream Codes**: Full support for Xtream API with multi-subscription management
- **M3U Playlists**: Import from URLs or file uploads with group-based selection
- **Live TV**: Dynamic M3U playlist generation for IPTV players (VLC, TiviMate, etc.)

### 🎯 Smart Synchronization
- **Parallel Fetching**: High-performance sync with concurrent metadata fetching (async/await)
- **Selective Sync**: Choose specific categories or groups to synchronize
- **Incremental Updates**: Only sync what's changed since last update
- **Dual Control**: Separate sync for Movies and Series
- **Robustness**: Redirect support and improved error handling for Xtream providers

### 📋 Rich Metadata
- **NFO Generation**: Detailed metadata files in Jellyfin format
- **TMDB Integration**: Automatic movie/series information enrichment
- **Smart Folder Structure**: 
  - Movies: `Movie Name {tmdb-ID}` folder support
  - Series: Optional `Season XX` subfolders
- **Configurable Formatting**: Title prefix cleaning, date formatting, and name normalization

### 🎨 Modern Interface
- **Responsive Design**: Works seamlessly on desktop and mobile
- **Real-Time Updates**: Live sync progress and status monitoring
- **Dark Mode**: Beautiful, comfortable viewing experience
- **Intuitive Navigation**: Clean organization with logical menu structure

### 📥 Download Manager
- **Direct Downloads**: Browse and download movies/series directly to your server
- **Smart Queue**: Intelligent download queue with configurable parallel limits
- **Auto-Monitoring**: Watch for new episodes and download automatically
- **Category Monitoring**: Monitor entire series categories for bulk downloads
- **Progress Tracking**: Real-time download progress with speed and ETA

### 📺 Live TV Architecture v2
- **Virtual Bouquets**: Create, rename, and reorder custom bouquets from multiple subscriptions
- **Live Composer**: Powerful drag-and-drop interface for channel organization
- **One-Click Discovery**: Fast category browser for quick channel selection
- **Undo/Redo**: Full history system for all layout and configuration changes
- **Centralized EPG Library** *(New in v4.0.0)*: Define global EPG sources once and link them to any playlist
- **Weighted Auto-Match**: Intelligent channel-EPG pairing using a composite score weighted by source priority
- **Compact Mode**: High-density view toggle for managing large channel lists efficiently
- **Bulk Operations**: Rapidly add, move, or delete hundreds of channels
- **Smart Filtering**: Real-time filtering by channel name, group, or subscription
- **Dynamic M3U Server**: Single, high-performance URL that updates instantly

### 🛠️ Advanced Administration
- **Command Center Dashboard** *(New in v4.0.0)*: Real-time system health, task monitoring, and quick actions
- **Database Management**: Easy reset and cleanup operations
- **File Management**: Bulk delete and reorganization tools
- **NFO Settings**: Customize title formatting with regex patterns
- **Real-Time Logs**: Stream application logs directly in the browser

## 🚀 Quick Start

### Installation from Docker Hub (Recommended)

```bash
docker run -d \
  -p 8000:8000 \
  -v $(pwd)/output:/output \
  -v $(pwd)/db:/db \
  --name xtream-to-strm \
  mourabena2ui/xtream-to-strm-web:4.5.2
```

Available tags: `4.5.2` (pin this in production), `4.5`, `latest`.

Access the web interface at **http://localhost:8000**

> 🔐 **Run it on your LAN only.** The web interface has no authentication, and your
> provider credentials are stored in clear text in the SQLite database under `db/`.
> Do not expose port 8000 to the internet; put it behind a VPN or a reverse proxy with
> its own authentication if you need remote access.

### Using Docker Compose

```yaml
services:
  app:
    image: mourabena2ui/xtream-to-strm-web:4.5.2
    container_name: xtream_app
    environment:
      - TZ=Europe/Paris
    ports:
      - "8000:8000"
    volumes:
      - ./output:/output
      - ./db:/db
    restart: unless-stopped
```

Then start with:
```bash
docker-compose up -d
```

## 📖 Usage

### 1. Add Your Content Source

**For Xtream Codes:**
- Navigate to **XtreamTV** → **Subscriptions**
- Add your subscription details (URL, username, password)
- Configure movie and series output directories

**For M3U Playlists:**
- Navigate to **M3U Import** → **Sources**
- Add source via URL or file upload
- Configure output directory

### 2. Select Content to Sync

**For Xtream:**
- Go to **XtreamTV** → **Bouquet Selection**
- List available categories
- Select categories for movies and/or series

**For M3U:**
- Go to **M3U Import** → **Group Selection**
- Select your source
- Choose groups for movies and/or series

### 3. Synchronize

Click **Sync Movies** or **Sync Series** to generate your files!

### 4. Download Content (Optional)

**Browse and Download:**
- Navigate to **Downloads** → **Media Selection**
- Browse available movies and series
- Add items to download queue
- Monitor downloads in **Download Manager**

**Auto-Monitoring:**
- Go to **Downloads** → **Monitoring**
- Add series or categories to watch
- New episodes download automatically

### 5. Live TV M3U (Optional)

**Generate Your Playlist:**
- Navigate to **Live TV** → **Live Selection**
- Select your subscription
- Click refresh to load bouquets
- Choose categories to include
- Copy or download your M3U URL
- Add URL to your IPTV player

### 6. Configure Your Media Server

Point Jellyfin to the `/output` directory to scan your new content. The generated files follow Jellyfin's naming conventions for optimal recognition.

## 🎛️ NFO Configuration

Customize how titles are formatted in NFO files:

| Setting | Description | Example |
|---------|-------------|---------|
| **Prefix Regex** | Strip language/country prefixes | `FR - Movie` → `Movie` |
| **Format Date** | Move year to parentheses | `Name_2024` → `Name (2024)` |
| **Clean Name** | Replace underscores with spaces | `My_Movie` → `My Movie` |

Access these settings in **Administration** → **NFO Settings**

## 📁 Generated File Structure

```
output/
├── movies/
│   └── Movie Name (2024)/
│       ├── Movie Name (2024).strm
│       └── Movie Name (2024).nfo
└── series/
    └── Series Name/
        ├── Season 01/
        │   ├── S01E01 - Episode Title.strm
        │   └── S01E01 - Episode Title.nfo
        └── tvshow.nfo
```

## 🔧 Technology Stack

- **Backend**: Python 3.11, FastAPI, SQLAlchemy, Celery
- **Frontend**: React 18, TypeScript, Vite, TailwindCSS
- **Infrastructure**: Redis, SQLite
- **Containerization**: Docker (multi-stage build)

## 📝 Version History

### v4.5.2 (Current)

Un `git clone` + `docker build` de ce dépôt ne produisait pas l'image publiée sur
Docker Hub — trouvé en rebuildant v4.5.1 depuis un checkout propre pour vérifier qu'il
ne contenait pas de code en cours d'édition ailleurs sur la machine.

- 🚨 **`backend/app/db/` (la base SQLAlchemy, la session, la migration légataire v2)
  n'avait jamais été suivi par git, depuis le tout début du dépôt public.** `.gitignore`
  excluait `db/` sans l'ancrer à la racine, ce qui a aussi exclu ce dossier de code
  homonyme sous `backend/app/`. Un build local a toujours fonctionné (Docker copie les
  fichiers présents sur le disque, peu importe ce que git suit), donc rien ne le
  laissait deviner : l'image publiée sur Docker Hub le contenait bien, faite depuis une
  copie de travail qui avait le dossier sur disque — mais quiconque clonait le dépôt
  GitHub et construisait l'image lui-même obtenait un conteneur qui plantait au
  démarrage (`ModuleNotFoundError: No module named 'app.db'`). `.gitignore` ancré à la
  racine (`/db/`, `/output/`) ; les 4 fichiers ajoutés à git.

- ✅ 162 tests, tous verts ; conteneur redémarré et testé depuis un clone propre.

### v4.5.1

Trois défauts trouvés en vérifiant que le `public_id` de la v4.5.0 marchait vraiment —
le dernier annule une bonne partie de ce que la v4.5.0 était censée corriger.

- 🔢 **Un id de chaîne M3U pouvait s'auto-corrompre au moment même où on l'ajoutait à un
  groupe.** L'id d'une chaîne issue d'une source M3U est un nombre jusqu'à 19 chiffres ;
  les écrans de navigation/recherche de chaînes le renvoyaient en JSON comme un *nombre*
  plutôt qu'une *chaîne*. Au-delà de 2⁵³, un navigateur ne représente plus un entier
  exactement — il arrondit les derniers chiffres avant de le renvoyer au serveur pour
  l'enregistrer. La chaîne ajoutée pointait alors vers un id qui n'existait nulle part,
  et disparaissait du M3U généré avec la même étiquette trompeuse que le bug de la
  v4.4.1 (`stream_gone_from_provider`), alors que la chaîne était bien présente chez le
  fournisseur. Tous les ids de chaînes/séries/épisodes M3U sont maintenant renvoyés en
  chaîne de caractères.
- 🔗 **Le bouton "Export M3U" de l'écran d'édition, et l'URL EPG affichée dans l'écran de
  configuration EPG, pointaient encore vers l'ancien id numérique** — cassés par le
  passage au `public_id` de la v4.5.0 elle-même. L'aperçu intégré fonctionnait (il
  résout l'id en interne) ce qui rendait le bug difficile à remarquer : tout semblait à
  jour dans l'appli, mais le fichier réellement servi à l'URL ne l'était pas.
- 🩹 **`public_id` — et le réglage "numérotation des chaînes" d'une playlist — étaient
  réinitialisés à *chaque redémarrage du conteneur*, pas seulement à chaque mise à jour.**
  Une migration de recréation de table, datant d'avant l'existence de ces deux colonnes,
  se rejouait sans garde à chaque démarrage avec une liste de colonnes figée qui ne les
  incluait pas — les effaçant à chaque fois, avant que les migrations suivantes ne les
  rajoutent avec une valeur par défaut (nouvel id aléatoire, numérotation désactivée).
  Concrètement, une URL TiviMate collée à la main pouvait se casser au redémarrage
  suivant — exactement ce que le `public_id` de la v4.5.0 devait empêcher. Neutralisée ;
  vérifié sur deux redémarrages consécutifs que `public_id` ne bouge plus.

- ✅ 162 tests, tous verts.

### v4.5.0

L'Auto Organizer parle désormais arabe, et une playlist supprimée-puis-recréée ne détourne
plus l'URL TiviMate d'une autre.

**Organisation automatique : profil arabe (Tunisie + cœur pan-arabe)**
- 🕌 **Nouveau profil "Arabic".** Tunisie en tête (15 chaînes tunisiennes reconnues
  nommément : El Watania 1/2, Nessma, El Hiwar Ettounsi, Attessia, Hannibal, Tunisna,
  Carthage+...), puis Sport / MBC & Rotana / Info / Documentaire / Divertissement /
  Musique / Enfants / Religieux. Pas d'équivalent ARCOM pour les chaînes pan-arabes, donc
  le classement s'appuie sur des règles de catégorie **et** de nom plutôt qu'une liste
  figée — il fonctionne aussi bien sur un abonnement Xtream que sur une source M3U dont les
  catégories n'ont rien à voir (`AR| MBC 4K` chez l'un, `General`/`Entertainment` chez
  l'autre).
- 🐛 **Un bug qui effaçait des chaînes en silence, corrigé avant de construire quoi que ce
  soit dessus.** Le nettoyage de nom ne gardait que `[A-Za-z0-9]` : un nom 100% arabe sans
  chiffre (chaînes musicales par artiste) devenait une chaîne vide et disparaissait comme
  "junk" ; un nom arabe finissant par un chiffre (séries diffusées comme des "chaînes")
  perdait son texte et 26 séries différentes fusionnaient sous la même fausse chaîne "2".
  Mesuré sur le catalogue réel : **225 chaînes récupérées** après correction. Même défaut
  que le reste du projet — succès affiché, données détruites, aucune erreur nulle part.
- 🔤 **Qualités mal reconnues.** `1080i`, `576p`, `360p` (utilisés par les sources M3U type
  iptv-org) n'étaient pas reconnus comme qualité, seulement `1080p`/`720p`/`480p` — le
  texte restait collé au nom et empêchait la fusion avec la chaîne de référence.
- 🏷️ **Faux identifiant EPG filtré.** Huit chaînes tunisiennes sans lien entre elles
  partageaient exactement le même id `"TS"`, un gabarit non renseigné par le fournisseur,
  pas un vrai identifiant.

**Playlists live**
- 🔗 **Un lien TiviMate ne pointe plus jamais vers la mauvaise playlist.** `playlist.m3u`
  et `playlist.xml` utilisaient l'id de base SQLite, qui n'est pas un vrai autoincrement :
  supprimer la playlist la plus récente puis en créer une nouvelle pouvait lui donner le
  même id, et l'ancienne URL collée dans TiviMate se mettait à servir silencieusement une
  playlist complètement différente. Les URLs utilisent maintenant un `public_id` aléatoire,
  généré une fois et jamais réattribué.

- ✅ 161 tests, tous verts.

### v4.4.1

Correctif : deux défauts silencieux du côté M3U, qui faisaient disparaître des chaînes
sans jamais rien signaler.

- 🆔 **Une chaîne M3U garde son identifiant d'une lecture à l'autre.** Elle était nommée
  par la clé primaire de sa ligne en base — et chaque relecture du playlist (toutes les
  heures) supprimait puis réinsérait toutes les lignes, donc renumérotait tout le
  catalogue. Toute playlist live construite sur une source M3U pointait une heure plus
  tard vers des lignes qui n'existaient plus : le M3U généré sortait **vide**, et le
  rapport de validation accusait le fournisseur (`stream_gone_from_provider`). Les
  identifiants sont maintenant dérivés de la source et de l'URL de la ligne. Effet de
  bord réparé au passage : chaque série M3U semblait modifiée à chaque sync et était
  réécrite pour rien.
- 🩺 **Réparation des playlists existantes** : `backend/migrations/repair_m3u_playlist_ids.py`
  recale les chaînes orphelines par tvg-id puis par nom, uniquement sur correspondance
  unique. Simulation par défaut, `--apply` pour écrire.
- 📺 **Une chaîne suivie d'une directive n'est plus jetée au parsing.** Le parseur lisait
  la ligne suivant `#EXTINF` comme l'URL et abandonnait l'entrée si elle commençait par
  `#` — donc toute chaîne accompagnée d'un `#EXTVLCOPT`, `#KODIPROP`, `#EXTGRP` ou
  `#EXTHTTP`. Sur la playlist française d'iptv-org : 430 entrées lues sur 459 réelles,
  TF1 parmi les absentes.
- 🔤 **Le nom d'une chaîne n'est plus coupé par une virgule d'attribut.** Il était pris à
  la première virgule de la ligne, alors qu'un `http-user-agent` contient toujours
  `(KHTML, like Gecko)`. Le nom démarre désormais à la première virgule hors guillemets,
  ce qui préserve aussi les virgules appartenant vraiment au nom.
- ✅ 159 tests, dont 11 nouveaux qui épinglent ces deux comportements.

### v4.4.0

La plus grosse version depuis la 4.0 : les sources M3U et Xtream ne sont plus deux
applications qui se ressemblent, et trois fonctions demandées arrivent en même temps.

**Une seule notion de source**
- 🔗 **M3U et Xtream sont enfin la même chose.** Il y avait deux tables, deux syncs, deux
  écrans de sélection et deux jeux de bugs. Il n'y a plus qu'un modèle `Source` lu à
  travers un adaptateur de catalogue : le sync, les téléchargements, l'EPG et la
  résolution live ne demandent plus de quel type est la source. Ajouter un format, c'est
  écrire un adaptateur — plus jamais un `if` dans un appelant.
- 🧾 **Le côté M3U hérite de tout ce qu'il n'avait jamais eu** : statut partiel, signature
  de layout, garde-fou catalogue vide, barre de progression, comptage des échecs par
  élément, balayage protégé — et surtout, ses deux `rmtree` non protégés ont disparu.
- 📺 **Les chaînes live d'une M3U ne sont plus jetées au parsing.** L'ancienne contrainte
  n'acceptait que MOVIE/SERIES.
- 🎞️ **Une série M3U devient vraiment des saisons et des épisodes**, déduites du titre, au
  lieu d'un dossier par épisode. ⚠️ Le premier sync d'une source M3U contenant de la VOD
  réécrit sa bibliothèque dans la nouvelle arborescence.
- 🖥️ Un seul écran *Sources* (identifiants, URL de playlist ou fichier envoyé) et un seul
  écran de sélection. La section M3U du menu disparaît.

**Organisation automatique des chaînes**
- 🪄 **Nouvel écran *Auto Organizer*** (`/live-organizer`) : il lit vos catégories, retire
  les entrées parasites, normalise les noms, fusionne les variantes d'une même chaîne et
  propose une organisation complète. `Prévisualiser` n'écrit rien ; `Appliquer` crée une
  **nouvelle playlist**, jamais une modification sur place.
- 📚 Deux profils de référence (508 chaînes françaises, numérotation TNT) : `detailed` en
  11 blocs, `compact` en 8. Sur un catalogue réel : 2 114 chaînes, 9 bouquets, **plus rien
  dans la file d'attente**, 392 chaînes avec un guide.
- 🛟 Les variantes en double ne sont pas perdues : elles vont dans un groupe *Secours /
  Alternatives*. Les flux décalés (`+1`) ont leur propre groupe et ne volent jamais le
  numéro de la chaîne d'origine.
- 🔢 **La M3U publie enfin `tvg-chno`**, donc TiviMate respecte votre ordre au lieu de
  renuméroter lui-même. Activable par playlist (`use_channel_numbers`) — les playlists
  existantes gardent leur comportement.
- 🐛 **Corrigé : sept chaînes étaient diffusées sous le nom d'une autre.** Des alias de la
  référence pointaient vers des chaînes déjà listées séparément (les OCS, Comédie+) ; la
  première insérée capturait le nom et les autres devenaient injoignables. Un contrôle
  automatique interdit désormais ce cas.
- 🐛 **Corrigé : une playlist pouvait servir une M3U vide sans la moindre erreur** — un
  groupe virtuel exigeait un abonnement sur le bouquet alors que chaque chaîne porte le
  sien.

**Replay (catch-up)**
- ⏪ **Les informations de replay survivent jusqu'au lecteur.** `catchup`, `catchup-days`,
  `catchup-source` et les anciens `tvg-rec` / `timeshift` sont lus, stockés et réémis.
  Le catalogue renvoyait un `0` en dur, ce qui détruisait l'information avant que quoi que
  ce soit puisse s'en servir.
- 🚫 **Rien n'est inventé** : les balises d'une source M3U sont recopiées telles quelles,
  une source Xtream reçoit `catchup="xc"`, et une source qui ne déclare rien ne reçoit
  aucune balise. `/validation` indique maintenant le nombre de chaînes avec replay.

**Correction manuelle des identifiants TMDB**
- 🎯 **Nouvel écran *TMDB Fixes*** (`/tmdb-fixes`) : quand un film est associé à la mauvaise
  fiche, vous imposez le bon identifiant. La correction bat le catalogue *et* la fiche
  détaillée du fournisseur, et elle décide du nom de dossier.
- 💾 Les corrections vivent dans leur propre table, pas dans les caches : un cache est vidé
  dès qu'un fournisseur cesse de lister un titre, une correction ne doit pas s'évaporer
  avec lui. Un identifiant vide est une réponse valable (« pas de fiche TMDB ») ; supprimer
  la ligne rend la main au fournisseur.
- 📥 Les téléchargements passent par le même service, donc le fichier et son `.strm`
  atterrissent dans le même dossier `{tmdb-…}`.

**Qualité**
- ✅ 145 tests, tous verts, dont la toute première couverture de la résolution des
  playlists live et 38 tests sur le moteur d'organisation.
- 🗃️ Migrations 006 à 009 appliquées automatiquement au démarrage.

### v4.3.0

- 📊 **The sync now shows how far it has got.** A run spends most of its time in its
  per-item loop, and a spinner said nothing about whether that was 3 titles or 3 000. Both
  the Xtream and the M3U sync publish a phase and a counter — reading the catalogue,
  removing deselected entries, writing files (`n / total`), sweeping the library — rendered
  as a progress bar on the selection screens and reflected in the dashboard's active-task
  list. Until the item count is known the bar is deliberately indeterminate rather than
  showing a fake 0 %. The counters are cleared when a run ends, fails or is stopped, so a
  finished sync never leaves a bar frozen at 87 %.
- 🗃️ The three progress columns are added to `sync_state` and `m3u_sync_state` automatically
  on first start; no manual migration.

### v4.2.1

A download-queue fix release. Both defects were reproduced against a live provider and a
real 2.9 GB file before being fixed, and the fix was verified by a full download that
finished at exactly the announced byte count.

- 🔁 **Fixed: a download restarted from zero at 99 % and never finished.** The byte counter
  lived on the ORM row while the pause check called `db.refresh()` every 5 seconds, which
  reloaded that row and discarded everything counted since the last commit — about 90 MB
  lost over a 2.9 GB film. A complete file was therefore declared truncated, and the retry
  started it over. The total is now counted locally and completeness is judged from the
  file on disk.
- 📂 **Fixed: retries landed in a different folder, so nothing ever resumed.** The target
  path is rebuilt from provider metadata on each attempt, and a failed category lookup sent
  the retry somewhere else, leaving the partial file unfindable. `save_path` is now recorded
  when the download *starts*, and an earlier attempt's bytes are carried over to the new
  target.
- 🎬 **Fixed: series downloads never started (HTTP 551).** Episodes are not in the local
  cache and nothing asked the provider, so every episode URL was built as `.mp4` while the
  provider served `.mkv`. The browse response's real container is now sent when queueing,
  and a 551 makes the task probe the other containers, correct the URL and rename the
  target accordingly.
- 🚦 **Sequential mode is now really sequential.** A retry went straight to the worker
  without passing the slot check, so two downloads ran at once against providers that allow
  one connection — which is what produced the 551s and the mid-stream cuts. The queue is
  also FIFO again: the sort reversed the creation date as well as the priority, so the
  newest item jumped ahead and the first ones were never served.
- 🩹 **HTTP 416 no longer trusts `HEAD`.** The remote size is read from a one-byte ranged
  `GET`; when it cannot be established the task fails loudly instead of truncating a
  finished file and starting again.

### v4.2.0

A hardening release. Every item below was reproduced against a live provider, a real
149 MB XMLTV guide and a 3 700-item library, then re-verified after the fix.

> ⚠️ **Two behaviour changes to read before upgrading** — see *Upgrading to v4.2.0* below.

**Sync & library generation**
- 🧨 **Fixed: an empty bouquet selection synced the entire catalogue.** Clearing every tick box skipped the category filter instead of applying it, walking 178 434 movies / 38 547 series. The filter is now applied unconditionally, and an empty selection means *nothing selected* — the generated library for that type is removed.
- 🧨 **Fixed: a provider returning an empty catalogue wiped the library.** An empty response is now treated as a provider fault, not as "the user removed everything".
- ♻️ **Deletion is disk-driven, not database-driven.** Rebuilding paths from cached names left orphans behind forever when a provider renamed a title. A post-sync sweep now removes any unaccounted `.strm`/`.nfo` under the library and prunes empty folders. A series that was not reprocessed, and any item whose refresh *failed*, keep their files untouched.
- 🔢 **Duplicate catalogue entries no longer overwrite each other.** Same-name entries become `Title`, `Title (2)`, `Title (3)`, ranked by sorted `stream_id` so names stay stable across syncs.
- 📺 **Ongoing series now gain their new episodes.** Episodes were only re-fetched when the series *name* changed. A provider `last_modified` stamp plus an age fallback (`SERIES_REFRESH_HOURS`, default 12) now drive the refresh.
- 🧩 **Fixed: `"info": []` aborted every series at episode 2.** 89 of 98 episodes were lost on providers sending that shape.
- ✂️ **Cleaner episode filenames** — `S01E01 - AMZ - Show - S01E01 - EPISODE ONE.strm` is now `S01E01 - EPISODE ONE.strm`.
- 📁 **Every movie gets its own folder**, instead of untagged titles landing loose in the library root.
- 🔏 **A layout signature forces a one-time rebuild** when the naming or folder rules change, so a settings change no longer leaves the library in its old shape.
- ✅ **Honest sync reporting**: a new `partial` status, counts of what was actually written (not of the to-do list), stale error messages cleared on a clean run, and the message finally rendered in the UI.
- 🔄 **A sync killed mid-flight no longer stays `running` forever** — leftover rows are reconciled to `failed` at startup.

**EPG / TiviMate**
- 📡 **The provider's native XMLTV guide is implemented** (`xmltv.php`) — it was a bare `pass`. Verified at 66 MB / 4 441 channels. The UI never renders the real URL, which carries the password.
- 🕐 **EPG timezone fixed.** Source offsets are honoured instead of stripped, and emitted timestamps are real UTC rather than local time labelled `+0000`.
- ▶️ **The now-playing slot was always empty** — the query excluded the programme currently on air and started the guide at the next one.
- 🎯 **Auto-match rewritten.** Two channels could claim one EPG id, a fuzzy fallback matched any short name inside any longer one, and the final score gate was mathematically unreachable. Now: exact match on the provider's declared `epg_channel_id` first, strict thresholds, and a greedy 1:1 assignment. Measured on a real 785-channel guide: 12/15 → **15/15**.
- 🗺️ **One resolver for M3U, guide and validation.** The M3U advertised `tvg-id`s the guide never described; one playlist went from 1 described channel to 11.
- 📊 **The XMLTV generator picks a source that actually has programmes**, not merely the first that lists the channel. Verified: 0 → 219 programmes.
- 🏷️ **`tvg-id="None"` eliminated**, and `x-tvg-url` is now absolute.

**Downloads**
- 🎞️ **Fixed: the `.mp4` extension was hardcoded**, which failed every download on providers serving `.mkv`.
- 🧊 **Frozen download queue fixed** with a Redis heartbeat — a dead download frees its slot in ≤ 5 min instead of 1 h.
- 📉 **Silent truncation fixed**: a mid-stream cut now resumes via HTTP `Range`, and a size guard runs before marking a download complete. Verified on a 3.4 GB file cut at 102 MB.
- 🗂️ **NFOs are written for downloads too** (movie NFO, `tvshow.nfo` + episode NFO), and each subscription gets its own download subfolder so two providers cannot collide.
- 🔎 **Paginated browse**: initial load went from 28 MB to 26 KB.

**Stability & UI**
- 🧠 **EPG memory leak fixed** — streaming `iterparse` plus worker recycling. Workers: ~1.5 GB → ~93 MB; container 3.67 GB → 876 MB.
- 🩺 **All six dashboard endpoints were hard 500s** (they read model fields that never existed) and are now correct, including live in-progress task counts.
- 🛡️ **Data-loss hazard removed**: all deletions go through a single guarded helper, with protected roots that the sweeper never enters.
- 🔔 **Toast + typed-confirmation system** across the app; every native `alert()`/`confirm()` removed. Destructive actions require typing the confirmation word.
- 🖥️ Log viewer pause actually pauses, with level filters and search; dead dashboard links repaired; renames survive a channel move; M3U upload keeps its directory fields.

### Upgrading to v4.2.0

1. **Back up `db/` before upgrading.** The container adds columns on first start.
2. **An empty bouquet selection now deletes.** Previously it synced everything. If any subscription has no bouquet ticked, tick what you want *before* the first sync on v4.2.0.
3. **The first sync rebuilds the whole library once.** The naming rules changed (per-movie folders, duplicate suffixes, cleaner episode titles), so the layout signature triggers one full regeneration. Expect a long first run; subsequent runs are incremental.

### v4.1.1 – v4.1.6

Docker Hub image republishes only — same application code as v4.0.0, no functional change.
The `latest` tag published on 2026-02-19 added `ffmpeg` to the image (used as the download
fallback), which is why it is larger than the `v4.1.x` tags.

### v4.0.0
- 🌐 **Global EPG Library**: Centralized EPG source management — define once, link to any playlist
- 🔗 **Playlist-EPG Linking**: Link multiple XMLTV sources to a playlist with drag-and-drop priority
- 🤖 **Weighted Auto-Match**: Intelligent channel pairing using composite scoring weighted by source priority
- 🔄 **Background EPG Refresh**: Configurable auto-refresh intervals with Celery-beat scheduling
- 📊 **Command Center Dashboard**: Complete redesign with hero stats, system health, active task monitor, and quick actions
- 🗜️ **Compact Mode**: High-density toggle for the Live Selection page — smaller rows, hidden secondary info, more channels visible
- 🧭 **Restructured Navigation**: Sidebar reorganized into logical "to STRM", "Management", and "System" sections
- 🗄️ **Data Migration**: Automated migration script to convert legacy per-playlist EPG data to the new global architecture
- 🐞 **Stability**: Fixed TypeScript build errors and improved API error handling

### v3.9.1
- ✍️ **Inline Rename**: Click directly on a channel name in the Composite List to rename it instantly
- 🔢 **Jump to Position**: Type a position number to instantly reorder a channel within a bouquet
- 🎯 **Drag-and-Drop Validation**: Ensured no conflicts between inline editing and sortable interactions

### v3.8.0
- ⚡ **Virtual Scrolling**: Integrated `react-window` for buttery-smooth rendering of 10,000+ channel lists
- 📄 **Paginated API**: Backend streams endpoint returns paginated results for reduced memory usage
- 🔁 **Incremental Sync**: Only changed content is re-synced, dramatically reducing sync time
- 🧠 **Redis Caching**: Xtream metadata cached in Redis for faster repeat access

### v3.7.1
- 🗜️ **Collapsible Panels**: Source Explorer and Virtual Groups panels can be collapsed to give the Composite List more space
- 📐 **Multi-Column Layout**: Composite List dynamically switches to 2 or 3 columns when panels are collapsed
- ♻️ **Auto-Save Indicator**: Replaced the manual "Save" button with an automatic persistence indicator
- 🔄 **Reset Confirmation**: Improved reset dialog with explicit warnings about data loss
- 📡 **EPG Page Access**: Added a playlist selector for direct EPG access without requiring Live Selection context

### v3.7.0
- 🚀 **Live TV v2**: Complete architectural overhaul with high-performance virtual bouquets
- ✍️ **Customization**: Rename and reorder channels with a persistent custom order
- 🔄 **Undo/Redo System**: Integrated history management for all Live TV operations
- 📁 **Bouquet Composer**: Modern split-pane UI for rapid channel organization
- 📡 **Multi-Source EPG**: Support for multiple XMLTV sources with full management UI
- ⚡ **Performance Ops**: 3x faster API synchronization and elimination of redundant redirects
- 🐞 **Stabilization**: Fixed critical 422/500 bulk delete and 404 rename errors

### v3.1.0
- 📺 **Live TV Module**: New dedicated module for managing Live TV channels from Xtream subscriptions
- 🎯 **Bouquet Management**: Select specific bouquets and exclude individual channels
- 📡 **Dynamic M3U Server**: Generate personalized M3U playlists with a single URL
- 🔧 **Pydantic Schemas**: Improved API serialization for better performance and reliability
- 🛠️ **XtreamClient Enhancement**: Added async methods for Live TV categories and streams
- 📱 **Live Selection UI**: New split-pane interface for managing bouquets and channels

### v3.0.4 (Hotfix)
- 💉 **Engine-Level Schema Healing**: Replaced external SQL scripts with native SQLAlchemy inspection. The application now automatically detects and adds missing columns on startup using its internal engine.
- 🩺 **Ultimate Reliability**: Final resolution for the `no such column` errors reported by users upgrading from v2.6.x.

### v3.0.3 (Hotfix)
- 🛡️ **Definitive Migration Fix**: Combined import-based and subprocess-based migration triggers for absolute reliability.
- 🩺 **Schema Verification**: Added a startup check that verifies the existence of critical columns and logs clear error messages if issues persist.
- 📦 **Package Support**: Added `__init__.py` to migrations to fix Python package resolution issues.

### v3.0.2 (Hotfix)
- 🧪 **Migration Stability**: Integrated database migration triggers directly into `main.py` for guaranteed execution across all environments.
- 🔧 **Path Resolution**: Robust database path discovery in migration scripts (supports relative and absolute paths).

### v3.0.1 (Hotfix)
- 🔧 **Database Migration**: Added automated SQL migration system to handle schema updates for existing users (fixing `no such column` errors).
- 🐳 **Docker Startup**: Improved `docker_start.sh` to apply migrations before starting the application.

### v3.0.0
- ✨ **Introduced Download Module**: New system to browse and download media directly to your server.
- ✨ **Auto-Download Monitoring**: Monitor movies, series, and **series categories** for new automatic downloads.
- ✨ **Intelligent Queue**: Optimized download queue with strict `max_parallel_downloads` enforcement and bulk-add performance.
- 🔧 **Enhanced Path Resolution**: Better folder structure (Category/Series/Season) and direct Xtream API fallback for metadata.
- 🔧 **Sanitization**: Improved title cleaning to handle separators and country prefixes.
- 🛠️ **Deep Analysis**: Refined various backend components for better concurrency and data type consistency.

### v2.6.1 (Latest)
- 🌍 **Timezone Support**: Added full support for local server time via `TZ` environment variable (default: `Europe/Paris`).
- 🕒 **Core Engine**: Migrated all backend logic from UTC to local time for accurate task scheduling and logging.
- 🎨 **UI Fix**: Implemented `formatDateTime` to prevent browser timezone shifts, ensuring consistency between server logs and dashboard.
- 🐳 **Docker**: Optimized container startup and environment configuration for timezone persistence.

### v2.6.0
- ✨ **Performance**: Parallel fetching engine with **configurable concurrency settings** via UI.
- ✨ **Logs**: New real-time log streaming interface for live monitoring.
- ✨ **Metadata**: TMDB ID folder support `Movie {tmdb-ID}` for perfect matching.
- ✨ **Series**: Configurable Season folders & Episode filename formatting.
- 🔒 **Security**: Switched to non-root container user (`appuser`) and added protected routes.
- 🛠️ **Admin**: Granular Cache Clearing tools & Smart Database Reset (preserves settings).
- 🐞 Fixed redirect handling for IPTV providers and corrected hardcoded versioning.

### v2.5.0
- ✨ Enhanced NFO title formatting options
- ✨ Configurable regex for prefix stripping
- ✨ Date formatting at end of titles
- ✨ Name cleaning (underscore replacement)
- 🎨 New application logo
- 🐛 Fixed config endpoint routing
- 🐛 Improved M3U sync with NFO generation

### v2.0.0
- ✨ Added M3U playlist support
- ✨ Refactored UI structure
- ✨ Split sync controls for Movies/Series
- 🎨 Enhanced dashboard and navigation

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/mourabenapi-ux/xtream-to-strm-web/issues)
- **Docker Hub**: [mourabena2ui/xtream-to-strm-web](https://hub.docker.com/r/mourabena2ui/xtream-to-strm-web)

## ☕ Support This Project

If you find this project helpful, consider supporting its development!

<a href="https://www.buymeacoffee.com/mourabena" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

Your support helps maintain and improve this project. Thank you! 🙏

---

<div align="center">

**Made with ❤️ for the Jellyfin and Kodi community**

[Docker Hub](https://hub.docker.com/r/mourabena2ui/xtream-to-strm-web) • [GitHub](https://github.com/mourabenapi-ux/xtream-to-strm-web)

</div>
