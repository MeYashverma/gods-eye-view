/**
 * Airport reference layer.
 *
 * Uses the OpenFlights airports dataset (ODbL 1.0), mirrored on GitHub so it
 * is served behind a CDN with permissive CORS headers. This is a *static
 * reference* dataset: it tells you where airports are, not what is flying.
 * The layer says so in its own description.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

const DATASET_URL = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

export const AIRPORT_TYPES = Object.freeze([
  { id: 'large_airport', label: 'Large', minRank: 3 },
  { id: 'medium_airport', label: 'Medium', minRank: 2 },
  { id: 'small_airport', label: 'Small', minRank: 1 },
]);

/**
 * Parse one `airports.dat` line.
 * The file is comma-separated with quoted names that may contain commas, so
 * the split has to honour quotes.
 */
export function parseAirportLine(line) {
  const cells = splitLine(line);
  if (cells.length < 14) return null;
  const id = cells[0];
  const name = unquote(cells[1]);
  const city = unquote(cells[2]);
  const country = unquote(cells[3]);
  const iata = unquote(cells[4]);
  const icao = unquote(cells[5]);
  const lat = toNumber(cells[6]);
  const lon = toNumber(cells[7]);
  const altitudeFt = toNumber(cells[8]);
  const timezone = toNumber(cells[9]);
  const dst = unquote(cells[10]);
  const tzName = unquote(cells[11]);
  const type = unquote(cells[12]);
  const source = unquote(cells[13]);
  if (lat === null || lon === null) return null;
  return {
    id: `airport:${icao || iata || id}`,
    numericId: id,
    name: name === '\\N' ? null : name,
    city: city === '\\N' ? null : city,
    country: country === '\\N' ? null : country,
    iata: iata && iata !== '\\N' ? iata : null,
    icao: icao && icao !== '\\N' ? icao : null,
    lat,
    lon,
    altitudeM: altitudeFt === null ? null : altitudeFt * 0.3048,
    utcOffsetH: timezone,
    dst,
    timezone: tzName === '\\N' ? null : tzName,
    type: type === '\\N' ? null : type,
    source: source === '\\N' ? null : source,
  };
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function splitLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out;
}

export function parseAirports(text, { types = null, box = null } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const wanted = types?.length ? new Set(types) : null;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseAirportLine(line);
    if (!record) continue;
    if (wanted && !wanted.has(record.type)) continue;
    if (box && !inBox(record.lat, record.lon, box)) continue;
    out.push(record);
  }
  return out;
}

function inBox(lat, lon, box) {
  const west = Math.min(box.west, box.east);
  const east = Math.max(box.west, box.east);
  return lat >= box.south && lat <= box.north && lon >= west && lon <= east;
}

export function airportRank(record) {
  switch (record?.type) {
    case 'large_airport':
      return 3;
    case 'medium_airport':
      return 2;
    case 'small_airport':
      return 1;
    default:
      return 0;
  }
}

export function airportColor(record) {
  switch (record?.type) {
    case 'large_airport':
      return '#38bdf8';
    case 'medium_airport':
      return '#a3e635';
    default:
      return '#94a3b8';
  }
}

export async function fetchAirports({ signal, types = ['large_airport', 'medium_airport'] } = {}, client = http) {
  const { data } = await client.text(DATASET_URL, {
    signal,
    accept: 'text/plain',
    timeoutMs: 40_000,
    cacheMs: 24 * 60 * 60 * 1000,
    staleMs: 7 * 24 * 60 * 60 * 1000,
    retries: 1,
  });
  const all = parseAirports(data);
  const wanted = new Set(types);
  const records = all.filter((record) => wanted.has(record.type));
  return { records, fetchedAt: Date.now(), count: records.length };
}
