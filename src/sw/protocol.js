// src/sw/protocol.js: the versioned page <-> Service Worker protocol (ARCHITECTURE §5.2, §7.1; v0.2.1
// DIGEST-AMENDMENTS D1, RESEARCH-DIGEST P0-4). Shared by the worker (core.js), the shell (render.js)
// and the drop-in runtime (swreg.js); no worker or window globals at module level, so it runs in Node
// tests, pages and workers alike.
//
// Every message carries { proto: PROTO, type }. A worker answers a message of another proto with
// mw-ack { ok: false, error: 'proto', expected }; mw-ping is answered whatever its proto, so a page can
// learn the worker's version and show "Reload" after an update (§5.2). PROTO changes only with an
// incompatible change; adding a message type or a field is compatible.
//
// Page -> worker (reply on the transferred port, else to the sending client):
//   mw-ping                                  -> mw-pong { buildId, mode, foreign }
//   mw-set-current { btih, ledgerId?, routing? }   shell: the origin's current site -> mw-ack
//   mw-map-client { clientId?, btih }        drop-in: this client renders btih -> mw-ack { doc? }
//   mw-site-saved { btih }                   re-read a site the page just stored -> mw-ack
//   mw-shell-check                           shell: the host's current page tag -> mw-ack { pointer, replaced }
//   mw-get-clients                           -> mw-clients { clients: { btih: liveCount }, current }
//   mw-keepalive                             v0.2.1: keeps the worker alive while the page depends on it
//                                            (sent at most every KEEPALIVE_MS) -> mw-ack
//   mw-doc-info                              v0.2.1 drop-in: what the worker saw of this page's navigation
//                                            -> mw-ack { doc: { noStore } | null }
//   mw-session-register { sid, kind, exp, M?, fk?, file? }   v0.3 (R 2.8.5, 2.9.6): a media or file
//                                            session; event.ports[0] is the session's private port,
//                                            which also carries the reply -> mw-ack { ok, sid, exp }
//   mw-session-close { sid } | { all: true } v0.3: ends a session (sign-out, close, page hide) -> mw-ack
// Worker -> page (pushed):
//   mw-site-invalid { btih, reason, path }   cached files failed verification or are missing
//   mw-reload                                the kill switch asks an old page to reload (no navigate())
//   mw-session-lost { sid }                  v0.3: a restarted worker asks the engine page to register
//                                            that session again
//   mw-message-error                         v0.3 code review (round 2): a message from this page could not be read
//                                            in the worker ('messageerror', such as a CryptoKey that cloned in the page
//                                            and not in the worker); a pending session register retries at once
// On a session's private port (v0.3):
//   worker -> page  mw-chunk-need { sid, req, i }          the ciphertext chunk i (media) or the
//                                                          plaintext block i (files)
//   page -> worker  mw-chunk { req, i, data } | { req, i, error }   data: an ArrayBuffer (transferred)
//   worker -> page  mw-chunk-cancel { sid, req, i }        v0.3 code review: the player let go of that range (a seek,
//                                                          a closed tab): the page stops waiting for chunk i and
//                                                          takes its piece out of the front of the download
// A GET of KEEPALIVE_PATH is answered 204 at once by the worker (a fetch event keeps it alive too).

export const PROTO = 1;

/** Keep-alive interval: Firefox stops an idle worker after 30 s (+30 s extended), so ping well below. */
export const KEEPALIVE_MS = 20000;
export const KEEPALIVE_PATH = '/_mw/keepalive';

export const MSG = Object.freeze({
  ping: 'mw-ping',
  pong: 'mw-pong',
  ack: 'mw-ack',
  setCurrent: 'mw-set-current',
  mapClient: 'mw-map-client',
  siteSaved: 'mw-site-saved',
  shellCheck: 'mw-shell-check',
  getClients: 'mw-get-clients',
  clients: 'mw-clients',
  keepalive: 'mw-keepalive',
  docInfo: 'mw-doc-info',
  siteInvalid: 'mw-site-invalid',
  reload: 'mw-reload',
  sessionRegister: 'mw-session-register',
  sessionClose: 'mw-session-close',
  sessionLost: 'mw-session-lost',
  chunkNeed: 'mw-chunk-need',
  chunk: 'mw-chunk',
  chunkCancel: 'mw-chunk-cancel',
  messageError: 'mw-message-error',
});

/** The page -> worker message types a worker of this PROTO understands. */
export const PAGE_TYPES = Object.freeze([MSG.ping, MSG.setCurrent, MSG.mapClient, MSG.siteSaved, MSG.shellCheck, MSG.getClients, MSG.keepalive, MSG.docInfo, MSG.sessionRegister, MSG.sessionClose]);

/** message(type, data) → { ...data, proto: PROTO, type } (type and proto always win). */
export function message(type, data) {
  return Object.assign({}, data || {}, { proto: PROTO, type });
}

/** isProtocolMessage(data) → true for an object whose type starts with 'mw-'. */
export function isProtocolMessage(data) {
  return Boolean(data) && typeof data === 'object' && typeof data.type === 'string' && data.type.indexOf('mw-') === 0;
}

/** checkProto(data) → { ok, expected }: ok when data.proto is this PROTO. */
export function checkProto(data) {
  return { ok: Boolean(data) && data.proto === PROTO, expected: PROTO };
}

/**
 * createKeepAlive({ post, intervalMs, setIntervalFn, clearIntervalFn }) → { hold(), release(), stop(), active }
 * While at least one hold() is not yet released, post() runs at once and then every intervalMs
 * (clamped to at most KEEPALIVE_MS). post() should send { proto, type: 'mw-keepalive' } to the
 * controlling worker; its failures are ignored. release() returns the count left.
 */
export function createKeepAlive({
  post, intervalMs = KEEPALIVE_MS,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = (id) => clearInterval(id),
} = {}) {
  const every = Math.max(1, Math.min(KEEPALIVE_MS, Number(intervalMs) || KEEPALIVE_MS));
  let holds = 0;
  let timer = null;
  const ping = () => {
    try {
      if (typeof post === 'function') post();
    } catch (_) { /* the worker went away: the next ping or a new controller takes over */ }
  };
  const api = {
    get active() {
      return timer !== null;
    },
    hold() {
      holds += 1;
      if (timer === null) {
        ping();
        timer = setIntervalFn(ping, every);
      }
      return holds;
    },
    release() {
      if (holds > 0) holds -= 1;
      if (holds === 0 && timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      return holds;
    },
    stop() {
      holds = 0;
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
    },
  };
  return api;
}
