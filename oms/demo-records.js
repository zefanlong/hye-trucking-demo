import { demoEvidence } from './demo-evidence.js?v=demo-scenarios-1';

export const demoScenarioVersion = 1;

// Stable identifiers make this additive migration safe for previously saved demos.
export function demoScenarios({ exampleShipment, exampleCustomShipment, priceQuote, day }) {
  const at = (offset, hour = 16) => Date.parse(day(offset) + `T${String(hour).padStart(2, '0')}:00:00Z`);
  const lanes = [
    ['120 Demo Way, Los Angeles, CA 90001', '85 Sample Drive, Chicago, IL 60601'],
    ['210 Sample Avenue, Ontario, CA 91761', '94 Example Road, Dallas, TX 75201'],
    ['95 Demo Avenue, San Jose, CA 95131', '84 Example Way, Houston, TX 77002'],
    ['21 Example Road, Newark, NJ 07102', '54 Sample Drive, Charlotte, NC 28202'],
    ['310 Sample Street, Seattle, WA 98101', '170 Demo Road, Denver, CO 80201']
  ];
  const states = ['ready', 'picked', 'transit', 'delivered', 'cancelled'];
  const pickupOffsets = [1, -1, -3, -6, 2];
  const names = ['服装及日用品', '家具配件', '电子产品', '机械零件', '展示用品'];
  const orders = ['ltl', 'ftl', 'custom'].flatMap((mode, group) => states.map((status, index) => {
    const number = 201 + group * 5 + index;
    const id = 'HYE-DEMO-' + number;
    const shipment = mode === 'custom' ? { ...exampleCustomShipment(), mode: 'custom' } : exampleShipment(mode);
    shipment.origin = lanes[index][0]; shipment.destination = lanes[index][1];
    shipment.pickupDate = day(pickupOffsets[index]); shipment.pickupTime = '09:00';
    shipment.services = { origin: index === 1 ? ['liftgate'] : [], destination: index === 2 ? ['appointment', 'notify'] : ['appointment'] };
    if (mode === 'ftl') { shipment.equipment = ['van', 'box', 'flatbed', 'sprinter', 'van'][index]; shipment.vehicleCount = 1; }
    if (mode !== 'custom') shipment.items = [{ type: 'pallet', quantity: mode === 'ftl' ? [20, 8, 18, 2, 12][index] : [2, 3, 2, 2, 1][index],
      weight: 400, length: 48, width: 40, height: index === 2 ? 60 : 48,
      commodities: [{ description: names[index], nmfc: '', freightClass: '70', declaredValue: '3500', pieceType: 'carton', pieceCount: '12', regulated: [] }] }];
    if (mode === 'custom') {
      const start = pickupOffsets[index];
      shipment.stops.origin.forEach((stop, i) => Object.assign(stop, { date: day(start + i), company: ['West Coast Demo Warehouse', 'Phoenix Demo Warehouse'][i], email: `pickup${i + 1}@example.com`, opensAt: '09:00', closesAt: '17:00' }));
      shipment.stops.destination.forEach((stop, i) => Object.assign(stop, { date: day(start + 3 + i), company: ['Midwest Demo Receiving', 'Indianapolis Demo Receiving'][i], email: `delivery${i + 1}@example.com`, opensAt: '09:00', closesAt: '17:00' }));
      shipment.origin = shipment.stops.origin[0].address; shipment.destination = shipment.stops.destination.at(-1).address;
      shipment.deliveryDate = shipment.stops.destination.at(-1).date;
    }
    const quoteId = 'QT-DEMO-SCENARIO-' + number;
    const quote = priceQuote({ id: quoteId }, shipment);
    const rate = structuredClone(quote.rates[index % 3]);
    if (mode === 'custom') rate.name = '多提多卸定制专线';
    const details = { pickupEnd: '17:00' };
    for (const side of ['origin', 'destination']) Object.assign(details, {
      [side + 'Company']: side === 'origin' ? 'HYE Demo Shipping Warehouse' : 'HYE Demo Receiving Center',
      [side + 'Contact']: side === 'origin' ? '演示发货联系人' : '演示收货联系人',
      [side + 'Phone']: side === 'origin' ? '+1 213 555 0101' : '+1 312 555 0102',
      [side + 'PhoneExtension']: side === 'origin' ? '101' : '202',
      [side + 'Email']: side === 'origin' ? 'pickup@example.com' : 'delivery@example.com',
      [side + 'Reference']: `${side === 'origin' ? 'PU' : 'DEL'}-DEMO-${number}`,
      [side + 'Notes']: side === 'origin' ? '从西侧货车入口进入，抵达后联系仓库。' : '请在收货窗口登记，交接前核对托盘件数。',
      [side + 'OpensAt']: '09:00', [side + 'ClosesAt']: '17:00'
    });
    const timeline = [{ status: 'ready', at: at(-8, 15), text: '订单已创建，等待安排提货。' }];
    if (['picked', 'transit', 'delivered'].includes(status)) timeline.push({ status: 'picked', at: at(pickupOffsets[index], 18), text: '承运商已完成现场交接并提取货物。' });
    if (['transit', 'delivered'].includes(status)) timeline.push({ status: 'transit', at: at(status === 'transit' ? -1 : -4, 20), location: mode === 'custom' ? 'Phoenix, AZ' : '转运中心', text: mode === 'custom' ? '已完成第二站提货，车辆驶往派送区域。' : '货物已到达转运中心，等待下一段运输。' });
    if (status === 'delivered') timeline.push({ status: 'delivered', at: at(-2, 20), text: '收货方已签收，交接件数与运输资料一致。' });
    if (status === 'cancelled') timeline.push({ status: 'cancelled', at: at(-1, 17), text: '取消申请已审核通过，运输安排已终止。' });
    return { id, quoteId, reference: 'PO-DEMO-' + number, demoScenario: demoScenarioVersion,
      date: day(-8), createdAt: at(-8, 15), shipment, details, rate, status, units: 'imperial',
      proNumber: status === 'ready' || status === 'cancelled' ? '' : 'DEMO-PRO-' + number,
      trackingEvents: timeline,
      ...(status === 'delivered' ? { deliveredAt: new Date(at(-2, 20)).toISOString(), podReceived: day(-1) } : {}),
      ...(mode === 'custom' ? { requirements: '两提两卸；每批货物仅对应一个提货点和一个送货点。', inquiryContact: { contact: '演示客户', email: 'shipping@example.com', phone: '+1 213 555 0100' } } : {}),
      rebills: [] };
  }));
  const byId = new Map(orders.map(order => [order.id, order]));
  const adjustment = (orderId, id, label, amount, issue, reason) => byId.get(orderId).rebills.push({ id, label, amount, issuedOn: day(issue), reason });
  adjustment('HYE-DEMO-204', 'RB-DEMO-201', '送货尾板费', 6500, 0, '现场使用了尾板卸货，原报价未包含该项服务。');
  adjustment('HYE-DEMO-203', 'RB-DEMO-202', '提货等候费', 4500, -4, '司机现场等待超过免费时长，请在申诉期限内核对交接记录。');
  adjustment('HYE-DEMO-202', 'RB-DEMO-203', '重量复核差额', 12800, -2, '承运商复核重量与申报不符，客户已提供称重资料，正在复核。');
  adjustment('HYE-DEMO-209', 'RB-DEMO-204', '预约送货费', 3500, -3, '已核实预约服务，客户提前确认扣款。');
  adjustment('HYE-DEMO-208', 'RB-DEMO-205', '限制进入服务费', 8500, -8, '送货场地属于限制进入地点，申诉期限已过，已完成演示扣款。');
  adjustment('HYE-DEMO-214', 'RB-DEMO-206', '装卸服务费', 9500, -7, '已扣款后客户补交现场资料，申诉仍在处理中。');
  adjustment('HYE-DEMO-213', 'RB-DEMO-207', '送货现场等候费', 5500, 0, '车辆在第二个送货点超出免费等候时长，请核对现场交接记录。');
  byId.get('HYE-DEMO-209').rebillPayments = { 'RB-DEMO-204': { id: 'DEMO-PAY-SCENARIO-204', total: 3500, collectedOn: day(-1), collectedAt: at(-1, 18), method: 'early', simulated: true } };
  byId.get('HYE-DEMO-214').rebillPayments = { 'RB-DEMO-206': { id: 'DEMO-PAY-SCENARIO-206', total: 9500, collectedOn: day(-2), collectedAt: at(-2, 17), method: 'early', simulated: true } };

  const ticket = (number, kind, orderId, status, subject, category, messages, extra = {}, start = -2) => {
    const createdAt = Math.min(at(start, 16), Date.now() - messages.length * 30 * 60000 - 60000);
    const entries = messages.map(([by, text, files], index) => ({ by, text, at: createdAt + index * 30 * 60000, ...(files ? { files } : {}) }));
    return { id: `${{ tickets: 'TK', disputes: 'BD', claims: 'CL' }[kind]}-DEMO-${number}`, demoScenario: demoScenarioVersion, kind, orderId, status, subject, category, ...extra, createdAt, updatedAt: entries.at(-1).at, messages: entries };
  };
  const tickets = [
    ticket(201, 'tickets', 'HYE-DEMO-201', 'pending', '确认明日提货安排', 'tracking', [
      ['customer', '这票货已打托完成，明天最早几点可以提货？'], ['system', '咨询已受理，等待客服接入。'], ['customer', '仓库营业时间为 9AM–5PM，请安排在这个时间段内到场。']
    ], {}, 0),
    ticket(202, 'tickets', 'HYE-DEMO-203', 'processing', '核对运输进度及预计送达时间', 'tracking', [
      ['customer', '收货仓库需要安排卸货，请确认目前运输节点和预计送达时间。'], ['support', '已向承运商查询，目前货物在转运中心，预计下一工作日离站。'],
      ['customer', '是否可以在送货前一天联系收货人？分机号为 202。'], ['support', '已记录提前联系要求，我们会继续跟进承运商反馈。'], ['system', '工单已转为处理中。'], ['customer', '谢谢，卸货区需要提前预留，请有更新后通知我。']
    ], {}, -1),
    ticket(203, 'tickets', 'HYE-DEMO-204', 'closed', '签收文件已回传，确认关闭', 'documents', [
      ['customer', '请帮忙提供这票货物的签收交接记录。'], ['support', '已补充演示签收交接文件，请在附件中查看。', [demoEvidence.delivery]], ['customer', '已下载并核对，件数一致，可以关闭。'], ['system', '客户已确认，工单已关闭。']
    ]),
    ticket(204, 'tickets', 'HYE-DEMO-202', 'processing', '请补充收货现场的卸货条件', 'stops', [
      ['customer', '收货方临时变更了卸货区域，请协助核对。'], ['support', '请确认新卸货区是否有卸货平台或叉车，是否需要尾板。'], ['system', '需要客户补充资料，运输订单暂未修改。']
    ], { customerActionRequired: true }),
    ticket(205, 'tickets', 'HYE-DEMO-201', 'pending', '收货联系电话修改申请', 'order-change', [
      ['customer', '请将收货现场联系电话修改为 +1 312 555 0199，分机 208。'], ['system', '修改申请已提交审核，原订单资料继续生效。']
    ], { orderChange: { side: 'destination', addressChange: false, result: 'pending', changes: [{ key: 'Phone', before: '+1 312 555 0102', after: '+1 312 555 0199' }, { key: 'PhoneExtension', before: '202', after: '208' }] } }),
    ticket(206, 'tickets', 'HYE-DEMO-206', 'closed', '提货交接码修改已审核通过', 'order-change', [
      ['customer', '请将提货交接码改为 PU-DEMO-206-V2。'], ['support', '已与发货仓库确认，申请审核通过。'], ['system', '提货交接码已更新为 PU-DEMO-206-V2。']
    ], { orderChange: { side: 'origin', addressChange: false, result: 'approved', changes: [{ key: 'Reference', before: 'PU-DEMO-206', after: 'PU-DEMO-206-V2' }] } }),
    ticket(207, 'tickets', 'HYE-DEMO-208', 'closed', '送货地址变更未通过审核', 'order-change', [
      ['customer', '希望将送货地址改到新的仓库。'], ['support', '新地址超出当前运输方案覆盖范围，需要重新核价。'], ['system', '本次修改申请审核未通过，原送货地址保留。']
    ], { orderChange: { side: 'destination', addressChange: true, result: 'rejected', changes: [{ key: 'address', before: byId.get('HYE-DEMO-208').shipment.destination, after: '220 Demo Road, Austin, TX 78701' }] } }),
    ticket(208, 'tickets', 'HYE-DEMO-211', 'closed', '客户已撤回取消订单申请', 'order-change', [
      ['customer', '收货计划临时调整，申请取消本次运输。'], ['support', '已收到，正在核对运输安排，审核前订单继续有效。'], ['customer', '收货计划恢复，请撤回取消申请。'], ['system', '取消申请已撤回，订单仍为待提货。']
    ], { orderChange: { side: 'cancel', status: 'ready', reason: '收货计划调整', result: 'pending' } }),
    ticket(209, 'tickets', 'HYE-DEMO-205', 'closed', '取消订单申请已审核通过', 'order-change', [
      ['customer', '货物尚未发出，现申请取消运输。'], ['support', '已确认尚未安排提货，取消申请审核通过。'], ['system', '订单状态已更新为已取消。']
    ], { orderChange: { side: 'cancel', status: 'ready', reason: '客户取消发货', result: 'approved' } }),
    ticket(210, 'tickets', 'HYE-DEMO-207', 'processing', '货物托盘数量修改申请', 'order-change', [
      ['customer', '请核实本票实际托盘数量，申请增加 2 个托盘。'], ['support', '已收到申请，正在核对提货记录及计价影响。'], ['system', '货物修改正在审核，原货物资料继续生效。']
    ], { orderChange: { side: 'cargo', result: 'pending', beforeItems: structuredClone(byId.get('HYE-DEMO-207').shipment.items),
      afterItems: byId.get('HYE-DEMO-207').shipment.items.map(item => ({ ...structuredClone(item), quantity: item.quantity + 2 })) } }),
    ticket(211, 'tickets', 'HYE-DEMO-202', 'pending', '已提货订单取消审核申请', 'order-change', [
      ['customer', '收货计划取消，希望申请终止运输。'], ['system', '取消申请已提交审核，订单当前状态保持已提货。'], ['customer', '请先核对是否已发出干线及可能产生的费用。']
    ], { orderChange: { side: 'cancel', status: 'picked', reason: '收货方取消采购', result: 'pending' } }),
    ticket(201, 'disputes', 'HYE-DEMO-204', 'pending', '尾板服务费核实申请', 'service', [
      ['customer', '收货仓库有卸货平台，为什么补收尾板费？请核对演示服务记录。', [demoEvidence.liftgate]], ['system', '账单申诉已提交，处理期间暂缓该笔补收扣款。'], ['customer', '仓库联系人可以配合提供现场说明。']
    ], { billId: 'RB-DEMO-201', charge: '送货尾板费' }, 0),
    ticket(202, 'disputes', 'HYE-DEMO-202', 'processing', '重量复核差额申诉', 'amount', [
      ['customer', '我方称重记录与承运商复核重量不同，请协助复核。'], ['support', '已要求承运商提供称重凭证，请补充出库称重记录。'], ['customer', '已请仓库准备相关资料。'], ['system', '申诉处理中，该笔补收暂缓扣款。']
    ], { billId: 'RB-DEMO-203', charge: '重量复核差额', customerActionRequired: true }, -1),
    ticket(203, 'disputes', 'HYE-DEMO-209', 'closed', '预约送货费用已核实', 'service', [
      ['customer', '请确认预约送货费的服务内容。'], ['support', '收货仓库要求预约时段，该费用对应本次预约服务。'], ['customer', '已确认服务使用情况，接受此项费用。'], ['system', '申诉已关闭，客户随后提前确认演示扣款。']
    ], { billId: 'RB-DEMO-204', charge: '预约送货费' }, -2),
    ticket(204, 'disputes', 'HYE-DEMO-214', 'processing', '已扣装卸费补充资料复核', 'amount', [
      ['customer', '这笔装卸费已扣款，我补充现场资料申请复核。'], ['support', '已收到，扣款记录会保留，我们正在向承运商核对。'], ['customer', '请一并核对服务记录中的托盘数量。'], ['system', '已扣款后的申诉进入处理中，处理结果待反馈。']
    ], { billId: 'RB-DEMO-206', charge: '装卸服务费' }, -1),
    ticket(201, 'claims', 'HYE-DEMO-204', 'pending', '两箱外包装破损索赔申请', 'damage', [
      ['customer', '签收时发现两箱外包装破损，申请核查货损。', [demoEvidence.damage]], ['system', '运输索赔已受理，等待客服审核。'], ['customer', '货物和包装均已保留，可以配合后续检查。']
    ], { requestedAmount: 38000 }, 0),
    ticket(202, 'claims', 'HYE-DEMO-209', 'processing', '签收短少一箱，请协助调查', 'shortage', [
      ['customer', '发货记录为 24 箱，现场只收到 23 箱，申请短少调查。'], ['support', '已向承运商发起查询，请保留装箱单和现场交接记录。'], ['customer', '收货方已逐箱清点，确认仍少一箱。'], ['support', '承运商正在核对中转站交接记录，后续会在此工单更新。'], ['system', '运输索赔处理中。']
    ], { requestedAmount: 16500 }),
    ticket(203, 'claims', 'HYE-DEMO-214', 'closed', '货损索赔已完成处理', 'damage', [
      ['customer', '货物到达后发现部分包装压损，申请核查。'], ['support', '已收到相关资料，正在核实运输交接情况。'], ['customer', '与收货方复核后，确认货品本身完好，无需继续索赔。'], ['system', '客户确认撤回，本次索赔已关闭，未产生赔付款。']
    ], { requestedAmount: 22000 }),
    ticket(204, 'claims', 'HYE-DEMO-208', 'processing', '货物长时间无更新，申请丢失调查', 'loss', [
      ['customer', '这票货物未按原计划送达，申请核查货物所在位置。'], ['support', '已发起运输追查，请提供货物外包装特征和装箱资料。'], ['customer', '货物为蓝色缠绕膜包装，托盘标签已提供给发货仓库核对。'], ['system', '承运商调查中，尚未确认丢失及赔付结果。']
    ], { requestedAmount: 185000 })
  ];
  byId.get('HYE-DEMO-206').details.originReference = 'PU-DEMO-206-V2';
  return { orders, tickets };
}
