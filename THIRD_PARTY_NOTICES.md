# Third-party notices

This project is built entirely on third-party libraries and data providers.
Nothing below is covered by this repository's MIT license unless stated.

## Inspiration and attribution

This is an **independent community implementation**. It was written from scratch
and shares no source code with the project that inspired it.

| | |
|---|---|
| Original project | [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu |
| Original license | MIT, Copyright (c) 2026 Bilawal Sidhu |
| Relationship | Independent implementation. Not affiliated with, endorsed by, or maintained by the original author. |

The original project's license text is reproduced below because its MIT terms
require the copyright notice to be preserved in derivative or inspired works
that reuse its code. This project reuses none, but the attribution is kept
deliberately.

```
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm dependencies

| Package | Version | License | Used for |
|---|---|---|---|
| [cesium](https://cesium.com/cesiumjs/) | ^1.146.0 | Apache-2.0 | 3D globe, terrain, imagery, post-processing |
| [satellite.js](https://github.com/shashwatak/satellite-js) | ^5.0.0 | MIT | SGP4/SDP4 orbit propagation from TLEs |
| [lucide](https://lucide.dev/) | ^1.55.0 | ISC | Icon set (per-icon ESM, tree-shaken) |
| [vite](https://vite.dev/) | ^7.3.7 | MIT | Build tooling (dev dependency) |

Cesium's own third-party attributions ship inside the Cesium package and are
displayed at runtime by Cesium's credit container. Lucide icons are ISC
licensed; the icon glyphs used here are named in `src/core/icons.js`.

`satellite.js` is pinned to the 5.x line deliberately. The 7.x releases load a
WebAssembly build whose loader imports `node:module`, which a browser bundler
cannot satisfy and which would add roughly 400 kB of unused WASM to the public
bundle.

## Fonts and imagery

No web fonts and no image assets are bundled. Typography uses the system UI
font stack; the only shipped graphic is `public/logo.svg`, which is original to
this repository.

## Data providers

See [DATA_SOURCES.md](DATA_SOURCES.md) for the full per-provider licence,
attribution string, refresh policy and known limitations. The same information
is shown in the running application's Attribution panel.
