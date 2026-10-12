/**
 * Provider adapter tests.
 *
 * Every assertion runs against a captured payload shape rather than a live
 * request, so the suite passes offline and never hammers a public API. What is
 * pinned is the normalizer contract: garbage in, `null` out — never a
 * fabricated record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEarthquake,
  normalizeEarthquakeFeed,
  magnitudeColor,
  magnitudeRadiusM,
  isoHoursAgo,
  TIME_RANGES,
} from '../src/sources/earthquakes.js';
import { parseTle, tleEpoch, toSatrec, periodMinutes, propagate, orbitTrack, orbitClass } from '../src/sources/celestrak.js';
import { normalizeWeatherMaps, frameAt, tileTemplate } from '../src/sources/rainviewer.js';
import { normalizeAircraft, normalizeAircraftFeed, buildEndpointUrl, createSampleFeed, emitterCategory } from '../src/sources/adsbV2.js';
import { subscriptionMessage, aisBoundingBox, normalizeAisMessage, mmsiMid, mmsiToMidCountry, shipTypeLabel, vesselColor } from '../src/sources/aisStream.js';
import { parseFirmsCsv, parseAcquisition, fireColor, fireAreaUrl } from '../src/sources/firms.js';
import { parseSystemsCsv, splitCsvLine, matchSystemsByPlace, nearestSystems, findFeedUrl, normalizeStations, normalizeHeader } from '../src/sources/gbfs.js';
import { parseAirportLine, parseAirports, airportRank } from '../src/sources/openflights.js';
import { validateWaypoints, routeUrl, normalizeRoute, describeManeuver, straightLinePath, TRAVEL_MODES } from '../src/sources/osrm.js';
import { coordinateResult, normalizePhoton, normalizeNominatim } from '../src/sources/geocode.js';
import { buildQuery, normalizeOverpass } from '../src/sources/overpass.js';
import { parseHemisphereCoordinate, saffirSimpson, stormColor, normalizeStormList } from '../src/sources/nhc.js';
import { normalizeStations as normalizeRadioStations, filterByBox, playbackOutlook, stationSearchUrl } from '../src/sources/radioBrowser.js';
import { describeWeatherCode, forecastUrl, normalizeForecastList } from '../src/sources/openMeteo.js';

/* ------------------------------- earthquakes ----------------------------- */

const QUAKE_FEATURE = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [142.369, 38.299, 29.5] },
  properties: {
    mag: 6.1,
    place: '92 km ENE of Sendai, Japan',
    time: 1_700_000_000_000,
    updated: 1_700_000_900_000,
    felt: 412,
    tsunami: 1,
    alert: 'green',
    cdi: 5.6,
    mmi: 6.1,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000abc',
    net: 'us',
    code: 'us6000abc',
    nst: 380,
    rms: 0.72,
    gap: 22,
    title: 'M 6.1 - 92 km ENE of Sendai, Japan',
  },
};

test('a USGS feature normalizes into a complete record', () => {
  const record = normalizeEarthquake(QUAKE_FEATURE);
  assert.equal(record.id, 'us6000abc');
  assert.ok(Math.abs(record.lat - 38.299) < 1e-9);
  assert.ok(Math.abs(record.lon - 142.369) < 1e-9, 'GeoJSON is lon,lat — the order must not be swapped');
  assert.equal(record.depthKm, 29.5);
  assert.equal(record.mag, 6.1);
  assert.equal(record.tsunami, true);
  assert.equal(record.time, 1_700_000_000_000);
  assert.equal(record.alert, 'green');
});

test('malformed quake features are dropped, not coerced', () => {
  assert.equal(normalizeEarthquake(null), null);
  assert.equal(normalizeEarthquake({}), null);
  assert.equal(normalizeEarthquake({ geometry: { type: 'Polygon', coordinates: [[0, 0]] }, properties: {} }), null);
  assert.equal(normalizeEarthquake({ geometry: { type: 'Point', coordinates: ['x', 'y'] }, properties: {} }), null);
});

test('a feed is parsed, cleaned and sorted newest-first', () => {
  const feed = {
    features: [
      { ...QUAKE_FEATURE, properties: { ...QUAKE_FEATURE.properties, time: 1_600_000_000_000 } },
      QUAKE_FEATURE,
      { geometry: null, properties: {} },
    ],
  };
  const records = normalizeEarthquakeFeed(feed);
  assert.equal(records.length, 2, 'the malformed feature is dropped');
  assert.ok(records[0].time > records[1].time, 'newest first');
  assert.deepEqual(normalizeEarthquakeFeed(null), []);
  assert.deepEqual(normalizeEarthquakeFeed({ features: 'nope' }), []);
});

test('magnitude colour is defined and radius scales monotonically', () => {
  assert.ok(magnitudeRadiusM(7) > magnitudeRadiusM(4));
  assert.ok(magnitudeRadiusM(4) > magnitudeRadiusM(2));
  assert.equal(magnitudeRadiusM(-5), magnitudeRadiusM(0), 'negative magnitudes are floored, never negative-sized');
  for (const mag of [-1, 1, 3, 5, 7, 9]) {
    assert.match(magnitudeColor(mag), /^#[0-9a-f]{6}$/i, `mag ${mag} needs a colour`);
  }
});

test('time ranges widen and raise the magnitude floor with them', () => {
  let last = 0;
  for (const range of TIME_RANGES) {
    assert.ok(range.hours > last, 'ranges widen');
    assert.ok(range.minMagnitude >= 2, 'wide ranges raise the floor');
    last = range.hours;
  }
  assert.match(isoHoursAgo(24, new Date(Date.UTC(2026, 0, 2))), /^\d{4}-\d{2}-01T00:00:00Z$/);
});

/* ------------------------------- satellites ------------------------------ */

const ISS_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9002',
  '2 25544  51.6400 208.9163 0006703 300.2571  59.8360 15.49560532    15',
].join('\n');

const GEO_TLE = [
  'GOES 16',
  '1 41866U 16071A   24001.50000000 -.00000052  00000-0  00000-0 0  9993',
  '2 41866   0.0282  75.1234 0001234  90.0000  20.0000  1.00271234  28005',
].join('\n');

test('a 3LE block parses into a named element set', () => {
  const [entry] = parseTle(ISS_TLE);
  assert.equal(entry.name, 'ISS (ZARYA)');
  assert.equal(entry.noradId, '25544');
  assert.equal(entry.internationalDesignator, '98067A');
  assert.ok(entry.epoch instanceof Date);
});

test('a 2LE block synthesises a name instead of inventing one', () => {
  const [entry] = parseTle(ISS_TLE.split('\n').slice(1).join('\n'));
  assert.equal(entry.name, 'NORAD 25544');
});

test('corrupt TLE input yields no entries and never throws', () => {
  assert.deepEqual(parseTle(''), []);
  assert.deepEqual(parseTle(null), []);
  assert.deepEqual(parseTle('not a tle at all'), []);
  assert.equal(toSatrec({ line1: 'garbage', line2: 'garbage' }), null);
  assert.equal(periodMinutes(null), null);
  assert.equal(propagate(null), null);
});

test('the TLE two-digit year pivot handles both centuries', () => {
  const modern = tleEpoch(ISS_TLE.split('\n')[1]);
  assert.equal(modern.getUTCFullYear(), 2024);
  const sputnik = tleEpoch('1 00001U 57001B   57001.50000000  .00000000  00000-0  00000-0 0    17');
  assert.equal(sputnik.getUTCFullYear(), 1957);
});

test('SGP4 propagation puts the ISS in low Earth orbit', () => {
  const satrec = toSatrec(parseTle(ISS_TLE)[0]);
  assert.ok(satrec, 'the ISS element set must build a satellite record');
  const position = propagate(satrec, new Date(Date.UTC(2024, 0, 1, 12, 0, 0)));
  assert.ok(position, 'propagation returned a position');
  assert.ok(position.lat >= -90 && position.lat <= 90);
  assert.ok(position.lon >= -180 && position.lon <= 180);
  assert.ok(position.heightKm > 300 && position.heightKm < 600, `ISS altitude was ${position.heightKm} km`);
  assert.ok(position.speedKmS > 7 && position.speedKmS < 8, `ISS speed was ${position.speedKmS} km/s`);
});

test('the orbital period matches the element set mean motion', () => {
  const satrec = toSatrec(parseTle(ISS_TLE)[0]);
  const period = periodMinutes(satrec);
  // Mean motion 15.49560532 rev/day -> 1440 / 15.49560532 = 92.93 min.
  assert.ok(Math.abs(period - 1440 / 15.49560532) < 0.05, `period was ${period} min`);
  const geo = toSatrec(parseTle(GEO_TLE)[0]);
  const geoPeriod = periodMinutes(geo);
  assert.ok(Math.abs(geoPeriod - 1436) < 40, `a geosynchronous period should be near a sidereal day, got ${geoPeriod}`);
});

test('orbit classes separate LEO from geosynchronous', () => {
  assert.equal(orbitClass(toSatrec(parseTle(GEO_TLE)[0])), 'GEO');
  assert.equal(orbitClass(toSatrec(parseTle(ISS_TLE)[0])), 'LEO');
  assert.equal(orbitClass(null), 'unknown');
});

test('an orbit track is a bounded ring of valid points', () => {
  const satrec = toSatrec(parseTle(ISS_TLE)[0]);
  const track = orbitTrack(satrec, new Date(Date.UTC(2024, 0, 1, 12, 0, 0)), { minutes: 90, samples: 40 });
  assert.ok(track.length >= 40, 'at least one point per requested sample');
  for (const point of track) {
    assert.ok(Number.isFinite(point.lat) && Number.isFinite(point.lon), 'no NaN in the polyline');
    assert.ok(Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180);
  }
  assert.deepEqual(orbitTrack(null), []);
});

/* --------------------------- radar / weather tiles ----------------------- */

const RAINVIEWER_PAYLOAD = {
  host: 'https://tilecache.rainviewer.com',
  generated: 1_700_000_000,
  radar: {
    past: [
      { time: 1_699_999_000, path: '/v1/radar/newer/tiles' },
      { time: 1_699_995_000, path: '/v1/radar/older/tiles' },
    ],
    nowcast: [{ time: 1_700_001_000, path: '/v1/radar/nowcast/tiles' }],
  },
  satellite: { past: [{ time: 1_699_998_000, path: '/v1/sat/sat/tiles' }] },
};

test('the RainViewer payload normalizes into time-sorted frames', () => {
  const maps = normalizeWeatherMaps(RAINVIEWER_PAYLOAD);
  assert.equal(maps.host, 'https://tilecache.rainviewer.com');
  assert.equal(maps.radar.past.length, 2);
  assert.ok(maps.radar.past[0].time < maps.radar.past[1].time, 'frames sorted ascending');
  assert.equal(maps.radar.past[0].time, 1_699_995_000_000, 'seconds become milliseconds');
  assert.equal(maps.radar.nowcast.length, 1);
  assert.equal(maps.satellite.past.length, 1);
  assert.equal(maps.generatedAt, 1_700_000_000_000);
});

test('frames without a path are dropped and an empty payload stays empty', () => {
  const maps = normalizeWeatherMaps({ host: 'https://h', radar: { past: [{ time: 1 }, null, { time: 2, path: '/p' }] } });
  assert.equal(maps.radar.past.length, 1);
  const empty = normalizeWeatherMaps({});
  assert.deepEqual(empty.radar.past, []);
  assert.deepEqual(empty.satellite.past, []);
  assert.equal(frameAt([]), null);
  assert.equal(frameAt(null), null);
});

test('frameAt picks the newest frame at or before the requested time', () => {
  const { radar } = normalizeWeatherMaps(RAINVIEWER_PAYLOAD);
  assert.equal(frameAt(radar.past, 1_699_995_500_000).path, '/v1/radar/older/tiles');
  assert.equal(frameAt(radar.past, 1_699_999_500_000).path, '/v1/radar/newer/tiles');
  assert.equal(frameAt(radar.past, 1_000_000_000_000).path, '/v1/radar/older/tiles', 'falls back to the oldest');
  assert.equal(frameAt(radar.past, 9_000_000_000_000).path, '/v1/radar/newer/tiles', 'future asks get the newest');
});

test('the tile template is a valid XYZ url', () => {
  const template = tileTemplate({ host: 'https://h.test', path: '/v1/radar/aaa/tiles' });
  assert.equal(template, 'https://h.test/v1/radar/aaa/tiles/256/{z}/{x}/{y}/2/1_1.png');
  assert.equal(tileTemplate(null), null);
  assert.equal(tileTemplate({ host: 'https://h' }), null);
  assert.equal(
    tileTemplate({ host: 'h', path: '/p' }, { scheme: 0, smooth: false, snow: false, size: 512 }),
    'h/p/512/{z}/{x}/{y}/0/0_0.png',
  );
});

/* ---------------------------------- ADS-B -------------------------------- */

const ADSB_AIRCRAFT = {
  hex: 'A1B2C3',
  flight: 'UAL123 ',
  lat: 40.5,
  lon: -74.1,
  alt_baro: 35000,
  gs: 480.5,
  track: 265,
  baro_rate: -640,
  category: 'A3',
  squawk: '1200',
  seen: 2,
  t: 'A320',
  r: 'N12345',
};

test('an ADS-B record normalizes into SI units', () => {
  const record = normalizeAircraft(ADSB_AIRCRAFT);
  assert.equal(record.callsign, 'UAL123', 'trailing spaces are trimmed');
  assert.equal(record.hex, 'a1b2c3', 'ICAO hex is lowercased');
  assert.equal(record.registration, 'N12345');
  assert.ok(Math.abs(record.altitudeM - 35000 * 0.3048) < 1, 'feet are converted to metres');
  assert.equal(record.altitudeSource, 'barometric');
  assert.ok(Math.abs(record.speedMs - 480.5 * 0.514444) < 0.01, 'knots are converted to m/s');
  assert.equal(record.trackDeg, 265);
  assert.equal(record.squawk, '1200');
  assert.ok(record.verticalRateMs < 0, 'a descent is negative');
  assert.equal(record.id, 'adsb:a1b2c3');
});

test('a grounded aircraft reports no altitude rather than zero feet', () => {
  const record = normalizeAircraft({ ...ADSB_AIRCRAFT, alt_baro: 'ground' });
  assert.equal(record.onGround, true);
  assert.equal(record.altitudeM, null);
});

test('aircraft without a position are dropped', () => {
  assert.equal(normalizeAircraft({ hex: 'abc', flight: 'NOPOS' }), null);
  assert.equal(normalizeAircraft({ hex: 'abc', lat: 'x', lon: 'y' }), null);
  assert.equal(normalizeAircraft(null), null);
  const feed = normalizeAircraftFeed({ aircraft: [ADSB_AIRCRAFT, { hex: 'x' }, null] });
  assert.equal(feed.records.length, 1);
  assert.equal(normalizeAircraftFeed({}).records.length, 0);
});

test('the sample feed is a valid readsb payload that normalizes cleanly', () => {
  // createSampleFeed emits the raw v2 shape on purpose, so it goes through the
  // same normalizer as a real feed rather than a separate code path.
  const { records } = normalizeAircraftFeed(createSampleFeed({ lat: 51.5, lon: -0.1, count: 10 }));
  assert.equal(records.length, 10, 'every synthesised contact is placeable');
  for (const record of records) {
    assert.ok(Number.isFinite(record.lat) && Number.isFinite(record.lon));
    assert.ok(record.callsign, 'every sample contact has a callsign');
    assert.match(record.hex, /^[0-9a-f]{6}$/, 'the ICAO hex is well formed');
  }
  const a = createSampleFeed({ count: 5, seed: 7 });
  const b = createSampleFeed({ count: 5, seed: 7 });
  assert.deepEqual(a.ac, b.ac, 'the same seed reproduces the same feed');
  assert.notDeepEqual(createSampleFeed({ count: 5, seed: 8 }).ac, a.ac, 'a different seed does not');
});

test('the emitter category comes from the feed, never from inference', () => {
  assert.equal(typeof emitterCategory('A3'), 'number');
  assert.equal(emitterCategory(undefined), 0, 'an absent category is 0, not a guess');
  assert.equal(emitterCategory(''), 0);
});

test('the endpoint template substitutes viewport placeholders', () => {
  const url = buildEndpointUrl('https://api.test/v2/{lat}/{lon}/{radiusNm}', { lat: 40.5, lon: -74.25, radiusNm: 100 });
  assert.ok(url.includes('40.5000') && url.includes('-74.2500') && url.includes('100'));
  assert.equal(
    buildEndpointUrl('https://my.readsb.test/data/aircraft.json', { lat: 0, lon: 0 }),
    'https://my.readsb.test/data/aircraft.json',
    'a plain url passes through untouched',
  );
});

/* ----------------------------------- AIS --------------------------------- */

test('the AIS subscription message carries the key and a nested bounding box', () => {
  const parsed = JSON.parse(
    subscriptionMessage({ apiKey: 'TESTKEY', bbox: [[50, 1], [52, 3]] }),
  );
  assert.equal(parsed.APIKey, 'TESTKEY');
  assert.deepEqual(parsed.BoundingBoxes, [[[50, 1], [52, 3]]], 'AISStream nests the box in an array');
  assert.ok(parsed.FilterMessageTypes.includes('PositionReport'));
});

test('the AIS bounding box converts a viewport into [lat, lon] corners', () => {
  assert.deepEqual(aisBoundingBox({ south: 50, west: 1, north: 52, east: 3 }), [[50, 1], [52, 3]]);
});

test('an AIS position report normalizes into the vessel record shape', () => {
  const previous = new Map();
  const record = normalizeAisMessage(
    {
      MessageType: 'PositionReport',
      Message: {
        PositionReport: {
          UserId: 211234567,
          Latitude: 51.5,
          Longitude: 1.25,
          Sog: 12.3,
          Cog: 210.0,
          TrueHeading: 210,
          NavigationalStatus: 0,
        },
      },
      MetaData: { MMSI: '211234567', MMSI_String: '211234567' },
    },
    previous,
  );
  assert.ok(record, 'a valid position report produces a record');
  assert.equal(record.mmsi, '211234567');
  assert.equal(record.id, 'ais:211234567');
  assert.ok(Math.abs(record.lat - 51.5) < 1e-6);
  assert.ok(Math.abs(record.lon - 1.25) < 1e-6);
  assert.equal(record.speedKn, 12.3, 'SOG is reported in knots as the feed gives it');
  assert.equal(record.country, 'Germany');
});

test('AIS sentinel values are treated as missing, not as real data', () => {
  const previous = new Map();
  const record = normalizeAisMessage(
    {
      MessageType: 'PositionReport',
      Message: { PositionReport: { Latitude: 51.5, Longitude: 1.25, Sog: 102.3, Cog: 360, TrueHeading: 511 } },
      MetaData: { MMSI: '1' },
    },
    previous,
  );
  assert.equal(record.speedKn, null, 'SOG 102.3 is the "unavailable" sentinel');
  assert.equal(record.courseDeg, null, 'COG 360 is the "unavailable" sentinel');
  assert.equal(record.headingDeg, null, 'heading 511 is the "unavailable" sentinel');
});

test('AIS messages without a usable position are dropped', () => {
  assert.equal(normalizeAisMessage(null), null);
  assert.equal(normalizeAisMessage({ MessageType: 'Unknown', Message: {}, MetaData: {} }), null);
  assert.equal(
    normalizeAisMessage({ MessageType: 'PositionReport', Message: { PositionReport: { Latitude: 91, Longitude: 0 } }, MetaData: { MMSI: '1' } }),
    null,
    '91/181 are the AIS not-available position sentinels',
  );
});

test('the MMSI maritime ID maps to a flag state', () => {
  assert.equal(mmsiMid(211234567), '211');
  assert.equal(mmsiMid('211234567'), '211');
  assert.equal(mmsiMid('12'), null, 'too short to be an MID');
  assert.equal(mmsiToMidCountry(211234567), 'Germany');
  assert.equal(mmsiToMidCountry(999999999), null, 'an unlisted MID is unknown, not guessed');
});

test('ship type and colour always resolve to something drawable', () => {
  assert.equal(shipTypeLabel(70), 'Cargo');
  assert.equal(shipTypeLabel(71), 'Cargo (hazard A)');
  assert.match(shipTypeLabel(79), /Cargo/);
  assert.match(shipTypeLabel(-1), /Type -1/);
  assert.equal(shipTypeLabel('x'), null);
  for (const code of [0, 35, 55, 60, 70, 80, 90, 99]) {
    assert.match(vesselColor(code), /^#[0-9a-f]{6}$/i, `type ${code} needs a colour`);
  }
});

/* ---------------------------------- FIRMS -------------------------------- */

const FIRMS_HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight';
const FIRMS_CSV = [
  FIRMS_HEADER,
  '38.12345,-120.54321,325.4,0.6,0.5,2026-01-15,1432,N,SUOMI-NPP,h,2.0,301.2,18.7,day',
  '39.9,-121.1,340.1,0.6,0.5,2026-01-15,1433,N,SUOMI-NPP,l,2.0,310.5,644.2,night',
].join('\n');

test('a FIRMS CSV parses into records with typed confidence', () => {
  const records = parseFirmsCsv(FIRMS_CSV);
  assert.equal(records.length, 2);
  assert.ok(Math.abs(records[0].lat - 38.12345) < 1e-9);
  assert.equal(records[0].confidence, 'h');
  assert.equal(records[0].satellite, 'N');
  assert.ok(records[0].frpMw > 0);
  assert.ok(Number.isFinite(records[0].observedAt), 'acquisition is parsed to epoch ms');
  assert.ok(records[0].id.startsWith('firms:'));
});

test('a CSV missing the brightness column yields nothing rather than half-records', () => {
  assert.deepEqual(parseFirmsCsv('latitude,longitude,confidence\n1,2,h'), []);
  assert.deepEqual(parseFirmsCsv(''), []);
  assert.deepEqual(parseFirmsCsv(FIRMS_HEADER), [], 'a header with no rows is not an error');
  assert.deepEqual(parseFirmsCsv(null), []);
});

test('a malformed FIRMS row is skipped rather than half-parsed', () => {
  const records = parseFirmsCsv(`${FIRMS_HEADER}\nabc,def,ghi,jkl,mno,pqr,stu,vwx,yza,bcd,efg,hij,klm,nop`);
  assert.equal(records.length, 0);
});

test('the FIRMS area url orders the box west,south,east,north', () => {
  const url = fireAreaUrl({ apiKey: 'K', box: { south: 37, west: -122, north: 39, east: -120 } });
  assert.ok(url.includes('/K/'), 'the key is sent to the provider it was issued by');
  assert.ok(url.includes('VIIRS_SNPP_NRT'));
  assert.ok(url.includes('-122.00,37.00,-120.00,39.00'), `box order was wrong: ${url}`);
});

test('fire colour follows radiative power, not an invented scale', () => {
  assert.notEqual(fireColor({ frpMw: 900 }), fireColor({ frpMw: 10 }));
  for (const frp of [0, 25, 100, 500, 5000]) {
    assert.match(fireColor({ frpMw: frp }), /^#[0-9a-f]{6}$/i);
  }
  assert.match(fireColor({}), /^#[0-9a-f]{6}$/i);
});

test('the FIRMS acquisition timestamp is UTC', () => {
  const at = parseAcquisition('2026-01-15', '1432');
  assert.equal(typeof at, 'number');
  const date = new Date(at);
  assert.equal(date.getUTCFullYear(), 2026);
  assert.equal(date.getUTCHours(), 14);
  assert.equal(date.getUTCMinutes(), 32);
  assert.equal(parseAcquisition(null, '1432'), null);
  assert.equal(parseAcquisition('nonsense', '1432'), null);
});

/* ----------------------------------- GBFS -------------------------------- */

/**
 * The real MobilityData catalog header. It carries **no coordinates**, which is
 * why systems are matched to the camera by place name.
 */
const GBFS_HEADER = 'Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions';
const GBFS_CSV = [
  GBFS_HEADER,
  'DE,Nextbike Germany,"Berlin, Germany",nextbike_berlin,https://www.nextbike.de,https://gbfs.nextbike.de/maps/gbfs/v2/nextbike_berlin/gbfs.json,2.3',
  'US,Citi Bike,"New York, NY",lyft_nyc,https://www.citibikenyc.com,https://gbfs.citibikenyc.com/gbfs/2.3/gbfs.json,2.3',
  'FR,Velib,"Paris, France",velib,https://www.velib-metropole.fr,https://velib-metropole-opendata.smoove.pro/opendata/Velib_Metropole/gbfs.json,2.3',
  'XX,No Feed Nowhere,"Nowhere",no_feed,https://example.test,,2.3',
].join('\n');

test('header names are matched regardless of case, spaces and dashes', () => {
  assert.equal(normalizeHeader('Auto-Discovery URL'), 'autodiscoveryurl');
  assert.equal(normalizeHeader('auto_discovery_url'), 'autodiscoveryurl');
  assert.equal(normalizeHeader('System ID'), 'systemid');
});

test('the real GBFS catalog header parses and rows without a feed are dropped', () => {
  const systems = parseSystemsCsv(GBFS_CSV);
  assert.equal(systems.length, 3, 'the row with no discovery url is dropped');
  const berlin = systems.find((system) => system.id === 'nextbike_berlin');
  assert.equal(berlin.name, 'Nextbike Germany');
  assert.equal(berlin.country, 'DE');
  assert.equal(berlin.location, 'Berlin, Germany');
  assert.ok(berlin.discoveryUrl.startsWith('https://'));
  assert.equal(berlin.lat, null, 'the catalog has no coordinates and none are invented');
});

test('a quoted CSV field containing a comma survives the split', () => {
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
});

test('systems are matched to a place name, and an unmatched place matches nothing', () => {
  const systems = parseSystemsCsv(GBFS_CSV);
  const berlin = matchSystemsByPlace(systems, 'Berlin', { limit: 3 });
  assert.equal(berlin.length, 1);
  assert.equal(berlin[0].id, 'nextbike_berlin');
  assert.deepEqual(matchSystemsByPlace(systems, 'Nowhereville', { limit: 3 }), []);
  assert.deepEqual(matchSystemsByPlace(systems, '', { limit: 3 }), []);
  assert.deepEqual(matchSystemsByPlace([], 'Berlin'), []);
});

test('distance matching refuses to run without coordinates', () => {
  const systems = parseSystemsCsv(GBFS_CSV);
  assert.deepEqual(nearestSystems(systems, 52.5, 13.4), [], 'no coordinates, so no claim of proximity');
  const withCoords = [{ id: 'x', lat: 52.5, lon: 13.4, discoveryUrl: 'https://x.test' }];
  assert.equal(nearestSystems(withCoords, 52.51, 13.41).length, 1);
});

test('a discovery document resolves to the right feed', () => {
  const discovery = {
    data: {
      en: {
        feeds: [
          { name: 'station_information', url: 'https://x.test/station_information.json' },
          { name: 'station_status', url: 'https://x.test/station_status.json' },
        ],
      },
    },
  };
  assert.equal(findFeedUrl(discovery, 'station_information'), 'https://x.test/station_information.json');
  assert.equal(findFeedUrl(discovery, 'station_status'), 'https://x.test/station_status.json');
  assert.equal(findFeedUrl(discovery, 'free_bike_status'), null, 'an absent feed is not guessed');
  assert.equal(findFeedUrl(null, 'station_information'), null);
});

test('stations merge information with status, and unknown stays unknown', () => {
  const information = {
    data: {
      stations: [
        { station_id: 'a', name: 'Alpha', lat: 50.1, lon: 8.7, capacity: 10 },
        { station_id: 'b', name: 'Beta', lat: 50.2, lon: 8.8, capacity: 8 },
        { station_id: 'c', name: 'Gamma', lat: 50.3, lon: 8.9 },
      ],
    },
  };
  const status = {
    data: {
      stations: [
        { station_id: 'a', num_bikes_available: 4, num_docks_available: 6, is_renting: 1, is_returning: 1 },
        { station_id: 'b', num_bikes_available: 0, num_docks_available: 0, is_renting: 0, is_returning: 0 },
        { station_id: 'zz', num_bikes_available: 9 },
      ],
    },
  };
  const stations = normalizeStations(information, status);
  assert.equal(stations.length, 3, 'an orphan status entry creates no station');
  const alpha = stations.find((s) => s.stationId === 'a');
  assert.equal(alpha.availableBikes, 4);
  assert.equal(alpha.availableDocks, 6);
  assert.equal(alpha.renting, true);
  const beta = stations.find((s) => s.stationId === 'b');
  assert.equal(beta.availableBikes, 0);
  assert.equal(beta.renting, false);
  const gamma = stations.find((s) => s.stationId === 'c');
  assert.equal(gamma.availableBikes, null, 'unknown availability stays unknown, never zero');
  assert.equal(gamma.renting, null, 'a station with no status row is not reported as rentable');
});

test('a missing status payload does not fabricate zero bikes', () => {
  const information = { data: { stations: [{ station_id: 'a', name: 'Alpha', lat: 50.1, lon: 8.7 }] } };
  const [station] = normalizeStations(information, null);
  assert.equal(station.availableBikes, null);
  assert.equal(station.availableDocks, null);
  assert.deepEqual(normalizeStations(null, null), []);
});

/* --------------------------------- airports ------------------------------ */

const AIRPORT_LINE = '1,"Goroka Airport","Goroka","Papua New Guinea","GKA","AYGA",-6.081689834590001,145.391998291,5282,10,"U","Pacific/Port_Moresby","airport","OurAirports"';

test('an OpenFlights line parses into a typed airport', () => {
  const record = parseAirportLine(AIRPORT_LINE);
  assert.ok(record);
  assert.equal(record.iata, 'GKA');
  assert.equal(record.icao, 'AYGA');
  assert.equal(record.country, 'Papua New Guinea');
  assert.ok(Math.abs(record.lat + 6.0817) < 1e-3);
  assert.ok(Math.abs(record.lon - 145.392) < 1e-3);
  assert.ok(Math.abs(record.altitudeM - 5282 * 0.3048) < 1, 'feet are converted to metres');
  assert.equal(record.id, 'airport:AYGA');
});

test('junk airport lines are dropped', () => {
  assert.equal(parseAirportLine(''), null);
  assert.equal(parseAirportLine('1,"X"'), null, 'fewer than 14 columns');
  assert.deepEqual(parseAirports(''), []);
  const second = '2,"Madang","Madang","Papua New Guinea","MAG","AYMD",-5.21,145.79,20,10,"U","Pacific/Port_Moresby","airport","OurAirports"';
  const records = parseAirports(`${AIRPORT_LINE}\n${second}`);
  assert.equal(records.length, 2);
  const large = parseAirportLine('3,"Big","Big","X","BIG","KBIG",40,-74,100,0,"U","UTC","large_airport","OurAirports"');
  assert.equal(airportRank(large), 3);
  assert.equal(airportRank(records[0]), 0, 'an untyped airport is not promoted to a hub');
});

test('the type filter narrows an airport list', () => {
  const large = '3,"Big","Big","X","BIG","KBIG",40,-74,100,0,"U","UTC","large_airport","OurAirports"';
  assert.equal(parseAirports(`${AIRPORT_LINE}\n${large}`, { types: ['large_airport'] }).length, 1);
  assert.equal(parseAirports(`${AIRPORT_LINE}\n${large}`, { types: [] }).length, 2, 'an empty filter means no filter');
});

/* ---------------------------------- routing ------------------------------ */

const OSRM_ROUTE = {
  code: 'Ok',
  routes: [{
    distance: 12_345.6,
    duration: 1_234.5,
    geometry: { type: 'LineString', coordinates: [[-74.0, 40.7], [-74.01, 40.71]] },
    legs: [{
      distance: 12_345.6,
      duration: 1_234.5,
      steps: [
        { maneuver: { type: 'depart', modifier: null, location: [-74.0, 40.7] }, name: 'Start Street', distance: 100, duration: 60 },
        { maneuver: { type: 'turn', modifier: 'left', location: [-74.005, 40.705] }, name: 'Main Road', distance: 200, duration: 90 },
        { maneuver: { type: 'arrive', modifier: null }, name: '', distance: 0, duration: 0 },
      ],
    }],
  }],
};

test('waypoints are validated against the provider limits', () => {
  assert.deepEqual(validateWaypoints([{ lat: 40, lon: -74 }, { lat: 41, lon: -75 }]), { ok: true, totalM: validateWaypoints([{ lat: 40, lon: -74 }, { lat: 41, lon: -75 }]).totalM });
  assert.match(validateWaypoints([]).reason, /two/i);
  assert.match(validateWaypoints([{ lat: 40, lon: -74 }]).reason, /two/i);
  const many = Array.from({ length: 13 }, (_, i) => ({ lat: 40 + i * 0.01, lon: -74 }));
  assert.match(validateWaypoints(many).reason, /twelve/i);
  const far = [{ lat: 0, lon: 0 }, { lat: 60, lon: 0 }];
  assert.match(validateWaypoints(far).reason, /km/i, 'an over-long leg is refused before the request');
});

test('the route url targets the configured OSRM host and profile', () => {
  const url = routeUrl('https://router.test', 'driving', [{ lat: 40.7, lon: -74 }, { lat: 40.8, lon: -74.1 }]);
  assert.ok(url.startsWith('https://router.test/route/v1/driving/'));
  assert.ok(url.includes('-74.000000,40.700000'), `coordinates were wrong: ${url}`);
  assert.ok(url.includes('steps=true'));
  assert.ok(url.includes('geometries=geojson'));
  for (const mode of TRAVEL_MODES) {
    assert.ok(typeof mode.id === 'string' && mode.label.length > 0);
  }
});

test('a route response normalizes with real geometry and steps', () => {
  const route = normalizeRoute(OSRM_ROUTE);
  assert.ok(Math.abs(route.distanceM - 12_345.6) < 0.01);
  assert.ok(Math.abs(route.durationS - 1_234.5) < 0.01);
  assert.equal(route.path.length, 2);
  assert.ok(route.path.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
  assert.equal(route.legs.length, 1);
  assert.equal(route.legs[0].steps.length, 3);
  assert.equal(route.legs[0].steps[1].maneuver, 'turn');
  assert.equal(route.legs[0].steps[1].modifier, 'left');
});

test('an errored OSRM response is reported, not silently turned into a route', () => {
  assert.equal(normalizeRoute({ code: 'NoRoute', message: 'no route found' }), null);
  assert.equal(normalizeRoute(null), null);
  assert.equal(normalizeRoute({ code: 'Ok', routes: [] }), null);
  assert.equal(normalizeRoute({ routes: [{ distance: 1, geometry: { coordinates: [[0, 0]] } }] }), null, 'one point is not a path');
});

test('a maneuver is described in words', () => {
  const route = normalizeRoute(OSRM_ROUTE);
  const turn = route.legs[0].steps[1];
  assert.ok(describeManeuver(turn).includes('turn'), describeManeuver(turn));
  assert.ok(describeManeuver(turn).includes('Main Road'));
  assert.equal(describeManeuver(null), '');
});

test('a straight-line path stays inside the requested segment count', () => {
  const path = straightLinePath({ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { segments: 8 });
  assert.equal(path.length, 9, 'n segments have n+1 vertices');
  assert.ok(Math.abs(path[0].lat) < 1e-9 && Math.abs(path.at(-1).lat - 1) < 1e-6);
  assert.deepEqual(straightLinePath(null, { lat: 1, lon: 1 }), []);
  assert.deepEqual(straightLinePath({ lat: 'x', lon: 0 }, { lat: 1, lon: 1 }), []);
});

/* -------------------------------- geocoding ------------------------------ */

test('a bare coordinate query short-circuits the network', () => {
  const result = coordinateResult('48.8566, 2.3522');
  assert.ok(result);
  assert.ok(Math.abs(result.lat - 48.8566) < 1e-6);
  assert.equal(result.kind, 'coordinate');
  assert.equal(coordinateResult('Paris'), null);
  assert.equal(coordinateResult(''), null);
});

test('a Photon payload normalizes into ranked results', () => {
  const payload = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [2.3522, 48.8566] },
        properties: { name: 'Paris', country: 'France', type: 'city', osm_id: 7444 },
      },
      { geometry: null, properties: { name: 'broken' } },
    ],
  };
  const results = normalizePhoton(payload);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Paris');
  assert.ok(Math.abs(results[0].lat - 48.8566) < 1e-6, 'Photon is lon,lat');
  assert.equal(results[0].kind, 'city');
  assert.equal(normalizePhoton(null).length, 0);
});

test('a Nominatim payload normalizes into the same shape', () => {
  const payload = [{ lat: '48.8566', lon: '2.3522', display_name: 'Paris, France', type: 'city', place_id: 9 }];
  const results = normalizeNominatim(payload);
  assert.equal(results.length, 1);
  assert.ok(Number.isFinite(results[0].lat), 'string coords are numericised');
  assert.ok(results[0].displayName.includes('Paris'));
  assert.equal(normalizeNominatim([]).length, 0);
  assert.equal(normalizeNominatim(null).length, 0);
});

/* -------------------------------- Overpass ------------------------------- */

test('an Overpass query is bounded by a box, a timeout and a limit', () => {
  const query = buildQuery(['["amenity"="fuel"]'], { south: 50, west: 8, north: 51, east: 9 }, { timeout: 10, limit: 50 });
  assert.match(query, /\[timeout:10\]/);
  assert.match(query, /\[out:json\]/);
  assert.match(query, /50\.00000,8\.00000,51\.00000,9\.00000/);
  assert.match(query, /out center tags 50/);
  assert.match(query, /nwr\["amenity"="fuel"\]/);
  assert.equal(normalizeOverpass(null).length, 0);
});

test('Overpass elements normalize into points with a stable id', () => {
  const payload = {
    elements: [
      { type: 'node', id: 123, lat: 50.5, lon: 8.5, tags: { name: 'Alpha', amenity: 'fuel' } },
      { type: 'node', id: 124, lat: 50.6, lon: 8.6, tags: {} },
      { type: 'way', id: 9, center: { lat: 50.7, lon: 8.7 }, tags: { name: 'Beta' } },
      { type: 'relation', id: 1, members: [] },
    ],
  };
  const records = normalizeOverpass(payload, { prefix: 'fuel' });
  assert.equal(records.length, 3, 'an element with no position and no center is dropped');
  assert.ok(records.every((r) => r.id.startsWith('fuel:')));
  assert.ok(records.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)));
  assert.equal(records.find((r) => r.osmType === 'way').name, 'Beta');
});

/* ---------------------------------- storms ------------------------------- */

test('hemisphere coordinates keep their sign', () => {
  assert.ok(Math.abs(parseHemisphereCoordinate('12.5N') - 12.5) < 1e-9);
  assert.ok(Math.abs(parseHemisphereCoordinate('12.5S') + 12.5) < 1e-9);
  assert.ok(Math.abs(parseHemisphereCoordinate('75.2W') + 75.2) < 1e-9);
  assert.ok(Math.abs(parseHemisphereCoordinate('75.2E') - 75.2) < 1e-9);
  assert.equal(parseHemisphereCoordinate('nonsense'), null);
  assert.equal(parseHemisphereCoordinate(''), null);
  assert.equal(parseHemisphereCoordinate(null), null);
});

test('wind speed maps onto the Saffir-Simpson scale', () => {
  assert.equal(saffirSimpson(137).category, 5);
  assert.equal(saffirSimpson(113).category, 4);
  assert.equal(saffirSimpson(96).category, 3);
  assert.equal(saffirSimpson(83).category, 2);
  assert.equal(saffirSimpson(64).category, 1);
  assert.equal(saffirSimpson(34).category, 0, 'a tropical storm is category 0');
  assert.equal(saffirSimpson(30).category, null, 'a depression has no category');
  assert.equal(saffirSimpson(30).label, 'Tropical depression');
  assert.equal(saffirSimpson(null).category, null);
  for (const category of [0, 1, 2, 3, 4, 5, null]) {
    assert.match(stormColor(category), /^#[0-9a-f]{6}$/i, `category ${category} needs a colour`);
  }
});

test('an NHC CurrentStorms payload normalizes into storm records', () => {
  const payload = {
    stormList: [{
      stormId: 'AL092026',
      stormName: 'TEST STORM',
      basin: 'ATL',
      stormType: 'HU',
      lat: '25.1N',
      lon: '75.2W',
      maxWind: '90',
      maxGust: '110',
      stormPressure: '968',
      stormSpeed: '12',
      stormDirection: '315',
      advisoryNumber: '14',
    }],
  };
  const storms = normalizeStormList(payload);
  assert.equal(storms.length, 1);
  const storm = storms[0];
  assert.equal(storm.id, 'nhc:AL092026');
  assert.ok(Math.abs(storm.lat - 25.1) < 1e-6);
  assert.ok(Math.abs(storm.lon + 75.2) < 1e-6, 'a W longitude is negative');
  assert.equal(storm.windKt, 90);
  assert.ok(Math.abs(storm.windMs - 90 * 0.514444) < 0.01);
  assert.equal(storm.category, 2);
  assert.equal(storm.categoryLabel, 'Category 2');
  assert.ok(storm.url.includes('al092026'), 'the advisory link is lowercased');
  assert.equal(normalizeStormList(null).length, 0);
  assert.equal(normalizeStormList({ stormList: [] }).length, 0);
  assert.equal(normalizeStormList({ stormList: [{ stormName: 'no position' }] }).length, 0);
});

/* ------------------------------ radio streams ---------------------------- */

const RADIO_STATIONS = [
  { stationuuid: 'u1', name: 'Alpha FM', url_resolved: 'https://stream.test/alpha', geo_lat: '50.1', geo_long: '8.7', country: 'Germany', bitrate: '128', codec: 'MP3', clickcount: '30000', votes: '40', lastcheckok: '1', tags: 'rock,pop' },
  { stationuuid: 'u2', name: 'Beta', url_resolved: 'https://stream.test/beta', geo_lat: '-33.0', geo_long: '151.0', lastcheckok: '0' },
  { stationuuid: 'u3', name: 'No Location', url_resolved: 'https://stream.test/c', geo_lat: '', geo_long: '' },
  { stationuuid: 'u4', name: 'No Stream', geo_lat: '10', geo_long: '10' },
];

test('radio stations normalize, and unlocated ones are dropped', () => {
  const stations = normalizeRadioStations(RADIO_STATIONS);
  assert.equal(stations.length, 3, 'the unlocated station is dropped, never parked at 0,0');
  const alpha = stations.find((s) => s.id === 'radio:u1');
  assert.equal(alpha.name, 'Alpha FM');
  assert.ok(alpha.url.startsWith('https://'));
  assert.equal(alpha.bitrateKbps, 128);
  assert.equal(alpha.clicks, 30000);
  assert.equal(alpha.lastCheckOk, true);
  assert.deepEqual(alpha.tags, ['rock', 'pop']);
  assert.deepEqual(normalizeRadioStations(null), []);
});

test('a station with a failed health check is still listed, with the reason', () => {
  const stations = normalizeRadioStations(RADIO_STATIONS);
  const beta = stations.find((s) => s.id === 'radio:u2');
  assert.equal(beta.lastCheckOk, false);
  assert.equal(playbackOutlook(beta).playable, true);
  assert.match(playbackOutlook(beta).reason, /health check/i);
  assert.equal(playbackOutlook(stations.find((s) => s.id === 'radio:u1')).reason, null);
  assert.equal(playbackOutlook({ url: null }).playable, false, 'no stream url is not playable');
});

test('stations are filtered to the viewport', () => {
  const stations = normalizeRadioStations(RADIO_STATIONS);
  const visible = filterByBox(stations, { south: 49, west: 7, north: 51, east: 10 });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'radio:u1');
  assert.equal(filterByBox(stations, null).length, stations.length, 'no box means no filter');
  // An antimeridian-spanning box must not silently drop everything.
  const wrapped = filterByBox(stations, { south: -40, west: 150, north: -30, east: -170 });
  assert.equal(wrapped.length, 1, 'the Sydney station is inside the wrapped box');
});

test('the station search url asks only for what the layer uses', () => {
  const url = stationSearchUrl('https://de1.api.radio-browser.info', { limit: 100 });
  assert.ok(url.includes('/json/stations/search'));
  assert.ok(url.includes('hidebroken=true'));
  assert.ok(url.includes('has_geo_info=true'));
  assert.ok(url.includes('limit=100'));
});

/* ------------------------------- open-meteo ------------------------------ */

test('a weather code resolves to a description', () => {
  assert.ok(describeWeatherCode(0).length > 0);
  assert.ok(describeWeatherCode(95).length > 0);
  assert.equal(describeWeatherCode(9999), 'Unknown', 'an unknown code says so');
});

test('a forecast url batches coordinates and asks in SI units', () => {
  const url = forecastUrl([{ lat: 50, lon: 8 }, { lat: 51, lon: 9 }]);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast'));
  assert.ok(url.includes('latitude=50.000%2C51.000'), url);
  assert.ok(url.includes('longitude=8.000%2C9.000'), url);
  assert.ok(url.includes('wind_speed_unit=ms'), 'no client-side unit conversion to get wrong');
  assert.ok(url.includes('timezone=UTC'));
  assert.ok(url.includes('current='));
});

test('a forecast payload normalizes into a grid aligned to its points', () => {
  const payload = [
    { latitude: 50, longitude: 8, elevation: 120, current: { time: '2026-01-01T00:00', temperature_2m: 3.2, wind_speed_10m: 5.5, weather_code: 61, cloud_cover: 80 } },
    { latitude: 51, longitude: 9, elevation: 200, current: { time: '2026-01-01T00:00', temperature_2m: 1.1, wind_speed_10m: 7.5, weather_code: 3, cloud_cover: 40 } },
  ];
  const grid = normalizeForecastList(payload);
  assert.equal(grid.length, 2);
  assert.ok(grid.every((cell) => Number.isFinite(cell.lat) && Number.isFinite(cell.lon)));
  assert.equal(grid[0].temperatureC, 3.2);
  assert.equal(grid[1].weatherCode, 3);
  assert.deepEqual(normalizeForecastList(null), []);
  assert.equal(normalizeForecastList({ latitude: 1, longitude: 2, current: {} }).length, 1, 'a single point arrives as an object');
});
