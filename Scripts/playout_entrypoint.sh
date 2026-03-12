#!/bin/bash
# NOTE: No 'set -e' here — we handle errors manually so the trap always fires.

CHANNEL_ID=${CHANNEL_ID:-1}
UDP_PORT=$((10000 + CHANNEL_ID))
FIFO_PATH="/tmp/playout_fifo_ch${CHANNEL_ID}"
MASTER_PID=""

# ─── Cleanup: called on SIGTERM, SIGINT, or EXIT ─────────────────────────────
cleanup() {
    echo "=== Cleanup triggered for Channel $CHANNEL_ID ==="
    # Kill feeder ffmpeg processes writing to our FIFO
    pkill -9 -f "ffmpeg.*pipe:1" 2>/dev/null || true
    # Kill the master ffmpeg reading our FIFO
    if [ -n "$MASTER_PID" ] && kill -0 "$MASTER_PID" 2>/dev/null; then
        echo "Killing master FFmpeg PID $MASTER_PID..."
        kill -TERM "$MASTER_PID" 2>/dev/null || true
        sleep 1
        kill -KILL "$MASTER_PID" 2>/dev/null || true
    fi
    # Belt-and-suspenders: kill any ffmpeg touching our specific FIFO
    pkill -9 -f "${FIFO_PATH}" 2>/dev/null || true
    # Remove FIFO so next run starts clean
    rm -f "$FIFO_PATH"
    echo "=== Cleanup done ==="
}

trap cleanup EXIT SIGTERM SIGINT

echo "=== TV Playout Container Starting (Channel $CHANNEL_ID) ==="
echo "Time: $(date)"

# ─── 1. Kill any stale ffmpeg from a previous (crashed) run ──────────────────
echo "Killing any stale ffmpeg processes from previous run..."
pkill -9 -f "ffmpeg.*${FIFO_PATH}" 2>/dev/null || true
pkill -9 -f "ffmpeg.*pipe:1" 2>/dev/null || true
sleep 0.5

# ─── 2. Create FIFO ──────────────────────────────────────────────────────────
rm -f "$FIFO_PATH"
mkfifo "$FIFO_PATH"
chmod 666 "$FIFO_PATH"
echo "FIFO created at $FIFO_PATH."

# ─── 3. Dummy writer — keeps FIFO open so Master FFmpeg never sees EOF ───────
tail -f /dev/null > "$FIFO_PATH" &
DUMMY_PID=$!
echo "Dummy writer started (PID $DUMMY_PID)."

# ─── 4. Generate today's and tomorrow's playlists ────────────────────────────
echo "Generating playlists..."
python3 /app/generate_playlist.py || echo "WARN: Playlist gen for today failed"
python3 /app/generate_playlist.py --date "$(date -d '+1 day' +%Y-%m-%d)" || echo "WARN: Playlist gen for tomorrow failed"
echo "Playlists ready."

# ─── 5. Start Master FFmpeg in auto-restart loop (FIFO → UDP/RTP + HLS) ──────
FFMPEG_BITRATE_K=${FFMPEG_BITRATE_K:-5000}
MUXRATE_K=$(( FFMPEG_BITRATE_K * 115 / 100 ))

mkdir -p /dev/shm/hls

MUX_OPTS="-muxrate ${MUXRATE_K}k -pcr_period 20"
OUTPUT_URL="udp://127.0.0.1:${UDP_PORT}?pkt_size=1316&flush_packets=1&buffer_size=10000000"
OUTPUT_FORMAT="mpegts"

if [ "$OUTPUT_PROTOCOL" = "rtp" ]; then
    OUTPUT_URL="rtp://${MULTICAST_IP}:${MULTICAST_PORT}?localaddr=${INTERFACE_IP}&ttl=15"
    OUTPUT_FORMAT="rtp_mpegts"
    MUX_OPTS=""
fi

# Master FFmpeg auto-restart loop — if it dies, it comes back in 2 seconds
(
  while true; do
    echo "[Master] Starting FFmpeg → $OUTPUT_URL (format=$OUTPUT_FORMAT)..."
    touch "/dev/shm/ch${CHANNEL_ID}_master.log"
    chmod 666 "/dev/shm/ch${CHANNEL_ID}_master.log"
    ffmpeg -re -hide_banner -loglevel warning -stats \
      -fflags +igndts+discardcorrupt \
      -err_detect ignore_err \
      -probesize 10000000 -analyzeduration 10000000 \
      -f mpegts -i "$FIFO_PATH" \
      -map 0 -c copy \
      -f $OUTPUT_FORMAT $MUX_OPTS \
      -max_muxing_queue_size 4096 \
      "$OUTPUT_URL" \
      -map 0 -c copy \
      -f hls \
      -hls_time 4 \
      -hls_list_size 5 \
      -hls_flags delete_segments+append_list \
      -hls_segment_type mpegts \
      -hls_segment_filename "/dev/shm/hls/ch${CHANNEL_ID}_%03d.ts" \
      "/dev/shm/hls/ch${CHANNEL_ID}.m3u8" 2> "/dev/shm/ch${CHANNEL_ID}_master.log"
    RET=$?
    echo "[Master] FFmpeg exited with code $RET — restarting in 2s..."
    sleep 2
  done
) &
MASTER_LOOP_PID=$!
echo "Master FFmpeg loop started (PID $MASTER_LOOP_PID) routing to $OUTPUT_URL and RAM HLS."

# ─── 6. Run playout.py — keep bash alive (no exec!) so trap works ────────────
echo "Starting playout feeder..."
python3 -u /app/playout.py
EXIT_CODE=$?
echo "playout.py exited with code $EXIT_CODE. Container will stop."
# trap cleanup will fire here automatically
exit $EXIT_CODE
