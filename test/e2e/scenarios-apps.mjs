// test/e2e/scenarios-apps.mjs: the apps on the door page (docs/INTERFACES.md "Apps on the door page" and docs/ARCHITECTURE.md 15.21)
// through the real built loader, the real identity origin and the Node tracker as the door's rendezvous,
// all on 127.0.0.1. Run with `node test/e2e/run.mjs --only APPS-1,APPS-2,APPS-3,APPS-4`.
//
//   APPS-1  home: the tiles of a signed-out visitor are locked (Messages, Rooms) or marked "not yet" (Calls, Files, Media), "Open a
//           link" works; nothing leaves the page (no socket, no peer connection) until a person acts; a visit sign-in unlocks
//           Messages and Rooms without opening a socket; a price card answered "Not now" sends nothing; sign-out locks the tiles
//           again and a reload makes the visitor a guest again; a second door whose door.json has no apps block keeps the paste box
//   APPS-2  pair: two SEPARATE browser processes. A opens a code, B knocks (typed in capitals with spaces), A sees the request.
//           Before the accept: no lane id was ever sent to either page, no announce, no peer connection, no manager, no SDP. The
//           rendezvous only ever saw the channel (4 characters) and sealed boxes. After the accept both connect directly ("Connected
//           to you now", the same compare digits); B sends formatted text with a link and an emoji (sent as sealed frames only), A
//           reads it (delivered, then read ticks), text is shown as text, A replies with a quote and reacts, B edits then deletes for
//           both, A pins, searches and exports (file name and JSON shape), a dropped wire shows "waiting to send" then delivered, a
//           disappearing message goes from both screens
//   APPS-3  reject and block: a code A replaced ("No one has this code right now"); A rejects B ("Rejected" at B, no lane, no peer
//           connection); B knocks again, A accepts and blocks B; a new knock from B is refused without A seeing anything
//   APPS-4  room: an owner and three people in four separate browsers; join requests pass the owner's decision; two are accepted
//           and one rejected; the roster of three is on all three members; messages fan out; the rejected person never learns the
//           lane (no frame, no announce, no peer connection) and receives nothing
//
// Network policy (docs/DEV-NETWORK.md): every URL is http://127.0.0.1 or ws://127.0.0.1; each party is a lib.mjs Visitor in a
// Chromium of its own (launchChromium: the local-only flags and loopback candidates), so the run's request guard applies and the
// run's ICE-server stripping runs first. Each scenario ends with leakCheck: no request or WebSocket left loopback, the ICE servers
// the page asked for were empty (the door names no STUN: the site's own STUN only, never a public default), no server-reflexive or
// relay candidate exists on any connection, and the data channels carried neither SDP text nor any message text in the clear.
//
// What a "peer connection counter" means here: an init script wraps RTCPeerConnection after the run's own wrapper (it sees the
// configuration the page asked for, before the run empties it) and counts constructions. The same script records what is sent on
// data channels and keeps the connections, so a scenario can drop the wires of one page (the network going away) without a reload.
// The tracker's announce recorder (stack.tracker.announces) and the pages' own (Visitor.announces) show who announced what and when.
//
// Real clicks only: every button of the apps acts on a trusted click, so the scenarios press with the mouse and type with the keyboard (a
// select changes on a trusted event only: it is set by typing the first letter of its choice). The identity popup is driven with
// driveIdp(popup, { unlock: 'visit' }): the identity client keeps 10 s between two sign-ins of one page (R 2.3.9), so a page signs in once
// per load. The door page is a second dev server over the run's build with the apps block (--apps-rendezvous: the stack's tracker,
// --apps-idp: the stack's identity origin, no --apps-stun). APPS-1 and APPS-3 use the block with no relay or direct key, the shipped
// default (relay rendezvous, direct off: conversations go through the rendezvous and no peer connection is made); APPS-2 and APPS-4
// check the direct wire (the lane announced only after the accept, peer connections, a dropped wire), so their door adds --apps-relay
// none, which keeps the direct wire of before the relay (AMENDMENTS A2 and A6). Chromium only: no APPS scenario runs in WebKit or Firefox.
//
// Two things the plan describes differently from the page: the shortest choice of the disappearing-message timer is 10 seconds (the
// service accepts one second, unit-tested; the page offers 10 seconds to a week), and a dropped wire is made by closing the page's
// peer connections (there is no button that leaves a lane), then the network's return is the browser's own 'online' event.

import { readFileSync } from 'node:fs';

import { Visitor, launchChromium, waitUntil, sleep, StepError, shellState, clickLoaderCard, isLocalUrl } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { appsText } from '../../src/loader/strings.js';

export const APPS_ORDER = ['APPS-1', 'APPS-2', 'APPS-3', 'APPS-4'];

const TX = (key, params) => appsText(key, 'en', params);
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const GROUP = '[' + ALPHA + ']{4}';
const CODE_RE = new RegExp('^' + GROUP + '-' + GROUP + '-' + GROUP + '$');
const SHORT_RE = new RegExp('^' + GROUP + '-' + GROUP + '$');
const LANE_RE = /^[0-9a-f]{40}$/;
// Emoji as code point escapes: this file stays ASCII.
const SMILE = '\u{1F600}';
const THUMB = '\u{1F44D}';
// A marker in every message text: long enough that it never turns up in base64 by chance, so "never in the clear" is a real test.
const MARK = 'mwe2e-q7kz';
const URL1 = 'https://example.org/felinar-e2e';

// ---------------------------------------------------------------------------------------------
// init script (runs in every frame before any page script, after the run's ICE-server stripping)
// ---------------------------------------------------------------------------------------------

/**
 * window.__mwApps: { made, ice, pcs, sent, sentBytes, dropAll() }. made counts RTCPeerConnection constructions; ice keeps the
 * iceServers each one was asked for (JSON); pcs keeps the connections; sent keeps what the page wrote on every data channel (as latin1
 * text, capped); dropAll() closes every connection (the network going away) and returns how many it closed.
 */
function appsWatch() {
  if (window.__mwApps) return;
  const W = { made: 0, ice: [], pcs: [], sent: [], sentBytes: 0 };
  window.__mwApps = W;
  const Inner = window.RTCPeerConnection;
  if (typeof Inner === 'function') {
    const Wrapped = function RTCPeerConnection(config, ...rest) {
      W.made++;
      try {
        W.ice.push(JSON.stringify((config && config.iceServers) || null));
      } catch (_) {
        W.ice.push('?');
      }
      const pc = new Inner(config, ...rest);
      W.pcs.push(pc);
      return pc;
    };
    Wrapped.prototype = Inner.prototype;
    Object.setPrototypeOf(Wrapped, Inner);
    window.RTCPeerConnection = Wrapped;
  }
  const DC = window.RTCDataChannel;
  if (DC && DC.prototype && typeof DC.prototype.send === 'function') {
    const send = DC.prototype.send;
    DC.prototype.send = function (data) {
      if (W.sentBytes < 8 * 1024 * 1024) {
        try {
          let u8 = null;
          if (typeof data === 'string') u8 = new TextEncoder().encode(data);
          else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (u8) {
            let s = '';
            for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
            W.sent.push(s);
            W.sentBytes += s.length;
          }
        } catch (_) { /* a frame the page is sending anyway */ }
      }
      return send.call(this, data);
    };
  }
  W.dropAll = () => {
    let n = 0;
    for (const pc of W.pcs) {
      try {
        if (pc.connectionState !== 'closed') {
          pc.close();
          n++;
        }
      } catch (_) { /* already gone */ }
    }
    return n;
  };
}

// Runs in the page: the messages of a list ('[data-role="messages"]' or '[data-role="room-messages"]') as plain data.
function readMessages(listSel) {
  return Array.from(document.querySelectorAll(listSel + ' li[data-msg]')).map((li) => {
    const q = (s) => li.querySelector(s);
    const body = q('[data-role="body"]');
    const quote = q('[data-role="quote"]');
    const from = q('[data-role="from"]');
    return {
      id: li.getAttribute('data-msg'),
      mine: li.getAttribute('data-mine') === '1',
      status: li.getAttribute('data-status') || '',
      deleted: li.classList.contains('mw-apps-deleted'),
      text: body ? body.textContent : '',
      edited: !!q('[data-role="edited"]'),
      pinned: !!q('[data-role="pinned"]'),
      expires: !!q('[data-role="expires"]'),
      scheduled: !!q('[data-role="scheduled"]'),
      cancelSend: !!q('[data-role="cancel-send"]'),
      quoteOf: quote ? quote.getAttribute('data-quote-of') : null,
      quoteText: quote ? quote.textContent : null,
      tick: (() => { const t = q('[data-role="ticks"]') || q('[data-role="state"]'); return t ? (t.getAttribute('aria-label') || t.textContent) : null; })(),
      from: from ? from.textContent : null,
      reactions: Array.from(li.querySelectorAll('[data-role="reaction"]')).map((b) => ({ emoji: b.getAttribute('data-emoji'), label: b.textContent, mine: b.getAttribute('aria-pressed') === 'true' })),
    };
  });
}

// Runs in the page: how a message body was built (elements only for marks and links, never for typed markup).
function bodyShape(li) {
  const n = li.querySelector('[data-role="body"]');
  const all = (s) => Array.from(n.querySelectorAll(s));
  return {
    text: n.textContent,
    strong: all('strong').map((x) => x.textContent),
    em: all('em').map((x) => x.textContent),
    s: all('s').map((x) => x.textContent),
    code: all('code').map((x) => x.textContent),
    links: all('a').map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target'), text: a.textContent })),
    foreign: n.querySelectorAll('img, script, iframe, object, embed, style, svg, form, input, b, i, u').length,
  };
}

// Runs in the page: what the page keeps in this browser: the names in localStorage and sessionStorage, the IndexedDB databases, the cookies and
// the Cache API names, and (text) every value and cached address as one string, to search for message texts.
async function storageOf() {
  const out = { local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort(), cookies: document.cookie, caches: [], idb: [], text: '' };
  for (const k of out.local) out.text += '\n' + k + '=' + localStorage.getItem(k);
  for (const k of out.session) out.text += '\n' + k + '=' + sessionStorage.getItem(k);
  const bytes = (v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? Array.from(new Uint8Array(v.buffer || v)).map((c) => String.fromCharCode(c)).join('') : v);
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  for (const d of dbs) {
    out.idb.push(d.name);
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await new Promise((res, rej) => { const r = db.transaction(name, 'readonly').objectStore(name).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        out.text += '\n' + d.name + '/' + name + ':' + JSON.stringify(rows, (_, v) => bytes(v));
      }
      db.close();
    } catch (_) { /* a database that cannot be read here */ }
  }
  out.caches = (await caches.keys()).sort();
  for (const c of out.caches) {
    const cache = await caches.open(c);
    for (const req of await cache.keys()) out.text += '\n' + req.url;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// parties: one Chromium process, one profile, one page
// ---------------------------------------------------------------------------------------------

/** Records, for one page, every WebSocket (url), every frame in both directions (a string, capped) and every request. */
function tapPage(page) {
  const tap = { sockets: [], frames: [], requests: [] };
  page.on('request', (r) => {
    if (tap.requests.length < 4000) tap.requests.push({ t: Date.now(), url: r.url() });
  });
  page.on('websocket', (ws) => {
    const url = ws.url();
    tap.sockets.push({ t: Date.now(), url });
    const keep = (dir) => (f) => {
      if (tap.frames.length >= 6000) return;
      const p = f && f.payload;
      tap.frames.push({ t: Date.now(), dir, url, payload: typeof p === 'string' ? p.slice(0, 24000) : '<binary ' + (p ? p.length : 0) + ' bytes>' });
    };
    ws.on('framesent', keep('out'));
    ws.on('framereceived', keep('in'));
  });
  return tap;
}

class Party {
  constructor(name, browser, visitor, page, tap, ownsBrowser = true) {
    this.name = name;
    this.browser = browser;
    this.v = visitor;
    this.page = page;
    this.tap = tap;
    this.ownsBrowser = ownsBrowser;
    this.short = null;
    this.firstShort = null;
    this.candidateTypes = new Set(); // every candidate type any connection of this page knew when sampled (leakCheck)
  }

  state() {
    return shellState(this.page);
  }

  async apps() {
    const s = await this.state();
    return s && s.apps ? s.apps : null;
  }

  loc(sel) {
    return this.page.locator(sel + ':visible').first();
  }

  /** A real mouse click on the first visible match of sel (force: also on an aria-disabled control, which Playwright would wait for). */
  async press(sel, timeoutMs = 15000, { force = false } = {}) {
    const l = this.loc(sel);
    try {
      await l.waitFor({ state: 'visible', timeout: timeoutMs });
      await l.click({ timeout: 5000, force });
    } catch (err) {
      throw new StepError(this.name + ': cannot press ' + sel + ': ' + String((err && err.message) || err).split('\n')[0]);
    }
  }

  async text(sel) {
    return (await this.loc(sel).innerText({ timeout: 5000 })).replace(/\s+/g, ' ').trim();
  }

  count(sel) {
    return this.page.locator(sel + ':visible').count();
  }

  /**
   * The text of the first visible match of sel, read in one step; '' when nothing matches. It never waits and cannot lose a race with a line
   * that goes away (a toast, the typing line): text() waits for its element and would time out on one that is already gone.
   */
  peek(sel) {
    return this.page.evaluate((q) => {
      const n = Array.from(document.querySelectorAll(q)).find((x) => x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden');
      return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
    }, sel);
  }

  made() {
    return this.page.evaluate(() => (window.__mwApps ? window.__mwApps.made : -1));
  }

  storage() {
    return this.page.evaluate(storageOf);
  }

  messages(listSel = '[data-role="messages"]') {
    return this.page.evaluate(readMessages, listSel);
  }

  /** The tiles of the apps home as data. */
  tiles() {
    return this.page.evaluate(() => Array.from(document.querySelectorAll('[data-app]')).map((n) => ({
      app: n.getAttribute('data-app'),
      state: n.getAttribute('data-state'),
      disabled: n.getAttribute('aria-disabled'),
      title: ((n.querySelector('.mw-apps-tile-title') || {}).textContent || '').trim(),
      note: ((n.querySelector('.mw-apps-tile-note') || {}).textContent || '').trim(),
      locked: !!(n.querySelector('.mw-apps-lock') && !n.querySelector('.mw-apps-lock').hidden),
    })));
  }

  /** The id the person sees for this page: a visit identity has no name, so the header is just "xxxx-xxxx". */
  async shortId() {
    const t = await this.text('[data-role="me"]');
    if (!SHORT_RE.test(t)) throw new StepError(this.name + ': the header is not a short id: ' + t);
    return t;
  }

  async close() {
    await this.v.close().catch(() => {});
    if (this.ownsBrowser) await this.browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

/** appsScenarios({ run, assert, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function appsScenarios({ run, assert, headed = false }) {
  const S = {};
  const bad = (what, v) => what + ': ' + JSON.stringify(v);

  // ---- the stack ------------------------------------------------------------------------------

  /**
   * The door page: a second dev server over the run's build whose /_mw/door.json names the apps block (tracker, identity origin, no STUN).
   * relay null: the block has no relay and no direct key, the shipped default (relay rendezvous, direct off: plan D2 and D3, AMENDMENTS A2).
   * relay 'none': the legacy block, which resolves to direct on (A2), for a scenario whose checks are about the direct wire and its ICE
   * (AMENDMENTS A6). One server per kind, shared by the scenarios that ask for it; the served door.json is read back and must carry exactly
   * the keys asked for.
   */
  async function doorStack(ctx, step, { relay = null } = {}) {
    const slot = relay === null ? 'appsDoor' : 'appsDoor-' + relay;
    if (ctx.shared[slot]) return ctx.shared[slot];
    const { stack } = ctx;
    const kind = relay === null ? 'no relay or direct key: the shipped default, relay rendezvous and direct off' : 'relay ' + relay + ': the direct wire as before the relay (AMENDMENTS A6)';
    const door = await step('the door: a dev server over the build whose door.json has the apps block (the stack\'s tracker, the stack\'s identity origin, no STUN; ' + kind + ')', async () => {
      const options = {
        root: stack.dist, port: 0, host: '127.0.0.1', dev: true, quiet: true,
        appsRendezvous: [stack.tracker.url], appsStun: [], appsIdp: stack.idp.url,
      };
      if (relay !== null) options.appsRelay = relay;
      const dev = await createDevServer(options);
      ctx.closers.push(() => dev.close());
      assert(dev.apps && dev.apps.rendezvous.length === 1 && dev.apps.stun.length === 0 && dev.apps.idp === stack.idp.url, bad('apps block', dev.apps));
      assert(stack.tracker.pairing === true, 'the stack tracker does not serve the pairing protocol (deploy/rtc-worker/pair.js)');
      const res = await fetch(dev.url + '_mw/door.json');
      const json = await res.json();
      assert(json.apps && json.apps.rendezvous[0] === stack.tracker.url && json.apps.idp === stack.idp.url, bad('served door.json apps', json.apps));
      assert(json.apps.relay === (relay === null ? undefined : relay) && json.apps.direct === undefined, bad('the relay and direct keys of the served door.json (asked: relay ' + relay + ', no direct)', { relay: json.apps.relay, direct: json.apps.direct }));
      return { dev, origin: new URL(dev.url).origin, page: dev.url + '_mw/open.html', rendezvous: stack.tracker.url, idp: stack.idp.url, relay };
    });
    ctx.shared[slot] = door;
    return door;
  }

  /** Closes the parties a failed scenario left open (kept so the run could print their logs). */
  async function closeLeftovers(ctx) {
    const left = ctx.shared.appsOpen || [];
    ctx.shared.appsOpen = [];
    for (const p of left) {
      if (ctx.visitors && typeof ctx.visitors.delete === 'function' && ctx.visitors.get(p.name) === p.v) ctx.visitors.delete(p.name);
      await p.close();
    }
  }

  /** A party in a Chromium of its own, or (browser given) in a new context of that browser; contextOptions: e.g. { locale: 'fr-CA' }. */
  async function newParty(ctx, name, { browser = null, contextOptions = {} } = {}) {
    if (!ctx.shared.appsOpen) {
      ctx.shared.appsOpen = [];
      ctx.closers.push(() => closeLeftovers(ctx));
    }
    const own = !browser;
    const b = browser || await launchChromium({ headless: !headed });
    const v = await Visitor.open(b, name, run, { initScripts: [appsWatch], contextOptions });
    if (ctx.visitors && typeof ctx.visitors.set === 'function') ctx.visitors.set(name, v); // a failing step prints its console and loader log
    const page = await v.newPage();
    const p = new Party(name, b, v, page, tapPage(page), own);
    ctx.shared.appsOpen.push(p);
    return p;
  }

  async function closeParties(ctx, parties) {
    for (const p of parties) {
      if (ctx.visitors && typeof ctx.visitors.delete === 'function' && ctx.visitors.get(p.name) === p.v) ctx.visitors.delete(p.name);
      ctx.shared.appsOpen = (ctx.shared.appsOpen || []).filter((x) => x !== p);
      await p.close();
    }
  }

  // ---- waiting and acting ---------------------------------------------------------------------

  /** Polls the apps state of a party until pred(state) is truthy; returns that state. A timeout says what the state was. */
  async function waitApps(P, pred, label, timeoutMs = 30000) {
    let last = null;
    try {
      return await waitUntil(async () => {
        last = await P.apps();
        return last && pred(last) ? last : null;
      }, { timeoutMs, stepMs: 150, label: P.name + ': ' + label });
    } catch (err) {
      if (err instanceof StepError) err.message += ' (the apps state then: ' + JSON.stringify(last).slice(0, 700) + ')';
      throw err;
    }
  }

  /** Polls the visible messages of a party until pred(messages) is truthy; returns the messages. A timeout says what they were. */
  async function waitMessages(P, pred, label, { timeoutMs = 30000, listSel } = {}) {
    let last = null;
    try {
      return await waitUntil(async () => {
        last = await P.messages(listSel);
        return pred(last) ? last : null;
      }, { timeoutMs, stepMs: 150, label: P.name + ': ' + label });
    } catch (err) {
      if (err instanceof StepError) err.message += ' (the messages then: ' + JSON.stringify((last || []).map((m) => [m.id.slice(0, 4), m.mine ? 'me' : 'peer', m.status, m.deleted ? 'deleted' : m.text.slice(0, 24)])).slice(0, 700) + ')';
      throw err;
    }
  }

  async function openDoor(P, door) {
    P.door = door; // the price card follows the door's relay and direct keys (continueCard)
    await P.page.goto(door.page, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // one reload into the limited-mode policy happens first; the apps home shows after it
    return waitApps(P, (a) => a.view === 'home', 'the apps home', 30000);
  }

  /** The header's Sign in, the loader's card, the identity origin's popup ("for this visit only"), then the apps are ready. */
  async function signIn(P) {
    const popups = [];
    const onPopup = (p) => popups.push(p);
    P.page.context().on('page', onPopup);
    try {
      await P.press('[data-role="signin"]');
      let answered = false;
      await waitUntil(async () => {
        const a = await P.apps();
        if (a && a.signedIn) return true;
        if (!popups.length) {
          await clickLoaderCard(P.page, 'Sign in');
          return false;
        }
        if (!answered) {
          answered = true;
          try {
            await driveIdp(popups[0], { unlock: 'visit' }, { timeoutMs: 40000 });
          } catch (err) {
            throw new StepError(P.name + ': identity origin: ' + ((err && err.message) || err));
          }
        }
        return false;
      }, { timeoutMs: 80000, stepMs: 300, label: P.name + ': signed in' });
    } finally {
      P.page.context().off('page', onPopup);
    }
    await waitApps(P, (a) => a.ready, 'the apps are ready', 15000);
    P.short = await P.shortId();
    return P.short;
  }

  /**
   * Answers the price card of the given kind ('start', 'knock', 'accept', 'room-create', 'room-join', 'room-accept') with Continue, after
   * checking its words; whileShown() runs while the card is on screen (nothing has left the page yet). Returns the card text.
   * The price is the one of the door the party opened (plan 3.8, DECISIONS DEC-3 and DEC-8): on the shipped default the relay text and then,
   * as its own paragraph, the sentence that the other person (the members) do not see your address (apps.price.hidden, apps.price.hiddenRoom;
   * every door here keeps direct links off); on a door with relay none the direct-only text of before the relay and no such paragraph. Never
   * the other door's text, and never the "also tries a direct link" line (no door here asks for it).
   */
  async function continueCard(P, kind, { check = false, whileShown = null } = {}) {
    await waitApps(P, (a) => a.card === kind, 'the ' + kind + ' card', 10000);
    const text = await P.text('[data-role="card"]');
    const accept = kind === 'accept' || kind === 'room-accept';
    const room = kind.indexOf('room') === 0;
    const legacy = !!(P.door && P.door.relay === 'none');
    const price = legacy ? (room ? 'apps.price.roomDirect' : 'apps.price.textDirect') : (room ? 'apps.price.room' : 'apps.price.text');
    const other = legacy ? (room ? 'apps.price.room' : 'apps.price.text') : (room ? 'apps.price.roomDirect' : 'apps.price.textDirect');
    const hidden = room ? 'apps.price.hiddenRoom' : 'apps.price.hidden';
    // a key the table does not have gives '', which every indexOf finds: so the sentence must exist before it is looked for
    assert(TX(hidden).length > 0, 'src/loader/strings.js has no English text for ' + hidden);
    assert(text.indexOf(TX(accept ? (room ? 'apps.accept.titleRoom' : 'apps.accept.title') : 'apps.price.title')) >= 0, P.name + ': the title of the ' + kind + ' card: ' + text);
    assert(text.indexOf(TX(price)) >= 0, P.name + ': the price (' + price + ') is not on the ' + kind + ' card: ' + text);
    assert(text.indexOf(TX(other)) < 0 && text.indexOf(TX('apps.price.direct')) < 0, P.name + ': the ' + kind + ' card carries ' + other + ' or apps.price.direct, which this door does not ask for: ' + text);
    // DEC-3 (DEC-8): with direct off the denial is its own paragraph after the price; the text of before the relay (relay none) has no such paragraph
    const paras = await P.page.evaluate(() => Array.from(document.querySelectorAll('[data-role="card"] p')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
    assert(paras.includes(TX(hidden)) === !legacy, P.name + ': the paragraph "' + TX(hidden) + '" ' + (legacy ? 'is on' : 'is missing from') + ' the ' + kind + ' card, or is not a paragraph of its own: ' + JSON.stringify(paras));
    if (!legacy) assert(paras.indexOf(TX(hidden)) === paras.indexOf(TX(price)) + 1, P.name + ': the denial does not follow the price on the ' + kind + ' card: ' + JSON.stringify(paras));
    assert((text.indexOf(TX('apps.price.check')) >= 0) === check, P.name + ': the "' + TX('apps.price.check') + '" line ' + (check ? 'is missing from' : 'is on') + ' the ' + kind + ' card: ' + text);
    if (whileShown) await whileShown();
    await P.press('[data-role="card-continue"]');
    await waitApps(P, (a) => a.card === null, 'the ' + kind + ' card closes', 10000);
    return text;
  }

  /** Answers a confirmation card (delete for both, block, leave) with its red button, after checking its title. */
  async function confirmCard(P, kind, titleKey) {
    await waitApps(P, (a) => a.card === kind, 'the ' + kind + ' card', 10000);
    const text = await P.text('[data-role="card"]');
    assert(text.indexOf(TX(titleKey)) >= 0, P.name + ': the title of the ' + kind + ' card: ' + text);
    await P.press('[data-role="card-continue"]');
    await waitApps(P, (a) => a.card === null, 'the ' + kind + ' card closes', 10000);
  }

  // ---- what the rendezvous and the lanes saw --------------------------------------------------

  /** Every JSON object a page sent ('out') or received ('in') on a WebSocket, with its time. */
  function framesJson(P, dir) {
    const out = [];
    for (const f of P.tap.frames) {
      if (f.dir !== dir || typeof f.payload !== 'string' || f.payload[0] !== '{') continue;
      try {
        out.push({ t: f.t, msg: JSON.parse(f.payload) });
      } catch (_) { /* not JSON */ }
    }
    return out;
  }

  /** The lane ids (40 hex characters) the rendezvous told this page about. */
  function lanesSeen(P) {
    const set = new Set();
    for (const { msg } of framesJson(P, 'in')) if (msg && typeof msg.lane === 'string' && LANE_RE.test(msg.lane)) set.add(msg.lane);
    return Array.from(set);
  }

  /** The text of every frame of the page's sockets, both directions (for "this string never travelled"). */
  function allFrameText(P, dir) {
    return P.tap.frames.filter((f) => !dir || f.dir === dir).map((f) => f.payload).join('\n');
  }

  /** The announces this page sent for an infohash, with their times. */
  const announcedLane = (P, lane) => P.v.announces.filter((a) => a.btih === lane);

  /** The peer ids (hex, as the tracker records them) this page announced with: the tracker's announce recorder can then be asked about this page alone. */
  function announcePeers(P) {
    const ids = new Set();
    for (const f of P.tap.frames) {
      if (f.dir !== 'out' || typeof f.payload !== 'string' || f.payload.indexOf('"action":"announce"') < 0) continue;
      const m = /"peer_id":("(?:[^"\\]|\\.)*")/.exec(f.payload.slice(0, 2000));
      if (!m) continue;
      let raw = '';
      try {
        raw = JSON.parse(m[1]);
      } catch (_) {
        continue;
      }
      let hex = '';
      for (let i = 0; i < raw.length; i++) hex += (raw.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
      ids.add(hex);
    }
    return ids;
  }

  /** The connections of a page: state and the kinds of candidates they know (local and remote). */
  function connectionInfo(P) {
    return P.page.evaluate(async () => {
      const out = [];
      for (const pc of window.__mwApps.pcs) {
        const e = { state: pc.connectionState, types: [], addresses: [] };
        try {
          const r = await pc.getStats();
          r.forEach((s) => {
            if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
              e.types.push(s.candidateType);
              e.addresses.push(s.address || s.ip || '');
            }
          });
        } catch (_) { /* closed */ }
        out.push(e);
      }
      return out;
    });
  }

  /**
   * assertNothingStored(P, before, needles): a door stores nothing (docs/APPS.md, "What is stored, and what is seen"): what the page keeps in the browser now has the same
   * names as `before` (localStorage, sessionStorage, IndexedDB databases, cookies, cache names) and no value, record or cached address
   * holds any of the needles (the message texts). Returns the number of characters searched (proof that something was read).
   */
  async function assertNothingStored(P, before, needles = []) {
    const now = await P.storage();
    const names = (x) => JSON.stringify([x.local, x.session, x.idb, x.cookies, x.caches]);
    assert(names(now) === names(before), P.name + ' keeps something new in the browser: ' + names(before) + ' became ' + names(now));
    for (const n of needles) assert(now.text.indexOf(n) < 0, P.name + ' keeps "' + n + '" in the browser');
    assert(now.text.length > 0, P.name + ': the storage scan read nothing (is it working?)');
    return now.text.length;
  }

  /** Notes the kinds of candidates every live connection of the page knows (a connection that is closed later cannot be asked again). */
  async function sampleCandidates(P) {
    for (const c of await connectionInfo(P)) for (const t of c.types) P.candidateTypes.add(t);
    return P.candidateTypes.size;
  }

  /**
   * leakCheck(parties, { run0, needles }): the end-of-scenario check that nothing left loopback and nothing was clear.
   *  - the run saw no request or WebSocket off 127.0.0.1 since the scenario began; neither did these pages (their own tap);
   *  - every RTCPeerConnection was asked for an empty iceServers list (the door names no STUN, and no public default exists), and
   *    the loader's own ICE list is empty;
   *  - no connection knows a server-reflexive or relay candidate (those exist only after contacting a STUN or TURN server);
   *  - what the pages wrote on data channels holds no SDP text and none of the needles (the message texts);
   *  - no page logged an uncaught error or a Content Security Policy refusal (every form of the apps is prevented from submitting).
   */
  async function leakCheck(parties, { run0, needles = [], door }) {
    assert(run.violations.length === run0, 'requests left 127.0.0.1: ' + JSON.stringify(run.violations.slice(run0)));
    const notes = [];
    const rendezvous = new URL(door.rendezvous).host;
    const origins = [door.origin, new URL(door.idp).origin];
    for (const P of parties) {
      for (const s of P.tap.sockets) assert(isLocalUrl(s.url) && new URL(s.url).host === rendezvous, P.name + ' opened a WebSocket to ' + s.url + ' (the rendezvous is ' + rendezvous + ')');
      for (const r of P.tap.requests) {
        assert(isLocalUrl(r.url), P.name + ' requested ' + r.url);
        if (/^https?:/.test(r.url)) assert(origins.indexOf(new URL(r.url).origin) >= 0, P.name + ' asked ' + r.url + ' (the door is ' + door.origin + ', the identity origin ' + origins[1] + ')');
      }
      const w = await P.page.evaluate(() => ({ made: window.__mwApps.made, ice: window.__mwApps.ice.slice(), sent: window.__mwApps.sent.join('\n'), sentBytes: window.__mwApps.sentBytes }));
      for (const ice of w.ice) assert(ice === '[]', P.name + ' asked for ICE servers ' + ice + ' (the door names none)');
      if (w.made > 0) assert(w.sentBytes > 0, P.name + ' made ' + w.made + ' connections and the data channel recorder saw no byte (the check below would prove nothing)');
      const st = await P.state();
      assert(!st.iceServers || st.iceServers.length === 0, P.name + ': the loader lists ICE servers ' + JSON.stringify(st.iceServers));
      const trouble = P.v.lines.filter((l) => /pageerror:|Content Security Policy|Refused to /i.test(l));
      assert(!trouble.length, P.name + ' logged ' + JSON.stringify(trouble.slice(0, 3)));
      const markers = ['v=0\r\n', 'a=fingerprint', 'candidate:', 'a=ice-ufrag'].concat(needles).filter((m) => w.sent.indexOf(m) >= 0);
      assert(!markers.length, P.name + ' wrote ' + JSON.stringify(markers) + ' on a data channel in the clear');
      if (w.made > 0) await sampleCandidates(P);
      for (const t of P.candidateTypes) assert(t !== 'srflx' && t !== 'relay', P.name + ' has a ' + t + ' candidate: a STUN or TURN server was contacted');
      if (w.made > 0) assert(P.candidateTypes.size > 0, P.name + ' made ' + w.made + ' connections and no connection ever knew a candidate (the check saw nothing)');
      notes.push(P.name + ' ' + P.tap.sockets.length + ' sockets, ' + w.made + ' connections, candidate types ' + (Array.from(P.candidateTypes).sort().join('+') || 'none'));
    }
    return notes.join('; ');
  }

  // ------------------------------------------------------------------------------------------- APPS-1
  S['APPS-1'] = {
    title: 'home: Messages and Rooms locked, Calls, Files and Media "not yet", "Open a link" works; nothing leaves the page until a person acts; a visit sign-in unlocks the apps; sign-out and a reload lock them again',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const door = await doorStack(ctx, step);
      const run0 = run.violations.length;
      const P = await step('a browser of its own opens the door page', () => newParty(ctx, 'APPS1'));
      await step('the apps home of a signed-out visitor: the title, the subtitle and every tile as a person sees it', async () => {
        const a = await openDoor(P, door);
        assert(a.signedIn === false && a.ready === false && a.code === null && a.card === null && a.tm === false && a.link === 'closed', bad('home state', a));
        assert(a.conversations.length === 0 && a.rooms.length === 0 && a.requests === 0, bad('home lists', a));
        assert((await P.text('[data-role="title"]')) === TX('apps.title'), 'title ' + (await P.text('[data-role="title"]')));
        assert((await P.text('.mw-apps-sub')) === TX('apps.subtitle.guest'), 'subtitle ' + (await P.text('.mw-apps-sub')));
        assert((await P.page.title()) === TX('apps.docTitle'), 'document title ' + (await P.page.title()));
        const tiles = await P.tiles();
        const by = Object.fromEntries(tiles.map((t) => [t.app, t]));
        assert(tiles.map((t) => t.app).join() === 'messages,rooms,calls,files,media,link', 'tiles ' + tiles.map((t) => t.app).join());
        for (const k of ['messages', 'rooms']) {
          assert(by[k].state === 'locked' && by[k].disabled === 'true' && by[k].locked === true && by[k].note === TX('apps.tile.signInFirst'), bad(k, by[k]));
        }
        for (const k of ['calls', 'files', 'media']) {
          assert(by[k].state === 'soon' && by[k].disabled === 'true' && by[k].locked === false && by[k].note === TX('apps.tile.notYet'), bad(k, by[k]));
        }
        assert(by.link.state === 'active' && by.link.disabled === 'false' && by.link.note === '', bad('link', by.link));
        for (const k of ['messages', 'rooms', 'calls', 'files', 'media', 'link']) assert(by[k].title === TX('apps.tile.' + k), bad(k, by[k]));
        assert((await P.count('[data-role="signin"]')) === 1 && (await P.count('[data-role="signout"]')) === 0, 'sign in / sign out buttons');
      });
      let kept = null;
      await step('nothing leaves the page: no WebSocket, no peer connection, no request beyond the door\'s own origin (the identity origin included)', async () => {
        kept = await P.storage();
        assert(P.tap.sockets.length === 0, bad('sockets', P.tap.sockets));
        assert((await P.made()) === 0, 'a peer connection exists');
        const idp = new URL(ctx.stack.idp.url).origin;
        const asked = P.tap.requests.filter((r) => new URL(r.url).origin !== door.origin);
        assert(asked.length === 0, 'the page asked other origins before any click: ' + JSON.stringify(asked.map((r) => r.url)) + ' (identity origin ' + idp + ')');
      });
      await step('the same home in a French browser (locale fr-CA): the page takes the browser\'s language for the title, the subtitle, the tiles and their notes', async () => {
        const F = await newParty(ctx, 'APPS1FR', { browser: P.browser, contextOptions: { locale: 'fr-CA' } });
        const a = await openDoor(F, door);
        assert(a.signedIn === false && a.view === 'home', bad('French home state', a));
        const fr = (key) => appsText(key, 'fr');
        for (const key of ['apps.title', 'apps.signIn', 'apps.subtitle.guest', 'apps.tile.rooms', 'apps.tile.messages.text', 'apps.tile.signInFirst', 'apps.tile.notYet']) assert(fr(key) !== TX(key), key + ' is not translated');
        assert((await F.text('[data-role="title"]')) === fr('apps.title'), 'title ' + (await F.text('[data-role="title"]')));
        assert((await F.text('.mw-apps-sub')) === fr('apps.subtitle.guest'), 'subtitle ' + (await F.text('.mw-apps-sub')));
        assert((await F.text('[data-role="signin"]')) === fr('apps.signIn'), 'sign in ' + (await F.text('[data-role="signin"]')));
        assert((await F.page.title()) === fr('apps.docTitle'), 'document title ' + (await F.page.title()));
        const by = Object.fromEntries((await F.tiles()).map((t) => [t.app, t]));
        for (const k of ['messages', 'rooms', 'calls', 'files', 'media', 'link']) assert(by[k].title === fr('apps.tile.' + k), bad(k, by[k]));
        assert(by.messages.note === fr('apps.tile.signInFirst') && by.rooms.note === fr('apps.tile.signInFirst') && by.calls.note === fr('apps.tile.notYet'), bad('notes', by));
        assert(F.tap.sockets.length === 0 && (await F.made()) === 0, 'the French page opened a socket or a connection');
        await closeParties(ctx, [F]);
      });
      await step('a locked tile opens nothing: pressing Messages while signed out only moves focus to Sign in (no view, no card, no socket)', async () => {
        await P.press('[data-app="messages"]', 15000, { force: true });
        await sleep(500);
        const a = await P.apps();
        assert(a.view === 'home' && a.card === null && a.signedIn === false, bad('after the press', a));
        assert(P.tap.sockets.length === 0, 'a socket opened');
        const focus = await P.page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-role')) || null);
        assert(focus === 'signin', 'focus is on ' + focus);
      });
      await step('"Open a link" is active: its paste box shows above the apps and Cancel closes it', async () => {
        await P.press('[data-app="link"]');
        const input = P.page.locator('input[type="url"]').first();
        await input.waitFor({ state: 'visible', timeout: 10000 });
        const box = await input.boundingBox();
        const top = await P.page.evaluate(({ x, y }) => {
          const n = document.elementFromPoint(x, y);
          return !!n && (n.tagName === 'INPUT' || !!n.closest('input'));
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        assert(top, 'the paste box is covered by the apps');
        await P.press('button:text-is("Cancel")');
        await waitUntil(async () => !(await input.isVisible().catch(() => false)), { timeoutMs: 5000, label: 'the paste box closes' });
        assert(P.tap.sockets.length === 0 && (await P.made()) === 0, 'the paste box started a connection');
      });
      await step('sign in "for this visit only" at the identity origin: Messages and Rooms unlock, the rest stays "not yet"; no socket opens', async () => {
        await signIn(P);
        const a = await P.apps();
        assert(a.signedIn && a.ready && a.view === 'home' && a.link === 'closed' && a.tm === false && a.code === null, bad('signed in', a));
        const by = Object.fromEntries((await P.tiles()).map((t) => [t.app, t]));
        for (const k of ['messages', 'rooms']) assert(by[k].state === 'active' && by[k].disabled === 'false' && by[k].locked === false && by[k].note === '', bad(k, by[k]));
        for (const k of ['calls', 'files', 'media']) assert(by[k].state === 'soon', bad(k, by[k]));
        assert((await P.text('.mw-apps-sub')) === TX('apps.subtitle.in'), 'subtitle ' + (await P.text('.mw-apps-sub')));
        const me = await P.text('[data-role="me"]');
        assert(me === P.short, 'header ' + me);
        assert((await P.count('[data-role="signout"]')) === 1 && (await P.count('[data-role="signin"]')) === 0, 'sign in / sign out buttons');
        assert((await P.text('.mw-apps-visit')) === TX('apps.visitNote'), 'visit note ' + (await P.text('.mw-apps-visit')));
        assert(P.tap.sockets.length === 0 && (await P.made()) === 0, 'signing in opened a socket or a connection');
        await assertNothingStored(P, kept, [P.short.replace('-', ''), 'p256:']); // a visit identity is kept in memory only
      });
      await step('Messages shows the price first; "Not now" leaves the view without any socket; the back button returns to the home', async () => {
        await P.press('[data-app="messages"]');
        const a = await waitApps(P, (x) => x.view === 'messages' && x.card === 'start', 'the price card');
        assert(a.code === null && a.link === 'closed', bad('price card state', a));
        const text = await P.text('[data-role="card"]');
        assert(text.indexOf(TX('apps.price.title')) >= 0 && text.indexOf(TX('apps.price.text')) >= 0 && text.indexOf(TX('apps.price.check')) < 0, 'card ' + text);
        await P.press('[data-role="card-cancel"]');
        await waitApps(P, (x) => x.card === null, 'the card closes', 5000);
        await sleep(400);
        assert(P.tap.sockets.length === 0 && (await P.made()) === 0 && (await P.apps()).code === null, 'Not now still opened a code or a socket');
        assert((await P.count('[data-role="code-show"]')) === 1, 'the "Show my code" button');
        await P.press('[data-role="back"]');
        await waitApps(P, (x) => x.view === 'home', 'back at the home', 5000);
      });
      await step('Rooms: the create and join forms show, and a code that is too short is refused before any socket', async () => {
        await P.press('[data-app="rooms"]');
        await waitApps(P, (x) => x.view === 'rooms', 'the rooms view', 5000);
        await P.loc('[data-role="join-input"]').fill('abc');
        await P.press('[data-role="join-button"]');
        await waitUntil(async () => (await P.text('[data-role="join-note"]')) === TX('apps.err.invalid'), { timeoutMs: 5000, label: 'the "twelve characters" note' });
        assert((await P.apps()).card === null && P.tap.sockets.length === 0, 'a short code opened a card or a socket');
        await P.press('[data-role="back"]');
      });
      await step('reload while signed in: nothing was stored, the visitor is a guest again with locked tiles', async () => {
        const first = P.short;
        await P.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        const a = await waitApps(P, (x) => x.view === 'home' && !x.signedIn, 'the home as a guest', 30000);
        assert(a.ready === false && a.code === null, bad('after the reload', a));
        const by = Object.fromEntries((await P.tiles()).map((t) => [t.app, t]));
        assert(by.messages.state === 'locked' && by.rooms.state === 'locked', bad('tiles after the reload', by));
        P.firstShort = first;
      });
      await step('sign in again (a new visit identity: the short id differs), then sign out: the tiles lock and the state is gone', async () => {
        await signIn(P); // the identity client's 10 s cooldown between sign-ins (R 2.3.9) starts afresh with the reload
        assert(P.short !== P.firstShort, 'the same short id after a reload: ' + P.short);
        await P.press('[data-role="signout"]');
        const a = await waitApps(P, (x) => !x.signedIn && x.view === 'home', 'signed out', 15000);
        assert(a.ready === false && a.code === null && a.conversations.length === 0, bad('after sign-out', a));
        const by = Object.fromEntries((await P.tiles()).map((t) => [t.app, t]));
        assert(by.messages.state === 'locked' && by.rooms.state === 'locked', bad('tiles', by));
        assert((await P.count('[data-role="signin"]')) === 1, 'the Sign in button is back');
      });
      await step('a door whose door.json has no apps block keeps the paste box: no apps home, nothing mounted, no socket (the way every door was before the apps)', async () => {
        const plain = await createDevServer({ root: ctx.stack.dist, port: 0, host: '127.0.0.1', dev: true, quiet: true });
        ctx.closers.push(() => plain.close());
        assert(!plain.apps, bad('apps block of the plain door', plain.apps));
        const json = await (await fetch(plain.url + '_mw/door.json')).json();
        assert(json.apps === undefined, bad('the plain door.json', Object.keys(json)));
        const F = await newParty(ctx, 'APPS1PLAIN', { browser: P.browser });
        await F.page.goto(plain.url + '_mw/open.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
        const input = F.page.locator('input[type="url"]').first();
        await input.waitFor({ state: 'visible', timeout: 30000 });
        assert((await F.count('[data-role="title"]')) === 0 && (await F.count('[data-app]')) === 0, 'the apps home shows on a door without a block');
        const shell = await F.state();
        assert(shell && !shell.apps, bad('inspect().apps on the plain door', shell && shell.apps));
        assert(F.tap.sockets.length === 0 && (await F.made()) === 0, 'the plain door page opened a socket or a connection');
        await closeParties(ctx, [F]);
      });
      const leaks = await step('nothing left loopback; no connection was ever made', async () => {
        assert(P.tap.sockets.length === 0 && (await P.made()) === 0, 'sockets ' + P.tap.sockets.length + ', connections ' + (await P.made()));
        return leakCheck([P], { run0, door });
      });
      await closeParties(ctx, [P]);
      return 'locked, soon and active tiles; sign-in unlocks, sign-out and a reload lock; no socket or connection (' + leaks + '); a door without a block keeps the paste box';
    },
  };

  // ------------------------------------------------------------------------------------------- APPS-2
  S['APPS-2'] = {
    title: 'pair: two browser processes; a code, a knock, an approval; nothing moves before it; sealed messages, ticks, quote, reaction, edit, delete for both, pin, search, export, a dropped wire, a disappearing message, sign-out',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      // AMENDMENTS A6: this scenario checks the direct wire (the lane announced only after the accept, the peer connections, the wire dropped
      // by closing B's connections, the actions A and B said), so its door says relay none (direct on, A2); the relay is proved by the LANE
      // scenarios (test/e2e/scenarios-lane.mjs) and by APPS-3, which runs on the shipped default.
      const door = await doorStack(ctx, step, { relay: 'none' });
      const { tracker } = ctx.stack;
      const run0 = run.violations.length;
      const text1 = 'hello *bold* _it_ ~gone~ `mono` ' + MARK + ' ' + URL1 + ' ';
      const plain1 = 'hello bold it gone mono ' + MARK + ' ' + URL1 + ' ' + SMILE;
      const text2 = '<img src=x onerror="window.__xss=1"> <b>not bold</b> &amp; ' + MARK + '-two';
      const text3 = 'draft one ' + MARK + '-three';
      const text3b = 'final two ' + MARK + '-three';
      const text4a = 'first draft ' + MARK + '-four';
      const text4b = 'second draft ' + MARK + '-four';
      const text4c = 'third draft ' + MARK + '-four';
      const reply = 'reply from A ' + MARK + '-reply';
      const away = 'sent while away ' + MARK + '-away';
      const later = 'scheduled for later ' + MARK + '-later';
      const quiet = 'read in silence ' + MARK + '-quiet';
      const soon = 'gone soon ' + MARK + '-soon';
      const needles = [MARK, 'felinar-e2e', 'draft one', 'final two', 'first draft', 'second draft', 'third draft', 'sent while away', 'gone soon', 'reply from A', 'not bold', 'scheduled for later', 'read in silence'];
      const listRow = (id) => '[data-role="messages"] li[data-msg="' + id + '"]';

      const [A, B] = await step('two browsers, A and B (separate processes, fresh profiles), open the door and sign in for this visit', async () => {
        const a = await newParty(ctx, 'APPS2A');
        const b = await newParty(ctx, 'APPS2B');
        for (const P of [a, b]) {
          await openDoor(P, door);
          await signIn(P);
        }
        assert(a.short !== b.short, 'the same short id ' + a.short);
        return [a, b];
      });
      // What the rendezvous holds once the browsers are signed in (a failed scenario before this one may still be closing sockets) and what each
      // page keeps in its browser: both must be the same, but for what the scenario does on purpose, at the end.
      const base = tracker.stats();
      const kept = new Map();
      for (const P of [A, B]) kept.set(P, await P.storage());

      const code = await step('A: Messages shows the price first; Continue opens a code of twelve characters at the rendezvous (the channel and a sealed box)', async () => {
        assert(A.tap.sockets.length === 0 && (await A.made()) === 0, 'A had a socket before the first click');
        await A.press('[data-app="messages"]');
        await continueCard(A, 'start', {
          whileShown: async () => {
            assert(A.tap.sockets.length === 0, 'a socket opened while the price card was up');
            assert(tracker.stats().codes === base.codes, 'a code was opened while the price card was up');
          },
        });
        const a = await waitApps(A, (x) => x.code && x.link === 'open', 'a code and an open link', 20000);
        // the shell shows the channel only (the secret half of a code is not in what tests and support read); the whole code is on the screen
        const shown = await A.text('[data-role="code"]');
        assert(CODE_RE.test(shown), 'the code ' + shown);
        assert(a.code === shown.slice(0, 4) && a.code.length === 4, 'the shell\'s code is the channel only: ' + a.code);
        assert(A.tap.sockets.length === 1 && new URL(A.tap.sockets[0].url).host === new URL(tracker.url).host, bad('A sockets', A.tap.sockets));
        assert(tracker.stats().codes === base.codes + 1, bad('rendezvous', tracker.stats()));
        const open = framesJson(A, 'out').map((f) => f.msg).filter((m) => m.action === 'pair-open');
        assert(open.length === 1 && open[0].channel === a.code && open[0].box && typeof open[0].box === 'object', bad('pair-open', open));
        return shown;
      });
      const secret = code.replace(/-/g, '').slice(4);

      await step('B: "Not now" on the price card sends nothing; the code typed in capitals with spaces, then the price card for the knock, sends the knock', async () => {
        await B.press('[data-app="messages"]');
        await waitApps(B, (x) => x.view === 'messages' && x.card === 'start', 'the price card', 10000);
        await B.press('[data-role="card-cancel"]');
        await waitApps(B, (x) => x.card === null, 'the card closes', 5000);
        assert(B.tap.sockets.length === 0, 'B opened a socket on "Not now"');
        await B.loc('[data-role="knock-input"]').fill(code.toUpperCase().replace(/-/g, ' '));
        await B.press('[data-role="knock-button"]');
        await continueCard(B, 'knock', { whileShown: async () => assert(B.tap.sockets.length === 0, 'a socket opened while the knock price card was up') });
        await waitApps(B, (x) => x.conversations.length === 1 && x.conversations[0].status === 'waiting', 'a waiting conversation', 20000);
        await waitUntil(async () => (await B.text('[data-role="knock-note"]')) === TX('apps.knock.sent'), { timeoutMs: 5000, label: 'the "request sent" note' });
        const row = await B.text('[data-role="conv-list"] li');
        assert(row.indexOf(TX('apps.status.waiting')) >= 0, 'B row ' + row);
        const knock = framesJson(B, 'out').map((f) => f.msg).filter((m) => m.action === 'pair-knock');
        assert(knock.length === 1 && knock[0].channel === code.slice(0, 4) && knock[0].box && typeof knock[0].box === 'object', bad('pair-knock', knock));
        assert(framesJson(B, 'out').every((f) => f.msg.action !== 'pair-open'), 'B opened a code');
      });

      await step('A sees the request with B\'s short id; before the accept: no lane id sent to anyone, no announce, no SDP, no peer connection, no manager; the secret half of the code never left a page', async () => {
        await waitApps(A, (x) => x.requests === 1, 'the request', 30000);
        const row = await A.text('[data-role="requests"] li.mw-apps-request');
        assert(row.indexOf(TX('apps.request.wants', { name: TX('apps.someone'), short: B.short })) >= 0, 'request row ' + row);
        assert((await A.page.title()) === '(1) ' + TX('apps.docTitle'), 'tab title ' + (await A.page.title()));
        const s = tracker.stats();
        assert(s.codes === base.codes + 1 && s.knocks === base.knocks + 1 && s.lanes === base.lanes, bad('rendezvous before the accept', { base, now: s }));
        for (const P of [A, B]) {
          const st = await P.state();
          assert((await P.made()) === 0, P.name + ' made a peer connection');
          assert(st.peers === 0 && st.apps.tm === false, P.name + ' peers ' + st.peers + ', manager ' + st.apps.tm);
          assert(P.v.announces.length === 0, bad(P.name + ' announces', P.v.announces));
          assert(lanesSeen(P).length === 0, P.name + ' was told a lane: ' + lanesSeen(P));
          const text = allFrameText(P);
          for (const mark of ['"announce"', 'info_hash', 'v=0', 'a=fingerprint', 'candidate:', 'a=ice-ufrag', 'p256:']) assert(text.indexOf(mark) < 0, P.name + ' sent or got ' + mark + ' at the rendezvous');
          assert(text.toLowerCase().indexOf(secret) < 0 && text.toLowerCase().indexOf(code.slice(5)) < 0, P.name + ': the secret half of the code is in a frame');
        }
      });

      let tAccept = 0; // the moment of the click on Accept: no announce of the lane may be older
      const lane = await step('A accepts: the price card repeats and adds "Check: read your codes to each other."; Continue; both connect directly and only now announce the lane', async () => {
        tAccept = Date.now();
        await A.press('[data-role="requests"] [data-role="accept"]');
        await continueCard(A, 'accept', { check: true });
        await Promise.all([A, B].map((P) => waitApps(P, (x) => x.conversations.length === 1 && x.conversations[0].status === 'connected', 'connected', 45000)));
        const la = lanesSeen(A);
        assert(la.length === 1 && lanesSeen(B).length === 1 && la[0] === lanesSeen(B)[0], bad('lanes', [la, lanesSeen(B)]));
        const s = tracker.stats();
        assert(s.lanes === base.lanes + 1 && s.knocks === base.knocks && s.codes === base.codes + 1, bad('rendezvous after the accept', { base, now: s }));
        for (const P of [A, B]) {
          const mine = announcedLane(P, la[0]);
          assert(mine.length > 0 && mine.every((x) => x.t >= tAccept), bad(P.name + ' lane announces', mine.map((x) => x.t - tAccept)));
          assert(P.v.announces.every((x) => x.btih === la[0]), P.name + ' announced another swarm: ' + JSON.stringify(P.v.announces.map((x) => x.btih)));
          assert((await P.made()) > 0, P.name + ': the counter saw no peer connection after the accept (is the page hook in place?)');
        }
        // the tracker's own recorder, asked about these two pages alone (their peer ids): nothing from them before the accept, and only the lane after it
        const peers = new Set([...announcePeers(A), ...announcePeers(B)]);
        assert(peers.size === 2, 'peer ids of the two pages: ' + JSON.stringify(Array.from(peers)));
        const server = tracker.announces.filter((x) => peers.has(x.peer));
        assert(server.length > 0 && server.every((x) => x.btih === la[0] && x.t >= tAccept), 'tracker announces from A and B ' + JSON.stringify(server.map((x) => [x.t - tAccept, x.event, String(x.btih).slice(0, 8)])));
        for (const P of [A, B]) await sampleCandidates(P);
        return la[0];
      }, 60000);
      const connectMs = Date.now() - tAccept;

      await step('both open the conversation: "Connected to you now", the other person\'s short id as its title and the same eight compare digits', async () => {
        for (const P of [A, B]) {
          await P.press('[data-role="conv-list"] [data-conv]');
          await waitApps(P, (x) => x.view === 'conversation', 'the conversation view', 5000);
        }
        for (const [P, other] of [[A, B], [B, A]]) {
          assert((await P.text('[data-role="status-line"]')) === TX('apps.status.connected'), P.name + ' status ' + (await P.text('[data-role="status-line"]')));
          assert((await P.text('[data-role="title"]')) === other.short, P.name + ' title ' + (await P.text('[data-role="title"]')));
        }
        const digits = [];
        for (const P of [A, B]) {
          digits.push(await waitUntil(async () => {
            const t = await P.peek('[data-role="verify"]');
            const m = /Compare: (\d{4} \d{4})/.exec(t);
            return m ? m[1] : null;
          }, { timeoutMs: 15000, label: P.name + ': the compare digits' }));
        }
        assert(digits[0] === digits[1], 'compare digits differ: ' + digits.join(' / '));
      });

      const m1 = await step('A goes back to the list; B sends text with marks, a link and an emoji (Enter sends): A has an unread count; B sees it Delivered, not yet Read', async () => {
        await A.press('[data-role="back"]');
        await waitApps(A, (x) => x.view === 'messages', 'A on the list', 5000);
        await B.loc('[data-role="composer"]').fill(text1);
        await B.press('[data-role="emoji-toggle"]');
        await B.press('[data-role="emoji"][data-emoji="' + SMILE + '"]');
        await B.page.keyboard.press('Enter');
        const sent = await waitMessages(B, (m) => m.some((x) => x.mine && x.text === plain1 && x.status === 'delivered'), 'delivered ticks at B', { timeoutMs: 30000 });
        const mine = sent.find((x) => x.mine && x.text === plain1);
        assert(mine.tick === TX('apps.msg.delivered'), 'ticks ' + mine.tick);
        const a = await waitApps(A, (x) => x.conversations[0].unread === 1, 'one unread message', 15000);
        assert(a.conversations[0].messages === 1, bad('A conversation', a.conversations[0]));
        assert((await A.text('[data-role="conv-list"] [data-role="unread"]')) === '1', 'unread badge');
        assert((await A.page.title()) === '(1) ' + TX('apps.docTitle'), 'tab title ' + (await A.page.title()));
        return mine.id;
      });

      await step('A opens the conversation: the text is drawn as bold, italic, strike, mono, a safe link and the emoji, never as markup; B\'s ticks turn to Read', async () => {
        await A.press('[data-role="conv-list"] [data-conv]');
        await waitMessages(A, (m) => m.some((x) => x.id === m1 && !x.mine), 'the message at A');
        const shape = await A.page.locator(listRow(m1)).evaluate(bodyShape);
        assert(shape.text === plain1, bad('text', shape.text));
        assert(shape.strong.join() === 'bold' && shape.em.join() === 'it' && shape.s.join() === 'gone' && shape.code.join() === 'mono', bad('marks', shape));
        assert(shape.links.length === 1 && shape.links[0].href === URL1 && shape.links[0].rel === 'noopener noreferrer' && shape.links[0].target === '_blank' && shape.links[0].text === URL1, bad('links', shape.links));
        assert(shape.foreign === 0, bad('foreign elements', shape));
        const read = await waitMessages(B, (m) => m.some((x) => x.id === m1 && x.status === 'read'), 'read ticks at B', { timeoutMs: 20000 });
        assert(read.find((x) => x.id === m1).tick === TX('apps.msg.read'), 'ticks ' + read.find((x) => x.id === m1).tick);
        const a = await waitApps(A, (x) => x.conversations[0].unread === 0, 'nothing unread', 10000);
        assert((await A.page.title()) === TX('apps.docTitle'), 'tab title ' + (await A.page.title()) + ' ' + JSON.stringify(a.conversations));
      });

      const m2 = await step('markup typed in a message stays text (an img tag, a b tag, an entity): no element is made from it and no script runs, on either side', async () => {
        await B.loc('[data-role="composer"]').fill(text2);
        await B.page.keyboard.press('Enter');
        const list = await waitMessages(A, (m) => m.some((x) => !x.mine && x.text === text2), 'the text at A');
        const id = list.find((x) => !x.mine && x.text === text2).id;
        for (const P of [A, B]) {
          await waitMessages(P, (m) => m.some((x) => x.id === id), 'the message at ' + P.name);
          const shape = await P.page.locator(listRow(id)).evaluate(bodyShape);
          assert(shape.text === text2 && shape.foreign === 0 && shape.links.length === 0, P.name + ' ' + JSON.stringify(shape));
          const probe = await P.page.evaluate(() => ({ xss: window.__xss === undefined, imgs: document.querySelectorAll('[data-role="messages"] img').length }));
          assert(probe.xss && probe.imgs === 0, P.name + ' ' + JSON.stringify(probe));
        }
        return id;
      });

      await step('B sees A typing; A replies with a quote of B\'s message and reacts with a thumbs up: B sees the quote and the reaction', async () => {
        await A.press(listRow(m1) + ' [data-role="msg-menu"]');
        await A.press('[data-role="menu"] [data-role="msg-reply"]');
        await waitUntil(async () => (await A.text('[data-role="replying"]')).indexOf(TX('apps.msg.replyingTo', { name: B.short })) >= 0, { timeoutMs: 5000, label: 'the "replying to" line' });
        await A.loc('[data-role="composer"]').fill(reply);
        await waitUntil(async () => (await B.peek('[data-role="typing"]')) === TX('apps.typing', { name: A.short }), { timeoutMs: 10000, label: 'B sees "is typing"' });
        await A.page.keyboard.press('Enter');
        const got = await waitMessages(B, (m) => m.some((x) => !x.mine && x.text === reply && x.quoteOf === m1), 'the reply with its quote at B');
        const q = got.find((x) => x.text === reply).quoteText;
        assert(q.indexOf(TX('apps.you')) >= 0 && q.indexOf('hello bold it gone mono') >= 0, 'quote ' + q);
        await waitUntil(async () => (await B.count('[data-role="typing"]')) === 0, { timeoutMs: 10000, label: 'the typing line goes' });
        await A.press(listRow(m1) + ' [data-role="msg-menu"]');
        await A.press('[data-role="menu"] [data-role="msg-react"]');
        await A.press('[data-role="react-row"] [data-role="react-pick"][data-emoji="' + THUMB + '"]');
        const bm = await waitMessages(B, (m) => m.some((x) => x.id === m1 && x.reactions.some((r) => r.emoji === THUMB && /1$/.test(r.label.trim()) && !r.mine)), 'the reaction at B');
        assert(bm.find((x) => x.id === m1).reactions.length === 1, 'reactions at B ' + JSON.stringify(bm.find((x) => x.id === m1).reactions));
        await waitMessages(A, (m) => m.some((x) => x.id === m1 && x.reactions.some((r) => r.emoji === THUMB && r.mine)), 'the own reaction at A');
      });

      /** P edits one of its messages through the menu (the composer holds the old text, Enter saves the new one): both show the new text with "edited". */
      async function editMessage(P, other, id, from, to) {
        await P.press(listRow(id) + ' [data-role="msg-menu"]');
        await P.press('[data-role="menu"] [data-role="msg-edit"]');
        await waitUntil(async () => (await P.loc('[data-role="composer"]').inputValue()) === from && (await P.text('[data-role="send"]')) === TX('apps.composer.save'), { timeoutMs: 5000, label: P.name + ': the composer holds the text to edit' });
        await P.loc('[data-role="composer"]').fill(to);
        await P.page.keyboard.press('Enter');
        for (const X of [P, other]) {
          const list = await waitMessages(X, (m) => m.some((x) => x.id === id && x.text === to && x.edited), 'the edit at ' + X.name);
          assert(list.find((x) => x.id === id).deleted === false, 'an edited message was deleted');
        }
        assert((await P.loc('[data-role="composer"]').inputValue()) === '', P.name + ': the composer is not empty after the edit');
      }

      const m3 = await step('B sends a message, edits it (both show the new text and "edited") and deletes it for both (both show the placeholder and no trace of either text)', async () => {
        await B.loc('[data-role="composer"]').fill(text3);
        await B.page.keyboard.press('Enter');
        const first = await waitMessages(A, (m) => m.some((x) => !x.mine && x.text === text3), 'the message at A');
        const id = first.find((x) => !x.mine && x.text === text3).id;
        await editMessage(B, A, id, text3, text3b);
        await B.press(listRow(id) + ' [data-role="msg-menu"]');
        await B.press('[data-role="menu"] [data-role="msg-delete-both"]');
        await confirmCard(B, 'delete-both', 'apps.confirm.deleteBoth.title');
        for (const P of [A, B]) {
          const list = await waitMessages(P, (m) => m.some((x) => x.id === id && x.deleted && x.text === TX('apps.msg.deleted')), 'the placeholder at ' + P.name);
          const visible = await P.page.locator('[data-role="messages"]').innerText();
          assert(visible.indexOf('draft one') < 0 && visible.indexOf('final two') < 0 && visible.indexOf(MARK + '-three') < 0, P.name + ' still shows the deleted text');
          assert(list.some((x) => x.id === m1 && !x.deleted) && list.some((x) => x.id === m2 && !x.deleted && x.text === text2), P.name + ' lost other messages');
        }
        return id;
      });

      const m4 = await step('B sends one more and edits it twice: both show the last text (the earlier texts are kept for the history, see the export)', async () => {
        await B.loc('[data-role="composer"]').fill(text4a);
        await B.page.keyboard.press('Enter');
        const first = await waitMessages(A, (m) => m.some((x) => !x.mine && x.text === text4a), 'the message at A');
        const id = first.find((x) => !x.mine && x.text === text4a).id;
        await editMessage(B, A, id, text4a, text4b);
        await editMessage(B, A, id, text4b, text4c);
        return id;
      });

      await step('A pins the first message and the conversation, searches (text, then pinned only, then a miss) and exports: the file name and the JSON shape', async () => {
        await A.press(listRow(m1) + ' [data-role="msg-menu"]');
        await A.press('[data-role="menu"] [data-role="msg-pin"]');
        await waitMessages(A, (m) => m.some((x) => x.id === m1 && x.pinned), 'the pinned mark');
        await A.press('[data-role="tools-toggle"]');
        await A.press('[data-role="tool-pin"]');
        await waitApps(A, (x) => x.conversations[0].pinned === true, 'the conversation is pinned', 10000);
        await A.press('[data-role="tool-search"]');
        const hits = () => A.page.evaluate(() => Array.from(document.querySelectorAll('[data-role="messages"] li.mw-apps-hit')).map((n) => n.getAttribute('data-msg')));
        await A.loc('[data-role="search-text"]').fill('felinar-e2e');
        await A.press('[data-role="search-go"]');
        await waitUntil(async () => (await A.text('[data-role="search-result"]')) === TX('apps.search.result', { i: 1, n: 1 }), { timeoutMs: 5000, label: 'result 1 of 1' });
        assert((await hits()).join() === m1, 'search hits ' + (await hits()));
        await A.loc('[data-role="search-text"]').fill('');
        await A.loc('[data-role="search-pinned"]').check();
        await A.press('[data-role="search-go"]');
        await waitUntil(async () => (await hits()).join() === m1, { timeoutMs: 5000, label: 'the pinned filter finds the pinned message only' });
        await A.loc('[data-role="search-pinned"]').uncheck();
        await A.loc('[data-role="search-text"]').fill(MARK + '-nothing');
        await A.press('[data-role="search-go"]');
        await waitUntil(async () => (await A.text('[data-role="search-result"]')) === TX('apps.search.none'), { timeoutMs: 5000, label: 'no match' });
        await A.press('[data-role="search-clear"]');
        const day0 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const dl = A.page.waitForEvent('download', { timeout: 15000 });
        await A.press('[data-role="tool-export"]');
        const download = await dl;
        const day1 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const name = download.suggestedFilename();
        const file = 'felinar-chat-' + B.short + '-';
        assert(name === file + day0 + '.json' || name === file + day1 + '.json', 'file name ' + name);
        const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
        assert(data.format === 'felinar-apps-chat' && data.version === 1 && /^\d{4}-\d\d-\d\dT/.test(data.exportedAt), bad('export head', { format: data.format, version: data.version, at: data.exportedAt }));
        assert(/^p256:/.test(data.me.pub) && /^p256:/.test(data.peer.pub) && data.me.pub !== data.peer.pub, bad('export keys', { me: data.me, peer: data.peer }));
        assert(data.me.short.replace('-', '') === A.short.replace('-', '') && data.peer.short.replace('-', '') === B.short.replace('-', ''), bad('export short ids', { me: data.me, peer: data.peer }));
        assert(/^\d{8}$/.test(String(data.compare).replace(/\s/g, '')), 'export compare ' + data.compare);
        const by = (id) => data.messages.find((x) => x.id === id);
        const e1 = by(m1);
        assert(e1 && e1.from === 'peer' && e1.text === text1 + SMILE, bad('export m1', e1));
        assert(e1.fmt === 'md1' && e1.pinned === true && JSON.stringify(e1.reactions) === JSON.stringify({ [THUMB]: ['me'] }), bad('export m1 flags', e1));
        const e2 = by(m2);
        assert(e2 && e2.from === 'peer' && e2.text === text2 && e2.deleted === false && e2.edits.length === 0, bad('export m2', e2));
        const e3 = by(m3);
        assert(e3 && e3.from === 'peer' && e3.deleted === true && e3.text === '', bad('export m3', e3));
        const e4 = by(m4);
        assert(e4 && e4.text === text4c && e4.deleted === false && e4.edits.map((x) => x.text).join('|') === text4a + '|' + text4b && e4.edits.every((x) => Number.isFinite(x.t)), bad('export m4', e4));
        const er = data.messages.find((x) => x.text === reply);
        assert(er && er.from === 'me' && er.reply === m1 && /^(sent|delivered|read)$/.test(er.status), bad('export reply', er));
        assert(data.messages.length === 5 && data.messages.every((x) => /^[A-Za-z0-9_-]{16}$/.test(x.id) && /^\d{4}-/.test(x.time)), bad('export messages', data.messages.map((x) => x.id)));
        return name;
      }, 60000);

      await step('send later: B schedules a message ten minutes ahead (it waits at B with its time and a Cancel button, A gets nothing); B cancels it and it is gone', async () => {
        const before = (await A.apps()).conversations[0].messages;
        await B.press('[data-role="later-toggle"]');
        await B.press('[data-role="later-set"]'); // the field offers ten minutes from now
        await waitUntil(async () => (await B.count('[data-role="later-note"]')) === 1, { timeoutMs: 5000, label: 'the "send later" note over the composer' });
        await B.loc('[data-role="composer"]').fill(later);
        await B.page.keyboard.press('Enter');
        const queued = await waitMessages(B, (m) => m.some((x) => x.mine && x.text === later && x.status === 'queued' && x.scheduled && x.cancelSend), 'the scheduled message at B');
        const id = queued.find((x) => x.text === later).id;
        await sleep(1500);
        assert((await A.apps()).conversations[0].messages === before, 'a scheduled message reached A before its time');
        await B.press(listRow(id) + ' [data-role="cancel-send"]');
        await waitMessages(B, (m) => !m.some((x) => x.id === id), 'the cancelled message is gone at B');
        await sleep(500);
        assert((await A.apps()).conversations[0].messages === before, 'a cancelled message reached A');
      });

      await step('privacy switches: with read receipts off A reads B\'s message and B stays at Delivered; with the typing line off B does not see A typing; both switched on again', async () => {
        if ((await A.count('[data-role="tool-receipts"]')) === 0) await A.press('[data-role="tools-toggle"]');
        const on = (role) => A.loc('[data-role="' + role + '"]').getAttribute('aria-pressed');
        assert((await on('tool-receipts')) === 'true' && (await on('tool-typing')) === 'true', 'the switches are not on by default');
        await A.press('[data-role="tool-receipts"]');
        await A.press('[data-role="tool-typing"]');
        await waitUntil(async () => (await on('tool-receipts')) === 'false' && (await on('tool-typing')) === 'false', { timeoutMs: 5000, label: 'both switches read off' });
        await B.loc('[data-role="composer"]').fill(quiet);
        await B.page.keyboard.press('Enter');
        const got = await waitMessages(A, (m) => m.some((x) => !x.mine && x.text === quiet), 'the message at A (A is reading it)');
        const id = got.find((x) => x.text === quiet).id;
        await waitMessages(B, (m) => m.some((x) => x.id === id && x.status === 'delivered'), 'delivered at B');
        await A.loc('[data-role="composer"]').fill('typing without a sound');
        await sleep(3500);
        assert((await B.count('[data-role="typing"]')) === 0, 'B was told that A is typing');
        const still = (await B.messages()).find((x) => x.id === id);
        assert(still.status === 'delivered', 'B\'s ticks went to ' + still.status + ' although A switched read receipts off');
        await A.loc('[data-role="composer"]').fill('');
        await A.press('[data-role="tool-receipts"]');
        await A.press('[data-role="tool-typing"]');
        await waitUntil(async () => (await on('tool-receipts')) === 'true' && (await on('tool-typing')) === 'true', { timeoutMs: 5000, label: 'both switches read on again' });
      });

      await step('limits: a message of the largest size (3,500 characters) arrives whole; a text too long for one frame (3,000 Arabic-script letters) is refused in the composer and the draft stays', async () => {
        const big = (MARK + '-big ').padEnd(3500, 'abcdefghij');
        assert(big.length === 3500, 'the big text is ' + big.length);
        await B.loc('[data-role="composer"]').fill(big);
        await B.page.keyboard.press('Enter');
        const got = await waitMessages(A, (m) => m.some((x) => !x.mine && x.text.length === 3500), 'the big message at A', { timeoutMs: 30000 });
        assert(got.find((x) => x.text.length === 3500).text === big, 'the big message arrived changed');
        await waitMessages(B, (m) => m.some((x) => x.mine && x.text === big && (x.status === 'delivered' || x.status === 'read')), 'delivered at B');
        const before = [(await A.apps()).conversations[0].messages, (await B.apps()).conversations[0].messages];
        const wide = '\u0633'.repeat(3000);
        await B.loc('[data-role="composer"]').fill(wide);
        await B.page.keyboard.press('Enter');
        await waitUntil(async () => (await B.count('[data-role="composer-error"]')) === 1, { timeoutMs: 10000, label: 'the composer error' });
        const said = await B.text('[data-role="composer-error"]');
        assert(said === TX('apps.err.tooLong'), 'the composer says "' + said + '"');
        assert((await B.loc('[data-role="composer"]').inputValue()) === wide, 'the draft did not stay');
        await sleep(800);
        assert((await A.apps()).conversations[0].messages === before[0] && (await B.apps()).conversations[0].messages === before[1], 'a message that does not fit a frame was sent');
        await B.loc('[data-role="composer"]').fill('');
      });

      await step('the wire drops (B\'s connections close, the page stays): both show "Not connected"; B\'s message waits ("Waiting to send"); when the network is back it is Delivered, then Read when A opens it', async () => {
        await A.press('[data-role="back"]');
        await waitApps(A, (x) => x.view === 'messages', 'A on the list', 5000);
        const before = (await A.apps()).conversations[0].messages;
        const dropped = await B.page.evaluate(() => window.__mwApps.dropAll());
        assert(dropped > 0, 'no connection to close at B');
        await Promise.all([A, B].map((P) => waitApps(P, (x) => x.conversations[0].status !== 'connected', P.name + ' notices that the wire is gone', 30000)));
        await waitUntil(async () => (await B.text('[data-role="status-line"]')).indexOf('Not connected') === 0, { timeoutMs: 10000, label: 'B\'s status line says "Not connected"' });
        await B.loc('[data-role="composer"]').fill(away);
        await B.page.keyboard.press('Enter');
        const queued = await waitMessages(B, (m) => m.some((x) => x.mine && x.text === away && x.status === 'queued'), 'the message waits at B', { timeoutMs: 10000 });
        assert(queued.find((x) => x.text === away).tick === TX('apps.msg.queued'), 'queued label ' + queued.find((x) => x.text === away).tick);
        assert((await A.apps()).conversations[0].messages === before, 'the message arrived while the wire was down');
        // The network is back: the browser tells the page ('online'), the manager asks the rendezvous for peers again (torrent.js kick(); it
        // ignores a kick in the first 2 s after the manager was built, so the event is repeated every 4 s, as a flaky network would).
        let lastOnline = 0;
        const done = await waitUntil(async () => {
          const m = await B.messages();
          if (m.some((x) => x.mine && x.text === away && x.status === 'delivered')) return m;
          if (Date.now() - lastOnline > 4000) {
            lastOnline = Date.now();
            await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
          }
          return null;
        }, { timeoutMs: 50000, stepMs: 150, label: 'B: delivered after the wire came back' });
        assert(done.find((x) => x.text === away).tick === TX('apps.msg.delivered'), 'delivered label');
        const a = await waitApps(A, (x) => x.conversations[0].unread === 1 && x.conversations[0].status === 'connected', 'A has the message and the wire', 15000);
        assert(a.conversations[0].messages === before + 1, bad('A conversation', a.conversations[0]));
        await A.press('[data-role="conv-list"] [data-conv]');
        await waitMessages(B, (m) => m.some((x) => x.mine && x.text === away && x.status === 'read'), 'read after A opens it', { timeoutMs: 20000 });
      }, 60000);

      await step('disappearing messages: A picks "10 seconds" by typing; the message shows "Disappears" on both sides and is gone from both screens about ten seconds later', async () => {
        if ((await A.count('[data-role="exp-select"]')) === 0) await A.press('[data-role="tools-toggle"]');
        const sel = A.loc('[data-role="exp-select"]');
        // A trusted change: the select acts on a person's input only. ArrowDown opens the pop-up menu on macOS and locator.selectOption()
        // dispatches an untrusted event, so the choice is made by typing its first letter ("1" finds "10 seconds" after "Off").
        await sel.focus();
        await A.page.keyboard.type('1');
        await waitUntil(async () => (await sel.inputValue()) === '10000', { timeoutMs: 5000, label: 'the select reads 10 seconds' });
        await A.loc('[data-role="composer"]').fill(soon);
        const tSend = Date.now();
        await A.page.keyboard.press('Enter');
        let id = null;
        for (const P of [A, B]) {
          const list = await waitMessages(P, (m) => m.some((x) => x.text === soon && x.expires), 'the message with its timer at ' + P.name, { timeoutMs: 15000 });
          id = list.find((x) => x.text === soon).id;
        }
        await Promise.all([A, B].map((P) => waitMessages(P, (m) => !m.some((x) => x.id === id), 'the message is gone at ' + P.name, { timeoutMs: 30000 })));
        const gone = Date.now() - tSend;
        assert(gone >= 8000 && gone < 25000, 'the message went after ' + gone + ' ms');
        for (const P of [A, B]) assert(!(await P.page.locator('[data-role="messages"]').innerText()).includes(MARK + '-soon'), P.name + ' still shows the text');
        return gone;
      }, 60000);

      await step('A signs out: the conversation and the code are gone, A\'s connections close, the rendezvous releases the code and B sees the wire close', async () => {
        for (const P of [A, B]) await sampleCandidates(P);
        assert(tracker.stats().codes === base.codes + 1, 'the rendezvous holds no code of A: ' + JSON.stringify(tracker.stats()));
        await A.press('[data-role="signout"]');
        const a = await waitApps(A, (x) => !x.signedIn && x.view === 'home', 'A signed out', 15000);
        assert(a.ready === false && a.code === null && a.conversations.length === 0 && a.rooms.length === 0 && a.requests === 0, bad('A after sign-out', a));
        await waitUntil(() => tracker.stats().codes === base.codes, { timeoutMs: 10000, label: 'the rendezvous releases the code of A' });
        await waitUntil(() => A.page.evaluate(() => window.__mwApps.pcs.every((pc) => pc.connectionState !== 'connected')), { timeoutMs: 15000, label: 'A\'s connections close' });
        await waitApps(B, (x) => x.conversations[0].status !== 'connected', 'B sees the wire close', 30000);
        const by = Object.fromEntries((await A.tiles()).map((t) => [t.app, t]));
        assert(by.messages.state === 'locked' && by.rooms.state === 'locked', bad('tiles after sign-out', by));
      });

      const leaks = await step('the rendezvous only saw the channel and sealed boxes; no message text, key or SDP travelled in the clear; nothing was stored in either browser; every connection stayed on loopback', async () => {
        for (const P of [A, B]) {
          const text = allFrameText(P);
          for (const n of needles) assert(text.indexOf(n) < 0, P.name + ': "' + n + '" travelled to the rendezvous');
          assert(text.indexOf('p256:') < 0 && text.toLowerCase().indexOf(secret) < 0, P.name + ' sent a key or the secret');
          await assertNothingStored(P, kept.get(P), needles.concat([A.short.replace('-', ''), B.short.replace('-', ''), 'p256:']));
        }
        // DECISIONS DEC-7: the keepalive (plan 3.4: the link writes pair-ping every 50 s while its socket is open) is not an action a person took, so it is
        // left out of what A and B "said"; with it in, a run that crossed the 50 s mark would fail here by the clock, not because a page said something new.
        const saidBy = (P) => framesJson(P, 'out').map((f) => f.msg.action).filter((a) => a !== 'pair-ping');
        assert(saidBy(B).every((a) => a === 'pair-knock' || a === 'announce'), 'B said something else to the rendezvous: ' + JSON.stringify(saidBy(B)));
        const aSaid = Array.from(new Set(saidBy(A)));
        assert(aSaid.every((x) => ['pair-open', 'pair-accept', 'pair-close', 'announce'].indexOf(x) >= 0), 'A said ' + aSaid.join());
        return leakCheck([A, B], { run0, needles, door });
      });
      await closeParties(ctx, [A, B]);
      return 'connected ' + connectMs + ' ms after the accept (lane ' + lane.slice(0, 8) + '); ' + leaks;
    },
  };

  // ------------------------------------------------------------------------------------------- APPS-3
  S['APPS-3'] = {
    title: 'reject and block: a replaced code says so; A rejects B ("Rejected" at B, no lane, no connection, no manager); B knocks again and is accepted; A blocks B; a later knock from B is refused without A seeing anything',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const door = await doorStack(ctx, step);
      const { tracker } = ctx.stack;
      const run0 = run.violations.length;
      const hello = 'hello before the block ' + MARK + '-block';
      const needles = [MARK, 'hello before the block'];

      const [A, B] = await step('two browsers, A and B (separate processes), open the door and sign in for this visit', async () => {
        const a = await newParty(ctx, 'APPS3A');
        const b = await newParty(ctx, 'APPS3B');
        for (const P of [a, b]) {
          await openDoor(P, door);
          await signIn(P);
        }
        return [a, b];
      });
      const base = tracker.stats();
      const kept = new Map();
      for (const P of [A, B]) kept.set(P, await P.storage());

      let code = await step('A opens a code (the price card first)', async () => {
        await A.press('[data-app="messages"]');
        await continueCard(A, 'start');
        await waitApps(A, (x) => x.code && x.link === 'open', 'a code', 20000);
        return A.text('[data-role="code"]');
      });
      const firstCode = code;

      /** B types A's code and presses Enter in the field (the price was answered already, and a form never submits at a door: form-action 'none'). */
      async function knock() {
        const n = (await B.apps()).conversations.length;
        await B.loc('[data-role="knock-input"]').fill(code);
        await B.page.keyboard.press('Enter');
        await waitApps(B, (x) => x.conversations.length === n + 1, 'a new waiting conversation', 15000);
      }

      await step('A presses "New code": a different code replaces the first at the rendezvous; B types the old code (the price card first): "No one has this code right now"; B keeps no conversation and A sees nothing', async () => {
        await A.press('[data-role="code-new"]');
        await waitUntil(async () => { const t = await A.loc('[data-role="code"]').first().innerText({ timeout: 2000 }).then((x) => x.trim(), () => ''); return CODE_RE.test(t) && t !== firstCode; }, { timeoutMs: 15000, label: 'A shows a new code' });
        code = await A.text('[data-role="code"]');
        const a = await waitApps(A, (x) => x.code === code.slice(0, 4), 'the new channel', 15000);
        assert(CODE_RE.test(code) && a.code.length === 4, 'the new code ' + code);
        assert(tracker.stats().codes === base.codes + 1, 'the rendezvous holds ' + tracker.stats().codes + ' codes, not ' + (base.codes + 1));
        await B.press('[data-app="messages"]');
        await waitApps(B, (x) => x.view === 'messages' && x.card === 'start', 'the price card', 10000);
        await B.press('[data-role="card-cancel"]');
        await waitApps(B, (x) => x.card === null, 'the card closes', 5000);
        assert(B.tap.sockets.length === 0, 'B opened a socket on "Not now"');
        await B.loc('[data-role="knock-input"]').fill(firstCode);
        await B.press('[data-role="knock-button"]');
        await continueCard(B, 'knock', { whileShown: async () => assert(B.tap.sockets.length === 0, 'a socket opened while the knock price card was up') });
        await waitUntil(async () => (await B.text('[data-role="knock-note"]')) === TX('apps.err.unknown'), { timeoutMs: 10000, label: 'the "no one has this code" note' });
        const b = await B.apps();
        assert(b.conversations.length === 0 && b.card === null, bad('B after the old code', b));
        await sleep(500);
        assert((await A.apps()).requests === 0, 'A was shown a request for a code it closed');
        assert(tracker.stats().knocks === base.knocks && tracker.stats().lanes === base.lanes, bad('rendezvous', tracker.stats()));
        assert((await B.made()) === 0 && (await B.state()).apps.tm === false, 'B made a connection or loaded the manager');
      });

      await step('B knocks with the right code (the Enter key of the field); A sees the request and presses Reject: B\'s conversation says "Rejected"; no lane, no peer connection, no manager, no announce anywhere', async () => {
        await knock();
        await waitApps(A, (x) => x.requests === 1, 'the request', 30000);
        await A.press('[data-role="requests"] [data-role="reject"]');
        await waitApps(A, (x) => x.requests === 0, 'the request is gone at A', 10000);
        const b = await waitApps(B, (x) => x.conversations.length === 1 && x.conversations[0].status === 'rejected', 'B is rejected', 20000);
        assert((await B.text('[data-role="conv-list"] li')).indexOf(TX('apps.status.rejected')) >= 0, 'B row ' + (await B.text('[data-role="conv-list"] li')));
        assert(b.conversations[0].messages === 0, bad('B conversation', b.conversations[0]));
        assert((await A.apps()).conversations.length === 0, 'A kept a conversation for a rejected request');
        const rejected = framesJson(B, 'in').map((f) => f.msg).filter((m) => m.action === 'pair-rejected');
        assert(rejected.length === 1 && rejected[0].reason === 'rejected', bad('B pair-rejected', rejected));
        const s = tracker.stats();
        assert(s.lanes === base.lanes && s.knocks === base.knocks && s.codes === base.codes + 1, bad('rendezvous', { base, now: s }));
        for (const P of [A, B]) {
          const st = await P.state();
          assert((await P.made()) === 0 && st.peers === 0 && st.apps.tm === false, P.name + ': connections ' + (await P.made()) + ', peers ' + st.peers + ', manager ' + st.apps.tm);
          assert(P.v.announces.length === 0 && lanesSeen(P).length === 0, P.name + ' announced or was told a lane');
        }
      });

      await step('B opens the rejected conversation: "Rejected", the composer is closed', async () => {
        await B.press('[data-role="conv-list"] [data-conv][data-status="rejected"]');
        await waitApps(B, (x) => x.view === 'conversation', 'the conversation view', 5000);
        assert((await B.text('[data-role="status-line"]')) === TX('apps.status.rejected'), 'status ' + (await B.text('[data-role="status-line"]')));
        assert(await B.loc('[data-role="composer"]').isDisabled(), 'the composer of a rejected conversation is open');
        assert((await B.text('[data-role="closed-note"]')) === TX('apps.composer.closed'), 'closed note');
        await B.press('[data-role="back"]');
        await waitApps(B, (x) => x.view === 'messages', 'B on the list', 5000);
      });

      await step('B knocks again with the same code; A accepts; both connect; B sends a message and A reads it', async () => {
        await knock();
        await waitApps(A, (x) => x.requests === 1, 'the second request', 30000);
        await A.press('[data-role="requests"] [data-role="accept"]');
        await continueCard(A, 'accept', { check: true });
        await waitApps(A, (x) => x.conversations.length === 1 && x.conversations[0].status === 'connected', 'A connected', 45000);
        await waitApps(B, (x) => x.conversations.some((c) => c.status === 'connected'), 'B connected', 45000);
        assert(tracker.stats().lanes === base.lanes + 1, bad('rendezvous', tracker.stats()));
        await B.press('[data-role="conv-list"] [data-conv][data-status="connected"]');
        await B.loc('[data-role="composer"]').fill(hello);
        await B.page.keyboard.press('Enter');
        await A.press('[data-role="conv-list"] [data-conv]');
        await waitMessages(A, (m) => m.some((x) => !x.mine && x.text === hello), 'the message at A');
        await waitMessages(B, (m) => m.some((x) => x.mine && x.text === hello && x.status === 'read'), 'read ticks at B', { timeoutMs: 20000 });
        for (const P of [A, B]) await sampleCandidates(P);
      }, 60000);

      const aMade = await step('A blocks B (tools, Block, the red button): the conversation reads "Blocked", its composer closes, A leaves the lane', async () => {
        await A.press('[data-role="tools-toggle"]');
        await A.press('[data-role="tool-block"]');
        await confirmCard(A, 'block', 'apps.confirm.block.title');
        await waitApps(A, (x) => x.conversations[0].status === 'blocked', 'A shows Blocked', 10000);
        assert((await A.text('[data-role="status-line"]')) === TX('apps.status.blocked'), 'status ' + (await A.text('[data-role="status-line"]')));
        assert(await A.loc('[data-role="composer"]').isDisabled(), 'the composer of a blocked conversation is open');
        assert((await A.count('[data-role="tool-unblock"]')) === 1 && (await A.count('[data-role="tool-block"]')) === 0, 'the tools offer Unblock');
        await waitApps(B, (x) => x.conversations.every((c) => c.status !== 'connected'), 'B notices that the wire is gone', 30000);
        return A.made();
      });

      await step('B knocks a third time: A is told nothing (no request, no toast, no counter in the tab title, no lane, no connection); B is refused after a wait', async () => {
        await B.press('[data-role="back"]');
        await waitApps(B, (x) => x.view === 'messages', 'B on the list', 5000);
        const lanes = tracker.stats().lanes;
        const tKnock = Date.now();
        await knock();
        let refused = null;
        for (;;) {
          const [a, b] = [await A.apps(), await B.apps()];
          assert(a.requests === 0, 'A was shown a request from a blocked person');
          // (the toast of B's earlier message may still be up: only the toast of a request would be news)
          const toast = await A.peek('[data-role="toast"]');
          assert(toast.indexOf(TX('apps.request.wants', { name: TX('apps.someone'), short: B.short })) < 0, 'A was shown a toast about a request: ' + toast);
          assert((await A.page.title()) !== '(1) ' + TX('apps.docTitle'), 'the tab title of A counts a request');
          refused = b.conversations.find((c) => c.status === 'rejected' && b.conversations.indexOf(c) === b.conversations.length - 1) || null;
          if (refused) break;
          if (Date.now() - tKnock > 25000) throw new StepError('B was not refused within 25 s: ' + JSON.stringify(b.conversations.map((c) => c.status)));
          await sleep(200);
        }
        const waited = Date.now() - tKnock;
        assert(waited >= 2500, 'the refusal came after ' + waited + ' ms (a blocked knock is answered after a random wait of 3 to 12 s)');
        assert(tracker.stats().lanes === lanes && tracker.stats().knocks === base.knocks, bad('rendezvous', tracker.stats()));
        assert((await A.made()) === aMade, 'A made ' + ((await A.made()) - aMade) + ' new peer connections after the block');
        assert(((await B.apps()).conversations.filter((c) => c.status === 'rejected').length) === 2, 'B conversations ' + JSON.stringify((await B.apps()).conversations.map((c) => c.status)));
        return waited;
      }, 60000);

      const leaks = await step('nothing travelled in the clear; nothing was stored in either browser; every connection stayed on loopback', async () => {
        for (const P of [A, B]) {
          const text = allFrameText(P);
          for (const n of needles) assert(text.indexOf(n) < 0, P.name + ': "' + n + '" travelled to the rendezvous');
          await assertNothingStored(P, kept.get(P), needles.concat(['p256:']));
        }
        return leakCheck([A, B], { run0, needles, door });
      });
      await closeParties(ctx, [A, B]);
      return 'rejected at once, accepted, blocked, then refused after the wait; ' + leaks;
    },
  };

  // ------------------------------------------------------------------------------------------- APPS-4
  S['APPS-4'] = {
    title: 'room: an owner and three people in four browser processes; the owner decides each request; the roster of three is on all three members; messages fan out; the rejected person never learns the lane and gets nothing',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      // AMENDMENTS A6: the lane step checks the direct wire of a room (the lane announced only after the first accept, a peer connection
      // on each member), so this scenario's door says relay none (direct on, A2).
      const door = await doorStack(ctx, step, { relay: 'none' });
      const { tracker } = ctx.stack;
      const run0 = run.violations.length;
      const t0 = Date.now();
      const words = { m1: 'room hello from the first member ' + MARK + '-m1', m2: 'room hello from the second member ' + MARK + '-m2', o: 'welcome to the room ' + MARK + '-owner' };
      const needles = [MARK, 'room hello from', 'welcome to the room'];
      const rows = (P) => P.page.locator('[data-role="room-requests"] li.mw-apps-request');

      const [O, M1, M2, X] = await step('four browsers (separate processes, fresh profiles): an owner, two people who will be accepted and one who will be rejected, all signed in for this visit', async () => {
        const out = [];
        for (const name of ['APPS4O', 'APPS4M1', 'APPS4M2', 'APPS4X']) out.push(await newParty(ctx, name));
        for (const P of out) {
          await openDoor(P, door);
          await signIn(P);
        }
        assert(new Set(out.map((P) => P.short)).size === 4, 'two parties share a short id');
        return out;
      });
      const base = tracker.stats();
      const kept = new Map();
      for (const P of [O, M1, M2, X]) kept.set(P, await P.storage());

      const { code, lane } = await step('the owner creates a room (the price card first): a code and a lane minted at the rendezvous; nobody has joined it, no announce, no peer connection, no manager', async () => {
        await O.press('[data-app="rooms"]');
        await waitApps(O, (x) => x.view === 'rooms', 'the rooms view', 5000);
        await O.press('[data-role="room-create"]');
        await continueCard(O, 'room-create', {
          whileShown: async () => {
            assert(O.tap.sockets.length === 0 && tracker.stats().lanes === base.lanes, 'a socket or a lane before Continue');
          },
        });
        const a = await waitApps(O, (x) => x.view === 'room' && x.rooms.length === 1 && x.link === 'open', 'the room view with an open link', 20000);
        assert(a.rooms[0].role === 'owner' && a.rooms[0].members === 1 && a.rooms[0].status === 'open', bad('owner room', a.rooms[0]));
        const shown = await O.text('[data-role="room-code"]');
        assert(CODE_RE.test(shown), 'room code ' + shown);
        assert((await O.text('[data-role="status-line"]')) === TX('apps.rooms.status.open'), 'status ' + (await O.text('[data-role="status-line"]')));
        const ids = lanesSeen(O);
        assert(ids.length === 1, 'the rendezvous told the owner ' + ids.length + ' lanes');
        const s = tracker.stats();
        assert(s.lanes === base.lanes + 1, bad('rendezvous', { base, now: s }));
        const st = await O.state();
        assert((await O.made()) === 0 && st.apps.tm === false && st.peers === 0 && O.v.announces.length === 0, 'the owner joined the lane before any accept');
        assert(!tracker.announces.some((x) => x.btih === ids[0]), 'the tracker saw an announce for the room lane before any accept');
        return { code: shown, lane: ids[0] };
      });

      await step('the three people (M1, M2, X) ask to join with the code (the price card first); the owner sees three requests; before any decision nobody has a peer connection, a manager or the lane', async () => {
        for (const P of [M1, M2, X]) {
          await P.press('[data-app="rooms"]');
          await waitApps(P, (x) => x.view === 'rooms', 'the rooms view', 5000);
          await P.loc('[data-role="join-input"]').fill(code);
          await P.press('[data-role="join-button"]');
          await continueCard(P, 'room-join', { whileShown: async () => assert(P.tap.sockets.length === 0, P.name + ' opened a socket before Continue') });
          await waitUntil(async () => (await P.text('[data-role="join-note"]')) === TX('apps.rooms.joinSent'), { timeoutMs: 10000, label: P.name + ': the "request sent" note' });
          await waitApps(P, (x) => x.rooms.length === 1 && x.rooms[0].status === 'waiting', 'a waiting room', 10000);
        }
        await waitApps(O, (x) => x.requests === 3, 'three requests at the owner', 30000);
        await waitUntil(async () => (await rows(O).count()) === 3, { timeoutMs: 10000, label: 'three request rows' });
        const texts = await rows(O).allInnerTexts();
        for (const P of [M1, M2, X]) assert(texts.some((t) => t.indexOf(TX('apps.request.room', { name: TX('apps.someone'), short: P.short })) >= 0), 'no request row for ' + P.name + ': ' + JSON.stringify(texts));
        assert(tracker.stats().knocks === base.knocks + 3, bad('rendezvous', tracker.stats()));
        for (const P of [O, M1, M2, X]) {
          const st = await P.state();
          assert((await P.made()) === 0 && st.apps.tm === false && st.peers === 0 && P.v.announces.length === 0, P.name + ' has a connection, a manager or an announce before any decision');
          if (P !== O) assert(lanesSeen(P).length === 0 && allFrameText(P).indexOf(lane) < 0, P.name + ' was told the lane');
        }
        assert(!tracker.announces.some((x) => x.btih === lane), 'the tracker saw an announce for the room lane before any decision');
      });

      let tAccept = 0; // the moment of the first click on Accept
      await step('the owner accepts M1 and M2 (the price card repeats and adds the check line) and rejects X; the two connect and the roster of three shows on all three', async () => {
        for (const P of [M1, M2]) {
          if (!tAccept) tAccept = Date.now();
          await rows(O).filter({ hasText: P.short }).locator('[data-role="accept"]').click({ timeout: 5000 });
          await continueCard(O, 'room-accept', { check: true });
          await waitUntil(async () => (await rows(O).filter({ hasText: P.short }).count()) === 0, { timeoutMs: 10000, label: 'the row of ' + P.name + ' goes' });
        }
        await rows(O).filter({ hasText: X.short }).locator('[data-role="reject"]').click({ timeout: 5000 });
        await waitApps(O, (x) => x.requests === 0, 'no request left', 10000);
        // the owner's room stays "Open for members" while its code is open; a member's room is "Connected"
        const okStatus = (P) => (P === O ? ['open', 'connected'] : ['connected']);
        for (const P of [O, M1, M2]) {
          await waitApps(P, (x) => x.rooms.length === 1 && x.rooms[0].members === 3 && okStatus(P).indexOf(x.rooms[0].status) >= 0, 'a room of three that is ' + okStatus(P).join(' or '), 25000);
        }
        await waitApps(X, (x) => x.rooms.length === 1 && x.rooms[0].status === 'rejected', 'the rejected room', 15000);
        for (const P of [M1, M2]) {
          await P.press('[data-role="room-list"] [data-room]');
          await waitApps(P, (x) => x.view === 'room', 'the room view', 5000);
        }
        const rosters = [];
        for (const P of [O, M1, M2]) {
          const r = await P.page.evaluate(() => Array.from(document.querySelectorAll('[data-role="roster"] li.mw-apps-member')).map((li) => ({
            pub: li.getAttribute('data-pub'),
            label: li.firstElementChild ? li.firstElementChild.textContent : '',
            marks: Array.from(li.querySelectorAll('.mw-apps-mark')).map((m) => m.textContent),
          })));
          rosters.push(r);
          assert(r.length === 3 && new Set(r.map((x) => x.pub)).size === 3, P.name + ' roster ' + JSON.stringify(r));
          for (const q of [O, M1, M2]) assert(r.some((x) => x.label === q.short), P.name + ' roster has no ' + q.name + ': ' + JSON.stringify(r));
          assert(!r.some((x) => x.label === X.short), P.name + ' roster lists the rejected person');
          const owners = r.filter((x) => x.marks.indexOf(TX('apps.rooms.owner')) >= 0);
          const yous = r.filter((x) => x.marks.indexOf(TX('apps.rooms.you')) >= 0);
          assert(owners.length === 1 && owners[0].label === O.short, P.name + ' roster owner mark ' + JSON.stringify(r));
          assert(yous.length === 1 && yous[0].label === P.short, P.name + ' roster "you" mark ' + JSON.stringify(r));
          const status = (await P.apps()).rooms[0].status;
          assert((await P.text('[data-role="status-line"]')) === TX('apps.rooms.status.' + status), P.name + ' status ' + (await P.text('[data-role="status-line"]')) + ' for ' + status);
        }
        const keys = (r) => r.map((x) => x.pub).sort().join();
        assert(keys(rosters[0]) === keys(rosters[1]) && keys(rosters[1]) === keys(rosters[2]), 'the three rosters list different people');
        for (const P of [O, M1, M2]) await sampleCandidates(P);
      }, 60000);

      await step('the lane: one lane for the three of them, announced only after the first accept; the rejected person was never told it and never announced anything', async () => {
        for (const P of [O, M1, M2]) {
          assert(lanesSeen(P).join() === lane, P.name + ' lanes ' + lanesSeen(P));
          const mine = announcedLane(P, lane);
          assert(mine.length > 0 && mine.every((x) => x.t >= tAccept), bad(P.name + ' lane announces', mine.map((x) => x.t - tAccept)));
          assert(P.v.announces.every((x) => x.btih === lane), P.name + ' announced another swarm');
          assert((await P.made()) > 0, P.name + ': no peer connection after the accept (is the page hook in place?)');
        }
        const peers = new Set([...announcePeers(O), ...announcePeers(M1), ...announcePeers(M2)]);
        const server = tracker.announces.filter((x) => x.btih === lane);
        assert(server.length > 0 && server.every((x) => x.t >= tAccept), 'tracker announces for the lane ' + JSON.stringify(server.map((x) => x.t - tAccept)));
        assert(server.every((x) => peers.has(x.peer)), 'the lane was announced by somebody else than the three members');
        assert(peers.size === 3, 'peer ids ' + peers.size);
        const st = await X.state();
        assert((await X.made()) === 0 && st.apps.tm === false && st.peers === 0 && X.v.announces.length === 0, 'the rejected person made a connection, loaded the manager or announced');
        assert(lanesSeen(X).length === 0 && allFrameText(X).indexOf(lane) < 0, 'the rejected person was told the lane');
        assert(allFrameText(M1).indexOf(lane) >= 0, 'the control failed: the lane is not in the frames of an accepted member');
        const s = tracker.stats();
        assert(s.lanes === base.lanes + 1 && s.knocks === base.knocks, bad('rendezvous', { base, now: s }));
      });

      await step('messages fan out: each of the three writes one (the Send button, Enter, Enter) and all three read all three, with the sender named; the rejected person has nothing', async () => {
        await M1.loc('[data-role="room-composer"]').fill(words.m1);
        await M1.press('[data-role="room-send"]');
        await M2.loc('[data-role="room-composer"]').fill(words.m2);
        await M2.page.keyboard.press('Enter');
        await O.loc('[data-role="room-composer"]').fill(words.o);
        await O.page.keyboard.press('Enter');
        const shorts = { [words.m1]: M1.short, [words.m2]: M2.short, [words.o]: O.short };
        for (const P of [O, M1, M2]) {
          const list = await waitMessages(P, (m) => m.length === 3 && Object.keys(shorts).every((t) => m.some((x) => x.text === t)), 'all three messages at ' + P.name, { listSel: '[data-role="room-messages"]', timeoutMs: 40000 });
          for (const [text, short] of Object.entries(shorts)) {
            const m = list.find((x) => x.text === text);
            if (short === P.short) assert(m.mine === true && m.from === null, P.name + ' own message ' + JSON.stringify(m));
            else assert(m.mine === false && m.from === short, P.name + ' message of ' + short + ' ' + JSON.stringify(m));
          }
        }
        await sleep(1500);
        const xs = (await X.apps()).rooms[0];
        assert(xs.messages === 0 && xs.status === 'rejected', bad('the rejected person\'s room', xs));
        assert((await X.messages('[data-role="room-messages"]')).length === 0, 'the rejected person\'s list holds messages');
        assert((await X.made()) === 0 && lanesSeen(X).length === 0, 'the rejected person made a connection or learned the lane');
      });

      await step('the rejected person opens the room row: "Rejected", no roster entries beyond the room, a closed composer', async () => {
        await X.press('[data-role="room-list"] [data-room]');
        await waitApps(X, (x) => x.view === 'room', 'the room view', 5000);
        assert((await X.text('[data-role="status-line"]')) === TX('apps.rooms.status.rejected'), 'status ' + (await X.text('[data-role="status-line"]')));
        assert(await X.loc('[data-role="room-composer"]').isDisabled(), 'the composer of a rejected room is open');
        assert((await X.count('[data-role="room-requests"]')) === 0 && (await X.count('[data-role="room-code"]')) === 0, 'the rejected person sees the owner\'s panel');
      });

      const leaks = await step('nothing travelled in the clear; no message text, key or SDP reached the rendezvous; nothing was stored in any browser; every connection stayed on loopback', async () => {
        const secret = code.replace(/-/g, '').slice(4);
        for (const P of [O, M1, M2, X]) {
          const text = allFrameText(P);
          for (const n of needles) assert(text.indexOf(n) < 0, P.name + ': "' + n + '" travelled to the rendezvous');
          assert(text.indexOf('p256:') < 0 && text.toLowerCase().indexOf(secret) < 0, P.name + ' sent a key or the secret half of the code');
          await assertNothingStored(P, kept.get(P), needles.concat(['p256:', lane]));
        }
        return leakCheck([O, M1, M2, X], { run0, needles, door });
      });
      await closeParties(ctx, [O, M1, M2, X]);
      return 'roster of three on three browsers, one lane (' + lane.slice(0, 8) + '), the fourth never reached; ' + leaks + ' [' + (Date.now() - t0) + ' ms]';
    },
  };

  return S;
}

export { StepError };
