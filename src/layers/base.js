/**
 * Layer contract and lifecycle.
 *
 * A layer owns four things: an identity (id/name/category/attribution), a data
 * adapter, a renderer, and a status. The manager owns refresh scheduling and
 * visibility; the layer never sets its own timers, which is what keeps twenty
 * layers from becoming a polling storm.
 *
 * Adapters signal honest outcomes by returning a result object or throwing an
 * HttpError. A layer that has nothing to draw says so with `EMPTY` rather than
 * leaving the row showing its previous state.
 */

import { LAYER_STATUS } from '../net/status.js';
import { HttpError } from '../net/http.js';
import { statusFromFailureKind } from '../net/status.js';
import { createDisposer } from '../core/dom.js';

export const LAYER_CATEGORIES = Object.freeze([
  { id: 'movement', label: 'Movement', icon: 'navigation' },
  { id: 'space', label: 'Space', icon: 'orbit' },
  { id: 'events', label: 'Events', icon: 'alert' },
  { id: 'weather', label: 'Weather', icon: 'cloudRain' },
  { id: 'cameras', label: 'Cameras', icon: 'camera' },
  { id: 'infrastructure', label: 'Infrastructure', icon: 'building' },
  { id: 'utilities', label: 'Utilities', icon: 'radio' },
]);

let layerSeq = 0;

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.name
 * @param {string} spec.category one of LAYER_CATEGORIES
 * @param {string} spec.icon Lucide icon name
 * @param {string} spec.description
 * @param {string|string[]} spec.sources source registry ids for attribution
 * @param {Function} spec.fetch async ({ signal, ctx }) => Array<record>
 * @param {Function} [spec.detail] record => detail model for the context panel
 * @param {Function} [spec.style] record => marker style
 * @param {Function} [spec.configure] ({layer, panel}) => builds the layer's options UI
 * @param {Array} [spec.requires] unmet requirements -> CONFIG_REQUIRED
 * @param {number} [spec.refreshMs]
 */
export function createLayer(spec) {
  if (!spec?.id || typeof spec.fetch !== 'function') {
    throw new TypeError('A layer needs an id and a fetch adapter');
  }

  const disposers = createDisposer();
  const listeners = new Set();
  const state = {
    uid: `layer-${++layerSeq}`,
    id: spec.id,
    name: spec.name,
    category: spec.category,
    icon: spec.icon || 'layers',
    description: spec.description || '',
    sources: Array.isArray(spec.sources) ? spec.sources : spec.sources ? [spec.sources] : [],
    refreshMs: spec.refreshMs ?? 5 * 60 * 1000,
    visible: spec.visible ?? false,
    status: LAYER_STATUS.IDLE,
    message: '',
    count: 0,
    fetchedAt: 0,
    error: null,
    records: [],
    params: { ...(spec.params || {}) },
    demo: Boolean(spec.demo),
    supported: spec.supported !== false,
    requires: (spec.requires || []).map((requirement) => ({ ...requirement })),
  };

  let renderer = null;
  let ctx = null;
  let aborter = null;
  let generation = 0;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener(snapshot());
      } catch (error) {
        console.error(`[layer:${state.id}] listener failed`, error);
      }
    }
  }

  function setStatus(status, extra = {}) {
    state.status = status;
    if ('message' in extra) state.message = extra.message;
    if ('error' in extra) state.error = extra.error;
    if ('count' in extra) state.count = extra.count;
    emit();
  }

  function snapshot() {
    return {
      id: state.id,
      name: state.name,
      category: state.category,
      icon: state.icon,
      description: state.description,
      sources: [...state.sources],
      visible: state.visible,
      status: state.status,
      message: state.message,
      count: state.count,
      fetchedAt: state.fetchedAt,
      error: state.error,
      demo: state.demo,
      supported: state.supported,
      // Exposed so the rail can say *which* setting to open, rather than only
      // that something is missing.
      requires: state.requires.map((requirement) => ({ ...requirement })),
      params: { ...state.params },
    };
  }

  const layer = {
    id: state.id,
    name: state.name,
    category: state.category,
    icon: state.icon,
    description: state.description,
    sources: state.sources,
    refreshMs: state.refreshMs,

    get status() {
      return state.status;
    },
    get visible() {
      return state.visible;
    },
    get count() {
      return state.count;
    },
    get params() {
      return state.params;
    },
    get records() {
      return state.records;
    },

    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },

    /** Bind the layer to the viewer surface. Called once at startup. */
    attach(surface) {
      ctx = surface;
      if (spec.createRenderer) {
        renderer = spec.createRenderer(surface, layer);
        if (renderer?.dispose) disposers.add(() => renderer.dispose());
      }
      if (spec.onAttach) spec.onAttach(surface, layer);
      if (!state.supported) {
        setStatus(LAYER_STATUS.UNAVAILABLE, { message: spec.unavailableMessage || '' });
      }
      return layer;
    },

    setParams(patch) {
      state.params = { ...state.params, ...patch };
      if (state.visible) layer.refresh({ force: true });
      emit();
    },

    show() {
      if (state.visible) return;
      state.visible = true;
      renderer?.setVisible?.(true);
      emit();
      if (!state.supported) {
        setStatus(LAYER_STATUS.UNAVAILABLE, { message: spec.unavailableMessage || '' });
        return;
      }
      layer.refresh({ force: true });
    },

    hide() {
      if (!state.visible) return;
      state.visible = false;
      renderer?.setVisible?.(false);
      aborter?.abort();
      aborter = null;
      emit();
    },

    toggle() {
      if (state.visible) layer.hide();
      else layer.show();
    },

    /**
     * Fetch and render. A refresh that is superseded by a newer one is dropped
     * rather than allowed to write stale records over fresh ones.
     */
    async refresh({ force = false, silent = false } = {}) {
      if (!state.visible) return;
      const unmet = checkRequirements(state.requires, ctx);
      if (unmet.length) {
        setStatus(LAYER_STATUS.CONFIG_REQUIRED, {
          message: unmet.join(' '),
          error: null,
          count: 0,
        });
        return;
      }
      if (!force && state.fetchedAt && Date.now() - state.fetchedAt < state.refreshMs) return;
      if (!force && state.status === LAYER_STATUS.LOADING) return;

      const thisGeneration = ++generation;
      aborter?.abort();
      const controller = new AbortController();
      aborter = controller;

      if (!silent) setStatus(LAYER_STATUS.LOADING, { message: 'Requesting…' });

      try {
        const result = await spec.fetch({
          signal: controller.signal,
          ctx,
          layer,
          params: state.params,
          previous: state.records,
        });
        if (thisGeneration !== generation || controller.signal.aborted) return;

        const records = Array.isArray(result) ? result : (result?.records ?? []);
        state.records = records;
        state.fetchedAt = Date.now();
        state.count = records.length;
        state.demo = Boolean(Array.isArray(result) ? false : result?.demo);

        renderer?.sync?.(records, state.params);
        renderer?.setVisible?.(true);

        if (!records.length) {
          setStatus(LAYER_STATUS.EMPTY, {
            message: (Array.isArray(result) ? '' : result?.message) || 'The source answered with no features in view.',
            error: null,
            count: 0,
          });
          return;
        }
        setStatus(state.demo ? LAYER_STATUS.SIMULATED : LAYER_STATUS.LIVE, {
          message: (Array.isArray(result) ? '' : result?.message) || '',
          error: null,
          count: records.length,
        });
      } catch (error) {
        if (thisGeneration !== generation) return;
        if (controller.signal.aborted && !state.visible) return;
        const kind = error instanceof HttpError ? error.kind : 'network';
        setStatus(statusFromFailureKind(kind), {
          message: error?.message || 'Request failed',
          error,
        });
        // Keep whatever is already drawn so a transient failure does not
        // blank the globe; the status row tells the truth about freshness.
      }
    },

    /** Called when the camera settles, for viewport-bounded sources. */
    onCameraSettled() {
      if (!state.visible || !spec.viewportAware) return;
      layer.refresh({ force: true, silent: true });
    },

    detail: (record) => (spec.detail ? spec.detail(record, layer) : null),
    style: (record) => (spec.style ? spec.style(record, state.params) : null),
    configure: spec.configure || null,
    viewportAware: Boolean(spec.viewportAware),
    /** Anything the layer wants to expose for picking beyond its markers. */
    pickables: () => renderer?.pickables?.() ?? [],
    focus: (record) => renderer?.focus?.(record),
    select: (id) => renderer?.select?.(id),
    clearSelection: () => renderer?.select?.(null),

    dispose() {
      aborter?.abort();
      generation += 1;
      listeners.clear();
      try {
        spec.onDispose?.();
      } catch (error) {
        console.error(`[layer:${state.id}] onDispose failed`, error);
      }
      disposers.dispose();
      renderer = null;
      ctx = null;
    },
  };

  return layer;
}

/**
 * A requirement is met when the named setting has a value. Returns the list of
 * human-readable blockers, empty when everything is satisfied.
 */
export function checkRequirements(requires, ctx) {
  if (!requires?.length) return [];
  const settings = ctx?.settings;
  const blockers = [];
  for (const requirement of requires) {
    if (requirement.kind === 'setting') {
      if (!settings?.has?.(requirement.id)) {
        blockers.push(requirement.message || `${requirement.label || requirement.id} is not configured.`);
      }
    }
  }
  return blockers;
}

/**
 * Refresh scheduler. One timer sweeps every visible layer, so N layers cost
 * one interval rather than N. Hidden layers are skipped entirely, and the
 * whole scheduler pauses when the tab is backgrounded — a static site has no
 * server to blame for burning a volunteer API's quota.
 */
export function createRefreshScheduler({ layers, intervalMs = 10_000, onTick } = {}) {
  let timer = null;
  let paused = false;

  const tick = () => {
    if (paused) return;
    const now = Date.now();
    for (const layer of layers()) {
      if (!layer.visible) continue;
      if (layer.viewportAware) continue; // driven by the camera, not the clock
      const due = !layer.count && layer.status === LAYER_STATUS.IDLE;
      if (!due && now - (layer.snapshot().fetchedAt || 0) < layer.refreshMs) continue;
      layer.refresh({ silent: layer.count > 0 }).catch(() => {});
    }
    onTick?.();
  };

  const onVisibility = () => {
    paused = typeof document !== 'undefined' ? document.hidden : false;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      // `document?.x` still throws a ReferenceError when `document` is not
      // declared at all, so the guard has to be a typeof check.
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    },
    tickNow: tick,
    get paused() {
      return paused;
    },
  };
}
