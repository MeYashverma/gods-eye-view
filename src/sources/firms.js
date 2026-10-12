/**
 * NASA FIRMS (LANCE) active-fire adapter.
 *
 * Requires a free NASA LANCE API key. The key is a bearer token in the URL,
 * which means it is browser-visible — NASA issues these keys for programmatic
 * access, so that is how the service is meant to be used, but the settings
 * panel states plainly that anything entered there can be read by the page.
 */

import { http } from '../net/http.js';
import { toNumber } from '../geo/coords.js';

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

export const FIRMS_SATELLITES = Object.freeze([
  { id: 'VIIRS_SNPP_NRT', label: 'VIIRS (Suomi NPP) — 375 m', resolution: 375 },
  { id: 'VIIRS_NOAA20_NRT', label: 'VIIRS (NOAA-20) — 375 m', resolution: 375 },
  { id: 'MODIS_NRT', label: 'MODIS — 1 km', resolution: 1000 },
]);

export function fireAreaUrl({ apiKey, satelliteId = 'VIIRS_SNPP_NRT', box, days = 1 }) {
  const south = Number(box.south).toFixed(2);
  const west = Number(box.west).toFixed(2);
  const north = Number(box.north).toFixed(2);
  const east = Number(box.east).toFixed(2);
  return `${BASE}/${encodeURIComponent(apiKey)}/${satelliteId}/${west},${south},${east},${north}/${days}`;
}

/**
 * Parse the FIRMS CSV. Columns vary slightly by satellite, so the header row
 * drives the field mapping instead of a fixed positional index.
 */
export function parseFirmsCsv(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((column) => column.trim());
  const index = Object.fromEntries(header.map((column, position) => [column, position]));
  const required = ['latitude', 'longitude', 'bright_ti4'];
  for (const column of required) {
    if (index[column] === undefined) return [];
  }

  const records = [];
  for (let line = 1; line < lines.length; line += 1) {
    const cells = lines[line].split(',');
    if (cells.length < header.length) continue;
    const lat = toNumber(cells[index.latitude]);
    const lon = toNumber(cells[index.longitude]);
    if (lat === null || lon === null) continue;
    const brightness = toNumber(cells[index.bright_ti4]);
    const frp = index.frp !== undefined ? toNumber(cells[index.frp]) : null;
    const confidence = cells[index.confidence] || null;
    const acqDate = cells[index.acq_date] || null;
    const acqTime = cells[index.acq_time] || null;
    records.push({
      id: `firms:${lat.toFixed(4)},${lon.toFixed(4)},${acqDate || ''},${acqTime || ''}`,
      lat,
      lon,
      brightnessK: brightness,
      frpMw: frp,
      confidence: confidence ? String(confidence).toLowerCase() : null,
      satellite: cells[index.satellite] || null,
      instrument: cells[index.instrument] || null,
      scan: index.scan !== undefined ? toNumber(cells[index.scan]) : null,
      track: index.track !== undefined ? toNumber(cells[index.track]) : null,
      dayNight: cells[index.daynight] || null,
      observedAt: parseAcquisition(acqDate, acqTime),
    });
  }
  return records;
}

/** FIRMS gives "2026-01-01" and "1423" (UTC hhmm). */
export function parseAcquisition(date, time) {
  if (!date) return null;
  const [year, month, day] = String(date).split('-').map(Number);
  const text = String(time || '0000').padStart(4, '0');
  const hours = Number(text.slice(0, 2));
  const minutes = Number(text.slice(2, 4));
  if (![year, month, day].every(Number.isFinite)) return null;
  const stamp = Date.UTC(year, month - 1, day, hours, minutes);
  return Number.isFinite(stamp) ? stamp : null;
}

export function fireColor(record) {
  const frp = record?.frpMw ?? 0;
  if (frp >= 500) return '#ff2d2d';
  if (frp >= 100) return '#ff7a18';
  if (frp >= 25) return '#ffb020';
  return '#ffd666';
}

export async function fetchActiveFires({ apiKey, box, satelliteId, days = 1, signal }, client = http) {
  if (!apiKey) {
    const error = new Error('A NASA FIRMS API key is required');
    error.kind = 'config';
    throw error;
  }
  const { data } = await client.text(fireAreaUrl({ apiKey, satelliteId, box, days }), {
    signal,
    accept: 'text/csv',
    timeoutMs: 30_000,
    cacheMs: 10 * 60 * 1000,
    retries: 1,
  });
  const records = parseFirmsCsv(data);
  return { records, fetchedAt: Date.now(), count: records.length };
}
