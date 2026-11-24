import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { SandboxCheckout } from './sandbox-booking.mjs';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { handleRequest } from './gateway.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT || 8787);
const origin = `http://127.0.0.1:${port}`;
const buckets = new Map();
const enabled = process.env.WARP_SANDBOX_BOOKING_ENABLED === 'true';
await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
const checkout = enabled ? new SandboxCheckout(process.env.HYE_SANDBOX_DB || resolve(root, '.local/sandbox.sqlite'), process.env.WARP_V2_SANDBOX_KEY) : null;
async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Object.assign(new Error('订单资料过大。'), { status: 413 }); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('请求 JSON 格式有误。'), { status: 400 }); }
}
function sendJSON(res, status, body, extra = {}) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(JSON.stringify(body)); }

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const session = checkout?.session(req.headers.cookie);
      const sessionHeaders = session?.created ? { 'Set-Cookie': `hye_sandbox_session=${session.id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400` } : {};
      const now = Date.now(), key = req.socket.remoteAddress;
      const bucket = buckets.get(key) ?? { start: now, count: 0 };
      if (now - bucket.start > 3600000) { bucket.start = now; bucket.count = 0; }
      buckets.set(key, bucket);
      if (req.method === 'POST' && ++bucket.count > 30) { sendJSON(res, 429, { message: '本地测试达到每小时 30 次请求上限。' }); return; }
      if (url.pathname === '/api/warp/sandbox/session' && req.method === 'GET') {
        if (req.headers.origin && req.headers.origin !== origin) { sendJSON(res, 403, { message: '只允许本机测试页面。' }); return; }
        sendJSON(res, 200, { bookingEnabled: Boolean(checkout), environment: 'staging', ...(session ? { csrfToken: session.csrf, wallet: checkout.wallet(session.id) } : {}) }, sessionHeaders); return;
      }
      if (url.pathname === '/api/warp/sandbox/book' && req.method === 'POST') {
        if (!checkout) { sendJSON(res, 403, { message: '本机沙盒下单尚未启用。' }); return; }
        if (req.headers.origin !== origin || session.created || req.headers['x-hye-csrf'] !== session.csrf) { sendJSON(res, 403, { message: '测试会话无效，请刷新页面后重新询价。' }); return; }
        try { sendJSON(res, 200, await checkout.book(session.id, await jsonBody(req))); }
        catch (error) { sendJSON(res, error.status || 500, { code: error.code || 'SANDBOX_ERROR', message: error.status ? error.message : '测试订单结果需要核对，请勿重复提交。' }); }
        return;
      }

      const quoteInput = checkout && url.pathname === '/api/warp/quote' && req.method === 'POST' ? await jsonBody(req) : null;
      const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: quoteInput ? JSON.stringify(quoteInput) : req, duplex: 'half' } : {}) });
      const quoteShipment = quoteInput?.shipment;
      const response = await handleRequest(request, { WARP_V2_SANDBOX_KEY: process.env.WARP_V2_SANDBOX_KEY });
      if (checkout && response.ok && quoteShipment) {
        const envelope = checkout.capture(session.id, quoteShipment, await response.json());
        sendJSON(res, 200, envelope, sessionHeaders); return;
      }
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...sessionHeaders }); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
    // Serve only the public app. Environment/configuration/contracts/server files stay private.
    if ((!/^\/(oms|assets)\//.test(pathname) && pathname !== '/index.html') || pathname.split('/').some(part => part.startsWith('.'))) { res.writeHead(404).end(); return; }
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + sep) || !['.html', '.js', '.css', '.png', '.svg', '.jpg', '.json', '.csv', '.tsv', '.woff2'].includes(extname(file))) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
  } catch (error) {
    if (req.url?.startsWith('/api/')) sendJSON(res, error.status || 500, { message: error.status ? error.message : '本地测试服务暂不可用。' });
    else res.writeHead(404).end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`HYE OMS: ${origin}/oms/#quote (Gateway V2 staging; Sandbox checkout ${enabled ? 'enabled' : 'disabled'})`));
