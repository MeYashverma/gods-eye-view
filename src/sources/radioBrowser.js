/**
 * Radio Browser adapter — a community database of internet radio streams.
 *
 * Two separate concerns are kept apart deliberately: the *station list* is a
 * JSON API with an open CORS policy, but *playing a stream* depends on the
 * individual broadcaster. Many streams refuse cross-origin playback, are
 * offline, or use codecs the browser cannot decode. The player therefore
 * reports per-station playback failures instead of leaving the UI implying
 * that audio is coming.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

const SERVERS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://all.api.radio-browser.info',
]);

export function normalizeStation(entry) {
  const lat = toNumber(entry?.geo_lat);
  const lon = toNumber(entry?.geo_long);
  if (lat === null || lon === null) return null;
  const name = String(entry?.name || '').trim();
  if (!name) return null;
  return {
    id: `radio:${entry.stationuuid || name}`,
    name,
    lat,
    lon,
    url: entry?.url_resolved || entry?.url || null,
    homepage: entry?.homepage || null,
    favicon: entry?.favicon || null,
    country: entry?.country || null,
    countryCode: entry?.countrycode || null,
    state: entry?.state || null,
    language: entry?.language || null,
    tags: String(entry?.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8),
    codec: entry?.codec || null,
    bitrateKbps: toNumber(entry?.bitrate) || null,
    clicks: toNumber(entry?.clickcount) || 0,
    votes: toNumber(entry?.votes) || 0,
    lastCheckOk: entry?.lastcheckok === '1' || entry?.lastcheckok === 1,
    lastCheckTime: entry?.lastchecktime_iso || null,
  };
}

export function normalizeStations(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of payload) {
    const station = normalizeStation(entry);
    if (!station || seen.has(station.id)) continue;
    seen.add(station.id);
    out.push(station);
  }
  return out;
}

export function stationSearchUrl(server, { limit = 1500 } = {}) {
  const url = new URL(`${server}/json/stations/search`);
  url.searchParams.set('hidebroken', 'true');
  url.searchParams.set('has_geo_info', 'true');
  url.searchParams.set('order', 'clickcount');
  url.searchParams.set('reverse', 'true');
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

/**
 * Client-side viewport filter — the API has no bounding-box parameter.
 *
 * A box whose west edge is greater than its east edge spans the antimeridian.
 * Collapsing that with min/max would silently exclude every station near the
 * date line, so the two cases are handled separately.
 */
export function filterByBox(stations, box) {
  if (!box) return stations;
  const { south, north } = box;
  const wraps = box.west > box.east;
  const inLongitude = wraps
    ? (lon) => lon >= box.west || lon <= box.east
    : (lon) => lon >= box.west && lon <= box.east;
  return stations.filter(
    (station) => station.lat >= south && station.lat <= north && inLongitude(station.lon),
  );
}

export async function fetchStations({ signal, limit = 1500, servers = SERVERS } = {}, client = http) {
  let lastError = null;
  for (const server of servers) {
    try {
      const { data } = await client.json(stationSearchUrl(server, { limit }), {
        signal,
        timeoutMs: 25_000,
        cacheMs: 30 * 60 * 1000,
        staleMs: 6 * 60 * 60 * 1000,
        retries: 0,
      });
      const stations = normalizeStations(data);
      if (stations.length) return { records: stations, server, fetchedAt: Date.now() };
      lastError = new Error('Radio Browser answered with no stations');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No Radio Browser server responded');
}

/**
 * Whether a stream is even worth attempting in this browser. This is a
 * best-effort filter — the only reliable test is trying to play it.
 */
export function playbackOutlook(station) {
  if (!station?.url) return { playable: false, reason: 'No stream URL published' };
  if (!station.lastCheckOk) {
    return { playable: true, reason: 'Last community health check failed — may be offline' };
  }
  return { playable: true, reason: null };
}
