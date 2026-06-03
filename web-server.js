const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const PORT = 8080;
const ROOT = path.join(__dirname);

// ─── Deploy Webhook Secret ────────────────────────────────────────────────────
// Token is checked on every POST /deploy request
const DEPLOY_SECRET = process.env.DEPLOY_SECRET || 'digify-deploy-2026';

// ─── Neon DB Connection Pool ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: 'postgresql://coo_readonly:Coo_R3adOnly_9fK2mQ7xPv4wZ@ep-rapid-brook-anwuernm-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

// ─── Company config ───────────────────────────────────────────────────────────
const COMPANIES = [
  { key: 'cem',   name: 'Channel Edge Media',  color: '#ef4444' },
  { key: 'remix', name: 'Remix Dynamix',        color: '#06b6d4' },
];

// ─── QB Status API ────────────────────────────────────────────────────────────
async function getQBStatus() {
  const client = await pool.connect();
  try {
    const invoiceRes = await client.query(`
      SELECT
        account,
        COUNT(*)::int                         AS invoice_count,
        COALESCE(SUM(total_amount), 0)::float AS total_revenue,
        MIN(week_start)                       AS earliest_week,
        MAX(week_end)                         AS latest_week,
        MAX(pushed_at)                        AS last_pushed,
        COUNT(CASE WHEN status = 'pushed' THEN 1 END)::int AS pushed_count
      FROM qbo_invoices
      GROUP BY account
      ORDER BY account
    `);
    const syncRes = await client.query(`
      SELECT DISTINCT ON (account)
        account, sync_type, records_synced, completed_at, status, error
      FROM sync_log
      WHERE status = 'completed'
      ORDER BY account, completed_at DESC
    `);
    const lastSyncRes = await client.query(`
      SELECT MAX(completed_at) AS last_sync, SUM(records_synced)::int AS total_today
      FROM sync_log
      WHERE completed_at > NOW() - INTERVAL '24 hours'
        AND status = 'completed'
    `);
    const invoiceMap = {};
    for (const row of invoiceRes.rows) invoiceMap[row.account] = row;
    const syncMap = {};
    for (const row of syncRes.rows) syncMap[row.account] = row;
    const lastSync = lastSyncRes.rows[0];
    const companies = COMPANIES.map(co => {
      const inv  = invoiceMap[co.key] || null;
      const sync = syncMap[co.key] || syncMap['all'] || null;
      return {
        key:          co.key,
        name:         co.name,
        color:        co.color,
        connected:    inv !== null,
        invoiceCount: inv ? inv.invoice_count : 0,
        totalRevenue: inv ? inv.total_revenue : 0,
        earliestWeek: inv ? inv.earliest_week : null,
        latestWeek:   inv ? inv.latest_week   : null,
        lastPushed:   inv ? inv.last_pushed   : null,
        pushedCount:  inv ? inv.pushed_count  : 0,
        lastSync:     sync ? sync.completed_at : null,
        syncRecords:  sync ? sync.records_synced : 0,
      };
    });
    return {
      pulledAt:         new Date().toISOString(),
      lastDbSync:       lastSync ? lastSync.last_sync : null,
      recordsTodaySync: lastSync ? lastSync.total_today : 0,
      companies,
    };
  } finally {
    client.release();
  }
}

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
};

// ─── HTTP Server ──────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── POST /deploy — secure webhook, no SSH needed ──────────────────────────
  if (req.method === 'POST' && urlPath === '/deploy') {
    const token = req.headers['x-deploy-token'] || '';
    if (token !== DEPLOY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      console.warn('[Deploy] ⚠️  Rejected unauthorized deploy attempt');
      return;
    }
    try {
      console.log('[Deploy] 📥 Pulling latest code from GitHub...');
      const pullOut = execSync('git pull origin main 2>&1', { cwd: ROOT, timeout: 30000 }).toString();
      console.log('[Deploy] Git pull:', pullOut.trim().split('\n').pop());
      let pm2Out = '';
      try {
        pm2Out = execSync('pm2 restart all 2>&1', { cwd: ROOT, timeout: 15000 }).toString();
        console.log('[Deploy] ✅ PM2 restarted all processes');
      } catch(e) {
        pm2Out = e.message;
        console.error('[Deploy] PM2 restart error:', e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deployedAt: new Date().toISOString(), gitPull: pullOut, pm2: pm2Out }));
    } catch(e) {
      console.error('[Deploy] ❌ Deploy error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // ── GET /api/qb-status ────────────────────────────────────────────────────
  if (urlPath === '/api/qb-status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    try {
      const data = await getQBStatus();
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('QB API error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  if (!path.extname(filePath)) filePath = filePath.replace(/\/?$/, '/index.html');
  const absPath = path.join(ROOT, filePath);

  if (!absPath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(absPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + filePath); return;
    }
    const ext = path.extname(absPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });

}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboards      →  http://localhost:${PORT}`);
  console.log(`📚 QB Status API   →  http://localhost:${PORT}/api/qb-status`);
  console.log(`🚀 Deploy Webhook  →  POST http://localhost:${PORT}/deploy`);
  console.log(`📊 CEM             →  http://localhost:${PORT}/cem-breakeven-tracker/`);
  console.log(`📊 Remix           →  http://localhost:${PORT}/remix-breakeven-tracker/`);
});
