import http from 'http';
import pool from '../config/db';
import { RowDataPacket } from 'mysql2';

function makeDockerRequest(method: string, path: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const options: http.RequestOptions = {
            socketPath: '/var/run/docker.sock',
            path: `/v1.44${path}`,
            method,
            headers: payload ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(JSON.stringify(payload))
            } : {}
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(data ? JSON.parse(data) : null); } catch { resolve(data); }
                } else {
                    reject(new Error(`Docker API Error ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(JSON.stringify(payload));
        req.end();
    });
}

export async function removeContainer(name: string) {
    try {
        await makeDockerRequest('POST', `/containers/${name}/stop?t=5`);
    } catch (e) { /* ignore if not running or doesn't exist */ }

    try {
        await makeDockerRequest('DELETE', `/containers/${name}?force=true`);
    } catch (e) { /* ignore if doesn't exist */ }
}

export async function createAndStartChannelContainers(channelId: number) {
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT multicast_ip, multicast_port, interface_ip, ffmpeg_bitrate_k, protocol, timezone_offset FROM channels WHERE id = ?', [channelId]);
    if (rows.length === 0) throw new Error("Channel not found in database");

    const mcastIp = rows[0].multicast_ip;
    const mcastPort = rows[0].multicast_port;
    const interfaceIp = rows[0].interface_ip || '172.16.88.223';
    const ffmpegBitrateK = rows[0].ffmpeg_bitrate_k || 5000;
    const protocol = rows[0].protocol || 'udp';
    const timezoneOffset = rows[0].timezone_offset !== null && rows[0].timezone_offset !== undefined ? parseInt(rows[0].timezone_offset) : 3;

    // TSDuck multiplexing overhead is +15% of the FFmpeg video bitrate
    const tsduckBitrate = Math.round(ffmpegBitrateK * 1000 * 1.15);

    const tsduckUdpPort = 10000 + channelId;
    const playoutContainerName = `tv_playout_ch_${channelId}`;
    const tsduckContainerName = `tv_tsduck_ch_${channelId}`;

    // Clean up old ones just in case
    await removeContainer(playoutContainerName);
    await removeContainer(tsduckContainerName);

    // 1. Create Playout Container
    const playoutConfig = {
        Image: "tv_station-tv_playout",
        Env: [
            `CHANNEL_ID=${channelId}`,
            `DB_HOST=127.0.0.1`,
            `DB_NAME=${process.env.DB_NAME || 'tv_stats'}`,
            `DB_USER=${process.env.DB_USER || 'logger'}`,
            `DB_PASS=${process.env.DB_PASS || 'password'}`,
            `MEDIA_DIR=/media/new_ads/`,
            `FFMPEG_BITRATE_K=${ffmpegBitrateK}`,
            `OUTPUT_PROTOCOL=${protocol}`,
            `MULTICAST_IP=${mcastIp}`,
            `MULTICAST_PORT=${mcastPort}`,
            `INTERFACE_IP=${interfaceIp}`,
            `TZ=Etc/GMT${timezoneOffset > 0 ? '-' : '+'}${Math.abs(timezoneOffset)}`
        ],
        HostConfig: {
            NetworkMode: "host",
            Binds: [
                "/opt/tv_station/media:/media",
                "/dev/shm:/dev/shm",
                process.env.SCRIPTS_DIR ? `${process.env.SCRIPTS_DIR}/generate_playlist.py:/app/generate_playlist.py` : "/opt/tv_station/Scripts/generate_playlist.py:/app/generate_playlist.py",
                process.env.SCRIPTS_DIR ? `${process.env.SCRIPTS_DIR}/playout.py:/app/playout.py` : "/opt/tv_station/Scripts/playout.py:/app/playout.py"
            ],
            RestartPolicy: { Name: "always" }
        },
        HealthCheck: {
            Test: ["CMD-SHELL", "pgrep -f playout.py || exit 1"],
            Interval: 10000000000, // 10s in nanoseconds
            Timeout: 5000000000,  // 5s in nanoseconds
            Retries: 3
        }
    };

    console.log(`Starting containers for Channel ${channelId} (${protocol}://${mcastIp}:${mcastPort})`);

    await makeDockerRequest('POST', `/containers/create?name=${playoutContainerName}`, playoutConfig);
    await makeDockerRequest('POST', `/containers/${playoutContainerName}/start`);

    if (protocol !== 'rtp') {
        const tsduckConfig = {
            Image: "tv_station-tsduck_ch2", // Use the shared base image
            Cmd: [
                "-v",
                "-I", "ip", "--buffer-size", "10000000", tsduckUdpPort.toString(),
                "-P", "pcrbitrate", "--min-pcr", "4", "--min-pid", "1",
                "-P", "continuity", "--fix",
                "-P", "sdt", "--service-id", "0x0001", "--provider", `SRV:http://${interfaceIp}:3000`,
                "-O", "ip", "--local-address", interfaceIp, "--packet-burst", "7", "--enforce-burst", "--ttl", "10",
                `${mcastIp}:${mcastPort}`
            ],
            HostConfig: {
                NetworkMode: "host",
                RestartPolicy: { Name: "always" }
            },
            HealthCheck: {
                Test: ["CMD-SHELL", "pgrep tsp || exit 1"],
                Interval: 10000000000, // 10s
                Timeout: 5000000000,  // 5s
                Retries: 3
            }
        };
        await makeDockerRequest('POST', `/containers/create?name=${tsduckContainerName}`, tsduckConfig);
        await makeDockerRequest('POST', `/containers/${tsduckContainerName}/start`);
    }

    // Start beacon stream for this interface (idempotent)
    await startBeaconStream(interfaceIp);
}

export async function stopChannelContainers(channelId: number) {
    await removeContainer(`tv_playout_ch_${channelId}`);
    await removeContainer(`tv_tsduck_ch_${channelId}`);
    await removeContainer(`tv_hls_ch_${channelId}`); // also stop any HLS writer
}

/** Starts (or resumes) an on-demand HLS writer container for the given channel.
 *  State machine:
 *    paused   → unpause (fast, no container recreation)
 *    running  → already live, return immediately
 *    missing  → create fresh container and start it
 *  Reads from TSDuck multicast output (UDP) or RTP output (RTP channels).
 */
export async function startHlsWriter(channelId: number): Promise<string> {
    const containerName = `tv_hls_ch_${channelId}`;
    const hlsDir = `/dev/shm/hls`;
    const m3u8Path = `${hlsDir}/ch${channelId}.m3u8`;

    // Check existing container state
    try {
        const info = await makeDockerRequest('GET', `/containers/${containerName}/json`);
        if (info?.State?.Paused) {
            // Fast path: unpause existing container
            await makeDockerRequest('POST', `/containers/${containerName}/unpause`);
            console.log(`[HLS] Unpaused writer for channel ${channelId}`);
            return m3u8Path;
        }
        if (info?.State?.Running) {
            console.log(`[HLS] Writer already running for channel ${channelId}`);
            return m3u8Path;
        }
        // Stopped/exited — remove and recreate
        await removeContainer(containerName);
    } catch {
        // Container does not exist — create fresh
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT multicast_ip, multicast_port, interface_ip, protocol FROM channels WHERE id = ?',
        [channelId]
    );
    if (rows.length === 0) throw new Error('Channel not found');

    const { multicast_ip, multicast_port, interface_ip, protocol } = rows[0];
    const segPattern = `${hlsDir}/ch${channelId}_%03d.ts`;

    let inputUrl: string;
    if (protocol === 'rtp') {
        inputUrl = `rtp://${multicast_ip}:${multicast_port}?localaddr=${interface_ip}`;
    } else {
        inputUrl = `udp://@${multicast_ip}:${multicast_port}?localaddr=${interface_ip}&fifo_size=5000000&overrun_nonfatal=1`;
    }

    // Fresh container: clean stale segments first, then start ffmpeg
    await makeDockerRequest('POST', `/containers/create?name=${containerName}`, {
        Image: 'tv_station-tsduck_ch2',
        Entrypoint: ['sh', '-c'],
        Cmd: [
            // Purge stale segments from previous run before starting ffmpeg
            `rm -f /dev/shm/hls/ch${channelId}_*.ts /dev/shm/hls/ch${channelId}.m3u8 2>/dev/null; ` +
            `mkdir -p /dev/shm/hls && ` +
            `ffmpeg -re -i '${inputUrl}' -c copy -f hls ` +
            `-hls_time 4 -hls_list_size 5 ` +
            `-hls_flags delete_segments+append_list ` +
            `-hls_segment_type mpegts ` +
            `-hls_segment_filename '${segPattern}' '${m3u8Path}'`
        ],
        HostConfig: {
            NetworkMode: 'host',
            Binds: ['/dev/shm:/dev/shm'],
            RestartPolicy: { Name: 'no' }
        }
    });
    await makeDockerRequest('POST', `/containers/${containerName}/start`);
    console.log(`[HLS] Fresh writer started for channel ${channelId} → ${m3u8Path} (stale segments purged)`)
    return m3u8Path;
}

/** Pauses the HLS writer container (keeps it warm for fast resume). */
export async function pauseHlsWriter(channelId: number) {
    const containerName = `tv_hls_ch_${channelId}`;
    try {
        const info = await makeDockerRequest('GET', `/containers/${containerName}/json`);
        if (info?.State?.Running && !info?.State?.Paused) {
            await makeDockerRequest('POST', `/containers/${containerName}/pause`);
            console.log(`[HLS] Writer paused for channel ${channelId}`);
        }
    } catch {
        // Container gone — nothing to pause
    }
}

/** Hard-stops and removes the HLS writer (used when channel is stopped). */
export async function stopHlsWriter(channelId: number) {
    await removeContainer(`tv_hls_ch_${channelId}`);
    console.log(`[HLS] Writer removed for channel ${channelId}`);
}

export async function isHlsWriterRunning(channelId: number): Promise<{ running: boolean; paused: boolean }> {
    try {
        const data = await makeDockerRequest('GET', `/containers/tv_hls_ch_${channelId}/json`);
        return {
            running: data?.State?.Running === true && data?.State?.Paused !== true,
            paused:  data?.State?.Paused  === true
        };
    } catch {
        return { running: false, paused: false };
    }
}

/** Starts a lightweight beacon stream on udp://226.0.0.1:5004 on the given interface.
 *  Injects server URL into SDT metadata so RPi agents can auto-discover the server.
 *  Idempotent: does nothing if the beacon container is already running.
 */
export async function startBeaconStream(interfaceIp: string) {
    const safeName = interfaceIp.replace(/\./g, '_');
    const containerName = `tv_beacon_${safeName}`;

    // Always try to remove and recreate to ensure latest command/config is applied
    await removeContainer(containerName);

    const serverUrl = `SRV:http://${interfaceIp}:3000`;
    const beaconConfig = {
        Image: "tv_station-tv_playout",
        Entrypoint: ["ffmpeg"],
        Cmd: [
            "-re",
            "-f", "lavfi",
            "-i", "anullsrc=sample_rate=8000:channel_layout=mono",
            "-c:a", "aac",
            "-b:a", "16k",
            "-metadata", "service_name=TV-Beacon",
            "-metadata", `service_provider=${serverUrl}`,
            "-f", "mpegts",
            `udp://226.0.0.1:5004?pkt_size=1316&localaddr=${interfaceIp}`
        ],
        HostConfig: {
            NetworkMode: "host",
            RestartPolicy: { Name: "always" }
        },
        HealthCheck: {
            Test: ["CMD-SHELL", "pgrep ffmpeg || exit 1"],
            Interval: 10000000000, // 10s
            Timeout: 5000000000,  // 5s
            Retries: 3
        }
    };

    try {
        await makeDockerRequest('POST', `/containers/create?name=${containerName}`, beaconConfig);
        await makeDockerRequest('POST', `/containers/${containerName}/start`);
        console.log(`[Beacon] Started on ${interfaceIp} → udp://226.0.0.1:5004 with ${serverUrl}`);
    } catch (e: any) {
        console.error(`[Beacon] Failed to start on ${interfaceIp}:`, e.message);
    }
}

/** Stops the beacon on an interface if no active channels remain on it. */
export async function stopBeaconIfNoChannelsActive(interfaceIp: string) {
    try {
        const [rows] = await pool.execute<RowDataPacket[]>(
            'SELECT COUNT(*) as cnt FROM channels WHERE interface_ip = ? AND status = "active"',
            [interfaceIp]
        );
        const count = rows[0]?.cnt || 0;
        if (count === 0) {
            const safeName = interfaceIp.replace(/\./g, '_');
            await removeContainer(`tv_beacon_${safeName}`);
            console.log(`[Beacon] Stopped on ${interfaceIp} (no active channels)`);
        }
    } catch (e: any) {
        console.error('[Beacon] Error checking active channels:', e.message);
    }
}

export async function getHostNetworkInterfaces(): Promise<string[]> {
    try {
        const createRes = await makeDockerRequest('POST', '/containers/create', {
            Image: "tv_station-tsduck_ch2", // Just reusing a known image that has 'ip' tool
            Cmd: ["sh", "-c", "ip -4 -o addr show"],
            HostConfig: { NetworkMode: "host" }
        });

        if (!createRes || !createRes.Id) return ['127.0.0.1'];
        const containerId = createRes.Id;

        await makeDockerRequest('POST', `/containers/${containerId}/start`);
        await makeDockerRequest('POST', `/containers/${containerId}/wait`);

        const logs: string = await makeDockerRequest('GET', `/containers/${containerId}/logs?stdout=true`);
        await makeDockerRequest('DELETE', `/containers/${containerId}?v=true&force=true`);

        // Match IPv4 addresses from the text output
        const ips = logs.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
        if (ips) {
            // Filter out loopback, broadcast masks (255) and internal docker subnets
            return [...new Set(ips)].filter(ip =>
                ip !== '127.0.0.1' &&
                !ip.endsWith('.255') &&
                !ip.startsWith('172.17.') &&
                !ip.startsWith('172.18.') &&
                !ip.startsWith('172.19.')
            );
        }
        return ['172.16.88.223', '192.168.0.237'];
    } catch (e) {
        console.error("Failed to get host interfaces:", e);
        return ['172.16.88.223', '192.168.0.237'];
    }
}

export async function execInContainer(containerName: string, cmd: string[]) {
    try {
        const createRes = await makeDockerRequest('POST', `/containers/${containerName}/exec`, {
            AttachStdout: true,
            AttachStderr: true,
            Cmd: cmd
        });

        if (!createRes || !createRes.Id) {
            throw new Error(`Failed to create exec instance in ${containerName}`);
        }

        const startRes = await makeDockerRequest('POST', `/exec/${createRes.Id}/start`, {
            Detach: false,
            Tty: false
        });

        return startRes;
    } catch (e: any) {
        throw new Error(`Error executing command in ${containerName}: ${e.message}`);
    }
}
