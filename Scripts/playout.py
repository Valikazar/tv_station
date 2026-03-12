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
            if 'ffmpeg' in line and '-f mpegts' in line and 'pipe:1' in line:
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
SIGNAL_FILE = f"/tmp/schedule_updated_ch{CHANNEL_ID}"  # Hot-reload trigger

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
        self.q = queue.Queue(maxsize=300) # 300 * 131072 = ~40MB buffer
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
                # Drop remaining queue items to avoid backlog after crash
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

    def get_next_item(self, silent=False):
        now = datetime.now()
        if not silent:
            # Diagnostic: log current time being used for DB lookup
            self.log_decision(f"[Decision] Checking schedule for time: {now.strftime('%H:%M:%S')}")
        cursor = self.get_db_cursor()
        
        # Find what SHOULD be playing right now, excluding the one we just finished
        if self.last_played_id:
            query_current = """SELECT gp.id, gp.video_id, gp.start_time, gp.duration, gp.filename, gp.entry_type, IFNULL(ts.exclude_from_stats, 0) as exclude_from_stats
                FROM generated_playlists gp
                LEFT JOIN time_slots ts ON gp.slot_id = ts.id
                WHERE gp.start_time <= %s AND DATE_ADD(gp.start_time, INTERVAL gp.duration/1000 SECOND) > %s 
                AND gp.id != %s AND gp.channel_id = %s
                ORDER BY gp.start_time DESC LIMIT 1"""
            cursor.execute(query_current, (now, now, self.last_played_id, CHANNEL_ID))
        else:
            query_current = """SELECT gp.id, gp.video_id, gp.start_time, gp.duration, gp.filename, gp.entry_type, IFNULL(ts.exclude_from_stats, 0) as exclude_from_stats
                FROM generated_playlists gp
                LEFT JOIN time_slots ts ON gp.slot_id = ts.id
                WHERE gp.start_time <= %s AND DATE_ADD(gp.start_time, INTERVAL gp.duration/1000 SECOND) > %s 
                AND gp.channel_id = %s
                ORDER BY gp.start_time DESC LIMIT 1"""
            cursor.execute(query_current, (now, now, CHANNEL_ID))
        
        current = cursor.fetchone()
        if current:
            if not silent:
                self.log_decision(f"[Decision] Selecting CURRENT idx {current['id']} | file={current['filename']} | type={current.get('entry_type', 'unknown')}")
            return current, "current"
        
        # Nothing playing right now — find the next scheduled item
        query_next = """SELECT gp.id, gp.video_id, gp.start_time, gp.duration, gp.filename, gp.entry_type, IFNULL(ts.exclude_from_stats, 0) as exclude_from_stats
            FROM generated_playlists gp
            LEFT JOIN time_slots ts ON gp.slot_id = ts.id
            WHERE gp.start_time > %s AND gp.channel_id = %s ORDER BY gp.start_time ASC LIMIT 1"""
        cursor.execute(query_next, (now, CHANNEL_ID))
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

        # Try to find absolute path first (if it's already absolute or in standard fallback dir)
        paths_to_try = [
            os.path.join("/media/ads/fallback", fallback_file),
            os.path.join(MEDIA_DIR, "fallback", fallback_file),
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

    def stream_file(self, filename, seek_seconds=0.0, duration_limit=None, video_id=None, exclude_from_stats=False, is_filler=False):
        # Resolve path: handle both absolute (filler) and relative (ads)
        if os.path.isabs(filename):
            filepath = filename
        else:
            filepath = os.path.join(MEDIA_DIR, filename)

        if not os.path.exists(filepath):
            logging.warning(f"FILE MISSING: {filepath} — will regenerate playlist")
            return 'missing'

        # Probe for exact actual duration to prevent PTS drift
        actual_duration = 0.0
        try:
            probe = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1', filepath],
                capture_output=True, text=True, timeout=5
            )
            file_dur = float(probe.stdout.strip())
            
            if seek_seconds > 0 and duration_limit is None:
                if seek_seconds >= file_dur - 1.0:
                    logging.info(f"Skipping {filename}: seek {seek_seconds:.1f}s >= duration {file_dur:.1f}s")
                    return True  # Treat as success so we move on

            actual_duration = file_dur
            if seek_seconds > 0:
                actual_duration -= seek_seconds
            if duration_limit and actual_duration > duration_limit:
                actual_duration = duration_limit
            if actual_duration < 0.0:
                actual_duration = 0.0
        except Exception:
            actual_duration = 0.0  # Fallback to elapsed wall-clock if probe fails

        vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p"
        
        # Probe for audio stream to decide if we need silent audio injection
        has_audio = False
        try:
            probe = subprocess.run(
                ['ffprobe', '-v', 'quiet', '-select_streams', 'a',
                 '-show_entries', 'stream=codec_type',
                 '-of', 'default=noprint_wrappers=1:nokey=1', filepath],
                capture_output=True, text=True, timeout=5
            )
            has_audio = 'audio' in probe.stdout
        except Exception:
            has_audio = True  # Assume audio exists if probe fails

        bitrate_k = int(os.environ.get('FFMPEG_BITRATE_K', 5000))

        # We transcode to ensure stable PTS and format for the Master FFmpeg
        cmd = [
            'ffmpeg', '-re', '-ss', f"{seek_seconds:.3f}",
            '-fflags', '+igndts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-i', filepath
        ]

        if duration_limit:
            cmd.insert(1, '-t')
            cmd.insert(2, f"{duration_limit:.3f}")

        if not has_audio:
            # Add silent stereo audio source matching our target format
            cmd += ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
            cmd += ['-map', '0:v:0', '-map', '1:a:0', '-shortest']
        else:
            cmd += ['-map', '0:v:0', '-map', '0:a:0']

        cmd += [
            '-filter:v', vf,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', f'{bitrate_k}k',
            '-maxrate', f'{bitrate_k}k', '-bufsize', f'{bitrate_k * 2}k',
            '-g', '50', '-r', '25', '-profile:v', 'main', '-level', '4.0',
            '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
            '-af', 'aresample=48000:async=1',
            '-flags', '+global_header',
            '-output_ts_offset', f"{self.ts_offset:.3f}",
            '-f', 'mpegts',
            'pipe:1'
        ]

        logging.info(f"Feeding FIFO with {filename} (seek={seek_seconds:.1f}s, ts_offset={self.ts_offset:.1f}s)...")
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

                chunk = self.process.stdout.read(131072)
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
                        break

                    # Filler interruption: stop if a real scheduled item is now due
                    if is_filler:
                        next_item, next_status = self.get_next_item(silent=True)
                        if next_status == "current":
                            logging.warning(f"Interrupting filler {filename}: scheduled item {next_item['filename']} is now due.")
                            break
            
            return True
        except Exception as e:
            if 'Broken pipe' in str(e) or 'Errno 32' in str(e) or isinstance(e, BrokenPipeError):
                logging.error(f"Broken pipe detected — master FFmpeg likely died. Resetting stream.")
                self.clear_queue()
                self._master_crashed = True
                self.ts_offset = 0.0
                time.sleep(2)
                try:
                    self.fifo_handle.close()
                except:
                    pass
                self.fifo_handle = open(FIFO_PATH, 'wb')
                logging.info("FIFO re-opened, ts_offset reset to 0.")
            else:
                logging.error(f"Feeder error: {e}")
                time.sleep(2)
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
                # Major reliability fix:
                # 1. If FFmpeg reported success, always use the known probed duration to keep PTS perfect.
                # 2. If it crashed/unfinished, use the best available estimate (duration limit or wall clock).
                if ret == 0 and actual_duration > 0.1:
                    added_offset = actual_duration
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
        logging.info("Starting FIFO Feeder Loop...")
        while True:
            item, status = self.get_next_item()
            now = datetime.now()
            if status == "current":
                seek = (now - item['start_time']).total_seconds()
                remaining = item['duration'] / 1000.0 - seek
                if remaining < 1.0:
                    self.last_played_id = item['id']
                    continue
                result = self.stream_file(item['filename'], seek_seconds=seek, duration_limit=remaining, video_id=item['video_id'], exclude_from_stats=item.get('exclude_from_stats', False))
                self.last_played_id = item['id']
                if result == 'missing':
                    self.regenerate_playlist()
            elif status == "next":
                if item:
                    wait = (item['start_time'] - now).total_seconds()
                    if wait > 2.0: # Stability fix: ignore gaps < 2s to avoid flashing filler
                        filler = self.get_filler()
                        if filler: self.stream_file(filler['filename'], duration_limit=wait, video_id=filler['id'], exclude_from_stats=False, is_filler=True)
                        else: time.sleep(min(wait, 5))
                    else:
                        result = self.stream_file(item['filename'], duration_limit=item['duration'] / 1000.0, video_id=item['video_id'], exclude_from_stats=item.get('exclude_from_stats', False))
                        self.last_played_id = item['id']
                        if result == 'missing':
                            self.regenerate_playlist()
                else:
                    filler = self.get_filler()
                    if filler: self.stream_file(filler['filename'], video_id=filler['id'], is_filler=True)
                    else: time.sleep(5)
            else:
                 time.sleep(5)

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
