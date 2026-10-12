import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_HASH_LENGTH,
  encodeLayerIds,
  decodeLayerIds,
  encodeShareLink,
  decodeShareLink,
} from '../src/share/link.js';
import { buildLayers, layerIds } from '../src/layers/registry.js';
import { IMAGERY_STACKS, TERRAIN_STACKS } from '../src/maps/catalog.js';

const CATALOG = layerIds(buildLayers());
const MAP_STACKS = IMAGERY_STACKS.map((stack) => stack.id);
const TERRAINS = TERRAIN_STACKS.map((stack) => stack.id);

test('the catalog is non-empty and duplicate-free', () => {
  assert.ok(CATALOG.length >= 20, `expected a full catalog, got ${CATALOG.length}`);
  assert.equal(new Set(CATALOG).size, CATALOG.length, 'layer ids must be unique');
  for (const id of CATALOG) assert.match(id, /^[a-z0-9-]+$/, `${id} is not a share-safe id`);
});

test('layer ids round-trip through catalog indices', () => {
  const sample = [CATALOG[0], CATALOG[3], CATALOG[CATALOG.length - 1]];
  const token = encodeLayerIds(sample, CATALOG);
  assert.deepEqual(decodeLayerIds(token, CATALOG), sample);
});

test('unknown and out-of-range layer tokens are dropped, not trusted', () => {
  assert.deepEqual(decodeLayerIds('', CATALOG), []);
  assert.deepEqual(decodeLayerIds('99999', CATALOG), []);
  assert.deepEqual(decodeLayerIds('-1', CATALOG), []);
  assert.deepEqual(decodeLayerIds('abc', CATALOG), []);
  assert.deepEqual(decodeLayerIds('1.1.1', CATALOG), [CATALOG[1]], 'duplicates collapse');
});

test('encode/decode is symmetric for a realistic state', () => {
  const state = {
    camera: { lat: 48.8566, lon: 2.3522, heightM: 1_500_000, heading: 33, pitch: -42 },
    style: 'nvg',
    layers: [CATALOG[1], CATALOG[5]],
    selection: { layerId: CATALOG[1], recordId: 'AEU123' },
    hud: true,
    clean: false,
    mapStack: MAP_STACKS[0],
    terrain: TERRAINS[0],
  };
  const hash = encodeShareLink(state, CATALOG);
  assert.ok(hash.length < MAX_HASH_LENGTH, `hash too long: ${hash.length}`);
  const decoded = decodeShareLink(hash, CATALOG, {
    knownMapStacks: MAP_STACKS,
    knownTerrains: TERRAINS,
  });
  assert.ok(Math.abs(decoded.camera.lat - state.camera.lat) < 1e-3);
  assert.ok(Math.abs(decoded.camera.lon - state.camera.lon) < 1e-3);
  assert.equal(decoded.camera.heightM, state.camera.heightM);
  assert.equal(decoded.camera.heading, 33);
  assert.equal(decoded.camera.pitch, -42);
  assert.equal(decoded.style, 'nvg');
  assert.deepEqual(decoded.layers, state.layers);
  assert.deepEqual(decoded.selection, { layerId: CATALOG[1], recordId: 'AEU123' });
  assert.equal(decoded.hud, true);
  assert.equal(decoded.clean, false);
  assert.equal(decoded.mapStack, MAP_STACKS[0]);
  assert.equal(decoded.terrain, TERRAINS[0]);
});

test('out-of-range camera values are clamped into legal bounds', () => {
  const decoded = decodeShareLink('la=999&lo=-999&h=1&hd=9999&p=99', CATALOG);
  assert.equal(decoded.camera.lat, 90);
  assert.equal(decoded.camera.lon, -180);
  assert.equal(decoded.camera.heightM, 250, 'height floor keeps the camera above ground');
  assert.equal(decoded.camera.heading, 359);
  assert.equal(decoded.camera.pitch, 0, 'pitch ceiling is the horizon');
});

test('non-numeric camera values fall back to defaults instead of NaN', () => {
  const decoded = decodeShareLink('la=abc&lo=xyz', CATALOG);
  for (const [key, value] of Object.entries(decoded.camera)) {
    assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
  assert.equal(decoded.camera.lat, 20);
  assert.equal(decoded.camera.lon, 0);
});

test('hostile selections are refused', () => {
  const cases = [
    `sel=${encodeURIComponent('../../etc/passwd')}~x`,
    `sel=${CATALOG[0]}~${encodeURIComponent('<script>alert(1)</script>')}`,
    `sel=${CATALOG[0]}~${'a'.repeat(500)}`,
    `sel=not-a-layer~AEU1`,
    `sel=${encodeURIComponent('%zz')}~AEU1`,
  ];
  for (const hash of cases) {
    const decoded = decodeShareLink(hash, CATALOG);
    assert.equal(decoded.selection, undefined, `${hash} should not produce a selection`);
  }
});

test('a legitimate selection survives', () => {
  const hash = encodeShareLink(
    { selection: { layerId: CATALOG[2], recordId: 'SAT-25544.7' } },
    CATALOG,
  );
  const decoded = decodeShareLink(hash, CATALOG);
  assert.deepEqual(decoded.selection, { layerId: CATALOG[2], recordId: 'SAT-25544.7' });
});

test('oversized hashes are ignored wholesale', () => {
  assert.equal(decodeShareLink(`la=1&pad=${'x'.repeat(MAX_HASH_LENGTH + 10)}`, CATALOG), null);
});

test('unknown styles, map stacks and terrains are ignored', () => {
  const decoded = decodeShareLink('st=psychedelic&m=evil-tiles&t=evil-terrain', CATALOG, {
    knownMapStacks: MAP_STACKS,
    knownTerrains: TERRAINS,
  });
  assert.equal(decoded.style, undefined);
  assert.equal(decoded.mapStack, undefined);
  assert.equal(decoded.terrain, undefined);
});

test('empty and malformed input degrades to null, never throws', () => {
  assert.equal(decodeShareLink('', CATALOG), null);
  assert.equal(decodeShareLink('#', CATALOG), null);
  assert.equal(decodeShareLink(null, CATALOG), null);
  assert.equal(decodeShareLink(undefined, CATALOG), null);
  assert.doesNotThrow(() => decodeShareLink('#%&^$@!~`', CATALOG));
});

test('flags default to false when absent', () => {
  const decoded = decodeShareLink(`l=${CATALOG.indexOf(CATALOG[0])}`, CATALOG);
  assert.equal(decoded.hud, false);
  assert.equal(decoded.clean, false);
});
