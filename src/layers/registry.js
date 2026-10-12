/**
 * Layer registry.
 *
 * One place where every layer is constructed and grouped, so the rail, the
 * share-link encoder and the attribution popover all read from the same list.
 */

import { LAYER_CATEGORIES } from './base.js';
import { createMovementLayers } from './movement.js';
import { createSatelliteLayer } from './space.js';
import { createEventLayers } from './events.js';
import { createWeatherLayers } from './weather.js';
import { createCameraLayers } from './cameras.js';
import { createInfrastructureLayers } from './infrastructure.js';
import { createUtilityLayers } from './utilities.js';

export function buildLayers() {
  return [
    ...createMovementLayers(),
    createSatelliteLayer(),
    ...createEventLayers(),
    ...createWeatherLayers(),
    ...createCameraLayers(),
    ...createInfrastructureLayers(),
    ...createUtilityLayers(),
  ];
}

export function groupLayers(layers) {
  const groups = LAYER_CATEGORIES.map((category) => ({
    ...category,
    layers: layers.filter((layer) => layer.category === category.id),
  }));
  const ungrouped = layers.filter(
    (layer) => !LAYER_CATEGORIES.some((category) => category.id === layer.category),
  );
  if (ungrouped.length) groups.push({ id: 'other', label: 'Other', icon: 'layers', layers: ungrouped });
  return groups.filter((group) => group.layers.length);
}

export function layerIds(layers) {
  return layers.map((layer) => layer.id);
}
