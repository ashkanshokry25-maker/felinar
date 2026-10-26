// test/e2e/scenarios-chat-rows.mjs: the open chat rows of the v0.3 test plan (V03-DESIGN-REVIEW Part 4.2; docs/deviations/
// integration-v03.md, R 4.2 table) run end to end in Chromium, over real WebRTC wires between browser contexts, through the
// e2e stack's local tracker (every URL on 127.0.0.1).
//
// The chat lab. Each peer is a page in a browser context of its own that loads the unbundled chat service
// (src/chat/service.js, the same module the loader bundles) and the vendored WebTorrent bundle (/_mw/webtorrent.min.js),
// joins one or more swarms on the local tracker and registers mw_chat1 through the TorrentManager seam the loader uses
// (registerWireExtension). What is a stand-in, and only that: the site keys and chat key are generated in the page (no
// identity origin), the ledger is a stub (roles 'writer'; a ban list the scenario sets; mw.ck ledger copies the scenario
// adds), the loader's cards answer "Continue" (prompt -> true), and the 60 s timers of the service (the WANT-TAGS period
// and the outbox retry) run every 5 s. The 30 s ACK timeout, the 2 to 20 s ACK delay, the 0.5 to 3 s relay jitter,
// the stamps, the Noise handshake, the holder, the relay budgets and fair queues are the shipped code, unchanged.
// Swarms control the topology: a line A - R - B is two swarms that only R joins, so A and B are not neighbours.
//
//   E-CH-2   recipient offline: the sender's ACK timeout sets the hold flag, a holder keeps the frame (HOLDING back:
//            "handed"); the sender leaves; the recipient comes back, asks with WANT-TAGS, collects it (HELD), and its
//            COLLECTED empties the holder
//   E-CH-3   a stranger frame without a valid stamp is struck and dropped by the relay (measured); with a stamp minted at
//            the recipient's chatBits (20, the default; mint time measured) it lands in the recipient's requests
//   E-CH-4   a moderator ban stops a member's room frames: the relay and the reader refuse them once their ledger holds the
//            ban, and the banned member's own send is E_BANNED once its ledger does
//   E-CH-5   groups: a removal and an addition started at the same moment from the admin's tab converge on one epoch at
//            every member; the removed member cannot read the next message; the newcomer holds no earlier secret and never
//            sees an earlier message (two admins' concurrent rekeys cannot be driven: the API makes the creator the only
//            admin; they are unit-tested, chat-lane-groups U-CH-6)
//   E-CH-7   the phone class relays nothing: the class is decided in an Android-emulated context by the loader's own
//            detectEnvironment and chatDeviceClass; a line A - P - B delivers nothing, a desktop relay then does
//   E-CH-9   a message delivered live (line A - H - B, H a holder) is never held: no hold-flagged frame reaches H, H's
//            store stays empty
//   E-CH-11  captured frames at a relay (the E-CH-9 line, after the wire's Noise layer): no plaintext, no site key, no
//            publicly computable inbox tag in any ENV or WANT-TAGS frame; WANT-TAGS are 1-byte prefixes with decoys; the
//            sealed wire bytes carry no "p256:" while the decrypted CK frames do
//   E-CH-10  a hostile neighbour floods the relay at its cap (16 KiB frames with valid 10-bit stamps): a contact DM across
//            the same relay arrives within the 5 s bound (measured, three messages)
//   E-CH-12  a relay that swaps BitTorrent peer ids: forwarding bytes unchanged, the Noise handshake ends with the real keys
//            and the relay reads and injects nothing; swapping the XX ephemeral fails the handshake; answering as itself,
//            it is seen under its own chat key, never as the peer whose id it claims

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { waitUntil, sleep, StepError, ROOT } from './lib.mjs';
import { inboxTag } from '../../src/chat/tags.js';
import { utcDay } from '../../src/chat/stamp.js';
import { T as FT } from '../../src/chat/frames.js';

export const CHAT_ROWS_ORDER = ['E-CH-2', 'E-CH-9', 'E-CH-11', 'E-CH-3', 'E-CH-4', 'E-CH-5', 'E-CH-7', 'E-CH-10', 'E-CH-12'];

// ---------------------------------------------------------------------------------------------------------------------------
// The lab page's script. Served as text ('(' + labMain + ')()'), so it must not use anything from this module's scope.
// ---------------------------------------------------------------------------------------------------------------------------

/* eslint-disable no-undef */
async function labMain() {
  const mods = await Promise.all([
    import('/_mw/webtorrent.min.js'), import('/src/chat/service.js'), import('/src/chain/crypto.js'), import('/src/chat/seal.js'),
    import('/src/chat/frames.js'), import('/src/chat/stamp.js'), import('/src/chat/tags.js'), import('/src/chain/canonical.js'),
    import('/src/chat/limits.js'),
  ]);
  const WebTorrent = mods[0].default;
  const [, svcMod, cry, sealM, fr, st, tg, canon, lim] = mods;
  const CLICK = { activation: true, tab: 'leader' };
  const rnd = (n) => { const u = new Uint8Array(n); globalThis.crypto.getRandomValues(u); return u; };
  const enc = (v) => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? { __u8: canon.b64url.encode(x) } : x));
  const dec = (s) => JSON.parse(s, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) && typeof x.__u8 === 'string' && Object.keys(x).length === 1 ? canon.b64url.decode(x.__u8) : x));
  const L = {
    ready: false, events: [], strikes: [], errors: [], captured: [], raw: [], wires: [], peerLog: [], counts: {}, relayLog: [],
    clients: [], capture: false, cfg: {}, banned: new Set(), ledgerCks: [], fast: 5000, swapped: 0,
  };
  window.lab = L;
  const store = {
    m: new Map(),
    async get(k) { const s = this.m.get(k); return s === undefined ? undefined : dec(s); },
    async set(k, v) { this.m.set(k, enc(v)); },
  };
  L.dumpStore = () => { const o = {}; for (const [k, v] of store.m) o[k] = v; return o; };
  L.readStore = (k) => { const s = store.m.get(k); return s === undefined ? null : JSON.parse(s); };

  const tm = {
    handlers: [],
    wires: new Set(),
    registerWireExtension(name, handler) {
      this.handlers.push(handler);
      for (const w of this.wires) if (!w.destroyed) { try { handler.onWire(w, 'rendezvous', { late: true }); } catch (e) { L.errors.push('onWire: ' + e.message); } }
      return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
    },
    add(wire) {
      this.wires.add(wire);
      wire.once('close', () => this.wires.delete(wire));
      for (const h of this.handlers) { try { h.onWire(wire, 'rendezvous', {}); } catch (e) { L.errors.push('onWire: ' + e.message); } }
    },
  };

  function client(peerId) {
    const opts = { tracker: { rtcConfig: { iceServers: [] } }, dht: false, lsd: false, utPex: false, webSeeds: false };
    if (peerId) opts.peerId = peerId;
    const c = new WebTorrent(opts);
    c.on('error', (e) => L.errors.push('client: ' + ((e && e.message) || e)));
    L.clients.push(c);
    return c;
  }

  /** join(ihs, { peerId }) -> this client's peer id: one WebTorrent client in those swarms, its wires on the chat seam. */
  L.join = (ihs, { peerId = null, onWire = null } = {}) => {
    const c = client(peerId);
    for (const ih of ihs) {
      const t = c.add('magnet:?xt=urn:btih:' + ih, { announce: [L.tracker] });
      t.on('error', (e) => L.errors.push('torrent: ' + ((e && e.message) || e)));
      t.on('wire', (wire) => {
        L.wires.push({ ih, peerId: wire.peerId, at: Date.now() });
        if (onWire) onWire(wire, ih);
        else tm.add(wire);
      });
    }
    return c.peerId;
  };
  /** leave(): every client destroyed (no wire to anyone: this page is offline for the swarm). */
  L.leave = () => {
    for (const c of L.clients) { try { c.destroy(); } catch (_) { /* gone */ } }
    L.clients = [];
  };

  function record(w, d, bytes, phase) {
    L.counts[d.type] = (L.counts[d.type] || 0) + 1;
    if (!L.capture || L.captured.length >= 6000) return;
    const r = { at: Date.now(), phase, wire: w.id, type: d.type, flags: d.header.flags, hop: d.header.hop, day: d.header.day };
    if (d.fields && d.fields.tag instanceof Uint8Array) r.tag = canon.hex.encode(d.fields.tag);
    if (d.type === fr.T.WANT) r.want = d.fields.entries.map((e) => canon.hex.encode(e));
    r.b64 = canon.b64url.encode(bytes || d.body);
    L.captured.push(r);
  }

  function instrument(lane) {
    lane.on('strike', (e) => L.strikes.push(Object.assign({ at: Date.now() }, e)));
    lane.on('peer', (e) => L.peerLog.push({ at: Date.now(), wire: e.wire, remote: e.remote, up: true }));
    lane.on('peer-gone', (e) => L.peerLog.push({ at: Date.now(), wire: e.wire, remote: e.remote, up: false, reason: e.reason }));
    const frame = lane._frame.bind(lane);
    lane._frame = (w, d, bytes) => { record(w, d, bytes, 'frame'); return frame(w, d, bytes); };
    const pre = lane._preSession.bind(lane);
    lane._preSession = (w, d) => { record(w, d, null, 'pre'); return pre(w, d); };
    const onMessage = lane.onMessage.bind(lane);
    lane.onMessage = (id, raw) => {
      if (L.capture && L.raw.length < 6000) L.raw.push({ at: Date.now(), wire: id, len: raw.length, b64: canon.b64url.encode(raw) });
      return onMessage(id, raw);
    };
  }

  L.held = () => { const h = L.svc && L.svc.lane && L.svc.lane.holder; return h ? h.items.size : null; };
  L.stats = () => {
    const ln = L.svc && L.svc.lane;
    if (!ln) return null;
    return Object.assign({ relayedBytes: ln.relayed, peers: ln.peers().map((p) => ({ id: p.id, remote: p.remote })), held: L.held(), counts: L.counts }, ln.stats);
  };
  L.call = async (name, params, ctx) => {
    try { return { ok: await L.svc.methods[name](params, ctx || CLICK) }; } catch (e) { return { err: e.code || e.message }; }
  };
  L.hasCk = (pub) => !!(L.svc && L.svc.sig.ckOf(pub));
  L.addLedgerCk = (ck) => { L.ledgerCks.push({ v: ck, author: ck.signer }); };

  /** init(o): keys (fresh or o.keys), a chat service on a stub ledger, chat on, optionally the holder, then the swarms. */
  L.init = async (o) => {
    L.name = o.name;
    L.tracker = o.tracker;
    L.ledgerId = o.ledgerId;
    L.cfg = Object.assign({ chat: 'open', requests: 'open' }, o.cfg || {});
    let signPriv;
    let signJwk;
    if (o.keys) {
      signJwk = o.keys.sign;
      signPriv = await cry.importPrivateJwk(signJwk);
    } else {
      const kp = await cry.generateKeyPair({ extractable: true });
      signJwk = await cry.exportPrivateJwk(kp.privateKey);
      signPriv = await cry.importPrivateJwk(signJwk);
    }
    const pub = await cry.publicFromPrivateJwk(signJwk);
    let chatJwk = o.keys && o.keys.chat;
    if (!chatJwk) {
      const p = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      chatJwk = await globalThis.crypto.subtle.exportKey('jwk', p.privateKey);
    }
    const chat = await sealM.chatKeyFromJwk(chatJwk);
    L.keys = { sign: signJwk, chat: chatJwk };
    L.chat = chat;
    let deviceClass = o.deviceClass || 'desktop';
    if (deviceClass === 'auto') {
      // The loader's own decision (src/loader/policy.js detectEnvironment, src/loader/api.js chatDeviceClass).
      const pol = await import('/src/loader/policy.js');
      const api = await import('/src/loader/api.js');
      const env = pol.detectEnvironment();
      L.env = { isMobile: env.isMobile, ua: navigator.userAgent, coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints };
      deviceClass = api.chatDeviceClass(env, navigator);
    }
    L.deviceClass = deviceClass;
    if (o.storeDump) for (const [k, v] of Object.entries(o.storeDump)) store.m.set(k, v);
    const node = {
      syncing: false,
      state: {
        owner: null, ownerConflict: false, policy: { banned: new Set(), moderators: new Set(), allow: new Set(), writers: 'open' },
        lists: new Map([['mw.ck', L.ledgerCks]]), rotations: new Map(),
      },
      roleOf: () => 'writer',
      isBanned: (p) => L.banned.has(p),
    };
    const svc = svcMod.createChatService({
      keys: { pub, sign: (b) => cry.sign(signPriv, b), chat }, ledgerId: L.ledgerId, node, cfg: () => L.cfg, deviceClass,
      hostOnly: false, ownTracker: L.tracker, wires: tm, store, prompt: async () => true, win: null, ckShare: 'reason',
      setTimeout: (fn, ms) => setTimeout(fn, ms === 60000 ? L.fast : ms), clearTimeout: (h) => clearTimeout(h),
    });
    for (const ev of svcMod.CHAT_EVENTS) svc.on(ev, (data) => { L.events.push({ ev, at: Date.now(), data: JSON.parse(enc(data === undefined ? null : data)) }); });
    L.svc = svc;
    L.pub = pub;
    const on = await L.call('chat.enable', {});
    if (on.err) throw new Error('chat.enable: ' + on.err);
    instrument(svc.lane);
    if (o.holder) {
      const h = await L.call('chat.holder.set', { on: true });
      if (h.err) throw new Error('chat.holder.set: ' + h.err);
    }
    L.peerIds = [];
    for (const j of o.joins || []) L.peerIds.push(L.join(j.ihs, { peerId: j.peerId || null }));
    L.ready = true;
    return { pub, chatPub: chat.pub, ck: svc.sig.ckOf(pub), deviceClass, env: L.env || null, peerIds: L.peerIds, keys: L.keys };
  };

  /** E-CH-3: n stranger ENV frames to `to` (a chat key) whose stamp is below 20 bits, flooded on this page's wires. */
  L.badStranger = async ({ to, n }) => {
    const ck = L.svc.sig.ckOf(L.pub);
    const ids = [];
    for (let i = 0; i < n; i++) {
      const sealed = await sealM.sealDm({
        myChat: L.chat, theirChatPub: to, ledgerId: L.ledgerId, day: st.utcDay(Date.now()), stranger: true, ck,
        message: { id: rnd(16), t: Date.now(), n: 0, kind: lim.KIND.text, body: canon.utf8.encode('unstamped request ' + i) },
      });
      const f = fr.encode(fr.T.ENV, { flags: lim.FLAG_STRANGER, day: st.headerDay(Date.now()) }, fr.envBody(sealed));
      const id = fr.frameId(f);
      let nonce = rnd(8);
      while (st.check(id, nonce, 20)) nonce = rnd(8);
      L.svc.lane.send(fr.withNonce(f, nonce), {});
      ids.push(canon.hex.encode(id));
    }
    return ids;
  };

  /** E-CH-10: ENV frames of `ct` bytes with random tags (or a recipient's public inbox tag) and valid stamps, at a rate. */
  L.junk = async ({ ms, perSecond, ct = 16016, bits = 10, inboxOf = null }) => {
    const eph = await sealM.generateChatKey();
    const epk = cry.publicKeyBytes(eph.pub);
    const end = Date.now() + ms;
    const gap = 1000 / perSecond;
    let next = Date.now();
    let sent = 0;
    let bytes = 0;
    while (Date.now() < end) {
      const tag = inboxOf ? await tg.inboxTag(inboxOf, st.utcDay(Date.now())) : rnd(8);
      const f = fr.encode(fr.T.ENV, { flags: inboxOf ? lim.FLAG_STRANGER : 0, day: st.headerDay(Date.now()) }, fr.envBody({ tag, epk, iv: rnd(12), ct: rnd(ct) }));
      const nonce = await st.mint(fr.frameId(f), bits);
      L.svc.lane.send(fr.withNonce(f, nonce), {});
      sent++;
      bytes += f.length;
      next += gap;
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return { sent, bytes };
  };

  /**
   * E-CH-12: a relay with no chat service. Its client toward A joins ihA under B's peer id, its client toward B joins ihB
   * under A's; mw_chat1 messages are forwarded between the two wires (mode 'pass': unchanged; 'swap-e': the ephemeral key of
   * the XX first message replaced by the relay's own).
   */
  L.relay = async ({ tracker, ihA, ihB, peerIdA, peerIdB, mode }) => {
    L.tracker = tracker;
    L.mode = mode;
    const sides = { A: { wire: null, queue: [] }, B: { wire: null, queue: [] } };
    const mine = mode === 'swap-e' ? await sealM.generateChatKey() : null;
    const send = (side, bytes) => {
      const s = sides[side];
      if (s.wire) { try { s.wire.extended('mw_chat1', bytes); } catch (e) { L.errors.push('relay send: ' + e.message); } } else s.queue.push(bytes);
    };
    const forward = (from, bytes) => {
      let out = bytes;
      const d = fr.decode(bytes);
      if (mode === 'swap-e' && !d.error && d.type === fr.T.XX && d.fields.step === 1) {
        const m = d.fields.msg;
        const nm = new Uint8Array(m.length);
        nm.set(cry.publicKeyBytes(mine.pub), 0);
        nm.set(m.subarray(65), 65);
        out = fr.encode(fr.T.XX, { day: d.header.day }, fr.xxBody(1, nm));
        L.swapped++;
      }
      if (L.relayLog.length < 4000) L.relayLog.push({ at: Date.now(), dir: from + '>' + (from === 'A' ? 'B' : 'A'), len: bytes.length, clearType: d.error ? null : d.type, b64: canon.b64url.encode(bytes) });
      send(from === 'A' ? 'B' : 'A', out);
    };
    const ext = (side) => {
      class Relay {
        constructor(wire) { this.wire = wire; }
        onHandshake() {}
        onExtendedHandshake(h) {
          if (!h || !h.m || !h.m.mw_chat1) return;
          sides[side].wire = this.wire;
          const q = sides[side].queue.splice(0);
          for (const b of q) send(side, b);
        }
        onMessage(buf) { forward(side, new Uint8Array(buf)); }
      }
      Relay.prototype.name = 'mw_chat1';
      return Relay;
    };
    L.join([ihA], { peerId: peerIdB, onWire: (wire) => wire.use(ext('A')) });
    L.join([ihB], { peerId: peerIdA, onWire: (wire) => wire.use(ext('B')) });
    L.inject = (side, n) => { for (let i = 0; i < n; i++) send(side, rnd(400)); return n; };
    L.ready = true;
    return { peerIds: L.clients.map((c) => c.peerId) };
  };

  L.ready = 'loaded';
}
/* eslint-enable no-undef */

// ---------------------------------------------------------------------------------------------------------------------------
// Node side: the lab server, peers, helpers
// ---------------------------------------------------------------------------------------------------------------------------

const ih = () => randomBytes(20).toString('hex');

async function startLab(stack) {
  const js = '(' + labMain.toString() + ')().catch((e) => { window.labError = String((e && e.stack) || e); });\n';
  const html = '<!doctype html><meta charset="utf-8"><title>chat lab</title><script type="module" src="/lab.js"></script>';
  const srcRoot = resolve(ROOT, 'src');
  const server = http.createServer((req, res) => {
    let body = null;
    let type = 'text/javascript; charset=utf-8';
    try {
      const p = new URL(req.url, 'http://lab.invalid').pathname;
      if (p === '/lab.html') { body = html; type = 'text/html; charset=utf-8'; }
      else if (p === '/lab.js') body = js;
      else if (p === '/_mw/webtorrent.min.js') body = readFileSync(join(stack.dist, '_mw', 'webtorrent.min.js'));
      else if (p.startsWith('/src/') && p.endsWith('.js')) {
        const f = resolve(ROOT, '.' + p);
        if (f.startsWith(srcRoot + sep) && existsSync(f)) body = readFileSync(f);
      }
    } catch (_) { body = null; }
    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const url = 'http://127.0.0.1:' + server.address().port;
  return { url, close: () => new Promise((ok) => { server.close(() => ok()); if (server.closeAllConnections) server.closeAllConnections(); }) };
}

/** An Android phone in Chromium's device emulation (user agent, viewport, touch, a coarse pointer). */
export const ANDROID_CONTEXT = Object.freeze({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
});

/** chatRowsScenarios({ assert, run }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function chatRowsScenarios({ assert }) {
  const S = {};

  async function lab(ctx) {
    if (ctx.shared.chatLab) return ctx.shared.chatLab;
    const l = await startLab(ctx.stack);
    l.ledgerId = 'e2e-chat-rows-' + randomBytes(6).toString('hex');
    ctx.closers.push(() => l.close());
    ctx.shared.chatLab = l;
    return l;
  }

  /** A lab page in a context of its own: init(o) runs there. Returns { name, page, pub, chatPub, ck, ... }. */
  async function peer(ctx, name, o = {}, { contextOptions = {}, relay = null } = {}) {
    const l = await lab(ctx);
    const v = await ctx.visitor(name, { serviceWorkers: 'block', contextOptions });
    const page = await v.newPage();
    await page.goto(l.url + '/lab.html', { waitUntil: 'load', timeout: 20000 });
    await waitUntil(async () => {
      const s = await page.evaluate(() => (window.labError ? { error: window.labError } : (window.lab ? window.lab.ready : null)));
      if (s && s.error) throw new StepError(name + ': the lab did not load: ' + s.error);
      return s ? true : null;
    }, { timeoutMs: 20000, label: name + ': lab loaded' });
    const info = relay
      ? await page.evaluate((r) => window.lab.relay(r), Object.assign({ tracker: ctx.stack.tracker.url }, relay))
      : await page.evaluate((x) => window.lab.init(x), Object.assign({ name, tracker: ctx.stack.tracker.url, ledgerId: l.ledgerId }, o));
    return Object.assign({ name, page, v }, info);
  }

  const L = (p, fn, arg) => p.page.evaluate(fn, arg);
  const call = (p, name, params) => L(p, (a) => window.lab.call(a.name, a.params), { name, params: params || {} });
  const stats = (p) => L(p, () => window.lab.stats());
  const events = (p, ev) => L(p, (e) => window.lab.events.filter((x) => x.ev === e), ev);
  async function ok(p, name, params) {
    const r = await call(p, name, params);
    if (r.err) throw new StepError(p.name + ': ' + name + ' -> ' + r.err);
    return r.ok;
  }
  async function peers(p, n, label) {
    return waitUntil(async () => {
      const s = await stats(p);
      return s && s.peers.length >= n ? s.peers : null;
    }, { timeoutMs: 30000, label: label || p.name + ': ' + n + ' chat neighbour(s)' });
  }
  async function closeAll(ctx, list) {
    for (const p of list) if (p) await ctx.closeVisitor(p.name).catch(() => {});
  }
  /** Contacts both ways; each side's chat key comes from a CK frame (neighbours) or a ledger copy (ledger: true). */
  async function contacts(a, b, { ledger = false } = {}) {
    if (ledger) {
      await L(a, (ck) => window.lab.addLedgerCk(ck), b.ck);
      await L(b, (ck) => window.lab.addLedgerCk(ck), a.ck);
    }
    // Review round R 5.3 (PRIV-2): contacts first on both sides; each then looks for the other's key, so the CK comes.
    for (const [x, y] of [[a, b], [b, a]]) await ok(x, 'chat.contacts.add', { pub: y.pub, nick: y.name });
    for (const [x, y] of [[a, b], [b, a]]) {
      await waitUntil(() => L(x, (pub) => window.lab.hasCk(pub), y.pub), { timeoutMs: 30000, label: x.name + ' has ' + y.name + '\'s chat key' });
    }
  }
  const msgAt = (p, text) => events(p, 'message').then((l) => l.find((e) => e.data && e.data.text === text) || null);
  /**
   * Waits until relay r holds a WANT-TAGS route toward `to` that was set at or after `since` (r's clock): a relay that has
   * no route sends a frame to a random half of its eligible neighbours (src/chat/lane.js _relay, _randomHalf), so with two
   * or more of them a first DM reaches its recipient only half the time until the recipient's WANT-TAGS arrive.
   */
  async function routed(r, to, since, label) {
    return waitUntil(() => L(r, (a) => {
      const ln = window.lab.svc.lane;
      const w = ln.peers().find((p) => p.remote === a.to);
      if (!w) return null;
      for (const m of ln.prefixRoutes.values()) if ((m.get(w.id) || 0) >= a.since) return true;
      return null;
    }, { to: to.chatPub, since }), { timeoutMs: 30000, label: label || r.name + ' has a WANT-TAGS route toward ' + to.name });
  }
  const clock = (p) => L(p, () => Date.now());

  // ------------------------------------------------------------------------------------------- E-CH-2
  S['E-CH-2'] = {
    title: 'recipient offline: the ACK timeout sets the hold flag, a holder keeps the frame (handed), the sender leaves; the recipient comes back, collects it with WANT-TAGS, and COLLECTED empties the holder',
    async fn(ctx, step) {
      const sw = ih();
      let A, B, H;
      try {
        [A, B, H] = await step('A, B and the holder H (chat.holder.set on, a desktop) join one swarm; every pair finishes the Noise handshake', async () => {
          const a = await peer(ctx, 'CR2-A', { joins: [{ ihs: [sw] }] });
          const b = await peer(ctx, 'CR2-B', { joins: [{ ihs: [sw] }] });
          const h = await peer(ctx, 'CR2-H', { joins: [{ ihs: [sw] }], holder: true });
          for (const p of [a, b, h]) await peers(p, 2);
          return [a, b, h];
        });
        await step('A and B add each other (chat keys from the CK frames of the wire)', () => contacts(A, B));
        await step('B goes offline (its WebTorrent client is destroyed); A and H drop to one neighbour', async () => {
          await L(B, () => window.lab.leave());
          for (const p of [A, H]) {
            await waitUntil(async () => ((await stats(p)).peers.length === 1 ? true : null), { timeoutMs: 30000, label: p.name + ' sees B gone' });
          }
        });
        const t0 = Date.now();
        const sent = await step('A sends "held for B": no ACK, so after the 30 s ACK timeout a hold-flagged copy goes out; H holds it and its HOLDING makes A\'s state "handed"', async () => {
          const r = await ok(A, 'chat.dm.send', { pub: B.pub, text: 'held for B' });
          const handed = await waitUntil(async () => {
            const d = await events(A, 'delivery');
            return d.find((x) => x.data.id === r.id && x.data.state === 'handed') || null;
          }, { timeoutMs: 55000, label: 'handed at A' });
          const held = await L(H, () => window.lab.held());
          assert(held === 1, 'H holds ' + held + ' frame(s)');
          return { id: r.id, first: r.state, handedMs: handed.at - t0, handed: handed.data.handed };
        });
        assert(sent.handedMs >= 29000, 'held after ' + sent.handedMs + ' ms, before the 30 s ACK timeout');
        await step('A goes offline too; B comes back (a new client in the swarm) and has only H as a neighbour', async () => {
          await L(A, () => window.lab.leave());
          await L(B, (s) => window.lab.join([s]), sw);
          await peers(B, 1);
        });
        const t1 = Date.now();
        const got = await step('B asks H with WANT-TAGS (1-byte prefixes), H answers HELD, B opens it: the message arrives from A', () => waitUntil(() => msgAt(B, 'held for B'), { timeoutMs: 45000, label: 'the held message at B' }));
        assert(got.data.from === A.pub, 'from ' + got.data.from);
        const collected = await step('B\'s COLLECTED deletes the frame at H (the holder is empty)', () => waitUntil(async () => ((await L(H, () => window.lab.held())) === 0 ? Date.now() : null), { timeoutMs: 20000, label: 'H empty' }));
        const hs = await stats(H);
        return 'first state ' + sent.first + '; handed after ' + (sent.handedMs / 1000).toFixed(1) + ' s (' + sent.handed + ' holder); held 1; B back: delivered from the holder after ' +
          ((got.at - t1) / 1000).toFixed(1) + ' s, collected (holder empty) after ' + ((collected - t1) / 1000).toFixed(1) + ' s; H saw ' + (hs.counts[FT.WANT] || 0) + ' WANT-TAGS frame(s)';
      } finally {
        await closeAll(ctx, [A, B, H]);
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-9 (and the world of E-CH-11)
  S['E-CH-9'] = {
    title: 'a message delivered live on a line A - H - B (H a holder) is never held: no hold-flagged frame reaches H and H\'s store stays empty',
    async fn(ctx, step) {
      const s1 = ih();
      const s2 = ih();
      const [A, B, H] = await step('the line A - H - B (two swarms only H joins); H turns the holder on and captures what it reads', async () => {
        const h = await peer(ctx, 'CR9-H', { joins: [{ ihs: [s1, s2] }], holder: true });
        await L(h, () => { window.lab.capture = true; });
        const a = await peer(ctx, 'CR9-A', { joins: [{ ihs: [s1] }] });
        const b = await peer(ctx, 'CR9-B', { joins: [{ ihs: [s2] }] });
        await peers(h, 2);
        await peers(a, 1);
        await peers(b, 1);
        return [a, b, h];
      });
      ctx.shared.chatRows9 = { A, B, H };
      await step('A and B add each other (not neighbours: each other\'s chat key from the opt-in ledger copy)', () => contacts(A, B, { ledger: true }));
      const t0 = Date.now();
      const r = await step('A sends "the secret word is lantern"; it crosses H and B receives it', async () => {
        const s = await ok(A, 'chat.dm.send', { pub: B.pub, text: 'the secret word is lantern' });
        const m = await waitUntil(() => msgAt(B, 'the secret word is lantern'), { timeoutMs: 30000, label: 'the message at B' });
        return { id: s.id, ms: m.at - t0 };
      });
      const delivered = await step('B\'s sealed ACK (2 to 20 s later) crosses H: A shows "delivered" before its 30 s ACK timeout', () => waitUntil(async () => {
        const d = await events(A, 'delivery');
        return d.find((x) => x.data.id === r.id && x.data.state === 'delivered') || null;
      }, { timeoutMs: 40000, label: 'delivered at A' }));
      await step('35 s after the send: H never received a hold-flagged frame and holds nothing', async () => {
        const wait = t0 + 35000 - Date.now();
        if (wait > 0) await sleep(wait);
      }, 40000);
      const cap = await L(H, () => window.lab.captured.filter((c) => c.type === 3 || c.type === 0x0b).map((c) => ({ flags: c.flags })));
      const hs = await stats(H);
      assert(cap.length >= 2, 'H read ' + cap.length + ' ENV frame(s); the line did not carry the message through H');
      assert(!cap.some((c) => c.flags & 1), 'a hold-flagged frame reached H');
      assert(hs.held === 0, 'H holds ' + hs.held);
      assert(hs.relayed >= 2, 'H relayed ' + hs.relayed + ' frame(s)');
      return 'delivered to B ' + (r.ms / 1000).toFixed(1) + ' s after the send, ACKed ("delivered" at A) after ' + ((delivered.at - t0) / 1000).toFixed(1) +
        ' s; H read ' + cap.length + ' ENV frames, relayed ' + hs.relayed + ', none hold-flagged, holds 0';
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-11
  S['E-CH-11'] = {
    title: 'frames captured at a relay (E-CH-9\'s H, after the wire\'s Noise layer) hold no plaintext, no site key and no publicly computable inbox tag; WANT-TAGS are 1-byte prefixes with decoys; the sealed wire bytes carry no key text',
    async fn(ctx, step) {
      const w = ctx.shared.chatRows9;
      assert(w, 'E-CH-9 did not run');
      const { A, B, H } = w;
      try {
        await step('H keeps capturing until it has WANT-TAGS frames from both A and B (every 5 s in the lab, 60 s shipped)', () => waitUntil(async () => {
          const c = await L(H, () => window.lab.captured.filter((x) => x.type === 5).map((x) => x.wire));
          return new Set(c).size >= 2 ? c : null;
        }, { timeoutMs: 30000, label: 'WANT-TAGS from both sides' }));
        const cap = await L(H, () => ({ frames: window.lab.captured.slice(), raw: window.lab.raw.slice() }));
        const day = utcDay(Date.now());
        const inbox = new Set();
        for (const p of [A, B]) for (const d of [day - 1, day, day + 1]) inbox.add(Buffer.from(await inboxTag(p.chatPub, d)).toString('hex'));
        const bytesOf = (x) => Buffer.from(x.b64, 'base64url');
        const env = cap.frames.filter((f) => f.type === FT.ENV);
        const want = cap.frames.filter((f) => f.type === FT.WANT);
        const ck = cap.frames.filter((f) => f.type === FT.CK);
        const res = await step('scan: ENV, HOLDING, COLLECTED and WANT-TAGS frames; the raw sealed wire messages', async () => {
          const needles = [Buffer.from('the secret word is lantern'), Buffer.from('lantern'), Buffer.from(A.pub), Buffer.from(B.pub), Buffer.from(A.pub.slice(5, 40)), Buffer.from(B.pub.slice(5, 40))];
          const conv = cap.frames.filter((f) => f.type !== FT.CK && f.type !== FT.HELLO && f.type !== FT.XX);
          for (const f of conv) for (const n of needles) assert(bytesOf(f).indexOf(n) < 0, 'a ' + f.type + ' frame holds "' + n.toString().slice(0, 30) + '"');
          for (const f of env) assert(!inbox.has(f.tag), 'an ENV frame carries a public inbox tag: ' + f.tag);
          let entries = 0;
          for (const f of want) {
            for (const e of f.want) {
              entries++;
              assert(e.length === 2, 'a WANT-TAGS entry of ' + (e.length / 2) + ' bytes: ' + e);
              assert(!inbox.has(e), 'a WANT-TAGS entry is an inbox tag');
            }
            assert(f.want.length <= 32 && f.want.length >= 5, 'a WANT-TAGS frame with ' + f.want.length + ' entries (real prefixes plus at least 4 decoys)');
          }
          const p256 = Buffer.from('p256:');
          const rawHits = cap.raw.filter((r) => bytesOf(r).indexOf(p256) >= 0 && bytesOf(r).indexOf(Buffer.from('"lanes"')) < 0).length;
          const ckHits = ck.filter((f) => bytesOf(f).indexOf(p256) >= 0).length;
          const rawText = cap.raw.filter((r) => bytesOf(r).indexOf(Buffer.from('lantern')) >= 0).length;
          assert(rawHits === 0 && rawText === 0, 'sealed wire messages hold key text (' + rawHits + ') or the message (' + rawText + ')');
          // Review round R 5.3 (PRIV-2): a relay that is nobody's contact gets no CK frame now (ckShare 'reason'), so the proof that
          // the capture reads the decrypted layer is the parsed WANT-TAGS frames (only readable after Noise), or a CK when one came.
          assert(ckHits > 0 || want.length > 0, 'the capture did not read the decrypted layer (no CK and no parsed WANT-TAGS frame: the scan would prove nothing)');
          return { conv: conv.length, env: env.length, want: want.length, entries, raw: cap.raw.length, ckHits };
        });
        return res.conv + ' conversation frames (' + res.env + ' ENV) and ' + res.raw + ' sealed wire messages scanned: no plaintext, no site key, no inbox tag; ' + res.want +
          ' WANT-TAGS frames, ' + res.entries + ' entries, all 1-byte prefixes; ' + res.ckHits + ' decrypted CK frames carry "p256:", the sealed bytes none';
      } finally {
        await closeAll(ctx, [A, B, H]);
        ctx.shared.chatRows9 = null;
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-3
  S['E-CH-3'] = {
    title: 'a stranger frame without a valid stamp is struck and dropped by the relay; with a stamp at the recipient\'s chatBits (20) it lands in the recipient\'s requests',
    async fn(ctx, step) {
      const s1 = ih();
      const s2 = ih();
      let A, R, B;
      try {
        [A, R, B] = await step('the line A - R - B, chatBits 20 (the default), requests on for the site; B opens its requests', async () => {
          const r = await peer(ctx, 'CR3-R', { joins: [{ ihs: [s1, s2] }] });
          const a = await peer(ctx, 'CR3-A', { joins: [{ ihs: [s1] }] });
          const b = await peer(ctx, 'CR3-B', { joins: [{ ihs: [s2] }] });
          await peers(r, 2);
          await ok(b, 'chat.requests.setOpen', { open: true });
          await L(a, (ck) => window.lab.addLedgerCk(ck), b.ck); // B's opt-in ledger copy: how a stranger learns its chat key
          await waitUntil(() => L(a, (pub) => window.lab.hasCk(pub), b.pub), { timeoutMs: 5000, label: 'B\'s chat key at A' });
          return [a, r, b];
        });
        const junk = await step('A floods 5 stranger frames to B\'s inbox whose stamps are under 20 bits', () => L(A, (to) => window.lab.badStranger({ to, n: 5 }), B.chatPub));
        await sleep(4000);
        const r1 = await L(R, () => ({ strikes: window.lab.strikes.filter((s) => s.reason === 'stamp').length, s: window.lab.stats() }));
        const b1 = await L(B, () => ({ env: window.lab.counts[3] || 0, requests: window.lab.events.filter((e) => e.ev === 'request').length }));
        assert(r1.strikes === junk.length, 'R struck ' + r1.strikes + ' of ' + junk.length + ' unstamped frames');
        assert(r1.s.relayed === 0 && b1.env === 0 && b1.requests === 0, 'an unstamped frame went on: R relayed ' + r1.s.relayed + ', B read ' + b1.env + ' ENV, ' + b1.requests + ' request(s)');
        const t0 = Date.now();
        const sent = await step('A sends a stranger message: the service mints the 20-bit stamp (timed)', () => ok(A, 'chat.dm.send', { pub: B.pub, text: 'hello from a stranger' }), 60000);
        const mintMs = Date.now() - t0;
        assert(sent.state === 'sent-unknown', 'state ' + sent.state);
        const req = await step('R relays it; it lands in B\'s requests (from A); B accepts it and reads the text', async () => {
          const e = await waitUntil(async () => (await events(B, 'request')).find((x) => x.data.from === A.pub) || null, { timeoutMs: 20000, label: 'the request at B' });
          await ok(B, 'chat.requests.accept', { id: e.data.id });
          await waitUntil(() => msgAt(B, 'hello from a stranger'), { timeoutMs: 5000, label: 'the accepted message' });
          return e;
        });
        const r2 = await stats(R);
        return junk.length + ' unstamped stranger frames: ' + r1.strikes + ' strikes at R, 0 relayed, 0 at B; the stamped one: minted in ' + mintMs + ' ms (20 bits, Chromium on this machine), a request at B ' +
          ((req.at - t0 - mintMs) / 1000).toFixed(1) + ' s after it left; R relayed ' + r2.relayed + ' frame(s)';
      } finally {
        await closeAll(ctx, [A, R, B]);
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-4
  S['E-CH-4'] = {
    title: 'a moderator ban stops a member\'s room frames: the relay and the reader drop them once their ledger holds the ban; the banned member\'s own send is E_BANNED once its ledger does',
    async fn(ctx, step) {
      const s1 = ih();
      const s2 = ih();
      let A, R, B;
      try {
        [A, R, B] = await step('the line B - R - A; A and B join the Lobby', async () => {
          const r = await peer(ctx, 'CR4-R', { joins: [{ ihs: [s1, s2] }] });
          const b = await peer(ctx, 'CR4-B', { joins: [{ ihs: [s1] }] });
          const a = await peer(ctx, 'CR4-A', { joins: [{ ihs: [s2] }] });
          await peers(r, 2);
          for (const p of [a, b]) await ok(p, 'chat.room.join', { name: 'Lobby' });
          return [a, r, b];
        });
        await step('before the ban: B\'s room message crosses R and reaches A', async () => {
          await ok(B, 'chat.room.send', { name: 'Lobby', text: 'before the ban' });
          await waitUntil(async () => (await events(A, 'room')).find((x) => x.data.text === 'before the ban') || null, { timeoutMs: 15000, label: 'the room message at A' });
        });
        const before = await stats(R);
        await step('the ban reaches R\'s and A\'s ledgers (not yet B\'s); B sends again: R drops the frame, A shows nothing', async () => {
          for (const p of [R, A]) await L(p, (pub) => window.lab.banned.add(pub), B.pub);
          await ok(B, 'chat.room.send', { name: 'Lobby', text: 'after the ban' });
          await sleep(6000); // the relay jitter is at most 3 s
        }, 20000);
        const after = await stats(R);
        const atA = (await events(A, 'room')).filter((x) => x.data.text === 'after the ban').length;
        assert((after.counts[FT.ROOM] || 0) > (before.counts[FT.ROOM] || 0), 'R never received the frame (the test proves nothing)');
        assert(after.relayed === before.relayed, 'R relayed the banned member\'s frame');
        assert(atA === 0, 'A shows the banned member\'s message');
        const own = await step('the ban reaches B\'s ledger: chat.room.send is E_BANNED at B (nothing leaves)', async () => {
          await L(B, (pub) => window.lab.banned.add(pub), B.pub);
          return call(B, 'chat.room.send', { name: 'Lobby', text: 'third try' });
        });
        assert(own.err === 'E_BANNED', 'B: ' + JSON.stringify(own));
        return 'before: delivered; after: R read the frame and relayed none (relayed ' + before.relayed + ' -> ' + after.relayed + '), A showed 0; B\'s own send: ' + own.err;
      } finally {
        await closeAll(ctx, [A, R, B]);
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-5
  S['E-CH-5'] = {
    title: 'groups: a removal and an addition started at the same moment converge on one epoch for every member; the removed member cannot read the next message; the newcomer holds no earlier secret and never sees an earlier message',
    async fn(ctx, step) {
      const sw = ih();
      let A, B, C, D;
      try {
        [A, B, C, D] = await step('A (admin), B, C and D in one swarm; A adds B, C and D as contacts and they add A', async () => {
          const list = [];
          for (const n of ['CR5-A', 'CR5-B', 'CR5-C', 'CR5-D']) list.push(await peer(ctx, n, { joins: [{ ihs: [sw] }] }));
          for (const p of list) await peers(p, 3);
          for (const p of list.slice(1)) await contacts(list[0], p);
          return list;
        });
        const g = await step('A creates the group { A, B, C }; B and C take the invite', async () => {
          const r = await ok(A, 'chat.group.create', { name: 'rows', members: [B.pub, C.pub] });
          for (const p of [B, C]) await waitUntil(async () => (await events(p, 'group')).find((e) => e.data.groupId === r.groupId && e.data.epochId === r.epochId) || null, { timeoutMs: 30000, label: p.name + ' joined' });
          return r;
        });
        await step('A writes "m1 before D"; B and C read it', async () => {
          await ok(A, 'chat.group.send', { groupId: g.groupId, text: 'm1 before D' });
          for (const p of [B, C]) await waitUntil(async () => (await events(p, 'group')).find((e) => e.data.text === 'm1 before D') || null, { timeoutMs: 20000, label: 'm1 at ' + p.name });
        });
        const both = await step('at the same moment (two calls, neither awaited first): A removes C and invites D', async () => {
          const [r1, r2] = await Promise.all([
            call(A, 'chat.group.remove', { groupId: g.groupId, pub: C.pub }),
            call(A, 'chat.group.invite', { groupId: g.groupId, pub: D.pub }),
          ]);
          if (r1.err || r2.err) throw new StepError('remove ' + JSON.stringify(r1) + ', invite ' + JSON.stringify(r2));
          return [r1.ok, r2.ok];
        });
        const lastEpoch = async (p) => {
          const e = (await events(p, 'group')).filter((x) => x.data.groupId === g.groupId && x.data.epochId);
          return e.length ? e[e.length - 1].data : null;
        };
        const conv = await step('B and D converge on one epoch whose members are A, B and D (stable for 4 s), the one A ends on', async () => {
          let last = null;
          let since = 0;
          return waitUntil(async () => {
            const l = await Promise.all([B, D].map(lastEpoch));
            const id = l[0] && l[0].epochId;
            const same = l.every((x) => x && x.epochId === id && x.members.indexOf(D.pub) >= 0 && x.members.indexOf(C.pub) < 0 && x.members.length === 3);
            if (!same) { last = null; return null; }
            if (last !== id) { last = id; since = Date.now(); return null; }
            return Date.now() - since >= 4000 ? { epochId: id, conflicts: (await events(B, 'group')).filter((x) => x.data.event === 'conflict').length } : null;
          }, { timeoutMs: 40000, stepMs: 500, label: 'one epoch' }).catch(async (err) => {
            const l = await Promise.all([B, C, D].map(lastEpoch));
            throw new StepError(err.message + ' (A returned ' + JSON.stringify(both.map((x) => ({ e: x.epochId.slice(0, 8), m: x.members.length }))) + '; B, C, D last: ' +
              JSON.stringify(l.map((x) => x && { e: x.epochId && x.epochId.slice(0, 8), n: x.members && x.members.length, ev: x.event })) + ')');
          });
        }, 50000);
        const aEnd = both.map((x) => x.epochId);
        assert(aEnd.indexOf(conv.epochId) >= 0, 'A ended on another epoch than B and D');
        const t2 = Date.now();
        await step('B writes "m2 after"; A and D read it; C (removed) reads nothing within 8 s', async () => {
          await ok(B, 'chat.group.send', { groupId: g.groupId, text: 'm2 after' });
          for (const p of [A, D]) await waitUntil(async () => (await events(p, 'group')).find((e) => e.data.text === 'm2 after') || null, { timeoutMs: 20000, label: 'm2 at ' + p.name });
          await sleep(Math.max(0, t2 + 8000 - Date.now()));
          const atC = (await events(C, 'group')).filter((e) => e.data.text === 'm2 after').length;
          assert(atC === 0, 'the removed member C read the message after its removal');
        }, 40000);
        const dHist = await step('the newcomer D: "m1 before D" never arrived, and its sealed store holds no secret of the epoch m1 was written under', async () => {
          const seen = (await events(D, 'group')).filter((e) => e.data.text === 'm1 before D').length;
          await sleep(2500); // the store is saved 2 s after the last change
          const saved = await L(D, () => window.lab.readStore('mw-chat-state'));
          const grp = saved && (saved.groups || []).find((x) => x.groupId === g.groupId);
          assert(grp, 'D has no saved group state');
          const first = grp.epochs.find((e) => e.record.epochId === g.epochId);
          assert(seen === 0, 'D read a message from before it joined');
          assert(!first || !first.secret, 'D holds the secret of the epoch before it joined');
          return { epochs: grp.epochs.length, secrets: grp.epochs.filter((e) => e.secret).length };
        });
        return 'converged on ' + conv.epochId.slice(0, 12) + '... (members A, B, D; B saw ' + conv.conflicts + ' conflict event(s)); C read nothing after its removal; D: no earlier message, ' +
          dHist.secrets + ' secret(s) in ' + dHist.epochs + ' stored epoch(s), none of the first epoch';
      } finally {
        await closeAll(ctx, [A, B, C, D]);
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-7
  S['E-CH-7'] = {
    title: 'the phone class relays nothing: an Android-emulated context is classed by the loader\'s own detectEnvironment and chatDeviceClass; a line A - P - B delivers nothing, a desktop relay then delivers',
    async fn(ctx, step) {
      const s1 = ih();
      const s2 = ih();
      let A, P, B, R;
      try {
        P = await step('P: Chromium device emulation of an Android phone (user agent, 412 x 915, touch); the loader\'s functions class it', async () => {
          const p = await peer(ctx, 'CR7-P', { joins: [{ ihs: [s1, s2] }], deviceClass: 'auto' }, { contextOptions: ANDROID_CONTEXT });
          assert(p.deviceClass === 'android', 'the loader classed the emulated phone as ' + p.deviceClass + ' ' + JSON.stringify(p.env));
          return p;
        });
        const holder = await call(P, 'chat.holder.set', { on: true });
        assert(holder.err === 'E_POLICY', 'a phone turned the holder on: ' + JSON.stringify(holder));
        [A, B] = await step('the line A - P - B', async () => {
          const a = await peer(ctx, 'CR7-A', { joins: [{ ihs: [s1] }] });
          const b = await peer(ctx, 'CR7-B', { joins: [{ ihs: [s2] }] });
          await peers(P, 2);
          return [a, b];
        });
        await step('A and B add each other (chat keys from the ledger copy)', () => contacts(A, B, { ledger: true }));
        await step('A sends "via the phone": P reads the frame and relays nothing; B gets nothing in 10 s', async () => {
          await ok(A, 'chat.dm.send', { pub: B.pub, text: 'via the phone' });
          await sleep(10000);
        }, 20000);
        const ps = await stats(P);
        assert((ps.counts[FT.ENV] || 0) >= 1, 'P never received the frame');
        assert(ps.relayed === 0 && ps.relayedBytes === 0, 'P relayed ' + ps.relayed + ' frame(s), ' + ps.relayedBytes + ' bytes');
        assert(!(await msgAt(B, 'via the phone')), 'B got the message through the phone');
        R = await step('control: a desktop relay R joins both swarms; A sends "via the desktop" and B gets it', async () => {
          // Social fixer (E-CH-7 alone): B sends each WANT-TAGS to a neighbour other than the one it received the most from
          // (src/chat/lane.js sendWant), so with P and R both B's neighbours the route toward B came only when earlier scenarios
          // had left R behind P in bytes. The route counts only from after R joined, and B's count for R's wire is kept at 0
          // while we wait, so B's next WANT-TAGS (every 5 s in this lab) goes to R; A must also hold R as a neighbour before it
          // sends, or A's flood reaches P alone.
          const since = await clock(B);
          const r = await peer(ctx, 'CR7-R', { joins: [{ ihs: [s1, s2] }] });
          await peers(r, 3);
          const nudge = setInterval(() => {
            L(B, (pub) => { const ln = window.lab.svc.lane; for (const w of ln.wires.values()) if (w.remote === pub) w.bytesIn = 0; }, r.chatPub).catch(() => {});
          }, 250);
          try {
            await routed(r, B, since);
          } finally {
            clearInterval(nudge);
          }
          await waitUntil(() => L(A, (pub) => (window.lab.svc.lane.neighbourOf(pub) !== null ? true : null), r.chatPub), { timeoutMs: 30000, label: 'A holds R as a chat neighbour' });
          await ok(A, 'chat.dm.send', { pub: B.pub, text: 'via the desktop' });
          await waitUntil(() => msgAt(B, 'via the desktop'), { timeoutMs: 20000, label: 'the message at B' });
          return r;
        });
        const rs = await stats(R);
        return 'class "' + P.deviceClass + '" (isMobile ' + P.env.isMobile + ', coarse pointer ' + P.env.coarse + '); holder E_POLICY; P read ' + ps.counts[FT.ENV] + ' ENV frame(s) and relayed 0 bytes, B got nothing in 10 s; the desktop relay relayed ' +
          rs.relayed + ' frame(s) and B got the second message';
      } finally {
        await closeAll(ctx, [A, P, B, R]);
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-10
  S['E-CH-10'] = {
    title: 'a hostile neighbour floods the relay at its cap (16 KiB frames, valid 10-bit stamps): a contact DM across the same relay arrives within the 5 s bound (measured)',
    async fn(ctx, step) {
      const sx = ih();
      const sa = ih();
      const sb = ih();
      let X, A, R, B;
      try {
        [X, A, R, B] = await step('R joins three swarms: X - R, A - R, R - B (nobody else is a neighbour)', async () => {
          const r = await peer(ctx, 'CR10-R', { joins: [{ ihs: [sx, sa, sb] }] });
          const x = await peer(ctx, 'CR10-X', { joins: [{ ihs: [sx] }] });
          const a = await peer(ctx, 'CR10-A', { joins: [{ ihs: [sa] }] });
          const b = await peer(ctx, 'CR10-B', { joins: [{ ihs: [sb] }] });
          await peers(r, 3);
          await L(b, () => { window.lab.capture = true; });
          return [x, a, r, b];
        });
        await step('A and B add each other (chat keys from the ledger copy); B\'s next WANT-TAGS gives R its route toward B', async () => {
          const since = await clock(R);
          await contacts(A, B, { ledger: true });
          await routed(R, B, since);
        });
        await step('warm-up: one DM A -> B without the flood (the route and the session work)', async () => {
          await ok(A, 'chat.dm.send', { pub: B.pub, text: 'warm-up' });
          await waitUntil(() => msgAt(B, 'warm-up'), { timeoutMs: 20000, label: 'warm-up at B' });
        });
        const r0 = await stats(R);
        const flood = L(X, () => window.lab.junk({ ms: 16000, perSecond: 24 }));
        await sleep(3000); // the relay's queues fill
        const lat = [];
        await step('during the flood (24 frames of 16,115 bytes a second, about 6 times the 64 KiB/s relay budget): three DMs, 3 s apart', async () => {
          for (let i = 0; i < 3; i++) {
            const text = 'under flood ' + i;
            const t0 = Date.now();
            await ok(A, 'chat.dm.send', { pub: B.pub, text });
            const m = await waitUntil(() => msgAt(B, text), { timeoutMs: 20000, stepMs: 50, label: text + ' at B' });
            lat.push(m.at - t0);
            await sleep(3000);
          }
        }, 60000);
        const fl = await flood;
        const r1 = await stats(R);
        const bIn = await L(B, () => window.lab.raw.reduce((n, r) => n + r.len, 0));
        const max = Math.max(...lat);
        assert(max <= 5000, 'a contact DM took ' + max + ' ms under the flood (bound 5,000 ms): ' + lat.join(', '));
        return 'X sent ' + fl.sent + ' frames (' + Math.round(fl.bytes / 1024) + ' KiB in 16 s); R relayed ' + (r1.relayed - r0.relayed) + ' and dropped ' + (r1.dropped - r0.dropped) +
          ' at its queue caps; B took ' + Math.round(bIn / 1024) + ' KiB in all; DM latencies ' + lat.map((x) => (x / 1000).toFixed(2) + ' s').join(', ') + ' (bound 5 s, met)';
      } finally {
        await closeAll(ctx, [X, A, R, B]);
      }
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-12
  S['E-CH-12'] = {
    title: 'a relay that swaps BitTorrent peer ids: forwarding unchanged, the Noise handshake binds the real keys and the relay reads and injects nothing; swapping the XX ephemeral fails the handshake; answering itself, it is seen under its own key',
    async fn(ctx, step) {
      let A, B, M1, M2, M3;
      try {
        [A, B] = await step('A and B (each other\'s contacts through the ledger copy), in no common swarm', async () => {
          const a = await peer(ctx, 'CR12-A');
          const b = await peer(ctx, 'CR12-B');
          await contacts(a, b, { ledger: true });
          return [a, b];
        });
        const joinPair = async () => {
          const ia = ih();
          const ib = ih();
          const pa = await L(A, (x) => window.lab.join([x]), ia);
          const pb = await L(B, (x) => window.lab.join([x]), ib);
          return { ia, ib, pa, pb };
        };
        const leaveBoth = async () => {
          for (const p of [A, B]) await L(p, () => window.lab.leave());
          for (const p of [A, B]) await waitUntil(async () => ((await stats(p)).peers.length === 0 ? true : null), { timeoutMs: 30000, label: p.name + ' without neighbours' });
        };
        // (1) pass
        const j1 = await joinPair();
        M1 = await peer(ctx, 'CR12-M1', {}, { relay: { ihA: j1.ia, ihB: j1.ib, peerIdA: j1.pa, peerIdB: j1.pb, mode: 'pass' } });
        const pass = await step('(1) M forwards unchanged, under B\'s peer id toward A and A\'s toward B: A\'s neighbour is B\'s real chat key, B\'s is A\'s', async () => {
          const pa = await peers(A, 1);
          const pb = await peers(B, 1);
          const wa = await L(A, () => window.lab.wires.slice(-1)[0]);
          assert(wa.peerId === j1.pb, 'A\'s wire peer id is not the one M claimed');
          assert(pa[0].remote === B.chatPub && pb[0].remote === A.chatPub, 'the handshake ended with other keys');
          return { wirePeer: wa.peerId };
        });
        await step('a DM A -> B goes through M, which sees no plaintext and no key text in anything it forwarded', async () => {
          await ok(A, 'chat.dm.send', { pub: B.pub, text: 'through the swapping relay' });
          await waitUntil(() => msgAt(B, 'through the swapping relay'), { timeoutMs: 20000, label: 'the DM at B' });
          const log = await L(M1, () => window.lab.relayLog.map((r) => r.b64));
          for (const b of log) {
            const u = Buffer.from(b, 'base64url');
            assert(u.indexOf(Buffer.from('swapping relay')) < 0 && u.indexOf(Buffer.from('p256:')) < 0, 'M read text or a key in a forwarded message');
          }
        });
        const inj = await step('M injects 3 messages of its own toward A: each fails A\'s session AEAD and is struck', async () => {
          const before = await L(A, () => window.lab.strikes.filter((s) => s.reason === 'aead').length);
          await L(M1, () => window.lab.inject('A', 3));
          return waitUntil(async () => {
            const n = await L(A, () => window.lab.strikes.filter((s) => s.reason === 'aead').length);
            return n - before >= 3 ? n - before : null;
          }, { timeoutMs: 10000, label: 'AEAD strikes at A' });
        });
        await ctx.closeVisitor(M1.name);
        await leaveBoth();
        // (2) swap the ephemeral
        const j2 = await joinPair();
        M2 = await peer(ctx, 'CR12-M2', {}, { relay: { ihA: j2.ia, ihB: j2.ib, peerIdA: j2.pa, peerIdB: j2.pb, mode: 'swap-e' } });
        const swap = await step('(2) M swaps the ephemeral key of XX message 1: the initiator\'s check of message 2 fails, its wire closes, no session on either side', async () => {
          const s = await waitUntil(async () => {
            const sa = await L(A, () => window.lab.strikes.filter((x) => /^xx/.test(x.reason)).map((x) => x.reason));
            const sb = await L(B, () => window.lab.strikes.filter((x) => /^xx/.test(x.reason)).map((x) => x.reason));
            return sa.length + sb.length ? { a: sa, b: sb } : null;
          }, { timeoutMs: 20000, label: 'a failed handshake' });
          await sleep(2000);
          const n = (await stats(A)).peers.length + (await stats(B)).peers.length;
          assert(n === 0, n + ' session(s) were set up through the swapped key');
          return Object.assign(s, { swapped: await L(M2, () => window.lab.swapped) });
        });
        await ctx.closeVisitor(M2.name);
        await leaveBoth();
        // (3) M answers as itself under the swapped peer ids
        const j3 = await joinPair();
        M3 = await peer(ctx, 'CR12-M3', { joins: [{ ihs: [j3.ia], peerId: j3.pb }, { ihs: [j3.ib], peerId: j3.pa }] });
        const self = await step('(3) M runs its own chat lane under B\'s peer id: A\'s neighbour is M\'s chat key, never B\'s; a DM still reaches B, sealed, through M as a plain relay', async () => {
          const pa = await peers(A, 1);
          const wa = await L(A, () => window.lab.wires.slice(-1)[0]);
          assert(wa.peerId === j3.pb, 'A\'s wire does not carry B\'s peer id');
          assert(pa[0].remote === M3.chatPub && pa[0].remote !== B.chatPub, 'A took the relay for B');
          await ok(A, 'chat.dm.send', { pub: B.pub, text: 'past the impostor' });
          await waitUntil(() => msgAt(B, 'past the impostor'), { timeoutMs: 20000, label: 'the DM at B' });
          const atM = await msgAt(M3, 'past the impostor');
          assert(!atM, 'M read the DM');
          return true;
        });
        assert(self, 'step 3');
        return '(1) unchanged bytes under swapped peer ids (A\'s wire said ' + pass.wirePeer.slice(0, 12) + '..., B\'s id): sessions with the real keys, DM delivered, nothing readable at M, ' + inj +
          ' injected messages struck (aead); (2) ephemeral swapped ' + swap.swapped + ' time(s): handshake failed (' + swap.a.concat(swap.b).join(', ') + '), 0 sessions; (3) M answering itself is seen under its own chat key';
      } finally {
        await closeAll(ctx, [A, B, M1, M2, M3]);
      }
    },
  };

  return S;
}
