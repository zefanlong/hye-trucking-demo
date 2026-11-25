import { pack2D, BestAreaFit, BestLongSideFit, BestShortSideFit, BottomLeft } from '../vendor/binpackingjs/2d/index.js';
import { convertLength, convertWeight } from './pallet-calculator.js';

// Editable planning presets, not manufacturer-specific vehicle specifications.
export const TRUCK_PRESETS = {
  'dry-van': { length: 636, width: 100, height: 110, payload: 43000 },
  'box-truck': { length: 312, width: 96, height: 96, payload: 10000 },
};
const positive = value => Number.isFinite(value) && value > 0;
const error = message => ({ status: 'error', message });

export function palletPlanToTruckGroups(plan, tareWeight = 40) {
  if (plan?.shipment.mixedError) throw new Error(plan.shipment.mixedError);
  if (!plan || !Number.isFinite(tareWeight) || tareWeight < 0 || plan.shipment.mixedError || plan.shipment.rows.some(row => row.status !== 'ok')) {
    throw new Error('Complete all carton groups before importing.');
  }
  const { settings, inputs, shipment } = plan;
  const deck = convertLength(settings.deckHeight.value, settings.deckHeight.unit, 'in');
  if (shipment.mode === 'mixed') {
    const groups = new Map();
    for (const pallet of shipment.pallets) {
      const key = JSON.stringify([pallet.counts, pallet.loadedHeight, pallet.productWeight]);
      const existing = groups.get(key);
      if (existing) {
        existing.quantity++; existing.pieceCount += pallet.cartonCount;
        existing.cartonGroups.forEach(component => { component.quantity += pallet.counts[component.inputIndex]; });
        continue;
      }
      groups.set(key, { name: `Mixed pallet ${groups.size + 1}`, quantity: 1, pieceCount: pallet.cartonCount,
        length: convertLength(settings.footprint.length, settings.footprint.unit, 'in'),
        width: convertLength(settings.footprint.width, settings.footprint.unit, 'in'), height: pallet.loadedHeight,
        weight: pallet.productWeight === null ? null : pallet.productWeight + tareWeight,
        maxLayers: 1, maxTopLoad: null, allowRotation: true,
        cartonGroups: pallet.counts.flatMap((count, index) => count ? [{ ...structuredClone(inputs[index]), inputIndex: index, quantity: count,
          sourceId: inputs[index].sourceId || `mixed-carton-${index}`,
          carton: Object.fromEntries([...['length', 'width', 'height'].map(axis => [axis, convertLength(inputs[index].carton[axis], inputs[index].carton.unit, 'in')]), ['unit', 'in']]),
          unitWeight: inputs[index].unitWeight == null ? null : { value: convertWeight(inputs[index].unitWeight.value, inputs[index].unitWeight.unit, 'lb'), unit: 'lb' },
        }] : []),
      });
    }
    return [...groups.values()];
  }
  return shipment.rows.flatMap((result, index) => {
    const input = inputs[index];
    const cartonHeight = convertLength(input.carton.height, input.carton.unit, 'in');
    const makeGroup = (quantity, cartons, suffix) => ({
      name: `Carton group ${index + 1}${suffix}`,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      pieceCount: quantity * cartons,
      quantity,
      length: convertLength(settings.footprint.length, settings.footprint.unit, 'in'),
      width: convertLength(settings.footprint.width, settings.footprint.unit, 'in'),
      height: deck + Math.ceil(cartons / result.geometricCartonsPerLayer) * cartonHeight,
      weight: result.totalProductWeight === null ? null : result.totalProductWeight / input.quantity * cartons + tareWeight,
      maxLayers: 1, maxTopLoad: null, allowRotation: true,
    });
    const fullCount = Math.floor(input.quantity / result.cartonsPerPallet);
    const remainder = input.quantity % result.cartonsPerPallet;
    return [
      ...(fullCount ? [makeGroup(fullCount, result.cartonsPerPallet, '')] : []),
      ...(remainder ? [makeGroup(1, remainder, ' · last pallet')] : []),
    ];
  });
}

function makeMixedStacks(groups, vehicle, byWeight = false) {
  const pool = groups.flatMap((group, groupIndex) => Array.from({ length: group.quantity }, () => ({ ...group, groupIndex })));
  pool.sort((a, b) => byWeight ? (b.weight ?? 0) - (a.weight ?? 0) || b.length * b.width - a.length * a.width
    : b.length * b.width - a.length * a.width || (b.weight ?? 0) - (a.weight ?? 0));
  const stacks = [];
  while (pool.length) {
    const base = pool.shift();
    if (base.height > vehicle.height || (base.weight ?? 0) > vehicle.payload) continue;
    const members = [{ ...base, x: 0, y: 0, z: 0 }];
    let loadedHeight = base.height;
    let weight = base.weight;
    while (members.length < 10 && weight !== null) {
      const top = members.at(-1);
      let next = null;
      for (let index = 0; index < pool.length && !next; index += 1) {
        const candidate = pool[index];
        if (candidate.weight === null || candidate.maxLayers <= members.length || members.some(item => item.maxLayers <= members.length)) continue;
        if (loadedHeight + candidate.height > vehicle.height + 1e-8 || weight + candidate.weight > vehicle.payload + 1e-8) continue;
        // Every lower pallet must carry the total weight resting above it, not just its immediate neighbor.
        let aboveWeight = candidate.weight;
        let supported = true;
        for (let level = members.length - 1; level >= 0; level -= 1) {
          if (aboveWeight > members[level].maxTopLoad + 1e-8) { supported = false; break; }
          aboveWeight += members[level].weight;
        }
        if (!supported) continue;
        const orientations = [[candidate.length, candidate.width]];
        if (candidate.allowRotation !== false) orientations.push([candidate.width, candidate.length]);
        const fitting = orientations.find(([length, width]) => length <= top.length + 1e-8 && width <= top.width + 1e-8);
        if (fitting) next = { index, member: { ...candidate, length: fitting[0], width: fitting[1],
          x: top.x + (top.length - fitting[0]) / 2, y: top.y + (top.width - fitting[1]) / 2, z: loadedHeight } };
      }
      if (!next) break;
      pool.splice(next.index, 1);
      members.push(next.member);
      loadedHeight += next.member.height;
      weight += next.member.weight;
    }
    stacks.push({ width: base.length, height: base.width, groupIndex: base.groupIndex,
      constrainRotation: members.some(member => member.allowRotation === false),
      count: members.length, loadedHeight, weight, members });
  }
  return stacks;
}

function orientationCandidates(plan) {
  const ids = [...new Set(plan.filter(stack => !stack.constrainRotation && stack.width !== stack.height).map(stack => stack.groupIndex))];
  if (!ids.length) return [plan];
  const masks = [new Set(), new Set(ids)];
  // Small sets can try every group orientation. Larger sets get a bounded set
  // of one-group changes to both uniform baselines, not exponential search.
  if (ids.length <= 4) {
    for (let mask = 1; mask < 2 ** ids.length - 1; mask++) masks.push(new Set(ids.filter((_, i) => mask & (1 << i))));
  } else {
    for (const id of ids.slice(0, 8)) {
      masks.push(new Set([id]), new Set(ids.filter(other => other !== id)));
    }
  }
  return [plan, ...masks.map(mask => plan.map(stack => {
    const turn = !stack.constrainRotation && mask.has(stack.groupIndex);
    return { ...stack, width: turn ? stack.height : stack.width, height: turn ? stack.width : stack.height,
      constrainRotation: true, preRotated: turn };
  }))];
}

// Shelf packing: every row starts at the same longitudinal position, with no
// interlocking into the space behind shorter pallets in the previous row.
function packAlignedRows(boxes, length, width, payload) {
  const placements = [];
  let x = 0, y = 0, depth = 0, usedWeight = 0, row = 0;
  for (const stack of boxes) {
    if (usedWeight + (stack.weight ?? 0) > payload + 1e-8) continue;
    // Direction is chosen by the group-level candidate, not greedily changed
    // pallet-by-pallet inside a supposedly simple row.
    const options = [{ length: stack.width, width: stack.height, turn: false }];
    const fit = () => options.filter(option => y + option.width <= width && x + Math.max(depth, option.length) <= length + 1e-8)
      .sort((a, b) => Math.max(depth, a.length) - Math.max(depth, b.length) || b.width - a.width)[0];
    let chosen = fit();
    if (!chosen && depth > 0 && options.some(option => option.width <= width && x + depth + option.length <= length + 1e-8)) {
      x += depth; y = 0; depth = 0; row++; chosen = fit();
    }
    if (!chosen) continue;
    placements.push({ ...stack, x, y, row, footprintLength: chosen.length, footprintWidth: chosen.width,
      rotated: Boolean(stack.preRotated) !== chosen.turn });
    y += chosen.width; depth = Math.max(depth, chosen.length); usedWeight += stack.weight ?? 0;
  }
  return { placements, loaded: placements.reduce((sum, item) => sum + item.count, 0),
    usedLength: placements.reduce((max, item) => Math.max(max, item.x + item.footprintLength), 0), usedWeight, layoutStyle: 'rows' };
}

export function calculateTruckLoading(groups, vehicle, { allowMixedStacking = false, preferSimpleLayout = true } = {}) {
  if (!vehicle || !['length', 'width', 'height', 'payload'].every(key => positive(vehicle[key]))) {
    return error('Enter positive vehicle dimensions and payload.');
  }
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 30) return error('Enter 1–30 pallet groups.');
  let totalPallets = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (!Number.isInteger(group.quantity) || group.quantity < 1 || !['length', 'width', 'height'].every(key => positive(group[key]))) {
      return error(`Group ${i + 1}: enter a whole quantity and positive loaded dimensions.`);
    }
    if (group.weight !== null && !positive(group.weight)) return error(`Group ${i + 1}: enter a positive weight or leave it blank.`);
    if (!Number.isInteger(group.maxLayers) || group.maxLayers < 1 || group.maxLayers > 10) return error(`Group ${i + 1}: maximum stack must be 1–10 pallets.`);
    if (group.maxLayers > 1 && (!positive(group.weight) || !Number.isFinite(group.maxTopLoad) || group.maxTopLoad < 0)) {
      return error(`Group ${i + 1}: stacking requires pallet weight and allowed load above the bottom pallet (lb).`);
    }
    totalPallets += group.quantity;
    if (totalPallets > 200) return error('Calculate up to 200 pallets per plan.');
  }
  const stacks = [];
  const warnings = [];
  groups.forEach((group, groupIndex) => {
    const layers = Math.min(
      group.maxLayers,
      Math.floor((vehicle.height + 1e-8) / group.height),
      group.maxLayers > 1 ? Math.floor((group.maxTopLoad + 1e-8) / group.weight) + 1 : 1,
      group.weight === null ? Infinity : Math.floor((vehicle.payload + 1e-8) / group.weight),
    );
    if (layers < 1) { warnings.push(`Group ${groupIndex + 1} exceeds vehicle height or payload.`); return; }
    for (let remaining = group.quantity; remaining > 0; remaining -= layers) {
      const count = Math.min(layers, remaining);
      stacks.push({ width: group.length, height: group.width, constrainRotation: group.allowRotation === false,
        groupIndex, count, loadedHeight: group.height * count, palletHeight: group.height,
        weight: group.weight === null ? null : group.weight * count,
        members: Array.from({ length: count }, (_, level) => ({ ...group, groupIndex, x: 0, y: 0, z: level * group.height })) });
    }
  });
  const knownWeight = groups.every(group => group.weight !== null);
  if (!knownWeight) warnings.push('Some pallet weights are missing; vehicle payload cannot be fully checked.');
  const totalWeight = knownWeight ? groups.reduce((sum, group) => sum + group.weight * group.quantity, 0) : null;
  if (totalWeight !== null && totalWeight > vehicle.payload) warnings.push(`Requested weight ${totalWeight.toFixed(1)} lb exceeds the vehicle payload of ${vehicle.payload} lb.`);
  const heuristics = [BestShortSideFit, BestAreaFit, BestLongSideFit, BottomLeft];
  // A zero-clearance fit across the vehicle is not loadable. This tiny guard is
  // only for strict comparison/rounding, not a physical handling-gap allowance.
  const packingWidth = vehicle.width - Math.min(vehicle.width / 2, 1e-7);
  const stackPlans = allowMixedStacking ? [stacks, makeMixedStacks(groups, vehicle), makeMixedStacks(groups, vehicle, true)] : [stacks];
  const seenOrders = new Set();
  const orders = stackPlans.flatMap(orientationCandidates).flatMap(plan => [plan, [...plan].sort((a, b) => b.width * b.height - a.width * a.height),
    [...plan].sort((a, b) => b.count - a.count || (a.weight ?? 0) - (b.weight ?? 0))]).filter(plan => {
    const key = JSON.stringify(plan);
    if (seenOrders.has(key)) return false;
    seenOrders.add(key); return true;
  });
  function better(candidate, previous) {
    if (!previous) return true;
    if (candidate.loaded !== previous.loaded) return candidate.loaded > previous.loaded;
    if (preferSimpleLayout && candidate.layoutStyle !== previous.layoutStyle) return candidate.layoutStyle === 'rows';
    if (candidate.usedLength !== previous.usedLength) return candidate.usedLength < previous.usedLength;
    return candidate.placements.length < previous.placements.length;
  }
  let bestRows = null, fixedSimpleLoaded = 0;
  function attempt(length) {
    let best = null;
    for (const boxes of orders) {
      const rows = packAlignedRows(boxes, length, packingWidth, vehicle.payload);
      if (better(rows, bestRows)) bestRows = rows;
      if (better(rows, best)) best = rows;
      for (const Heuristic of heuristics) {
        const packed = pack2D({ bins: [{ width: length, height: packingWidth }], boxes, heuristic: new Heuristic() });
        let usedWeight = 0;
        const placements = [];
        for (const box of packed.packedBins[0]?.boxes ?? []) {
          const stack = box.sourceBox;
          if (usedWeight + (stack.weight ?? 0) > vehicle.payload + 1e-8) continue;
          usedWeight += stack.weight ?? 0;
          placements.push({ ...stack, x: box.x, y: box.y,
            footprintLength: box.width, footprintWidth: box.height, rotated: Boolean(stack.preRotated) !== Boolean(box.rotated) });
        }
        const loaded = placements.reduce((sum, placement) => sum + placement.count, 0);
        const usedLength = placements.reduce((max, placement) => Math.max(max, placement.x + placement.footprintLength), 0);
        const candidate = { placements, loaded, usedLength, usedWeight, layoutStyle: 'mixed' };
        if (better(candidate, best)) best = candidate;
      }
    }
    return best;
  }
  let best = attempt(vehicle.length);
  // Bounded heuristic search. Retain only verified layouts; do not claim a global optimum.
  if (best.loaded > 0) {
    // Partial loads also need compaction; a payload/space-limited load is not a reason
    // to keep an unnecessarily long layout. Retain only actual feasible candidates.
    let lower = 0;
    let upper = best.usedLength;
    for (let i = 0; i < 10 && upper - lower > 0.1; i += 1) {
      const middle = (lower + upper) / 2;
      const candidate = attempt(middle);
      if (candidate.loaded >= best.loaded) {
        if (better(candidate, best)) best = candidate;
        upper = middle;
      } else lower = middle;
    }
  }
  // Rotation broadens the feasible set, but greedy packing can still select a
  // worse arrangement. Keep the fully optimized fixed-orientation solution as
  // an explicit fallback (including its independently built mixed stacks).
  if (groups.some(group => group.allowRotation !== false)) {
    const fixed = calculateTruckLoading(groups.map(group => ({ ...group, allowRotation: false })), vehicle, { allowMixedStacking, preferSimpleLayout });
    fixedSimpleLoaded = fixed.simpleLoaded;
    if (better(fixed, best)) best = fixed;
  }
  if (best.loaded < totalPallets) warnings.push('Some pallets do not fit this plan. Try another vehicle, fewer layers, or different groups.');
  return { status: 'ok', ...best, totalPallets, unplaced: totalPallets - best.loaded,
    linearFeet: best.usedLength / 12, remainingFeet: (vehicle.length - best.usedLength) / 12,
    totalWeight,
    loadedWeight: knownWeight ? best.usedWeight : null, warnings, vehicle, groups, preferSimpleLayout,
    simpleLoaded: Math.max(bestRows?.loaded || 0, fixedSimpleLoaded) };
}
