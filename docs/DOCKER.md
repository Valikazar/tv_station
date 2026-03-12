# Docker Reference

This document describes every Docker image and container used in the TV Station Playout System, their configuration options, volumes, networking, and operational notes.

---

## Table of Contents

1. [Images Overview](#1-images-overview)
2. [Image Details](#2-image-details)
   - [tv_site (Node.js web app)](#tv_site--nodejs-web-app)
   - [tv_station-tv_playout (Playout engine)](#tv_station-tv_playout--playout-engine)
   - [tv_station-tsduck_ch2 (TSDuck muxer/beacon)](#tv_station-tsduck_ch2--tsduck-muxerbeacon)
   - [mariadb:10.6 (Database)](#mariadb106--database)
3. [Runtime Containers](#3-runtime-containers)
   - [tv_db (MariaDB)](#tv_db--mariadb)
   - [tv_site (Web app)](#tv_site--web-app)
   - [tv_playout_ch_N (Per-channel playout)](#tv_playout_ch_n--per-channel-playout)
   - [tv_tsduck_ch_N (Per-channel muxer)](#tv_tsduck_ch_n--per-channel-muxer)
   - [tv_beacon_* (SDT beacon)](#tv_beacon_--sdt-beacon)
4. [docker-compose.yml Explained](#4-docker-composeyml-explained)
5. [Volumes](#5-volumes)
6. [Networking](#6-networking)
7. [Environment Variables](#7-environment-variables)
8. [Container Lifecycle](#8-container-lifecycle)
9. [Logs](#9-logs)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Images Overview

| Image Name | Base | Built By | Role |
|---|---|---|---|
| `tv_site` | `node:20-slim` | `Dockerfile` | Node.js web app + REST API |
| `tv_station-tv_playout` | `python:3.11-slim` | `Scripts/Dockerfile.playout` | FFmpeg playout feeder + Master FFmpeg |
| `tv_station-tsduck_ch2` | `ubuntu:24.04` | `Dockerfile.tsduck` | TSDuck TS muxer, SDT broadcaster, beacon |
| `mariadb:10.6` | Official image | Docker Hub | Database |

---

## 2. Image Details

### `tv_site` — Node.js web app

**Dockerfile:** `./Dockerfile`

```dockerfile
FROM node:20-slim

WORKDIR /opt/tv_station/tv_site

RUN apt-get update && apt-get install -y curl ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
```

**Why `ffmpeg` in this image?**  
The web app uses `ffprobe` (bundled with `ffmpeg`) to probe the duration of uploaded video files. It does **not** do any encoding itself.

**Build context:** `./tv_site/` (the application source directory).

---

### `tv_station-tv_playout` — Playout engine

**Dockerfile:** `Scripts/Dockerfile.playout`

```dockerfile
FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg tzdata procps && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir mysql-connector-python

COPY Scripts/playout.py /app/playout.py
COPY Scripts/generate_playlist.py /app/generate_playlist.py
COPY Scripts/playout_entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /app
ENTRYPOINT ["/app/entrypoint.sh"]
```

**Packages installed:**
- `ffmpeg` — video encoding (feeder) and muxing (master)
- `tzdata` — correct timezone handling for playlist scheduling
- `procps` — `pgrep`, `pkill` for process management in the entrypoint
- `mysql-connector-python` — MariaDB client for Python

**Built as a build-only service** in `docker-compose.yml` (no `ports`, `restart: "no"`) so the image exists for the web app to reference when creating runtime containers via the Docker API.

---

### `tv_station-tsduck_ch2` — TSDuck muxer/beacon

**Dockerfile:** `./Dockerfile.tsduck`

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y curl inotify-tools pciutils libc6-dev sudo pcscd libpcsclite1 \
    libedit2 libsrt-gnutls-dev librist-dev srt-tools uuid-dev procps && \
    curl -sLo /tmp/tsduck.deb https://github.com/tsduck/tsduck/releases/download/v3.43-4549/tsduck_3.43-4549.ubuntu24_amd64.deb && \
    apt-get install -y /tmp/tsduck.deb && \
    rm /tmp/tsduck.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["tsp"]
```

**TSDuck version:** v3.43-4549 (Ubuntu 24.04 / amd64)  
**Entrypoint:** `tsp` — the TSDuck Transport Stream Processor. All runtime arguments are passed as `Cmd` via the Docker API.

> ⚠️ **Architecture note:** This image is compiled for `amd64` only. It will **not** run on ARM hosts. The server must be an x86-64 machine.

---

### `mariadb:10.6` — Database

Official MariaDB Docker image. No custom Dockerfile — configured entirely via environment variables in `docker-compose.yml`.

**Healthcheck:** Uses the built-in `healthcheck.sh --connect --innodb_initialized` script included in the official image.

---

## 3. Runtime Containers

### `tv_db` — MariaDB

| Property | Value |
|---|---|
| Image | `mariadb:10.6` |
| Container name | `tv_db` |
| Restart policy | `always` |
| Port | `3306:3306` |
| Volume | `./mariadb_data:/var/lib/mysql` |
| Network | `tv_network` (bridge) |
| Healthcheck | `healthcheck.sh --connect --innodb_initialized` every 10 s |

---

### `tv_site` — Web app

| Property | Value |
|---|---|
| Image | Built from `./Dockerfile` |
| Container name | `tv_site` |
| Restart policy | `always` |
| Ports | `3000:3000` (HTTP API/UI), `5555:5555/udp` (UDP discovery) |
| Network | `tv_network` (bridge) |
| Healthcheck | `curl -f http://localhost:3000/login` every 15 s |

**Volumes mounted into `tv_site`:**

| Host Path | Container Path | Purpose |
|---|---|---|
| `./media` | `/opt/tv_station/media` | Video assets (ads, fallback) |
| `./uploads_temp` | `/opt/tv_station/tv_site/uploads_temp` | Temporary upload staging |
| `./logs` | `/opt/tv_station/tv_site/logs` | Application log files |
| `/var/run/docker.sock` | `/var/run/docker.sock` (read-only) | Docker Engine API access |
| `/dev/shm` | `/dev/shm` (read-only) | Read HLS/log files from RAM |

> **Security note:** Mounting `/var/run/docker.sock` grants the container full control over the Docker daemon. This is required for dynamic container management (starting/stopping playout per channel). Ensure the server is not publicly accessible.

---

### `tv_playout_ch_N` — Per-channel playout

Created **dynamically** by the web app via the Docker API when a channel is started. Not defined in `docker-compose.yml`.

| Property | Value |
|---|---|
| Image | `tv_station-tv_playout` |
| Container name | `tv_playout_ch_N` (e.g. `tv_playout_ch_1`) |
| Restart policy | `always` |
| Network mode | `host` (required for multicast and FIFO access) |

**Environment variables passed at runtime:**

| Variable | Description |
|---|---|
| `CHANNEL_ID` | Channel number |
| `DB_HOST` | MariaDB host (127.0.0.1 in host network mode) |
| `DB_NAME`, `DB_USER`, `DB_PASS` | Database credentials |
| `MEDIA_DIR` | Path to ad video files (`/media/new_ads/`) |
| `FFMPEG_BITRATE_K` | Video bitrate in kbps |
| `OUTPUT_PROTOCOL` | `udp` or `rtp` |
| `MULTICAST_IP`, `MULTICAST_PORT` | Channel's multicast output address |
| `INTERFACE_IP` | Server's network interface IP for binding |
| `TZ` | Timezone (e.g. `Etc/GMT-3` for UTC+3) |

**Volumes mounted:**

| Host Path | Container Path | Purpose |
|---|---|---|
| `/opt/tv_station/media` | `/media` | Video assets |
| `/dev/shm` | `/dev/shm` | FIFO and HLS RAM filesystem |
| `/opt/tv_station/Scripts/generate_playlist.py` | `/app/generate_playlist.py` | Playlist script |
| `/opt/tv_station/Scripts/playout.py` | `/app/playout.py` | Feeder script |

**Healthcheck:** `pgrep -f playout.py || exit 1` every 10 s

---

### `tv_tsduck_ch_N` — Per-channel muxer

Created **dynamically** by the web app when a channel is started (only for `protocol = udp`; skipped for `protocol = rtp` since the playout container outputs RTP directly).

| Property | Value |
|---|---|
| Image | `tv_station-tsduck_ch2` |
| Container name | `tv_tsduck_ch_N` |
| Restart policy | `always` |
| Network mode | `host` |

**`tsp` command constructed at runtime:**

```
tsp -v
  -I ip --buffer-size 10000000 <10000+N>       # read raw MPEG-TS from playout UDP port
  -P pcrbitrate --min-pcr 4 --min-pid 1        # accurate PCR estimation
  -P continuity --fix                           # fix continuity counter errors
  -P sdt --service-id 0x0001 \
         --provider "SRV:http://<ip>:3000"     # inject server URL into SDT
  -P regulate --bitrate <tsduck_bitrate>        # CBR output
  -O ip --local-address <interface> \
         --packet-burst 7 --enforce-burst \
         --ttl 10 <mcast_ip>:<mcast_port>      # multicast output
```

**Bitrate calculation:**
```
tsduck_bitrate = ffmpeg_bitrate_kbps * 1000 * 1.15
```
The 15% overhead accounts for MPEG-TS framing, PCR, PAT/PMT/SDT tables, and stuffing packets.

**Healthcheck:** `pgrep tsp || exit 1` every 10 s

---

### `tv_beacon_*` — SDT beacon

One beacon container per network interface with active channels.

| Property | Value |
|---|---|
| Image | `tv_station-tsduck_ch2` |
| Container name | `tv_beacon_<ip_with_underscores>` (e.g. `tv_beacon_172_16_88_223`) |
| Restart policy | `always` |
| Network mode | `host` |

**Purpose:** Broadcasts a minimal MPEG-TS stream containing SDT (Service Description Table) on the well-known multicast address `udp://226.0.0.1:5004`. The SDT `provider` field contains the server URL (`SRV:http://<ip>:3000`), allowing legacy receivers to auto-discover the server without UDP broadcast.

**`tsp` command:**

```
tsp -v
  -I null                                   # generate null TS packets
  -P pat --create --add-service 0x0001/0x100
  -P pmt --create --service 0x0001
  -P sdt --create --service 0x0001 \
         --provider "SRV:http://<ip>:3000" \
         --name "TV-Beacon"
  -P regulate --bitrate 1000000             # 1 Mbit/s
  -O ip --local-address <interface> --ttl 10 226.0.0.1:5004
```

---

## 4. docker-compose.yml Explained

```yaml
services:
  mariadb:       # Database — always first, tv_site depends on it being healthy
  tv_site:       # Web app — depends_on mariadb with condition: service_healthy
  tv_playout_base:  # Build-only — ensures tv_station-tv_playout image is built
  tsduck_base:      # Build-only — ensures tv_station-tsduck_ch2 image is built
```

The two `*_base` services have `restart: "no"` and `entrypoint: ["echo", "Base image built"]`. They exist solely to trigger the Docker build of their respective images during `docker compose up --build`, making those images available on the host for the web app's runtime container creation.

---

## 5. Volumes

| Volume / Mount | Type | Description |
|---|---|---|
| `./mariadb_data` | Bind mount | MariaDB data directory — **back this up!** |
| `./media` | Bind mount | All video assets. Subdirectories: `new_ads/`, `ads/fallback/` |
| `./uploads_temp` | Bind mount | Temp storage for files being uploaded via the web UI |
| `./logs` | Bind mount | Application log files from the Node.js app |
| `/dev/shm` | Bind mount (host RAM) | Shared memory: HLS segments (`hls/`), FFmpeg log files (`ch*_*.log`), FIFOs |
| `/var/run/docker.sock` | Bind mount | Docker socket — for dynamic container management |

### Media directory layout

```
media/
├── new_ads/          ← ad video files (referenced by DB filename column)
│   ├── video1.mp4
│   └── ...
└── ads/
    └── fallback/
        └── fall.mp4  ← default fallback/filler video (required!)
```

---

## 6. Networking

### `tv_network` (bridge)

Used for communication between `tv_db` and `tv_site`. Containers on this network can reach each other by container name (e.g. `DB_HOST=mariadb`).

### `host` network mode

The `tv_playout_ch_N`, `tv_tsduck_ch_N`, and `tv_beacon_*` containers all use `network_mode: host` because:
1. **Multicast** — bridge networking cannot forward multicast packets; host mode is required for proper multicast output on the LAN interface
2. **FIFO communication** — playout and tsduck containers communicate via UDP on loopback (`127.0.0.1:10000+N`); host mode ensures they share the same network namespace

### Port summary

| Port | Protocol | Used by | Description |
|---|---|---|---|
| `3000` | TCP | `tv_site` | HTTP web UI and REST API |
| `5555` | UDP | `tv_site` | UDP receiver auto-discovery |
| `3306` | TCP | `tv_db` | MariaDB (internal; exposed for external tools) |
| `10001+` | UDP (loopback) | `playout → tsduck` | Per-channel MPEG-TS pipe |
| `226.0.0.1:5004` | UDP multicast | `tv_beacon_*` | SDT discovery beacon |
| channel port | UDP multicast | `tv_tsduck_ch_N` | Per-channel multicast output |

---

## 7. Environment Variables

Copy `.env.example` to `.env` and set all values before starting:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `MYSQL_ROOT_PASSWORD` | ✅ | — | MariaDB root password |
| `DB_NAME` | — | `tv_stats` | Database name |
| `DB_USER` | — | `logger` | Database user |
| `DB_PASS` | ✅ | — | Database user password |
| `SESSION_SECRET` | ✅ | — | Express session signing secret |
| `ADDR` | ✅ | `172.16.88.223` | Server LAN IP (in SDT beacon and discovery replies) |
| `ERSATZTV_URL` | — | `http://127.0.0.1:8409` | Legacy — not used in current version |
| `ADS_BASE_PATH` | — | `/opt/tv_station/media/ads/` | Base path for ad files |

---

## 8. Container Lifecycle

### Starting the system

```bash
docker compose up -d --build
```

All channels that had `status = "active"` in the database are automatically restored (playout + tsduck + beacon containers are re-created) when `tv_site` starts.

### Starting / stopping a channel

Done via the web UI (**Channels** page → Start / Stop buttons), or by calling:
- `POST /admin/channels/:id/start`
- `POST /admin/channels/:id/stop`

The web app calls `createAndStartChannelContainers()` / `stopChannelContainers()` which use the Docker API.

### Full system teardown

```bash
docker compose down
```

This stops and removes `tv_db` and `tv_site`. The dynamically-created playout/tsduck/beacon containers must be cleaned up manually or are removed automatically the next time the channel is stopped via the web UI.

To also remove all dynamically created containers at once:

```bash
docker ps -a --filter "name=tv_playout" --filter "name=tv_tsduck" \
  --filter "name=tv_beacon" -q | xargs docker rm -f
```

---

## 9. Logs

### Where to find logs

| Log | Location | Access |
|---|---|---|
| Node.js app | `./logs/` (host bind mount) | `tail -f logs/app.log` |
| Master FFmpeg (per channel) | `/dev/shm/chN_master.log` | Web UI → Health → Logs tab |
| Feeder FFmpeg (per channel) | `/dev/shm/chN_feeder.log` | Web UI → Health → Logs tab |
| TSDuck container | `docker logs tv_tsduck_ch_N` | `docker logs -f tv_tsduck_ch_N` |
| MariaDB container | `docker logs tv_db` | `docker logs -f tv_db` |

### Reading logs from the web UI

Navigate to **Health** → select a channel → **Logs**. The page auto-refreshes the last 100 lines from `/dev/shm/chN_*.log`.

---

## 10. Troubleshooting

### Channel won't start

1. Check that both base images are built: `docker images | grep tv_station`
2. Check `tv_site` logs: `docker logs tv_site`
3. Ensure the `ADDR` in `.env` matches the server's actual LAN IP
4. Verify `/dev/shm` has enough space: `df -h /dev/shm`

### No video output / TSDuck exits immediately

- Check TSDuck logs: `docker logs tv_tsduck_ch_1`
- Common cause: wrong `MULTICAST_IP` or `INTERFACE_IP` — the interface must exist on the host and match `ADDR`
- Verify the playout container is sending to the correct UDP port: `ss -unp | grep 10001`

### HLS preview not loading in browser

- Check if `/dev/shm/hls/chN.m3u8` exists: `ls -la /dev/shm/hls/`
- Check Master FFmpeg log: `cat /dev/shm/ch1_master.log`
- Ensure nginx is serving `/hls/` from `/dev/shm/hls/` (see `nginx_site_config`)

### Receivers can't find the server

1. Verify `ADDR` in `.env` is the correct LAN IP
2. Check UDP port 5555 is open: `ss -unp | grep 5555`
3. Test discovery manually from another machine:
   ```bash
   echo -n "TV-DISCOVER" | nc -u <server-ip> 5555
   ```

### MariaDB won't start

- Check data directory permissions: `ls -la mariadb_data/`
- Check logs: `docker logs tv_db`
- If upgrading MariaDB version, run `mysql_upgrade` inside the container
