/**
 * Camera control — presets, focus tracking, and the viewport box that
 * viewport-aware layers query with.
 */

import * as Cesium from 'cesium';
import { clamp, heightToZoom, distanceM } from '../geo/coords.js';

export const CAMERA_PRESETS = Object.freeze([
  { id: 'whole-earth', label: 'Whole Earth', lat: 20, lon: 0, heightM: 21_000_000, heading: 0, pitch: -90 },
  { id: 'americas', label: 'Americas', lat: 15, lon: -80, heightM: 14_000_000 },
  { id: 'europe-africa', label: 'Europe & Africa', lat: 20, lon: 15, heightM: 11_000_000 },
  { id: 'asia-pacific', label: 'Asia & Pacific', lat: 20, lon: 110, heightM: 13_000_000 },
  { id: 'north-atlantic', label: 'North Atlantic', lat: 45, lon: -30, heightM: 7_000_000 },
  { id: 'new-york', label: 'New York', lat: 40.7128, lon: -74.006, heightM: 22_000 },
  { id: 'london', label: 'London', lat: 51.5072, lon: -0.1276, heightM: 22_000 },
  { id: 'tokyo', label: 'Tokyo', lat: 35.6762, lon: 139.6503, heightM: 22_000 },
  { id: 'singapore', label: 'Singapore', lat: 1.3521, lon: 103.8198, heightM: 22_000 },
  { id: 'san-francisco', label: 'San Francisco', lat: 37.7749, lon: -122.4194, heightM: 20_000 },
  { id: 'sydney', label: 'Sydney', lat: -33.8688, lon: 151.2093, heightM: 22_000 },
  { id: 'dubai', label: 'Dubai', lat: 25.2048, lon: 55.2708, heightM: 24_000 },
]);

export const ZOOM_STEPS = Object.freeze([
  { id: 'street', label: 'Street', heightM: 900 },
  { id: 'city', label: 'City', heightM: 30_000 },
  { id: 'region', label: 'Region', heightM: 700_000 },
  { id: 'nation', label: 'National', heightM: 3_000_000 },
  { id: 'continent', label: 'Continental', heightM: 9_000_000 },
  { id: 'global', label: 'Global', heightM: 21_000_000 },
]);

export function createCameraController({ viewer, onIdle }) {
  let idleTimer = null;
  let lastSignature = '';

  const handleMoveEnd = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const signature = signatureOf(viewer.camera);
      if (signature !== lastSignature) {
        lastSignature = signature;
        onIdle?.(focus());
      }
    }, 700);
  };

  viewer.camera.moveEnd.addEventListener(handleMoveEnd);

  /** Camera position as lat/lon/height — the readout and every query use this. */
  function focus() {
    const camera = viewer.camera;
    const cartographic = camera.positionCartographic;
    return {
      lat: cartographic.latitude * (180 / Math.PI),
      lon: cartographic.longitude * (180 / Math.PI),
      heightM: cartographic.height,
      heading: ((camera.heading * 180) / Math.PI + 360) % 360,
      pitch: (camera.pitch * 180) / Math.PI,
      roll: (camera.roll * 180) / Math.PI,
      zoom: heightToZoom(cartographic.height),
    };
  }

  /**
   * The ground rectangle currently on screen. Uses the four screen corners
   * picked against the ellipsoid rather than a lat/lon approximation, so a
   * tilted view still yields a box that actually contains what is visible.
   */
  function viewportBox(radiusKm = 400) {
    const scene = viewer.scene;
    const canvas = scene.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return null;

    const corners = [
      new Cesium.Cartesian2(width * 0.15, height * 0.15),
      new Cesium.Cartesian2(width * 0.85, height * 0.15),
      new Cesium.Cartesian2(width * 0.15, height * 0.85),
      new Cesium.Cartesian2(width * 0.85, height * 0.85),
      new Cesium.Cartesian2(width * 0.5, height * 0.5),
    ];

    let south = 90;
    let north = -90;
    let west = 180;
    let east = -180;
    let hit = false;

    for (const corner of corners) {
      const ray = viewer.camera.getPickRay(corner);
      if (!ray) continue;
      const position = scene.globe.pick(ray, scene);
      const cartographic = position
        ? scene.globe.ellipsoid.cartesianToCartographic(position)
        : null;
      if (!cartographic) continue;
      hit = true;
      const lat = cartographic.latitude * (180 / Math.PI);
      const lon = cartographic.longitude * (180 / Math.PI);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }

    const center = focus();
    if (!hit) {
      // Looking at space: fall back to a box around the sub-camera point.
      const span = Math.min(60, Math.max(0.4, center.heightM / 111_320));
      south = clamp(center.lat - span, -90, 90);
      north = clamp(center.lat + span, -90, 90);
      west = center.lon - span;
      east = center.lon + span;
    } else {
      // Pad so markers just off-screen still load.
      const padLat = Math.max(0.05, (north - south) * 0.12);
      const padLon = Math.max(0.05, (east - west) * 0.12);
      south = clamp(south - padLat, -90, 90);
      north = clamp(north + padLat, -90, 90);
      west -= padLon;
      east += padLon;
    }

    // A box wider than the whole planet is not a useful query.
    if (east - west > 360) {
      west = -180;
      east = 180;
    }
    return { south, north, west, east, radiusKm };
  }

  function flyTo({ lat, lon, heightM = 500_000, heading = 0, pitch = -90, duration = 1.8 }) {
    return viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(50, heightM)),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(clamp(pitch, -90, 0)),
        roll: 0,
      },
      duration,
    });
  }

  /** Zoom by a factor around the current focus, without leaving the ground. */
  function zoomBy(factor) {
    const current = focus();
    const next = clamp(current.heightM * factor, 250, 36_000_000);
    return flyTo({ ...current, heightM: next, duration: 0.9 });
  }

  /** Rotate the heading by `degrees` in place — the "orbit" gesture. */
  function orbit(degrees) {
    const current = focus();
    return flyTo({ ...current, heading: (current.heading + degrees + 360) % 360, duration: 0.6 });
  }

  function reset() {
    return flyTo({ ...CAMERA_PRESETS[0], duration: 2.2 });
  }

  /** Look straight down, keeping the current focus. */
  function topDown() {
    const current = focus();
    return flyTo({ ...current, heading: 0, pitch: -90, duration: 0.8 });
  }

  /** Serialize the camera for share links. Rounded so links stay short. */
  function serialize() {
    const current = focus();
    return {
      lat: Number(current.lat.toFixed(4)),
      lon: Number(current.lon.toFixed(4)),
      h: Math.round(current.heightM),
      hdg: Math.round(current.heading),
      pch: Math.round(current.pitch),
    };
  }

  function restore(serialized, { animate = true } = {}) {
    if (!serialized || !Number.isFinite(serialized.lat) || !Number.isFinite(serialized.lon)) return false;
    const target = {
      lat: clamp(serialized.lat, -90, 90),
      lon: clamp(serialized.lon, -180, 180),
      heightM: clamp(serialized.h ?? 5_000_000, 250, 40_000_000),
      heading: clamp(serialized.hdg ?? 0, 0, 359),
      pitch: clamp(serialized.pch ?? -90, -90, 0),
    };
    if (!animate) {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.heightM),
        orientation: {
          heading: Cesium.Math.toRadians(target.heading),
          pitch: Cesium.Math.toRadians(target.pitch),
          roll: 0,
        },
      });
      lastSignature = signatureOf(viewer.camera);
      return true;
    }
    flyTo(target);
    return true;
  }

  /**
   * Follow a moving contact: re-aim the camera at its current position while
   * preserving the operator's chosen altitude and angle.
   */
  function followTrack({ getPosition, keepRange = true }) {
    let handle = null;
    const tick = () => {
      const position = getPosition();
      if (!position) return;
      const current = focus();
      const heightM = keepRange
        ? Math.max(500, Math.min(current.heightM, distanceM(position.lat, position.lon, current.lat, current.lon) * 1.6 + 2000))
        : current.heightM;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(position.lon, position.lat, heightM),
        orientation: {
          heading: Cesium.Math.toRadians(current.heading),
          pitch: Cesium.Math.toRadians(current.pitch),
          roll: 0,
        },
      });
    };
    tick();
    handle = setInterval(tick, 2000);
    return () => {
      if (handle) clearInterval(handle);
      handle = null;
    };
  }

  /**
   * Cockpit view: sit just behind and above the contact, pointing along its
   * track. Used by the tracked-aircraft cockpit mode.
   */
  function cockpitView({ getPosition, getHeading, offsetM = 60 }) {
    let handle = null;
    const tick = () => {
      const position = getPosition();
      if (!position) return;
      const heading = Number.isFinite(getHeading?.()) ? getHeading() : 0;
      const heightM = (position.height ?? 0) + offsetM;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(position.lon, position.lat, heightM),
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(-2),
          roll: 0,
        },
      });
    };
    tick();
    handle = setInterval(tick, 100);
    return () => {
      if (handle) clearInterval(handle);
      handle = null;
    };
  }

  return {
    focus,
    viewportBox,
    flyTo,
    zoomBy,
    zoomIn: () => zoomBy(1 / 2.4),
    zoomOut: () => zoomBy(2.4),
    orbit,
    reset,
    topDown,
    serialize,
    restore,
    followTrack,
    cockpitView,
    presets: CAMERA_PRESETS,
    zoomSteps: ZOOM_STEPS,
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      viewer.camera.moveEnd.removeEventListener(handleMoveEnd);
    },
  };
}

function signatureOf(camera) {
  const cartographic = camera.positionCartographic;
  return [
    (cartographic.latitude * 57.2958).toFixed(2),
    (cartographic.longitude * 57.2958).toFixed(2),
    Math.round(cartographic.height / 1000),
  ].join('|');
}
