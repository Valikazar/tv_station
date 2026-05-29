#!/bin/bash
# fix_audio.sh - Forces HDMI audio on Raspberry Pi
# Run as root: sudo bash fix_audio.sh

echo "1. Forcing HDMI audio output via amixer..."

# 1. Detect which HDMI port is physically connected
CONNECTED_HDMI=""
for port in /sys/class/drm/card*-HDMI-A-*/status; do
    if [ -f "$port" ] && grep -q "^connected" "$port"; then
        CONNECTED_HDMI=$(echo "$port" | grep -o "HDMI-A-[0-9]")
        echo "Detected connected port: $CONNECTED_HDMI"
        break
    fi
done

HDMI_CARD=""
if [ -n "$CONNECTED_HDMI" ]; then
    # Map HDMI-A-1 -> index matching hdmi-0 or hdmi0, HDMI-A-2 -> index matching hdmi-1 or hdmi1
    case "$CONNECTED_HDMI" in
        "HDMI-A-1") CARD_PATTERN="hdmi.*0" ;;
        "HDMI-A-2") CARD_PATTERN="hdmi.*1" ;;
        *) CARD_PATTERN="hdmi" ;;
    esac
    HDMI_CARD=$(aplay -l 2>/dev/null | grep -i "$CARD_PATTERN" | head -n 1 | cut -d' ' -f2 | tr -d ':')
fi

# Fallback
if [ -z "$HDMI_CARD" ]; then
    HDMI_CARD=$(aplay -l | grep -i "hdmi" | head -n 1 | cut -d' ' -f2 | tr -d ':')
fi

if [ -z "$HDMI_CARD" ]; then
    echo "HDMI card not found via aplay, falling back to Card 0..."
    HDMI_CARD=0
fi

echo "Selected Card: $HDMI_CARD"

echo "1. Forcing audio output and unmuting all controls on Card $HDMI_CARD..."

# Unmute and set volume for ALL simple controls available on this card
amixer -c "$HDMI_CARD" scontrols | cut -d"'" -f2 | while read ctrl; do
    echo "  - Unmuting/Setting $ctrl..."
    amixer -c "$HDMI_CARD" sset "$ctrl" unmute 2>/dev/null
    amixer -c "$HDMI_CARD" sset "$ctrl" 100% 2>/dev/null
    amixer -c "$HDMI_CARD" sset "$ctrl" 80% 2>/dev/null # some cards prefer 80% for PCM
done

# Explicitly try common HDMI/IEC958 controls that might not be in 'scontrols'
for ctrl in "IEC958" "IEC958,0" "Digital"; do
    amixer -c "$HDMI_CARD" cset name="$ctrl" on 2>/dev/null || true
done

# Specifically for older RPi firmware: force output to HDMI (1=jack, 2=hdmi)
amixer cset numid=3 2 2>/dev/null || true

echo "2. Applying volume settings to ALSA state..."
alsactl store || true

echo "3. Restarting audio services..."
systemctl restart alsa-state 2>/dev/null || true

echo "Done. If you still hear no sound, please run: speaker-test -D plughw:$HDMI_CARD,0 -r 48000 -c 2 -F S16_LE"
