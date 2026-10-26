const out = (window.__tag = window.__tag || {})
out.module = { currentScript: document.currentScript === null ? 'null' : String(document.currentScript), importMetaUrl: import.meta.url, byQuery: (document.querySelector('script[type=module][src*="tag-mod.js"]') || {}).dataset ? JSON.stringify(document.querySelector('script[type=module][src*="tag-mod.js"]').dataset) : null, readyStateAtRun: document.readyState }
out.api = {
  requestIdleCallback: typeof requestIdleCallback, SharedWorker: typeof SharedWorker, locks: typeof (navigator.locks && navigator.locks.request), BroadcastChannel: typeof BroadcastChannel,
  Navigation: typeof window.navigation, prerendering: typeof document.prerendering, serviceWorker: typeof navigator.serviceWorker, storageGetDirectory: typeof (navigator.storage && navigator.storage.getDirectory),
  RTCPeerConnection: typeof RTCPeerConnection, connection: typeof navigator.connection, saveData: navigator.connection ? String(navigator.connection.saveData) : 'n/a', ReadableStreamTransferable: (() => { try { const c = new MessageChannel(); const rs = new ReadableStream(); c.port1.postMessage(rs, [rs]); return true } catch (e) { return false } })(),
  AbortSignalTimeout: typeof AbortSignal.timeout, toHex: typeof Uint8Array.prototype.toHex, withResolvers: typeof Promise.withResolvers, structuredClone: typeof structuredClone, scheduler_postTask: typeof (self.scheduler && scheduler.postTask)
}
fetch('/__report', { method: 'POST', body: JSON.stringify({ tag: true, ...out }) })
