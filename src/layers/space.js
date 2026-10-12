/**
 * Satellite layer.
 *
 * Element sets come from CelesTrak; positions are propagated in the browser
 * with satellite.js (SGP4). That is the same technique every amateur tracking
 * site uses, and it is genuinely live — but it is a model, so the epoch of the
 * element set is shown next to every contact and the layer description says
 * plainly that these are not precision positions.
 */

import * as Cesium from 'cesium';
import { createLayer } from './base.js';
import {
  TLE_GROUPS,
  fetchTleGroup,
  orbitClass,
  orbitTrack,
  periodMinutes,
  propagate,
  toSatrec,
} from '../sources/celestrak.js';
import { formatUtcDateTime } from '../net/status.js';

function classColor(kind) {
  switch (kind) {
    case 'GEO':
      return '#a78bfa';
    case 'HEO/MEO':
      return '#38bdf8';
    case 'Sun-synchronous LEO':
      return '#4ade80';
    case 'LEO':
      return '#22d3ee';
    default:
      return '#94a3b8';
  }
}

export function createSatelliteLayer() {
  let satrecs = new Map();
  let epoch = null;
  let points = null;
  let labels = null;
  let trackEntity = null;
  let redrawTimer = null;
  let surface = null;
  let selectedId = null;
  /** Assigned immediately after createLayer returns. */
  let self = null;

  function params() {
    return self?.params || {};
  }

  function currentPosition(noradId) {
    const entry = satrecs.get(noradId);
    if (!entry) return null;
    return propagate(entry.satrec, new Date());
  }

  function clearTrack() {
    if (trackEntity && surface?.viewer) {
      surface.viewer.entities.remove(trackEntity);
      trackEntity = null;
    }
  }

  function drawTrack() {
    clearTrack();
    if (!selectedId || !surface?.viewer) return;
    const noradId = selectedId.replace(/^sat:/, '');
    const entry = satrecs.get(noradId);
    if (!entry) return;
    const now = new Date();
    const period = Math.max(20, Math.min(1440, entry.periodMin ?? 100));
    const track = orbitTrack(entry.satrec, now, { minutes: period, samples: 140 });
    if (track.length < 2) return;
    const positions = track.map((point) =>
      Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.heightKm * 1000),
    );
    trackEntity = surface.viewer.entities.add({
      polyline: {
        positions,
        width: 1.6,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.18,
          color: Cesium.Color.fromCssColorString(classColor(entry.class)),
        }),
      },
    });
  }

  function drawPositions() {
    if (!points) return 0;
    points.removeAll();
    labels.removeAll();
    const now = new Date();
    const limit = Math.min(satrecs.size, Number(params().limit ?? 400));
    const showNames = Boolean(params().showNames);
    let drawn = 0;
    let labelled = 0;

    for (const [noradId, entry] of satrecs) {
      if (drawn >= limit) break;
      const position = propagate(entry.satrec, now);
      if (!position) continue;
      const heightM = position.heightKm * 1000;
      const cartesian = Cesium.Cartesian3.fromDegrees(position.lon, position.lat, heightM);
      const isIss = noradId === '25544';
      drawn += 1;
      points.add({
        position: cartesian,
        pixelSize: isIss ? 9 : selectedId === `sat:${noradId}` ? 8 : 4,
        color: Cesium.Color.fromCssColorString(isIss ? '#ffffff' : classColor(entry.class)),
        outlineColor: Cesium.Color.fromCssColorString('rgba(4,8,12,0.8)'),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { layerId: 'satellites', recordId: `sat:${noradId}` },
      });

      if (showNames && labelled < 30) {
        labelled += 1;
        labels.add({
          position: cartesian,
          text: entry.name,
          font: '500 10px "JetBrains Mono", monospace',
          fillColor: Cesium.Color.fromCssColorString('rgba(214,228,240,0.9)'),
          outlineColor: Cesium.Color.fromCssColorString('rgba(3,6,10,0.9)'),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -9),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { layerId: 'satellites', recordId: `sat:${noradId}`, label: true },
        });
      }
    }
    if (selectedId && params().showOrbits) drawTrack();
    return drawn;
  }

  const layer = createLayer({
    id: 'satellites',
    name: 'Satellites & orbital objects',
    category: 'space',
    icon: 'orbit',
    description:
      'Positions propagated in the browser (SGP4) from CelesTrak two-line element sets. Modelled positions — not precision navigation.',
    sources: 'celestrak',
    refreshMs: 6 * 60 * 60 * 1000,
    params: { group: 'stations', limit: 400, showOrbits: false, showNames: false },

    configure({ panel }) {
      panel.select({
        id: 'group',
        label: 'Element-set group',
        options: TLE_GROUPS.map((group) => ({ value: group.id, label: group.label })),
      });
      panel.slider({ id: 'limit', label: 'Max objects', min: 50, max: 4000, step: 50 });
      panel.toggle({ id: 'showNames', label: 'Show object names' });
      panel.toggle({ id: 'showOrbits', label: 'Draw ground track for the selection' });
    },

    async fetch({ signal }) {
      const active = params();
      const result = await fetchTleGroup(active.group, { signal, limit: Number(active.limit) });
      satrecs = new Map();
      for (const entry of result.records) {
        const satrec = toSatrec(entry);
        if (!satrec) continue;
        satrecs.set(entry.noradId, {
          ...entry,
          satrec,
          class: orbitClass(satrec),
          periodMin: periodMinutes(satrec),
        });
      }
      epoch = result.records.reduce((latest, entry) => {
        if (!entry.epoch) return latest;
        return !latest || entry.epoch > latest ? entry.epoch : latest;
      }, null);
      const records = [...satrecs.values()].map((entry) => ({
        id: `sat:${entry.noradId}`,
        noradId: entry.noradId,
        name: entry.name,
        class: entry.class,
        periodMin: entry.periodMin,
        epoch: entry.epoch ? entry.epoch.getTime() : null,
        line1: entry.line1,
        line2: entry.line2,
      }));
      return {
        records,
        message: `${records.length} objects · ${active.group} · epoch ${
          epoch ? formatUtcDateTime(epoch) : 'unknown'
        }`,
      };
    },

    detail: (record) => {
      const position = currentPosition(record?.noradId);
      return {
        title: record.name,
        subtitle: `${record.class} · NORAD ${record.noradId}`,
        fields: [
          ['Orbit class', record.class],
          ['Period', record.periodMin ? `${record.periodMin.toFixed(1)} min` : '—'],
          ['Position', position ? `${position.lat.toFixed(3)}°, ${position.lon.toFixed(3)}°` : '—'],
          ['Altitude', position ? `${Math.round(position.heightKm).toLocaleString()} km` : '—'],
          ['Velocity', position?.speedKmS ? `${position.speedKmS.toFixed(2)} km/s` : '—'],
          ['Element epoch', record.epoch ? formatUtcDateTime(record.epoch) : '—'],
          ['Propagation', 'SGP4, in browser (satellite.js)'],
        ],
        code: [record.line1, record.line2].join('\n'),
        note: 'Positions are modelled from element sets that are typically hours to days old. SGP4 error grows as a set ages.',
      };
    },

    style: (record) => ({
      pixelSize: record.noradId === '25544' ? 9 : 4,
      color: record.noradId === '25544' ? '#ffffff' : classColor(record.class),
    }),

    createRenderer(context) {
      surface = context;
      const scene = context.viewer.scene;
      points = new Cesium.PointPrimitiveCollection({ scene });
      labels = new Cesium.LabelCollection({ scene });
      scene.primitives.add(points);
      scene.primitives.add(labels);

      // Positions only move with the clock, so redraw on a short interval
      // rather than per frame — 5 s is far finer than the eye needs at this
      // scale and keeps the render loop free for camera work.
      redrawTimer = setInterval(() => {
        if (self?.visible) drawPositions();
      }, 5000);

      return {
        sync: drawPositions,
        setVisible(value) {
          points.show = value;
          labels.show = value;
          if (!value) clearTrack();
        },
        select(id) {
          selectedId = id;
          drawPositions();
        },
        pickables: () => [points],
        focus: (record) => {
          const position = currentPosition(record?.noradId);
          if (!position || !context.viewer) return false;
          context.viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
              position.lon,
              position.lat,
              position.heightKm * 1000 + 1_500_000,
            ),
            duration: 1.8,
          });
          return true;
        },
        dispose() {
          if (redrawTimer) clearInterval(redrawTimer);
          clearTrack();
          points.destroy();
          labels.destroy();
        },
      };
    },
  });

  self = layer;
  return layer;
}

/** Fixture element set for the unit tests. */
export const ISS_FIXTURE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26001.50000000  .00016717  00000-0  30374-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
].join('\n');
