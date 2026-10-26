// Probe run inside each context. Returns a plain object. Never contacts anything but the local test server.
async function runProbe(cfg) {
  const out = {};
  const t = async (name, fn, ms = 4000) => {
    try {
      const r = await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
      out[name] = r === undefined ? 'ok' : r;
    } catch (e) { out[name] = 'ERR:' + (e && e.name || 'Error') + (e && e.message ? ':' + String(e.message).slice(0, 70) : ''); }
  };
  const safe = (fn) => { try { return fn(); } catch (e) { return 'THROWS:' + (e && e.name); } };
  out.origin = safe(() => String(location.origin));
  out.href = safe(() => String(location.href).slice(0, 40));
  out.isSecureContext = safe(() => String(self.isSecureContext));
  out.cryptoSubtle = safe(() => typeof (self.crypto && self.crypto.subtle));
  out.serviceWorkerApi = safe(() => typeof navigator.serviceWorker);
  out.rtcApi = safe(() => typeof self.RTCPeerConnection);
  await t('swRegister', async () => { if (!navigator.serviceWorker) throw new Error('no api'); const r = await navigator.serviceWorker.register(cfg.swUrl, { scope: cfg.swScope }); try { await r.unregister(); } catch (_) {} return 'registered'; });
  await t('indexedDB', () => new Promise((res, rej) => { const q = indexedDB.open('s4probe', 1); q.onsuccess = () => { q.result.close(); res('ok'); }; q.onerror = () => rej(q.error || new Error('idb error')); q.onblocked = () => rej(new Error('blocked')); }));
  await t('localStorage', () => { localStorage.setItem('k', 'v'); return localStorage.getItem('k') === 'v' ? 'ok' : 'mismatch'; });
  await t('cacheStorage', async () => { const c = await caches.open('s4'); await c.put('/x', new Response('1')); return 'ok'; });
  await t('broadcastChannel', () => { const b = new BroadcastChannel('s4'); b.close(); return 'ok'; });
  await t('webLocks', async () => { await navigator.locks.request('s4', () => 1); return 'ok'; });
  await t('blobWorker', () => new Promise((res, rej) => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); w.onmessage = () => { w.terminate(); res('ok'); }; w.onerror = (e) => rej(new Error(e.message || 'worker error')); }));
  await t('importBlobModule', async () => { const m = await import(URL.createObjectURL(new Blob(['export default 7'], { type: 'text/javascript' }))); return m.default === 7 ? 'ok' : 'bad'; });
  await t('wasm', async () => { const m = await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return m ? 'ok' : 'no'; });
  await t('sha256', async () => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('a')); return d.byteLength === 32 ? 'ok' : 'bad'; });
  await t('sha1', async () => { const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('a')); return d.byteLength === 20 ? 'ok' : 'bad'; });
  await t('p256sign', async () => { const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); const s = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, new Uint8Array(4)); return s.byteLength === 64 ? 'ok' : 'bad'; });
  await t('storagePersist', async () => { if (!navigator.storage || !navigator.storage.estimate) throw new Error('no api'); const e = await navigator.storage.estimate(); return typeof e.quota; });
  await t('webSocketLocal', () => new Promise((res, rej) => { const w = new WebSocket(cfg.wsUrl); w.onopen = () => { w.close(); res('open'); }; w.onerror = () => rej(new Error('ws error')); }));
  await t('fetchLocalCors', async () => { const r = await fetch(cfg.corsUrl); const j = await r.json(); return j.ok ? 'ok' : 'bad'; });
  await t('fetchLocalNoCors', async () => { const r = await fetch(cfg.corsUrl, { mode: 'no-cors' }); return r.type; });
  await t('rtcLoopbackDataChannel', () => new Promise((res, rej) => {
    const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] });
    const done = (v, bad) => { try { a.close(); b.close(); } catch (_) {} bad ? rej(new Error(v)) : res(v); };
    const timer = setTimeout(() => done('no channel in 6s', true), 6000);
    a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
    b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
    b.ondatachannel = (e) => { e.channel.onmessage = (m) => { clearTimeout(timer); done(m.data === 'hi' ? 'ok' : 'bad'); }; };
    const ch = a.createDataChannel('x'); ch.onopen = () => ch.send('hi');
    a.createOffer().then((o) => a.setLocalDescription(o).then(() => b.setRemoteDescription(o))).then(() => b.createAnswer()).then((an) => b.setLocalDescription(an).then(() => a.setRemoteDescription(an))).catch((e) => done(String(e), true));
  }), 8000);
  await t('historyPushState', () => { history.pushState({}, '', '#s4'); return 'ok'; });
  await t('windowOpenBlank', () => { const w = window.open('about:blank'); if (w) { w.close(); return 'ok'; } return 'null'; });
  return out;
}
if (typeof module !== 'undefined') module.exports = { runProbe };
