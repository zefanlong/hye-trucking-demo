import {
  BestAreaFit,
  BestLongSideFit,
  BestShortSideFit,
  BottomLeft,
  pack2D,
} from '../vendor/binpackingjs/2d/index.js';

export const PALLET_PRESETS = Object.freeze({
  'us-standard': Object.freeze({
    label: 'US Standard',
    footprint: Object.freeze({ length: 40, width: 48, unit: 'in' }),
  }),
  euro: Object.freeze({
    label: 'Euro Pallet',
    footprint: Object.freeze({ length: 800, width: 1200, unit: 'mm' }),
  }),
});

const LENGTHS_PER_INCH = Object.freeze({ in: 1, cm: 2.54, mm: 25.4 });
const POUNDS_PER_UNIT = Object.freeze({ lb: 1, kg: 2.2046226218487757 });
const MAX_LAYER_CANDIDATES = 500;
const MAX_SHIPMENT_CANDIDATES = 1_500;

export function convertLength(value, fromUnit, toUnit) {
  return value / LENGTHS_PER_INCH[fromUnit] * LENGTHS_PER_INCH[toUnit];
}

export function convertWeight(value, fromUnit, toUnit) {
  return value * POUNDS_PER_UNIT[fromUnit] / POUNDS_PER_UNIT[toUnit];
}

function rowError(code, message) {
  return { status: 'error', code, message };
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function normalizeLength(measurement) {
  if (!measurement || !positiveFinite(measurement.value) || !LENGTHS_PER_INCH[measurement.unit]) {
    return null;
  }
  return convertLength(measurement.value, measurement.unit, 'in');
}

function normalizeRow(input, palletSettings, candidateLimit = MAX_LAYER_CANDIDATES) {
  if (!Number.isInteger(input?.quantity) || input.quantity <= 0) {
    return rowError('invalid_quantity', 'Carton quantity must be a positive whole number.');
  }

  const carton = input.carton;
  if (
    !carton
    || !LENGTHS_PER_INCH[carton.unit]
    || !positiveFinite(carton.length)
    || !positiveFinite(carton.width)
    || !positiveFinite(carton.height)
  ) {
    return rowError('invalid_carton_dimensions', 'Carton dimensions must be positive numbers.');
  }

  const footprint = palletSettings?.footprint;
  if (
    !footprint
    || !LENGTHS_PER_INCH[footprint.unit]
    || !positiveFinite(footprint.length)
    || !positiveFinite(footprint.width)
  ) {
    return rowError('invalid_pallet_dimensions', 'Pallet dimensions must be positive numbers.');
  }

  const maxLoadedHeight = normalizeLength(palletSettings.maxLoadedHeight);
  const deckHeight = normalizeLength(palletSettings.deckHeight);
  if (maxLoadedHeight === null || deckHeight === null || maxLoadedHeight <= deckHeight) {
    return rowError('invalid_usable_height', 'Maximum loaded height must exceed pallet deck height.');
  }

  const normalized = {
    quantity: input.quantity,
    carton: {
      length: convertLength(carton.length, carton.unit, 'in'),
      width: convertLength(carton.width, carton.unit, 'in'),
      height: convertLength(carton.height, carton.unit, 'in'),
    },
    pallet: {
      length: convertLength(footprint.length, footprint.unit, 'in'),
      width: convertLength(footprint.width, footprint.unit, 'in'),
      usableHeight: maxLoadedHeight - deckHeight,
    },
    unitWeight: null,
    maxPayload: null,
    allowRotation: input.allowRotation !== false,
  };

  if (input.unitWeight !== null && input.unitWeight !== undefined) {
    if (!positiveFinite(input.unitWeight.value) || !POUNDS_PER_UNIT[input.unitWeight.unit]) {
      return rowError('invalid_unit_weight', 'Unit weight must be a positive number.');
    }
    normalized.unitWeight = convertWeight(input.unitWeight.value, input.unitWeight.unit, 'lb');
  }

  if (palletSettings.maxPayload !== null && palletSettings.maxPayload !== undefined) {
    if (!positiveFinite(palletSettings.maxPayload.value) || !POUNDS_PER_UNIT[palletSettings.maxPayload.unit]) {
      return rowError('invalid_max_payload', 'Maximum payload must be a positive number.');
    }
    normalized.maxPayload = convertWeight(
      palletSettings.maxPayload.value,
      palletSettings.maxPayload.unit,
      'lb',
    );
    if (normalized.unitWeight !== null && normalized.maxPayload < normalized.unitWeight) {
      return rowError('carton_exceeds_payload', 'One carton exceeds the pallet payload limit.');
    }
  }

  const fitsNormally = normalized.carton.length <= normalized.pallet.length
    && normalized.carton.width <= normalized.pallet.width;
  const fitsRotated = normalized.allowRotation
    && normalized.carton.width <= normalized.pallet.length
    && normalized.carton.length <= normalized.pallet.width;
  if (!fitsNormally && !fitsRotated) {
    return rowError('carton_exceeds_footprint', 'Carton footprint does not fit on the pallet.');
  }

  const areaUpperBound = Math.floor(
    normalized.pallet.length * normalized.pallet.width
      / (normalized.carton.length * normalized.carton.width),
  );
  if (areaUpperBound > candidateLimit) {
    return rowError('calculation_limit', 'Carton size creates too many layer candidates.');
  }

  return { status: 'ok', normalized, areaUpperBound };
}

function calculatePalletRowWithinLimit(input, palletSettings, candidateLimit) {
  const prepared = normalizeRow(input, palletSettings, candidateLimit);
  if (prepared.status === 'error') return prepared;

  const { normalized, areaUpperBound } = prepared;
  const boxes = Array.from({ length: areaUpperBound }, (_, index) => ({
    width: normalized.carton.length,
    height: normalized.carton.width,
    constrainRotation: !normalized.allowRotation,
    cartonIndex: index,
  }));
  const bins = [{ width: normalized.pallet.length, height: normalized.pallet.width }];
  const attempts = PACKING_HEURISTICS.map((Heuristic) => {
    const packed = pack2D({ bins, boxes, heuristic: new Heuristic(), limit: areaUpperBound });
    const placements = packed.packedBins[0]?.boxes ?? [];
    return {
      heuristic: Heuristic.name,
      placements,
      packedCount: placements.length,
      footprintUtilization: packed.packedBins[0]?.efficiency ?? 0,
    };
  });
  const best = attempts.reduce(
    (winner, attempt) => attempt.packedCount > winner.packedCount ? attempt : winner,
    attempts[0],
  );
  const layers = Math.floor(normalized.pallet.usableHeight / normalized.carton.height);
  if (layers < 1) {
    return rowError('carton_exceeds_usable_height', 'Carton height exceeds the usable loaded height.');
  }

  const geometricCapacity = best.packedCount * layers;
  if (geometricCapacity < 1) {
    return rowError('zero_capacity', 'No cartons fit within the pallet settings.');
  }
  const payloadCapacity = normalized.maxPayload !== null && normalized.unitWeight !== null
    ? Math.floor(normalized.maxPayload / normalized.unitWeight)
    : Number.POSITIVE_INFINITY;
  const cartonsPerPallet = Math.min(geometricCapacity, payloadCapacity);
  const limitingFactor = payloadCapacity < geometricCapacity ? 'payload' : 'geometry';
  const palletCount = Math.ceil(normalized.quantity / cartonsPerPallet);
  const remainder = normalized.quantity % cartonsPerPallet;
  const cartonsPerLayer = Math.min(best.packedCount, cartonsPerPallet);

  return {
    status: 'ok',
    palletCount,
    cartonsPerLayer,
    geometricCartonsPerLayer: best.packedCount,
    layers,
    cartonsPerPallet,
    cartonsOnLastPallet: remainder || cartonsPerPallet,
    limitingFactor,
    footprintUtilization: best.footprintUtilization,
    placements: best.placements
      .slice(0, cartonsPerLayer)
      .map(({ sourceBox: _sourceBox, ...placement }) => placement),
    attemptedHeuristics: attempts.map((attempt) => attempt.heuristic),
    heuristic: best.heuristic,
    fullPalletProductWeight: normalized.unitWeight === null
      ? null
      : cartonsPerPallet * normalized.unitWeight,
    totalProductWeight: normalized.unitWeight === null
      ? null
      : normalized.quantity * normalized.unitWeight,
    calculationCandidates: areaUpperBound,
  };
}

export function calculatePalletRow(input, palletSettings) {
  return calculatePalletRowWithinLimit(input, palletSettings, MAX_LAYER_CANDIDATES);
}

export function calculatePalletShipment(rows, palletSettings) {
  let remainingCandidates = MAX_SHIPMENT_CANDIDATES;
  const results = rows.map((row) => {
    const result = calculatePalletRowWithinLimit(
      row,
      palletSettings,
      Math.min(MAX_LAYER_CANDIDATES, remainingCandidates),
    );
    if (result.status === 'ok') remainingCandidates -= result.calculationCandidates;
    return result;
  });
  const successfulRows = results
    .map((result, index) => ({ result, input: rows[index] }))
    .filter(({ result }) => result.status === 'ok');
  const hasCompleteWeight = successfulRows.length > 0
    && successfulRows.every(({ result }) => result.totalProductWeight !== null);
  const shipment = {
    rows: results,
    totals: {
      cartons: successfulRows.reduce((sum, { input }) => sum + input.quantity, 0),
      estimatedPallets: successfulRows.reduce((sum, { result }) => sum + result.palletCount, 0),
      productWeight: hasCompleteWeight
        ? successfulRows.reduce((sum, { result }) => sum + result.totalProductWeight, 0)
        : null,
    },
    assumptions: [
      'Carton height remains upright.',
      'Different carton rows are calculated as separate pallet groups.',
      'Estimated results require warehouse confirmation.',
    ],
  };
  if (palletSettings?.mixCartons === true && results.every(row => row.status === 'ok') && rows.length) {
    return calculateMixedPallets(rows, palletSettings, shipment);
  }
  return shipment;
}

// Bounded 3D heuristic built on the existing MaxRects floor packer. Each box
// creates its own top surface: upper boxes never bridge gaps or overhang.
function calculateMixedPallets(rows, settings, separate) {
  const normalized = rows.map(row => normalizeRow(row, settings).normalized);
  const total = rows.reduce((sum, row) => sum + row.quantity, 0);
  if (rows.length > 30 || total > 1500 || separate.totals.estimatedPallets > 200) {
    return { ...separate, mixedNotice: 'Mixed packing supports up to 30 carton groups, 1500 cartons and 200 pallets. Separate results are shown.' };
  }
  if (settings.maxPayload && normalized.some(row => row.unitWeight === null)) {
    return { ...separate, mixedError: 'Enter every carton weight to check the mixed pallet payload limit.' };
  }
  const pallet = normalized[0].pallet;
  const deck = normalizeLength(settings.deckHeight);
  const attempts = [];
  for (const Heuristic of PACKING_HEURISTICS) for (const priority of ['area', 'height']) {
    const remaining = rows.map(row => row.quantity), pallets = [];
    const order = normalized.map((_, index) => index).sort((a, b) => {
      const aa = normalized[a].carton, bb = normalized[b].carton;
      return priority === 'height' ? bb.height - aa.height || bb.length * bb.width - aa.length * aa.width
        : bb.length * bb.width - aa.length * aa.width || bb.height - aa.height;
    });
    while (remaining.some(Boolean) && pallets.length < 200) {
      const placements = [], surfaces = [{ x: 0, y: 0, z: 0, width: pallet.length, height: pallet.width }];
      let weight = 0, unknownWeight = false;
      while (surfaces.length && remaining.some(Boolean)) {
        // Fill low surfaces first; the support relationships remain explicit.
        surfaces.sort((a, b) => a.z - b.z || b.width * b.height - a.width * a.height);
        const surface = surfaces.shift(), boxes = [];
        let budget = normalized[0].maxPayload === null ? Infinity : normalized[0].maxPayload - weight;
        for (const index of order) {
          const { carton, allowRotation, unitWeight } = normalized[index];
          if (surface.z + carton.height > pallet.usableHeight + 1e-8) continue;
          if (!(carton.length <= surface.width + 1e-8 && carton.width <= surface.height + 1e-8)
            && !(allowRotation && carton.width <= surface.width + 1e-8 && carton.length <= surface.height + 1e-8)) continue;
          const count = Math.min(remaining[index], Math.floor(surface.width * surface.height / (carton.length * carton.width) + 1e-8),
            unitWeight ? Math.floor((budget + 1e-8) / unitWeight) : Infinity, 500 - boxes.length);
          for (let n = 0; n < count; n++) boxes.push({ width: carton.length, height: carton.width, constrainRotation: !allowRotation, rowIndex: index });
          budget -= count * (unitWeight || 0);
        }
        if (!boxes.length) continue;
        const packed = pack2D({ bins: [{ width: surface.width, height: surface.height }], boxes, heuristic: new Heuristic(), limit: boxes.length });
        for (const box of packed.packedBins[0]?.boxes || []) {
          const index = box.sourceBox.rowIndex, row = normalized[index];
          const placement = { x: surface.x + box.x, y: surface.y + box.y, z: surface.z,
            width: box.width, height: box.height, cartonHeight: row.carton.height, rotated: box.rotated, rowIndex: index };
          placements.push(placement); remaining[index]--;
          weight += row.unitWeight || 0; unknownWeight ||= row.unitWeight === null;
          surfaces.push({ x: placement.x, y: placement.y, z: placement.z + row.carton.height, width: box.width, height: box.height });
        }
      }
      if (!placements.length) break;
      const counts = rows.map((_, index) => placements.filter(box => box.rowIndex === index).length);
      pallets.push({ placements, counts, cartonCount: placements.length, productWeight: unknownWeight ? null : weight,
        loadedHeight: deck + Math.max(...placements.map(box => box.z + box.cartonHeight)) });
    }
    if (remaining.every(count => count === 0)) attempts.push({ pallets, heuristic: `${Heuristic.name} / ${priority}` });
  }
  attempts.sort((a, b) => a.pallets.length - b.pallets.length
    || a.pallets.reduce((sum, p) => sum + p.loadedHeight, 0) - b.pallets.reduce((sum, p) => sum + p.loadedHeight, 0));
  const best = attempts[0];
  // Adding permission must not produce a worse pallet count than separate packing.
  if (!best || best.pallets.length > separate.totals.estimatedPallets) {
    return { ...separate, mixedNotice: 'Separate packing uses fewer pallets than the mixed candidates. Separate results are shown.' };
  }
  return { ...separate, mode: 'mixed', pallets: best.pallets, heuristic: best.heuristic,
    totals: { ...separate.totals, estimatedPallets: best.pallets.length },
    assumptions: ['Carton height remains upright.',
      'Mixed cartons use fully supported top surfaces; no bridging or overhang is modeled.',
      'Carton crush strength and load securing are not modeled. Confirm the mixed plan with the warehouse.',
      'Estimated results require warehouse confirmation.'] };
}

export const PACKING_HEURISTICS = Object.freeze([
  BestShortSideFit,
  BestAreaFit,
  BestLongSideFit,
  BottomLeft,
]);

export { pack2D };
