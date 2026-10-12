import test from 'node:test';
import assert from 'node:assert/strict';

import { DRAW_MODES, pathLengthM, sphericalAreaM2, formatArea } from '../src/tools/annotations.js';
import { distanceM } from '../src/geo/coords.js';

test('every draw mode is declared', () => {
  assert.deepEqual(
    Object.values(DRAW_MODES).sort(),
    ['line', 'measure', 'none', 'point', 'polygon'],
  );
});

test('a path length is the sum of its great-circle legs', () => {
  const points = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 0, lon: 2 },
  ];
  const total = pathLengthM(points);
  const expected = distanceM(0, 0, 0, 1) + distanceM(0, 1, 0, 2);
  assert.ok(Math.abs(total - expected) < 1, `${total} vs ${expected}`);
  // One degree of longitude at the equator is about 111.2 km.
  assert.ok(Math.abs(distanceM(0, 0, 0, 1) - 111_195) < 200);
});

test('degenerate paths have zero length', () => {
  assert.equal(pathLengthM([]), 0);
  assert.equal(pathLengthM([{ lat: 1, lon: 1 }]), 0);
});

test('a one-degree square at the equator has roughly the right area', () => {
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ];
  const area = sphericalAreaM2(square);
  // ~111.2 km x ~110.6 km = ~12,300 km^2.
  assert.ok(area > 1.2e10 && area < 1.25e10, `got ${(area / 1e6).toFixed(0)} km²`);
});

test('polygon area shrinks with latitude, as it must on a sphere', () => {
  const atEquator = sphericalAreaM2([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 },
  ]);
  const at60 = sphericalAreaM2([
    { lat: 60, lon: 0 }, { lat: 60, lon: 1 }, { lat: 61, lon: 1 }, { lat: 61, lon: 0 },
  ]);
  assert.ok(at60 < atEquator * 0.6, 'a degree of longitude is much shorter at 60°');
  assert.ok(at60 > atEquator * 0.4, 'but not zero');
});

test('vertex order does not change the area', () => {
  const clockwise = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 },
  ];
  const counterClockwise = [...clockwise].reverse();
  assert.ok(Math.abs(sphericalAreaM2(clockwise) - sphericalAreaM2(counterClockwise)) < 1);
});

test('fewer than three points has no area', () => {
  assert.equal(sphericalAreaM2([]), 0);
  assert.equal(sphericalAreaM2([{ lat: 0, lon: 0 }]), 0);
  assert.equal(sphericalAreaM2([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]), 0);
  assert.equal(sphericalAreaM2(null), 0);
});

test('area is formatted in m² below a kilometre and km² above', () => {
  assert.equal(formatArea(500), '500 m²');
  assert.equal(formatArea(2_500_000), '2.50 km²');
  assert.equal(formatArea(NaN), '—');
  assert.equal(formatArea(undefined), '—');
});
