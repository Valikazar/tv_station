# Components Reference

This document provides a detailed description of every component in the TV Station Playout System.

---

## Table of Contents

1. [Web Application (`tv_site`)](#1-web-application-tv_site)
   - [Entry Point — `src/app.ts`](#entry-point--srcappts)
   - [Routes](#routes)
   - [Services](#services)
   - [Utilities](#utilities)
   - [Views (EJS Templates)](#views-ejs-templates)
2. [Playout Pipeline](#2-playout-pipeline)
   - [Entrypoint — `playout_entrypoint.sh`](#entrypoint--playout_entrypointsh)
   - [Feeder — `Scripts/playout.py`](#feeder--scriptsplayoutpy)
   - [Playlist Generator — `Scripts/generate_playlist.py`](#playlist-generator--scriptsgenerate_playlistpy)
3. [Receiver Agent — `receiver_agent.py`](#3-receiver-agent--receiver_agentpy)
4. [Docker Service — `src/services/dockerService.ts`](#4-docker-service--srcservicesdockerservicets)
5. [Database Schema](#5-database-schema)
6. [Configuration & Utilities](#6-configuration--utilities)

---

## 1. Web Application (`tv_site`)

The web application is a **Node.js / TypeScript / Express** server that provides the management UI and the REST API consumed by receiver agents.

### Entry Point — `src/app.ts`

**Responsibilities:**
- Configures Express middleware (JSON parser, URL-encoded parser, sessions, rate limiting)
- Implements bcrypt-based **login/logout** with brute-force protection (5 attempts / 15 min)
- Injects `t` (i18n translations), `username`, `channels`, and `lang` into every EJS view via a global middleware
- Mounts all route handlers under their respective URL prefixes
- On startup: calls `initializeSlots()` to ensure DB tables exist, then calls `createAndStartChannelContainers()` for every channel with `status = "active"` — this restores the full broadcast pipeline after a server reboot
- Starts the **UDP Discovery service** on port `5555/UDP`

**UDP Discovery Protocol (`startUdpDiscovery`):**

Raspberry Pi agents broadcast `TV-DISCOVER` as a UDP datagram to `255.255.255.255:5555`. The server immediately replies with `TV-SERVER:http://<ADDR>:3000`. This lets receivers auto-configure without hardcoded server IPs or TSDuck SDT parsing.

```
RPi → broadcast UDP:5555  "TV-DISCOVER"
Server → unicast to RPi  "TV-SERVER:http://172.16.88.223:3000"
```

---

### Routes

#### `adRoutes.ts` — Ad Video Management (`/ads`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ads` | Main ad management page |
| `POST` | `/ads/upload` | Upload a new video file (multer, stored to `ADS_BASE_PATH`) |
| `POST` | `/ads/update/:id` | Update video metadata (name, target slots, channel) |
| `POST` | `/ads/delete/:id` | Delete video and its file from disk |
| `GET` | `/ads/files` | JSON: list of video files with duration probed by ffprobe |

Videos are associated with time slots via a `target_slots_ids` JSON array stored in the DB. The playlist generator uses this to fill each slot with the correct videos.

---

#### `adminRoutes.ts` — Admin Panel (`/admin`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin` | Admin page: time slots, channel settings |
| `POST` | `/admin/slots` | Save time slot configuration for a channel |
| `POST` | `/admin/channel-settings` | Save channel-level settings (start behavior, fallback video) |
| `POST` | `/admin/upload-fallback` | Upload a custom per-channel fallback video |
| `GET` | `/admin/interfaces` | JSON: list of host network interfaces (via Docker exec) |

**Time Slot Behaviors** (`start_behavior` field):

| Code | Name | Description |
|------|------|-------------|
| `1` | Natural | Videos may slightly overflow into the next slot (~5% tolerance) |
| `2` | Trim | Current video is cut at the exact slot boundary |
| `3` | Stretch | Current video is extended (or cut) to exactly fill remaining time |
| `4` | Exact | No video that would overflow is started; a filler gap is used instead |

---

#### `channelRoutes.ts` — Channel CRUD (`/admin/channels`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/channels` | Channels list page |
| `POST` | `/admin/channels/add` | Create a new channel (name, multicast IP/port, bitrate, protocol) |
| `POST` | `/admin/channels/update/:id` | Update channel settings |
| `POST` | `/admin/channels/delete/:id` | Stop containers and delete channel |
| `POST` | `/admin/channels/:id/start` | Start playout containers for a channel |
| `POST` | `/admin/channels/:id/stop` | Stop playout containers for a channel |
| `POST` | `/admin/channels/switch/:id` | Switch current channel context in the session |

---

#### `healthRoutes.ts` — Health Monitoring (`/health`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Container health dashboard (status of all tv_* containers) |
| `GET` | `/health/logs/:container` | Tail live log output (`/dev/shm/chN_*.log`) for a container |
| `POST` | `/health/restart/:container` | Restart a specific container via Docker API |

Logs are read directly from RAM (`/dev/shm`) — no disk I/O, low latency.

---

#### `receiverRoutes.ts` — Receiver Management (`/api/receivers`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/receivers` | ✅ Required | Receiver management page |
| `GET` | `/api/receivers/config` | ❌ Public | Called by RPi on boot; returns `stream_url` for the receiver |
| `POST` | `/api/receivers/report` | ❌ Public | Heartbeat: receives CPU/temp/traffic, returns `command` if pending |
| `POST` | `/api/receivers/:id/command` | ✅ Required | Send `change_channel` or `reboot` command to a receiver |
| `POST` | `/api/receivers/:id/update` | ✅ Required | Update nickname/location metadata |
| `DELETE` | `/api/receivers/:id` | ✅ Required | Remove receiver record from DB |

**Report payload** (from RPi → server):
```json
{
  "id": "uuid-from-mac",
  "hostname": "rpi-livingroom",
  "ip_address": "192.168.1.42",
  "cpu_usage": 14.5,
  "temperature": 52.3,
  "traffic_speed": 750123,
  "current_stream_url": "udp://226.0.0.1:1234"
}
```

**Command response** (server → RPi):
```json
{ "command": "change_channel", "url": "udp://226.0.0.2:5678" }
```
or
```json
{ "command": "reboot" }
```

---

#### `reportRoutes.ts` — Statistics (`/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Main report page — playback statistics per slot/period |
| `GET` | `/report/export/excel` | Export report as Excel (via ExcelJS) |
| `GET` | `/report/export/pdf` | Export report as PDF (via PDFKit) |

---

#### `watchRoutes.ts` — In-browser Preview (`/watch`)

Serves the `watch.ejs` page that uses **hls.js** to play the HLS stream at `http://<server>/hls/chN.m3u8`. HLS segments are generated by the Master FFmpeg into `/dev/shm/hls/`.

---

### Services

#### `dockerService.ts`

Central gateway between the web app and the **Docker Engine API** via the Unix socket `/var/run/docker.sock`. All communication is raw HTTP over the socket — no Docker SDK dependency.

**Key functions:**

| Function | Description |
|----------|-------------|
| `createAndStartChannelContainers(channelId)` | Creates and starts `tv_playout_ch_N` and `tv_tsduck_ch_N` containers for a channel |
| `stopChannelContainers(channelId)` | Stops and removes playout + TSDuck containers |
| `startBeaconStream(interfaceIp)` | Creates/recreates the `tv_beacon_*` container that broadcasts SDT over `udp://226.0.0.1:5004` |
| `stopBeaconIfNoChannelsActive(interfaceIp)` | Stops the beacon if no active channels remain on a given interface |
| `getHostNetworkInterfaces()` | Runs `ip -4 -o addr show` inside a temporary container to enumerate host LAN IPs |
| `removeContainer(name)` | Gracefully stops (5 s timeout) then force-removes a container |
| `execInContainer(name, cmd)` | Runs a command inside a running container via Exec API |

**Container naming convention:**

| Container | Role |
|-----------|------|
| `tv_playout_ch_N` | FFmpeg playout feeder + Master FFmpeg + playlist generation |
| `tv_tsduck_ch_N` | TSDuck TS muxer — PCR regulation, SDT injection, multicast output |
| `tv_beacon_<ip>` | TSDuck beacon — null TS + SDT on `udp://226.0.0.1:5004` |

---

#### `statsService.ts`

Aggregates raw `playback_log` rows from the database into per-slot, per-period statistics displayed on the report page.

---

### Utilities

#### `timeSlots.ts`

Manages **time slot** configuration — the schedule of when specific ad blocks air during the broadcast day.

- Runs `CREATE TABLE IF NOT EXISTS time_slots` on startup
- Applies schema migrations idempotently (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
- Maintains an **in-memory cache** per channel (`cachedSlotsByChannel`)
- Exports `initializeSlots()`, `saveSlots()`, `getSlots()`, `getSlotForTime()`

---

#### `adMapping.ts`

Helpers for resolving which ad videos are assigned to which time slots, used by the report and ad management pages.

---

#### `actionLogger.ts`

Simple audit logger — writes admin actions (channel start/stop, slot changes, etc.) to the application log.

---

### Views (EJS Templates)

| Template | Description |
|----------|-------------|
| `login.ejs` | Login page |
| `index.ejs` | Root redirect / report home |
| `admin.ejs` | Admin panel: time slots, channel settings, fallback video |
| `channels.ejs` | Channel management: add/edit/start/stop channels |
| `ads.ejs` | Ad video library: upload, assign to slots, delete |
| `receivers.ejs` | Receiver dashboard: status cards, channel switch, reboot |
| `health.ejs` | Container health: status indicators, live log tails |
| `report.ejs` | Playback statistics with date/period filter |
| `watch.ejs` | In-browser HLS player (hls.js) |

---

## 2. Playout Pipeline

Each active channel runs inside a **`tv_playout_ch_N`** Docker container. The pipeline inside is:

```
generate_playlist.py  ──→  MariaDB  (generated_playlists table)
                                    ↑
playout.py  ──reads──→  MariaDB schedule
            ──ffmpeg──→  FIFO(/tmp/playout_fifo_chN)
                                    ↓
Master FFmpeg  ──reads FIFO──→  UDP :10000+N  (→ TSDuck → multicast)
                             ──→  HLS /dev/shm/hls/chN.m3u8
```

---

### Entrypoint — `playout_entrypoint.sh`

Bash script that runs as the container `ENTRYPOINT`. Orchestrates the full startup sequence:

1. **Kill stale FFmpeg processes** from any previous (crashed) container run
2. **Create FIFO** at `/tmp/playout_fifo_chN` with `mkfifo`
3. **Start dummy writer** (`tail -f /dev/null > FIFO`) — keeps the FIFO permanently open so Master FFmpeg never gets an EOF before playout.py is ready
4. **Generate playlists** for today and tomorrow via `generate_playlist.py`
5. **Start Master FFmpeg** in a `while true` auto-restart loop:
   - Reads raw MPEG-TS from the FIFO
   - Outputs simultaneously to:
     - `udp://127.0.0.1:10000+N` → picked up by TSDuck for distribution
     - `/dev/shm/hls/chN.m3u8` → HLS preview segments in RAM
6. **Start `playout.py`** (feeder) — bash stays alive (no `exec`) so the `trap cleanup EXIT` always fires on container shutdown

**Cleanup trap** kills all FFmpeg processes and removes the FIFO on any signal (SIGTERM, SIGINT, EXIT).

---

### Feeder — `Scripts/playout.py`

The core scheduling and encoding engine. Runs as the main process inside the playout container.

**Class `PlayoutSender`:**

| Method | Description |
|--------|-------------|
| `__init__` | Opens FIFO handle, starts background writer thread and queue |
| `get_next_item()` | Queries MariaDB for the currently-due playlist entry (or the next upcoming one) |
| `get_filler()` | Returns the channel's fallback video path (`fall.mp4` or per-channel override) |
| `stream_file()` | Runs an FFmpeg child process; encodes video → writes chunks into thread queue |
| `log_playback_start()` | Inserts a row into `playback_log` (skipped for excluded slots) |
| `regenerate_playlist()` | Triggers `generate_playlist.py` in a background thread if a file is missing |
| `run()` | Main loop: `get_next_item` → decide seek/duration → `stream_file` → repeat |

**FFmpeg feeder command** (per file):
- `-re` — reads at real-time speed
- Input: ad video file (relative to `MEDIA_DIR`)
- Video filter: scale to 1920×1080, letterbox/pillarbox, 25fps, `yuv420p`
- Video codec: `libx264 ultrafast`, configurable bitrate (`FFMPEG_BITRATE_K`)
- Audio codec: `aac 192k`, 48kHz stereo; missing audio → silent `anullsrc` injection
- Output: raw `mpegts` piped to `stdout` → queue → FIFO
- `-output_ts_offset` — cumulative timestamp offset for seamless PTS continuity across file boundaries

**FIFO + Queue architecture:**

```
playout.py
  → ffmpeg subprocess stdout
    → 128KB chunks → thread-safe Queue (max 300 chunks ≈ 40 MB)
      → background writer thread → FIFO handle (always open)
         ↑
         Master FFmpeg reads from FIFO
```

This decouples encoding speed from playback and prevents blocking on the FIFO when queue is full.

**Reactive filler interruption:** While playing a filler video, every 5 seconds the feeder checks the schedule. If a real ad is now due, filler streaming is interrupted immediately.

---

### Playlist Generator — `Scripts/generate_playlist.py`

Generates the full broadcast schedule for a given date and writes it to the `generated_playlists` table.

**Algorithm:**

1. Load `time_slots` for the channel from DB
2. Load all `ad_videos` for the channel that have existing files on disk
3. Step through the day millisecond by millisecond:
   - If inside an ad slot → fill with slot-assigned videos
   - If between slots → fill with mainstream (slot 0) videos
4. Apply `start_behavior` rules at each slot boundary (Natural / Trim / Stretch / Exact)
5. Where no video fits → insert a filler entry (`fall.mp4`)
6. Bulk-insert all `playlist_entries` into DB in chunks of 500

**Called automatically** by the container entrypoint at startup, and on-demand by `playout.py` when a file is found missing.

---

## 3. Receiver Agent — `receiver_agent.py`

A lightweight Python script deployed on each **Raspberry Pi** receiver. Designed for **stateless, read-only filesystem** operation.

**Identity:**
- Hardware UUID derived from the MAC address via `uuid.getnode()` — reproducible across reboots, no disk storage needed
- Hostname from `socket.gethostname()`

**Startup sequence:**

```
Phase 1: Server Discovery
  → broadcast "TV-DISCOVER" UDP to 255.255.255.255:5555
  → if timeout: scan common LAN IPs (*.1, *.2, *.223, *.224, *.236)
  → receive "TV-SERVER:http://..." reply
  ↓
Phase 2: Get Config
  → GET /api/receivers/config?id=UUID&hostname=rpi-name
  → receive { stream_url: "udp://..." }
  ↓
Phase 3: Start MPV
  → mpv_load(stream_url) via IPC socket /tmp/mpvsocket
  ↓
Phase 4: Report Loop (every 10 s)
  → POST /api/receivers/report  { id, cpu, temp, traffic, url }
  → handle command: change_channel | reboot
```

**MPV control:**
- MPV runs independently (started by systemd before the agent)
- Agent communicates via Unix IPC socket (`/tmp/mpvsocket`) using the MPV JSON protocol
- `mpv_load(url)` — switch to new stream URL without restarting MPV: `{"command": ["loadfile", url, "replace"]}`
- `mpv_get_path()` — read currently playing URL (used as ground truth in reports)

**Metrics collected:**
- **CPU usage** — parsed from `top -bn1` output
- **Temperature** — read from `/sys/class/thermal/thermal_zone0/temp`
- **Traffic speed** — computed from `/proc/net/dev` receive bytes delta over elapsed time (bytes/second)

**Fault tolerance:**
- If the report POST fails → immediately attempt server re-discovery
- All phases retry indefinitely with 5 s sleep between attempts

---

## 4. Docker Service — `src/services/dockerService.ts`

Communicates with the Docker Engine via raw HTTP over the **Unix socket** `/var/run/docker.sock` (mounted read-only into the `tv_site` container).

Uses Docker API v1.44. No external Docker SDK is required.

**TSDuck container pipeline per channel:**

```
tsp
  -I ip <udp_port>          ← reads raw MPEG-TS from playout ffmpeg
  -P pcrbitrate              ← accurate PCR bitrate estimation
  -P continuity --fix        ← fix continuity counter errors
  -P sdt --provider SRV:http://<ip>:3000  ← inject server URL into SDT
  -P regulate --bitrate <N>  ← CBR output regulation
  -O ip <mcast_ip>:<port>   ← multicast output
```

**Beacon container:**

```
tsp
  -I null                    ← generate null TS packets
  -P pat --create            ← create minimal PAT table
  -P pmt --create            ← create minimal PMT table
  -P sdt --provider SRV:http://<ip>:3000  ← server URL in SDT
  -P regulate --bitrate 1M   ← 1 Mbit/s CBR beacon stream
  -O ip 226.0.0.1:5004       ← fixed well-known multicast address
```

The beacon allows **legacy receivers** (before the UDP discovery protocol was added) to find the server URL by parsing SDT from the multicast stream.

---

## 5. Database Schema

**MariaDB database: `tv_stats`**

| Table | Description |
|-------|-------------|
| `channels` | Channel definitions: name, multicast IP/port, bitrate, protocol, status |
| `channel_settings` | Per-channel settings: start behavior, fallback video path |
| `time_slots` | Ad block schedule: start time, duration, behavior flags |
| `ad_videos` | Video library: filename, duration, target slot IDs, channel |
| `generated_playlists` | Pre-computed daily schedule entries |
| `playback_log` | History of every video playback event |
| `receivers` | Registered RPi receivers: UUID, hostname, IP, metrics, assigned stream |

**Schema initialization** is handled automatically by `initializeSlots()` in `timeSlots.ts` using `CREATE TABLE IF NOT EXISTS` and idempotent `ALTER TABLE ADD COLUMN` migrations. No manual SQL scripts need to be run.

---

## 6. Configuration & Utilities

### `.env` file

Loaded by `dotenv` in Node.js and manually parsed by Python scripts (by scanning `/opt/tv_station/.env`, `.env`, `../.env`).

### `add_user.js`

Interactive CLI script to add a new user to `users.json` with a bcrypt-hashed password.

```bash
node add_user.js
```

### `generate_hash.js`

Utility to generate a bcrypt hash for a given password:

```bash
node generate_hash.js mypassword
```

### `users.json`

Flat JSON file storing user credentials (login + bcrypt password hash). No user table in the database — kept simple and easy to manage.

### `nginx_site_config`

Nginx virtual host configuration. Should be placed in `/etc/nginx/sites-enabled/`. Provides:
- Reverse proxy to Node.js (`localhost:3000`)
- HLS segment serving from `/dev/shm/hls/` with `no-cache` headers and CORS
- 500 MB `client_max_body_size` for large video uploads
