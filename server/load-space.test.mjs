import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLoadSpace, loadSpaceView } from '../oms/load-space.js';
import { calculateTruckLoading, TRUCK_PRESETS } from '../oms/vendor/pallet-planner/shared/truck-loading.js';
const pallet = (quantity, dimensions = {}) => ({ quantity, length: 48, width: 40, height: 48, weight: 400, ...dimensions });
function validPlacements(plan) {
  for (const a of plan.placements) {
    assert.ok(a.x >= 0 && a.y >= 0);
    assert.ok(a.x + a.footprintLength <= plan.vehicle.length + 1e-6);
    assert.ok(a.y + a.footprintWidth < plan.vehicle.width);
    assert.ok(a.loadedHeight <= plan.vehicle.height);
    for (const b of plan.placements) if (a !== b) {
      assert.ok(a.x + a.footprintLength <= b.x + 1e-6 || b.x + b.footprintLength <= a.x + 1e-6 || a.y + a.footprintWidth <= b.y + 1e-6 || b.y + b.footprintWidth <= a.y + 1e-6, 'pallet footprints must not overlap');
    }
  }
  assert.ok(plan.loadedWeight <= plan.vehicle.payload);
}

test('OMS calls the upstream Pallet Planner and renders its exact verified placements', () => {
  const plan = calculateLoadSpace([pallet(2)]);
  const upstream = calculateTruckLoading(plan.groups, TRUCK_PRESETS['dry-van'], { allowMixedStacking: false, preferSimpleLayout: true });
  assert.deepEqual(plan.placements, upstream.placements);
  assert.equal(plan.linearFeet, upstream.linearFeet);
  assert.equal(plan.linearFeet, 40 / 12);
  assert.equal(plan.remainingFeet, 596 / 12);
  assert.equal(plan.vehicle.width, 100);
  assert.equal(plan.loaded, 2);
  validPlacements(plan);
  assert.match(loadSpaceView(plan), /已装 2 件/);
});

test('different freight groups may share a row instead of adding separate row estimates', () => {
  const plan = calculateLoadSpace([pallet(1), pallet(1, { length: 60 })]);
  assert.equal(plan.loaded, 2);
  assert.equal(plan.linearFeet, 5);
  validPlacements(plan);
});

test('partial loads report excluded pieces for width, height, floor space and payload limits', () => {
  for (const item of [pallet(1, { length: 101, width: 101 }), pallet(1, { height: 111 }), pallet(1, { weight: 44000 }), pallet(40)]) {
    const plan = calculateLoadSpace([item]);
    assert.ok(plan.unplaced > 0);
    assert.equal(plan.loaded + plan.unplaced, item.quantity);
    assert.match(loadSpaceView(plan), /件未装入/);
    validPlacements(plan);
  }
});

test('box truck uses the source preset and strict width guard, while unsupported vehicles stay explicit', () => {
  const plan = calculateLoadSpace([pallet(2)], { mode: 'ftl', equipment: 'box' });
  assert.equal(plan.vehicle.length, 312);
  assert.equal(plan.vehicle.width, 96);
  assert.equal(plan.linearFeet, 4);
  validPlacements(plan);
  assert.equal(calculateLoadSpace([pallet(1)], { mode: 'ftl', equipment: 'sprinter' }).status, 'unsupported');
});

test('missing dimensions and upstream plan-size limits never produce fabricated loading geometry', () => {
  for (const items of [[], [{ quantity: 1, width: 40 }], [pallet(1.5)], [pallet(1, { length: Infinity })]]) assert.equal(calculateLoadSpace(items).status, 'incomplete');
  const plan = calculateLoadSpace([pallet(1000)]);
  assert.equal(plan.status, 'limit');
  assert.doesNotMatch(loadSpaceView(plan), /<svg|NaN|Infinity/);
});
