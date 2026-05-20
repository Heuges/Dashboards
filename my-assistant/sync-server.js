const http = require('http');
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PORT     = 8888;
const DATA_DIR = path.join(__dirname, 'data');
const WITHINGS_CONFIG_FILE = path.join(DATA_DIR, 'withings-config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Helpers ───────────────────────────────────────────────────────────────

function readBody(req) {
    return new Promise(resolve => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
    });
}
function readDataFile(name) {
    const filePath = path.join(DATA_DIR, name + '.json');
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) { return []; }
}
function writeDataFile(name, data) {
    fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
}
function readWithingsConfig() {
    try { return JSON.parse(fs.readFileSync(WITHINGS_CONFIG_FILE, 'utf8')); } catch(e) { return null; }
}
function writeWithingsConfig(cfg) {
    fs.writeFileSync(WITHINGS_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ─── Withings Scraper ──────────────────────────────────────────────────────

async function scrapeWithings(url) {
    let puppeteer;
    try { puppeteer = require('puppeteer'); } catch(e) {
        return { success: false, error: 'Puppeteer not installed', rawText: '' };
    }

    console.log(`[Withings] Launching headless browser for ${url.slice(0,60)}...`);
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
        // Extra wait for React rendering (increased to 12s to ensure slow page requests complete)
        await new Promise(r => setTimeout(r, 12000));

        // Take a screenshot for debug
        await page.screenshot({ path: path.join(DATA_DIR, 'withings-debug.png'), fullPage: true });

        // Extract all visible text and try to find measurements
        const result = await page.evaluate(() => {
            const pageText = document.body ? document.body.innerText : '';

            // Extract weight measurements
            const weightMatches = [];
            
            // 1. Try section-based extraction first (handles charts/tables where units are separate from values)
            const weightSectionRegex = /weight\s*\((lbs|kg)\)([\s\S]*?)(?:body\s+composition|water\s+mass|activity|average\s+visceral\s+fat|$)/i;
            const match = weightSectionRegex.exec(pageText);
            if (match) {
                const unit = match[1].toLowerCase();
                const sectionText = match[2];
                const numberRegex = /(\d{2,3}(?:\.\d{1,2})?)/g;
                let m;
                while ((m = numberRegex.exec(sectionText)) !== null) {
                    const val = parseFloat(m[1]);
                    // Filter out dates (days of month <= 31) and years (e.g. 2026)
                    if (unit === 'lbs' && val >= 80 && val <= 500) {
                        weightMatches.push({ raw: m[0], value: val });
                    } else if (unit === 'kg' && val >= 35 && val <= 250) {
                        weightMatches.push({ raw: m[0], value: val });
                    }
                }
            }
            
            // 2. Fallback to pattern-based matching (handles standard text like "264.2 lbs")
            if (weightMatches.length === 0) {
                const weightPatterns = [
                    /(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:lbs?|pounds?)/gi,
                    /(\d{2,3}(?:[.,]\d{1,2})?)\s*kg/gi,
                    /weight\s*:?\s*(\d{2,3}(?:[.,]\d{1,2})?)/gi,
                    /poids\s*:?\s*(\d{2,3}(?:[.,]\d{1,2})?)/gi,
                ];
                for (const pattern of weightPatterns) {
                    let m;
                    while ((m = pattern.exec(pageText)) !== null) {
                        weightMatches.push({ raw: m[0], value: parseFloat(m[1].replace(',', '.')) });
                    }
                }
            }

            // Date patterns  
            const datePattern = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})/g;
            const dates = [];
            let dm;
            while ((dm = datePattern.exec(pageText)) !== null) dates.push(dm[0]);

            // Try known selectors Withings RPM might use
            const trySelectors = [
                '[class*="weight"]', '[class*="Weight"]', '[data-testid*="weight"]',
                '[class*="measure"]', '[class*="value"]', 'td', 'th', 'li',
                '[class*="card"] span', '[class*="tile"] span', '[class*="metric"]'
            ];
            const selectorData = {};
            for (const sel of trySelectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0 && els.length < 50) {
                    selectorData[sel] = Array.from(els).map(e => e.innerText?.trim()).filter(Boolean).slice(0, 10);
                }
            }

            // Extract body composition metrics (Fat, Muscle, Bone)
            let fat = null;
            let muscle = null;
            let bone = null;
            
            const bodyCompRegex = /body\s+composition\s*\([\s\S]*?(?:average\s+visceral\s+fat|$)/i;
            const bodyCompMatch = bodyCompRegex.exec(pageText);
            if (bodyCompMatch) {
                const sectionText = bodyCompMatch[0];
                const lines = sectionText.split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !/[a-zA-Z]/.test(l)); // Filter out labels/dates
                const numbers = lines.map(l => parseFloat(l)).filter(n => !isNaN(n));
                
                if (numbers.length >= 3 && numbers.length % 3 === 0) {
                    const setSize = numbers.length / 3;
                    muscle = numbers[0]; // Newest muscle is first
                    fat = numbers[setSize]; // Newest fat is first
                    bone = numbers[setSize * 2]; // Newest bone is first
                }
            }
            
            // Extract water mass
            let water = null;
            const waterRegex = /water\s+mass\s*\([\s\S]*?(?:activity|$)/i;
            const waterMatch = waterRegex.exec(pageText);
            if (waterMatch) {
                const sectionText = waterMatch[0];
                const lines = sectionText.split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !/[a-zA-Z]/.test(l));
                const numbers = lines.map(l => parseFloat(l)).filter(n => !isNaN(n));
                if (numbers.length > 0) {
                    water = numbers[0]; // Newest water is first
                }
            }

            return {
                pageText: pageText.slice(0, 8000),
                weightMatches,
                dates: dates.slice(0, 10),
                selectorData,
                title: document.title,
                url: window.location.href,
                fat,
                muscle,
                bone,
                water
            };
        });

        await browser.close();

        // Process weight matches into a usable format
        const weights = [];
        for (const wm of result.weightMatches) {
            const val = wm.value;
            if (val > 80 && val < 400) {
                // Likely lbs
                weights.push({ value: val, unit: 'lbs', raw: wm.raw });
            } else if (val > 35 && val < 180) {
                // Likely kg — convert to lbs
                weights.push({ value: Math.round(val * 2.20462 * 10) / 10, unit: 'lbs', convertedFrom: 'kg', raw: wm.raw });
            }
        }

        console.log(`[Withings] Scraped — found ${weights.length} weight readings. Title: "${result.title}"`);
        console.log(`[Withings] Page text preview: ${result.pageText.slice(0, 300)}`);

        return {
            success: true,
            weights,
            dates: result.dates,
            title: result.title,
            pageTextPreview: result.pageText.slice(0, 2000),
            selectorData: result.selectorData,
            scrapedAt: new Date().toISOString(),
            fat: result.fat,
            muscle: result.muscle,
            bone: result.bone,
            water: result.water
        };

    } catch(err) {
        console.error('[Withings] Scrape error:', err.message);
        await browser.close().catch(() => {});
        return { success: false, error: err.message, rawText: '' };
    }
}

async function runWithingsSync() {
    const cfg = readWithingsConfig();
    if (!cfg || !cfg.url) {
        console.log('[Withings] No link configured — skipping sync.');
        return;
    }

    const result = await scrapeWithings(cfg.url);
    const syncResult = { ...result, syncedAt: new Date().toISOString() };

    // Save the raw result for the dashboard to inspect
    writeDataFile('withings-last-sync', syncResult);

    // If we found weight data, merge into the weight log
    if (result.success && result.weights.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        let weightLog = readDataFile('weightlog');

        // Add or update today's weight entry
        const added = [];
        if (result.weights.length > 0) {
            // The first weight in result.weights is the most recent (e.g. 264.2)
            const newestWeight = result.weights[0];
            const existingIndex = weightLog.findIndex(e => e.date === today && e.source === 'withings');
            
            const entry = {
                id: existingIndex >= 0 ? weightLog[existingIndex].id : Date.now() + Math.random(),
                date: today,
                time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
                timestamp: new Date().toISOString(),
                weight: newestWeight.value,
                unit: 'lbs',
                source: 'withings',
                fat: result.fat,
                muscle: result.muscle,
                bone: result.bone,
                water: result.water
            };
            
            if (existingIndex >= 0) {
                // Update today's entry (overwriting any previous incorrect sync)
                weightLog[existingIndex] = entry;
                console.log(`[Withings] ✅ Updated today's weight reading to ${newestWeight.value} lbs.`);
            } else {
                // Insert new entry
                weightLog.unshift(entry);
                console.log(`[Withings] ✅ Saved new weight reading of ${newestWeight.value} lbs to weightlog.`);
            }
            added.push(entry);
            writeDataFile('weightlog', weightLog);
        }
    }

    // Update config with last sync time
    cfg.lastSyncAt = new Date().toISOString();
    cfg.lastSyncResult = result.success ? 'ok' : 'error';
    writeWithingsConfig(cfg);

    return syncResult;
}

// ─── 10pm Daily Scheduler ─────────────────────────────────────────────────

let lastScheduledSync = null;
setInterval(() => {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    if (now.getHours() === 22 && now.getMinutes() === 0 && lastScheduledSync !== dateKey) {
        lastScheduledSync = dateKey;
        console.log(`[Withings] ⏰ 10pm — running scheduled sync...`);
        runWithingsSync().catch(e => console.error('[Withings] Scheduler error:', e.message));
    }
}, 60000);

// ─── Server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // ── GET /withings/config ───────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/withings/config') {
        const cfg = readWithingsConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cfg || {}));
        return;
    }

    // ── POST /withings/link ────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/withings/link') {
        const body = await readBody(req);
        const { url } = JSON.parse(body);
        if (!url || !url.includes('withings')) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid URL' })); return;
        }
        const now = new Date();
        const expires = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
        const cfg = { url, savedAt: now.toISOString(), expiresAt: expires.toISOString() };
        writeWithingsConfig(cfg);
        console.log(`[Withings] 🔗 New link saved. Expires: ${expires.toLocaleDateString()}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'saved', expiresAt: cfg.expiresAt }));
        return;
    }

    // ── GET /withings/sync (force sync) ───────────────────────────────────
    if (req.method === 'GET' && req.url === '/withings/sync') {
        const cfg = readWithingsConfig();
        if (!cfg || !cfg.url) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'No Withings link configured' })); return;
        }
        console.log('[Withings] Manual sync triggered via dashboard.');
        // Respond immediately, sync in background
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'syncing', message: 'Sync started — check back in ~15 seconds.' }));
        runWithingsSync().catch(e => console.error('[Withings] Manual sync error:', e.message));
        return;
    }

    // ── GET /withings/last-sync ────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/withings/last-sync') {
        const data = readDataFile('withings-last-sync');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // ── Generic /data/* endpoints ─────────────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/data/')) {
        const name = req.url.replace('/data/', '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readDataFile(name)));
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/data/')) {
        const name = req.url.replace('/data/', '');
        const body = await readBody(req);
        try {
            writeDataFile(name, JSON.parse(body));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'saved' }));
        } catch(e) {
            res.writeHead(400); res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
        }
        return;
    }

    // ── Git Sync ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/sync') {
        const startTime = new Date();
        console.log(`[${startTime.toLocaleTimeString()}] Sync triggered by dashboard.`);
        const directoriesToSync = [
            '/Users/thomasheuges/.gemini/antigravity-ide/scratch/antigravity-sync',
            '/Users/thomasheuges/.gemini/antigravity-ide/scratch/Dashboards'
        ];
        const results = [];
        let processed = 0;
        directoriesToSync.forEach(dir => {
            const label = dir.split('/').pop();
            const cmd = `cd "${dir}" && git add . && (git commit -m "Auto-sync from My Assistant" || true) && (git pull --rebase || true) && git push`;
            exec(cmd, (error, stdout, stderr) => {
                const completedAt = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
                if (error) {
                    results.push({ dir: label, status: 'error', completedAt, message: error.message });
                } else {
                    const alreadyUpToDate = stdout.includes('up to date') || stdout.includes('nothing to commit');
                    results.push({ dir: label, status: alreadyUpToDate ? 'up-to-date' : 'pushed', completedAt });
                }
                processed++;
                if (processed === directoriesToSync.length) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'success', completedAt: new Date().toLocaleTimeString(), dirs: results }));
                }
            });
        });
        return;
    }

    res.writeHead(404); res.end();
});

server.listen(PORT, () => {
    console.log(`🧠 Brain Server running on http://localhost:${PORT}`);
    console.log(`📡 Withings endpoints: /withings/link (POST), /withings/sync (GET), /withings/config (GET)`);
    console.log(`⏰ Withings auto-sync scheduled at 10:00 PM daily`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
});
