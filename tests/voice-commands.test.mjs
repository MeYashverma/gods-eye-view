import test from 'node:test';
import assert from 'node:assert/strict';

import { INTENTS, CAMERA_VERBS, parseCommand, buildLayerAliases } from '../src/voice/commands.js';
import { STYLE_IDS } from '../src/tools/effects.js';

const LAYERS = [
  { id: 'aircraft', name: 'Civil aircraft' },
  { id: 'military', name: 'Military aircraft' },
  { id: 'fires', name: 'Active fires (NASA FIRMS)' },
  { id: 'earthquakes', name: 'Earthquakes (USGS)' },
  { id: 'satellites', name: 'Satellites' },
];

const ALIASES = buildLayerAliases(LAYERS);
const VOCAB = { layerAliases: ALIASES, styleIds: STYLE_IDS };

test('every intent the executor handles is declared', () => {
  const expected = [
    'fly-to', 'toggle-layer', 'set-layer', 'style', 'camera', 'track',
    'refresh', 'share', 'clean', 'describe', 'help', 'unknown',
  ];
  assert.deepEqual(Object.values(INTENTS).sort(), [...expected].sort());
});

test('layer aliases include the plain name and a short form', () => {
  assert.equal(ALIASES.get('civil aircraft'), 'aircraft');
  assert.equal(ALIASES.get('active fires'), 'fires', 'short form of a parenthesised name');
  assert.equal(ALIASES.get('active fires (nasa firms)'), 'fires');
  assert.equal(ALIASES.get('satellites'), 'satellites');
});

test('"fly to <place>" produces a place query', () => {
  const result = parseCommand('Fly to Tokyo', VOCAB);
  assert.equal(result.intent, INTENTS.FLY_TO);
  assert.equal(result.query, 'Tokyo');
});

test('other travel phrasings are understood', () => {
  for (const phrase of ['navigate to Reykjavik', 'take me to Svalbard', 'go to the Azores', 'where is Kiribati']) {
    const result = parseCommand(phrase, VOCAB);
    assert.equal(result.intent, INTENTS.FLY_TO, phrase);
    assert.ok(result.query.length > 0, phrase);
  }
});

test('"fly to the globe" is not treated as a place', () => {
  assert.notEqual(parseCommand('fly to the globe', VOCAB).intent, INTENTS.FLY_TO);
});

test('layer toggles resolve to the right layer', () => {
  const on = parseCommand('show earthquakes', VOCAB);
  assert.equal(on.intent, INTENTS.SET_LAYER);
  assert.equal(on.layerId, 'earthquakes');
  assert.equal(on.enabled, true);

  const off = parseCommand('turn off satellites', VOCAB);
  assert.equal(off.layerId, 'satellites');
  assert.equal(off.enabled, false);
});

test('the longest matching alias wins', () => {
  const result = parseCommand('show military aircraft', VOCAB);
  assert.equal(result.intent, INTENTS.SET_LAYER);
  assert.equal(result.layerId, 'military', 'must not collapse to "aircraft"');
});

test('an ambiguous toggle reports no preference', () => {
  const result = parseCommand('toggle satellites', VOCAB);
  assert.equal(result.intent, INTENTS.SET_LAYER);
  assert.equal(result.enabled, null, 'the executor decides, the parser does not guess');
});

test('an unrecognised layer name is not invented', () => {
  const result = parseCommand('show me the submarines', VOCAB);
  assert.notEqual(result.intent, INTENTS.SET_LAYER);
});

test('visual styles map onto ids the renderer owns', () => {
  const cases = [
    ['night vision', 'nvg'],
    ['thermal', 'flir'],
    ['switch to infrared', 'flir'],
    ['monochrome', 'mono'],
    ['crt', 'crt'],
    ['blueprint', 'blueprint'],
  ];
  for (const [phrase, style] of cases) {
    const result = parseCommand(phrase, VOCAB);
    assert.equal(result.intent, INTENTS.STYLE, phrase);
    assert.equal(result.style, style, phrase);
    assert.ok(STYLE_IDS.includes(result.style), `${style} must be a real style`);
  }
});

test('an unknown style is refused rather than passed through', () => {
  assert.notEqual(parseCommand('set style rainbow', VOCAB).intent, INTENTS.STYLE);
});

test('camera verbs resolve to concrete actions', () => {
  assert.equal(parseCommand('reset camera', VOCAB).action, 'reset');
  assert.equal(parseCommand('zoom in', VOCAB).action, 'zoom-in');
  assert.equal(parseCommand('zoom out', VOCAB).action, 'zoom-out');
  assert.equal(parseCommand('top down', VOCAB).action, 'top-down');
  assert.equal(parseCommand('orbit left', VOCAB).degrees, -45);
  assert.equal(parseCommand('orbit right', VOCAB).degrees, 45);
  assert.equal(parseCommand('tilt up', VOCAB).delta, 15);
  assert.equal(parseCommand('tilt down', VOCAB).delta, -15);
  for (const phrase of Object.keys(CAMERA_VERBS)) {
    assert.equal(parseCommand(phrase, VOCAB).intent, INTENTS.CAMERA, phrase);
  }
});

test('tracking, refresh, share, clean, describe and help all parse', () => {
  assert.equal(parseCommand('track this', VOCAB).intent, INTENTS.TRACK);
  assert.equal(parseCommand('track this', VOCAB).enabled, true);
  assert.equal(parseCommand('stop tracking', VOCAB).intent, INTENTS.TRACK);
  assert.equal(parseCommand('refresh data', VOCAB).intent, INTENTS.REFRESH);
  assert.equal(parseCommand('share this view', VOCAB).intent, INTENTS.SHARE);
  assert.equal(parseCommand('clean view', VOCAB).intent, INTENTS.CLEAN);
  assert.equal(parseCommand('clean view', VOCAB).enabled, true);
  assert.equal(parseCommand('turn clean mode off', VOCAB).enabled, false);
  assert.equal(parseCommand('what is selected', VOCAB).intent, INTENTS.DESCRIBE);
  assert.equal(parseCommand('help', VOCAB).intent, INTENTS.HELP);
});

test('punctuation, case and whitespace do not break matching', () => {
  assert.equal(parseCommand('  FLY   TO   tokyo!  ', VOCAB).intent, INTENTS.FLY_TO);
  assert.equal(parseCommand('SHOW EARTHQUAKES?', VOCAB).intent, INTENTS.SET_LAYER);
});

test('unrecognised speech is reported as unknown, never acted on', () => {
  const result = parseCommand('order a pizza', VOCAB);
  assert.equal(result.intent, INTENTS.UNKNOWN);
  assert.equal(result.reason, 'order a pizza', 'the executor can tell the user what it heard');
});

test('empty input is unknown, not an error', () => {
  assert.equal(parseCommand('', VOCAB).intent, INTENTS.UNKNOWN);
  assert.equal(parseCommand(null, VOCAB).intent, INTENTS.UNKNOWN);
  assert.equal(parseCommand(undefined, VOCAB).intent, INTENTS.UNKNOWN);
  assert.equal(parseCommand('   ', VOCAB).intent, INTENTS.UNKNOWN);
});

test('an absurdly long transcript cannot become a place query', () => {
  const result = parseCommand(`fly to ${'a'.repeat(500)}`, VOCAB);
  assert.notEqual(result.intent, INTENTS.FLY_TO);
});

test('the parser works with no vocabulary at all', () => {
  assert.equal(parseCommand('fly to Oslo').intent, INTENTS.FLY_TO);
  assert.equal(parseCommand('help').intent, INTENTS.HELP);
  assert.doesNotThrow(() => parseCommand('help'));
  // With no layer aliases there is nothing to toggle, so "show X" degrades to a
  // place search rather than silently doing nothing.
  assert.equal(parseCommand('show earthquakes').intent, INTENTS.FLY_TO);
});
