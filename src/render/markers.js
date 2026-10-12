/**
 * Marker rendering on the globe.
 *
 * Uses Cesium primitive collections (PointPrimitiveCollection /
 * LabelCollection) rather than entities. Entities are the friendlier API but
 * a 4,000-point infrastructure layer as entities costs several hundred
 * milliseconds per refresh on a mid-range laptop; primitives diff in place and
 * reuse GPU buffers.
 *
 * Records are matched by `id`, so a refresh updates positions instead of
 * destroying and recreating every marker — which is what keeps tracking and
 * selection stable while a feed polls.
 */

import * as Cesium from 'cesium';
import { createIconAtlas } from './icons.js';

const DEFAULT_POINT = Object.freeze({
  pixelSize: 6,
  color: '#38bdf8',
  outlineColor: 'rgba(3,6,10,0.85)',
  outlineWidth: 1,
});

/**
 * @param {object} options
 * @param {import('cesium').Viewer} options.viewer
 * @param {string} options.layerId
 * @param {Function} options.positionOf record => {lon,lat,height} | null
 * @param {Function} [options.styleOf] record => style overrides
 * @param {string} [options.billboard] icon key for the canvas atlas
 * @param {number} [options.maxLabels] label budget per frame
 * @param {number} [options.maxPoints] hard cap on drawn markers
 */
export function createMarkerRenderer({
  viewer,
  layerId,
  positionOf,
  styleOf = () => ({}),
  billboard = null,
  maxLabels = 40,
  maxPoints = 6000,
  onPick = null,
}) {
  const scene = viewer.scene;
  const points = new Cesium.PointPrimitiveCollection({ scene });
  const labels = new Cesium.LabelCollection({ scene });
  scene.primitives.add(points);
  scene.primitives.add(labels);

  const atlas = billboard ? createIconAtlas(billboard) : null;
  const billboards = atlas
    ? scene.primitives.add(new Cesium.BillboardCollection({ scene }))
    : null;

  /** id -> { point, label, billboard, record } */
  const nodes = new Map();
  const seen = new Set();
  let selectedId = null;
  let visible = true;
  let labelBudget = maxLabels;

  const scratchColor = new Cesium.Color();
  const scratchCartesian = new Cesium.Cartesian3();

  function styleFor(record) {
    const style = styleOf(record) || {};
    return {
      pixelSize: style.pixelSize ?? DEFAULT_POINT.pixelSize,
      color: style.color ?? DEFAULT_POINT.color,
      outlineColor: style.outlineColor ?? DEFAULT_POINT.outlineColor,
      outlineWidth: style.outlineWidth ?? DEFAULT_POINT.outlineWidth,
      label: style.label ?? null,
      priority: style.priority ?? 0,
      rotation: style.rotation ?? null,
      scale: style.scale ?? 1,
    };
  }

  function ensureNode(id) {
    let node = nodes.get(id);
    if (node) return node;
    const point = points.add({
      pixelSize: DEFAULT_POINT.pixelSize,
      color: Cesium.Color.fromCssColorString(DEFAULT_POINT.color),
      outlineColor: Cesium.Color.fromCssColorString(DEFAULT_POINT.outlineColor),
      outlineWidth: DEFAULT_POINT.outlineWidth,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      id: { layerId, recordId: id },
    });
    node = { point, label: null, billboard: null };
    nodes.set(id, node);
    return node;
  }

  function sync(records, params = {}) {
    if (!Array.isArray(records)) return;
    seen.clear();

    // Priority-ordered so a hard cap drops the least interesting markers.
    const ordered = records.length > maxPoints ? [...records] : records;
    let drawn = 0;

    for (const record of ordered) {
      const id = record?.id;
      if (!id) continue;
      const position = positionOf(record, params);
      if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)) continue;
      if (drawn >= maxPoints) continue;
      drawn += 1;
      seen.add(id);

      const style = styleFor(record);
      const node = ensureNode(id);
      const height = Number.isFinite(position.height) ? position.height : 0;
      Cesium.Cartesian3.fromDegrees(position.lon, position.lat, height, undefined, scratchCartesian);

      node.point.position = scratchCartesian.clone();
      node.point.show = true;
      node.point.pixelSize = style.pixelSize * (selectedId === id ? 1.6 : 1);
      scratchColor.clone(Cesium.Color.fromCssColorString(style.color), node.point.color);
      node.point.color = Cesium.Color.fromCssColorString(style.color);
      node.point.outlineColor = Cesium.Color.fromCssColorString(style.outlineColor);
      node.point.outlineWidth = style.outlineWidth;
      node.record = record;

      if (billboards) {
        const image = atlas.imageFor(style.rotation);
        if (!node.billboard) {
          node.billboard = billboards.add({
            position: scratchCartesian.clone(),
            image,
            scale: style.scale,
            rotation: (-(style.rotation ?? 0) * Math.PI) / 180,
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: { layerId, recordId: id },
          });
        } else {
          node.billboard.position = scratchCartesian.clone();
          node.billboard.image = image;
          node.billboard.rotation = (-(style.rotation ?? 0) * Math.PI) / 180;
          node.billboard.scale = style.scale;
          node.billboard.show = true;
        }
        // With a billboard the point is only a selection halo.
        node.point.pixelSize = selectedId === id ? 10 : 0.01;
      }
    }

    // Retire markers that the source no longer reports.
    for (const [id, node] of nodes) {
      if (seen.has(id)) continue;
      points.remove(node.point);
      if (node.label) labels.remove(node.label);
      if (node.billboard) billboards.remove(node.billboard);
      nodes.delete(id);
    }

    if (selectedId && !seen.has(selectedId)) selectedId = null;
    renderLabels();
  }

  /**
   * Labels are a scarce resource: drawing 4,000 of them destroys legibility
   * and the frame budget. Show the selected marker always, then fill the
   * remaining budget with the highest-priority visible records.
   */
  function renderLabels() {
    labels.removeAll();
    if (!visible || labelBudget <= 0) return;

    const candidates = [];
    for (const [id, node] of nodes) {
      const style = node.record ? styleFor(node.record) : null;
      if (!style?.label) continue;
      candidates.push({ id, node, style });
    }
    candidates.sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      return b.style.priority - a.style.priority;
    });

    const budget = Math.min(labelBudget, candidates.length);
    for (let index = 0; index < budget; index += 1) {
      const { id, node, style } = candidates[index];
      const label = labels.add({
        position: node.point.position,
        text: style.label,
        font: '500 10px "JetBrains Mono", ui-monospace, monospace',
        fillColor: Cesium.Color.fromCssColorString(id === selectedId ? '#e8eef5' : 'rgba(214,228,240,0.86)'),
        outlineColor: Cesium.Color.fromCssColorString('rgba(3,6,10,0.9)'),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -11),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: id === selectedId,
        backgroundColor: Cesium.Color.fromCssColorString('rgba(8,12,16,0.78)'),
        id: { layerId, recordId: id, label: true },
      });
      node.label = label;
    }
  }

  return {
    sync,
    setVisible(next) {
      visible = Boolean(next);
      points.show = visible;
      labels.show = visible;
      if (billboards) billboards.show = visible;
      if (!visible) labels.removeAll();
    },
    setLabelBudget(value) {
      labelBudget = Math.max(0, Number(value) || 0);
      renderLabels();
    },
    select(id) {
      if (selectedId === id) return selectedId;
      selectedId = id;
      for (const [nodeId, node] of nodes) {
        const style = node.record ? styleFor(node.record) : DEFAULT_POINT;
        node.point.pixelSize = nodeId === id ? style.pixelSize * 1.7 : style.pixelSize;
      }
      renderLabels();
      return selectedId;
    },
    get selectedId() {
      return selectedId;
    },
    recordFor(id) {
      return nodes.get(id)?.record || null;
    },
    positionFor(id) {
      const node = nodes.get(id);
      if (!node?.record) return null;
      return positionOf(node.record);
    },
    focus(record) {
      const position = positionOf(record);
      if (!position) return false;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          position.lon,
          position.lat,
          Math.max(position.height ?? 0, 0) + 400_000,
        ),
        duration: 1.6,
      });
      return true;
    },
    pickables() {
      const out = [points];
      if (billboards) out.push(billboards);
      return out;
    },
    get size() {
      return nodes.length;
    },
    dispose() {
      points.destroy();
      labels.destroy();
      if (billboards) billboards.destroy();
      nodes.clear();
      atlas?.dispose?.();
    },
    onPick,
  };
}

/** Shared colour helpers so every layer speaks the same visual language. */
export function rampColor(stops, t) {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = Cesium.Color.fromCssColorString(stops[index]);
  const b = Cesium.Color.fromCssColorString(stops[index + 1]);
  return Cesium.Color.lerp(a, b, local, new Cesium.Color()).toCssHexString();
}
