import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import { execInContainer } from './dockerService';

let lastRunMinute = -1;

/**
 * Starts the periodic schedule generator.
 * Runs at 07:00 and 23:50 daily.
 */
export function startScheduler() {
    console.log('[Scheduler] Initializing periodic schedule generation tasks...');
    
    // Check every 30 seconds to be safe
    setInterval(async () => {
        const now = new Date();
        const hrs = now.getHours();
        const mins = now.getMinutes();
        const currentMinute = hrs * 60 + mins;

        // Only run once per minute
        if (currentMinute === lastRunMinute) return;

        // Check for 07:00 or 23:50
        if ((hrs === 7 && mins === 0) || (hrs === 23 && mins === 50)) {
            lastRunMinute = currentMinute;
            console.log(`[Scheduler] Triggering scheduled playlist generation (Time: ${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')})`);
            await runDailyGeneration();
        }
    }, 30000);
}

/**
 * Iterates through all active channels and triggers playlist generation.
 */
async function runDailyGeneration() {
    try {
        const [activeChannels] = await pool.execute<RowDataPacket[]>('SELECT id, timezone_offset FROM channels WHERE status = "active"');
        
        if (activeChannels.length === 0) {
            console.log('[Scheduler] No active channels found for generation.');
            return;
        }

        for (const ch of activeChannels) {
            const channelId = ch.id;
            const timezoneOffset = ch.timezone_offset !== null ? parseInt(ch.timezone_offset) : 3;
            const containerName = `tv_playout_ch_${channelId}`;
            
            console.log(`[Scheduler] Generating playlists for Channel ${channelId} (TZ Offset: ${timezoneOffset})...`);

            // 1. Generate for today
            try {
                await execInContainer(containerName, ['python3', '/app/generate_playlist.py']);
                console.log(`[Scheduler] Channel ${channelId}: Today's playlist generated.`);
            } catch (e: any) {
                console.error(`[Scheduler] Channel ${channelId}: Today's generation failed: ${e.message}`);
                continue; // Skip tomorrow if today failed? Or try anyway? Let's try anyway.
            }

            // 2. Generate for tomorrow based on channel's local time
            try {
                const now = new Date();
                // Shift to local time, then add 1 day
                const localTime = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
                const tomorrowLocal = new Date(localTime);
                tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
                
                const tomorrowStr = tomorrowLocal.toISOString().split('T')[0];
                
                await execInContainer(containerName, ['python3', '/app/generate_playlist.py', '--date', tomorrowStr]);
                console.log(`[Scheduler] Channel ${channelId}: Tomorrow's playlist generated (${tomorrowStr}).`);
            } catch (e: any) {
                console.error(`[Scheduler] Channel ${channelId}: Tomorrow's generation failed: ${e.message}`);
            }

            // 3. Trigger HotReload signal
            try {
                await execInContainer(containerName, ['sh', '-c', `touch /tmp/schedule_updated_ch${channelId}`]);
                console.log(`[Scheduler] Channel ${channelId}: HotReload signal sent.`);
            } catch (e: any) {
                console.warn(`[Scheduler] Channel ${channelId}: Failed to send HotReload signal: ${e.message}`);
            }
        }
    } catch (e: any) {
        console.error('[Scheduler] Error during scheduled generation:', e.message);
    }
}
