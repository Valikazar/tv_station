import path from 'path';
import { getSlots } from './timeSlots';

// Define the base path for ads.
// Default to local 'ads' folder relative to project root or use env var.
// In prod, this might be /opt/tv_station/media/ads/
export const ADS_BASE_PATH = process.env.ADS_BASE_PATH || path.join(__dirname, '../../ads');

export interface AdSlot {
    dbId: number; // Database ID from time_slots table, or 0 for MainStream
    id: string;   // Directory name (name from time_slots)
    name: string; // Custom name from DB
    label: string; // Human readable label
    hour?: number;
    minute?: number;
    duration?: number;
}

/**
 * Build AD_SLOTS dynamically from the DB-backed time slots.
 */
export function getAdSlots(channelId: number = 1): AdSlot[] {
    const slots = getSlots(channelId);
    const adSlots: AdSlot[] = slots.map(s => {
        const hStr = s.hour.toString().padStart(2, '0');
        const mStr = s.minute.toString().padStart(2, '0');
        const defaultName = `block_${hStr}${mStr}`;
        const isDefault = s.name === defaultName;

        return {
            dbId: s.id || 0,
            id: s.name,
            name: s.name,
            hour: s.hour,
            minute: s.minute,
            duration: s.duration,
            label: isDefault ? `${hStr}:${mStr} (${s.duration} мин)` : s.name,
        };
    });

    // Add MainStream as requested
    adSlots.unshift({
        dbId: 0,
        id: 'MainStream',
        name: 'Main',
        label: 'Прямой эфир'
    });

    return adSlots;
}
/** @deprecated Use getAdSlots() instead */
export const AD_SLOTS: AdSlot[] = getAdSlots();

export function getSlotById(id: string, channelId: number = 1): AdSlot | undefined {
    return getAdSlots(channelId).find(slot => slot.id === id);
}

export function getLibraryNameForSlot(slotId: string): string {
    if (slotId === 'MainStream') return 'main';
    // Strip prefixes to get a clean base for the library name
    const base = slotId.replace('block_', '').replace('col_', '');
    return `lib_${base}`;
}
