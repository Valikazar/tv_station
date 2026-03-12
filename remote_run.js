const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function run() {
    try {
        console.log("Killing old hung plink processes...");
        await execPromise('taskkill /F /IM plink.exe').catch(() => { });

        console.log("Copying script to server...");
        // Use pscp to push to server
        await execPromise('pscp -pw Vosemdig1896 Scripts/generate_playlist.py employee@192.168.0.237:/opt/tv_station/Scripts/generate_playlist.py');

        console.log("Executing via docker on server...");
        // Use plink to execute docker cp and docker exec on the remote server
        const { stdout, stderr } = await execPromise(`plink -batch -ssh employee@192.168.0.237 -pw Vosemdig1896 "docker cp /opt/tv_station/Scripts/generate_playlist.py tv_playout_ch_1:/app/generate_playlist.py && docker exec tv_playout_ch_1 python3 /app/generate_playlist.py"`);
        console.log(stdout);
        if (stderr) console.error(stderr);

        console.log("Done");
    } catch (e) {
        console.error(e);
    }
}
run();
