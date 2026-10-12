/**
 * Event layers — earthquakes, active fires, tropical cyclones.
 *
 * Earthquakes are the most reliably browser-accessible live source in the
 * project (USGS publishes cross-origin GeoJSON). Fires need a free NASA key.
 * Cyclones come from the NHC advisory feed and are explicitly advisory-only.
 */

import * as Cesium from 'cesium';
import { createLayer } from './base.js';
import { createPointLayer, viewportQueryBox } from './pointLayer.js';
import {
  TIME_RANGES,
  fetchEarthquakes,
  magnitudeColor,
  magnitudeRadiusM,
} from '../sources/earthquakes.js';
import { fetchActiveFires, fireColor, FIRMS_SATELLITES } from '../sources/firms.js';
import { fetchActiveStorms, stormColor } from '../sources/nhc.js';
import { formatUtcDateTime, formatAge } from '../net/status.js';
import { formatLatLon, formatDistance, compassPoint } from '../geo/coords.js';

/* ----------------------------- earthquakes ------------------------------ */

export function createEarthquakeLayer() {
  let rings = null;
  let surface = null;

  return createPointLayer({
    id: 'earthquakes',
    name: 'Earthquakes',
    category: 'events',
    icon: 'activity',
    description: 'USGS seismic events. Positions, magnitudes and depths as published by the U.S. Geological Survey.',
    sources: 'usgs',
    refreshMs: 2 * 60 * 1000,
    viewportAware: true,
    maxPoints: 2000,
    maxLabels: 20,
    params: { range: 'day', minMagnitude: 2.5, magnitudeScale: 1 },
    configure({ panel }) {
      panel.select({
        id: 'range',
        label: 'Time range',
        options: TIME_RANGES.map((range) => ({ value: range.id, label: range.label })),
      });
      panel.slider({ id: 'minMagnitude', label: 'Minimum magnitude', min: 0, max: 7, step: 0.5 });
      panel.slider({ id: 'magnitudeScale', label: 'Marker scale', min: 0.4, max: 2.5, step: 0.1 });
    },
    positionOf: (record) => ({
      lat: record.lat,
      lon: record.lon,
      height: record.depthKm ? -record.depthKm * 1000 : 0,
    }),
    styleOf: (record) => ({
      pixelSize: Math.max(4, Math.min(18, 3 + (record.mag ?? 1) * 1.6)),
      color: magnitudeColor(record.mag),
      label: (record.mag ?? 0) >= 4.5 ? `M${(record.mag ?? 0).toFixed(1)}` : null,
      priority: record.mag ?? 0,
    }),
    detail: (record) => ({
      title: `M${(record.mag ?? 0).toFixed(1)} — ${record.place}`,
      subtitle: record.title || '',
      fields: [
        ['Magnitude', record.mag === null ? '—' : `${record.mag.toFixed(1)} ${record.magType || ''}`.trim()],
        ['Depth', record.depthKm === null ? '—' : `${record.depthKm.toFixed(1)} km`],
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Origin time', record.time ? formatUtcDateTime(record.time) : '—'],
        ['Age', record.time ? formatAge(Date.now() - record.time) : '—'],
        ['Felt reports', record.felt ?? '—'],
        ['Tsunami alert', record.tsunami ? 'YES — see official sources' : 'None issued in feed'],
        ['PAGER alert', record.alert || 'None'],
        ['Intensity (CDI)', record.cdi?.toFixed(1) ?? '—'],
        ['Network', record.net || '—'],
        ['Stations', record.nst ?? '—'],
        ['RMS', record.rms?.toFixed(2) ?? '—'],
      ],
      links: record.url ? [{ label: 'USGS event page', href: record.url }] : [],
      note: 'Not for emergency decisions. Follow official warnings from your national authority.',
    }),
    async fetch({ box, params, signal }) {
      const range = TIME_RANGES.find((entry) => entry.id === params.range) || TIME_RANGES[0];
      const result = await fetchEarthquakes({
        hours: range.hours,
        minMagnitude: Math.max(params.minMagnitude, range.minMagnitude),
        box: params.range === 'day' || params.range === 'week' ? box : null,
        signal,
      });
      drawRings(result.records, params);
      return {
        records: result.records,
        message: `${result.records.length} events · last ${range.label}`,
      };
    },
    createRenderer: undefined,
    onAttach(context) {
      surface = context;
      rings = new Cesium.CustomDataSource('earthquake-rings');
      context.viewer.dataSources.add(rings);
    },
    onDispose() {
      if (surface?.viewer && rings) surface.viewer.dataSources.remove(rings, true);
      rings = null;
    },
  });

  function drawRings(records, params) {
    if (!rings) return;
    rings.entities.removeAll();
    const scale = Number(params.magnitudeScale ?? 1);
    for (const record of records) {
      if ((record.mag ?? 0) < 5) continue;
      rings.entities.add({
        position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat),
        ellipse: {
          semiMajorAxis: magnitudeRadiusM(record.mag, scale),
          semiMinorAxis: magnitudeRadiusM(record.mag, scale),
          material: Cesium.Color.fromCssColorString(magnitudeColor(record.mag)).withAlpha(0.1),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(magnitudeColor(record.mag)).withAlpha(0.55),
          outlineWidth: 1,
          height: 0,
        },
      });
    }
  }
}

/* -------------------------------- fires --------------------------------- */

function createFireLayer() {
  return createPointLayer({
    id: 'fires',
    name: 'Active fires (NASA FIRMS)',
    category: 'events',
    icon: 'flame',
    description:
      'Near-real-time thermal anomaly detections from MODIS and VIIRS. Requires a free NASA LANCE key.',
    sources: 'firms',
    refreshMs: 15 * 60 * 1000,
    viewportAware: true,
    maxPoints: 4000,
    maxLabels: 0,
    params: { satellite: 'VIIRS_SNPP_NRT', days: 1, minConfidence: 'n' },
    requires: [{ kind: 'setting', id: 'firmsKey', label: 'NASA FIRMS API key' }],
    configure({ panel }) {
      panel.setting({
        id: 'firmsKey',
        label: 'NASA FIRMS (LANCE) API key',
        secret: true,
        placeholder: 'Free key from firms.modaps.eosdis.nasa.gov',
      });
      panel.select({
        id: 'satellite',
        label: 'Instrument',
        options: FIRMS_SATELLITES.map((entry) => ({ value: entry.id, label: entry.label })),
      });
      panel.select({
        id: 'days',
        label: 'Look-back',
        options: [
          { value: 1, label: 'Last 24 h' },
          { value: 2, label: 'Last 48 h' },
          { value: 7, label: 'Last 7 days' },
        ],
      });
      panel.select({
        id: 'minConfidence',
        label: 'Minimum confidence',
        options: [
          { value: 'l', label: 'Low' },
          { value: 'n', label: 'Nominal' },
          { value: 'h', label: 'High' }
        ],
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: Math.max(3, Math.min(12, 3 + (record.frpMw ?? 0) / 120)),
      color: fireColor(record),
      priority: record.frpMw ?? 0,
    }),
    detail: (record) => ({
      title: `Fire detection · FRP ${record.frpMw?.toFixed?.(1) ?? '—'} MW`,
      subtitle: [record.satellite, record.instrument].filter(Boolean).join(' · '),
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Brightness', record.brightnessK ? `${record.brightnessK.toFixed(1)} K` : '—'],
        ['Radiative power', record.frpMw ? `${record.frpMw.toFixed(1)} MW` : '—'],
        ['Confidence', record.confidence || '—'],
        ['Day / night', record.dayNight === 'N' ? 'Night' : 'Day'],
        ['Observed', record.observedAt ? formatUtcDateTime(record.observedAt) : '—'],
        ['Instrument', record.instrument || '—'],
      ],
      note: 'A thermal anomaly is not a confirmed wildfire. Agricultural burning and industrial heat appear too.',
    }),
    async fetch({ ctx, box, params, signal }) {
      const queryBox = box || viewportQueryBox(ctx, { radiusKm: 800 });
      const result = await fetchActiveFires({
        apiKey: ctx.settings.get('firmsKey'),
        box: queryBox,
        satelliteId: params.satellite,
        days: Number(params.days),
        signal,
      });
      const rank = { l: 0, n: 1, h: 2 };
      const minimum = rank[params.minConfidence] ?? 1;
      const records = result.records.filter((record) => (rank[record.confidence] ?? 0) >= minimum);
      return {
        records,
        message: `${records.length} detections of ${result.records.length} in view`,
      };
    },
  });
}

/* ------------------------------- cyclones ------------------------------- */

function createCycloneLayer() {
  return createPointLayer({
    id: 'cyclones',
    name: 'Tropical cyclones',
    category: 'events',
    icon: 'siren',
    description:
      'Active storm positions from the NOAA National Hurricane Center / Central Pacific Hurricane Center advisory feed.',
    sources: 'nhc',
    refreshMs: 10 * 60 * 1000,
    maxPoints: 40,
    maxLabels: 12,
    params: {},
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 12,
      color: stormColor(record.category),
      label: record.name,
      priority: 100,
    }),
    detail: (record) => ({
      title: record.name,
      subtitle: `${record.categoryLabel} · ${record.basin || 'basin'}`,
      fields: [
        ['Type', record.type || '—'],
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Max sustained wind', record.windKt ? `${Math.round(record.windKt)} kt (${Math.round(record.windKt * 1.852)} km/h)` : '—'],
        ['Gusts', record.gustKt ? `${Math.round(record.gustKt)} kt` : '—'],
        ['Central pressure', record.pressureHpa ? `${Math.round(record.pressureHpa)} hPa` : '—'],
        ['Movement', record.movementKt ? `${Math.round(record.movementKt)} kt` : '—'],
        ['Heading', record.headingDeg === null ? '—' : `${Math.round(record.headingDeg)}° ${compassPoint(record.headingDeg)}`],
        ['Advisory', record.advisoryNumber || '—'],
      ],
      links: record.url ? [{ label: 'NHC advisory', href: 'https://www.nhc.noaa.gov/' }] : [],
      note: 'Advisory product on a delay. Never use this console for decisions about safety.',
    }),
    fetch: async ({ signal }) => fetchActiveStorms({ signal }),
  });
}

export function createEventLayers() {
  return [createEarthquakeLayer(), createFireLayer(), createCycloneLayer()];
}

export { formatDistance };
