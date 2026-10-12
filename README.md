# God's Eye View

A real-time 3D Earth intelligence console that runs entirely from static
hosting. CesiumJS globe, 22 live data layers, ops-console interface — no server,
no database, no API key required to use it.

**Live:** <https://meyashverma.github.io/gods-eye-view/>

> **Independent implementation.** This project was inspired by
> [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal
> Sidhu (MIT). It is not affiliated with, endorsed by, or maintained by the
> original author, and it shares no source code with it. Attribution is kept in
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> **Not authoritative.** Everything here comes from public feeds of varying
> latency and accuracy, some of which are advisory products on a delay. This is
> for situational awareness and curiosity — not for navigation, emergency
> response, or any safety-critical decision.

---

## What it does

A full-screen globe with a top status bar, a left layer rail, a contextual
detail panel, a bottom telemetry strip, coordinate search, camera and render
controls, a basemap selector, settings, and attribution. Dark industrial
surfaces, restrained green/amber/cyan, Lucide icons — no glassmorphism, no glow
for glow's sake, no emoji controls.

### Layers

| Category | Layers |
|---|---|
| Movement | Civil aircraft · Military aircraft · Maritime traffic (AIS) |
| Space | Satellites & orbital objects |
| Events | Earthquakes · Active fires (NASA FIRMS) · Tropical cyclones |
| Weather | Precipitation radar · Satellite clouds · Wind field |
| Cameras | Public traffic cameras · Mapped ALPR cameras · Street level imagery |
| Infrastructure | Data centres · Dams · Power infrastructure · Military areas · Airports |
| Utilities | Radio stations · Bikeshare stations · Routing · Transit stops |

Every layer publishes one honest status: `live`, `stale`, `empty`, `error`,
`blocked` (CORS), `offline`, `rate-limited`, `config-required`, `unavailable` or
`simulated`. A toggle changing state is not evidence that data arrived, and the
UI does not pretend otherwise.

### Interaction

- Click to inspect; selection is stable across refreshes and syncs the detail panel
- Fly-to, follow, fading trails, cockpit view
- HUD with coordinates, altitude, heading, zoom and active layers
- Detection-style bounding boxes and labels with a density budget
- Real post-process visual styles — night vision, FLIR, monochrome, noir, CRT,
  surveillance, blueprint. These compile fragment shaders against the scene
  colour buffer; they are not CSS filters and not screenshots. The UI calls the
  FLIR look a stylisation rather than implying thermal data.
- Scene-cleaning mode for screenshots and presentations
- Local annotations: points, lines, polygons and measurements, stored in
  localStorage and measured with real spherical geometry
- Scene director for a guided camera tour
- Shareable view links, bounded and validated
- Optional voice control through the browser's own speech input
- Keyboard: `L` layers · `C` context · `H` HUD · `R` reset · `P` presentation ·
  `V` voice · `S` share · `D` tour · `,` settings · `+`/`-` zoom · `[`/`]` orbit

### Voice control, honestly

The voice path uses the browser's Web Speech API and a small deterministic
parser — navigate to a place, toggle a layer, change the visual style, reset or
orbit the camera, track a selection, refresh, share. There is no assistant
persona and no claim about anything that did not happen: the executor returns
what it actually did and the UI repeats exactly that. It needs no API key, and
it issues no ephemeral tokens from a private key — there is no private key
anywhere in this project.

---

## Feature status

| Feature | Status | Notes |
|---|---|---|
| CesiumJS globe, orbit/pan/zoom | Implemented | WebGL2, keyless imagery and terrain by default |
| Basemap and terrain selector with fallback | Implemented | Esri · OSM · Cesium ion · Google tiles; terrain auto/ion/Re:Earth/flat |
| Place and coordinate search | Implemented | Photon → Nominatim, plus local coordinate parsing |
| Share links | Implemented | Bounded, validated, degrades safely on malformed input |
| Annotations, measurements | Implemented | localStorage only |
| Visual styles as real shaders | Implemented | 7 styles plus `normal` |
| Scene director / camera tour | Implemented | |
| Voice control | Implemented | Browser-native speech input |
| Live ADS-B traffic | **Unavailable without setup** | No public ADS-B API sends CORS headers. See below. |
| AIS maritime traffic | Implemented | Needs a free AISStream key |
| Satellite TLE propagation | Implemented | SGP4 in-browser |
| Active fires | Implemented | Needs a free NASA FIRMS key |
| Street-level imagery | Implemented | Needs a free Mapillary token |
| Photorealistic 3D tiles | Implemented | Needs a Google Maps key |
| Cesium World Terrain | Implemented | Needs a Cesium ion token |
| Live transit vehicle positions | **Not implemented** | Needs a GTFS-Realtime feed and a protobuf decoder. Mapped stops only. |
| Submarine cables | **Omitted by design** | TeleGeography data is CC BY-NC-SA. See [DATA_SOURCES.md](DATA_SOURCES.md). |
| Plate recognition, face recognition, person search | **Will not implement** | See below. |

### Why there is no live ADS-B out of the box

`api.adsb.lol`, `opendata.adsb.fi`, `airplanes.live` and OpenSky all serve data
with no `Access-Control-Allow-Origin` header and reject preflight. A browser on
a static host cannot read them, and GitHub Pages has no proxy. The aircraft
layers therefore read a user-supplied endpoint (your own `readsb`/`tar1090`
`aircraft.json`, or anything else that does send CORS headers) and otherwise
offer a synthesised feed that is labelled **SAMPLE DATA** and reported as
`SIMULATED`. It is never mixed with real records and never presented as traffic.

### The ALPR layer, explicitly

Mapped ALPR cameras shows **locations and public tags only**. It performs no
plate recognition, collects no plate data, performs no face recognition, offers
no search for a named person and tracks no individual. It does not scrape camera
feeds, bypass authentication, or request sites that disallow it.

---

## Development

Requires Node 20.19 or newer.

```bash
npm install
npm run dev          # dev server
npm run build        # production build to dist/
npm run preview      # serve the production build
npm test             # unit tests (node:test, no browser needed)
npm run check:build  # integrity checks against a built dist/
npm run check        # tests + build + integrity checks
```

`npm run dev` serves from `/gods-eye-view/`, matching production, so a subpath
bug shows up locally instead of after a deploy.

### Deploying to GitHub Pages

1. Push to `main`. The `Build and deploy to GitHub Pages` workflow runs tests,
   builds, verifies the output, and publishes it as an artifact.
2. Under **Settings → Pages**, set **Source** to *GitHub Actions*. This is a
   one-time step that cannot be done from a workflow.
3. The site appears at `https://<owner>.github.io/<repo>/`.

`base` is derived from the repository name at build time, so a fork deploys
correctly under its own subpath with no edits. For a user/organisation site
(`<owner>.github.io`) it resolves to `/`. Override with `PAGES_BASE` if needed.

Direct loads and hard refreshes work — there is no SPA rewrite and no route to
fall through.

---

## How it is built

ES modules, CesiumJS, Vite, no framework. Adapters, controllers, renderers and
UI are separate layers, and the pure logic is unit-testable in Node.

```
src/
  core/        store, event bus, DOM helpers, icon set
  geo/         coordinates, distance, projection, formatting
  net/         fetch client, cache, retry, CORS classification, status model
  settings/    localStorage preferences and provider credentials
  sources/     one adapter per provider — init, fetch, normalise, freshness
  layers/      the layer registry: base, point layers, and 22 layer factories
  render/      marker and glyph rendering
  maps/        imagery and terrain catalog with fallback chains
  camera/      camera controller, presets, follow and cockpit modes
  tools/       visual styles, overlay, annotations, scene director
  share/       bounded share-link codec
  voice/       command parser and speech controller
  ui/          shell, layer rail, context panel, modals, components
```

Every adapter has timeouts, cancellation, bounded retry with backoff, cache
reuse, duplicate-request suppression, rate-limit handling and CORS-failure
detection. Refresh is visibility-aware and one shared scheduler sweeps all
visible layers on a single interval. Nothing polls faster than five seconds —
`tests/layer-registry.test.mjs` fails the build if it does.

## Security

- No credentials are committed. There is no `.env`, no build-time injection and
  no GitHub Actions variable holding a key.
- `scripts/check-build.mjs` fails the build if any credential-shaped string
  appears in a bundle that did not come from a third-party library's published
  source.
- Share links carry camera state, layer selection and visual style only.
  `tests/settings.test.mjs` asserts a secret cannot reach one.
- Secret settings are redacted before any export or log line.
- Stored settings are filtered to known keys, so a hostile localStorage value
  cannot extend the settings shape.

A key entered in Settings is browser-visible by definition — it is sent from
the user's browser. Settings says so out loud next to each field.

## Tests

`npm test` runs 176 unit tests with `node:test`, no browser required. They cover
coordinate maths, the status model, the HTTP cache and CORS classification,
share-link encode/decode and its hostile-input handling, the voice parser, every
provider normalizer against captured payloads, settings and secret redaction,
the icon set, annotation geometry, layer catalog integrity and the refresh
scheduler.

`npm run check:build` then inspects the emitted `dist/`: base paths in every
asset URL, Cesium's static workers and assets, `cesium-base.js` agreeing with
the deployed base, no credential-shaped strings, no Node builtins in a browser
bundle, and the GitHub Pages size budget.

These are real checks, not a smoke test — they have found and fixed a 60× error
in orbital period, a GBFS catalog parser that could never match a row, an
antimeridian bounding box that dropped every station, a duplicate layer id, and
an attribute-injection hole in the icon renderer.

## Data and attribution

See [DATA_SOURCES.md](DATA_SOURCES.md) for per-provider licences, attribution
strings, refresh policies and known limitations. The same table is rendered in
the running application under **Info → Attribution**.

## Licence

MIT — see [LICENSE](LICENSE). The MIT grant covers this repository's source
code only. No datasets are bundled; everything shown is fetched at runtime and
remains subject to each provider's own terms.
