/**
 * Infrastructure layers.
 *
 * All of these come from OpenStreetMap through Overpass, so they are ODbL data
 * with a shared attribution, and all of them are *mapped* features: they say a
 * volunteer recorded a data centre or a dam at this location, not that it is
 * operating. The layer descriptions say that explicitly.
 *
 * The airport layer is different — a static reference dataset, not live
 * traffic — and is labelled as such.
 */

import { createPointLayer, viewportQueryBox } from './pointLayer.js';
import { fetchFeatures } from '../sources/overpass.js';
import { fetchAirports, airportColor, airportRank } from '../sources/openflights.js';
import { formatLatLon, formatAltitude } from '../geo/coords.js';

function osmLink(record) {
  return `https://www.openstreetmap.org/${record.osmType}/${record.osmId}`;
}

/** Shared shape for a simple OSM point layer. */
function osmPointLayer({ id, name, icon, selectors, color, prefix, radiusKm = 400, description, limit = 800, extraFields = () => [] }) {
  return createPointLayer({
    id,
    name,
    category: 'infrastructure',
    icon,
    description,
    sources: 'overpass',
    refreshMs: 30 * 60 * 1000,
    viewportAware: true,
    maxPoints: 2500,
    maxLabels: 14,
    params: { radiusKm, namedOnly: true },
    configure({ panel }) {
      panel.slider({ id: 'radiusKm', label: 'Search radius (km)', min: 50, max: 2000, step: 50 });
      panel.toggle({ id: 'namedOnly', label: 'Only named features' });
      panel.notice({
        tone: 'info',
        title: 'Mapped data',
        body: 'Features come from OpenStreetMap contributors. A mapped feature is not evidence that it is operating today.',
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 6,
      color: typeof color === 'function' ? color(record) : color,
      label: record.name || null,
      priority: record.name ? 10 : 0,
    }),
    detail: (record) => ({
      title: record.name || name,
      subtitle: 'OpenStreetMap-mapped feature',
      fields: [['Position', formatLatLon(record.lat, record.lon)], ...extraFields(record)],
      links: [{ label: 'OpenStreetMap object', href: osmLink(record) }],
    }),
    async fetch({ ctx, box, params, signal }) {
      const queryBox = box || viewportQueryBox(ctx, { radiusKm: params.radiusKm });
      const result = await fetchFeatures(selectors, queryBox, {
        signal,
        prefix,
        limit,
        preferIndex: ctx?.overpassIndex ?? 0,
      });
      if (result.index >= 0) ctx.overpassIndex = result.index;
      const records = params.namedOnly ? result.records.filter((record) => record.name) : result.records;
      return { records, message: `${records.length} mapped features in view` };
    },
  });
}

function createAirportLayer() {
  return createPointLayer({
    id: 'airports',
    name: 'Airports (reference)',
    category: 'infrastructure',
    icon: 'plane',
    description:
      'Static reference dataset of airport locations (OpenFlights, ODbL). Shows where airports are — not live traffic.',
    sources: 'openflights',
    refreshMs: 24 * 60 * 60 * 1000,
    viewportAware: true,
    maxPoints: 4000,
    maxLabels: 16,
    params: { types: 'large,medium', minRank: 2 },
    configure({ panel }) {
      panel.chips({
        id: 'types',
        label: 'Airport size',
        options: [
          { value: 'large', label: 'Large' },
          { value: 'medium', label: 'Medium' },
          { value: 'small', label: 'Small' },
        ],
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 4 + airportRank(record) * 2,
      color: airportColor(record),
      label: record.iata || record.icao || null,
      priority: airportRank(record) * 10,
    }),
    detail: (record) => ({
      title: record.name || record.iata || record.icao || 'Airport',
      subtitle: [record.city, record.country].filter(Boolean).join(', '),
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['IATA', record.iata || '—'],
        ['ICAO', record.icao || '—'],
        ['Type', (record.type || '—').replace(/_/g, ' ')],
        ['Elevation', record.altitudeM === null ? '—' : formatAltitude(record.altitudeM)],
        ['Time zone', record.timezone || '—'],
        ['UTC offset', record.utcOffsetH === null ? '—' : `${record.utcOffsetH} h`],
      ],
      links: [
        { label: 'OpenStreetMap search', href: `https://www.openstreetmap.org/search?query=${encodeURIComponent(record.icao || record.name || '')}` },
      ],
      note: 'Static reference dataset. Not live traffic and not authoritative.',
    }),
    async fetch({ ctx, box, params, signal }) {
      const types = String(params.types || 'large,medium')
        .split(',')
        .map((entry) => `${entry.trim()}_airport`)
        .filter((entry) => entry !== '_airport');
      const result = await fetchAirports({ signal, types });
      let records = result.records;
      if (box) {
        const west = Math.min(box.west, box.east);
        const east = Math.max(box.west, box.east);
        records = records.filter(
          (record) =>
            record.lat >= box.south && record.lat <= box.north && record.lon >= west && record.lon <= east,
        );
      }
      ctx?.events?.emit?.('airports:loaded', { count: records.length });
      return { records, message: `${records.length} airports · OpenFlights (ODbL)` };
    },
  });
}

export function createInfrastructureLayers() {
  return [
    osmPointLayer({
      id: 'datacenters',
      name: 'Data centres',
      icon: 'database',
      color: '#a78bfa',
      prefix: 'dc',
      radiusKm: 600,
      description: 'Buildings mapped in OpenStreetMap as data centres.',
      selectors: ['["building"="data_center"]', '["building"="datacentre"]', '["man_made"="data_center"]'],
      extraFields: (record) => [
        ['Operator', record.tags?.operator || '—'],
        ['Building', record.tags?.building || '—'],
        ['Height', record.tags?.height || '—'],
      ],
    }),
    osmPointLayer({
      id: 'dams',
      name: 'Dams',
      icon: 'waves',
      color: '#38bdf8',
      prefix: 'dam',
      radiusKm: 600,
      description: 'Dams and weirs mapped in OpenStreetMap.',
      selectors: ['["waterway"="dam"]', '["waterway"="weir"]'],
      extraFields: (record) => [
        ['Waterway', record.tags?.waterway || '—'],
        ['Operator', record.tags?.operator || '—'],
        ['Height', record.tags?.height || '—'],
      ],
    }),
    osmPointLayer({
      id: 'power',
      name: 'Power infrastructure',
      icon: 'zap',
      color: '#f0b429',
      prefix: 'pwr',
      radiusKm: 400,
      description: 'Substations and power plants mapped in OpenStreetMap.',
      selectors: ['["power"="substation"]', '["power"="plant"]', '["power"="generator"]'],
      limit: 1000,
      extraFields: (record) => [
        ['Power type', record.tags?.power || '—'],
        ['Substation', record.tags?.substation || '—'],
        ['Voltage', record.tags?.voltage || '—'],
        ['Operator', record.tags?.operator || '—'],
        ['Output', record.tags?.['generator:output:electricity'] || '—'],
      ],
    }),
    osmPointLayer({
      id: 'military-areas',
      name: 'Military areas',
      icon: 'shield',
      color: '#f0645a',
      prefix: 'mil',
      radiusKm: 600,
      description: 'Areas mapped in OpenStreetMap as military land use. Mapping does not establish current activity.',
      selectors: ['["military"="barracks"]', '["military"="airfield"]', '["military"="naval_base"]', '["military"="range"]', '["military"="danger_area"]'],
      extraFields: (record) => [
        ['Military type', record.tags?.military || '—'],
        ['Operator', record.tags?.operator || '—'],
        ['Land use', record.tags?.landuse || '—'],
      ],
    }),
    createAirportLayer(),
  ];
}
