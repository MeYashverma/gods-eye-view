/**
 * Small UI primitives. Everything the console is made of — panels, sections,
 * sliders, chips, notices, key/value grids — is built here so individual
 * panels stay declarative and consistent.
 */

import { el, clear, escapeHtml, safeUrl } from '../core/dom.js';
import { iconMarkup } from '../core/icons.js';

/* -------------------------------- panels -------------------------------- */

export function createPanel({ id, title, icon, position, className = '' }) {
  const body = el('div', { class: 'panel__body' });
  const titleNode = el('span', { class: 'panel__title', text: title });
  const head = el('div', { class: 'panel__head' }, iconHtml(icon), titleNode);
  const root = el('section', {
    class: `panel ${className}`.trim(),
    id,
    'aria-label': title,
  }, head, body);

  const closeButton = button({
    icon: 'x',
    label: `Close ${title}`,
    className: 'btn btn--icon btn--sm',
    onClick: () => hide(),
  });
  head.append(closeButton);

  function show() {
    root.classList.remove('is-closed');
    document.dispatchEvent(new CustomEvent('gev:panel', { detail: { id, open: true } }));
  }
  function hide() {
    root.classList.add('is-closed');
    document.dispatchEvent(new CustomEvent('gev:panel', { detail: { id, open: false } }));
  }

  return {
    root,
    head,
    titleNode,
    body,
    show,
    hide,
    toggle: () => (root.classList.contains('is-closed') ? show() : hide()),
    setTitle: (value) => {
      titleNode.textContent = value;
    },
    setActions(...nodes) {
      for (const node of head.querySelectorAll('[data-panel-action]')) node.remove();
      for (const node of nodes) {
        node.dataset.panelAction = '1';
        head.insertBefore(node, closeButton);
      }
    },
    get isOpen() {
      return !root.classList.contains('is-closed');
    },
    render(...nodes) {
      clear(body);
      body.append(...nodes);
      return body;
    },
  };
}

export function section({ title, icon, collapsed = false, body: build }) {
  const content = el('div', { class: 'panel__section-body' });
  if (typeof build === 'function') build(content);
  else if (Array.isArray(build)) content.append(...build);

  const chevron = el('span', { class: 'chev', html: iconMarkup('chevronDown', { size: 12 }) });
  const head = el('button', {
    class: 'panel__section-head',
    type: 'button',
    'aria-expanded': String(!collapsed),
  }, chevron, el('span', { text: title }), icon ? iconHtml(icon) : null);

  const root = el('div', { class: `panel__section${collapsed ? ' is-collapsed' : ''}` }, head, content);
  head.addEventListener('click', () => {
    const isCollapsed = root.classList.toggle('is-collapsed');
    head.setAttribute('aria-expanded', String(!isCollapsed));
  });
  return { root, content, head };
}

/* ------------------------------- controls ------------------------------- */

export function button({ label, icon, onClick, className = 'btn', title, disabled = false, ariaPressed }) {
  const node = el('button', {
    class: className,
    type: 'button',
    title: title || label || '',
    'aria-label': label || title || '',
    onclick: onClick,
  });
  if (icon) node.append(iconEl(icon));
  if (label) node.append(el('span', { text: label }));
  if (disabled) node.disabled = true;
  if (ariaPressed !== undefined) node.setAttribute('aria-pressed', String(Boolean(ariaPressed)));
  return node;
}

export function iconEl(name, size = 14, className = '') {
  const wrapper = el('span', { class: className, html: iconMarkup(name, { size }) });
  return wrapper.firstElementChild || wrapper;
}

export function iconHtml(name, size = 14) {
  const wrapper = el('span', { class: 'ic-wrap', html: iconMarkup(name, { size }) });
  return wrapper.firstElementChild || wrapper;
}

export function toggle({ label, checked, onChange, help, id }) {
  const input = el('input', {
    type: 'checkbox',
    id: id ? `toggle-${id}` : undefined,
    checked,
    onchange: (event) => onChange(event.target.checked),
  });
  const row = el('label', { class: 'checkbox', for: input.id }, input, el('span', { text: label }));
  if (help) row.title = help;
  return row;
}

export function slider({ label, value, min, max, step = 1, onChange, format = (entry) => String(entry) }) {
  const output = el('span', { class: 'slider-val', text: format(value) });
  const input = el('input', {
    class: 'input-range',
    type: 'range',
    min,
    max,
    step,
    value,
    'aria-label': label,
    oninput: (event) => {
      const next = Number(event.target.value);
      output.textContent = format(next);
      onChange(next);
    },
  });
  return el('div', { class: 'field' },
    el('div', { class: 'slider-row' }, el('label', { class: 'field-label', text: label }), output),
    input,
  );
}

export function select({ label, value, options, onChange, id }) {
  const control = el('select', {
    class: 'select',
    id: id ? `select-${id}` : undefined,
    'aria-label': label,
    onchange: (event) => onChange(event.target.value),
  });
  for (const option of options) {
    const node = el('option', { value: option.value, text: option.label });
    if (String(option.value) === String(value)) node.selected = true;
    control.append(node);
  }
  return el('div', { class: 'field' }, el('label', { class: 'field-label', text: label, for: control.id }), control);
}

export function textInput({ label, value = '', placeholder = '', onChange, secret = false, help, id }) {
  const control = el('input', {
    class: 'input',
    type: secret ? 'password' : 'text',
    value,
    placeholder,
    id: id ? `input-${id}` : undefined,
    'aria-label': label,
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: (event) => onChange(event.target.value),
  });
  const wrapper = el('div', { class: 'field' }, el('label', { class: 'field-label', text: label, for: control.id }), control);
  if (help) wrapper.append(el('p', { class: 't-mute', style: { margin: '0', fontSize: '10.5px', lineHeight: '1.45' }, text: help }));
  return { wrapper, control };
}

export function chips({ label, values, options, onChange }) {
  const selected = new Set(String(values || '').split(',').filter(Boolean));
  const container = el('div', { class: 'chips', role: 'group', 'aria-label': label });
  for (const option of options) {
    const isOn = selected.has(option.value);
    const chip = el('button', {
      class: `chip${isOn ? ' is-on' : ''}`,
      type: 'button',
      'aria-pressed': String(isOn),
      text: option.label,
      onclick: (event) => {
        const on = event.currentTarget.classList.toggle('is-on');
        event.currentTarget.setAttribute('aria-pressed', String(on));
        if (on) selected.add(option.value);
        else selected.delete(option.value);
        onChange([...selected].join(','));
      },
    });
    container.append(chip);
  }
  return el('div', { class: 'field' }, el('span', { class: 'field-label', text: label }), container);
}

export function notice({ title, body, tone = '', html = false }) {
  return el('div', { class: `notice${tone ? ` notice--${tone}` : ''}` },
    title ? el('div', { class: 'notice__title', text: title }) : null,
    html ? el('div', { html: body }) : el('div', { text: body }),
  );
}

export function keyValues(entries) {
  const list = el('dl', { class: 'kv' });
  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === '') {
      list.append(el('dt', { text: key }), el('dd', { class: 't-mute', text: '—' }));
      continue;
    }
    list.append(el('dt', { text: key }), el('dd', { text: String(value) }));
  }
  return list;
}

export function linkList(links) {
  if (!links?.length) return null;
  const wrap = el('div', { class: 'chips' });
  for (const link of links) {
    const href = safeUrl(link.href);
    if (!href) continue;
    wrap.append(
      el('a', {
        class: 'chip',
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
        html: `${escapeHtml(link.label)} ${iconMarkup('external', { size: 10 })}`,
      }),
    );
  }
  return wrap.childElementCount ? wrap : null;
}

export function badge(status, label) {
  return el('span', { class: `badge badge--${status}`, text: label });
}

export function statusDot(tone) {
  return el('span', { class: `dot dot--${tone}` });
}

export function emptyState(message, icon = 'info') {
  return el('div', { class: 'ctx-empty' }, iconHtml(icon, 18), el('div', { text: message }));
}

export function spinnerRow(message) {
  return el('div', { class: 'ctx-empty' }, statusDot('loading'), el('span', { text: message }));
}

/* -------------------------------- modals -------------------------------- */

export function createModal({ title, wide = false, onClose }) {
  const body = el('div', { class: 'gev-modal__body' });
  const close = button({
    icon: 'x',
    label: 'Close',
    className: 'btn btn--icon btn--sm',
    onClick: () => hide(),
  });
  const panel = el('div', {
    class: `gev-modal${wide ? ' gev-modal--wide' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  }, el('div', { class: 'gev-modal__head' }, el('span', { class: 'gev-modal__title', text: title }), close), body);

  const backdrop = el('div', { class: 'gev-modal-backdrop is-hidden' }, panel);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) hide();
  });

  let previousFocus = null;
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hide();
    }
  };

  function show() {
    previousFocus = document.activeElement;
    backdrop.classList.remove('is-hidden');
    document.addEventListener('keydown', onKey, true);
    close.focus();
  }
  function hide() {
    backdrop.classList.add('is-hidden');
    document.removeEventListener('keydown', onKey, true);
    if (previousFocus?.isConnected) previousFocus.focus();
    onClose?.();
  }

  return {
    root: backdrop,
    body,
    show,
    hide,
    setTitle: (value) => {
      panel.querySelector('.gev-modal__title').textContent = value;
    },
    render(...nodes) {
      clear(body);
      body.append(...nodes);
      return body;
    },
    get isOpen() {
      return !backdrop.classList.contains('is-hidden');
    },
  };
}

/* -------------------------------- toasts -------------------------------- */

export function createToasts(container) {
  const visible = new Set();
  return {
    show(message, { tone = '', timeout = 4200, key = null } = {}) {
      if (key) {
        for (const node of visible) {
          if (node.dataset.key === key) node.remove();
        }
      }
      const node = el('div', { class: `toast${tone ? ` toast--${tone}` : ''}`, text: message });
      if (key) node.dataset.key = key;
      container.append(node);
      visible.add(node);
      const timer = setTimeout(() => dismiss(node), timeout);
      node.addEventListener('click', () => {
        clearTimeout(timer);
        dismiss(node);
      });
      return node;
    },
    dismissAll() {
      for (const node of visible) dismiss(node);
    },
  };

  function dismiss(node) {
    if (!visible.has(node)) return;
    visible.delete(node);
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  }
}
