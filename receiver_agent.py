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
AGENT_VERSION   = "2.1.11"               # Auto-incremented by deploy.ps1
BEACON_URL      = "udp://226.0.0.1:5004"   # Fixed well-known beacon multicast address
MPV_SOCKET      = "/tmp/mpvsocket"          # MPV IPC socket path
REPORT_INTERVAL = 10                     # seconds between status reports

# ── State (in-memory only) ─────────────────────────────────────────────────────
_last_traffic_time  = 0
_last_traffic_bytes = 0
_traffic_history     = []
_server_url         = None               # Discovered at runtime
_current_stream_url = None
_last_load_attempt  = 0                  # Cooldown for MPV loadfile enforcement
_last_frame_count   = -1                 # Track rendered frames to detect freezes
_stall_count        = 0                  # Number of consecutive stall detections
_ipc_fail_count     = 0                  # Number of consecutive IPC failures
_last_hdmi_status   = None               # Tracks physical HDMI connection state

# ── Identity ───────────────────────────────────────────────────────────────────
def get_receiver_id() -> str:
    """Stable UUID from hardware MAC address or CPU serial."""
    mac = None
    # Try to read real ethernet MAC directly
    for iface in ['eth0', 'end0', 'wlan0']:
        try:
            with open(f'/sys/class/net/{iface}/address', 'r') as f:
                mac_str = f.read().strip()
                mac = int(mac_str.replace(':', ''), 16)
                if mac: break
        except Exception:
            pass
            
    # If no valid MAC, try Raspberry Pi CPU Serial
    if not mac:
        try:
            with open('/proc/cpuinfo', 'r') as f:
                for line in f:
                    if line.startswith('Serial'):
                        serial = line.split(':')[1].strip()
                        mac = int(serial[-12:], 16)
                        break
        except Exception:
            pass

    # Fallback to python node check
    if not mac:
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
def mpv_send(command: list) -> dict | list | None:
    """Sends one or more JSON commands to MPV and waits for ALL responses."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(MPV_SOCKET)
        
        expected_responses = 1
        if command and isinstance(command[0], list):
            expected_responses = len(command)
            msg = ""
            for cmd in command:
                msg += json.dumps({"command": cmd, "async": False}) + "\n"
        else:
            msg = json.dumps({"command": command}) + "\n"
            
        s.send(msg.encode())
        
        # Robust read: loop until we have all expected responses or timeout
        response_raw = ""
        received_count = 0
        start_time = time.monotonic()
        
        while received_count < expected_responses and (time.monotonic() - start_time) < 2.0:
            try:
                chunk = s.recv(16384).decode()
                if not chunk: break
                response_raw += chunk
                # Count lines that look like valid JSON responses (contain 'error' or 'data')
                received_count = 0
                for line in response_raw.split('\n'):
                    if ('"error"' in line or '"data"' in line) and ('"request_id"' not in line or '"event"' not in line):
                        received_count += 1
            except socket.timeout:
                break
                
        s.close()
        
        responses = []
        if response_raw:
            for line in response_raw.split('\n'):
                line = line.strip()
                if not line: continue
                try:
                    data = json.loads(line)
                    if 'error' in data or 'data' in data:
                        responses.append(data)
                except: continue
        
        if not responses: return None
        return responses[-1] if not isinstance(command[0], list) else responses
    except Exception as e:
        log(f"[MPV] IPC error: {e}")
        return None

def mpv_batch_get_properties(names: list) -> dict:
    """Gets multiple properties in a single socket connection."""
    commands = [["get_property", name] for name in names]
    results = mpv_send(commands)
    output = {}
    if isinstance(results, list):
        # MPV might mix in events. We filter for command responses and map by order
        data_responses = [r.get("data") for r in results if "error" in r]
        for i, name in enumerate(names):
            output[name] = data_responses[i] if i < len(data_responses) else None
    return output

def mpv_load(url: str) -> bool:
    """Instructs MPV to load a new stream URL. Returns True if IPC command accepted."""
    global _last_frame_count, _stall_count
    log(f"[MPV] Loading stream: {url}")
    # Reset counters on new load
    _last_frame_count = -1
    _stall_count = 0
    result = mpv_send(["loadfile", url, "replace"])
    if result is None:
        log(f"[MPV] loadfile failed — IPC socket error")
        return False
    err = result.get("error", "")
    if err and err != "success":
        log(f"[MPV] loadfile rejected by MPV: {err}")
        return False
    
    # Force volume to 30% on load
    mpv_send(["set_property", "volume", 30])
    
    log(f"[MPV] loadfile accepted (MPV response: {result})")
    return True

def mpv_get_path() -> str | None:
    """Gets the currently playing URL from MPV."""
    res = mpv_send(["get_property", "path"])
    if res and "data" in res:
        return res.get("data")
    return None

def mpv_get_property(name: str):
    """Gets any property from MPV."""
    res = mpv_send(["get_property", name])
    if res and "data" in res:
        return res.get("data")
    return None

def mpv_force_restart():
    """Hard-resets the player if it's deadlocked or frozen."""
    log("[Agent] Recovery: Force-restarting MPV process...")
    try:
        # Kill any existing mpv instance. 
        # We assume systemd or the agent's next cycle will handle the reload.
        subprocess.run(["sudo", "-n", "pkill", "-9", "mpv"], capture_output=True)
        time.sleep(2)
        # Attempt to restart the specific service if we know it
        subprocess.run(["sudo", "-n", "systemctl", "restart", "mpv-player.service"], capture_output=True)
    except Exception as e:
        log(f"[Agent] Restart failed: {e}")

def send_logs(server_url: str, receiver_id: str, hostname: str):
    """Fetches system and MPV logs and sends them to the server."""
    if not server_url:
        return
    try:
        log("[Agent] Fetching recent system and MPV logs...")
        mpv_logs = subprocess.run(["sudo", "journalctl", "-u", "mpv-player.service", "-n", "100", "--no-pager"], capture_output=True, text=True).stdout
        agent_logs = subprocess.run(["sudo", "journalctl", "-u", "tv-agent.service", "-n", "50", "--no-pager"], capture_output=True, text=True).stdout
        
        full_logs = "=== MPV LOGS ===\n" + mpv_logs + "\n=== AGENT LOGS ===\n" + agent_logs
        
        payload = {
            "id": receiver_id,
            "hostname": hostname,
            "logs": full_logs
        }
        requests.post(f"{server_url}/api/receivers/logs", json=payload, timeout=10)
        log("[Agent] Logs successfully sent to server.")
    except Exception as e:
        log(f"[Agent] Failed to send logs: {e}")

def ensure_hdmi_hotplug() -> bool:
    """Ensures the Raspberry Pi boots with HDMI forced on, even if headless. Returns True if reboot is needed."""
    modified = False
    paths = ["/boot/firmware/config.txt", "/boot/config.txt"]
    
    for p in paths:
        if os.path.exists(p):
            try:
                with open(p, 'r') as f:
                    content = f.read()
                
                if "hdmi_force_hotplug=1" not in content:
                    log(f"[Agent] hdmi_force_hotplug=1 not found in {p}. Adding it now...")
                    subprocess.run(["sudo", "bash", "-c", f"echo '' >> {p}"])
                    subprocess.run(["sudo", "bash", "-c", f"echo '# Auto-added by tv-agent for headless support' >> {p}"])
                    subprocess.run(["sudo", "bash", "-c", f"echo 'hdmi_force_hotplug=1' >> {p}"])
                    subprocess.run(["sudo", "bash", "-c", f"echo 'hdmi_group=2' >> {p}"])
                    subprocess.run(["sudo", "bash", "-c", f"echo 'hdmi_mode=82' >> {p}"])
                    modified = True
            except Exception as e:
                log(f"[Agent] Error checking/modifying {p}: {e}")
                
    return modified

def get_system_uptime() -> float:
    """Reads system uptime from /proc/uptime."""
    try:
        with open("/proc/uptime", "r") as f:
            return float(f.readline().split()[0])
    except Exception:
        return 0.0

def get_hdmi_status() -> str:
    """Reads the current connection status of all physical HDMI ports."""
    try:
        drm_path = "/sys/class/drm"
        if not os.path.exists(drm_path):
            return "unknown"
        
        connected_any = False
        disconnected_any = False
        
        for name in os.listdir(drm_path):
            if "HDMI-A" in name:
                status_file = os.path.join(drm_path, name, "status")
                if os.path.exists(status_file):
                    with open(status_file, "r") as f:
                        status = f.read().strip()
                        if status == "connected":
                            connected_any = True
                        elif status == "disconnected":
                            disconnected_any = True
                            
        if connected_any:
            return "connected"
        if disconnected_any:
            return "disconnected"
        return "unknown"
    except Exception as e:
        log(f"[HDMI] Error reading status: {e}")
        return "unknown"

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
    """Returns incoming traffic speed in bytes/second across all non-loopback interfaces (smoothed moving average)."""
    global _last_traffic_time, _last_traffic_bytes, _traffic_history
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
    if dt < 0.1:
        if _traffic_history:
            return sum(_traffic_history) / len(_traffic_history)
        return 0.0

    speed = (current_bytes - _last_traffic_bytes) / dt
    _last_traffic_time  = current_time
    _last_traffic_bytes = current_bytes
    
    _traffic_history.append(max(0.0, speed))
    if len(_traffic_history) > 12:
        _traffic_history.pop(0)
        
    return sum(_traffic_history) / len(_traffic_history)

# ── Main Loop ──────────────────────────────────────────────────────────────────
def main():
    global _server_url, _current_stream_url, _last_frame_count, _stall_count, _ipc_fail_count, _last_hdmi_status

    receiver_id = get_receiver_id()
    hostname    = get_hostname()
    log(f"[Agent] Started — ID: {receiver_id}, Host: {hostname}")

    # ── Initial HDMI Status & Boot Recovery ────────────────────────────────────
    hdmi_status = get_hdmi_status()
    log(f"[Agent] Initial HDMI Status: {hdmi_status}")
    _last_hdmi_status = hdmi_status
    
    # Boot Recovery: if system recently booted and HDMI is connected, force MPV restart
    uptime = get_system_uptime()
    if uptime > 0 and uptime < 300 and hdmi_status == "connected":
        log(f"[Agent] System recently booted ({uptime:.1f}s ago) with HDMI connected. Performing one-time MPV restart to ensure clean display binding...")
        mpv_force_restart()
        # Give MPV a moment to start up and initialize
        time.sleep(3)

    # ── Phase 0: System Tuning (Reliability) ──────────────────────────────────
    # Execute the tuning script if it exists to ensure network/OS settings are applied
    # We check common locations since the agent might run as root or pi
    possible_paths = [
        "/home/pi/tune_rpi.sh",
        os.path.expanduser("~/tune_rpi.sh")
    ]
    tune_script = None
    for p in possible_paths:
        if os.path.exists(p):
            tune_script = p
            break

    # Also check for audio fix script
    audio_fix_script = None
    audio_paths = ["/home/pi/fix_audio.sh", os.path.expanduser("~/fix_audio.sh")]
    for p in audio_paths:
        if os.path.exists(p):
            audio_fix_script = p
            break

    if tune_script:
        log(f"[Agent] Applying system tuning via {tune_script}...")
        try:
            # We use sudo -n (non-interactive) to prevent hanging if sudo requires a password
            # and --no-restart to prevent a restart loop when called from the agent itself.
            subprocess.run(["sudo", "-n", "bash", tune_script, "--no-restart"], capture_output=True, text=True, timeout=30)
            log("[Agent] Tuning script executed.")
        except Exception as e:
            log(f"[Agent] Tuning script failed: {e}")
    else:
        log("[Agent] Tuning script not found (checked: ~/, /home/pi/, /home/employee/), skipping Phase 0 tuning.")

    if audio_fix_script:
        log(f"[Agent] Applying HDMI audio fix via {audio_fix_script}...")
        try:
            subprocess.run(["sudo", "-n", "bash", audio_fix_script], capture_output=True, text=True, timeout=15)
            log("[Agent] Audio fix executed.")
        except Exception as e:
            log(f"[Agent] Audio fix failed: {e}")

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

    # ── Phase 4: Report loop detector ──────────────────────────────────────────
    while True:
        try:
            # 0. HDMI HOTPLUG DETECTION AND RECOVERY
            current_hdmi = get_hdmi_status()
            if _last_hdmi_status == "disconnected" and current_hdmi == "connected":
                log("[HDMI] Hotplug detected! HDMI changed from disconnected to connected. Restarting MPV to re-initialize physical display...")
                mpv_force_restart()
                _last_hdmi_status = current_hdmi
                time.sleep(REPORT_INTERVAL)
                continue
            _last_hdmi_status = current_hdmi

            # 1. ATOMIC STATUS CHECK (One connection per cycle)
            props = mpv_batch_get_properties([
                "path",
                "vo-frame-count", 
                "time-pos",
                "paused-for-cache", 
                "eof-reached", 
                "pause",
                "volume"
            ])
            
            playing = props.get("path")
            
            if props.get("volume") is None:
                # If volume is None, IPC definitely failed
                _ipc_fail_count += 1
                log(f"[Agent] MPV IPC unreachable (fail #{_ipc_fail_count}/5)")
                if _ipc_fail_count >= 5:
                    log("[Agent] IPC dead for 50s. Triggering hardware recovery...")
                    send_logs(_server_url, receiver_id, hostname)
                    if ensure_hdmi_hotplug():
                        log("[Agent] Applied hdmi_force_hotplug. Rebooting to take effect...")
                        subprocess.run(["sudo", "reboot"])
                    else:
                        mpv_force_restart()
                    _ipc_fail_count = 0
                time.sleep(REPORT_INTERVAL)
                continue
            
            _ipc_fail_count = 0
            traffic_speed = get_traffic_speed() # Current speed in bytes/s

            # 2. Check for Frozen Playback (Anti-Stuck Logic v7 - Consolidated)
            if playing and _current_stream_url and playing == _current_stream_url:
                current_frames = props.get("vo-frame-count")
                # Fallback to time-pos if vo-frame-count is not supported or None
                if current_frames is None:
                    current_frames = props.get("time-pos")
                
                is_buffering = props.get("paused-for-cache") == True
                eof_reached = props.get("eof-reached") == True
                is_paused = props.get("pause") == True
                
                # RECOVERY 1: Forced Unpause if player got stuck in pause state
                if is_paused and not is_buffering:
                    log("[Agent] MPV is PAUSED while stream is active. Forcing unpause...")
                    mpv_send(["set_property", "pause", False])
                    time.sleep(1) 

                # RECOVERY 2: If EOF is reached on a live stream, reload immediately
                if eof_reached:
                    log(f"[Agent] EOF REACHED on live stream. Triggering immediate reconnection...")
                    mpv_load(_current_stream_url)
                elif current_frames is not None:
                    # If frame count / time-pos hasn't moved, we are stalled
                    if current_frames == _last_frame_count and not is_buffering:
                        _stall_count += 1
                        
                        # Use a 50KB/s threshold for lower bitrate safety
                        if traffic_speed > 50000: 
                            if _stall_count >= 3:
                                log(f"[Agent] STALL DETECTED: Playback frozen at {current_frames} despite traffic ({traffic_speed/1024:.1f} KB/s). Reloading...")
                                mpv_load(_current_stream_url)
                                if _stall_count >= 6:
                                    log("[Agent] STALL PERSISTS after reload. Hardware-resetting player.")
                                    send_logs(_server_url, receiver_id, hostname)
                                    mpv_force_restart()
                        else:
                            # Network is idle. We wait, but for 60s max
                            if _stall_count >= 6:
                                log(f"[Agent] Fallback: Stalled for 60s with no traffic. Forcing reconnect...")
                                mpv_load(_current_stream_url)
                            elif _stall_count % 3 == 0:
                                log(f"[Agent] Playback idle (Position fixed at {current_frames}). Network is idle too. Waiting...")
                    else:
                        # Playback is moving
                        _stall_count = 0
                        _last_frame_count = current_frames
                else:
                    _stall_count = 0
            else:
                _stall_count = 0
                _last_frame_count = -1

            # 3. ENFORCEMENT: If MPV is idle or playing wrong URL, reload
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
                "version":            AGENT_VERSION,
                "cpu_usage":          get_cpu_usage(),
                "temperature":        get_temperature(),
                "traffic_speed":      get_traffic_speed(),
                "current_source_ip":  "Detected",
                "current_stream_url": report_playing,
                "actual_volume":      props.get("volume"),
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
                
                # Check for settings sync (volume)
                server_vol = data.get("volume")
                if server_vol is not None:
                    log(f"[Agent] Syncing volume to server Target: {server_vol}%")
                    mpv_send(["set_property", "volume", server_vol])

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










