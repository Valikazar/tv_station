import express, { Request, Response } from 'express';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import { createAndStartChannelContainers, stopChannelContainers, getHostNetworkInterfaces, stopBeaconIfNoChannelsActive, startHlsWriter, stopHlsWriter, pauseHlsWriter, isHlsWriterRunning } from '../services/dockerService';
import { initializeChannelDefaults } from '../utils/timeSlots';

// In-process heartbeat timers: channelId → timeout handle
const hlsTimers: Record<number, ReturnType<typeof setTimeout>> = {};
const HLS_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes

function resetHlsTimer(channelId: number) {
    if (hlsTimers[channelId]) clearTimeout(hlsTimers[channelId]);
    hlsTimers[channelId] = setTimeout(async () => {
        console.log(`[HLS] Pausing channel ${channelId} due to inactivity (no ping for 5 min).`);
        try { await pauseHlsWriter(channelId); } catch { /* ignore */ }
        delete hlsTimers[channelId];
    }, HLS_INACTIVITY_MS);
}

const router = express.Router();

// Require admin (optional if mounted under /admin, but good practice)
router.use((req, res, next) => {
    if (req.session.username === 'admin') next();
    else res.status(403).json({ error: 'Access denied' });
});

router.get('/', async (req: Request, res: Response) => {
    res.render('channels');
});

router.get('/list', async (req: Request, res: Response) => {
    try {
        const [channels] = await pool.execute<RowDataPacket[]>('SELECT * FROM channels ORDER BY id ASC');
        res.json({ success: true, channels });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/switch', (req: Request, res: Response) => {
    const channelId = parseInt(req.body.channel_id);
    if (!isNaN(channelId)) {
        req.session.currentChannelId = channelId;
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: "Invalid channel ID" });
    }
});

router.get('/interfaces', async (req: Request, res: Response) => {
    try {
        const ips = await getHostNetworkInterfaces();
        res.json({ success: true, interfaces: ips });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/:id/edit', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    const { name, multicast_ip, multicast_port, interface_ip, ffmpeg_bitrate_k, protocol, timezone_offset } = req.body;

    if (!name || !multicast_ip || !multicast_port || !interface_ip || !ffmpeg_bitrate_k || !protocol || timezone_offset === undefined) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        await pool.execute(
            'UPDATE channels SET name = ?, multicast_ip = ?, multicast_port = ?, interface_ip = ?, ffmpeg_bitrate_k = ?, protocol = ?, timezone_offset = ? WHERE id = ?',
            [name, multicast_ip, parseInt(multicast_port), interface_ip, parseInt(ffmpeg_bitrate_k), protocol, parseInt(timezone_offset), channelId]
        );

        // If the channel was active, restart it with new settings to apply cleanly
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT status FROM channels WHERE id = ?', [channelId]);
        if (rows.length > 0 && rows[0].status === 'active') {
            await createAndStartChannelContainers(channelId); // this function auto-removes existing ones
        }
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/', async (req: Request, res: Response) => {
    const { name, multicast_ip, multicast_port, protocol, timezone_offset } = req.body;
    if (!name || !multicast_ip || !multicast_port || !protocol || timezone_offset === undefined) return res.status(400).json({ error: "Missing required fields" });
    try {
        const [result]: any = await pool.execute(
            'INSERT INTO channels (name, multicast_ip, multicast_port, status, protocol, timezone_offset) VALUES (?, ?, ?, ?, ?, ?)',
            [name, multicast_ip, parseInt(multicast_port), 'stopped', protocol, parseInt(timezone_offset)]
        );
        
        const newChannelId = result.insertId;
        await initializeChannelDefaults(newChannelId);

        res.json({ success: true, channel_id: newChannelId });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/:id/start', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    try {
        await createAndStartChannelContainers(channelId);
        await pool.execute('UPDATE channels SET status = "active" WHERE id = ?', [channelId]);
        res.json({ success: true });
    } catch (e: any) {
        await pool.execute('UPDATE channels SET status = "error" WHERE id = ?', [channelId]);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/:id/stop', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    try {
        // Get interface before stopping to check beacon afterward
        const [rows] = await pool.execute<RowDataPacket[]>('SELECT interface_ip FROM channels WHERE id = ?', [channelId]);
        const interfaceIp = rows[0]?.interface_ip;

        await stopChannelContainers(channelId);
        await pool.execute('UPDATE channels SET status = "stopped" WHERE id = ?', [channelId]);

        // Stop beacon if no active channels remain on this interface
        if (interfaceIp) await stopBeaconIfNoChannelsActive(interfaceIp);

        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/:id', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    try {
        await stopChannelContainers(channelId);
        await pool.execute('DELETE FROM channels WHERE id = ?', [channelId]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── HLS on-demand endpoints ─────────────────────────────────────────────────

// Start HLS writer for a channel, returns the m3u8 URL relative path
router.post('/:id/hls/start', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    try {
        const m3u8 = await startHlsWriter(channelId);
        resetHlsTimer(channelId);
        // m3u8 is an absolute path on the server; expose as web URL via existing /hls/ nginx alias
        const url = `/hls/ch${channelId}.m3u8`;
        res.json({ success: true, url });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Heartbeat — call every 30s from the browser player to keep HLS alive
router.post('/:id/hls/ping', (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    resetHlsTimer(channelId);
    res.json({ success: true });
});

// Stop HLS writer explicitly (pauses the container, keeps it warm)
router.post('/:id/hls/stop', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    if (hlsTimers[channelId]) { clearTimeout(hlsTimers[channelId]); delete hlsTimers[channelId]; }
    try {
        await pauseHlsWriter(channelId);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// HLS status check
router.get('/:id/hls/status', async (req: Request, res: Response) => {
    const channelId = parseInt(req.params.id as string);
    try {
        const state = await isHlsWriterRunning(channelId);
        res.json({ success: true, ...state });
    } catch (e: any) {
        res.json({ success: true, running: false, paused: false });
    }
});

export default router;
