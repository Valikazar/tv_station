import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve(__dirname, '../../logs/actions.log');
const LOG_DIR = path.dirname(LOG_FILE);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function logAction(username: string, action: string, details?: string) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const logLine = `[${timestamp}] [${username}] ${action}${details ? ` | ${details}` : ''}\n`;

    fs.appendFile(LOG_FILE, logLine, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });

    // Also log to console
    console.log(`ACTION: ${logLine.trim()}`);
}
