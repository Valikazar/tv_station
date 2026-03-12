import axios from 'axios';

const ERSATZTV_URL = process.env.ERSATZTV_URL || 'http://127.0.0.1:8409';
const CHANNEL_ID = process.env.ERSATZTV_CHANNEL_ID || '1';

interface ErsatzLibrary {
    id: number;
    name: string;
}

let libraryCache: ErsatzLibrary[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 3600000; // 1 hour

let resetTimeout: NodeJS.Timeout | null = null;

// Brute-force discovery: Try to scan IDs 0-50 and see which ones respond
export async function discoverAndScanLibraries() {
    console.log('Starting ErsatzTV library discovery (ID range 0-50)...');
    const successfulIds: number[] = [];

    // Construct promises for parallel checking
    const checks = [];
    for (let i = 0; i <= 50; i++) {
        checks.push(
            axios.post(`${ERSATZTV_URL}/api/libraries/${i}/scan`, {}, { timeout: 3000 })
                .then(() => {
                    successfulIds.push(i);
                    console.log(`[Discovery] ✅ Library ID ${i} exists and scan was triggered.`);
                })
                .catch(() => {
                    // Ignore failures (404, etc.)
                })
        );
    }

    await Promise.all(checks);

    if (successfulIds.length > 0) {
        console.log(`Discovery complete. Active Library IDs: ${successfulIds.join(', ')}`);
        schedulePlayoutReset();
    } else {
        console.warn('Discovery complete. No active libraries found in range 0-50.');
    }
}

export async function getLibraryIdByName(name: string): Promise<number | null> {
    // Currently disabled due to API returning HTML
    return null;
}

export async function scanLibrary(libraryId: number) {
    try {
        await axios.post(`${ERSATZTV_URL}/api/libraries/${libraryId}/scan`);
        console.log(`Triggered scan for library ${libraryId}`);
        schedulePlayoutReset();
    } catch (err: any) {
        console.error(`Failed to scan ErsatzTV library ${libraryId}:`, err.message);
    }
}

function schedulePlayoutReset() {
    if (resetTimeout) {
        clearTimeout(resetTimeout);
    }

    // Schedule reset for 100 seconds from now
    resetTimeout = setTimeout(async () => {
        try {
            await axios.post(`${ERSATZTV_URL}/api/channels/${CHANNEL_ID}/playout/reset`);
            console.log(`ErsatzTV Playout reset triggered for channel ${CHANNEL_ID}`);
            resetTimeout = null;
        } catch (err: any) {
            console.error(`Failed to reset ErsatzTV playout:`, err.message);
        }
    }, 100000);
}

export async function getSmartCollections() {
    try {
        const response = await axios.get(`${ERSATZTV_URL}/api/collections/smart`);
        const data = response.data;
        if (Array.isArray(data)) return data;
        if (data && typeof data === 'object' && Array.isArray((data as any).items)) {
            return (data as any).items;
        }
        return [];
    } catch (err: any) {
        console.error('Failed to fetch ErsatzTV smart collections:', err.message);
        return [];
    }
}
