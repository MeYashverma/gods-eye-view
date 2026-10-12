/**
 * Utility layers — radio, bikeshare, routing, and mapped transit stops.
 *
 * Transit is the honest one to talk about: live vehicle positions need a
 * GTFS-Realtime protobuf decoder plus an agency feed, so this project shows
 * mapped stops and says plainly that live vehicles are not implemented, rather
 * than drawing something that looks like movement.
 */

import * as Cesium from 'cesium';
import { createPointLayer, viewportQueryBox } from './pointLayer.js';
import { createLayer } from './base.js';
import { fetchStations, filterByBox, playbackOutlook } from '../sources/radioBrowser.js';
import {
  fetchCatalog,
  fetchSystemStations,
  matchSystemsByPlace,
  stationColor,
} from '../sources/gbfs.js';
import { reversePlace } from '../sources/geocode.js';
import { fetchRoute, straightLinePath, TRAVEL_MODES } from '../sources/osrm.js';
import { fetchFeatures } from '../sources/overpass.js';
import { formatLatLon, distanceM, formatDistance } from '../geo/coords.js';

/* -------------------------------- radio --------------------------------- */

export function createRadioLayer() {
  let audio = null;
  let nowPlaying = null;
  let surface = null;

  const stopAudio = () => {
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
    nowPlaying = null;
    surface?.events.emit('radio:nowplaying', null);
  };

  const layer = createPointLayer({
    id: 'radio',
    name: 'Radio stations',
    category: 'utilities',
    icon: 'radio',
    description:
      'Geolocated internet radio streams from the Radio Browser community database. Stream availability is decided by each broadcaster.',
    sources: 'radio-browser',
    refreshMs: 60 * 60 * 1000,
    viewportAware: true,
    maxPoints: 2000,
    maxLabels: 12,
    params: { radiusKm: 600, onlyWorking: true, minClicks: 0 },
    configure({ panel }) {
      panel.slider({ id: 'radiusKm', label: 'Search radius (km)', min: 50, max: 3000, step: 50 });
      panel.slider({ id: 'minClicks', label: 'Minimum popularity', min: 0, max: 5000, step: 100 });
      panel.toggle({ id: 'onlyWorking', label: 'Hide streams that failed the last health check' });
      panel.notice({
        tone: 'info',
        title: 'Playback',
        body: 'Some broadcasters refuse cross-origin playback or serve codecs this browser cannot decode. Failures are reported per station.',
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: record.lastCheckOk ? 6 : 4,
      color: record.lastCheckOk ? '#22d3ee' : '#64748b',
      label: record.clicks > 20000 ? record.name : null,
      priority: record.clicks / 1000,
    }),
    detail: (record) => ({
      title: record.name,
      subtitle: [record.state, record.country].filter(Boolean).join(', ') || 'Internet radio',
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Country', record.country || '—'],
        ['Language', record.language || '—'],
        ['Codec', record.codec || '—'],
        ['Bitrate', record.bitrateKbps ? `${record.bitrateKbps} kbps` : '—'],
        ['Popularity', `${record.clicks.toLocaleString()} clicks · ${record.votes.toLocaleString()} votes`],
        ['Health check', record.lastCheckOk ? 'Passed' : 'Failed'],
        ['Tags', record.tags.join(', ') || '—'],
      ],
      links: [
        ...(record.homepage ? [{ label: 'Station homepage', href: record.homepage }] : []),
        ...(record.url ? [{ label: 'Stream URL', href: record.url }] : []),
      ],
      actions: [{ id: 'radio:play', label: 'Play station' }],
      note: playbackOutlook(record).reason || null,
    }),
    async fetch({ ctx, box, params, signal }) {
      const result = await fetchStations({ signal });
      const view = box || ctx.camera.viewportBox(params.radiusKm);
      let records = view ? filterByBox(result.records, view) : result.records;
      if (params.onlyWorking) records = records.filter((record) => record.lastCheckOk);
      const minClicks = Number(params.minClicks ?? 0);
      if (minClicks > 0) records = records.filter((record) => record.clicks >= minClicks);
      return {
        records: records.sort((a, b) => b.clicks - a.clicks),
        message: `${records.length} of ${result.records.length} stations in view`,
      };
    },
    onAttach(context) {
      surface = context;
    },
    onDispose() {
      stopAudio();
    },
  });

  /** Attempt playback and report the outcome — success or a real reason. */
  layer.play = (record) => {
    if (!record?.url) {
      surface?.events.emit('radio:error', 'That station publishes no stream URL.');
      return false;
    }
    stopAudio();
    audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.preload = 'none';

    const failureTimer = setTimeout(() => {
      if (audio && audio.paused) {
        surface?.events.emit('radio:error', `${record.name} did not start — the stream may be offline or may refuse cross-origin playback.`);
        stopAudio();
      }
    }, 12_000);

    audio.addEventListener('playing', () => {
      clearTimeout(failureTimer);
      surface?.events.emit('radio:playing', record);
    });
    audio.addEventListener('error', () => {
      clearTimeout(failureTimer);
      surface?.events.emit('radio:error', `${record.name} could not be played. The stream is offline, blocked, or uses an unsupported codec.`);
      stopAudio();
    });
    audio.addEventListener('ended', () => {
      clearTimeout(failureTimer);
      stopAudio();
    });

    audio.src = record.url;
    const started = audio.play();
    if (started?.catch) {
      started.catch((error) => {
        clearTimeout(failureTimer);
        const blocked = error?.name === 'NotAllowedError';
        surface?.events.emit(
          'radio:error',
          blocked
            ? 'This browser blocked autoplay. Press play again from the station panel.'
            : `Playback failed: ${error?.message || error}`,
        );
        stopAudio();
      });
    }
    nowPlaying = record;
    surface?.events.emit('radio:nowplaying', record);
    return true;
  };

  layer.stop = stopAudio;
  Object.defineProperty(layer, 'nowPlaying', { get: () => nowPlaying });

  return layer;
}

/* ------------------------------- bikeshare ------------------------------ */

function createBikeshareLayer() {
  let catalog = null;
  let systemErrors = [];

  return createPointLayer({
    id: 'bikeshare',
    name: 'Bikeshare stations',
    category: 'utilities',
    icon: 'bike',
    description:
      'GBFS bikeshare systems near the current view, with live bike and dock counts. Each operator decides its own cross-origin policy.',
    sources: 'gbfs',
    refreshMs: 5 * 60 * 1000,
    viewportAware: true,
    maxPoints: 1500,
    maxLabels: 12,
    params: { maxSystems: 3 },
    configure({ panel }) {
      panel.slider({ id: 'maxSystems', label: 'Systems to query', min: 1, max: 6, step: 1 });
      panel.notice({
        tone: 'info',
        title: 'How systems are found',
        body: 'The GBFS catalog lists systems by city name, not by coordinate. The camera position is reverse-geocoded to a place name and matched against it, so an unmatched location honestly reports "no system found" instead of guessing.',
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 6,
      color: stationColor(record),
      label: (record.availableBikes ?? 0) >= 0 ? `${record.availableBikes}` : null,
      priority: record.availableBikes ?? 0,
    }),
    detail: (record) => ({
      title: record.name,
      subtitle: record.systemName || 'Bikeshare station',
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Bikes available', record.availableBikes === null ? '—' : String(record.availableBikes)],
        ['Docks available', record.availableDocks === null ? '—' : String(record.availableDocks)],
        ['E-bikes', record.eBikes === null ? '—' : String(record.eBikes)],
        ['Capacity', record.capacity === null ? '—' : String(record.capacity)],
        ['Renting', record.renting === null ? 'Unknown' : record.renting ? 'Yes' : 'No'],
        ['Returning', record.returning === null ? 'Unknown' : record.returning ? 'Yes' : 'No'],
        ['System', record.systemName || '—'],
      ],
      note: systemErrors.length ? `Some systems were unreachable: ${systemErrors.join('; ')}` : null,
    }),
    async fetch({ ctx, params, signal }) {
      const focus = ctx.camera.focus();
      if (!focus) return { records: [], message: 'Move the camera to a city to find systems' };
      catalog = catalog || (await fetchCatalog({ signal }));

      // The catalog is keyed by place name, so the camera has to be resolved to
      // one. A failed reverse lookup is reported, never papered over.
      const place = await reversePlace(focus.lat, focus.lon, { signal });
      const placeText = place ? [place.name, place.country].filter(Boolean).join(' ') : '';
      const systems = placeText
        ? matchSystemsByPlace(catalog, placeText, { limit: Number(params.maxSystems ?? 3) })
        : [];
      if (!placeText) return { records: [], message: 'Could not resolve a place name for this position' };
      if (!systems.length) {
        return { records: [], message: `No GBFS system listed for "${placeText}"` };
      }
      const results = await Promise.all(systems.map((system) => fetchSystemStations(system, { signal })));
      systemErrors = results.filter((entry) => entry.error).map((entry) => entry.error);
      const records = results.flatMap((entry) => entry.records);
      const ok = results.filter((entry) => !entry.error).length;
      return {
        records,
        message: `${records.length} stations from ${ok}/${systems.length} systems`,
      };
    },
  });
}

/* ------------------------------- directions ----------------------------- */

function createDirectionsLayer() {
  let routeEntity = null;
  let stepEntities = [];
  let lastRoute = null;
  let surface = null;

  const clear = () => {
    if (!surface?.viewer) return;
    if (routeEntity) surface.viewer.entities.remove(routeEntity);
    for (const entity of stepEntities) surface.viewer.entities.remove(entity);
    routeEntity = null;
    stepEntities = [];
  };

  const layer = createLayer({
    id: 'directions',
    name: 'Routing',
    category: 'utilities',
    icon: 'route',
    description:
      'Driving, cycling and walking routes from OSRM over OpenStreetMap data. Falls back to a clearly-labelled straight line when routing is unavailable.',
    sources: 'osrm',
    refreshMs: 0,
    params: { mode: 'driving', waypoints: [] },
    supported: false, // driven by the panel, not by the refresh scheduler
    unavailableMessage: 'Pick waypoints in the Routing panel to compute a route.',
    configure({ panel }) {
      panel.select({
        id: 'mode',
        label: 'Travel mode',
        options: TRAVEL_MODES.map((mode) => ({ value: mode.id, label: mode.label })),
      });
      panel.custom('routing');
      panel.notice({
        tone: 'warn',
        title: 'Router etiquette',
        body: 'The default OSRM endpoint is a shared demo server that asks for light interactive use. Point Settings at your own instance for heavier use.',
      });
    },
    onAttach(context) {
      surface = context;
    },
    onDispose() {
      clear();
    },
    fetch: async () => ({ records: [], message: 'Routing is driven from the panel' }),
  });

  layer.addWaypoint = (point) => {
    const waypoints = [...layer.params.waypoints, { lat: point.lat, lon: point.lon }].slice(0, 12);
    layer.setParams({ waypoints });
    return waypoints;
  };

  layer.clearWaypoints = () => {
    layer.setParams({ waypoints: [] });
    clear();
    lastRoute = null;
    surface?.events.emit('directions:route', null);
  };

  layer.compute = async () => {
    const { waypoints, mode } = layer.params;
    if (waypoints.length < 2) {
      surface?.events.emit('directions:error', 'Add at least two waypoints.');
      return null;
    }
    const baseUrl = surface.settings.get('osrmUrl') || 'https://router.project-osrm.org';
    let route = null;
    let estimated = false;
    let error = null;
    try {
      const result = await fetchRoute({ baseUrl, mode, waypoints, signal: undefined });
      route = result.route;
    } catch (failure) {
      error = failure?.message || String(failure);
      route = {
        distanceM: distanceM(waypoints[0].lat, waypoints[0].lon, waypoints.at(-1).lat, waypoints.at(-1).lon),
        durationS: null,
        path: straightLinePath(waypoints[0], waypoints.at(-1)),
        legs: [],
      };
      estimated = true;
    }
    lastRoute = { route, estimated, error, mode };
    draw(route, estimated);
    surface?.events.emit('directions:route', lastRoute);
    return lastRoute;
  };

  function draw(route, estimated) {
    clear();
    if (!surface?.viewer || !route?.path?.length) return;
    const positions = route.path.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 40));
    routeEntity = surface.viewer.entities.add({
      polyline: {
        positions,
        width: estimated ? 2 : 3.5,
        material: estimated
          ? Cesium.Color.fromCssColorString('#f0b429').withAlpha(0.7)
          : new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#38bdf8'),
              dashLength: 14,
            }),
        clampToGround: !estimated,
      },
    });
    if (route.legs?.length) {
      for (const leg of route.legs) {
        for (const step of leg.steps || []) {
          if (!step.at) continue;
          stepEntities.push(
            surface.viewer.entities.add({
              position: Cesium.Cartesian3.fromDegrees(step.at.lon, step.at.lat, 10),
              point: { pixelSize: 6, color: Cesium.Color.fromCssColorString('#38bdf8'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
              label: {
                text: step.instruction || '',
                font: '500 10px "JetBrains Mono", monospace',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -12),
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString('rgba(8,12,16,0.8)'),
                scale: 0.9,
              },
            }),
          );
        }
      }
    }
    surface.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        Math.min(...route.path.map((p) => p.lon)) - 0.02,
        Math.min(...route.path.map((p) => p.lat)) - 0.02,
        Math.max(...route.path.map((p) => p.lon)) + 0.02,
        Math.max(...route.path.map((p) => p.lat)) + 0.02,
      ),
      duration: 1.4,
    });
  }

  layer.setVisible = (value) => {
    if (!value) clear();
  };
  Object.defineProperty(layer, 'lastRoute', { get: () => lastRoute });

  return layer;
}

/* --------------------------- mapped transit ----------------------------- */

function createTransitLayer() {
  return createPointLayer({
    id: 'transit',
    name: 'Transit stops (mapped)',
    category: 'utilities',
    icon: 'train',
    description:
      'Bus, tram and rail stops mapped in OpenStreetMap. Live vehicle positions are NOT implemented — they need a GTFS-Realtime feed and a protobuf decoder.',
    sources: 'overpass',
    refreshMs: 60 * 60 * 1000,
    viewportAware: true,
    maxPoints: 1500,
    maxLabels: 10,
    params: { radiusKm: 40, namedOnly: false },
    configure({ panel }) {
      panel.slider({ id: 'radiusKm', label: 'Search radius (km)', min: 5, max: 200, step: 5 });
      panel.notice({
        tone: 'warn',
        title: 'Not live',
        body: 'This layer shows mapped stop infrastructure only. Live vehicle positions require an agency GTFS-Realtime feed and a protobuf decoder, which this static build does not include.',
      });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 5,
      color: record.tags?.railway ? '#a78bfa' : '#38bdf8',
      label: record.name || null,
      priority: record.tags?.railway ? 10 : 1,
    }),
    detail: (record) => ({
      title: record.name || 'Transit stop',
      subtitle: record.tags?.railway ? 'Rail stop' : record.tags?.highway === 'bus_stop' ? 'Bus stop' : 'Tram stop',
      fields: [
        ['Position', formatLatLon(record.lat, record.lon)],
        ['Type', record.tags?.railway || record.tags?.public_transport || record.tags?.highway || '—'],
        ['Network', record.tags?.network || '—'],
        ['Operator', record.tags?.operator || '—'],
        ['Ref', record.tags?.ref || '—'],
        ['Shelter', record.tags?.shelter || '—'],
      ],
      links: [{ label: 'OpenStreetMap object', href: `https://www.openstreetmap.org/${record.osmType}/${record.osmId}` }],
    }),
    async fetch({ ctx, box, params, signal }) {
      const queryBox = box || viewportQueryBox(ctx, { radiusKm: params.radiusKm });
      const result = await fetchFeatures(
        ['["highway"="bus_stop"]', '["railway"="tram_stop"]', '["railway"="station"]', '["railway"="halt"]'],
        queryBox,
        { signal, prefix: 'trn', limit: 900, preferIndex: ctx?.overpassIndex ?? 0 },
      );
      if (result.index >= 0) ctx.overpassIndex = result.index;
      return { records: result.records, message: `${result.records.length} mapped stops — infrastructure only` };
    },
  });
}

export function createUtilityLayers() {
  return [createRadioLayer(), createBikeshareLayer(), createDirectionsLayer(), createTransitLayer()];
}

export { formatDistance, distanceM };
