// U-ID-6 (R 2.3.8, MF-05): the device link between two identity origins. Commit before reveal, a substituted
// key changes the SAS, no ciphertext before the person confirms, codes refused after 120 s, no site name or
// ledger id in any code, and every code survives a QR round trip through the bundled encoder and decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';

import { LinkNewDevice, LinkOldDevice, sasFor, parseLinkCode, LINK_WINDOW_MS, LINK_PREFIX } from '../../src/idp/link.js';
import { encode, decode, toImageData } from '../../src/idp/qr.js';
import { Vault } from '../../src/identity/vault.js';
import { b64url } from '../../src/chain/canonical.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

async function secrets() {
  const { vault, kVault } = Vault.create();
  vault.label('o|https://shop.example');
  vault.label('l|mw1:abcdefghijklmnopqrstuvwxyz0');
  vault.addSite('o|https://shop.example', 'https://shop.example');
  const rootStar = webcrypto.getRandomValues(new Uint8Array(32));
  return { rootStar, kVault, vault, vaultBlob: await vault.toBlob(kVault, { id: 'AAAAAAAAAAAAAAAAAAAAAA' }) };
}

async function link({ tamper = null, clk = clock() } = {}) {
  const b = new LinkNewDevice({ now: clk.now });
  const a = new LinkOldDevice({ now: clk.now });
  a.open();
  const qr1 = await b.open();
  const qr2 = await a.acceptCommit(qr1);
  const toB = tamper && tamper.qr2 ? await tamper.qr2(qr2) : qr2;
  const { reveal, sas: sasB } = await b.acceptA(toB);
  const { sas: sasA } = await a.acceptReveal(reveal);
  return { a, b, qr1, qr2, reveal, sasA, sasB, clk };
}

test('the happy path moves root* and K_vault and the vault blob; both screens show the same 6 digits', async () => {
  const s = await secrets();
  const { a, b, sasA, sasB } = await link();
  assert.match(sasA, /^\d{6}$/);
  assert.equal(sasA, sasB);
  const codes = await a.confirm(true, s);
  assert.ok(codes.length >= 2, 'the identity code and at least one vault part');
  await b.acceptSecret(codes[0]);
  for (const c of codes.slice(1)) b.acceptPart(c);
  const got = b.complete();
  assert.deepEqual(Array.from(got.rootStar), Array.from(s.rootStar));
  assert.deepEqual(Array.from(got.kVault), Array.from(s.kVault));
  assert.deepEqual(got.vaultBlob, s.vaultBlob);
  const opened = await Vault.open(got.kVault, got.vaultBlob);
  assert.deepEqual(opened.toJSON(), s.vault.toJSON());
});

test('commit before reveal: QR 1 carries only SHA-256(eB) and the nonce, and a substituted reveal is refused', async () => {
  const clk = clock();
  const b = new LinkNewDevice({ now: clk.now });
  const a = new LinkOldDevice({ now: clk.now });
  a.open();
  const qr1 = await b.open();
  const c1 = parseLinkCode(qr1);
  assert.equal(c1.step, 'c');
  assert.equal(c1.commit.length, 32);
  assert.equal(c1.nonce.length, 16);
  // A cannot be given the reveal before the commitment.
  const early = new LinkOldDevice({ now: clk.now });
  early.open();
  await assert.rejects(early.acceptReveal('mwlink:2:b:' + b64url.encode(new Uint8Array(65).fill(4))), (e) => e.code === 'E_LINK_STEP');
  await a.acceptCommit(qr1);
  // Another key revealed under B's commitment: refused, so a substitution needs a grind the commitment forbids.
  const other = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', other.publicKey));
  await assert.rejects(a.acceptReveal('mwlink:2:b:' + b64url.encode(raw)), (e) => e.code === 'E_LINK_COMMIT');
  // And after a failed reveal nothing can be confirmed.
  await assert.rejects(a.confirm(true, await secrets()), (e) => e.code === 'E_LINK_STEP');
});

test('a substituted key changes the SAS (an attacker in the middle of QR 2 is seen by the person)', async () => {
  let mallory = null;
  const { sasA, sasB } = await link({
    tamper: {
      async qr2() {
        const k = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        mallory = new Uint8Array(await webcrypto.subtle.exportKey('raw', k.publicKey));
        return 'mwlink:2:a:' + b64url.encode(mallory);
      },
    },
  });
  assert.ok(mallory);
  assert.notEqual(sasA, sasB, 'B computed its number with the attacker key, A with its own');
});

test('the SAS is uint32_be(SHA-256("mw-link-v2" || eA || eB || nonceB)[0..4]) mod 10^6', async () => {
  for (let i = 0; i < 20; i++) {
    const eA = webcrypto.getRandomValues(new Uint8Array(65));
    const eB = webcrypto.getRandomValues(new Uint8Array(65));
    const nonce = webcrypto.getRandomValues(new Uint8Array(16));
    const h = createHash('sha256').update(Buffer.from(LINK_PREFIX)).update(eA).update(eB).update(nonce).digest();
    const expect = String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
    assert.equal(await sasFor(eA, eB, nonce), expect);
  }
  assert.equal(2 ** 32 % 1000000, 967296, 'the stated bias: 967,296 values occur one extra time');
});

test('no ciphertext before the person confirms; a "they differ" answer ends the link with nothing sent', async () => {
  const s = await secrets();
  const { a, qr1, qr2, reveal } = await link();
  for (const code of [qr1, qr2, reveal]) {
    assert.ok(!/^mwlink:2:[sv]:/.test(code), 'only keys, a hash and a nonce travel before the confirmation');
    assert.ok(!code.includes(b64url.encode(s.rootStar)) && !code.includes(b64url.encode(s.kVault)));
  }
  assert.equal(a.state, 'compare');
  await assert.rejects(a.confirm(false, s), (e) => e.code === 'E_USER_CANCELLED');
  assert.equal(a.state, 'failed');
  await assert.rejects(a.confirm(true, s), (e) => e.code === 'E_LINK_STEP', 'no second chance after "they differ"');
});

test('codes are accepted only within 120 s of the person opening the screen, on each device', async () => {
  const clkA = clock();
  const clkB = clock();
  const b = new LinkNewDevice({ now: clkB.now });
  const a = new LinkOldDevice({ now: clkA.now });
  a.open();
  const qr1 = await b.open();
  clkA.advance(LINK_WINDOW_MS + 1);
  await assert.rejects(a.acceptCommit(qr1), (e) => e.code === 'E_LINK_EXPIRED');
  // B's own window as well.
  const a2 = new LinkOldDevice({ now: clkA.now });
  a2.open();
  const qr2 = await a2.acceptCommit(qr1);
  clkB.advance(LINK_WINDOW_MS + 1);
  await assert.rejects(b.acceptA(qr2), (e) => e.code === 'E_LINK_EXPIRED');
  // Inside the window everything works (the boundary itself is accepted).
  const fresh = await link({ clk: clock() });
  fresh.clk.advance(LINK_WINDOW_MS - 1);
  const codes = await fresh.a.confirm(true, await secrets());
  await fresh.b.acceptSecret(codes[0]);
});

test('no QR carries a site name or a ledger id, and every code survives the QR encoder and decoder', async () => {
  const s = await secrets();
  const { a, b, qr1, qr2, reveal } = await link();
  const codes = [qr1, qr2, reveal].concat(await a.confirm(true, s));
  for (const code of codes) {
    assert.match(code, /^mwlink:2:[cabsv]:[A-Za-z0-9_:-]+$/);
    let text = code;
    if (code.startsWith('mwlink:2:v:')) text = Buffer.from(b64url.decode(code.split(':').pop())).toString('utf8');
    assert.ok(!text.includes('shop.example') && !text.includes('mw1:') && !text.includes('o|') && !text.includes('l|'), 'no site name or ledger id in ' + code.slice(0, 16));
    const qr = encode(code, { ecl: 'M' });
    const back = decode(toImageData(qr, { scale: 3, margin: 4 }));
    assert.ok(back, 'decodes ' + code.slice(0, 12));
    assert.equal(back.text, code);
  }
  await b.acceptSecret(codes[3]);
  for (const c of codes.slice(4)) b.acceptPart(c);
  assert.deepEqual(Array.from(b.complete().kVault), Array.from(s.kVault));
});

test('parseLinkCode refuses malformed codes and steps out of order', async () => {
  for (const bad of ['', 'mwlink:1:c:aa:bb', 'mwlink:2:x:aa', 'mwlink:2:a:' + b64url.encode(new Uint8Array(64)), 'mwlink:2:a:' + b64url.encode(new Uint8Array(65)),
    'mwlink:2:c:' + b64url.encode(new Uint8Array(31)) + ':' + b64url.encode(new Uint8Array(16)), 'mwlink:2:v:3:2:abc', 'https://evil.example/']) {
    assert.throws(() => parseLinkCode(bad), (e) => e.code === 'E_LINK_STEP', bad);
  }
  const clk = clock();
  const b = new LinkNewDevice({ now: clk.now });
  await b.open();
  await assert.rejects(b.acceptSecret('mwlink:2:s:' + b64url.encode(new Uint8Array(92))), (e) => e.code === 'E_LINK_STEP');
  const a = new LinkOldDevice({ now: clk.now });
  a.open();
  await assert.rejects(a.acceptCommit('mwlink:2:b:' + b64url.encode(Uint8Array.from([4].concat(new Array(64).fill(1))))), (e) => e.code === 'E_LINK_STEP');
});
