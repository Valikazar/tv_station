import express, { Request, Response, NextFunction } from 'express';
import { getSlots, saveSlots, buildSlotName } from '../utils/timeSlots';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ADS_BASE_PATH } from '../utils/adMapping';

const execAsync = promisify(exec);

const router = express.Router();

// Admin-only middleware
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (req.session.username === 'admin') {
        next();
    } else {
        res.status(403).send('Доступ запрещён');
    }
};

router.use(requireAdmin);

// Multer setup for temporary uploads
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads_temp');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const upload = multer({ dest: UPLOAD_DIR });

async function getVideoDuration(filePath: string): Promise<number> {
    try {
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
        const duration = parseFloat(stdout.trim());
        return isNaN(duration) ? -1 : Math.round(duration * 1000);
    } catch (e) {
        return -1;
    }
}

// GET /admin — render admin settings page
router.get('/', async (req: Request, res: Response) => {
    const channelId = Number(req.session.currentChannelId) || 1;
    const slots = getSlots(channelId);

    let fallbackPath = 'fall.mp4';
    try {
        const [rows] = await pool.execute<RowDataPacket[]>(
            "SELECT fallback_path FROM channel_settings WHERE channel_id = ?",
            [channelId]
        );
        if (rows.length > 0 && rows[0].fallback_path) {
            fallbackPath = rows[0].fallback_path;
        }
    } catch (e) {
        console.error('Error fetching fallback path:', e);
    }

    res.render('admin', {
        username: req.session.username,
        currentChannelId: channelId,
        fallbackPath: fallbackPath,
        slots: slots.map(s => ({
            id: s.id,
            name: s.name,
            hour: s.hour,
            minute: s.minute,
            duration: s.duration,
            exclude_from_stats: !!s.exclude_from_stats,
            start_behavior: s.start_behavior,
            end_behavior: s.end_behavior,
        })),
    });
});

// POST /admin/slots — save time slots
router.post('/slots', async (req: Request, res: Response) => {
    try {
        const { slots } = req.body;

        if (!Array.isArray(slots) || slots.length === 0) {
            return res.status(400).json({ error: 'Список слотов не может быть пустым' });
        }

        // Validate each slot
        for (const s of slots) {
            if (typeof s.name !== 'string' || s.name.trim() === '') {
                return res.status(400).json({ error: 'Название слота не может быть пустым' });
            }
            if (typeof s.hour !== 'number' || typeof s.minute !== 'number' || typeof s.duration !== 'number') {
                return res.status(400).json({ error: 'Каждый слот должен содержать name, hour, minute, duration' });
            }
            if (s.hour < 0 || s.hour > 23 || s.minute < 0 || s.minute > 59) {
                return res.status(400).json({ error: `Неверное время: ${s.hour}:${s.minute}` });
            }
            if (s.duration < 1 || s.duration > 1440) {
                return res.status(400).json({ error: `Неверная длительность: ${s.duration}` });
            }
            s.exclude_from_stats = !!s.exclude_from_stats;
            s.start_behavior = typeof s.start_behavior === 'number' ? s.start_behavior : 4;
            s.end_behavior = typeof s.end_behavior === 'number' ? s.end_behavior : 1;
        }

        // Sort by start time
        const sorted = [...slots].sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));

        // Check for overlaps
        const overlaps: number[] = [];
        for (let i = 0; i < sorted.length; i++) {
            const currentStart = sorted[i].hour * 60 + sorted[i].minute;
            const currentEnd = currentStart + sorted[i].duration;

            for (let j = i + 1; j < sorted.length; j++) {
                const nextStart = sorted[j].hour * 60 + sorted[j].minute;
                if (nextStart < currentEnd) {
                    // Find original indices
                    const origI = slots.findIndex((s: any) => s.hour === sorted[i].hour && s.minute === sorted[i].minute);
                    const origJ = slots.findIndex((s: any) => s.hour === sorted[j].hour && s.minute === sorted[j].minute);
                    if (!overlaps.includes(origI)) overlaps.push(origI);
                    if (!overlaps.includes(origJ)) overlaps.push(origJ);
                }
            }
        }

        if (overlaps.length > 0) {
            return res.status(400).json({
                error: 'Обнаружены пересечения слотов',
                overlaps,
            });
        }

        const channelId = req.session.currentChannelId || 1;
        await saveSlots(sorted, channelId);

        res.json({ success: true, message: 'Слоты сохранены', slots: getSlots(channelId) });
    } catch (err: any) {
        console.error('Error saving slots:', err);
        res.status(500).json({ error: 'Ошибка сохранения: ' + err.message });
    }
});

router.get('/main-slot', async (req: Request, res: Response) => {
    const channelId = Number(req.session.currentChannelId) || 1;
    try {
        const [rows] = await pool.execute<RowDataPacket[]>(
            "SELECT main_start_behavior, main_exclude_from_stats FROM channel_settings WHERE channel_id = ?",
            [channelId]
        );
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.json({ main_start_behavior: 4, main_exclude_from_stats: 0 });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

router.post('/main-slot', async (req: Request, res: Response) => {
    const channelId = Number(req.session.currentChannelId) || 1;
    const { main_start_behavior, main_exclude_from_stats } = req.body;

    const startBehavior = typeof main_start_behavior === 'number' ? main_start_behavior : 4;
    const exclude = main_exclude_from_stats ? 1 : 0;

    try {
        await pool.execute(
            `INSERT INTO channel_settings (channel_id, main_start_behavior, main_exclude_from_stats)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE main_start_behavior = ?, main_exclude_from_stats = ?`,
            [channelId, startBehavior, exclude, startBehavior, exclude]
        );
        res.json({ message: 'Настройки Main слота сохранены' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// POST /admin/upload-fallback — replace the fallback filler for the current channel
router.post('/upload-fallback', upload.single('fallbackFile'), async (req: Request, res: Response) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).send('Файл не выбран');
        }

        const channelId = Number(req.session.currentChannelId) || 1;

        // Validate video duration/format
        const duration = await getVideoDuration(file.path);
        if (duration < 0) {
            await fs.promises.unlink(file.path);
            return res.status(400).send('Некорректный видеофайл или формат. Не удалось определить длительность.');
        }

        const fallbackDir = path.join(path.dirname(ADS_BASE_PATH), 'fallback');
        if (!fs.existsSync(fallbackDir)) {
            fs.mkdirSync(fallbackDir, { recursive: true });
        }

        // Use channel-specific filename
        const filename = `fallback_ch${channelId}.mp4`;
        const targetPath = path.join(fallbackDir, filename);

        // Move the file (overwrite existing)
        await fs.promises.copyFile(file.path, targetPath);
        await fs.promises.unlink(file.path);

        // Update database
        await pool.execute(
            `INSERT INTO channel_settings (channel_id, fallback_path)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE fallback_path = ?`,
            [channelId, filename, filename]
        );

        res.json({ success: true, message: `Резервный филлер для канала ${channelId} успешно заменён` });
    } catch (err: any) {
        console.error('Fallback Upload Error:', err);
        res.status(500).send(`Ошибка при загрузке: ${err.message}`);
    }
});

router.get('/receivers', async (req: Request, res: Response) => {
    try {
        const [channels] = await pool.execute<RowDataPacket[]>(
            'SELECT id, name, multicast_ip, multicast_port, protocol FROM channels'
        );
        res.render('receivers', {
            username: req.session.username,
            lang: req.session.lang || 'en',
            availableChannels: channels
        });
    } catch (err) {
        console.error('Error fetching channels for receivers view:', err);
        res.render('receivers', {
            username: req.session.username,
            lang: req.session.lang || 'en',
            availableChannels: []
        });
    }
});

export default router;
