import express, { Request, Response } from 'express';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import { createAndStartChannelContainers, stopChannelContainers, getHostNetworkInterfaces, stopBeaconIfNoChannelsActive } from '../services/dockerService';
import { initializeChannelDefaults } from '../utils/timeSlots';

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

export default router;
