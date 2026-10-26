// Unit tests of the C2 integrator (docs/deviations/integration-c2.md): the seams between the C2 lanes and the v0.3 code that
// no single lane owned. The reader schema of _mw.cfg accepts calls (and every value ledger-admin can write); the files and
// media services get the owner key, the pin evidence and the manager's evidence through mountV03Services; the activation
// tracker survives a cross-origin target (the door view); the call panel takes its rules from the shell's own copy of
// ui.css (no stylesheet to wait for); the loader cards' slots let clicks beside a card reach the page.
// Run: node --test test/unit/integration-c2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { schemaOk } from '../../src/chain/state.js';
import { CFG_ENUMS } from '../../tools/ledger-admin.mjs';
import { MwApi, mountV03Services, ActivationTracker } from '../../src/loader/api.js';
import { createCallUi } from '../../src/loader/call-ui.js';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { ROOT } from '../../tools/lib.mjs';

const PUB = 'p256:B' + 'A'.repeat(86);
const LEDGER = 'mw1:' + 'a'.repeat(27);

test('the reader schema of _mw.cfg accepts calls: off | contacts, and every value ledger-admin writes', () => {
  assert.equal(schemaOk('_mw.cfg', { chat: 'members', calls: 'contacts' }, 'key'), true);
  assert.equal(schemaOk('_mw.cfg', { chat: 'open', calls: 'off' }, 'key'), true);
  assert.equal(schemaOk('_mw.cfg', { calls: 'everyone' }, 'key'), false, 'an unknown value hides the item, as for chat');
  assert.equal(schemaOk('_mw.cfg', { calls: true }, 'key'), false);
  // Writer and reader agree: a setting ledger-admin can write is never one the readers hide.
  for (const [name, values] of Object.entries(CFG_ENUMS)) {
    for (const v of values) assert.equal(schemaOk('_mw.cfg', { chat: 'members', [name]: v }, 'key'), true, name + ' = ' + v);
  }
});

test('mountV03Services hands files and media the owner key, the pin evidence and the manager evidence (lane seed-engine O2)', async () => {
  const seen = {};
  const svc = () => ({ methods: {}, on: () => () => {} });
  const modules = {
    files: { createFilesService: (d) => { seen.files = d; return svc(); } },
    media: { createMediaService: (d) => { seen.media = d; return svc(); } },
  };
  const owner = () => PUB;
  const pinEvidence = (ih, now) => ({ configured: true, receipt: null, heartbeat: null, ih, now });
  const evidenceInputs = (ih) => ({ ih, wires: [] });
  const api = new MwApi({});
  const res = await mountV03Services(api, { modules, deps: { ledgerId: LEDGER, owner, pinEvidence, evidenceInputs } });
  assert.deepEqual(res.mounted.sort(), ['files', 'media']);
  for (const name of ['files', 'media']) {
    assert.equal(seen[name].owner, owner, name + ': owner');
    assert.equal(seen[name].pinEvidence, pinEvidence, name + ': pinEvidence');
    assert.equal(seen[name].evidenceInputs, evidenceInputs, name + ': evidenceInputs');
    assert.equal(seen[name].pin, undefined, name + ': no pin request seam in C2 (files.pinRequest stays E_POLICY)');
  }
});

test('ActivationTracker.watch: a cross-origin window (the door view) is not watched and does not throw', () => {
  const tracker = new ActivationTracker({ nav: null });
  const crossOrigin = {};
  Object.defineProperty(crossOrigin, 'addEventListener', { get() { throw new Error('SecurityError: Blocked a frame with origin "null"'); } });
  const unwatch = tracker.watch(crossOrigin);
  assert.equal(typeof unwatch, 'function');
  unwatch();
  const added = [];
  const ok = { addEventListener: (type) => added.push(type), removeEventListener() {} };
  tracker.watch(ok);
  assert.ok(added.length > 0, 'an ordinary target is still watched');
});

/** A FakeDocument whose styleSheets hold the shell's ui.css, as a browser lists the sheet the shell page loaded. */
function docWithSheet(href, rules) {
  const doc = new FakeDocument();
  doc.baseURI = 'http://127.0.0.1:8080/';
  doc.styleSheets = [{ href, cssRules: rules.map((cssText) => ({ cssText })) }];
  return doc;
}

test('the call panel styles its closed root from the shell\'s own ui.css rules (no <link> to wait for)', async () => {
  const doc = docWithSheet('http://127.0.0.1:8080/_mw/ui.css', ['.mw-call-card { padding: 12px 14px; }', '.mw-call-live { position: absolute; }']);
  const ui = createCallUi({ doc, win: {}, nav: { language: 'en' }, lang: 'en', strict: false, cssHref: '/_mw/ui.css' });
  const p = ui.prompt('call.start', { to: PUB, name: 'Ada' });
  const host = doc.body.find((x) => x.getAttribute && x.getAttribute('data-mw-call') !== null);
  assert.ok(host, 'the panel host is on the page');
  const style = host.find((x) => x.tagName === 'STYLE');
  const link = host.find((x) => x.tagName === 'LINK');
  assert.ok(style, 'an inline <style> in the root');
  assert.match(style.textContent, /\.mw-call-card \{ padding: 12px 14px; \}/);
  assert.equal(link, null, 'no stylesheet link when the shell already holds the rules');
  host.buttonByText('Cancel').dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(await p, false);
  ui.destroy();

  // Without a readable sheet (another href, or none), the panel falls back to the <link> of before.
  const doc2 = docWithSheet('http://127.0.0.1:8080/other.css', ['.x { color: red; }']);
  const ui2 = createCallUi({ doc: doc2, win: {}, nav: { language: 'en' }, lang: 'en', strict: false, cssHref: '/_mw/ui.css' });
  ui2.prompt('call.start', { to: PUB, name: 'Ada' });
  const host2 = doc2.body.find((x) => x.getAttribute && x.getAttribute('data-mw-call') !== null);
  const link2 = host2.find((x) => x.tagName === 'LINK');
  assert.ok(link2, 'the fallback link');
  assert.equal(link2.getAttribute('href'), '/_mw/ui.css');
  ui2.destroy();
});

test('the loader cards\' slots take no pointer events (a click beside a card reaches the site), the cards do', () => {
  const src = readFileSync(join(ROOT, 'src', 'loader', 'ui.js'), 'utf8');
  assert.match(src, /headerSlot = h\('div', Object\.assign\(\{\}, BASE, \{ 'pointer-events': 'none' \}\)\)/);
  assert.match(src, /promptSlot = h\('div', Object\.assign\(\{\}, BASE, \{ 'pointer-events': 'none' \}\)\)/);
  assert.match(src, /const cardStyle = Object\.assign\(\{\}, BASE, \{ 'pointer-events': 'auto'/);
});

test('the desktop call panel sits at the top right, clear of the loader cards at the bottom', () => {
  const css = readFileSync(join(ROOT, 'src', 'loader', 'ui.css'), 'utf8');
  const rule = /\n\[data-mw-call\] \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the [data-mw-call] rule');
  assert.match(rule[1], /top: max\(48px/);
  assert.match(rule[1], /bottom: auto/);
});
