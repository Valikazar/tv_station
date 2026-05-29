import express, { Request, Response } from 'express';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import fs from 'fs';
import path from 'path';

const router = express.Router();
let isSchemaPatched = false;

async function patchSchema() {
    if (isSchemaPatched) return;
    try {
        const [columns]: any = await pool.query("SHOW COLUMNS FROM receivers LIKE 'version'");
        if (columns.length === 0) {
            console.log("Patching 'receivers' table: Adding 'version' column...");
            await pool.query("ALTER TABLE receivers ADD COLUMN version VARCHAR(20) DEFAULT '1.0.0' AFTER ip_address");
        }
        
        const [volColumns]: any = await pool.query("SHOW COLUMNS FROM receivers LIKE 'target_volume'");
        if (volColumns.length === 0) {
            console.log("Patching 'receivers' table: Adding volume columns...");
            await pool.query("ALTER TABLE receivers ADD COLUMN target_volume INT DEFAULT 30 AFTER version, ADD COLUMN actual_volume INT AFTER target_volume");
        }
        isSchemaPatched = true;
    } catch (e) {
        console.warn("Schema patch check failed (can be ignored if already patched):", e);
    }
}

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
            current_stream_url,
            version,
            actual_volume
        } = req.body;

        if (!id) {
            return res.status(400).json({ error: 'Receiver ID is required' });
        }

        // NOTE: current_stream_url is intentionally NOT updated here.
        // It stores the last *assigned* (commanded) URL, set only via /command endpoint.
        // actual_stream_url stores what MPV is actually playing (reported by agent).
        await patchSchema();

        await pool.execute(`
            INSERT INTO receivers (
                id, hostname, ip_address, version, cpu_usage, temperature, 
                traffic_speed, current_source_ip, actual_stream_url, actual_volume, last_seen
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE
                hostname = VALUES(hostname),
                ip_address = VALUES(ip_address),
                version = VALUES(version),
                cpu_usage = VALUES(cpu_usage),
                temperature = VALUES(temperature),
                traffic_speed = VALUES(traffic_speed),
                current_source_ip = VALUES(current_source_ip),
                actual_stream_url = VALUES(actual_stream_url),
                actual_volume = VALUES(actual_volume),
                last_seen = CURRENT_TIMESTAMP
        `, [
            id, hostname, ip_address, version || '1.0.0', cpu_usage, temperature,
            traffic_speed, current_source_ip, current_stream_url, actual_volume || null
        ]);

        // Check if there are pending commands or settings sync
        const [rows]: any = await pool.execute(
            'SELECT target_stream_url, target_command, target_volume FROM receivers WHERE id = ?',
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

            // Sync volume if mismatch
            if (rows[0].target_volume !== null && rows[0].target_volume !== actual_volume) {
                response.volume = rows[0].target_volume;
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

// Endpoint to receive logs from agents when they encounter a crash or freeze
router.post('/logs', async (req: Request, res: Response) => {
    try {
        const { id, hostname, logs } = req.body;
        if (!id || !logs) {
            return res.status(400).json({ error: 'id and logs are required' });
        }

        const logsDir = path.join(__dirname, '../../logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        const logFilePath = path.join(logsDir, `receiver_${id}.log`);
        const timestamp = new Date().toISOString();
        
        let logContent = `\n--- LOG REPORT AT ${timestamp} (Hostname: ${hostname || 'Unknown'}) ---\n`;
        logContent += logs;
        logContent += `\n-----------------------------------------------------\n`;

        fs.appendFileSync(logFilePath, logContent);
        
        console.log(`[Receivers] Saved crash logs from receiver ${id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving receiver logs:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin routes for receivers (will be protected by requireAuth in app.ts)
router.get('/', async (req: Request, res: Response) => {
    try {
        const [rows] = await pool.execute(`
            SELECT *, 
            (TIMESTAMPDIFF(SECOND, last_seen, CURRENT_TIMESTAMP) < 60) AS is_online 
            FROM receivers 
            ORDER BY INET_ATON(ip_address) ASC, last_seen DESC
        `);
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
        const { nickname, location, volume } = req.body;
        await pool.execute(
            'UPDATE receivers SET nickname = ?, location = ?, target_volume = ? WHERE id = ?',
            [nickname || null, location || null, volume !== undefined ? volume : 30, id]
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
