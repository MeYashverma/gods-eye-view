/**
 * Scene director — a scripted camera tour.
 *
 * A tour is an ordered list of shots. Each shot is a camera target plus a
 * dwell time and an optional set of layers to reveal, so a presenter can walk
 * an audience through the globe hands-free. Tours are plain JSON, which makes
 * them shareable through the same hash mechanism as everything else.
 */

import { CAMERA_PRESETS } from '../camera/controller.js';

export const DEFAULT_TOUR = Object.freeze([
  { id: 'orbit', label: 'Whole Earth', shot: { lat: 20, lon: 0, heightM: 21_000_000, heading: 0, pitch: -90 }, dwellMs: 6000, orbitDegPerSec: 6 },
  { id: 'americas', label: 'Americas', shot: { lat: 15, lon: -85, heightM: 14_000_000, pitch: -90 }, dwellMs: 6000, orbitDegPerSec: 8 },
  { id: 'atlantic', label: 'North Atlantic', shot: { lat: 45, lon: -30, heightM: 7_000_000, pitch: -90 }, dwellMs: 5000, orbitDegPerSec: 10 },
  { id: 'europe', label: 'Europe', shot: { lat: 50, lon: 10, heightM: 3_200_000, pitch: -70 }, dwellMs: 6000, orbitDegPerSec: 6 },
  { id: 'tokyo', label: 'Tokyo', shot: { lat: 35.6762, lon: 139.6503, heightM: 90_000, pitch: -45 }, dwellMs: 6000, orbitDegPerSec: 12 },
  { id: 'new-york', label: 'New York', shot: { lat: 40.7128, lon: -74.006, heightM: 60_000, pitch: -40 }, dwellMs: 6000, orbitDegPerSec: 12 },
  { id: 'dubai', label: 'Dubai', shot: { lat: 25.2048, lon: 55.2708, heightM: 70_000, pitch: -38 }, dwellMs: 6000, orbitDegPerSec: 12 },
  { id: 'sydney', label: 'Sydney', shot: { lat: -33.8688, lon: 151.2093, heightM: 70_000, pitch: -42 }, dwellMs: 6000, orbitDegPerSec: 12 },
]);

export function createDirector({ camera, viewer, onShot, layers }) {
  let shots = [...DEFAULT_TOUR];
  let index = -1;
  let timer = null;
  let orbitHandle = null;
  let playing = false;

  const stopOrbit = () => {
    if (orbitHandle) {
      clearInterval(orbitHandle);
      orbitHandle = null;
    }
  };

  const applyShot = (shot) => {
    stopOrbit();
    camera.flyTo({ ...shot.shot, duration: 2.4 });
    if (shot.layers?.length && layers) {
      for (const layer of layers()) {
        const shouldShow = shot.layers.includes(layer.id);
        if (shouldShow && !layer.visible) layer.show();
      }
    }
    if (shot.orbitDegPerSec) {
      const step = shot.orbitDegPerSec * 0.1;
      orbitHandle = setInterval(() => {
        const focus = camera.focus();
        viewer.camera.setView({
          destination: viewer.camera.position,
          orientation: {
            heading: viewer.camera.heading + (step * Math.PI) / 180,
            pitch: viewer.camera.pitch,
            roll: 0,
          },
        });
        void focus;
      }, 100);
    }
    onShot?.({ shot, index });
  };

  const next = () => {
    if (!shots.length) return;
    index = (index + 1) % shots.length;
    const shot = shots[index];
    applyShot(shot);
    timer = setTimeout(() => {
      if (playing) next();
    }, Math.max(1500, shot.dwellMs || 5000));
  };

  return {
    play() {
      if (playing) return;
      playing = true;
      next();
    },
    pause() {
      playing = false;
      if (timer) clearTimeout(timer);
      timer = null;
      stopOrbit();
    },
    stop() {
      this.pause();
      index = -1;
    },
    next,
    previous() {
      if (!shots.length) return;
      index = (index - 1 + shots.length) % shots.length;
      applyShot(shots[index]);
    },
    get playing() {
      return playing;
    },
    get index() {
      return index;
    },
    get shots() {
      return [...shots];
    },
    setShots(value) {
      if (!Array.isArray(value) || !value.length) return;
      shots = value.filter((shot) => shot?.shot && Number.isFinite(shot.shot.lat));
      index = -1;
    },
    dispose() {
      this.stop();
    },
  };
}

export { CAMERA_PRESETS };
