import 'dotenv/config';
import { getLocale } from './i18n';
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import path from 'path';
import reportRoutes from './routes/reportRoutes';
import adRoutes from './routes/adRoutes';
import watchRoutes from './routes/watchRoutes';
import adminRoutes from './routes/adminRoutes';
import healthRoutes from './routes/healthRoutes';
import channelRoutes from './routes/channelRoutes';
import receiverRoutes from './routes/receiverRoutes';
import { createAndStartChannelContainers } from './services/dockerService';
import { initializeSlots } from './utils/timeSlots';
import { startScheduler } from './services/scheduleManager';
import dgram from 'dgram';

// Extend express-session types
declare module 'express-session' {
    interface SessionData {
        isAuthenticated?: boolean;
        username?: string;
        currentChannelId?: number;
        lang?: 'en' | 'ru';
    }
}

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
}));

// Rate limiting for login attempts
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: (req: Request) => getLocale((req.session as any)?.lang).login_too_many,
    standardHeaders: true,
    legacyHeaders: false,
});

// View engine setup
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'ejs');

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Authentication middleware
const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Set language route
app.post('/set-lang', (req: Request, res: Response) => {
    const lang = req.body.lang;
    if (lang === 'en' || lang === 'ru') {
        req.session.lang = lang;
        // Also set a persistent cookie for language
        res.cookie('lang', lang, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true });
    }
    const referer = req.get('Referer') || '/';
    res.redirect(referer);
});

// Login routes (before auth middleware)
app.get('/login', (req: Request, res: Response) => {
    if (req.session.isAuthenticated) {
        return res.redirect('/');
    }
    const t = getLocale(req.session.lang);
    res.render('login', { error: null, t, lang: req.session.lang || 'en' });
});

import fs from 'fs';

interface User {
    login: string;
    passwordHash: string;
}

// Load users from JSON file
function loadUsers(): User[] {
    try {
        const usersPath = path.join(__dirname, '../users.json');
        const data = fs.readFileSync(usersPath, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error loading users.json:', err);
        return [];
    }
}

// Pass username, channel info, and i18n to all views
app.use(async (req: Request, res: Response, next: NextFunction) => {
    // Try to get language from session, then from cookie, then default to 'en'
    let lang: 'en' | 'ru' = req.session.lang as any;
    
    if (!lang) {
        const cookieStr = req.headers.cookie || '';
        const match = cookieStr.match(/lang=(en|ru)/);
        if (match) {
            lang = match[1] as any;
            req.session.lang = lang; // Sync session
        } else {
            lang = 'en';
        }
    }

    res.locals.lang = lang;
    res.locals.t = getLocale(lang);
    res.locals.username = req.session.username || '';
    if (req.session.isAuthenticated) {
        if (!req.session.currentChannelId) req.session.currentChannelId = 1;
        res.locals.currentChannelId = req.session.currentChannelId;
        try {
            const [channels] = await pool.execute<RowDataPacket[]>('SELECT id, name FROM channels');
            res.locals.channels = channels;
        } catch (e) {
            res.locals.channels = [{ id: 1, name: res.locals.t.nav_channel_main }];
        }
    }
    next();
});

app.post('/login', loginLimiter, async (req: Request, res: Response) => {
    const { login, password } = req.body;
    const users = loadUsers();
    const t = getLocale(req.session.lang);
    const lang = req.session.lang || 'en';

    if (users.length === 0) {
        return res.render('login', { error: t.login_error_config, t, lang });
    }

    // Find user by login
    const user = users.find(u => u.login === login);
    if (!user) {
        return res.render('login', { error: t.login_error_invalid, t, lang });
    }

    // Check password with bcrypt
    try {
        const passwordMatch = await bcrypt.compare(password, user.passwordHash);
        if (passwordMatch) {
            req.session.isAuthenticated = true;
            req.session.username = user.login;
            res.redirect('/');
        } else {
            res.render('login', { error: t.login_error_invalid, t, lang });
        }
    } catch (err) {
        console.error('Bcrypt error:', err);
        res.render('login', { error: t.login_error_bcrypt, t, lang });
    }
});

app.get('/logout', (req: Request, res: Response) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect('/login');
    });
});

import pool from './config/db';
import { RowDataPacket } from 'mysql2';


// Public routes
app.use('/api/receivers', receiverRoutes); // /api/receivers/report is public, others are used by admin UI

// Protected routes
app.use('/', requireAuth, reportRoutes);
app.use('/ads', requireAuth, adRoutes);
app.use('/watch', requireAuth, watchRoutes);
app.use('/admin', requireAuth, adminRoutes);
app.use('/admin/channels', requireAuth, channelRoutes);
app.use('/health', requireAuth, healthRoutes);

// Initialize slots from DB, then start server
initializeSlots().then(async () => {
    try {
        const [activeChannels] = await pool.execute<RowDataPacket[]>('SELECT id FROM channels WHERE status = "active"');
        for (const ch of activeChannels) {
            console.log(`[Auto-Start] Restoring active containers for Channel ${ch.id}...`);
            await createAndStartChannelContainers(ch.id).catch((e: any) => console.error(`Failed to restore Channel ${ch.id}:`, e));
        }
    } catch (e) {
        console.error('Failed to sync active channels with Docker:', e);
    }
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        startUdpDiscovery();
        startScheduler();
    });
}).catch((err: any) => {
    console.error('Failed to initialize, starting with defaults:', err);
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        startUdpDiscovery();
    });
});

/** UDP Discovery Service on port 5555.
 *  RPi sends 'TV-DISCOVER' as a UDP packet to the subnet broadcast address.
 *  Server replies with 'TV-SERVER:http://<serverIp>:3000'.
 *  This removes the dependency on TSDuck SDT beacon for server discovery.
 */
function startUdpDiscovery() {
    const DISCOVERY_PORT = 5555;
    const server = dgram.createSocket('udp4');

    server.on('message', (msg, rinfo) => {
        const text = msg.toString().trim();
        if (text === 'TV-DISCOVER') {
            const serverIp = process.env.ADDR || '172.16.88.223';
            const reply = Buffer.from(`TV-SERVER:http://${serverIp}:3000`);
            server.send(reply, rinfo.port, rinfo.address, (err) => {
                if (err) console.error('[Discovery] Reply error:', err);
                else console.log(`[Discovery] Replied to ${rinfo.address} with http://${serverIp}:3000`);
            });
        }
    });

    server.on('error', (err) => {
        console.error('[Discovery] UDP error:', err);
    });

    server.bind(DISCOVERY_PORT, () => {
        server.setBroadcast(true);
        console.log(`[Discovery] UDP discovery listening on port ${DISCOVERY_PORT}`);
    });
}
