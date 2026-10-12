/**
 * Geographic helpers shared by every adapter, layer and UI readout.
 * Pure functions only — no Cesium import — so they are unit-testable in Node.
 */

export const EARTH_RADIUS_M = 6371008.8; // WGS84 mean radius
export const DEG = Math.PI / 180;
const NM_PER_M = 1 / 1852;
const FT_PER_M = 1 / 0.3048;
const KMH_PER_MS = 3.6;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Accept anything a user or a feed might send; return a number or null. */
export function toNumber(value) {
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalizeLat(value) {
  const lat = toNumber(value);
  if (lat === null || lat < -90 || lat > 90) return null;
  return lat;
}

export function normalizeLon(value) {
  const lon = toNumber(value);
  if (lon === null) return null;
  let wrapped = lon % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped < -180) wrapped += 360;
  return wrapped;
}

/** Round a coordinate to ~110 m so cached queries do not leak exact position. */
export function roundForCache(lon, lat, step = 0.001) {
  return [Math.round(lon / step) * step, Math.round(lat / step) * step];
}

export function formatLat(lat, digits = 4) {
  const value = toNumber(lat);
  if (value === null) return '—';
  const hemi = value < 0 ? 'S' : 'N';
  return `${Math.abs(value).toFixed(digits)}° ${hemi}`;
}

export function formatLon(lon, digits = 4) {
  const value = toNumber(lon);
  if (value === null) return '—';
  const hemi = value < 0 ? 'W' : 'E';
  return `${Math.abs(value).toFixed(digits)}° ${hemi}`;
}

export function formatLatLon(lat, lon, digits = 4) {
  return `${formatLat(lat, digits)}  ${formatLon(lon, digits)}`;
}

/** Degrees/minutes/seconds — the format operators expect on a readout. */
export function toDms(value, axis) {
  const number = toNumber(value);
  if (number === null) return null;
  const hemi = axis === 'lat' ? (number < 0 ? 'S' : 'N') : number < 0 ? 'W' : 'E';
  const abs = Math.abs(number);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return {
    hemi,
    deg,
    min,
    sec: Number(sec.toFixed(2)),
    text: `${String(deg).padStart(axis === 'lat' ? 2 : 3, '0')}°${String(min).padStart(2, '0')}'${sec.toFixed(2).padStart(5, '0')}" ${hemi}`,
  };
}

/**
 * Parse free-form position text. Accepts:
 *   "37.7749, -122.4194"   "-122.4194 37.7749"
 *   "37 46 N 122 25 W"     "37°46'29.6"N 122°25'11.5"W"
 *   "37.7749 -122.4194"
 * Returns { lat, lon } or null. Nothing is guessed: if a value falls outside
 * its valid range the input is rejected rather than coerced.
 */
export function parseCoordinates(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const dms = parseDmsPair(raw);
  if (dms) return dms;

  const numbers = raw
    .replace(/[°,]/g, ' ')
    .split(/[\s/|]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(toNumber);
  if (numbers.length !== 2 || numbers.some((value) => value === null)) return null;

  const [a, b] = numbers;
  // Two conventions collide: "lat lon" and "lon lat". Disambiguate by range;
  // when both readings are valid, prefer "lat lon", which is what search boxes
  // and coordinate pickers overwhelmingly emit.
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lon: a };
  return null;
}

function parseDmsPair(raw) {
  const pattern =
    /(\d+(?:\.\d+)?)\s*(?:°|\s)\s*(\d+(?:\.\d+)?)?\s*(?:'|′|\s)?\s*(\d+(?:\.\d+)?)?\s*(?:"|″)?\s*([NSns])[\s,]*(-?\d+(?:\.\d+)?)\s*(?:°|\s)\s*(\d+(?:\.\d+)?)?\s*(?:'|′|\s)?\s*(\d+(?:\.\d+)?)?\s*(?:"|″)?\s*([EWew])/;
  const match = raw.match(pattern);
  if (!match) return null;
  const toDecimal = (deg, min, sec) =>
    (toNumber(deg) ?? 0) + (toNumber(min) ?? 0) / 60 + (toNumber(sec) ?? 0) / 3600;
  let lat = toDecimal(match[1], match[2], match[3]);
  let lon = toDecimal(match[5], match[6], match[7]);
  if (/[Ss]/.test(match[4])) lat = -lat;
  if (/[Ww]/.test(match[8])) lon = -lon;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dPhi = (lat2 - lat1) * DEG;
  const dLambda = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function distanceNm(lat1, lon1, lat2, lon2) {
  return distanceM(lat1, lon1, lat2, lon2) * NM_PER_M;
}

/** Initial great-circle bearing in degrees true, 0-360. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dLambda = (lon2 - lon1) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

export function compassPoint(deg) {
  const value = toNumber(deg);
  if (value === null) return '—';
  return COMPASS[Math.round(((value % 360) + 360) % 360 / 22.5) % 16];
}

/** Destination point after travelling `distanceM` metres on `bearingDeg`. */
export function destination(lat, lon, bearing, distance) {
  const phi1 = lat * DEG;
  const lambda1 = lon * DEG;
  const theta = bearing * DEG;
  const delta = distance / EARTH_RADIUS_M;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { lat: phi2 / DEG, lon: (((lambda2 / DEG) + 540) % 360) - 180 };
}

/** Bounding box that contains a circle of `radiusKm` around a point. */
export function boundingBox(lat, lon, radiusKm) {
  const dLat = (radiusKm / 111.32) * 1;
  const cosLat = Math.max(0.0001, Math.cos(lat * DEG));
  const dLon = (radiusKm / 111.32) / cosLat;
  return {
    south: clamp(lat - dLat, -90, 90),
    north: clamp(lat + dLat, -90, 90),
    west: normalizeLon(lon - dLon),
    east: normalizeLon(lon + dLon),
  };
}

/** True when the box wraps the antimeridian. */
export function boxWrapsAntimeridian(west, east) {
  return west > east;
}

/** Overpass-style "south,west,north,east" string. */
export function overpassBBox(box) {
  return [box.south, box.west, box.north, box.east].map((value) => value.toFixed(5)).join(',');
}

export function formatDistance(metres) {
  const value = toNumber(metres);
  if (value === null || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} m`;
  if (value < 100000) return `${(value / 1000).toFixed(1)} km`;
  return `${Math.round(value / 1000).toLocaleString()} km`;
}

export function formatAltitude(metres) {
  const value = toNumber(metres);
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString()} m`;
}

export function metersToFeet(metres) {
  const value = toNumber(metres);
  return value === null ? null : value * FT_PER_M;
}

export function feetToMeters(feet) {
  const value = toNumber(feet);
  return value === null ? null : value * 0.3048;
}

export function formatFeet(metres) {
  const feet = metersToFeet(metres);
  if (feet === null) return '—';
  return `${Math.round(feet).toLocaleString()} ft`;
}

export function msToKmh(ms) {
  const value = toNumber(ms);
  return value === null ? null : value * KMH_PER_MS;
}

export function formatSpeed(ms) {
  const kmh = msToKmh(ms);
  if (kmh === null) return '—';
  return `${Math.round(kmh)} km/h`;
}

export function formatKnots(ms) {
  const value = toNumber(ms);
  if (value === null) return '—';
  return `${Math.round(value * NM_PER_M * 3600)} kt`;
}

/**
 * Approximate WGS84 ground resolution (metres/pixel) at a latitude and zoom.
 * Used for level-of-detail decisions instead of guessing from camera height.
 */
export function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos(lat * DEG)) / 2 ** zoom;
}

/**
 * Convert a camera height above the ellipsoid into an approximate zoom level.
 * Only used to pick level-of-detail buckets, so the small approximation from
 * ignoring field of view is acceptable and is documented here rather than
 * hidden inside a layer.
 */
export function heightToZoom(heightM, fovDeg = 60) {
  const height = Math.max(1, toNumber(heightM) ?? 1);
  const fov = (clamp(toNumber(fovDeg) ?? 60, 10, 120) * DEG) / 2;
  const visibleSpanM = 2 * height * Math.tan(fov);
  const equatorCircumferenceM = 40075016.686;
  return clamp(Math.log2(equatorCircumferenceM / (visibleSpanM * 256)), 0, 22);
}

/** Compact, stable ID for anything with a lat/lon and a label. */
export function featureKey(prefix, lat, lon, extra = '') {
  return `${prefix}:${lat.toFixed(5)},${lon.toFixed(5)}${extra ? `:${extra}` : ''}`;
}

/**
 * Deterministic 32-bit hash. Used to derive stable per-record colours so a
 * marker keeps the same colour across refreshes without storing state.
 */
export function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
