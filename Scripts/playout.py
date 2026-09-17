import os
import time
import subprocess
import mysql.connector
from datetime import datetime, timedelta
import logging
import sys
import threading
import signal
import random
import json

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def kill_stale_feeders():
    """Kill any ffmpeg feeder processes from a previous playout.py run."""
    import signal as _signal
    try:
        # Use ps -ef instead of pgrep for better compatibility
        result = subprocess.run(
            ['ps', '-ef'],
            capture_output=True, text=True
        )
        lines = result.stdout.strip().split('\n')
        own_pid = os.getpid()
        for line in lines:
            # Only kill feeders belonging to THIS channel to avoid cross-channel interference
            if 'ffmpeg' in line and f'title=feeder_ch{CHANNEL_ID}' in line:
                parts = line.split()
                if len(parts) > 1 and parts[1].isdigit():
                    pid = int(parts[1])
                    if pid != own_pid:
                        try:
                            os.kill(pid, _signal.SIGKILL)
                            logging.warning(f"Killed stale ffmpeg feeder PID {pid}")
                        except ProcessLookupError:
                            pass
    except FileNotFoundError:
        # Command 'ps' not found, skip stale feeder cleanup
        pass
    except Exception as e:
        logging.warning(f"Could not scan for stale ffmpeg feeders: {e}")

def lock_process():
    import fcntl
    CHANNEL_ID = int(os.environ.get('CHANNEL_ID', 1))
    lock_file = f'/tmp/playout_ch{CHANNEL_ID}.lock'
    handle = open(lock_file, 'w')
    try:
        fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except (IOError, OSError):
        logging.error("Another instance of playout.py is already running. Exiting.")
        sys.exit(1)

def load_env():
    paths = ['/opt/tv_station/.env', '.env', '../.env']
    for p in paths:
        if os.path.exists(p):
            try:
                with open(p) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#') and '=' in line:
                            k, v = line.split('=', 1)
                            if k.strip() not in os.environ:
                                os.environ[k.strip()] = v.strip()
            except: pass

load_env()

# Constants
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', 'localhost'),
    'user': os.environ.get('DB_USER', 'logger'),
    'password': os.environ.get('DB_PASS', 'password'),
    'database': os.environ.get('DB_NAME', 'tv_stats')
}

CHANNEL_ID = int(os.environ.get('CHANNEL_ID', 1))

MEDIA_DIR = os.environ.get('MEDIA_DIR', '/media/new_ads/')
FIFO_PATH = f"/tmp/playout_fifo_ch{CHANNEL_ID}"
SIGNAL_FILE = f"/tmp/schedule_updated_ch{CHANNEL_ID}"
_PROBE_CACHE = {}

def probe_file_info(filepath):
    if filepath in _PROBE_CACHE:
        return _PROBE_CACHE[filepath]
    
    duration = 0.0
    has_audio = False
    try:
        cmd = [
            'ffprobe', '-v', 'quiet', 
            '-show_entries', 'format=duration:stream=codec_type',
            '-of', 'json', filepath
        ]
        probe = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if probe.returncode == 0 and probe.stdout.strip():
            data = json.loads(probe.stdout)
            if 'format' in data and 'duration' in data['format']:
                duration = float(data['format']['duration'])
            if 'streams' in data:
                for stream in data['streams']:
                    if stream.get('codec_type') == 'audio':
                        has_audio = True
                        break
    except Exception as e:
        logging.error(f"Error probing {filepath}: {e}")
        
    _PROBE_CACHE[filepath] = (duration, has_audio)
    return duration, has_audio

def probe_stream_has_audio(stream_url):
    """Quick check if an RTSP/HTTP stream has an audio track."""
    try:
        cmd = [
            'ffprobe', '-v', 'quiet',
            '-rtsp_transport', 'tcp',
            '-show_entries', 'stream=codec_type',
            '-of', 'json',
            '-read_intervals', '%+5',
            stream_url
        ]
        probe = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if probe.returncode == 0 and probe.stdout.strip():
            data = json.loads(probe.stdout)
            for s in data.get('streams', []):
                if s.get('codec_type') == 'audio':
                    return True
    except Exception as e:
        logging.warning(f"probe_stream_has_audio({stream_url}): {e}")
    return False

class PlayoutSender:
    def __init__(self):
        self.conn = None
        self.process = None
        self.last_played_id = None  # Track last played playlist entry to avoid double-play
        self.ts_offset = 0.0  # Cumulative timestamp offset for continuous PTS
        self._last_decision_key = None
        self._last_decision_time = 0
        self.writer_error = None
        self.connect_db()
        # Ensure FIFO exists
        if not os.path.exists(FIFO_PATH):
            os.mkfifo(FIFO_PATH)
            os.chmod(FIFO_PATH, 0o666)
            logging.info(f"Created FIFO at {FIFO_PATH}")
        
        # PERSISTENT FIFO HANDLE: This prevents Master FFmpeg from exiting on EOF
        logging.info(f"Opening FIFO {FIFO_PATH} for persistent writing...")
        self.fifo_handle = open(FIFO_PATH, 'wb')
        logging.info("FIFO handle opened and locked live.")
        
        # Initialize a single background queue and writer thread for continuous output
        import queue
        import threading
        self.q = queue.Queue(maxsize=400) # 400 * 20KB = ~8.0MB buffer (~12s @ 5Mbps)
        self._writer_thread = threading.Thread(target=self._fifo_writer_loop, daemon=True)
        self._writer_thread.start()

    def _fifo_writer_loop(self):
        while True:
            item = self.q.get()
            if item is None:
                continue
            
            try:
                if self.fifo_handle:
                    self.fifo_handle.write(item)
                    self.fifo_handle.flush()
            except Exception as e:
                self.writer_error = e
                try:
                    while not self.q.empty():
                        self.q.get_nowait()
                        self.q.task_done()
                except:
                    pass
                time.sleep(0.5)

    def clear_queue(self):
        """Clears the writer queue to prevent stale data from playing."""
        try:
            while not self.q.empty():
                self.q.get_nowait()
                self.q.task_done()
        except:
            pass
        self.writer_error = None

    def connect_db(self):
        try:
            self.conn = mysql.connector.connect(**DB_CONFIG)
            logging.info("DB Connected.")
        except Exception as e:
            logging.error(f"DB Connection failed: {e}")
            self.conn = None

    def reconnect_db(self):
        """Close and reopen DB connection to flush transaction isolation cache."""
        try:
            if self.conn:
                self.conn.close()
        except: pass
        self.conn = None
        self.connect_db()

    def get_db_cursor(self):
        while not self.conn or not self.conn.is_connected():
            time.sleep(5)
            self.connect_db()
        return self.conn.cursor(dictionary=True)

    def log_decision(self, message):
        """Logs a decision only if it's new or enough time has passed."""
        now = time.monotonic()
        if message != self._last_decision_key or (now - self._last_decision_time) > 30:
            logging.info(message)
            self._last_decision_key = message
            self._last_decision_time = now

    def get_next_item(self, current_time=None, silent=False):
        if current_time is None:
            current_time = datetime.now()
        
        if not silent:
            # Diagnostic: log current time being used for DB lookup
            self.log_decision(f"[Decision] Checking schedule for position: {current_time.strftime('%H:%M:%S')} (Wall: {datetime.now().strftime('%H:%M:%S')})")
        cursor = self.get_db_cursor()
        
        # Find what SHOULD be playing right now, excluding the one we just finished
        common_cols = """gp.id, gp.video_id, gp.start_time, gp.duration, gp.filename, gp.entry_type, gp.unmuted,
                IFNULL(ts.exclude_from_stats, 0) as exclude_from_stats,
                IFNULL(av.source_type, 'file') as source_type,
                av.stream_url,
                IFNULL(av.stream_buffer_sec, 5) as stream_buffer_sec"""

        if self.last_played_id:
            query_current = f"""SELECT {common_cols}
                FROM generated_playlists gp
                LEFT JOIN time_slots ts ON gp.slot_id = ts.id
                LEFT JOIN ad_videos av ON gp.video_id = av.id
                WHERE gp.start_time <= %s AND DATE_ADD(gp.start_time, INTERVAL gp.duration/1000 SECOND) > %s 
                AND gp.id != %s AND gp.channel_id = %s
                ORDER BY gp.start_time DESC LIMIT 1"""
            cursor.execute(query_current, (current_time, current_time, self.last_played_id, CHANNEL_ID))
        else:
            query_current = f"""SELECT {common_cols}
                FROM generated_playlists gp
                LEFT JOIN time_slots ts ON gp.slot_id = ts.id
                LEFT JOIN ad_videos av ON gp.video_id = av.id
                WHERE gp.start_time <= %s AND DATE_ADD(gp.start_time, INTERVAL gp.duration/1000 SECOND) > %s 
                AND gp.channel_id = %s
                ORDER BY gp.start_time DESC LIMIT 1"""
            cursor.execute(query_current, (current_time, current_time, CHANNEL_ID))
        
        current = cursor.fetchone()
        if current:
            if not silent:
                self.log_decision(f"[Decision] Selecting CURRENT idx {current['id']} | file={current['filename']} | type={current.get('entry_type', 'unknown')}")
            return current, "current"
        
        # Nothing playing right now — find the next scheduled item
        query_next = f"""SELECT {common_cols}
            FROM generated_playlists gp
            LEFT JOIN time_slots ts ON gp.slot_id = ts.id
            LEFT JOIN ad_videos av ON gp.video_id = av.id
            WHERE gp.start_time > %s AND gp.channel_id = %s ORDER BY gp.start_time ASC LIMIT 1"""
        cursor.execute(query_next, (current_time, CHANNEL_ID))
        nxt = cursor.fetchone()
        if nxt:
            if not silent:
                self.log_decision(f"[Decision] Selecting NEXT idx {nxt['id']} | file={nxt['filename']} | type={nxt.get('entry_type', 'unknown')} starting at {nxt['start_time']}")
        else:
            if not silent:
                self.log_decision("[Decision] No current or next scheduled items found in the database. Will fall back to filler.")
        return nxt, "next"

    def get_filler(self):
        """Returns the ultimate fallback video (fall.mp4 or channel-specific) for gaps."""
        fallback_file = "fall.mp4"
        try:
            cursor = self.get_db_cursor()
            cursor.execute("SELECT fallback_path FROM channel_settings WHERE channel_id = %s", (CHANNEL_ID,))
            row = cursor.fetchone()
            if row and row['fallback_path']:
                fallback_file = row['fallback_path']
        except Exception as e:
            logging.error(f"Error fetching channel fallback path: {e}")

        paths_to_try = [
            os.path.join("/media/fallback", fallback_file),
            os.path.join("/media/ads/fallback", fallback_file),
            os.path.join(MEDIA_DIR, "fallback", fallback_file),
            os.path.join(MEDIA_DIR, fallback_file),
            os.path.join("/media", fallback_file),
            os.path.join("/app/media/fallback", fallback_file),
            fallback_file # maybe it's absolute already
        ]
        
        for p in paths_to_try:
            if os.path.exists(p):
                return {'id': 0, 'filename': p}
        
        logging.warning(f"[Decision] Fallback filler {fallback_file} not found in any standard path!")
        return None


    def log_playback_start(self, video_id, exclude=False):
        if not video_id: return
        if exclude:
            logging.info(f"Skipped logging playback (Excluded Slot): ID {video_id} (Channel: {CHANNEL_ID})")
            return
        try:
            cursor = self.get_db_cursor()
            cursor.execute("INSERT INTO playback_log (video_id, start_time, channel_id) VALUES (%s, %s, %s)", (video_id, datetime.now(), CHANNEL_ID))
            self.conn.commit()
            logging.info(f"Logged playback: ID {video_id} (Channel: {CHANNEL_ID})")
        except Exception as e:
            logging.error(f"Failed to log playback: {e}")

    def regenerate_playlist(self):
        """Regenerate today's playlist in background when a file is missing."""
        now = datetime.now()
        # Cooldown: don't regenerate more than once per 5 minutes
        if hasattr(self, '_last_regen') and (now - self._last_regen).total_seconds() < 300:
            logging.info("Playlist regeneration skipped (cooldown active).")
            return
        self._last_regen = now
        
        def _regen():
            today_str = now.strftime('%Y-%m-%d')
            logging.warning(f"REGENERATING playlist for {today_str} due to missing file...")
            try:
                result = subprocess.run(
                    ['python3', '/app/generate_playlist.py', '--date', today_str],
                    env=os.environ.copy(),
                    capture_output=True, text=True, timeout=60
                )
                if result.returncode == 0:
                    logging.info(f"Playlist regenerated successfully for {today_str}.")
                else:
                    logging.error(f"Playlist regeneration failed: {result.stderr[-500:]}")
            except Exception as e:
                logging.error(f"Playlist regeneration error: {e}")
        
        thread = threading.Thread(target=_regen, daemon=True)
        thread.start()

    def stream_rtsp(self, stream_url, duration_limit, video_id=None, exclude_from_stats=False, is_unmuted=False, buffer_sec=5):
        """Pull an RTSP/HTTP live stream and feed it to the playout FIFO for the given duration.
        
        buffer_sec: seconds of pre-roll buffering before data starts to flow to FIFO.
                    Eliminates startup glitches at the cost of that delay.
        """
        logging.info(f"[Stream] Starting RTSP pull: {stream_url} (dur={duration_limit:.1f}s, buffer={buffer_sec}s)")
        self.log_playback_start(video_id, exclude=exclude_from_stats)
        stream_start = time.monotonic()

        # Check if stream has audio (for mute decision)
        has_audio = probe_stream_has_audio(stream_url)
        
        vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p"
        bitrate_k = int(os.environ.get('FFMPEG_BITRATE_K', 5000))
        v_bitrate = int(bitrate_k * 0.94)
        vf_sync = "setpts=PTS-STARTPTS"
        af_sync = "asetpts=PTS-STARTPTS,aresample=48000:async=1"

        cmd = [
            'ffmpeg',
            '-fflags', '+igndts+discardcorrupt+genpts',
            '-rtsp_transport', 'tcp',
            # Buffer the incoming stream to smooth startup
            '-thread_queue_size', '4096',
            '-analyzeduration', f'{buffer_sec * 1000000}',  # microseconds
            '-probesize', '10000000',
            '-timeout', '5000000',
            '-i', stream_url
        ]

        if not has_audio or not is_unmuted:
            cmd += ['-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
            cmd += ['-map', '0:v:0', '-map', '1:a:0']
        else:
            cmd += ['-map', '0:v:0', '-map', '0:a:0']

        cmd += [
            '-filter:v', f"{vf},{vf_sync}",
            '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', f'{v_bitrate}k',
            '-maxrate', f'{v_bitrate}k', '-bufsize', f'{bitrate_k * 2}k',
            '-bf', '0', '-vsync', 'cfr',
            '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
            '-r', '25', '-profile:v', 'high', '-level', '4.1',
            '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
            '-af', af_sync,
            '-max_interleave_delta', '0',
            '-shortest',
            '-max_delay', '500000',
            '-flags', '+global_header',
            '-metadata', f'title=feeder_ch{CHANNEL_ID}',
            '-output_ts_offset', f"{self.ts_offset:.3f}",
            '-t', f"{duration_limit:.3f}",
            '-f', 'mpegts',
            'pipe:1'
        ]

        log_file = None
        try:
            channel_id = os.environ.get('CHANNEL_ID', '1')
            log_path = f'/dev/shm/ch{channel_id}_stream.log'
            log_file = open(log_path, 'w')
            try: os.chmod(log_path, 0o666)
            except: pass

            self.process = subprocess.Popen(
                cmd,
                preexec_fn=os.setpgrp,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=log_file,
                bufsize=10**6
            )

            bytes_written = 0
            last_check_time = time.monotonic()
            while True:
                if self.writer_error:
                    raise self.writer_error

                chunk = self.process.stdout.read(20480)
                if not chunk:
                    break
                self.q.put(chunk)
                bytes_written += len(chunk)

                if time.monotonic() - last_check_time > 2.0:
                    last_check_time = time.monotonic()
                    if os.path.exists(SIGNAL_FILE):
                        try: os.remove(SIGNAL_FILE)
                        except: pass
                        logging.warning(f"[HotReload][Stream] Interrupting stream {stream_url}")
                        self.reconnect_db()
                        self.last_played_id = None
                        self._interrupted_by_hotreload = True
                        break

            return True
        except Exception as e:
            self._master_crashed = True
            wall_elapsed_at_crash = time.monotonic() - stream_start
            self.ts_offset += wall_elapsed_at_crash
            self.stream_start_time = datetime.now() - timedelta(seconds=self.ts_offset)
            self.clear_queue()
            logging.error(f"[Stream] Error: {e} — advancing ts_offset by {wall_elapsed_at_crash:.1f}s.")
            time.sleep(2)
            try: self.fifo_handle.close()
            except: pass
            self.fifo_handle = open(FIFO_PATH, 'wb')
            return False
        finally:
            wall_elapsed = time.monotonic() - stream_start
            ret = -1
            if self.process:
                ret = self.process.poll()
                if ret is None:
                    try:
                        os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
                        self.process.wait(timeout=5)
                    except:
                        try: self.process.kill()
                        except: pass
                ret = self.process.wait()
                self.process = None
            if log_file:
                try: log_file.close()
                except: pass

            if not getattr(self, '_master_crashed', False):
                if getattr(self, '_interrupted_by_hotreload', False):
                    self.ts_offset += wall_elapsed
                    self.stream_start_time = datetime.now() - timedelta(seconds=self.ts_offset)
                    self._interrupted_by_hotreload = False
                else:
                    self.ts_offset += wall_elapsed
            else:
                self._master_crashed = False

            logging.info(f"[Stream] Done: {stream_url}, {bytes_written // 1024}KB, elapsed={wall_elapsed:.1f}s, next_offset={self.ts_offset:.3f}s")

    def stream_file(self, filename, seek_seconds=0.0, duration_limit=None, video_id=None, exclude_from_stats=False, is_filler=False, is_unmuted=False):
        # Resolve path: handle both absolute (filler) and relative (ads)
        if os.path.isabs(filename):
            filepath = filename
        else:
            filepath = os.path.join(MEDIA_DIR, filename)

        if not os.path.exists(filepath):
            logging.warning(f"FILE MISSING: {filepath} — will regenerate playlist")
            return 'missing'

        # Probe for duration and audio using single cached probe
        file_dur, has_audio = probe_file_info(filepath)
        
        actual_duration = file_dur
        if seek_seconds > 0:
            if seek_seconds >= file_dur - 1.0:
                logging.info(f"Skipping {filename}: seek {seek_seconds:.1f}s >= duration {file_dur:.1f}s")
                return True
            actual_duration -= seek_seconds
        if duration_limit and actual_duration > duration_limit:
            actual_duration = duration_limit
        if actual_duration < 0.0:
            actual_duration = 0.0

        vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p"
        bitrate_k = int(os.environ.get('FFMPEG_BITRATE_K', 5000))

        # We remove '-re' from feeder because the Master FFmpeg uses '-re' on FIFO input.
        # This keeps our RAM queue and FIFO full, completely eliminating transitions freeze.
        cmd = [
            'ffmpeg', '-ss', f"{seek_seconds:.3f}",
            '-fflags', '+igndts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-i', filepath
        ]

        if not has_audio or not is_unmuted:
            # Add silent stereo audio source matching our target format
            cmd += ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
            cmd += ['-map', '0:v:0', '-map', '1:a:0']
        else:
            cmd += ['-map', '0:v:0', '-map', '0:a:0']

        v_bitrate = int(bitrate_k * 0.94)  # Give headroom for TS muxing overhead and audio
        
        # FIX A/V DESYNC: 
        # 1. Normalize PTS to 0
        # 2. Pad both streams so neither ends prematurely and causes a gap
        # 3. Use -t exactly at output to ensure exact duration without drift
        vf_sync = "setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=10"
        af_sync = "asetpts=PTS-STARTPTS,aresample=48000:async=1,apad=pad_dur=10"

        cmd += [
            '-filter:v', f"{vf},{vf_sync}",
            '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', f'{v_bitrate}k',
            '-maxrate', f'{v_bitrate}k', '-bufsize', f'{bitrate_k * 2}k',
            '-bf', '0', '-vsync', 'cfr', 
            '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', 
            '-r', '25', '-profile:v', 'high', '-level', '4.1',
            '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
            '-af', af_sync,
            '-max_interleave_delta', '0',
            '-max_delay', '500000',
            '-flags', '+global_header',
            '-metadata', f'title=feeder_ch{CHANNEL_ID}',
            '-output_ts_offset', f"{self.ts_offset:.3f}",
            '-t', f"{actual_duration:.3f}",
            '-f', 'mpegts',
            'pipe:1'
        ]

        logging.info(f"Feeding FIFO with {filename} (seek={seek_seconds:.1f}s, ts_offset={self.ts_offset:.1f}s)...")
        logging.debug(f"FFmpeg command: {' '.join(cmd)}")
        self.log_playback_start(video_id, exclude=exclude_from_stats)
        stream_start = time.monotonic()
        
        log_file = None
        try:
            channel_id = os.environ.get('CHANNEL_ID', '1')
            log_path = f'/dev/shm/ch{channel_id}_feeder.log'
            log_file = open(log_path, 'w')
            try: os.chmod(log_path, 0o666)
            except: pass

            self.process = subprocess.Popen(
                cmd,
                preexec_fn=os.setpgrp,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=log_file,
                bufsize=10**6
            )
            
            bytes_written = 0
            last_check_time = time.monotonic()
            while True:
                # Check if background writer thread hit an error (e.g. Broken Pipe)
                if self.writer_error:
                    raise self.writer_error

                chunk = self.process.stdout.read(20480) # 20KB buffer: perfect balanced middle ground
                if not chunk:
                    break
                self.q.put(chunk)
                bytes_written += len(chunk)
                
                # REACTIVE INTERRUPTION:
                # 1. Check for hot-reload signal from server (schedule was updated)
                # 2. If playing filler, also check if a scheduled item is now due
                if time.monotonic() - last_check_time > 2.0:
                    last_check_time = time.monotonic()

                    # Hot-reload: signal file created by server after Refresh Schedule
                    if os.path.exists(SIGNAL_FILE):
                        try: os.remove(SIGNAL_FILE)
                        except: pass
                        logging.warning(f"[HotReload] Schedule updated signal received — interrupting {filename}")
                        self.reconnect_db()       # Flush MySQL transaction cache
                        self.last_played_id = None  # Don't exclude current entry after regen
                        self._interrupted_by_hotreload = True
                        break

                    # Filler interruption: stop if a real scheduled item is now due
                    if is_filler:
                        next_item, next_status = self.get_next_item(silent=True)
                        if next_status == "current":
                            logging.warning(f"Interrupting filler {filename}: scheduled item {next_item['filename']} is now due.")
                            self._interrupted_by_filler = True
                            break
            
            return True
        except Exception as e:
            self._master_crashed = True
            # CRITICAL FIX: do NOT reset ts_offset to 0.0
            # The master was consuming at ~1x real-time speed, so advance ts_offset
            # by wall_elapsed to keep PTS continuity for the restarted master.
            wall_elapsed_at_crash = time.monotonic() - stream_start
            self.ts_offset += wall_elapsed_at_crash
            # Realign stream_start_time so virtual clock equals wall clock now
            self.stream_start_time = datetime.now() - timedelta(seconds=self.ts_offset)
            self.clear_queue()
            
            if 'Broken pipe' in str(e) or 'Errno 32' in str(e) or isinstance(e, BrokenPipeError):
                logging.error(f"Broken pipe detected — master FFmpeg likely died. Advancing ts_offset by {wall_elapsed_at_crash:.1f}s (new offset={self.ts_offset:.1f}s).")
            else:
                logging.error(f"Feeder error: {e} — advancing ts_offset by {wall_elapsed_at_crash:.1f}s.")
            
            time.sleep(2)
            try:
                self.fifo_handle.close()
            except:
                pass
            self.fifo_handle = open(FIFO_PATH, 'wb')
            logging.info(f"FIFO re-opened, ts_offset adjusted to {self.ts_offset:.1f}s (no reset).")
            return False
        finally:
            wall_elapsed = time.monotonic() - stream_start
            
            # Safely capture exit code and kill ffmpeg if needed
            ret = -1
            if self.process:
                ret = self.process.poll()
                if ret is None:
                    try:
                        os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
                        self.process.wait(timeout=5)
                    except:
                        try: self.process.kill()
                        except: pass
                
                ret = self.process.wait()
                if ret != 0:
                   logging.error(f"FFmpeg exited with {ret}")
                self.process = None
            if log_file:
                try: log_file.close()
                except: pass

            # Only increment ts_offset if master is still alive (not reset after crash)
            if not getattr(self, '_master_crashed', False):
                # Handle explicit hotreload or filler interruptions to prevent schedule drift
                if getattr(self, '_interrupted_by_hotreload', False):
                    added_offset = wall_elapsed
                    self.ts_offset += added_offset
                    # Realign virtual clock to wall clock: current_stream_time becomes datetime.now()
                    self.stream_start_time = datetime.now() - timedelta(seconds=self.ts_offset)
                    self._interrupted_by_hotreload = False
                    logging.info(f"[HotReload] Virtual clock realigned to wall clock (new offset={self.ts_offset:.1f}s).")
                elif getattr(self, '_interrupted_by_filler', False):
                    added_offset = wall_elapsed
                    self.ts_offset += added_offset
                    self._interrupted_by_filler = False
                elif ret == 0 and actual_duration > 0.1:
                    added_offset = actual_duration
                    self.ts_offset += added_offset
                else:
                    # Fallback for short/crashed/error segments
                    # Use wall elapsed if it's longer than what we thought we streamed, else trust actual_duration probe
                    added_offset = max(wall_elapsed, actual_duration if actual_duration > 0.1 else 0.0)
                    self.ts_offset += added_offset
            else:
                # Reset the flag for the next file
                self._master_crashed = False
                
            logging.info(f"File done/stopped: {filename}, {bytes_written // 1024}KB, elapsed={wall_elapsed:.1f}s (exact={actual_duration:.2f}s), next_offset={self.ts_offset:.3f}s")

    def run(self):
        logging.info("Starting FIFO Feeder Loop (Timing Swap Mode)...")
        self.stream_start_time = datetime.now()
        
        while True:
            # Timing Swap: calculate current stream position relative to start + offset
            # This allows the feeder to be ahead of wall-clock time
            current_stream_time = self.stream_start_time + timedelta(seconds=self.ts_offset)

            # Safety resync: if virtual clock is > 5 minutes behind wall time (e.g. after a
            # stuck-loop on missing files) or > 30 seconds ahead of wall time, auto-align.
            clock_lag = (datetime.now() - current_stream_time).total_seconds()
            if clock_lag > 300 or clock_lag < -30:
                logging.warning(f"[SafetyResync] Virtual clock lag is {clock_lag:.0f}s — auto-aligning to wall clock.")
                self.stream_start_time = datetime.now() - timedelta(seconds=self.ts_offset)
                continue

            item, status = self.get_next_item(current_time=current_stream_time)
            
            if status == "current":
                # Calculate seek based on virtual stream time, not actual wall clock
                seek = (current_stream_time - item['start_time']).total_seconds()
                remaining = item['duration'] / 1000.0 - seek
                if remaining < 0.5:
                    self.last_played_id = item['id']
                    continue
                is_unmuted = bool(item.get('unmuted', 0))
                source_type = item.get('source_type', 'file')
                if source_type == 'stream' and item.get('stream_url'):
                    result = self.stream_rtsp(
                        item['stream_url'],
                        duration_limit=remaining,
                        video_id=item['video_id'],
                        exclude_from_stats=item.get('exclude_from_stats', False),
                        is_unmuted=is_unmuted,
                        buffer_sec=int(item.get('stream_buffer_sec', 5))
                    )
                else:
                    result = self.stream_file(item['filename'], seek_seconds=seek, duration_limit=remaining, video_id=item['video_id'], exclude_from_stats=item.get('exclude_from_stats', False), is_unmuted=is_unmuted)
                
                if result is True:
                    self.last_played_id = item['id']
                elif result == 'missing':
                    self.last_played_id = item['id']
                    # Advance past the missing slot so we don't loop on it forever.
                    skip_s = max(remaining, 1.0)
                    logging.warning(f"[Missing] Skipping current item '{item['filename']}', advancing virtual clock by {skip_s:.1f}s.")
                    self.ts_offset += skip_s
                    time.sleep(0.5)
                    self.regenerate_playlist()
                else:
                    # result == False (crashed/disconnected)
                    # We do NOT set last_played_id, so it will be retried in the next loop iteration.
                    # Sleep a bit to avoid tight looping on a dead camera/process.
                    logging.warning(f"[Retry] Process crashed or disconnected. Retrying item '{item.get('filename', 'stream')}'...")
                    time.sleep(1.0)
            elif status == "next":
                if item:
                    wait = (item['start_time'] - current_stream_time).total_seconds()
                    if wait > 0.1:
                        filler = self.get_filler()
                        if filler:
                            # Play filler for exactly 'wait' seconds to bridge the gap and stay on schedule
                            logging.info(f"[Scheduler] Bridging a gap of {wait:.2f}s with filler: {filler['filename']}")
                            self.stream_file(filler['filename'], duration_limit=wait, video_id=filler['id'], is_filler=True)
                        else:
                            # No filler: jump virtual clock and sleep
                            logging.warning(f"[Scheduler] No filler found to bridge gap of {wait:.2f}s. Sleeping.")
                            sleep_time = min(wait, 2.0)
                            time.sleep(sleep_time)
                            self.ts_offset += sleep_time
                    else:
                        # Gap is negligible, advance virtual clock to reach start time in next iteration
                        self.ts_offset += wait
                        time.sleep(max(wait, 0.01))
                else:
                    filler = self.get_filler()
                    if filler:
                        self.stream_file(filler['filename'], video_id=filler['id'], is_filler=True)
                    else:
                        time.sleep(2)
            else:
                time.sleep(2)

if __name__ == "__main__":
    import signal
    current_sender = None

    def cleanup():
        if current_sender and current_sender.process:
            try: os.killpg(os.getpgid(current_sender.process.pid), signal.SIGTERM)
            except: pass

    def signal_handler(sig, frame):
        cleanup()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    lock_h = lock_process()
    kill_stale_feeders()
    current_sender = PlayoutSender()
    try:
        current_sender.run()
    except Exception as e:
        logging.error(f"Crashed: {e}")
    finally:
        cleanup()
