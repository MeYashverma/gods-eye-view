/**
 * AISStream.io adapter — live maritime AIS over WebSocket.
 *
 * This one *does* work from a static page, because WebSockets are not subject
 * to the same-origin policy the way `fetch` is. It requires a free API key
 * from aisstream.io. That key is browser-visible by design (the service is
 * built for client applications), so the settings panel says so and links to
 * the dashboard where it can be restricted.
 *
 * Without a key the vessel layer reports CONFIG_REQUIRED. It does not pretend
 * to be receiving ships.
 */

const WS_URL = 'wss://stream.aisstream.io/v0/stream';

export const AIS_ENDPOINT = WS_URL;

/** The subscription message AISStream expects as its first frame. */
export function subscriptionMessage({ apiKey, bbox, messageTypes = ['PositionReport', 'ShipStaticData'] }) {
  return JSON.stringify({
    APIKey: apiKey,
    BoundingBoxes: [bbox],
    FilterMessageTypes: messageTypes,
  });
}

/** AISStream wants [[[south,west],[north,east]]]. */
export function aisBoundingBox(box) {
  return [
    [Number(box.south.toFixed(3)), Number(box.west.toFixed(3))],
    [Number(box.north.toFixed(3)), Number(box.east.toFixed(3))],
  ];
}

const SHIP_TYPES = Object.freeze({
  0: 'Not available',
  20: 'Wing in ground',
  30: 'Fishing',
  31: 'Towing',
  32: 'Towing >200m',
  33: 'Dredging',
  34: 'Diving',
  35: 'Military',
  36: 'Sailing',
  37: 'Pleasure craft',
  40: 'High speed craft',
  50: 'Pilot vessel',
  51: 'Search and rescue',
  52: 'Tug',
  53: 'Port tender',
  55: 'Law enforcement',
  60: 'Passenger',
  70: 'Cargo',
  71: 'Cargo (hazard A)',
  79: 'Cargo (no additional info)',
  80: 'Tanker',
  81: 'Tanker (hazard A)',
  89: 'Tanker (no additional info)',
  90: 'Other',
});

export function shipTypeLabel(typeCode) {
  const code = Number(typeCode);
  if (!Number.isFinite(code)) return null;
  if (SHIP_TYPES[code]) return SHIP_TYPES[code];
  const family = Math.floor(code / 10) * 10;
  return SHIP_TYPES[family] || `Type ${code}`;
}

export function vesselColor(typeCode) {
  const code = Number(typeCode) || 0;
  if (code >= 80 && code < 90) return '#f97316'; // tanker
  if (code >= 70 && code < 80) return '#38bdf8'; // cargo
  if (code >= 60 && code < 70) return '#a78bfa'; // passenger
  if (code >= 30 && code < 40) return '#4ade80'; // fishing / special
  if (code === 35 || code === 55 || code === 51) return '#f0645a'; // military / SAR / law
  if (code >= 50 && code < 60) return '#fbbf24'; // special craft
  return '#94a3b8';
}

/**
 * Reduce an AISStream frame into the app's vessel record shape.
 * Pure, so the parser is unit-tested against captured frames.
 */
export function normalizeAisMessage(message, previous = new Map()) {
  const meta = message?.MetaData;
  if (!meta) return null;
  const mmsi = String(meta.MMSI ?? '').trim();
  if (!mmsi) return null;

  const existing = previous.get(mmsi) || { id: `ais:${mmsi}`, mmsi };
  const lat = Number(message?.Message?.PositionReport?.Latitude ?? message?.Message?.StandardClassBCSPositionReport?.Latitude ?? existing.lat);
  const lon = Number(message?.Message?.PositionReport?.Longitude ?? message?.Message?.StandardClassBCSPositionReport?.Longitude ?? existing.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 91 || lon === 181) return null;

  const position = message?.Message?.PositionReport || message?.Message?.StandardClassBCSPositionReport;
  const staticData = message?.Message?.ShipStaticData;

  return {
    ...existing,
    id: `ais:${mmsi}`,
    mmsi,
    name: staticData?.Name?.trim() || existing.name || null,
    callSign: staticData?.CallSign?.trim() || existing.callSign || null,
    imo: staticData?.ImoNumber || existing.imo || null,
    shipType: staticData?.Type ?? existing.shipType ?? null,
    shipTypeLabel: shipTypeLabel(staticData?.Type ?? existing.shipType),
    destination: staticData?.Destination?.trim() || existing.destination || null,
    draughtM: staticData?.Draught ? staticData.Draught / 10 : existing.draughtM ?? null,
    lat,
    lon,
    speedKn: position?.Sog !== undefined && position.Sog !== 102.3 ? position.Sog : existing.speedKn ?? null,
    courseDeg: position?.Cog !== undefined && position.Cog !== 360 ? position.Cog : existing.courseDeg ?? null,
    headingDeg: position?.TrueHeading !== undefined && position.TrueHeading !== 511 ? position.TrueHeading : existing.headingDeg ?? null,
    navStatus: position?.NavigationalStatus ?? existing.navStatus ?? null,
    rateOfTurn: position?.RateOfTurn ?? existing.rateOfTurn ?? null,
    country: mmsiToMidCountry(mmsi),
    observedAt: meta.MmsiString ? Date.now() : Date.now(),
  };
}

/** First three digits of an MMSI are the Maritime Identification Digit. */
export function mmsiMid(mmsi) {
  const text = String(mmsi || '');
  return text.length >= 3 ? text.slice(0, 3) : null;
}

/** A small MID table: enough to be useful without shipping a 900-row file. */
const MID_TABLE = Object.freeze({
  '201': 'Greece', '211': 'Germany', '219': 'Denmark', '224': 'Spain', '226': 'France',
  '232': 'United Kingdom', '235': 'United Kingdom', '244': 'Netherlands', '245': 'Netherlands',
  '246': 'Netherlands', '247': 'Italy', '249': 'Malta', '255': 'Portugal', '256': 'Cyprus',
  '259': 'Norway', '265': 'Sweden', '266': 'Finland', '271': 'Türkiye', '273': 'Russia',
  '276': 'Estonia', '277': 'Lithuania', '303': 'United States', '309': 'Bahamas',
  '311': 'Bahamas', '312': 'Belize', '316': 'Canada', '325': 'Antigua & Barbuda',
  '338': 'United States', '351': 'Panama', '352': 'Panama', '353': 'Panama', '354': 'Panama',
  '355': 'Panama', '356': 'Panama', '357': 'Panama', '366': 'United States', '367': 'United States',
  '368': 'United States', '369': 'United States', '370': 'Panama', '371': 'Panama',
  '372': 'Panama', '373': 'Panama', '412': 'China', '413': 'China', '431': 'Japan',
  '440': 'South Korea', '441': 'South Korea', '477': 'Hong Kong', '501': 'Antarctica',
  '503': 'Australia', '512': 'New Zealand', '525': 'Indonesia', '538': 'Marshall Islands',
  '563': 'Singapore', '564': 'Singapore', '565': 'Singapore', '566': 'Singapore',
  '636': 'Liberia', '630': 'Liberia', '725': 'Brazil', '735': 'Ecuador',
});

export function mmsiToMidCountry(mmsi) {
  const mid = mmsiMid(mmsi);
  return mid ? (MID_TABLE[mid] || null) : null;
}

/**
 * Open the stream and keep it alive.
 * @returns {{close:Function, get records:Function}}
 */
export function openAisStream({
  apiKey,
  bbox,
  onRecords,
  onStatus,
  maxVessels = 1500,
  reconnectMs = 5000,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (!apiKey) {
    onStatus?.({ status: 'config-required', message: 'An AISStream.io API key is required.' });
    return { close() {}, get records() { return []; } };
  }

  const vessels = new Map();
  let socket = null;
  let closed = false;
  let reconnectTimer = null;
  let flushTimer = null;
  let lastEmit = 0;

  const emit = () => {
    lastEmit = Date.now();
    const list = [...vessels.values()];
    onRecords?.(list);
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (Date.now() - lastEmit >= 2000) emit();
    }, 2000);
  };

  const connect = () => {
    if (closed) return;
    try {
      socket = new WebSocketImpl(WS_URL);
    } catch (error) {
      onStatus?.({ status: 'error', message: `Could not open the AISStream socket: ${error?.message || error}` });
      return;
    }

    socket.onopen = () => {
      onStatus?.({ status: 'live', message: 'AISStream connected' });
      try {
        socket.send(subscriptionMessage({ apiKey, bbox: aisBoundingBox(bbox) }));
      } catch (error) {
        onStatus?.({ status: 'error', message: `Subscription failed: ${error?.message || error}` });
      }
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const record = normalizeAisMessage(message, vessels);
      if (!record) return;
      vessels.set(record.mmsi, record);
      if (vessels.size > maxVessels) {
        // Evict the least recently observed contact.
        const oldest = [...vessels.values()].sort((a, b) => (a.observedAt || 0) - (b.observedAt || 0))[0];
        if (oldest) vessels.delete(oldest.mmsi);
      }
      scheduleFlush();
    };

    socket.onerror = () => {
      onStatus?.({ status: 'error', message: 'AISStream socket error — check the key and network.' });
    };

    socket.onclose = () => {
      if (closed) return;
      onStatus?.({ status: 'stale', message: 'AISStream disconnected; reconnecting…' });
      reconnectTimer = setTimeout(connect, reconnectMs);
    };
  };

  connect();

  return {
    get records() {
      return [...vessels.values()];
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) clearTimeout(flushTimer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      vessels.clear();
    },
  };
}
