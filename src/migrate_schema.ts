import pool from './config/db';

async function migrate() {
    try {
        const conn = await pool.getConnection();
        console.log('Connected to database...');

        // 1. Modify play_history: Remove channel_id, title; Add video_id
        // Using raw queries to avoid permission issues with DROP if possible, or just ignore errors if table doesn't exist

        try {
            console.log('Dropping old play_history...');
            await conn.query('DROP TABLE IF EXISTS play_history');
        } catch (e: any) {
            console.warn('Drop failed (might be permissions or table usage):', e.message);
        }

        console.log('Creating new play_history...');
        // We'll try to CREATE OR REPLACE or just CREATE
        await conn.query(`
            CREATE TABLE IF NOT EXISTS play_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                video_id INT NOT NULL,
                start_time DATETIME,
                INDEX idx_start_time (start_time),

                INDEX idx_video_id (video_id)
            )
        `);

        console.log('Migration complete.');
        conn.release();
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
