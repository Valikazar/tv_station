import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: process.env.DB_HOST || '192.168.0.237',
    user: process.env.DB_USER || 'logger',
    password: process.env.DB_PASS || 'password',
    database: process.env.DB_NAME || 'tv_stats',
    port: Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

export default pool;
