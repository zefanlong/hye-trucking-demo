// Contract stand-in, not WARP Sandbox. No real carrier or payment is contacted.
const http = require('http');
const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || !['/api/v1/freights/quote', '/api/v1/freights/freight-quote', '/api/v1/freights/book', '/api/v1/freights/booking'].includes(req.url)) return send(501, { code: 'NOT_MODELED' });
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    let body; try { body = JSON.parse(text); } catch { return send(400, { code: 'INVALID_JSON' }); }
    if (req.headers.apikey !== 'test-server-key' || req.headers.authorization) return send(401, { code: 'request_unauthorized' });
    if (req.url.endsWith('/book') || req.url.endsWith('/booking')) {
      const marketBook = req.url.endsWith('/book');
      const items = marketBook ? body.items : body.listItems;
      if (!body.quoteId || !items?.length || !body.pickupInfo?.contactPhone || !body.deliveryInfo?.contactPhone || !body.pickupInfo.address.street || !body.pickupInfo[marketBook ? 'timeWindow' : 'windowTime']) return send(400, { code: 'invalid_field_data' });
      if (body.quoteId === 'MOCK_CARD_FAIL') return send(402, { code: 'CHARGE_FAILED' });
      if (body.quoteId === 'MOCK_500') return send(500, { code: 'internal_server_error' });
      return send(200, { orderId: 'TEST_ORDER_' + body.quoteId, proNumber: 'P-SANDBOX', shipmentIds: ['S-SANDBOX'], trackingNumber: 'TEST_TRACK', ...(body.quoteId === 'MOCK_PAYMENT_REQUIRED' ? { paymentLink: 'https://customer.wearewarp.com/dashboard/pay-orders', message: 'Add funds' } : { payment: { method: 'card', amount_charged: 188.65, card_fee: 0, last4: '4242' } }) });
    }
    const market = req.url.endsWith('/freight-quote');
    const items = market ? body.items : body.listItems;
    if (!body.pickupInfo?.zipcode || !body.deliveryInfo?.zipcode || !body.pickupDate || !items?.length || items.some(i => !i.quantity || !i.totalWeight || !i.length || !i.width || !i.height || i.sizeUnit !== 'IN' || i.weightUnit !== 'lbs')) return send(400, { code: 'required_field_missing' });
    const fault = req.headers['x-mock-response-code'];
    if (fault === '429') return send(429, { code: 'rate_limit_exceeded' });
    if (fault === '502') { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>unavailable</html>'); return; }
    if (fault === '400') return send(400, { code: 'invalid_field_data' });
    if (fault === '200-invalid') return send(200, { price_usd: 0 });
    const data = { quote_id: 'MOCK_V2_REFERENCE', shipmentType: fault === 'substitution' ? 'FTL' : 'LTL',
      price: { amount: 188.6526125, currency_code: 'USD' }, transit_time: 3,
      estimated_delivery_date: null, expiration_time_utc: Math.floor(Date.now()/1000) + 3600, status: 'ACCEPT',
      charges: [{ code: 'TOTAL', description: 'Total rate', amount: 188.6526125 }, { code: 'TRANSIT', description: 'Transit Cost', amount: 159.5 }, { code: 'SERVICE_OPTION', description: 'fuel_surcharge', amount: 29.1526125 }] };
    if (!market) return send(200, data);
    const option = { source: 'WARP', id: 'MOCK_V2_REFERENCE', carrierCode: 'WTCH', carrierName: 'Warp Technology', shipmentType: data.shipmentType, rate: 188.6526125, currency: 'USD', transitTime: 259200, expirationTs: Date.now() + 3600000, serviceLevel: 'STANDARD', serviceCharges: data.charges.filter(c => c.code !== 'TOTAL') };
    send(200, { options: [option, { ...option, source: 'WWEX', id: 'MOCK_XPO_REFERENCE', carrierCode: 'CNWY', carrierName: 'XPO Logistics', rate: 300, transitTime: 172800, serviceCharges: [{ code: 'TRANSIT', amount: 300 }] }] });
  });
});
server.listen(process.env.PORT || 4500);
