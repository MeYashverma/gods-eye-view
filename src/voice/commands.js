/**
 * Voice command parser.
 *
 * A small, deterministic grammar over the Web Speech API transcript. It is
 * deliberately narrow: the executor only ever reports what actually happened,
 * so there is no assistant persona claiming to have done something it did not.
 *
 * The parser is pure, so every phrase below is covered by unit tests without
 * a microphone or a browser.
 */

export const INTENTS = Object.freeze({
  FLY_TO: 'fly-to',
  TOGGLE_LAYER: 'toggle-layer',
  SET_LAYER: 'set-layer',
  STYLE: 'style',
  CAMERA: 'camera',
  TRACK: 'track',
  REFRESH: 'refresh',
  SHARE: 'share',
  CLEAN: 'clean',
  DESCRIBE: 'describe',
  HELP: 'help',
  UNKNOWN: 'unknown',
});

export const CAMERA_VERBS = Object.freeze({
  'reset camera': { action: 'reset' },
  'whole earth': { action: 'reset' },
  'global view': { action: 'reset' },
  'zoom out': { action: 'zoom-out' },
  'zoom in': { action: 'zoom-in' },
  'top down': { action: 'top-down' },
  'orbit left': { action: 'orbit', degrees: -45 },
  'orbit right': { action: 'orbit', degrees: 45 },
  'tilt down': { action: 'pitch', delta: -15 },
  'tilt up': { action: 'pitch', delta: 15 },
});

const STYLE_ALIASES = Object.freeze([
  { phrase: 'night vision', style: 'nvg' },
  { phrase: 'night vision mode', style: 'nvg' },
  { phrase: 'thermal', style: 'flir' },
  { phrase: 'flir', style: 'flir' },
  { phrase: 'infrared', style: 'flir' },
  { phrase: 'monochrome', style: 'mono' },
  { phrase: 'black and white', style: 'mono' },
  { phrase: 'grayscale', style: 'mono' },
  { phrase: 'noir', style: 'noir' },
  { phrase: 'crt', style: 'crt' },
  { phrase: 'retro', style: 'crt' },
  { phrase: 'cctv', style: 'surveillance' },
  { phrase: 'surveillance', style: 'surveillance' },
  { phrase: 'blueprint', style: 'blueprint' },
  { phrase: 'normal', style: 'normal' },
  { phrase: 'standard', style: 'normal' },
  { phrase: 'clear style', style: 'normal' },
]);

/**
 * @param {string} transcript
 * @param {{layerAliases: Map<string,string>, styleIds: string[]}} vocabulary
 */
export function parseCommand(transcript, vocabulary = {}) {
  const raw = String(transcript ?? '').trim();
  if (!raw) return { intent: INTENTS.UNKNOWN, reason: 'empty' };
  const text = normalize(raw);

  if (/^(help|what can you do|commands)/.test(text)) {
    return { intent: INTENTS.HELP };
  }

  const camera = matchCamera(text);
  if (camera) return { intent: INTENTS.CAMERA, ...camera };

  const style = matchStyle(text, vocabulary.styleIds);
  if (style) return { intent: INTENTS.STYLE, style };

  if (/^(share|copy) (this )?(view|link)/.test(text) || text === 'share' || text === 'copy link') {
    return { intent: INTENTS.SHARE };
  }
  if (/clean (view|screen|mode)|presentation mode/.test(text)) {
    return { intent: INTENTS.CLEAN, enabled: !/\b(off|exit|stop)\b/.test(text) };
  }
  if (/^(track|follow) (this|it|that|selected)?/.test(text) || text === 'track' || text === 'follow') {
    return { intent: INTENTS.TRACK, enabled: !/\b(stop|off|cancel)\b/.test(text) };
  }
  if (/stop (tracking|following)/.test(text)) {
    return { intent: INTENTS.TRACK, enabled: false };
  }
  if (/^refresh/.test(text) || text === 'refresh data' || text === 'update data') {
    return { intent: INTENTS.REFRESH };
  }
  if (/^(what|describe|tell me about)( is)? (selected|this|that)/.test(text)) {
    return { intent: INTENTS.DESCRIBE };
  }

  const layerToggle = matchLayerToggle(text, vocabulary.layerAliases);
  if (layerToggle) return { intent: INTENTS.SET_LAYER, ...layerToggle };

  const flyTo = matchFlyTo(text);
  if (flyTo) return { intent: INTENTS.FLY_TO, ...flyTo };

  return { intent: INTENTS.UNKNOWN, reason: raw, text: raw };
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[?!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCamera(text) {
  for (const [phrase, action] of Object.entries(CAMERA_VERBS)) {
    if (text.includes(phrase)) return { ...action };
  }
  return null;
}

function matchStyle(text, styleIds = []) {
  for (const alias of STYLE_ALIASES) {
    if (text.includes(alias.phrase) && (!styleIds.length || styleIds.includes(alias.style))) {
      return alias.style;
    }
  }
  const explicit = text.match(/^(?:set )?style (\w+)$/);
  if (explicit && styleIds.includes(explicit[1])) return explicit[1];
  return null;
}

const TOGGLE_OFF = /\b(off|hide|disable|stop showing|turn off|switch off)\b/;
const TOGGLE_ON = /\b(on|show|enable|display|turn on|switch on|activate)\b/;

function matchLayerToggle(text, aliases = new Map()) {
  const wantsOn = TOGGLE_ON.test(text);
  const wantsOff = TOGGLE_OFF.test(text);
  if (!wantsOn && !wantsOff && !/^toggle /.test(text)) return null;

  // Longest alias first so "military aircraft" wins over "aircraft".
  const entries = [...aliases.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, layerId] of entries) {
    if (!text.includes(phrase)) continue;
    const enabled = wantsOff ? false : wantsOn ? true : null;
    return { layerId, enabled };
  }
  return null;
}

const FLY_PATTERNS = [
  /^(?:fly|go|navigate|take me|zoom) to (.+)$/,
  /^show (?:me )?(.+)$/,
  /^search for (.+)$/,
  /^(?:find|locate) (.+)$/,
  /^where is (.+)$/,
];

function matchFlyTo(text) {
  for (const pattern of FLY_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const target = match[1].trim();
    if (!target || target.length > 120) continue;
    if (/^(the )?(globe|earth|map)$/i.test(target)) continue;
    return { query: titleCase(target) };
  }
  return null;
}

function titleCase(text) {
  return text.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

/**
 * Build the alias table the parser matches against, from the live layer list.
 * Aliases are lowercase and include the layer's own words so "turn on active
 * fires" finds the "Active fires (NASA FIRMS)" layer.
 */
export function buildLayerAliases(layers) {
  const aliases = new Map();
  for (const layer of layers) {
    const name = String(layer.name || '');
    const lowered = name.toLowerCase();
    aliases.set(lowered, layer.id);
    // Strip parentheticals and trailing qualifiers.
    const simple = lowered.replace(/\s*\(.*?\)/g, '').trim();
    if (simple && !aliases.has(simple)) aliases.set(simple, layer.id);
    // First two words, so "active fires" works for "active fires (nasa firms)".
    const words = simple.split(/\s+/);
    if (words.length > 2) {
      const shortName = words.slice(0, 2).join(' ');
      if (!aliases.has(shortName)) aliases.set(shortName, layer.id);
    }
    if (layer.id && !aliases.has(layer.id)) aliases.set(layer.id.replace(/-/g, ' '), layer.id);
  }
  return aliases;
}
