const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// The directories you want to sync
const directoriesToSync = [
    '/Users/thomasheuges/.gemini/antigravity/scratch/antigravity-sync',
    '/Users/thomasheuges/.gemini/antigravity/scratch/Dashboards'
];

// Helper: read request body
function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
    });
}

// Helper: read a JSON data file
function readDataFile(name) {
    const filePath = path.join(DATA_DIR, name + '.json');
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return [];
    }
}

// Helper: write a JSON data file
function writeDataFile(name, data) {
    const filePath = path.join(DATA_DIR, name + '.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const server = http.createServer(async (req, res) => {
    // Add CORS headers so the dashboard can call this from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ─── DATA ENDPOINTS (To Do & Reminders) ───

    // GET /data/todos or /data/reminders
    if (req.method === 'GET' && req.url.startsWith('/data/')) {
        const name = req.url.replace('/data/', '');
        const data = readDataFile(name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // POST /data/todos or /data/reminders
    if (req.method === 'POST' && req.url.startsWith('/data/')) {
        const name = req.url.replace('/data/', '');
        const body = await readBody(req);
        try {
            const data = JSON.parse(body);
            writeDataFile(name, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'saved' }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
        }
        return;
    }

    // ─── SYNC ENDPOINT ───

    if (req.method === 'POST' && req.url === '/sync') {
        console.log(`[${new Date().toLocaleTimeString()}] Sync triggered by dashboard.`);
        
        let successCount = 0;
        let errorCount = 0;

        // If nothing to sync
        if (directoriesToSync.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'success' }));
            return;
        }

        directoriesToSync.forEach(dir => {
            // Commands: Add all changes, commit, pull (to avoid conflicts), then push.
            // Using || true for commit so it doesn't fail if there's nothing to commit.
            const cmd = `cd "${dir}" && git add . && (git commit -m "Auto-sync from My Assistant" || true) && (git pull --rebase || true) && git push`;
            
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error syncing ${dir}:`, error.message);
                    errorCount++;
                } else {
                    console.log(`Successfully synced ${dir}`);
                    successCount++;
                }

                // If all directories are processed, send response
                if (successCount + errorCount === directoriesToSync.length) {
                    if (errorCount === 0) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'success' }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'error', message: 'Some directories failed to sync' }));
                    }
                }
            });
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`🧠 Brain Server running on http://localhost:${PORT}`);
    console.log(`Ready to intercept "Good Night" and "Good Morning" signals.`);
    console.log(`Data endpoints: /data/todos, /data/reminders`);
});
