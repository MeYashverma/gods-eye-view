/**
 * Share links.
 *
 * State lives in the URL hash so a link works on a GitHub Pages subpath
 * without touching the path component, and so nothing is sent to a server.
 *
 * Everything is bounded and validated on the way in: a malformed, hostile or
 * absurdly long hash must degrade to "ignore it and use defaults", never
 * break navigation. The encoder is symmetric with the decoder and both are
 * unit-tested.
 */

import { clamp } from '../geo/coords.js';
import { STYLE_IDS } from '../tools/effects.js';

export const MAX_HASH_LENGTH = 900;

/** Short, stable parameter names keep links readable. */
const PARAMS = Object.freeze({
  lat: 'la',
  lon: 'lo',
  height: 'h',
  heading: 'hd',
  pitch: 'p',
  style: 'st',
  layers: 'l',
  selection: 'sel',
  hud: 'hud',
  clean: 'cl',
  map: 'm',
  terrain: 't',
});

const NUMERIC_BOUNDS = Object.freeze({
  la: [-90, 90],
  lo: [-180, 180],
  h: [250, 40_000_000],
  hd: [0, 359],
  p: [-90, 0],
});

/** Layer ids are compressed to their index in the catalog. */
export function encodeLayerIds(ids, catalog) {
  if (!ids?.length) return '';
  const indices = [];
  for (const id of ids) {
    const index = catalog.indexOf(id);
    if (index >= 0) indices.push(index);
  }
  return indices.join('.');
}

export function decodeLayerIds(token, catalog) {
  if (!token) return [];
  const out = [];
  for (const part of String(token).split('.')) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= catalog.length) continue;
    const id = catalog[index];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Serialize application state into a hash string (without the leading `#`).
 * @param {object} state
 * @param {string[]} catalog ordered layer ids
 */
export function encodeShareLink(state, catalog) {
  const params = new URLSearchParams();
  const camera = state.camera;
  if (camera) {
    if (Number.isFinite(camera.lat)) params.set(PARAMS.lat, camera.lat.toFixed(4));
    if (Number.isFinite(camera.lon)) params.set(PARAMS.lon, camera.lon.toFixed(4));
    if (Number.isFinite(camera.heightM)) params.set(PARAMS.height, String(Math.round(camera.heightM)));
    if (Number.isFinite(camera.heading)) params.set(PARAMS.heading, String(Math.round(camera.heading)));
    if (Number.isFinite(camera.pitch)) params.set(PARAMS.pitch, String(Math.round(camera.pitch)));
  }
  if (state.style && STYLE_IDS.includes(state.style)) params.set(PARAMS.style, state.style);
  const layerToken = encodeLayerIds(state.layers, catalog);
  if (layerToken) params.set(PARAMS.layers, layerToken);
  if (state.selection?.layerId && state.selection?.recordId) {
    params.set(
      PARAMS.selection,
      `${encodeURIComponent(state.selection.layerId)}~${encodeURIComponent(state.selection.recordId)}`,
    );
  }
  if (state.hud) params.set(PARAMS.hud, '1');
  if (state.clean) params.set(PARAMS.clean, '1');
  if (state.mapStack) params.set(PARAMS.map, state.mapStack);
  if (state.terrain) params.set(PARAMS.terrain, state.terrain);
  return params.toString();
}

function readNumber(params, key, fallback) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const bounds = NUMERIC_BOUNDS[key];
  return bounds ? clamp(value, bounds[0], bounds[1]) : value;
}

/**
 * Parse a hash back into application state.
 * Unknown keys are ignored; invalid values fall back rather than throwing.
 */
export function decodeShareLink(hash, catalog, { knownMapStacks = [], knownTerrains = [] } = {}) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text) return null;
  if (text.length > MAX_HASH_LENGTH) return null;

  let params;
  try {
    params = new URLSearchParams(text);
  } catch {
    return null;
  }

  const state = {};
  const lat = params.get(PARAMS.lat);
  const lon = params.get(PARAMS.lon);
  if (lat !== null || lon !== null) {
    state.camera = {
      lat: readNumber(params, PARAMS.lat, 20),
      lon: readNumber(params, PARAMS.lon, 0),
      heightM: readNumber(params, PARAMS.height, 12_000_000),
      heading: readNumber(params, PARAMS.heading, 0),
      pitch: readNumber(params, PARAMS.pitch, -90),
    };
  }

  const style = params.get(PARAMS.style);
  if (style && STYLE_IDS.includes(style)) state.style = style;

  const layerToken = params.get(PARAMS.layers);
  if (layerToken) state.layers = decodeLayerIds(layerToken, catalog);

  const selection = params.get(PARAMS.selection);
  if (selection) {
    const [layerId, recordId] = selection.split('~');
    const decodedLayer = safeDecode(layerId);
    const decodedRecord = safeDecode(recordId);
    if (decodedLayer && decodedRecord && catalog.includes(decodedLayer)) {
      state.selection = { layerId: decodedLayer, recordId: decodedRecord.slice(0, 120) };
    }
  }

  state.hud = params.get(PARAMS.hud) === '1';
  state.clean = params.get(PARAMS.clean) === '1';

  const mapStack = params.get(PARAMS.map);
  if (mapStack && knownMapStacks.includes(mapStack)) state.mapStack = mapStack;

  const terrain = params.get(PARAMS.terrain);
  if (terrain && knownTerrains.includes(terrain)) state.terrain = terrain;

  return state;
}

/** Decode one percent-encoded component, refusing anything pathological. */
function safeDecode(value) {
  if (typeof value !== 'string' || value.length > 120) return null;
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9._:-]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Replace the hash without adding a history entry per keystroke. */
export function writeHash(hash, { replace = true } = {}) {
  if (typeof window === 'undefined') return;
  const url = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`;
  if (replace) window.history.replaceState(null, '', url);
  else window.location.hash = hash;
}

export function readHash() {
  return typeof window === 'undefined' ? '' : window.location.hash;
}
