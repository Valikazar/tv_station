 # Raspberry Pi 4/5 Receiver Setup Guide

This guide walks you through setting up a Raspberry Pi 4 or 5 as a stateless TV receiver for the TV Station Playout System.

The receiver:
- Plays a UDP multicast stream assigned by the server
- Auto-discovers the server on the LAN via UDP broadcast — **no IP configuration needed**
- Reports CPU usage, temperature, and network traffic to the server every 10 seconds
- Can be switched to a different channel or rebooted remotely from the web UI

---

## Table of Contents

1. [Hardware Requirements](#1-hardware-requirements)
2. [OS Installation](#2-os-installation)
3. [Initial System Configuration](#3-initial-system-configuration)
4. [Install Dependencies](#4-install-dependencies)
5. [Configure MPV](#5-configure-mpv)
6. [Deploy the Receiver Agent](#6-deploy-the-receiver-agent)
7. [Configure systemd Services](#7-configure-systemd-services)
8. [Enable Auto-login and Autostart](#8-enable-auto-login-and-autostart)
9. [Network Configuration](#9-network-configuration)
10. [Read-only Filesystem (Optional but Recommended)](#10-read-only-filesystem-optional-but-recommended)
11. [Verification](#11-verification)
12. [Updating the Agent](#12-updating-the-agent)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Hardware Requirements

| Item | Recommended |
|------|-------------|
| Board | Raspberry Pi 4 Model B (2 GB+ RAM) or Raspberry Pi 5 |
| Storage | microSD 8 GB+ (Class 10 / A1) or USB SSD |
| OS | Raspberry Pi OS Lite **64-bit** (Bookworm) |
| Network | Ethernet (recommended) or Wi-Fi |
| Display | HDMI display (any resolution — MPV will scale) |
| Power | Official 15W USB-C PSU (RPi 4) or 27W USB-C PSU (RPi 5) |

> **Note:** Wi-Fi may introduce buffering on high-bitrate streams. Ethernet is strongly preferred for streams above 4 Mbit/s.

---

## 2. OS Installation

### Using Raspberry Pi Imager

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Select: **Raspberry Pi OS Lite (64-bit)** (no desktop environment needed)
3. Click ⚙️ **Advanced options** before writing:
   - Set hostname (e.g. `rpi-hall`)
   - Enable SSH
   - Set username and password
   - Configure Wi-Fi if not using Ethernet
4. Write to the microSD card

### Headless setup (SSH access)

After boot, find the device on your network:

```bash
# From your workstation
nmap -sn 192.168.1.0/24 | grep -A2 "Raspberry"
# or
ping rpi-hall.local
```

Connect:

```bash
ssh pi@rpi-hall.local
```

---

## 3. Initial System Configuration

```bash
# Update system
sudo apt update && sudo apt full-upgrade -y

# Set timezone (example: UTC+3 / Moscow)
sudo timedatectl set-timezone Europe/Moscow

# Optional: set a static hostname
sudo hostnamectl set-hostname rpi-hall

# Increase GPU memory split for better video output
sudo raspi-config
# → Performance Options → GPU Memory → set to 128 (for RPi 4)
# RPi 5 manages this automatically
```

### Enable hardware video acceleration (RPi 4)

```bash
sudo raspi-config
# → Advanced Options → GL Driver → choose "GL (Fake KMS)"
```

For RPi 5, hardware decoding is handled automatically via V4L2 drivers.

---

## 4. Install Dependencies

```bash
sudo apt install -y \
    mpv \
    python3 \
    python3-requests \
    iproute2 \
    procps \
    curl \
    wget
```

**Package notes:**

| Package | Version | Purpose |
|--------|---------|---------|
| `mpv` | ≥ 0.35 | Video player with IPC socket support |
| `python3` | ≥ 3.9 | Receiver agent runtime |
| `python3-requests` | ≥ 2.28 | HTTP reports to the server |
| `iproute2` | — | `ip` command for network diagnostics |
| `procps` | — | `top` for CPU usage measurements |

---

## 5. Configure MPV

MPV must start with the **Unix IPC socket** enabled at `/tmp/mpvsocket`. The agent uses this socket to control playback.

Create the MPV configuration directory and file:

```bash
mkdir -p ~/.config/mpv
```

Create `~/.config/mpv/mpv.conf`:

```ini
# IPC socket for receiver_agent.py control
input-ipc-server=/tmp/mpvsocket

# Start in fullscreen
fs=yes

# Disable OSD (no on-screen status messages)
osd-level=0

# Keep playing on errors (e.g. temporary stream dropout)
keep-open=yes

# Buffer settings for network streams
demuxer-max-bytes=50MiB
demuxer-readahead-secs=5

# UDP/RTP stream options
network-timeout=10

# Disable screensaver
stop-screensaver=yes

# No window decorations (borderless fullscreen looks cleaner)
no-border

# Hardware decoding (best on RPi 4/5)
hwdec=v4l2m2m-copy
hwdec-codecs=h264
```

> **RPi 5 note:** On RPi 5 with Bookworm, try `hwdec=auto-safe` if `v4l2m2m-copy` doesn't work.

---

## 6. Deploy the Receiver Agent

### Copy the agent to the Pi

From your workstation:

```bash
scp receiver_agent.py pi@rpi-hall.local:/home/pi/receiver_agent.py
```

Or clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/tv_station.git /home/pi/tv_station
cp /home/pi/tv_station/receiver_agent.py /home/pi/receiver_agent.py
```

Make it executable:

```bash
chmod +x /home/pi/receiver_agent.py
```

### Test the agent manually (before configuring systemd)

First, start MPV manually in a terminal:

```bash
mpv --input-ipc-server=/tmp/mpvsocket --idle
```

Then in another terminal, run the agent:

```bash
python3 /home/pi/receiver_agent.py
```

Expected output:
```
[Agent] Started — ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, Host: rpi-hall
[Discovery] Broadcasting TV-DISCOVER on port 5555...
[Discovery] Found server: http://192.168.1.100:3000 (from 192.168.1.100)
[Agent] Config received: udp://226.0.0.1:1234
[MPV] Loading stream: udp://226.0.0.1:1234
```

Press `Ctrl+C` to stop after confirming it works.

---

## 7. Configure systemd Services

We create two systemd services:
1. `mpv-player.service` — starts MPV player
2. `mpv-player.service` — starts MPV player
2. `tv-agent.service` — starts the Python receiver agent (waits for MPV)

### `mpv-player.service`

```bash
sudo tee /etc/systemd/system/mpv-player.service > /dev/null << 'EOF'
[Unit]
Description=MPV Video Player for TV Receiver
After=graphical-session.target network.target
Wants=graphical-session.target

[Service]
Type=simple
User=pi
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/pi/.Xauthority
ExecStart=/usr/bin/mpv \
    --input-ipc-server=/tmp/mpvsocket \
    --idle \
    --fs \
    --osd-level=0 \
    --keep-open=yes \
    --demuxer-max-bytes=50MiB \
    --demuxer-readahead-secs=5 \
    --hwdec=v4l2m2m-copy \
    --hwdec-codecs=h264
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

> **RPi 5 / KMS note:** If you are using the KMS console (no X11), replace `Environment=DISPLAY=:0` with the appropriate Wayland/DRM settings, or run MPV without a display variable using `--vo=drm`.

---

### `tv-agent.service`

```bash
sudo tee /etc/systemd/system/tv-agent.service > /dev/null << 'EOF'
[Unit]
Description=TV Station Receiver Agent
After=network-online.target mpv-player.service
Wants=network-online.target
Requires=mpv-player.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStartPre=/bin/sleep 3
# -u for unbuffered output to ensure instant logs in journalctl
ExecStart=/usr/bin/python3 -u /home/pi/receiver_agent.py
Restart=always
RestartSec=5
# Output is sent to systemd journal (RAM-based in Read-Only mode), NO disk writes.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

### Enable and start services

```bash
sudo systemctl daemon-reload
sudo systemctl enable mpv-player.service
sudo systemctl enable tv-agent.service
sudo systemctl start mpv-player.service
sudo systemctl start tv-agent.service
```

### Check service status

```bash
sudo systemctl status mpv-player.service
sudo systemctl status tv-agent.service

# View live agent logs
sudo journalctl -u tv-agent.service -f
```

---

## 8. Enable Auto-login and Autostart

For a fully headless kiosk boot (no keyboard/monitor needed at startup):

```bash
sudo raspi-config
# → System Options → Boot / Auto Login → "Console Autologin"
```

Alternatively, with `systemd`:

```bash
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d/

sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf > /dev/null << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin pi --noclear %I $TERM
EOF
```

---

## 9. Network Configuration

### Ethernet (recommended)

No special configuration needed. The receiver uses DHCP by default. The agent discovers the server via UDP broadcast — no static IP is required on the RPi.

### Static IP (optional, for reliability)

Edit `/etc/dhcpcd.conf`:

```
interface eth0
static ip_address=192.168.1.50/24
static routers=192.168.1.1
static domain_name_servers=8.8.8.8
```

### Wi-Fi

If using Wi-Fi, ensure the SSID and passphrase are configured during OS imaging (Raspberry Pi Imager advanced options) or via:

```bash
sudo raspi-config
# → System Options → Wireless LAN
```

### Multicast routing

The receiver receives UDP multicast streams directly. No additional routing configuration is needed if the RPi and server are on the same LAN segment.

If separated by a router, the router must support **IGMP snooping** / multicast routing. Consult your router's documentation.

---

## 10. Read-only Filesystem (Optional but Recommended)

A read-only root filesystem prevents SD card corruption on unexpected power loss — essential for a 24/7 kiosk device.

### Method: `overlayfs` via `raspi-config`

```bash
sudo raspi-config
# → Performance Options → Overlay File System → Enable
# Confirm that /boot is also write-protected
```

> ⚠️ **Important:** The receiver agent is designed to be **fully stateless** — it writes nothing to disk. MPV IPC socket is in `/tmp` (RAM tmpfs). All configuration is fetched from the server at runtime.

### After enabling overlay FS

Verify the filesystem is read-only:

```bash
findmnt -o TARGET,FSTYPE,OPTIONS / | grep ro
```

To make temporary changes (e.g. to update `receiver_agent.py`), disable overlay FS first:

```bash
sudo raspi-config
# → Performance Options → Overlay File System → Disable
# Reboot, make changes, then re-enable
```

---

## 11. Verification

### Check the agent is running

```bash
sudo journalctl -u receiver-agent.service -n 50
```

You should see periodic lines like:

```
[Agent] Started — ID: ..., Host: rpi-hall
[Discovery] Broadcasting TV-DISCOVER on port 5555...
[Discovery] Found server: http://192.168.1.100:3000 (from 192.168.1.100)
[Agent] Config received: udp://226.0.0.2:5001
[MPV] Loading stream: udp://226.0.0.2:5001
```

### Check the receiver appears in the web UI

Open `http://<server-ip>:3000` → **Receivers** tab.

The RPi should appear within ~10 seconds of the agent starting, showing:
- Hostname
- IP address
- CPU usage
- Temperature
- Traffic speed
- Current stream URL

### Check video is playing on the display

The display should show the video stream within a few seconds of the agent loading the stream URL into MPV.

### Test remote channel switch

In the web UI → Receivers → click **Switch Channel** on your receiver → select a different channel.

The agent should receive the `change_channel` command on the next report cycle (within 10 seconds) and MPV should switch streams.

### Test remote reboot

In the web UI → Receivers → click **Reboot**. The Pi should reboot within ~10 seconds.

---

## 12. Updating the Agent

Since the filesystem may be read-only, follow this procedure:

1. Disable overlay FS (if enabled):
   ```bash
   sudo raspi-config  # Overlay FS → Disable
   sudo reboot
   ```

2. Copy new agent:
   ```bash
   scp receiver_agent.py pi@rpi-hall.local:/home/pi/receiver_agent.py
   ```

3. Re-enable overlay FS:
   ```bash
   sudo raspi-config  # Overlay FS → Enable
   sudo reboot
   ```

Alternatively, use `git pull` if the repository is cloned on the Pi.

---

## 13. Troubleshooting

### Agent can't find the server

**Symptom:** `[Discovery] Broadcast timeout, trying directed subnet scan...` repeating endlessly.

**Checks:**
1. Is the server running and port 5555/UDP open?
   ```bash
   # From the RPi
   echo -n "TV-DISCOVER" | nc -u <server-ip> 5555
   ```
2. Is there a firewall blocking UDP 5555 on the server?
   ```bash
   # On the server
   sudo ufw status
   sudo ufw allow 5555/udp
   ```
3. Are the RPi and server on the same subnet? Broadcast discovery (`255.255.255.255`) only works within the same LAN segment.

---

### MPV IPC socket not found

**Symptom:** `[MPV] IPC error: [Errno 2] No such file or directory: '/tmp/mpvsocket'`

**Cause:** MPV is not running or did not open the socket yet.

**Fix:**
- Check MPV service: `sudo systemctl status mpv-player.service`
- The agent has a 2-second startup delay to let MPV initialize — if MPV takes longer, increase `ExecStartPre=/bin/sleep 3` in `receiver-agent.service`
- Restart both services: `sudo systemctl restart mpv-player receiver-agent`

---

### Black screen / no video

**Checks:**
1. Is MPV running? `ps aux | grep mpv`
2. What URL is MPV playing?
   ```bash
   echo '{"command":["get_property","path"]}' | nc -U /tmp/mpvsocket
   ```
3. Can the RPi receive the multicast stream?
   ```bash
   sudo apt install -y vlc-bin
   vlc --intf dummy udp://@226.0.0.1:5001
   # or with ffmpeg:
   ffprobe udp://@226.0.0.1:5001
   ```
4. Is the playout container running on the server? Check the **Health** page in the web UI.

---

### High CPU usage / overheating

- Ensure hardware decoding is working: check `mpv` logs for `[vo/gpu] Detected hardware decode`
- On RPi 4: ensure a heatsink is installed; consider a case fan
- Reduce the stream bitrate on the server (Channels → Edit → Bitrate)
- Check temperature: `vcgencmd measure_temp` or see the Receivers dashboard

---

### Agent stops reporting after network interruption

The agent is designed to re-discover the server automatically after any `requests.exceptions.RequestException`. Check:

```bash
sudo journalctl -u receiver-agent.service -f
```

You should see `[Agent] Report failed: ... Re-discovering server...` followed by a new discovery attempt.

---

### MPV shows a previous channel after reboot

This is expected — the agent fetches the assigned stream URL from the server on every boot. After ~3 seconds, it sends `loadfile` to MPV with the correct URL.

---

## Reference: Agent Configuration

The following constants in `receiver_agent.py` can be adjusted if needed:

| Constant | Default | Description |
|---|---|---|
| `BEACON_URL` | `udp://226.0.0.1:5004` | Legacy multicast beacon address (not used by default) |
| `MPV_SOCKET` | `/tmp/mpvsocket` | MPV IPC socket path |
| `REPORT_INTERVAL` | `10` | Seconds between status reports to the server |
| `DISCOVERY_PORT` | `5555` | UDP port for server discovery broadcast |

These can also be overridden via environment variables if you wrap the agent in a shell script.
