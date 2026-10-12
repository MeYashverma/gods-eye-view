/**
 * Left rail — the layer navigator, per-layer status and per-layer options.
 */

import { el, clear } from '../core/dom.js';
import {
  button,
  chips,
  iconHtml,
  notice,
  select,
  slider,
  statusDot,
  textInput,
  toggle,
  createModal,
} from './components.js';
import { statusLabel, statusTone, formatAge } from '../net/status.js';
import { LAYER_STATUS } from '../net/status.js';
import { SOURCES, getSource } from '../sources/registry.js';

export function createLayerPanel({ panel, groups, onOpenInfo }) {
  const search = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter layers…',
    'aria-label': 'Filter layers',
    oninput: (event) => filter(event.target.value),
  });

  const list = el('div', { class: 'layer-list' });
  const searchRow = el('div', { class: 'layer-search' }, iconHtml('search', 13), search);

  const rows = new Map();

  for (const group of groups) {
    const groupBody = el('div', { class: 'layer-group__body' });
    const chevron = el('span', { class: 'chev', html: iconHtml('chevronDown', 12).outerHTML });
    const head = el('button', { class: 'layer-group__head', type: 'button', 'aria-expanded': 'true' },
      chevron,
      el('span', { text: group.label }),
      el('span', { class: 'layer-group__count', text: String(group.layers.length) }),
    );
    const groupRoot = el('div', { class: 'layer-group', dataset: { group: group.id } }, head, groupBody);
    head.addEventListener('click', () => {
      const collapsed = groupRoot.classList.toggle('is-collapsed');
      head.setAttribute('aria-expanded', String(!collapsed));
    });

    for (const layer of group.layers) {
      groupBody.append(buildRow(layer));
    }
    list.append(groupRoot);
  }

  function buildRow(layer) {
    const name = el('span', { class: 'layer-row__name', text: layer.name });
    const meta = el('span', { class: 'layer-row__meta' });
    const dot = statusDot('idle');
    const statusText = el('span', { text: 'Ready' });
    const info = el('button', {
      class: 'layer-row__info',
      type: 'button',
      title: 'Layer details and options',
      'aria-label': `${layer.name} details and options`,
      html: iconHtml('sliders', 13).outerHTML,
      onclick: (event) => {
        event.stopPropagation();
        onOpenInfo(layer);
      },
    });

    const row = el('button', {
      class: 'layer-row',
      type: 'button',
      'aria-pressed': 'false',
      title: layer.description,
    },
      el('span', { class: 'layer-row__icon', html: iconHtml(layer.icon, 15).outerHTML }),
      el('span', { class: 'layer-row__label' }, name, meta),
      el('span', { class: 'layer-row__status' }, dot, statusText, info),
    );

    row.addEventListener('click', () => layer.toggle());

    layer.subscribe((snapshot) => {
      row.classList.toggle('is-on', snapshot.visible);
      row.setAttribute('aria-pressed', String(snapshot.visible));
      dot.className = `dot dot--${statusTone(snapshot.status)}`;
      const bits = [];
      if (snapshot.visible && snapshot.count) bits.push(snapshot.count.toLocaleString());
      if (snapshot.visible && snapshot.fetchedAt) bits.push(formatAge(Date.now() - snapshot.fetchedAt));
      if (snapshot.demo) bits.push('SAMPLE');
      statusText.textContent = statusLabel(snapshot.status);
      meta.textContent = bits.join(' · ');
    });

    rows.set(layer.id, { row, layer });
    return row;
  }

  function filter(query) {
    const needle = String(query || '').trim().toLowerCase();
    for (const { row, layer } of rows.values()) {
      const haystack = `${layer.name} ${layer.id} ${layer.description}`.toLowerCase();
      row.style.display = !needle || haystack.includes(needle) ? '' : 'none';
    }
    for (const groupRoot of list.querySelectorAll('.layer-group')) {
      const anyVisible = [...groupRoot.querySelectorAll('.layer-row')].some(
        (row) => row.style.display !== 'none',
      );
      groupRoot.style.display = anyVisible ? '' : 'none';
    }
  }

  const bulkRow = el('div', { class: 'layer-search' },
    button({ label: 'All off', className: 'btn btn--sm', onClick: () => clearAll() }),
    el('span', { style: { flex: '1 1 auto' } }),
    button({ label: 'Refresh', icon: 'refresh', className: 'btn btn--sm', onClick: () => refreshVisible() }),
  );

  function clearAll() {
    for (const { layer } of rows.values()) {
      if (layer.visible) layer.hide();
    }
  }

  function refreshVisible() {
    for (const { layer } of rows.values()) {
      if (layer.visible) layer.refresh({ force: true }).catch(() => {});
    }
  }

  panel.render(searchRow, bulkRow, list);

  return {
    clearAll,
    refreshVisible,
    setLayerVisible(id, visible) {
      const entry = rows.get(id);
      if (!entry) return;
      if (visible && !entry.layer.visible) entry.layer.show();
      if (!visible && entry.layer.visible) entry.layer.hide();
    },
  };
}

/**
 * Per-layer options sheet. Builds whatever the layer declared through its
 * `configure({ panel })` callback, so adding an option to a layer never
 * requires touching the UI.
 */
export function createLayerInfoModal({ layers, settings, onRoute }) {
  const modal = createModal({ title: 'Layer', wide: true });
  let currentLayer = null;

  function open(layer) {
    currentLayer = layer;
    modal.setTitle(layer.name);
    clear(modal.body);

    modal.body.append(el('p', { class: 't-dim', style: { margin: 0, lineHeight: '1.6' }, text: layer.description }));

    const status = layer.snapshot();
    modal.body.append(
      notice({
        tone: toneFor(status.status),
        title: `Status · ${statusLabel(status.status)}`,
        body: statusMessage(status),
      }),
    );

    modal.body.append(sourceSection(layer));

    if (typeof layer.configure === 'function') {
      const optionsSection = el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Options' }));
      const builder = createPanelBuilder({ layer, settings, container: optionsSection, onRoute });
      try {
        layer.configure({ panel: builder, layer, settings });
      } catch (error) {
        console.error('[layer:configure] failed', error);
        optionsSection.append(notice({ tone: 'crit', title: 'Options failed to render', body: String(error?.message || error) }));
      }
      modal.body.append(optionsSection);
    }

    modal.body.append(el('div', { class: 'ctx-actions' },
      button({
        label: layer.visible ? 'Hide layer' : 'Show layer',
        icon: layer.visible ? 'eyeOff' : 'eye',
        className: 'btn btn--primary',
        onClick: () => {
          layer.toggle();
          open(layer);
        },
      }),
      button({
        label: 'Refresh now',
        icon: 'refresh',
        onClick: () => {
          layer.refresh({ force: true }).catch(() => {});
          open(layer);
        },
      }),
    ));

    modal.show();
  }

  return { open, modal, get current() { return currentLayer; } };
}

function toneFor(status) {
  switch (status) {
    case LAYER_STATUS.BLOCKED:
    case LAYER_STATUS.ERROR:
    case LAYER_STATUS.OFFLINE:
    case LAYER_STATUS.UNAVAILABLE:
      return 'crit';
    case LAYER_STATUS.CONFIG_REQUIRED:
    case LAYER_STATUS.STALE:
    case LAYER_STATUS.RATE_LIMITED:
      return 'warn';
    case LAYER_STATUS.SIMULATED:
      return 'demo';
    default:
      return 'info';
  }
}

function statusMessage(status) {
  if (status.message) return status.message;
  switch (status.status) {
    case LAYER_STATUS.BLOCKED:
      return 'The provider did not send a CORS header for this origin, so the browser blocked the response. A static site cannot work around that.';
    case LAYER_STATUS.CONFIG_REQUIRED:
      return 'This layer needs a provider credential or endpoint. Add it in Settings or in the options above.';
    case LAYER_STATUS.EMPTY:
      return 'The provider answered successfully with no features for the current view.';
    case LAYER_STATUS.OFFLINE:
      return 'The browser reports no network connection.';
    case LAYER_STATUS.IDLE:
      return 'Not loaded yet.';
    case LAYER_STATUS.SIMULATED:
      return 'SAMPLE DATA — synthesised for demonstration. Nothing here is an observation.';
    default:
      return statusLabel(status.status);
  }
}

function sourceSection(layer) {
  const wrap = el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Data source & attribution' }));
  for (const sourceId of layer.sources) {
    const source = getSource(sourceId);
    if (!source) continue;
    wrap.append(
      el('div', { class: 'notice' },
        el('div', { class: 'notice__title', text: source.name }),
        el('div', { text: source.license }),
        el('div', { class: 't-mute', style: { fontSize: '10.5px', marginTop: '3px' }, text: source.notes }),
        el('div', { style: { marginTop: '4px' } },
          el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.url }),
        ),
        el('div', { style: { marginTop: '4px' } },
          el('span', {
            class: `badge badge--${source.browserDirect ? 'live' : 'config'}`,
            text: source.browserDirect ? 'Browser-readable' : 'Not browser-readable',
          }),
        ),
      ),
    );
  }
  if (!layer.sources.length) {
    wrap.append(el('div', { class: 't-mute', text: 'No external source.' }));
  }
  return wrap;
}

/**
 * The object handed to a layer's `configure()` callback. Each method appends
 * a control bound to the layer's own params, or to the settings store when
 * the control names a provider credential.
 */
function createPanelBuilder({ layer, settings, container, onRoute }) {
  return {
    toggle({ id, label, help }) {
      const control = toggle({
        label,
        checked: Boolean(layer.params[id]),
        help,
        id: `${layer.id}-${id}`,
        onChange: (value) => layer.setParams({ [id]: value }),
      });
      container.append(control);
      if (help) container.append(el('p', { class: 't-mute', style: { margin: '-2px 0 4px', fontSize: '10.5px', lineHeight: '1.45' }, text: help }));
    },
    slider({ id, label, min, max, step = 1, format }) {
      container.append(
        slider({
          label,
          value: Number(layer.params[id] ?? min),
          min,
          max,
          step,
          format: format || ((value) => String(value)),
          onChange: (value) => layer.setParams({ [id]: value }),
        }),
      );
    },
    select({ id, label, options }) {
      container.append(
        select({
          label,
          value: layer.params[id],
          options,
          id: `${layer.id}-${id}`,
          onChange: (value) => {
            const option = options.find((entry) => String(entry.value) === String(value));
            layer.setParams({ [id]: typeof option?.value === 'number' ? option.value : value });
          },
        }),
      );
    },
    chips({ id, label, options }) {
      container.append(
        chips({
          label,
          values: layer.params[id],
          options,
          onChange: (value) => layer.setParams({ [id]: value }),
        }),
      );
    },
    notice({ title, body, tone }) {
      container.append(notice({ title, body, tone }));
    },
    setting({ id, label, placeholder, help, secret = false }) {
      const field = textInput({
        label,
        value: settings.get(id) || '',
        placeholder,
        help,
        secret,
        id: `${layer.id}-${id}`,
        onChange: (value) => settings.set(id, value.trim()),
      });
      container.append(field.wrapper);
      if (secret) {
        container.append(
          notice({
            tone: 'warn',
            title: 'Browser-visible credential',
            body: 'Anything entered here is stored in this browser and is readable by the page. Only enter a credential the provider documents for client-side use.',
          }),
        );
      }
    },
    /** Escape hatch for controls that do not fit the generic set. */
    custom(kind) {
      const placeholder = el('div', {
        class: 'notice notice--info',
        dataset: { custom: kind },
      }, el('div', { class: 'notice__title', text: kind }), el('div', { text: 'Rendered by the host panel.' }));
      container.append(placeholder);
      onRoute?.(kind, { layer, container, settings });
    },
  };
}

export { SOURCES };
