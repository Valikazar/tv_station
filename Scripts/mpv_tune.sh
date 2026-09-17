#!/bin/bash
# SMART MPV tuning for Raspberry Pi 4 (Bookworm Lite)
# Automatically detects kernel version to choose between 
# High-Performance (KMS Overlay) or Safe-Mode (Copy).

# 1. Configuration Path
TARGET_USER=${1:-$SUDO_USER}
[ -z "$TARGET_USER" ] && TARGET_USER=$USER
USER_HOME=$(getent passwd "$TARGET_USER" | cut -d: -f6)
echo "Targeting user: $TARGET_USER (Home: $USER_HOME)"

CONFIG_DIR="$USER_HOME/.config/mpv"
CONFIG_FILE="$CONFIG_DIR/mpv.conf"
mkdir -p "$CONFIG_DIR"
chown "$TARGET_USER":"$TARGET_USER" "$CONFIG_DIR"

# 2. Hardware/Audio Detection with EDID verification
HDMI_PORT=""
for port_path in /sys/class/drm/card*-HDMI-A-*; do
    if [ -f "$port_path/status" ]; then
        status=$(cat "$port_path/status")
        if [ "$status" = "connected" ]; then
            connector=$(basename "$port_path" | cut -d'-' -f2-)
            if [ -f "$port_path/edid" ] && [ "$(wc -c < "$port_path/edid")" -gt 0 ]; then
                HDMI_PORT="$connector"
                echo "Detected connected port with valid EDID: $HDMI_PORT"
                break
            fi
            if [ -z "$HDMI_PORT" ]; then
                HDMI_PORT="$connector"
            fi
        fi
    fi
done

[ -n "$HDMI_PORT" ] && echo "Selected connector: $HDMI_PORT"

# Find ALSA card index for HDMI
CARD_IDX=$(aplay -l | grep -i "hdmi" | head -n 1 | cut -d' ' -f2 | tr -d ':')
AUDIO_DEV="auto"
[ -n "$CARD_IDX" ] && AUDIO_DEV="alsa/plughw:$CARD_IDX,0"

# 3. Hardware Version Detection (Pi 4 vs Pi 5)
MODEL=$(cat /sys/firmware/devicetree/base/model 2>/dev/null || echo "Unknown")
HWDEC="v4l2m2m"
VO="gpu"
VD_LAVC_THREADS="1"
GPU_CTX="drm"
HWDEC_CODECS="h264"

if [[ "$MODEL" == *"Raspberry Pi 5"* ]]; then
    echo "Detected Raspberry Pi 5. Applying Software Decoding Profile (hwdec=auto, 4 threads)..."
    HWDEC="auto"
    VD_LAVC_THREADS="4"
else
    echo "Detected Raspberry Pi 4 or older. Applying Hardware Decoding Profile (v4l2m2m)..."
fi

# 5. Generate Clean mpv.conf
cat <<EOF > "$CONFIG_FILE"
# --- MPV GOLDEN HP CONFIG ---
# Cloned from stable .228 (Kernel $KERNEL_VER)

# IPC socket
input-ipc-server=/tmp/mpvsocket

# Start settings
fs=yes
osd-level=0
keep-open=yes
no-border
# profile=low-latency

# Buffer & Network (Optimized for UDP TV streams)
cache=yes
cache-secs=3
demuxer-max-bytes=134217728
network-timeout=15
demuxer-lavf-o=fifo_size=100000000,overrun_nonfatal=1,probesize=100000000,analyzeduration=100000000
demuxer-lavf-analyzeduration=100
demuxer-lavf-probesize=100000000

# Hardware Decoding & Rendering (GOLDEN STANDARD)
hwdec=$HWDEC
hwdec-codecs=$HWDEC_CODECS
vo=$VO
gpu-context=$GPU_CTX
vd-lavc-dr=yes
vd-lavc-threads=$VD_LAVC_THREADS

# Force FullHD Resolution (Never 4K)
drm-mode=1920x1080

# Force DRM Connector
$( [ -n "$HDMI_PORT" ] && echo "drm-connector=$HDMI_PORT" || echo "# drm-connector=auto" )

# Disable Heavy GPU Shaders (Bilinear Only)
scale=bilinear
cscale=bilinear
dscale=bilinear

# Synchronization
video-sync=audio
framedrop=vo
hr-seek=yes

# Audio Settings (HDMI Focus)
ao=pipewire,alsa
audio-device=$AUDIO_DEV
audio-format=s16
audio-samplerate=48000
audio-channels=stereo
volume=30
af=lavfi=[aresample=48000:resampler=swr]

# Stability fallbacks
audio-wait-open=2
audio-fallback-to-null=yes
audio-buffer=0.8
EOF

# 6. Permissions & Success
chown "$TARGET_USER":"$TARGET_USER" "$CONFIG_FILE"
echo -e "\e[1;32mMPV tuning complete ($HWDEC). Config saved to $CONFIG_FILE\e[0m"

# 7. Restart service
if [ -f /etc/systemd/system/mpv-player.service ]; then
    sudo systemctl restart mpv-player.service
fi
