"""
TV Station Receiver Agent — Stateless Design
=============================================
- No disk writes (read-only filesystem compatible)
- UUID derived from hardware MAC address (reproducible, no storage needed)
- Server discovered automatically from beacon stream at udp://226.0.0.1:5004
- MPV controlled via UNIX IPC socket (/tmp/mpvsocket) — no service file edits
- All configuration stored on server, RPi is fully stateless
"""

import requests
import time
import subprocess
import os
import uuid
import socket
import json
import re
import sys

# ── Logging ───────────────────────────────────────────────────────────────────
def log(msg):
    print(msg, flush=True)

# ── Configuration ─────────────────────────────────────────────────────────────
BEACON_URL   = "udp://226.0.0.1:5004"   # Fixed well-known beacon multicast address
MPV_SOCKET   = "/tmp/mpvsocket"          # MPV IPC socket path
REPORT_INTERVAL = 10                     # seconds between status reports

# ── State (in-memory only) ─────────────────────────────────────────────────────
_last_traffic_time  = 0
_last_traffic_bytes = 0
_server_url         = None               # Discovered at runtime
_current_stream_url = None
_last_load_attempt  = 0                  # Cooldown for MPV loadfile enforcement

# ── Identity ───────────────────────────────────────────────────────────────────
def get_receiver_id() -> str:
    """Stable UUID from hardware MAC address — no disk required."""
    mac = uuid.getnode()
    return str(uuid.UUID(int=mac, version=1))

def get_hostname() -> str:
    return socket.gethostname()

def get_ip_address() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        try: return socket.gethostbyname(socket.gethostname())
        except: return "127.0.0.1"

# ── Server Discovery ───────────────────────────────────────────────────────────
DISCOVERY_PORT = 5555
KNOWN_SERVER_IPS = []  # Optional fallback IPs populated at runtime

def discover_server() -> str | None:
    """
    Sends a UDP broadcast 'TV-DISCOVER' packet on port 5555.
    The server replies with 'TV-SERVER:http://...'.
    Falls back to checking known IPs directly via HTTP.
    """
    log(f"[Discovery] Broadcasting TV-DISCOVER on port {DISCOVERY_PORT}...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(3)
    try:
        sock.sendto(b'TV-DISCOVER', ('255.255.255.255', DISCOVERY_PORT))
        data, addr = sock.recvfrom(256)
        text = data.decode().strip()
        if text.startswith('TV-SERVER:'):
            server = text[len('TV-SERVER:'):]
            log(f"[Discovery] Found server: {server} (from {addr[0]})")
            return server
    except socket.timeout:
        log("[Discovery] Broadcast timeout, trying directed subnet scan...")
        # Try directed to known gateway/common IPs
        my_ip = get_ip_address()
        prefix = '.'.join(my_ip.split('.')[:3])
        for last in [1, 2, 223, 224, 236]:
            target = f"{prefix}.{last}"
            try:
                sock2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock2.settimeout(1)
                sock2.sendto(b'TV-DISCOVER', (target, DISCOVERY_PORT))
                data, addr = sock2.recvfrom(256)
                text = data.decode().strip()
                if text.startswith('TV-SERVER:'):
                    server = text[len('TV-SERVER:'):]
                    log(f"[Discovery] Found server: {server} (from {addr[0]})")
                    return server
            except: pass
            finally:
                try: sock2.close()
                except: pass
    except Exception as e:
        log(f"[Discovery] Error: {e}")
    finally:
        sock.close()
    return None

# ── MPV Control ────────────────────────────────────────────────────────────────
def mpv_send(command: list) -> dict | None:
    """Sends a JSON command to MPV via the IPC socket. Returns response dict or None."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(MPV_SOCKET)
        msg = json.dumps({"command": command}) + "\n"
        s.send(msg.encode())
        response_raw = s.recv(4096).decode().strip()
        s.close()

        if response_raw:
            # MPV often sends events (property-change, etc) along with the command response.
            # We split by newline and find the first JSON that looks like a response.
            for line in response_raw.split('\n'):
                line = line.strip()
                if not line: continue
                try:
                    data = json.loads(line)
                    # A command response usually has 'error' key or 'request_id'
                    if 'error' in data or 'data' in data:
                        return data
                except:
                    continue
        return {"error": "no valid response"}
    except Exception as e:
        log(f"[MPV] IPC error: {e}")
        return None

def mpv_load(url: str) -> bool:
    """Instructs MPV to load a new stream URL. Returns True if IPC command accepted."""
    log(f"[MPV] Loading stream: {url}")
    result = mpv_send(["loadfile", url, "replace"])
    if result is None:
        log(f"[MPV] loadfile failed — IPC socket error")
        return False
    err = result.get("error", "")
    if err and err != "success":
        log(f"[MPV] loadfile rejected by MPV: {err}")
        return False
    log(f"[MPV] loadfile accepted (MPV response: {result})")
    return True

def mpv_get_path() -> str | None:
    """Gets the currently playing URL from MPV."""
    res = mpv_send(["get_property", "path"])
    if res and "data" in res:
        return res.get("data")
    return None

# ── Metrics ────────────────────────────────────────────────────────────────────
def get_cpu_usage() -> float:
    try:
        out = os.popen(
            "top -bn1 | grep 'Cpu(s)' | "
            "sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | "
            "awk '{print 100 - $1}'"
        ).read().strip()
        return float(out)
    except: return 0.0

def get_temperature() -> float:
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return float(f.read().strip()) / 1000.0
    except: return 0.0

def get_traffic_speed() -> float:
    """Returns incoming traffic speed in bytes/second across all non-loopback interfaces."""
    global _last_traffic_time, _last_traffic_bytes
    current_time  = time.time()
    current_bytes = 0
    try:
        with open("/proc/net/dev") as f:
            for line in f:
                if ":" not in line or "lo:" in line:
                    continue
                parts = line.split(":")
                if len(parts) > 1:
                    stats = parts[1].split()
                    if stats:
                        current_bytes += int(stats[0])  # Receive bytes
    except Exception as e:
        log(f"[Metrics] Traffic error: {e}")
        return 0.0

    if _last_traffic_time == 0:
        _last_traffic_time  = current_time
        _last_traffic_bytes = current_bytes
        return 0.0

    dt = current_time - _last_traffic_time
    if dt < 0.1: return 0.0

    speed = (current_bytes - _last_traffic_bytes) / dt
    _last_traffic_time  = current_time
    _last_traffic_bytes = current_bytes
    return max(0.0, speed)

# ── Main Loop ──────────────────────────────────────────────────────────────────
def main():
    global _server_url, _current_stream_url

    receiver_id = get_receiver_id()
    hostname    = get_hostname()
    log(f"[Agent] Started — ID: {receiver_id}, Host: {hostname}")

    # ── Phase 1: Discover server from beacon ──────────────────────────────────
    while _server_url is None:
        _server_url = discover_server()
        if _server_url is None:
            log("[Agent] Beacon not found, retrying in 5s...")
            time.sleep(5)

    # ── Phase 2: Get initial stream URL from server ───────────────────────────
    while _current_stream_url is None:
        try:
            config_url = f"{_server_url}/api/receivers/config"
            resp = requests.get(config_url, params={"id": receiver_id, "hostname": hostname}, timeout=5)
            data = resp.json()
            _current_stream_url = data.get("stream_url")
            log(f"[Agent] Config received: {_current_stream_url}")
        except Exception as e:
            log(f"[Agent] Config request failed: {e}, retrying in 5s...")
            time.sleep(5)

    # ── Phase 3: Tell MPV to play the assigned stream ─────────────────────────
    if _current_stream_url:
        time.sleep(2)  # Give MPV a moment to start if agent starts with systemd
        mpv_load(_current_stream_url)

    # ── Phase 4: Report loop ──────────────────────────────────────────────────
    while True:
        try:
            # Get current stream from MPV (ground truth)
            playing = mpv_get_path()

            # ENFORCEMENT: If MPV is idle or playing wrong URL, reload every cycle
            if _current_stream_url and (playing is None or playing != _current_stream_url):
                if playing is None:
                    log(f"[Agent] MPV is idle, loading assigned stream: {_current_stream_url}")
                else:
                    log(f"[Agent] Target mismatch! MPV plays: {playing}, should be: {_current_stream_url}. Fixing...")
                mpv_load(_current_stream_url)

            # Use the most accurate info for the report
            report_playing = playing or _current_stream_url

            payload = {
                "id":                 receiver_id,
                "hostname":           hostname,
                "ip_address":         get_ip_address(),
                "cpu_usage":          get_cpu_usage(),
                "temperature":        get_temperature(),
                "traffic_speed":      get_traffic_speed(),
                "current_source_ip":  "Detected",
                "current_stream_url": report_playing,
            }

            try:
                report_url = f"{_server_url}/api/receivers/report"
                response   = requests.post(report_url, json=payload, timeout=5)
                data       = response.json()

                # Handle switch command from server
                cmd = data.get("command")
                if cmd == "change_channel":
                    target_url = data.get("url")
                    log(f"[Agent] Received change_channel command → {target_url}")
                    if target_url:
                        # Always apply the command — do NOT skip even if URL looks same
                        if mpv_load(target_url):
                            _current_stream_url = target_url
                            print(f"[Agent] Channel switched to: {target_url}")
                        else:
                            print(f"[Agent] MPV load FAILED for: {target_url}")
                elif cmd == "reboot":
                    print("[Agent] Server requested reboot. Rebooting now...")
                    subprocess.run(["sudo", "reboot"])

            except (requests.exceptions.RequestException, ValueError) as e:
                print(f"[Agent] Report failed: {e}. Re-discovering server...")
                new_server = discover_server()
                if new_server:
                    _server_url = new_server

        except Exception as e:
            print(f"[Agent] Loop error: {e}")

        time.sleep(REPORT_INTERVAL)


if __name__ == "__main__":
    main()
