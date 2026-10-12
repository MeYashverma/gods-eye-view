/**
 * A tiny observable store. Deliberately dependency-free: the app is a single
 * page with a handful of cross-cutting pieces of state (visibility, selection,
 * style, camera), and a 60-line store is easier to reason about and to test
 * than pulling in a state library.
 */
export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();
  const selectors = new Map();

  function notify(keys) {
    for (const listener of [...listeners]) {
      try {
        listener(state, keys);
      } catch (error) {
        // A broken subscriber must never stop the render loop.
        console.error('[store] listener failed', error);
      }
    }
    for (const [key, entries] of selectors) {
      if (!keys.has(key) && keys.size) continue;
      for (const entry of [...entries]) {
        try {
          const next = entry.select(state);
          if (!Object.is(next, entry.last)) {
            entry.last = next;
            entry.listener(next);
          }
        } catch (error) {
          console.error('[store] selector failed', error);
        }
      }
    }
  }

  return {
    get: () => state,
    /** Merge a partial patch; subscribers see the new frozen-free snapshot. */
    patch(patch) {
      if (!patch || typeof patch !== 'object') return state;
      const keys = new Set();
      const next = { ...state };
      for (const [key, value] of Object.entries(patch)) {
        if (Object.is(next[key], value)) continue;
        next[key] = value;
        keys.add(key);
      }
      if (!keys.size) return state;
      state = next;
      notify(keys);
      return state;
    },
    set(key, value) {
      return this.patch({ [key]: value });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      listener(state, new Set());
      return () => listeners.delete(listener);
    },
    /** Subscribe to one derived value; the listener fires only when it changes. */
    select(select, listener) {
      if (typeof select !== 'function' || typeof listener !== 'function') {
        throw new TypeError('select and listener must be functions');
      }
      const entry = { select, listener, last: select(state) };
      const id = Symbol('selector');
      if (!selectors.has(id)) selectors.set(id, new Set([entry]));
      listener(entry.last);
      return () => {
        for (const entries of selectors.values()) entries.delete(entry);
      };
    },
    destroy() {
      listeners.clear();
      selectors.clear();
    },
  };
}

/** Batch several mutations into one notification. */
export function transaction(store, mutate) {
  const snapshot = { ...store.get() };
  mutate(store);
  const after = store.get();
  const changed = new Set();
  for (const key of new Set([...Object.keys(snapshot), ...Object.keys(after)])) {
    if (!Object.is(snapshot[key], after[key])) changed.add(key);
  }
  return changed;
}
