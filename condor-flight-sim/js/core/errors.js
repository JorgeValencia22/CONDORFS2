/**
 * Error handling: global handlers, readable error overlay and non-fatal warnings.
 * The goal is to never leave the user in front of a black screen without explanation.
 */
(function (SIM) {
  'use strict';

  let overlay = null;
  let reported = 0;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.getElementById('error-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'error-overlay';
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ErrorHandler = {
    /**
     * Shows a blocking error dialog.
     * @param {string} title
     * @param {string} message human readable explanation
     * @param {object} [opts] {detail, actions:[{label, fn}]}
     */
    show(title, message, opts = {}) {
      const el = ensureOverlay();
      const actions = opts.actions || [{ label: 'Reload simulator', fn: () => window.location.reload() }];
      el.innerHTML = `
        <div class="error-card" role="alertdialog" aria-labelledby="err-title">
          <div class="error-code">SYSTEM FAULT</div>
          <h2 id="err-title">${escapeHtml(title)}</h2>
          <p>${escapeHtml(message)}</p>
          ${opts.detail ? `<pre class="error-detail">${escapeHtml(opts.detail)}</pre>` : ''}
          <div class="error-actions"></div>
        </div>`;
      const box = el.querySelector('.error-actions');
      actions.forEach((a, i) => {
        const b = document.createElement('button');
        b.className = i === 0 ? 'btn btn-primary' : 'btn';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          el.classList.remove('visible');
          a.fn && a.fn();
        });
        box.appendChild(b);
      });
      el.classList.add('visible');
    },

    hide() {
      if (overlay) overlay.classList.remove('visible');
    },

    /** Non-fatal warning: logged and surfaced as a notification when the flight UI is active. */
    warn(message, err) {
      console.warn('[CÓNDOR]', message, err || '');
      SIM.events && SIM.events.emit('notify', { text: message, level: 'warn' });
    },

    /** Wraps a function so exceptions are reported instead of breaking the frame loop. */
    guard(fn, context) {
      return function guarded(...args) {
        try {
          return fn.apply(this, args);
        } catch (err) {
          ErrorHandler.report(err, context);
          return undefined;
        }
      };
    },

    report(err, context = 'runtime') {
      console.error(`[CÓNDOR:${context}]`, err);
      reported++;
      // Only escalate to the blocking dialog for the first few distinct errors.
      if (reported <= 1) {
        ErrorHandler.show(
          'Unexpected error',
          `A ${context} error occurred. The simulator tried to keep running; if the problem persists, reload the page.`,
          {
            detail: (err && (err.stack || err.message)) || String(err),
            actions: [
              { label: 'Continue', fn: () => {} },
              { label: 'Reload', fn: () => window.location.reload() },
            ],
          }
        );
      }
    },
  };

  window.addEventListener('error', (ev) => {
    // Resource loading errors (scripts/images) are handled where they are requested.
    if (ev.target && ev.target !== window) return;
    ErrorHandler.report(ev.error || ev.message, 'script');
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    ErrorHandler.report(ev.reason, 'async');
  });

  SIM.ErrorHandler = ErrorHandler;
  SIM.escapeHtml = escapeHtml;
})(window.SIM);
