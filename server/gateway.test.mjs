import test, { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { handleRequest } from './gateway.mjs';
import { toWarpRequest, normalizeWarpQuote, normalizeWarpOptions } from '../oms/warp-api.js';

let simulation, mockOrigin;
before(async () => {
  simulation = spawn('postman', ['simulation', 'run', 'postman/simulations/warp.sim.yaml', '--port', 'auto', '--no-history', '--output', 'ndjson'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { simulation.kill('SIGINT'); reject(new Error('Postman simulation did not start')); }, 15000);
    let pending = '';
    simulation.on('error', error => { clearTimeout(timer); reject(error); });
    simulation.on('exit', code => { if (!mockOrigin) { clearTimeout(timer); reject(new Error('Postman simulation exited: ' + code)); } });
    simulation.stdout.on('data', chunk => {
      pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) { try { const event = JSON.parse(line); if (event.event === 'listening') { mockOrigin = 'http://127.0.0.1:' + event.port; clearTimeout(timer); resolve(); } } catch {} }
    });
  });
});
after(() => { simulation?.kill('SIGINT'); });

const shipment = () => ({ mode: 'ltl', origin: '90001', destination: '94105', pickupDate: '2099-11-25',
  addressTypes: { origin: 'commercial-dock', destination: 'residential' }, services: { origin: [], destination: ['liftgate', 'appointment'] },
  items: [{ type: 'pallet', quantity: 2, weight: 500, length: 48, width: 40, height: 48 }] });
const request = (path = '/api/warp/quote', body = { shipment: shipment() }, origin = 'https://zefanlong.github.io') => new Request('http://127.0.0.1:8787' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
const network = fault => (url, options) => {
  assert.equal(url, 'https://stg.wearewarp.com/api/v1/freights/freight-quote');
  assert.equal(options.headers.Authorization, undefined);
  const body = JSON.parse(options.body);
  assert.equal(options.headers.apikey, 'test-server-key');
  assert.deepEqual(body.items[0], { quantity: 2, totalWeight: 1000, length: 48, width: 40, height: 48, sizeUnit: 'IN', weightUnit: 'lbs', packaging: 'Pallet', stackable: false });
  assert.deepEqual(body.deliveryInfo.serviceOptions, ['liftgate-delivery', 'delivery-appointment', 'residential-delivery']);
  return fetch(mockOrigin + '/warp/api/v1/freights/freight-quote', { ...options, headers: { ...options.headers, ...(fault ? { 'x-mock-response-code': fault } : {}) } });
};

test('V2 authenticated quote travels through real HTTP serialization and returns cents, identity, expiry, CORS', async () => {
  const response = await handleRequest(request(), { WARP_V2_SANDBOX_KEY: 'test-server-key' }, network());
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), 'https://zefanlong.github.io');
  const body = await response.json(); assert.equal(body.options.length, 2); assert.equal(body.options[0].priceCents, 18865); assert.equal(body.source, 'warp-v2'); assert.equal(body.options[0].quoteId, 'MOCK_V2_REFERENCE'); assert.equal(body.options[1].carrierName, 'XPO Logistics'); assert.ok(body.options[0].expiresAt > Date.now());
  assert.equal(body.booking_url, undefined); assert.equal(body.book_tool_call, undefined);
});
for (const fault of ['429', '502', '400', '200-invalid']) test('upstream ' + fault + ' never becomes a fabricated price', async () => {
  const response = await handleRequest(request(), { WARP_V2_SANDBOX_KEY: 'test-server-key' }, network(fault)); assert.equal(response.status, fault === '429' ? 429 : 502);
  const body = await response.json(); assert.equal(body.priceCents, undefined); assert.equal(body.quoteId, undefined);
});
test('dedicated substitution is flagged and cannot appear as shared LTL', async () => {
  const response = await handleRequest(request(), { WARP_V2_SANDBOX_KEY: 'test-server-key' }, network('substitution'));
  const body = await response.json(); assert.equal(body.options[0].substituted, true); assert.equal(body.options[0].mode, 'FTL');
});
test('booking, balances, arbitrary upstream paths and hostile origins never contact WARP', async () => {
  const unexpected = () => { throw new Error('upstream must not be contacted'); };
  for (const path of ['/api/warp/book', '/api/warp/balance', '/api/warp/live/book', '/api/warp/agents/signup']) assert.equal((await handleRequest(request(path), {}, unexpected)).status, 403);
  assert.equal((await handleRequest(request('/api/warp/quote', {}, 'https://untrusted.example'), {}, unexpected)).status, 403);
  assert.equal((await handleRequest(request('/api/warp/quote', { shipment: { ...shipment(), services: { destination: ['amazon'] } } }), {}, unexpected)).status, 400);
  assert.equal((await handleRequest(request('/api/warp/quote', { shipment: { ...shipment(), items: [] } }), {}, unexpected)).status, 400);
});
test('mixed dimensions, total line weight, unsupported equipment and limits are explicit', () => {
  const mixed = shipment(); mixed.items.push({ type: 'pallet', quantity: 1, weight: 201.1, length: 50.2, width: 40, height: 60 });
  assert.equal(toWarpRequest(mixed).body.listItems[1].length, 50.2); assert.equal(toWarpRequest(mixed).body.listItems[1].totalWeight, 201.1);
  assert.throws(() => toWarpRequest({ ...shipment(), mode: 'ftl', equipment: 'reefer', vehicleCount: 1 }));
  assert.throws(() => toWarpRequest({ ...shipment(), mode: 'ftl', equipment: 'van', vehicleCount: 2 }));
  assert.throws(() => normalizeWarpQuote({ price: { amount: 25, currency_code: 'USD' }, quote_id: 'expired', expiration_time_utc: 1 }, 'LTL'));
});
test('provider quote cannot mutate demo wallet and date edits require new quotes', async () => {
  const model = await import('../oms/model.js');
  const provider = { source: 'warp-v2', quoteId: 'TEST_REFERENCE', priceCents: 18865, expiresAt: Date.now() + 3600000, transitDays: 3, deliveryDate: '2099-11-28', vehicle: 'LTL (shared)' };
  const before = structuredClone(model.currentState());
  const quote = model.saveWarpQuote(shipment(), provider);
  assert.equal(model.bookOrder(quote.id), null);
  assert.equal(model.refreshQuote(quote.id), null);
  assert.deepEqual(model.currentState().orders, before.orders);
  assert.deepEqual(model.walletSnapshot().balance, model.walletSnapshot(before).balance);
  model.chooseRate(quote.id, quote.rates[0].id);
  assert.equal(model.quoteStatus(model.currentState().quotes[0]), 'valid');
  const changed = model.updateQuote(quote.id, { shipment: { ...shipment(), pickupDate: '2099-11-26' } });
  assert.equal(model.quoteStatus(changed), 'stale');
});


test('actual OMS LTL example without mode reaches V2; FTL stays explicit and unknown modes fail', async () => {
  const { exampleShipment } = await import('../oms/model.js');
  const ltl = exampleShipment('ltl');
  assert.equal(ltl.mode, undefined);
  const normalized = toWarpRequest(ltl);
  assert.equal(normalized.body.shipmentType, 'LTL');
  assert.equal(normalized.body.listItems[0].totalWeight, 800);
  let called = false;
  const response = await handleRequest(request('/api/warp/quote', { shipment: ltl }), { WARP_V2_SANDBOX_KEY: 'test-server-key' }, (url, options) => {
    called = true;
    assert.equal(JSON.parse(options.body).shipmentType, 'LTL');
    return fetch(mockOrigin + '/warp/api/v1/freights/freight-quote', options);
  });
  assert.equal(called, true);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'warp-v2');
  const ftl = toWarpRequest(exampleShipment('ftl'));
  assert.equal(ftl.body.shipmentType, 'FTL');
  assert.equal(ftl.body.vehicleType.code, 'DRY_VAN_53');
  assert.throws(() => toWarpRequest({ ...ltl, mode: 'custom' }));
});


test('all API carrier options share native rates; unavailable API creates no simulated prices', async () => {
  const model = await import('../oms/model.js');
  const option = { source: 'warp-v2', quoteId: 'COMBINED_REFERENCE', priceCents: 18865, expiresAt: Date.now() + 3600000, transitDays: 3, deliveryDate: '', vehicle: 'LTL', charges: [], missing: [], sourceName: 'WARP', carrierName: 'Warp Technology', carrierCode: 'WTCH' };
  const combined = model.saveWarpQuote(shipment(), { source: 'warp-v2', options: [option, { ...option, quoteId: 'XPO_REAL_OPTION', carrierCode: 'CNWY', carrierName: 'XPO Logistics', sourceName: 'WWEX', priceCents: 30000 }] });
  assert.equal(combined.rates.length, 2);
  assert.ok(combined.rates.every(rate => rate.provider));
  assert.equal(combined.rates[1].carrierName, 'XPO Logistics');
  assert.equal(combined.rates[1].logo, 'XPOL.png');
  for (const rate of combined.rates) { model.chooseRate(combined.id, rate.id); assert.equal(model.bookOrder(combined.id), null); }
  const failed = model.saveWarpQuote(shipment(), null, combined.id, {}, 'WARP unavailable');
  assert.deepEqual(failed.rates, []);
  assert.equal(failed.providerError, 'WARP unavailable');
});

test('market expiry is milliseconds, transit is seconds, invalid and duplicate options are excluded', () => {
  const row = { source: 'WWEX', id: 'VALID', carrierName: 'XPO', carrierCode: 'CNWY', shipmentType: 'LTL', rate: 123.45, currency: 'USD', expirationTs: Date.now() + 60000, transitTime: 561600, serviceCharges: [] };
  const result = normalizeWarpOptions({ options: [row, row, { ...row, id: 'EXPIRED', expirationTs: 1 }, { ...row, id: 'BAD', rate: -1 }] }, 'LTL');
  assert.equal(result.options.length, 1); assert.equal(result.rejectedOptions, 3);
  assert.equal(result.options[0].transitDays, 6.5); assert.equal(result.options[0].priceCents, 12345);
});
