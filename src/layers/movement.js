/**
 * Movement layers — aircraft, military traffic and maritime AIS.
 *
 * These three carry the hardest static-hosting constraints in the project, and
 * each one handles it differently rather than pretending:
 *
 *  - Aircraft: no public ADS-B API sends CORS headers, so the layer runs
 *    against a user-supplied endpoint and offers an explicitly-labelled sample
 *    feed. It never labels the sample as live.
 *  - Military: the same, filtered on the classification fields the feed
 *    actually publishes. Nothing is inferred and passed off as observation.
 *  - Vessels: AISStream is a WebSocket, which the same-origin policy does not
 *    block, so this genuinely works from a static page — with a free user key.
 */

import { createPointLayer } from './pointLayer.js';
import { viewportQueryBox } from './pointLayer.js';
import {
  createSampleFeed,
  fetchAircraft,
  normalizeAircraftFeed,
} from '../sources/adsbV2.js';
import { openAisStream } from '../sources/aisStream.js';
import { vesselColor } from '../sources/aisStream.js';
import { LAYER_STATUS, formatAge } from '../net/status.js';
import {
  formatAltitude,
  formatFeet,
  formatKnots,
  formatSpeed,
  compassPoint,
  formatLatLon,
} from '../geo/coords.js';

/* ------------------------------- aircraft ------------------------------- */

function aircraftStyle(record, params = {}) {
  const altitudeKm = (record.altitudeM ?? 0) / 1000;
  const showLabels = params.showCallsigns !== false;
  return {
    pixelSize: record.onGround ? 5 : 7,
    color: record.military
      ? '#f0645a'
      : record.emergency
        ? '#ff2d2d'
        : record.onGround
          ? '#f0b429'
          : altitudeKm > 10
            ? '#38bdf8'
            : '#7dd3fc',
    rotation: record.trackDeg ?? 0,
    scale: 0.62,
    label: showLabels ? (record.callsign || record.registration || null) : null,
    priority: (record.speedMs ?? 0) + (record.callsign ? 50 : 0),
  };
}

function aircraftDetail(record) {
  return {
    title: record.callsign || record.registration || `0x${record.hex}`,
    subtitle: record.aircraftType ? `${record.aircraftType} · ${record.hex.toUpperCase()}` : record.hex.toUpperCase(),
    fields: [
      ['Position', formatLatLon(record.lat, record.lon)],
      ['Altitude', record.altitudeM === null ? 'Unknown' : `${formatAltitude(record.altitudeM)} (${formatFeet(record.altitudeM)})`],
      ['Altitude source', record.altitudeSource || '—'],
      ['Ground speed', record.speedMs === null ? '—' : `${formatSpeed(record.speedMs)} (${formatKnots(record.speedMs)})`],
      ['Track', record.trackDeg === null ? '—' : `${Math.round(record.trackDeg)}° ${compassPoint(record.trackDeg)}`],
      ['Vertical rate', record.verticalRateMs === null ? '—' : `${Math.round(record.verticalRateMs * 196.85)} ft/min`],
      ['Squawk', record.squawk || '—'],
      ['Emergency', record.emergency || 'None'],
      ['Emitter category', record.category || '—'],
      ['Registration', record.registration || '—'],
      ['Source', record.source === 'multilateration' ? 'Multilateration (estimated)' : 'ADS-B'],
      ['Last seen', formatAge(Date.now() - (record.observedAt || Date.now()))],
    ],
    note: record.source === 'multilateration'
      ? 'This position was multilaterated from receiver timing, not broadcast directly. Treat it as an estimate.'
      : null,
  };
}

function makeAircraftLayer({ id, name, description, militaryOnly = false, icon = 'plane' }) {
  return createPointLayer({
    id,
    name,
    category: 'movement',
    icon,
    description,
    sources: 'adsb-lol',
    refreshMs: 20_000,
    viewportAware: true,
    billboard: 'aircraft',
    maxPoints: 3000,
    maxLabels: 24,
    params: {
      minAltitudeFt: 0,
      maxAltitudeFt: 60000,
      showCallsigns: true,
      hideOnGround: false,
      radiusNm: 250,
    },
    positionOf: (record) => ({
      lat: record.lat,
      lon: record.lon,
      height: record.altitudeM ?? 0,
    }),
    styleOf: aircraftStyle,
    detail: aircraftDetail,
    configure: configureAircraft,
    async fetch({ ctx, params, signal, box }) {
      const demo = Boolean(ctx?.settings.get('aircraftDemoMode'));
      if (demo) {
        const focus = ctx.camera.focus() || { lat: 0, lon: 0 };
        const feed = createSampleFeed({ lat: focus.lat, lon: focus.lon, count: 42 });
        const { records } = normalizeAircraftFeed(feed);
        return {
          records: applyAircraftFilters(records, params, militaryOnly),
          demo: true,
          message: 'Sample data — synthesised aircraft, not observations',
        };
      }
      const endpoint = ctx?.settings.get('adsbEndpoint');
      if (!endpoint) {
        const error = new Error(
          'No ADS-B endpoint configured. Public ADS-B APIs send no CORS header, so supply your own in Settings.',
        );
        error.kind = 'config';
        throw error;
      }
      const focus = ctx?.camera?.focus?.() || { lat: 0, lon: 0 };
      const result = await fetchAircraft(
        { endpoint, lat: focus.lat, lon: focus.lon, radiusNm: params.radiusNm, signal },
      );
      let records = applyAircraftFilters(result.records, params, militaryOnly);
      if (box) records = records.filter((record) => insideBox(record, box));
      return {
        records,
        message: `${result.records.length} contacts from ${new URL(endpoint).host}`,
      };
    },
  });
}

function applyAircraftFilters(records, params, militaryOnly) {
  const minFt = Number(params.minAltitudeFt ?? 0);
  const maxFt = Number(params.maxAltitudeFt ?? 60000);
  return records.filter((record) => {
    if (militaryOnly && !record.military) return false;
    if (params.hideOnGround && record.onGround) return false;
    if (record.altitudeM === null) return true;
    const feet = record.altitudeM / 0.3048;
    return feet >= minFt && feet <= maxFt;
  });
}

function insideBox(record, box) {
  const west = Math.min(box.west, box.east);
  const east = Math.max(box.west, box.east);
  return record.lat >= box.south && record.lat <= box.north && record.lon >= west && record.lon <= east;
}

function configureAircraft({ panel }) {
  panel.setting({
    id: 'adsbEndpoint',
    label: 'ADS-B endpoint',
    placeholder: 'https://your-proxy.example/v2/lat/{lat}/lon/{lon}/dist/{radiusNm}',
    help: 'Public ADS-B APIs (adsb.lol, adsb.fi, airplanes.live, OpenSky) do not send Access-Control-Allow-Origin, so a static page cannot read them. Point this at your own proxy, or at a readsb/tar1090 receiver on your network.',
  });
  panel.toggle({
    id: 'aircraftDemoMode',
    label: 'Use labelled sample data',
    help: 'Renders synthesised aircraft so the layer can be explored. Every marker and the status row are marked SAMPLE DATA.',
  });
}

/* ------------------------------- vessels -------------------------------- */

function vesselLayer() {
  let stream = null;
  let lastStatus = { status: LAYER_STATUS.IDLE, message: '' };
  let pendingRecords = [];
  let pushUpdate = null;

  return createPointLayer({
    id: 'vessels',
    name: 'Maritime traffic (AIS)',
    category: 'movement',
    icon: 'ship',
    description: 'Live ship positions from the AISStream.io WebSocket. AIS is a public broadcast; positions are self-reported by each vessel.',
    sources: 'aisstream',
    refreshMs: 0,
    requires: [{ kind: 'setting', id: 'aisStreamKey', label: 'AISStream.io API key' }],
    maxPoints: 1500,
    maxLabels: 18,
    params: { minSpeedKn: 0, showNames: false },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record, params) => ({
      pixelSize: 5,
      color: vesselColor(record.shipType),
      rotation: record.headingDeg ?? record.courseDeg ?? 0,
      scale: 0.5,
      label: params.showNames ? (record.name || null) : null,
      priority: record.speedKn ?? 0,
    }),
    detail: (record) => ({
      title: record.name || `MMSI ${record.mmsi}`,
      subtitle: [record.shipTypeLabel, record.country].filter(Boolean).join(' · ') || 'AIS contact',
      fields: [
        ['MMSI', record.mmsi],
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Ship type', record.shipTypeLabel || '—'],
        ['Flag (MID)', record.country || 'Unknown'],
        ['Speed over ground', record.speedKn === null ? '—' : `${record.speedKn.toFixed(1)} kn`],
        ['Course', record.courseDeg === null ? '—' : `${Math.round(record.courseDeg)}° ${compassPoint(record.courseDeg)}`],
        ['Heading', record.headingDeg === null ? '—' : `${Math.round(record.headingDeg)}°`],
        ['Destination', record.destination || '—'],
        ['Call sign', record.callSign || '—'],
        ['IMO', record.imo || '—'],
        ['Draught', record.draughtM ? `${record.draughtM.toFixed(1)} m` : '—'],
      ],
      note: 'AIS positions are broadcast by the vessel itself and are not verified.',
    }),
    configure: ({ panel }) => {
      panel.setting({
        id: 'aisStreamKey',
        label: 'AISStream.io API key',
        secret: true,
        placeholder: 'Free key from aisstream.io',
        help: 'AISStream is a browser WebSocket service, so the key is client-side by design. Restrict it in the AISStream dashboard.',
      });
    },
    onAttach(surface, layer) {
      pushUpdate = (status) => {
        lastStatus = status;
        // Reflect stream health on the layer row without re-fetching.
        layer.refresh({ silent: true }).catch(() => {});
      };
      surface.events.on('vessels:status', (status) => pushUpdate(status));
    },
    async fetch({ ctx, params, signal }) {
      const key = ctx.settings.get('aisStreamKey');
      if (!key) {
        const error = new Error('An AISStream.io API key is required');
        error.kind = 'config';
        throw error;
      }
      if (!stream) {
        const box = ctx.camera.viewportBox(300) || { south: -90, west: -180, north: 90, east: 180 };
        stream = openAisStream({
          apiKey: key,
          bbox: box,
          onStatus: (status) => ctx.events.emit('vessels:status', status),
        });
      }
      const records = stream.records.filter((record) => (record.speedKn ?? 0) >= Number(params.minSpeedKn || 0));
      return {
        records,
        message: lastStatus.message || `${records.length} vessels`,
      };
    },
    onDispose() {
      stream?.close();
      stream = null;
    },
  });
}

export function createMovementLayers() {
  return [
    makeAircraftLayer({
      id: 'aircraft',
      name: 'Civil aircraft',
      description:
        'Live civil air traffic. Because no public ADS-B API sends CORS headers, this layer reads a user-supplied endpoint and offers a clearly-labelled sample feed.',
    }),
    makeAircraftLayer({
      id: 'military',
      name: 'Military aircraft',
      icon: 'tower',
      militaryOnly: true,
      description:
        'Contacts the ADS-B feed itself flags as military. Classification comes from the source, not from inference.',
    }),
    vesselLayer(),
  ];
}
