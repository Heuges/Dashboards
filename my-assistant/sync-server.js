const http  = require('http');
const https = require('https');
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const querystring = require('querystring');

const PORT     = 8888;

// ─── Google Sheets — All Company Config ───────────────────────────────────
const SHEET_ID   = '1zW-orwWjQ4k3MFYduw4_vkpnqgAPmaD8a1UWMIwNkX4';
const SHEET_TABS = ['January','February','March','April','May'];
// Tab name = the month of the expense as it appears in Agicap.
// Exception: "May" tab = April 2026 expenses (per Tommy).
const TAB_TO_DASH_MONTH = {
    January:  '2026-01', February: '2026-02',
    March:    '2026-03', April:    '2026-04',
    May:      '2026-04',  // May tab = April 2026 expenses per Tommy
};
// Dollar-amount columns (0-indexed in CSV) — second set of company columns (rows sum)
// Col 22=Digify, 24=Remix, 26=CEM, 28=CareOne, 30=SpaceJet, 32=RealInnovations
const COMPANY_COLS = {
    digify:   22,
    remix:    24,
    cem:      26,
    careone:  28,
    spacejet: 30,
    reali:    32,
};
const ACT_COL  = 5;   // Column F = actual cost (shared)
const MUP_COL  = 7;   // Column H = markup cost (shared)
const STATIC_PORT = 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DASHBOARDS_DIR = path.join(__dirname, '..');
const WITHINGS_CONFIG_FILE = path.join(DATA_DIR, 'withings-config.json');
const WITHINGS_API_FILE    = path.join(DATA_DIR, 'withings-api.json');
const SHARE_TOKENS_FILE    = path.join(DATA_DIR, 'share-tokens.json');
const REDIRECT_URI = 'https://dashboard-assistant.digify.ai/withings/callback';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Board definitions
const BOARDS = {
    cem:      { dir: 'cem-breakeven-tracker',      name: 'CEM Breakeven Tracker' },
    digify:   { dir: 'digify-breakeven-tracker',   name: 'Digify Breakeven Tracker' },
    networks: { dir: 'networks-breakeven-tracker', name: 'Networks Breakeven Tracker' },
    remix:    { dir: 'remix-breakeven-tracker',    name: 'Remix Dynamix Breakeven Tracker' },
};

// ─── Share Token Helpers ───────────────────────────────────────────────────

function generateToken() {
    return require('crypto').randomBytes(24).toString('hex');
}
function readShareTokens() {
    try { return JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf8')); } catch(e) { return {}; }
}
function writeShareTokens(tokens) {
    fs.writeFileSync(SHARE_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
}
function ensureShareTokens() {
    const tokens = readShareTokens();
    let changed = false;
    for (const key of Object.keys(BOARDS)) {
        if (!tokens[key]) { tokens[key] = generateToken(); changed = true; }
    }
    if (changed) writeShareTokens(tokens);
    return tokens;
}

// Auto-generate missing tokens on startup
const _initTokens = ensureShareTokens();
console.log('[Share] 🔗 Share tokens ready for:', Object.keys(BOARDS).join(', '));



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
    try { puppeteer = require('puppeteer-core'); } catch(e) {
        return { success: false, error: 'puppeteer-core not installed', rawText: '' };
    }

    // Find system Chromium
    const CHROMIUM_PATHS = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/bin/google-chrome',
    ];
    const fs2 = require('fs');
    const executablePath = CHROMIUM_PATHS.find(p => fs2.existsSync(p));
    if (!executablePath) return { success: false, error: 'No system Chromium found', rawText: '' };

    console.log(`[Withings] Launching headless browser for ${url.slice(0,60)}...`);
    const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
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

            // ── Try to extract historical readings from chart tooltips / data tables ──
            // Withings live page sometimes renders a data table or aria labels with readings
            const historicalReadings = [];
            try {
                // Look for elements with weight + date pairs in aria/title/tooltip attrs
                const dataEls = document.querySelectorAll('[aria-label],[title],[data-value]');
                dataEls.forEach(el => {
                    const txt = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-value') || '').trim();
                    // Pattern: "264.2 lbs - May 10, 2026" or similar
                    const m = txt.match(/(\d{2,3}(?:\.\d{1,2})?)\s*(?:lbs?|kg)[\s\-–,]*(\w+ \d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
                    if (m) historicalReadings.push({ raw: m[0], weight: parseFloat(m[1]), date: m[2] });
                });
                // Also try table rows
                document.querySelectorAll('tr,li').forEach(row => {
                    const txt = row.innerText || '';
                    const m = txt.match(/(\d{2,3}(?:\.\d{1,2})?)\s*(?:lbs?|kg)[^\n]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},?\s*\d{4})/i);
                    if (m) historicalReadings.push({ raw: m[0], weight: parseFloat(m[1]), date: m[2] });
                });
            } catch(e) {}

            return {
                pageText: pageText.slice(0, 8000),
                weightMatches,
                historicalReadings,
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
                weights.push({ value: val, unit: 'lbs', raw: wm.raw });
            } else if (val > 35 && val < 180) {
                weights.push({ value: Math.round(val * 2.20462 * 10) / 10, unit: 'lbs', convertedFrom: 'kg', raw: wm.raw });
            }
        }

        // Process historical readings (with dates)
        const historical = [];
        for (const hr of (result.historicalReadings || [])) {
            const val = hr.weight;
            if (val > 80 && val < 400) {
                historical.push({ value: val, unit: 'lbs', dateRaw: hr.date, raw: hr.raw });
            } else if (val > 35 && val < 180) {
                historical.push({ value: Math.round(val * 2.20462 * 10) / 10, unit: 'lbs', convertedFrom: 'kg', dateRaw: hr.date, raw: hr.raw });
            }
        }

        console.log(`[Withings] Scraped — ${weights.length} latest + ${historical.length} historical readings. Title: "${result.title}"`);
        if (historical.length > 0) console.log('[Withings] Historical sample:', JSON.stringify(historical.slice(0,3)));

        return {
            success: true,
            weights,
            historical,
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
    if (result.success && (result.weights.length > 0 || result.historical.length > 0)) {
        const today = new Date().toISOString().slice(0, 10);
        let weightLog = readDataFile('weightlog');
        let added = [];

        // ── Merge latest reading (today) ──
        if (result.weights.length > 0) {
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
            if (existingIndex >= 0) { weightLog[existingIndex] = entry; }
            else { weightLog.unshift(entry); }
            added.push(entry);
            console.log(`[Withings] ✅ Saved latest weight: ${newestWeight.value} lbs`);
        }

        // ── Merge historical readings (with dates) ──
        for (const hr of result.historical) {
            // Parse the date string
            let parsedDate = null;
            try {
                const d = new Date(hr.dateRaw);
                if (!isNaN(d.getTime())) parsedDate = d.toISOString().slice(0, 10);
            } catch(e) {}
            if (!parsedDate) continue;

            // Skip if already have an entry for this date from withings
            const exists = weightLog.find(e => e.date === parsedDate && e.source === 'withings');
            if (exists) continue;

            const entry = {
                id: Date.now() + Math.random(),
                date: parsedDate,
                time: '8:00 AM',
                timestamp: new Date(parsedDate + 'T08:00:00').toISOString(),
                weight: hr.value,
                unit: 'lbs',
                source: 'withings-historical'
            };
            weightLog.push(entry);
            added.push(entry);
            console.log(`[Withings] ✅ Added historical: ${hr.value} lbs on ${parsedDate}`);
        }

        // Sort newest first
        weightLog.sort((a, b) => new Date(b.date) - new Date(a.date));
        writeDataFile('weightlog', weightLog);
        console.log(`[Withings] Total weight log entries: ${weightLog.length}`);
    }

    // Update config with last sync time
    cfg.lastSyncAt = new Date().toISOString();
    cfg.lastSyncResult = result.success ? 'ok' : 'error';
    writeWithingsConfig(cfg);

    return syncResult;
}

// ─── Withings Official API ─────────────────────────────────────────────────

function readWithingsApi() {
    try { return JSON.parse(fs.readFileSync(WITHINGS_API_FILE, 'utf8')); } catch(e) { return null; }
}
function writeWithingsApi(data) {
    fs.writeFileSync(WITHINGS_API_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Make an HTTPS POST to the Withings API
function withingsPost(path, params) {
    return new Promise((resolve, reject) => {
        const body = querystring.stringify(params);
        const options = {
            hostname: 'wbsapi.withings.net',
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Refresh the access token using the stored refresh token
async function refreshWithingsToken() {
    const api = readWithingsApi();
    if (!api || !api.refresh_token || !api.client_id || !api.client_secret) {
        throw new Error('No Withings API credentials stored');
    }
    console.log('[Withings API] 🔄 Refreshing access token...');
    const result = await withingsPost('/v2/oauth2', {
        action: 'requesttoken',
        grant_type: 'refresh_token',
        client_id: api.client_id,
        client_secret: api.client_secret,
        refresh_token: api.refresh_token
    });
    if (result.status !== 0) throw new Error(`Token refresh failed: ${JSON.stringify(result)}`);
    const tokens = result.body;
    const updated = {
        ...api,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000),
        userid: tokens.userid
    };
    writeWithingsApi(updated);
    console.log('[Withings API] ✅ Token refreshed. Expires:', new Date(updated.expires_at).toLocaleString());
    return updated;
}

// Get a valid access token (refresh if needed)
async function getValidToken() {
    let api = readWithingsApi();
    if (!api || !api.access_token) throw new Error('Not authenticated with Withings API');
    // Refresh if within 5 minutes of expiry
    if (!api.expires_at || Date.now() > api.expires_at - 300000) {
        api = await refreshWithingsToken();
    }
    return api.access_token;
}

async function pullWithingsHistory(monthsBack = 6) {
    const token = await getValidToken();
    const startdate = Math.floor((Date.now() - monthsBack * 30 * 24 * 3600 * 1000) / 1000);
    const enddate   = Math.floor(Date.now() / 1000);

    console.log(`[Withings API] 📥 Pulling all body metrics from ${new Date(startdate*1000).toLocaleDateString()}...`);

    // Pull ALL meastype at once (no meastype filter = all types)
    const result = await withingsPost('/measure', {
        action: 'getmeas',
        category: 1,
        startdate,
        enddate,
        access_token: token
    });

    if (result.status !== 0) throw new Error(`Measurements API error: ${JSON.stringify(result)}`);

    const measuregroups = result.body?.measuregrps || [];
    const readings = [];

    // Withings meastype: 1=Weight(kg), 5=FatFree(kg), 6=FatRatio(%),
    // 8=FatMass(kg), 76=Muscle(kg), 77=Water(kg), 88=Bone(kg)
    const KG_LBS = 2.20462;
    const r1 = v => Math.round(v * 10) / 10;

    for (const grp of measuregroups) {
        const date = new Date(grp.date * 1000);
        const dateStr = date.toISOString().slice(0, 10);
        const m = {};
        for (const measure of grp.measures) m[measure.type] = measure.value * Math.pow(10, measure.unit);
        if (!m[1]) continue;
        readings.push({
            date: dateStr,
            timestamp: date.toISOString(),
            source: 'withings-api',
            weight:      r1(m[1] * KG_LBS),
            weight_kg:   r1(m[1]),
            fat_pct:     m[6]  != null ? r1(m[6])           : null,
            fat_kg:      m[8]  != null ? r1(m[8])           : null,
            fat_lbs:     m[8]  != null ? r1(m[8]  * KG_LBS) : null,
            fat_free_kg: m[5]  != null ? r1(m[5])           : null,
            muscle_kg:   m[76] != null ? r1(m[76])          : null,
            muscle_lbs:  m[76] != null ? r1(m[76] * KG_LBS) : null,
            water_kg:    m[77] != null ? r1(m[77])          : null,
            water_lbs:   m[77] != null ? r1(m[77] * KG_LBS) : null,
            bone_kg:     m[88] != null ? r1(m[88])          : null,
            bone_lbs:    m[88] != null ? r1(m[88] * KG_LBS) : null,
        });
    }

    console.log(`[Withings API] ✅ Got ${readings.length} sessions with body metrics`);

    let weightLog = readDataFile('weightlog');
    let added = 0, updated = 0;
    for (const r of readings) {
        const exists = weightLog.find(e => e.date === r.date && e.source === 'withings-api');
        if (exists) { Object.assign(exists, r); updated++; continue; }
        weightLog.push({ id: Date.now() + Math.random(), time: new Date(r.timestamp).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}), unit:'lbs', ...r });
        added++;
    }
    weightLog.sort((a, b) => new Date(b.date) - new Date(a.date));
    writeDataFile('weightlog', weightLog);
    console.log(`[Withings API] Merged: ${added} new, ${updated} updated. Total: ${weightLog.length}`);

    const api = readWithingsApi();
    writeWithingsApi({ ...api, lastHistorySync: new Date().toISOString(), totalEntries: weightLog.length });
    return { added, updated, total: weightLog.length, readings: readings.length };
}



let lastScheduledSync = null;
setInterval(() => {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    if (now.getHours() === 22 && now.getMinutes() === 0 && lastScheduledSync !== dateKey) {
        lastScheduledSync = dateKey;
        console.log(`[Withings] ⏰ 10pm — running scheduled API sync...`);
        pullWithingsHistory(1).then(r => {
            writeDataFile('withings-last-sync', { success: true, syncedAt: new Date().toISOString(), added: r.added, updated: r.updated, total: r.total });
            console.log(`[Withings] ✅ Nightly sync done: ${r.added} new, ${r.updated} updated`);
        }).catch(e => {
            writeDataFile('withings-last-sync', { success: false, error: e.message, syncedAt: new Date().toISOString() });
            console.error('[Withings] Nightly sync error:', e.message);
        });
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

    // ── POST /withings/api-config (save client_id + client_secret) ─────────
    if (req.method === 'POST' && req.url === '/withings/api-config') {
        const body = await readBody(req);
        const { client_id, client_secret } = JSON.parse(body);
        if (!client_id || !client_secret) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'client_id and client_secret required' })); return;
        }
        const existing = readWithingsApi() || {};
        writeWithingsApi({ ...existing, client_id, client_secret });
        console.log('[Withings API] ✅ Client credentials saved.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'saved' }));
        return;
    }

    // ── GET /withings/api-config ───────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/withings/api-config') {
        const api = readWithingsApi();
        if (!api) { res.writeHead(200); res.end(JSON.stringify({ connected: false })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: !!(api.access_token),
            has_credentials: !!(api.client_id && api.client_secret),
            lastHistorySync: api.lastHistorySync || null,
            totalEntries: api.totalEntries || 0,
            expires_at: api.expires_at || null
        }));
        return;
    }

    // ── GET /withings/auth (start OAuth2 flow) ─────────────────────────────
    if (req.method === 'GET' && req.url === '/withings/auth') {
        const api = readWithingsApi();
        if (!api || !api.client_id) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Save client_id first via /withings/api-config' })); return;
        }
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: api.client_id,
            state: 'dash-assistant',
            scope: 'user.metrics',
            redirect_uri: REDIRECT_URI,
        });
        const authUrl = `https://account.withings.com/oauth2_user/authorize2?${params.toString()}`;
        console.log('[Withings API] 🔗 Redirecting to Withings OAuth...');
        res.writeHead(302, { 'Location': authUrl });
        res.end();
        return;
    }

    // ── GET /withings/callback (OAuth2 code exchange) ──────────────────────
    if (req.method === 'GET' && req.url.startsWith('/withings/callback')) {
        const urlParams = new URL(req.url, 'https://dashboard-assistant.digify.ai').searchParams;
        const code  = urlParams.get('code');
        const error = urlParams.get('error');
        if (error || !code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h2>Withings Auth Error: ${error || 'no code'}</h2>`);
            return;
        }
        try {
            const api = readWithingsApi();
            const result = await withingsPost('/v2/oauth2', {
                action: 'requesttoken',
                grant_type: 'authorization_code',
                client_id: api.client_id,
                client_secret: api.client_secret,
                code,
                redirect_uri: REDIRECT_URI
            });
            if (result.status !== 0) throw new Error(JSON.stringify(result));
            const tokens = result.body;
            writeWithingsApi({
                ...api,
                access_token:  tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_at:    Date.now() + (tokens.expires_in * 1000),
                userid:        tokens.userid,
                connectedAt:   new Date().toISOString()
            });
            console.log('[Withings API] ✅ OAuth complete! Pulling 6-month history...');
            // Pull history in background
            pullWithingsHistory(6).then(r => {
                console.log(`[Withings API] 🎉 History sync complete: ${r.added} new, ${r.total} total entries`);
            }).catch(e => console.error('[Withings API] History pull error:', e.message));
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;background:#0a0e1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:#1a2236;border:1px solid #1e293b;border-radius:16px;padding:40px;text-align:center;max-width:400px}h2{color:#10b981;margin-bottom:12px}p{color:#94a3b8;margin-bottom:24px}a{display:inline-block;background:#3b82f6;color:#fff;padding:10px 24px;border-radius:10px;text-decoration:none;font-weight:600}</style></head><body><div class="box"><h2>✅ Withings Connected!</h2><p>Pulling your last 6 months of weight data now. The chart will populate within a minute.</p><a href="https://dashboard-assistant.digify.ai">← Back to Dashboard</a></div></body></html>`);
        } catch(e) {
            console.error('[Withings API] Callback error:', e.message);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<h2>Error: ${e.message}</h2>`);
        }
        return;
    }

    // ── GET /withings/api-sync (trigger manual history pull) ──────────────
    if (req.method === 'GET' && req.url === '/withings/api-sync') {
        const api = readWithingsApi();
        if (!api || !api.access_token) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'Not connected to Withings API. Visit /withings/auth first.' })); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'syncing', message: 'Pulling latest data from Withings API...' }));
        pullWithingsHistory(6).then(r => {
            writeDataFile('withings-last-sync', { success: true, syncedAt: new Date().toISOString(), added: r.added, updated: r.updated, total: r.total });
            console.log(`[Withings API] ✅ Manual sync: ${r.added} new, ${r.updated} updated, ${r.total} total`);
        }).catch(e => {
            writeDataFile('withings-last-sync', { success: false, error: e.message, syncedAt: new Date().toISOString() });
            console.error('[Withings API] Manual sync error:', e.message);
        });
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

    // ── GET /data/sheets-sync/:company ────────────────────────────────────
    // Since Caddy blocks /sheets/*, we proxy sheets sync via the /data/ path.
    if (req.method === 'GET' && req.url.startsWith('/data/sheets-sync/')) {
        const co = req.url.replace('/data/sheets-sync/', '');
        console.log(`[${co.toUpperCase()} Sheets] Manual sync triggered via /data/...`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'syncing', company: co, message: `Pulling ${co} data from Google Sheet...` }));
        const syncFn = co === 'networks' ? syncAllCompanies : () => syncCompanyExpenses(co);
        syncFn().then(() => console.log(`[${co.toUpperCase()} Sheets] ✅ Sync complete`))
                .catch(e => console.error(`[${co.toUpperCase()} Sheets] Sync error:`, e.message));
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
            '/home/tommy/work/antigravity-sync',
            '/home/tommy/work/Dashboards'
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

    // ── GET /share/:board/:token ───────────────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/share/')) {
        const parts = req.url.split('/').filter(Boolean); // ['share','cem','TOKEN']
        const boardKey = parts[1];
        const token    = parts[2];
        const tokens   = readShareTokens();
        const board    = BOARDS[boardKey];

        if (!board || !token || tokens[boardKey] !== token) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;background:#0a0e1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:#1a2236;border:1px solid #1e293b;border-radius:16px;padding:40px;text-align:center}h2{color:#ef4444}</style></head><body><div class="box"><h2>🔒 Access Denied</h2><p style="color:#94a3b8">This link is invalid or has expired.</p></div></body></html>`);
            return;
        }

        // Serve the board's HTML with a view-only header injected
        const boardPath = path.join(DASHBOARDS_DIR, board.dir, 'index.html');
        try {
            let html = fs.readFileSync(boardPath, 'utf8');
            // Inject a small "shared view" banner and disable any edit controls
            const banner = `<div style="background:linear-gradient(135deg,#1e3a5f,#1a2236);border-bottom:1px solid #1e293b;padding:10px 20px;display:flex;align-items:center;justify-content:between;font-family:'Inter',sans-serif;font-size:.8rem;color:#94a3b8"><span style="flex:1">📊 <strong style="color:#f1f5f9">${board.name}</strong> &nbsp;·&nbsp; View Only</span><span style="color:#64748b">Shared by Loyal Companies</span></div>`;
            html = html.replace('<body>', '<body>' + banner);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } catch(e) {
            res.writeHead(404); res.end('Board not found');
        }
        return;
    }

    // ── GET /admin/share-tokens ────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/admin/share-tokens') {
        const tokens = readShareTokens();
        const BASE = 'https://dashboard-assistant.digify.ai';
        const result = {};
        for (const [key, board] of Object.entries(BOARDS)) {
            result[key] = {
                name: board.name,
                token: tokens[key],
                shareUrl: `${BASE}/share/${key}/${tokens[key]}`
            };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
        return;
    }

    // ── POST /admin/share-tokens/regenerate ───────────────────────────────
    if (req.method === 'POST' && req.url.startsWith('/admin/share-tokens/regenerate')) {
        const boardKey = req.url.split('/').pop();
        if (!BOARDS[boardKey]) { res.writeHead(400); res.end(JSON.stringify({ error: 'Unknown board' })); return; }
        const tokens = readShareTokens();
        tokens[boardKey] = generateToken();
        writeShareTokens(tokens);
        const newUrl = `https://dashboard-assistant.digify.ai/share/${boardKey}/${tokens[boardKey]}`;
        console.log(`[Share] 🔄 Token regenerated for ${boardKey}: ${newUrl}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ board: boardKey, shareUrl: newUrl }));
        return;
    }

    // ── GET /sheets/:company — serve cached expense data ───────────────────
    // Supports: /sheets/cem, /sheets/digify, /sheets/remix, /sheets/networks
    const sheetsReadMatch = req.method === 'GET' && req.url.match(/^\/sheets\/(cem|digify|remix|networks)$/);
    if (sheetsReadMatch) {
        const co   = sheetsReadMatch[1];
        const data = readDataFile(`${co}-expenses`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data || { error: `No data yet — call /sheets/${co}/sync first` }));
        return;
    }

    // ── GET /sheets/:company/sync — trigger fresh pull ─────────────────────
    const sheetsSyncMatch = req.method === 'GET' && req.url.match(/^\/sheets\/(cem|digify|remix|networks)\/sync$/);
    if (sheetsSyncMatch) {
        const co = sheetsSyncMatch[1];
        console.log(`[${co.toUpperCase()} Sheets] Manual sync triggered...`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'syncing', company: co, message: `Pulling ${co} data from Google Sheet...` }));
        const syncFn = co === 'networks' ? syncAllCompanies : () => syncCompanyExpenses(co);
        syncFn().then(() => console.log(`[${co.toUpperCase()} Sheets] ✅ Sync complete`))
                .catch(e => console.error(`[${co.toUpperCase()} Sheets] Sync error:`, e.message));
        return;
    }

    res.writeHead(404); res.end();

});


// ─── Google Sheets Parser ─────────────────────────────────────────────────

function fetchSheetCSV(tab) {
    return new Promise((resolve, reject) => {
        const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
        const doGet = (targetUrl, redirects) => {
            if (redirects > 5) { reject(new Error('Too many redirects')); return; }
            const mod = targetUrl.startsWith('https') ? https : http;
            mod.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    doGet(res.headers.location, redirects + 1); return;
                }
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        };
        doGet(url, 0);
    });
}

function parseCEMCurrency(v) {
    if (!v) return 0;
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

function parseCSVRow(line) {
    const cols = []; let field = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') { inQ = !inQ; }
        else if (line[i] === ',' && !inQ) { cols.push(field.trim()); field = ''; }
        else { field += line[i]; }
    }
    cols.push(field.trim());
    return cols;
}

function parseSheetTab(csvText, companyCol) {
    const rows = csvText.split('\n').map(l => parseCSVRow(l));
    const employees = [], vendors = [], platforms = [];
    let grandTotal = 0;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 3) continue;
        const nameC  = (row[2] || '').trim();
        const nameD  = (row[3] || '').trim();
        const name   = nameC || nameD;
        const actual = parseCEMCurrency(row[ACT_COL]);
        const coAmt  = parseCEMCurrency(row.length > companyCol ? row[companyCol] : '');

        if (i === 0) continue; // header row

        // Accounting row (WestLake / Lauren)
        if (i === 1 && coAmt > 0) {
            vendors.push({ name: 'WestLake Accounting Services', actual, cemAmt: coAmt, category: 'accounting' });
            continue;
        }
        // Employee rows (i=3 to i=24 = rows 4-25)
        if (i >= 3 && i <= 24 && coAmt > 0) {
            const skip = name.includes('Review') || name.includes('Employees') || !name;
            if (!skip) employees.push({ name, actual, cemAmt: coAmt });
            continue;
        }
        // Platform / vendor rows (i=26 to i=65)
        if (i >= 26 && i <= 65 && coAmt > 0) {
            platforms.push({ name: name || `Item-${i+1}`, actual, cemAmt: coAmt });
            continue;
        }
        // Grand total row (row 67 = i=66)
        if (i === 66 && coAmt > 0) { grandTotal = coAmt; continue; }
        // Fallback: look for grand total in rows 60-74
        if (i >= 60 && i < 75 && grandTotal === 0 && coAmt > 30000) { grandTotal = coAmt; }
    }

    const staffTotal    = employees.reduce((s, e) => s + e.cemAmt, 0);
    const vendorTotal   = vendors.reduce((s, v) => s + v.cemAmt, 0);
    const platformTotal = platforms.reduce((s, p) => s + p.cemAmt, 0);
    const computed      = staffTotal + vendorTotal + platformTotal;
    const resolvedTotal = (grandTotal && grandTotal >= computed * 0.7) ? grandTotal : computed;

    return { employees, vendors, platforms, staffTotal, vendorTotal, platformTotal,
             grandTotal: resolvedTotal, computedTotal: computed };
}

// Sync a single company's expenses across all tabs
async function syncCompanyExpenses(companyKey) {
    const col = COMPANY_COLS[companyKey];
    if (!col && col !== 0) throw new Error(`Unknown company: ${companyKey}`);
    const label  = companyKey.toUpperCase();
    const result = { syncedAt: new Date().toISOString(), sheetId: SHEET_ID, company: companyKey, months: {} };
    for (const tab of SHEET_TABS) {
        try {
            console.log(`[${label} Sheets] Fetching "${tab}" tab...`);
            const csv    = await fetchSheetCSV(tab);
            const parsed = parseSheetTab(csv, col);
            result.months[tab] = { tab, dashMonth: TAB_TO_DASH_MONTH[tab], ...parsed };
            console.log(`[${label} Sheets] ${tab}: Staff=$${parsed.staffTotal.toLocaleString()}, Total=$${parsed.grandTotal.toLocaleString()}`);
        } catch(e) {
            console.error(`[${label} Sheets] Error on "${tab}":`, e.message);
            result.months[tab] = { tab, dashMonth: TAB_TO_DASH_MONTH[tab], error: e.message };
        }
    }
    writeDataFile(`${companyKey}-expenses`, result);
    return result;
}

// Sync all companies at once — fetches each tab only once
async function syncAllCompanies() {
    const companies = Object.keys(COMPANY_COLS);
    const results   = {};
    for (const co of companies) results[co] = { syncedAt: new Date().toISOString(), sheetId: SHEET_ID, company: co, months: {} };
    // Also build Networks aggregate
    const netResult = { syncedAt: new Date().toISOString(), sheetId: SHEET_ID, company: 'networks', months: {} };

    for (const tab of SHEET_TABS) {
        let csv;
        try {
            console.log(`[All Sheets] Fetching "${tab}" tab...`);
            csv = await fetchSheetCSV(tab);
        } catch(e) {
            console.error(`[All Sheets] Error fetching "${tab}":`, e.message);
            for (const co of companies) results[co].months[tab] = { tab, error: e.message };
            continue;
        }

        // Parse for each company
        for (const co of companies) {
            try {
                const parsed = parseSheetTab(csv, COMPANY_COLS[co]);
                results[co].months[tab] = { tab, dashMonth: TAB_TO_DASH_MONTH[tab], ...parsed };
            } catch(e) {
                results[co].months[tab] = { tab, dashMonth: TAB_TO_DASH_MONTH[tab], error: e.message };
            }
        }

        // Networks aggregate = sum of all companies per row
        try {
            const rows = csv.split('\n').map(l => parseCSVRow(l));
            const netEmployees = [], netPlatforms = [], netVendors = [];
            for (let i = 1; i < rows.length && i < 67; i++) {
                const row = rows[i];
                if (!row || row.length < 3) continue;
                const name = (row[2] || row[3] || '').trim();
                const actual = parseCEMCurrency(row[ACT_COL]);
                const allCoAmt = companies.reduce((s, co) => s + parseCEMCurrency(row[COMPANY_COLS[co]] || ''), 0);
                if (allCoAmt === 0) continue;
                if (i === 1) { netVendors.push({ name: 'WestLake Accounting Services', actual, cemAmt: allCoAmt }); continue; }
                if (i >= 3 && i <= 24) { const skip = !name || name.includes('Review'); if (!skip) netEmployees.push({ name, actual, cemAmt: allCoAmt }); continue; }
                if (i >= 26 && i <= 65) { netPlatforms.push({ name: name || `Item-${i+1}`, actual, cemAmt: allCoAmt }); }
            }
            const staffTotal    = netEmployees.reduce((s, e) => s + e.cemAmt, 0);
            const vendorTotal   = netVendors.reduce((s, v) => s + v.cemAmt, 0);
            const platformTotal = netPlatforms.reduce((s, p) => s + p.cemAmt, 0);
            const computed      = staffTotal + vendorTotal + platformTotal;
            netResult.months[tab] = { tab, dashMonth: TAB_TO_DASH_MONTH[tab],
                employees: netEmployees, vendors: netVendors, platforms: netPlatforms,
                staffTotal, vendorTotal, platformTotal, grandTotal: computed, computedTotal: computed };
            console.log(`[Networks Agg] ${tab}: Total=$${computed.toLocaleString()}`);
        } catch(e) {
            netResult.months[tab] = { tab, error: e.message };
        }
    }

    // Save all results
    for (const co of companies) writeDataFile(`${co}-expenses`, results[co]);
    writeDataFile('networks-expenses', netResult);
    console.log('[All Sheets] ✅ Sync complete for all companies');
    return { companies: results, networks: netResult };
}

// Auto-sync all companies on startup
setTimeout(() => {
    console.log('[All Sheets] ⏰ Running startup sync for all companies...');
    syncAllCompanies().catch(e => console.error('[All Sheets] Startup sync error:', e.message));
}, 3000);

// Schedule nightly sync at 7am
setInterval(() => {
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h === 7 && m === 0) {
        console.log('[All Sheets] ⏰ 7am nightly sync for all companies...');
        syncAllCompanies().catch(e => console.error('[All Sheets] Nightly sync error:', e.message));
    }
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🧠 Brain Server running on http://localhost:${PORT}`);
    console.log(`📡 Withings endpoints: /withings/link (POST), /withings/sync (GET), /withings/config (GET)`);
    console.log(`📊 CEM Sheets endpoints: /sheets/cem (GET), /sheets/cem/sync (GET)`);
    console.log(`⏰ Withings auto-sync at 10pm | Sheets auto-sync at 7am daily`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
});
