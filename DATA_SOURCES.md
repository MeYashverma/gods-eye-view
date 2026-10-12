# Data sources

Every record on the globe is fetched at runtime from a third party. This
repository bundles **no datasets** — there is nothing under `src/data/`, no
committed CSV, no cached snapshot. That is deliberate: it keeps the licence
story simple and it means nothing on screen can be stale by weeks without the
UI saying so.

The same table is rendered inside the running application under
**Info → Attribution**, with a live timestamp for each layer.

## Legend

- **Direct** — the provider sends `Access-Control-Allow-Origin`, so the browser
  can call it from a static page. This is the only thing that makes a layer
  work on GitHub Pages at all.
- **Key** — the layer needs a credential the user supplies in Settings. The app
  is fully usable without any of them.

## Movement

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [adsb.lol](https://adsb.lol) | **No** | ODbL 1.0 (data); community API terms | adsb.lol contributors | Public ADS-B aggregators do not send CORS headers. See the ADS-B section below. |
| [adsbdb](https://api.adsbdb.com) | **No** | No published licence | adsbdb | Callsign/route lookups. Not reachable from a browser. |
| [AISStream.io](https://aisstream.io) | Yes (WebSocket) | Free beta service; no formal ToS published | AISStream.io | Needs a free key. AIS is a public broadcast; positions are **self-reported by each vessel**. |

### Why there is no live ADS-B by default

`api.adsb.lol`, `opendata.adsb.fi`, `airplanes.live` and OpenSky all serve data
without an `Access-Control-Allow-Origin` header, and reject preflight requests.
A browser on a static host therefore cannot read them — there is no header to
negotiate and no proxy on GitHub Pages to add one. Every open-source project
that shows live ADS-B from a browser ships a server for exactly this reason,
and this project has no server by design.

What the aircraft layers do instead:

1. If you set **ADS-B endpoint** in Settings to something that does send CORS
   headers — your own `readsb`/`tar1090` `aircraft.json`, a Cloudflare Worker in
   front of adsb.lol, anything — the layer reads it as live data.
2. Otherwise the layer offers a **SAMPLE DATA** feed. It is synthesised,
   deterministic per seed, and the layer status reads `SIMULATED` with a visible
   **SAMPLE DATA** badge. It is never presented as traffic, and it never mixes
   with real records.

The military aircraft layer has the same two paths. Its records carry whatever
classification the feed itself supplies; nothing is inferred from a hex code.

## Space

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [CelesTrak](https://celestrak.org) | Yes | Public data; usage policy at celestrak.org | CelesTrak / T.S. Kelso | Two-line element sets only. Positions are propagated in-browser with SGP4. |

Two constraints worth knowing, both handled in `src/sources/celestrak.js`:

- As of 2026-05-09 CSV is the default GP format, so every request passes
  `FORMAT=TLE` explicitly.
- NORAD catalog numbers passed 100000 in July 2026 and those objects have no
  TLE representation. They are simply absent from a TLE group; the layer does
  not substitute anything for them.

Satellite positions are a propagation of an element set that may be hours or
days old. They are not precision navigation and the layer says so.

## Events

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [USGS FDSN](https://earthquake.usgs.gov/fdsnws/event/1/) | Yes | U.S. Government public domain | U.S. Geological Survey | Bounding-box and magnitude filters, so a zoomed view asks only for what is in view. |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/area/map/) | **No** | NASA open data; acknowledgement required | NASA FIRMS / LANCE, MODIS & VIIRS | Needs a free key. Fire detections are near-real-time, not real-time. |
| [NOAA NHC / CPHC](https://www.nhc.noaa.gov/CurrentStorms.json) | Yes | NWS public data; no endorsement implied | NOAA/NWS NHC & CPHC | **Advisory products on a delay.** Never use for decisions about safety. |

## Weather

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [RainViewer](https://www.rainviewer.com/api.html) | Yes | Free for non-commercial use with attribution | © RainViewer | Radar frames are reliably populated; the free satellite feed is often empty and the layer says so. |
| [Open-Meteo](https://open-meteo.com) | Yes | CC BY 4.0 (non-commercial) | Weather data by Open-Meteo.com | Keyless. Drives the wind grid. |

## Cameras and street level

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [OpenStreetMap Overpass](https://overpass-api.de) | Yes | © OpenStreetMap contributors, ODbL 1.0 | © OpenStreetMap contributors | Cameras and ALPR locations come from what mappers tagged. |
| [Mapillary](https://www.mapillary.com) | Yes (token) | Imagery CC BY-SA 4.0 | © Mapillary contributors | Needs a free client access token. |

### The ALPR layer, explicitly

The ALPR layer shows **locations and public tags only** — where an
OpenStreetMap contributor recorded that a camera exists and what they tagged it
as. It performs no plate recognition, collects no plate data, performs no face
recognition, offers no search for a named person and tracks no individual. It
does not scrape camera feeds, does not bypass authentication, and does not
request sites that disallow it. The privacy line is shown in the layer's own
description, not just here.

## Infrastructure

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [OpenStreetMap Overpass](https://overpass-api.de) | Yes | © OpenStreetMap contributors, ODbL 1.0 | © OpenStreetMap contributors | Datacentres, dams, power, military areas, airports. |
| [OpenFlights](https://openflights.org/data.html) | Yes | ODbL 1.0 | © OpenFlights.org | Airport locations. |

Mapping a site in OpenStreetMap records that the site is mapped. It does not
establish current activity, ownership or status, and the layer descriptions say
so.

**Deliberately omitted:** TeleGeography's submarine cable map is CC BY-NC-SA 3.0
(NonCommercial + ShareAlike). Those terms do not fit a permissively licensed
project, so the data is neither bundled nor fetched. Submarine cables are absent
from this project by design.

## Utilities

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [Radio Browser](https://www.radio-browser.info) | Yes | MIT (API); each stream keeps its broadcaster's terms | Radio Browser community database | Playback success is decided by each broadcaster, not by this app. |
| [GBFS / MobilityData](https://github.com/MobilityData/gbfs) | Yes | Per-operator; catalog CC BY 4.0 | Bikeshare operators via GBFS | See the note below. |
| [OSRM (FOSSGIS)](https://project-osrm.org) | Yes | Routes over OpenStreetMap, ODbL 1.0 | Routes © OpenStreetMap contributors, OSRM | Public demo router; light interactive use only. |

### Bikeshare systems are matched by place name

The MobilityData `systems.csv` catalog (1,544 systems) has the columns
`Country Code, Name, Location, System ID, URL, Auto-Discovery URL, ...` and
**carries no coordinates at all**. There is therefore no way to ask "which
systems are within 50 km of this camera".

Rather than invent coordinates or pretend a match, the layer reverse-geocodes
the camera position to a place name and matches it against the catalog's
`Location` text. When nothing matches it reports
`No GBFS system listed for "<place>"` and draws nothing. Per-operator cross-origin
policy varies, so individual systems can still fail; each failure is reported
rather than hidden.

## Search and basemaps

| Source | Direct | Licence | Attribution | Notes |
|---|---|---|---|---|
| [Photon (Komoot)](https://photon.komoot.io) | Yes | © OpenStreetMap contributors, ODbL 1.0 | Search © OpenStreetMap contributors | Primary geocoder. |
| [Nominatim](https://nominatim.openstreetmap.org) | Yes | © OpenStreetMap contributors, ODbL 1.0 | Search © OpenStreetMap contributors | Fallback. Rate-limited to about 1 req/s in the client, per its usage policy. |
| [Esri World Imagery](https://www.esri.com) | Yes | Esri terms; free non-commercial with attribution | Esri, Maxar, Earthstar Geographics | Default keyless basemap. |
| [OpenStreetMap tiles](https://tile.openstreetmap.org) | Yes | © OpenStreetMap contributors, ODbL 1.0 | © OpenStreetMap contributors | Optional basemap. |
| [Re:Earth terrain](https://reearth.io) | Yes | Keyless public endpoint | Terrain by Re:Earth | Default keyless terrain. |
| [Cesium ion](https://ion.cesium.com) | Yes (token) | Cesium ion terms | Cesium ion | Optional; unlocks Cesium World Terrain and Bing imagery. |
| [Google Photorealistic 3D Tiles](https://developers.google.com/maps) | Yes (key) | Google Maps Platform terms | Google | Optional; billed to you. Restrict the key to your Pages origin. |

## Credentials

Every credential this app can use is **browser-visible by definition** — it is
sent from the user's browser, so it is not a secret and cannot be made one.
Settings says this out loud next to each field.

- Nothing is committed. There is no `.env`, no build-time injection, no GitHub
  Actions variable holding a key. `scripts/check-build.mjs` fails the build if
  any credential-shaped string appears in a bundle that did not come from a
  third-party library's own published source.
- Nothing is put in a URL. Share links carry camera state, layer selection and
  visual style only; `tests/settings.test.mjs` asserts a key cannot reach one.
- Secret fields are redacted before any export or log line.

Only providers that document client-side use are supported: Cesium ion, Google
Maps Platform, Mapillary, AISStream.io and NASA FIRMS all publish browser or
client token flows. A key placed here should be restricted to your Pages origin
in the provider's dashboard.

## Rate limits and refresh

Every adapter declares a refresh interval, a cache TTL and a stale window in
`src/sources/registry.js`. `tests/layer-registry.test.mjs` fails if any layer
polls faster than 5 seconds. One shared scheduler sweeps all visible layers on a
single interval, skips viewport-driven layers, and pauses entirely when the tab
is backgrounded — a static site has no server to blame for burning a volunteer
API's quota.

## Not authoritative

These are public feeds of varying latency and accuracy. Some are advisory
products published on a delay. Nothing here is suitable for navigation,
emergency response, or any safety-critical decision.
