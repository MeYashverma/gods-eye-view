/**
 * Console shell — top status bar, telemetry strip, tool clusters and HUD.
 *
 * The shell owns no data. It reads the app store and the camera, and calls the
 * controllers the app hands it.
 */

import { el, clear } from '../core/dom.js';
import { button, createToasts, iconHtml } from './components.js';
import { iconMarkup } from '../core/icons.js';
import { VISUAL_STYLES } from '../tools/effects.js';
import {
  formatLat,
  formatLon,
  formatDistance,
  compassPoint,
} from '../geo/coords.js';
import { formatUtc } from '../net/status.js';

export function createShell({ root, events }) {
  const app = root;

  /* ------------------------------- top bar ------------------------------ */

  const brand = el('div', { class: 'gev-topbar__brand' },
    el('span', { html: iconMarkup('globe', { size: 17 }) }),
    el('span', { class: 'gev-topbar__name', text: "GOD'S EYE VIEW" }),
  );
  const subtitle = el('span', { class: 'gev-topbar__sub', text: 'INDEPENDENT COMMUNITY BUILD · STATIC HOSTING' });

  const searchInput = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search a place or paste coordinates…   /',
    'aria-label': 'Search for a place or coordinates',
    style: { maxWidth: '330px', flex: '1 1 220px' },
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const searchWrap = el('div', { style: { position: 'relative', display: 'flex', flex: '1 1 220px', maxWidth: '340px' } },
    searchInput,
  );
  const resultsRoot = el('div', {
    class: 'panel',
    style: { position: 'absolute', top: '34px', left: 0, right: 0, zIndex: 40, maxHeight: '320px', overflowY: 'auto' },
  });
  resultsRoot.classList.add('is-closed');
  const results = {
    root: resultsRoot,
    render(...nodes) {
      clear(resultsRoot);
      resultsRoot.append(...nodes);
      return resultsRoot;
    },
    show() {
      resultsRoot.classList.remove('is-closed');
    },
    hide() {
      resultsRoot.classList.add('is-closed');
    },
    get isOpen() {
      return !resultsRoot.classList.contains('is-closed');
    },
  };
  searchWrap.append(resultsRoot);

  const clockNode = el('div', { class: 'gev-topbar__clock' },
    el('span', { class: 'mono', text: '--:--:--' }),
    el('small', { text: 'UTC' }),
  );

  const buttons = {};
  const makeButton = (id, icon, label, onClick) => {
    const node = button({ icon, label, className: 'btn btn--icon', onClick, title: label });
    buttons[id] = node;
    return node;
  };

  const topbar = el('header', { class: 'gev-topbar' },
    brand,
    subtitle,
    makeButton('layers', 'panelLeft', 'Layer navigator (L)'),
    searchWrap,
    el('span', { class: 'gev-topbar__spacer' }),
    makeButton('display', 'palette', 'Visual style'),
    makeButton('hud', 'crosshair', 'Heads-up display (H)'),
    makeButton('voice', 'mic', 'Voice control (V)'),
    makeButton('clean', 'eye', 'Clean view (P)'),
    makeButton('share', 'share', 'Share this view (S)'),
    makeButton('attribution', 'info', 'Data sources & attribution'),
    makeButton('settings', 'settings', 'Settings (,)'),
    makeButton('context', 'panelRight', 'Context panel (C)'),
    clockNode,
  );

  /* ------------------------------ telemetry ----------------------------- */

  const tele = {
    coords: el('b', { text: '—' }),
    alt: el('b', { text: '—' }),
    heading: el('b', { text: '—' }),
    zoom: el('b', { text: '—' }),
    layers: el('b', { text: '0' }),
    contacts: el('b', { text: '0' }),
    source: el('b', { text: '—' }),
    fps: el('b', { text: '—' }),
  };
  const item = (label, node, extraClass = '') =>
    el('span', { class: `gev-tele__item ${extraClass}`.trim() }, el('span', { class: 't-mute', text: label }), node);

  const telemetry = el('footer', { class: 'gev-tele', role: 'status', 'aria-live': 'off' },
    item('POS', tele.coords),
    el('span', { class: 'gev-tele__sep' }),
    item('ALT', tele.alt, 'gev-tele__hide-sm'),
    el('span', { class: 'gev-tele__sep gev-tele__hide-sm' }),
    item('HDG', tele.heading, 'gev-tele__hide-sm'),
    el('span', { class: 'gev-tele__sep gev-tele__hide-sm' }),
    item('Z', tele.zoom, 'gev-tele__hide-sm'),
    el('span', { class: 'gev-tele__spacer' }),
    item('LAYERS', tele.layers),
    el('span', { class: 'gev-tele__sep' }),
    item('CONTACTS', tele.contacts),
    el('span', { class: 'gev-tele__sep gev-tele__hide-sm' }),
    item('FPS', tele.fps, 'gev-tele__hide-sm'),
    el('span', { class: 'gev-tele__sep gev-tele__hide-sm' }),
    item('SRC', tele.source, 'gev-tele__hide-sm'),
  );

  /* ------------------------------- clusters ----------------------------- */

  const navCluster = el('div', { class: 'gev-cluster gev-cluster--nav' });
  const viewCluster = el('div', { class: 'gev-cluster gev-cluster--view' });

  /* --------------------------------- HUD -------------------------------- */

  const hud = el('div', { class: 'gev-hud gev-hud--tl is-hidden', 'aria-hidden': 'true' },
    el('div', { class: 'gev-hud__cross' }),
    el('div', { class: 'hud-readout', text: '—' }),
  );
  const hudReadout = hud.querySelector('.hud-readout');

  /* ------------------------------ overlay ------------------------------- */

  const overlay = el('canvas', { id: 'gev-overlay' });
  const credits = el('div', { id: 'gev-credits' });
  const toasts = el('div', { class: 'gev-toasts', role: 'status', 'aria-live': 'polite' });
  const scrim = el('div', { class: 'gev-scrim is-hidden' });

  app.append(topbar, overlay, hud, navCluster, viewCluster, credits, telemetry, toasts, scrim);

  return {
    root: app,
    topbar,
    searchInput,
    results,
    buttons,
    telemetry,
    tele,
    clockNode,
    navCluster,
    viewCluster,
    hud,
    hudReadout,
    overlay,
    credits,
    scrim,
    toasts: createToasts(toasts),
    setTelemetry({ focus, layersOn, contacts, fps, sourceSummary }) {
      if (focus) {
        tele.coords.textContent = `${formatLat(focus.lat, 3)} ${formatLon(focus.lon, 3)}`;
        tele.alt.textContent = formatDistance(focus.heightM);
        tele.heading.textContent = `${Math.round(focus.heading)}° ${compassPoint(focus.heading)}`;
        tele.zoom.textContent = `z${focus.zoom.toFixed(1)}`;
      }
      if (Number.isFinite(layersOn)) tele.layers.textContent = String(layersOn);
      if (Number.isFinite(contacts)) tele.contacts.textContent = contacts.toLocaleString();
      if (Number.isFinite(fps)) tele.fps.textContent = String(Math.round(fps));
      if (sourceSummary) tele.source.textContent = sourceSummary;
      clockNode.firstElementChild.textContent = formatUtc();
    },
    setHud(text) {
      hudReadout.textContent = text;
    },
    buildNavCluster(actions) {
      clear(navCluster);
      for (const action of actions) {
        navCluster.append(
          button({
            icon: action.icon,
            label: action.label,
            className: 'btn btn--icon',
            title: action.label,
            onClick: action.onClick,
          }),
        );
      }
    },
    buildViewCluster(styleId, onSelect) {
      clear(viewCluster);
      for (const style of VISUAL_STYLES) {
        const node = button({
          label: style.label,
          className: `btn btn--sm${style.id === styleId ? ' btn--on' : ''}`,
          title: style.description,
          onClick: () => onSelect(style.id),
        });
        node.dataset.styleId = style.id;
        viewCluster.append(node);
      }
    },
    highlightStyle(styleId) {
      for (const node of viewCluster.querySelectorAll('[data-style-id]')) {
        node.classList.toggle('btn--on', node.dataset.styleId === styleId);
      }
    },
    iconHtml,
  };
}
