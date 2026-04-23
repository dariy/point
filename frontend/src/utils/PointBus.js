/**
 * Lightweight Pub/Sub event bus for window.Point.
 */

class PointBus {
  constructor() {
    /** @type {Object.<string, Array<Function>>} */
    this.listeners = {};
  }

  /**
   * Subscribe to an event.
   * @param {string} event 
   * @param {Function} callback 
   */
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event 
   * @param {Function} callback 
   */
  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(l => l !== callback);
  }

  /**
   * Emit an event with data.
   * @param {string} event 
   * @param {any} [data] 
   */
  emit(event, data) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(l => l(data));
  }
}

// Initialise window.Point globally.
const bus = new PointBus();
const point = {
  on: bus.on.bind(bus),
  off: bus.off.bind(bus),
  emit: bus.emit.bind(bus)
};

if (typeof window !== 'undefined') {
  window.Point = point;
} else {
  // eslint-disable-next-line no-undef
  const root = typeof globalThis !== 'undefined' ? globalThis : global;
  root.window = root.window || {};
  root.window.Point = point;
}

export default point;
