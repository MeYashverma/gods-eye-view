/**
 * Global modals: settings, data attribution, share link and help.
 */

import { el } from '../core/dom.js';
import {
  button,
  createModal,
  notice,
  select,
  textInput,
  toggle,
  keyValues,
} from './components.js';
import { SETTING_FIELDS, redactSettings } from '../settings/store.js';
import { listSources } from '../sources/registry.js';
import { listImageryStacks, listTerrainStacks, PHOTOREAL_3D } from '../maps/catalog.js';
import { VISUAL_STYLES } from '../tools/effects.js';
import { encodeShareLink } from '../share/link.js';

export function createSettingsModal({ settings, mapController, store, toast, onRestartNeeded }) {
  const modal = createModal({ title: 'Settings', wide: true });

  function open() {
    modal.render(
      notice({
        tone: 'warn',
        title: 'Nothing here is secret',
        body: 'This is a static site with no backend, so anything you enter is stored in this browser and is readable by the page and its JavaScript. Only enter credentials a provider documents for client-side use, and restrict them to your Pages origin. Never commit a key to this repository.',
      }),
    );

    const fields = el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Provider credentials & endpoints' }));
    for (const field of SETTING_FIELDS) {
      const input = textInput({
        label: `${field.label}${field.secret ? ' (browser-visible)' : ''}`,
        value: settings.get(field.id) || '',
        placeholder: field.secret ? 'Stored locally in this browser only' : '',
        secret: field.secret,
        id: field.id,
        onChange: (value) => settings.set(field.id, value.trim()),
      });
      fields.append(input.wrapper);
      fields.append(
        el('p', { class: 't-mute', style: { margin: '0 0 8px', fontSize: '10.5px', lineHeight: '1.5' } },
          el('span', { text: field.hint }),
          ' ',
          el('a', { href: field.docs, target: '_blank', rel: 'noopener noreferrer', text: 'Documentation' }),
        ),
      );
    }
    modal.body.append(fields);

    modal.body.append(
      el('div', { class: 'field' },
        el('span', { class: 'field-label', text: 'Map source' }),
        select({
          label: 'Imagery',
          value: store.get().mapStack,
          options: listImageryStacks().map((stack) => ({
            value: stack.id,
            label: `${stack.label}${stack.keyless ? '' : ' — requires a token'}`,
          })),
          onChange: (value) => {
            store.patch({ mapStack: value });
            mapController.setImagery(value);
          },
        }),
        select({
          label: 'Terrain',
          value: store.get().terrain,
          options: listTerrainStacks().map((stack) => ({ value: stack.id, label: stack.label })),
          onChange: (value) => {
            store.patch({ terrain: value });
            mapController.setTerrain(value);
          },
        }),
        toggle({
          label: `${PHOTOREAL_3D.label} (needs a Google Maps key)`,
          checked: Boolean(store.get().photoreal),
          id: 'photoreal',
          onChange: async (value) => {
            store.patch({ photoreal: value });
            const ok = await mapController.setPhotorealistic(value);
            if (!ok && value) {
              toast.show('Photorealistic 3D Tiles is unavailable. Check your Google Maps key and its enabled APIs.', { tone: 'error', timeout: 7000 });
            }
          },
        }),
      ),
    );

    modal.body.append(
      el('div', { class: 'field' },
        el('span', { class: 'field-label', text: 'Display & accessibility' }),
        toggle({
          label: 'Show contact labels',
          checked: settings.get('showLabels'),
          id: 'showLabels',
          onChange: (value) => settings.set('showLabels', value),
        }),
        select({
          label: 'Label density',
          value: settings.get('labelDensity'),
          options: [
            { value: 'off', label: 'Off' },
            { value: 'minimal', label: 'Minimal' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'dense', label: 'Dense' },
          ],
          onChange: (value) => settings.set('labelDensity', value),
        }),
        toggle({
          label: 'Reduce motion',
          checked: settings.get('reduceMotion'),
          id: 'reduceMotion',
          onChange: (value) => {
            settings.set('reduceMotion', value);
            document.documentElement.classList.toggle('gev-reduce-motion', value);
          },
        }),
      ),
    );

    modal.body.append(
      el('div', { class: 'ctx-actions' },
        button({
          label: 'Copy redacted settings',
          icon: 'copy',
          onClick: async () => {
            await navigator.clipboard?.writeText?.(JSON.stringify(redactSettings(settings.get()), null, 2));
            toast.show('Redacted settings copied. Credentials were replaced with [redacted].', { tone: 'ok' });
          },
        }),
        button({
          label: 'Reset preferences',
          icon: 'reset',
          className: 'btn btn--danger',
          onClick: () => {
            settings.reset();
            open();
            onRestartNeeded?.();
            toast.show('Preferences reset. Reload to apply.', { tone: 'warn' });
          },
        }),
      ),
    );

    modal.show();
  }

  return { open, modal };
}

export function createAttributionModal({ layers }) {
  const modal = createModal({ title: 'Data sources & attribution', wide: true });

  function open() {
    modal.render(
      notice({
        tone: 'info',
        title: 'How to read this',
        body: 'Code in this repository is MIT licensed. That grant does not extend to any third-party data, imagery or tile service — each keeps its own licence, listed below. Nothing here is authoritative or suitable for safety-critical decisions.',
      }),
    );

    const usedSourceIds = new Set();
    for (const layer of layers()) for (const id of layer.sources) usedSourceIds.add(id);

    const inUse = listSources().filter((source) => usedSourceIds.has(source.id));
    const available = listSources().filter((source) => !usedSourceIds.has(source.id));

    for (const [title, list] of [['Used by the layers you have enabled', inUse], ['Available in this build', available]]) {
      if (!list.length) continue;
      modal.body.append(el('div', { class: 'field' }, el('span', { class: 'field-label', text: title })));
      for (const source of list) {
        modal.body.append(
          el('div', { class: 'notice' },
            el('div', { class: 'notice__title', text: source.name }),
            keyValues([
              ['Attribution', source.attribution],
              ['Licence', source.license],
              ['Browser CORS', source.browserDirect ? 'Permitted' : 'Not permitted from a static origin'],
              ['Refresh', source.refreshMs ? `${Math.round(source.refreshMs / 60000)} min` : 'On demand'],
            ]),
            el('p', { class: 't-mute', style: { margin: '6px 0 0', fontSize: '10.5px', lineHeight: '1.5' }, text: source.notes }),
            el('div', { style: { marginTop: '4px' } },
              el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.url }),
            ),
          ),
        );
      }
    }

    modal.show();
  }

  return { open, modal };
}

export function createShareModal({ state, catalog, toast }) {
  const modal = createModal({ title: 'Share this view' });

  function open() {
    const hash = encodeShareLink(state(), catalog());
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${hash}`;
    const input = textInput({
      label: 'Shareable URL',
      value: url,
      id: 'share-url',
      onChange: () => {},
    });
    input.control.readOnly = true;
    input.control.addEventListener('focus', () => input.control.select());

    modal.render(
      notice({
        tone: 'info',
        title: 'What the link contains',
        body: 'Camera position and angle, the enabled layers, the visual style and the current selection. No credentials, no annotations and no personal data are encoded.',
      }),
      input.wrapper,
      el('div', { class: 'ctx-actions' },
        button({
          label: 'Copy link',
          icon: 'copy',
          className: 'btn btn--primary',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast.show('Share link copied.', { tone: 'ok' });
            } catch {
              input.control.select();
              toast.show('Clipboard blocked — the link is selected, press Ctrl/Cmd+C.', { tone: 'warn' });
            }
          },
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field-label', text: 'Encoded parameters' }),
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
          text: hash || '(empty)',
        }),
      ),
    );
    modal.show();
  }

  return { open, modal };
}

export function createHelpModal() {
  const modal = createModal({ title: 'Keyboard shortcuts & capabilities', wide: true });

  const shortcuts = [
    ['/ or Ctrl+K', 'Focus place search'],
    ['Esc', 'Clear selection / close panel / exit clean view'],
    ['L', 'Toggle the layer rail'],
    ['C', 'Toggle the context panel'],
    ['H', 'Toggle the heads-up display'],
    ['R', 'Reset the camera to the whole Earth'],
    ['+ / −', 'Zoom in / out'],
    ['[ / ]', 'Orbit the camera left / right'],
    ['0 … 7', 'Select a visual style'],
    ['D', 'Toggle detection brackets on the selection'],
    ['P', 'Toggle clean (presentation) view'],
    ['V', 'Toggle voice listening'],
    ['S', 'Open share link'],
    [',', 'Open settings'],
  ];

  function open() {
    modal.render(
      el('div', { class: 'field' },
        el('span', { class: 'field-label', text: 'Keyboard shortcuts' }),
        keyValues(shortcuts),
      ),
      notice({
        tone: 'info',
        title: 'Voice commands',
        body: '“Fly to Tokyo” · “turn on earthquakes” · “hide satellites” · “night vision” · “reset camera” · “zoom in” · “track” · “clean view” · “share view”. Voice uses the browser Web Speech API; it needs microphone permission and is not available in every browser.',
      }),
      notice({
        tone: 'warn',
        title: 'What this build cannot do on static hosting',
        body: 'There is no backend. Live civil aircraft need a CORS-friendly ADS-B endpoint you supply, because no public ADS-B API sends CORS headers. Maritime AIS works but needs a free AISStream key. Live transit vehicles need a GTFS-Realtime protobuf decoder and are not implemented. Anything unavailable says so in its own status row rather than drawing something that looks like data.',
      }),
      notice({
        tone: 'crit',
        title: 'Not for operational use',
        body: 'Every source here is a public feed with its own latency, coverage and licensing limits. Do not use this console for navigation, emergency response, or any safety-critical decision.',
      }),
      el('div', { class: 'field' },
        el('span', { class: 'field-label', text: 'Visual styles' }),
        el('div', { class: 'chips' },
          ...VISUAL_STYLES.map((style) =>
            el('span', { class: 'chip', title: style.description, text: style.label }),
          ),
        ),
      ),
    );
    modal.show();
  }

  return { open, modal };
}
