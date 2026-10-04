/**
 * Notifications — short toasts for system events (FLAPS 10, GEAR DOWN, STALL WARNING,
 * ENGINE FAILURE, LOW FUEL...). Duplicate messages are merged instead of stacking.
 */
(function (SIM) {
  'use strict';

  const { h, icon } = SIM.UI;

  class Notifications {
    constructor() {
      this.el = h('div.notifications', { role: 'status', 'aria-live': 'polite' });
      this.items = new Map();
    }

    show(text, level = 'info', duration = 2600) {
      const key = text;
      let item = this.items.get(key);
      if (item) {
        clearTimeout(item.timer);
        item.el.classList.remove('leaving');
        item.el.classList.add('bump');
        setTimeout(() => item.el.classList.remove('bump'), 160);
      } else {
        const ic = level === 'warn' ? 'warning' : level === 'danger' ? 'warning' : level === 'success' ? 'check' : 'info';
        item = { el: h(`div.toast.${level}`, icon(ic), h('span', text)) };
        this.items.set(key, item);
        this.el.prepend(item.el);
        while (this.el.children.length > 5) {
          const last = this.el.lastChild;
          this.items.forEach((v, k) => v.el === last && this.items.delete(k));
          last.remove();
        }
      }
      item.timer = setTimeout(() => {
        item.el.classList.add('leaving');
        setTimeout(() => {
          item.el.remove();
          this.items.delete(key);
        }, 300);
      }, duration);
    }

    clear() {
      this.items.forEach((i) => clearTimeout(i.timer));
      this.items.clear();
      this.el.innerHTML = '';
    }
  }

  SIM.Notifications = Notifications;
})(window.SIM);
