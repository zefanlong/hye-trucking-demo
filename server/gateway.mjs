import { toWarpRequest, toWarpMarketRequest, normalizeWarpQuote, normalizeWarpOptions } from '../oms/warp-api.js';

// Fixed staging host: the supplied Sandbox key is never sent to production.
const WARP = 'https://stg.wearewarp.com/api/v1';
export async function handleRequest(request, env = {}, upstream = fetch) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const allowed = new Set(['https://zefanlong.github.io', url.origin]);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' };
  if (origin && allowed.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  const reply = (status, body) => Response.json(body, { status, headers });
  if (origin && !allowed.has(origin)) return reply(403, { message: '请求来源未获允许。' });
  if (url.pathname !== '/api/warp/quote') return reply(403, { code: 'BOOKING_DISABLED', message: '此服务仅开放 Gateway V2 测试环境询价。正式下单、扣款及余额接口均未开放。' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  if (request.method !== 'POST') return reply(405, { message: '仅支持 POST。' });
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return reply(415, { message: '请求必须是 JSON。' });
  if (env.QUOTE_LIMITER && !(await env.QUOTE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) return reply(429, { code: 'RATE_LIMITED', message: '查价过于频繁，请稍后再试。' });
  // Streaming limit: do not buffer an unlimited request body.
  let text = '';
  const reader = request.body?.getReader();
  if (!reader) return reply(400, { message: '请填写询价资料。' });
  const chunks = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); return reply(413, { message: '询价资料过大。' }); } chunks.push(value); }
  text = new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => Array.from(chunk))));
  let normalized;
  try { normalized = toWarpRequest(JSON.parse(text).shipment); }
  catch (error) { return reply(400, { message: error instanceof SyntaxError ? '请求格式有误。' : error.message }); }
  const market = normalized.mode === 'LTL';
  let payload;
  try { payload = market ? toWarpMarketRequest(normalized.body) : normalized.body; }
  catch (error) { return reply(400, { message: error.message }); }
  if (!env.WARP_V2_SANDBOX_KEY) return reply(503, { code: 'GATEWAY_NOT_CONFIGURED', message: 'WARP V2 Sandbox 询价后端尚未配置密钥。' });
  try {
    const result = await upstream(`${WARP}/freights/${market ? 'freight-quote' : 'quote'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.WARP_V2_SANDBOX_KEY }, body: JSON.stringify(payload),
      redirect: 'error', signal: AbortSignal.timeout(45000)
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok) {
      const code = String(data.code ?? data.error?.code ?? '').slice(0, 80);
      const messages = { required_field_missing: 'WARP V2 要求补全询价字段。', invalid_field_data: 'WARP V2 不接受这些货物或服务条件。', request_unauthorized: 'WARP V2 Sandbox 密钥无效或已失效，请在服务端更新。' };
      return reply(result.status === 429 ? 429 : 502, { code: 'UPSTREAM_QUOTE_FAILED', message: result.status === 429 ? 'WARP 询价频率已达上限，请稍后再试。' : messages[code] || 'WARP 暂未返回这条线路的报价，请稍后重试或更换运输方式。' });
    }
    return reply(200, market ? normalizeWarpOptions(data, normalized.mode, 'staging') : { source: 'warp-v2', environment: 'staging', options: [normalizeWarpQuote(data, normalized.mode, 'staging')] });
  } catch (error) { return reply(502, { code: 'WARP_UNAVAILABLE', message: /timeout|abort/i.test(error.name) ? 'WARP 询价超时，请稍后重试。' : 'WARP 询价暂不可用，请稍后重试。' }); }
}
export default { fetch(request, env) { return handleRequest(request, env); } };
