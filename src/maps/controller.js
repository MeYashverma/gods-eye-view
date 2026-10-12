/**
 * Map stack controller — imagery, terrain and the optional Google
 * Photorealistic 3D tileset.
 *
 * Every swap is a fallback chain, never a single point of failure: if the
 * chosen terrain endpoint cannot be reached the globe still renders on a flat
 * ellipsoid, and the UI reports which stack actually won. A globe that fails
 * to boot because one optional provider is down is worse than a flat globe.
 */

import * as Cesium from 'cesium';
import { getImageryStack, resolveTerrain, PHOTOREAL_3D } from './catalog.js';

export function createMapController({ viewer, settings, onStatus }) {
  let imageryLayers = [];
  let terrainState = { id: 'flat', label: 'Flat ellipsoid', reason: null, ok: true };
  let photorealTileset = null;
  let disposed = false;

  const report = (payload) => {
    if (!disposed) onStatus?.(payload);
  };

  function clearImagery() {
    for (const layer of imageryLayers) {
      try {
        viewer.imageryLayers.remove(layer, true);
      } catch {
        /* already gone */
      }
    }
    imageryLayers = [];
  }

  function buildProvider(stack) {
    switch (stack.kind) {
      case 'osm':
        return new Cesium.OpenStreetMapImageryProvider({
          url: 'https://tile.openstreetmap.org/',
          maximumLevel: stack.maximumLevel,
          credit: new Cesium.Credit(stack.credit, false),
        });
      case 'url-template-group':
      case 'url-template': {
        const definitions =
          stack.kind === 'url-template-group'
            ? stack.layers
            : [{ url: stack.url, credit: stack.credit }];
        return definitions.map(
          (definition) =>
            new Cesium.UrlTemplateImageryProvider({
              url: definition.url,
              maximumLevel: stack.maximumLevel,
              credit: new Cesium.Credit(definition.credit, false),
            }),
        );
      }
      case 'ion-imagery': {
        if (!Cesium.Ion.defaultAccessToken) return null;
        return Cesium.IonImageryProvider.fromAssetId(
          stack.style === 'AERIAL_WITH_LABELS' ? 3 : 2,
          {},
        );
      }
      default:
        return null;
    }
  }

  /**
   * Apply an imagery stack. Falls back to Esri Satellite if the requested
   * stack cannot be constructed (for example an ion stack with no token).
   */
  async function setImagery(stackId) {
    if (disposed) return;
    const requested = getImageryStack(stackId);
    const chain = [requested];
    if (requested.id !== 'esri-imagery') chain.push(getImageryStack('esri-imagery'));

    for (const stack of chain) {
      try {
        const provider = buildProvider(stack);
        if (!provider) continue;
        const providers = Array.isArray(provider) ? provider : [provider];
        const resolved = [];
        for (const entry of providers) {
          resolved.push(entry instanceof Promise || entry?.then ? await entry : entry);
        }
        clearImagery();
        for (const instance of resolved) {
          imageryLayers.push(viewer.imageryLayers.addImageryProvider(instance));
        }
        report({ kind: 'imagery', id: stack.id, label: stack.label, ok: true, fallback: stack.id !== requested.id });
        return stack.id;
      } catch (error) {
        report({
          kind: 'imagery',
          id: stack.id,
          label: stack.label,
          ok: false,
          error,
          message: `Imagery "${stack.label}" failed: ${error?.message || error}`,
        });
      }
    }
    // Last resort: a single-colour globe still lets every data layer work.
    clearImagery();
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1219');
    report({ kind: 'imagery', id: 'none', label: 'None (all providers failed)', ok: false });
    return 'none';
  }

  async function setTerrain(stackId) {
    if (disposed) return;
    const { stack, reason } = resolveTerrain(stackId, {
      hasIonToken: settings.has('cesiumIonToken'),
    });

    const attempts = [stack];
    if (stack.id !== 'flat') attempts.push({ id: 'flat', label: 'Flat ellipsoid', keyless: true });

    for (const attempt of attempts) {
      try {
        const provider = await buildTerrainProvider(attempt);
        if (!provider) continue;
        viewer.scene.globe.terrainProvider = provider;
        viewer.scene.globe.depthTestAgainstTerrain = attempt.id !== 'flat';
        terrainState = {
          id: attempt.id,
          label: attempt.label,
          reason: attempt.id === stack.id ? reason : `Fell back from ${stack.label}`,
          ok: true,
        };
        report({ kind: 'terrain', ...terrainState });
        return terrainState;
      } catch (error) {
        report({
          kind: 'terrain',
          id: attempt.id,
          label: attempt.label,
          ok: false,
          reason: `Failed: ${error?.message || error}`,
        });
      }
    }
    terrainState = { id: 'flat', label: 'Flat ellipsoid', reason: 'No terrain provider responded', ok: false };
    report({ kind: 'terrain', ...terrainState });
    return terrainState;
  }

  async function buildTerrainProvider(stack) {
    if (stack.id === 'flat') return new Cesium.EllipsoidTerrainProvider();
    if (stack.id === 'ion') {
      if (!Cesium.Ion.defaultAccessToken) return null;
      return Cesium.createWorldTerrainAsync({
        requestVertexNormals: true,
        requestWaterMask: false,
      });
    }
    if (stack.url) {
      return Cesium.CesiumTerrainProvider.fromUrl(stack.url, {
        requestVertexNormals: true,
        requestWaterMask: false,
      });
    }
    return null;
  }

  /**
   * Google Photorealistic 3D Tiles. Removed cleanly on toggle-off so the
   * imagery underneath is visible again.
   */
  async function setPhotorealistic(enabled) {
    if (!enabled) {
      if (photorealTileset) {
        viewer.scene.primitives.remove(photorealTileset);
        photorealTileset = null;
        viewer.scene.globe.show = true;
        report({ kind: 'photoreal', ok: true, enabled: false });
      }
      return false;
    }
    const key = settings.get(PHOTOREAL_3D.requiresSetting);
    if (!key) {
      report({
        kind: 'photoreal',
        ok: false,
        enabled: false,
        message: 'A Google Maps API key is required for Photorealistic 3D Tiles.',
      });
      return false;
    }
    if (photorealTileset) return true;
    try {
      const tileset = await Cesium.createGooglePhotorealistic3DTileset({
        key,
        showCreditsOnScreen: true,
      });
      photorealTileset = viewer.scene.primitives.add(tileset);
      // Google's 3D tiles include their own ground; hide the 2D globe so the
      // two do not z-fight.
      viewer.scene.globe.show = false;
      report({ kind: 'photoreal', ok: true, enabled: true });
      return true;
    } catch (error) {
      viewer.scene.globe.show = true;
      report({
        kind: 'photoreal',
        ok: false,
        enabled: false,
        message: `Google Photorealistic 3D Tiles failed: ${error?.message || error}`,
      });
      return false;
    }
  }

  return {
    setImagery,
    setTerrain,
    setPhotorealistic,
    get terrain() {
      return terrainState;
    },
    get imagery() {
      return imageryLayers;
    },
    /** Re-apply terrain when the user adds or removes an ion token. */
    async refreshTerrain() {
      return setTerrain(terrainState.id === 'flat' ? 'auto' : terrainState.id);
    },
    dispose() {
      disposed = true;
      clearImagery();
      if (photorealTileset) {
        try {
          viewer.scene.primitives.remove(photorealTileset);
        } catch {
          /* viewer already gone */
        }
        photorealTileset = null;
      }
    },
  };
}
