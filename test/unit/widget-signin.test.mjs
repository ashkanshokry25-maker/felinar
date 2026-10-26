// Unit tests for src/widget/signin.js: challenge fetched (same origin only), client.signIn called with
// purpose 'server', proof posted, 10 s cooldown, 'mw-signin' events, no secret fields, closed shadow root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, FakeNode } from './dropin-fake-dom.mjs';
import { createSigninElement, createSigninRunner, sameOriginUrl, COOLDOWN_MS, EVENT_NAME } from '../../src/widget/signin.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup({ clientImpl, fetchImpl, attrs } = {}) {
  const doc = new FakeDocument();
  const win = { document: doc, location: { href: 'https://forum.test/thread/1', origin: 'https://forum.test' }, matchMedia: () => ({ matches: false }), navigator: { language: 'en-US' } };
  const clock = { t: 1000 };
  const calls = { fetch: [], signIn: [] };
  const fetchFn = fetchImpl || (async (url, init) => {
    calls.fetch.push([url, init]);
    if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ nonce: 'N0nce_abc', statement: 'Sign in to Example Forum', exp: 5000 }) };
    return { ok: true, status: 200, json: async () => ({ user: 'ana' }) };
  });
  // The real client opens its window and then awaits the challenge (client.js resolveLate); the fake does the same.
  const client = clientImpl || { signIn: async (arg) => { const challenge = await arg.challenge; calls.signIn.push(Object.assign({}, arg, { challenge })); return { proof: { c: { nonce: challenge.nonce }, alg: 'ES256-P1363', sig: 'xx' } }; } };
  class Base extends FakeNode { constructor() { super('mw-signin', doc); } }
  const El = createSigninElement({ HTMLElement: Base, win, doc, client, fetchFn, now: () => clock.t, makeEvent: (type, detail) => ({ type, detail, bubbles: true }) });
  const el = new El();
  for (const [k, v] of Object.entries(attrs || { statement: 'Sign in to Example Forum', 'challenge-url': '/auth/mw/challenge', 'proof-url': '/auth/mw/verify' })) el.setAttribute(k, v);
  const events = [];
  el.addEventListener(EVENT_NAME, (e) => events.push(e.detail));
  el.connectedCallback();
  return { el, doc, win, clock, calls, events, fetchFn };
}

const button = (el) => el._shadow.find((n) => n.tagName === 'BUTTON');

test('one button in a closed shadow root, the info sentence, and no input of any kind', () => {
  const { el } = setup();
  assert.equal(el.shadowRoot, null, 'closed');
  assert.equal(el._shadow.mode, 'closed');
  assert.equal(el._shadow.findAll((n) => n.tagName === 'BUTTON').length, 1);
  assert.equal(el._shadow.findAll((n) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName)).length, 0);
  assert.equal(button(el).textContent, 'Sign in with felinar');
  const text = el._shadow.findAll((n) => n._text).map((n) => n._text).join(' | ');
  assert.ok(text.includes('Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.'));
  assert.ok(!/blockchain|serverless|unstoppable|censorship-resistant|production-ready/i.test(text));
  el.connectedCallback(); // a second connect adds nothing
  assert.equal(el._shadow.findAll((n) => n.tagName === 'BUTTON').length, 1);
});

test('a click fetches the challenge, calls client.signIn with purpose server and want proof, posts the proof, emits events', async () => {
  const { el, calls, events } = setup();
  button(el).click();
  await flush(); await flush(); await flush();
  assert.equal(calls.fetch[0][0], 'https://forum.test/auth/mw/challenge');
  assert.equal(calls.fetch[0][1].method, 'GET');
  assert.equal(calls.fetch[0][1].credentials, 'same-origin');
  assert.equal(calls.signIn.length, 1);
  assert.deepEqual(calls.signIn[0], { purpose: 'server', challenge: { nonce: 'N0nce_abc', statement: 'Sign in to Example Forum', exp: 5000 }, want: ['proof'] });
  assert.equal(calls.fetch[1][0], 'https://forum.test/auth/mw/verify');
  assert.equal(calls.fetch[1][1].method, 'POST');
  // integration I-2: the proof text itself (mw-signin-v1 section 1), not { proof }.
  assert.deepEqual(JSON.parse(calls.fetch[1][1].body), { c: { nonce: 'N0nce_abc' }, alg: 'ES256-P1363', sig: 'xx' });
  assert.deepEqual(events.map((e) => e.state), ['pending', 'signed-in']);
  assert.deepEqual(events[1].body, { user: 'ana' });
  assert.equal(button(el).disabled, false);
});

test('the page cannot choose the proof fields: the client call carries only purpose, challenge and want', async () => {
  const { el, calls } = setup();
  el.setAttribute('origin', 'https://evil.test');
  el.setAttribute('key-mode', 'linked');
  button(el).click();
  await flush(); await flush(); await flush();
  assert.deepEqual(Object.keys(calls.signIn[0]).sort(), ['challenge', 'purpose', 'want']);
});

test('a script-made click does nothing', async () => {
  const { el, calls, events } = setup();
  button(el).dispatchEvent({ type: 'click', isTrusted: false });
  await flush();
  assert.equal(calls.fetch.length, 0);
  assert.equal(events.length, 0);
});

test('10 s cooldown: a second click inside it reports E_RATE, one after it works', async () => {
  assert.equal(COOLDOWN_MS, 10000);
  const { el, calls, events, clock } = setup();
  button(el).click();
  await flush(); await flush(); await flush();
  clock.t += 3000;
  button(el).click();
  await flush(); await flush(); await flush();
  assert.equal(calls.signIn.length, 1);
  assert.equal(events[events.length - 1].code, 'E_RATE');
  clock.t += 8000;
  button(el).click();
  await flush(); await flush(); await flush();
  assert.equal(calls.signIn.length, 2);
  assert.equal(events[events.length - 1].state, 'signed-in');
});

test('cross-origin challenge-url or proof-url is refused before any request', async () => {
  const { el, calls, events } = setup({ attrs: { 'challenge-url': 'https://evil.test/c', 'proof-url': '/p' } });
  button(el).click();
  await flush(); await flush();
  assert.equal(calls.fetch.length, 0);
  assert.equal(events[events.length - 1].code, 'E_BAD_REQUEST');
  assert.throws(() => sameOriginUrl('//evil.test/x', { location: { href: 'https://forum.test/', origin: 'https://forum.test' } }), (e) => e.code === 'E_BAD_REQUEST');
  assert.equal(sameOriginUrl('/a?b=1', { location: { href: 'https://forum.test/x', origin: 'https://forum.test' } }), 'https://forum.test/a?b=1');
});

test('a challenge without a nonce is E_NONCE_REQUIRED; a cancelled sign-in posts nothing; a refused proof is E_DENIED', async () => {
  const a = setup({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ statement: 'x' }) }) });
  button(a.el).click();
  await flush(); await flush(); await flush();
  assert.equal(a.events[a.events.length - 1].code, 'E_NONCE_REQUIRED');
  assert.equal(a.calls.signIn.length, 0);

  const posts = [];
  const b = setup({
    clientImpl: { signIn: async () => { const e = new Error('c'); e.code = 'E_USER_CANCELLED'; throw e; } },
    fetchImpl: async (url, init) => { posts.push(init.method); return { ok: true, status: 200, json: async () => ({ nonce: 'abc' }) }; }
  });
  button(b.el).click();
  await flush(); await flush(); await flush();
  assert.deepEqual(posts, ['GET']);
  assert.equal(b.events[b.events.length - 1].code, 'E_USER_CANCELLED');
  assert.ok(b.el._shadow.findAll((n) => n._text).map((n) => n._text).join(' ').includes('You cancelled.'));

  const c = setup({ fetchImpl: async (url, init) => (init.method === 'GET' ? { ok: true, status: 200, json: async () => ({ nonce: 'abc' }) } : { ok: false, status: 403, json: async () => ({}) }) });
  button(c.el).click();
  await flush(); await flush(); await flush();
  assert.equal(c.events[c.events.length - 1].code, 'E_DENIED');
  assert.equal(c.events[c.events.length - 1].status, 403);
});

test('code review v0.3 round 2: client.signIn runs inside the click, before the challenge arrives (the window is never blocked)', async () => {
  const win = { location: { href: 'https://forum.test/', origin: 'https://forum.test' }, inClick: false };
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const opened = [];
  const fetchFn = async (url, init) => {
    if (init.method === 'GET') { await slow; return { ok: true, status: 200, json: async () => ({ nonce: 'late' }) }; }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  // A popup blocker: window.open works only while the click is being dispatched (the browser's transient activation).
  const client = { signIn: async (arg) => { opened.push(win.inClick); if (!win.inClick) { const e = new Error('blocked'); e.code = 'E_POPUP_BLOCKED'; throw e; } const ch = await arg.challenge; return { proof: { c: { nonce: ch.nonce } } }; } };
  const doc = new FakeDocument();
  Object.assign(win, { document: doc, matchMedia: () => ({ matches: false }), navigator: { language: 'en' } });
  class Base extends FakeNode { constructor() { super('mw-signin', doc); } }
  const El = createSigninElement({ HTMLElement: Base, win, doc, client, fetchFn, now: () => 1, makeEvent: (type, detail) => ({ type, detail }) });
  const el = new El();
  el.setAttribute('challenge-url', '/c');
  el.setAttribute('proof-url', '/p');
  const events = [];
  el.addEventListener(EVENT_NAME, (e) => events.push(e.detail));
  el.connectedCallback();
  win.inClick = true;
  button(el).click();
  win.inClick = false;
  assert.deepEqual(opened, [true], 'the identity window opened during the click');
  await new Promise((r) => setTimeout(r, 30)); // the challenge comes on a later task
  release();
  await flush(); await flush(); await flush(); await flush();
  assert.equal(events[events.length - 1].state, 'signed-in', JSON.stringify(events));
});

test('the runner accepts a lazily imported client (function returning a promise)', async () => {
  const seen = [];
  const win = { location: { href: 'https://a.test/', origin: 'https://a.test' } };
  const runner = createSigninRunner({
    client: async () => ({ signIn: async (arg) => { seen.push(arg.purpose); return { proof: { sig: 's' } }; } }),
    fetchFn: async (u, init) => ({ ok: true, status: 204, json: async () => ({ nonce: 'n' }) }),
    win, now: () => 1
  });
  const out = await runner.run({ challengeUrl: '/c', proofUrl: '/p' });
  assert.deepEqual(seen, ['server']);
  assert.equal(out.status, 204);
});

test('French label follows the lang attribute', () => {
  const { el } = setup({ attrs: { lang: 'fr', 'challenge-url': '/c', 'proof-url': '/p' } });
  assert.equal(button(el).textContent, 'Se connecter avec felinar');
});

test('integrator (UX-10): a blocked window does not start the cooldown; a second block in a row says to open the page in a browser', async () => {
  let n = 0;
  const clientImpl = { signIn: async () => { n++; const e = new Error('blocked'); e.code = 'E_POPUP_BLOCKED'; throw e; } };
  const { el, events, clock } = setup({ clientImpl });
  button(el).click();
  await flush(); await flush(); await flush();
  assert.equal(events[events.length - 1].code, 'E_POPUP_BLOCKED');
  clock.t += 500;
  button(el).click();
  await flush(); await flush(); await flush();
  assert.equal(n, 2, 'the second tap calls the client again (no E_RATE)');
  assert.ok(el._shadow.findAll((x) => x._text && /cannot open the sign-in window/.test(x._text)).length > 0, 'the open-in-browser sentence');
  const runner = createSigninRunner({ client: clientImpl, fetchFn: async () => ({ ok: true, json: async () => ({ nonce: 'n' }) }), win: { location: { href: 'https://f.test/', origin: 'https://f.test' } }, now: () => 0 });
  await assert.rejects(runner.run({ challengeUrl: '/c', proofUrl: '/p' }), (e) => e.code === 'E_POPUP_BLOCKED');
  await assert.rejects(runner.run({ challengeUrl: '/c', proofUrl: '/p' }), (e) => e.code === 'E_POPUP_BLOCKED', 'not E_RATE');
});
