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

// Schema auto-patching from within Docker context to bypass host connectivity issues
pool.query(`ALTER TABLE ad_videos ADD COLUMN unmuted_slots_ids JSON DEFAULT ('[]')`).catch(() => {});
pool.query(`ALTER TABLE generated_playlists ADD COLUMN unmuted TINYINT(1) DEFAULT 0`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN source_type VARCHAR(16) NOT NULL DEFAULT 'file'`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN stream_url VARCHAR(512) DEFAULT NULL`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN stream_buffer_sec INT NOT NULL DEFAULT 5`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN rotation_end_date DATE DEFAULT NULL`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN is_duplicate TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN original_video_id INT DEFAULT NULL`).catch(() => {});
pool.query(`ALTER TABLE ad_videos ADD COLUMN sort_order INT NOT NULL DEFAULT 0`).catch(() => {});

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
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM ad_videos WHERE channel_id = ? ORDER BY sort_order ASC, id ASC', [channelId]);
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
        const filteredVideos = rows.map(video => {
            let slots: (number | string)[] = [];
            let unmutedSlots: (number | string)[] = [];
            try {
                if (typeof video.target_slots_ids === 'string') slots = JSON.parse(video.target_slots_ids || '[]');
                else if (Array.isArray(video.target_slots_ids)) slots = video.target_slots_ids;
            } catch (e) { slots = []; }

            try {
                if (typeof video.unmuted_slots_ids === 'string') unmutedSlots = JSON.parse(video.unmuted_slots_ids || '[]');
                else if (Array.isArray(video.unmuted_slots_ids)) unmutedSlots = video.unmuted_slots_ids;
            } catch (e) { unmutedSlots = []; }

            video.parsedSlots = slots;
            video.parsedUnmutedSlots = unmutedSlots;
            return video;
        }).filter(video => {
            const slots = video.parsedSlots;
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
        const rotationEndDateRaw = req.body.rotationEndDate as string | undefined;
        const rotationEndDate = rotationEndDateRaw && rotationEndDateRaw.trim() ? rotationEndDateRaw.trim() : null;

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

        let originalName = file.originalname;

        // If uploaded file is an image, convert it to a 15-second video
        if (file.mimetype.startsWith('image/')) {
            console.log(`[Upload] Image detected: ${originalName}. Converting to 15s MP4...`);
            const tempVideoPath = file.path + '_converted.mp4';
            // Generate a 15s video from the image with a silent audio track
            const ffmpegCmd = `ffmpeg -y -loop 1 -framerate 30 -i "${file.path}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -t 15 -pix_fmt yuv420p -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" -c:a aac -shortest "${tempVideoPath}"`;
            
            await execAsync(ffmpegCmd);
            
            // Clean up original image and update file references
            await fs.promises.unlink(file.path).catch(e => console.error('Error removing original image:', e));
            file.path = tempVideoPath;
            file.mimetype = 'video/mp4';
            originalName = `${path.parse(originalName).name}.mp4`;
            file.originalname = originalName;
            console.log(`[Upload] Image conversion successful. New name: ${originalName}`);
        }

        // Check duration and validate video
        const duration = await getVideoDuration(file.path);
        if (duration < 0) {
            await fs.promises.unlink(file.path).catch(() => {});
            return res.status(400).send('Invalid video file or format. Could not determine duration.');
        }

        const channelId = req.session.currentChannelId || 1;

        // Insert into DB first to get ID
        const [result] = await pool.execute<any>(
            'INSERT INTO ad_videos (filename, display_name, target_slots_ids, duration, channel_id, rotation_end_date) VALUES (?, ?, ?, ?, ?, ?)',
            ['TEMP', displayName || originalName, JSON.stringify(slotIds), duration, channelId, rotationEndDate]
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
        const isDuplicate = video.is_duplicate === 1;
        const targetDbId = isNaN(Number(slotId)) ? slotId : Number(slotId);

        // Duplicates cannot be placed in the archive
        if (isDuplicate && targetDbId === ARCHIVE_SLOT) {
            return res.status(400).send('Duplicates cannot be placed in the archive');
        }

        let slots = typeof video.target_slots_ids === 'string' ? JSON.parse(video.target_slots_ids) : video.target_slots_ids;

        if (slots.includes(targetDbId)) return res.status(400).send('Already in slot');

        if (!slots.includes(targetDbId)) {
            slots.push(targetDbId);

            // If it was in archive and now added to a slot, remove from archive implicitly.
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
        const isDuplicate = video.is_duplicate === 1;
        let slots = typeof video.target_slots_ids === 'string' ? JSON.parse(video.target_slots_ids) : video.target_slots_ids;
        const targetDbId = isNaN(Number(slotId)) ? slotId : Number(slotId);

        const index = slots.indexOf(targetDbId);
        if (index === -1) return res.status(400).send('Not in slot');

        if (targetDbId === ARCHIVE_SLOT) {
            // Archive slot: for originals - delete file from disk; for duplicates - this shouldn't happen
            if (!isDuplicate) {
                const filePath = path.join(NEW_ADS_PATH, video.filename);
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                }
            }
            slots.splice(index, 1);
        } else {
            slots.splice(index, 1);
            const activeSlotsCount = slots.filter((s: string | number) => s !== ARCHIVE_SLOT).length;

            if (isDuplicate) {
                // Duplicates: when no active slots remain, delete the DB record (never archive)
                if (activeSlotsCount === 0) {
                    const username = req.session?.username || 'unknown';
                    logAction(username, 'DELETE_DUPLICATE', `duplicate video ID ${videoId} removed from all slots - DB record deleted`);
                    await pool.execute('DELETE FROM ad_videos WHERE id = ?', [videoId]);
                    // Get updated slot count
                    const [countRows] = await pool.execute<RowDataPacket[]>(
                        "SELECT count(*) as count FROM ad_videos WHERE JSON_CONTAINS(target_slots_ids, ?)",
                        [JSON.stringify(targetDbId)]
                    );
                    return res.json({ success: true, slots: [], slotCount: countRows[0].count, deleted: true });
                }
            } else {
                // Originals: move to archive when no active slots remain
                if (activeSlotsCount === 0 && !slots.includes(ARCHIVE_SLOT)) {
                    slots.push(ARCHIVE_SLOT);
                }
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

// Toggle unmuted state for a slot
router.post('/toggle-mute', async (req: Request, res: Response) => {
    try {
        const { videoId, slotId } = req.body;
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT unmuted_slots_ids FROM ad_videos WHERE id = ?', [videoId]);
        if (rows.length === 0) return res.status(404).send('Video not found');

        const video = rows[0];
        let unmutedSlots = [];
        try {
            if (typeof video.unmuted_slots_ids === 'string') unmutedSlots = JSON.parse(video.unmuted_slots_ids || '[]');
            else if (Array.isArray(video.unmuted_slots_ids)) unmutedSlots = video.unmuted_slots_ids;
            else if (video.unmuted_slots_ids) unmutedSlots = [video.unmuted_slots_ids];
        } catch (e) { }

        const targetDbId = isNaN(Number(slotId)) ? slotId : Number(slotId);
        const index = unmutedSlots.indexOf(targetDbId);

        let isUnmutedNow = false;
        if (index === -1) {
            unmutedSlots.push(targetDbId);
            isUnmutedNow = true;
        } else {
            unmutedSlots.splice(index, 1);
        }

        await pool.execute('UPDATE ad_videos SET unmuted_slots_ids = ? WHERE id = ?', [JSON.stringify(unmutedSlots), videoId]);

        const username = req.session?.username || 'unknown';
        logAction(username, 'TOGGLE_MUTE', `video ID ${videoId} slot ID "${targetDbId}" state -> ${isUnmutedNow ? 'UNMUTED' : 'MUTED'}`);

        res.json({ success: true, isUnmuted: isUnmutedNow, unmutedSlots });
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

// Set or clear the rotation end date for a video
router.post('/set-rotation-end', async (req: Request, res: Response) => {
    try {
        const { videoId, rotationEndDate } = req.body;
        if (!videoId) return res.status(400).json({ success: false, error: 'videoId required' });
        const dateVal = rotationEndDate && rotationEndDate.trim() ? rotationEndDate.trim() : null;
        await pool.execute('UPDATE ad_videos SET rotation_end_date = ? WHERE id = ?', [dateVal, videoId]);
        const username = req.session?.username || 'unknown';
        logAction(username, 'SET_ROTATION_END', `video ID ${videoId} -> ${dateVal ?? 'no limit'}`);
        res.json({ success: true, rotationEndDate: dateVal });
    } catch (err: any) {
        console.error('set-rotation-end error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create a duplicate of a video (virtual copy pointing to the same file)
router.post('/duplicate', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.body;
        if (!videoId) return res.status(400).json({ success: false, error: 'videoId required' });

        const [rows] = await pool.execute<RowDataPacket[]>('SELECT * FROM ad_videos WHERE id = ?', [videoId]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Video not found' });

        const original = rows[0];
        const channelId = original.channel_id;

        // Ensure sort_order is normalized to avoid placement bugs
        const [allVideos] = await pool.execute<RowDataPacket[]>(
            'SELECT id, sort_order FROM ad_videos WHERE channel_id = ? ORDER BY sort_order ASC, id ASC',
            [channelId]
        );
        
        let originalOrder = original.sort_order;
        const uniqueOrders = new Set(allVideos.map((v: any) => v.sort_order));
        
        if (uniqueOrders.size !== allVideos.length) {
            // Normalize to 10, 20, 30...
            for (let i = 0; i < allVideos.length; i++) {
                const newOrder = i * 10;
                await pool.execute('UPDATE ad_videos SET sort_order = ? WHERE id = ?', [newOrder, allVideos[i].id]);
                if (allVideos[i].id === original.id) {
                    originalOrder = newOrder;
                }
            }
        }

        // Place duplicate right after the original
        const newSortOrder = originalOrder + 5;

        const dupName = `${original.display_name} (копия)`;

        const [result] = await pool.execute<any>(
            `INSERT INTO ad_videos 
             (filename, display_name, target_slots_ids, unmuted_slots_ids, duration, channel_id, source_type, stream_url, stream_buffer_sec, rotation_end_date, is_duplicate, original_video_id, sort_order)
             VALUES (?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
                original.filename,
                dupName,
                original.duration,
                channelId,
                original.source_type || 'file',
                original.stream_url || null,
                original.stream_buffer_sec || 5,
                original.rotation_end_date || null,
                videoId,
                newSortOrder
            ]
        );

        const username = req.session?.username || 'unknown';
        logAction(username, 'DUPLICATE', `video ID ${videoId} -> new duplicate ID ${result.insertId} "${dupName}"`);

        res.json({ success: true, newId: result.insertId, displayName: dupName });
    } catch (err: any) {
        console.error('Duplicate error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Reorder: swap sort_order of a video with its neighbor (up or down)
router.post('/reorder', async (req: Request, res: Response) => {
    try {
        const { videoId, direction } = req.body;
        if (!videoId || !direction) return res.status(400).json({ success: false, error: 'videoId and direction required' });

        const [rows] = await pool.execute<RowDataPacket[]>('SELECT id, channel_id FROM ad_videos WHERE id = ?', [videoId]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Video not found' });

        const channelId = rows[0].channel_id;

        // Get all videos for this channel in display order (sort_order ASC, id ASC as tiebreaker)
        const [allVideos] = await pool.execute<RowDataPacket[]>(
            'SELECT id, sort_order FROM ad_videos WHERE channel_id = ? ORDER BY sort_order ASC, id ASC',
            [channelId]
        );

        // Normalize sort_order if there are any collisions
        const uniqueOrders = new Set(allVideos.map((v: any) => v.sort_order));
        if (uniqueOrders.size !== allVideos.length) {
            // Assign sequential sort_order values based on current (id-based) order
            for (let i = 0; i < allVideos.length; i++) {
                await pool.execute('UPDATE ad_videos SET sort_order = ? WHERE id = ?', [i * 10, allVideos[i].id]);
                allVideos[i].sort_order = i * 10;
            }
        }

        // Find current video's position in the ordered list
        const currentIdx = allVideos.findIndex((v: any) => String(v.id) === String(videoId));
        if (currentIdx === -1) return res.status(404).json({ success: false, error: 'Video not found in list' });

        const neighborIdx = direction === 'up' ? currentIdx - 1 : currentIdx + 1;

        if (neighborIdx < 0 || neighborIdx >= allVideos.length) {
            return res.json({ success: true, alreadyAtEdge: true });
        }

        const current = allVideos[currentIdx];
        const neighbor = allVideos[neighborIdx];

        // Swap sort_order values
        await pool.execute('UPDATE ad_videos SET sort_order = ? WHERE id = ?', [neighbor.sort_order, current.id]);
        await pool.execute('UPDATE ad_videos SET sort_order = ? WHERE id = ?', [current.sort_order, neighbor.id]);

        const username = req.session?.username || 'unknown';
        logAction(username, 'REORDER', `video ID ${videoId} moved ${direction}`);

        res.json({ success: true });
    } catch (err: any) {
        console.error('Reorder error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Add RTSP/HTTP stream as a schedulable entry
router.post('/add-stream', async (req: Request, res: Response) => {
    try {
        const { displayName, streamUrl, durationSec, bufferSec, slots, rotationEndDate } = req.body;

        if (!streamUrl || !streamUrl.trim()) {
            return res.status(400).json({ success: false, error: 'Stream URL is required' });
        }
        if (!durationSec || isNaN(Number(durationSec)) || Number(durationSec) <= 0) {
            return res.status(400).json({ success: false, error: 'Duration must be a positive number' });
        }

        const channelId = req.session.currentChannelId || 1;
        const durationMs = Math.round(Number(durationSec) * 1000);
        const buffer = Math.max(0, Math.round(Number(bufferSec) || 5));
        const name = (displayName || streamUrl).trim();

        let slotIds: (string | number)[] = [];
        if (Array.isArray(slots)) {
            slotIds = slots.map((id: string) => isNaN(Number(id)) ? id : Number(id));
        } else if (slots) {
            slotIds = [isNaN(Number(slots)) ? slots : Number(slots)];
        }

        // Use a synthetic filename so playout.py can identify it as a stream
        const tempFilename = `stream_${Date.now()}`;
        const endDate = rotationEndDate && rotationEndDate.trim() ? rotationEndDate.trim() : null;

        const [result] = await pool.execute<any>(
            `INSERT INTO ad_videos 
             (filename, display_name, target_slots_ids, duration, channel_id, source_type, stream_url, stream_buffer_sec, rotation_end_date)
             VALUES (?, ?, ?, ?, ?, 'stream', ?, ?, ?)`,
            [tempFilename, name, JSON.stringify(slotIds), durationMs, channelId, streamUrl.trim(), buffer, endDate]
        );
        const videoId = result.insertId;

        // Update filename to include ID for uniqueness
        const finalFilename = `stream_${videoId}`;
        await pool.execute('UPDATE ad_videos SET filename = ? WHERE id = ?', [finalFilename, videoId]);

        const username = req.session?.username || 'unknown';
        logAction(username, 'ADD_STREAM', `"${name}" -> ${streamUrl} (${durationSec}s buffer=${buffer}s) slots: [${slotIds.join(', ')}]`);

        res.json({ success: true, videoId });
    } catch (err: any) {
        console.error('Add stream error:', err);
        res.status(500).json({ success: false, error: err.message });
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
                p.unmuted,
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
