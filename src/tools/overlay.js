/**
 * Screen-space tactical overlay.
 *
 * Draws detection-style brackets and callsign tags for contacts on screen, on
 * a transparent canvas above the globe. Positions come from projecting real
 * world positions through Cesium's camera, so boxes stay glued to their
 * contacts through orbit and zoom instead of drifting.
 */

import { Cartesian3 } from 'cesium';

export const OVERLAY_MODES = Object.freeze({
  OFF: 'off',
  SELECTED: 'selected',
  ALL: 'all',
});

export function createOverlay({ canvas, viewer, layers, selection }) {
  const ctx = canvas.getContext('2d');
  let mode = OVERLAY_MODES.SELECTED;
  let showBrackets = true;
  let accent = 'rgba(120, 235, 180, 0.9)';
  let frame = null;
  let maxBoxes = 40;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || viewer.scene.canvas.clientWidth;
    const height = canvas.clientHeight || viewer.scene.canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  /** Project a world position to CSS pixels; null when it is behind the camera. */
  function project(lat, lon, heightM = 0) {
    const cartesian = Cartesian3.fromDegrees(lon, lat, heightM);
    const windowPosition = viewer.scene.cartesianToCanvasCoordinates(cartesian);
    if (!windowPosition) return null;
    return { x: windowPosition.x, y: windowPosition.y };
  }

  function draw() {
    frame = requestAnimationFrame(draw);
    const { width, height } = resize();
    ctx.clearRect(0, 0, width, height);
    if (mode === OVERLAY_MODES.OFF) return;

    const targets = [];
    for (const layer of layers()) {
      if (!layer.visible) continue;
      const includeAll = mode === OVERLAY_MODES.ALL;
      const records = includeAll ? layer.records : layer.records.filter(
        (record) => selection.current?.recordId === record.id && selection.current?.layerId === layer.id,
      );
      for (const record of records) {
        if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon)) continue;
        targets.push({ layer, record });
        if (targets.length >= maxBoxes) break;
      }
      if (targets.length >= maxBoxes) break;
    }

    ctx.lineWidth = 1;
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'top';

    for (const target of targets) {
      const { record, layer } = target;
      let height = 0;
      if (Number.isFinite(record.altitudeM)) height = record.altitudeM;
      else if (Number.isFinite(record.heightKm)) height = record.heightKm * 1000;
      const point = project(record.lat, record.lon, height);
      if (!point) continue;
      if (point.x < -80 || point.y < -40 || point.x > width + 80 || point.y > height + 40) continue;

      const isSelected =
        selection.current?.recordId === record.id && selection.current?.layerId === layer.id;
      const box = sizeFor(record, isSelected);
      const color = isSelected ? accent : 'rgba(150, 175, 200, 0.5)';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      if (showBrackets) drawBrackets(ctx, point, box);
      else {
        ctx.strokeRect(point.x - box / 2, point.y - box / 2, box, box);
      }

      const label = labelFor(record);
      if (label) {
        ctx.fillText(label, point.x + box / 2 + 6, point.y - box / 2);
        if (isSelected) {
          const meta = metaFor(record);
          if (meta) ctx.fillText(meta, point.x + box / 2 + 6, point.y - box / 2 + 12);
        }
      }
    }
  }

  return {
    start() {
      if (!frame) draw();
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    setMode(next) {
      mode = next;
    },
    get mode() {
      return mode;
    },
    setBrackets(value) {
      showBrackets = Boolean(value);
    },
    setAccent(value) {
      accent = value;
    },
    setMaxBoxes(value) {
      maxBoxes = Math.max(1, Number(value) || 40);
    },
    dispose() {
      this.stop();
    },
  };
}

function sizeFor(record, isSelected) {
  const base = isSelected ? 34 : 22;
  const mag = Number.isFinite(record.mag) ? record.mag * 2 : 0;
  return base + mag;
}

function labelFor(record) {
  return (
    record.callsign ||
    record.name ||
    record.stationId ||
    record.iata ||
    record.noradId ||
    record.mmsi ||
    null
  );
}

function metaFor(record) {
  if (Number.isFinite(record.mag)) return `M${record.mag.toFixed(1)}`;
  if (Number.isFinite(record.altitudeM)) return `${Math.round(record.altitudeM / 0.3048).toLocaleString()} ft`;
  if (Number.isFinite(record.heightKm)) return `${Math.round(record.heightKm)} km`;
  return null;
}

/** Corner brackets, the classic detection-box look. */
function drawBrackets(ctx, point, size) {
  const half = size / 2;
  const arm = Math.max(4, size * 0.22);
  const x = point.x - half;
  const y = point.y - half;
  ctx.beginPath();
  // top-left
  ctx.moveTo(x, y + arm);
  ctx.lineTo(x, y);
  ctx.lineTo(x + arm, y);
  // top-right
  ctx.moveTo(x + size - arm, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + size, y + arm);
  // bottom-right
  ctx.moveTo(x + size, y + size - arm);
  ctx.lineTo(x + size, y + size);
  ctx.lineTo(x + size - arm, y + size);
  // bottom-left
  ctx.moveTo(x + arm, y + size);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x, y + size - arm);
  ctx.stroke();
}
