// lab frame agent (injected by the SW into HTML documents when cfg.injectAgent): restores window.opener in a popup shell
window.__agent = 'ran'
try {
  if (window.parent !== window && !window.opener && window.parent.opener) {
    Object.defineProperty(window, 'opener', { configurable: true, get: function () { return window.parent.opener } })
    window.__agentOpener = 'shimmed'
  }
} catch (e) { window.__agentOpener = 'err ' + e.name }
