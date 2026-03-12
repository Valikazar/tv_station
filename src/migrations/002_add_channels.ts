import pool from '../config/db';

async function execute() {
    const conn = await pool.getConnection();
    try {
        console.log('Creating channels table...');
        await conn.query(`
            CREATE TABLE IF NOT EXISTS channels (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                multicast_ip VARCHAR(50) NOT NULL,
                multicast_port INT NOT NULL,
                status ENUM('active', 'stopped', 'error') DEFAULT 'stopped'
            )
        `);

        console.log('Inserting default channel 1...');
        await conn.query(`
            INSERT IGNORE INTO channels (id, name, multicast_ip, multicast_port, status)
            VALUES (1, 'Основной канал', '226.0.0.21', 5004, 'active')
        `);

        const tables = ['time_slots', 'playback_log', 'ad_videos', 'play_history', 'playlists'];
        for (const table of tables) {
            console.log(`Checking table ${table} for channel_id...`);
            try {
                const [cols]: any = await conn.query(`SHOW COLUMNS FROM ?? LIKE 'channel_id'`, [table]);
                if (cols.length === 0) {
                    console.log(`Adding channel_id to ${table}...`);
                    await conn.query(`ALTER TABLE ?? ADD COLUMN channel_id INT DEFAULT 1`, [table]);
                    console.log(`Adding foreign key to ${table}...`);
                    try {
                        await conn.query(`ALTER TABLE ?? ADD CONSTRAINT ?? FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE`, [table, `fk_${table}_channel`]);
                    } catch (e: any) {
                        console.log(`Constraint ignore: ${e.message}`);
                    }
                } else {
                    console.log(`channel_id already exists in ${table}.`);
                }
            } catch (err: any) {
                console.log(`Skipping table ${table}: ${err.message}`);
            }
        }

        console.log('Migration completed successfully.');
    } catch (e) {
        console.error('Migration failed:', e);
    } finally {
        conn.release();
        process.exit();
    }
}

execute();
