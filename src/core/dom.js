/** Small DOM helpers so UI modules stay declarative and free of stringly HTML. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

export function svg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') {
      node.value = value;
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Remove a node from its parent if it is attached. Safe to call twice. */
export function detach(node) {
  if (node?.parentNode) node.parentNode.removeChild(node);
  return node;
}

/**
 * Escape untrusted provider strings before they reach innerHTML. Most of this
 * app builds DOM nodes directly; this exists for the few template spots (rich
 * text attribution, search highlighting).
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow http/https URLs from provider data; anything else is dropped. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value), window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    /* fall through */
  }
  return null;
}

export function debounce(fn, ms = 200) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    wrapped.cancel();
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, ms = 200) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  const invoke = () => {
    last = Date.now();
    timer = null;
    fn(...lastArgs);
  };
  const wrapped = (...args) => {
    lastArgs = args;
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(invoke, remaining);
    }
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = 0;
  };
  return wrapped;
}

/** Track disposers so a panel/component can tear down in one call. */
export function createDisposer() {
  const disposers = [];
  let disposed = false;
  return {
    add(dispose) {
      if (disposed) {
        if (typeof dispose === 'function') dispose();
        return dispose;
      }
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    dispose() {
      disposed = true;
      const errors = [];
      while (disposers.length) {
        try {
          disposers.pop()();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) console.error('[dispose] errors during teardown', errors);
    },
    get isDisposed() {
      return disposed;
    },
  };
}
