// test/e2e/scenarios-obs.mjs: usage reports (plan obs-2026-11-02, section 2.11; docs/OBSERVABILITY.md) through the real built loader, the real
// identity origin and the Node tracker, all on 127.0.0.1, with test/e2e/obs-collector.mjs standing in for the report endpoint. Run with
// `node test/e2e/run.mjs --only OBS-1,OBS-2,OBS-3`.
//
//   OBS-1  a site visitor: the first-run card names the report host, and nothing leaves the page before the yes (the page holds its events in
//          memory); after "Share and load" the events of the loader arrive in order, in one session, signed out (who null): boot, the card,
//          the click on its button, the choice, consent, pointer, fetch, render, trackers, peers, ICE by candidate type and the log lines of
//          the loader's own ring; the tail socket and /events.json hold the same batches as the store; the page's own count of what it sent
//          is what arrived; no address, port, user agent, URL fragment or whole infohash is in any body as the page sent it (the raw text,
//          before the endpoint masks it again), and a control proves that the scan would see one. Then a site published with --consent
//          gate: the gate names the host, nothing is shown or connected behind it, and its button, the choice, consent, the render and
//          the trackers follow in that order
//   OBS-2  pair: two door visitors in two browser processes pair as in APPS-2 (a code, a knock, an accept) and one sends a message. For each
//          session the collector shows the apps views, the sign-in steps, the link opening, and the conversation going waiting, connecting,
//          connected; the ICE events name candidate types and never an address (the addresses the pages really hold are looked for, and are
//          not there); who is each page's short id and never the other's; the request and accept order across the two sessions; no code
//          (whole or half), message or address leaves; a page that has not agreed ("Not now") sends nothing
//   OBS-3  no yes, no report: "Load from host only", the Settings switch turned off before the choice, and the switch turned off after reports
//          had begun (it stays off after a reload, and on again it sends again) send nothing more, and the page's own count and its
//          Diagnostics line say so; a site and a door whose door.json has no obs block never call the collector
//
// How the pages are given the endpoint: each scenario starts a dev server of its own over the run's build with --obs <collector origin>
// (tools/dev-server.mjs: the obs block in /_mw/door.json, loopback http allowed) and tells the collector that server's origin may post (the
// Worker's ALLOW_ORIGINS). OBS-1 and OBS-3 publish a guestbook for that server; OBS-2 serves the door page with the apps block beside the obs
// block. Network policy (docs/DEV-NETWORK.md): every URL is on 127.0.0.1, each page is a Visitor of lib.mjs, so the run's request guard
// applies; the collector is one more loopback server. MW_E2E_OBS_DUMP=<file prefix> writes the rows each scenario collected to
// <prefix>-<scenario id>.jsonl, for reading a failing run.
//
// The first yes on the door page is a price card's Continue (the card names the host), not the sign-in: the sign-in card is the loader's and
// names no host. These scenarios do not depend on that: a page that has not said yes must send nothing, one that has must send, and the
// scenarios hold a page for a flush interval and a little more at each point where it has not.
//
// Time across two sessions: a batch carries t0 in whole seconds and each event its time since the reporter began, so two events of two
// sessions are ordered by those times only when they are 1000 ms or more apart (sessionsOf in ./obs-collector.mjs). OBS-2 therefore waits
// GAP_MS between the steps whose order across the two sessions it asserts. Chromium only.

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import http from 'node:http';

import { Visitor, launchChromium, waitUntil, sleep, StepError, shellState, clickLoaderCard, clickShellButton, clickGateButton, gateState, waitForSite, isLocalUrl, ROOT } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { createCollector, firstOf, inOrder, matchEvent, findLeaks, show } from './obs-collector.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { publish } from '../../tools/publish.mjs';
import { CONSENT_ACCEPT_RE } from '../../tools/live.mjs';
import { STRINGS, UI_TEXT, fmt, appsText } from '../../src/loader/strings.js';
import { CONFIG } from '../../src/loader/config.js';

export const OBS_ORDER = ['OBS-1', 'OBS-2', 'OBS-3'];

const TX = (key, params) => appsText(key, 'en', params);
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const GROUP = '[' + ALPHA + ']{4}';
const CODE_RE = new RegExp('^' + GROUP + '-' + GROUP + '-' + GROUP + '$');
const SHORT_RE = new RegExp('^' + GROUP + '-' + GROUP + '$');
// One reporter flush is 2000 ms; a beacon then takes a moment more to arrive.
const FLUSH_WAIT_MS = 2800;
// Two events of two sessions are ordered by their times when this far apart (see the header).
const GAP_MS = 1300;
// A marker in the message OBS-2 sends: long enough that it is never in a report by chance.
const MARK = 'obs-e2e-q7kz';
// What the page reports for a host that is an IP address: the card tells the visitor 127.0.0.1, the reporter masks the same text like any address.
const MASKED = 'x.x.x.x';
// What describeTarget and the click listener may put in a ui.click event.
const CLICK_KEYS = ['t', 'n', 'role', 'fk', 'app', 'view', 'banner', 'dialog', 'row', 'card', 'id', 'tag', 'text', 'trusted', 'type'];
// A value that is a word, an id, a list of words or a type/protocol pair, and not a sentence.
const WORD_RE = /^[A-Za-z0-9_.:\-,/]{0,48}$/;
const ICE_KEYS = { 'ice.pc': ['id', 'ev'], 'ice.gathering': ['id', 'state'], 'ice.state': ['id', 'state'], 'ice.conn': ['id', 'state'], 'ice.local': ['id', 'type', 'proto'], 'ice.remote': ['id', 'sdp', 'types'], 'ice.pair': ['id', 'local', 'remote'] };
const KINDS = 'host|srflx|relay|prflx';

/** The origin of a URL, with ws and wss read as http and https. */
const originOfUrl = (url) => new URL(String(url).replace(/^ws/, 'http')).origin;
const portOfUrl = (url) => Number(new URL(String(url).replace(/^ws/, 'http')).port);

/** postBatch(collector, batch, origin) -> { status, text }: a POST /e from Node with the Origin a page would send (fetch may not set it). */
function postBatch(collector, batch, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: collector.host, port: collector.port, path: '/e', method: 'POST', headers: { 'content-type': 'text/plain', origin } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(batch));
  });
}

/** openTail(collector) -> { frames, close() }: a client of /tail?token=, as the operator tool opens it, open when it is returned. */
async function openTail(collector) {
  const frames = [];
  const url = collector.origin.replace(/^http/, 'ws') + '/tail?token=' + collector.token;
  let close = () => {};
  if (typeof globalThis.WebSocket === 'function') {
    const sock = new globalThis.WebSocket(url);
    sock.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise((resolve, reject) => {
      sock.onopen = resolve;
      sock.onerror = () => reject(new StepError('the collector refused the tail socket'));
    });
    close = () => sock.close();
  } else {
    const mod = await import('ws');
    const Sock = mod.WebSocket || mod.default;
    const sock = new Sock(url);
    sock.on('message', (data) => frames.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      sock.on('open', resolve);
      sock.on('error', () => reject(new StepError('the collector refused the tail socket')));
    });
    close = () => sock.close();
  }
  return { frames, close };
}

/** Records every request a context makes (its URL and method), so a scenario can say which origins a page talked to. */
function tapContext(visitor) {
  const seen = [];
  visitor.context.on('request', (r) => {
    if (seen.length < 6000) seen.push({ t: Date.now(), url: r.url(), method: r.method(), type: r.resourceType() });
  });
  return seen;
}

// ---------------------------------------------------------------------------------------------
// init script: keeps the page's peer connections, so a scenario can ask them for the addresses they really hold
// ---------------------------------------------------------------------------------------------

/** window.__mwObsPc: { made, pcs }. It runs before any page script, after the run's own ICE-server stripping; the loader's wrapper goes on top. */
function pcWatch() {
  if (window.__mwObsPc) return;
  const W = { made: 0, pcs: [] };
  window.__mwObsPc = W;
  const Inner = window.RTCPeerConnection;
  if (typeof Inner !== 'function') return;
  const Wrapped = function RTCPeerConnection(config, ...rest) {
    W.made++;
    const pc = new Inner(config, ...rest);
    W.pcs.push(pc);
    return pc;
  };
  Wrapped.prototype = Inner.prototype;
  Object.setPrototypeOf(Wrapped, Inner);
  window.RTCPeerConnection = Wrapped;
}

/** Runs in the page: every address its peer connections know (candidate addresses of the stats and of the local description). */
async function candidateAddresses() {
  const found = new Set();
  const W = window.__mwObsPc;
  if (!W) return [];
  for (const pc of W.pcs) {
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type !== 'local-candidate' && s.type !== 'remote-candidate') return;
        for (const k of ['address', 'ip']) if (s[k]) found.add(String(s[k]));
      });
    } catch (_) { /* a closed connection has no stats */ }
    try {
      const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
      for (const m of sdp.matchAll(/candidate:\S+ \d+ \w+ \d+ (\S+) \d+ typ/g)) found.add(m[1]);
    } catch (_) { /* no description yet */ }
  }
  return Array.from(found);
}

// ---------------------------------------------------------------------------------------------
// parties: one Chromium process, one profile, one page (the shape of scenarios-apps.mjs, with what these scenarios use)
// ---------------------------------------------------------------------------------------------

class Party {
  constructor(name, browser, visitor, page) {
    this.name = name;
    this.browser = browser;
    this.v = visitor;
    this.page = page;
    this.short = null;
    this.requests = []; // every request of the page: { t, url, method }
    page.on('request', (r) => {
      if (this.requests.length < 6000) this.requests.push({ t: Date.now(), url: r.url(), method: r.method() });
    });
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

  /** The id the person sees for this page: a visit identity has no name, so the header is just "xxxx-xxxx". */
  async shortId() {
    const t = await this.text('[data-role="me"]');
    if (!SHORT_RE.test(t)) throw new StepError(this.name + ': the header is not a short id: ' + t);
    return t;
  }

  /** The messages of the open conversation as plain data. */
  messages() {
    return this.page.evaluate(() => Array.from(document.querySelectorAll('[data-role="messages"] li[data-msg]')).map((li) => {
      const body = li.querySelector('[data-role="body"]');
      return { id: li.getAttribute('data-msg'), mine: li.getAttribute('data-mine') === '1', status: li.getAttribute('data-status') || '', text: body ? body.textContent : '' };
    }));
  }

  async close() {
    await this.v.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// the scenarios
// ---------------------------------------------------------------------------------------------

/** obsScenarios({ run, assert, headed }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function obsScenarios({ run, assert, headed = false }) {
  const S = {};
  const bad = (what, v) => what + ': ' + JSON.stringify(v);

  // ---- the stack ------------------------------------------------------------------------------

  /**
   * closeAllMine(ctx): closes every visitor and party these scenarios may have left open, which a failed scenario does (the run keeps them so
   * it can print their logs). One that stayed open would go on posting to the collector and be counted in the next scenario.
   */
  async function closeAllMine(ctx) {
    for (const name of ['OBS1', 'OBS1G', 'OBS3H', 'OBS3S1', 'OBS3S2', 'OBS3N']) await ctx.closeVisitor(name);
    await closeLeftovers(ctx);
  }

  /** The collector, once per run; its address is what every dev server below names in its obs block. */
  async function kit(ctx, step) {
    if (ctx.shared.obs) return ctx.shared.obs;
    const k = await step('the collector: a loopback stand-in for the report endpoint (/e, /events.json, /tail) on the rules of deploy/obs-worker', async () => {
      const collector = await createCollector({});
      ctx.closers.push(() => collector.close());
      assert(collector.origin.startsWith('http://127.0.0.1:'), 'the collector is at ' + collector.origin);
      return { collector, validator: collector.validator };
    });
    ctx.shared.obs = k;
    return k;
  }

  /** A guestbook for a dev server whose door.json carries the obs block: { dev, pub, url, origin }. gated: published with --consent gate. */
  async function siteOf(ctx, step, { gated = false } = {}) {
    const k = await kit(ctx, step);
    const slot = gated ? 'gatedSite' : 'site';
    if (k[slot]) return k[slot];
    k[slot] = await step('a guestbook on a dev server started with --obs <the collector>, published for scope 127.0.0.1 with a ledger of its own' + (gated ? ' and --consent gate' : ''), async () => {
      const { stack } = ctx;
      const outDir = join(stack.runDir, gated ? 'obs-publish-gate' : 'obs-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true, obs: k.collector.origin });
      ctx.closers.push(() => dev.close());
      assert(dev.obs && dev.obs.endpoint === k.collector.origin, 'the dev server serves the obs block ' + JSON.stringify(dev.obs));
      const origin = new URL(dev.url).origin;
      k.collector.allowOrigin(origin);
      const pub = await publish(Object.assign({
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: gated ? 'obs-gated-guestbook' : 'obs-guestbook', scope: '127.0.0.1', chain: gated ? 'e2e-obs-gate' : 'e2e-obs', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
      }, gated ? { consent: 'gate' } : {}));
      dev.setPointer(pub.pointer);
      const json = await (await fetch(dev.url + '_mw/door.json')).json();
      assert(json.obs && json.obs.endpoint === k.collector.origin, 'the served door.json: ' + JSON.stringify(json.obs));
      return { dev, pub, url: dev.url, origin };
    });
    return k[slot];
  }

  /** The door page: apps block and obs block in one door.json. */
  async function doorOf(ctx, step) {
    const k = await kit(ctx, step);
    if (k.door) return k.door;
    k.door = await step('the door: a dev server whose door.json has the apps block (the stack\'s tracker and identity origin) and the obs block (the collector)', async () => {
      const { stack } = ctx;
      const dev = await createDevServer({
        root: stack.dist, port: 0, host: '127.0.0.1', dev: true, quiet: true,
        appsRendezvous: [stack.tracker.url], appsStun: [], appsIdp: stack.idp.url, obs: k.collector.origin,
      });
      ctx.closers.push(() => dev.close());
      const origin = new URL(dev.url).origin;
      k.collector.allowOrigin(origin);
      const json = await (await fetch(dev.url + '_mw/door.json')).json();
      assert(json.apps && json.apps.rendezvous[0] === stack.tracker.url && json.obs && json.obs.endpoint === k.collector.origin, 'the served door.json: ' + JSON.stringify([json.apps, json.obs]));
      return { dev, origin, page: dev.url + '_mw/open.html', rendezvous: stack.tracker.url, idp: stack.idp.url };
    });
    return k.door;
  }

  /** The ports of every loopback server a run talks to, for the leak scan. */
  function portsOf(ctx, k) {
    const urls = [ctx.stack.origin, ctx.stack.tracker.url, ctx.stack.idp.url, k.collector.origin];
    if (k.site) urls.push(k.site.url);
    if (k.gatedSite) urls.push(k.gatedSite.url);
    if (k.door) urls.push(k.door.page);
    return Array.from(new Set(urls.map(portOfUrl)));
  }

  /**
   * assertClean(collector, { ports, literals }, label) -> the number of texts scanned: no body as the page sent it (the raw POST text), and no
   * row as stored, holds an address, a port, a user agent, a URL fragment, a whole pair code, a hash of 40 hex digits, or one of the literals.
   */
  function assertClean(collector, { ports, literals = [] }, label) {
    const texts = collector.rawBodies().concat(collector.rows().map((row) => JSON.stringify(row)));
    assert(texts.length > 0, label + ': nothing to scan');
    const hits = [];
    for (const text of texts) for (const hit of findLeaks(text, { ports, literals })) if (hits.indexOf(hit) < 0) hits.push(hit);
    assert(!hits.length, label + ': a report holds ' + hits.slice(0, 5).join('; '));
    return texts.length;
  }

  /**
   * Adds what the collector held to a failing step, so the run's output says what had arrived. With MW_E2E_OBS_DUMP=<file prefix> the rows
   * of the scenario are also written, one JSON row per line, to <prefix>-<scenario id>.jsonl (the text as stored, after the endpoint's masks).
   */
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
          writeFileSync(prefix + '-' + id + '.jsonl', collector.rows().map((row) => JSON.stringify(row)).join('\n') + '\n');
        } catch (_) { /* a dump is a convenience */ }
      }
    }
  }

  /**
   * settled(collector, pages, label) -> [{ obs, session }]: waits until every page has handed over what it holds and the collector holds exactly
   * that: nothing queued, nothing dropped, and the page's count of events sent equals the events of its session (a batch that was sent twice
   * counts once). pages: [{ obs: async () => inspect().obs, session: (sessions) => the session of this page }].
   */
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

  /** assertIce(session, label, { connected }): the ICE events of a session carry the catalogue's fields, candidate types and protocols, never an address. */
  function assertIce(x, label, { connected = false } = {}) {
    const ice = x.events.filter((e) => /^ice\./.test(e.n));
    assert(ice.length >= 4, label + ' reported ' + ice.length + ' ICE events');
    const kind = new RegExp('^(' + KINDS + ')$');
    const pair = new RegExp('^(' + KINDS + ')/(udp|tcp)$');
    for (const e of ice) {
      assert(ICE_KEYS[e.n], label + ': an ICE event the catalogue does not have: ' + e.n);
      const keys = Object.keys(e).filter((q) => ['t', 'n'].indexOf(q) < 0 && q[0] !== '$');
      assert(keys.every((q) => ICE_KEYS[e.n].indexOf(q) >= 0), label + ': ' + e.n + ' carries ' + JSON.stringify(keys));
      if (e.n === 'ice.local') assert(kind.test(e.type) && /^(udp|tcp)$/.test(e.proto), bad(label + ' ice.local', e));
      if (e.n === 'ice.remote') assert(/^(offer|answer)$/.test(e.sdp) && new RegExp('^(' + KINDS + ')(,(' + KINDS + '))*$').test(e.types), bad(label + ' ice.remote', e));
      if (e.n === 'ice.pair') assert(pair.test(e.local) && pair.test(e.remote), bad(label + ' ice.pair', e));
      if (e.n === 'ice.pc') assert(/^(created|closed)$/.test(e.ev), bad(label + ' ice.pc', e));
      if (e.n === 'ice.gathering') assert(/^(new|gathering|complete)$/.test(e.state), bad(label + ' ice.gathering', e));
      if (e.n === 'ice.conn') assert(/^(new|connecting|connected|disconnected|failed|closed)$/.test(e.state), bad(label + ' ice.conn', e));
    }
    assert(ice.some((e) => e.n === 'ice.local'), label + ': no ice.local event');
    assert(!ice.some((e) => e.type === 'srflx' || e.type === 'relay'), label + ': a server-reflexive or relay candidate (the pages name no STUN server in this run)');
    if (connected) assert(ice.some((e) => matchEvent(e, { n: 'ice.conn', state: 'connected' })) && ice.some((e) => matchEvent(e, { n: 'ice.pair', local: /^host\//, remote: /^host\// })), label + ': no connected pair of host candidates in ' + ice.map((e) => e.n).join(' '));
  }

  /** assertWords(session, label): outside the events that carry text by design (log, error, ui.click), every string field is a word, an id or a short list. */
  function assertWords(x, label) {
    for (const e of x.events) {
      if (/^(log|error|ui\.click)$/.test(e.n)) continue;
      for (const q of Object.keys(e)) {
        if (q === 'n' || q === 't' || q[0] === '$') continue;
        assert(typeof e[q] !== 'string' || WORD_RE.test(e[q]), label + ': ' + e.n + '.' + q + ' is not a word: ' + JSON.stringify(e[q]));
      }
    }
  }

  /** assertClicks(session, label): every ui.click was a real click on a control named by its role, id or tag, with at most 24 characters of its label; ui.change holds no value of a text field. */
  function assertClicks(x, label) {
    const clicks = x.events.filter((e) => e.n === 'ui.click');
    assert(clicks.length > 0, label + ': no ui.click event');
    for (const e of clicks) {
      assert(Object.keys(e).filter((q) => q[0] !== '$').every((q) => CLICK_KEYS.indexOf(q) >= 0), bad(label + ' ui.click holds more than describeTarget and the listener give', e));
      assert(e.type === 'click' && e.trusted === true, bad(label + ' ui.click', e));
      assert(typeof e.text !== 'string' || e.text.length <= 24, bad(label + ' ui.click text is cut at 24 characters', e));
      assert(['role', 'fk', 'app', 'view', 'banner', 'dialog', 'row', 'card', 'id', 'tag'].some((q) => typeof e[q] === 'string'), bad(label + ' ui.click names no control', e));
    }
    for (const e of x.events.filter((q) => q.n === 'ui.change')) {
      assert(Object.keys(e).filter((q) => ['t', 'n', 'control'].indexOf(q) < 0 && q[0] !== '$').length === 0, bad(label + ' ui.change carries a value of a text field', e));
    }
  }

  /** assertFirstYes(session, label): the page told its first yes once, after the apps home was shown, and by a card or the sign-in. */
  function assertFirstYes(x, label) {
    const yes = x.events.filter((e) => e.n === 'apps.first-yes');
    assert(yes.length === 1 && /^(card|signin)$/.test(yes[0].via), bad(label + ' apps.first-yes', yes));
    assert(x.events.findIndex((e) => e === yes[0]) > x.events.findIndex((e) => matchEvent(e, { n: 'apps.view', view: 'home' })), label + ': the first yes came before the home was shown');
  }

  // ---- waiting and acting on a site page --------------------------------------------------------

  /** The loader's own report state of a page (window.__mwShell.inspect().obs), or null. */
  const obsOf = async (page) => {
    const st = await shellState(page);
    return st ? st.obs : null;
  };

  /** Presses a button of the first-run card (light DOM, a trusted click) whose whole text matches re. */
  const pressCard = (page, re, label) => clickShellButton(page, re, { scope: '.mw-notice button, .mw-gate button', timeoutMs: 20000, label });

  /** Waits until the first-run card is up and returns its text. */
  async function cardText(page) {
    return waitUntil(async () => {
      const t = await page.evaluate(() => {
        const n = document.querySelector('.mw-notice');
        return n && !n.hidden && n.getClientRects().length ? n.innerText.replace(/\s+/g, ' ').trim() : '';
      });
      return t || null;
    }, { timeoutMs: 20000, stepMs: 100, label: 'the first-run card' });
  }

  /** True when the Settings dialog is on screen. */
  const settingsOpen = (page) => page.locator('#mw-settings-title').isVisible();

  /** Opens the Settings dialog (the button of the bar, which the pill shows again when the bar has been folded away) unless it is open already. */
  async function openSettings(page) {
    if (await settingsOpen(page)) return;
    const button = page.locator('.mw-settings-btn');
    if (!(await button.isVisible())) {
      const pill = page.locator('.mw-pill');
      if ((await pill.getAttribute('aria-expanded')) === 'false') await pill.click({ timeout: 5000 });
    }
    await button.click({ timeout: 10000 });
    await page.locator('#mw-settings-title').waitFor({ state: 'visible', timeout: 10000 });
  }

  /** Closes the Settings dialog with its Close button (a real click). */
  async function closeSettings(page) {
    if (!(await settingsOpen(page))) return;
    await page.locator('.mw-scrim:visible button', { hasText: new RegExp('^' + STRINGS.settingsClose + '$') }).first().click({ timeout: 5000 });
    await page.locator('#mw-settings-title').waitFor({ state: 'hidden', timeout: 5000 });
  }

  /** The usage report switch of the Settings dialog: open Settings, set the switch with a real click on its label, close Settings. */
  async function setReportsSwitch(page, on) {
    await openSettings(page);
    const label = page.locator('label[for="mw-reports"]');
    await label.waitFor({ state: 'visible', timeout: 10000 });
    const box = page.locator('#mw-reports');
    await waitUntil(async () => !(await box.isDisabled()), { timeoutMs: 10000, label: 'the usage report switch is enabled' });
    if ((await box.isChecked()) !== on) await label.click({ timeout: 5000 });
    await waitUntil(async () => (await box.isChecked()) === on, { timeoutMs: 5000, label: 'the switch shows ' + (on ? 'on' : 'off') });
    await closeSettings(page);
  }

  /** The one line of the Diagnostics section about the reports ("Usage reports to <host>: <state>. Sent n, waiting n, dropped n."), or ''. */
  const reportsLine = (page) => page.locator('.mw-reports-line').first().textContent().then((t) => String(t || '').replace(/\s+/g, ' ').trim()).catch(() => '');

  // ------------------------------------------------------------------------------------------- OBS-1
  S['OBS-1'] = {
    title: 'a site visitor: the first-run card names the report host and nothing leaves before the yes; then boot, the card, the click, consent, pointer, fetch, render, trackers, peers, ICE and the log lines arrive in order in one session, with no address in any body',
    async fn(ctx, step) {
      await closeAllMine(ctx);
      const k = await kit(ctx, step);
      const site = await siteOf(ctx, step);
      const { collector } = k;
      collector.clear();
      const run0 = run.violations.length;
      const btih = site.pub.btih;
      return noted(collector, 'OBS-1', async () => {
        const tail = await step('an operator\'s tail socket opens first (GET /tail?token=, the way felinar-ops events-tail does) and is greeted', async () => {
          const t = await openTail(collector);
          await collector.waitFor(() => t.frames.length >= 1, { label: 'the hello frame' });
          assert(t.frames[0].type === 'hello' && t.frames[0].batches === 0, bad('hello frame', t.frames[0]));
          return t;
        });
        ctx.closers.push(() => tail.close());

        const v = await ctx.visitor('OBS1');
        const seen = tapContext(v);
        const callsTo = () => seen.filter((r) => new URL(r.url).origin === collector.origin);
        const opened = await step('a visitor opens the site (consent left pending): it renders from its host', () => ctx.openSite('OBS1', { url: site.url, consent: false }));
        const page = opened.page;
        const session = () => Array.from(collector.sessions().values())[0];

        await step('the first-run card says that this page also sends usage reports to the collector\'s host; for a flush interval and more nothing leaves the page, which holds its events in memory', async () => {
          const text = await cardText(page);
          assert(STRINGS.consentReports, 'strings.js has no consentReports line');
          const line = fmt(STRINGS.consentReports, { host: collector.host });
          assert(text.indexOf(line) >= 0, 'the card does not hold the reports line for ' + collector.host + ': ' + text.slice(0, 900));
          await sleep(FLUSH_WAIT_MS);
          assert(collector.pageRequests().length === 0, 'the page called the collector before the yes: ' + JSON.stringify(collector.pageRequests().slice(0, 3)));
          assert(callsTo().length === 0, 'a request to the collector origin before the yes');
          const o = await obsOf(page);
          assert(o && o.host === collector.host && o.enabled === true && o.allowed === false && o.sent === 0 && o.queued > 0 && o.batches === 0, bad('inspect().obs before the yes', o));
        });

        await step('"Share and load" is pressed (a real click): the held events go out', async () => {
          await pressCard(page, CONSENT_ACCEPT_RE, 'the consent button');
          await collector.waitFor((c) => c.count() >= 1, { timeoutMs: 20000, label: 'the first batch' });
        });

        await step('the page goes on: the swarm trackers, the peers count and the loader\'s log lines are reported, until the page has handed over everything it holds', async () => {
          await collector.waitFor((c) => {
            const x = Array.from(c.sessions().values())[0];
            return x && firstOf(x.events, 'tracker.state') && firstOf(x.events, 'peers.count');
          }, { timeoutMs: 30000, label: 'tracker.state and peers.count' });
          await settled(collector, [{ obs: () => obsOf(page), session: (sessions) => sessions[0] }]);
        });

        const s = await step('one session, signed out, labelled with this loader, this build and this site; batches numbered without a gap, times that never go back', async () => {
          const sessions = collector.sessions();
          assert(sessions.size === 1, 'sessions: ' + Array.from(sessions.keys()).join(', '));
          const one = session();
          assert(/^[a-z2-9]{12}$/.test(one.sid), 'sid ' + one.sid);
          assert(one.page === 'site', 'page ' + one.page);
          assert(one.ua && one.ua.browser === 'chromium' && one.ua.mobile === false, bad('ua', one.ua));
          assert(one.loader === CONFIG.version, 'loader ' + one.loader + ' (the build is ' + CONFIG.version + ')');
          assert(one.who.length === 1 && one.who[0] === null, bad('who: a visitor who never signed in', one.who));
          const door = JSON.parse(await (await fetch(site.url + '_mw/door.json')).text());
          assert(one.build === door.buildId, 'build ' + one.build + ' (the door.json says ' + door.buildId + ')');
          assert(one.site.every((x) => x === '' || x === btih.slice(0, 8)) && one.site[one.site.length - 1] === btih.slice(0, 8), bad('site: the first 8 characters of the infohash, nothing more', one.site));
          assert(one.seqs.every((q, i) => q === i), bad('batch numbers', one.seqs));
          assert(one.repeats === 0, one.repeats + ' batch(es) arrived twice');
          for (let i = 1; i < one.events.length; i++) assert(one.events[i].t >= one.events[i - 1].t, 'event times go back at ' + show(one.events[i]) + ' (' + one.events[i - 1].t + ' then ' + one.events[i].t + ')');
          return one;
        });

        await step('the events are in the order the loader did things: boot, the card, the click on its button, the choice, consent; pointer, fetch, render; trackers and peer connections after consent', async () => {
          const names = s.events.map((e) => e.n);
          const c1 = inOrder(s.events, ['boot.start', 'boot.features', 'boot.stage', 'run.start',
            { n: 'gate.shown', kind: 'consent', host: MASKED },
            { n: 'ui.click', trusted: true, type: 'click', text: CONSENT_ACCEPT_RE },
            { n: 'gate.choice', choice: 'accepted' }, { n: 'consent.set', choice: 'accepted' }]);
          assert(c1.ok, 'order of the first chain: ' + c1.link + ' not after ' + c1.after + ' in ' + names.join(' '));
          const c2 = inOrder(s.events, ['run.start', 'pointer.resolved', { n: 'site.fetch', step: 'start' }, { n: 'site.fetch', step: 'done' }, { n: 'render.done', mode: 'site' }]);
          assert(c2.ok, 'order of the second chain: ' + c2.link + ' not after ' + c2.after + ' in ' + names.join(' '));
          const consentAt = s.events.findIndex((e) => matchEvent(e, { n: 'consent.set', choice: 'accepted' }));
          // a web seed is the host's own copy, a wire to it is not a peer; trackers, connections and peer wires are what waits for the yes
          const early = s.events.slice(0, consentAt).filter((e) => /^(tracker\.state|ice\.|peer\.ice)/.test(e.n) || (e.n === 'peer.wire' && e.web === false));
          assert(!early.length, 'the page reported trackers or peer connections before the yes: ' + early.map((e) => e.n).join(' '));
          const tr = firstOf(s.events, 'tracker.state');
          assert(tr && /^(open|connecting|reconnecting|closed)$/.test(tr.state) && tr.host === MASKED, bad('tracker.state (a loopback tracker is an address, so it is masked)', tr));
          const peers = firstOf(s.events, 'peers.count');
          assert(Number.isInteger(peers.count) && Number.isInteger(peers.webseeds), bad('peers.count', peers));
          assert(s.events.some((e) => matchEvent(e, { n: 'peer.wire', web: true })), 'no wire to the web seed was reported');
          const log = s.events.filter((e) => e.n === 'log');
          assert(log.length >= 3 && log.every((e) => typeof e.m === 'string' && e.m.length > 0), log.length + ' log events');
          return names.length + ' events, ' + new Set(names).size + ' names';
        });

        await step('what the ICE events, the clicks and every other field hold: candidate types and protocols, controls named by role, id or tag, and words, never a sentence of a person', async () => {
          assertIce(s, 'OBS-1');
          assertClicks(s, 'OBS-1');
          assertWords(s, 'OBS-1');
        });

        await step('the loader\'s own log ring is mirrored line by line: every kind of line in its Diagnostics log has a log event', async () => {
          const st = await shellState(page);
          const ring = (st.log || []).map((l) => l.replace(/^\d\d:\d\d:\d\d\.\d{3} /, ''));
          assert(ring.length >= 3, 'the log ring holds ' + ring.length + ' lines');
          // A line and its mirror agree on their first two words (the rest may have been masked: an address, a hash, a code).
          const lead = (line) => line.toLowerCase().split(/[^a-z]+/).filter(Boolean).slice(0, 2).join(' ');
          const wanted = Array.from(new Set(ring.map(lead))).filter(Boolean);
          let missing = wanted;
          try {
            await waitUntil(async () => {
              const mirrored = new Set(session().events.filter((e) => e.n === 'log').map((e) => lead(String(e.m))));
              missing = wanted.filter((x) => !mirrored.has(x));
              return missing.length === 0;
            }, { timeoutMs: 8000, stepMs: 250, label: 'the log mirror' });
          } catch (err) {
            throw new StepError('lines of the log ring that have no log event: ' + JSON.stringify(missing.slice(0, 6)));
          }
          return ring.length + ' lines, ' + wanted.length + ' kinds';
        });

        await step('no body, as the page sent it, holds an address, a port, a user agent, a URL fragment, a whole pair code or the whole infohash; every report was a plain POST /e that the collector took', async () => {
          const n = assertClean(collector, { ports: portsOf(ctx, k), literals: [btih] }, 'OBS-1');
          assert(collector.posts().length > 0 && collector.posts().every((p) => p.status === 204 && /^text\/plain/.test(p.type)), bad('posts', collector.posts().filter((p) => p.status !== 204 || !/^text\/plain/.test(p.type)).map((p) => [p.status, p.reason, p.type])));
          assert(collector.pageRequests().every((r) => r.method === 'POST' && r.path === '/e'), bad('requests of the page: reports are plain POSTs (no preflight)', collector.pageRequests().filter((r) => r.method !== 'POST')));
          // the page's own request list saw the same posts: the checks above and before the yes looked at something that shows these requests
          assert(callsTo().length === collector.posts().length && callsTo().every((r) => r.method === 'POST'), 'the page made ' + callsTo().length + ' calls to the collector, which holds ' + collector.posts().length + ' posts');
          return n + ' texts scanned';
        });

        await step('the page\'s own count agrees with the collector (sent equals arrived, nothing dropped) and the request guard saw nothing leave 127.0.0.1', async () => {
          const [now] = await settled(collector, [{ obs: () => obsOf(page), session: (sessions) => sessions[0] }]);
          assert(now.obs.lastOk !== false && now.session.events.length >= s.events.length, bad('inspect().obs', now.obs));
          assert(run.violations.length === run0, 'requests left 127.0.0.1: ' + JSON.stringify(run.violations.slice(run0)));
        });

        await step('the tail socket and /events.json hold the same batches as the collector\'s store, in the same order', async () => {
          const rows = collector.rows();
          await collector.waitFor(() => tail.frames.length >= rows.length + 1, { label: 'the tail frames' });
          const key = (row) => row.sid + ':' + row.body.seq;
          assert(tail.frames[0].type === 'hello', 'first frame ' + JSON.stringify(tail.frames[0]));
          const frames = tail.frames.slice(1, rows.length + 1);
          assert(JSON.stringify(frames.map(key)) === JSON.stringify(rows.map(key)), 'tail frames ' + frames.map(key).join(' ') + ' against rows ' + rows.map(key).join(' '));
          assert(JSON.stringify(frames) === JSON.stringify(rows), 'a tail frame is not the stored row');
          const res = await fetch(collector.origin + '/events.json?token=' + collector.token + '&limit=1000');
          const body = await res.json();
          assert(res.status === 200 && body.more === false && JSON.stringify(body.batches.slice(0, rows.length)) === JSON.stringify(rows), 'events.json: ' + res.status + ' ' + body.batches.length + ' batches against ' + rows.length + ' rows');
          assert((await fetch(collector.origin + '/events.json')).status === 404, '/events.json answered without the token');
        });

        await step('a control: a batch that does carry an address is caught by the very scan used above, so a clean result is not a scan that cannot see', async () => {
          const canary = { v: 1, sid: 'c4n4ryc4n4ry', seq: 0, page: 'site', build: '', loader: CONFIG.version, site: '', who: null, net: null, ua: { browser: 'chromium', mobile: false }, t0: Math.floor(Date.now() / 1000), events: [{ t: 1, n: 'log', m: 'peer 192.0.2.7:4242 joined' }] };
          const res = await postBatch(collector, canary, site.origin);
          assert(res.status === 204, 'the collector refused the control batch: ' + res.status + ' ' + res.text);
          let caught = null;
          try {
            assertClean(collector, { ports: portsOf(ctx, k), literals: [btih] }, 'control');
          } catch (err) {
            caught = err;
          }
          assert(caught instanceof StepError && /an IPv4 address/.test(caught.message), 'the scan did not see the address of the control batch: ' + (caught && caught.message));
          assert(!JSON.stringify(collector.rows().slice(-1)[0]).includes('192.0.2.7'), 'the endpoint stored the address it was sent');
        });

        await ctx.closeVisitor('OBS1');
        tail.close();

        // ---- the gate: a site whose pointer says consent=gate shows the blocking gate before anything loads; its button is the yes
        const gated = await siteOf(ctx, step, { gated: true });
        collector.clear();
        const gv = await ctx.visitor('OBS1G');
        const gseen = tapContext(gv);
        const gpage = await step('a visitor opens a site published with --consent gate: the gate stands before anything loads', async () => {
          const page = await gv.newPage();
          await page.goto(gated.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitUntil(async () => ((await gateState(page)).visible ? true : null), { timeoutMs: 20000, label: 'the gate' });
          return page;
        });
        await step('the gate says that loading it peer-to-peer also sends usage reports to the collector\'s host; the site is not loaded, and for a flush interval and more nothing leaves the page', async () => {
          const g = await gateState(gpage);
          const line = fmt(STRINGS.gateReports, { host: collector.host });
          assert(g.text.indexOf(line) >= 0, 'the gate does not hold the reports line for ' + collector.host + ': ' + g.text.slice(0, 900));
          assert(g.buttons.indexOf(STRINGS.gateLoad) >= 0, bad('gate buttons', g.buttons));
          await sleep(FLUSH_WAIT_MS);
          const st = await shellState(gpage);
          assert(st && st.mounted === false, bad('the site is mounted behind the gate', st && st.mounted));
          assert(collector.pageRequests().length === 0 && gseen.every((r) => new URL(r.url).origin !== collector.origin), 'the page called the collector while the gate was up');
          const o = await obsOf(gpage);
          assert(o && o.allowed === false && o.sent === 0 && o.queued > 0, bad('inspect().obs while the gate is up', o));
        });
        await step('"Load" is pressed (a real click): the held events go out, the site loads, and the trackers come after', async () => {
          assert(await clickGateButton(gpage, new RegExp('^' + STRINGS.gateLoad + '$')), 'no Load button');
          await collector.waitFor((c) => c.count() >= 1, { timeoutMs: 20000, label: 'the first batch after Load' });
          await waitForSite(gpage, { timeoutMs: 30000, label: 'the gated site' });
          await collector.waitFor((c) => {
            const x = Array.from(c.sessions().values())[0];
            return x && firstOf(x.events, 'tracker.state');
          }, { timeoutMs: 30000, label: 'tracker.state' });
          await settled(collector, [{ obs: () => obsOf(gpage), session: (sessions) => sessions[0] }]);
        });
        const g = await step('one session, signed out; the gate, the click on its button, the choice and consent, then the render and the trackers, in this order and none of them before the click', async () => {
          const sessions = collector.sessions();
          assert(sessions.size === 1, 'sessions: ' + Array.from(sessions.keys()).join(', '));
          const one = session();
          assert(one.page === 'site' && one.who.length === 1 && one.who[0] === null, bad('page and who', [one.page, one.who]));
          assert(one.site[one.site.length - 1] === gated.pub.btih.slice(0, 8), bad('site', one.site));
          assert(one.repeats === 0 && one.seqs.every((q, i) => q === i), bad('batch numbers', one.seqs));
          const r = inOrder(one.events, ['boot.start', 'boot.features', 'boot.stage', 'run.start', 'pointer.resolved',
            { n: 'gate.shown', kind: 'gate', host: MASKED },
            { n: 'ui.click', dialog: 'mw-gate-title', trusted: true, type: 'click', text: STRINGS.gateLoad },
            { n: 'gate.choice', choice: 'accepted' }, { n: 'consent.set', choice: 'accepted' },
            { n: 'render.done', mode: 'site' }, { n: 'tracker.state' }]);
          assert(r.ok, 'the gate chain: ' + r.link + ' is not after ' + r.after + ' in ' + one.events.map((e) => e.n).join(' '));
          // the host's own copy may be fetched behind the gate (a wire to a web seed is not a peer); showing the site, trackers and peers wait for the yes
          const clickAt = one.events.findIndex((e) => e.n === 'ui.click');
          const early = one.events.slice(0, clickAt).filter((e) => /^(render\.done|tracker\.state|ice\.|peer\.ice)/.test(e.n) || (e.n === 'peer.wire' && e.web === false));
          assert(!early.length, 'the page showed the site or connected to peers before the gate was answered: ' + early.map((e) => e.n).join(' '));
          assertIce(one, 'gate');
          assertClicks(one, 'gate');
          assertWords(one, 'gate');
          return one;
        });
        await step('no body of the gated page, as it sent it, holds an address, a port, a user agent, a fragment, a whole code or the whole infohash', async () => {
          assertClean(collector, { ports: portsOf(ctx, k), literals: [gated.pub.btih] }, 'OBS-1 gate');
          assert(collector.posts().every((p) => p.status === 204) && collector.pageRequests().every((r) => r.method === 'POST' && r.path === '/e'), 'the gated page posted something that was not a plain POST /e taken by the collector');
        });
        await ctx.closeVisitor('OBS1G');
        assert(run.violations.length === run0, 'requests left 127.0.0.1: ' + JSON.stringify(run.violations.slice(run0)));
        return s.events.length + ' events in ' + s.batches.length + ' batches (' + new Set(s.events.map((e) => e.n)).size + ' names) from one session, validated by ' + k.validator + '; the first-run card named ' + collector.host + ' and the page held everything until the yes; then a gated site: ' + g.events.length + ' events, the gate first';
      });
    },
  };

  // ---- parties and the apps of the door page ------------------------------------------------------

  /** Closes the parties a failed scenario left open (kept so the run could print their logs). */
  async function closeLeftovers(ctx) {
    const left = ctx.shared.obsOpen || [];
    ctx.shared.obsOpen = [];
    for (const p of left) {
      if (ctx.visitors && typeof ctx.visitors.delete === 'function' && ctx.visitors.get(p.name) === p.v) ctx.visitors.delete(p.name);
      await p.close();
    }
  }

  /** A party in a Chromium process of its own. */
  async function newParty(ctx, name) {
    if (!ctx.shared.obsOpen) {
      ctx.shared.obsOpen = [];
      ctx.closers.push(() => closeLeftovers(ctx));
    }
    const browser = await launchChromium({ headless: !headed });
    const v = await Visitor.open(browser, name, run, { initScripts: [pcWatch] });
    if (ctx.visitors && typeof ctx.visitors.set === 'function') ctx.visitors.set(name, v); // a failing step prints its console and loader log
    const page = await v.newPage();
    const P = new Party(name, browser, v, page);
    ctx.shared.obsOpen.push(P);
    return P;
  }

  async function closeParties(ctx, parties) {
    for (const p of parties) {
      if (ctx.visitors && typeof ctx.visitors.delete === 'function' && ctx.visitors.get(p.name) === p.v) ctx.visitors.delete(p.name);
      ctx.shared.obsOpen = (ctx.shared.obsOpen || []).filter((x) => x !== p);
      await p.close();
    }
  }

  /** Polls the apps state of a party until pred(state) is truthy; returns that state. A timeout says what the state was. */
  async function waitApps(P, pred, label, timeoutMs = 30000) {
    let last = null;
    try {
      return await waitUntil(async () => {
        last = await P.apps();
        return last && pred(last) ? last : null;
      }, { timeoutMs, stepMs: 150, label: P.name + ': ' + label });
    } catch (err) {
      if (err instanceof StepError) err.message += ' (the apps state then: ' + JSON.stringify(last).slice(0, 600) + ')';
      throw err;
    }
  }

  async function openDoor(P, door) {
    await P.page.goto(door.page, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // one reload into the limited-mode policy happens first; the apps home shows after it
    return waitApps(P, (a) => a.view === 'home', 'the apps home', 30000);
  }

  /** The header's Sign in, the loader's card, the identity origin's popup ("for this visit only"), then the apps are ready. */
  async function signIn(P, { beforeCard = null } = {}) {
    const popups = [];
    const onPopup = (p) => popups.push(p);
    P.page.context().on('page', onPopup);
    try {
      await P.press('[data-role="signin"]');
      if (beforeCard) {
        await waitUntil(async () => {
          const r = await P.page.evaluate(() => (window.__mwShell && typeof window.__mwShell.rectOf === 'function' ? window.__mwShell.rectOf('Sign in') : null)).catch(() => null);
          return r && r.width > 0 ? r : null;
        }, { timeoutMs: 15000, label: P.name + ': the loader\'s sign-in card' });
        await beforeCard();
      }
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

  /** The requests a party's page made to the collector (its own tap, so one page is told from another). */
  const callsOf = (P, collector) => P.requests.filter((r) => new URL(r.url).origin === collector.origin);

  /**
   * holdIfNotYet(P, collector, label): when the page has not said yes yet, it is watched for one flush interval and a bit: it must not call the
   * collector and must keep its events (queued, not sent). A page that is already sending (a design in which an earlier card was the yes) is left alone.
   */
  async function holdIfNotYet(P, collector, label) {
    const o = await P.obs();
    if (!o || o.allowed) return 'sending';
    const before = callsOf(P, collector).length;
    await sleep(FLUSH_WAIT_MS);
    const after = await P.obs();
    assert(callsOf(P, collector).length === before, P.name + ' called the collector ' + label + ': ' + JSON.stringify(callsOf(P, collector).slice(before)));
    assert(after && after.allowed === false && after.sent === 0 && after.queued > 0, bad(P.name + ' inspect().obs ' + label, after));
    return 'holding';
  }

  /**
   * Answers the card of the given kind with Continue. The price cards (start, knock) must name the report host, because one of them is the
   * first yes; the accept card comes after a code was opened, so it need not. While a card is up a page that has not said yes sends nothing;
   * the Continue is a yes, and the page then sends. mark: { before } gets the time of the click. Returns the card's text.
   */
  async function continueCard(P, kind, collector, mark = null) {
    await waitApps(P, (a) => a.card === kind, 'the ' + kind + ' card', 10000);
    const text = await P.text('[data-role="card"]');
    const line = TX('apps.price.reports', { host: collector.host });
    if (kind !== 'accept') assert(text.indexOf(line) >= 0, P.name + ': the ' + kind + ' card does not say where the usage reports go (' + collector.host + '): ' + text.slice(0, 700));
    await holdIfNotYet(P, collector, 'while the ' + kind + ' card was up');
    if (mark) mark.before = Date.now();
    await P.press('[data-role="card-continue"]');
    await waitApps(P, (a) => a.card === null, 'the ' + kind + ' card closes', 10000);
    await waitUntil(async () => {
      const o = await P.obs();
      return o && o.allowed === true ? o : null;
    }, { timeoutMs: 10000, label: P.name + ': the page sends after Continue on the ' + kind + ' card' });
    return text;
  }

  // ------------------------------------------------------------------------------------------- OBS-2
  S['OBS-2'] = {
    title: 'pair: two door visitors in two browsers; per session the views, sign-in, link, code, knock, request and waiting, connecting, connected; ICE by candidate type only; who is each short id; the order across the two sessions; no code, message or address',
    async fn(ctx, step) {
      await closeAllMine(ctx);
      const k = await kit(ctx, step);
      const door = await doorOf(ctx, step);
      const { collector } = k;
      collector.clear();
      const run0 = run.violations.length;
      const text1 = 'hello from B ' + MARK;
      return noted(collector, 'OBS-2', async () => {
        const [A, B] = await step('two browsers, A and B (separate processes, fresh profiles), open the door page: the apps home shows, and nothing has left either page', async () => {
          const a = await newParty(ctx, 'OBS2A');
          const b = await newParty(ctx, 'OBS2B');
          for (const P of [a, b]) await openDoor(P, door);
          await sleep(FLUSH_WAIT_MS);
          assert(collector.pageRequests().length === 0, 'a page called the collector before any yes: ' + JSON.stringify(collector.pageRequests().slice(0, 3)));
          for (const P of [a, b]) {
            const o = await P.obs();
            assert(o && o.host === collector.host && o.enabled === true && o.allowed === false && o.sent === 0 && o.queued > 0, bad(P.name + ' inspect().obs before any yes', o));
            assert(callsOf(P, collector).length === 0, P.name + ' asked the collector');
          }
          return [a, b];
        });

        await step('A presses Sign in and nothing is sent while the loader\'s card is up; A and B sign in for this visit (the identity origin\'s popup)', async () => {
          await signIn(A, {
            beforeCard: async () => {
              await sleep(FLUSH_WAIT_MS);
              assert(callsOf(A, collector).length === 0, 'A called the collector while the sign-in card was up: ' + JSON.stringify(callsOf(A, collector).slice(0, 3)));
            },
          });
          await signIn(B);
          assert(A.short !== B.short, 'the same short id ' + A.short);
        });

        const code = await step('A: Messages shows the price card, which names the report host; Continue is the yes, and opens a code at the rendezvous', async () => {
          await A.press('[data-app="messages"]');
          await continueCard(A, 'start', collector);
          const a = await waitApps(A, (x) => x.code && x.link === 'open', 'a code and an open link', 20000);
          const shown = await A.text('[data-role="code"]');
          assert(CODE_RE.test(shown) && a.code === shown.slice(0, 4), bad('the code', [shown, a.code]));
          return shown;
        });
        const secret = code.slice(5);
        const hidden = [code, code.toUpperCase(), code.replace(/-/g, ''), code.replace(/-/g, ' ').toUpperCase(), secret, secret.toUpperCase(), secret.replace('-', ''), secret.replace('-', ' ').toUpperCase()];

        await sleep(GAP_MS);
        const tKnock = { before: 0, after: 0 };
        await step('B: the price card; "Not now" is not a yes (a page that has not agreed sends nothing); then the code typed in capitals with spaces and the knock\'s price card: Continue sends the knock', async () => {
          await B.press('[data-app="messages"]');
          await waitApps(B, (x) => x.view === 'messages' && x.card === 'start', 'the price card', 10000);
          await holdIfNotYet(B, collector, 'while the first price card was up');
          await B.press('[data-role="card-cancel"]');
          await waitApps(B, (x) => x.card === null, 'the card closes', 5000);
          await holdIfNotYet(B, collector, 'after "Not now"');
          await B.loc('[data-role="knock-input"]').fill(code.toUpperCase().replace(/-/g, ' '));
          await B.press('[data-role="knock-button"]');
          await continueCard(B, 'knock', collector, tKnock);
          await waitApps(B, (x) => x.conversations.length === 1 && x.conversations[0].status === 'waiting', 'a waiting conversation', 20000);
          tKnock.after = Date.now();
        });

        const tAccept = { before: 0, after: 0 };
        await step('A sees the request; a pause; A accepts (the card repeats the price); both connect', async () => {
          await waitApps(A, (x) => x.requests === 1, 'the request', 30000);
          await sleep(GAP_MS);
          tAccept.before = Date.now();
          await A.press('[data-role="requests"] [data-role="accept"]');
          await continueCard(A, 'accept', collector);
          await Promise.all([A, B].map((P) => waitApps(P, (x) => x.conversations.length === 1 && x.conversations[0].status === 'connected', 'connected', 45000)));
          tAccept.after = Date.now();
        }, 60000);

        const held = await step('what each page really holds: the addresses of its peer connections (a positive control for the scan below)', async () => {
          const out = [];
          for (const P of [A, B]) out.push(...await P.page.evaluate(candidateAddresses));
          const found = Array.from(new Set(out));
          assert(found.length > 0, 'the pages know no candidate address (the control would prove nothing)');
          return found;
        });

        await step('B opens the conversation and sends a message; A is told it arrived', async () => {
          await B.press('[data-role="conv-list"] [data-conv]');
          await waitApps(B, (x) => x.view === 'conversation', 'the conversation view', 5000);
          await B.loc('[data-role="composer"]').fill(text1);
          await B.page.keyboard.press('Enter');
          await waitUntil(async () => (await B.messages()).some((m) => m.mine && m.text === text1 && m.status === 'delivered'), { timeoutMs: 30000, label: 'B: the message is delivered' });
          await waitApps(A, (x) => x.conversations[0].unread === 1, 'A: one unread message', 15000);
        });

        const mine = (P) => (sessions) => sessions.find((x) => x.who.includes(P.short));
        await step('the collector holds a session labelled with the short id each page shows (the sign-in reached the reporter)', () => waitUntil(() => {
          const sessions = Array.from(collector.sessions().values());
          return mine(A)(sessions) && mine(B)(sessions);
        }, { timeoutMs: 20000, stepMs: 250, label: 'a session of the collector with who ' + A.short + ' and one with who ' + B.short }));
        await step('every page has handed over what it holds, and the collector has it', () => settled(collector, [{ obs: () => A.obs(), session: mine(A) }, { obs: () => B.obs(), session: mine(B) }]));

        const sess = await step('two sessions, one for each page, found by the short id the header shows; who is null until the sign-in and then that id and no other', async () => {
          const doorJson = JSON.parse(await (await fetch(door.page.replace(/open\.html$/, 'door.json'))).text());
          const sessions = Array.from(collector.sessions().values());
          assert(sessions.length === 2, 'sessions: ' + sessions.map((x) => x.sid + ' ' + JSON.stringify(x.who)).join(' | '));
          const out = new Map();
          for (const P of [A, B]) {
            const found = sessions.filter((x) => x.who.includes(P.short));
            assert(found.length === 1, P.name + ' (' + P.short + ') is in ' + found.length + ' sessions');
            const x = found[0];
            assert(JSON.stringify(x.who) === JSON.stringify([null, P.short]), bad(P.name + ': who', x.who));
            const firstWho = x.events.find((e) => e.$who !== null);
            assert(firstWho && firstWho.n === 'auth.change' && firstWho.signedIn === true, bad(P.name + ': the first event labelled with the short id is the sign-in', firstWho));
            assert(x.page === 'door' && JSON.stringify(x.site) === JSON.stringify(['']), bad(P.name + ' page and site', [x.page, x.site]));
            assert(x.loader === CONFIG.version && x.ua && x.ua.browser === 'chromium', bad(P.name + ' loader and ua', [x.loader, x.ua]));
            assert(x.build === doorJson.buildId, P.name + ': build ' + x.build + ' (the door.json says ' + doorJson.buildId + ')');
            assert(x.repeats === 0 && x.seqs.every((q, i) => q === i), bad(P.name + ' batch numbers', x.seqs));
            for (let i = 1; i < x.events.length; i++) assert(x.events[i].t >= x.events[i - 1].t, P.name + ': event times go back at ' + show(x.events[i]));
            out.set(P, x);
          }
          assert(out.get(A).sid !== out.get(B).sid, 'one session for two pages');
          return out;
        });
        const a = sess.get(A);
        const b = sess.get(B);
        const ch4 = code.slice(0, 4);
        const trace = (x) => x.events.map((e) => e.n + (e.status ? ':' + e.status : e.ev ? ':' + e.ev : e.step ? ':' + e.step : '')).join(' ');

        await step('A\'s session: home, sign-in, the price card and its yes, the link opening, the code, the request, the accept card, connecting, the wire, connected, the message', async () => {
          const r = inOrder(a.events, ['boot.start', 'boot.features', 'boot.stage', 'run.start',
            { n: 'apps.view', view: 'home' },
            { n: 'apps.signin', step: 'start' }, { n: 'signin.start' }, { n: 'signin.result', code: 'ok' }, { n: 'apps.signin', step: 'done' },
            { n: 'apps.view', view: 'messages' },
            { n: 'apps.card', kind: 'start', ev: 'show' }, { n: 'apps.card', kind: 'start', ev: 'continue' },
            { n: 'link.state', state: 'open' }, { n: 'link.sent', action: 'pair-open' },
            { n: 'apps.code', ev: 'opened', kind: 'pair', channel: ch4 },
            { n: 'link.push', name: 'pair-request' }, { n: 'apps.request', ev: 'in', kind: 'pair' },
            { n: 'apps.card', kind: 'accept', ev: 'show' }, { n: 'apps.card', kind: 'accept', ev: 'continue' },
            { n: 'apps.request', ev: 'accept', kind: 'pair' },
            { n: 'apps.conv', status: 'connecting', incoming: true },
            { n: 'ice.conn', state: 'connected' }, { n: 'apps.wire', ev: 'up', kind: 'pair' },
            { n: 'apps.conv', status: 'connected', incoming: true },
            { n: 'apps.msg', status: 'received' }]);
          assert(r.ok, 'A: ' + r.link + ' is not after ' + r.after + ' in ' + trace(a));
          assert(!a.events.some((e) => matchEvent(e, { n: 'apps.knock' })), 'A sent a knock');
          assertFirstYes(a, 'A');
        });

        await step('B\'s session: home, sign-in, "Not now", the code typed, the knock card and its yes, the knock, waiting, connecting, ICE, connected, the message going queued, sent, delivered', async () => {
          const r = inOrder(b.events, ['boot.start', 'boot.features', 'boot.stage', 'run.start',
            { n: 'apps.view', view: 'home' },
            { n: 'apps.signin', step: 'start' }, { n: 'signin.start' }, { n: 'signin.result', code: 'ok' }, { n: 'apps.signin', step: 'done' },
            { n: 'apps.view', view: 'messages' },
            { n: 'apps.card', kind: 'start', ev: 'show' }, { n: 'apps.card', kind: 'start', ev: 'cancel' },
            { n: 'ui.change', control: 'knock-input' }, { n: 'ui.click', role: 'knock-button' },
            { n: 'apps.card', kind: 'knock', ev: 'show' }, { n: 'apps.card', kind: 'knock', ev: 'continue' },
            { n: 'apps.knock', ev: 'sent', kind: 'pair', channel: ch4 }, { n: 'link.state', state: 'open' }, { n: 'apps.knock', ev: 'ok', channel: ch4 },
            { n: 'apps.conv', status: 'waiting', incoming: false }, { n: 'link.push', name: 'pair-accepted' }, { n: 'apps.conv', status: 'connecting', incoming: false },
            { n: 'ice.remote', sdp: 'answer' }, { n: 'ice.conn', state: 'connected' }, { n: 'ice.pair' },
            { n: 'apps.wire', ev: 'up', kind: 'pair' }, { n: 'apps.conv', status: 'connected', incoming: false },
            { n: 'apps.view', view: 'conversation' },
            { n: 'apps.msg', status: 'queued' }, { n: 'apps.msg', status: 'sent' }, { n: 'apps.msg', status: 'delivered' }]);
          assert(r.ok, 'B: ' + r.link + ' is not after ' + r.after + ' in ' + trace(b));
          assertFirstYes(b, 'B');
          assert(!b.events.some((e) => matchEvent(e, { n: 'apps.code', ev: 'opened' })), 'B opened a code');
          assert(!a.events.some((e) => matchEvent(e, { n: 'apps.code', ev: 'opened', channel: (v) => v !== ch4 })), 'A opened a code other than the one on the screen');
        });

        await step('across the two sessions: the code of A, then the knock of B, then the accept of A (the steps were 1300 ms or more apart, so their times order them), each within the moments the test saw it', async () => {
          const opened = firstOf(a.events, { n: 'apps.code', ev: 'opened' });
          const knock = firstOf(b.events, { n: 'apps.knock', ev: 'sent' });
          const accept = firstOf(a.events, { n: 'apps.request', ev: 'accept' });
          assert(opened.$abs < knock.$abs, 'the knock of B (' + knock.$abs + ') is not after the code of A (' + opened.$abs + ')');
          assert(knock.$abs < accept.$abs, 'the accept of A (' + accept.$abs + ') is not after the knock of B (' + knock.$abs + ')');
          // an event's time is at most 999 ms before the moment it happened (t0 is whole seconds), never after: the test's own clock brackets it
          const within = (ev, lo, hi, what) => assert(ev.$abs > lo - 1000 && ev.$abs <= hi + 50, what + ' is at ' + ev.$abs + ', outside ' + lo + ' to ' + hi);
          within(knock, tKnock.before, tKnock.after, 'the knock of B');
          within(accept, tAccept.before, tAccept.after, 'the accept of A');
          for (const [x, who] of [[a, 'A'], [b, 'B']]) {
            const up = firstOf(x.events, { n: 'apps.conv', status: 'connected' });
            assert(up.$abs > tAccept.before - 1000, who + ' connected (' + up.$abs + ') before A accepted (' + tAccept.before + ')');
          }
        });

        await step('ICE events name candidate types and protocols, never an address, and the pair that connected is host to host; clicks name the control, not what was typed; no field is a sentence', async () => {
          for (const [x, who] of [[a, 'A'], [b, 'B']]) {
            assertIce(x, who, { connected: true });
            assertClicks(x, who);
            assertWords(x, who);
            for (const e of x.events.filter((q) => /^link\./.test(q.n) && q.n !== 'link.state')) {
              const w = e.action || e.name;
              if (w) assert(/^pair-[a-z-]{1,24}$/.test(w), bad(who + ' ' + e.n + ' names an action', e));
            }
          }
        });

        await step('no body, as the page sent it, holds an address (the addresses the pages really hold least of all), a port, a whole or half code, the message, or the marker', async () => {
          const n = assertClean(collector, { ports: portsOf(ctx, k), literals: hidden.concat(held, [text1, MARK]) }, 'OBS-2');
          assert(collector.posts().length > 0 && collector.posts().every((p) => p.status === 204 && /^text\/plain/.test(p.type)), bad('posts', collector.posts().filter((p) => p.status !== 204 || !/^text\/plain/.test(p.type)).map((p) => [p.status, p.reason, p.type])));
          assert(collector.pageRequests().every((r) => r.method === 'POST' && r.path === '/e'), bad('requests of the pages (plain POSTs, no preflight)', collector.pageRequests().filter((r) => r.method !== 'POST')));
          return n + ' texts, ' + held.length + ' addresses looked for';
        });

        await step('the pages\' own counts agree with the collector (sent equals arrived, nothing dropped); each page called the collector only with POST /e, and only its own door, the identity origin and the collector were asked', async () => {
          await settled(collector, [{ obs: () => A.obs(), session: mine(A) }, { obs: () => B.obs(), session: mine(B) }]);
          for (const [P, x] of [[A, a], [B, b]]) {
            const o = await P.obs();
            assert(o.lastOk !== false, bad(P.name + ' inspect().obs', o));
            const now = mine(P)(Array.from(collector.sessions().values()));
            const calls = callsOf(P, collector);
            assert(calls.length > 0 && calls.length === now.batches.length + now.repeats && calls.every((r) => r.method === 'POST' && new URL(r.url).pathname === '/e'), P.name + ' made ' + calls.length + ' calls, the collector holds ' + now.batches.length + ' batches');
            assert(now.events.length >= x.events.length, P.name + ' lost events');
            const origins = new Set(P.requests.map((r) => (isLocalUrl(r.url) && /^https?:/.test(r.url) ? new URL(r.url).origin : null)).filter(Boolean));
            const allowedOrigins = [door.origin, collector.origin, originOfUrl(door.idp)];
            assert(Array.from(origins).every((o2) => allowedOrigins.indexOf(o2) >= 0), P.name + ' asked ' + Array.from(origins).join(', ') + ' (the door ' + door.origin + ', the identity origin ' + originOfUrl(door.idp) + ', the collector ' + collector.origin + ')');
          }
          assert(run.violations.length === run0, 'requests left 127.0.0.1: ' + JSON.stringify(run.violations.slice(run0)));
        });

        await closeParties(ctx, [A, B]);
        return 'two sessions of ' + a.events.length + ' and ' + b.events.length + ' events; validated by ' + k.validator + '; ' + held.length + ' real addresses looked for in every body, none found';
      });
    },
  };

  // ------------------------------------------------------------------------------------------- OBS-3
  S['OBS-3'] = {
    title: 'no yes, no report: "Load from host only", the Settings switch off before the choice, and the switch off after reports began (kept off by a reload) send nothing more; a site and a door without the block never call the collector',
    async fn(ctx, step) {
      await closeAllMine(ctx);
      const k = await kit(ctx, step);
      const site = await siteOf(ctx, step);
      const { collector } = k;
      const { stack } = ctx;
      collector.clear();
      const run0 = run.violations.length;
      const callsTo = (seen) => seen.filter((r) => new URL(r.url).origin === collector.origin);
      const pcs = (page) => page.evaluate(() => window.__mwE2EPc || 0);
      return noted(collector, 'OBS-3', async () => {
        await step('"Load from host only": the site renders from its host, the page sends nothing, drops what it held, and its Settings line says the reports are off', async () => {
          const v = await ctx.visitor('OBS3H');
          const seen = tapContext(v);
          const { page } = await ctx.openSite('OBS3H', { url: site.url, consent: false });
          await cardText(page);
          const before = await obsOf(page);
          assert(before && before.allowed === false && before.queued > 0, bad('obs with the card up', before));
          await pressCard(page, new RegExp('^' + STRINGS.consentHostOnly + '$'), 'the host only button');
          await waitUntil(async () => {
            const st = await shellState(page);
            return st && st.consent === 'host-only' ? st : null;
          }, { timeoutMs: 10000, label: 'the choice is stored as host-only' });
          // the page goes on and the visitor does things that would be reported if reports were on: Settings opens and closes (clicks)
          await openSettings(page);
          await sleep(300);
          await closeSettings(page);
          await sleep(FLUSH_WAIT_MS * 2);
          const o = await obsOf(page);
          assert(o && o.allowed === false && o.sent === 0 && o.batches === 0 && o.queued === 0 && o.dropped > 0, bad('inspect().obs after "Load from host only"', o));
          assert(callsTo(seen).length === 0, 'the page called the collector: ' + JSON.stringify(callsTo(seen).slice(0, 3)));
          assert(collector.requests().length === 0 && collector.count() === 0, 'the collector saw ' + collector.requests().length + ' requests');
          const line = await reportsLine(page);
          const want = fmt(UI_TEXT.en.reportsDebug, { host: collector.host, state: UI_TEXT.en.reportsStateOff, sent: 0, queued: 0, dropped: o.dropped });
          assert(line === want, 'the Diagnostics line is ' + JSON.stringify(line) + ', expected ' + JSON.stringify(want));
          const st = await shellState(page);
          assert(st.mounted === true && st.source === 'webseed', bad('the site still loaded, from its host', [st.mounted, st.source]));
          await ctx.closeVisitor('OBS3H');
        });

        await step('the Settings switch turned off before the choice: "Share and load" then shares with peers (connections are made) and still sends no report', async () => {
          const v = await ctx.visitor('OBS3S1');
          const seen = tapContext(v);
          const { page } = await ctx.openSite('OBS3S1', { url: site.url, consent: false });
          await cardText(page);
          await page.locator('.mw-notice button', { hasText: new RegExp('^' + STRINGS.consentSettings + '$') }).first().click({ timeout: 10000 });
          await setReportsSwitch(page, false);
          const mid = await obsOf(page);
          assert(mid && mid.allowed === false && mid.queued === 0 && mid.sent === 0, bad('obs after the switch, before the choice', mid));
          await pressCard(page, CONSENT_ACCEPT_RE, 'the consent button');
          await waitUntil(async () => {
            const st = await shellState(page);
            return st && st.consent === 'accepted' ? st : null;
          }, { timeoutMs: 10000, label: 'the choice is stored as accepted' });
          // the page really shares: it makes peer connections (the tracker offers) while it sends no report
          await waitUntil(async () => (await pcs(page)) > 0, { timeoutMs: 20000, label: 'the page made peer connections' });
          await sleep(FLUSH_WAIT_MS * 2);
          const o = await obsOf(page);
          assert(o && o.allowed === false && o.sent === 0 && o.batches === 0 && o.queued === 0, bad('inspect().obs after sharing with the switch off', o));
          assert(callsTo(seen).length === 0 && collector.requests().length === 0, 'the page called the collector: ' + JSON.stringify(collector.requests().slice(0, 3)));
          await ctx.closeVisitor('OBS3S1');
        });

        await step('the switch turned off after reports began: no batch arrives after it, the page says so; it stays off after a reload; turned on again, reports resume', async () => {
          const v = await ctx.visitor('OBS3S2');
          const seen = tapContext(v);
          const { page } = await ctx.openSite('OBS3S2', { url: site.url, consent: true });
          await collector.waitFor((c) => c.count() >= 1, { timeoutMs: 20000, label: 'the first batch of the visitor who agreed' });
          assert((await obsOf(page)).allowed === true, 'the page is not sending after "Share and load"');
          await setReportsSwitch(page, false);
          await waitUntil(async () => {
            const o = await obsOf(page);
            return o && o.allowed === false ? o : null;
          }, { timeoutMs: 10000, label: 'the page stops at once' });
          await sleep(900); // a batch that left just before the switch may still be arriving
          const stopped = collector.count();
          const callsStopped = callsTo(seen).length;
          await openSettings(page);
          await sleep(300);
          await closeSettings(page);
          await sleep(FLUSH_WAIT_MS * 2);
          const o = await obsOf(page);
          assert(o.allowed === false && o.queued === 0, bad('inspect().obs after the switch', o));
          assert(collector.count() === stopped && callsTo(seen).length === callsStopped, 'a report arrived after the switch: ' + (collector.count() - stopped) + ' batches');
          // reload: the choice is stored, the switch is still off, and the new page sends nothing
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitForSite(page, { timeoutMs: 30000, label: 'the site after the reload' });
          await sleep(FLUSH_WAIT_MS * 2);
          const again = await obsOf(page);
          assert(again && again.allowed === false && again.sent === 0 && again.batches === 0, bad('inspect().obs after the reload', again));
          assert(collector.count() === stopped, 'the reloaded page sent ' + (collector.count() - stopped) + ' batches');
          await openSettings(page);
          assert(!(await page.locator('#mw-reports').isChecked()), 'the switch shows on after the reload');
          await closeSettings(page);
          // the control: turned on again, the same page sends again, so everything above was the switch and not a page that cannot send
          await setReportsSwitch(page, true);
          await collector.waitFor((c) => c.count() > stopped, { timeoutMs: 20000, label: 'a batch after the switch is turned on again' });
          assert((await obsOf(page)).allowed === true, 'the page does not send after the switch is turned on again');
          await ctx.closeVisitor('OBS3S2');
        });

        const quiet = collector.requests().length;
        await step('a site and a door whose door.json has no obs block: no report object (inspect().obs is null), no request to the collector, nothing for it to see', async () => {
          const v = await ctx.visitor('OBS3N');
          const seen = tapContext(v);
          const { page } = await ctx.openSite('OBS3N', { consent: true }); // the run's own site: its dev server was started without --obs
          await sleep(FLUSH_WAIT_MS * 2);
          const st = await shellState(page);
          assert(st && st.obs === null, bad('inspect().obs of a site without the block', st && st.obs));
          assert(callsTo(seen).length === 0, 'a page without the block called the collector: ' + JSON.stringify(callsTo(seen).slice(0, 3)));
          const plain = await createDevServer({ root: stack.dist, port: 0, host: '127.0.0.1', dev: true, quiet: true });
          ctx.closers.push(() => plain.close());
          assert(!plain.obs && !plain.apps, bad('blocks of the plain door', [plain.obs, plain.apps]));
          collector.allowOrigin(new URL(plain.url).origin); // allowed to post, if it ever knew where: it must not
          const door = await v.newPage();
          await door.goto(plain.url + '_mw/open.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await door.locator('input[type="url"]').first().waitFor({ state: 'visible', timeout: 30000 });
          await sleep(FLUSH_WAIT_MS);
          const ds = await shellState(door);
          assert(ds && ds.obs === null, bad('inspect().obs of a door without the block', ds && ds.obs));
          assert(callsTo(seen).length === 0, 'a door without the block called the collector: ' + JSON.stringify(callsTo(seen).slice(0, 3)));
          await ctx.closeVisitor('OBS3N');
          assert(collector.requests().length === quiet, 'the collector saw ' + (collector.requests().length - quiet) + ' requests from pages without the block');
        });

        assert(run.violations.length === run0, 'requests left 127.0.0.1: ' + JSON.stringify(run.violations.slice(run0)));
        return 'host only, the switch before the choice and the switch after reports began each stopped the reports; a site and a door without the block made 0 calls; validated by ' + k.validator;
      });
    },
  };

  return S;
}
