import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYER_STATUS,
  IS_DATA_STATE,
  statusTone,
  statusLabel,
  hasLiveData,
  statusFromFailureKind,
  evaluateFreshness,
  formatAge,
  formatUtc,
  formatUtcDateTime,
} from '../src/net/status.js';
import {
  FAILURE_KIND,
  classifyFetchFailure,
  backoffDelay,
  cacheKey,
  createCache,
  isHttpError,
} from '../src/net/http.js';

test('every documented status exists exactly once', () => {
  const expected = [
    'idle', 'off', 'loading', 'live', 'stale', 'empty',
    'error', 'blocked', 'offline', 'rate-limited', 'config-required',
    'unavailable', 'simulated',
  ];
  const values = Object.values(LAYER_STATUS);
  assert.equal(new Set(values).size, values.length, 'no duplicate status values');
  assert.equal(values.length, expected.length, 'no undocumented statuses added');
  for (const status of expected) {
    assert.ok(values.includes(status), `missing status ${status}`);
  }
});

test('every status maps to a tone the stylesheet actually defines', async () => {
  // Read the real stylesheet rather than a copy of it, so a new status without
  // a matching `.dot--*` rule fails here instead of rendering an invisible dot.
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles/layout.css', import.meta.url), 'utf8');
  const defined = new Set([...css.matchAll(/\.dot--([a-z-]+)/g)].map((m) => m[1]));
  for (const status of Object.values(LAYER_STATUS)) {
    const tone = statusTone(status);
    assert.ok(defined.has(tone), `${status} -> tone "${tone}" has no .dot--${tone} rule`);
  }
});

test('statuses have human labels with no empty strings', () => {
  for (const status of Object.values(LAYER_STATUS)) {
    const label = statusLabel(status);
    assert.ok(label.length > 0, `${status} needs a label`);
    assert.notEqual(label, 'Unknown', `${status} fell through to the Unknown label`);
  }
  assert.equal(statusLabel('not-a-status'), 'Unknown');
});

test('sample data is never reported as live', () => {
  assert.ok(hasLiveData(LAYER_STATUS.LIVE));
  assert.ok(hasLiveData(LAYER_STATUS.STALE), 'stale observations are still observations');
  assert.ok(!hasLiveData(LAYER_STATUS.SIMULATED), 'the honesty rule');
  assert.ok(!hasLiveData(LAYER_STATUS.EMPTY));
  assert.ok(!hasLiveData(LAYER_STATUS.CONFIG_REQUIRED));
  assert.ok(!hasLiveData(LAYER_STATUS.UNAVAILABLE));
  assert.ok(!hasLiveData(LAYER_STATUS.OFF));
});

test('IS_DATA_STATE covers only states where records are on the globe', () => {
  const values = Object.values(LAYER_STATUS);
  assert.deepEqual(
    [...IS_DATA_STATE].sort(),
    [LAYER_STATUS.LIVE, LAYER_STATUS.STALE, LAYER_STATUS.EMPTY, LAYER_STATUS.SIMULATED].sort(),
  );
  assert.ok(!IS_DATA_STATE.has(LAYER_STATUS.BLOCKED));
  assert.ok(values.every((status) => typeof IS_DATA_STATE.has(status) === 'boolean'));
});

test('failure kinds translate into honest user-facing statuses', () => {
  assert.equal(statusFromFailureKind(FAILURE_KIND.CORS), LAYER_STATUS.BLOCKED);
  assert.equal(statusFromFailureKind(FAILURE_KIND.RATE_LIMIT), LAYER_STATUS.RATE_LIMITED);
  assert.equal(statusFromFailureKind(FAILURE_KIND.OFFLINE), LAYER_STATUS.OFFLINE);
  assert.equal(statusFromFailureKind(FAILURE_KIND.CONFIG), LAYER_STATUS.CONFIG_REQUIRED);
  for (const kind of [FAILURE_KIND.TIMEOUT, FAILURE_KIND.HTTP, FAILURE_KIND.NETWORK, FAILURE_KIND.PARSE]) {
    assert.equal(statusFromFailureKind(kind), LAYER_STATUS.ERROR);
  }
  assert.equal(statusFromFailureKind('something-unheard-of'), LAYER_STATUS.ERROR);
  assert.equal(statusFromFailureKind(undefined), LAYER_STATUS.ERROR);
});

test('a cross-origin failure while online is diagnosed as a missing CORS header', () => {
  const error = classifyFetchFailure(new TypeError('Failed to fetch'), {
    url: 'https://api.example.org/v1/things',
    online: true,
  });
  assert.ok(isHttpError(error), 'callers can branch on isHttpError');
  assert.equal(error.kind, FAILURE_KIND.CORS);
  assert.match(error.message, /CORS/i, 'the message names the cause');
  assert.equal(error.url, 'https://api.example.org/v1/things');
  assert.equal(statusFromFailureKind(error.kind), LAYER_STATUS.BLOCKED);
});

test('the same failure while offline is reported as offline, not CORS', () => {
  const error = classifyFetchFailure(new TypeError('Failed to fetch'), {
    url: 'https://api.example.org/v1/things',
    online: false,
  });
  assert.equal(error.kind, FAILURE_KIND.OFFLINE);
  assert.equal(statusFromFailureKind(error.kind), LAYER_STATUS.OFFLINE);
});

test('a genuine user cancellation stays an abort', () => {
  const error = classifyFetchFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }), {
    url: 'https://x.test/a',
    online: true,
  });
  assert.equal(error.kind, FAILURE_KIND.ABORTED);
});

test('freshness verdicts default to a sane policy', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(evaluateFreshness(now - 5_000, now), LAYER_STATUS.LIVE);
  assert.equal(evaluateFreshness(now - 10 * 60_000, now), LAYER_STATUS.STALE);
  assert.equal(evaluateFreshness(now, now, { freshMs: 1_000, staleMs: 2_000 }), LAYER_STATUS.LIVE);
  assert.equal(evaluateFreshness(now - 5_000, now, { freshMs: 1_000, staleMs: 2_000 }), LAYER_STATUS.STALE);
  assert.equal(evaluateFreshness(null, now), LAYER_STATUS.IDLE, 'never-fetched is not stale');
  assert.equal(evaluateFreshness(undefined, now), LAYER_STATUS.IDLE);
});

test('age strings stay readable and bounded at every scale', () => {
  assert.equal(formatAge(5_000), '5s ago');
  assert.equal(formatAge(5 * 60_000), '5m ago');
  assert.equal(formatAge(3 * 3600_000), '3h ago');
  assert.equal(formatAge(5 * 86400_000), '5d ago');
  assert.equal(formatAge(-1), '—');
  assert.equal(formatAge(NaN), '—');
  assert.ok(formatAge(400 * 86400_000).length < 12, 'the readout must not grow');
});

test('clock strings never print "Invalid Date"', () => {
  assert.doesNotMatch(formatUtc(new Date()), /Invalid/);
  assert.equal(formatUtc(new Date(Date.UTC(2026, 0, 5, 6, 7, 8))), '06:07:08');
  assert.equal(formatUtcDateTime(Date.UTC(2026, 0, 5, 6, 7, 8)), '2026-01-05 06:07:08Z');
  assert.equal(formatUtcDateTime('not a date'), '—');
  assert.equal(formatUtcDateTime(undefined), '—');
});

test('backoff grows, is capped, and is jittered', () => {
  const deterministic = (attempt, rand) => backoffDelay(attempt, 400, 8000, () => rand);
  assert.ok(deterministic(1, 1) < deterministic(4, 1), 'delay increases with attempts');
  assert.ok(backoffDelay(30, 400, 8000, () => 1) <= 8000, 'capped at maxMs');
  assert.equal(backoffDelay(0, 400, 8000, () => 0), 0, 'full jitter can yield zero');
  assert.ok(Number.isInteger(deterministic(2, 0.5)));
  assert.notEqual(deterministic(3, 0.1), deterministic(3, 0.9), 'jitter actually varies');
});

test('cache keys separate by url, method and body', () => {
  assert.equal(cacheKey('https://a.test/x'), cacheKey('https://a.test/x'));
  assert.equal(cacheKey('https://a.test/x'), cacheKey('https://a.test/x', {}));
  assert.notEqual(cacheKey('https://a.test/x'), cacheKey('https://a.test/y'));
  assert.notEqual(cacheKey('https://a.test/x', { method: 'GET' }), cacheKey('https://a.test/x', { method: 'POST' }));
  assert.notEqual(
    cacheKey('https://a.test/x', { method: 'POST', body: '1' }),
    cacheKey('https://a.test/x', { method: 'POST', body: '2' }),
  );
});

test('the cache honours its entry bound with FIFO eviction', () => {
  const cache = createCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a').value, 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), null, 'the oldest entry was evicted to hold the bound');
  assert.equal(cache.get('b').value, 2);
  assert.equal(cache.get('c').value, 3);
  assert.equal(cache.size, 2);
  // Re-setting an existing key must not evict something else.
  cache.set('b', 20);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('c').value, 3);
});

test('cache entries expire and can be served stale during the grace window', () => {
  const cache = createCache();
  const t0 = 1_000_000;
  cache.set('k', 'v', 1_000, 5_000, t0);
  assert.deepEqual(cache.get('k', t0 + 500), { value: 'v', stale: false, age: 500 });
  assert.deepEqual(cache.get('k', t0 + 2_000), { value: 'v', stale: true, age: 2_000 });
  assert.equal(cache.get('k', t0 + 9_000), null, 'past ttl + staleTtl the entry is gone');
});
