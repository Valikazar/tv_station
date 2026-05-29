import pool from './src/config/db';

async function init() {
    try {
        console.log('Initializing ads table...');
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS ad_videos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                filename VARCHAR(255) NOT NULL,
                display_name VARCHAR(255) NOT NULL,
                target_slots JSON NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ ad_videos table ready');

        console.log('Initializing site_settings table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS site_settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                setting_value JSON NOT NULL
            )
        `);
        console.log('✅ site_settings table ready');

        console.log('Initializing time_slots table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS time_slots (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                start_time TIME NOT NULL,
                duration INT NOT NULL
            )
        `);
        console.log('✅ time_slots table ready');

        console.log('Running schema migrations for muting feature...');
        try {
            await pool.query(`ALTER TABLE ad_videos ADD COLUMN unmuted_slots_ids JSON DEFAULT ('[]')`);
            console.log('✅ Added unmuted_slots_ids to ad_videos');
        } catch (e: any) {
            if (e.code !== 'ER_DUP_FIELDNAME') console.error('Migration error:', e.message);
        }

        try {
            await pool.query(`ALTER TABLE generated_playlists ADD COLUMN unmuted TINYINT(1) DEFAULT 0`);
            console.log('✅ Added unmuted to generated_playlists');
        } catch (e: any) {
             if (e.code !== 'ER_DUP_FIELDNAME') console.error('Migration error:', e.message);
        }

        process.exit(0);
    } catch (err: any) {
        console.error('❌ Error initializing table:', err.message);
        if (err.code === 'ER_CANT_CREATE_TABLE') {
            console.error('TIP: This might be a database or file system permission issue.');
            console.error('The deploy script will attempt to fix this using root privileges.');
        }
        process.exit(1);
    }
}

init();
