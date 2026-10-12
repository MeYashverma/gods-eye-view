/**
 * Selection and picking.
 *
 * One handler owns clicks on the globe. Markers are created with an
 * `{ layerId, recordId }` payload, so a pick resolves to a layer and a record
 * without any layer knowing about input handling. The selection is a stable
 * pair plus a snapshot of the record — which is what the context panel, the
 * follow camera and the share link all read.
 */

import * as Cesium from 'cesium';

export function createSelectionManager({ viewer, layers, followTarget, events }) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  let current = null;
  let followStop = null;
  let enabled = true;
  const listeners = new Set();

  function layerById(id) {
    return layers().find((layer) => layer.id === id) || null;
  }

  /** Height above the ellipsoid for any record shape the app produces. */
  function positionOf(record) {
    if (!record || !Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return null;
    let height = 0;
    if (Number.isFinite(record.altitudeM)) height = record.altitudeM;
    else if (Number.isFinite(record.heightKm)) height = record.heightKm * 1000;
    else if (Number.isFinite(record.height)) height = record.height;
    return { lat: record.lat, lon: record.lon, height };
  }

  function emit() {
    const snapshot = serialize();
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[selection] listener failed', error);
      }
    }
    events?.emit('selection:change', snapshot);
  }

  function pickAt(screenPosition) {
    const picked = viewer.scene.pick(screenPosition);
    const payload = picked?.id;
    if (!payload || typeof payload !== 'object' || !payload.recordId) return null;
    const layer = layerById(payload.layerId);
    if (!layer || !layer.visible) return null;
    const record = layer.records?.find?.((entry) => entry.id === payload.recordId) || null;
    return { layer, recordId: payload.recordId, record };
  }

  handler.setInputAction((movement) => {
    if (!enabled) return;
    const hit = pickAt(movement.position);
    if (!hit || !hit.record) {
      clear();
      return;
    }
    select(hit.layer, hit.recordId);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function select(layer, recordId, { flyTo = false, follow = false } = {}) {
    if (!layer) return null;
    const record = layer.records?.find?.((entry) => entry.id === recordId) || null;
    if (!record) return null;
    current = { layerId: layer.id, recordId, record };
    layer.select?.(recordId);
    for (const other of layers()) {
      if (other !== layer) other.clearSelection?.();
    }
    if (flyTo) layer.focus?.(record);
    setFollow(follow);
    emit();
    return current;
  }

  function clear() {
    const had = Boolean(current);
    current = null;
    setFollow(false);
    for (const layer of layers()) layer.clearSelection?.();
    if (had) emit();
  }

  function setFollow(value) {
    if (followStop) {
      followStop();
      followStop = null;
    }
    if (!value || !current || typeof followTarget !== 'function') return;
    const layer = layerById(current.layerId);
    if (!layer) return;
    followStop = followTarget(() => {
      const fresh = layer.records?.find?.((entry) => entry.id === current?.recordId);
      const source = fresh || current?.record;
      if (!source) return null;
      current.record = source;
      return positionOf(source);
    });
  }

  function serialize() {
    if (!current) return null;
    return { layerId: current.layerId, recordId: current.recordId };
  }

  return {
    select,
    clear,
    get current() {
      return current;
    },
    serialize,
    subscribe(listener) {
      listeners.add(listener);
      listener(serialize());
      return () => listeners.delete(listener);
    },
    setFollow,
    get following() {
      return Boolean(followStop);
    },
    setEnabled(value) {
      enabled = Boolean(value);
    },
    pickAt,
    /** Re-read the record after a refresh so the panel tracks live values. */
    refresh() {
      if (!current) return;
      const layer = layerById(current.layerId);
      const fresh = layer?.records?.find?.((entry) => entry.id === current.recordId);
      if (fresh && fresh !== current.record) {
        current.record = fresh;
        emit();
      }
    },
    dispose() {
      if (followStop) followStop();
      listeners.clear();
      if (!handler.isDestroyed()) handler.destroy();
    },
  };
}
