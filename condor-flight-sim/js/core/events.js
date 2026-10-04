/**
 * Minimal publish/subscribe bus used to decouple systems (UI, audio, ATC, missions...).
 */
(function (SIM) {
  'use strict';

  class EventBus {
    constructor() {
      this.handlers = new Map();
    }

    on(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type).add(fn);
      return () => this.off(type, fn);
    }

    once(type, fn) {
      const off = this.on(type, (payload) => {
        off();
        fn(payload);
      });
      return off;
    }

    off(type, fn) {
      const set = this.handlers.get(type);
      if (set) set.delete(fn);
    }

    emit(type, payload) {
      const set = this.handlers.get(type);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[EventBus] handler for "${type}" failed`, err);
        }
      }
    }

    /** Removes every handler registered through the returned scope; used for per-flight listeners. */
    scope() {
      const offs = [];
      return {
        on: (type, fn) => {
          offs.push(this.on(type, fn));
        },
        dispose: () => {
          offs.forEach((off) => off());
          offs.length = 0;
        },
      };
    }
  }

  SIM.EventBus = EventBus;
  SIM.events = new EventBus();
})(window.SIM);
