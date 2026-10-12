/**
 * Weather layers.
 *
 *  - Radar and satellite clouds: RainViewer publishes keyless, cross-origin
 *    tile frames, so these render as ordinary Cesium imagery layers.
 *  - Wind: Open-Meteo model output sampled on a coarse grid over the current
 *    view. It is model data on a grid, not station observations, and the layer
 *    description says so.
 */

import * as Cesium from 'cesium';
import { createLayer } from './base.js';
import { createPointLayer } from './pointLayer.js';
import {
  RADAR_SCHEMES,
  fetchWeatherMaps,
  frameAt,
  tileTemplate,
} from '../sources/rainviewer.js';
import { fetchForecastGrid } from '../sources/openMeteo.js';
import { compassPoint, boundingBox } from '../geo/coords.js';
import { formatUtcDateTime, formatAge } from '../net/status.js';

/** Build a grid of sample points across the current view. */
export function buildGrid(box, { cols = 14, rows = 8 } = {}) {
  const west = Math.min(box.west, box.east);
  const east = Math.max(box.west, box.east);
  const points = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      points.push({
        lat: box.south + ((box.north - box.south) * (rowIndex + 0.5)) / rows,
        lon: west + ((east - west) * (colIndex + 0.5)) / cols,
      });
    }
  }
  return points;
}

export function windColor(ms) {
  if (ms >= 25) return '#f43f5e';
  if (ms >= 17) return '#fb923c';
  if (ms >= 11) return '#facc15';
  if (ms >= 6) return '#a3e635';
  if (ms >= 2) return '#38bdf8';
  return '#64748b';
}

/**
 * A tile-overlay layer: fetches a frame list, then hands Cesium a URL
 * template. The layer stays honest about which frame is on screen.
 */
function createTileOverlayLayer({
  id,
  name,
  description,
  kind,
  opacity = 0.75,
  defaultScheme = 2,
}) {
  let imageryLayer = null;
  let surface = null;
  let currentTemplate = null;

  const layer = createLayer({
    id,
    name,
    category: 'weather',
    icon: kind === 'radar' ? 'cloudRain' : 'cloud',
    description,
    sources: 'rainviewer',
    refreshMs: 10 * 60 * 1000,
    params: { opacity, scheme: defaultScheme },
    configure({ panel }) {
      panel.slider({ id: 'opacity', label: 'Overlay opacity', min: 0.1, max: 1, step: 0.05 });
      if (kind === 'radar') {
        panel.select({
          id: 'scheme',
          label: 'Colour scheme',
          options: RADAR_SCHEMES.map((scheme) => ({ value: scheme.id, label: scheme.label })),
        });
      }
    },
    onAttach(context) {
      surface = context;
    },
    async fetch({ signal }) {
      const maps = await fetchWeatherMaps({ signal });
      const frames = kind === 'radar' ? maps.radar.past : maps.satellite.past;
      if (!frames.length) {
        return { records: [], message: 'The provider published no frames for this product' };
      }
      const frame = frameAt(frames);
      const template = tileTemplate({ host: maps.host, path: frame.path }, {
        scheme: Number(layer.params.scheme ?? defaultScheme),
      });
      if (!template) {
        return { records: [], message: 'Could not build a tile URL from the provider response' };
      }
      applyTemplate(template);
      currentTemplate = template;
      return {
        records: [{ id: `${id}:${frame.time}`, time: frame.time }],
        message: `Frame ${formatUtcDateTime(frame.time)} (${formatAge(Date.now() - frame.time)})`,
      };
    },
    onDispose() {
      removeLayer();
    },
  });

  function applyTemplate(template) {
    if (!surface?.viewer) return;
    removeLayer();
    imageryLayer = surface.viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: template,
        maximumLevel: 12,
        minimumLevel: 1,
        credit: new Cesium.Credit('© RainViewer', false),
      }),
    );
    imageryLayer.alpha = Number(layer.params.opacity ?? opacity);
    // Keep overlays beneath the base imagery stack's ordering by pushing them
    // to the top, which is what an operator expects from a weather overlay.
    surface.viewer.imageryLayers.raiseToTop(imageryLayer);
  }

  function removeLayer() {
    if (imageryLayer && surface?.viewer) {
      try {
        surface.viewer.imageryLayers.remove(imageryLayer, true);
      } catch {
        /* already removed */
      }
    }
    imageryLayer = null;
  }

  // Wrap hide/show so removing the layer from the rail also removes the tiles.
  const originalHide = layer.hide;
  const originalShow = layer.show;
  layer.hide = () => {
    removeLayer();
    originalHide.call(layer);
  };
  layer.show = () => {
    originalShow.call(layer);
    if (currentTemplate) applyTemplate(currentTemplate);
  };

  // Opacity and colour scheme apply immediately without a refetch.
  layer.subscribe((snapshot) => {
    if (imageryLayer) imageryLayer.alpha = Number(snapshot.params.opacity ?? opacity);
    if (snapshot.params.scheme !== undefined && currentTemplate && snapshot.visible) {
      const template = currentTemplate.replace(/\/(\d)\/\d_\d\.png$/, `/${snapshot.params.scheme}/1_1.png`);
      if (template !== currentTemplate) {
        applyTemplate(template);
        currentTemplate = template;
      }
    }
  });

  return layer;
}

function createWindLayer() {
  return createPointLayer({
    id: 'wind',
    name: 'Wind field',
    category: 'weather',
    icon: 'wind',
    description:
      'Open-Meteo model wind on a coarse grid over the current view. Model output, not station observations.',
    sources: 'open-meteo',
    refreshMs: 15 * 60 * 1000,
    viewportAware: true,
    billboard: 'arrow',
    maxPoints: 200,
    maxLabels: 0,
    params: { density: 14, minMs: 0 },
    configure({ panel }) {
      panel.slider({ id: 'density', label: 'Grid density', min: 6, max: 22, step: 1 });
      panel.slider({ id: 'minMs', label: 'Hide below (m/s)', min: 0, max: 15, step: 0.5 });
    },
    positionOf: (record) => ({ lat: record.lat, lon: record.lon, height: 0 }),
    styleOf: (record) => ({
      pixelSize: 8,
      color: windColor(record.windMs ?? 0),
      rotation: record.windDirDeg ?? 0,
      scale: 0.55 + Math.min(0.6, (record.windMs ?? 0) / 40),
      priority: record.windMs ?? 0,
    }),
    detail: (record) => ({
      title: `Wind ${Math.round(record.windMs ?? 0)} m/s`,
      subtitle: `${compassPoint(record.windDirDeg)} · model grid point`,
      fields: [
        ['Wind speed', record.windMs === null ? '—' : `${(record.windMs).toFixed(1)} m/s (${Math.round(record.windMs * 3.6)} km/h)`],
        ['Direction', record.windDirDeg === null ? '—' : `${Math.round(record.windDirDeg)}° ${compassPoint(record.windDirDeg)}`],
        ['Gusts', record.windGustMs === null ? '—' : `${record.windGustMs.toFixed(1)} m/s`],
        ['Temperature', record.temperatureC === null ? '—' : `${record.temperatureC.toFixed(1)} °C`],
        ['Feels like', record.apparentC === null ? '—' : `${record.apparentC.toFixed(1)} °C`],
        ['Humidity', record.humidityPct === null ? '—' : `${Math.round(record.humidityPct)} %`],
        ['Cloud cover', record.cloudCoverPct === null ? '—' : `${Math.round(record.cloudCoverPct)} %`],
        ['Precipitation', record.precipitationMm === null ? '—' : `${record.precipitationMm.toFixed(1)} mm`],
        ['Pressure', record.pressureHpa === null ? '—' : `${record.pressureHpa.toFixed(0)} hPa`],
        ['Model time', record.time || '—'],
      ],
      note: 'Interpolated model data on a grid. Local conditions can differ substantially.',
    }),
    async fetch({ ctx, box, params, signal }) {
      const view = box || ctx.camera.viewportBox(1200) || boundingBox(0, 0, 1200);
      const density = Math.max(4, Math.min(24, Number(params.density ?? 14)));
      const points = buildGrid(view, { cols: density, rows: Math.max(4, Math.round(density / 2)) });
      const observations = await fetchForecastGrid(points, { signal });
      const minimum = Number(params.minMs ?? 0);
      const records = observations
        .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon))
        .filter((entry) => (entry.windMs ?? 0) >= minimum)
        .map((entry, index) => ({
          ...entry,
          id: `wind:${index}:${entry.lat.toFixed(2)},${entry.lon.toFixed(2)}`,
        }));
      return {
        records,
        message: `${records.length} grid points · Open-Meteo model`,
      };
    },
  });
}

export function createWeatherLayers() {
  return [
    createTileOverlayLayer({
      id: 'weather-radar',
      name: 'Precipitation radar',
      description: 'RainViewer radar composite from national weather services. Keyless, refreshed every few minutes.',
      kind: 'radar',
    }),
    createTileOverlayLayer({
      id: 'weather-satellite',
      name: 'Satellite clouds',
      description: 'RainViewer infrared satellite composite. Availability varies by region and time.',
      kind: 'satellite',
      opacity: 0.6,
      defaultScheme: 0,
    }),
    createWindLayer(),
  ];
}
