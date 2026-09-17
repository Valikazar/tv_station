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
AGENT_VERSION   = "2.1.17"               # Auto-incremented by deploy.ps1
BEACON_URL      = "udp://226.0.0.1:5004"   # Fixed well-known beacon multicast address
MPV_SOCKET      = "/tmp/mpvsocket"          # MPV IPC socket path
REPORT_INTERVAL = 10                     # seconds between status reports
HTTP_TIMEOUT    = (3, 7)                 # (connect_timeout, read_timeout) in seconds
SESSION_MAX_AGE = 300                    # recreate HTTP session every 5 minutes to prevent CLOSE-WAIT leaks

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
_http_session       = None               # Managed requests.Session
_session_created_at = 0.0                # Timestamp of last session creation
_stream_load_time   = 0.0                # Tracks wall time when the stream was last loaded
_udp_errors_history = []                 # list of (timestamp, error_count) to track last hour drops

# ── HTTP Session Management ────────────────────────────────────────────────────
def _get_session() -> requests.Session:
    """Returns a managed HTTP session, recreating it if stale to prevent CLOSE-WAIT leaks."""
    global _http_session, _session_created_at
    now = time.time()
    if _http_session is None or (now - _session_created_at) > SESSION_MAX_AGE:
        if _http_session is not None:
            try: _http_session.close()
            except: pass
        _http_session = requests.Session()
        # Disable keep-alive retries — we'd rather fail fast and reconnect clean
        adapter = requests.adapters.HTTPAdapter(
            max_retries=0,
            pool_connections=1,
            pool_maxsize=1
        )
        _http_session.mount('http://', adapter)
        _http_session.mount('https://', adapter)
        _session_created_at = now
        log("[HTTP] New session created")
    return _http_session

def _reset_session():
    """Force-closes and discards the current HTTP session (call on network errors)."""
    global _http_session, _session_created_at
    if _http_session is not None:
        try: _http_session.close()
        except: pass
        _http_session = None
        _session_created_at = 0.0
        log("[HTTP] Session reset due to error")

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
    global _last_frame_count, _stall_count, _stream_load_time
    log(f"[MPV] Loading stream: {url}")
    # Reset counters on new load
    _last_frame_count = -1
    _stall_count = 0
    _stream_load_time = time.time()
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
        _get_session().post(f"{server_url}/api/receivers/logs", json=payload, timeout=HTTP_TIMEOUT)
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

def get_mpv_uptime() -> float:
    """Gets the uptime of the MPV process in seconds."""
    try:
        pid_bytes = subprocess.run(["pgrep", "-x", "mpv"], capture_output=True)
        pid_str = pid_bytes.stdout.decode().strip()
        if not pid_str:
            return 0.0
        pid = pid_str.split()[0]
        with open(f"/proc/{pid}/stat", "r") as f:
            stat_parts = f.read().split()
        starttime_ticks = float(stat_parts[21])
        ticks_per_sec = os.sysconf(os.sysconf_names['SC_CLK_TCK'])
        with open("/proc/uptime", "r") as f:
            sys_uptime = float(f.readline().split()[0])
        mpv_uptime = sys_uptime - (starttime_ticks / ticks_per_sec)
        return max(0.0, mpv_uptime)
    except Exception:
        return 0.0

def check_cec_tv_power(connector_name: str) -> str | None:
    """
    Queries the TV via CEC on the corresponding adapter.
    Returns:
      - "connected" if the TV is confirmed to be turned ON.
      - "disconnected" if the TV is confirmed to be turned OFF / Standby.
      - None if CEC is inactive, unsupported, or adapter cannot be probed.

    NOTE: We rely ONLY on GIVE_DEVICE_POWER_STATUS (mandatory CEC spec).
    GIVE_OSD_NAME is optional and many TVs (LG, Sony, etc.) return Rx,Timeout
    even when fully ON — do NOT use it for power state detection.
    """
    try:
        # Map HDMI-A-1 -> /dev/cec0, HDMI-A-2 -> /dev/cec1
        if "HDMI-A-1" in connector_name:
            cec_dev = "/dev/cec0"
        elif "HDMI-A-2" in connector_name:
            cec_dev = "/dev/cec1"
        else:
            return None
            
        if not os.path.exists(cec_dev):
            return None
            
        # Ensure CEC adapter is configured as Playback device (fast, no-op if already done)
        subprocess.run(["sudo", "-n", "cec-ctl", "-d", cec_dev, "--playback"], 
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
                        
        # Query power status — mandatory CEC spec, all compliant TVs support this
        # --timeout 1200 means 1.2s max wait for reply
        res = subprocess.run(
            ["sudo", "-n", "cec-ctl", "-d", cec_dev, "--to", "0", "--give-device-power-status", "--timeout", "1200"],
            capture_output=True, text=True, timeout=3
        )
        
        if res.returncode != 0 or "REPORT_POWER_STATUS" not in res.stdout:
            # TV did not reply at all -> CEC not active or TV physically disconnected
            return None
            
        stdout = res.stdout
        if "pwr-state: standby" in stdout or "pwr-state: to-standby" in stdout:
            log(f"[CEC] TV on {cec_dev} reports standby/off")
            return "disconnected"
            
        if "pwr-state: on" in stdout or "pwr-state: to-on" in stdout:
            # Query vendor ID to verify if the TV is truly ON or in QuickStart+ standby mode (LG/other TVs).
            # If the TV is in standby, the main board is asleep, and the Vendor ID query will time out.
            vendor_res = subprocess.run(
                ["sudo", "-n", "cec-ctl", "-d", cec_dev, "--to", "0", "--give-device-vendor-id", "--timeout", "1200"],
                capture_output=True, text=True, timeout=3
            )
            vendor_stdout = vendor_res.stdout
            if "Rx, Timeout" in vendor_stdout or "timeout" in vendor_stdout.lower():
                log(f"[CEC] TV on {cec_dev} reports ON but Vendor ID query timed out (standby/sleep mode)")
                return "disconnected"
                
            log(f"[CEC] TV on {cec_dev} confirms ON")
            return "connected"
            
        # Unrecognised power state — don't override DRM result
        return None
    except Exception as e:
        log(f"[CEC] Error querying TV power status: {e}")
        return None


def get_hdmi_status() -> str:
    """Reads the current connection status of the active HDMI display."""
    try:
        drm_path = "/sys/class/drm"
        if not os.path.exists(drm_path):
            return "unknown"
        
        candidates = []
        for name in os.listdir(drm_path):
            if "HDMI-A" in name:
                status_file = os.path.join(drm_path, name, "status")
                edid_file = os.path.join(drm_path, name, "edid")
                if os.path.exists(status_file):
                    with open(status_file, "r") as f:
                        status = f.read().strip()
                    
                    has_edid = False
                    if os.path.exists(edid_file):
                        try:
                            with open(edid_file, "rb") as edid_f:
                                has_edid = len(edid_f.read(8)) > 0
                        except Exception:
                            pass
                    
                    connector_name = name
                    if "-" in name:
                        parts = name.split("-", 1)
                        if len(parts) > 1:
                            connector_name = parts[1]
                    
                    candidates.append({
                        "name": connector_name,
                        "status": status,
                        "has_edid": has_edid
                    })
        
        if not candidates:
            return "unknown"
            
        # Prioritize candidate with a valid EDID
        active_connector = None
        for c in candidates:
            if c["has_edid"]:
                active_connector = c
                break
                
        if not active_connector:
            # If no EDID is found anywhere, return "connected" if any are connected, else "disconnected"
            for c in candidates:
                if c["status"] == "connected":
                    active_connector = c
                    break
        
        if not active_connector:
            return "disconnected"
            
        if active_connector["status"] != "connected":
            return "disconnected"
            
        # Check TV power state via CEC if active_connector is connected
        cec_power = check_cec_tv_power(active_connector["name"])
        if cec_power == "disconnected":
            return "disconnected"
            
        return active_connector["status"]
    except Exception as e:
        log(f"[HDMI] Error reading status: {e}")
        return "unknown"

def detect_active_drm_connector() -> str | None:
    """
    Scans DRM connectors in /sys/class/drm/ to find the best physical HDMI display.
    Prioritizes connectors that are 'connected' AND have a non-empty EDID.
    Falls back to the first 'connected' connector.
    """
    drm_path = "/sys/class/drm"
    if not os.path.exists(drm_path):
        return None
        
    candidates = [] # list of (connector_name, has_edid)
    for name in os.listdir(drm_path):
        if "HDMI-A" in name:
            status_file = os.path.join(drm_path, name, "status")
            edid_file = os.path.join(drm_path, name, "edid")
            
            if os.path.exists(status_file):
                try:
                    with open(status_file, "r") as f:
                        status = f.read().strip()
                    if status == "connected":
                        has_edid = False
                        if os.path.exists(edid_file):
                            try:
                                with open(edid_file, "rb") as edid_f:
                                    has_edid = len(edid_f.read(8)) > 0
                            except Exception:
                                pass
                        
                        connector_name = name
                        if "-" in name:
                            parts = name.split("-", 1)
                            if len(parts) > 1:
                                connector_name = parts[1]
                        
                        candidates.append((connector_name, has_edid))
                except Exception as e:
                    log(f"[DRM] Error reading connector {name}: {e}")
                    
    if not candidates:
        return None
        
    for conn, has_edid in candidates:
        if has_edid:
            return conn
            
    return candidates[0][0]

def update_mpv_connector(connector: str) -> bool:
    """Updates the drm-connector option in the user's mpv.conf if it differs. Returns True if updated."""
    if not connector:
        return False
        
    config_paths = [
        "/home/pi/.config/mpv/mpv.conf",
        os.path.expanduser("~/.config/mpv/mpv.conf")
    ]
    
    unique_paths = []
    for p in config_paths:
        if p not in unique_paths and os.path.exists(p):
            unique_paths.append(p)
            
    if not unique_paths:
        config_dir = "/home/pi/.config/mpv"
        if os.path.exists("/home/pi"):
            os.makedirs(config_dir, exist_ok=True)
            unique_paths = [os.path.join(config_dir, "mpv.conf")]
            with open(unique_paths[0], "w") as f:
                pass
        else:
            return False

    updated_any = False
    for p in unique_paths:
        try:
            with open(p, "r") as f:
                content = f.read()
                
            match = re.search(r'^\s*drm-connector\s*=\s*(.+)$', content, re.MULTILINE)
            if match:
                current_val = match.group(1).strip()
                if current_val == connector:
                    continue
                new_content = re.sub(r'^\s*drm-connector\s*=\s*.*$', f'drm-connector={connector}', content, flags=re.MULTILINE)
            else:
                new_content = content.rstrip() + f"\n\n# Dynamic DRM Connector auto-detected\ndrm-connector={connector}\n"
                
            log(f"[Agent] Updating {p} with drm-connector={connector}...")
            with open(p, "w") as f:
                f.write(new_content)
                
            if os.geteuid() == 0:
                try:
                    import pwd
                    pi_uid = pwd.getpwnam('pi').pw_uid
                    pi_gid = pwd.getpwnam('pi').pw_gid
                    os.chown(p, pi_uid, pi_gid)
                except Exception:
                    pass
            updated_any = True
        except Exception as e:
            log(f"[Agent] Error updating {p}: {e}")
            
    if updated_any:
        log(f"[Agent] Restarting mpv-player to apply new DRM connector: {connector}...")
        mpv_force_restart()
        return True
    return False

def ensure_correct_connector(force_restart_on_no_change=False):
    """Detects active connector, updates mpv.conf, and restarts MPV if needed."""
    connector = detect_active_drm_connector()
    if connector:
        updated = update_mpv_connector(connector)
        if not updated and force_restart_on_no_change:
            log("[Agent] Connector unchanged, but forcing MPV restart anyway...")
            mpv_force_restart()

# ── Metrics ────────────────────────────────────────────────────────────────────

def get_ethernet_link_speed() -> str:
    """Reads ethernet link speed from sysfs."""
    try:
        for iface in ['eth0', 'end0']:
            path = f"/sys/class/net/{iface}"
            if os.path.exists(path):
                operstate_file = f"{path}/operstate"
                speed_file = f"{path}/speed"
                if os.path.exists(operstate_file):
                    with open(operstate_file, 'r') as f:
                        state = f.read().strip()
                    if state == "down":
                        return "down"
                if os.path.exists(speed_file):
                    with open(speed_file, 'r') as f:
                        speed = f.read().strip()
                        return f"{speed} Mbps"
        return "unknown"
    except:
        return "error"

def get_udp_rcvbuf_errors() -> int:
    """Reads UDP receive buffer errors from /proc/net/snmp."""
    try:
        if os.path.exists("/proc/net/snmp"):
            with open("/proc/net/snmp", "r") as f:
                for line in f:
                    if line.startswith("Udp:"):
                        parts = line.split()
                        if parts[1].isdigit():
                            if len(parts) > 5:
                                return int(parts[5])
        return 0
    except:
        return 0

def get_udp_errors_last_hour() -> int:
    """Calculates UDP drops occurred within the last 1 hour using a sliding in-memory history."""
    global _udp_errors_history
    try:
        now = time.time()
        current_errors = get_udp_rcvbuf_errors()
        
        # Append current measurement
        _udp_errors_history.append((now, current_errors))
        
        # Remove older than 1 hour (3600 seconds)
        _udp_errors_history = [item for item in _udp_errors_history if now - item[0] <= 3600]
        
        if len(_udp_errors_history) > 0:
            oldest_time, oldest_errors = _udp_errors_history[0]
            # Handle counter reset (e.g. reboot)
            if current_errors < oldest_errors:
                _udp_errors_history = [(now, current_errors)]
                return 0
            return current_errors - oldest_errors
        return 0
    except Exception as e:
        log(f"[Metrics] UDP last hour calculation error: {e}")
        return 0

def get_ethernet_errors() -> dict:
    """Reads physical layer errors from ethtool for eth0 or end0."""
    out = {"fcs": 0, "align": 0, "symbol": 0}
    try:
        for iface in ['eth0', 'end0']:
            path = f"/sys/class/net/{iface}"
            if os.path.exists(path):
                res = subprocess.run(
                    ["sudo", "-n", "/usr/sbin/ethtool", "-S", iface],
                    capture_output=True, text=True, timeout=5
                )
                if res.returncode == 0:
                    for line in res.stdout.splitlines():
                        line = line.strip()
                        if not line: continue
                        parts = line.split(":")
                        if len(parts) == 2:
                            key = parts[0].strip()
                            try:
                                val = int(parts[1].strip())
                            except ValueError:
                                continue
                            if key in ['rx_fcs', 'rx_frame_check_sequence_errors']:
                                out["fcs"] = val
                            elif key in ['rx_align', 'rx_alignment_errors']:
                                out["align"] = val
                            elif key in ['rx_code', 'rx_symbol_errors']:
                                out["symbol"] = val
                break
    except Exception as e:
        log(f"[Metrics] Ethernet errors detection failed: {e}")
    return out

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
    global _server_url, _current_stream_url, _last_frame_count, _stall_count, _ipc_fail_count, _last_hdmi_status, _stream_load_time

    receiver_id = get_receiver_id()
    hostname    = get_hostname()
    log(f"[Agent] Started — ID: {receiver_id}, Host: {hostname}")

    # ── Initial HDMI Status & Boot Recovery ────────────────────────────────────
    hdmi_status = get_hdmi_status()
    log(f"[Agent] Initial HDMI Status: {hdmi_status}")
    _last_hdmi_status = hdmi_status
    
    # Auto-detect correct DRM connector on startup
    uptime = get_system_uptime()
    if hdmi_status == "connected":
        sentinel_path = "/tmp/.agent_boot_restart_done"
        force_restart = (uptime > 0 and uptime < 300) and not os.path.exists(sentinel_path)
        if force_restart:
            try:
                with open(sentinel_path, "w") as f:
                    f.write("1")
            except Exception:
                pass
        ensure_correct_connector(force_restart_on_no_change=force_restart)
        if force_restart:
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
            resp = _get_session().get(config_url, params={"id": receiver_id, "hostname": hostname}, timeout=HTTP_TIMEOUT)
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
                log("[HDMI] Hotplug detected! HDMI changed from disconnected to connected. Re-detecting connector and restarting MPV...")
                ensure_correct_connector(force_restart_on_no_change=True)
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
                "volume",
                "vo-configured",
                "current-vo",
                "demuxer-cache-duration"
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

            # 1.5. CHECK FOR ACTIVE HDMI OUTPUT BINDING (HDMI verification)
            if playing and _current_stream_url and playing == _current_stream_url:
                vo_configured = props.get("vo-configured")
                current_vo = props.get("current-vo")
                # Wait 15 seconds after loading the stream to allow MPV connection to establish
                if (time.time() - _stream_load_time) > 15:
                    if current_hdmi != "disconnected" and (vo_configured == False or not current_vo):
                        log(f"[HDMI] Screen is active but MPV display binding failed (vo-configured: {vo_configured}, vo: {current_vo}). Re-detecting connector and restarting MPV...")
                        ensure_correct_connector(force_restart_on_no_change=True)
                        time.sleep(REPORT_INTERVAL)
                        continue

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

            # Determine active connector to report in hdmi_status if connected
            connector = detect_active_drm_connector()
            hdmi_val = connector if current_hdmi == "connected" and connector else current_hdmi

            eth_errs = get_ethernet_errors()

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
                "link_speed":         get_ethernet_link_speed(),
                "udp_errors":         get_udp_rcvbuf_errors(),
                "udp_errors_1h":      get_udp_errors_last_hour(),
                "mpv_cache_duration": props.get("demuxer-cache-duration"),
                "hdmi_status":        hdmi_val,
                "mpv_uptime":         int(get_mpv_uptime()),
                "eth_fcs_errors":     eth_errs["fcs"],
                "eth_align_errors":   eth_errs["align"],
                "eth_symbol_errors":  eth_errs["symbol"],
            }

            try:
                report_url = f"{_server_url}/api/receivers/report"
                response   = _get_session().post(report_url, json=payload, timeout=HTTP_TIMEOUT)
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
                print(f"[Agent] Report failed: {e}. Resetting HTTP session and re-discovering server...")
                _reset_session()
                new_server = discover_server()
                if new_server:
                    _server_url = new_server

        except Exception as e:
            print(f"[Agent] Loop error: {e}")

        time.sleep(REPORT_INTERVAL)


if __name__ == "__main__":
    main()










