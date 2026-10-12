/**
 * Point-layer factory.
 *
 * Most layers in this console are "fetch records, put a marker on each, show a
 * panel when one is picked". Factoring that once keeps each layer definition
 * to its genuinely distinguishing parts: where the data comes from, how a
 * record maps to a position, and how it is drawn.
 */

import { createLayer } from './base.js';
import { createMarkerRenderer } from '../render/markers.js';
import { boundingBox } from '../geo/coords.js';

/**
 * @param {object} spec everything createLayer accepts, plus:
 * @param {Function} spec.positionOf record => {lat, lon, height?}
 * @param {Function} [spec.styleOf]  record => marker style
 * @param {boolean} [spec.viewportAware] re-fetch when the camera settles
 * @param {Function} [spec.queryBox] (surface, params) => box for viewport queries
 * @param {number} [spec.viewportRadiusKm]
 */
export function createPointLayer(spec) {
  const {
    positionOf,
    styleOf,
    detail,
    queryBox,
    viewportAware,
    maxLabels = 40,
    maxPoints = 6000,
    billboard = null,
    labelDensity = 'balanced',
    ...layerSpec
  } = spec;

  if (typeof positionOf !== 'function') {
    throw new TypeError(`Layer ${spec.id} needs a positionOf mapping`);
  }

  const fetchAdapter = async (context) => {
    const surface = context.ctx;
    const params = context.params || {};
    const box = viewportAware
      ? (queryBox ? queryBox(surface, params) : surface?.camera?.viewportBox?.(params.viewportRadiusKm))
      : null;
    return spec.fetch({ ...context, box, surface });
  };

  return createLayer({
    ...layerSpec,
    viewportAware,
    fetch: fetchAdapter,
    detail,
    createRenderer(surface) {
      if (!surface?.viewer) return null;
      const renderer = createMarkerRenderer({
        viewer: surface.viewer,
        layerId: spec.id,
        positionOf,
        styleOf,
        billboard,
        maxLabels,
        maxPoints,
      });
      renderer.setLabelBudget(labelBudgetFor(labelDensity));
      return renderer;
    },
  });
}

const LABEL_BUDGETS = Object.freeze({ minimal: 12, balanced: 40, dense: 120, off: 0 });

export function labelBudgetFor(density) {
  return LABEL_BUDGETS[density] ?? LABEL_BUDGETS.balanced;
}

/**
 * Build a viewport box around the camera focus with a margin, used by layers
 * that query a provider for "what is near what I am looking at".
 */
export function viewportQueryBox(surface, { radiusKm = 400, minRadiusKm = 60, maxRadiusKm = 2500 } = {}) {
  const focus = surface?.camera?.focus?.();
  if (!focus) return boundingBox(0, 0, radiusKm);
  const heightKm = (focus.heightM ?? 0) / 1000;
  // Roughly the ground span visible at this altitude, clamped to sane bounds.
  const span = Math.min(maxRadiusKm, Math.max(minRadiusKm, heightKm * 0.9));
  return boundingBox(focus.lat, focus.lon, span);
}
