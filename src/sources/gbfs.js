/**
 * GBFS bikeshare adapter.
 *
 * The system catalog is fetched from the MobilityData repository on GitHub
 * (a static file behind a CDN that sends permissive CORS headers). Individual
 * operators then serve their own GBFS feeds, and each one decides its own
 * cross-origin policy — so this adapter reports per-system results rather than
 * treating one operator's refusal as a global failure.
 */

import { http } from '../net/http.js';
import { distanceM, toNumber } from '../geo/coords.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv';

/**
 * Parse the MobilityData systems catalog.
 * Returns only systems that publish a location and an autodiscovery URL.
 */
/**
 * Parse the MobilityData GBFS systems catalog.
 *
 * The published file (1,500+ systems) has the header
 * `Country Code,Name,Location,System ID,URL,Auto-Discovery URL,...` and carries
 * **no coordinates at all** — so systems are matched to the camera by place
 * name (see `matchSystemsByPlace`), never by distance. Headers are matched
 * case- and punctuation-insensitively because the catalog has changed its
 * column spellings more than once, and a rename must not silently produce an
 * empty list.
 */
export function parseSystemsCsv(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((column) => column.trim());
  const index = new Map(header.map((column, position) => [normalizeHeader(column), position]));
  const get = (cells, ...names) => {
    for (const name of names) {
      const position = index.get(normalizeHeader(name));
      if (position === undefined) continue;
      const value = (cells[position] ?? '').trim();
      if (value) return value;
    }
    return null;
  };

  const out = [];
  for (let line = 1; line < lines.length; line += 1) {
    // The catalog has free-text fields; a naive split is wrong when a quoted
    // field contains a comma, so split honouring double quotes.
    const cells = splitCsvLine(lines[line]);
    const url = get(cells, 'auto-discovery-url', 'autodiscoveryurl', 'url');
    if (!url || !/^https:\/\//i.test(url)) continue;
    // The catalog also carries a marketing `URL` column. Falling back to it is
    // only useful when it actually points at a GBFS discovery document —
    // otherwise we would queue a request against an operator's homepage and
    // report the resulting failure as a provider outage.
    if (!/gbfs/i.test(url)) continue;
    const id = get(cells, 'system_id', 'systemid') || url;
    const location = get(cells, 'location');
    const country = get(cells, 'country-code', 'countrycode', 'country');
    const lat = toNumber(get(cells, 'latitude', 'lat'));
    const lon = toNumber(get(cells, 'longitude', 'lon', 'lng'));
    out.push({
      id,
      name: get(cells, 'name') || id,
      operator: get(cells, 'operator'),
      country,
      location,
      // Only present if a future catalog revision adds the columns.
      lat: lat === null ? null : lat,
      lon: lon === null ? null : lon,
      discoveryUrl: url,
      language: get(cells, 'language') || 'en',
    });
  }
  return out;
}

/** Match header spellings regardless of case, spaces, underscores and dashes. */
export function normalizeHeader(column) {
  return String(column ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'de', 'la', 'le', 'el', 'in', 'city']);

/**
 * Rank systems against free-text place names.
 *
 * The catalog gives a city/region string instead of coordinates, so "is there a
 * bikeshare system near this camera" is answered by name matching. Returns only
 * systems with at least one significant shared token, so an unmatched camera
 * yields an empty list and the layer says so instead of guessing.
 */
export function matchSystemsByPlace(systems, placeText, { limit = 3 } = {}) {
  const wanted = tokenize(placeText);
  if (!wanted.size) return [];
  const scored = [];
  for (const system of systems) {
    const haystack = tokenize([system.location, system.name, system.country].filter(Boolean).join(' '));
    if (!haystack.size) continue;
    let score = 0;
    for (const token of wanted) if (haystack.has(token)) score += 1;
    if (score) scored.push({ ...system, placeScore: score });
  }
  return scored.sort((a, b) => b.placeScore - a.placeScore).slice(0, limit);
}

function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

export function splitCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

/**
 * Distance-based system selection. Kept because it is the right answer when a
 * catalog does carry coordinates, but it deliberately returns an empty list
 * when the systems have none — it never pretends a system is nearby.
 */
export function nearestSystems(systems, lat, lon, { maxKm = 120, limit = 3 } = {}) {
  return systems
    .filter((system) => Number.isFinite(system.lat) && Number.isFinite(system.lon))
    .map((system) => ({ ...system, distanceKm: distanceM(lat, lon, system.lat, system.lon) / 1000 }))
    .filter((system) => system.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/** GBFS feeds are discovered from a per-system autodiscovery document. */
export function findFeedUrl(discovery, kind) {
  const data = discovery?.data;
  if (!data) return null;
  const languages = Object.values(data);
  for (const language of languages) {
    const feeds = language?.feeds;
    if (!Array.isArray(feeds)) continue;
    const feed = feeds.find((entry) => entry?.name === kind);
    if (feed?.url) return feed.url;
  }
  return null;
}

export function normalizeStations(information, status) {
  const info = information?.data?.stations;
  if (!Array.isArray(info)) return [];
  const statusById = new Map(
    (Array.isArray(status?.data?.stations) ? status.data.stations : []).map((entry) => [
      String(entry.station_id),
      entry,
    ]),
  );
  const out = [];
  for (const station of info) {
    const lat = toNumber(station.lat);
    const lon = toNumber(station.lon);
    if (lat === null || lon === null) continue;
    const live = statusById.get(String(station.station_id)) || {};
    out.push({
      id: `gbfs:${station.station_id}`,
      stationId: String(station.station_id),
      name: station.name || 'Unnamed station',
      lat,
      lon,
      capacity: toNumber(station.capacity),
      availableBikes: toNumber(live.num_bikes_available) ?? null,
      availableDocks: toNumber(live.num_docks_available) ?? null,
      eBikes: toNumber(live.num_ebikes_available) ?? null,
      disabled: toNumber(live.num_bikes_disabled) ?? null,
      // `null`, not `true`: a station with no status row is unknown, and
      // reporting it as rentable would be inventing availability.
      renting: live.is_renting === undefined ? null : live.is_renting !== 0,
      returning: live.is_returning === undefined ? null : live.is_returning !== 0,
      lastReported: toNumber(live.last_reported) ? Number(live.last_reported) * 1000 : null,
    });
  }
  return out;
}

export function stationColor(station) {
  const available = station?.availableBikes ?? 0;
  if (!station?.renting || !station?.returning) return '#64748b';
  if (available === 0) return '#f0645a';
  if (available <= 2) return '#f0b429';
  if (available >= 10) return '#22d3ee';
  return '#4ade80';
}

export async function fetchCatalog({ signal } = {}, client = http) {
  const { data } = await client.text(CATALOG_URL, {
    signal,
    accept: 'text/csv',
    timeoutMs: 25_000,
    cacheMs: 24 * 60 * 60 * 1000,
    staleMs: 7 * 24 * 60 * 60 * 1000,
    retries: 1,
  });
  return parseSystemsCsv(data);
}

/**
 * Load one system's stations. Failures are returned rather than thrown so a
 * caller querying three systems can still draw the two that answered.
 */
export async function fetchSystemStations(system, { signal } = {}, client = http) {
  try {
    const discoveryResult = await client.json(system.discoveryUrl, {
      signal,
      timeoutMs: 15_000,
      cacheMs: 6 * 60 * 60 * 1000,
      retries: 0,
    });
    const infoUrl = findFeedUrl(discoveryResult.data, 'station_information');
    const statusUrl = findFeedUrl(discoveryResult.data, 'station_status');
    if (!infoUrl) {
      return { system, records: [], error: 'System publishes no station_information feed' };
    }
    const [information, status] = await Promise.all([
      client.json(infoUrl, { signal, timeoutMs: 15_000, cacheMs: 2 * 60 * 1000, retries: 0 }),
      statusUrl
        ? client.json(statusUrl, { signal, timeoutMs: 15_000, cacheMs: 60_000, retries: 0 })
        : Promise.resolve({ data: null }),
    ]);
    const records = normalizeStations(information.data, status.data).map((record) => ({
      ...record,
      systemId: system.id,
      systemName: system.name,
    }));
    return { system, records, error: null };
  } catch (error) {
    return {
      system,
      records: [],
      error: error?.kind === 'cors'
        ? `${system.name} does not permit cross-origin requests`
        : (error?.message || 'Unknown error'),
    };
  }
}
