/**
 * USGS earthquake adapter.
 *
 * Uses the FDSN event query API rather than the fixed summary feeds because it
 * accepts a bounding box and a magnitude floor, so a zoomed-in view asks for
 * the events actually in view instead of downloading the whole planet and
 * filtering client-side.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

const ENDPOINT = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

export const TIME_RANGES = Object.freeze([
  { id: 'day', label: '24 h', hours: 24, minMagnitude: 2.5 },
  { id: 'week', label: '7 d', hours: 24 * 7, minMagnitude: 2.5 },
  { id: 'month', label: '30 d', hours: 24 * 30, minMagnitude: 3.0 },
  { id: 'year', label: '365 d', hours: 24 * 365, minMagnitude: 4.5 },
]);

export function magnitudeColor(mag) {
  const value = toNumber(mag) ?? 0;
  if (value >= 7) return '#f43f5e';
  if (value >= 6) return '#fb7185';
  if (value >= 5) return '#f97316';
  if (value >= 4) return '#facc15';
  if (value >= 3) return '#a3e635';
  return '#38bdf8';
}

/** Marker radius in metres, scaled by magnitude so M7 dominates an M2. */
export function magnitudeRadiusM(mag, scale = 1) {
  const value = Math.max(0, toNumber(mag) ?? 0);
  return Math.round(18_000 * 2 ** (value - 3) * scale);
}

export function isoHoursAgo(hours, from = new Date()) {
  const date = new Date(from.getTime() - hours * 3600 * 1000);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert one GeoJSON Feature into the app's earthquake record shape.
 * Pure, so the parser is covered by unit tests with a captured payload.
 */
export function normalizeEarthquake(feature) {
  const geometry = feature?.geometry;
  const props = feature?.properties || {};
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;
  const [lon, lat, depth] = geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const mag = toNumber(props.mag);
  return {
    id: String(props.code || props.net || `${lat},${lon}`),
    lat,
    lon,
    depthKm: Number.isFinite(depth) ? depth : null,
    mag,
    magType: props.magType || null,
    place: props.place || 'Unknown location',
    time: toNumber(props.time),
    updated: toNumber(props.updated),
    felt: toNumber(props.felt),
    tsunami: props.tsunami === 1,
    alert: props.alert || null,
    cdi: toNumber(props.cdi),
    mmi: toNumber(props.mmi),
    url: props.url || null,
    net: props.net || null,
    nst: toNumber(props.nst),
    rms: toNumber(props.rms),
    gap: toNumber(props.gap),
    title: props.title || null,
  };
}

export function normalizeEarthquakeFeed(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const records = [];
  for (const feature of features) {
    const record = normalizeEarthquake(feature);
    if (record) records.push(record);
  }
  records.sort((a, b) => (b.time || 0) - (a.time || 0));
  return records;
}

/**
 * @param {object} query
 * @param {number} [query.hours]
 * @param {number} [query.minMagnitude]
 * @param {{south:number,west:number,north:number,east:number}} [query.box]
 */
export async function fetchEarthquakes(
  { hours = 24, minMagnitude = 2.5, box = null, limit = 800, signal } = {},
  client = http,
) {
  const params = new URLSearchParams({
    format: 'geojson',
    starttime: isoHoursAgo(hours),
    minmagnitude: String(minMagnitude),
    orderby: 'time-asc',
    limit: String(limit),
  });
  if (box) {
    // USGS rejects boxes that cross the antimeridian, so clamp rather than
    // send a request that would 400 and look like a provider failure.
    const west = Math.min(box.west, box.east);
    const east = Math.max(box.west, box.east);
    params.set('minlatitude', clampLat(box.south));
    params.set('maxlatitude', clampLat(box.north));
    params.set('minlongitude', String(west.toFixed(3)));
    params.set('maxlongitude', String(east.toFixed(3)));
  }

  const { data, meta } = await client.json(`${ENDPOINT}?${params}`, {
    signal,
    timeoutMs: 20_000,
    cacheMs: 60_000,
    retries: 2,
  });
  const records = normalizeEarthquakeFeed(data);
  return { records, fetchedAt: Date.now(), meta, count: records.length };
}

function clampLat(value) {
  return String(Math.max(-90, Math.min(90, Number(value) || 0)).toFixed(3));
}
