/**
 * OSRM routing adapter.
 *
 * The default endpoint is the FOSSGIS public demo router. Its operators ask
 * for light, interactive use, so this client caches each route for ten
 * minutes, refuses to send a leg the router would reject anyway, and sends an
 * identifying user agent. Anyone with heavier needs points Settings at their
 * own OSRM instance.
 *
 * When routing is unavailable the Directions layer falls back to a straight
 * line that is labelled as an estimate — it never presents the estimate as a
 * computed route.
 */

import { http } from '../net/http.js';
import { distanceM } from '../geo/coords.js';

export const DEFAULT_OSRM = 'https://router.project-osrm.org';

export const TRAVEL_MODES = Object.freeze([
  { id: 'driving', label: 'Driving', icon: 'navigation' },
  { id: 'cycling', label: 'Cycling', icon: 'bike' },
  { id: 'walking', label: 'Walking', icon: 'route' },
]);

/** The demo router's profiles; walking is not always deployed. */
export const PROFILE_BY_MODE = Object.freeze({
  driving: 'driving',
  cycling: 'bike',
  walking: 'foot',
});

const MAX_LEG_M = 2_500_000;
const MAX_TOTAL_M = 6_000_000;

export function validateWaypoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { ok: false, reason: 'At least two waypoints are required' };
  }
  if (points.length > 12) return { ok: false, reason: 'At most twelve waypoints' };
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const leg = distanceM(previous.lat, previous.lon, current.lat, current.lon);
    if (leg > MAX_LEG_M) {
      return { ok: false, reason: `Leg ${index} is ${Math.round(leg / 1000).toLocaleString()} km — over the 2,500 km limit` };
    }
    total += leg;
  }
  if (total > MAX_TOTAL_M) {
    return { ok: false, reason: 'Total distance exceeds the 6,000 km route limit' };
  }
  return { ok: true, totalM: total };
}

export function routeUrl(baseUrl, mode, points, { steps = true } = {}) {
  const profile = PROFILE_BY_MODE[mode] || 'driving';
  const coordinates = points.map((point) => `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`).join(';');
  const url = new URL(`${String(baseUrl || DEFAULT_OSRM).replace(/\/$/, '')}/route/v1/${profile}/${coordinates}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  if (steps) url.searchParams.set('steps', 'true');
  url.searchParams.set('alternatives', 'false');
  return url.toString();
}

/** OSRM returns seconds/metres; convert to the units the panel shows. */
export function normalizeRoute(payload) {
  const route = Array.isArray(payload?.routes) ? payload.routes[0] : null;
  if (!route) return null;
  const coordinates = route.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  return {
    distanceM: route.distance ?? null,
    durationS: route.duration ?? null,
    path: coordinates.map(([lon, lat]) => ({ lon, lat })),
    legs: (route.legs || []).map((leg) => ({
      distanceM: leg.distance ?? null,
      durationS: leg.duration ?? null,
      steps: (leg.steps || []).map((step) => ({
        name: step.name || null,
        maneuver: step.maneuver?.type || null,
        modifier: step.maneuver?.modifier || null,
        instruction: step.maneuver?.type
          ? `${step.maneuver.type}${step.maneuver.modifier ? ` ${step.maneuver.modifier}` : ''}${step.name ? ` onto ${step.name}` : ''}`
          : null,
        distanceM: step.distance ?? null,
        durationS: step.duration ?? null,
        at: step.maneuver?.location ? { lon: step.maneuver.location[0], lat: step.maneuver.location[1] } : null,
      })),
    })),
  };
}

/** Plain-language instruction text for a maneuver. */
export function describeManeuver(step) {
  if (!step) return '';
  if (step.instruction) return step.instruction.replace(/_/g, ' ');
  return step.name || step.maneuver || '';
}

/** Great-circle fallback, used only when routing genuinely cannot run. */
export function straightLinePath(from, to, { segments = 64 } = {}) {
  if (!from || !to) return [];
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lon)) return [];
  if (!Number.isFinite(to.lat) || !Number.isFinite(to.lon)) return [];
  const steps = Math.max(1, Math.min(512, Math.round(segments) || 64));
  const path = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    path.push({
      lat: from.lat + (to.lat - from.lat) * t,
      lon: from.lon + (to.lon - from.lon) * t,
    });
  }
  return path;
}

/**
 * Compute a route.
 *
 * Validates against the router's own limits *before* sending anything, so a
 * 6,000 km request is refused locally with a readable reason instead of coming
 * back as an opaque 400. Throws on failure — the caller decides whether to fall
 * back to a labelled straight-line estimate.
 *
 * @param {object} options
 * @param {string} [options.baseUrl]
 * @param {string} options.mode one of {@link TRAVEL_MODES}
 * @param {{lat:number, lon:number}[]} options.waypoints
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{route:object, estimated:false, meta:object}>}
 */
export async function fetchRoute({ baseUrl, mode, waypoints, signal }, client = http) {
  const validation = validateWaypoints(waypoints);
  if (!validation.ok) {
    const error = new Error(validation.reason);
    error.kind = 'config';
    throw error;
  }

  const base = String(baseUrl || DEFAULT_OSRM).trim();
  const url = routeUrl(base, mode, waypoints);
  const { data, meta } = await client.json(url, {
    signal,
    timeoutMs: 25_000,
    // A route does not change under a parked camera; ten minutes is plenty and
    // keeps the demo router's load down.
    cacheMs: 10 * 60 * 1000,
    staleMs: 30 * 60 * 1000,
    retries: 1,
  });

  const route = normalizeRoute(data);
  if (!route) {
    const error = new Error(data?.message || 'The router returned no route between those points');
    error.kind = 'http';
    throw error;
  }
  return { route, estimated: false, meta, totalM: validation.totalM };
}
