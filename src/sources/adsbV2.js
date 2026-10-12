/**
 * ADS-B adapter.
 *
 * The honest constraint: every public ADS-B API (adsb.lol, adsb.fi,
 * airplanes.live, OpenSky) answers HTTP requests but sends no
 * `Access-Control-Allow-Origin` header. A browser therefore cannot read them
 * from a static origin, and no amount of client-side code changes that. The
 * reference implementation reaches adsb.lol through its own Node proxy; this
 * project has no server.
 *
 * So the layer supports what a static site legitimately can:
 *   1. a user-supplied endpoint that does send CORS headers (their own
 *      proxy, or a readsb/tar1090 receiver on their own network), and
 *   2. a clearly-labelled sample feed so the rendering, filtering and
 *      tracking paths are real and testable without pretending to be live.
 *
 * Both speak the same v2/readsb record shape, and the parser below is shared.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

export const ADSB_PRESETS = Object.freeze([
  {
    id: 'adsb-lol',
    label: 'adsb.lol point query',
    template: 'https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radiusNm}',
    cors: false,
    note: 'No CORS header — will be blocked from a static site unless you proxy it.',
  },
  {
    id: 'local-readsb',
    label: 'Local readsb / tar1090',
    template: 'http://{host}/data/aircraft.json',
    cors: true,
    note: 'A receiver you run yourself. Enable CORS on it, or browse from the same origin.',
  },
  {
    id: 'custom',
    label: 'Custom v2-compatible URL',
    template: '',
    cors: true,
    note: 'Anything returning readsb/tar1090 v2 JSON with an Access-Control-Allow-Origin header.',
  },
]);

const KNOT_TO_MS = 0.514444;
const FOOT_TO_M = 0.3048;
const FPM_TO_MS = 0.00508;

const EMITTER_CATEGORY = Object.freeze({
  A1: 2, A2: 3, A3: 4, A4: 5, A5: 6, A6: 7, A7: 8,
  B1: 9, B2: 10, B3: 11, B4: 12, B6: 14, B7: 15,
  C1: 17, C2: 18, C3: 19, D1: 25,
});

/** "A1", "B2" ... -> the numeric ICAO emitter category. */
export function emitterCategory(value) {
  return EMITTER_CATEGORY[String(value || '').trim().toUpperCase()] ?? 0;
}

/**
 * Normalise one readsb/v2 aircraft record.
 * @returns {object|null} null when the record cannot be placed on the globe.
 */
export function normalizeAircraft(aircraft, nowSeconds) {
  const hex = String(aircraft?.hex || '').trim().toLowerCase();
  const lat = toNumber(aircraft?.lat);
  const lon = toNumber(aircraft?.lon ?? aircraft?.lon_r);
  if (!hex || lat === null || lon === null) return null;

  const seenPos = Math.max(0, toNumber(aircraft?.seen_pos) ?? toNumber(aircraft?.seen) ?? 0);
  const onGround = aircraft?.alt_baro === 'ground' || aircraft?.alt_baro === 0;
  const baroFeet = onGround ? null : toNumber(aircraft?.alt_baro);
  const geomFeet = toNumber(aircraft?.alt_geom);
  const altitudeM = baroFeet === null ? (geomFeet === null ? null : geomFeet * FOOT_TO_M) : baroFeet * FOOT_TO_M;
  const gsKt = toNumber(aircraft?.gs);
  const track = toNumber(aircraft?.track ?? aircraft?.true_track);
  const verticalFpm = toNumber(aircraft?.baro_rate) ?? toNumber(aircraft?.geom_rate);

  return {
    id: `adsb:${hex}`,
    hex,
    callsign: String(aircraft?.flight || aircraft?.r || '').trim() || null,
    registration: aircraft?.r || null,
    aircraftType: aircraft?.t || null,
    lat,
    lon,
    altitudeM,
    altitudeSource: baroFeet !== null ? 'barometric' : geomFeet !== null ? 'geometric' : null,
    onGround,
    speedMs: gsKt === null ? null : gsKt * KNOT_TO_MS,
    trackDeg: track,
    verticalRateMs: verticalFpm === null ? null : verticalFpm * FPM_TO_MS,
    squawk: aircraft?.squawk ? String(aircraft.squawk) : null,
    emergency: aircraft?.emergency || null,
    category: aircraft?.category || null,
    emitterCategory: emitterCategory(aircraft?.category),
    military: Boolean(aircraft?.military),
    source: aircraft?.mlat?.length ? 'multilateration' : 'adsb',
    seenSecondsAgo: seenPos,
    observedAt: nowSeconds ? (nowSeconds - seenPos) * 1000 : Date.now(),
  };
}

/**
 * Normalise a whole v2 response.
 * @param {object} payload readsb/tar1090/adsb.lol response
 */
export function normalizeAircraftFeed(payload) {
  const rawNow = toNumber(payload?.now);
  const nowSeconds =
    rawNow === null ? Math.floor(Date.now() / 1000) : Math.floor(rawNow > 1e10 ? rawNow / 1000 : rawNow);
  const list = Array.isArray(payload?.ac) ? payload.ac : Array.isArray(payload?.aircraft) ? payload.aircraft : [];
  const records = [];
  for (const entry of list) {
    const record = normalizeAircraft(entry, nowSeconds);
    if (record) records.push(record);
  }
  return { records, feedTime: nowSeconds * 1000, total: toNumber(payload?.total) ?? records.length };
}

export function buildEndpointUrl(template, { lat, lon, radiusNm = 250, host = '' } = {}) {
  return String(template || '')
    .replace('{lat}', Number(lat).toFixed(4))
    .replace('{lon}', Number(lon).toFixed(4))
    .replace('{radiusNm}', String(Math.round(radiusNm)))
    .replace('{host}', encodeURIComponent(host));
}

export async function fetchAircraft({ endpoint, lat, lon, radiusNm = 250, signal }, client = http) {
  if (!endpoint) {
    const error = new Error('No ADS-B endpoint configured');
    error.kind = 'config';
    throw error;
  }
  const url = buildEndpointUrl(endpoint, { lat, lon, radiusNm });
  const { data } = await client.json(url, {
    signal,
    timeoutMs: 15_000,
    retries: 1,
  });
  return { ...normalizeAircraftFeed(data), fetchedAt: Date.now() };
}

/**
 * The sample feed. Every record is synthesised and the layer that uses it
 * reports status `SIMULATED`, which the UI renders as a distinct
 * "SAMPLE DATA" badge. Nothing here is presented as an observation.
 */
export function createSampleFeed({ lat = 40.7128, lon = -74.006, count = 42, seed = 1 } = {}) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const callsigns = ['UAL', 'DAL', 'AAL', 'SWA', 'JBU', 'FDX', 'UPS', 'NKS', 'ASA', 'BAW', 'AFR', 'DLH'];
  const types = ['A320', 'B738', 'B77W', 'A321', 'B739', 'E75L', 'CRJ9', 'A359'];
  const now = Math.floor(Date.now() / 1000);
  const ac = [];
  for (let index = 0; index < count; index += 1) {
    const bearing = random() * Math.PI * 2;
    const radius = (random() ** 0.6) * 3.2; // degrees
    const altitude = Math.round(2000 + random() * 38000);
    ac.push({
      hex: (0xa00000 + Math.floor(random() * 0xfffff)).toString(16),
      flight: `${callsigns[Math.floor(random() * callsigns.length)]}${100 + Math.floor(random() * 8999)} `,
      r: null,
      t: types[Math.floor(random() * types.length)],
      lat: lat + Math.sin(bearing) * radius,
      lon: lon + (Math.cos(bearing) * radius) / Math.max(0.2, Math.cos((lat * Math.PI) / 180)),
      alt_baro: random() > 0.9 ? 'ground' : altitude,
      gs: Math.round(180 + random() * 320),
      track: Math.round(random() * 359),
      baro_rate: Math.round((random() - 0.5) * 3200),
      squawk: String(1000 + Math.floor(random() * 6999)),
      category: ['A3', 'A5', 'B2', 'B6'][Math.floor(random() * 4)],
      seen_pos: Math.round(random() * 12),
      seen: Math.round(random() * 12),
      mlat: [],
      military: index % 17 === 0,
    });
  }
  return { now, ac, total: ac.length };
}
