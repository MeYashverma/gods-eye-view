/**
 * Sets Cesium's asset root before the application bundle runs.
 *
 * This is a plain (non-module) script so it executes before the ESM entry point
 * and so it survives Content-Security-Policy rules that forbid inline scripts.
 *
 * `scripts/cesium-static.mjs` rewrites this file inside `dist/` at build time so
 * the path always matches Vite's resolved `base` — meaning a fork deployed under
 * a different repository name needs no manual edit.
 */
window.CESIUM_BASE_URL = '/gods-eye-view/cesium/';
