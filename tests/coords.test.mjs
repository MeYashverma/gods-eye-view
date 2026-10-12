import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  normalizeLat,
  normalizeLon,
  parseCoordinates,
  distanceM,
  bearingDeg,
  compassPoint,
  destination,
  boundingBox,
  overpassBBox,
  formatLat,
  formatLon,
  formatDistance,
  formatAltitude,
  formatKnots,
  metersToFeet,
  feetToMeters,
  msToKmh,
  heightToZoom,
  featureKey,
  toNumber,
} from '../src/geo/coords.js';

test('clamp keeps values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('latitude out of range is rejected, not silently clamped', () => {
  assert.equal(normalizeLat(45), 45);
  assert.equal(normalizeLat(91), null, 'a bad feed value must be dropped, not faked');
  assert.equal(normalizeLat(-91), null);
  assert.equal(normalizeLat('nonsense'), null);
});

test('longitude wraps rather than being rejected', () => {
  assert.ok(Math.abs(normalizeLon(181) - -179) < 1e-9);
  assert.ok(Math.abs(normalizeLon(-181) - 179) < 1e-9);
  assert.equal(normalizeLon(0), 0);
  assert.equal(normalizeLon(null), null);
});

test('toNumber rejects junk', () => {
  assert.equal(toNumber('42.5'), 42.5);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(NaN), null);
});

test('parseCoordinates accepts decimal pairs', () => {
  const result = parseCoordinates('48.8566, 2.3522');
  assert.ok(result, 'decimal pair should parse');
  assert.ok(Math.abs(result.lat - 48.8566) < 1e-6);
  assert.ok(Math.abs(result.lon - 2.3522) < 1e-6);
});

test('parseCoordinates accepts degree-minute-second notation', () => {
  const result = parseCoordinates("40°26'46\"N 79°58'56\"W");
  assert.ok(result, 'DMS pair should parse');
  assert.ok(Math.abs(result.lat - 40.446) < 0.01, `lat was ${result.lat}`);
  assert.ok(Math.abs(result.lon + 79.982) < 0.01, `lon was ${result.lon}`);
});

test('parseCoordinates rejects out-of-range values', () => {
  assert.equal(parseCoordinates('999, 0'), null);
  assert.equal(parseCoordinates('0, 999'), null);
  assert.equal(parseCoordinates('not a place'), null);
});

test('great-circle distance matches a known city pair', () => {
  // Paris (48.8566 N, 2.3522 E) -> London (51.5074 N, 0.1278 W) is ~343 km.
  const metres = distanceM(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(metres > 335_000 && metres < 350_000, `got ${metres}`);
  assert.equal(distanceM(10, 10, 10, 10), 0);
});

test('bearing and compass point agree', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0)) < 0.5, 'due north');
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.5, 'due east');
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(90), 'E');
  assert.equal(compassPoint(180), 'S');
  assert.equal(compassPoint(270), 'W');
  assert.equal(compassPoint(359), 'N');
});

test('destination projects a point along a bearing', () => {
  const point = destination(0, 0, 0, 111_195); // one degree of arc north
  assert.ok(Math.abs(point.lat - 1) < 0.01, `lat ${point.lat}`);
  assert.ok(Math.abs(point.lon) < 1e-6, `lon ${point.lon}`);
});

test('bounding box expands around a centre', () => {
  const box = boundingBox(0, 0, 100);
  assert.ok(box.south < 0 && box.north > 0 && box.west < 0 && box.east > 0);
  // ~1 degree of latitude per 111.32 km.
  assert.ok(Math.abs(box.north - 100 / 111.32) < 0.01, `north ${box.north}`);
  const polar = boundingBox(89.9, 0, 500);
  assert.ok(polar.north <= 90, 'boxes are clamped at the poles');
  assert.equal(typeof overpassBBox(box), 'string');
  assert.match(overpassBBox(box), /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
});

test('formatters produce human strings, never NaN', () => {
  assert.match(formatLat(48.8566), /48\.85\d*\s*(°\s*)?N/i);
  assert.match(formatLon(-0.1278), /0\.12\d*\s*(°\s*)?W/i);
  assert.match(formatDistance(850), /m/);
  assert.match(formatDistance(12_500), /km/);
  assert.match(formatAltitude(9_144), /\d/);
  assert.match(formatKnots(450), /\d/);
  assert.ok(!formatDistance(NaN).includes('NaN'), 'no NaN leaking into the HUD');
  assert.ok(!formatAltitude(undefined).includes('NaN'));
});

test('unit conversions are accurate', () => {
  assert.ok(Math.abs(metersToFeet(1) - 3.28084) < 1e-3);
  assert.ok(Math.abs(feetToMeters(3.28084) - 1) < 1e-3);
  assert.ok(Math.abs(msToKmh(10) - 36) < 1e-6);
});

test('heightToZoom maps altitude monotonically onto a bounded tile zoom', () => {
  assert.ok(heightToZoom(40_000_000) < heightToZoom(10_000), 'higher camera = shallower zoom');
  assert.ok(heightToZoom(10_000) < heightToZoom(100));
  for (const height of [100, 10_000, 1_000_000, 40_000_000]) {
    const zoom = heightToZoom(height);
    assert.ok(zoom >= 0 && zoom <= 22, `zoom ${zoom} out of tile range`);
  }
  assert.ok(Number.isFinite(heightToZoom(undefined)), 'junk input degrades to a usable default');
});

test('featureKey is stable and collision-resistant', () => {
  assert.equal(featureKey('a', 1, 2), featureKey('a', 1, 2));
  assert.notEqual(featureKey('a', 1, 2), featureKey('b', 1, 2));
  assert.notEqual(featureKey('a', 1, 2), featureKey('a', 1, 2.0001));
  assert.equal(featureKey('a', 1, 2, 'extra'), 'a:1.00000,2.00000:extra');
});
