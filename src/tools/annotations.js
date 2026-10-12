/**
 * Local annotations — points, lines and polygons the operator draws.
 *
 * Stored in localStorage, never sent anywhere. Lengths and areas use real
 * spherical geometry (haversine for distance, a spherical excess formula for
 * area) rather than screen-space approximations, so a measurement on screen
 * and a measurement in the panel agree.
 */

import * as Cesium from 'cesium';
import { EARTH_RADIUS_M, DEG, distanceM } from '../geo/coords.js';

const STORAGE_KEY = 'gev:annotations:v1';

export const DRAW_MODES = Object.freeze({
  NONE: 'none',
  POINT: 'point',
  LINE: 'line',
  POLYGON: 'polygon',
  MEASURE: 'measure',
});

export function pathLengthM(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceM(points[index - 1].lat, points[index - 1].lon, points[index].lat, points[index].lon);
  }
  return total;
}

/**
 * Spherical polygon area in square metres.
 * Uses the standard spherical-excess sum over the unit sphere, then scales by
 * R^2. Accurate enough for annotations and, unlike a planar shoelace on
 * lat/lon, correct at high latitude.
 */
export function sphericalAreaM2(points) {
  if (!points || points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total +=
      (next.lon - current.lon) * DEG *
      (2 + Math.sin(current.lat * DEG) + Math.sin(next.lat * DEG));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function formatArea(m2) {
  if (!Number.isFinite(m2)) return '—';
  if (m2 < 1e6) return `${Math.round(m2).toLocaleString()} m²`;
  return `${(m2 / 1e6).toFixed(2)} km²`;
}

export function createAnnotationStore({ storage = safeStorage() } = {}) {
  let items = [];
  const listeners = new Set();

  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed.filter(isValidAnnotation);
    }
  } catch {
    items = [];
  }

  function persist() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (error) {
      console.warn('[annotations] could not persist', error);
    }
  }

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener([...items]);
      } catch (error) {
        console.error('[annotations] listener failed', error);
      }
    }
  }

  return {
    list: () => [...items],
    get: (id) => items.find((item) => item.id === id) || null,
    add(annotation) {
      if (!isValidAnnotation(annotation)) return null;
      items = [...items, annotation];
      persist();
      emit();
      return annotation;
    },
    update(id, patch) {
      items = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
      persist();
      emit();
    },
    remove(id) {
      items = items.filter((item) => item.id !== id);
      persist();
      emit();
    },
    clear() {
      items = [];
      persist();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener([...items]);
      return () => listeners.delete(listener);
    },
  };
}

function isValidAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object') return false;
  if (!['point', 'line', 'polygon'].includes(annotation.type)) return false;
  if (!Array.isArray(annotation.points) || !annotation.points.length) return false;
  return annotation.points.every(
    (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon),
  );
}

function safeStorage() {
  try {
    const probe = '__gev_annotations_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Globe renderer for annotations. Kept separate from the store so the store
 * can be unit-tested without a Cesium viewer.
 */
export function createAnnotationRenderer({ viewer, store }) {
  const source = new Cesium.CustomDataSource('annotations');
  viewer.dataSources.add(source);
  let mode = DRAW_MODES.NONE;
  let pending = [];
  let handler = null;
  let previewEntity = null;
  let onModeChange = null;

  const COLOR = Cesium.Color.fromCssColorString('#fbbf24');

  function redraw() {
    source.entities.removeAll();
    previewEntity = null;
    for (const item of store.list()) {
      const positions = item.points.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 5));
      if (item.type === 'point') {
        source.entities.add({
          position: positions[0],
          point: { pixelSize: 9, color: COLOR, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5 },
          label: {
            text: item.label || '',
            font: '500 11px "JetBrains Mono", monospace',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -14),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('rgba(8,12,16,0.8)'),
            scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 1e7, 0.4),
          },
        });
      } else if (item.type === 'line') {
        source.entities.add({
          polyline: { positions, width: 2.5, material: COLOR, clampToGround: true },
          label: {
            position: positions[Math.floor(positions.length / 2)],
            text: labelFor(item),
            font: '500 10px "JetBrains Mono", monospace',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('rgba(8,12,16,0.8)'),
          },
        });
      } else {
        source.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            material: COLOR.withAlpha(0.14),
            outline: true,
            outlineColor: COLOR,
            height: 0,
          },
          label: {
            position: positions[0],
            text: labelFor(item),
            font: '500 10px "JetBrains Mono", monospace',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('rgba(8,12,16,0.8)'),
          },
        });
      }
    }
  }

  function labelFor(item) {
    if (item.type === 'line') return item.label || formatLength(pathLengthM(item.points));
    if (item.type === 'polygon') return item.label || formatArea(sphericalAreaM2(item.points));
    return item.label || '';
  }

  function formatLength(metres) {
    if (metres < 1000) return `${Math.round(metres)} m`;
    return `${(metres / 1000).toFixed(2)} km`;
  }

  function pickGround(screenPosition) {
    const ray = viewer.camera.getPickRay(screenPosition);
    if (!ray) return null;
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return null;
    const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
    if (!cartographic) return null;
    return {
      lat: cartographic.latitude / DEG,
      lon: cartographic.longitude / DEG,
    };
  }

  function installHandler() {
    if (handler) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement) => {
      if (mode === DRAW_MODES.NONE) return;
      const point = pickGround(movement.position);
      if (!point) return;
      if (mode === DRAW_MODES.POINT) {
        finish([{ ...point }], 'point');
        return;
      }
      pending = [...pending, point];
      redrawPreview();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(() => {
      if (mode === DRAW_MODES.NONE || pending.length < 2) return;
      finish(pending, mode === DRAW_MODES.MEASURE ? 'line' : mode);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  function redrawPreview() {
    if (previewEntity) {
      source.entities.remove(previewEntity);
      previewEntity = null;
    }
    if (pending.length < 2) return;
    previewEntity = source.entities.add({
      polyline: {
        positions: pending.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 5)),
        width: 2,
        material: Cesium.Color.fromCssColorString('#38bdf8'),
        clampToGround: true,
      },
    });
  }

  function finish(points, type) {
    const annotation = {
      id: `ann:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      points: [...points],
      label: '',
      createdAt: Date.now(),
      measurement:
        type === 'line'
          ? { lengthM: pathLengthM(points) }
          : type === 'polygon'
            ? { areaM2: sphericalAreaM2(points), perimeterM: pathLengthM([...points, points[0]]) }
            : null,
    };
    store.add(annotation);
    pending = [];
    redrawPreview();
    redraw();
    onModeChange?.({ finished: annotation });
  }

  const unsubscribe = store.subscribe(() => redraw());

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
      pending = [];
      redrawPreview();
      if (mode !== DRAW_MODES.NONE) installHandler();
      viewer.scene.screenSpaceCameraController.enableInputs = true;
    },
    cancelPending() {
      pending = [];
      redrawPreview();
    },
    onFinished(callback) {
      onModeChange = callback;
    },
    redraw,
    setVisible(value) {
      source.show = Boolean(value);
    },
    dispose() {
      unsubscribe();
      if (handler && !handler.isDestroyed()) handler.destroy();
      viewer.dataSources.remove(source, true);
    },
  };
}
