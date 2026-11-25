import test from 'node:test';
import assert from 'node:assert/strict';

test('ticket detail renders customer, support and system messages as distinct chat rows', async () => {
  globalThis.document = { addEventListener() {} };
  const { ticketConversationPanel } = await import('../oms/views.js').finally(() => { delete globalThis.document; });
  const html = ticketConversationPanel({
    id: 'TK-TEST-1', subject: '送达时间', category: 'tracking', status: 'pending',
    messages: [
      { by: 'customer', text: '请确认日期', at: Date.parse('2026-11-24T16:00:00Z') },
      { by: 'support', text: '预计周三送达', at: Date.parse('2026-11-24T18:00:00Z') },
      { by: 'system', text: '工单已重新打开', at: Date.parse('2026-11-24T19:00:00Z') }
    ]
  });

  assert.match(html, /ticket-chat-dock/);
  assert.match(html, /ticket-chat-row-customer/);
  assert.match(html, /ticket-chat-row-support/);
  assert.match(html, /ticket-chat-row-system/);
  assert.match(html, /aria-label="工单沟通消息"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /ticket-chat-composer/);
  assert.match(html, /data-action="close-ticket"/);
  assert.match(html, /发送回复/);
  assert.match(html, /datetime="2026-11-24T16:00:00\.000Z"/);
});

test('closed ticket keeps the conversation and hides the reply composer', async () => {
  globalThis.document = { addEventListener() {} };
  const { ticketConversationPanel } = await import('../oms/views.js').finally(() => { delete globalThis.document; });
  const html = ticketConversationPanel({
    id: 'TK-TEST-2', subject: '账单咨询', category: 'billing', status: 'closed',
    messages: [{ by: 'system', text: '工单已关闭', at: Date.parse('2026-11-24T19:00:00Z') }]
  });

  assert.match(html, /工单已关闭/);
  assert.doesNotMatch(html, /ticket-chat-composer/);
});

test('ticket inspector keeps conversation and application details in separate accessible tabs', async () => {
  globalThis.document = { addEventListener() {} };
  const { ticketDetail } = await import('../oms/views.js').finally(() => { delete globalThis.document; });
  const html = ticketDetail({
    id: 'TK-TEST-3', subject: '确认预计送达时间', category: 'tracking', status: 'pending',
    messages: [{ by: 'customer', text: '请确认日期', at: Date.parse('2026-11-24T16:00:00Z'), files: [{ id: 'FILE-TEST-1', name: '提货凭证.pdf' }] }]
  }, { id: 'HYE-DEMO-103', shipment: { origin: 'Los Angeles', destination: 'Chicago' } }, '', 'tickets', null, null, 'details');

  assert.match(html, /确认预计送达时间/);
  assert.match(html, /HYE-DEMO-103/);
  assert.match(html, /id="ticket-tab-details" role="tab" aria-selected="true"/);
  assert.match(html, /id="ticket-panel-conversation"[^>]* hidden/);
  assert.doesNotMatch(html, /id="ticket-panel-details"[^>]* hidden/);
  assert.doesNotMatch(html, /id="ticket-(?:tab|panel)-files"/);
  assert.match(html.slice(html.indexOf('id="ticket-panel-details"')), /相关附件[\s\S]*data-action="download-evidence" data-id="FILE-TEST-1"/);
  assert.equal((html.match(/id="ticket-reply-form"/g) ?? []).length, 1);
});

test('the conversation panel collapses while keeping a control to reopen it', async () => {
  globalThis.document = { addEventListener() {} };
  const { ticketConversationPanel } = await import('../oms/views.js').finally(() => { delete globalThis.document; });
  const ticket = { id: 'TK-TEST-4', subject: '文件回单', category: 'documents', status: 'pending', messages: [] };
  const html = ticketConversationPanel(ticket, true);

  assert.match(html, /ticket-chat-dock-collapsed/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /展开沟通对话/);
  assert.doesNotMatch(html, /ticket-chat-history/);
});
