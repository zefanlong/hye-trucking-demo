import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { handleRequest } from './gateway.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT || 8787);
const origin = `http://127.0.0.1:${port}`;
const buckets = new Map();
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const now = Date.now(), key = req.socket.remoteAddress;
      const bucket = buckets.get(key) ?? { start: now, count: 0 };
      if (now - bucket.start > 3600000) { bucket.start = now; bucket.count = 0; }
      buckets.set(key, bucket);
      if (req.method === 'POST' && ++bucket.count > 30) { res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: '本地查价达到每小时 30 次上限。' })); return; }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: req, duplex: 'half' } : {}) });
      const response = await handleRequest(request, { WARP_V2_SANDBOX_KEY: process.env.WARP_V2_SANDBOX_KEY });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
    // Serve only the public app. Environment/configuration/contracts/server files stay private.
    if ((!/^\/(oms|assets)\//.test(pathname) && pathname !== '/index.html') || pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep) || !['.html', '.js', '.css', '.png', '.svg', '.jpg', '.json', '.csv', '.tsv', '.woff2'].includes(extname(file))) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`HYE OMS: ${origin}/oms/#quote (Gateway V2 staging quotes; booking disabled)`));
