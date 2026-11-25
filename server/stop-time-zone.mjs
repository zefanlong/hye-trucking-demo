import { readFileSync } from 'node:fs';
import { find } from 'geo-tz/now';

const zipPoints = JSON.parse(readFileSync(new URL('../assets/us-zip-locations.json', import.meta.url), 'utf8'));
const localities = readFileSync(new URL('../oms/map-data/zip-localities.tsv', import.meta.url), 'utf8');
const zipStates = new Map();
const cityZipCodes = new Map();
const cityKey = (city, state) => city.toLowerCase().replace(/[.\s]+/g, '') + ',' + state;

for (const row of localities.split('\n')) {
  const [zip, city, state] = row.split('\t');
  if (!/^\d{5}$/.test(zip) || !city || !state) continue;
  if (!zipStates.has(zip)) zipStates.set(zip, new Set());
  zipStates.get(zip).add(state);
  const key = cityKey(city, state);
  if (!cityZipCodes.has(key)) cityZipCodes.set(key, new Set());
  cityZipCodes.get(key).add(zip);
}

function zipTimeZone(zip) {
  const point = zipPoints[zip];
  if (!point) return undefined;
  // Coastal ZIP centroids can fall in the water, where the lookup reports a nautical zone.
  const zones = find(...point).filter(zone => !zone.startsWith('Etc/'));
  return zones.length === 1 ? zones[0] : undefined;
}

export function stopTimeZone({ zipcode, city, state }) {
  if (!zipStates.get(zipcode)?.has(state)) return undefined;
  const zone = zipTimeZone(zipcode);
  if (zone) return zone;
  const cityZips = cityZipCodes.get(cityKey(city, state));
  if (!cityZips?.has(zipcode)) return undefined;
  // Some ZIPs have no geographic point. Use the matching city only when its located ZIPs agree.
  const cityZones = new Set([...cityZips].map(zipTimeZone).filter(Boolean));
  return cityZones.size === 1 ? cityZones.values().next().value : undefined;
}
