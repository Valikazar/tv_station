import os
import mysql.connector
from datetime import datetime, timedelta, date
import json
import logging
import sys

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Load .env manually
def load_env():
    paths = ['/opt/tv_station/.env', '.env', '../.env']
    for p in paths:
        if os.path.exists(p):
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        parts = line.split('=', 1)
                        if len(parts) == 2:
                            k, v = parts
                            if not os.environ.get(k.strip()):
                                os.environ[k.strip()] = v.strip()

load_env()

# Constants
DB_CONFIG = {
    'host': os.environ.get('DB_HOST', '127.0.0.1'),
    'user': os.environ.get('DB_USER', 'logger'),
    'password': os.environ.get('DB_PASS', 'password'),
    'database': os.environ.get('DB_NAME', 'tv_stats')
}

CHANNEL_ID = int(os.environ.get('CHANNEL_ID', 1))

FALLBACK_FILE = "fall.mp4"
FALLBACK_DURATION_MS = 8000 

def get_db_connection():
    return mysql.connector.connect(**DB_CONFIG)

def get_ms_from_time(t):
    return (t.hour * 3600 + t.minute * 60 + t.second) * 1000 + (t.microsecond // 1000)

def generate_playlist(target_date_str=None):
    conn = get_db_connection()
    cursor = conn.cursor(dictionary=True)

    if target_date_str:
        target_date = datetime.strptime(target_date_str, "%Y-%m-%d").date()
    else:
        target_date = date.today()

    logging.info(f"Generating playlist for {target_date} (Channel: {CHANNEL_ID})")

    # Clear existing for the target date
    cursor.execute("DELETE FROM generated_playlists WHERE schedule_date = %s AND channel_id = %s", (target_date, CHANNEL_ID))
    
    # Clean up historical playlists (older than today)
    try:
        cursor.execute("DELETE FROM generated_playlists WHERE schedule_date < CURRENT_DATE() AND channel_id = %s", (CHANNEL_ID,))
    except Exception as e:
        logging.error("Failed to clean up old playlists: " + str(e))

    conn.commit()

    # 1. Fetch Time Slots and Settings
    cursor.execute("SELECT * FROM time_slots WHERE channel_id = %s ORDER BY start_time", (CHANNEL_ID,))
    slots = cursor.fetchall()
    
    cursor.execute("SELECT main_start_behavior as start_behavior, fallback_path FROM channel_settings WHERE channel_id = %s", (CHANNEL_ID,))
    main_settings = cursor.fetchone()
    MAIN_START_BEHAVIOR = main_settings['start_behavior'] if main_settings else 4
    CHANNEL_FALLBACK_FILE = main_settings['fallback_path'] if main_settings and main_settings['fallback_path'] else FALLBACK_FILE

    # 2. Fetch Ad Videos for this specific channel
    cursor.execute("SELECT id, filename, duration, target_slots_ids FROM ad_videos WHERE duration > 0 AND channel_id = %s", (CHANNEL_ID,))
    all_videos = cursor.fetchall()
    
    # Filter out videos whose files don't exist on disk
    MEDIA_DIR = os.environ.get('MEDIA_DIR', '/media/new_ads/')
    videos = []
    for v in all_videos:
        fpath = os.path.join(MEDIA_DIR, v['filename'])
        if os.path.exists(fpath):
            videos.append(v)
        else:
            logging.warning(f"Excluding video id={v['id']} ({v['filename']}): file not found at {fpath}")
    
    logging.info(f"Videos available: {len(videos)} of {len(all_videos)} (excluded {len(all_videos) - len(videos)} missing)")

    def get_videos_for_slot(slot_id):
        slot_videos = []
        for v in videos:
            try:
                target_ids = v['target_slots_ids']
                if isinstance(target_ids, bytes): target_ids = target_ids.decode('utf-8')
                if isinstance(target_ids, str): target_ids = json.loads(target_ids)
                if str(slot_id) in [str(x) for x in target_ids]:
                    slot_videos.append(v)
            except: pass
        return slot_videos

    mainstream_videos = get_videos_for_slot(0)
    slot_video_map = {s['id']: get_videos_for_slot(s['id']) for s in slots}

    current_ms = 0
    end_of_day_ms = 86400 * 1000
    video_cursors = {0: 0}
    for s in slots: video_cursors[s['id']] = 0

    def get_next_video(slot_id_key, available_videos):
        if not available_videos: return None
        idx = video_cursors.get(slot_id_key, 0)
        video = available_videos[idx % len(available_videos)]
        video_cursors[slot_id_key] = idx + 1
        return video

    playlist_entries = []
    processed_slots = []
    for s in slots:
        if isinstance(s['start_time'], timedelta):
            start_ms = int(s['start_time'].total_seconds() * 1000)
        else:
            start_ms = get_ms_from_time(s['start_time'])
        duration_ms = s['duration'] * 60 * 1000
        processed_slots.append({
            'id': s['id'], 
            'start': start_ms, 
            'end': start_ms + duration_ms,
            'start_behavior': s.get('start_behavior', 4)
        })

    processed_slots.sort(key=lambda x: x['start'])
    current_slot_idx = 0
    
    while current_ms < end_of_day_ms:
        active_slot = None
        next_slot = processed_slots[current_slot_idx] if current_slot_idx < len(processed_slots) else None
        
        if next_slot and current_ms >= next_slot['start']:
            active_slot = next_slot
            
        if active_slot:
            if current_ms >= active_slot['end']:
                current_slot_idx += 1
                continue

        if not active_slot and next_slot and next_slot['start_behavior'] == 4:
            idx = video_cursors.get(0, 0)
            if mainstream_videos:
                cand = mainstream_videos[idx % len(mainstream_videos)]
                cand_dur = cand['duration']
            else:
                cand_dur = FALLBACK_DURATION_MS
             
            if current_ms + cand_dur > next_slot['start']:
                active_slot = next_slot

        slot_id_key = active_slot['id'] if active_slot else 0
        vid_list = mainstream_videos if slot_id_key == 0 else slot_video_map.get(slot_id_key, [])
        block_type = 'main' if slot_id_key == 0 else 'ad'

        if not active_slot:
            behavior = next_slot['start_behavior'] if next_slot else 1
            next_strict_start = next_slot['start'] if next_slot else end_of_day_ms
        else:
            # Inside a slot: always fill naturally up to the slot's own end time
            behavior = 1
            next_strict_start = active_slot['end']
            
            if current_slot_idx + 1 < len(processed_slots):
                upcoming = processed_slots[current_slot_idx + 1]
                if upcoming['start_behavior'] in [2, 3]:
                    next_strict_start = min(next_strict_start, upcoming['start'])

        candidate_video = None
        assigned_duration_ms = FALLBACK_DURATION_MS

        if not vid_list:
            candidate_video = None
            assigned_duration_ms = FALLBACK_DURATION_MS
            if current_ms + assigned_duration_ms > next_strict_start:
                 assigned_duration_ms = next_strict_start - current_ms
        else:
            idx = video_cursors.get(slot_id_key, 0)
            candidate = vid_list[idx % len(vid_list)]
            cand_dur = candidate['duration']
            
            if behavior == 1:
                next_slot_dur = 0
                ref_slot = next_slot if not active_slot else (processed_slots[current_slot_idx+1] if current_slot_idx+1 < len(processed_slots) else None)
                if ref_slot:
                     next_slot_dur = ref_slot['end'] - ref_slot['start']
                
                overrun = (current_ms + cand_dur) - next_strict_start
                if overrun > 0 and (next_slot_dur > 0 and overrun > 0.05 * next_slot_dur):
                    best_fit = None
                    for v in vid_list:
                        if (current_ms + v['duration']) - next_strict_start <= max(0, 0.05 * next_slot_dur):
                             best_fit = v
                             break
                    if best_fit:
                         candidate = best_fit
                         cand_dur = best_fit['duration']
                    else:
                         candidate = None
                         cand_dur = next_strict_start - current_ms
                
                candidate_video = candidate
                assigned_duration_ms = cand_dur
                if candidate: video_cursors[slot_id_key] = idx + 1
                
            elif behavior == 2 or behavior == 4:
                if current_ms + cand_dur > next_strict_start:
                    best_fit = None
                    for v in vid_list:
                        if current_ms + v['duration'] <= next_strict_start:
                            best_fit = v
                            break
                    if best_fit:
                        candidate = best_fit
                        cand_dur = best_fit['duration']
                    else:
                        candidate = None
                        if behavior == 2:
                            cand_dur = next_strict_start - current_ms
                        else:
                            cand_dur = 0
                
                candidate_video = candidate
                assigned_duration_ms = cand_dur
                if candidate: video_cursors[slot_id_key] = idx + 1
            
            elif behavior == 3:
                if current_ms + cand_dur > next_strict_start:
                     cand_dur = next_strict_start - current_ms
                candidate_video = candidate
                assigned_duration_ms = cand_dur
                if candidate: video_cursors[slot_id_key] = idx + 1

        if assigned_duration_ms <= 0:
             if active_slot:
                  current_slot_idx += 1
             else:
                  current_ms = max(current_ms, next_strict_start)
             continue

        if not candidate_video:
            playlist_entries.append({
                'schedule_date': target_date,
                'start_time': datetime.combine(target_date, datetime.min.time()) + timedelta(milliseconds=current_ms),
                'duration': assigned_duration_ms,
                'filename': CHANNEL_FALLBACK_FILE,
                'entry_type': 'filler',
                'video_id': None,
                'slot_id': slot_id_key if slot_id_key != 0 else None,
                'channel_id': CHANNEL_ID
            })
            current_ms += assigned_duration_ms
        else:
            playlist_entries.append({
                'schedule_date': target_date,
                'start_time': datetime.combine(target_date, datetime.min.time()) + timedelta(milliseconds=current_ms),
                'duration': assigned_duration_ms,
                'filename': candidate_video['filename'],
                'entry_type': block_type,
                'video_id': candidate_video['id'],
                'slot_id': slot_id_key if slot_id_key != 0 else None,
                'channel_id': CHANNEL_ID
            })
            current_ms += assigned_duration_ms

    if playlist_entries:
        CHUNK_SIZE = 500
        logging.info(f"Inserting {len(playlist_entries)} items in chunks...")
        insert_query = "INSERT INTO generated_playlists (schedule_date, start_time, duration, filename, entry_type, video_id, slot_id, channel_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
        for i in range(0, len(playlist_entries), CHUNK_SIZE):
            chunk = playlist_entries[i:i + CHUNK_SIZE]
            data = [(x['schedule_date'], x['start_time'], x['duration'], x['filename'], x['entry_type'], x['video_id'], x['slot_id'], x['channel_id']) for x in chunk]
            cursor.executemany(insert_query, data)
            conn.commit()
    
    logging.info("Playlist generation complete.")
    cursor.close()
    conn.close()

if __name__ == "__main__":
    t_date = None
    if len(sys.argv) > 1:
        for i, arg in enumerate(sys.argv):
            if arg == "--date" and i + 1 < len(sys.argv):
                t_date = sys.argv[i+1]
                break
    generate_playlist(t_date)
