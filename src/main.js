/**
 * Application entry point.
 *
 * Boots the globe, wires the controllers, builds the layer catalog and the
 * console UI, then restores any shared state from the URL hash. Startup is
 * staged so a failure in one optional subsystem (a terrain endpoint, a
 * provider) never prevents the globe from rendering.
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { createStore } from './core/store.js';
import { createEventBus } from './core/events.js';
import { createSettingsStore } from './settings/store.js';
import { createMapController } from './maps/controller.js';
import { createCameraController } from './camera/controller.js';
import { buildLayers, groupLayers } from './layers/registry.js';
import { createRefreshScheduler } from './layers/base.js';
import { createSelectionManager } from './app/selection.js';
import { createVisualEffects, VISUAL_STYLES } from './tools/effects.js';
import { createOverlay, OVERLAY_MODES } from './tools/overlay.js';
import { createAnnotationStore, createAnnotationRenderer, DRAW_MODES } from './tools/annotations.js';
import { createDirector } from './tools/director.js';
import { createSpeechController, describeResult } from './voice/speech.js';
import { buildLayerAliases, INTENTS } from './voice/commands.js';
import { http } from './net/http.js';
import { searchPlaces } from './sources/geocode.js';
import { decodeShareLink, encodeShareLink, readHash, writeHash } from './share/link.js';
import { labelBudgetFor } from './layers/pointLayer.js';
import { listImageryStacks, listTerrainStacks } from './maps/catalog.js';

import { createShell } from './ui/shell.js';
import { createPanel, button } from './ui/components.js';
import { el } from './core/dom.js';
import { createLayerPanel, createLayerInfoModal } from './ui/layerPanel.js';
import { createContextPanel } from './ui/contextPanel.js';
import {
  createAttributionModal,
  createHelpModal,
  createSettingsModal,
  createShareModal,
} from './ui/modals.js';

const bootStatus = document.getElementById('boot-status');
const bootRoot = document.getElementById('boot');

function progress(message) {
  if (bootStatus) bootStatus.textContent = message;
  console.info(`[boot] ${message}`);
}

function fail(error) {
  console.error("[boot] God's Eye View failed to start", error);
  if (bootStatus) {
    bootStatus.textContent = `Startup failed: ${error?.message || error}`;
    bootStatus.classList.add('is-error');
  }
}

async function start() {
  /* ------------------------------- core state ---------------------------- */

  progress('Reading preferences…');
  const settings = createSettingsStore();
  const events = createEventBus();
  const store = createStore({
    mapStack: settings.get('lastMapStack') || 'esri-imagery',
    terrain: settings.get('lastTerrain') || 'auto',
    photoreal: false,
    style: 'normal',
    clean: false,
    hud: settings.get('showHud'),
    overlay: OVERLAY_MODES.SELECTED,
  });

  if (settings.get('cesiumIonToken')) {
    Cesium.Ion.defaultAccessToken = settings.get('cesiumIonToken');
  }
  if (settings.get('reduceMotion')) {
    document.documentElement.classList.add('gev-reduce-motion');
  }

  /* -------------------------------- globe ------------------------------- */

  progress('Creating the globe engine…');
  const container = document.getElementById('cesium-container');
  const creditContainer = document.getElementById('gev-credits');

  // Belt-and-braces: `public/cesium-base.js` normally sets this first (it is a
  // classic script in <head>, so it runs before this module). Setting it again
  // here guards against a reordered document. Cesium reads the global lazily
  // inside buildModuleUrl(), which is why a statement this late is still safe.
  if (typeof window !== 'undefined' && !window.CESIUM_BASE_URL) {
    window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;
  }

  const viewer = new Cesium.Viewer(container, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    creditContainer,
    contextOptions: { requestWebgl2: true },
  });

  // Dark operational presentation.
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#050a12');
  viewer.scene.globe.showGroundAtmosphere = true;
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.skyAtmosphere.hueShift = -0.04;
  viewer.scene.skyAtmosphere.saturationShift = -0.08;
  viewer.scene.fog.enabled = true;
  viewer.scene.globe.showWaterEffect = false;
  viewer.scene.sun.show = true;
  viewer.scene.moon.show = false;
  viewer.scene.skyBox.show = true;
  viewer.scene.highDynamicRange = false;
  viewer.scene.screenSpaceCameraController.enableTilt = true;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 200;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 38_000_000;
  viewer.targetFrameRate = 60;

  const sceneState = { imagery: null, terrain: null, photoreal: null };
  const mapController = createMapController({
    viewer,
    settings,
    onStatus: (payload) => {
      sceneState[payload.kind] = payload;
      events.emit('map:status', payload);
      if (!payload.ok && payload.message) {
        console.warn(`[map:${payload.kind}] ${payload.message}`);
      }
    },
  });

  progress('Loading imagery and terrain…');
  await mapController.setImagery(store.get().mapStack);
  await mapController.setTerrain(store.get().terrain);

  /* -------------------------------- camera ------------------------------ */

  const camera = createCameraController({
    viewer,
    onIdle: (focus) => {
      events.emit('camera:idle', focus);
      for (const layer of layers) layer.onCameraSettled?.();
    },
  });

  /* ------------------------------- layers ------------------------------- */

  progress('Registering data layers…');
  const layers = buildLayers();
  const layerIds = layers.map((layer) => layer.id);
  const surface = {
    viewer,
    settings,
    store,
    camera,
    events,
    http,
    overpassIndex: 0,
  };
  for (const layer of layers) {
    try {
      layer.attach(surface);
    } catch (error) {
      console.error(`[layer:${layer.id}] failed to attach`, error);
    }
  }

  /* ------------------------------ selection ----------------------------- */

  const selection = createSelectionManager({
    viewer,
    layers: () => layers,
    followTarget: (getPosition) => camera.followTrack({ getPosition }),
    events,
  });

  /* -------------------------------- tools ------------------------------- */

  const effects = createVisualEffects({ viewer });
  const overlay = createOverlay({
    canvas: document.getElementById('gev-overlay'),
    viewer,
    layers: () => layers,
    selection,
  });
  overlay.start();

  const annotationStore = createAnnotationStore();
  const annotations = createAnnotationRenderer({ viewer, store: annotationStore });

  const director = createDirector({ camera, viewer, layers: () => layers, onShot: (shot) => events.emit('director:shot', shot) });

  /* -------------------------------- shell ------------------------------- */

  progress('Building the console…');
  const root = document.getElementById('app');
  const shell = createShell({ root, events });

  const layersPanel = createPanel({ id: 'panel-layers', title: 'Data layers', icon: 'layers' });
  const contextPanel = createPanel({ id: 'panel-context', title: 'Selection', icon: 'target' });
  root.append(layersPanel.root, contextPanel.root);

  const layerInfo = createLayerInfoModal({ layers: () => layers, settings, onRoute: routeCustomControl });
  const context = createContextPanel({
    panel: contextPanel,
    selection,
    camera,
    layers: () => layers,
    events,
    toast: shell.toasts,
  });

  const layerControls = createLayerPanel({
    panel: layersPanel,
    groups: groupLayers(layers),
    onOpenInfo: (layer) => layerInfo.open(layer),
  });
  layerControls.clear = layerControls.clearAll;

  const settingsModal = createSettingsModal({
    settings,
    mapController,
    store,
    toast: shell.toasts,
    onRestartNeeded: () => shell.toasts.show('Reload the page to apply the reset.', { tone: 'warn' }),
  });
  const attributionModal = createAttributionModal({ layers: () => layers });
  const helpModal = createHelpModal();
  const shareModal = createShareModal({
    state: collectState,
    catalog: () => layerIds,
    toast: shell.toasts,
  });

  /* ------------------------------ tool clusters -------------------------- */

  shell.buildNavCluster([
    { icon: 'zoomIn', label: 'Zoom in (+)', onClick: () => camera.zoomIn() },
    { icon: 'zoomOut', label: 'Zoom out (−)', onClick: () => camera.zoomOut() },
    { icon: 'reset', label: 'Reset camera to whole Earth (R)', onClick: () => camera.reset() },
    { icon: 'crosshair', label: 'Look straight down', onClick: () => camera.topDown() },
    { icon: 'chevronLeft', label: 'Orbit left ([)', onClick: () => camera.orbit(-45) },
    { icon: 'chevronRight', label: 'Orbit right (])', onClick: () => camera.orbit(45) },
    { icon: 'mapPin', label: 'Draw a point', onClick: () => setDrawMode(DRAW_MODES.POINT) },
    { icon: 'route', label: 'Draw a line', onClick: () => setDrawMode(DRAW_MODES.LINE) },
    { icon: 'pentagon', label: 'Draw a polygon', onClick: () => setDrawMode(DRAW_MODES.POLYGON) },
    { icon: 'ruler', label: 'Measure a distance', onClick: () => setDrawMode(DRAW_MODES.MEASURE) },
    { icon: 'trash', label: 'Clear annotations', onClick: () => annotationStore.clear() },
    { icon: 'play', label: 'Play camera tour', onClick: () => toggleTour() },
  ]);

  shell.buildViewCluster(store.get().style, (styleId) => setStyle(styleId));

  /* ------------------------------- actions ------------------------------ */

  function setStyle(styleId) {
    const applied = effects.setStyle(styleId);
    store.patch({ style: applied });
    shell.highlightStyle(applied);
    if (applied !== styleId) {
      shell.toasts.show(`“${styleId}” could not be compiled on this device — kept ${applied}.`, { tone: 'warn' });
    }
  }

  function toggleHud(force) {
    const next = force === undefined ? !store.get().hud : force;
    store.patch({ hud: next });
    shell.hud.classList.toggle('is-hidden', !next);
    shell.buttons.hud.classList.toggle('btn--on', next);
  }

  function toggleClean(force) {
    const next = force === undefined ? !store.get().clean : force;
    store.patch({ clean: next });
    root.classList.toggle('is-clean', next);
    shell.buttons.clean.classList.toggle('btn--on', next);
  }

  let drawMode = DRAW_MODES.NONE;
  function setDrawMode(mode) {
    drawMode = drawMode === mode ? DRAW_MODES.NONE : mode;
    annotations.setMode(drawMode);
    shell.toasts.show(
      drawMode === DRAW_MODES.NONE
        ? 'Drawing cancelled.'
        : `Click the globe to place vertices. Double-click to finish.`,
      { tone: 'ok', timeout: 3000, key: 'draw' },
    );
  }

  let tourPlaying = false;
  function toggleTour() {
    if (tourPlaying) {
      director.stop();
      tourPlaying = false;
      shell.toasts.show('Camera tour stopped.', { tone: 'ok', timeout: 2500 });
    } else {
      director.play();
      tourPlaying = true;
      shell.toasts.show('Camera tour running. Press Esc to stop.', { tone: 'ok', timeout: 3000 });
    }
  }

  function routeCustomControl(kind, context_) {
    if (kind !== 'routing') return;
    const host = context_.container;
    host.append(
      el('div', { class: 'chips' },
        button({
          label: 'Add waypoint at camera',
          icon: 'mapPin',
          className: 'btn btn--sm',
          onClick: () => {
            const focus = camera.focus();
            const waypoints = context_.layer.addWaypoint(focus);
            shell.toasts.show(`Waypoint ${waypoints.length} added.`, { tone: 'ok', timeout: 2200 });
          },
        }),
        button({
          label: 'Clear',
          icon: 'trash',
          className: 'btn btn--sm btn--danger',
          onClick: () => context_.layer.clearWaypoints(),
        }),
        button({
          label: 'Compute route',
          icon: 'route',
          className: 'btn btn--sm btn--primary',
          onClick: async () => {
            const result = await context_.layer.compute();
            if (!result) return;
            shell.toasts.show(
              result.estimated
                ? `Routing unavailable (${result.error || 'unknown'}). Showing a straight-line estimate.`
                : `Route: ${formatKm(result.route.distanceM)} · ${Math.round((result.route.durationS || 0) / 60)} min`,
              { tone: result.estimated ? 'warn' : 'ok', timeout: 6000 },
            );
          },
        }),
      ),
    );
  }

  function formatKm(metres) {
    return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
  }

  /* ------------------------------- search ------------------------------- */

  let searchAbort = null;
  let searchTimer = null;

  shell.searchInput.addEventListener('input', (event) => {
    const query = event.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (query.length < 2) {
      shell.results.classList.add('is-closed');
      return;
    }
    searchTimer = setTimeout(() => runSearch(query), 320);
  });

  shell.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const query = shell.searchInput.value.trim();
      if (query) runSearch(query);
    }
    if (event.key === 'Escape') {
      shell.results.classList.add('is-closed');
      shell.searchInput.blur();
    }
  });

  async function runSearch(query) {
    shell.results.classList.remove('is-closed');
    shell.results.render(el('div', { class: 'ctx-empty', text: 'Searching…' }));
    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    try {
      const found = await searchPlaces(query, { signal: controller.signal, limit: 8 });
      if (!found.length) {
        shell.results.render(el('div', { class: 'ctx-empty', text: `No place matched “${query}”. Try coordinates such as 35.68, 139.69.` }));
        return;
      }
      const list = el('div', { class: 'result-list' });
      for (const place of found) {
        list.append(
          el('button', {
            class: 'result-row',
            type: 'button',
            onclick: () => {
              const height = zoomToHeight(place.zoom ?? 12);
              camera.flyTo({ lat: place.lat, lon: place.lon, heightM: height });
              shell.results.classList.add('is-closed');
              shell.searchInput.value = place.name;
            },
          },
            el('span', { class: 'result-row__main' },
              el('span', { class: 'result-row__name', text: place.name }),
              el('span', { class: 'result-row__sub', text: place.displayName || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}` }),
            ),
            el('span', { class: 'badge badge--idle', text: place.kind }),
          ),
        );
      }
      shell.results.render(list);
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;
      shell.results.render(
        el('div', { class: 'ctx-empty', text: `Search failed: ${error?.message || error}. Both Photon and Nominatim were unreachable or blocked.` }),
      );
    }
  }

  function zoomToHeight(zoom) {
    return Math.round(156543.03392 * 256 / 2 ** Math.max(1, Math.min(20, zoom)) * 0.6);
  }

  /* -------------------------------- voice ------------------------------- */

  const voice = createSpeechController({
    vocabulary: { layerAliases: buildLayerAliases(layers), styleIds: VISUAL_STYLES.map((style) => style.id) },
    onTranscript: (transcript) => shell.toasts.show(`Heard: “${transcript}”`, { timeout: 3000, key: 'voice' }),
    onStatus: ({ listening, error }) => {
      shell.buttons.voice.classList.toggle('btn--on', listening);
      if (error) shell.toasts.show(error, { tone: 'warn', timeout: 7000 });
    },
    onIntent: async (intent) => {
      const result = await executeIntent(intent);
      if (result) shell.toasts.show(describeResult(intent.intent, result), { tone: result.ok ? 'ok' : 'warn', timeout: 4200 });
    },
  });

  async function executeIntent(intent) {
    switch (intent.intent) {
      case INTENTS.FLY_TO: {
        const found = await searchPlaces(intent.query, { limit: 1 }).catch(() => []);
        const place = found[0];
        if (!place) return { ok: false, message: `I could not find “${intent.query}”.` };
        camera.flyTo({ lat: place.lat, lon: place.lon, heightM: zoomToHeight(place.zoom ?? 11) });
        return { ok: true, label: place.name };
      }
      case INTENTS.SET_LAYER: {
        const layer = layers.find((entry) => entry.id === intent.layerId);
        if (!layer) return { ok: false, message: 'I did not recognise that layer.' };
        const enabled = intent.enabled === null ? !layer.visible : intent.enabled;
        if (enabled) layer.show();
        else layer.hide();
        return { ok: true, label: layer.name, enabled };
      }
      case INTENTS.STYLE: {
        setStyle(intent.style);
        return { ok: true, label: VISUAL_STYLES.find((style) => style.id === intent.style)?.label || intent.style };
      }
      case INTENTS.CAMERA: {
        switch (intent.action) {
          case 'reset': camera.reset(); return { ok: true, message: 'Camera reset to the whole Earth.' };
          case 'zoom-in': camera.zoomIn(); return { ok: true, message: 'Zoomed in.' };
          case 'zoom-out': camera.zoomOut(); return { ok: true, message: 'Zoomed out.' };
          case 'top-down': camera.topDown(); return { ok: true, message: 'Looking straight down.' };
          case 'orbit': camera.orbit(intent.degrees); return { ok: true, message: `Orbiting ${intent.degrees > 0 ? 'right' : 'left'}.` };
          default: return { ok: false, message: 'That camera action is not supported.' };
        }
      }
      case INTENTS.TRACK: {
        if (!selection.current) return { ok: false, message: 'Nothing is selected to track.' };
        selection.setFollow(intent.enabled !== false);
        return { ok: true, enabled: intent.enabled !== false, label: selection.current.recordId };
      }
      case INTENTS.REFRESH: {
        layerControls.refreshVisible();
        return { ok: true };
      }
      case INTENTS.SHARE: {
        writeHash(encodeShareLink(collectState(), layerIds));
        try {
          await navigator.clipboard.writeText(window.location.href);
          return { ok: true };
        } catch {
          return { ok: false, message: 'The link is in the address bar, but the clipboard was blocked.' };
        }
      }
      case INTENTS.CLEAN: {
        toggleClean(intent.enabled);
        return { ok: true, enabled: intent.enabled };
      }
      case INTENTS.DESCRIBE: {
        const described = context.describe();
        if (!described) return { ok: false, message: 'Nothing is selected.' };
        return { ok: true, message: `${described.title || described.record} on the ${described.layer} layer.` };
      }
      case INTENTS.HELP:
        return { ok: true };
      default:
        return { ok: false, message: `I did not understand “${intent.reason || ''}”. Say “help”.` };
    }
  }

  /* ------------------------------ top bar wiring ------------------------- */

  shell.buttons.layers.onclick = () => {
    layersPanel.toggle();
    shell.buttons.layers.classList.toggle('btn--on', layersPanel.isOpen);
  };
  shell.buttons.context.onclick = () => {
    contextPanel.toggle();
    shell.buttons.context.classList.toggle('btn--on', contextPanel.isOpen);
  };
  shell.buttons.settings.onclick = () => settingsModal.open();
  shell.buttons.attribution.onclick = () => attributionModal.open();
  shell.buttons.share.onclick = () => shareModal.open();
  shell.buttons.hud.onclick = () => toggleHud();
  shell.buttons.clean.onclick = () => toggleClean();
  shell.buttons.voice.onclick = () => {
    if (!voice.supported) {
      shell.toasts.show(voice.unsupportedReason, { tone: 'warn', timeout: 9000 });
      return;
    }
    voice.toggle();
  };
  shell.buttons.display.onclick = () => {
    const index = VISUAL_STYLES.findIndex((style) => style.id === store.get().style);
    setStyle(VISUAL_STYLES[(index + 1) % VISUAL_STYLES.length].id);
  };

  /* ------------------------------ keyboard ------------------------------ */

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

    if ((event.key === '/' || (event.ctrlKey && event.key === 'k')) && !typing) {
      event.preventDefault();
      shell.searchInput.focus();
      return;
    }
    if (typing) return;

    switch (event.key) {
      case 'Escape':
        if (store.get().clean) toggleClean(false);
        else if (tourPlaying) toggleTour();
        else if (drawMode !== DRAW_MODES.NONE) setDrawMode(DRAW_MODES.NONE);
        else selection.clear();
        break;
      case 'l': case 'L': shell.buttons.layers.click(); break;
      case 'c': case 'C': shell.buttons.context.click(); break;
      case 'h': case 'H': toggleHud(); break;
      case 'r': case 'R': camera.reset(); break;
      case 'p': case 'P': toggleClean(); break;
      case 'v': case 'V': shell.buttons.voice.click(); break;
      case 's': case 'S': shareModal.open(); break;
      case ',': settingsModal.open(); break;
      case 'd': case 'D': {
        const next = store.get().overlay === OVERLAY_MODES.SELECTED ? OVERLAY_MODES.OFF : OVERLAY_MODES.SELECTED;
        store.patch({ overlay: next });
        overlay.setMode(next);
        shell.toasts.show(next === OVERLAY_MODES.OFF ? 'Detection brackets off.' : 'Detection brackets on the selection.', { timeout: 2200 });
        break;
      }
      case '+': case '=': camera.zoomIn(); break;
      case '-': case '_': camera.zoomOut(); break;
      case '[': camera.orbit(-45); break;
      case ']': camera.orbit(45); break;
      default: {
        const digit = Number(event.key);
        if (Number.isInteger(digit) && digit >= 0 && digit <= 9 && digit < VISUAL_STYLES.length) {
          setStyle(VISUAL_STYLES[digit].id);
        }
      }
    }
  });

  /* ------------------------------ telemetry ----------------------------- */

  let frames = 0;
  let lastFpsAt = performance.now();
  viewer.scene.postRender.addEventListener(() => {
    frames += 1;
  });

  setInterval(() => {
    const now = performance.now();
    const fps = (frames * 1000) / Math.max(1, now - lastFpsAt);
    frames = 0;
    lastFpsAt = now;

    const visible = layers.filter((layer) => layer.visible);
    const contacts = visible.reduce((total, layer) => total + (layer.count || 0), 0);
    const blocked = visible.filter((layer) => ['blocked', 'error', 'offline', 'config-required', 'unavailable'].includes(layer.status)).length;
    const sourceSummary = !visible.length
      ? 'idle'
      : blocked
        ? `${visible.length - blocked}/${visible.length} ok`
        : `${visible.length} live`;

    shell.setTelemetry({
      focus: camera.focus(),
      layersOn: visible.length,
      contacts,
      fps,
      sourceSummary,
    });

    if (store.get().hud) {
      const focus = camera.focus();
      shell.setHud(
        `${focus.lat.toFixed(4)}  ${focus.lon.toFixed(4)}  ·  ALT ${formatKm(focus.heightM)}  ·  HDG ${Math.round(focus.heading)}°  ·  PITCH ${Math.round(focus.pitch)}°  ·  ${visible.length} LAYERS  ·  ${contacts} CONTACTS`,
      );
    }
    selection.refresh();
  }, 1000);

  /* ------------------------------- scheduler ---------------------------- */

  const scheduler = createRefreshScheduler({ layers: () => layers });
  scheduler.start();

  /* --------------------------- preferences wiring ------------------------ */

  settings.subscribe((values, key) => {
    if (key === 'showLabels' || key === 'labelDensity') {
      const budget = values.showLabels ? labelBudgetFor(values.labelDensity) : 0;
      for (const layer of layers) layer.setLabelBudget?.(budget);
    }
    if (key === 'cesiumIonToken') {
      Cesium.Ion.defaultAccessToken = values.cesiumIonToken || undefined;
      mapController.refreshTerrain();
    }
  });

  store.subscribe((state, keys) => {
    if (keys.has('mapStack')) settings.set('lastMapStack', state.mapStack);
    if (keys.has('terrain')) settings.set('lastTerrain', state.terrain);
  });

  events.on('radio:error', (message) => shell.toasts.show(message, { tone: 'error', timeout: 7000 }));
  events.on('radio:playing', (station) => shell.toasts.show(`Playing ${station.name}`, { tone: 'ok', timeout: 3500 }));
  events.on('vessels:status', (status) => {
    if (status.message) console.info(`[vessels] ${status.message}`);
  });
  events.on('map:status', (payload) => {
    if (payload.kind === 'terrain' && payload.ok) {
      shell.toasts.show(`Terrain: ${payload.label}${payload.reason ? ` — ${payload.reason}` : ''}`, { timeout: 4000 });
    }
  });

  /* ------------------------------ share state --------------------------- */

  function collectState() {
    return {
      camera: {
        lat: camera.focus().lat,
        lon: camera.focus().lon,
        heightM: camera.focus().heightM,
        heading: camera.focus().heading,
        pitch: camera.focus().pitch,
      },
      style: store.get().style,
      layers: layers.filter((layer) => layer.visible).map((layer) => layer.id),
      selection: selection.serialize(),
      hud: store.get().hud,
      clean: store.get().clean,
      mapStack: store.get().mapStack,
      terrain: store.get().terrain,
    };
  }

  let shareDebounce = null;
  setInterval(() => {
    if (shareDebounce) clearTimeout(shareDebounce);
    shareDebounce = setTimeout(() => {
      try {
        writeHash(encodeShareLink(collectState(), layerIds));
      } catch (error) {
        // A share link is a convenience; never let it break the console.
        console.warn('[share] could not update the URL hash', error);
      }
    }, 900);
  }, 2500);

  /* --------------------------- restore from hash ------------------------- */

  const restored = decodeShareLink(readHash(), layerIds, {
    knownMapStacks: listImageryStacks().map((stack) => stack.id),
    knownTerrains: listTerrainStacks().map((stack) => stack.id),
  });

  if (restored) {
    if (restored.mapStack && restored.mapStack !== store.get().mapStack) {
      store.patch({ mapStack: restored.mapStack });
      await mapController.setImagery(restored.mapStack);
    }
    if (restored.terrain && restored.terrain !== store.get().terrain) {
      store.patch({ terrain: restored.terrain });
      await mapController.setTerrain(restored.terrain);
    }
    if (restored.style) setStyle(restored.style);
    if (restored.hud) toggleHud(true);
    if (restored.clean) toggleClean(true);
    if (restored.layers?.length) {
      for (const layer of layers) {
        if (restored.layers.includes(layer.id)) layer.show();
      }
    }
    if (restored.camera) camera.restore(restored.camera, { animate: false });
    if (restored.selection) {
      const layer = layers.find((entry) => entry.id === restored.selection.layerId);
      if (layer) {
        // The record only exists once the layer has fetched, so retry briefly.
        let attempts = 0;
        const trySelect = setInterval(() => {
          attempts += 1;
          const ok = selection.select(layer, restored.selection.recordId, { flyTo: false });
          if (ok || attempts > 20) clearInterval(trySelect);
        }, 500);
      }
    }
    shell.toasts.show('Restored a shared view.', { tone: 'ok', timeout: 4000 });
  } else {
    camera.restore({ lat: 20, lon: 0, h: 21_000_000, hdg: 0, pch: -90 }, { animate: false });
  }

  /* ------------------------------ first paint --------------------------- */

  layersPanel.show();
  contextPanel.show();
  shell.buttons.layers.classList.add('btn--on');
  shell.buttons.context.classList.add('btn--on');
  shell.setTelemetry({ focus: camera.focus(), layersOn: 0, contacts: 0, fps: 60, sourceSummary: 'idle' });

  progress('Ready.');
  setTimeout(() => {
    bootRoot?.classList.add('is-hidden');
    setTimeout(() => bootRoot?.remove(), 600);
  }, 350);

  shell.toasts.show(
    'Independent community build. Every layer states whether its data is live, sample, or unavailable — check the Data sources button for attribution.',
    { tone: 'info', timeout: 9000 },
  );

  /* ------------------------------- teardown ----------------------------- */

  window.addEventListener('pagehide', () => {
    scheduler.stop();
    voice.dispose();
    overlay.dispose();
    annotations.dispose();
    director.dispose();
    selection.dispose();
    camera.dispose();
    effects.dispose();
    mapController.dispose();
    for (const layer of layers) layer.dispose();
    if (!viewer.isDestroyed()) viewer.destroy();
  });

  // Exposed for manual verification from the browser console.
  window.__gev = { viewer, layers, camera, selection, settings, store, effects, annotations, director, voice, shell };
}

start().catch(fail);
