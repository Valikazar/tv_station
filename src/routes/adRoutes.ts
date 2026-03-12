import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ADS_BASE_PATH, getAdSlots, getLibraryNameForSlot } from '../utils/adMapping';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import { logAction } from '../utils/actionLogger';
import { execInContainer } from '../services/dockerService';

const execAsync = promisify(exec);
const router = express.Router();
const FALLBACK_SOURCE = '/opt/tv_station/media/ads/fallback/fall.mp4';
const FALLBACK_FILENAME = 'fall.mp4';
const ARCHIVE_SLOT = 'old';

/**
 * Get video duration in seconds using ffprobe.
 * Returns -1 if not a valid video.
 */
async function getVideoDuration(filePath: string): Promise<number> {
    try {
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
        const duration = parseFloat(stdout.trim());
        return isNaN(duration) ? -1 : Math.round(duration * 1000);
    } catch (e) {
        return -1;
    }
}

// Configure multer for temp upload
// Use absolute path to ensure reliability regardless of CWD
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads_temp');
if (!fs.existsSync(UPLOAD_DIR)) {
    try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.error('Failed to create upload dir:', e);
    }
}
const upload = multer({ dest: UPLOAD_DIR });

const uploadMiddleware = (req: Request, res: Response, next: any) => {
    upload.single('videoFile')(req, res, (err) => {
        if (err) {
            console.error('Multer Upload Error:', err);
            return res.status(500).send(`File upload error: ${err.message}`);
        }
        next();
    });
};

const NEW_ADS_PATH = path.join(path.dirname(ADS_BASE_PATH), 'new_ads');

// Helper functions for fallbacks are no longer needed as playout sequence uses DB and fallback from /app directly.

router.get('/', async (req: Request, res: Response) => {
    try {
        const channelId = req.session.currentChannelId || 1;
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM ad_videos WHERE channel_id = ? ORDER BY created_at DESC', [channelId]);
        const showArchived = req.query.showArchived === 'true';
        const allAdSlots = getAdSlots(channelId);

        // Count videos per slot for the UI
        const slotCounts: Record<string, number> = {};
        const slotsToCount = [...allAdSlots, { id: ARCHIVE_SLOT, dbId: ARCHIVE_SLOT, label: 'Архив' }];
        for (const slot of slotsToCount) {
            const [countRows] = await pool.execute<RowDataPacket[]>(
                "SELECT count(*) as count FROM ad_videos WHERE JSON_CONTAINS(target_slots_ids, ?) AND channel_id = ?",
                [JSON.stringify(slot.dbId), channelId]
            );
            slotCounts[slot.id] = countRows[0].count;
        }

        // Filter videos based on showArchived
        const filteredVideos = rows.filter(video => {
            let slots: (number | string)[] = [];
            try {
                if (typeof video.target_slots_ids === 'string') {
                    slots = JSON.parse(video.target_slots_ids || '[]');
                } else if (Array.isArray(video.target_slots_ids)) {
                    slots = video.target_slots_ids;
                }
            } catch (e) { slots = []; }

            if (slots.length === 0) return false;
            if (showArchived) return true;

            // If not showing archived, at least one slot must be regular
            return slots.some((s: number | string) => s !== ARCHIVE_SLOT);
        });

        res.render('ads', {
            slots: allAdSlots,
            archiveSlot: { id: ARCHIVE_SLOT, label: 'Архив' },
            videos: filteredVideos,
            slotCounts,
            showArchived
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading ads page');
    }
});

router.post('/upload', uploadMiddleware, async (req: Request, res: Response) => {
    try {
        const file = req.file;
        const displayName = req.body.displayName;
        let selectedSlots = req.body.slots; // These are dbIds now

        console.log('UPLOAD DEBUG - req.body:', JSON.stringify(req.body));
        console.log('UPLOAD DEBUG - selectedSlots before parsing:', selectedSlots);

        if (!file) {
            return res.status(400).send('No file uploaded');
        }

        if (!selectedSlots) {
            selectedSlots = [];
        } else if (!Array.isArray(selectedSlots)) {
            selectedSlots = [selectedSlots];
        }

        // Convert to numbers where appropriate
        const slotIds = selectedSlots.map((id: string) => isNaN(Number(id)) ? id : Number(id));

        const originalName = file.originalname;

        // Check duration and validate video
        const duration = await getVideoDuration(file.path);
        if (duration < 0) {
            await fs.promises.unlink(file.path);
            return res.status(400).send('Invalid video file or format. Could not determine duration.');
        }

        const channelId = req.session.currentChannelId || 1;

        // Insert into DB first to get ID
        const [result] = await pool.execute<any>(
            'INSERT INTO ad_videos (filename, display_name, target_slots_ids, duration, channel_id) VALUES (?, ?, ?, ?, ?)',
            ['TEMP', displayName || originalName, JSON.stringify(slotIds), duration, channelId]
        );
        const videoId = result.insertId;

        // Generate filename with ID only (preserving extension)
        const ext = path.extname(file.originalname);
        const newFilename = `${videoId}${ext}`;

        // Update filename in DB
        await pool.execute('UPDATE ad_videos SET filename = ? WHERE id = ?', [newFilename, videoId]);

        if (!fs.existsSync(NEW_ADS_PATH)) {
            fs.mkdirSync(NEW_ADS_PATH, { recursive: true });
        }

        const targetPath = path.join(NEW_ADS_PATH, newFilename);

        // Move the file from temp to new_ads
        await fs.promises.copyFile(file.path, targetPath);
        await fs.promises.unlink(file.path);

        // Log action
        const username = req.session?.username || 'unknown';
        logAction(username, 'UPLOAD', `"${displayName}" -> slots (IDs): [${slotIds.join(', ')}]`);

        res.redirect('/ads');

    } catch (err: any) {
        console.error('Upload Error Details:', err);
        res.status(500).send(`Error uploading file: ${err.message}`);
    }
});

// Add to slot
router.post('/add-to-slot', async (req: Request, res: Response) => {
    try {
        const { videoId, slotId } = req.body; // slotId is dbId here
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM ad_videos WHERE id = ?', [videoId]);
        if (rows.length === 0) return res.status(404).send('Video not found');

        const video = rows[0];
        let slots = typeof video.target_slots_ids === 'string' ? JSON.parse(video.target_slots_ids) : video.target_slots_ids;
        const targetDbId = isNaN(Number(slotId)) ? slotId : Number(slotId);

        if (slots.includes(targetDbId)) return res.status(400).send('Already in slot');

        if (!slots.includes(targetDbId)) {
            slots.push(targetDbId);

            // If it was in archive and now added to a slot, we can remove it from archive implicitly if desired.
            if (targetDbId !== ARCHIVE_SLOT && slots.includes(ARCHIVE_SLOT)) {
                slots = slots.filter((s: string | number) => s !== ARCHIVE_SLOT);
            }

            await pool.execute('UPDATE ad_videos SET target_slots_ids = ? WHERE id = ?', [JSON.stringify(slots), videoId]);
        }

        // Get updated slot count
        const [countRows] = await pool.execute<RowDataPacket[]>(
            "SELECT count(*) as count FROM ad_videos WHERE JSON_CONTAINS(target_slots_ids, ?)",
            [JSON.stringify(targetDbId)]
        );

        // Log action
        const username = req.session?.username || 'unknown';
        logAction(username, 'ADD_TO_SLOT', `video ID ${videoId} -> slot ID "${targetDbId}"`);

        res.json({ success: true, slots, slotCount: countRows[0].count });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Remove from slot
router.post('/remove-from-slot', async (req: Request, res: Response) => {
    try {
        const { videoId, slotId } = req.body; // slotId is dbId here
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM ad_videos WHERE id = ?', [videoId]);
        if (rows.length === 0) return res.status(404).send('Video not found');

        const video = rows[0];
        let slots = typeof video.target_slots_ids === 'string' ? JSON.parse(video.target_slots_ids) : video.target_slots_ids;
        const targetDbId = isNaN(Number(slotId)) ? slotId : Number(slotId);

        const index = slots.indexOf(targetDbId);
        if (index === -1) return res.status(400).send('Not in slot');

        if (targetDbId === ARCHIVE_SLOT) {
            // Permanent delete from archive (= delete from disk)
            const filePath = path.join(NEW_ADS_PATH, video.filename);
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
            slots.splice(index, 1);
        } else {
            slots.splice(index, 1);
            // If no active slots remain, move to archive
            const activeSlotsCount = slots.filter((s: string | number) => s !== ARCHIVE_SLOT).length;
            if (activeSlotsCount === 0 && !slots.includes(ARCHIVE_SLOT)) {
                slots.push(ARCHIVE_SLOT);
            }
        }

        await pool.execute('UPDATE ad_videos SET target_slots_ids = ? WHERE id = ?', [JSON.stringify(slots), videoId]);

        // Get updated slot count
        const [countRows] = await pool.execute<RowDataPacket[]>(
            "SELECT count(*) as count FROM ad_videos WHERE JSON_CONTAINS(target_slots_ids, ?)",
            [JSON.stringify(targetDbId)]
        );

        // Log action
        const username = req.session?.username || 'unknown';
        logAction(username, 'REMOVE_FROM_SLOT', `video ID ${videoId} <- slot ID "${targetDbId}"`);

        res.json({ success: true, slots, slotCount: countRows[0].count });
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});
// Trigger Playlist Generation manually
router.post('/generate-playlist', async (req: Request, res: Response) => {
    try {
        const channelId = req.session.currentChannelId || 1;
        console.log(`User triggered manual playlist generation for Channel ${channelId}`);

        // Execute the script on the correct tv_playout container for today
        const containerName = `tv_playout_ch_${channelId}`;
        await execInContainer(containerName, ['python3', '/app/generate_playlist.py']);

        // Execute the script on the correct tv_playout container for tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];
        await execInContainer(containerName, ['python3', '/app/generate_playlist.py', '--date', tomorrowStr]);

        // Signal the running playout process to hot-reload the new schedule
        // playout.py checks for this file every 2s and interrupts the current segment
        try {
            await execInContainer(containerName, ['sh', '-c', `touch /tmp/schedule_updated_ch${channelId}`]);
            console.log(`[HotReload] Signal sent to ${containerName}`);
        } catch (e: any) {
            console.warn(`[HotReload] Could not send signal to ${containerName}: ${e.message}`);
        }

        const username = req.session?.username || 'unknown';
        logAction(username, 'GENERATE_PLAYLIST', 'Manually updated playlist via Ads Management UI');

        res.json({ success: true });
    } catch (err: any) {
        console.error('Failed to generate playlist:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/disk-space', async (req: Request, res: Response) => {
    try {
        // the /opt/tv_station/media/ads path maps inside the container
        const { stdout } = await execAsync('df -h /opt/tv_station/media/ads');
        // output format typically: Filesystem      Size  Used Avail Use% Mounted on
        const lines = stdout.split('\n');
        if (lines.length > 1) {
            const parts = lines[1].trim().split(/\s+/);
            // parts[1] is Size, parts[2] is Used, parts[3] is Avail, parts[4] is Use%
            res.json({ success: true, free: parts[3], total: parts[1], use: parts[4] });
        } else {
            res.json({ success: false, error: "Unable to parse df output" });
        }
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/playlist', async (req: Request, res: Response) => {
    try {
        const channelId = req.session.currentChannelId || 1;
        const [channelRows] = await pool.execute<RowDataPacket[]>('SELECT timezone_offset FROM channels WHERE id = ?', [channelId]);
        const timezoneOffset = channelRows.length > 0 ? (channelRows[0].timezone_offset !== null ? parseInt(channelRows[0].timezone_offset) : 3) : 3;

        // Calculate current date based on channel's timezone offset
        // This is robust even if the server/container is in UTC
        const now = new Date();
        const localTime = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
        const todayLocal = localTime.toISOString().split('T')[0];

        const targetDate = req.query.date ? String(req.query.date) : todayLocal;
        console.log(`Fetching playlist for Channel ${channelId}, Date: ${targetDate} (Offset: ${timezoneOffset})`);

        const [rows] = await pool.execute<RowDataPacket[]>(`
            SELECT 
                p.start_time, 
                DATE_FORMAT(p.start_time, '%H:%i:%s') as formatted_time, 
                p.duration, 
                p.filename, 
                p.entry_type, 
                a.display_name,
                s.name as slot_name,
                s.exclude_from_stats
            FROM generated_playlists p
            LEFT JOIN ad_videos a ON p.video_id = a.id
            LEFT JOIN time_slots s ON p.slot_id = s.id
            WHERE p.channel_id = ? AND DATE(p.schedule_date) = ?
            ORDER BY p.start_time ASC
        `, [channelId, targetDate]);

        res.json({ success: true, playlist: rows, timezoneOffset });
    } catch (e: any) {
        console.error('Failed to fetch playlist:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

export default router;
