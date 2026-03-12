import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import { getSlotForTime, getSlots } from '../utils/timeSlots';

export interface FileStats {
    title: string;
    display_name: string;
    total: number;
    inBreaks: number;
    slots: { [key: string]: number };
}

/**
 * Convert a date string (YYYY-MM-DD) in GMT+3 to UTC Date object
 * GMT+3 00:00:00 = UTC previous day 21:00:00
 */
function gmt3StartOfDayToUTC(dateStr: string): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    // Create local date at midnight
    return new Date(year, month - 1, day, 0, 0, 0);
}

/**
 * Convert a date string (YYYY-MM-DD) end of day in GMT+3 to UTC Date object
 * GMT+3 23:59:59 = UTC same day 20:59:59
 */
function gmt3EndOfDayToUTC(dateStr: string): Date {
    const [year, month, day] = dateStr.split('-').map(Number);
    // Create local date at end of day
    return new Date(year, month - 1, day, 23, 59, 59, 999);
}

export async function getStats(startDateStr: string, endDateStr: string, channelId: number = 1): Promise<FileStats[]> {
    // Convert GMT+3 date range to precise UTC boundaries
    const queryStart = gmt3StartOfDayToUTC(startDateStr);
    const queryEnd = gmt3EndOfDayToUTC(endDateStr);

    const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT ph.start_time, av.filename as title, av.display_name 
         FROM play_history ph
         JOIN ad_videos av ON ph.video_id = av.id
         WHERE ph.start_time BETWEEN ? AND ? AND ph.channel_id = ?`,
        [queryStart, queryEnd, channelId]
    );

    const statsMap: Map<string, FileStats> = new Map();

    // Helper to get or create stats entry
    const getEntry = (title: string): FileStats => {
        if (!statsMap.has(title)) {
            const slotsInit: { [key: string]: number } = {};
            getSlots(channelId).filter(s => !s.exclude_from_stats).forEach(s => slotsInit[s.name] = 0);
            statsMap.set(title, {
                title,
                display_name: title, // Default to filename if not found in join
                total: 0,
                inBreaks: 0,
                slots: slotsInit
            });
        }
        return statsMap.get(title)!;
    };

    // Process rows - no need to filter by date anymore, SQL already filtered precisely
    for (const row of rows) {
        const date = new Date(row.start_time);
        const entry = getEntry(row.title);

        // Update display name if available from join
        if (row.display_name) {
            entry.display_name = row.display_name;
        }

        entry.total++;

        const slot = getSlotForTime(date, channelId);
        if (slot && entry.slots[slot] !== undefined) {
            entry.slots[slot]++;
        }
    }

    // Calculate inBreaks (Sum of all defined slots) and sort
    const results = Array.from(statsMap.values());
    results.forEach(item => {
        let sumBreaks = 0;
        getSlots(channelId).filter(s => !s.exclude_from_stats).forEach(slot => {
            sumBreaks += item.slots[slot.name] || 0;
        });
        item.inBreaks = sumBreaks;
    });

    return results.sort((a, b) => b.total - a.total);
}

export async function getPlaybackLogStats(startDateStr: string, endDateStr: string, channelId: number = 1): Promise<FileStats[]> {
    const queryStart = gmt3StartOfDayToUTC(startDateStr);
    const queryEnd = gmt3EndOfDayToUTC(endDateStr);

    const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT pl.start_time, 
                COALESCE(av.filename, CAST(pl.video_id AS CHAR), 'Unknown') as title, 
                av.display_name 
         FROM playback_log pl
         LEFT JOIN ad_videos av ON pl.video_id = av.id
         WHERE pl.start_time BETWEEN ? AND ? AND pl.channel_id = ?`,
        [queryStart, queryEnd, channelId]
    );

    const statsMap: Map<string, FileStats> = new Map();

    const getEntry = (title: string): FileStats => {
        if (!statsMap.has(title)) {
            const slotsInit: { [key: string]: number } = {};
            getSlots(channelId).filter(s => !s.exclude_from_stats).forEach(s => slotsInit[s.name] = 0);
            statsMap.set(title, {
                title,
                display_name: title,
                total: 0,
                inBreaks: 0,
                slots: slotsInit
            });
        }
        return statsMap.get(title)!;
    };

    for (const row of rows) {
        const date = new Date(row.start_time);
        // Clean up filename if needed, or just use as is
        const entry = getEntry(row.title);

        if (row.display_name) {
            entry.display_name = row.display_name;
        }

        entry.total++;

        const slot = getSlotForTime(date, channelId);
        if (slot && entry.slots[slot] !== undefined) {
            entry.slots[slot]++;
        }
    }

    const results = Array.from(statsMap.values());
    results.forEach(item => {
        let sumBreaks = 0;
        getSlots(channelId).filter(s => !s.exclude_from_stats).forEach(slot => {
            sumBreaks += item.slots[slot.name] || 0;
        });
        item.inBreaks = sumBreaks;
    });

    return results.sort((a, b) => b.total - a.total);
}
