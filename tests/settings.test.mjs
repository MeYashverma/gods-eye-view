/**
 * Credential and secret-handling tests.
 *
 * The rule being enforced: a user-supplied key is browser-visible by
 * definition, so the only honest guarantees this app can make are that the key
 * never leaves localStorage, never enters a URL, and never appears in a log,
 * export or share link. These tests pin each of those.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTING_FIELDS,
  SECRET_FIELDS,
  redactSettings,
  createSettingsStore,
  SETTINGS_DEFAULTS,
  STORAGE_KEY,
} from '../src/settings/store.js';
import { encodeShareLink, decodeShareLink } from '../src/share/link.js';
import { SOURCES } from '../src/sources/registry.js';

/** In-memory storage so these tests do not touch a real browser profile. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _dump: () => Object.fromEntries(map),
  };
}

test('every settings field is documented with a provider and a link', () => {
  assert.ok(SETTING_FIELDS.length >= 5);
  for (const field of SETTING_FIELDS) {
    assert.ok(field.id, 'a field needs an id');
    assert.ok(field.label.length > 0, `${field.id} needs a label`);
    assert.ok(field.provider.length > 0, `${field.id} needs a provider`);
    assert.match(field.docs, /^https:\/\//, `${field.id} needs an https docs link`);
    assert.ok(field.hint.length > 20, `${field.id} needs a hint explaining what it unlocks`);
    assert.equal(typeof field.secret, 'boolean');
  }
  assert.equal(new Set(SETTING_FIELDS.map((f) => f.id)).size, SETTING_FIELDS.length, 'ids unique');
});

test('credential fields are marked secret', () => {
  assert.ok(SECRET_FIELDS.has('aisStreamKey'));
  assert.ok(SECRET_FIELDS.has('firmsKey'));
  for (const field of SETTING_FIELDS) {
    if (field.secret) assert.ok(SECRET_FIELDS.has(field.id));
  }
});

test('secret values are redacted in any exported snapshot', () => {
  const settings = { aisStreamKey: 'SUPER-SECRET', firmsKey: 'ANOTHER', cesiumIonToken: 'public-ish' };
  const redacted = redactSettings(settings);
  assert.equal(redacted.aisStreamKey, '[redacted]');
  assert.equal(redacted.firmsKey, '[redacted]');
  assert.equal(redacted.cesiumIonToken, 'public-ish', 'non-secret fields stay readable');
  assert.ok(!JSON.stringify(redacted).includes('SUPER-SECRET'));
  assert.equal(settings.aisStreamKey, 'SUPER-SECRET', 'redaction does not mutate the source');
});

test('the store hydrates from storage and ignores malformed JSON', () => {
  const store = createSettingsStore({ storage: memoryStorage({ [STORAGE_KEY]: '{"firmsKey":"K1"}' }) });
  assert.equal(store.get('firmsKey'), 'K1');

  const broken = createSettingsStore({ storage: memoryStorage({ [STORAGE_KEY]: '{not json' }) });
  assert.equal(broken.get('firmsKey'), '', 'unreadable storage degrades to defaults');
  assert.doesNotThrow(() => broken.get());
});

test('unknown and prototype-polluting stored keys are dropped', () => {
  const store = createSettingsStore({
    storage: memoryStorage({
      [STORAGE_KEY]: '{"__proto__":{"polluted":true},"constructor":{},"invented":"x","firmsKey":"ok"}',
    }),
  });
  const values = store.get();
  assert.equal(values.firmsKey, 'ok', 'known keys survive');
  assert.equal(values.invented, undefined, 'unknown keys are dropped');
  assert.deepEqual(
    Object.keys(values).sort(),
    Object.keys(SETTINGS_DEFAULTS).sort(),
    'the stored object cannot add fields to the settings shape',
  );
  assert.equal({}.polluted, undefined, 'Object.prototype was not modified');
});

test('setting an unknown id is refused', () => {
  const store = createSettingsStore({ storage: memoryStorage() });
  const before = store.get();
  store.set('inventedSetting', 'value');
  assert.deepEqual(Object.keys(store.get()), Object.keys(before));
  assert.equal(store.get('inventedSetting'), undefined);
});

test('persistence survives a round trip and reset clears it', () => {
  const storage = memoryStorage();
  const store = createSettingsStore({ storage });
  store.set('firmsKey', 'K2');
  store.set('labelDensity', 'dense');
  assert.equal(JSON.parse(storage._dump()[STORAGE_KEY]).firmsKey, 'K2');

  const reopened = createSettingsStore({ storage });
  assert.equal(reopened.get('firmsKey'), 'K2');
  assert.equal(reopened.get('labelDensity'), 'dense');

  reopened.reset();
  assert.equal(reopened.get('firmsKey'), '');
  assert.equal(reopened.get('labelDensity'), SETTINGS_DEFAULTS.labelDensity);
});

test('subscribers are notified per key and can unsubscribe', () => {
  const store = createSettingsStore({ storage: memoryStorage() });
  const seen = [];
  const unsubscribe = store.subscribe((values, key) => seen.push([key, values.firmsKey]));
  store.set('firmsKey', 'A');
  store.set('firmsKey', 'A', );
  store.set('cesiumIonToken', 'T');
  assert.deepEqual(seen, [['firmsKey', 'A'], ['cesiumIonToken', 'A']], 'no-op writes do not notify');
  unsubscribe();
  store.set('firmsKey', 'B');
  assert.equal(seen.length, 2);
});

test('a listener that throws does not break the store', () => {
  const store = createSettingsStore({ storage: memoryStorage() });
  store.subscribe(() => {
    throw new Error('bad listener');
  });
  assert.doesNotThrow(() => store.set('firmsKey', 'X'));
  assert.equal(store.get('firmsKey'), 'X');
});

test('a storage failure is tolerated, not fatal', () => {
  const exploding = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
  const store = createSettingsStore({ storage: exploding });
  assert.doesNotThrow(() => store.set('firmsKey', 'X'));
  assert.equal(store.get('firmsKey'), 'X', 'the value still works in memory');
});

test('secrets never reach a share link', () => {
  const storage = memoryStorage();
  const store = createSettingsStore({ storage });
  store.set('firmsKey', 'TOP-SECRET-FIRMS');
  store.set('aisStreamKey', 'TOP-SECRET-AIS');

  const hash = encodeShareLink(
    { camera: { lat: 1, lon: 2, heightM: 1000 }, layers: [], ...store.get() },
    ['aircraft', 'fires'],
  );
  assert.ok(!hash.includes('TOP-SECRET'), `secret leaked into the hash: ${hash}`);
  const decoded = decodeShareLink(hash, ['aircraft', 'fires']);
  assert.equal(decoded.firmsKey, undefined, 'a key is not a shareable parameter');
  assert.equal(decoded.aisStreamKey, undefined);
});

test('the app works with no credentials configured at all', () => {
  const store = createSettingsStore({ storage: memoryStorage() });
  for (const field of SETTING_FIELDS) {
    assert.equal(store.get(field.id), '', `${field.id} must default to empty`);
    assert.equal(store.has(field.id), false);
  }
  // Every documented field has a default, so a fresh install is a valid state.
  assert.deepEqual(
    Object.keys(store.get()).sort(),
    Object.keys(SETTINGS_DEFAULTS).sort(),
  );
});

test('the source registry flags which providers a browser cannot reach directly', () => {
  const blocked = Object.entries(SOURCES).filter(([, source]) => source.browserDirect === false);
  assert.ok(blocked.length >= 3, 'ADS-B, adsbdb and FIRMS are known to be non-CORS');
  for (const [id, source] of blocked) {
    assert.equal(source.id, id, 'the registry key must equal the source id');
    assert.ok(source.notes?.length > 10, `${id} must explain why a browser cannot call it`);
  }
  for (const source of Object.values(SOURCES)) {
    assert.match(source.url, /^https:\/\//, `${source.id} must be https`);
    assert.ok(source.license?.length > 0, `${source.id} must state its terms`);
  }
});
