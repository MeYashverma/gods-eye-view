/**
 * Camera layers.
 *
 * What these layers do, and what they deliberately do not:
 *  - Camera *locations* come from OpenStreetMap's `man_made=surveillance`
 *    tagging, contributed by volunteers. A mapped camera is a statement that
 *    someone recorded a camera there; it is not proof the camera is live.
 *  - Imagery is only ever loaded from a URL the OSM contributor published in
 *    the camera's own `contact:website` / `website` tag, rendered into an
 *    `<img>` element. Nothing is scraped, no authentication is bypassed, and a
 *    feed that refuses to load simply shows as unavailable.
 *  - The ALPR layer shows mapped camera locations and their public tags only.
 *    There is no plate recognition, no plate storage, no face recognition and
 *    no person search anywhere in this project, and none is planned.
 */

import { createPointLayer, viewportQueryBox } from './pointLayer.js';
import { fetchFeatures } from '../sources/overpass.js';
import { safeUrl } from '../core/dom.js';
import { formatLatLon } from '../geo/coords.js';

const CAMERA_SELECTORS = Object.freeze([
  '["man_made"="surveillance"]["contact:website"]',
  '["man_made"="surveillance"]["website"]',
  '["man_made"="surveillance"]["surveillance:type"="webcam"]',
  '["man_made"="surveillance"]["webcam"]',
]);

const ALPR_SELECTORS = Object.freeze([
  '["man_made"="surveillance"]["surveillance:type"="ALPR"]',
  '["man_made"="surveillance"]["surveillance:type"="ANPR"]',
  '["man_made"="surveillance"]["surveillance:type"="alpr"]',
  '["camera:type"="ALPR"]',
  '["surveillance"="ALPR"]',
]);

/** Pull the first usable public image URL out of an OSM tag set. */
export function cameraImageUrl(tags) {
  const candidates = [
    tags?.['contact:website'],
    tags?.website,
    tags?.['webcam'],
    tags?.['contact:webcam'],
    tags?.image,
  ];
  for (const candidate of candidates) {
    const url = safeUrl(candidate);
    if (url && /\.(jpe?g|png|webp)(\?|$)/i.test(url)) return url;
  }
  // A page URL is still useful as a link (cameraPageUrl), but it is not an
  // image and is never passed to an <img> element.
  return null;
}

export function cameraPageUrl(tags) {
  for (const key of ['contact:website', 'website', 'webcam']) {
    const url = safeUrl(tags?.[key]);
    if (url) return url;
  }
  return null;
}

function osmLink(record) {
  return `https://www.openstreetmap.org/${record.osmType}/${record.osmId}`;
}

function createCameraLayer() {
  return createPointLayer({
    id: 'cameras',
    name: 'Public traffic cameras',
    category: 'cameras',
    icon: 'camera',
    description:
      'Camera locations mapped by OpenStreetMap contributors, with imagery loaded only from the URL each contributor published.',
    sources: 'overpass',
    refreshMs: 30 * 60 * 1000,
    viewportAware: true,
    billboard: 'camera',
    maxPoints: 1200,
    maxLabels: 10,
    params: { radiusKm: 120, onlyWithImage: false },
    configure({ panel }) {
      panel.slider({ id: 'radiusKm', label: 'Search radius (km)', min: 20, max: 600, step: 10 });
      panel.toggle({ id: 'onlyWithImage', label: 'Only cameras with a published image' });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 7,
      color: record.imageUrl ? '#22d3ee' : '#64748b',
      rotation: record.directionDeg ?? 0,
      scale: 0.6,
      label: record.imageUrl ? (record.name || 'Camera') : null,
      priority: record.imageUrl ? 10 : 0,
    }),
    detail: (record) => ({
      title: record.name || 'Mapped camera',
      subtitle: 'OpenStreetMap-mapped camera location',
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Type', record.tags?.['surveillance:type'] || record.tags?.surveillance || '—'],
        ['Zone', record.tags?.['surveillance:zone'] || '—'],
        ['Direction', record.directionDeg === null ? '—' : `${record.directionDeg}°`],
        ['Operator', record.tags?.operator || '—'],
        ['Imagery', record.imageUrl ? 'Published by the contributor' : 'No public image URL tagged'],
      ],
      links: [
        { label: 'OpenStreetMap object', href: osmLink(record) },
        ...(record.pageUrl ? [{ label: 'Camera source page', href: record.pageUrl }] : []),
      ],
      image: record.imageUrl,
      note: 'Mapped locations are contributed by volunteers and may be out of date. Imagery © the respective operator.',
    }),
    async fetch({ ctx, box, params, signal }) {
      const queryBox = box || viewportQueryBox(ctx, { radiusKm: params.radiusKm });
      const result = await fetchFeatures(CAMERA_SELECTORS, queryBox, {
        signal,
        prefix: 'cam',
        limit: 800,
        preferIndex: ctx?.overpassIndex ?? 0,
      });
      if (result.index >= 0) ctx.overpassIndex = result.index;
      const records = result.records
        .map((record) => ({
          ...record,
          imageUrl: cameraImageUrl(record.tags),
          pageUrl: cameraPageUrl(record.tags),
          directionDeg: parseDirection(record.tags?.direction ?? record.tags?.['camera:direction']),
        }))
        .filter((record) => (params.onlyWithImage ? Boolean(record.imageUrl) : true));
      return {
        records,
        message: `${records.length} mapped cameras near the current view`,
      };
    },
  });
}

/** OSM directions can be degrees or a cardinal word. */
export function parseDirection(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return ((numeric % 360) + 360) % 360;
  const cardinals = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
  const key = String(value).trim().toLowerCase();
  return cardinals[key] ?? null;
}

function createAlprLayer() {
  return createPointLayer({
    id: 'alpr',
    name: 'Mapped ALPR cameras',
    category: 'cameras',
    icon: 'scan',
    description:
      'Locations OpenStreetMap contributors tagged as automatic number-plate-recognition cameras. Locations and public tags only — no plate reading, storage or person search.',
    sources: 'overpass',
    refreshMs: 60 * 60 * 1000,
    viewportAware: true,
    maxPoints: 1200,
    maxLabels: 10,
    params: { radiusKm: 60 },
    configure({ panel }) {
      panel.slider({ id: 'radiusKm', label: 'Search radius (km)', min: 10, max: 300, step: 5 });
      panel.notice({
        tone: 'info',
        title: 'Scope of this layer',
        body: 'This layer displays mapped camera locations and the public tags attached to them. It performs no plate recognition, stores no plates, and offers no person or vehicle search.',
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: () => ({ pixelSize: 6, color: '#fbbf24', priority: 5 }),
    detail: (record) => ({
      title: record.name || 'Mapped ALPR camera',
      subtitle: 'OpenStreetMap tagging',
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Surveillance type', record.tags?.['surveillance:type'] || '—'],
        ['Zone', record.tags?.['surveillance:zone'] || '—'],
        ['Operator', record.tags?.operator || 'Unknown'],
        ['Direction', record.directionDeg === null ? '—' : `${record.directionDeg}°`],
      ],
      links: [{ label: 'OpenStreetMap object', href: osmLink(record) }],
      note: 'Tagging reflects what contributors recorded. It is not an authoritative register.',
    }),
    async fetch({ ctx, box, params, signal }) {
      const queryBox = box || viewportQueryBox(ctx, { radiusKm: params.radiusKm });
      const result = await fetchFeatures(ALPR_SELECTORS, queryBox, {
        signal,
        prefix: 'alpr',
        limit: 600,
        preferIndex: ctx?.overpassIndex ?? 0,
      });
      if (result.index >= 0) ctx.overpassIndex = result.index;
      const records = result.records.map((record) => ({
        ...record,
        directionDeg: parseDirection(record.tags?.direction ?? record.tags?.['camera:direction']),
      }));
      return { records, message: `${records.length} mapped ALPR locations in view` };
    },
  });
}

function createStreetLevelLayer() {
  return createPointLayer({
    id: 'street-level',
    name: 'Street level imagery',
    category: 'cameras',
    icon: 'film',
    description:
      'Mapillary street-level imagery near the current view. Requires a free Mapillary client access token.',
    sources: 'mapillary',
    refreshMs: 0,
    viewportAware: true,
    maxPoints: 400,
    maxLabels: 0,
    params: { radiusKm: 2 },
    requires: [{ kind: 'setting', id: 'mapillaryToken', label: 'Mapillary client token' }],
    configure({ panel }) {
      panel.setting({
        id: 'mapillaryToken',
        label: 'Mapillary client token',
        placeholder: 'From mapillary.com/dashboard/developers',
        help: 'A client-side access token, as Mapillary documents it. Imagery © Mapillary contributors, CC BY-SA 4.0.',
      });
      panel.slider({ id: 'radiusKm', label: 'Radius (km)', min: 0.5, max: 20, step: 0.5 });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 5,
      color: '#4ade80',
      rotation: record.compassAngle ?? 0,
      scale: 0.5,
      priority: record.capturedAt ?? 0,
    }),
    detail: (record) => ({
      title: record.creatorName || 'Mapillary image',
      subtitle: record.capturedAt ? new Date(record.capturedAt).toISOString().slice(0, 10) : 'CC BY-SA 4.0',
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Compass', record.compassAngle === null ? '—' : `${Math.round(record.compassAngle)}°`],
        ['Captured', record.capturedAt ? new Date(record.capturedAt).toISOString().slice(0, 10) : '—'],
        ['Creator', record.creatorName || '—'],
        ['License', 'CC BY-SA 4.0'],
      ],
      image: record.thumbnail,
      links: record.id ? [{ label: 'Open on Mapillary', href: `https://www.mapillary.com/app/?pKey=${record.imageId}` }] : [],
    }),
    async fetch({ ctx, box, params, signal }) {
      const token = ctx.settings.get('mapillaryToken');
      if (!token) {
        const error = new Error('A Mapillary client token is required');
        error.kind = 'config';
        throw error;
      }
      const queryBox = box || viewportQueryBox(ctx, { radiusKm: params.radiusKm });
      const west = Math.min(queryBox.west, queryBox.east);
      const east = Math.max(queryBox.west, queryBox.east);
      const url = new URL('https://graph.mapillary.com/images');
      url.searchParams.set('access_token', token);
      url.searchParams.set('fields', 'id,geometry,thumb_1024_url,compass_angle,captured_at,creator');
      url.searchParams.set('bbox', `${west.toFixed(4)},${queryBox.south.toFixed(4)},${east.toFixed(4)},${queryBox.north.toFixed(4)}`);
      url.searchParams.set('limit', '400');
      const { data } = await ctx.http.json(url.toString(), { signal, timeoutMs: 20_000, retries: 1 });
      const records = (data?.data || [])
        .map((entry) => ({
          id: `mapillary:${entry.id}`,
          imageId: entry.id,
          lat: entry.geometry?.coordinates?.[1],
          lon: entry.geometry?.coordinates?.[0],
          thumbnail: entry.thumb_1024_url || null,
          compassAngle: entry.compass_angle ?? null,
          capturedAt: entry.captured_at ? new Date(entry.captured_at).getTime() : null,
          creatorName: entry.creator?.username || null,
        }))
        .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon));
      return { records, message: `${records.length} images · © Mapillary, CC BY-SA 4.0` };
    },
  });
}

export function createCameraLayers() {
  return [createCameraLayer(), createAlprLayer(), createStreetLevelLayer()];
}
