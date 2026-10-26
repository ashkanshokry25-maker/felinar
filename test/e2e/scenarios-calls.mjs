// test/e2e/scenarios-calls.mjs: peer-to-peer calls through the real loader, SDK, identity origin and chat lane
// (docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.5 "End-to-end"). Built by the calls lane contract-first; the
// C2 integrator wires CALLS_ORDER and CALLS_WEBKIT_ORDER into test/e2e/run.mjs after rebuilding dist/ (this file
// edits neither run.mjs nor lib.mjs).
//
//   E-CL-3   a non-contact's ring creates no RTCPeerConnection (counted by an init script); after a decline no offer
//            leaves the caller; host-only gives E_HOST_ONLY; calls off gives E_POLICY
//   E-CL-1   (Chromium) ring, accept with video, connected within 10 s; audio and video bytes both ways; the remote
//            certificate (certificate stats) equals the fingerprint of the sealed answer; chat-lane bytes hold no v=0,
//            a=fingerprint or candidate: text; mute and camera off reach the peer over mw-call; hang up closes both
//            connections and ends every capture track
//   E-CL-2   (Chromium) a group call of four from a context forced to the metered class is audio only; each context
//            has 3 connected pairs with audio from 3 peers; a leaver's pairs close within 5 s; a video call to five
//            people fails with E_LIMIT
//   E-CL-1W  (--webkit) E-CL-1 in two WebKit browsers (one per participant), plus a screen shared from a trusted click
//
// Network policy (docs/DEV-NETWORK.md): every URL is http://127.0.0.1; Chromium is launched here (not the run's shared
// browser) with chromiumArgs() plus --allow-loopback-in-peer-connection and BOTH fake-media flags (the fake-UI flag alone
// grants the machine's real camera and microphone); WebKit gets the camera and microphone context permissions. Every
// visitor is a lib.mjs Visitor, so the run's request guard and the ICE-server stripping init script apply. UI methods
// (start, accept, screen) run from real clicks on buttons this file adds to the site frame; the loader's cards are
// pressed with real mouse clicks (window.__mwShell.rectOf).
//
// Contract assumptions (docs/deviations/calls.md "e2e contract"): mw.calls.start({ to, video }), accept(id, { video }),
// decline(id), hangup(id), mute(id, on), camera(id, on), screen(id, on), on(event, fn) in the SDK; the loader's cards
// for call.start / call.group / call.incoming / call.metered / call.screen findable by window.__mwShell.rectOf(label);
// window.__mwShell.setCallPrefs({ sameLan }) so two browsers on one machine may use their loopback candidates (the
// person's "same local network" choice); _mw.cfg.calls accepted by the reader schema (src/chain/state.js).

import { join } from 'node:path';

import { Visitor, waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, clickLoaderCard, clickShellButton, launchWebkit, ROOT } from './lib.mjs';
import { chromiumArgs } from './browser-args.mjs';
import { driveIdp } from './idp-driver.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { setCfg, readBlocksFile, writeBlocksFile } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import * as STRINGS_MODULE from '../../src/loader/strings.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

export const CALLS_ORDER = ['E-CL-3', 'E-CL-1', 'E-CL-2'];
export const CALLS_WEBKIT_ORDER = ['E-CL-1W'];

const CALL_FLAGS = ['--allow-loopback-in-peer-connection', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const UI = (STRINGS_MODULE.UI_TEXT && STRINGS_MODULE.UI_TEXT.en) || {};
const CALL = (STRINGS_MODULE.CALL_TEXT && STRINGS_MODULE.CALL_TEXT.en) || {};
const HOST_ONLY = (STRINGS_MODULE.STRINGS && STRINGS_MODULE.STRINGS.consentHostOnly) || 'Load from host only';
/** Buttons that confirm a card, in the order they are tried (the call panel's own label first, then Continue). */
const LABELS = {
  start: [CALL['call.call'], CALL['call.start.confirm'], 'Call', UI.continue, 'Continue'],
  group: [CALL['call.join'], CALL['call.group.confirm'], 'Join', 'Call', UI.continue, 'Continue'],
  metered: [CALL['call.metered.confirm'], UI.continue, 'Continue', 'OK'],
  screen: [CALL['call.screen.start'], 'Share screen', UI.continue, 'Continue'],
  audio: [CALL['call.accept.audio'], 'Accept with audio'],
  video: [CALL['call.accept.video'], 'Accept with video'],
  decline: [CALL['call.decline'], 'Decline'],
  chat: [UI.continue, 'Continue'],
};

// ---------------------------------------------------------------------------------------------
// init scripts (every frame, after lib.mjs's ICE-server stripping)
// ---------------------------------------------------------------------------------------------

/**
 * Counts the call connections (an RTCPeerConnection that opens the 'mw-call' channel), keeps every capture track, and
 * records what the page sends on every other data channel (the swarm and chat-lane wires) once recording is on.
 */
function callWatch() {
  if (window.__mwCallWatch) return;
  const W = { pcs: [], tracks: [], log: [], logBytes: 0, recording: false };
  window.__mwCallWatch = W;
  const RTC = window.RTCPeerConnection;
  if (typeof RTC === 'function' && RTC.prototype && typeof RTC.prototype.createDataChannel === 'function') {
    const cdc = RTC.prototype.createDataChannel;
    RTC.prototype.createDataChannel = function (label, opts) {
      const dc = cdc.call(this, label, opts);
      if (label === 'mw-call' && W.pcs.indexOf(this) < 0) W.pcs.push(this);
      return dc;
    };
  }
  const DC = window.RTCDataChannel;
  if (DC && DC.prototype && typeof DC.prototype.send === 'function') {
    const send = DC.prototype.send;
    DC.prototype.send = function (data) {
      if (W.recording && this.label !== 'mw-call' && W.logBytes < 8 * 1024 * 1024) {
        try {
          let u8 = null;
          if (typeof data === 'string') u8 = new TextEncoder().encode(data);
          else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (u8) {
            let s = '';
            for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
            W.log.push(s);
            W.logBytes += s.length;
          }
        } catch (_) { /* a frame the page is sending anyway */ }
      }
      return send.call(this, data);
    };
  }
  // C2 integrator: the prototype, not the navigator.mediaDevices instance: in Playwright WebKit an own property set on the
  // instance by this script was sometimes gone by the time the loader captured (its tracks went unrecorded).
  const MD = window.MediaDevices && window.MediaDevices.prototype;
  if (MD && typeof MD.getUserMedia === 'function') {
    const gum = MD.getUserMedia;
    MD.getUserMedia = function (c) { W.gum = (W.gum || 0) + 1; return gum.call(this, c).then((s) => { for (const t of s.getTracks()) W.tracks.push(t); return s; }); };
  }
  if (MD && typeof MD.getDisplayMedia === 'function') {
    const gdm = MD.getDisplayMedia;
    MD.getDisplayMedia = function (c) { return gdm.call(this, c).then((s) => { for (const t of s.getTracks()) W.tracks.push(t); return s; }); };
  }
}

/** Debug only (MW_E2E_SHOTS): shadow roots open, so a failing card can be inspected. */
function openShadows() {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return orig.call(this, Object.assign({}, o, { mode: 'open' })); };
}

/** Makes the page see a cellular connection, so the loader's policy class is mobileMetered (E-CL-2). */
function forceMetered() {
  const conn = { type: 'cellular', effectiveType: '4g', saveData: false, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(Navigator.prototype, 'connection', { configurable: true, get() { return conn; } }); } catch (_) { /* fixed */ }
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

// C2 integrator: MW_E2E_SHOTS=<directory> keeps a screenshot before each UI call and when a click does not land.
const SHOTS = process.env.MW_E2E_SHOTS || null;
let shotSeq = 0;
async function shot(page, name) {
  if (!SHOTS) return;
  try { await page.screenshot({ path: join(SHOTS, String(++shotSeq).padStart(3, '0') + '-' + name + '.png') }); } catch (_) { /* a closed page */ }
}

/** callsScenarios({ run, assert, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function callsScenarios({ run, assert, headed = false }) {
  const S = {};

  async function callsSite(ctx, step, { calls = 'contacts' } = {}) {
    const key = 'callsSite:' + calls;
    if (ctx.shared[key]) return ctx.shared[key];
    const { stack } = ctx;
    const m = await step('a guestbook with chat for members and calls (' + calls + '): _mw.cfg served at cs=, the site\'s own tracker and STUN', async () => {
      const outDir = join(stack.runDir, 'calls-publish-' + calls);
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        // C2 integrator: a ledger of its own (chain). Every e2e site on scope 127.0.0.1 with the run's owner key had one ledger id, so
        // the calls site's _mw.cfg merged with the members site's and the main site's in the full run (features.calls read false).
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'calls-guestbook-' + calls, scope: '127.0.0.1', chain: 'e2e-calls-' + calls, key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
        tracker: [stack.tracker.url], stun: ['stun:127.0.0.1:3478'], chat: true,
      });
      const identity = await loadOwnerKey(stack.owner.file);
      let cfg;
      try {
        cfg = await setCfg({ blocks: readBlocksFile(join(outDir, 'genesis.json')), identity, set: { chat: 'members', calls } });
      } catch (err) {
        throw new StepError('ledger-admin could not set calls (' + err.message + '); the reader schema of _mw.cfg (src/chain/state.js CFG) must list calls: off | contacts');
      }
      writeBlocksFile(join(outDir, 'genesis.json'), cfg.blocks);
      dev.setPointer(pub.pointer);
      return { dev, pub, outDir, url: dev.url, cfg: cfg.cfg };
    });
    ctx.shared[key] = m;
    return m;
  }

  /** A Chromium of its own with the fake media devices (the run's shared browser has none). */
  async function callBrowser(ctx) {
    if (ctx.shared.callBrowser) return ctx.shared.callBrowser;
    const pw = await import('playwright');
    const chromium = pw.chromium || (pw.default && pw.default.chromium);
    const b = await chromium.launch({ headless: !headed, args: chromiumArgs({ allowRemote: false }).concat(CALL_FLAGS) });
    ctx.closers.push(() => b.close());
    ctx.shared.callBrowser = b;
    return b;
  }

  async function visitor(ctx, browser, name, { metered = false } = {}) {
    const v = await Visitor.open(browser, name, run, {
      initScripts: [callWatch].concat(metered ? [forceMetered] : []).concat(SHOTS ? [openShadows] : []),
      contextOptions: { permissions: ['camera', 'microphone'] },
    });
    ctx.closers.push(() => v.close());
    // C2 integrator: listed with the run's visitors, so a failing step prints their console lines and loader logs.
    if (ctx.visitors && typeof ctx.visitors.set === 'function') ctx.visitors.set(name, v);
    return v;
  }

  async function sdk(page, fn, arg) {
    return siteFrame(page).evaluate(fn, arg);
  }

  /** The first of `labels` that a loader card shows now, or null. */
  async function cardShown(page, labels) {
    for (const l of labels.filter((x) => typeof x === 'string' && x.length)) {
      const r = await page.evaluate((x) => (window.__mwShell && typeof window.__mwShell.rectOf === 'function' ? window.__mwShell.rectOf(x) : null), l).catch(() => null);
      if (r && r.width > 0) return l;
    }
    return null;
  }

  /**
   * Presses the first of `labels` that a loader card shows, until the card goes away. done() (optional) ends the wait
   * early when the call it belongs to settled without a card (an error before any card): then it returns null.
   */
  async function pressCard(page, labels, { timeoutMs = 30000, what = 'card', done = null } = {}) {
    const list = labels.filter((l) => typeof l === 'string' && l.length);
    let found = null;
    await waitUntil(async () => {
      found = await cardShown(page, list);
      if (found) return true;
      return done ? Boolean(await done()) : false;
    }, { timeoutMs, label: 'the loader ' + what + ' (one of ' + JSON.stringify(list) + ')' });
    if (!found) return null;
    await shot(page, 'card-' + what.replace(/\W+/g, '-'));
    if (SHOTS) {
      const res = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /ui\.css/.test(e.name)).map((e) => e.name + ' ' + e.initiatorType + ' ' + Math.round(e.duration) + 'ms ' + (e.responseStatus || '') + ' ' + e.transferSize)).catch((e) => String(e));
      console.log('[shots] ' + what + ' ui.css entries: ' + JSON.stringify(res));
      const probe = await page.evaluate(() => {
        const host = document.querySelector('[data-mw-call]');
        const root = host && host.shadowRoot;
        if (!root) return { host: !!host, root: false };
        const link = root.querySelector('link');
        const live = root.querySelector('.mw-call-live');
        const cs = live ? getComputedStyle(live) : null;
        return { href: link && link.getAttribute('href'), sheet: !!(link && link.sheet), rules: link && link.sheet ? link.sheet.cssRules.length : -1, livePos: cs && cs.position, liveW: cs && cs.width, connected: host.isConnected };
      }).catch((e) => String(e));
      console.log('[shots] ' + what + ' call panel css: ' + JSON.stringify(probe));
    }
    await waitUntil(async () => {
      await clickLoaderCard(page, found);
      await sleep(300);
      return !(await page.evaluate((x) => window.__mwShell.rectOf(x), found).catch(() => null));
    }, { timeoutMs: 10000, label: 'pressing "' + found + '"' });
    return found;
  }

  /** The SDK listeners and three buttons (start, accept, screen) in the site frame: UI methods run from real clicks. */
  async function siteControls(page) {
    await sdk(page, async () => {
      if (window.__mwCallsE2E) return true;
      const E = { events: { ring: [], state: [], peer: [], ended: [] }, results: {}, next: {}, ready: false };
      window.__mwCallsE2E = E;
      const mw = (await import('/_mw/sdk.js')).default;
      if (!mw.calls) throw new Error('the SDK has no mw.calls');
      for (const ev of Object.keys(E.events)) mw.calls.on(ev, (x) => E.events[ev].push(x));
      const bar = document.createElement('div');
      // C2 integrator: a column on the left edge, clear of the loader's signed-in header (bottom centre, up to 640px wide).
      bar.style.cssText = 'position:fixed;left:8px;top:220px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;background:#fff;padding:4px';
      for (const name of ['start', 'accept', 'screen']) {
        const b = document.createElement('button');
        b.id = 'mw-e2e-' + name;
        b.textContent = 'e2e ' + name;
        b.style.cssText = 'width:110px;height:36px';
        b.addEventListener('click', () => {
          E.results[name] = 'pending';
          Promise.resolve().then(() => mw.calls[name](...(E.next[name] || []))).then((r) => { E.results[name] = { ok: r }; }, (e) => { E.results[name] = { code: (e && e.code) || String(e && e.message), message: String((e && e.message) || '').slice(0, 200) }; });
        });
        bar.appendChild(b);
      }
      document.body.appendChild(bar);
      E.ready = true;
      return true;
    });
  }

  /**
   * Clicks a site button for a UI method with its arguments; presses the given cards as they come (a call that fails
   * before a card ends the wait); resolves with { ok } or { code }.
   */
  async function uiCall(page, name, callArgs, cards = [], { timeoutMs = 45000 } = {}) {
    await sdk(page, ([n, a]) => { window.__mwCallsE2E.next[n] = a; delete window.__mwCallsE2E.results[n]; }, [name, callArgs]);
    await shot(page, 'before-' + name);
    await siteFrame(page).click('#mw-e2e-' + name, { timeout: 15000 }).catch(async (err) => { await shot(page, 'click-failed-' + name); throw err; });
    const result = () => sdk(page, (n) => { const r = window.__mwCallsE2E.results[n]; return r && r !== 'pending' ? r : null; }, name).catch(() => null);
    for (const c of cards) {
      const pressed = await pressCard(page, LABELS[c], { what: c + ' card', done: result });
      if (!pressed) break;
    }
    return waitUntil(result, { timeoutMs, label: name + ' result' });
  }

  async function sameLan(page) {
    const ok = await page.evaluate(() => {
      const s = window.__mwShell;
      if (!s || typeof s.setCallPrefs !== 'function') return false;
      s.setCallPrefs({ sameLan: true });
      return true;
    });
    if (!ok) throw new StepError('the loader has no window.__mwShell.setCallPrefs({ sameLan }): two browsers on one machine need the "same local network" choice to use loopback candidates (docs/deviations/calls.md, request to wire-ui)');
  }

  /** A member of the calls site: opens it, Share and load, signs in for this visit, turns chat on, adds the controls. */
  async function member(ctx, step, browser, name, m, { metered = false, lan = true } = {}) {
    const k = 'callMember:' + name;
    if (ctx.shared[k]) return ctx.shared[k];
    const r = await step(name + ' opens the calls site, signs in at the identity origin and turns chat on (one loader card)', async () => {
      const v = await visitor(ctx, browser, name, { metered });
      const page = await v.newPage();
      await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // C2 integrator (measured here, Playwright WebKit 27.2): WebKit offers only an mDNS host candidate (<uuid>.local) until the
      // page has captured, and two WebKit browsers on one machine never connected the swarm with those (0 peers after 45 s).
      // With a capture running in the shell page before "Share and load", the swarm's offers carry this machine's own address
      // and the members connect. Real networks use the site's STUN server instead (iceServers are emptied in this suite).
      if (browser.browserType && browser.browserType().name() === 'webkit') {
        const got = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
          window.__mwE2ECapture = s;
          // The test's own capture is not the loader's: keep it out of the "every capture track ends" check.
          const W = window.__mwCallWatch;
          if (W) W.tracks = W.tracks.filter((t) => s.getTracks().indexOf(t) < 0);
          return s.getTracks().length;
        }, (e) => 'error ' + e.name));
        assert(got === 1, name + ': WebKit capture before joining the swarm: ' + got);
      }
      await acceptConsent(page, { timeoutMs: 20000 });
      await waitForSite(page, { timeoutMs: 30000, label: name + ': site' });
      const f = siteFrame(page);
      await f.waitForSelector('#sign-in:not([hidden])', { timeout: 15000 });
      const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
      await f.click('#sign-in');
      await withTimeout(driveIdp(await popupPromise, { unlock: 'visit' }), 60000, 'identity origin');
      await waitUntil(() => f.evaluate(() => document.documentElement.dataset.auth === 'signed-in'), { timeoutMs: 20000, label: name + ': signed in' });
      const info = await sdk(page, async () => (await import('/_mw/sdk.js')).default.ready());
      let settled = null;
      const running = sdk(page, async () => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { await mw.chat.enable(); } catch (e) { return { err: e.code || e.message }; }
        return mw.chat.state();
      }).then((x) => { settled = x; return x; });
      await pressCard(page, LABELS.chat, { what: 'chat card', done: () => settled });
      const on = await withTimeout(running, 30000, 'chat.enable');
      assert(on && on.state === 'on', name + ': chat ' + JSON.stringify(on));
      if (lan) await sameLan(page);
      await siteControls(page);
      // C2 integrator: the ledger, and with it _mw.cfg.calls, may arrive after the sign-in (from cs= when no member is online):
      // wait until the page reads calls as on before the scenario starts calling.
      const features = m.cfg && m.cfg.calls === 'contacts'
        ? await waitUntil(async () => { const r = await sdk(page, async () => (await import('/_mw/sdk.js')).default.ready()); return r && r.features && r.features.calls === true ? r.features : null; }, { timeoutMs: 20000, label: name + ': calls on (mw.ready().features.calls)' })
        : info.features;
      return { v, page, pub: info.identity.pub, short: info.identity.short, features };
    });
    ctx.shared[k] = r;
    return r;
  }

  async function addContacts(a, list) {
    for (const pub of list) {
      const r = await sdk(a.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.chat.contacts.add(p); } catch (e) { return { err: e.code || e.message }; }
      }, pub);
      if (r && r.err) throw new StepError('contacts.add: ' + r.err);
    }
  }

  async function events(page, name) {
    return sdk(page, (n) => window.__mwCallsE2E.events[n].slice(), name);
  }

  /** The call connections of a page: states and per-kind bytes from getStats, the certificate check, ufrags. */
  async function callPcs(page) {
    return page.evaluate(async () => {
      const W = window.__mwCallWatch;
      const out = [];
      for (const pc of W.pcs) {
        const e = { state: pc.connectionState, audioIn: 0, audioOut: 0, videoIn: 0, videoOut: 0, screenIn: 0, cert: null, sdpFp: null, localFp: null, ufrags: [] };
        try {
          const r = await pc.getStats();
          let remoteId = null;
          const certs = {};
          r.forEach((s) => {
            if (s.type === 'transport' && s.remoteCertificateId) remoteId = s.remoteCertificateId;
            if (s.type === 'certificate') certs[s.id] = s.fingerprint;
            if (s.type === 'inbound-rtp') {
              if (s.kind === 'audio') e.audioIn += s.bytesReceived || 0;
              else if (s.mid === '2') e.screenIn += s.bytesReceived || 0;
              else e.videoIn += s.bytesReceived || 0;
            }
            if (s.type === 'outbound-rtp') {
              if (s.kind === 'audio') e.audioOut += s.bytesSent || 0;
              else e.videoOut += s.bytesSent || 0;
            }
          });
          e.cert = remoteId ? String(certs[remoteId] || '').toUpperCase() : null;
        } catch (_) { /* closed */ }
        const fp = (d) => { const m = d && /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(d.sdp); return m ? m[1].toUpperCase() : null; };
        // Firefox throws "Peer connection is closed" when a closed connection's descriptions are read (docs/deviations/firefox.md).
        try {
          e.sdpFp = fp(pc.remoteDescription);
          e.localFp = fp(pc.localDescription);
          for (const d of [pc.localDescription, pc.remoteDescription]) {
            const m = d && /a=ice-ufrag:(\S+)/.exec(d.sdp);
            if (m) e.ufrags.push(m[1]);
          }
        } catch (_) { /* closed */ }
        out.push(e);
      }
      return out;
    });
  }

  async function connectedPcs(page) {
    return (await callPcs(page)).filter((x) => x.state === 'connected');
  }

  async function record(page, on) {
    await page.evaluate((x) => { window.__mwCallWatch.recording = x; if (x) { window.__mwCallWatch.log = []; window.__mwCallWatch.logBytes = 0; } }, on);
  }

  /** What the page sent on swarm and chat-lane wires while recording: clear SDP markers and this call's own strings. */
  async function leaks(page, needles) {
    return page.evaluate((list) => {
      const W = window.__mwCallWatch;
      const found = [];
      const marks = ['v=0\r\n', 'a=fingerprint', 'candidate:', 'a=ice-ufrag'].concat(list || []);
      for (const s of W.log) for (const m of marks) if (s.indexOf(m) >= 0) found.push(m);
      return { found, bytes: W.logBytes, frames: W.log.length };
    }, needles);
  }

  async function oneToOne(ctx, step, browserA, browserB, tag, { screen = false } = {}) {
    const m = await callsSite(ctx, step);
    const a = await member(ctx, step, browserA, tag + 'A', m);
    const b = await member(ctx, step, browserB, tag + 'B', m);
    await step(tag + 'A and ' + tag + 'B add each other as contacts; mw.ready().features.calls is on', async () => {
      await addContacts(a, [b.pub]);
      await addContacts(b, [a.pub]);
      assert(a.features && a.features.calls === true, 'features ' + JSON.stringify(a.features));
    });
    await record(a.page, true);
    await record(b.page, true);
    const started = await step(tag + 'A calls ' + tag + 'B with video (a click, then the call.start card)', async () => {
      // A chat key that is still on its way gives E_PEER_UNREACHABLE: retry while it travels.
      return waitUntil(async () => {
        const r = await uiCall(a.page, 'start', [{ to: b.pub, video: true }], ['start']);
        if (r.code === 'E_PEER_UNREACHABLE') return null;
        if (r.code) throw new StepError('calls.start: ' + r.code);
        return r.ok;
      }, { timeoutMs: 45000, stepMs: 1000, label: 'calls.start' });
    });
    const ring = await step(tag + 'B\'s page rings (the ring event, no SDP); ' + tag + 'B has no call connection yet', async () => {
      const r = await waitUntil(async () => (await events(b.page, 'ring')).find((x) => x.id === started.id) || null, { timeoutMs: 20000, label: 'ring' });
      assert(r.from === a.pub && r.kind === 'video', 'ring ' + JSON.stringify(r));
      assert((await callPcs(b.page)).length === 0, 'the callee made a connection before accepting');
      return r;
    });
    const tAccept = Date.now();
    await step(tag + 'B accepts with video (a click, then "Accept with video" on the loader card)', async () => {
      const r = await uiCall(b.page, 'accept', [ring.id, { video: true }], ['video']);
      assert(!r.code, 'accept: ' + JSON.stringify(r));
    });
    // The 10 s of SZ 3.5 is a target: a loaded runner may miss it, so the step fails only past a generous bound and
    // the result says whether the target was met (code review round 1, F40).
    const ms = await step('both connect (target: within 10 s of the accept)', async () => {
      await waitUntil(async () => (await connectedPcs(a.page)).length === 1 && (await connectedPcs(b.page)).length === 1, { timeoutMs: 30000, label: 'connected' });
      return Date.now() - tAccept;
    });
    await step('audio and video bytes both ways; the remote certificate equals the fingerprint of the sealed answer', async () => {
      await sleep(3000);
      for (const [who, p] of [['A', a], ['B', b]]) {
        const [x] = await connectedPcs(p.page);
        assert(x.audioIn > 0 && x.audioOut > 0 && x.videoIn > 0 && x.videoOut > 0, who + ' bytes ' + JSON.stringify(x));
        assert(x.cert && x.cert === x.sdpFp, who + ': certificate ' + x.cert + ' against the SDP fingerprint ' + x.sdpFp);
      }
    });
    await step('the chat-lane and swarm wires carried no SDP or candidate text (and none of this call\'s fingerprints or ufrags)', async () => {
      const [x] = await connectedPcs(a.page);
      const needles = [x.localFp, x.sdpFp].filter(Boolean).concat(x.ufrags.map((u) => 'ice-ufrag:' + u));
      for (const p of [a, b]) {
        const l = await leaks(p.page, needles);
        assert(l.found.length === 0, 'clear text on a wire: ' + JSON.stringify(l.found) + ' in ' + l.frames + ' frames');
      }
    });
    let shared = null;
    if (screen) {
      shared = await step(tag + 'A shares a screen from a trusted click (the call.screen card, then getDisplayMedia)', async () => {
        const r = await uiCall(a.page, 'screen', [started.id, true], ['screen']);
        assert(r.ok && r.ok.screen === true, 'screen ' + JSON.stringify(r));
        await waitUntil(async () => (await events(b.page, 'peer')).some((p) => p.pub === a.pub && p.screen === true), { timeoutMs: 15000, label: 'screen at B' });
        await waitUntil(async () => ((await connectedPcs(b.page))[0] || {}).screenIn > 0, { timeoutMs: 15000, label: 'screen bytes at B' });
        return r.ok;
      });
    }
    await step('mute and camera off reach ' + tag + 'B over mw-call', async () => {
      await sdk(a.page, async (id) => { const mw = (await import('/_mw/sdk.js')).default; await mw.calls.mute(id, true); await mw.calls.camera(id, false); }, started.id);
      await waitUntil(async () => {
        const ev = (await events(b.page, 'peer')).filter((p) => p.pub === a.pub);
        return ev.some((p) => p.mute === true) && ev.some((p) => p.camera === false);
      }, { timeoutMs: 15000, label: 'mute and camera off at B' });
    });
    if (SHOTS) {
      for (const [who, p] of [['A', a], ['B', b]]) {
        const info = await p.page.evaluate(() => ({ gum: window.__mwCallWatch.gum || 0, tracks: window.__mwCallWatch.tracks.map((t) => t.kind + ':' + t.readyState) })).catch((e) => String(e));
        console.log('[shots] before hang-up ' + who + ': ' + JSON.stringify(info));
      }
    }
    await step('hang up: both connections close and every capture track ends', async () => {
      await sdk(a.page, async (id) => (await import('/_mw/sdk.js')).default.calls.hangup(id), started.id);
      await waitUntil(async () => (await events(b.page, 'ended')).some((e) => e.id === started.id), { timeoutMs: 15000, label: 'ended at B' });
      await sleep(1000);
      for (const [who, p] of [['A', a], ['B', b]]) {
        const pcs = await callPcs(p.page);
        assert(pcs.length >= 1 && pcs.every((x) => x.state === 'closed'), who + ' connections ' + JSON.stringify(pcs.map((x) => x.state)));
        const tracks = await p.page.evaluate(() => window.__mwCallWatch.tracks.map((t) => t.kind + ':' + t.readyState));
        assert(tracks.length >= 1 && tracks.every((t) => t.endsWith(':ended')), who + ' tracks ' + JSON.stringify(tracks));
      }
    });
    await record(a.page, false);
    await record(b.page, false);
    return 'connected ' + ms + ' ms after the accept (' + (ms <= 10000 ? 'target 10000 ms met' : 'target 10000 ms MISSED') + ')' + (shared ? ', screen shared' : '');
  }

  // ------------------------------------------------------------------------------------------- E-CL-3
  S['E-CL-3'] = {
    title: 'a non-contact\'s ring creates no RTCPeerConnection; after a decline no offer leaves the caller; host-only gives E_HOST_ONLY; calls off gives E_POLICY',
    async fn(ctx, step) {
      const m = await callsSite(ctx, step);
      const browser = await callBrowser(ctx);
      const x = await member(ctx, step, browser, 'NX', m);
      const y = await member(ctx, step, browser, 'NY', m);
      await step('NX adds NY as a contact; NY never adds NX; NX calls NY: NY gets no ring and makes no call connection', async () => {
        await addContacts(x, [y.pub]);
        // Review round R 5.3 (PRIV-2): the loader sends its chat key only with a reason, and NX is not NY's contact, so NX
        // may never learn NY's chat key (calls.start stays E_PEER_UNREACHABLE: nothing can ring NY). If NX does learn it, the
        // ring must still not reach NY. Either way NY gets no ring and makes no call connection.
        let r = null;
        try {
          r = await waitUntil(async () => {
            const res = await uiCall(x.page, 'start', [{ to: y.pub }], ['start']);
            if (res.code === 'E_PEER_UNREACHABLE') return null;
            return res;
          }, { timeoutMs: 15000, stepMs: 1000, label: 'calls.start' });
        } catch (_) { r = { code: 'E_PEER_UNREACHABLE' }; }
        assert((r.ok && r.ok.state === 'ringing') || r.code === 'E_PEER_UNREACHABLE', 'start ' + JSON.stringify(r));
        await sleep(5000);
        assert((await events(y.page, 'ring')).length === 0, 'NY was rung by a non-contact');
        assert((await callPcs(y.page)).length === 0, 'NY created a call connection');
        if (r.ok) await sdk(x.page, async (id) => (await import('/_mw/sdk.js')).default.calls.hangup(id), r.ok.id);
        return r.ok ? 'NX rang into nothing' : 'NX never learned NY\'s chat key (E_PEER_UNREACHABLE)';
      });
      await step('NY adds NX; NX calls again; NY declines: NX ends with E_DECLINED and never made a call connection', async () => {
        await addContacts(y, [x.pub]);
        // Now each looks for the other's chat key, so the keys come (PRIV-2); until they do, start is E_PEER_UNREACHABLE.
        const r = await waitUntil(async () => {
          const res = await uiCall(x.page, 'start', [{ to: y.pub }], ['start']);
          return res.code === 'E_PEER_UNREACHABLE' ? null : res;
        }, { timeoutMs: 45000, stepMs: 1000, label: 'calls.start after NY added NX' });
        assert(r.ok, 'start ' + JSON.stringify(r));
        const ring = await waitUntil(async () => (await events(y.page, 'ring')).find((e) => e.id === r.ok.id) || null, { timeoutMs: 20000, label: 'ring' });
        await sdk(y.page, async (id) => (await import('/_mw/sdk.js')).default.calls.decline(id), ring.id);
        const ended = await waitUntil(async () => (await events(x.page, 'ended')).find((e) => e.id === r.ok.id) || null, { timeoutMs: 20000, label: 'ended at NX' });
        assert(ended.code === 'E_DECLINED', 'ended ' + JSON.stringify(ended));
        assert((await callPcs(x.page)).length === 0, 'NX created a call connection, so an offer could have left');
        assert((await callPcs(y.page)).length === 0, 'NY created a call connection');
      });
      await step('a host-only visitor: mw.calls.start is E_HOST_ONLY before any card', async () => {
        const v = await visitor(ctx, browser, 'NH');
        const page = await v.newPage();
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await clickShellButton(page, new RegExp('^' + HOST_ONLY + '$'), { scope: '.mw-notice button, .mw-gate button', timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, label: 'NH site' });
        await siteControls(page);
        const r = await uiCall(page, 'start', [{ to: x.pub }], []);
        assert(r.code === 'E_HOST_ONLY', 'host-only ' + JSON.stringify(r));
        assert((await callPcs(page)).length === 0);
      });
      await step('a site with calls off: mw.calls.start is E_POLICY', async () => {
        const off = await callsSite(ctx, step, { calls: 'off' });
        const v = await visitor(ctx, browser, 'NO');
        const page = await v.newPage();
        await page.goto(off.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(page, { timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, label: 'NO site' });
        await siteControls(page);
        const r = await uiCall(page, 'start', [{ to: x.pub }], []);
        assert(r.code === 'E_POLICY', 'calls off ' + JSON.stringify(r));
      });
      return 'no ring and no connection from a non-contact; declined with no connection; E_HOST_ONLY; E_POLICY';
    },
  };

  // ------------------------------------------------------------------------------------------- E-CL-1
  S['E-CL-1'] = {
    title: 'ring, accept with video, connected within 10 s; media both ways; the certificate equals the sealed answer; no SDP text on the chat lane; mute and camera off; hang up ends everything (Chromium, fake devices)',
    async fn(ctx, step) {
      await closeMembers(ctx);
      const browser = await callBrowser(ctx);
      return oneToOne(ctx, step, browser, browser, 'C1');
    },
  };

  // ------------------------------------------------------------------------------------------- E-CL-2
  /** Closes the members earlier call scenarios left open, so a scenario's swarm holds only its own (C2 integrator: with the four
   *  of E-CL-3 and E-CL-1 still open, E-CL-2's ring did not reach a member in the full run). */
  async function closeMembers(ctx) {
    for (const k of Object.keys(ctx.shared)) {
      if (!k.startsWith('callMember:')) continue;
      const mbr = ctx.shared[k];
      delete ctx.shared[k];
      try { await mbr.v.close(); } catch (_) { /* gone */ }
      if (ctx.visitors && ctx.visitors.get(mbr.v.name) === mbr.v) ctx.visitors.delete(mbr.v.name);
    }
  }

  S['E-CL-2'] = {
    title: 'a group call of four from a metered context is audio only; 3 connected pairs each with audio from 3 peers; a leaver\'s pairs close within 5 s; a video call to five people is E_LIMIT',
    async fn(ctx, step) {
      await closeMembers(ctx);
      const m = await callsSite(ctx, step);
      const browser = await callBrowser(ctx);
      const g = [await member(ctx, step, browser, 'G0', m, { metered: true })];
      for (let i = 1; i < 4; i++) g.push(await member(ctx, step, browser, 'G' + i, m));
      const others = g.slice(1);
      await step('G0 adds G1 to G3 as contacts, and they add G0', async () => {
        await addContacts(g[0], others.map((o) => o.pub));
        for (const o of others) await addContacts(o, [g[0].pub]);
      });
      await step('a video call to five people is E_LIMIT, before any card', async () => {
        const extra = [];
        for (let i = 0; i < 2; i++) extra.push(await exportPublicKey((await generateKeyPair()).publicKey));
        await addContacts(g[0], extra);
        const r = await uiCall(g[0].page, 'start', [{ to: others.map((o) => o.pub).concat(extra), video: true }], []);
        assert(r.code === 'E_LIMIT', 'five people with video ' + JSON.stringify(r));
      });
      const started = await step('G0 (cellular) starts a call with G1, G2 and G3 asking for video: the group card, the metered card, audio only', async () => {
        const r = await waitUntil(async () => {
          const res = await uiCall(g[0].page, 'start', [{ to: others.map((o) => o.pub), video: true }], ['group', 'metered']);
          if (res.code === 'E_PEER_UNREACHABLE') return null;
          if (res.code) throw new StepError('start ' + res.code);
          return res.ok;
        }, { timeoutMs: 60000, stepMs: 2000, label: 'calls.start' });
        assert(r.kind === 'audio' && r.notice === 'metered', 'start ' + JSON.stringify(r));
        return r;
      });
      await step('G1, G2 and G3 accept with audio', async () => {
        for (const o of others) {
          const ring = await waitUntil(async () => (await events(o.page, 'ring')).find((e) => e.id === started.id) || null, { timeoutMs: 20000, label: 'ring at ' + o.v.name });
          const r = await uiCall(o.page, 'accept', [ring.id, { video: false }], ['audio']);
          assert(!r.code, o.v.name + ' accept ' + JSON.stringify(r));
        }
      });
      await step('each context has 3 connected pairs with audio from 3 peers, and no video', async () => {
        await waitUntil(async () => {
          for (const p of g) if ((await connectedPcs(p.page)).length !== 3) return false;
          return true;
        }, { timeoutMs: 45000, label: '3 connected pairs everywhere' });
        await sleep(3000);
        for (const p of g) {
          const pcs = await connectedPcs(p.page);
          assert(pcs.every((x) => x.audioIn > 0), p.v.name + ' audio from 3 peers ' + JSON.stringify(pcs.map((x) => x.audioIn)));
          assert(pcs.every((x) => x.videoOut === 0 && x.videoIn === 0), p.v.name + ' video bytes ' + JSON.stringify(pcs.map((x) => [x.videoOut, x.videoIn])));
        }
      });
      const left = await step('G2 hangs up: every pair with G2 closes within 5 s; the others keep 2 pairs', async () => {
        const t0 = Date.now();
        await sdk(g[2].page, async (id) => (await import('/_mw/sdk.js')).default.calls.hangup(id), started.id);
        await waitUntil(async () => {
          for (const p of [g[0], g[1], g[3]]) if ((await connectedPcs(p.page)).length !== 2) return false;
          return true;
        }, { timeoutMs: 5000, stepMs: 100, label: 'the leaver\'s pairs closed' });
        return Date.now() - t0;
      });
      for (const p of g) await sdk(p.page, async (id) => { try { await (await import('/_mw/sdk.js')).default.calls.hangup(id); } catch (_) { /* already ended */ } }, started.id);
      return 'audio only from a metered caller, 3 pairs each, the leaver\'s pairs closed in ' + left + ' ms';
    },
  };

  // ------------------------------------------------------------------------------------------- E-CL-1W
  S['E-CL-1W'] = {
    title: 'E-CL-1 in two WebKit browsers (one per participant), plus a screen shared from a trusted click',
    async fn(ctx, step) {
      const b1 = await launchWebkit({ headless: !headed });
      const b2 = await launchWebkit({ headless: !headed });
      if (!b1 || !b2) throw new StepError('Playwright WebKit is not installed');
      ctx.closers.push(() => b1.close(), () => b2.close());
      return oneToOne(ctx, step, b1, b2, 'W1', { screen: true });
    },
  };

  return S;
}

export { StepError };
