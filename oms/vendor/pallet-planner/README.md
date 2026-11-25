# Pallet & Load Planner core

Vendored from the user's https://zefanlong.space/tool/pallet/ project on 2026-11-25.
The deployed `truck-ui.js` imports `shared/truck-loading.js`, which exports
`calculateTruckLoading` and the planning presets used by OMS.

The algorithm files and their dependency closure are preserved. The only source
normalization removes deployment cache query strings from relative JS imports.
See `provenance.json` for original URLs and SHA-256 hashes before normalization.
The bundled binpackingjs MIT license is retained beside that dependency.

OMS's `load-space.js` adapts shipment handling units to pallet groups with
`maxLayers: 1`, `allowRotation: true`, `allowMixedStacking: false` and
`preferSimpleLayout: true`. It draws the returned placements directly, uses the
same result for displayed linear feet, and reports partial loads and the upstream
30-group/200-piece limit. Dry van and box truck dimensions/payload are the
upstream editable reference presets, not manufacturer-specific specifications.
Other FTL vehicle types have no applicable preset and are shown as unsupported.
No customer shipment data is sent to the external tool.
