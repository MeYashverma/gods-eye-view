/**
 * NOAA National Hurricane Center / Central Pacific Hurricane Center adapter.
 *
 * Reads the published CurrentStorms.json advisory summary. These are advisory
 * products on a delay: the layer is for situational awareness, never for
 * decisions about safety, and the UI says so next to every storm.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

const ENDPOINT = 'https://www.nhc.noaa.gov/CurrentStorms.json';

/**
 * NHC encodes positions as strings like "25.3N" / "88.2W".
 * Returns a signed decimal degree value or null.
 */
export function parseHemisphereCoordinate(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*([NSEW]?)$/);
  if (!match) return null;
  let number = toNumber(match[1]);
  if (number === null) return null;
  const hemi = match[2];
  if (hemi === 'S' || hemi === 'W') number = -Math.abs(number);
  if (hemi === 'N' || hemi === 'E') number = Math.abs(number);
  return number;
}

/** knots -> m/s, and the Saffir-Simpson category from sustained wind. */
export function saffirSimpson(knots) {
  const kt = toNumber(knots);
  if (kt === null) return { category: null, label: 'Unclassified' };
  if (kt >= 137) return { category: 5, label: 'Category 5' };
  if (kt >= 113) return { category: 4, label: 'Category 4' };
  if (kt >= 96) return { category: 3, label: 'Category 3' };
  if (kt >= 83) return { category: 2, label: 'Category 2' };
  if (kt >= 64) return { category: 1, label: 'Category 1' };
  if (kt >= 34) return { category: 0, label: 'Tropical storm' };
  return { category: null, label: 'Tropical depression' };
}

export function stormColor(category) {
  switch (category) {
    case 5:
      return '#ff2d95';
    case 4:
      return '#ff4500';
    case 3:
      return '#ff8c00';
    case 2:
      return '#ffd700';
    case 1:
      return '#ffe97a';
    case 0:
      return '#5eead4';
    default:
      return '#7dd3fc';
  }
}

export function normalizeStorm(entry) {
  const lat = parseHemisphereCoordinate(entry?.lat);
  const lon = parseHemisphereCoordinate(entry?.lon);
  if (lat === null || lon === null) return null;
  const windKt = toNumber(entry?.maxWind);
  const classification = saffirSimpson(windKt);
  return {
    id: `nhc:${entry?.stormId || `${lat},${lon}`}`,
    name: entry?.stormName || 'Unnamed',
    type: entry?.stormType || null,
    basin: entry?.basin || null,
    lat,
    lon,
    windKt,
    windMs: windKt === null ? null : windKt * 0.514444,
    gustKt: toNumber(entry?.maxGust) ?? null,
    pressureHpa: toNumber(entry?.stormPressure) ?? null,
    movementKt: toNumber(entry?.stormSpeed) ?? null,
    headingDeg: toNumber(entry?.stormDirection) ?? null,
    advisoryNumber: entry?.advisoryNumber || null,
    advisoryTime: entry?.updateTime || null,
    category: classification.category,
    categoryLabel: classification.label,
    url: entry?.stormId
      ? `https://www.nhc.noaa.gov/refresh/graphics_at5+shtml/${String(entry.stormId).toLowerCase()}.shtml`
      : null,
  };
}

export function normalizeStormList(payload) {
  const list = Array.isArray(payload?.stormList) ? payload.stormList : [];
  return list.map(normalizeStorm).filter(Boolean);
}

export async function fetchActiveStorms({ signal } = {}, client = http) {
  const { data } = await client.json(ENDPOINT, {
    signal,
    timeoutMs: 20_000,
    cacheMs: 5 * 60 * 1000,
    staleMs: 30 * 60 * 1000,
    retries: 2,
  });
  const records = normalizeStormList(data);
  return {
    records,
    fetchedAt: Date.now(),
    count: records.length,
    message: records.length
      ? `${records.length} active tropical cyclone${records.length === 1 ? '' : 's'} in the advisory feed`
      : 'No active tropical cyclones in the Atlantic or eastern/central Pacific basins',
  };
}
