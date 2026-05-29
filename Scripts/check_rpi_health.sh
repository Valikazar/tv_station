#!/bin/bash
# check_rpi_health.sh - Comprehensive diagnostics for TV receiver
# Run as root: sudo bash check_rpi_health.sh

log_section() {
    echo -e "\n\e[1;34m=== $1 ===\e[0m"
}

log_section "1. System Basics"
echo "Hostname: $(hostname)"
echo "Uptime: $(uptime -p)"
echo "IP Address: $(hostname -I)"
echo "CPU Temp: $(vcgencmd measure_temp)"
echo "CPU Clock: $(vcgencmd measure_clock arm)"

log_section "2. Throttling & Power"
THROTTLED=$(vcgencmd get_throttled)
echo "Current Status: $THROTTLED"
if [[ "$THROTTLED" != "throttled=0x0" ]]; then
    echo -e "\e[1;31mWARNING: System is throttled! (Under-voltage or Over-heating)\e[0m"
    # Bit explanations:
    # 0: under-voltage
    # 1: arm frequency capped
    # 2: currently throttled
    # 3: soft temperature limit active
    # 16: under-voltage has occurred
    # 17: arm frequency capped has occurred
    # 18: throttling has occurred
    # 19: soft temperature limit has occurred
fi

log_section "3. Network Errors (UDP drops)"
echo "Recent UDP error stats (look for 'packet receive errors' or 'receive buffer errors'):"
netstat -su | grep -E "packet receive errors|receive buffer errors|packets to unknown port received"

log_section "4. Memory & Swap"
free -h
echo "Swap status: $(swapon --show)"

log_section "5. Hardware Video Decoding"
if ls /dev/video* 1>/dev/null 2>&1; then
    echo "Video devices found: $(ls /dev/video* | xargs)"
else
    echo "No video devices found in /dev/"
fi

log_section "6. Service Status"
systemctl status tv-agent.service --no-pager -n 5
echo "---"
systemctl status mpv-player.service --no-pager -n 5

log_section "7. Latest MPV Path / URL"
if [ -e /tmp/mpvsocket ]; then
    # Add timeout to nc so it doesn't hang waiting for MPV to close the socket
    echo '{"command":["get_property","path"]}' | nc -w 1 -U /tmp/mpvsocket || echo "No response"
else
    echo "MPV socket not found."
fi

echo -e "\n\e[1;32mDiagnostics complete.\e[0m"
