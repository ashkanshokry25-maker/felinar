// test/e2e/v03/signin-lab.js: the page of the server-backed example site in the E-SI scenarios
// (test/e2e/scenarios-v03.mjs). Served with the unbundled src/ modules by
// test/fixtures/signin-server/server.mjs --static on 127.0.0.1 only.
//
// The identity origin (lane idp) does not exist in wave 1, so a STAND-IN plays its part: it builds the
// mw-signin-v1 challenge with src/identity/signin.js and signs it with a non-extractable P-256 key made
// here, taking the origin from location.origin (the real one takes event.origin of the opener). What is
// real: the <mw-signin> element (src/widget/signin.js, closed shadow root, redress check, same-origin
// URLs, the proof text POST), the fixture server and @felinar/verify (packages/verify/verify.js).
import { createSigninElement } from '/src/widget/signin.js';
import { buildChallenge, signChallenge, makeLocalProof } from '/src/identity/signin.js';
import { b64url } from '/src/chain/canonical.js';

const IDO = 'http://127.0.0.1:9'; // the stand-in identity origin's name in the proof (no server behind it)
const lab = { events: [], calls: [], key: null, pub: null };

async function key() {
  if (lab.key) return lab;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  lab.key = kp.privateKey;
  lab.pub = 'p256:' + b64url.encode(raw);
  return lab;
}

const requestId = () => b64url.encode(crypto.getRandomValues(new Uint8Array(16)));

/** proofFor(challenge, { origin, now, keyMode }) -> a signed proof, as the identity origin would make it. */
async function proofFor(challenge, { origin = location.origin, now = Date.now(), keyMode = 'pairwise' } = {}) {
  const k = await key();
  const c = buildChallenge({ origin, pub: k.pub, keyMode, purpose: 'server', challenge, now, requestId: requestId(), idp: IDO, build: 'e2e-lab' });
  return signChallenge(c, k.key);
}

lab.client = {
  // The real client opens its window first and then awaits the challenge (client.js resolveLate; code review v0.3, round 2:
  // the widget passes the challenge fetch as a promise so nothing is awaited inside the click before the window opens).
  async signIn(req) {
    const challenge = await req.challenge;
    lab.calls.push(Object.assign({}, req, { challenge }));
    return { proof: await proofFor(challenge) };
  },
};

customElements.define('mw-signin-lab', createSigninElement({ HTMLElement, win: window, doc: document, client: lab.client }));
document.addEventListener('mw-signin', (e) => lab.events.push(e.detail));

lab.challenge = async (base = '') => (await fetch(base + '/auth/mw/challenge', { method: 'POST', cache: 'no-store' })).json();
lab.proofFor = proofFor;
lab.post = async (proof, base = '') => {
  const r = await fetch(base + '/auth/mw/verify', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: typeof proof === 'string' ? proof : JSON.stringify(proof) });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, body };
};
lab.localProof = async () => {
  const k = await key();
  return makeLocalProof({ signKey: k.key, pub: k.pub, origin: location.origin, epoch: 1 });
};
lab.ready = true;
window.mwSigninLab = lab;
