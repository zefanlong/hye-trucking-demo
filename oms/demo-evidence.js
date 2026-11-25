// Bundled, clearly labelled demonstration attachments; no supplier documents.
export const demoEvidence = {
  liftgate: { id: 'DEMO-EVIDENCE-LIFTGATE-1', name: '演示_尾板服务记录.pdf' },
  damage: { id: 'DEMO-EVIDENCE-DAMAGE-1', name: '演示_货损检查记录.pdf' },
  delivery: { id: 'DEMO-EVIDENCE-DELIVERY-1', name: '演示_签收交接记录.pdf' }
};

export function demoEvidenceBlob(id) {
  const key = Object.keys(demoEvidence).find(key => demoEvidence[key].id === id);
  if (!key) return null;
  const text = {
    liftgate: ['Liftgate service record', 'Demo shipment: HYE-DEMO-204', 'Service: delivery liftgate', 'Sample additional charge: USD 65.00'],
    damage: ['Cargo inspection record', 'Demo shipment: HYE-DEMO-204', 'Finding: two cartons with damaged outer packaging', 'Customer requested review of the sample cargo claim.'],
    delivery: ['Delivery handoff record', 'Demo shipment: HYE-DEMO-204', 'Received: two pallets, eight hundred pounds', 'Sample handoff completed.']
  }[key];
  const lines = ['HYE Freight - DEMONSTRATION DOCUMENT', ...text, 'For interface preview only. Not a carrier-issued document.'];
  const stream = `BT /F1 14 Tf 50 770 Td ${lines.map((line, index) => `${index ? '0 -28 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}
