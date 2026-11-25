import { calculateTruckLoading, TRUCK_PRESETS } from './vendor/pallet-planner/shared/truck-loading.js';

// Adapt OMS handling units to the existing Pallet & Load Planner contract.
// Keep the upstream packing, rotation, strict-width and payload rules unchanged.
const cache = new Map();
export function calculateLoadSpace(items, shipment = {}) {
  if (shipment.mode === 'ftl' && !['van', 'box', 'reefer'].includes(shipment.equipment)) {
    return { status: 'unsupported', message: '当前车型暂无参考车厢尺寸，暂不模拟装车。' };
  }
  const preset = shipment.mode === 'ftl' && shipment.equipment === 'box' ? 'box-truck' : 'dry-van';
  const vehicle = { ...TRUCK_PRESETS[preset] };
  const groups = (items ?? []).map((item, index) => ({
    name: `货物 ${index + 1}`, quantity: Number(item.quantity), length: Number(item.length), width: Number(item.width), height: Number(item.height),
    weight: item.weight === '' || item.weight == null ? null : Number(item.weight),
    maxLayers: 1, maxTopLoad: null, allowRotation: true
  }));
  const quantity = groups.reduce((sum, group) => sum + group.quantity, 0);
  if (!groups.length || groups.some(group => !Number.isInteger(group.quantity) || group.quantity < 1 || !['length', 'width', 'height'].every(key => Number.isFinite(group[key]) && group[key] > 0) || group.weight !== null && !(Number.isFinite(group.weight) && group.weight > 0))) {
    return { status: 'incomplete', message: '补全货物件数和尺寸后显示装车示意。' };
  }
  if (groups.length > 30 || quantity > 200) return { status: 'limit', message: '装车模拟支持最多 30 种、200 件货物，请分批规划。' };
  const key = JSON.stringify([groups, vehicle]);
  if (cache.has(key)) return cache.get(key);
  const result = calculateTruckLoading(groups, vehicle, { allowMixedStacking: false, preferSimpleLayout: true });
  const plan = { ...result, preset, label: preset === 'box-truck' ? '26ft 参考车厢' : '53ft 参考车厢' };
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, plan);
  return plan;
}

const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const geometry = value => Number(value.toFixed(3));
function floorDiagram(plan) {
  const { vehicle, placements } = plan;
  const extent = vehicle.length;
  const scale = 284 / extent;
  const top = 25, floorHeight = vehicle.width * scale;
  const fullHeight = top + floorHeight + 21;
  const marks = placements.map((placement, index) => {
    if (placement.x >= extent) return '';
    const x = 18 + placement.x * scale, y = top + placement.y * scale;
    const width = Math.min(placement.footprintLength, extent - placement.x) * scale, height = placement.footprintWidth * scale;
    const label = `货物 ${placement.groupIndex + 1} · ${number(placement.footprintLength)} × ${number(placement.footprintWidth)} in${placement.rotated ? ' · 已水平旋转' : ''}`;
    return `<g class="load-piece load-piece-${placement.groupIndex % 3}" tabindex="0" role="img" aria-label="${label}"><title>${label} · 装载件 ${index + 1}</title><rect x="${geometry(x)}" y="${geometry(y)}" width="${geometry(width)}" height="${geometry(height)}"/>${width > 19 && height > 17 ? `<text x="${geometry(x + width / 2)}" y="${geometry(y + height / 2)}">${placement.groupIndex + 1}</text>` : ''}</g>`;
  }).join('');
  const boundary = plan.usedLength * scale + 18;
  return `<svg class="load-floor" viewBox="0 0 320 ${geometry(fullHeight)}" role="img" aria-label="装车俯视图，已装 ${plan.loaded} 件，占用 ${number(plan.linearFeet)} 英尺，整车视图">
    <text class="load-direction" x="18" y="13">车头</text><text class="load-direction" x="302" y="13" text-anchor="end">车尾</text>
    <rect class="load-floor-base" x="18" y="${top}" width="284" height="${geometry(floorHeight)}" rx="3"/>
    ${marks}${plan.usedLength > 0 && boundary < 302 ? `<path class="load-boundary" d="M${geometry(boundary)} ${top - 2}v${geometry(floorHeight + 4)}"/>` : ''}
    <text class="load-axis" x="18" y="${geometry(fullHeight - 4)}">0 ft</text><text class="load-axis" x="302" y="${geometry(fullHeight - 4)}" text-anchor="end">${number(extent / 12)} ft</text>
  </svg>`;
}

export function loadSpaceView(plan) {
  if (plan.status !== 'ok') return `<div class="load-space"><h4>模拟装车</h4><p class="note">${plan.message || '暂不能生成装车示意。'}</p></div>`;
  return `<div class="load-space" data-load-space>
    <div class="panel-head"><div class="load-title"><h4>模拟装车</h4><span class="load-reference" title="参考尺寸 ${plan.vehicle.length} × ${plan.vehicle.width} × ${plan.vehicle.height} in · 载重 ${number(plan.vehicle.payload)} lb · 不叠放">${plan.label}</span></div></div>
    <div data-load-view="whole">${floorDiagram(plan)}</div>
    ${plan.unplaced ? `<p class="load-warning">${plan.unplaced} 件未装入，需核对车厢尺寸、载重或分车运输。</p>` : ''}
  </div>`;
}
