#!/bin/bash
# ffmpeg_watchdog.sh
# Мониторит количество ffmpeg процессов.
# Если их больше MAX_FFMPEG — убивает лишние (самые старые).
# При превышении памяти ТОЛЬКО убивает ffmpeg — НЕ трогает Docker и данные.
#
# Установка:
#   chmod +x /opt/tv_station/ffmpeg_watchdog.sh
#   sudo cp /etc/systemd/system/ffmpeg-watchdog.service ...
#   sudo systemctl enable --now ffmpeg-watchdog

# --- НАСТРОЙКИ ---
# Максимальное допустимое число ffmpeg процессов (2 канала × 3 ffmpeg + запас = 8)
MAX_FFMPEG=8
# Порог RAM в МБ для экстренной очистки (30 ГБ)
MEM_THRESHOLD_MB=30720
# Интервал проверки (секунды)
SLEEP_INTERVAL=30

# Telegram (опционально — оставьте пустыми если не нужно)
TG_TOKEN=""
TG_CHAT_ID=""

# --- ФУНКЦИИ ---
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

send_tg() {
    [ -z "$TG_TOKEN" ] || [ -z "$TG_CHAT_ID" ] && return
    curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        -d "chat_id=${TG_CHAT_ID}" \
        -d "text=$1" \
        -d "parse_mode=HTML" > /dev/null
}

kill_excess_ffmpeg() {
    local count reason
    reason="$1"
    # Получаем PIDs всех ffmpeg, сортируем по времени запуска (самые старые — первые)
    mapfile -t PIDS < <(ps -eo pid,etimes,comm --no-headers | awk '$3=="ffmpeg"{print $1,$2}' | sort -k2 -rn | awk '{print $1}')
    count=${#PIDS[@]}

    if [ "$count" -le "$MAX_FFMPEG" ]; then
        return
    fi

    local to_kill=$(( count - MAX_FFMPEG ))
    log "⚠️  $reason: найдено $count ffmpeg (макс=$MAX_FFMPEG). Ищу лишние фидеры..."
    
    local killed=0
    for (( i=0; i<count; i++ )); do
        [ "$killed" -ge "$to_kill" ] && break
        
        local pid="${PIDS[$i]}"
        # Проверяем, не является ли процесс мастером (читает из FIFO)
        local cmdline=$(ps -p "$pid" -o cmd --no-headers 2>/dev/null)
        if [[ "$cmdline" == *"/tmp/playout_fifo_"* ]]; then
            log "  Skipping master ffmpeg PID $pid"
            continue
        fi

        log "  Killing old feeder ffmpeg PID $pid"
        kill -9 "$pid" 2>/dev/null || true
        ((killed++))
    done

    send_tg "✅ <b>[$(hostname)]</b> Убито $killed лишних ffmpeg. Осталось процессов: $(( count - killed ))"
}

# --- ОСНОВНОЙ ЦИКЛ ---
log "=== ffmpeg_watchdog started (max=$MAX_FFMPEG, mem_threshold=${MEM_THRESHOLD_MB}MB) ==="

while true; do
    FFMPEG_COUNT=$(pgrep -c ffmpeg 2>/dev/null || echo 0)
    MEM_USED=$(free -m | awk '/^Mem:/{print $3}')

    # Проверка по количеству ffmpeg
    if [ "$FFMPEG_COUNT" -gt "$MAX_FFMPEG" ]; then
        kill_excess_ffmpeg "Превышен лимит ffmpeg"
    fi

    # Проверка по памяти — тоже только убиваем ffmpeg, НЕ Docker
    if [ "$MEM_USED" -gt "$MEM_THRESHOLD_MB" ]; then
        log "🔴 Критическое потребление RAM: ${MEM_USED}MB > ${MEM_THRESHOLD_MB}MB"
        send_tg "🔴 <b>[$(hostname)] Критическая RAM!</b>%0AИспользовано: <b>${MEM_USED} МБ</b>%0AУбиваю все лишние ffmpeg..."
        kill_excess_ffmpeg "Критическая RAM"
    fi

    sleep "$SLEEP_INTERVAL"
done
