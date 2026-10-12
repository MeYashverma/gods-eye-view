/**
 * Local preferences and provider credentials.
 *
 * Storage policy:
 *  - Values live in localStorage only, under one namespaced key.
 *  - Credential-bearing fields are marked SECRET and are never written to a
 *    URL, never logged, and never included in exported reports or share links.
 *  - A key placed here is a *browser-visible* key by definition. This module
 *    says so out loud in the UI, because "stored in settings" is not the same
 *    thing as "secret". Only provider credentials that the provider documents
 *    for client-side use belong here.
 */

const STORAGE_KEY = 'gev:settings:v1';

export const SETTING_FIELDS = Object.freeze([
  {
    id: 'cesiumIonToken',
    label: 'Cesium ion token',
    secret: false,
    provider: 'Cesium ion',
    docs: 'https://ion.cesium.com/tokens',
    hint: 'Unlocks Cesium World Terrain and Bing imagery. The app runs without it on a free keyless imagery and terrain fallback.',
  },
  {
    id: 'googleMapsKey',
    label: 'Google Maps API key',
    secret: false,
    provider: 'Google Maps Platform',
    docs: 'https://developers.google.com/maps/documentation/tile',
    hint: 'Optional. Enables Google Photorealistic 3D Tiles. Google keys are billed to you and are browser-visible — restrict them to your Pages origin.',
  },
  {
    id: 'mapillaryToken',
    label: 'Mapillary client token',
    secret: false,
    provider: 'Mapillary',
    docs: 'https://www.mapillary.com/dashboard/developers',
    hint: 'Optional. Client-side access token, as documented by Mapillary. Enables the Street Level viewer.',
  },
  {
    id: 'aisStreamKey',
    label: 'AISStream.io API key',
    secret: true,
    provider: 'AISStream.io',
    docs: 'https://aisstream.io',
    hint: 'Optional free key. AISStream is a browser WebSocket service, so the key is client-side by design. Restrict it in the AISStream dashboard.',
  },
  {
    id: 'firmsKey',
    label: 'NASA FIRMS (LANCE) API key',
    secret: true,
    provider: 'NASA FIRMS',
    docs: 'https://firms.modaps.eosdis.nasa.gov/api/area/map/',
    hint: 'Optional free key from NASA FIRMS. Enables near-real-time active fire detections.',
  },
  {
    id: 'adsbEndpoint',
    label: 'ADS-B endpoint (v2 / readsb JSON)',
    secret: false,
    provider: 'Your own receiver or proxy',
    docs: 'https://github.com/bilawalsidhu/gods-eye-view#readme',
    hint: 'A URL returning readsb/tar1090 `aircraft.json` or adsb.lol-compatible v2 JSON. Required because public ADS-B APIs do not send CORS headers, so a static site cannot read them directly.',
  },
  {
    id: 'osrmUrl',
    label: 'OSRM routing base URL',
    secret: false,
    provider: 'OSRM',
    docs: 'https://project-osrm.org/',
    hint: 'Optional. Defaults to the public demo router, which asks for light interactive use. Point this at your own OSRM for heavier use.',
  },
]);

export const SECRET_FIELDS = new Set(
  SETTING_FIELDS.filter((field) => field.secret).map((field) => field.id),
);

const DEFAULTS = Object.freeze({
  cesiumIonToken: '',
  googleMapsKey: '',
  mapillaryToken: '',
  aisStreamKey: '',
  firmsKey: '',
  adsbEndpoint: '',
  osrmUrl: '',
  aircraftDemoMode: false,
  reduceMotion: false,
  showLabels: true,
  showHud: false,
  labelDensity: 'balanced',
  lastMapStack: 'esri-imagery',
  lastTerrain: 'auto',
});

/** Redact a settings object for logging/export. */
export function redactSettings(settings) {
  const out = { ...settings };
  for (const key of SECRET_FIELDS) {
    if (out[key]) out[key] = '[redacted]';
  }
  return out;
}

export function createSettingsStore({ storage = safeLocalStorage(), initial = {} } = {}) {
  let settings = { ...DEFAULTS, ...initial };
  const listeners = new Set();

  function persist() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // Private-mode browsers can throw on quota or access. Preferences are a
      // convenience, so a failure here must not break the app.
      console.warn('[settings] could not persist preferences', error);
    }
  }

  function emit(key) {
    for (const listener of [...listeners]) {
      try {
        listener(settings, key);
      } catch (error) {
        console.error('[settings] listener failed', error);
      }
    }
  }

  // Hydrate once. Malformed JSON is discarded rather than trusted.
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        settings = { ...settings, ...pickKnown(parsed) };
      }
    }
  } catch {
    /* ignore unreadable storage */
  }

  return {
    get: (id) => (id === undefined ? { ...settings } : settings[id]),
    has: (id) => Boolean(String(settings[id] ?? '').trim()),
    set(id, value) {
      if (!(id in DEFAULTS)) {
        console.warn(`[settings] ignoring unknown setting "${id}"`);
        return settings[id];
      }
      if (settings[id] === value) return settings[id];
      settings = { ...settings, [id]: value };
      persist();
      emit(id);
      return value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Redacted snapshot, safe for a status report or a console dump. */
    export: () => redactSettings(settings),
    reset() {
      settings = { ...DEFAULTS };
      persist();
      emit(null);
    },
    get fields() {
      return SETTING_FIELDS;
    },
  };
}

function pickKnown(input) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key in input) out[key] = input[key];
  }
  return out;
}

function safeLocalStorage() {
  try {
    const probe = '__gev_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export { DEFAULTS as SETTINGS_DEFAULTS, STORAGE_KEY };
