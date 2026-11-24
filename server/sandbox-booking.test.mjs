import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { SandboxCheckout } from './sandbox-booking.mjs';

let mockOrigin, simulation;
const directory = mkdtempSync(resolve('../sandbox-booking-tests-'));
before(async () => {
  simulation = spawn('postman', ['simulation', 'run', 'postman/simulations/warp.sim.yaml', '--port', 'auto', '--no-history', '--output', 'ndjson'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => reject(new Error('Simulation startup timed out')), 15000);
    simulation.on('error', reject);
    simulation.stdout.on('data', chunk => { pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) { try { const event = JSON.parse(line); if (event.event === 'listening') { mockOrigin = 'http://127.0.0.1:' + event.port; clearTimeout(timer); resolve(); } } catch {} } });
  });
});
after(() => { simulation?.kill('SIGINT'); rmSync(directory, { recursive: true, force: true }); });
const shipment = () => ({ origin: '120 Demo Way, Los Angeles, CA 90001', destination: '85 Sample Drive, Chicago, IL 60601', pickupDate: '2099-11-25', pickupTime: '09:00',
  addressTypes: { origin: 'commercial-dock', destination: 'commercial-dock' }, services: { origin: [], destination: [] },
  items: [{ type: 'pallet', quantity: 1, weight: 500, length: 48, width: 40, height: 48 }] });
const details = () => ({ originCompany: 'Sandbox pickup', originContact: 'Test', originPhone: '+12135550101', originEmail: 'pickup@example.com', originTimezone: 'America/Los_Angeles', pickupEnd: '17:00', destinationCompany: 'Sandbox delivery', destinationContact: 'Test', destinationPhone: '+13125550102', destinationEmail: 'delivery@example.com', destinationTimezone: 'America/Chicago', destinationDate: '2099-11-30', destinationOpensAt: '09:00', destinationClosesAt: '17:00' });
function fixture(id = 'MOCK_SUCCESS', { lostResponse = false, mode = 'ltl' } = {}) {
  let writes = 0;
  const path = resolve(directory, crypto.randomUUID() + '.sqlite');
  const checkout = new SandboxCheckout(path, 'test-server-key', { upstream: async (url, options) => {
    writes++;
    assert.ok(url.startsWith('https://stg.wearewarp.com/api/v1/freights/'));
    assert.equal(options.headers.apikey, 'test-server-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.quoteId, id);
    const market = url.endsWith('/book');
    assert.equal((market ? payload.items : payload.listItems)[0].totalWeight, 500);
    assert.equal(payload.pickupInfo.address.zipcode, '90001');
    assert.equal(payload.pickupInfo[market ? 'timeWindow' : 'windowTime'].from, '2099-11-25T17:00:00.000Z');
    const response = await fetch(mockOrigin + '/warp/api/v1/freights/' + (market ? 'book' : 'booking'), options);
    if (lostResponse) throw new Error('Response lost after upstream accepted');
    return response;
  } });
  const session = checkout.session().id;
  const ship = { ...shipment(), ...(mode === 'ftl' ? { mode: 'ftl', equipment: 'van', vehicleCount: 1 } : {}) };
  const provider = { source: 'warp-v2', quoteId: id, priceCents: 18865, expiresAt: Date.now() + 3600000, transitDays: 3, vehicle: 'LTL' };
  const option = checkout.capture(session, ship, { source: 'warp-v2', options: [provider] }).options[0];
  const body = { handle: option.bookingHandle, confirmSandbox: true, confirmedAmountCents: 18865, shipment: ship, details: details() };
  return { checkout, session, body, path, writes: () => writes, option };
}
test('Sandbox market booking uses stored quote payload, writes once, debits only independent test ledger', async () => {
  const f = fixture();
  try {
    const before = f.checkout.wallet(f.session);
    const result = await f.checkout.book(f.session, f.body);
    assert.equal(result.status, 'booked'); assert.equal(result.supplierPayment, 'reported');
    assert.equal(result.testDebitCents, 18865); assert.equal(result.wallet.balanceCents, before.balanceCents - 18865);
    const replay = await f.checkout.book(f.session, { ...f.body, details: { ...f.body.details, originContact: 'Changed after booking' } });
    assert.equal(replay.replay, true); assert.equal(f.writes(), 1); assert.equal(replay.wallet.debitedCents, 18865);
    assert.equal(replay.confirmedDetails.originContact, 'Test');
    const model = await import('../oms/model.js'); const customerBalance = model.walletSnapshot().balance;
    const quote = model.saveWarpQuote(f.body.shipment, { options: [f.option] }); model.chooseRate(quote.id, quote.rates[0].id);
    model.recordSandboxOrder(quote.id, result);
    assert.equal(model.walletSnapshot().balance, customerBalance); assert.ok(!model.billingRecords(model.currentState().orders).some(bill => bill.orderId === 'SBX-' + result.orderId));
  } finally { f.checkout.close(); }
});
test('single quote books through /booking rather than marketplace /book', async () => {
  const f = fixture('MOCK_FTL', { mode: 'ftl' });
  try { const result = await f.checkout.book(f.session, f.body); assert.equal(result.status, 'booked'); assert.equal(f.writes(), 1); } finally { f.checkout.close(); }
});
test('supplier payment hold is preserved without false debit or production payment link', async () => {
  const f = fixture('MOCK_PAYMENT_REQUIRED');
  try {
    const result = await f.checkout.book(f.session, f.body); assert.equal(result.status, 'awaiting_payment'); assert.equal(result.testDebitCents, 0); assert.equal(result.wallet.debitedCents, 0); assert.equal(result.paymentLink, undefined); await f.checkout.book(f.session, f.body); assert.equal(f.writes(), 1);
    const model = await import('../oms/model.js'); const quote = model.saveWarpQuote(f.body.shipment, { options: [f.option] }); model.chooseRate(quote.id, quote.rates[0].id);
    assert.equal(model.recordSandboxOrder(quote.id, result).status, 'awaiting_payment');
  } finally { f.checkout.close(); }
});
test('wrong session, tampered amount or freight, missing confirmation and invalid time never call supplier', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.checkout.book(f.checkout.session().id, f.body));
    for (const update of [{ confirmedAmountCents: 1 }, { confirmSandbox: false }, { shipment: { ...f.body.shipment, items: [{ ...f.body.shipment.items[0], weight: 1 }] } }, { details: { ...details(), originTimezone: '' } }, { details: { ...details(), destinationDate: '2000-01-01' } }]) await assert.rejects(f.checkout.book(f.session, { ...f.body, ...update }));
    assert.equal(f.writes(), 0); assert.equal(f.checkout.wallet(f.session).debitedCents, 0);
  } finally { f.checkout.close(); }
});
test('concurrent clicks create at most one supplier booking', async () => {
  const f = fixture();
  try { const results = await Promise.allSettled([f.checkout.book(f.session, f.body), f.checkout.book(f.session, f.body)]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.writes(), 1); assert.equal(f.checkout.wallet(f.session).debitedCents, 18865); } finally { f.checkout.close(); }
});
test('different concurrent orders reserve the shared test budget before supplier writes', async () => {
  let release, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const checkout = new SandboxCheckout(resolve(directory, crypto.randomUUID() + '.sqlite'), 'test-server-key', { upstream: async (url, options) => { writes++; await gate; return fetch(mockOrigin + '/warp/api/v1/freights/book', options); } });
  const session = checkout.session().id;
  const options = checkout.capture(session, shipment(), { options: [1, 2, 3].map(n => ({ quoteId: 'MOCK_BUDGET_' + n, priceCents: 500000, expiresAt: Date.now() + 3600000 })) }).options;
  const body = option => ({ handle: option.bookingHandle, confirmSandbox: true, confirmedAmountCents: 500000, shipment: shipment(), details: details() });
  const first = checkout.book(session, body(options[0])), second = checkout.book(session, body(options[1]));
  try {
    assert.equal(checkout.wallet(session).reservedCents, 1000000);
    await assert.rejects(checkout.book(session, body(options[2])), error => error.status === 402);
    assert.equal(writes, 2); release(); await Promise.all([first, second]); assert.equal(checkout.wallet(session).availableCents, 0);
  } finally { release(); await Promise.allSettled([first, second]); checkout.close(); }
});
test('lost response and 5xx remain unknown and are never blindly retried', async () => {
  for (const [id, lostResponse] of [['MOCK_LOST', true], ['MOCK_500', false]]) {
    const f = fixture(id, { lostResponse });
    try { await assert.rejects(f.checkout.book(f.session, f.body)); await assert.rejects(f.checkout.book(f.session, f.body), error => error.code === 'BOOKING_RESULT_UNKNOWN'); assert.equal(f.writes(), 1); assert.equal(f.checkout.wallet(f.session).debitedCents, 0); assert.equal(f.checkout.wallet(f.session).reservedCents, 18865); } finally { f.checkout.close(); }
  }
});
test('supplier card failure never records a successful order or debit', async () => {
  const f = fixture('MOCK_CARD_FAIL');
  try { await assert.rejects(f.checkout.book(f.session, f.body), error => error.status === 402); assert.equal(f.checkout.wallet(f.session).debitedCents, 0); } finally { f.checkout.close(); }
});
test('completed order and ledger survive service restart without another supplier write', async () => {
  const f = fixture(); const first = await f.checkout.book(f.session, f.body); f.checkout.close();
  const restarted = new SandboxCheckout(f.path, 'test-server-key', { upstream: () => { throw new Error('must not write again'); } });
  try { const replay = await restarted.book(f.session, f.body); assert.equal(replay.orderId, first.orderId); assert.equal(replay.replay, true); assert.equal(replay.wallet.debitedCents, 18865); } finally { restarted.close(); }
});
