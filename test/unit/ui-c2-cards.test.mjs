// Unit tests for the C2 pieces of src/loader/ui.js (v0.3 C2, lane wire-ui; research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md
// 3.1.4, 3.1.5, 3.3): the 'dock' card (dock mode starts inside the person's click; where the browser cannot tell, the
// person declares "I am on Wi-Fi" and "My phone is plugged in" with two toggle buttons, never an input), the seeding
// lines of the bar (the loader's own upload card with labels, the keeper line, the carry meter) and the dim page of dock
// mode, and the pure helpers that turn evidence, caps, ages and byte counts into the SEED_TEXT sentences. Fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument } from './dropin-fake-dom.mjs';
import {
  createCards, CARD_KINDS, createSeedUi, capText, ageText, clockText, labelText, carryMeter, meterText, trackerText, lastSentence
} from '../../src/loader/ui.js';
import { UI_CARD_KINDS } from '../../src/loader/api.js';
import { seedText } from '../../src/loader/strings.js';

function cardsWorld(opts = {}) {
  const doc = new FakeDocument();
  let clock = 1000000;
  const win = { document: doc, innerWidth: 1200, innerHeight: 900, matchMedia: () => ({ matches: false }), navigator: { language: 'en-CA' } };
  const cards = createCards(Object.assign({ win, doc, now: () => clock, minVisibleMs: 0, strict: false, lang: 'en' }, opts));
  const btn = (label) => cards.host.buttonByText(label);
  const texts = () => cards.host.findAll((n) => n._text).map((n) => n._text);
  const click = (b, extra = {}) => b.dispatchEvent(Object.assign({ type: 'click', isTrusted: true }, extra));
  return { doc, cards, btn, texts, click, tick: (ms) => { clock += ms; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the dock card: the end time, the start button runs dock.start() inside the click, Cancel has the focus', async () => {
  const w = cardsWorld();
  const calls = [];
  let answer = { on: true, until: 1000000 + 7200000, reason: null, declared: false };
  const p = w.cards.prompt('dock', { ms: 7200000, until: 1000000 + 7200000, declare: false, start: (declared) => { calls.push(declared); return Promise.resolve(answer); } });
  assert.ok(CARD_KINDS.indexOf('dock') >= 0);
  assert.deepEqual([...UI_CARD_KINDS].sort(), [...CARD_KINDS].sort(), 'the API knows every card kind of ui.js');
  const all = w.texts();
  assert.ok(all.includes(seedText('dock.on', 'en', { time: clockText(1000000 + 7200000, 'en') })), all.join(' | '));
  const start = w.btn(seedText('dock.start'));
  assert.ok(start, 'two hours: the button says what it does');
  assert.equal(w.doc.activeElement, w.btn('Cancel'), 'the safe button has the focus');
  assert.equal(w.cards.host.findAll((n) => n.tagName === 'INPUT').length, 0, 'no input in any card');
  start.dispatchEvent({ type: 'click', isTrusted: false });
  assert.deepEqual(calls, [], 'a script click starts nothing');
  w.click(start);
  assert.deepEqual(calls, [false], 'started synchronously, inside the person\'s click');
  assert.deepEqual(await p, answer);

  // Another length: the button is Continue (the text gives the time). A refusal keeps the card open with its reason.
  const w2 = cardsWorld();
  answer = { on: false, until: null, reason: 'unplugged', declared: false };
  const p2 = w2.cards.prompt('dock', { ms: 3600000, declare: false, start: () => Promise.resolve(answer) });
  assert.equal(w2.btn(seedText('dock.start')), null);
  w2.click(w2.btn('Continue'));
  await flush();
  assert.ok(w2.texts().includes(seedText('dock.refused.unplugged')));
  assert.equal(w2.cards.open, 'dock', 'still open: plug in and try again');
  answer = { on: true, until: 5, reason: null, declared: false };
  w2.click(w2.btn('Continue'));
  assert.deepEqual(await p2, answer);
  const w3 = cardsWorld();
  const p3 = w3.cards.prompt('dock', { ms: 7200000, start: () => Promise.reject(new Error('x')) });
  w3.click(w3.btn('Cancel'));
  assert.equal(await p3, false);
});

test('the dock card where the browser cannot tell: two declaration toggles; start only with both, then start(true)', async () => {
  const w = cardsWorld();
  const calls = [];
  const p = w.cards.prompt('dock', { ms: 7200000, declare: true, start: (declared) => { calls.push(declared); return Promise.resolve({ on: true, until: 9, declared }); } });
  const wifi = w.btn(seedText('seed.declareWifi'));
  const plugged = w.btn(seedText('seed.declarePlugged'));
  assert.equal(wifi.getAttribute('aria-pressed'), 'false');
  assert.equal(plugged.getAttribute('aria-pressed'), 'false');
  assert.equal(w.cards.host.findAll((n) => n.tagName === 'INPUT').length, 0);
  w.click(w.btn(seedText('dock.start')));
  assert.deepEqual(calls, [], 'not declared: nothing starts');
  assert.ok(w.texts().includes(seedText('dock.refused.declare')));
  w.click(wifi);
  assert.equal(wifi.getAttribute('aria-pressed'), 'true');
  w.click(w.btn(seedText('dock.start')));
  assert.deepEqual(calls, [], 'one of two is not enough');
  w.click(plugged);
  wifi.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(wifi.getAttribute('aria-pressed'), 'true', 'a script cannot take a declaration back or make one');
  w.click(w.btn(seedText('dock.start')));
  assert.deepEqual(calls, [true]);
  assert.deepEqual(await p, { on: true, until: 9, declared: true });
});

test('createSeedUi: the upload card with its labels, the keeper line, the carry meter, the dim page of dock mode', () => {
  const doc = new FakeDocument();
  const host = doc.createElement('div');
  const overlay = doc.createElement('div');
  doc.body.appendChild(host);
  doc.body.appendChild(overlay);
  const ui = createSeedUi({ doc, host, overlayHost: overlay, lang: 'en' });
  const { meter, keeper, uploads, dock, dockStop } = ui.nodes;
  for (const n of [meter, keeper, uploads, dock]) assert.equal(n.hidden, true, 'nothing shows before there is something to say');
  assert.equal(meter.getAttribute('aria-live'), 'polite');

  ui.setMeter({ visit: 'This visit: 60% of the bytes came from 3 visitors, 40% from the host.', tracker: '4 connected to this site (tracker report, 16:30)' });
  assert.equal(meter.hidden, false);
  assert.equal(meter.textContent, 'This visit: 60% of the bytes came from 3 visitors, 40% from the host.4 connected to this site (tracker report, 16:30)');
  ui.setMeter({});
  assert.equal(meter.hidden, true);

  ui.setUploads([{ key: 'files:a', name: 'holiday-photo.jpg', text: labelText('handoff.sending', { pct: 62 }) }, { key: 'x', text: '' }], { note: seedText('avail.noPin') });
  assert.equal(uploads.hidden, false);
  assert.equal(uploads.findAll((n) => n.className === 'mw-upload-row').length, 1, 'a row without a sentence is left out');
  assert.ok(uploads.textContent.includes('holiday-photo.jpg'));
  assert.ok(uploads.textContent.includes('Sending to the site: 62%'));
  assert.ok(uploads.textContent.includes(seedText('avail.noPin')));
  ui.setUploads([]);
  assert.equal(uploads.hidden, true);

  ui.setKeeper({ on: true, text: seedText('keeper.on') + ' (site: 1.2 MB / 20 GB)' });
  assert.equal(keeper.hidden, false);
  assert.equal(keeper.textContent, 'Keeping this site while this tab is open. (site: 1.2 MB / 20 GB)');
  ui.setKeeper({ on: false });
  assert.equal(keeper.hidden, true);

  let stopped = 0;
  const until = Date.UTC(2026, 9, 20, 22, 0);
  ui.setDock({ on: true, until }, { onStop: () => { stopped++; } });
  assert.equal(dock.hidden, false);
  assert.equal(dock.parentNode, overlay, 'over the whole page');
  assert.ok(dock.textContent.startsWith(seedText('dock.on', 'en', { time: clockText(until, 'en') })));
  assert.equal(dockStop.textContent, seedText('dock.stop'));
  dockStop.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(stopped, 0, 'a script click does not stop it');
  dockStop.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(stopped, 1);
  ui.setDock(null);
  assert.equal(dock.hidden, true);
  assert.throws(() => createSeedUi({ doc }), TypeError);
});

test('caps, ages and clock times as the sentences print them', () => {
  assert.equal(capText(1073741824), '1 GiB');
  assert.equal(capText(268435456), '256 MiB');
  assert.equal(capText(16777216), '16 MiB');
  assert.equal(capText(20000000000), '20 GB', 'the 20 GB month of the desktop row is decimal');
  assert.equal(capText(1073741824, 'fr'), '1 Gio');
  assert.equal(capText(20000000000, 'fr-CA'), '20 Go');
  assert.equal(capText(0), '0 B');
  assert.equal(capText(Infinity), '');
  assert.equal(capText(null), '');
  assert.equal(ageText(10000), 'less than a minute');
  assert.equal(ageText(60000), '1 minute');
  assert.equal(ageText(14 * 60000), '14 minutes');
  assert.equal(ageText(3600000), '1 hour');
  assert.equal(ageText(3 * 3600000 + 5), '3 hours');
  assert.equal(ageText(30000, 'fr'), 'moins d\'une minute');
  assert.equal(ageText(7200000, 'fr'), '2 heures');
  assert.match(clockText(Date.UTC(2026, 9, 20, 20, 5), 'en'), /\d{1,2}:05/);
  assert.equal(clockText(NaN), '');
  assert.equal(lastSentence('One. Two? Three.'), 'Three.');
  assert.equal(lastSentence('Only one.'), '');
});

test('labels: every SZ 3.1.5 key with its placeholders filled from the evidence (and never a number above it)', () => {
  assert.equal(labelText('avail.onlyHere', {}), 'Only on this device. Keep this page open until it is sent.');
  assert.equal(labelText('avail.keptBySite', { age: 125000 }), 'Kept by the site (checked 2 minutes ago)');
  assert.equal(labelText('avail.heldBy', { n: 3 }), 'Kept by you and at least 3 others online now (reported)');
  assert.equal(labelText('avail.heldBy', { n: 3.7 }), 'Kept by you and at least 3 others online now (reported)', 'a count is whole and rounded down');
  assert.equal(labelText('handoff.sending', { pct: 104 }), 'Sending to the site: 100%');
  assert.equal(labelText('handoff.waiting', {}), seedText('handoff.waiting'));
  assert.equal(labelText('avail.nobody'), seedText('avail.nobody'));
  assert.equal(labelText('avail.keptBySite', { age: 3600000 }, 'fr'), 'Gardé par le site (vérifié il y a 1 heure)');
  assert.equal(labelText('no.such.key', {}), '');
  assert.equal(labelText(null), '');
  // A count of one: the singular key when lane docs-strings adds one, else the sentence of the table.
  assert.equal(labelText('avail.heldBy', { n: 1 }), seedText('avail.heldByOne', 'en', { n: 1 }) || seedText('avail.heldBy', 'en', { n: 1 }));
});

test('the carry meter: measured shares in whole percent adding up to 100, the senders counted, nothing before bytes', () => {
  assert.equal(carryMeter({}), null, 'nothing downloaded this visit (a copy from the cache)');
  assert.deepEqual(carryMeter({ peerBytes: 600, webseedBytes: 400, senders: 3 }), { p: 60, n: 3, h: 40 });
  assert.deepEqual(carryMeter({ peerBytes: 0, webseedBytes: 5000, senders: 0 }), { p: 0, n: 0, h: 100 });
  assert.deepEqual(carryMeter({ peerBytes: 1, webseedBytes: 100000, senders: 1 }), { p: 1, n: 1, h: 99 }, 'bytes from visitors never print as 0%');
  assert.deepEqual(carryMeter({ peerBytes: 100000, webseedBytes: 1, senders: 2 }), { p: 99, n: 2, h: 1 }, 'bytes from the host never print as 0%');
  assert.deepEqual(carryMeter({ peerBytes: 5000, webseedBytes: 0, senders: 0 }), { p: 100, n: 1, h: 0 }, 'at least the one who sent them');
  for (let i = 0; i < 50; i++) {
    const m = carryMeter({ peerBytes: i * 37 + 1, webseedBytes: i * 11, senders: i });
    assert.equal(m.p + m.h, 100);
  }
  assert.equal(meterText(carryMeter({ peerBytes: 600, webseedBytes: 400, senders: 3 })), 'This visit: 60% of the bytes came from 3 visitors, 40% from the host.');
  assert.equal(meterText(carryMeter({ peerBytes: 600, webseedBytes: 400, senders: 3 }), 'fr'), 'Cette visite : 60 % des octets viennent de 3 visiteurs, 40 % de l\'hébergeur.');
  assert.equal(meterText(null), '');
  assert.equal(trackerText(4, Date.UTC(2026, 9, 20, 20, 30)), '4 connected to this site (tracker report, ' + clockText(Date.UTC(2026, 9, 20, 20, 30)) + ')');
  assert.equal(trackerText(null, 1), '');
  assert.equal(trackerText(2, null), '');
});

test('the C2 additions of ui.js and ui.css keep the wording and floor rules; no ranking, streak or thanks text', () => {
  const ui = readFileSync(new URL('../../src/loader/ui.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../src/loader/ui.css', import.meta.url), 'utf8');
  for (const src of [ui, css]) {
    assert.doesNotMatch(src, /blockchain|serverless|unstoppable|censorship-resistant|production-ready/i);
    assert.doesNotMatch(src, /[\u2013\u2014\u201c\u201d\u2018\u2019]/);
  }
  const c2 = ui.slice(ui.indexOf('v0.3 C2 (lane wire-ui'), ui.indexOf('export function trustedOnly'));
  assert.ok(c2.length > 1000, 'the C2 helpers are where this test reads them');
  const code = c2.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\b(rank|ranking|streak|leaderboard|points|thanks|thank you|reward)\b/i, 'never streaks, rankings or thanks loops (ARCHITECTURE 8)');
  assert.match(css, /\.mw-dock \{[\s\S]*?position: fixed/);
  assert.match(css, /\[data-mw-call\] \{[\s\S]*?z-index: calc\(var\(--mw-z\) \+ 2\)/, 'a call that rings on a docked phone is seen');
});

// ---- createUI itself (the loader's bar and Settings) on a fake DOM with classList, dataset and querySelector ----------

import { FakeNode } from './dropin-fake-dom.mjs';
import { createUI } from '../../src/loader/ui.js';
import { STRINGS } from '../../src/loader/strings.js';

class DomNode extends FakeNode {
  get classList() {
    const node = this;
    const list = () => String(node.className || '').split(/\s+/).filter(Boolean);
    const add = (...c) => { node.className = Array.from(new Set(list().concat(c))).join(' '); };
    const remove = (...c) => { node.className = list().filter((x) => c.indexOf(x) < 0).join(' '); };
    return {
      add,
      remove,
      toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want !== has) { if (want) add(c); else remove(c); } return want; },
      contains: (c) => list().indexOf(c) >= 0,
    };
  }
  get dataset() { if (!this._data) this._data = {}; return this._data; }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.find((n) => n.getAttribute && n.getAttribute('id') === sel.slice(1)) || null;
    return this.find((n) => String(n.className || '').split(/\s+/).some((c) => sel.split(',').some((s) => s.trim() === '.' + c))) || null;
  }
}
class DomDocument extends FakeDocument {
  createElement(tag, attrs = null) {
    const el = new DomNode(tag, this);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  }
}

test('createUI builds with the C2 pieces: the Settings controls follow the model and fire on trusted clicks', () => {
  const doc = new DomDocument();
  const store = new Map();
  const win = {
    document: doc, navigator: { language: 'en-CA' }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), console,
  };
  doc.defaultView = win;
  const root = doc.createElement('div');
  root.setAttribute('id', 'mw-root');
  doc.body.appendChild(root);
  const ui = createUI(root, STRINGS, { lang: 'en' });
  for (const fn of ['setMeter', 'setUploads', 'setKeeper', 'setDock']) assert.equal(typeof ui[fn], 'function', fn);
  const fired = [];
  ui.settings.onChange((action, payload) => { fired.push([action, payload]); });
  const btnText = (t) => root.find((n) => n.tagName === 'BUTTON' && n.textContent === t);
  const field = (id) => root.find((n) => n.getAttribute && n.getAttribute('id') === id);
  // Before the model: every C2 control is hidden and disabled.
  assert.equal(field('mw-keeper').disabled, true);
  ui.settings.setModel({
    share: true, isMobile: true, shareOnNetwork: false, storage: {}, ledger: null, version: '0.3.0',
    seed: { declare: { wifi: true, plugged: true }, wifi: true, plugged: false, keeper: { shown: false }, dock: { shown: true, supported: true, on: false }, line: null },
  });
  assert.equal(field('mw-declare-wifi').checked, true);
  assert.equal(field('mw-declare-wifi').disabled, false);
  assert.equal(field('mw-declare-plugged').checked, false);
  assert.equal(field('mw-keeper').parentNode.parentNode.hidden, true, 'no keeper tab on a phone');
  const dock = btnText(seedText('dock.start'));
  assert.ok(dock && !dock.disabled);
  dock.dispatchEvent({ type: 'click', isTrusted: false });
  assert.deepEqual(fired, [], 'a script click starts nothing');
  dock.dispatchEvent({ type: 'click', isTrusted: true });
  assert.deepEqual(fired.pop(), ['dock', {}]);
  const plugged = field('mw-declare-plugged');
  plugged.checked = true;
  plugged.dispatchEvent({ type: 'change' });
  assert.deepEqual(fired.pop(), ['declarePlugged', { on: true }]);
  ui.settings.setModel({ share: true, isMobile: false, storage: {}, version: '0.3.0', seed: { declare: null, keeper: { shown: true, on: true }, dock: { shown: false }, line: 'Keeping this site while this tab is open. (my-site: 1 MB / 20 GB)' } });
  assert.equal(field('mw-keeper').checked, true);
  assert.equal(field('mw-declare-wifi').parentNode.parentNode.hidden, true);
  assert.ok(root.findAll((n) => n._text === 'Keeping this site while this tab is open. (my-site: 1 MB / 20 GB)').length === 1);
  ui.settings.setModel({ share: true, isMobile: true, storage: {}, version: '0.3.0', seed: { dock: { shown: true, supported: true, on: true } } });
  assert.ok(btnText(seedText('dock.stop')), 'the button stops a running dock mode');
  // The bar's lines and the dim page.
  ui.setMeter({ visit: 'v', tracker: null });
  ui.setDock({ on: true, until: Date.now() + 3600000 }, { onStop: () => fired.push(['stop']) });
  const overlay = root.find((n) => n.className === 'mw-dock');
  assert.equal(overlay.hidden, false);
  overlay.find((n) => n.tagName === 'BUTTON').dispatchEvent({ type: 'click', isTrusted: true });
  assert.deepEqual(fired.pop(), ['stop']);
});
