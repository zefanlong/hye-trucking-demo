// Local, durable Sandbox checkout. No production host, arbitrary route, or card data accepted.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { toWarpRequest, toWarpMarketRequest } from '../oms/warp-api.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400, code = 'SANDBOX_VALIDATION') => Object.assign(new Error(message), { status, code });
export const WARP_SANDBOX_ORIGIN = 'https://stg.wearewarp.com/api/v1';

function parseAddress(value, unit = '') {
  const match = String(value ?? '').trim().match(/^(.+),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (!match) throw fail('请使用“街道, 城市, 州 ZIP”格式填写完整地址。');
  return { street: match[1].trim(), city: match[2].trim(), state: match[3].toUpperCase(), zipcode: match[4], ...(unit ? { street2: String(unit).slice(0, 100) } : {}) };
}
function zonedTime(date, time, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) throw fail('请填写有效的日期和时间窗口。');
  const target = Date.parse(date + 'T' + time + ':00Z');
  let instant = target;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(instant).map(p => [p.type, p.value]));
    const observed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    instant += target - observed;
  }
  const p = Object.fromEntries(format.formatToParts(instant).map(p => [p.type, p.value]));
  if (`${p.year}-${p.month}-${p.day}` !== date || `${p.hour}:${p.minute}` !== time) throw fail('所选当地时间无效，请调整时间窗口。');
  return new Date(instant).toISOString();
}
function stopFor(side, shipment, details, zip, services, market) {
  const address = parseAddress(shipment[side], details[side + 'Unit']);
  if (address.zipcode !== zip) throw fail('地址邮编与服务端报价不一致，请重新询价。');
  for (const field of ['Company', 'Contact', 'Phone', 'Email']) if (typeof details[side + field] !== 'string' || !details[side + field].trim()) throw fail('请补齐提送货公司、联系人、电话和邮箱。');
  if (!/^\+?[\d\s().-]{7,30}$/.test(details[side + 'Phone']) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details[side + 'Email'])) throw fail('请检查联系电话和邮箱格式。');
  const zone = details[side + 'Timezone'];
  if (!['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York'].includes(zone)) throw fail('请选择两个地点各自的当地时区。');
  const date = side === 'origin' ? shipment.pickupDate : details.destinationDate;
  const from = zonedTime(date, side === 'origin' ? shipment.pickupTime : details.destinationOpensAt, zone);
  const to = zonedTime(date, side === 'origin' ? details.pickupEnd : details.destinationClosesAt, zone);
  if (Date.parse(from) <= Date.now() || Date.parse(to) <= Date.parse(from)) throw fail('时间窗口必须在未来，结束时间须晚于开始时间。');
  const requiresAppointment = services.includes(side === 'origin' ? 'pickup-appointment' : 'delivery-appointment');
  return { locationName: details[side + 'Company'].slice(0, 200), contactName: details[side + 'Contact'].slice(0, 150), contactPhone: details[side + 'Phone'], contactEmail: details[side + 'Email'], address,
    ...(details[side + 'PhoneExtension'] ? { phoneExtension: details[side + 'PhoneExtension'] } : {}),
    requiresAppointment, ...(requiresAppointment ? { appointmentInfo: { from, to } } : {}),
    [market ? 'timeWindow' : 'windowTime']: { from, to },
    ...(market ? { serviceOptions: services, refNums: [details[side + 'Reference']].filter(Boolean) } : { refNum: details[side + 'Reference'] || '' }),
    instructions: String(details[side + 'Notes'] || '').slice(0, 1500) };
}
export function buildSandboxBooking(snapshot, shipment, details) {
  const normalized = toWarpRequest(shipment);
  const market = snapshot.market;
  const current = market ? toWarpMarketRequest(normalized.body) : normalized.body;
  if (digest(current) !== digest(snapshot.payload)) throw fail('运输计价信息与服务端报价不一致，请重新询价。', 409, 'QUOTE_CHANGED');
  const payload = snapshot.payload;
  const pickup = market ? payload.pickupInfo.serviceOptions : payload.pickupServices.map(row => row.service);
  const delivery = market ? payload.deliveryInfo.serviceOptions : payload.deliveryServices.map(row => row.service);
  const pickupInfo = stopFor('origin', shipment, details, payload.pickupInfo.zipcode, pickup, market);
  const deliveryInfo = stopFor('destination', shipment, details, payload.deliveryInfo.zipcode, delivery, market);
  const pickupWindow = pickupInfo[market ? 'timeWindow' : 'windowTime'];
  const deliveryWindow = deliveryInfo[market ? 'timeWindow' : 'windowTime'];
  if (Date.parse(deliveryWindow.from) < Date.parse(pickupWindow.from)) throw fail('送货窗口不能早于提货窗口。');
  return market
    ? { quoteId: snapshot.quoteId, pickupInfo, deliveryInfo, items: payload.items, additionalServices: payload.additionalServices }
    : { quoteId: snapshot.quoteId, pickupInfo, deliveryInfo, listItems: payload.listItems, pickupServices: payload.pickupServices, deliveryServices: payload.deliveryServices, additionalServices: payload.additionalServices, shipmentType: payload.shipmentType, ...(payload.vehicleType ? { vehicleType: payload.vehicleType } : {}) };
}

export class SandboxCheckout {
  constructor(path, key, { upstream = fetch, maxBookingCents = 500000 } = {}) {
    if (!key) throw new Error('Sandbox key required');
    this.key = key; this.fingerprint = digest(key); this.upstream = upstream; this.maxBookingCents = maxBookingCents;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS quotes (handle TEXT PRIMARY KEY, session TEXT, account TEXT, quote_id TEXT, snapshot TEXT, state TEXT DEFAULT 'ready', request_hash TEXT, request_body TEXT, result TEXT, UNIQUE(account,quote_id));
      CREATE TABLE IF NOT EXISTS ledger (handle TEXT PRIMARY KEY, session TEXT, cents INTEGER, created INTEGER);`);
    // A process interrupted during a write has an unknown supplier outcome, never an automatic retry.
    this.db.exec("UPDATE quotes SET state='unknown' WHERE state='submitting'");
  }
  close() { this.db.close(); }
  session(cookie = '') {
    const id = cookie.match(/(?:^|;\s*)hye_sandbox_session=([a-f0-9]{48})(?:;|$)/)?.[1];
    let row = id && this.db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(id, Date.now());
    const created = !row;
    if (!row) { row = { id: randomBytes(24).toString('hex'), csrf: randomBytes(24).toString('hex'), expires: Date.now() + 86400000 }; this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(row.id, row.csrf, row.expires); }
    return { ...row, created };
  }
  wallet(session) {
    const debit = this.db.prepare('SELECT COALESCE(SUM(cents),0) AS cents FROM ledger WHERE session=?').get(session).cents;
    const reserved = this.db.prepare("SELECT COALESCE(SUM(json_extract(snapshot,'$.priceCents')),0) AS cents FROM quotes WHERE session=? AND state IN ('submitting','unknown')").get(session).cents;
    return { environment: 'sandbox', openingCents: 1000000, debitedCents: debit, reservedCents: reserved, balanceCents: 1000000 - debit, availableCents: 1000000 - debit - reserved, label: 'OMS 独立测试资金账本' };
  }
  capture(session, shipment, envelope) {
    const normalized = toWarpRequest(shipment), market = normalized.mode === 'LTL';
    const payload = market ? toWarpMarketRequest(normalized.body) : normalized.body;
    const options = envelope.options.map(option => {
      let row = this.db.prepare('SELECT * FROM quotes WHERE account=? AND quote_id=?').get(this.fingerprint, option.quoteId);
      if (row && row.session !== session) return { ...option, bookingUnavailable: '该报价属于另一测试会话，请重新询价。' };
      if (!row) {
        const handle = randomUUID();
        const snapshot = { market, payload, quoteId: option.quoteId, priceCents: option.priceCents, expiresAt: option.expiresAt, option };
        this.db.prepare('INSERT INTO quotes(handle,session,account,quote_id,snapshot) VALUES (?,?,?,?,?)').run(handle, session, this.fingerprint, option.quoteId, JSON.stringify(snapshot));
        row = { handle };
      }
      return { ...option, bookingHandle: row.handle };
    });
    return { ...envelope, options };
  }
  async book(session, body) {
    const row = this.db.prepare('SELECT * FROM quotes WHERE handle=? AND session=? AND account=?').get(body.handle, session, this.fingerprint);
    if (!row) throw fail('该报价不属于当前测试会话，请重新询价。', 404);
    const snapshot = JSON.parse(row.snapshot);
    if (body.confirmSandbox !== true || body.confirmedAmountCents !== snapshot.priceCents) throw fail('请明确确认沙盒下单及服务端报价金额。', 409, 'AMOUNT_NOT_CONFIRMED');
    if (snapshot.priceCents > this.maxBookingCents) throw fail('超出本地沙盒单笔测试上限。', 403);
    // Completed requests replay even after expiry. Never repeat a supplier write.
    if (row.state === 'booked' || row.state === 'awaiting_payment') return { ...JSON.parse(row.result), replay: true, wallet: this.wallet(session) };
    if (['unknown', 'submitting'].includes(row.state)) throw fail('该订单结果正在核对或尚不明确，请勿再次下单。', 409, 'BOOKING_RESULT_UNKNOWN');
    if (!(snapshot.expiresAt > Date.now())) throw fail('服务端报价已过期，请重新询价。', 409);
    if (snapshot.priceCents > this.wallet(session).availableCents) throw fail('OMS 测试可用资金不足，包含正在提交或结果未知订单的预留金额。', 402);
    const payload = buildSandboxBooking(snapshot, body.shipment, body.details || {});
    const requestHash = digest(payload);
    if (row.request_hash && row.request_hash !== requestHash) throw fail('上次尝试的订单资料不同，请重新询价。', 409);
    const lock = this.db.prepare("UPDATE quotes SET state='submitting', request_hash=?, request_body=? WHERE handle=? AND state IN ('ready','rejected')").run(requestHash, JSON.stringify(payload), row.handle);
    if (!lock.changes) throw fail('订单正在提交，请等待结果。', 409);
    let response, data;
    try {
      response = await this.upstream(`${WARP_SANDBOX_ORIGIN}/freights/${snapshot.market ? 'book' : 'booking'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: this.key }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(45000) });
      data = await response.json();
    } catch { this.db.prepare("UPDATE quotes SET state='unknown' WHERE handle=?").run(row.handle); throw fail('WARP 沙盒下单结果未知，已暂停重试；请核对供应商订单。', 502, 'BOOKING_RESULT_UNKNOWN'); }
    if (!response.ok) {
      const uncertain = response.status >= 500 || response.status === 409;
      this.db.prepare('UPDATE quotes SET state=? WHERE handle=?').run(uncertain ? 'unknown' : 'rejected', row.handle);
      const code = String(data?.code || '').slice(0, 80);
      const hints = { CHARGE_FAILED: 'WARP 测试扣款失败，订单未创建。', PAYMENT_ACTION_REQUIRED: 'WARP 测试付款需要进一步验证，订单未创建。', CARD_PAYMENT_UNAVAILABLE: '此测试账户尚未开通卡支付。', invalid_field_data: 'WARP 拒绝订单资料，请核对地址和时间窗口。', required_field_missing: 'WARP 要求补全订单字段。' };
      throw fail(uncertain ? 'WARP 下单结果需要核对，已禁止自动重试。' : hints[code] || 'WARP 沙盒拒绝下单；未记录本地测试扣款。', response.status === 402 ? 402 : 502, code || 'SANDBOX_BOOK_FAILED');
    }
    if (typeof data?.orderId !== 'string' || !data.orderId) { this.db.prepare("UPDATE quotes SET state='unknown' WHERE handle=?").run(row.handle); throw fail('WARP 未返回可核对的订单编号，已停止重复提交。', 502); }
    const pendingPayment = Boolean(data.paymentLink);
    const payment = data.payment && typeof data.payment === 'object' ? { method: String(data.payment.method || '').slice(0, 30), amountCharged: typeof data.payment.amount_charged === 'number' ? data.payment.amount_charged : null, cardFee: typeof data.payment.card_fee === 'number' ? data.payment.card_fee : null, last4: /^\d{4}$/.test(data.payment.last4 || '') ? data.payment.last4 : '' } : null;
    const result = { environment: 'staging', handle: row.handle, quoteId: snapshot.quoteId, amountCents: snapshot.priceCents,
      confirmedShipment: structuredClone(body.shipment), confirmedDetails: structuredClone(body.details),
      orderId: data.orderId, proNumber: String(data.proNumber || '').slice(0, 100), trackingNumber: String(data.trackingNumber || '').slice(0, 100), shipmentIds: Array.isArray(data.shipmentIds) ? data.shipmentIds.filter(x => typeof x === 'string').slice(0, 20) : [],
      status: pendingPayment ? 'awaiting_payment' : 'booked', supplierPayment: pendingPayment ? 'pending' : payment ? 'reported' : 'not_reported', payment,
      // Payment URLs may target the production portal: never redirect a Sandbox user there.
      paymentActionRequired: pendingPayment, testDebitCents: pendingPayment ? 0 : snapshot.priceCents, recordedAt: Date.now() };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!pendingPayment) this.db.prepare('INSERT OR IGNORE INTO ledger VALUES (?,?,?,?)').run(row.handle, session, snapshot.priceCents, result.recordedAt);
      this.db.prepare('UPDATE quotes SET state=?,result=? WHERE handle=?').run(result.status, JSON.stringify(result), row.handle);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ...result, wallet: this.wallet(session) };
  }
}
