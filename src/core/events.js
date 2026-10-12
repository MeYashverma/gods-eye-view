/** Minimal event bus shared by the UI, layers and tools. */
export function createEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event)?.delete(handler);
    },
    once(event, handler) {
      const off = this.on(event, (payload) => {
        off();
        handler(payload);
      });
      return off;
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[events:${event}] handler failed`, error);
        }
      }
    },
    off(event, handler) {
      if (handler) handlers.get(event)?.delete(handler);
      else handlers.delete(event);
    },
    clear() {
      handlers.clear();
    },
  };
}
