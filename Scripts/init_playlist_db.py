import os
import mysql.connector

# Load .env manually for local testing
if os.path.exists('.env'):
    with open('.env') as f:
        for line in f:
            if line.strip() and not line.startswith('#'):
                parts = line.strip().split('=', 1)
                if len(parts) == 2:
                    key, value = parts[0].strip(), parts[1].strip()
                    if not os.environ.get(key):
                        os.environ[key] = value

def create_table():
    db_config = {
        'host': os.environ.get('DB_HOST', 'localhost'),
        'user': os.environ.get('DB_USER', 'logger'),
        'password': os.environ.get('DB_PASS', 'password'),
        'database': os.environ.get('DB_NAME', 'tv_stats')
    }
    
    try:
        conn = mysql.connector.connect(**db_config)
        cursor = conn.cursor()
        
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS generated_playlists (
                id INT AUTO_INCREMENT PRIMARY KEY,
                schedule_date DATE NOT NULL,
                start_time DATETIME NOT NULL,
                duration INT NOT NULL,
                filename VARCHAR(255) NOT NULL,
                entry_type ENUM('ad', 'main', 'filler') NOT NULL,
                video_id INT,
                slot_id INT,
                INDEX idx_date (schedule_date),
                INDEX idx_start_time (start_time)
            )
        """)
        
        conn.commit()
        print("Table 'generated_playlists' created/verified.")
        
    except mysql.connector.Error as err:
        print(f"Error: {err}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

if __name__ == "__main__":
    create_table()
