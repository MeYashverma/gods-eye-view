/**
 * CelesTrak orbital-element adapter plus the SGP4 propagation the satellite
 * layer runs on.
 *
 * Positions are computed in the browser from two-line element sets with
 * satellite.js. That is standard practice, but it is a model: TLEs are fitted
 * observations, SGP4 drifts, and a set older than a few days can be off by
 * kilometres. The layer shows the element epoch next to every contact so the
 * limitation is visible rather than implied.
 *
 * Parsing and propagation are pure functions, so they run unchanged under
 * Node's test runner.
 */

import * as satellite from 'satellite.js';
import { http } from '../net/http.js';

const ENDPOINT = 'https://celestrak.org/NORAD/elements/gp.php';

export const TLE_GROUPS = Object.freeze([
  { id: 'stations', label: 'Brightest / stations', max: 200 },
  { id: 'starlink', label: 'Starlink', max: 4000 },
  { id: 'weather', label: 'Weather', max: 800 },
  { id: 'gps-ops', label: 'GPS', max: 60 },
  { id: 'geo', label: 'Geostationary', max: 600 },
  { id: 'science', label: 'Science', max: 400 },
  { id: 'cubesat', label: 'CubeSats', max: 600 },
  { id: 'resource', label: 'Earth resources', max: 400 },
  { id: 'iridium', label: 'Iridium', max: 120 },
  { id: 'amateur', label: 'Amateur radio', max: 400 },
  { id: 'military', label: 'Misc. military', max: 400 },
]);

const RAD = 180 / Math.PI;

/**
 * Parse a 2LE/3LE element-set document.
 * Tolerates the two common shapes: a name line followed by lines 1 and 2, or a
 * bare pair of lines.
 * @returns {Array<{name:string, line1:string, line2:string, noradId:string, epoch:Date}>}
 */
export function parseTle(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('1 ')) continue;
    const line1 = line;
    const line2 = lines[index + 1];
    if (!line2?.startsWith('2 ')) continue;

    // A name line precedes the pair when the document is 3LE.
    const previous = lines[index - 1];
    const name =
      previous && !previous.startsWith('1 ') && !previous.startsWith('2 ')
        ? previous
        : `NORAD ${line1.slice(2, 7).trim()}`;

    out.push({
      name,
      line1,
      line2,
      noradId: line1.slice(2, 7).trim(),
      internationalDesignator: line1.slice(9, 17).trim(),
      epoch: tleEpoch(line1),
    });
    index += 1;
  }
  return out;
}

/** TLE epochs use a two-digit year; the pivot convention keeps 57→1957 sane. */
export function tleEpoch(line1) {
  const yearPart = Number(line1.slice(18, 20));
  const dayPart = Number(line1.slice(20, 32));
  if (!Number.isFinite(yearPart) || !Number.isFinite(dayPart)) return null;
  const year = yearPart < 57 ? 2000 + yearPart : 1900 + yearPart;
  const start = Date.UTC(year, 0, 1);
  return new Date(start + (dayPart - 1) * 86_400_000);
}

/** Build a satellite.js record, or null when the element set is corrupt. */
export function toSatrec(entry) {
  try {
    const satrec = satellite.twoline2satrec(entry.line1, entry.line2);
    if (!satrec || !Number.isFinite(satrec.inclo)) return null;
    return satrec;
  } catch {
    return null;
  }
}

/** Mean orbital period in minutes, derived from mean motion. */
export function periodMinutes(satrec) {
  if (!satrec || !Number.isFinite(satrec.no) || satrec.no <= 0) return null;
  // satellite.js stores mean motion `no` in radians per minute, so one full
  // revolution takes 2*pi / no minutes. (The ISS element set gives ~92.9 min.)
  return (2 * Math.PI) / satrec.no;
}

/**
 * Propagate to geodetic coordinates.
 * @returns {{lat:number, lon:number, heightKm:number, speedKmS:number, visible:boolean}|null}
 */
export function propagate(satrec, date = new Date()) {
  if (!satrec) return null;
  const positionAndVelocity = satellite.propagate(satrec, date);
  if (!positionAndVelocity?.position || typeof positionAndVelocity.position === 'boolean') {
    return null;
  }
  const positionEci = positionAndVelocity.position;
  const velocityEci = positionAndVelocity.velocity;
  const gmst = satellite.gstime(date);
  const geodetic = satellite.eciToGeodetic(positionEci, gmst);
  const lat = geodetic.latitude * RAD;
  const lon = geodetic.longitude * RAD;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(geodetic.height)) {
    return null;
  }
  const speed = velocityEci
    ? Math.hypot(velocityEci.x, velocityEci.y, velocityEci.z)
    : null;
  return {
    lat,
    lon: ((lon + 540) % 360) - 180,
    heightKm: geodetic.height,
    speedKmS: speed,
    visible: true,
  };
}

/**
 * Earth-centred fixed position in metres — the frame Cesium renders in.
 * Using ECF per sample (rather than one fixed rotation) keeps a track arc
 * aligned with the rotating planet over the sampled window.
 */
export function propagateEcefMeters(satrec, date = new Date()) {
  if (!satrec) return null;
  const result = satellite.propagate(satrec, date);
  if (!result?.position || typeof result.position === 'boolean') return null;
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(result.position, gmst);
  if (!Number.isFinite(ecf?.x)) return null;
  return { x: ecf.x * 1000, y: ecf.y * 1000, z: ecf.z * 1000 };
}

/**
 * Sample a ground track. `minutes` is clamped to one period so a GEO
 * satellite does not produce a 1,440-sample spiral.
 */
export function orbitTrack(satrec, startDate = new Date(), { minutes = 100, samples = 90 } = {}) {
  if (!satrec) return [];
  const period = periodMinutes(satrec);
  const window = Math.min(minutes, Math.max(10, period ?? minutes));
  const step = (window * 60_000) / Math.max(2, samples);
  const track = [];
  for (let index = 0; index <= samples; index += 1) {
    const at = new Date(startDate.getTime() + index * step);
    const point = propagate(satrec, at);
    if (point) track.push({ ...point, at: at.getTime() });
  }
  return track;
}

/** Classify an orbit well enough to be useful, without pretending precision. */
export function orbitClass(satrec) {
  if (!satrec) return 'unknown';
  const altitudeKm = ((satrec.a * (1 - satrec.ecco) - 1) * 6371) | 0;
  const inclination = satrec.inclo * RAD;
  if (altitudeKm > 35_000) return 'GEO';
  if (altitudeKm > 20_000) return 'HEO/MEO';
  if (inclination > 80 && inclination < 100) return 'Sun-synchronous LEO';
  if (altitudeKm < 2000) return 'LEO';
  return 'MEO';
}

export async function fetchTleGroup(groupId, { signal, limit } = {}, client = http) {
  const group = TLE_GROUPS.find((entry) => entry.id === groupId);
  if (!group) throw new Error(`Unknown TLE group: ${groupId}`);
  const url = `${ENDPOINT}?GROUP=${encodeURIComponent(groupId)}&FORMAT=tle`;
  const { data, meta } = await client.text(url, {
    signal,
    accept: 'text/plain',
    timeoutMs: 25_000,
    cacheMs: 6 * 60 * 60 * 1000,
    staleMs: 24 * 60 * 60 * 1000,
    retries: 2,
  });
  const parsed = parseTle(data);
  const capped = limit ? parsed.slice(0, Math.min(limit, group.max)) : parsed.slice(0, group.max);
  return { records: capped, fetchedAt: Date.now(), meta, count: capped.length, groupId };
}
