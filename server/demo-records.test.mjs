import test from 'node:test';
import assert from 'node:assert/strict';
import { currentState, exampleShipment, walletSnapshot, billingRecords, orderType, caseKind, customCargoRoute, dateInZone } from '../oms/model.js';
import { demoEvidence, demoEvidenceBlob } from '../oms/demo-evidence.js?v=demo-scenarios-1';

const fixedNow = Date.parse('2026-11-25T20:00:00Z');
function legacyState() {
  return { profile: { company: '客户原资料', contact: '原联系人', email: 'original@example.com' }, addresses: [{ id: 'existing-address', label: '原地址' }],
    quotes: [{ id: 'QT-EXISTING', stage: 'details', details: { originNotes: '尚未完成的草稿' } }],
    orders: [{ id: 'HYE-EXISTING', reference: 'CLIENT-REF', date: '2026-11-20', status: 'ready', shipment: exampleShipment(), rate: { total: 50000, freight: 45000, accessorial: 5000 } }],
    tickets: [{ id: 'TK-EXISTING', kind: 'tickets', orderId: 'HYE-EXISTING', status: 'pending', subject: '客户原工单', messages: [{ by: 'customer', text: '原对话', at: fixedNow - 3600000 }] }],
    wallet: { openingBalance: 1000000, openingOn: '2026-11-01', topups: [{ id: 'TOPUP-EXISTING', token: 'existing-token', amount: 25000, date: '2026-11-02', createdAt: fixedNow - 86400000 }] } };
}

function withSavedState(action) {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try { const legacy = legacyState(); storage.set('hye-oms-client-demo-v1', JSON.stringify(legacy)); return action(legacy, storage); }
  finally { Date.now = originalNow; delete globalThis.localStorage; }
}

test('sample migration preserves existing records, unfinished drafts and wallet balance and runs only once', () => withSavedState(legacy => {
  const balance = walletSnapshot(legacy).balance;
  const state = currentState();
  assert.deepEqual(state.orders.find(o => o.id === 'HYE-EXISTING'), legacy.orders[0]);
  assert.deepEqual(state.tickets.find(t => t.id === 'TK-EXISTING'), legacy.tickets[0]);
  assert.deepEqual(state.profile, legacy.profile); assert.deepEqual(state.addresses, legacy.addresses); assert.deepEqual(state.quotes, legacy.quotes);
  assert.deepEqual(state.wallet.topups[0], legacy.wallet.topups[0]); assert.equal(walletSnapshot(state).balance, balance);
  const snapshot = JSON.stringify(state);
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(currentState()), snapshot);
  assert.equal(new Set(state.orders.map(o => o.id)).size, state.orders.length);
  assert.equal(state.wallet.topups.filter(t => t.id === 'TOPUP-DEMO-SCENARIOS-1').length, 1);
}));

test('all transport categories and all business order/case statuses have coherent linked samples', () => withSavedState(() => {
  const state = currentState(); const orders = state.orders.filter(o => o.demoScenario);
  for (const kind of ['ltl', 'ftl', 'custom']) assert.deepEqual(new Set(orders.filter(o => orderType(o) === kind).map(o => o.status)), new Set(['ready','picked','transit','delivered','cancelled']));
  for (const kind of ['tickets', 'disputes', 'claims']) for (const status of ['pending','processing','closed']) assert.ok(state.tickets.some(t => t.demoScenario && caseKind(t) === kind && t.status === status), kind + status);
  for (const order of orders.filter(o => orderType(o) === 'custom')) for (const item of order.shipment.items) {
    const route = customCargoRoute(item, order.shipment.stops); assert.ok(route?.originStopId); assert.ok(route?.destinationStopId);
  }
  for (const ticket of state.tickets.filter(t => t.demoScenario)) {
    assert.ok(state.orders.some(o => o.id === ticket.orderId));
    assert.ok(ticket.messages.length >= 2);
    assert.ok(ticket.messages.every((m, i) => ['customer','support','system'].includes(m.by) && m.at <= fixedNow && (!i || m.at >= ticket.messages[i - 1].at)));
    for (const file of ticket.messages.flatMap(m => m.files ?? [])) assert.ok(demoEvidenceBlob(file.id));
  }
  const approved = state.tickets.find(t => t.id === 'TK-DEMO-206');
  assert.equal(state.orders.find(o => o.id === approved.orderId).details.originReference, approved.orderChange.changes[0].after);
}));

test('rebill samples cover waiting, held disputes, paid disputes, early confirmation and automatic collection without pending primary bills', () => withSavedState(() => {
  const state = currentState(); const bills = billingRecords(state.orders, dateInZone(), state.tickets);
  assert.ok(bills.filter(b => !b.originalId).every(b => b.paymentStatus === 'charged'));
  const get = id => bills.find(b => b.id === id);
  assert.equal(get('RB-DEMO-207').workflowStatus, 'waiting'); assert.equal(get('RB-DEMO-207').appealDaysRemaining, 5);
  assert.equal(get('RB-DEMO-203').paymentStatus, 'held'); assert.equal(get('RB-DEMO-203').workflowStatus, 'disputing');
  assert.equal(get('RB-DEMO-206').paymentStatus, 'collected'); assert.equal(get('RB-DEMO-206').workflowStatus, 'disputing');
  assert.equal(get('RB-DEMO-204').collectionMethod, 'early'); assert.equal(get('RB-DEMO-204').workflowStatus, 'completed');
  assert.equal(get('RB-DEMO-205').collectionMethod, 'automatic'); assert.equal(get('RB-DEMO-205').workflowStatus, 'completed');
  for (const ticket of state.tickets.filter(t => t.kind === 'disputes')) assert.equal(get(ticket.billId)?.orderId, ticket.orderId);
}));

test('bundled sample evidence is a valid labelled PDF blob with consistent cross-reference offsets', async () => {
  for (const file of Object.values(demoEvidence)) {
    const blob = demoEvidenceBlob(file.id); assert.equal(blob.type, 'application/pdf');
    const text = await blob.text(); assert.ok(text.startsWith('%PDF-1.4')); assert.match(text, /DEMONSTRATION DOCUMENT/); assert.match(text, /Not a carrier-issued document/);
    const xref = Number(text.match(/startxref\n(\d+)/)[1]); assert.equal(text.slice(xref, xref + 4), 'xref');
    const entries = text.slice(xref).split('\n').slice(3, 8);
    entries.forEach((entry, i) => assert.ok(text.slice(Number(entry.slice(0, 10))).startsWith(`${i + 1} 0 obj`)));
  }
  assert.equal(demoEvidenceBlob('unknown-client-upload'), null);
});
