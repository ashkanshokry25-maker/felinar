/* AbortSignal.timeout(ms) polyfill (Safari < 16, Chromium 103-123 partial, Samsung < 27). Classic script, ES2017. */
(function (G) {
  'use strict';
  if (typeof G.AbortSignal !== 'function' || typeof G.AbortController !== 'function' || typeof G.AbortSignal.timeout === 'function') return;
  Object.defineProperty(G.AbortSignal, 'timeout', {
    value: function timeout(ms) {
      var c = new G.AbortController();
      setTimeout(function () {
        c.abort(typeof G.DOMException === 'function' ? new G.DOMException('The operation timed out.', 'TimeoutError') : new Error('The operation timed out.'));
      }, ms);
      return c.signal;
    },
    writable: true, configurable: true
  });
})(typeof globalThis === 'object' ? globalThis : self);
