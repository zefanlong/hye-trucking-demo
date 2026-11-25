import test from 'node:test';
import assert from 'node:assert/strict';
import { localQuoteConfig, quoteProvider } from '../oms/quote-provider.js';

test('static GitHub Pages configuration stays on demo quotes', () => {
  assert.equal(quoteProvider({ gatewayUrl: '' }), 'demo');
  assert.equal(quoteProvider({ gatewayUrl: 'https://quotes.example.workers.dev' }), 'demo');
});

test('the local sandbox opts in to WARP quotes explicitly', () => {
  assert.equal(quoteProvider({ gatewayUrl: '', quoteMode: 'warp' }), 'warp');
  assert.equal(quoteProvider({ gatewayUrl: 'https://quotes.example.workers.dev', quoteMode: 'warp' }), 'warp');
});

test('the local service uses WARP only when checkout and its server key are configured', () => {
  assert.equal(localQuoteConfig(false, true).quoteMode, 'demo');
  assert.equal(localQuoteConfig(true, false).quoteMode, 'demo');
  assert.equal(localQuoteConfig(true, true).quoteMode, 'warp');
});
