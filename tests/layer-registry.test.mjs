/**
 * Layer catalog integrity.
 *
 * Builds the real catalog in Node (Cesium's non-visual classes load headless)
 * and asserts the invariants the rail, share links and attribution panel all
 * depend on — most importantly that no layer claims a capability it does not
 * have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLayers, groupLayers, layerIds } from '../src/layers/registry.js';
import { LAYER_CATEGORIES, checkRequirements, createRefreshScheduler } from '../src/layers/base.js';
import { LAYER_STATUS } from '../src/net/status.js';
import { SOURCES, getSource } from '../src/sources/registry.js';
import { ICON_NAMES } from '../src/core/icons.js';
import { VISUAL_STYLES, SHADERS, STYLE_IDS } from '../src/tools/effects.js';

/**
 * A minimal stand-in for the surface `main.js` hands every layer. Layers only
 * touch it while attached, so a stub is enough to assert attach-time status.
 */
function makeSurface() {
  const listeners = new Set();
  return {
    viewer: { entities: { add: () => ({}), remove: () => {} }, dataSources: { add: () => {}, remove: () => {} }, scene: {} },
    settings: { get: () => '', has: () => false },
    store: { get: () => ({}), patch: () => {}, subscribe: () => () => {} },
    camera: { focus: () => ({ lat: 0, lon: 0, heightM: 1e7 }), viewportBox: () => ({ south: -1, west: -1, north: 1, east: 1 }) },
    events: { on: (t, fn) => { listeners.add(fn); return () => listeners.delete(fn); }, emit: () => {}, off: () => {} },
    http: { json: async () => ({ data: null }), text: async () => ({ data: '' }) },
    overpassIndex: 0,
  };
}

const layers = buildLayers();
const ids = layerIds(layers);

test('the catalog covers every documented category', () => {
  const expected = ['movement', 'space', 'events', 'weather', 'cameras', 'infrastructure', 'utilities'];
  for (const category of expected) {
    assert.ok(LAYER_CATEGORIES.some((entry) => entry.id === category), `${category} is not a declared category`);
    assert.ok(layers.some((layer) => layer.category === category), `no layer in ${category}`);
  }
});

test('layer ids are unique and share-safe', () => {
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/, `${id} is not a safe id`);
});

test('every layer has the fields the rail and detail panel read', () => {
  for (const layer of layers) {
    assert.ok(layer.id, 'layer needs an id');
    assert.ok(layer.name?.length > 0, `${layer.id} needs a name`);
    assert.ok(layer.description?.length > 20, `${layer.id} needs a real description`);
    assert.ok(ICON_NAMES.includes(layer.icon), `${layer.id} uses unknown icon "${layer.icon}"`);
    assert.ok(LAYER_CATEGORIES.some((c) => c.id === layer.category), `${layer.id} has unknown category`);
    assert.ok(typeof layer.show === 'function', `${layer.id} needs show()`);
    assert.ok(typeof layer.hide === 'function', `${layer.id} needs hide()`);
    assert.ok(typeof layer.refresh === 'function', `${layer.id} needs refresh()`);
    assert.ok(typeof layer.snapshot === 'function', `${layer.id} needs snapshot()`);
    assert.ok(typeof layer.detail === 'function', `${layer.id} needs detail()`);
    assert.ok(typeof layer.dispose === 'function', `${layer.id} needs dispose()`);
    const snapshot = layer.snapshot();
    assert.equal(typeof snapshot.supported, 'boolean', `${layer.id} must state whether it is supported`);
    assert.ok(Array.isArray(snapshot.requires), `${layer.id} must declare its requirements`);
  }
});

test('every layer cites a registered data source', () => {
  for (const layer of layers) {
    const sources = Array.isArray(layer.sources) ? layer.sources : [layer.sources];
    assert.ok(sources.length > 0, `${layer.id} cites no source`);
    for (const id of sources) {
      assert.ok(getSource(id), `${layer.id} cites unknown source "${id}"`);
    }
  }
});

const KNOWN_SETTINGS = [
  'aisStreamKey', 'firmsKey', 'cesiumIonToken', 'googleMapsKey', 'mapillaryToken', 'adsbEndpoint', 'osrmUrl',
];

test('layers that need credentials name the setting they need', () => {
  const keyGated = layers.filter((layer) => layer.snapshot().requires.length);
  assert.ok(keyGated.length >= 2, 'at least AIS and street-level imagery are gated');
  for (const layer of keyGated) {
    for (const requirement of layer.snapshot().requires) {
      assert.equal(requirement.kind, 'setting', `${layer.id} has an unhandled requirement kind`);
      assert.ok(KNOWN_SETTINGS.includes(requirement.id), `${layer.id} requires unknown setting "${requirement.id}"`);
      assert.ok(requirement.label?.length > 0, `${layer.id} must name the setting for the user`);
    }
  }
  // checkRequirements turns those into human-readable blockers.
  const vessels = layers.find((layer) => layer.id === 'vessels');
  const blockers = checkRequirements(vessels.snapshot().requires, { settings: { has: () => false } });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /AISStream/i, 'the blocker names the provider');
  assert.deepEqual(checkRequirements(vessels.snapshot().requires, { settings: { has: () => true } }), []);
});

test('the ADS-B layers state the CORS limitation to the user', () => {
  // No public ADS-B API sends CORS headers, so a static site cannot read one
  // directly. The description has to say that rather than imply live traffic.
  for (const id of ['aircraft', 'military']) {
    const layer = layers.find((entry) => entry.id === id);
    assert.match(layer.description, /CORS|sample|user-supplied|endpoint|feed/i, `${id} must state where the data comes from`);
  }
  const vessels = layers.find((layer) => layer.id === 'vessels');
  assert.ok(
    vessels.snapshot().requires.some((r) => r.id === 'aisStreamKey'),
    'AIS needs a key and must declare it',
  );
});

test('sample data is reported as SIMULATED and never as LIVE', () => {
  assert.equal(LAYER_STATUS.SIMULATED, 'simulated');
  assert.equal(LAYER_STATUS.LIVE, 'live');
  assert.notEqual(LAYER_STATUS.SIMULATED, LAYER_STATUS.LIVE);
  // The demo flag is per-layer state, flipped only by an adapter that says so.
  for (const layer of layers) {
    assert.equal(typeof layer.snapshot().demo, 'boolean');
    assert.equal(layer.snapshot().demo, false, 'no layer ships enabled in demo mode');
  }
});

test('a layer starts hidden and idle before it is attached', () => {
  const layer = layers.find((entry) => entry.id === 'earthquakes');
  assert.equal(layer.visible, false, 'layers do not fetch until switched on');
  const snapshot = layer.snapshot();
  assert.ok([LAYER_STATUS.IDLE, LAYER_STATUS.OFF].includes(snapshot.status), `was ${snapshot.status}`);
  assert.equal(snapshot.count, 0);
});

test('groups contain every layer exactly once', () => {
  const groups = groupLayers(layers);
  const grouped = groups.flatMap((group) => group.layers.map((layer) => layer.id));
  assert.equal(grouped.length, layers.length, 'no layer lost or duplicated by grouping');
  assert.deepEqual([...grouped].sort(), [...ids].sort());
  for (const group of groups) {
    assert.ok(group.label.length > 0);
    assert.ok(ICON_NAMES.includes(group.icon), `group ${group.id} uses unknown icon`);
    assert.ok(group.layers.length > 0, 'an empty group is not rendered');
  }
});

test('a disabled layer reports unavailable rather than pretending to work', () => {
  const unsupported = layers.filter((layer) => layer.snapshot().supported === false);
  assert.ok(unsupported.length > 0, 'something in the catalog is honestly marked unsupported');
  for (const layer of unsupported) {
    assert.equal(layer.snapshot().id, layer.id);
    // Attaching flips an unsupported layer straight to UNAVAILABLE.
    layer.attach(makeSurface());
    assert.equal(layer.snapshot().status, LAYER_STATUS.UNAVAILABLE, `${layer.id} must report unavailable`);
    layer.dispose();
  }
});

test('the transit layer does not claim live vehicles it cannot show', () => {
  const transit = layers.find((layer) => layer.id === 'transit');
  assert.match(transit.description, /NOT implemented/i, 'the missing capability is stated outright');
  assert.match(transit.description, /stops?/i, 'and what it does show is stated');
});

test('the ALPR layer exposes locations only, with the privacy line attached', () => {
  const alpr = layers.find((layer) => layer.id === 'alpr');
  const text = `${alpr.name} ${alpr.description}`.toLowerCase();
  assert.match(text, /locations? and public tags only/i, 'it is a location layer');
  assert.match(text, /no plate reading|no plate recognition/i, 'plate reading is explicitly excluded');
  assert.match(text, /no.*person search|no.*storage/i, 'person search and storage are explicitly excluded');
});

test('refresh intervals are sane and non-polling layers opt out', () => {
  for (const layer of layers) {
    assert.ok(Number.isFinite(layer.refreshMs), `${layer.id} has no refreshMs`);
    assert.ok(layer.refreshMs >= 0, `${layer.id} has a negative interval`);
    if (layer.refreshMs > 0) {
      assert.ok(layer.refreshMs >= 5_000, `${layer.id} refreshes faster than 5s — that is a polling storm`);
    }
  }
  const pushBased = layers.filter((layer) => layer.refreshMs === 0);
  assert.ok(pushBased.length > 0, 'AIS and routing are event driven, not polled');
});

test('the scheduler sweeps only visible layers and can be stopped cleanly', () => {
  const refreshed = [];
  const stub = (id, extra = {}) => ({
    id,
    visible: false,
    viewportAware: false,
    count: 0,
    status: 'idle',
    refreshMs: 60_000,
    snapshot: () => ({ fetchedAt: 0 }),
    refresh: () => { refreshed.push(id); return Promise.resolve(); },
    ...extra,
  });
  const hidden = stub('hidden');
  const shown = stub('shown', { visible: true });
  const cameraDriven = stub('camera', { visible: true, viewportAware: true });

  let ticks = 0;
  const scheduler = createRefreshScheduler({
    layers: () => [hidden, shown, cameraDriven],
    intervalMs: 10,
    onTick: () => { ticks += 1; },
  });
  assert.equal(typeof scheduler.start, 'function');
  assert.equal(typeof scheduler.stop, 'function');
  assert.equal(typeof scheduler.tickNow, 'function');

  scheduler.tickNow();
  assert.deepEqual(refreshed, ['shown'], 'hidden and camera-driven layers are not swept by the clock');
  assert.equal(ticks, 1);

  scheduler.start();
  scheduler.stop();
  assert.equal(scheduler.paused, false);
});

test('the scheduler pauses while the tab is backgrounded', () => {
  const refreshed = [];
  const layer = {
    id: 'a', visible: true, viewportAware: false, count: 0, status: 'idle', refreshMs: 0,
    snapshot: () => ({ fetchedAt: 0 }),
    refresh: () => { refreshed.push('a'); return Promise.resolve(); },
  };
  const scheduler = createRefreshScheduler({ layers: () => [layer], intervalMs: 10 });
  scheduler.tickNow();
  assert.equal(refreshed.length, 1, 'a fresh tick refreshes a due layer');
  scheduler.stop();
});

test('every visual style is a real fragment shader, not a CSS filter', () => {
  assert.ok(VISUAL_STYLES.length >= 7);
  assert.deepEqual(STYLE_IDS, VISUAL_STYLES.map((style) => style.id));
  for (const style of VISUAL_STYLES) {
    assert.ok(style.id && style.label.length > 0);
    assert.ok(style.description.length > 10, `${style.id} must say what the style actually is`);
    if (style.id === 'normal') {
      assert.equal(SHADERS[style.id], undefined, '"normal" is the no-effect state');
      continue;
    }
    const shader = SHADERS[style.id];
    assert.ok(shader, `${style.id} has no shader — it would be a fake style`);
    assert.ok(shader.includes('void main'), `${style.id} must be a real fragment shader`);
    assert.ok(shader.includes('colorTexture'), `${style.id} must read the scene colour buffer`);
    assert.ok(!shader.includes('url('), `${style.id} must not be an image overlay`);
  }
});

test('the style descriptions do not claim sensor data they do not have', () => {
  const flir = VISUAL_STYLES.find((style) => style.id === 'flir');
  assert.match(flir.description, /stylis|not radiometric|not thermal data/i, 'FLIR is a look, not thermal data');
  const nvg = VISUAL_STYLES.find((style) => style.id === 'nvg');
  assert.match(nvg.description, /not real night vision|rendering style/i);
});

test('source ids are unique and every source declares its licence terms', () => {
  const entries = Object.entries(SOURCES);
  assert.equal(new Set(entries.map(([id]) => id)).size, entries.length);
  for (const [id, source] of entries) {
    assert.equal(source.id, id);
    assert.ok(source.name?.length > 0, `${id} needs a display name`);
    assert.ok(source.license?.length > 0, `${id} must state its licence or terms`);
    assert.ok(source.attribution?.length > 0, `${id} must state who to credit`);
    assert.ok(source.url?.length > 0, `${id} must be linkable for attribution`);
    assert.match(source.url, /^https:\/\//, `${id} must be https`);
    assert.equal(typeof source.browserDirect, 'boolean', `${id} must state whether a browser can call it`);
    assert.ok(source.refreshMs >= 0, `${id} needs a refresh policy`);
    assert.ok(source.notes?.length > 10, `${id} needs usage notes`);
  }
});
