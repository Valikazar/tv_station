import express, { Request, Response } from 'express';
import http from 'http';

const router = express.Router();

function getDockerContainers(): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: '/containers/json?all=true',
            method: 'GET'
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Docker API returned ${res.statusCode}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.end();
    });
}

router.get('/', async (req: Request, res: Response) => {
    try {
        const containers = await getDockerContainers();

        // Filter the containers to only show ones relevant to TV station
        const healthStatus = containers
            .filter(c => c.Names.some((n: string) => n.startsWith('/tv_') && !n.includes('_base')))
            .map(c => {
                return {
                    name: c.Names[0].replace('/', ''),
                    state: c.State,
                    status: c.Status,
                    health: c.Status.includes('healthy') ? 'healthy' : (c.Status.includes('unhealthy') ? 'unhealthy' : 'unknown')
                };
            });

        res.render('health', {
            username: req.session.username,
            containers: healthStatus,
            error: null
        });
    } catch (e: any) {
        console.error("Docker health check error:", e);
        res.render('health', {
            username: req.session.username,
            containers: [],
            error: 'Не удалось получить статус контейнеров. Убедитесь, что docker.sock подключен.'
        });
    }
});

router.get('/logs/:name', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    if (!name.startsWith('tv_')) {
        return res.status(400).send('Invalid container name');
    }

    try {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/containers/${name}/logs?stdout=true&stderr=true&tail=100`,
            method: 'GET'
        };

        const reqDocker = http.request(options, (resDocker) => {
            const chunks: Buffer[] = [];
            resDocker.on('data', (chunk) => {
                chunks.push(chunk);
            });
            resDocker.on('end', () => {
                const data = Buffer.concat(chunks);
                let output = '';

                let isMultiplexed = true;
                if (data.length >= 8) {
                    const type = data.readUInt8(0);
                    if ((type !== 1 && type !== 2) || data.readUInt8(1) !== 0) {
                        isMultiplexed = false;
                    }
                } else {
                    isMultiplexed = false;
                }

                if (!isMultiplexed) {
                    output = data.toString('utf8');
                } else {
                    let offset = 0;
                    while (offset < data.length) {
                        if (offset + 8 > data.length) break;
                        const size = data.readUInt32BE(offset + 4);
                        offset += 8;
                        if (offset + size > data.length) {
                            output += data.subarray(offset).toString('utf8');
                            break;
                        }
                        output += data.subarray(offset, offset + size).toString('utf8');
                        offset += size;
                    }
                }
                res.type('text/plain').send(output);
            });
        });

        reqDocker.on('error', (e) => {
            res.status(500).send('Docker API Error: ' + e.message);
        });

        reqDocker.end();
    } catch (e: any) {
        res.status(500).send('Error fetching logs: ' + e.message);
    }
});

router.get('/logs/:name/master', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    if (!name.startsWith('tv_')) return res.status(400).send('Invalid container name');

    const match = name.match(/ch_(\d+)/);
    const channelId = match ? match[1] : '1';
    const logPath = `/dev/shm/ch${channelId}_master.log`;

    try {
        const fs = require('fs');
        if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            return res.type('text/plain').send(content.slice(-5000) || '\n');
        }

        const { exec } = require('child_process');
        exec(`docker exec ${name} tail -c 5000 ${logPath}`, (error: any, stdout: string, stderr: string) => {
            if (error && !stdout) {
                return res.send(`Ожидание данных лога Master (или файл еще не создан)...`);
            }
            res.type('text/plain').send(stdout || stderr);
        });
    } catch (e: any) {
        res.status(500).send('Error fetching tail: ' + e.message);
    }
});

router.get('/logs/:name/feeder', async (req: Request, res: Response) => {
    const name = req.params.name as string;
    if (!name.startsWith('tv_')) return res.status(400).send('Invalid container name');

    const match = name.match(/ch_(\d+)/);
    const channelId = match ? match[1] : '1';
    const logPath = `/dev/shm/ch${channelId}_feeder.log`;

    try {
        const fs = require('fs');
        if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            return res.type('text/plain').send(content.slice(-5000) || '\n');
        }

        const { exec } = require('child_process');
        exec(`docker exec ${name} tail -c 5000 ${logPath}`, (error: any, stdout: string, stderr: string) => {
            if (error && !stdout) {
                return res.send(`Ожидание данных лога Feeder (или файл еще не создан)...`);
            }
            res.type('text/plain').send(stdout || stderr);
        });
    } catch (e: any) {
        res.status(500).send('Error fetching tail: ' + e.message);
    }
});

export default router;
