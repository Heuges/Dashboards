const http = require('http');
const { exec } = require('child_process');

const PORT = 8888;

// The directories you want to sync
const directoriesToSync = [
    '/Users/thomasheuges/.gemini/antigravity/scratch/antigravity-sync',
    '/Users/thomasheuges/.gemini/antigravity/scratch/Dashboards'
];

const server = http.createServer((req, res) => {
    // Add CORS headers so the dashboard can call this from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

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
});
