/**
 * Visual styles.
 *
 * These are real post-process render stages, not CSS filters layered over the
 * canvas and not screenshots. Each style compiles a fragment shader that runs
 * against Cesium's colour buffer every frame, so it interacts correctly with
 * camera movement, terrain and the atmosphere.
 *
 * They are labelled as *rendering styles*, not sensor simulation: a "FLIR"
 * look derived from a visible-light colour buffer is a stylisation, and the UI
 * calls it that rather than implying thermal data.
 */

import * as Cesium from 'cesium';

const HEADER = `
uniform sampler2D colorTexture;
varying vec2 v_textureCoordinates;
`;

/**
 * Fragment shader source per style. Exported so a test can assert every style
 * is a real render stage rather than a CSS filter, and so the `normal` style is
 * visibly the one entry with no shader.
 */
export const SHADERS = Object.freeze({
  nvg: `${HEADER}
uniform float gain;
uniform float noise;
uniform float vignette;
uniform float time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 color = texture2D(colorTexture, v_textureCoordinates);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float boosted = pow(clamp(luma * gain, 0.0, 1.0), 0.55);
  float grain = (hash(v_textureCoordinates * vec2(1024.0, 768.0) + vec2(time)) - 0.5) * noise;
  boosted = clamp(boosted + grain, 0.0, 1.0);
  vec2 centered = v_textureCoordinates - 0.5;
  float edge = 1.0 - smoothstep(0.35, 0.72, length(centered)) * vignette;
  vec3 green = vec3(0.16, 1.0, 0.34) * boosted * edge;
  gl_FragColor = vec4(green, color.a);
}`,

  flir: `${HEADER}
uniform float sensitivity;
uniform float whiteHot;
uniform float vignette;

vec3 palette(float t) {
  t = clamp(t, 0.0, 1.0);
  if (whiteHot > 0.5) return vec3(t);
  vec3 c0 = vec3(0.0, 0.0, 0.02);
  vec3 c1 = vec3(0.25, 0.02, 0.55);
  vec3 c2 = vec3(0.9, 0.18, 0.1);
  vec3 c3 = vec3(1.0, 0.75, 0.15);
  vec3 c4 = vec3(1.0, 1.0, 1.0);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  vec4 color = texture2D(colorTexture, v_textureCoordinates);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float heat = clamp(pow(luma, 1.0 / max(0.05, sensitivity)), 0.0, 1.0);
  vec2 centered = v_textureCoordinates - 0.5;
  float edge = 1.0 - smoothstep(0.4, 0.75, length(centered)) * vignette;
  gl_FragColor = vec4(palette(heat) * edge, color.a);
}`,

  mono: `${HEADER}
uniform float contrast;
uniform float brightness;

void main() {
  vec4 color = texture2D(colorTexture, v_textureCoordinates);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  luma = clamp((luma - 0.5) * contrast + 0.5 + brightness, 0.0, 1.0);
  gl_FragColor = vec4(vec3(luma), color.a);
}`,

  noir: `${HEADER}
uniform float grain;
uniform float vignette;
uniform float contrast;
uniform float time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 color = texture2D(colorTexture, v_textureCoordinates);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  luma = clamp((luma - 0.5) * contrast + 0.5, 0.0, 1.0);
  float g = (hash(v_textureCoordinates * vec2(900.0, 700.0) + vec2(time)) - 0.5) * grain;
  vec2 centered = v_textureCoordinates - 0.5;
  float edge = 1.0 - smoothstep(0.25, 0.85, length(centered)) * vignette;
  float warm = luma * edge + g;
  gl_FragColor = vec4(vec3(warm * 1.0, warm * 0.98, warm * 0.94), color.a);
}`,

  crt: `${HEADER}
uniform float scanlines;
uniform float curvature;
uniform float aberration;
uniform float noise;
uniform float time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 curve(vec2 uv) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  return uv + c * r2 * curvature;
}

void main() {
  vec2 uv = curve(v_textureCoordinates);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float shift = aberration * 0.0035;
  float r = texture2D(colorTexture, uv + vec2(shift, 0.0)).r;
  float g = texture2D(colorTexture, uv).g;
  float b = texture2D(colorTexture, uv - vec2(shift, 0.0)).b;
  vec3 color = vec3(r, g, b);
  float lines = 0.5 + 0.5 * sin(uv.y * 900.0);
  color *= mix(1.0, lines, scanlines);
  float flicker = 0.97 + 0.03 * sin(time * 9.0);
  color *= flicker;
  float grain = (hash(uv * vec2(1200.0, 800.0) + vec2(time)) - 0.5) * noise;
  vec2 centered = uv - 0.5;
  float edge = 1.0 - smoothstep(0.35, 0.85, length(centered)) * 0.8;
  gl_FragColor = vec4((color + grain) * edge, 1.0);
}`,

  surveillance: `${HEADER}
uniform float scanlines;
uniform float grain;
uniform float time;
uniform float pixelation;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = v_textureCoordinates;
  float blocks = max(1.0, pixelation * 400.0);
  uv = floor(uv * blocks) / blocks;
  vec4 color = texture2D(colorTexture, uv);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float lines = 0.65 + 0.35 * sin(uv.y * 700.0);
  luma *= mix(1.0, lines, scanlines);
  float g = (hash(uv * vec2(800.0, 600.0) + vec2(time)) - 0.5) * grain;
  luma = clamp(luma + g, 0.0, 1.0);
  gl_FragColor = vec4(vec3(luma * 0.92, luma * 0.96, luma), color.a);
}`,

  blueprint: `${HEADER}
uniform float grid;
uniform float lineBoost;

void main() {
  vec4 color = texture2D(colorTexture, v_textureCoordinates);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  float edges = abs(luma - dot(texture2D(colorTexture, v_textureCoordinates + vec2(0.0015, 0.0)).rgb, vec3(0.3333)));
  edges += abs(luma - dot(texture2D(colorTexture, v_textureCoordinates + vec2(0.0, 0.0015)).rgb, vec3(0.3333)));
  edges = clamp(edges * lineBoost, 0.0, 1.0);
  vec2 g = abs(fract(v_textureCoordinates * 60.0) - 0.5);
  float lines = 1.0 - smoothstep(0.46, 0.5, min(g.x, g.y));
  vec3 base = vec3(0.02, 0.08, 0.16);
  vec3 ink = vec3(0.35, 0.8, 1.0);
  vec3 outColor = base + ink * (edges * 0.85 + lines * grid * 0.25);
  gl_FragColor = vec4(outColor, color.a);
}`,
});

export const VISUAL_STYLES = Object.freeze([
  {
    id: 'normal',
    label: 'Standard',
    description: 'No post-processing.',
    params: {},
  },
  {
    id: 'nvg',
    label: 'Night vision',
    description: 'Green-phosphor intensifier look. A rendering style, not real night vision.',
    params: {
      gain: { label: 'Gain', min: 0.4, max: 4, step: 0.05, default: 1.9 },
      noise: { label: 'Sensor noise', min: 0, max: 0.4, step: 0.01, default: 0.1 },
      vignette: { label: 'Vignette', min: 0, max: 1, step: 0.05, default: 0.7 },
    },
  },
  {
    id: 'flir',
    label: 'FLIR palette',
    description: 'Thermal-style colour ramp applied to the visible-light buffer. Stylisation, not radiometric data.',
    params: {
      sensitivity: { label: 'Sensitivity', min: 0.3, max: 3, step: 0.05, default: 1.4 },
      whiteHot: { label: 'White hot', min: 0, max: 1, step: 1, default: 0 },
      vignette: { label: 'Vignette', min: 0, max: 1, step: 0.05, default: 0.55 },
    },
  },
  {
    id: 'mono',
    label: 'Monochrome',
    description: 'Greyscale with adjustable contrast.',
    params: {
      contrast: { label: 'Contrast', min: 0.4, max: 2.5, step: 0.05, default: 1.25 },
      brightness: { label: 'Brightness', min: -0.4, max: 0.4, step: 0.02, default: 0.02 },
    },
  },
  {
    id: 'noir',
    label: 'Noir',
    description: 'High-contrast monochrome with film grain and vignette.',
    params: {
      contrast: { label: 'Contrast', min: 0.5, max: 3, step: 0.05, default: 1.5 },
      grain: { label: 'Grain', min: 0, max: 0.4, step: 0.01, default: 0.12 },
      vignette: { label: 'Vignette', min: 0, max: 1, step: 0.05, default: 0.6 },
    },
  },
  {
    id: 'crt',
    label: 'CRT terminal',
    description: 'Scanlines, barrel curvature, chromatic aberration and noise.',
    params: {
      scanlines: { label: 'Scanlines', min: 0, max: 1, step: 0.05, default: 0.5 },
      curvature: { label: 'Curvature', min: 0, max: 1.5, step: 0.05, default: 0.5 },
      aberration: { label: 'Chromatic split', min: 0, max: 3, step: 0.1, default: 1.2 },
      noise: { label: 'Noise', min: 0, max: 0.3, step: 0.01, default: 0.06 },
    },
  },
  {
    id: 'surveillance',
    label: 'CCTV',
    description: 'Low-resolution, noisy security-camera presentation.',
    params: {
      scanlines: { label: 'Scanlines', min: 0, max: 1, step: 0.05, default: 0.5 },
      grain: { label: 'Grain', min: 0, max: 0.4, step: 0.01, default: 0.14 },
      pixelation: { label: 'Pixelation', min: 0, max: 1, step: 0.05, default: 0.25 },
    },
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    description: 'Edge-boosted technical drawing look.',
    params: {
      grid: { label: 'Grid', min: 0, max: 1, step: 0.05, default: 0.5 },
      lineBoost: { label: 'Edge strength', min: 1, max: 20, step: 0.5, default: 8 },
    },
  },
]);

export const STYLE_IDS = VISUAL_STYLES.map((style) => style.id);

export function getStyle(id) {
  return VISUAL_STYLES.find((style) => style.id === id) || VISUAL_STYLES[0];
}

export function defaultParamsFor(id) {
  const style = getStyle(id);
  const out = {};
  for (const [key, definition] of Object.entries(style.params)) out[key] = definition.default;
  return out;
}

export function createVisualEffects({ viewer }) {
  const stages = new Map();
  let activeId = 'normal';
  let activeStage = null;
  let timeHandle = null;
  let startTime = performance.now();
  const values = {};

  const needsTime = (id) => ['nvg', 'crt', 'surveillance', 'noir'].includes(id);

  function removeActive() {
    if (activeStage) {
      try {
        viewer.scene.postProcessStages.remove(activeStage);
      } catch {
        /* already removed */
      }
      activeStage = null;
    }
    if (timeHandle) {
      clearInterval(timeHandle);
      timeHandle = null;
    }
  }

  function setStyle(id, overrides = {}) {
    const style = getStyle(id);
    removeActive();
    activeId = style.id;
    Object.assign(values, defaultParamsFor(style.id), overrides);

    if (style.id === 'normal') {
      viewer.scene.postProcessStages.remove?.(activeStage);
      return activeId;
    }

    const shader = SHADERS[style.id];
    if (!shader) return 'normal';

    const uniforms = {};
    for (const [key, definition] of Object.entries(style.params)) {
      uniforms[key] = () => Number(values[key] ?? definition.default);
    }
    if (needsTime(style.id)) {
      uniforms.time = () => (performance.now() - startTime) / 1000;
    }

    try {
      activeStage = viewer.scene.postProcessStages.add(new Cesium.PostProcessStage({ shader, uniforms }));
    } catch (error) {
      // A shader that fails to compile must not take the globe down.
      console.error('[effects] stage failed to compile', error);
      activeStage = null;
      activeId = 'normal';
      return 'normal';
    }

    if (needsTime(style.id)) {
      timeHandle = setInterval(() => {
        /* the uniform closure reads the clock; nothing to do */
      }, 250);
    }
    return activeId;
  }

  return {
    setStyle,
    setParam(key, value) {
      values[key] = Number(value);
    },
    get styleId() {
      return activeId;
    },
    get params() {
      return { ...values };
    },
    styles: VISUAL_STYLES,
    dispose() {
      removeActive();
      stages.clear();
    },
  };
}
