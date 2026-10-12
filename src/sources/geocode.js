/**
 * Place search.
 *
 * Photon first, Nominatim as the fallback. Both are OpenStreetMap services
 * with published fair-use policies: Nominatim asks for about one request per
 * second and an identifying referer, so the client enforces that spacing
 * rather than trusting callers to.
 */

import { http } from '../net/http.js';
import { parseCoordinates, toNumber } from '../geo/coords.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/**
 * A search box that understands coordinates should never spend a network
 * round trip on them. Checked first, and the result is marked so the UI can
 * show that it came from parsing rather than from a gazetteer.
 */
export function coordinateResult(query) {
  const parsed = parseCoordinates(query);
  if (!parsed) return null;
  return {
    id: `coord:${parsed.lat.toFixed(5)},${parsed.lon.toFixed(5)}`,
    name: `${parsed.lat.toFixed(4)}, ${parsed.lon.toFixed(4)}`,
    displayName: `Coordinate ${parsed.lat.toFixed(4)}, ${parsed.lon.toFixed(4)}`,
    lat: parsed.lat,
    lon: parsed.lon,
    kind: 'coordinate',
    zoom: 11,
  };
}

export function normalizePhoton(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const out = [];
  for (const feature of features) {
    const [lon, lat] = feature?.geometry?.coordinates || [];
    const props = feature.properties || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      id: `photon:${props.osm_id ?? out.length}`,
      name: props.name || props.street || 'Unnamed',
      displayName: photonLabel(props),
      lat,
      lon,
      kind: props.type || props.osm_key || 'place',
      category: props.osm_key || null,
      country: props.country || null,
      zoom: photonZoom(props),
      bbox: props.extent || null,
    });
  }
  return out;
}

function photonLabel(props) {
  return [props.name, props.district, props.city, props.state, props.country]
    .filter(Boolean)
    .join(', ');
}

function photonZoom(props) {
  const type = String(props.type || '');
  if (['country', 'state', 'region'].includes(type)) return type === 'country' ? 5 : 7;
  if (type === 'city' || type === 'county') return 10;
  if (type === 'locality' || type === 'town') return 12;
  return 15;
}

export function normalizeNominatim(payload) {
  const list = Array.isArray(payload) ? payload : [];
  return list.map((entry, index) => {
    const lat = toNumber(entry.lat);
    const lon = toNumber(entry.lon);
    if (lat === null || lon === null) return null;
    return {
      id: `nominatim:${entry.place_id ?? index}`,
      name: entry.name || entry.display_name?.split(',')[0] || 'Unnamed',
      displayName: entry.display_name || '',
      lat,
      lon,
      kind: entry.type || entry.class || 'place',
      category: entry.class || null,
      country: entry.address?.country || null,
      zoom: nominatimZoom(entry),
      bbox: Array.isArray(entry.boundingbox)
        ? [
            toNumber(entry.boundingbox[2]),
            toNumber(entry.boundingbox[0]),
            toNumber(entry.boundingbox[3]),
            toNumber(entry.boundingbox[1]),
          ]
        : null,
    };
  }).filter(Boolean);
}

function nominatimZoom(entry) {
  const zoom = toNumber(entry.zoom ?? entry.place_rank);
  if (zoom !== null) return Math.min(17, Math.max(3, Math.round(zoom)));
  return 12;
}

export async function searchPlaces(query, { signal, limit = 6 } = {}, client = http) {
  const text = String(query || '').trim();
  if (!text) return [];

  const coordinate = coordinateResult(text);
  if (coordinate) return [coordinate];

  try {
    const url = new URL(PHOTON);
    url.searchParams.set('q', text);
    url.searchParams.set('limit', String(limit));
    const { data } = await client.json(url.toString(), {
      signal,
      timeoutMs: 12_000,
      cacheMs: 5 * 60 * 1000,
      retries: 0,
    });
    const results = normalizePhoton(data);
    if (results.length) return results;
  } catch (error) {
    // Photon being unavailable is not a reason to give up.
    if (error?.kind === 'aborted') throw error;
  }

  const url = new URL(NOMINATIM);
  url.searchParams.set('q', text);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');
  const { data } = await client.json(url.toString(), {
    signal,
    timeoutMs: 12_000,
    cacheMs: 5 * 60 * 1000,
    retries: 0,
    // Nominatim's usage policy: no more than about one request per second.
    minIntervalMs: 1_100,
  });
  return normalizeNominatim(data);
}

/**
 * Reverse lookup: the city/region name for a camera position.
 *
 * Used by layers whose catalog is keyed by place name rather than coordinates
 * (GBFS, for one). Photon's reverse endpoint is the primary, Nominatim the
 * fallback, and both are cached hard because a place name does not change.
 * Returns `null` rather than throwing: a failed reverse lookup just means the
 * caller cannot narrow by place this cycle.
 */
export async function reversePlace(lat, lon, { signal } = {}, client = http) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    const url = new URL('https://photon.komoot.io/reverse');
    url.searchParams.set('lat', lat.toFixed(5));
    url.searchParams.set('lon', lon.toFixed(5));
    url.searchParams.set('limit', '1');
    const { data } = await client.json(url.toString(), {
      signal,
      timeoutMs: 12_000,
      cacheMs: 24 * 60 * 60 * 1000,
      staleMs: 7 * 24 * 60 * 60 * 1000,
      retries: 0,
    });
    const [first] = normalizePhoton(data);
    if (first) return first;
  } catch (error) {
    if (error?.kind === 'aborted') throw error;
  }

  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', lat.toFixed(5));
  url.searchParams.set('lon', lon.toFixed(5));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('zoom', '10');
  const { data } = await client.json(url.toString(), {
    signal,
    timeoutMs: 12_000,
    cacheMs: 24 * 60 * 60 * 1000,
    staleMs: 7 * 24 * 60 * 60 * 1000,
    retries: 0,
    // Nominatim's usage policy: no more than about one request per second.
    minIntervalMs: 1_100,
  });
  const entry = Array.isArray(data) ? data[0] : data;
  const [first] = normalizeNominatim(entry ? [entry] : []);
  return first || null;
}
