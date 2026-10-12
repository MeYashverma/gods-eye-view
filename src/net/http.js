/**
 * The one HTTP path every provider adapter goes through.
 *
 * Static hosting means the browser talks to third-party providers directly, so
 * this module has to carry the responsibilities a backend would normally own:
 * timeouts, cancellation, bounded retries with backoff, response caching,
 * duplicate-request coalescing, per-host rate limiting, and — critically —
 * telling the difference between "the provider is down", "the provider
 * refused our origin (CORS)", "we are offline" and "the provider returned an
 * empty but valid answer". Layers surface that distinction to the user
 * instead of silently drawing nothing.
 */

export const FAILURE_KIND = Object.freeze({
  TIMEOUT: 'timeout',
  HTTP: 'http',
  NETWORK: 'network',
  CORS: 'cors',
  PARSE: 'parse',
  ABORTED: 'aborted',
  OFFLINE: 'offline',
  RATE_LIMIT: 'rate-limit',
  CONFIG: 'config',
});

export class HttpError extends Error {
  constructor(message, { kind = FAILURE_KIND.NETWORK, status = null, url = '', cause = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

export function isHttpError(value) {
  return value instanceof HttpError;
}

const DEFAULTS = Object.freeze({
  timeoutMs: 15000,
  retries: 2,
  backoffMs: 400,
  backoffMaxMs: 8000,
  cacheMs: 0,
  staleMs: 0,
  minIntervalMs: 0,
  headers: null,
  signal: null,
});

/** In-memory response cache with TTL plus an optional stale grace window. */
export function createCache({ maxEntries = 200 } = {}) {
  const entries = new Map();
  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return null;
      const age = now - entry.at;
      if (age <= entry.ttl) return { value: entry.value, stale: false, age };
      if (entry.staleTtl > 0 && age <= entry.ttl + entry.staleTtl) {
        return { value: entry.value, stale: true, age };
      }
      entries.delete(key);
      return null;
    },
    /**
     * Insertion-ordered (FIFO) eviction: when the cache is full the oldest
     * entry is dropped. A read does not extend an entry's life, which keeps the
     * bound honest for a polling app — the same viewport requested every few
     * seconds must not be able to pin one provider's responses forever.
     */
    set(key, value, ttl = 60_000, staleTtl = 0, now = Date.now()) {
      if (entries.size >= maxEntries && !entries.has(key)) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { value, at: now, ttl, staleTtl });
      return value;
    },
    has: (key) => entries.has(key),
    delete: (key) => entries.delete(key),
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

/** Exponential backoff with full jitter. Exported so tests can assert bounds. */
export function backoffDelay(attempt, baseMs = 400, maxMs = 8000, random = Math.random) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * exponential);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new HttpError('Request aborted while waiting to retry', { kind: FAILURE_KIND.ABORTED }));
      },
      { once: true },
    );
  });

/**
 * Classify a thrown fetch failure. Browsers expose CORS refusals as an opaque
 * TypeError with no status, which is indistinguishable from a DNS or socket
 * error at the JS layer — so `navigator.onLine` is the tie-breaker: if we are
 * offline the honest label is "offline", otherwise a cross-origin GET that
 * produced no response is almost always a missing CORS header, and telling the
 * user that is far more actionable than "network error".
 */
export function classifyFetchFailure(error, { url = '', online = true } = {}) {
  if (error?.name === 'AbortError') {
    return new HttpError('Request timed out or was cancelled', {
      kind: FAILURE_KIND.ABORTED,
      url,
      cause: error,
    });
  }
  if (!online) {
    return new HttpError('Browser is offline', { kind: FAILURE_KIND.OFFLINE, url, cause: error });
  }
  return new HttpError(
    'Request blocked — the provider sent no CORS header for this origin, or the host is unreachable',
    { kind: FAILURE_KIND.CORS, url, cause: error },
  );
}

/** Serialize a request into a cache key. */
export function cacheKey(url, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const body = typeof init.body === 'string' ? init.body : '';
  return `${method} ${url} ${body}`;
}

/**
 * Create a fetch client bound to one provider's policy.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {() => boolean} [options.isOnline] injectable for tests
 * @param {() => number} [options.now] injectable for tests
 */
export function createHttpClient(options = {}) {
  const {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    now = () => Date.now(),
    random = Math.random,
    userAgent = "gods-eye-view/1.0 (independent community implementation; static GitHub Pages host)",
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }

  const cache = createCache();
  const inflight = new Map();
  /** Per-host timestamp of the last dispatch, for polite minimum spacing. */
  const hostGate = new Map();

  async function waitForGate(host, minIntervalMs) {
    if (!minIntervalMs) return;
    const previous = hostGate.get(host) || 0;
    const target = previous + minIntervalMs;
    hostGate.set(host, Math.max(target, now()));
    const wait = target - now();
    if (wait > 0) await sleep(wait);
  }

  async function request(url, init = {}) {
    const config = { ...DEFAULTS, ...init };
    const method = (config.method || 'GET').toUpperCase();
    const requestInit = {
      method,
      headers: {
        Accept: config.accept || '*/*',
        ...config.headers,
      },
      cache: 'no-store',
    };
    if (config.body !== undefined) requestInit.body = config.body;

    const key = cacheKey(url, requestInit);

    if (method === 'GET' && config.cacheMs > 0) {
      const hit = cache.get(key, now());
      if (hit && !config.force) {
        return { data: hit.value, meta: { cached: true, stale: hit.stale, age: hit.age, url } };
      }
    }

    if (inflight.has(key) && !config.force) {
      return inflight.get(key);
    }

    const host = safeHost(url);
    const promise = (async () => {
      await waitForGate(host, config.minIntervalMs);
      let lastError = null;
      let timedOut = false;
      for (let attempt = 0; attempt <= config.retries; attempt += 1) {
        if (attempt > 0) await sleep(backoffDelay(attempt - 1, config.backoffMs, config.backoffMaxMs, random));
        if (config.signal?.aborted) {
          throw new HttpError('Request aborted', { kind: FAILURE_KIND.ABORTED, url });
        }
        try {
          lastError = null;
          timedOut = false;
          const controller = new AbortController();
          const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, config.timeoutMs);
          const onAbort = () => controller.abort();
          config.signal?.addEventListener('abort', onAbort, { once: true });
          let response;
          try {
            response = await fetchImpl(url, { ...requestInit, signal: controller.signal });
          } finally {
            clearTimeout(timer);
            config.signal?.removeEventListener('abort', onAbort);
          }

          if (response.status === 429 || response.status === 503) {
            lastError = new HttpError(`Provider rate-limited the request (HTTP ${response.status})`, {
              kind: FAILURE_KIND.RATE_LIMIT,
              status: response.status,
              url,
            });
            if (attempt < config.retries) continue;
            throw lastError;
          }
          if (!response.ok) {
            const error = new HttpError(`Provider returned HTTP ${response.status}`, {
              kind: FAILURE_KIND.HTTP,
              status: response.status,
              url,
            });
            if (response.status >= 500 && attempt < config.retries) {
              lastError = error;
              continue;
            }
            throw error;
          }

          const data = await readBody(response, config);
          if (method === 'GET' && config.cacheMs > 0) {
            cache.set(key, data, config.cacheMs, config.staleMs, now());
          }
          return { data, meta: { cached: false, stale: false, age: 0, url, status: response.status } };
        } catch (error) {
          if (error instanceof HttpError) {
            if (error.kind === FAILURE_KIND.ABORTED && config.signal?.aborted) throw error;
            lastError = error;
            // Timeouts and transient network faults are worth retrying; a hard
            // CORS or HTTP error will not fix itself.
            const retryable =
              error.kind === FAILURE_KIND.TIMEOUT ||
              error.kind === FAILURE_KIND.NETWORK ||
              error.kind === FAILURE_KIND.RATE_LIMIT;
            if (!retryable || attempt >= config.retries) throw error;
            continue;
          }
          lastError = classifyFetchFailure(error, { url, online: isOnline() });
          if (lastError.kind === FAILURE_KIND.ABORTED && config.signal?.aborted) throw lastError;
          if (lastError.kind === FAILURE_KIND.ABORTED && timedOut) {
            lastError = new HttpError(`Provider did not respond within ${config.timeoutMs} ms`, {
              kind: FAILURE_KIND.TIMEOUT,
              url,
              cause: error,
            });
          }
          if (attempt >= config.retries) throw lastError;
        }
      }
      throw lastError || new HttpError('Request failed', { kind: FAILURE_KIND.NETWORK, url });
    })();

    const tracked = promise.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  return {
    request,
    /** Fetch and parse JSON. */
    async json(url, init = {}) {
      return request(url, { ...init, responseType: 'json' });
    },
    /** Fetch as text. */
    async text(url, init = {}) {
      return request(url, { ...init, responseType: 'text' });
    },
    /** Fetch as an ArrayBuffer (GRIB, protobuf, images). */
    async arrayBuffer(url, init = {}) {
      return request(url, { ...init, responseType: 'arraybuffer' });
    },
    cache,
    get inflightCount() {
      return inflight.size;
    },
    clearCache: () => cache.clear(),
    /** Reset host spacing — used when the user explicitly hits refresh. */
    resetGates: () => hostGate.clear(),
    userAgent,
  };
}

function safeHost(url) {
  try {
    return new URL(url, 'https://local.invalid').host;
  } catch {
    return 'unknown';
  }
}

async function readBody(response, config) {
  const type = config.responseType || 'json';
  try {
    if (type === 'json') return await response.json();
    if (type === 'text') return await response.text();
    if (type === 'arraybuffer') return await response.arrayBuffer();
    if (type === 'blob') return await response.blob();
    return await response.text();
  } catch (error) {
    throw new HttpError(`Could not read the provider response as ${type}`, {
      kind: FAILURE_KIND.PARSE,
      status: response.status,
      url: response.url,
      cause: error,
    });
  }
}

/** Human-readable one-liner for a failure, shown in layer status rows. */
export function describeFailure(error) {
  if (!error) return 'Unknown error';
  if (error instanceof HttpError) {
    switch (error.kind) {
      case FAILURE_KIND.CORS:
        return 'Blocked by the browser (no CORS header from the provider). This source cannot be read directly from a static site.';
      case FAILURE_KIND.OFFLINE:
        return 'You appear to be offline.';
      case FAILURE_KIND.TIMEOUT:
      case FAILURE_KIND.ABORTED:
        return 'The provider did not respond in time.';
      case FAILURE_KIND.RATE_LIMIT:
        return 'The provider is rate-limiting requests. The layer will back off and retry.';
      case FAILURE_KIND.HTTP:
        return `Provider error (HTTP ${error.status}).`;
      case FAILURE_KIND.PARSE:
        return 'The provider response could not be parsed.';
      default:
        return error.message;
    }
  }
  return String(error?.message || error);
}

/** Shared client used by adapters that have no special policy. */
export const http = createHttpClient();
