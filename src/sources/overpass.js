/**
 * Overpass API adapter — OpenStreetMap's query endpoint.
 *
 * Used for mapped infrastructure (data centres, dams, substations, military
 * areas) and for camera locations. Mapped features are statements about the
 * world made by volunteers; they are not proof that something is operating
 * today, and the UI says so.
 *
 * Public Overpass instances are shared and rate-limited, so the adapter
 * spaces requests, caches aggressively, and fails over to a mirror before
 * reporting an error.
 */

import { http } from '../net/http.js';
import { overpassBBox } from '../geo/coords.js';

export const OVERPASS_MIRRORS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]);

/** Wrap a selector list into a bounded, timeout-protected Overpass query. */
export function buildQuery(selectors, box, { timeout = 25, limit = 600 } = {}) {
  const bbox = overpassBBox(box);
  const body = selectors
    .map((selector) => `nwr${selector}(${bbox});`)
    .join('\n  ');
  return `[out:json][timeout:${timeout}];
(
  ${body}
);
out center tags ${limit};`;
}

/**
 * Flatten Overpass's mixed node/way/relation output into point records.
 * Ways and relations carry a computed `center`; nodes carry lat/lon directly.
 */
export function normalizeOverpass(payload, { prefix = 'osm' } = {}) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const records = [];
  for (const element of elements) {
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tags = element.tags || {};
    records.push({
      id: `${prefix}:${element.type}/${element.id}`,
      osmType: element.type,
      osmId: element.id,
      lat,
      lon,
      name: tags.name || tags.operator || null,
      tags,
    });
  }
  return records;
}

/**
 * Run a query against the mirror chain. The first instance that answers wins;
 * its index is returned so the client can stick with it for a while instead of
 * hammering the primary from scratch each time.
 */
export async function queryOverpass(
  query,
  { signal, mirrors = OVERPASS_MIRRORS, client = http, preferIndex = 0, cacheMs = 30 * 60 * 1000 } = {},
) {
  const order = [...mirrors.slice(preferIndex), ...mirrors.slice(0, preferIndex)];
  let lastError = null;
  for (let index = 0; index < order.length; index += 1) {
    const endpoint = order[index];
    try {
      const body = new URLSearchParams({ data: query });
      const { data } = await client.json(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal,
        timeoutMs: 35_000,
        retries: 0, // the mirror chain is the retry strategy
        cacheMs,
        minIntervalMs: 2_000,
      });
      return { payload: data, endpoint, index: mirrors.indexOf(endpoint) };
    } catch (error) {
      lastError = error;
      // A CORS or 4xx refusal means this instance will not help us; move on.
    }
  }
  throw lastError || new Error('No Overpass instance responded');
}

export async function fetchFeatures(
  selectors,
  box,
  { signal, prefix = 'osm', limit = 600, preferIndex = 0, cacheMs } = {},
  client = http,
) {
  const query = buildQuery(selectors, box, { limit });
  const result = await queryOverpass(query, { signal, client, preferIndex, cacheMs });
  const records = normalizeOverpass(result.payload, { prefix });
  return {
    records,
    endpoint: result.endpoint,
    index: result.index,
    fetchedAt: Date.now(),
    count: records.length,
  };
}
