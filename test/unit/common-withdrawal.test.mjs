// Unit tests for src/common/withdrawal.js (v0.2.1, DIGEST-AMENDMENTS A3): a withdrawal deletes every
// stored version of the scope, and only safe text and links reach the visitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeWithdrawn, withdrawalNotice } from '../../src/common/withdrawal.js';
import { ZERO_BTIH } from '../../src/common/pointer.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

function memoryCache({ sites = [], prefs = {}, failOn = null } = {}) {
  const store = { sites: new Set(sites), prefs: new Map(Object.entries(prefs)) };
  return {
    store,
    async getPref(k, d) { return store.prefs.has(k) ? store.prefs.get(k) : d; },
    async setPref(k, v) { store.prefs.set(k, v); },
    async listSites() { return Array.from(store.sites, (btih) => ({ btih })); },
    async deleteSite(b) {
      if (b === failOn) throw new Error('quota');
      store.sites.delete(b);
    },
  };
}

test('purgeWithdrawn deletes the listed versions, the replaced record and (all) every site of the origin; never the zero btih', async () => {
  const cache = memoryCache({ sites: [A, B, C, D], prefs: { 'versions:mw1:x': [A, B] } });
  const res = await purgeWithdrawn({ cache, ledgerId: 'mw1:x', btihs: [C.toUpperCase(), ZERO_BTIH, 'nonsense'] });
  assert.deepEqual(res.deleted.sort(), [A, B, C]);
  assert.deepEqual(Array.from(cache.store.sites), [D], 'another lineage stays without all');
  assert.deepEqual(cache.store.prefs.get('versions:mw1:x'), [], 'the version list is cleared');
  const res2 = await purgeWithdrawn({ cache, ledgerId: 'mw1:other', all: true });
  assert.deepEqual(res2.deleted, [D], 'all: a rotated key gives another ledger id, the origin still holds only this site');
  assert.equal(cache.store.sites.size, 0);
});

test('purgeWithdrawn never throws: storage errors are reported, a missing cache does nothing', async () => {
  const cache = memoryCache({ sites: [A, B], prefs: { 'versions:L': [A, B] }, failOn: B });
  const res = await purgeWithdrawn({ cache, ledgerId: 'L' });
  assert.deepEqual(res, { deleted: [A], failed: [B] });
  assert.deepEqual(await purgeWithdrawn({}), { deleted: [], failed: [] });
  const broken = { deleteSite: async () => {}, getPref: async () => { throw new Error('closed'); }, listSites: async () => { throw new Error('closed'); }, setPref: async () => { throw new Error('closed'); } };
  assert.deepEqual(await purgeWithdrawn({ cache: broken, ledgerId: 'L', all: true, btihs: [A] }), { deleted: [A], failed: [] });
});

test('withdrawalNotice: the owner\'s reason without control or bidi characters, at most 200 characters; only https: and mailto: contacts', () => {
  assert.deepEqual(withdrawalNotice({ why: 'copyright', ct: 'mailto:abuse@example.com' }), { why: 'copyright', ct: 'mailto:abuse@example.com' });
  assert.deepEqual(withdrawalNotice({ why: 'a\u0000b‮c', ct: 'https://example.com/report' }), { why: 'a b c', ct: 'https://example.com/report' });
  assert.equal(withdrawalNotice({ why: 'x'.repeat(300) }).why.length, 200);
  for (const bad of ['javascript:alert(1)', 'http://example.com/', 'data:text/html,hi', 'not a url', 42]) {
    assert.equal(withdrawalNotice({ ct: bad }).ct, null, String(bad));
  }
  assert.deepEqual(withdrawalNotice(null), { why: null, ct: null });
  assert.deepEqual(withdrawalNotice({ why: '   ' }), { why: null, ct: null });
  // Review round R 5.3 (PTR-12): zero-width and other format characters (Unicode Cf) do not survive either.
  assert.equal(withdrawalNotice({ why: 'Session\u200B expired\u200E. Sign\u2060 in\u00AD again\uFEFF' }).why, 'Session expired . Sign in again');
  assert.equal(/\p{Cf}/u.test(withdrawalNotice({ why: 'a\u200Bb\u200Cc\u200Dd\u2060e\u2066f\u202Eg' }).why), false);
});

test('the worker reads a stamped withdrawal as withdrawn (the shell check needs the record; the drop-in mapping skips it)', async () => {
  const { stampedPointerFromHtml } = await import('../../src/sw/lib.js');
  const active = '<!doctype html><html><head><meta name="mw-pointer" content="v=mw1; btih=' + A + '"></head>';
  const withdrawn = '<!doctype html><html><head><meta name="mw-pointer" content="v=mw1; st=withdrawn; btih=' + A + '"></head>';
  const unknown = '<!doctype html><html><head><meta name="mw-pointer" content="v=mw1; st=paused; btih=' + A + '"></head>';
  assert.equal(stampedPointerFromHtml(active).withdrawn, false);
  assert.equal(stampedPointerFromHtml(withdrawn).withdrawn, true);
  assert.equal(stampedPointerFromHtml(unknown).withdrawn, true, 'an unknown status is a withdrawal');
});
