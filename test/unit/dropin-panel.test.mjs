// Unit tests for src/dropin/panel.js with the small fake DOM: a closed shadow root, strings from
// src/loader/strings.js, one prompt at a time, settings with keyed focus, CSSOM-only styling (no
// <style> element and no style attribute, so a strict CSP cannot break it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { createPanel, formatBytes } from '../../src/dropin/panel.js';
import { STRINGS as S } from '../../src/loader/strings.js';

function setup({ dark = false } = {}) {
  const doc = new FakeDocument();
  const win = { document: doc, matchMedia: (q) => ({ matches: dark && /dark/.test(q) }) };
  const panel = createPanel({ win });
  return { doc, win, panel };
}

const hostOf = (doc) => doc.body.children.find((c) => c.hasAttribute('data-mw-ui')) || null;
const buttonTexts = (root) => root.findAll((n) => n.tagName === 'BUTTON').map((b) => b.textContent);

function allText(root) {
  const out = [];
  const visit = (n) => {
    if (n._text) out.push(n._text);
    for (const c of n.children) visit(c);
    if (n._shadow) visit(n._shadow);
  };
  visit(root);
  return out.join(' | ');
}

test('formatBytes: binary units, one decimal from KB up', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(512 * 1024 * 1024), '512 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes('x'), '0 B');
  assert.throws(() => createPanel({ win: {} }), TypeError);
});

test('nothing touches the page until a prompt shows; the notice lives in a closed shadow root', () => {
  const { doc, panel } = setup();
  assert.equal(hostOf(doc), null);
  assert.equal(panel.mode, null);
  const hide = panel.showNotice({});
  const host = hostOf(doc);
  assert.ok(host, 'one host element');
  assert.equal(host.shadowRoot, null, 'a closed root is invisible to page scripts');
  assert.equal(host._shadow.mode, 'closed');
  assert.equal(panel.mode, 'closed');
  assert.equal(panel.promptKind, 'notice');
  assert.equal(doc.body.children.filter((c) => c.hasAttribute('data-mw-ui')).length, 1);
  hide();
  assert.equal(hostOf(doc), null, 'the host leaves the page with its last card');
  assert.equal(panel.promptKind, null);
});

test('notice: the verbatim §4.5 text with [Settings] [OK]; OK stores nothing itself but calls back once and goes away', () => {
  const { doc, panel } = setup();
  const calls = [];
  panel.showNotice({ onOk: () => calls.push('ok'), onSettings: () => calls.push('settings') });
  const host = hostOf(doc);
  assert.ok(allText(host).includes(S.noticeText));
  assert.deepEqual(buttonTexts(host), [S.noticeSettings, S.noticeOk]);
  assert.equal(S.noticeText.startsWith('This site is delivered peer-to-peer.'), true);
  host.buttonByText(S.noticeSettings).click();
  assert.deepEqual(calls, ['settings']);
  assert.equal(panel.promptKind, 'notice', 'Settings keeps the notice');
  host.buttonByText(S.noticeOk).click();
  assert.deepEqual(calls, ['settings', 'ok']);
  assert.equal(hostOf(doc), null);
  assert.equal(panel.promptKind, null);
});

test('v0.2.1 C1 first-run card: [Share and load] [Load from host only] on one layer, Settings, the card text; script clicks do nothing', () => {
  const { doc, panel } = setup();
  const calls = [];
  panel.showConsentCard({ onShare: () => calls.push('share'), onHostOnly: () => calls.push('host-only'), onSettings: () => calls.push('settings') });
  const host = hostOf(doc);
  assert.equal(panel.promptKind, 'notice', 'the engine keeps one prompt kind for the non-blocking card');
  assert.deepEqual(buttonTexts(host), [S.consentShare, S.consentHostOnly, S.consentSettings]);
  for (const k of ['consentTitle', 'consentText', 'consentChoice']) assert.ok(allText(host).includes(S[k]), k);
  assert.ok(!allText(host).includes(S.consentMobile), 'the phone line only on phones');
  host.buttonByText(S.consentHostOnly).dispatchEvent({ type: 'click', isTrusted: false });
  host.buttonByText(S.consentShare).dispatchEvent({ type: 'click', isTrusted: false });
  assert.deepEqual(calls, [], 'untrusted clicks are ignored');
  host.buttonByText(S.consentSettings).click();
  assert.equal(panel.promptKind, 'notice', 'Settings keeps the card');
  host.buttonByText(S.consentHostOnly).click();
  assert.deepEqual(calls, ['settings', 'host-only']);
  assert.equal(hostOf(doc), null);
  panel.showConsentCard({ mobile: true, onShare: () => calls.push('share') });
  assert.ok(allText(hostOf(doc)).includes(S.consentMobile));
  hostOf(doc).buttonByText(S.consentShare).click();
  assert.deepEqual(calls, ['settings', 'host-only', 'share']);
  assert.equal(hostOf(doc), null);
});

test('v0.2.1 A4 (legacy migration only, identity.legacy === true): Settings holds identity export and import; script clicks do nothing', async () => {
  const { doc, panel } = setup();
  const actions = [];
  const model = { share: true, storage: { usage: 1, quota: 2 }, canForget: false, identity: { short: 'abcd1234', name: 'Ada', canExport: true, canImport: true, legacy: true } };
  panel.openSettings(model, (a, p) => actions.push([a, p]));
  const host = hostOf(doc);
  assert.ok(allText(host).includes(S.settingsIdentity) && allText(host).includes(S.identity({ short: 'abcd1234', name: 'Ada' })));
  assert.ok(buttonTexts(host).includes(S.settingsExportIdentity) && buttonTexts(host).includes(S.settingsImportIdentity));
  const inputs = host.findAll((n) => n.tagName === 'INPUT');
  const exportPass = inputs.find((n) => n.getAttribute('autocomplete') === 'new-password');
  const importPass = inputs.find((n) => n.getAttribute('autocomplete') === 'current-password');
  const file = inputs.find((n) => n.getAttribute('type') === 'file');
  assert.ok(exportPass && importPass && file, 'passphrase fields and the file input');
  exportPass.value = 'correct horse battery';
  host.buttonByText(S.settingsExportIdentity).dispatchEvent({ type: 'click', isTrusted: false });
  assert.deepEqual(actions, [], 'a script click exports nothing');
  host.buttonByText(S.settingsExportIdentity).click();
  assert.deepEqual(actions, [['exportIdentity', { passphrase: 'correct horse battery' }]]);
  // Import without a file: a note, nothing emitted; with a file: its text and the passphrase.
  host.buttonByText(S.settingsImportIdentity).click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actions.length, 1);
  file.files = [{ text: async () => '{"type":"mw-identity"}' }];
  importPass.value = 'pw-for-import';
  host.buttonByText(S.settingsImportIdentity).click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(actions[1], ['importIdentity', { text: '{"type":"mw-identity"}', passphrase: 'pw-for-import' }]);
  // A moderator identity cannot be exported here; no identity yet: no section at all.
  panel.updateSettings(Object.assign({}, model, { identity: { short: 'm', canExport: false, canImport: true, legacy: true } }));
  assert.equal(buttonTexts(hostOf(doc)).includes(S.settingsExportIdentity), false);
  panel.updateSettings(Object.assign({}, model, { identity: null }));
  assert.equal(allText(hostOf(doc)).includes(S.settingsIdentity), false);
});

test('only one prompt at a time: a newer one replaces the older', () => {
  const { doc, panel } = setup();
  const hideNotice = panel.showNotice({});
  panel.showGate({ hostOnlyOffered: true });
  const host = hostOf(doc);
  assert.equal(panel.promptKind, 'gate');
  assert.ok(!allText(host).includes(S.noticeText));
  hideNotice(); // the old hide() must not remove the newer card
  assert.equal(panel.promptKind, 'gate');
  assert.ok(allText(host).includes(S.gateText));
});

test('gate: Load / Load from host only (when offered) / Cancel call back and close; Load takes the focus', () => {
  const { doc, panel } = setup();
  const calls = [];
  panel.showGate({ hostOnlyOffered: true, onLoad: () => calls.push('load'), onHostOnly: () => calls.push('host'), onCancel: () => calls.push('cancel') });
  let host = hostOf(doc);
  assert.deepEqual(buttonTexts(host), [S.gateLoad, S.gateHostOnly, S.gateCancel]);
  assert.ok(allText(host).includes(S.gateText));
  assert.equal(host.buttonByText(S.gateLoad).focused, true);
  host.buttonByText(S.gateHostOnly).click();
  assert.deepEqual(calls, ['host']);
  assert.equal(hostOf(doc), null);

  panel.showGate({ hostOnlyOffered: false, onLoad: () => calls.push('load'), onCancel: () => calls.push('cancel') });
  host = hostOf(doc);
  assert.deepEqual(buttonTexts(host), [S.gateLoad, S.gateCancel], 'no host-only button without a web seed');
  host.buttonByText(S.gateCancel).click();
  panel.showGate({ onLoad: () => calls.push('load') });
  hostOf(doc).buttonByText(S.gateLoad).click();
  assert.deepEqual(calls, ['host', 'cancel', 'load']);
});

test('key change: both fingerprints and the scope, Keep (default) or Confirm', () => {
  const { doc, panel } = setup();
  const calls = [];
  panel.showKeyChange({ scope: 'site.test', oldFp: 'aaaa1111', newFp: 'bbbb2222', onKeep: () => calls.push('keep'), onConfirm: () => calls.push('confirm') });
  const host = hostOf(doc);
  const text = allText(host);
  assert.ok(text.includes(S.keyChangedTitle));
  assert.ok(text.includes('aaaa1111') && text.includes('bbbb2222') && text.includes('site.test'));
  assert.deepEqual(buttonTexts(host), [S.keyChangedKeep, S.keyChangedConfirm]);
  assert.equal(host.buttonByText(S.keyChangedKeep).focused, true, 'the safe choice has the focus');
  host.buttonByText(S.keyChangedConfirm).click();
  assert.deepEqual(calls, ['confirm']);
  assert.equal(hostOf(doc), null);
});

test('showMessage: a status card with optional actions', () => {
  const { doc, panel } = setup();
  const calls = [];
  panel.showMessage(S.settingsForgetDone, { actions: [{ label: S.reload, onClick: () => calls.push('reload') }] });
  const host = hostOf(doc);
  assert.ok(allText(host).includes(S.settingsForgetDone));
  host.buttonByText(S.reload).click();
  assert.deepEqual(calls, ['reload']);
  assert.equal(hostOf(doc), null);
  panel.showMessage('plain');
  panel.hidePrompt();
  assert.equal(hostOf(doc), null);
});

test('settings: sharing, storage and version; toggles call back and the control keeps focus after the re-render', () => {
  const { doc, panel } = setup();
  const changes = [];
  const model = { share: true, hostOnly: false, hostOnlyForced: false, isMobile: false, shareOnNetwork: false, storage: { usage: 2 * 1024 * 1024, quota: 100 * 1024 * 1024 }, persisted: false, canForget: true, version: '0.2.0' };
  panel.openSettings(model, (action, payload) => changes.push([action, payload]));
  const host = hostOf(doc);
  const text = allText(host);
  assert.ok(text.includes(S.settingsTitle));
  assert.ok(text.includes(S.settingsShare), 'the verbatim Settings sentence (DESIGN-REVIEW 4.5)');
  // Code review round 1 (F56): the text says that Off still passes posts on and leaves the IP visible.
  assert.match(S.settingsShare, /Off stops sharing this site's files\. Posts are still passed between connected visitors, and your IP stays visible\. Choose Host only to stop all peer connections\./);
  assert.ok(text.includes(S.settingsHostOnly));
  assert.ok(text.includes(S.settingsStorageUsage('2.0 MB', '100 MB')));
  assert.ok(text.includes(S.settingsPersisted(false)));
  assert.ok(text.includes(S.settingsVersion('0.2.0')));
  assert.deepEqual(buttonTexts(host), [S.settingsForget, S.settingsClose]);
  const boxes = () => host.findAll((n) => n.tagName === 'INPUT');
  assert.equal(boxes().length, 2);
  assert.equal(boxes()[0].checked, true);
  boxes()[0].checked = false;
  boxes()[0].dispatchEvent({ type: 'change' });
  assert.deepEqual(changes, [['share', { on: false }]]);
  panel.updateSettings(Object.assign({}, model, { share: false }));
  assert.equal(boxes()[0].checked, false);
  assert.equal(boxes()[0].focused, true, 'focus returns to the control that was used');
  assert.ok(allText(host).includes(S.settingsShareLabel + ': ' + S.settingsOff));
  host.buttonByText(S.settingsForget).click();
  assert.deepEqual(changes[1], ['forget', {}]);
  panel.notify(S.settingsForgetDone, 'ok');
  assert.ok(allText(host).includes(S.settingsForgetDone));
  host.buttonByText(S.settingsClose).click();
  assert.deepEqual(changes[2], ['close', {}]);
  assert.equal(panel.settingsOpen, false);
  assert.equal(hostOf(doc), null);
});

test('settings: host-only forced (no WebRTC) disables that switch; share switch is disabled while host only; mobile adds "Share on this network"; no forget without a copy', () => {
  const { doc, panel } = setup();
  const changes = [];
  panel.openSettings({ share: true, hostOnly: true, hostOnlyForced: true, isMobile: true, shareOnNetwork: false, storage: {}, persisted: null, canForget: false }, (a, p) => changes.push([a, p]));
  const host = hostOf(doc);
  const [shareBox, hostBox] = host.findAll((n) => n.tagName === 'INPUT');
  assert.equal(shareBox.disabled, true, 'sharing is moot while host only');
  assert.equal(hostBox.disabled, true, 'forced by the browser');
  assert.equal(hostBox.checked, true);
  assert.deepEqual(buttonTexts(host), [S.settingsShareOnNetwork + ': ' + S.settingsOff, S.settingsClose]);
  assert.ok(allText(host).includes(S.settingsShareOnNetworkNote));
  assert.ok(allText(host).includes(S.settingsPersisted(null)));
  host.buttonByText(S.settingsShareOnNetwork + ': ' + S.settingsOff).click();
  assert.deepEqual(changes, [['shareOnNetwork', { on: true }]]);
});

test('settings: Escape closes them, and a card and the settings can be open together', () => {
  const { doc, panel } = setup();
  const changes = [];
  panel.showNotice({});
  const close = panel.openSettings({ storage: {} }, (a) => changes.push(a));
  const host = hostOf(doc);
  assert.equal(panel.settingsOpen, true);
  assert.equal(panel.promptKind, 'notice');
  const card = host.find((n) => n.getAttribute('role') === 'dialog');
  card.dispatchEvent({ type: 'keydown', key: 'a' });
  assert.equal(panel.settingsOpen, true);
  card.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(panel.settingsOpen, false);
  assert.deepEqual(changes, ['close']);
  assert.equal(panel.promptKind, 'notice');
  assert.ok(hostOf(doc), 'the notice is still there');
  close();
  panel.updateSettings({});
  panel.notify('x');
});

test('styling is CSSOM only: fixed host with !important, no <style> element, no style attribute, no innerHTML', () => {
  const { doc, panel } = setup();
  panel.showNotice({});
  panel.openSettings({ storage: {}, isMobile: true, canForget: true }, () => {});
  const host = hostOf(doc);
  const pos = host.style.props.get('position');
  assert.deepEqual(pos, { value: 'fixed', priority: 'important' });
  assert.equal(host.style.props.get('pointer-events').value, 'none', 'the container never blocks the page; only cards take clicks');
  const everything = host.findAll(() => true).concat([host]);
  assert.equal(everything.filter((n) => n.tagName === 'STYLE').length, 0, 'no <style> element');
  assert.equal(everything.filter((n) => n.hasAttribute('style')).length, 0, 'no style attribute');
  const cards = host.findAll((n) => n.getAttribute('role') === 'region' || n.getAttribute('role') === 'dialog');
  assert.ok(cards.length >= 2);
  for (const c of cards) assert.equal(c.style.props.get('pointer-events').value, 'auto');
  const buttons = host.findAll((n) => n.tagName === 'BUTTON');
  assert.ok(buttons.every((b) => b.getAttribute('type') === 'button'), 'buttons never submit a host form');
  assert.ok(buttons.every((b) => b.style.props.get('cursor') && b.style.props.get('cursor').value === 'pointer'));
});

test('colours follow prefers-color-scheme at creation', () => {
  const light = setup({ dark: false });
  light.panel.showNotice({});
  const dark = setup({ dark: true });
  dark.panel.showNotice({});
  const bg = (ctx) => hostOf(ctx.doc).find((n) => n.getAttribute('role') === 'region').style.props.get('background').value;
  assert.equal(bg(light), '#ffffff');
  assert.notEqual(bg(dark), bg(light));
});

test('every visible string follows the wording rules: no em or en dashes, straight quotes only', () => {
  const { doc, panel } = setup();
  panel.showNotice({});
  panel.openSettings({ share: true, storage: { usage: 1, quota: 2 }, persisted: true, canForget: true, isMobile: true, version: '0.2.0' }, () => {});
  const text1 = allText(hostOf(doc));
  panel.showGate({ hostOnlyOffered: true });
  const text2 = allText(hostOf(doc));
  panel.showKeyChange({ scope: 's.test', oldFp: 'a', newFp: 'b' });
  const text3 = allText(hostOf(doc));
  for (const t of [text1, text2, text3]) {
    assert.ok(!/[–—‘’“”]/.test(t), t);
    assert.ok(!/blockchain|serverless|unstoppable|censorship/i.test(t), t);
  }
});

test('rectOf(label): where a button is on screen, for tests that must click inside the closed shadow root', () => {
  const { doc, panel } = setup();
  assert.equal(panel.rectOf(S.noticeOk), null, 'nothing shown yet');
  panel.showNotice({});
  const ok = hostOf(doc).buttonByText(S.noticeOk);
  assert.equal(panel.rectOf(S.noticeOk), null, 'the fake DOM has no layout');
  ok.getBoundingClientRect = () => ({ x: 400, y: 600, width: 50, height: 32, top: 600 });
  assert.deepEqual(panel.rectOf(S.noticeOk), { x: 400, y: 600, width: 50, height: 32 });
  assert.equal(panel.rectOf('No such button'), null);
});

test('destroy() removes everything', () => {
  const { doc, panel } = setup();
  panel.showNotice({});
  panel.openSettings({ storage: {} }, () => {});
  panel.destroy();
  assert.equal(hostOf(doc), null);
  assert.equal(panel.host, null);
  panel.showMessage('again after destroy works');
  assert.ok(hostOf(doc));
});

// ---- v0.3 (lane ui): no secret fields, redress speed bumps, prompt() ---------------------------------------

const findCardsHost = (doc) => doc.body.children.find((c) => c.hasAttribute('data-mw-ui-cards')) || null;

test('v0.3: without identity.legacy the settings have no password, file or text field; "Open identity page" asks the engine', () => {
  const { doc, panel } = setup();
  const actions = [];
  panel.openSettings({ share: true, storage: {}, identity: { short: 'abcd1234', name: 'Ada', canExport: true, canImport: true } }, (a) => actions.push(a));
  const host = hostOf(doc);
  assert.equal(host.findAll((n) => n.tagName === 'INPUT' && n.getAttribute('type') !== 'checkbox').length, 0, 'only checkboxes remain');
  assert.equal(buttonTexts(host).includes(S.settingsExportIdentity), false);
  assert.equal(buttonTexts(host).includes(S.settingsImportIdentity), false);
  host.buttonByText('Open identity page').dispatchEvent({ type: 'click', isTrusted: false });
  assert.deepEqual(actions, []);
  host.buttonByText('Open identity page').click();
  assert.deepEqual(actions, ['openIdentity']);
});

test('v0.3: a panel button does nothing when the page covers it, fades it, or moves it; the prompt is closed with a notice', () => {
  const doc = new FakeDocument();
  const styles = new Map();
  const win = { document: doc, innerWidth: 1000, innerHeight: 800, matchMedia: () => ({ matches: false }), getComputedStyle: (n) => styles.get(n) || { opacity: '1', visibility: 'visible', display: 'block' } };
  const panel = createPanel({ win });
  const calls = [];
  panel.showNotice({ onOk: () => calls.push('ok') });
  const ok2 = hostOf(doc).buttonByText(S.noticeOk);
  ok2.getBoundingClientRect = () => ({ x: 400, y: 600, width: 60, height: 40 });
  hostOf(doc)._shadow.elementFromPoint = () => ok2;
  doc.elementFromPoint = () => hostOf(doc);
  styles.set(ok2, { opacity: '0', visibility: 'visible', display: 'block' });
  ok2.click();
  assert.deepEqual(calls, [], 'opacity 0: no action');
  assert.equal(panel.promptKind, 'message');
  assert.ok(allText(hostOf(doc)).includes('Cancelled'));
});

test('v0.3: panel.prompt opens the sign-in card in its own closed root; the button calls the injected signIn, no secret fields', async () => {
  const doc = new FakeDocument();
  const win = { document: doc, matchMedia: () => ({ matches: false }) };
  const seen = [];
  const panel = createPanel({ win, actions: { signIn: async () => { seen.push('signIn'); return { state: 'signed-in' }; } }, cardOptions: { minVisibleMs: 0, strict: false } });
  const p = panel.prompt('signin', {});
  const h = findCardsHost(doc);
  assert.ok(h);
  assert.equal(h.shadowRoot, null, 'closed');
  assert.equal(h.findAll((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').length, 0);
  h.buttonByText('Sign in').click();
  assert.deepEqual(await p, { state: 'signed-in' });
  assert.deepEqual(seen, ['signIn']);
  await assert.rejects(panel.prompt('no-such-kind', {}), (e) => e.code === 'E_BAD_REQUEST');
  panel.destroy();
  assert.equal(findCardsHost(doc), null);
});
