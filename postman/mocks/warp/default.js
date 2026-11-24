// Contract stand-in, not WARP Sandbox. No real carrier or payment is contacted.
const http = require('http');
const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/api/v1/freights/quote') return send(501, { code: 'NOT_MODELED' });
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    let body; try { body = JSON.parse(text); } catch { return send(400, { code: 'INVALID_JSON' }); }
    if (req.headers.apikey !== 'test-server-key' || req.headers.authorization) return send(401, { code: 'request_unauthorized' });
    if (!body.pickupInfo?.zipcode || !body.deliveryInfo?.zipcode || !body.pickupDate || !body.listItems?.length || body.listItems.some(i => !i.quantity || !i.totalWeight || !i.length || !i.width || !i.height || i.sizeUnit !== 'IN' || i.weightUnit !== 'lbs')) return send(400, { code: 'required_field_missing' });
    const fault = req.headers['x-mock-response-code'];
    if (fault === '429') return send(429, { code: 'rate_limit_exceeded' });
    if (fault === '502') { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>unavailable</html>'); return; }
    if (fault === '400') return send(400, { code: 'invalid_field_data' });
    if (fault === '200-invalid') return send(200, { price_usd: 0 });
    const data = { quote_id: 'MOCK_V2_REFERENCE', shipmentType: fault === 'substitution' ? 'FTL' : 'LTL',
      price: { amount: 188.6526125, currency_code: 'USD' }, transit_time: 3,
      estimated_delivery_date: null, expiration_time_utc: Math.floor(Date.now()/1000) + 3600, status: 'ACCEPT',
      charges: [{ code: 'TOTAL', description: 'Total rate', amount: 188.6526125 }, { code: 'TRANSIT', description: 'Transit Cost', amount: 159.5 }, { code: 'SERVICE_OPTION', description: 'fuel_surcharge', amount: 29.1526125 }] };
    send(200, data);
  });
});
server.listen(process.env.PORT || 4500);
