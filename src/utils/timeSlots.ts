import pool from '../config/db';
import { RowDataPacket } from 'mysql2';

export interface TimeSlot {
    id?: number;
    name: string;
    hour: number;
    minute: number;
    duration: number; // minutes
    exclude_from_stats?: boolean;
    start_behavior?: number;
    end_behavior?: number;
}

const DEFAULT_SLOTS: TimeSlot[] = [
    { name: 'block_0850', hour: 8, minute: 50, duration: 10, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1035', hour: 10, minute: 35, duration: 10, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1220', hour: 12, minute: 20, duration: 40, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1300', hour: 13, minute: 0, duration: 60, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1435', hour: 14, minute: 35, duration: 10, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1620', hour: 16, minute: 20, duration: 10, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1805', hour: 18, minute: 5, duration: 10, start_behavior: 4, end_behavior: 1 },
    { name: 'block_1950', hour: 19, minute: 50, duration: 10, start_behavior: 4, end_behavior: 1 },
    { name: 'block_2135', hour: 21, minute: 35, duration: 10, start_behavior: 4, end_behavior: 1 },
];

// In-memory cache by channel ID
let cachedSlotsByChannel: Record<number, TimeSlot[]> = {};

/**
 * Build a slot name from hour and minute, e.g. hour=8, minute=50 -> "col_0850"
 */
export function buildSlotName(hour: number, minute: number): string {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `block_${h}${m}`;
}

/**
 * Initialize slots: create time_slots table, load from DB or insert defaults.
 */
export async function initializeSlots(): Promise<void> {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS time_slots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                start_time TIME NOT NULL,
                duration INT NOT NULL
            )
        `);

        try {
            await pool.query("ALTER TABLE time_slots ADD COLUMN exclude_from_stats BOOLEAN NOT NULL DEFAULT 0");
        } catch (e: any) { }

        try {
            await pool.query("ALTER TABLE time_slots ADD COLUMN start_behavior INT NOT NULL DEFAULT 4");
        } catch (e: any) { }

        try {
            await pool.query("ALTER TABLE time_slots ADD COLUMN end_behavior INT NOT NULL DEFAULT 1");
        } catch (e: any) { }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS channel_settings (
                channel_id INT PRIMARY KEY,
                main_start_behavior INT NOT NULL DEFAULT 4,
                main_exclude_from_stats BOOLEAN NOT NULL DEFAULT 0,
                fallback_path VARCHAR(255) DEFAULT NULL
            )
        `);

        try {
            await pool.query("ALTER TABLE channel_settings ADD COLUMN fallback_path VARCHAR(255) DEFAULT NULL");
        } catch (e: any) { }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS receivers (
                id VARCHAR(100) PRIMARY KEY,
                hostname VARCHAR(100),
                nickname VARCHAR(100),
                location VARCHAR(100),
                ip_address VARCHAR(50),
                cpu_usage FLOAT,
                temperature FLOAT,
                traffic_speed FLOAT,
                current_source_ip VARCHAR(50),
                current_stream_url VARCHAR(255),
                target_stream_url VARCHAR(255),
                target_command VARCHAR(100),
                last_seen DATETIME
            )
        `);

        try { await pool.query("ALTER TABLE receivers ADD COLUMN nickname VARCHAR(100)"); } catch (e) { }
        try { await pool.query("ALTER TABLE receivers ADD COLUMN location VARCHAR(100)"); } catch (e) { }
        try { await pool.query("ALTER TABLE receivers ADD COLUMN target_command VARCHAR(100)"); } catch (e) { }
        // actual_stream_url = what MPV is actually playing (reported by agent every 10s)
        // current_stream_url = last assigned/commanded URL (set only via /command endpoint)
        try { await pool.query("ALTER TABLE receivers ADD COLUMN actual_stream_url VARCHAR(255)"); } catch (e) { }

        const [rows] = await pool.execute<RowDataPacket[]>(
            "SELECT * FROM time_slots ORDER BY start_time ASC"
        );

        if (rows.length > 0) {
            cachedSlotsByChannel = {};
            for (const s of rows) {
                const [h, m] = s.start_time.split(':').map(Number);
                const chId = s.channel_id || 1;
                if (!cachedSlotsByChannel[chId]) cachedSlotsByChannel[chId] = [];
                cachedSlotsByChannel[chId].push({
                    id: s.id,
                    name: s.name,
                    hour: h,
                    minute: m,
                    duration: s.duration,
                    exclude_from_stats: !!s.exclude_from_stats,
                    start_behavior: s.start_behavior !== undefined ? s.start_behavior : 4,
                    end_behavior: s.end_behavior !== undefined ? s.end_behavior : 1,
                });
            }
            console.log(`✅ Loaded time slots from DB for ${Object.keys(cachedSlotsByChannel).length} channels`);
        } else {
            // Check if we can migrate from old site_settings
            const [oldRows] = await pool.execute<RowDataPacket[]>(
                "SELECT setting_value FROM site_settings WHERE setting_key = 'time_slots'"
            );

            if (oldRows.length > 0) {
                console.log('Found legacy JSON slots in site_settings. Migrating...');
                const raw = typeof oldRows[0].setting_value === 'string'
                    ? JSON.parse(oldRows[0].setting_value)
                    : oldRows[0].setting_value;
                const slots = Array.isArray(raw) ? raw : [];

                for (const s of slots) {
                    const startTime = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:00`;
                    await pool.execute(
                        "INSERT INTO time_slots (name, start_time, duration) VALUES (?, ?, ?)",
                        [s.name, startTime, s.duration]
                    );
                }

                // Reload
                const [newRows] = await pool.execute<RowDataPacket[]>("SELECT * FROM time_slots ORDER BY start_time ASC");
                cachedSlotsByChannel = {};
                for (const s of newRows) {
                    const [h, m] = s.start_time.split(':').map(Number);
                    const chId = s.channel_id || 1;
                    if (!cachedSlotsByChannel[chId]) cachedSlotsByChannel[chId] = [];
                    cachedSlotsByChannel[chId].push({
                        id: s.id, name: s.name, hour: h, minute: m, duration: s.duration,
                        exclude_from_stats: !!s.exclude_from_stats,
                        start_behavior: s.start_behavior !== undefined ? s.start_behavior : 4,
                        end_behavior: s.end_behavior !== undefined ? s.end_behavior : 1
                    });
                }
                console.log(`✅ Migrated and loaded slots for ${Object.keys(cachedSlotsByChannel).length} channels`);
            } else {
                console.log('Inserting default slots for Channel 1...');
                await initializeChannelDefaults(1);
            }
        }
    } catch (err: any) {
        console.error('CRITICAL: Failed to initialize time_slots table:', err.message);
        cachedSlotsByChannel = { 1: [...DEFAULT_SLOTS] };
    }
}

/**
 * Creates default slots and settings for a new channel.
 */
export async function initializeChannelDefaults(channelId: number): Promise<void> {
    try {
        // 1. Insert default time slots
        for (const s of DEFAULT_SLOTS) {
            const startTime = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:00`;
            await pool.execute(
                "INSERT IGNORE INTO time_slots (name, start_time, duration, start_behavior, end_behavior, channel_id) VALUES (?, ?, ?, ?, ?, ?)",
                [s.name, startTime, s.duration, s.start_behavior || 4, s.end_behavior || 1, channelId]
            );
        }

        // 2. Insert default channel settings
        await pool.execute(
            "INSERT IGNORE INTO channel_settings (channel_id, main_start_behavior, main_exclude_from_stats) VALUES (?, ?, ?)",
            [channelId, 4, 0]
        );

        // 3. Update cache
        const [rows] = await pool.execute<RowDataPacket[]>(
            "SELECT * FROM time_slots WHERE channel_id = ? ORDER BY start_time ASC",
            [channelId]
        );
        cachedSlotsByChannel[channelId] = rows.map(s => {
            const [h, m] = s.start_time.split(':').map(Number);
            return {
                id: s.id,
                name: s.name,
                hour: h,
                minute: m,
                duration: s.duration,
                exclude_from_stats: !!s.exclude_from_stats,
                start_behavior: s.start_behavior !== undefined ? s.start_behavior : 4,
                end_behavior: s.end_behavior !== undefined ? s.end_behavior : 1,
            };
        });

        console.log(`✅ Initialized default slots for channel ${channelId}`);
    } catch (err: any) {
        console.error(`Error initializing defaults for channel ${channelId}:`, err.message);
    }
}

/**
 * Save slots to DB and update cache.
 */
export async function saveSlots(slots: { id?: number | null; name: string; hour: number; minute: number; duration: number; exclude_from_stats?: boolean; start_behavior?: number; end_behavior?: number }[], channelId: number = 1): Promise<void> {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Get all current IDs for this channel
        const [existingRows] = await connection.execute<RowDataPacket[]>("SELECT id FROM time_slots WHERE channel_id = ?", [channelId]);
        const existingIds = existingRows.map(r => r.id);

        // 2. Identify IDs in the incoming list
        const incomingIds = slots
            .filter(s => s.id !== null && s.id !== undefined)
            .map(s => s.id as number);

        // 3. Delete IDs not in the new list
        const idsToDelete = existingIds.filter(id => !incomingIds.includes(id));
        if (idsToDelete.length > 0) {
            // mysql2 execute doesn't like arrays in IN clause easily, use query
            await connection.query("DELETE FROM time_slots WHERE id IN (?)", [idsToDelete]);
        }

        // 4. Update or Insert
        for (const s of slots) {
            const startTime = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:00`;
            const excl = s.exclude_from_stats ? 1 : 0;
            const sb = s.start_behavior || 4;
            const eb = s.end_behavior || 1;
            if (s.id) {
                await connection.execute(
                    "UPDATE time_slots SET name = ?, start_time = ?, duration = ?, exclude_from_stats = ?, start_behavior = ?, end_behavior = ? WHERE id = ? AND channel_id = ?",
                    [s.name, startTime, s.duration, excl, sb, eb, s.id, channelId]
                );
            } else {
                await connection.execute(
                    "INSERT INTO time_slots (name, start_time, duration, exclude_from_stats, start_behavior, end_behavior, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [s.name, startTime, s.duration, excl, sb, eb, channelId]
                );
            }
        }

        await connection.commit();

        // Reload cache
        const [newRows] = await connection.execute<RowDataPacket[]>("SELECT * FROM time_slots ORDER BY start_time ASC");
        cachedSlotsByChannel = {};
        for (const s of newRows) {
            const [h, m] = s.start_time.split(':').map(Number);
            const chId = s.channel_id || 1;
            if (!cachedSlotsByChannel[chId]) cachedSlotsByChannel[chId] = [];
            cachedSlotsByChannel[chId].push({
                id: s.id, name: s.name, hour: h, minute: m, duration: s.duration,
                exclude_from_stats: !!s.exclude_from_stats,
                start_behavior: s.start_behavior !== undefined ? s.start_behavior : 4,
                end_behavior: s.end_behavior !== undefined ? s.end_behavior : 1
            });
        }

        console.log(`✅ Synced slots to DB (IDs preserved)`);
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}

/**
 * Get current slots (from cache).
 */
export function getSlots(channelId: number = 1): TimeSlot[] {
    return cachedSlotsByChannel[channelId] || [];
}

/** @deprecated Use getSlots(channelId) instead */
export const SLOTS: TimeSlot[] = [];

/**
 * Checks which slot the date falls into.
 * @param date - The date object (assumed UTC from DB or local).
 * @returns The name of the slot or null.
 */
export function getSlotForTime(date: Date, channelId: number = 1): string | null {
    const hour = date.getHours();
    const minute = date.getMinutes();

    const timeInMinutes = hour * 60 + minute;
    const slots = cachedSlotsByChannel[channelId] || [];

    for (const slot of slots) {
        const slotStart = slot.hour * 60 + slot.minute;
        const slotEnd = slotStart + slot.duration;

        if (timeInMinutes >= slotStart && timeInMinutes < slotEnd) {
            return slot.name;
        }
    }

    return null;
}
