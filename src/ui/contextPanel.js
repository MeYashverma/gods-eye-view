/**
 * Right-hand context panel — the details sheet for whatever is selected, plus
 * the tracking and cockpit controls that operate on it.
 */

import { el, clear, escapeHtml, safeUrl } from '../core/dom.js';
import { button, iconHtml, keyValues, linkList, notice } from './components.js';

export function createContextPanel({ panel, selection, camera, layers, events, toast }) {
  let followStop = null;
  let cockpitStop = null;
  let currentDetail = null;

  const hero = el('div', { class: 'ctx-hero' });
  const actions = el('div', { class: 'ctx-actions' });
  const body = el('div', { class: 'ctx-body' });

  panel.render(hero, actions, body);

  const unsubscribe = selection.subscribe(() => render());
  events.on('selection:change', () => render());

  function render() {
    clear(hero);
    clear(actions);
    clear(body);

    const entry = selection.current;
    if (!entry) {
      currentDetail = null;
      hero.append(
        el('div', { class: 'ctx-empty' },
          iconHtml('target', 18),
          el('div', { text: 'Select a contact on the globe to inspect it.' }),
          el('div', { class: 't-mute', style: { fontSize: '10.5px', marginTop: '6px' }, text: 'Turn on a layer from the left rail first.' }),
        ),
      );
      return;
    }

    const layer = layers().find((entry2) => entry2.id === entry.layerId);
    if (!layer) {
      hero.append(el('div', { class: 'ctx-empty', text: 'The source layer for this selection is no longer active.' }));
      return;
    }

    const detail = layer.detail?.(entry.record);
    currentDetail = detail;
    if (!detail) {
      hero.append(el('div', { class: 'ctx-hero__title', text: entry.recordId }));
      return;
    }

    hero.append(
      el('div', { class: 'ctx-hero__title', text: detail.title || 'Selection' }),
      el('div', { class: 'ctx-hero__sub', text: [layer.name, detail.subtitle].filter(Boolean).join(' · ') }),
    );

    actions.append(
      button({ label: 'Fly to', icon: 'focus', className: 'btn btn--sm', onClick: () => layer.focus?.(entry.record) }),
      button({
        label: selection.following ? 'Stop follow' : 'Follow',
        icon: 'navigation',
        className: `btn btn--sm${selection.following ? ' btn--on' : ''}`,
        onClick: () => {
          selection.setFollow(!selection.following);
          render();
        },
      }),
      button({
        label: 'Cockpit',
        icon: 'aperture',
        className: 'btn btn--sm',
        onClick: () => startCockpit(layer, entry.record),
      }),
      button({ label: 'Clear', icon: 'x', className: 'btn btn--sm', onClick: () => selection.clear() }),
    );

    for (const action of detail.actions || []) {
      actions.append(
        button({
          label: action.label,
          icon: action.icon || 'play',
          className: 'btn btn--sm btn--primary',
          onClick: () => {
            if (action.id === 'radio:play') {
              const radio = layers().find((entry2) => entry2.id === 'radio');
              radio?.play?.(entry.record);
            }
          },
        }),
      );
    }

    if (detail.image) {
      const href = safeUrl(detail.image);
      if (href) {
        const image = el('img', {
          src: href,
          alt: detail.title || 'Camera image',
          style: { width: '100%', display: 'block', border: '1px solid var(--l-1)', borderRadius: '3px', background: 'var(--s-0)' },
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
        });
        image.addEventListener('error', () => {
          image.replaceWith(
            notice({
              tone: 'warn',
              title: 'Imagery unavailable',
              body: 'The publisher did not serve this image to this origin. Nothing is cached or proxied.',
            }),
          );
        });
        body.append(el('div', { style: { padding: '8px 9px 0' } }, image));
      }
    }

    if (detail.note) {
      body.append(el('div', { style: { padding: '8px 9px 0' } }, notice({ tone: 'info', body: detail.note })));
    }

    body.append(el('div', { style: { padding: '9px' } }, keyValues(detail.fields || [])));

    if (detail.code) {
      body.append(
        el('div', { style: { padding: '0 9px 9px' } },
          el('span', { class: 'field-label', text: 'Element set' }),
          el('pre', {
            class: 'mono',
            style: {
              margin: '4px 0 0',
              padding: '6px',
              background: 'var(--s-0)',
              border: '1px solid var(--l-1)',
              borderRadius: '3px',
              fontSize: '9.5px',
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            },
            text: detail.code,
          }),
        ),
      );
    }

    const links = linkList(detail.links);
    if (links) body.append(el('div', { style: { padding: '0 9px 12px' } }, links));
  }

  function startCockpit(layer, record) {
    stopCockpit();
    const getPosition = () => {
      const fresh = layer.records?.find?.((entry) => entry.id === record.id) || record;
      if (!Number.isFinite(fresh.lat) || !Number.isFinite(fresh.lon)) return null;
      return {
        lat: fresh.lat,
        lon: fresh.lon,
        height: Number.isFinite(fresh.altitudeM) ? fresh.altitudeM : 0,
      };
    };
    const getHeading = () => {
      const fresh = layer.records?.find?.((entry) => entry.id === record.id) || record;
      return Number.isFinite(fresh.trackDeg) ? fresh.trackDeg : (Number.isFinite(fresh.courseDeg) ? fresh.courseDeg : 0);
    };
    if (!getPosition()) {
      toast.show('That contact has no usable position.', { tone: 'warn' });
      return;
    }
    cockpitStop = camera.cockpitView({ getPosition, getHeading });
    document.getElementById('app')?.classList.add('is-cockpit');
    toast.show(`Cockpit view locked to ${detailTitle()}. Click “Exit cockpit” to return.`, { tone: 'ok', timeout: 3500 });
    renderCockpitExit();
  }

  function detailTitle() {
    return currentDetail?.title || selection.current?.recordId || 'contact';
  }

  function renderCockpitExit() {
    const exit = button({
      label: 'Exit cockpit',
      icon: 'x',
      className: 'btn btn--sm btn--danger',
      onClick: stopCockpit,
    });
    exit.dataset.cockpitExit = '1';
    for (const existing of actions.querySelectorAll('[data-cockpit-exit]')) existing.remove();
    actions.append(exit);
  }

  function stopCockpit() {
    if (cockpitStop) cockpitStop();
    cockpitStop = null;
    document.getElementById('app')?.classList.remove('is-cockpit');
    for (const existing of actions.querySelectorAll('[data-cockpit-exit]')) existing.remove();
  }

  return {
    render,
    stopCockpit,
    get hasSelection() {
      return Boolean(selection.current);
    },
    describe() {
      if (!selection.current) return null;
      return {
        layer: selection.current.layerId,
        record: selection.current.recordId,
        title: currentDetail?.title || null,
        html: currentDetail
          ? `<strong>${escapeHtml(currentDetail.title || '')}</strong>${currentDetail.fields
              .filter(([, value]) => value)
              .slice(0, 4)
              .map(([key, value]) => ` · ${escapeHtml(key)}: ${escapeHtml(String(value))}`)
              .join('')}`
          : null,
      };
    },
    dispose() {
      unsubscribe();
      stopCockpit();
      if (followStop) followStop();
    },
  };
}
