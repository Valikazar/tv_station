#!/bin/bash
# tune_rpi.sh - Applies system tunings for Raspberry Pi TV receiver
# Run as root: sudo bash tune_rpi.sh

RESTART_SERVICE=true
for arg in "$@"; do
    if [ "$arg" == "--no-restart" ]; then
        RESTART_SERVICE=false
    fi
done

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo bash tune_rpi.sh)"
  exit 1
fi

echo "1. Applying Network Stack (UDP Optimization)..."
cat <<EOF > /etc/sysctl.d/99-tv-multicast.conf
# UDP buffer sizes for stable multicast reception
net.core.rmem_max=26214400
net.core.rmem_default=26214400
net.core.wmem_max=26214400
net.core.wmem_default=26214400
net.core.netdev_max_backlog=2000

# Force IGMPv2 for enterprise network compatibility
net.ipv4.conf.all.force_igmp_version=2
net.ipv4.conf.default.force_igmp_version=2
EOF
sysctl -p /etc/sysctl.d/99-tv-multicast.conf

# Force immediate active sysctl state
sysctl -w net.ipv4.conf.all.force_igmp_version=2 >/dev/null 2>&1 || true
sysctl -w net.ipv4.conf.default.force_igmp_version=2 >/dev/null 2>&1 || true

# Add static multicast route for local interfaces
for iface in eth0 end0 wlan0; do
    if ip link show "$iface" >/dev/null 2>&1; then
        ip route add 224.0.0.0/4 dev "$iface" 2>/dev/null || true
    fi
done


echo "2. Applying SD Card Protection (Wear Leveling)..."
# Disable swap
if command -v dphys-swapfile >/dev/null 2>&1; then
    dphys-swapfile swapoff || true
    dphys-swapfile uninstall || true
    systemctl disable dphys-swapfile || true
fi

# Update fstab to reduce writes
if ! grep -q "commit=600" /etc/fstab; then
    # Add noatime and commit=600 to ext4 partitions
    sed -i -E 's/(ext4[[:space:]]+defaults[,[:alnum:]]*)/\1,noatime,commit=600/' /etc/fstab
fi

# Store journals in RAM
mkdir -p /etc/systemd/journald.conf.d
cat <<EOF > /etc/systemd/journald.conf.d/volatile.conf
[Journal]
Storage=volatile
EOF
if [ "$RESTART_SERVICE" = true ]; then
    systemctl restart systemd-journald
fi

echo "3. Applying Process Priorities for Player (tv-agent.service)..."
if systemctl list-unit-files | grep -q tv-agent.service; then
    mkdir -p /etc/systemd/system/tv-agent.service.d
    cat <<EOF > /etc/systemd/system/tv-agent.service.d/priority.conf
[Service]
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=10
Nice=-10
EOF
    systemctl daemon-reload
    if [ "$RESTART_SERVICE" = true ]; then
        systemctl restart tv-agent.service
        echo "tv-agent.service priority updated and restarted."
    else
        echo "Priority settings written. They will apply on next restart."
    fi
else
    echo "tv-agent.service not found. Skipping priority tuning."
fi

echo "4. Applying Headless HDMI Fix & Global FullHD (1080p) Restriction..."
# Remount boot/firmware as read-write if mounted read-only
mount -o remount,rw /boot 2>/dev/null || true
mount -o remount,rw /boot/firmware 2>/dev/null || true

# Global FullHD (1080p) restriction in config.txt
for config_file in /boot/firmware/config.txt /boot/config.txt; do
    if [ -f "$config_file" ]; then
        # 1. Enforce headless defaults
        if ! grep -q "hdmi_force_hotplug=1" "$config_file"; then
            echo "" >> "$config_file"
            echo "# Auto-added by tune_rpi.sh for headless support" >> "$config_file"
            echo "hdmi_force_hotplug=1" >> "$config_file"
            echo "hdmi_group=2" >> "$config_file"
            echo "hdmi_mode=82" >> "$config_file"
            echo "Added hdmi_force_hotplug to $config_file"
        fi
        
        # 2. Hardware-level pixel frequency limit to disable 4K output globally (limit to < 200MHz)
        if ! grep -q "hdmi_max_pixel_freq" "$config_file"; then
            echo "" >> "$config_file"
            echo "# Force global FullHD limits (Disable 4K)" >> "$config_file"
            echo "hdmi_max_pixel_freq:0=200000000" >> "$config_file"
            echo "hdmi_max_pixel_freq:1=200000000" >> "$config_file"
            echo "Added global FullHD limit (hdmi_max_pixel_freq) to $config_file"
        fi
    fi
done

# Force FullHD resolution in cmdline.txt for KMS/DRM subsystems
for cmdline_file in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    if [ -f "$cmdline_file" ]; then
        content=$(cat "$cmdline_file")
        # Remove any existing video= arguments to avoid duplicate/conflicting configurations
        content_clean=$(echo "$content" | sed -E 's/[[:space:]]*video=[^[:space:]]+//g')
        # Append FullHD restrictions for both HDMI-A-1 and HDMI-A-2
        echo "$content_clean video=HDMI-A-1:1920x1080@60D video=HDMI-A-2:1920x1080@60D" > "$cmdline_file"
        echo "Forced 1080p in kernel cmdline: $cmdline_file"
    fi
done

echo "--------------------------------------------------------"
echo "Tuning complete!"
echo "--------------------------------------------------------"

