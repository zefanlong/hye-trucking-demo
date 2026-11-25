import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxBooking } from './sandbox-booking.mjs';
import { toWarpMarketRequest, toWarpRequest } from '../oms/warp-api.js';
import { chooseRate, saveWarpQuote } from '../oms/model.js';

function shipment(overrides = {}) {
  return {
    origin: '120 Demo Way, Los Angeles, CA 90001',
    destination: '85 Sample Drive, Chicago, IL 60601',
    pickupDate: '2099-07-15',
    pickupTime: '09:00',
    addressTypes: { origin: 'commercial-dock', destination: 'commercial-dock' },
    services: { origin: [], destination: [] },
    items: [{ type: 'pallet', quantity: 1, weight: 500, length: 48, width: 40, height: 48 }],
    ...overrides
  };
}

const details = {
  originCompany: 'Sandbox pickup', originContact: 'Test', originPhone: '+12135550101', originEmail: 'pickup@example.com',
  destinationCompany: 'Sandbox delivery', destinationContact: 'Test', destinationPhone: '+13125550102', destinationEmail: 'delivery@example.com',
  pickupEnd: '17:00', destinationDate: '2099-07-16', destinationOpensAt: '09:00', destinationClosesAt: '17:00'
};

function marketBooking(stops, bookingDetails = details) {
  const payload = toWarpMarketRequest(toWarpRequest(stops).body);
  return buildSandboxBooking({ market: true, payload, quoteId: 'TZ_TEST' }, stops, bookingDetails);
}

test('Sandbox form shows local time inputs without timezone controls', async () => {
  globalThis.document = { addEventListener() {} };
  const { detailsView } = await import('../oms/views.js').finally(() => { delete globalThis.document; });
  const quote = saveWarpQuote(shipment(), { options: [{ quoteId: 'TZ_TEST', bookingHandle: 'test-handle', priceCents: 10000, expiresAt: Date.now() + 3600000 }] });
  const selected = chooseRate(quote.id, quote.rates[0].id);
  const view = detailsView(selected, [], 'imperial');
  assert.doesNotMatch(view, /地点时区|name="(?:origin|destination)Timezone"/);
  assert.match(view, /name="pickupTime"/);
  assert.match(view, /name="destinationDate"/);
});

test('Sandbox booking uses each ZIP locally and ignores old form timezone values', () => {
  const booking = marketBooking(shipment(), { ...details, originTimezone: 'America/New_York', destinationTimezone: 'America/Los_Angeles' });
  assert.equal(booking.pickupInfo.timeWindow.from, '2099-07-15T16:00:00.000Z');
  assert.equal(booking.deliveryInfo.timeWindow.from, '2099-07-16T14:00:00.000Z');
});

test('ZIP lookup supports Arizona and rejects an unrecognized ZIP', () => {
  const booking = marketBooking(shipment({ origin: '120 Demo Way, Phoenix, AZ 85004', pickupDate: '2099-11-25' }), { ...details, destinationDate: '2099-11-26' });
  assert.equal(booking.pickupInfo.timeWindow.from, '2099-11-25T16:00:00.000Z');
  assert.equal(booking.deliveryInfo.timeWindow.from, '2099-11-26T15:00:00.000Z');
  assert.throws(() => marketBooking(shipment({ origin: '120 Demo Way, Phoenix, AZ 00000' })), /核对提货地点的地址和 ZIP/);
});

test('A local time that occurs twice on the fall DST transition is rejected', () => {
  const stops = shipment({ pickupDate: '2099-11-01', pickupTime: '01:30' });
  assert.throws(() => marketBooking(stops, { ...details, destinationDate: '2099-11-02' }), /夏令时切换/);
});
