/**
 * RainViewer adapter — keyless, cross-origin-enabled radar and satellite tile
 * frames re-hosted from national weather services.
 *
 * The API returns a list of frame paths; the tiles themselves are plain
 * XYZ PNGs, so Cesium renders them with a UrlTemplateImageryProvider and no
 * per-frame fetching.
 */

import { http } from '../net/http.js';

const FEED = 'https://api.rainviewer.com/public/weather-maps.json';

/** Colour schemes documented by RainViewer. 2 = original with snow. */
export const RADAR_SCHEMES = Object.freeze([
  { id: 0, label: 'Black & white' },
  { id: 1, label: 'Original' },
  { id: 2, label: 'Universal blue' },
  { id: 3, label: 'TITAN' },
  { id: 4, label: 'The Weather Channel' },
  { id: 5, label: 'Meteored' },
  { id: 6, label: 'NEXRAD Level III' },
  { id: 7, label: 'RAINBOW @ SELEX-SI' },
  { id: 8, label: 'Dark Sky' },
]);

export function normalizeWeatherMaps(payload) {
  const host = String(payload?.host ?? '').replace(/\/$/, '');
  const radarPast = Array.isArray(payload?.radar?.past) ? payload.radar.past : [];
  const radarNowcast = Array.isArray(payload?.radar?.nowcast) ? payload.radar.nowcast : [];
  const satellitePast = Array.isArray(payload?.satellite?.past) ? payload.satellite.past : [];

  const pick = (frames) =>
    frames
      .filter((frame) => frame?.path)
      .map((frame) => ({ time: Number(frame.time) * 1000, path: String(frame.path) }))
      .sort((a, b) => a.time - b.time);

  return {
    host,
    generatedAt: Number(payload?.generated) * 1000 || Date.now(),
    radar: { past: pick(radarPast), nowcast: pick(radarNowcast) },
    satellite: { past: pick(satellitePast) },
  };
}

/** Newest frame at or before `at`, or the newest frame available. */
export function frameAt(frames, at = Date.now()) {
  if (!frames?.length) return null;
  let chosen = frames[0];
  for (const frame of frames) {
    if (frame.time <= at) chosen = frame;
  }
  return chosen;
}

/**
 * Build an XYZ tile template.
 * @param {{host:string, path:string}} frame
 * @param {{scheme?:number, smooth?:boolean, snow?:boolean, size?:number}} options
 */
export function tileTemplate(frame, { scheme = 2, smooth = true, snow = true, size = 256 } = {}) {
  if (!frame?.host || !frame?.path) return null;
  const options = `${smooth ? 1 : 0}_${snow ? 1 : 0}`;
  return `${frame.host}${frame.path}/${size}/{z}/{x}/{y}/${scheme}/${options}.png`;
}

export async function fetchWeatherMaps({ signal } = {}, client = http) {
  const { data, meta } = await client.json(FEED, {
    signal,
    timeoutMs: 15_000,
    cacheMs: 5 * 60 * 1000,
    staleMs: 30 * 60 * 1000,
    retries: 2,
  });
  const normalized = normalizeWeatherMaps(data);
  if (!normalized.host) throw new Error('RainViewer response carried no tile host');
  return { ...normalized, meta };
}

export async function latestRadarFrame({ signal } = {}, client = http) {
  const maps = await fetchWeatherMaps({ signal }, client);
  const frame = frameAt(maps.radar.past) || maps.radar.nowcast.at(-1) || null;
  return frame ? { ...frame, host: maps.host } : null;
}

export async function latestSatelliteFrame({ signal } = {}, client = http) {
  const maps = await fetchWeatherMaps({ signal }, client);
  const frame = frameAt(maps.satellite.past);
  return frame ? { ...frame, host: maps.host } : null;
}
