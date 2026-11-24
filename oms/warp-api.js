// Gateway API V2 quote adapter. Supplier keys belong exclusively to the server.
export function toWarpRequest(shipment, today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })) {
  const fail = message => { throw new Error(message); };
  const zip = value => String(value ?? '').match(/(?:^|\D)(\d{5})(?:-\d{4})?(?!\d)/)?.[1];
  const origin_zip = zip(shipment?.origin), destination_zip = zip(shipment?.destination);
  if (!origin_zip || !destination_zip) fail('请填写两端五位美国 ZIP。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shipment.pickupDate ?? '') || !Number.isFinite(Date.parse(shipment.pickupDate)) || new Date(shipment.pickupDate).toISOString().slice(0, 10) !== shipment.pickupDate || shipment.pickupDate < today) fail('请选择有效的提货日期。');
  if (!['ltl', 'ftl'].includes(shipment.mode)) fail('此入口仅支持 LTL 或 FTL 询价。');
  const mode = shipment.mode === 'ftl' ? { van: 'DRY_VAN_53', box: 'STRAIGHT_TRUCK_26', sprinter: 'CARGO_VAN' }[shipment.equipment] : 'LTL';
  if (!mode) fail('WARP 当前接入支持干柜、Box Truck 和 Sprinter；其他车型请用演示询价。');
  if (shipment.mode === 'ftl' && Number(shipment.vehicleCount) !== 1) fail('WARP 单次询价对应一辆车，请将车辆数量设为 1。');
  if (!Array.isArray(shipment.items) || !shipment.items.length || shipment.items.length > 50) fail('请填写货物重量、尺寸和数量。');
  const items = shipment.items.map(item => {
    if (item.type !== 'pallet') fail('当前 WARP 接入按托盘询价，木箱或纸箱请先按实际托盘信息填写。');
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) fail('请检查托盘数量。');
    for (const name of ['weight', 'length', 'width', 'height']) if (!Number.isFinite(item[name]) || item[name] <= 0 || item[name] > 100000) fail('请填写有效的货物重量和尺寸。');
    if ((item.commodities ?? []).some(c => (c.regulated ?? []).length)) fail('此查价入口暂不支持危险品或特殊监管货物，请联系人工确认。');
    return { quantity: item.quantity, totalWeight: Number((item.weight * item.quantity).toFixed(4)), length: item.length, width: item.width, height: item.height, sizeUnit: 'IN', weightUnit: 'lbs', packaging: 'Pallet', stackable: false, ...(item.commodities?.[0]?.description ? { name: String(item.commodities[0].description).slice(0, 200) } : {}), ...(item.commodities?.[0]?.freightClass ? { freightClass: String(item.commodities[0].freightClass) } : {}) };
  });
  const accessorials = {};
  for (const [side, key, suffix] of [['origin', 'pickup', 'pickup'], ['destination', 'delivery', 'delivery']]) {
    const names = { liftgate: `liftgate-${suffix}`, inside: `inside-${suffix}`, limited: `limited-access-${suffix}`, appointment: `${suffix}-appointment`, tradeshow: `convention-trade-show-${suffix}` };
    accessorials[key] = (shipment.services?.[side] ?? []).map(service => {
      if (!names[service]) fail('当前 WARP 入口无法完整传递“亚马逊预约、到货通知或 CFS”等服务，请取消该项后查价，或转人工确认。');
      return names[service];
    });
    const type = shipment.addressTypes?.[side];
    if (!['commercial-dock', 'commercial-no-dock', 'residential'].includes(type)) fail('请选择提送货地址类型。');
    if (type === 'residential') accessorials[key].push(`residential-${suffix}`);
  }
  const pallets = items.reduce((sum, item) => sum + item.quantity, 0);
  const totalWeight = items.reduce((sum, item) => sum + item.totalWeight, 0);
  if (mode === 'STRAIGHT_TRUCK_26' && (pallets > 12 || totalWeight > 10000)) fail('Box Truck 上限为 12 托、10,000 lb。');
  if (mode === 'CARGO_VAN' && (pallets > 3 || totalWeight > 3500)) fail('Sprinter 上限为 3 托、3,500 lb。');
  const body = {
    pickupDate: shipment.pickupDate, pickupInfo: { zipcode: origin_zip, country: 'US' }, deliveryInfo: { zipcode: destination_zip, country: 'US' },
    listItems: items, shipmentType: mode === 'LTL' ? 'LTL' : 'FTL',
    ...(mode === 'LTL' ? {} : { vehicleType: { code: mode } }),
    pickupServices: accessorials.pickup.map(service => ({ quantity: 1, service })),
    deliveryServices: accessorials.delivery.map(service => ({ quantity: 1, service })), additionalServices: []
  };
  return { mode, body };
}

export function normalizeWarpQuote(data, requestedMode, environment = 'staging') {
  const expiresAt = data?.expiration_time_utc * 1000;
  const cents = Math.round(data?.price?.amount * 100);
  if (data?.status !== 'ACCEPT' || typeof data?.price?.amount !== 'number' || !Number.isSafeInteger(cents) || cents <= 0 || data.price.currency_code !== 'USD' || typeof data.quote_id !== 'string' || !data.quote_id || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('WARP V2 未返回有效的 USD 报价，请重新询价。');
  const days = data.transit_time;
  const substituted = requestedMode === 'LTL' && data.shipmentType !== 'LTL';
  const charges = Array.isArray(data.charges) ? data.charges.filter(row => typeof row.amount === 'number' && Number.isFinite(row.amount)).map(row => ({ code: String(row.code).slice(0, 80), description: String(row.description ?? '').slice(0, 200), cents: Math.round(row.amount * 100) })).slice(0, 40) : [];
  return {
    source: 'warp-v2', environment, fetchedAt: Date.now(), quoteId: data.quote_id, priceCents: cents,
    expiresAt, transitDays: typeof days === 'number' && Number.isFinite(days) && days >= 0 ? days : null,
    deliveryDate: /^\d{4}-\d{2}-\d{2}$/.test(data.estimated_delivery_date ?? '') ? data.estimated_delivery_date : '',
    mode: String(data.shipmentType ?? '').slice(0, 30),
    vehicle: { LTL: 'LTL', DRY_VAN_53: '53ft 干柜', STRAIGHT_TRUCK_26: '26ft Box Truck', CARGO_VAN: 'Cargo Van' }[requestedMode], substituted,
    tier: 'reference', included: [], missing: [], charges,
    chargesReconcile: charges.filter(row => row.code !== 'TOTAL').length > 0 && charges.filter(row => row.code !== 'TOTAL').reduce((sum, row) => sum + row.cents, 0) === cents
  };
}

export async function fetchWarpQuote(shipment) {
  toWarpRequest(shipment); // Fail before sending an unsupported shipment.
  const base = globalThis.HYE_WARP_CONFIG?.gatewayUrl ?? '';
  const response = await fetch(`${base}/api/warp/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipment }),
    signal: AbortSignal.timeout(25000), credentials: 'omit', referrerPolicy: 'no-referrer'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '询价服务不可用。GitHub Pages 需配置独立询价后端；本地可运行 npm start。');
  if (data.source !== 'warp-v2' || !Number.isSafeInteger(data.priceCents) || data.priceCents <= 0 || !(data.expiresAt > Date.now())) throw new Error('询价服务返回了无效报价。');
  return data;
}
