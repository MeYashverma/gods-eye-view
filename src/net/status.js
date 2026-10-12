/**
 * The honest status model.
 *
 * Every layer publishes exactly one of these states and the UI renders it.
 * The point is that a toggle changing state is not evidence that data arrived:
 * a source that is blocked by CORS, a source that needs a key the user has not
 * supplied, a source that answered with zero rows, and a source serving
 * bundled sample data are four different things and are labelled as four
 * different things.
 */

export const LAYER_STATUS = Object.freeze({
  IDLE: 'idle',
  OFF: 'off',
  LOADING: 'loading',
  LIVE: 'live',
  STALE: 'stale',
  EMPTY: 'empty',
  ERROR: 'error',
  BLOCKED: 'blocked',
  OFFLINE: 'offline',
  RATE_LIMITED: 'rate-limited',
  CONFIG_REQUIRED: 'config-required',
  UNAVAILABLE: 'unavailable',
  SIMULATED: 'simulated',
});

/** Tones drive both the CSS class and the dot colour. */
const TONES = Object.freeze({
  [LAYER_STATUS.IDLE]: 'idle',
  [LAYER_STATUS.OFF]: 'off',
  [LAYER_STATUS.LOADING]: 'loading',
  [LAYER_STATUS.LIVE]: 'live',
  [LAYER_STATUS.STALE]: 'stale',
  [LAYER_STATUS.EMPTY]: 'empty',
  [LAYER_STATUS.ERROR]: 'error',
  [LAYER_STATUS.BLOCKED]: 'blocked',
  [LAYER_STATUS.OFFLINE]: 'error',
  [LAYER_STATUS.RATE_LIMITED]: 'stale',
  [LAYER_STATUS.CONFIG_REQUIRED]: 'config',
  [LAYER_STATUS.UNAVAILABLE]: 'error',
  [LAYER_STATUS.SIMULATED]: 'demo',
});

const LABELS = Object.freeze({
  [LAYER_STATUS.IDLE]: 'Ready',
  [LAYER_STATUS.OFF]: 'Off',
  [LAYER_STATUS.LOADING]: 'Loading',
  [LAYER_STATUS.LIVE]: 'Live',
  [LAYER_STATUS.STALE]: 'Stale',
  [LAYER_STATUS.EMPTY]: 'No data',
  [LAYER_STATUS.ERROR]: 'Error',
  [LAYER_STATUS.BLOCKED]: 'Blocked',
  [LAYER_STATUS.OFFLINE]: 'Offline',
  [LAYER_STATUS.RATE_LIMITED]: 'Rate limit',
  [LAYER_STATUS.CONFIG_REQUIRED]: 'Needs setup',
  [LAYER_STATUS.UNAVAILABLE]: 'Unavailable',
  [LAYER_STATUS.SIMULATED]: 'Sample data',
});

/** True when the layer is showing data that is not current. */
export const IS_DATA_STATE = new Set([
  LAYER_STATUS.LIVE,
  LAYER_STATUS.STALE,
  LAYER_STATUS.EMPTY,
  LAYER_STATUS.SIMULATED,
]);

export function statusTone(status) {
  return TONES[status] || 'idle';
}

export function statusLabel(status) {
  return LABELS[status] || 'Unknown';
}

/** True when the state means "real observations are on the globe right now". */
export function hasLiveData(status) {
  return status === LAYER_STATUS.LIVE || status === LAYER_STATUS.STALE;
}

/**
 * Map an HttpError kind onto a layer status. Kept here so adapters do not each
 * invent their own mapping.
 */
export function statusFromFailureKind(kind) {
  switch (kind) {
    case 'cors':
      return LAYER_STATUS.BLOCKED;
    case 'offline':
      return LAYER_STATUS.OFFLINE;
    case 'rate-limit':
      return LAYER_STATUS.RATE_LIMITED;
    case 'timeout':
    case 'network':
    case 'http':
    case 'parse':
      return LAYER_STATUS.ERROR;
    case 'config':
      return LAYER_STATUS.CONFIG_REQUIRED;
    default:
      return LAYER_STATUS.ERROR;
  }
}

/**
 * Freshness verdict for a timestamped feed.
 * @param {number} fetchedAt epoch ms of the last successful fetch
 * @param {number} [now]
 * @param {{freshMs?:number, staleMs?:number}} policy
 */
export function evaluateFreshness(fetchedAt, now = Date.now(), { freshMs = 60_000, staleMs = 300_000 } = {}) {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return LAYER_STATUS.IDLE;
  const age = now - fetchedAt;
  // Past `staleMs` the records are still drawn, so the honest label stays
  // "stale"; a layer only leaves that state when its adapter reports a failure.
  return age <= freshMs ? LAYER_STATUS.LIVE : LAYER_STATUS.STALE;
}

/** "12s ago", "4m ago", "2h ago" — bounded so the readout never grows. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** UTC clock string used across the HUD and telemetry strip. */
export function formatUtc(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function formatUtcDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (entry) => String(entry).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}
