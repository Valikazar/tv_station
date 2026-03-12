# 📺 TV Station Playout System

A self-hosted, multi-channel TV playout and broadcast management system. Schedule and broadcast video content over UDP multicast (MPEG-TS) or RTP, manage ad slots, monitor receivers, and control everything from a web UI — all without commercial software.

---

## ✨ Features

- **Multi-channel playout** — run independent channels, each with its own schedule, bitrate, and multicast address
- **Smart playlist generation** — fills the broadcast day automatically based on configurable time slots and video inventory
- **Web management UI** — schedule ads, manage channels, monitor health, view playback reports
- **Raspberry Pi receivers** — stateless agents discover the server automatically via UDP broadcast and switch channels on command
- **Docker-based pipeline** — each channel runs in isolated containers (FFmpeg playout + TSDuck TS muxer + SDT beacon)
- **HLS side-stream** — simultaneous in-browser preview via RAM-backed HLS (`/dev/shm`)
- **Real-time receiver dashboard** — see CPU, temperature, traffic speed, and stream URL for every connected RPi
- **Bilingual UI** — English / Russian interface

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SERVER (Linux/x64)                        │
│                                                                   │
│  ┌──────────────┐    ┌──────────────────────────────────────┐    │
│  │  MariaDB     │◄───│  tv_site  (Node.js / TypeScript)     │    │
│  │  (tv_stats)  │    │  • Web UI  (EJS)                     │    │
│  └──────────────┘    │  • REST API                          │    │
│                       │  • Session auth (bcrypt)             │    │
│                       │  • Docker orchestration              │    │
│                       │  • UDP discovery service :5555       │    │
│                       └────────────────┬─────────────────────┘    │
│                                        │ Docker API               │
│                       ┌────────────────▼─────────────────────┐   │
│  Per channel (×N):    │  tv_playout_ch_N  (Python container) │   │
│                       │  • generate_playlist.py              │   │
│                       │  • playout.py → FFmpeg feeder → FIFO │   │
│                       │  • Master FFmpeg → UDP + HLS         │   │
│                       └────────────────┬─────────────────────┘   │
│                                        │ UDP :10000+N             │
│                       ┌────────────────▼─────────────────────┐   │
│                       │  tv_tsduck_ch_N  (TSDuck container)  │   │
│                       │  • PCR regulation                    │   │
│                       │  • SDT injection (server URL)        │   │
│                       │  • Multicast output                  │   │
│                       └────────────────┬─────────────────────┘   │
│                                        │ UDP Multicast            │
│                       ┌────────────────▼─────────────────────┐   │
│                       │  tv_beacon_*  (TSDuck container)     │   │
│                       │  • Null TS → SDT → Multicast :5004   │   │
│                       └──────────────────────────────────────┘   │
└───────────────────────────────────┬─────────────────────────────┘
                                    │ LAN (UDP Multicast)
        ┌───────────────────────────▼──────────────────────────┐
        │              Raspberry Pi Receivers                   │
        │  • receiver_agent.py discovers server via :5555      │
        │  • MPV plays assigned multicast stream               │
        │  • Reports CPU/temp/traffic every 10 s               │
        └──────────────────────────────────────────────────────┘
```

---

## 📁 Repository Structure

```
tv_station/
├── Dockerfile                  # tv_site Node.js container
├── Dockerfile.tsduck           # TSDuck base image (muxer + beacon)
├── docker-compose.yml          # Orchestration (MariaDB + tv_site + base images)
├── nginx.conf                  # Nginx main config (for host nginx)
├── nginx_site_config           # Nginx virtual host config (reverse proxy)
├── .env.example                # Environment variable template
├── receiver_agent.py           # Raspberry Pi receiver agent
├── add_user.js                 # CLI tool: add a new user
├── generate_hash.js            # CLI tool: generate bcrypt password hash
│
├── Scripts/
│   ├── Dockerfile.playout      # tv_playout Python base image
│   ├── playout_entrypoint.sh   # Container startup: FIFO → Master FFmpeg → playout.py
│   ├── playout.py              # Feeder: reads DB schedule, streams files into FIFO
│   ├── generate_playlist.py    # Generates today's/tomorrow's playlists from DB slots
│   ├── init_playlist_db.py     # One-time DB schema initializer (legacy helper)
│   └── ffmpeg_watchdog.sh      # Legacy watchdog (superseded by Docker restart policy)
│
└── src/                        # Node.js / TypeScript application
    ├── app.ts                  # Express app entry point
    ├── config/db.ts            # MariaDB connection pool
    ├── i18n/                   # Translation strings (en / ru)
    ├── routes/
    │   ├── adRoutes.ts         # Ad video management
    │   ├── adminRoutes.ts      # Admin panel (slots, channels, settings)
    │   ├── channelRoutes.ts    # Channel CRUD
    │   ├── healthRoutes.ts     # Container health & log viewer
    │   ├── receiverRoutes.ts   # Receiver dashboard & command API
    │   ├── reportRoutes.ts     # Playback statistics & Excel/PDF export
    │   └── watchRoutes.ts      # In-browser HLS preview
    ├── services/
    │   ├── dockerService.ts    # Docker Engine API client (containers lifecycle)
    │   └── statsService.ts     # Playback stats aggregation
    └── utils/
        ├── timeSlots.ts        # Time slot management & DB cache
        ├── adMapping.ts        # Ad-to-slot assignment helpers
        └── actionLogger.ts     # Admin action audit log
```

---

## 🚀 Quick Start

### Prerequisites

- Linux host (Ubuntu 22.04 / 24.04 recommended) with Docker & Docker Compose v2
- Network interface with a static IP on the LAN where receivers live
- `ffmpeg` and `nginx` installed on the host (for HLS preview; or run fully in Docker)

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/tv_station.git
cd tv_station
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env          # set DB passwords, server IP, etc.
```

### 3. Prepare media directories

```bash
mkdir -p media/new_ads media/ads/fallback
# Copy your fallback video:
cp /path/to/fall.mp4 media/ads/fallback/fall.mp4
```

### 4. Build and start

```bash
docker compose up -d --build
```

### 5. Create the first user

```bash
node add_user.js
```

### 6. Open the web UI

Navigate to `http://<server-ip>:3000` (or port 80 via nginx reverse proxy).

---

## 🔧 Environment Variables

See [.env.example](.env.example) for a fully annotated template.

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `mariadb` | MariaDB hostname (container name) |
| `DB_NAME` | `tv_stats` | Database name |
| `DB_USER` | `logger` | Database user |
| `DB_PASS` | `password` | Database password |
| `MYSQL_ROOT_PASSWORD` | — | MariaDB root password |
| `SESSION_SECRET` | — | Express session secret (change in production!) |
| `ADDR` | `172.16.88.223` | Server LAN IP (used in SDT beacon & UDP discovery) |
| `ADS_BASE_PATH` | `/opt/tv_station/media/ads/` | Base path for ad files |

---

## 📖 Documentation

| Document | Description |
|---|---|
| [docs/COMPONENTS.md](docs/COMPONENTS.md) | Detailed description of every component |
| [docs/DOCKER.md](docs/DOCKER.md) | Docker images, containers, volumes, networking |
| [docs/RASPBERRY_PI_SETUP.md](docs/RASPBERRY_PI_SETUP.md) | Step-by-step RPi 4/5 receiver setup guide |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Web server / API | Node.js 20 + Express 5 + TypeScript |
| Templating | EJS |
| Database | MariaDB 10.6 |
| Video encoding | FFmpeg |
| TS muxing / SDT | TSDuck (`tsp`) |
| Containerization | Docker + Docker Compose v2 |
| Reverse proxy | Nginx |
| Receiver OS | Raspberry Pi OS Lite (64-bit) |
| Receiver player | MPV |
| Receiver agent | Python 3.11 |

---

## 📜 License

MIT
