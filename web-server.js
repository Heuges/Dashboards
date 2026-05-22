const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = path.join(__dirname); // /home/tommy/work/Dashboards

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

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Root → main dashboard index
  if (urlPath === '/') urlPath = '/index.html';
  // Bare directory → index.html
  if (!path.extname(urlPath)) urlPath = urlPath.replace(/\/?$/, '/index.html');

  const filePath = path.join(ROOT, urlPath);

  // Safety: don't serve outside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=300'
    });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboards root  →  http://0.0.0.0:${PORT}`);
  console.log(`📊 CEM              →  http://localhost:${PORT}/cem-breakeven-tracker/`);
  console.log(`📊 Digify           →  http://localhost:${PORT}/digify-breakeven-tracker/`);
  console.log(`📊 Networks         →  http://localhost:${PORT}/networks-breakeven-tracker/`);
  console.log(`📊 Remix            →  http://localhost:${PORT}/remix-breakeven-tracker/`);
  console.log(`🧠 My Assistant     →  http://localhost:${PORT}/my-assistant/`);
});
