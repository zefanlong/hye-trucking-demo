export function quoteProvider(config = globalThis.HYE_WARP_CONFIG) {
  return config?.quoteMode === 'warp' ? 'warp' : 'demo';
}

export function localQuoteConfig(checkoutEnabled, keyConfigured) {
  return { gatewayUrl: '', quoteMode: checkoutEnabled && keyConfigured ? 'warp' : 'demo' };
}
