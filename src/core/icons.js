/**
 * Icon rendering.
 *
 * Uses Lucide (ISC licensed) — a single, consistent, properly licensed icon
 * set — instead of emoji glyphs, which render differently on every platform
 * and cannot be sized or coloured with the design system.
 *
 * Each icon is imported from its own module so Rollup only bundles the glyphs
 * the console actually renders. `tests/icons.test.mjs` asserts every import
 * path below resolves on disk, so a renamed icon fails the build check rather
 * than silently drawing nothing.
 */
import defaultAttributes from 'lucide/dist/esm/defaultAttributes.mjs';

import Activity from 'lucide/dist/esm/icons/activity.mjs';
import OctagonAlert from 'lucide/dist/esm/icons/octagon-alert.mjs';
import TriangleAlert from 'lucide/dist/esm/icons/triangle-alert.mjs';
import Anchor from 'lucide/dist/esm/icons/anchor.mjs';
import Aperture from 'lucide/dist/esm/icons/aperture.mjs';
import Bike from 'lucide/dist/esm/icons/bike.mjs';
import Broadcast from 'lucide/dist/esm/icons/radio-tower.mjs';
import Building from 'lucide/dist/esm/icons/building.mjs';
import Camera from 'lucide/dist/esm/icons/camera.mjs';
import Check from 'lucide/dist/esm/icons/check.mjs';
import ChevronDown from 'lucide/dist/esm/icons/chevron-down.mjs';
import ChevronLeft from 'lucide/dist/esm/icons/chevron-left.mjs';
import ChevronRight from 'lucide/dist/esm/icons/chevron-right.mjs';
import Clock from 'lucide/dist/esm/icons/clock.mjs';
import Cloud from 'lucide/dist/esm/icons/cloud.mjs';
import CloudLightning from 'lucide/dist/esm/icons/cloud-lightning.mjs';
import CloudRain from 'lucide/dist/esm/icons/cloud-rain.mjs';
import Compass from 'lucide/dist/esm/icons/compass.mjs';
import Copy from 'lucide/dist/esm/icons/copy.mjs';
import Crosshair from 'lucide/dist/esm/icons/crosshair.mjs';
import Database from 'lucide/dist/esm/icons/database.mjs';
import Download from 'lucide/dist/esm/icons/download.mjs';
import ExternalLink from 'lucide/dist/esm/icons/external-link.mjs';
import Eye from 'lucide/dist/esm/icons/eye.mjs';
import EyeOff from 'lucide/dist/esm/icons/eye-off.mjs';
import Factory from 'lucide/dist/esm/icons/factory.mjs';
import Film from 'lucide/dist/esm/icons/film.mjs';
import Flame from 'lucide/dist/esm/icons/flame.mjs';
import Focus from 'lucide/dist/esm/icons/focus.mjs';
import Gauge from 'lucide/dist/esm/icons/gauge.mjs';
import Globe from 'lucide/dist/esm/icons/globe.mjs';
import Headphones from 'lucide/dist/esm/icons/headphones.mjs';
import Info from 'lucide/dist/esm/icons/info.mjs';
import KeyRound from 'lucide/dist/esm/icons/key-round.mjs';
import Layers from 'lucide/dist/esm/icons/layers.mjs';
import LinkIcon from 'lucide/dist/esm/icons/link.mjs';
import MapPin from 'lucide/dist/esm/icons/map-pin.mjs';
import Maximize from 'lucide/dist/esm/icons/maximize.mjs';
import Mic from 'lucide/dist/esm/icons/mic.mjs';
import MicOff from 'lucide/dist/esm/icons/mic-off.mjs';
import Minus from 'lucide/dist/esm/icons/minus.mjs';
import Monitor from 'lucide/dist/esm/icons/monitor.mjs';
import Mountain from 'lucide/dist/esm/icons/mountain.mjs';
import Navigation from 'lucide/dist/esm/icons/navigation.mjs';
import Orbit from 'lucide/dist/esm/icons/orbit.mjs';
import Palette from 'lucide/dist/esm/icons/palette.mjs';
import PanelLeft from 'lucide/dist/esm/icons/panel-left.mjs';
import PanelRight from 'lucide/dist/esm/icons/panel-right.mjs';
import Pause from 'lucide/dist/esm/icons/pause.mjs';
import Pencil from 'lucide/dist/esm/icons/pencil.mjs';
import Plane from 'lucide/dist/esm/icons/plane.mjs';
import Play from 'lucide/dist/esm/icons/play.mjs';
import Plus from 'lucide/dist/esm/icons/plus.mjs';
import Radar from 'lucide/dist/esm/icons/radar.mjs';
import Radio from 'lucide/dist/esm/icons/radio.mjs';
import RefreshCw from 'lucide/dist/esm/icons/refresh-cw.mjs';
import RotateCcw from 'lucide/dist/esm/icons/rotate-ccw.mjs';
import Route from 'lucide/dist/esm/icons/route.mjs';
import Ruler from 'lucide/dist/esm/icons/ruler.mjs';
import Satellite from 'lucide/dist/esm/icons/satellite.mjs';
import Scan from 'lucide/dist/esm/icons/scan.mjs';
import Search from 'lucide/dist/esm/icons/search.mjs';
import Settings from 'lucide/dist/esm/icons/settings.mjs';
import Ship from 'lucide/dist/esm/icons/ship.mjs';
import Siren from 'lucide/dist/esm/icons/siren.mjs';
import SlidersHorizontal from 'lucide/dist/esm/icons/sliders-horizontal.mjs';
import Sun from 'lucide/dist/esm/icons/sun.mjs';
import Target from 'lucide/dist/esm/icons/target.mjs';
import Thermometer from 'lucide/dist/esm/icons/thermometer.mjs';
import TowerControl from 'lucide/dist/esm/icons/tower-control.mjs';
import TrainFront from 'lucide/dist/esm/icons/train-front.mjs';
import Trash from 'lucide/dist/esm/icons/trash.mjs';
import Video from 'lucide/dist/esm/icons/video.mjs';
import Volume2 from 'lucide/dist/esm/icons/volume-2.mjs';
import VolumeX from 'lucide/dist/esm/icons/volume-x.mjs';
import Droplets from 'lucide/dist/esm/icons/droplets.mjs';
import Pentagon from 'lucide/dist/esm/icons/pentagon.mjs';
import Share2 from 'lucide/dist/esm/icons/share-2.mjs';
import Shield from 'lucide/dist/esm/icons/shield.mjs';
import WifiOff from 'lucide/dist/esm/icons/wifi-off.mjs';
import Wind from 'lucide/dist/esm/icons/wind.mjs';
import X from 'lucide/dist/esm/icons/x.mjs';
import Zap from 'lucide/dist/esm/icons/zap.mjs';
import ZoomIn from 'lucide/dist/esm/icons/zoom-in.mjs';
import ZoomOut from 'lucide/dist/esm/icons/zoom-out.mjs';

export const ICONS = {
  activity: Activity,
  alertOctagon: OctagonAlert,
  alert: TriangleAlert,
  anchor: Anchor,
  aperture: Aperture,
  bike: Bike,
  broadcast: Broadcast,
  building: Building,
  camera: Camera,
  check: Check,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  clock: Clock,
  cloud: Cloud,
  cloudLightning: CloudLightning,
  cloudRain: CloudRain,
  compass: Compass,
  copy: Copy,
  crosshair: Crosshair,
  database: Database,
  download: Download,
  external: ExternalLink,
  eye: Eye,
  eyeOff: EyeOff,
  factory: Factory,
  film: Film,
  flame: Flame,
  focus: Focus,
  gauge: Gauge,
  globe: Globe,
  headphones: Headphones,
  info: Info,
  key: KeyRound,
  layers: Layers,
  link: LinkIcon,
  mapPin: MapPin,
  maximize: Maximize,
  mic: Mic,
  micOff: MicOff,
  minus: Minus,
  monitor: Monitor,
  mountain: Mountain,
  navigation: Navigation,
  orbit: Orbit,
  palette: Palette,
  panelLeft: PanelLeft,
  panelRight: PanelRight,
  pause: Pause,
  pencil: Pencil,
  plane: Plane,
  play: Play,
  plus: Plus,
  radar: Radar,
  radio: Radio,
  refresh: RefreshCw,
  reset: RotateCcw,
  route: Route,
  ruler: Ruler,
  satellite: Satellite,
  scan: Scan,
  search: Search,
  settings: Settings,
  ship: Ship,
  siren: Siren,
  sliders: SlidersHorizontal,
  sun: Sun,
  target: Target,
  thermometer: Thermometer,
  tower: TowerControl,
  train: TrainFront,
  trash: Trash,
  video: Video,
  volume: Volume2,
  volumeOff: VolumeX,
  waves: Droplets,
  share: Share2,
  shield: Shield,
  pentagon: Pentagon,
  wifiOff: WifiOff,
  wind: Wind,
  x: X,
  zap: Zap,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
};

export const ICON_NAMES = Object.keys(ICONS);

/** Escape a value for use inside a double-quoted attribute. */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render one icon to an SVG markup string.
 *
 * Every interpolated value is attribute-escaped. `className` and `strokeWidth`
 * are caller-supplied, and an unescaped `"` would let a value break out of its
 * attribute and inject a sibling one (`class="x" onload="..."`).
 */
export function iconMarkup(name, { size = 14, className = '', strokeWidth } = {}) {
  const shape = ICONS[name];
  if (!shape) return '';
  const numericSize = Number.isFinite(Number(size)) ? Number(size) : 14;
  const attrs = {
    ...defaultAttributes,
    width: numericSize,
    height: numericSize,
    ...(strokeWidth ? { 'stroke-width': strokeWidth } : {}),
  };
  if (className) attrs.class = className;
  const body = shape
    .map(([tag, props]) => {
      const rendered = Object.entries(props)
        .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
        .join(' ');
      return `<${tag} ${rendered}/>`;
    })
    .join('');
  const attrString = Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ');
  return `<svg ${attrString} aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Build a live SVG element (preferred when the node is reused/updated). */
export function iconEl(name, { size = 14, className = 'ic', strokeWidth } = {}) {
  const wrapper = document.createElement('span');
  wrapper.className = className;
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.innerHTML = iconMarkup(name, { size, strokeWidth });
  return wrapper.firstElementChild || wrapper;
}
