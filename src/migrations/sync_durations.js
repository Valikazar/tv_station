require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);
const ADS_BASE_PATH = process.env.ADS_BASE_PATH || '/opt/tv_station/media/ads/';

async function getVideoDurationMs(filePath) {
    try {
        const { stdout, stderr } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
            console.error(`  [!] ffprobe returned NaN for ${filePath}. Stderr: ${stderr}`);
            return 0;
        }
        return Math.round(duration * 1000);
    } catch (e) {
        console.error(`  [!] ffprobe failed for ${filePath}: ${e.message}`);
        return 0;
    }
}

async function migrate() {
    let connection;
    try {
        console.log('Starting duration sync (ms) for existing files...');

        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        });

        const [videos] = await connection.execute("SELECT id, filename, target_slots_ids FROM ad_videos");
        console.log(`Found ${videos.length} videos to check.`);

        for (const video of videos) {
            // Find any existing file for this video
            let absolutePath = '';

            // Try archive first if it exists
            const archivePath = path.join(ADS_BASE_PATH, 'old', video.filename);
            if (fs.existsSync(archivePath)) {
                absolutePath = archivePath;
            } else {
                // Try other slots
                const dirs = fs.readdirSync(ADS_BASE_PATH).filter(f => {
                    try { return fs.statSync(path.join(ADS_BASE_PATH, f)).isDirectory(); } catch (e) { return false; }
                });
                for (const dir of dirs) {
                    const checkPath = path.join(ADS_BASE_PATH, dir, video.filename);
                    if (fs.existsSync(checkPath)) {
                        absolutePath = checkPath;
                        break;
                    }
                }
            }

            if (absolutePath) {
                const durationMs = await getVideoDurationMs(absolutePath);
                if (durationMs > 0) {
                    await connection.execute("UPDATE ad_videos SET duration = ? WHERE id = ?", [durationMs, video.id]);
                    console.log(`✅ Updated video ${video.id} (${video.filename}): ${durationMs}ms`);
                } else {
                    console.warn(`⚠️ Could not determine duration for video ${video.id} at ${absolutePath}`);
                }
            } else {
                console.warn(`❌ Could not find file for video ${video.id} (${video.filename}) in any slot. Deleting record...`);
                await connection.execute("DELETE FROM ad_videos WHERE id = ?", [video.id]);
            }
        }

        console.log('✅ Duration sync (ms) and cleanup complete.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Sync failed:', err.message);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
}

migrate();
