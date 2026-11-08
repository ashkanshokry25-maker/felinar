// test/e2e/scenarios-lane.mjs: the relay lane of the apps (plan relay-first-2026-11-07, section 6.4; docs/APPS.md, "Messages through the
// rendezvous") through the real built loader, the real identity origin and the Node tracker as the door's rendezvous, all on 127.0.0.1, with
// test/e2e/obs-collector.mjs standing in for the usage report endpoint. Run with
// `node test/e2e/run.mjs --only LANE-1,LANE-2,LANE-3,LANE-4,LANE-5,LANE-6,LANE-7`.
//
//   LANE-1  relay when a direct link is impossible: a door whose block says relay rendezvous, direct on. Visitor B's Chromium cannot make a
//           direct link (a probe on a blank page proves it before the pairing, and proves that A can). After the accept the conversation connects
//           through the rendezvous within 10 s, a message crosses each way with Delivered and Read, inspect() shows via relay, the status line says
//           so, the tracker's counts show one relay lane and at least two frames, the reports hold apps.lane joined and apps.wire via relay, and
//           no report, log line, inspect() JSON, DOM text or frame sent to the reports collector holds the lane id in full or a message text
//   LANE-2  the same door, both visitors direct capable: via becomes direct within 10 s of the accept; the tracker has relayed only the frames sent
//           before the direct wire came up (none after it); messages both ways, each shown once
//   LANE-3  the same door with a rendezvous started without the relay (relayLane false, the tracker's --no-relay-lane): each side's join fails with
//           "relay is off on this rendezvous" and is reported once; the pair still connects directly; no error card
//   LANE-4  a door with relay none: no join at all (no pair-join sent, no apps.lane report), direct as before the relay existed, nothing relayed
//   LANE-5  the default door (relay rendezvous, direct absent) with BOTH visitors started without window.RTCPeerConnection (the shape of Tor
//           Browser): sign-in, code, knock, accept, messages both ways with Delivered and Read, via relay; run.start reports webrtc false; no error card
//   LANE-6  the default door with normal Chromium on both sides: no RTCPeerConnection is constructed on either page (two counters), the door names a
//           STUN server and none is contacted, the reports hold no ice event, no lane is announced to the tracker, messages both ways via relay
//   LANE-7  rooms through the relay (DECISIONS DEC-6: APPS-4 runs on the legacy door, A6): the shipped default door (no relay or direct token, which A2
//           resolves to relay rendezvous and direct off) with an owner and two members in three browser processes; the roster of three on all three; a
//           message from the owner and one from a member fan out to the other two over the relay, each shown once with the sender named (the sender's tick
//           says Sent: a room carries no per-member acks, so it shows no Delivered); no RTCPeerConnection on any page, no manager, no announce; the reports
//           hold room-join, apps.lane joined and apps.wire up via relay for the room; the lane id and the texts are in no report, log line, inspect() or page
//
// How a visitor cannot make a direct link (LANE-1): first choice is the launch argument --force-webrtc-ip-handling-policy=disable_non_proxied_udp
// with no proxy, which leaves the engine with no candidate at all. A probe (two peer connections in one blank page) checks it; when the engine
// still connects on loopback the visitor gets an init script that keeps every data channel closed instead. The scenario's output says which one ran
// (MW_E2E_LANE_BLOCK=arg or init forces one, to try the other).
//
// Which options name the tokens: the door is a dev server over the run's build (tools/dev-server.mjs, options appsRelay and appsDirect, the flags
// --apps-relay and --apps-direct) with the apps block and the obs block in its /_mw/door.json; the scenario reads the served door.json back and fails
// when the tokens are not what it asked for. Every scenario ends with the network policy (nothing left 127.0.0.1) and the secrets scan: the lane id
// (every 9 character window of it: the reporter's mask keeps 8), the sealed frames (three windows of each) and the message texts are looked for in the collector's bodies and rows,
// in inspect(), in the loader's log and the console, and in the page (text and attributes; a message text only where messages are drawn).
//
// Real clicks only, as in scenarios-apps.mjs: every button of the apps acts on a trusted click, so the scenarios press with the mouse and type with the
// keyboard. Chromium only. Each scenario opens its own browsers (two, three for LANE-7; separate processes, fresh profiles).

import { Visitor, launchChromium, waitUntil, sleep, StepError, shellState, clickLoaderCard, isLocalUrl, peerConnectionCount } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { createCollector, firstOf, inOrder, matchEvent, findLeaks } from './obs-collector.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { createTracker } from '../../tools/tracker.mjs';
import { appsText } from '../../src/loader/strings.js';

export const LANE_ORDER = ['LANE-1', 'LANE-2', 'LANE-3', 'LANE-4', 'LANE-5', 'LANE-6', 'LANE-7'];

const TX = (key, params) => appsText(key, 'en', params);
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const GROUP = '[' + ALPHA + ']{4}';
const CODE_RE = new RegExp('^' + GROUP + '-' + GROUP + '-' + GROUP + '$');
const SHORT_RE = new RegExp('^' + GROUP + '-' + GROUP + '$');
const LANE_RE = /^[0-9a-f]{40}$/;
const FRAME_RE = /^[A-Za-z0-9_-]{4,7700}$/;
// A marker in every message text: long enough that it never turns up in base64 by chance, so "never in the clear" is a real test.
const MARK = 'lane-e2e-q7kz';
// Plan 6.4: the conversation is connected through the rendezvous, or becomes direct, within this long of the accept.
const WITHIN_MS = 10000;
const STUN_NAMED = 'stun:stun.example.test:3478';
// Where a message text may be drawn: the lists of messages, the one-line preview of the last message in a list row, the quote above the composer.
const MESSAGE_REGIONS = '[data-role="messages"], [data-role="room-messages"], .mw-apps-row-prev, [data-role="replying"]';

// ---------------------------------------------------------------------------------------------
// init scripts (they run in every frame before any page script, after the run's own ICE-server stripping)
// ---------------------------------------------------------------------------------------------

/**
 * window.__mwLane: { made, alias, calls }. Counts the constructions of RTCPeerConnection and of its legacy name webkitRTCPeerConnection (the run's own
 * wrapper counts the first only, in window.__mwE2EPc), and the calls that only a made connection can take (createDataChannel, createOffer,
 * setLocalDescription, setRemoteDescription), so a page that reached the constructor another way is still seen.
 */
function laneWatch() {
  if (window.__mwLane) return;
  const W = { made: 0, alias: 0, calls: 0 };
  window.__mwLane = W;
  const wrap = (name, field) => {
    const Inner = window[name];
    if (typeof Inner !== 'function') return;
    const Wrapped = function RTCPeerConnection(...args) {
      W[field]++;
      return new Inner(...args);
    };
    Wrapped.prototype = Inner.prototype;
    Object.setPrototypeOf(Wrapped, Inner);
    window[name] = Wrapped;
  };
  wrap('RTCPeerConnection', 'made');
  wrap('webkitRTCPeerConnection', 'alias');
  const proto = typeof RTCPeerConnection === 'function' ? RTCPeerConnection.prototype : null;
  if (!proto) return;
  for (const m of ['createDataChannel', 'createOffer', 'setLocalDescription', 'setRemoteDescription']) {
    const orig = proto[m];
    if (typeof orig !== 'function') continue;
    proto[m] = function (...args) {
      W.calls++;
      return orig.apply(this, args);
    };
  }
}

/** The shape of Tor Browser: the WebRTC constructors are not there (window.RTCPeerConnection is undefined), so the loader reports webrtc false. */
function noRtc() {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
    try {
      delete window[name];
    } catch (_) { /* a property the engine keeps */ }
  }
}

/** The fallback of LANE-1: every data channel this page creates or is offered is closed at once, so no wire can ever open. */
function closedChannels() {
  const Inner = window.RTCPeerConnection;
  if (typeof Inner !== 'function' || Inner.__mwLaneClosed) return;
  const create = Inner.prototype.createDataChannel;
  Inner.prototype.createDataChannel = function (...args) {
    const dc = create.apply(this, args);
    try {
      dc.close();
    } catch (_) { /* already closing */ }
    return dc;
  };
  const Wrapped = function RTCPeerConnection(...args) {
    const pc = new Inner(...args);
    pc.addEventListener('datachannel', (e) => {
      try {
        e.channel.close();
      } catch (_) { /* already closing */ }
    });
    return pc;
  };
  Wrapped.prototype = Inner.prototype;
  Object.setPrototypeOf(Wrapped, Inner);
  Object.defineProperty(Wrapped, '__mwLaneClosed', { value: true });
  window.RTCPeerConnection = Wrapped;
}

/**
 * Runs in a blank page: two peer connections of this page try to open a data channel to each other on loopback. -> { candidates, opened, error }.
 * It stops at once when nothing can ever connect (no candidate after gathering, or the channel was closed), and after openMs otherwise.
 */
async function probeDirectInPage(openMs) {
  const out = { candidates: 0, opened: false, error: null };
  const pcs = [];
  try {
    const a = new RTCPeerConnection({ iceServers: [] });
    const b = new RTCPeerConnection({ iceServers: [] });
    pcs.push(a, b);
    a.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        out.candidates++;
        b.addIceCandidate(e.candidate).catch(() => {});
      }
    });
    b.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        out.candidates++;
        a.addIceCandidate(e.candidate).catch(() => {});
      }
    });
    const dc = a.createDataChannel('probe');
    dc.addEventListener('open', () => { out.opened = true; });
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    const end = Date.now() + openMs;
    let gatheredAt = 0;
    while (Date.now() < end && !out.opened) {
      const gathered = a.iceGatheringState === 'complete' && b.iceGatheringState === 'complete';
      if (gathered && !gatheredAt) gatheredAt = Date.now();
      // nothing can connect when no candidate came, or when the candidates had their moment (300 ms past the end of gathering) and no channel opened
      if (gathered && (out.candidates === 0 || Date.now() - gatheredAt > 300)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (err) {
    out.error = String((err && err.message) || err);
  }
  for (const pc of pcs) {
    try {
      pc.close();
    } catch (_) { /* gone */ }
  }
  return out;
}

/**
 * Runs in the page: where in the document each needle ({ id, v }) is. Text nodes and every attribute are looked at (open shadow roots too; the loader's
 * cards sit in a closed one and are not part of the page's own text). region: the hit lies inside a place where messages are drawn.
 * -> { scanned, hits: [{ id, where, region }] }
 */
function domScanInPage(arg) {
  const { needles, regions } = arg;
  const hits = [];
  let scanned = 0;
  const inRegion = (node) => {
    try {
      return !!(node && node.closest && node.closest(regions));
    } catch (_) {
      return false;
    }
  };
  const check = (value, where, region) => {
    scanned += value.length;
    for (const nd of needles) if (value.indexOf(nd.v) >= 0) hits.push({ id: nd.id, where, region });
  };
  const walk = (node) => {
    if (node.nodeType === 3) {
      check(node.nodeValue || '', 'text', inRegion(node.parentElement));
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) for (const at of Array.from(node.attributes)) check(at.name + '=' + at.value, 'attribute ' + at.name, inRegion(node));
    if (node.shadowRoot) walk(node.shadowRoot);
    for (const c of Array.from(node.childNodes)) walk(c);
  };
  walk(document.documentElement);
  check(document.title || '', 'title', false);
  return { scanned, hits };
}

// Runs in the page: the messages of a list as plain data: '[data-role="messages"]' (the open conversation) or '[data-role="room-messages"]' (the open
// room, LANE-7). `from` is the sender's label a room draws on another member's message; a conversation names nobody there.
function readMessages(listSel) {
  return Array.from(document.querySelectorAll(listSel + ' li[data-msg]')).map((li) => {
    const q = (s) => li.querySelector(s);
    const body = q('[data-role="body"]');
    const tick = q('[data-role="ticks"]') || q('[data-role="state"]');
    const from = q('[data-role="from"]');
    return {
      id: li.getAttribute('data-msg'),
      mine: li.getAttribute('data-mine') === '1',
      status: li.getAttribute('data-status') || '',
      text: body ? body.textContent : '',
      tick: tick ? (tick.getAttribute('aria-label') || tick.textContent) : null,
      from: from ? from.textContent : null,
    };
  });
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
  constructor(name, browser, visitor, page, tap) {
    this.name = name;
    this.browser = browser;
    this.v = visitor;
    this.page = page;
    this.tap = tap;
    this.short = null;
  }

  state() {
    return shellState(this.page);
  }

  async apps() {
    const s = await this.state();
    return s && s.apps ? s.apps : null;
  }

  async obs() {
    const s = await this.state();
    return s ? s.obs : null;
  }

  loc(sel) {
    return this.page.locator(sel + ':visible').first();
  }

  /** A real mouse click on the first visible match of sel. */
  async press(sel, timeoutMs = 15000) {
    const l = this.loc(sel);
    try {
      await l.waitFor({ state: 'visible', timeout: timeoutMs });
      await l.click({ timeout: 5000 });
    } catch (err) {
      throw new StepError(this.name + ': cannot press ' + sel + ': ' + String((err && err.message) || err).split('\n')[0]);
    }
  }

  async text(sel) {
    return (await this.loc(sel).innerText({ timeout: 5000 })).replace(/\s+/g, ' ').trim();
  }

  /** The text of the first visible match of sel, read in one step; '' when nothing matches (it never waits). */
  peek(sel) {
    return this.page.evaluate((q) => {
      const n = Array.from(document.querySelectorAll(q)).find((x) => x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden');
      return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
    }, sel);
  }

  count(sel) {
    return this.page.locator(sel + ':visible').count();
  }

  messages(listSel = '[data-role="messages"]') {
    return this.page.evaluate(readMessages, listSel);
  }

  /** The id the person sees for this page: a visit identity has no name, so the header is just "xxxx-xxxx". */
  async shortId() {
    const t = await this.text('[data-role="me"]');
    if (!SHORT_RE.test(t)) throw new StepError(this.name + ': the header is not a short id: ' + t);
    return t;
  }

  async close() {
    await this.v.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

/** laneScenarios({ run, assert, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function laneScenarios({ run, assert, headed = false }) {
  const S = {};
  const bad = (what, v) => what + ': ' + JSON.stringify(v);
  /** The English text of an apps string; a key the table does not have gives '' there, which every indexOf would find, so it fails here. */
  const must = (key, params) => {
    const t = TX(key, params);
    assert(typeof t === 'string' && t.length > 0, 'src/loader/strings.js has no English text for ' + key);
    return t;
  };

  // ---- the stack ------------------------------------------------------------------------------

  /** The collector, once per run; its address is what every door below names in its obs block. */
  async function kit(ctx, step) {
    if (ctx.shared.laneKit) return ctx.shared.laneKit;
    const k = await step('the collector: a loopback stand-in for the report endpoint (/e, /events.json, /tail) on the rules of deploy/obs-worker', async () => {
      const collector = await createCollector({});
      ctx.closers.push(() => collector.close());
      assert(collector.origin.startsWith('http://127.0.0.1:'), 'the collector is at ' + collector.origin);
      return { collector, validator: collector.validator, doors: new Map() };
    });
    ctx.shared.laneKit = k;
    return k;
  }

  /**
   * The door: a dev server over the run's build whose /_mw/door.json holds the apps block (the rendezvous, the stack's identity origin, a STUN list) with
   * the tokens asked for (relay, direct: undefined leaves the key out) and the obs block (the collector). The served file is read back: the tokens must
   * be there as asked and no other must be.
   */
  async function doorFor(ctx, step, { relay, direct, rendezvous = null, stun = [], label }) {
    const k = await kit(ctx, step);
    const { stack } = ctx;
    const where = rendezvous || stack.tracker.url;
    const key = JSON.stringify([relay, direct, where, stun]);
    if (k.doors.has(key)) return k.doors.get(key);
    const door = await step('the door (' + label + '): a dev server whose door.json has the apps block (' + (relay === undefined ? 'no relay token' : 'relay ' + relay) + ', ' + (direct === undefined ? 'no direct token' : 'direct ' + direct) + ') and the obs block', async () => {
      const options = {
        root: stack.dist, port: 0, host: '127.0.0.1', dev: true, quiet: true,
        appsRendezvous: [where], appsStun: stun, appsIdp: stack.idp.url, obs: k.collector.origin,
      };
      if (relay !== undefined) options.appsRelay = relay;
      if (direct !== undefined) options.appsDirect = direct;
      const dev = await createDevServer(options);
      ctx.closers.push(() => dev.close());
      const origin = new URL(dev.url).origin;
      k.collector.allowOrigin(origin);
      const json = await (await fetch(dev.url + '_mw/door.json')).json();
      assert(json.apps && json.apps.rendezvous[0] === where && json.apps.idp === stack.idp.url && JSON.stringify(json.apps.stun) === JSON.stringify(stun), bad('the served door.json apps block', json.apps));
      assert(json.apps.relay === relay && json.apps.direct === direct, bad('the tokens of the served door.json (asked relay ' + relay + ', direct ' + direct + '; tools/dev-server.mjs options appsRelay and appsDirect)', { relay: json.apps.relay, direct: json.apps.direct }));
      assert(json.obs && json.obs.endpoint === k.collector.origin, bad('the served door.json obs block', json.obs));
      return { dev, origin, page: dev.url + '_mw/open.html', rendezvous: where, idp: stack.idp.url, relay, direct };
    });
    k.doors.set(key, door);
    return door;
  }

  /** Closes the parties a failed scenario left open (kept so the run could print their logs). */
  async function closeLeftovers(ctx) {
    const left = ctx.shared.laneOpen || [];
    ctx.shared.laneOpen = [];
    for (const p of left) {
      if (ctx.visitors && typeof ctx.visitors.delete === 'function' && ctx.visitors.get(p.name) === p.v) ctx.visitors.delete(p.name);
      await p.close();
    }
  }

  /** A party in a Chromium process of its own (args: extra launch switches; initScripts: functions that run in every frame of its pages). */
  async function newParty(ctx, name, { args = [], initScripts = [] } = {}) {
    if (!ctx.shared.laneOpen) {
      ctx.shared.laneOpen = [];
      ctx.closers.push(() => closeLeftovers(ctx));
    }
    const browser = await launchChromium({ headless: !headed, args });
    const v = await Visitor.open(browser, name, run, { initScripts: [laneWatch].concat(initScripts) });
    if (ctx.visitors && typeof ctx.visitors.set === 'function') ctx.visitors.set(name, v); // a failing step prints its console and loader log
    const page = await v.newPage();
    const P = new Party(name, browser, v, page, tapPage(page));
    ctx.shared.laneOpen.push(P);
    return P;
  }

  async function closeParties(ctx, parties) {
    for (const p of parties) {
      if (ctx.visitors && typeof ctx.visitors.delete === 'function' && ctx.visitors.get(p.name) === p.v) ctx.visitors.delete(p.name);
      ctx.shared.laneOpen = (ctx.shared.laneOpen || []).filter((x) => x !== p);
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

  /** Polls the visible messages of a party (the open conversation, or the list `listSel` names) until pred(messages) is truthy; returns the messages. A timeout says what they were. */
  async function waitMessages(P, pred, label, timeoutMs = 30000, listSel = undefined) {
    let last = null;
    try {
      return await waitUntil(async () => {
        last = await P.messages(listSel);
        return pred(last) ? last : null;
      }, { timeoutMs, stepMs: 150, label: P.name + ': ' + label });
    } catch (err) {
      if (err instanceof StepError) err.message += ' (the messages then: ' + JSON.stringify((last || []).map((m) => [m.id.slice(0, 4), m.mine ? 'me' : 'peer', m.status, m.text.slice(0, 24)])).slice(0, 700) + ')';
      throw err;
    }
  }

  async function openDoor(P, door) {
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
   * Answers the price card of the given kind ('start', 'knock', 'accept', and the room kinds 'room-create', 'room-join', 'room-accept') with Continue,
   * after checking its words against the door's tokens (expect; apps-ui.js priceSpec): with relay rendezvous the card has the relay sentence, never the
   * direct-only text of before the relay, and then, as its own paragraph, either the sentence that the other person (the members) do not see your address
   * (direct off; apps.price.hidden, apps.price.hiddenRoom) or the direct line (direct on), never both (DECISIONS DEC-3 and DEC-8); with relay none the
   * direct-only text alone. On a door with the relay the next paragraph, on its own, is the sentence that the host of a rendezvous can be ordered to
   * record addresses (apps.price.hostOrder, CH-1 of the polish batch); the relay none card has no such paragraph (OD-5 A). A card that can be a first yes
   * names the report host; the accept cards carry the check line instead. whileShown() runs while the card is on screen (nothing has left the page yet);
   * mark: { at } gets the time of the click on Continue. Returns the card text.
   * One helper for the pair and the room cards (D-integrate folded LANE-7's room helper in here, so the rooms of LANE-7 are held to DEC-3 as well).
   */
  async function continueCard(P, kind, { collector, expect, mark = null, whileShown = null }) {
    await waitApps(P, (a) => a.card === kind, 'the ' + kind + ' card', 10000);
    const text = await P.text('[data-role="card"]');
    const accept = kind === 'accept' || kind === 'room-accept';
    const room = kind.indexOf('room') === 0;
    assert(text.indexOf(must(accept ? (room ? 'apps.accept.titleRoom' : 'apps.accept.title') : 'apps.price.title')) >= 0, P.name + ': the title of the ' + kind + ' card: ' + text);
    const relayKey = room ? 'apps.price.room' : 'apps.price.text';
    const directOnlyKey = room ? 'apps.price.roomDirect' : 'apps.price.textDirect';
    const relaySentence = must(relayKey);
    const directOnly = must(directOnlyKey);
    const hidden = must(room ? 'apps.price.hiddenRoom' : 'apps.price.hidden');
    const hostOrder = must('apps.price.hostOrder');
    const paras = await P.page.evaluate(() => Array.from(document.querySelectorAll('[data-role="card"] p')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
    if (expect.relay === 'none') {
      assert(text.indexOf(directOnly) >= 0 && text.indexOf(relaySentence) < 0, P.name + ': the ' + kind + ' card of a door with relay none does not show the direct-only text (' + directOnlyKey + ') alone: ' + text);
      assert(text.indexOf(hidden) < 0, P.name + ': the ' + kind + ' card of a door with relay none carries the relay card\'s sentence that the other side does not see the address: ' + text);
      // OD-5 A: relay none restores today's card, which has no sentence about the host being ordered to record addresses
      assert(text.indexOf(hostOrder) < 0, P.name + ': the ' + kind + ' card of a door with relay none carries the sentence that the host can be ordered to record addresses (apps.price.hostOrder): ' + text);
    } else {
      assert(text.indexOf(relaySentence) >= 0, P.name + ': the relay sentence (' + relayKey + ') is not on the ' + kind + ' card: ' + text);
      assert(text.indexOf(directOnly) < 0, P.name + ': the ' + kind + ' card carries the direct-only text (' + directOnlyKey + ') on a door with the relay: ' + text);
      const direct = expect.direct === 'on';
      assert((text.indexOf(must('apps.price.direct')) >= 0) === direct, P.name + ': the direct line (apps.price.direct) ' + (direct ? 'is missing from' : 'is on') + ' the ' + kind + ' card: ' + text);
      // DEC-3: the denial is a paragraph of its own right after the relay sentence when direct is off, and absent when direct is on
      assert(paras.includes(hidden) === !direct, P.name + ': the paragraph "' + hidden + '" ' + (direct ? 'is on' : 'is missing from') + ' the ' + kind + ' card, or is not a paragraph of its own: ' + JSON.stringify(paras));
      if (!direct) assert(paras.indexOf(hidden) === paras.indexOf(relaySentence) + 1, P.name + ': the denial does not follow the relay sentence on the ' + kind + ' card: ' + JSON.stringify(paras));
      // CH-1: that the host can be ordered to record addresses is a paragraph of its own, right after the denial (direct off) or the direct line (direct on)
      const beforeOrder = direct ? must('apps.price.direct') : hidden;
      assert(paras.indexOf(beforeOrder) >= 0 && paras.indexOf(hostOrder) === paras.indexOf(beforeOrder) + 1, P.name + ': the paragraph "' + hostOrder + '" does not follow "' + beforeOrder + '" on the ' + kind + ' card, or is not a paragraph of its own: ' + JSON.stringify(paras));
    }
    if (!accept) assert(text.indexOf(must('apps.price.reports', { host: collector.host })) >= 0, P.name + ': the ' + kind + ' card does not say where the usage reports go (' + collector.host + '): ' + text);
    assert((text.indexOf(must('apps.price.check')) >= 0) === accept, P.name + ': the check line (apps.price.check) ' + (accept ? 'is missing from' : 'is on') + ' the ' + kind + ' card: ' + text);
    if (whileShown) await whileShown();
    if (mark) mark.at = Date.now();
    await P.press('[data-role="card-continue"]');
    await waitApps(P, (a) => a.card === null, 'the ' + kind + ' card closes', 10000);
    return text;
  }

  // ---- what the pages sent and were sent ------------------------------------------------------

  /** Every JSON object a page sent ('out') or received ('in') on a WebSocket, with its time. */
  function framesJson(P, dir) {
    const out = [];
    for (const f of P.tap.frames) {
      if (f.dir !== dir || typeof f.payload !== 'string' || f.payload[0] !== '{') continue;
      try {
        out.push({ t: f.t, msg: JSON.parse(f.payload), raw: f.payload });
      } catch (_) { /* not JSON */ }
    }
    return out;
  }

  /** The lane ids (40 hex characters) the pages sent or were told, in any frame of the rendezvous socket. */
  function lanesOf(...parties) {
    const set = new Set();
    for (const P of parties) {
      for (const dir of ['in', 'out']) for (const { msg } of framesJson(P, dir)) if (msg && typeof msg.lane === 'string' && LANE_RE.test(msg.lane)) set.add(msg.lane);
    }
    return Array.from(set);
  }

  /** The relayed frames ("f" of a pair-relay request or a pair-relayed push) the pages wrote or got. */
  function framesOfRelay(...parties) {
    const set = new Set();
    for (const P of parties) {
      for (const dir of ['in', 'out']) {
        for (const { msg } of framesJson(P, dir)) if (msg && typeof msg.action === 'string' && /^(pair|room)-relay(ed)?$/.test(msg.action) && typeof msg.f === 'string') set.add(msg.f);
      }
    }
    return Array.from(set);
  }

  /** The relay actions a page sent, by name. */
  const sentActions = (P) => framesJson(P, 'out').map((f) => f.msg.action).filter((a) => typeof a === 'string' && /^(pair|room)-/.test(a));

  /** Windows of `len` characters of `text`: a needle for the whole of an id and for every part of it. */
  function windows(text, len, every = 1) {
    const out = [];
    for (let i = 0; i + len <= text.length; i += every) out.push(text.slice(i, i + len));
    return out;
  }

  /**
   * The needles of the secrets scan. lanes: every 9 character window of the lane id (the reporter's mask keeps 8, so nothing longer may be anywhere); frames:
   * the first, the middle and the last 32 characters of each relayed frame; texts: the whole message texts and the marker.
   */
  function secretsOf(parties, texts) {
    const lanes = lanesOf(...parties);
    const needles = { lane: [], frame: [], text: [] };
    for (const lane of lanes) {
      needles.lane.push(...windows(lane, 9));
      needles.lane.push(lane.toUpperCase());
    }
    for (const f of framesOfRelay(...parties)) {
      if (f.length < 64) continue;
      needles.frame.push(f.slice(0, 32), f.slice(Math.floor(f.length / 2) - 16, Math.floor(f.length / 2) + 16), f.slice(-32));
    }
    for (const t of texts.concat([MARK])) needles.text.push(t);
    return { lanes, needles };
  }

  /**
   * Looks for the secrets in what the plan lists (6.4 LANE-1): the collector's bodies as the pages sent them and the rows as stored, inspect() of each page
   * (its loader log is part of it), the console lines of each page, and the page itself. A lane id or a frame is nowhere; a message text is nowhere
   * but in the places where messages are drawn. Returns how many texts and characters were searched (proof that something was read).
   */
  async function assertNoSecrets(parties, collector, texts, label, { expectFrames = true } = {}) {
    const { lanes, needles } = secretsOf(parties, texts);
    assert(lanes.length === 1, label + ': the pages saw ' + lanes.length + ' lane ids (one is expected)');
    if (expectFrames) assert(needles.frame.length > 0, label + ': no relayed frame was seen on a socket (the scan of frames would prove nothing)');
    const forbidden = needles.lane.concat(needles.frame, needles.text);
    const kindOf = (n) => (needles.lane.indexOf(n) >= 0 ? 'the lane id' : needles.frame.indexOf(n) >= 0 ? 'a sealed frame' : 'a message text');
    /** Fails, naming where and what (never the whole secret), when `text` holds any needle of `list`. */
    const look = (where, text, list = forbidden) => {
      const hit = list.find((n) => text.indexOf(n) >= 0);
      if (hit !== undefined) assert(false, label + ': ' + where + ' holds ' + kindOf(hit) + ' (' + JSON.stringify(hit.slice(0, 8)) + '...)');
    };
    // The controls: the same search finds a lane id, a sealed frame and a message text put in a body (otherwise "none found" would prove nothing).
    const found = (text) => forbidden.find((n) => text.indexOf(n) >= 0);
    assert(found('{"x":"' + lanes[0].slice(4, 20) + '"}') !== undefined && found('{"t":"hello ' + texts[0] + '"}') !== undefined, label + ': the search does not see a lane id or a message text put in a body');
    if (needles.frame.length) assert(found('{"f":"' + framesOfRelay(...parties)[0] + '"}') !== undefined, label + ': the search does not see a frame put in a body');
    const bodies = collector.rawBodies().concat(collector.rows().map((row) => JSON.stringify(row)));
    assert(bodies.length > 0, label + ': the collector holds nothing');
    let searched = bodies.length;
    for (const text of bodies) look('a report', text);
    const leaks = findLeaks(bodies.join('\n'), { literals: lanes.concat(texts, [MARK]) });
    assert(!leaks.length, label + ': a report holds ' + leaks.slice(0, 4).join('; '));
    for (const P of parties) {
      const inspected = JSON.stringify(await P.state());
      assert(inspected && inspected.length > 100, P.name + ': inspect() came back empty');
      look(P.name + ' inspect()', inspected);
      look(P.name + ' console', P.v.lines.join('\n'));
      searched += 2;
      for (const view of ['conversation', 'list']) {
        if (view === 'list') {
          const a = await P.apps();
          // an open conversation goes back to the Messages list, an open room (LANE-7) to the Rooms list
          if (a.view === 'conversation' || a.view === 'room') {
            const list = a.view === 'room' ? 'rooms' : 'messages';
            await P.press('[data-role="back"]');
            await waitApps(P, (x) => x.view === list, 'back at the ' + list + ' list', 5000);
          }
        }
        const all = needles.lane.concat(needles.frame).map((v, i) => ({ id: 'secret' + i, v })).concat(needles.text.map((v, i) => ({ id: 'text' + i, v })));
        if (view === 'conversation') {
          // the control: the page scan sees a lane id put into the page (outside the lists) and the message texts where they are drawn (inside them)
          await P.page.evaluate((v) => { const n = document.createElement('p'); n.id = 'lane-scan-control'; n.textContent = 'control ' + v; document.body.appendChild(n); }, lanes[0]);
          const c = await P.page.evaluate(domScanInPage, { needles: all, regions: MESSAGE_REGIONS });
          await P.page.evaluate(() => { const n = document.getElementById('lane-scan-control'); if (n) n.remove(); });
          assert(c.hits.some((h) => /^secret/.test(h.id) && h.region === false), label + ': ' + P.name + ': the page scan does not see a lane id put into the page');
          assert(c.hits.some((h) => /^text/.test(h.id) && h.region === true), label + ': ' + P.name + ': the page scan does not see the messages drawn in the conversation');
        }
        const r = await P.page.evaluate(domScanInPage, { needles: all, regions: MESSAGE_REGIONS });
        assert(r.scanned > 200, P.name + ': the page scan read only ' + r.scanned + ' characters');
        searched += r.scanned;
        for (const h of r.hits) {
          if (!(/^text/.test(h.id) && h.region)) {
            assert(false, label + ': ' + P.name + ' (' + view + ' view) shows ' + (/^text/.test(h.id) ? 'a message text outside the places where messages are drawn' : 'a lane id or a sealed frame') + ' in ' + h.where);
          }
        }
      }
    }
    return searched;
  }

  /** The end-of-scenario network check: nothing left loopback, each page opened sockets to the rendezvous only, asked only the door, the identity origin and the collector. */
  function assertNetwork(parties, door, collector, run0) {
    assert(run.violations.length === run0, 'requests left 127.0.0.1: ' + JSON.stringify(run.violations.slice(run0)));
    const rendezvous = new URL(door.rendezvous).host;
    const origins = [door.origin, new URL(door.idp).origin, collector.origin];
    for (const P of parties) {
      for (const s of P.tap.sockets) assert(isLocalUrl(s.url) && new URL(s.url).host === rendezvous, P.name + ' opened a WebSocket to ' + s.url + ' (the rendezvous is ' + rendezvous + ')');
      for (const r of P.tap.requests) {
        assert(isLocalUrl(r.url), P.name + ' requested ' + r.url);
        if (/^https?:/.test(r.url)) assert(origins.indexOf(new URL(r.url).origin) >= 0, P.name + ' asked ' + r.url + ' (the door is ' + door.origin + ', the identity origin ' + origins[1] + ', the collector ' + collector.origin + ')');
      }
    }
  }

  // ---- the usage reports ----------------------------------------------------------------------

  /** settled(collector, pages): waits until every page has handed over what it holds and the collector holds exactly that. -> [{ obs, session }] */
  async function settled(collector, pages, label) {
    return waitUntil(async () => {
      const sessions = Array.from(collector.sessions().values());
      const out = [];
      for (const p of pages) {
        const o = await p.obs();
        const x = p.session(sessions);
        if (!o || !x || o.queued !== 0 || o.dropped !== 0 || o.sent === 0 || o.sent !== x.events.length) return null;
        out.push({ obs: o, session: x });
      }
      return out;
    }, { timeoutMs: 30000, stepMs: 250, label: label || 'every event the pages sent is in the collector' });
  }

  const mine = (P) => (sessions) => sessions.find((x) => x.who.includes(P.short));

  /** The sessions of the collector for the given parties (two, or the three of LANE-7), once everything they report is in. -> Map party -> session */
  async function sessionsFor(collector, parties) {
    await settled(collector, parties.map((P) => ({ obs: () => P.obs(), session: mine(P) })));
    const sessions = Array.from(collector.sessions().values());
    const out = new Map();
    for (const P of parties) {
      const found = sessions.filter((x) => x.who.includes(P.short));
      assert(found.length === 1, P.name + ' (' + P.short + ') is in ' + found.length + ' sessions of the collector');
      out.set(P, found[0]);
    }
    return out;
  }

  /** The sessions of the collector for the two parties, once everything they report is in. -> Map party -> session */
  const sessionsOf = (collector, A, B) => sessionsFor(collector, [A, B]);

  const count = (events, pattern) => events.filter((e) => matchEvent(e, pattern)).length;
  const noIce = (x, who) => assert(!x.events.some((e) => /^ice\./.test(e.n)), who + ' reported an ice event: ' + x.events.filter((e) => /^ice\./.test(e.n)).map((e) => e.n).slice(0, 4).join(' '));

  // ---- the flow every scenario shares ---------------------------------------------------------

  /**
   * Two parties meet: both open the door and sign in; A opens a code; B knocks with it typed in capitals and spaces; A accepts. Resolves when both show the
   * conversation connected. -> { code, tAccept: { at }, connectedAt } (tAccept.at is the moment of the click on the accept card's Continue).
   */
  async function meet(step, { A, B, door, collector }) {
    const expect = { relay: door.relay || 'rendezvous', direct: door.direct || (door.relay === 'none' ? 'on' : 'off') };
    await step('A and B open the door page and sign in for this visit', async () => {
      for (const P of [A, B]) {
        await openDoor(P, door);
        await signIn(P);
      }
      assert(A.short !== B.short, 'the same short id ' + A.short);
    });
    const code = await step('A: Messages shows the price card (the relay sentence for this door and the line that names the report host); Continue opens a code at the rendezvous', async () => {
      await A.press('[data-app="messages"]');
      await continueCard(A, 'start', { collector, expect });
      const a = await waitApps(A, (x) => x.code && x.link === 'open', 'a code and an open link', 20000);
      const shown = await A.text('[data-role="code"]');
      assert(CODE_RE.test(shown) && a.code === shown.slice(0, 4), bad('the code', [shown, a.code]));
      return shown;
    });
    await step('B: the price card, "Not now"; the code typed in capitals with spaces; the knock card; Continue sends the knock', async () => {
      await B.press('[data-app="messages"]');
      await waitApps(B, (x) => x.view === 'messages' && x.card === 'start', 'the price card', 10000);
      await B.press('[data-role="card-cancel"]');
      await waitApps(B, (x) => x.card === null, 'the card closes', 5000);
      await B.loc('[data-role="knock-input"]').fill(code.toUpperCase().replace(/-/g, ' '));
      await B.press('[data-role="knock-button"]');
      await continueCard(B, 'knock', { collector, expect });
      await waitApps(B, (x) => x.conversations.length === 1 && x.conversations[0].status === 'waiting', 'a waiting conversation', 20000);
    });
    const tAccept = { at: 0 };
    let connectedAt = 0;
    await step('A sees the request and accepts (the card repeats the price); both show the conversation connected', async () => {
      await waitApps(A, (x) => x.requests === 1, 'the request', 30000);
      await A.press('[data-role="requests"] [data-role="accept"]');
      await continueCard(A, 'accept', { collector, expect, mark: tAccept });
      await Promise.all([A, B].map((P) => waitApps(P, (x) => x.conversations.length === 1 && x.conversations[0].status === 'connected', 'connected', 45000)));
      connectedAt = Date.now();
    }, 60000);
    return { code, tAccept, connectedAt };
  }

  /** Both open the conversation. */
  async function openConversation(A, B) {
    for (const P of [A, B]) {
      await P.press('[data-role="conv-list"] [data-conv]');
      await waitApps(P, (x) => x.view === 'conversation', 'the conversation view', 5000);
    }
  }

  /**
   * A message crosses from `from` to `to`: it shows once at the receiver and Read (so Delivered before it) at the sender, whose tick says so. Both have the
   * conversation open on a visible page, so the receiver reads it at once. -> the id.
   */
  async function sendOne(from, to, text) {
    await from.loc('[data-role="composer"]').fill(text);
    await from.page.keyboard.press('Enter');
    const got = await waitMessages(to, (m) => m.some((x) => !x.mine && x.text === text), 'the message at ' + to.name);
    assert(got.filter((x) => x.text === text).length === 1, to.name + ' shows the message ' + got.filter((x) => x.text === text).length + ' times');
    const sent = await waitMessages(from, (m) => m.some((x) => x.mine && x.text === text && x.status === 'read'), 'the message is Read at ' + from.name, 30000);
    const mineMsg = sent.find((x) => x.mine && x.text === text);
    assert(sent.filter((x) => x.text === text).length === 1 && mineMsg.tick === must('apps.msg.read'), bad(from.name + ' tick of its message', mineMsg));
    return mineMsg.id;
  }

  /** The status line of a party's open conversation says `want`. */
  async function expectStatus(P, want, label) {
    await waitUntil(async () => ((await P.peek('[data-role="status-line"]')) === want ? true : null), { timeoutMs: 15000, stepMs: 150, label: P.name + ': the status line says "' + want + '" (' + label + ')' });
  }

  /** No error card: the loader's own is not shown, the apps show no card or closed note, and the composer works (a message was sent). */
  async function assertNoErrorCard(P) {
    const shown = await P.page.evaluate(() => {
      const e = document.querySelector('.mw-error:not([hidden])');
      const note = document.querySelector('[data-role="conv-note"]');
      return { error: e ? e.textContent.replace(/\s+/g, ' ').trim() : null, note: note ? note.textContent.trim() : '' };
    });
    assert(shown.error === null, P.name + ' shows an error card: ' + shown.error);
    assert(shown.note === '', P.name + ' shows a note under the conversation: ' + shown.note);
    const a = await P.apps();
    assert(a.card === null && a.conversations[0].status === 'connected', bad(P.name + ' conversation', a.conversations[0]));
  }

  /** The text of two messages of a scenario. */
  const textsOf = (tag) => ({ a: 'hello from A ' + MARK + '-' + tag, b: 'hello from B ' + MARK + '-' + tag, a2: 'and again from A ' + MARK + '-' + tag + '-2', b2: 'and again from B ' + MARK + '-' + tag + '-2' });

  /** A and B message each other twice each way, in turn. */
  async function talk(A, B, texts) {
    await sendOne(B, A, texts.b);
    await sendOne(A, B, texts.a);
    await sendOne(B, A, texts.b2);
    await sendOne(A, B, texts.a2);
  }

  /** The rendezvous' counts, read now; relay fields are numbers (a tracker without them is not the one of this build). */
  function relayStats(tracker) {
    const s = tracker.stats();
    for (const field of ['relays', 'relayed', 'relayBytes', 'relayBusy', 'relayRate', 'joinsRefused']) {
      assert(typeof s[field] === 'number', 'the rendezvous stats have no number ' + field + ' (deploy/rtc-worker/pair.js, plan 3.2): ' + JSON.stringify(Object.keys(s)));
    }
    return s;
  }

  /**
   * What a page sent to the rendezvous for the relay (plan 3.1): only these fields, frames within the size, f in the alphabet. `kind` is the prefix of the
   * actions, 'pair' (a conversation) or 'room' (LANE-7); `minRelays` is how many relay requests this page must have made (a room member who wrote nothing made 0).
   */
  function assertRelayWire(P, { joined = true, kind = 'pair', minRelays = 2 } = {}) {
    const re = new RegExp('^' + kind + '-(join|relay|leave)$');
    const out = framesJson(P, 'out').filter((f) => f.msg && re.test(String(f.msg.action)));
    const allowed = { [kind + '-join']: ['v', 'action', 'lane', 'rid'], [kind + '-relay']: ['v', 'action', 'lane', 'f', 'rid'], [kind + '-leave']: ['v', 'action', 'lane', 'rid'] };
    for (const { msg, raw } of out) {
      assert(Object.keys(msg).every((k) => allowed[msg.action].indexOf(k) >= 0), bad(P.name + ' ' + msg.action + ' carries other fields', Object.keys(msg)));
      assert(msg.v === 1 && LANE_RE.test(String(msg.lane)), bad(P.name + ' ' + msg.action, { v: msg.v, lane: typeof msg.lane }));
      if (msg.action === kind + '-relay') assert(FRAME_RE.test(String(msg.f)) && Buffer.byteLength(raw) <= 8192, P.name + ' relayed a frame outside the plan: ' + String(msg.f).length + ' characters, ' + Buffer.byteLength(raw) + ' bytes');
    }
    if (joined) {
      assert(out.some((f) => f.msg.action === kind + '-join'), P.name + ' sent no ' + kind + '-join');
      const relays = out.filter((f) => f.msg.action === kind + '-relay').length;
      assert(relays >= minRelays, P.name + ' sent ' + relays + ' ' + kind + '-relay requests (at least ' + minRelays + ' expected)');
    }
    for (const { msg } of framesJson(P, 'in')) {
      if (String(msg.action) === kind + '-relayed') assert(Object.keys(msg).sort().join() === 'action,f,lane' && FRAME_RE.test(msg.f) && LANE_RE.test(msg.lane), bad(P.name + ' got a ' + kind + '-relayed push of another shape', Object.keys(msg)));
    }
    return out.length;
  }

  /** A and B at the end of a scenario: close their browsers. */
  const finish = (ctx, parties) => closeParties(ctx, parties);

  // ------------------------------------------------------------------------------------------- LANE-1
  S['LANE-1'] = {
    title: 'relay: a door with relay rendezvous and direct on; B cannot make a direct link; the conversation connects through the rendezvous within 10 s, messages both ways Delivered and Read, via relay; counts, reports and a scan for the lane id, the frames and the texts',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      const door = await doorFor(ctx, step, { relay: 'rendezvous', direct: 'on', label: 'relay rendezvous, direct on' });
      const { collector } = k;
      const tracker = ctx.stack.tracker;
      collector.clear();
      const run0 = run.violations.length;
      const texts = textsOf('one');
      const [A, B, how] = await step('two browsers; the probe: A can make a direct link on loopback, B cannot (a launch argument, or an init script when the engine connects anyway)', async () => {
        const forced = process.env.MW_E2E_LANE_BLOCK || '';
        const a = await newParty(ctx, 'LANE1A');
        let b = null;
        let how = '';
        if (forced !== 'init') {
          b = await newParty(ctx, 'LANE1B', { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
          await b.page.goto('about:blank');
          const r = await b.page.evaluate(probeDirectInPage, 2500);
          if (r.opened) {
            assert(forced !== 'arg', 'the launch argument did not keep B from linking (' + JSON.stringify(r) + ')');
            await closeParties(ctx, [b]);
            b = null;
          } else {
            how = 'launch argument --force-webrtc-ip-handling-policy=disable_non_proxied_udp (' + r.candidates + ' candidates gathered)';
          }
        }
        if (!b) {
          b = await newParty(ctx, 'LANE1B', { initScripts: [closedChannels] });
          await b.page.goto('about:blank');
          const r = await b.page.evaluate(probeDirectInPage, 2500);
          assert(!r.opened, 'B can still make a direct link with the init script on: ' + JSON.stringify(r));
          how = 'init script that closes every data channel (' + r.candidates + ' candidates gathered)';
        }
        await a.page.goto('about:blank');
        const control = await a.page.evaluate(probeDirectInPage, 5000);
        assert(control.opened && control.candidates > 0, 'the positive control failed: A cannot make a direct link on loopback either: ' + JSON.stringify(control));
        return [a, b, how];
      }, 60000);
      return noted(collector, 'LANE-1', async () => {
        const base = relayStats(tracker);
        const m = await meet(step, { A, B, door, collector });
        const connectMs = m.connectedAt - m.tAccept.at;
        await step('connected through the rendezvous within 10 s of the accept; inspect() shows via relay on both; the status line says so', async () => {
          assert(connectMs <= WITHIN_MS, 'the conversation took ' + connectMs + ' ms to connect (the plan says ' + WITHIN_MS + ' ms)');
          for (const P of [A, B]) {
            const a = await P.apps();
            assert(a.conversations[0].via === 'relay', bad(P.name + ' inspect().apps.conversations[0].via (src/loader/apps-ui.js inspect() shows the service\'s via)', a.conversations[0]));
          }
          await openConversation(A, B);
          for (const P of [A, B]) await expectStatus(P, must('apps.status.relayed'), 'via relay');
        });
        await step('a message crosses each way, twice; each shows once at the receiver and is Read at the sender (Delivered before it)', () => talk(A, B, texts));
        await step('the rendezvous counted one relay lane and at least two relayed frames, hit no cap, and the pages sent only the fields and sizes of the plan', async () => {
          const s = relayStats(tracker);
          assert(s.relays - base.relays === 1, bad('relay lanes (now minus before)', { now: s.relays, before: base.relays }));
          assert(s.relayed - base.relayed >= 2, bad('relayed frames (now minus before)', { now: s.relayed, before: base.relayed }));
          assert(s.relayBytes > base.relayBytes, bad('relayBytes', { now: s.relayBytes, before: base.relayBytes }));
          assert(s.relayBusy === base.relayBusy && s.relayRate === base.relayRate && s.joinsRefused === base.joinsRefused, bad('a cap was hit by honest traffic', { now: s, before: base }));
          for (const P of [A, B]) assertRelayWire(P);
        });
        const sess = await step('the reports of both pages hold apps.lane joined, apps.wire up via relay and apps.conv connected via relay, and messages Delivered and Read', async () => {
          const out = await sessionsOf(collector, A, B);
          for (const [P, x] of out) {
            const r = inOrder(x.events, ['run.start', { n: 'link.sent', action: 'pair-join' }, { n: 'apps.lane', ev: 'joined' }, { n: 'apps.wire', ev: 'up', via: 'relay' }, { n: 'apps.conv', status: 'connected', via: 'relay' }]);
            assert(r.ok, P.name + ': ' + r.link + ' is not after ' + r.after + ' in ' + x.events.map((e) => e.n + (e.ev ? ':' + e.ev : e.status ? ':' + e.status : '')).join(' ').slice(0, 900));
            assert(firstOf(x.events, { n: 'link.reply', action: 'pair-join', ok: true }) && firstOf(x.events, { n: 'link.reply', action: 'pair-relay', ok: true }), P.name + ': no successful pair-join and pair-relay reply in the reports');
            assert(firstOf(x.events, { n: 'apps.msg', status: 'delivered' }) && firstOf(x.events, { n: 'apps.msg', status: 'read' }), P.name + ': the reports do not hold Delivered and Read');
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.wire', via: 'direct', ev: 'up' })), P.name + ' reported a direct wire up although B cannot make one');
          }
          return out;
        });
        const searched = await step('no report, log line, inspect() JSON, page or collector frame holds the lane id (nor any 9 characters of it: the reporter keeps 8), a sealed frame or a message text outside the message lists', () => assertNoSecrets([A, B], collector, Object.values(texts), 'LANE-1'));
        await step('nothing left 127.0.0.1, and the rendezvous never saw a message text in the clear', async () => {
          assertNetwork([A, B], door, collector, run0);
          for (const P of [A, B]) for (const dir of ['in', 'out']) assert(P.tap.frames.filter((f) => f.dir === dir).every((f) => f.payload.indexOf(MARK) < 0), P.name + ' ' + dir + ': a message marker is in a frame of the rendezvous socket');
        });
        const lines = [A, B].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [A, B]);
        return 'B could not link directly (' + how + '); connected via relay in ' + connectMs + ' ms (target ' + WITHIN_MS + ' ms met); ' + lines + '; ' + searched + ' texts and characters searched for the lane id, frames and texts, none found';
      });
    },
  };

  /** noted(collector, id, fn): a failing step says what the collector held, and MW_E2E_OBS_DUMP=<prefix> writes its rows (as scenarios-obs.mjs does). */
  async function noted(collector, id, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StepError) err.message += ' [the collector held ' + collector.brief() + ']';
      throw err;
    } finally {
      const prefix = process.env.MW_E2E_OBS_DUMP;
      if (prefix) {
        try {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(prefix + '-' + id + '.jsonl', collector.rows().map((row) => JSON.stringify(row)).join('\n') + '\n');
        } catch (_) { /* a dump is a convenience */ }
      }
    }
  }

  // ------------------------------------------------------------------------------------------- LANE-2
  S['LANE-2'] = {
    title: 'relay then direct: the same door, both visitors direct capable; via becomes direct within 10 s of the accept; the rendezvous has relayed only the frames sent before the direct wire came up; messages both ways, each shown once',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      const door = await doorFor(ctx, step, { relay: 'rendezvous', direct: 'on', label: 'relay rendezvous, direct on' });
      const { collector } = k;
      const tracker = ctx.stack.tracker;
      collector.clear();
      const run0 = run.violations.length;
      const texts = textsOf('two');
      const [A, B] = await step('two browsers, A and B (separate processes, fresh profiles)', async () => [await newParty(ctx, 'LANE2A'), await newParty(ctx, 'LANE2B')]);
      return noted(collector, 'LANE-2', async () => {
        const base = relayStats(tracker);
        const m = await meet(step, { A, B, door, collector });
        let directMs = 0;
        await step('via becomes direct on both within 10 s of the accept (the relay carried the first frames)', async () => {
          await Promise.all([A, B].map((P) => waitApps(P, (x) => x.conversations[0].via === 'direct', 'via direct', 30000)));
          directMs = Date.now() - m.tAccept.at;
          assert(directMs <= WITHIN_MS, 'the direct link took ' + directMs + ' ms (the plan says ' + WITHIN_MS + ' ms)');
        }, 60000);
        let before = null;
        await step('the status line says "Connected to you now"; the relay has carried only a few frames, and none after the direct wire came up', async () => {
          await openConversation(A, B);
          for (const P of [A, B]) await expectStatus(P, must('apps.status.connected'), 'via direct');
          await sleep(700); // a frame already on its way through the relay when the wire came up
          before = relayStats(tracker);
          assert(before.relayed - base.relayed <= 12, bad('frames relayed before the direct wire (now minus before)', { now: before.relayed, before: base.relayed }));
        });
        await step('messages both ways, twice each, over the direct wire: each shows once, Read at the sender; the relayed count does not move', async () => {
          await talk(A, B, texts);
          const after = relayStats(tracker);
          assert(after.relayed === before.relayed && after.relayBytes === before.relayBytes, bad('frames relayed after the direct wire came up', { now: after.relayed, before: before.relayed }));
          for (const P of [A, B]) assert((await P.apps()).conversations[0].via === 'direct', P.name + ' went back to ' + (await P.apps()).conversations[0].via);
        });
        await step('the control for LANE-5 and LANE-6: on this door the counters do see peer connections and the reports do hold ice events', async () => {
          for (const P of [A, B]) {
            const w = await P.page.evaluate(() => window.__mwLane);
            assert((await peerConnectionCount(P.page)) > 0 && w && w.made > 0 && w.calls > 0, bad(P.name + ' peer connection counters on a door with direct on (the run\'s wrapper, made, calls)', [await peerConnectionCount(P.page), w]));
          }
        });
        const sess = await step('the reports hold apps.lane joined, then apps.wire up via relay, then apps.wire up via direct, and apps.conv connected; no wire was killed', async () => {
          const out = await sessionsOf(collector, A, B);
          for (const [P, x] of out) {
            assert(x.events.some((e) => /^ice\./.test(e.n)), P.name + ' reported no ice event although it made peer connections');
            const r = inOrder(x.events, [{ n: 'apps.lane', ev: 'joined' }, { n: 'apps.wire', ev: 'up', via: 'relay' }, { n: 'apps.wire', ev: 'up', via: 'direct' }]);
            assert(r.ok, P.name + ': ' + r.link + ' is not after ' + r.after + ' in ' + x.events.map((e) => e.n + (e.ev ? ':' + e.ev : e.status ? ':' + e.status : '')).join(' ').slice(0, 900));
            assert(firstOf(x.events, { n: 'apps.conv', status: 'connected' }), P.name + ' reported no conversation connected');
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.wire', ev: 'kill' })), P.name + ' killed a wire');
          }
          return out;
        });
        const searched = await step('the lane id, the sealed frames and the message texts are in no report, log line, inspect() JSON or page', () => assertNoSecrets([A, B], collector, Object.values(texts), 'LANE-2', { expectFrames: false }));
        await step('nothing left 127.0.0.1', async () => assertNetwork([A, B], door, collector, run0));
        const lines = [A, B].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [A, B]);
        return 'relay first, direct at ' + directMs + ' ms (target ' + WITHIN_MS + ' ms met); relayed ' + (before.relayed - base.relayed) + ' frames before the direct wire and none after; ' + lines + '; ' + searched + ' texts and characters searched, none found';
      });
    },
  };

  // ------------------------------------------------------------------------------------------- LANE-3
  S['LANE-3'] = {
    title: 'relay off at the rendezvous: the door asks for relay rendezvous and direct on, the rendezvous was started without the relay lane; each join fails with "relay is off" and is reported once per side; the pair still connects directly; no error card',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      const { collector } = k;
      if (!k.noRelay) {
        k.noRelay = await step('a rendezvous of its own, the Node tracker started with relayLane false (--no-relay-lane)', async () => {
          const t = await createTracker({ port: 0, open: true, quiet: true, relayLane: false });
          ctx.closers.push(() => t.close());
          assert(t.pairing === true, 'the tracker does not serve the pairing protocol (deploy/rtc-worker/pair.js)');
          return t;
        });
      }
      const tracker = k.noRelay;
      const door = await doorFor(ctx, step, { relay: 'rendezvous', direct: 'on', rendezvous: tracker.url, label: 'relay rendezvous, direct on, rendezvous without the relay' });
      collector.clear();
      const run0 = run.violations.length;
      const texts = textsOf('three');
      const [A, B] = await step('two browsers, A and B (separate processes, fresh profiles)', async () => [await newParty(ctx, 'LANE3A'), await newParty(ctx, 'LANE3B')]);
      return noted(collector, 'LANE-3', async () => {
        const base = relayStats(tracker);
        const m = await meet(step, { A, B, door, collector });
        await step('connected directly on both (the relay was refused, the lane swarm connected them); no error card, no note, the status line says "Connected to you now"', async () => {
          for (const P of [A, B]) await waitApps(P, (x) => x.conversations[0].via === 'direct', 'via direct', 30000);
          await openConversation(A, B);
          for (const P of [A, B]) {
            await expectStatus(P, must('apps.status.connected'), 'direct');
            await assertNoErrorCard(P);
          }
        }, 60000);
        await step('messages both ways, twice each: each shows once, Read at the sender', () => talk(A, B, texts));
        await step('the rendezvous refused two joins (one per side) and carried no relay lane and no frame', async () => {
          const s = relayStats(tracker);
          assert(s.joinsRefused - base.joinsRefused === 2, bad('joins refused (now minus before)', { now: s.joinsRefused, before: base.joinsRefused }));
          assert(s.relays === 0 && s.relayed === base.relayed && s.relayBytes === base.relayBytes, bad('the rendezvous without the relay relayed', s));
          for (const P of [A, B]) assert(sentActions(P).filter((a) => a === 'pair-relay').length === 0, P.name + ' relayed a frame to a rendezvous that has the relay off');
        });
        const sess = await step('the reports hold one failed pair-join reply ("relay is off on this rendezvous") and one apps.lane off per side, then apps.wire up via direct', async () => {
          const out = await sessionsOf(collector, A, B);
          for (const [P, x] of out) {
            const failed = x.events.filter((e) => matchEvent(e, { n: 'link.reply', action: 'pair-join', ok: false }));
            assert(failed.length === 1 && failed[0].reason === 'relay-is-off-on-this-rendezvous', bad(P.name + ' failed pair-join replies', failed.map((e) => e.reason)));
            assert(count(x.events, { n: 'apps.lane', ev: 'off' }) === 1, bad(P.name + ' apps.lane off', x.events.filter((e) => e.n === 'apps.lane').map((e) => e.ev)));
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.wire', via: 'relay' })), P.name + ' reported a relay wire');
            const r = inOrder(x.events, [{ n: 'apps.lane', ev: 'off' }, { n: 'apps.wire', ev: 'up', via: 'direct' }, { n: 'apps.conv', status: 'connected', via: 'direct' }]);
            assert(r.ok, P.name + ': ' + r.link + ' is not after ' + r.after);
          }
          return out;
        });
        const searched = await step('the lane id and the message texts are in no report, log line, inspect() JSON or page', () => assertNoSecrets([A, B], collector, Object.values(texts), 'LANE-3', { expectFrames: false }));
        await step('nothing left 127.0.0.1', async () => assertNetwork([A, B], door, collector, run0));
        const lines = [A, B].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [A, B]);
        return 'the rendezvous refused the relay (2 joins, "relay is off"), the pair connected directly in ' + (m.connectedAt - m.tAccept.at) + ' ms; ' + lines + '; ' + searched + ' texts and characters searched, none found';
      });
    },
  };

  // ------------------------------------------------------------------------------------------- LANE-4
  S['LANE-4'] = {
    title: 'relay none: a door with relay none sends no pair-join and reports no apps.lane; the pair connects directly as before the relay existed and nothing is relayed',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      const door = await doorFor(ctx, step, { relay: 'none', label: 'relay none, direct absent (which means direct on)' });
      const { collector } = k;
      const tracker = ctx.stack.tracker;
      collector.clear();
      const run0 = run.violations.length;
      const texts = textsOf('four');
      const [A, B] = await step('two browsers, A and B (separate processes, fresh profiles)', async () => [await newParty(ctx, 'LANE4A'), await newParty(ctx, 'LANE4B')]);
      return noted(collector, 'LANE-4', async () => {
        const base = relayStats(tracker);
        const m = await meet(step, { A, B, door, collector });
        await step('connected directly on both: via direct, "Connected to you now"', async () => {
          for (const P of [A, B]) await waitApps(P, (x) => x.conversations[0].via === 'direct', 'via direct', 30000);
          await openConversation(A, B);
          for (const P of [A, B]) await expectStatus(P, must('apps.status.connected'), 'direct');
        }, 60000);
        await step('messages both ways, twice each: each shows once, Read at the sender', () => talk(A, B, texts));
        await step('no pair-join, pair-relay or pair-leave was sent, and the rendezvous relayed and refused nothing', async () => {
          for (const P of [A, B]) {
            const relayActions = sentActions(P).filter((a) => /^(pair|room)-(join|relay|leave)$/.test(a));
            assert(relayActions.length === 0, P.name + ' sent ' + relayActions.join(', '));
            assert(sentActions(P).some((a) => a === 'pair-open' || a === 'pair-knock'), P.name + ' sent no pairing action (the control that sentActions sees the frames)');
          }
          const s = relayStats(tracker);
          assert(s.relays === base.relays && s.relayed === base.relayed && s.joinsRefused === base.joinsRefused && s.relayBytes === base.relayBytes, bad('the rendezvous counts changed (now, before)', { now: s, before: base }));
        });
        const sess = await step('the reports hold no pair-join in link.sent and no apps.lane; the wire went up via direct', async () => {
          const out = await sessionsOf(collector, A, B);
          for (const [P, x] of out) {
            assert(count(x.events, { n: 'link.sent', action: 'pair-join' }) === 0 && count(x.events, { n: 'link.sent', action: 'pair-relay' }) === 0, P.name + ' reported a pair-join or pair-relay in link.sent');
            assert(count(x.events, { n: 'link.sent', action: 'pair-open' }) + count(x.events, { n: 'link.sent', action: 'pair-knock' }) >= 1, P.name + ' reported no pair-open or pair-knock (the control that the reports see link.sent)');
            assert(count(x.events, 'apps.lane') === 0, P.name + ' reported apps.lane: ' + x.events.filter((e) => e.n === 'apps.lane').map((e) => e.ev).join(' '));
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.wire', via: 'relay' })), P.name + ' reported a relay wire');
            assert(firstOf(x.events, { n: 'apps.wire', ev: 'up', via: 'direct' }) && firstOf(x.events, { n: 'apps.conv', status: 'connected', via: 'direct' }), P.name + ' reported no direct wire up and conversation connected via direct');
          }
          return out;
        });
        const searched = await step('the lane id and the message texts are in no report, log line or page', () => assertNoSecrets([A, B], collector, Object.values(texts), 'LANE-4', { expectFrames: false }));
        await step('nothing left 127.0.0.1', async () => assertNetwork([A, B], door, collector, run0));
        const lines = [A, B].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [A, B]);
        return 'no pair-join; direct as before, connected in ' + (m.connectedAt - m.tAccept.at) + ' ms; nothing relayed; ' + lines + '; ' + searched + ' texts and characters searched, none found';
      });
    },
  };

  // ------------------------------------------------------------------------------------------- LANE-5
  S['LANE-5'] = {
    title: 'no WebRTC at all: the default door (relay rendezvous, direct absent) with both visitors started without window.RTCPeerConnection (the shape of Tor Browser); sign-in, code, knock, accept and messages both ways, Delivered and Read, via relay; run.start reports webrtc false; no error card',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      const door = await doorFor(ctx, step, { relay: 'rendezvous', label: 'relay rendezvous, direct absent (which means direct off)' });
      const { collector } = k;
      const tracker = ctx.stack.tracker;
      collector.clear();
      const run0 = run.violations.length;
      const texts = textsOf('five');
      const [A, B] = await step('two browsers whose pages have no RTCPeerConnection (an init script deletes it before any page script)', async () => {
        const out = [await newParty(ctx, 'LANE5A', { initScripts: [noRtc] }), await newParty(ctx, 'LANE5B', { initScripts: [noRtc] })];
        for (const P of out) {
          await P.page.goto('about:blank');
          const t = await P.page.evaluate(() => [typeof window.RTCPeerConnection, typeof window.webkitRTCPeerConnection, typeof window.RTCDataChannel]);
          assert(t.join() === 'undefined,undefined,undefined', bad(P.name + ' still has WebRTC (typeof RTCPeerConnection, webkitRTCPeerConnection, RTCDataChannel)', t));
        }
        return out;
      });
      return noted(collector, 'LANE-5', async () => {
        const base = relayStats(tracker);
        const m = await meet(step, { A, B, door, collector });
        const connectMs = m.connectedAt - m.tAccept.at;
        await step('connected through the rendezvous within 10 s of the accept; via relay on both; no manager was made; no error card; the status line says so', async () => {
          assert(connectMs <= WITHIN_MS, 'the conversation took ' + connectMs + ' ms to connect (the plan says ' + WITHIN_MS + ' ms)');
          for (const P of [A, B]) {
            const a = await P.apps();
            assert(a.conversations[0].via === 'relay' && a.tm === false, bad(P.name + ' via and manager', { via: a.conversations[0].via, tm: a.tm }));
          }
          await openConversation(A, B);
          for (const P of [A, B]) {
            await expectStatus(P, must('apps.status.relayed'), 'via relay');
            await assertNoErrorCard(P);
          }
        });
        await step('messages both ways, twice each: each shows once, Read at the sender (Delivered before it)', () => talk(A, B, texts));
        await step('no peer connection, no announce and no lane swarm: the pages never had a constructor to call', async () => {
          for (const P of [A, B]) {
            assert((await peerConnectionCount(P.page)) === 0, P.name + ' made a peer connection');
            assert(P.v.announces.length === 0, bad(P.name + ' announced a lane', P.v.announces));
            assert(framesJson(P, 'out').every((f) => f.msg.action !== 'announce'), P.name + ' sent an announce to the rendezvous');
          }
          const s = relayStats(tracker);
          assert(s.relays - base.relays === 1 && s.relayed - base.relayed >= 2, bad('the rendezvous counts (now, before)', { now: s, before: base }));
          for (const P of [A, B]) assertRelayWire(P);
        });
        const sess = await step('the reports hold run.start with webrtc false on both, apps.wire up via relay, and no ice event', async () => {
          const out = await sessionsOf(collector, A, B);
          for (const [P, x] of out) {
            const start = firstOf(x.events, { n: 'run.start' });
            assert(start && start.webrtc === false, bad(P.name + ' run.start', start));
            noIce(x, P.name);
            const r = inOrder(x.events, [{ n: 'apps.lane', ev: 'joined' }, { n: 'apps.wire', ev: 'up', via: 'relay' }, { n: 'apps.conv', status: 'connected', via: 'relay' }]);
            assert(r.ok, P.name + ': ' + r.link + ' is not after ' + r.after);
            assert(firstOf(x.events, { n: 'apps.msg', status: 'delivered' }) && firstOf(x.events, { n: 'apps.msg', status: 'read' }), P.name + ': the reports do not hold Delivered and Read');
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.lane', ev: 'direct-unavailable' })), P.name + ' reported direct-unavailable (direct is off on this door, so it is not asked for)');
          }
          return out;
        });
        const searched = await step('the lane id, the sealed frames and the message texts are in no report, log line, inspect() JSON or page', () => assertNoSecrets([A, B], collector, Object.values(texts), 'LANE-5'));
        await step('nothing left 127.0.0.1', async () => assertNetwork([A, B], door, collector, run0));
        const lines = [A, B].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [A, B]);
        return 'no RTCPeerConnection on either page; connected via relay in ' + connectMs + ' ms (target ' + WITHIN_MS + ' ms met); run.start webrtc false; ' + lines + '; ' + searched + ' texts and characters searched, none found';
      });
    },
  };

  // ------------------------------------------------------------------------------------------- LANE-6
  S['LANE-6'] = {
    title: 'direct off means no WebRTC: the default door with normal Chromium on both sides makes no RTCPeerConnection on either page, contacts no STUN server (the door names one), reports no ice event, announces no lane; messages both ways via relay',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      const door = await doorFor(ctx, step, { relay: 'rendezvous', stun: [STUN_NAMED], label: 'relay rendezvous, direct absent, and a STUN server named' });
      const { collector } = k;
      const tracker = ctx.stack.tracker;
      collector.clear();
      const run0 = run.violations.length;
      const texts = textsOf('six');
      const [A, B] = await step('two browsers, A and B (separate processes, fresh profiles), both with WebRTC', async () => {
        const out = [await newParty(ctx, 'LANE6A'), await newParty(ctx, 'LANE6B')];
        for (const P of out) {
          await P.page.goto('about:blank');
          assert((await P.page.evaluate(() => typeof window.RTCPeerConnection)) === 'function', P.name + ' has no RTCPeerConnection (the scenario needs a browser that does)');
        }
        return out;
      });
      return noted(collector, 'LANE-6', async () => {
        const base = relayStats(tracker);
        const m = await meet(step, { A, B, door, collector });
        const connectMs = m.connectedAt - m.tAccept.at;
        await step('connected through the rendezvous within 10 s of the accept; via relay on both; no manager was made', async () => {
          assert(connectMs <= WITHIN_MS, 'the conversation took ' + connectMs + ' ms to connect (the plan says ' + WITHIN_MS + ' ms)');
          for (const P of [A, B]) {
            const a = await P.apps();
            assert(a.conversations[0].via === 'relay' && a.tm === false, bad(P.name + ' via and manager', { via: a.conversations[0].via, tm: a.tm }));
          }
          await openConversation(A, B);
          for (const P of [A, B]) await expectStatus(P, must('apps.status.relayed'), 'via relay');
        });
        await step('messages both ways, twice each: each shows once, Read at the sender', () => talk(A, B, texts));
        await step('no RTCPeerConnection was constructed on either page (the run\'s wrapper, the legacy name, and the calls only a connection can take), no ICE server was loaded, no lane was announced', async () => {
          for (const P of [A, B]) {
            assert((await peerConnectionCount(P.page)) === 0, P.name + ' constructed ' + (await peerConnectionCount(P.page)) + ' peer connections (the run\'s wrapper)');
            const w = await P.page.evaluate(() => window.__mwLane);
            assert(w && w.made === 0 && w.alias === 0 && w.calls === 0, bad(P.name + ' peer connection use (made, alias, calls)', w));
            const st = await P.state();
            assert(!st.iceServers || st.iceServers.length === 0, bad(P.name + ': the loader lists ICE servers although the door names ' + STUN_NAMED, st.iceServers));
            assert(P.v.announces.length === 0 && framesJson(P, 'out').every((f) => f.msg.action !== 'announce'), P.name + ' announced a lane to the rendezvous');
          }
          const s = relayStats(tracker);
          assert(s.relays - base.relays === 1 && s.relayed - base.relayed >= 2, bad('the rendezvous counts (now, before)', { now: s, before: base }));
          assert(!ctx.stack.tracker.announces.some((x) => x.t >= m.tAccept.at && lanesOf(A, B).indexOf(String(x.btih)) >= 0), 'the tracker saw an announce for the pair\'s lane');
          for (const P of [A, B]) assertRelayWire(P);
        });
        const sess = await step('the reports hold run.start with webrtc true (the page could, and did not), no ice event, apps.wire up via relay', async () => {
          const out = await sessionsOf(collector, A, B);
          for (const [P, x] of out) {
            const start = firstOf(x.events, { n: 'run.start' });
            assert(start && start.webrtc === true, bad(P.name + ' run.start', start));
            noIce(x, P.name);
            assert(!x.events.some((e) => /^(ice|peer)\./.test(e.n)), P.name + ' reported a peer event: ' + x.events.filter((e) => /^(ice|peer)\./.test(e.n)).map((e) => e.n).slice(0, 4).join(' '));
            assert(firstOf(x.events, { n: 'apps.wire', ev: 'up', via: 'relay' }) && !x.events.some((e) => matchEvent(e, { n: 'apps.wire', via: 'direct' })), P.name + ': the reports do not show a relay wire alone');
          }
          return out;
        });
        const searched = await step('the lane id, the sealed frames and the message texts are in no report, log line, inspect() JSON or page', () => assertNoSecrets([A, B], collector, Object.values(texts), 'LANE-6'));
        await step('nothing left 127.0.0.1: no STUN host, no other host (the run\'s network guard saw no request or socket off loopback)', async () => assertNetwork([A, B], door, collector, run0));
        const lines = [A, B].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [A, B]);
        return 'zero peer connections on both pages with a STUN server named; connected via relay in ' + connectMs + ' ms (target ' + WITHIN_MS + ' ms met); ' + lines + '; ' + searched + ' texts and characters searched, none found';
      });
    },
  };

  // ------------------------------------------------------------------------------------------- LANE-7
  // DECISIONS DEC-6 (I2 Unresolved 1): APPS-4 proves a room on the direct wire of the legacy door (A6), so this scenario proves a room through the relay.

  /** The messages of a party's open room (the list the room draws). */
  const waitRoomMessages = (P, pred, label, timeoutMs = 30000) => waitMessages(P, pred, label, timeoutMs, '[data-role="room-messages"]');

  /**
   * A room message crosses from `from` to every party of `to`: shown once at each, with the sender named; at the sender it is its own and its tick says
   * Sent. A room carries no per-member acks (apps.js reports a room's messages as queued, sent and received only), so no Delivered is shown and none is asked for. -> the id
   */
  async function roomSend(from, to, text) {
    await from.loc('[data-role="room-composer"]').fill(text);
    await from.page.keyboard.press('Enter');
    for (const P of to) {
      const got = await waitRoomMessages(P, (m) => m.some((x) => !x.mine && x.text === text), 'the room message of ' + from.name + ' at ' + P.name);
      const hits = got.filter((x) => x.text === text);
      assert(hits.length === 1 && hits[0].from === from.short, bad(P.name + ' shows the message of ' + from.name + ' (once, with the sender named)', hits.map((x) => [x.mine, x.from, x.status])));
    }
    const sent = await waitRoomMessages(from, (m) => m.some((x) => x.mine && x.text === text && x.status === 'sent'), 'the message is Sent at ' + from.name);
    const mineMsg = sent.find((x) => x.mine && x.text === text);
    assert(sent.filter((x) => x.text === text).length === 1 && mineMsg.tick === must('apps.msg.sent') && mineMsg.from === null, bad(from.name + ' its own room message', mineMsg));
    return mineMsg.id;
  }

  /** The roster a party's room draws: [{ pub, label, marks }]. */
  const readRoster = (P) => P.page.evaluate(() => Array.from(document.querySelectorAll('[data-role="roster"] li.mw-apps-member')).map((li) => ({
    pub: li.getAttribute('data-pub'),
    label: li.firstElementChild ? li.firstElementChild.textContent : '',
    marks: Array.from(li.querySelectorAll('.mw-apps-mark')).map((m) => m.textContent),
  })));

  S['LANE-7'] = {
    title: 'rooms through the relay: the shipped default door (no relay or direct token: relay rendezvous, direct off); an owner and two members in three browser processes; the roster of three on all three; a message from the owner and one from a member fan out to the other two over the relay; no RTCPeerConnection on any page; the lane id and the texts are in no report, log line, inspect() JSON or page',
    async fn(ctx, step) {
      await closeLeftovers(ctx);
      const k = await kit(ctx, step);
      // Both tokens absent: the door.json of a door made before the relay existed, which A2 resolves to relay rendezvous and direct off (the new default).
      const door = await doorFor(ctx, step, { relay: undefined, direct: undefined, label: 'the shipped default: no relay token, no direct token' });
      const { collector } = k;
      const tracker = ctx.stack.tracker;
      collector.clear();
      const run0 = run.violations.length;
      const expect = { relay: 'rendezvous', direct: 'off' };
      const texts = { o: 'welcome to the room ' + MARK + '-seven', m: 'hello from a member ' + MARK + '-seven-2' };
      const rows = (P) => P.page.locator('[data-role="room-requests"] li.mw-apps-request');
      const [O, M1, M2] = await step('three browsers (separate processes, fresh profiles), all with WebRTC: an owner and two members open the door and sign in for this visit', async () => {
        const out = [];
        for (const name of ['LANE7O', 'LANE7M1', 'LANE7M2']) out.push(await newParty(ctx, name));
        for (const P of out) {
          await P.page.goto('about:blank');
          assert((await P.page.evaluate(() => typeof window.RTCPeerConnection)) === 'function', P.name + ' has no RTCPeerConnection (the scenario needs a browser that could make one and does not)');
          await openDoor(P, door);
          await signIn(P);
        }
        assert(new Set(out.map((P) => P.short)).size === 3, 'two parties share a short id');
        return out;
      }, 60000);
      return noted(collector, 'LANE-7', async () => {
        const base = relayStats(tracker);
        const t0 = Date.now();
        const code = await step('the owner creates a room (the price card: the room sentence, then the members-do-not-see-your-address paragraph, no direct line, the report host); a code and a lane minted at the rendezvous; no socket before Continue; no manager, no peer connection, no announce', async () => {
          await O.press('[data-app="rooms"]');
          await waitApps(O, (x) => x.view === 'rooms', 'the rooms view', 5000);
          await O.press('[data-role="room-create"]');
          await continueCard(O, 'room-create', { collector, expect, whileShown: async () => assert(O.tap.sockets.length === 0, 'the owner opened a socket before Continue') });
          const a = await waitApps(O, (x) => x.view === 'room' && x.rooms.length === 1 && x.link === 'open', 'the room view with an open link', 20000);
          assert(a.rooms[0].role === 'owner' && a.rooms[0].members === 1 && a.rooms[0].status === 'open' && a.tm === false, bad('the owner\'s room', { room: a.rooms[0], tm: a.tm }));
          const shown = await O.text('[data-role="room-code"]');
          assert(CODE_RE.test(shown), 'the room code: ' + shown);
          assert((await O.text('[data-role="status-line"]')) === must('apps.rooms.status.open'), 'the owner\'s status line: ' + (await O.text('[data-role="status-line"]')));
          const ids = lanesOf(O);
          assert(ids.length === 1, 'the rendezvous told the owner ' + ids.length + ' lanes');
          assert((await peerConnectionCount(O.page)) === 0 && O.v.announces.length === 0, 'the owner made a peer connection or announced before any member');
          return shown;
        });
        await step('the two members ask to join with the code (the price card first: the room sentence, then the members-do-not-see-your-address paragraph, no direct line, the report host); the owner sees two requests; nobody has a peer connection or a manager', async () => {
          for (const P of [M1, M2]) {
            await P.press('[data-app="rooms"]');
            await waitApps(P, (x) => x.view === 'rooms', 'the rooms view', 5000);
            await P.loc('[data-role="join-input"]').fill(code);
            await P.press('[data-role="join-button"]');
            await continueCard(P, 'room-join', { collector, expect, whileShown: async () => assert(P.tap.sockets.length === 0, P.name + ' opened a socket before Continue') });
            await waitUntil(async () => (await P.text('[data-role="join-note"]')) === must('apps.rooms.joinSent'), { timeoutMs: 10000, label: P.name + ': the "request sent" note' });
            await waitApps(P, (x) => x.rooms.length === 1 && x.rooms[0].status === 'waiting', 'a waiting room', 10000);
          }
          await waitApps(O, (x) => x.requests === 2, 'two requests at the owner', 30000);
          await waitUntil(async () => (await rows(O).count()) === 2, { timeoutMs: 10000, label: 'two request rows' });
          for (const P of [O, M1, M2]) {
            const a = await P.apps();
            assert((await peerConnectionCount(P.page)) === 0 && a.tm === false && P.v.announces.length === 0, P.name + ' has a peer connection, a manager or an announce before any decision');
          }
        }, 60000);
        const tAccept = { at: 0 };
        let connectMs = 0;
        await step('the owner accepts both (the accept card: the room sentence, the members-do-not-see-your-address paragraph and the check line, no direct line); within 10 s of the last accept the room of three shows on all three, no manager, no error card', async () => {
          for (const P of [M1, M2]) {
            await rows(O).filter({ hasText: P.short }).locator('[data-role="accept"]').click({ timeout: 5000 });
            await continueCard(O, 'room-accept', { collector, expect, mark: tAccept });
            await waitUntil(async () => (await rows(O).filter({ hasText: P.short }).count()) === 0, { timeoutMs: 10000, label: 'the row of ' + P.name + ' goes' });
          }
          // the owner's room stays "Open for members" while its code is open; a member's room is "Connected" (as APPS-4 reads them)
          const okStatus = (P) => (P === O ? ['open', 'connected'] : ['connected']);
          await Promise.all([O, M1, M2].map((P) => waitApps(P, (x) => x.rooms.length === 1 && x.rooms[0].members === 3 && okStatus(P).indexOf(x.rooms[0].status) >= 0, 'a room of three that is ' + okStatus(P).join(' or '), 30000)));
          connectMs = Date.now() - tAccept.at;
          assert(connectMs <= WITHIN_MS, 'the room of three took ' + connectMs + ' ms after the last accept (the plan says ' + WITHIN_MS + ' ms)');
          for (const P of [M1, M2]) {
            await P.press('[data-role="room-list"] [data-room]');
            await waitApps(P, (x) => x.view === 'room', 'the room view', 5000);
          }
          for (const P of [O, M1, M2]) {
            const a = await P.apps();
            // inspect() lists a room without `via` (apps-ui.js reads only a conversation's via in this build, A1); the path of the room is proved below
            // by the reports (apps.wire up, kind room, via relay) and by the zero peer connections on every page.
            assert(a.tm === false, P.name + ' loaded a manager');
            const status = a.rooms[0].status;
            assert((await P.text('[data-role="status-line"]')) === must('apps.rooms.status.' + status), P.name + ' status line "' + (await P.text('[data-role="status-line"]')) + '" for ' + status);
            const e = await P.page.evaluate(() => { const n = document.querySelector('.mw-error:not([hidden])'); return n ? n.textContent.replace(/\s+/g, ' ').trim() : null; });
            assert(e === null, P.name + ' shows an error card: ' + e);
          }
        }, 60000);
        await step('the roster of three (the owner marked, "you" on each) is the same on all three', async () => {
          const rosters = [];
          for (const P of [O, M1, M2]) {
            const r = await readRoster(P);
            rosters.push(r);
            assert(r.length === 3 && new Set(r.map((x) => x.pub)).size === 3, P.name + ' roster ' + JSON.stringify(r));
            for (const q of [O, M1, M2]) assert(r.some((x) => x.label === q.short), P.name + ' roster has no ' + q.name + ': ' + JSON.stringify(r));
            const owners = r.filter((x) => x.marks.indexOf(must('apps.rooms.owner')) >= 0);
            const yous = r.filter((x) => x.marks.indexOf(must('apps.rooms.you')) >= 0);
            assert(owners.length === 1 && owners[0].label === O.short, P.name + ' roster owner mark ' + JSON.stringify(r));
            assert(yous.length === 1 && yous[0].label === P.short, P.name + ' roster "you" mark ' + JSON.stringify(r));
          }
          const keys = (r) => r.map((x) => x.pub).sort().join();
          assert(keys(rosters[0]) === keys(rosters[1]) && keys(rosters[1]) === keys(rosters[2]), 'the three rosters list different people');
        });
        await step('a message from the owner fans out to both members, and one from a member to the other two: each shows once at each receiver with the sender named; the sender\'s tick says Sent (a room shows no Delivered: it has no per-member acks)', async () => {
          await roomSend(O, [M1, M2], texts.o);
          await roomSend(M1, [O, M2], texts.m);
        }, 60000);
        await step('no RTCPeerConnection was constructed on any page (the run\'s wrapper, the legacy name, the calls only a connection can take), no manager, no announce; the rendezvous counted one relay lane and the frames, hit no cap; the pages sent only the fields and sizes of the plan, in the room form', async () => {
          for (const P of [O, M1, M2]) {
            assert((await peerConnectionCount(P.page)) === 0, P.name + ' constructed ' + (await peerConnectionCount(P.page)) + ' peer connections (the run\'s wrapper)');
            const w = await P.page.evaluate(() => window.__mwLane);
            assert(w && w.made === 0 && w.alias === 0 && w.calls === 0, bad(P.name + ' peer connection use (made, alias, calls)', w));
            assert((await P.apps()).tm === false, P.name + ' loaded a manager');
            assert(P.v.announces.length === 0 && framesJson(P, 'out').every((f) => f.msg.action !== 'announce'), P.name + ' announced a lane to the rendezvous');
            assert(sentActions(P).every((a) => !/^pair-(join|relay|leave)$/.test(a)), P.name + ' used the pair form of a relay action for a room: ' + sentActions(P).join(', '));
          }
          const lanes = lanesOf(O, M1, M2);
          assert(lanes.length === 1, 'the pages saw ' + lanes.length + ' lane ids (the room\'s one is expected)');
          assert(!tracker.announces.some((x) => x.t >= t0 && String(x.btih) === lanes[0]), 'the tracker saw an announce for the room\'s lane');
          const s = relayStats(tracker);
          assert(s.relays - base.relays === 1, bad('relay lanes (now minus before)', { now: s.relays, before: base.relays }));
          assert(s.relayed - base.relayed >= 2 && s.relayBytes > base.relayBytes, bad('relayed frames (now minus before; two messages at least)', { now: s.relayed, before: base.relayed }));
          assert(s.relayBusy === base.relayBusy && s.relayRate === base.relayRate && s.joinsRefused === base.joinsRefused, bad('a cap was hit by honest traffic', { now: s, before: base }));
          assertRelayWire(O, { kind: 'room', minRelays: 1 });
          assertRelayWire(M1, { kind: 'room', minRelays: 1 });
          assertRelayWire(M2, { kind: 'room', minRelays: 0 });
        });
        const sess = await step('the reports of all three hold link.sent room-join, apps.lane joined, apps.wire up (kind room, via relay) in that order, a successful room-join reply, apps.room with three members; apps.msg sent at the two senders and received at every receiver; no direct wire, no kill, no ice or peer event, run.start webrtc true', async () => {
          const out = await sessionsFor(collector, [O, M1, M2]);
          for (const [P, x] of out) {
            const start = firstOf(x.events, { n: 'run.start' });
            assert(start && start.webrtc === true, bad(P.name + ' run.start', start));
            noIce(x, P.name);
            assert(!x.events.some((e) => /^peer\./.test(e.n)), P.name + ' reported a peer event: ' + x.events.filter((e) => /^peer\./.test(e.n)).map((e) => e.n).slice(0, 4).join(' '));
            const r = inOrder(x.events, ['run.start', { n: 'link.sent', action: 'room-join' }, { n: 'apps.lane', ev: 'joined' }, { n: 'apps.wire', ev: 'up', kind: 'room', via: 'relay' }]);
            assert(r.ok, P.name + ': ' + r.link + ' is not after ' + r.after + ' in ' + x.events.map((e) => e.n + (e.ev ? ':' + e.ev : e.status ? ':' + e.status : '')).join(' ').slice(0, 900));
            assert(firstOf(x.events, { n: 'link.reply', action: 'room-join', ok: true }), P.name + ': no successful room-join reply in the reports');
            assert(firstOf(x.events, { n: 'apps.room', members: 3 }), P.name + ': no apps.room with three members in the reports: ' + JSON.stringify(x.events.filter((e) => e.n === 'apps.room').map((e) => [e.status, e.members])));
            if (P !== O) assert(firstOf(x.events, { n: 'apps.room', status: 'connected' }), P.name + ': no apps.room connected in the reports');
            assert(firstOf(x.events, { n: 'apps.msg', status: 'received' }), P.name + ': the reports do not hold a received message');
            if (P !== M2) assert(firstOf(x.events, { n: 'apps.msg', status: 'sent' }) && firstOf(x.events, { n: 'link.reply', action: 'room-relay', ok: true }), P.name + ': the reports do not hold a sent message and a successful room-relay reply');
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.wire', via: 'direct' })), P.name + ' reported a direct wire');
            assert(!x.events.some((e) => matchEvent(e, { n: 'apps.wire', ev: 'kill' })), P.name + ' killed a wire');
            const refused = x.events.filter((e) => e.n === 'apps.lane' && ['join', 'joined', 'left'].indexOf(e.ev) < 0);
            assert(refused.length === 0, bad(P.name + ' apps.lane says the lane did not work', refused.map((e) => e.ev)));
          }
          return out;
        });
        const searched = await step('the lane id (nor any 9 characters of it), the sealed frames and the message texts are in no report, log line, inspect() JSON or page outside the room\'s message list', () => assertNoSecrets([O, M1, M2], collector, [texts.o, texts.m], 'LANE-7'));
        await step('nothing left 127.0.0.1, and the rendezvous never saw a message text in the clear', async () => {
          assertNetwork([O, M1, M2], door, collector, run0);
          for (const P of [O, M1, M2]) for (const dir of ['in', 'out']) assert(P.tap.frames.filter((f) => f.dir === dir).every((f) => f.payload.indexOf(MARK) < 0), P.name + ' ' + dir + ': a message marker is in a frame of the rendezvous socket');
        });
        const lines = [O, M1, M2].map((P) => P.name + ' ' + sess.get(P).events.length + ' events').join(', ');
        await finish(ctx, [O, M1, M2]);
        return 'a room of three through the relay on the shipped default door, the roster on all three ' + connectMs + ' ms after the last accept (target ' + WITHIN_MS + ' ms met); two messages fanned out; zero peer connections on three pages; ' + lines + '; ' + searched + ' texts and characters searched for the lane id, frames and texts, none found';
      });
    },
  };

  return S;
}

