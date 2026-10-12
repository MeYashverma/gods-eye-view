/**
 * Map stack catalog — the imagery and terrain sources the console can swap
 * between, and the rules for choosing a default.
 *
 * The hard constraint is that GitHub Pages ships no secrets: the default stack
 * has to be keyless. Cesium ion and Google Photorealistic 3D Tiles are
 * therefore opt-in, gated on a user-supplied token, and the app never implies
 * they are available when they are not.
 */

export const IMAGERY_STACKS = Object.freeze([
  {
    id: 'esri-imagery',
    label: 'Esri Satellite',
    shortLabel: 'SAT',
    kind: 'url-template',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Esri, Maxar, Earthstar Geographics',
    sourceId: 'esri',
    keyless: true,
    maximumLevel: 19,
  },
  {
    id: 'esri-labeled',
    label: 'Esri Satellite + Labels',
    shortLabel: 'SAT+LBL',
    kind: 'url-template-group',
    layers: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit: 'Esri, Maxar, Earthstar Geographics',
      },
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        credit: 'Esri, Maxar, Earthstar Geographics',
      },
    ],
    sourceId: 'esri',
    keyless: true,
    maximumLevel: 19,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    shortLabel: 'OSM',
    kind: 'osm',
    credit: '© OpenStreetMap contributors',
    sourceId: 'osm-tiles',
    keyless: true,
    maximumLevel: 19,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial (Cesium ion)',
    shortLabel: 'BING',
    kind: 'ion-imagery',
    style: 'AERIAL_WITH_LABELS',
    credit: 'Bing Maps / Microsoft via Cesium ion',
    sourceId: 'cesium-ion',
    keyless: false,
    requiresSetting: 'cesiumIonToken',
  },
]);

export const TERRAIN_STACKS = Object.freeze([
  {
    id: 'auto',
    label: 'Automatic',
    description: 'Cesium World Terrain when an ion token is set, otherwise keyless Re:Earth terrain, otherwise a flat ellipsoid.',
    keyless: true,
  },
  {
    id: 'ion',
    label: 'Cesium World Terrain',
    description: 'High-resolution global terrain. Requires a Cesium ion token.',
    keyless: false,
    requiresSetting: 'cesiumIonToken',
  },
  {
    id: 'reearth',
    label: 'Re:Earth terrain (keyless)',
    description: 'Quantized-mesh terrain from the keyless Re:Earth endpoint.',
    keyless: true,
    url: 'https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json',
  },
  {
    id: 'flat',
    label: 'Flat ellipsoid',
    description: 'No terrain. Fastest, and the only option that cannot fail.',
    keyless: true,
  },
]);

/** Google Photorealistic 3D Tiles is a tileset, not an imagery layer. */
export const PHOTOREAL_3D = Object.freeze({
  id: 'photoreal',
  label: 'Google Photorealistic 3D',
  shortLabel: '3D',
  requiresSetting: 'googleMapsKey',
  keyless: false,
  credit: 'Google',
  sourceId: 'google-tiles',
});

export function getImageryStack(id) {
  return IMAGERY_STACKS.find((stack) => stack.id === id) || IMAGERY_STACKS[0];
}

export function getTerrainStack(id) {
  return TERRAIN_STACKS.find((stack) => stack.id === id) || TERRAIN_STACKS[0];
}

/**
 * Resolve the terrain stack to actually apply, given the user's settings.
 * Returns the chosen stack plus the reason, so the UI can explain a fallback
 * instead of quietly downgrading.
 */
export function resolveTerrain(requestedId, { hasIonToken = false } = {}) {
  const requested = getTerrainStack(requestedId);
  if (requested.id === 'auto') {
    if (hasIonToken) return { stack: getTerrainStack('ion'), reason: 'Cesium ion token present' };
    return { stack: getTerrainStack('reearth'), reason: 'Keyless terrain (no ion token set)' };
  }
  if (requested.requiresSetting === 'cesiumIonToken' && !hasIonToken) {
    return {
      stack: getTerrainStack('flat'),
      reason: 'Cesium ion token not configured — using a flat ellipsoid',
    };
  }
  return { stack: requested, reason: null };
}

export function listImageryStacks() {
  return IMAGERY_STACKS;
}

export function listTerrainStacks() {
  return TERRAIN_STACKS;
}
