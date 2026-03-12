import express, { Request, Response } from 'express';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';

const router = express.Router();

// Public: called by RPi agent on startup to get its stream URL
router.get('/config', async (req: Request, res: Response) => {
    try {
        const { id, hostname } = req.query as { id: string; hostname: string };
        if (!id) return res.status(400).json({ error: 'id is required' });

        // Upsert receiver so it appears in the list even before first report
        await pool.execute(`
            INSERT INTO receivers (id, hostname, last_seen)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE
                hostname = VALUES(hostname),
                last_seen = CURRENT_TIMESTAMP
        `, [id, hostname || null]);

        const [rows]: any = await pool.execute(
            'SELECT current_stream_url, target_stream_url FROM receivers WHERE id = ?',
            [id]
        );

        let streamUrl: string | null = null;

        if (rows.length > 0 && rows[0].target_stream_url) {
            // Pending command — return it and clear
            streamUrl = rows[0].target_stream_url;
            await pool.execute('UPDATE receivers SET target_stream_url = NULL WHERE id = ?', [id]);
        } else if (rows.length > 0 && rows[0].current_stream_url) {
            streamUrl = rows[0].current_stream_url;
        } else {
            // Default: first active channel multicast address
            const [channels]: any = await pool.execute(
                'SELECT multicast_ip, multicast_port, protocol FROM channels WHERE status = "active" ORDER BY id ASC LIMIT 1'
            );
            if (channels.length > 0) {
                const proto = channels[0].protocol || 'udp';
                streamUrl = `${proto}://${channels[0].multicast_ip}:${channels[0].multicast_port}`;
            }
        }

        res.json({ stream_url: streamUrl });
    } catch (err) {
        console.error('Error in receiver config API:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Public route for receivers to report status
// In a production environment, you would want to add a shared secret or token for authentication
router.post('/report', async (req: Request, res: Response) => {
    try {
        const {
            id,
            hostname,
            ip_address,
            cpu_usage,
            temperature,
            traffic_speed,
            current_source_ip,
            current_stream_url
        } = req.body;

        if (!id) {
            return res.status(400).json({ error: 'Receiver ID is required' });
        }

        // NOTE: current_stream_url is intentionally NOT updated here.
        // It stores the last *assigned* (commanded) URL, set only via /command endpoint.
        // actual_stream_url stores what MPV is actually playing (reported by agent).
        await pool.execute(`
            INSERT INTO receivers (
                id, hostname, ip_address, cpu_usage, temperature, 
                traffic_speed, current_source_ip, actual_stream_url, last_seen
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE
                hostname = VALUES(hostname),
                ip_address = VALUES(ip_address),
                cpu_usage = VALUES(cpu_usage),
                temperature = VALUES(temperature),
                traffic_speed = VALUES(traffic_speed),
                current_source_ip = VALUES(current_source_ip),
                actual_stream_url = VALUES(actual_stream_url),
                last_seen = CURRENT_TIMESTAMP
        `, [
            id, hostname, ip_address, cpu_usage, temperature,
            traffic_speed, current_source_ip, current_stream_url
        ]);

        // Check if there are pending commands
        const [rows]: any = await pool.execute(
            'SELECT target_stream_url, target_command FROM receivers WHERE id = ?',
            [id]
        );

        const response: any = { success: true };
        let clearNeeded = false;

        if (rows.length > 0) {
            if (rows[0].target_stream_url) {
                response.command = 'change_channel';
                response.url = rows[0].target_stream_url;
                clearNeeded = true;
            }
            
            // Reboot can be sent either instead of channel change or as separate command
            if (rows[0].target_command === 'reboot') {
                if (response.command === 'change_channel') {
                    // If both, reboot takes precedence or we can combine. 
                    // Usually better to just reboot, it will fetch new config on start.
                    response.command = 'reboot';
                } else {
                    response.command = 'reboot';
                }
                clearNeeded = true;
            }

            if (clearNeeded) {
                // Clear the commands after sending
                await pool.execute(
                    'UPDATE receivers SET target_stream_url = NULL, target_command = NULL WHERE id = ?',
                    [id]
                );
            }
        }

        res.json(response);
    } catch (err) {
        console.error('Error in receiver report API:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin routes for receivers (will be protected by requireAuth in app.ts)
router.get('/', async (req: Request, res: Response) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM receivers ORDER BY last_seen DESC');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching receivers:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/command', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { stream_url } = req.body;

        if (!stream_url) {
            return res.status(400).json({ error: 'stream_url is required' });
        }

        // Set target command AND update current_stream_url immediately so the UI
        // always reflects the *assigned* channel, not what MPV happens to report.
        await pool.execute(
            'UPDATE receivers SET target_stream_url = ?, current_stream_url = ? WHERE id = ?',
            [stream_url, stream_url, id]
        );

        res.json({ success: true, message: 'Command queued' });
    } catch (err) {
        console.error('Error queuing receiver command:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await pool.execute('DELETE FROM receivers WHERE id = ?', [id]);
        res.json({ success: true, message: 'Receiver deleted' });
    } catch (err) {
        console.error('Error deleting receiver:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/details', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { nickname, location } = req.body;
        await pool.execute(
            'UPDATE receivers SET nickname = ?, location = ? WHERE id = ?',
            [nickname || null, location || null, id]
        );
        res.json({ success: true, message: 'Details updated' });
    } catch (err) {
        console.error('Error updating receiver details:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/:id/reboot', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await pool.execute(
            'UPDATE receivers SET target_command = "reboot" WHERE id = ?',
            [id]
        );
        res.json({ success: true, message: 'Reboot command queued' });
    } catch (err) {
        console.error('Error queuing reboot command:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
