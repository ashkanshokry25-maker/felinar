// Fixtures shared by the social example's tests: valid-looking ledger ids, hashes and keys, and snapshot builders in the shape
// of mw.db.subscribe (docs/SDK.md). ASCII only; not a test file.
import { sha256, utf8, b64urlEncode } from '../../examples/social/js/ids.js';

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const ledgerId = (n) => 'mw1:' + b64urlEncode(sha256(utf8('ledger|' + n))).slice(0, 27);
export const hashOf = (n) => hex(sha256(utf8('hash|' + n)));
export const pubOf = (n) => 'p256:' + b64urlEncode(Uint8Array.from([4, ...sha256(utf8('x|' + n)), ...sha256(utf8('y|' + n))]));
export const MINUTE = 60000;
export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0); // 2026-10-20 12:00 UTC

/** One list item as the SDK returns it: { h, author, ts, v }. */
export const item = (h, author, ts, v) => ({ h, author, ts, v });

/** snapshot({ owner, lists, kv, profiles, policy }) -> the object db.subscribe passes to its callback. */
export function snapshot(o = {}) {
  return {
    height: o.height || 1, depth: 1, bytes: o.bytes || 1024, capReached: false, kv: o.kv || {}, lists: o.lists || {}, profiles: o.profiles || {},
    policy: o.policy || { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [], allowCount: 0 },
    owner: o.owner || null, authors: 1, unmoderated: false, peers: o.peers || 0, inSync: o.inSync || 0, role: o.role || 'reader',
  };
}
/** A tiny world: person n has ledger ledgerId(n) and key pubOf(n). */
export function person(n, o = {}) {
  const id = ledgerId(n), owner = pubOf(n);
  const posts = (o.posts || []).map((p, i) => item(p.h || hashOf('post|' + n + '|' + i), owner, p.ts, p.v || { text: p.text }));
  const lists = Object.assign({ 'mw.post': posts }, o.lists || {});
  return { id, owner, snap: snapshot({ owner, lists, kv: o.kv, profiles: Object.assign({ [owner]: o.name || 'Person ' + n }, o.profiles), policy: o.policy, role: o.role }) };
}

// ---- scenarios for the browser tests (JSON only: they travel through page.addInitScript)
import { hubLabelFor, shortIdOf } from '../../examples/social/js/ids.js';
export { hubLabelFor, shortIdOf };
export const label = (n) => hubLabelFor(ledgerId(n));

/** A personal ledger as the mock keeps it: { id, owner, policy, lists, kv, profiles }. */
export function ledger(n, o = {}) {
  const owner = pubOf(n), id = o.id || ledgerId(n);
  const posts = (o.posts || []).map((p, i) => item(p.h || hashOf('post|' + n + '|' + i), owner, p.ts, p.v || { text: p.text }));
  return {
    id, owner, policy: o.policy || { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [] },
    lists: Object.assign({ 'mw.post': posts }, o.lists || {}), kv: o.kv || {}, profiles: Object.assign({ [owner]: o.name || 'Person ' + n }, o.profiles || {}), bytes: o.bytes || 20480,
    withdrawn: o.withdrawn, removed: o.removed,
  };
}
/** scenario({ me: n, name, followed: [n..], ledgers: [ledger(...)], ...extra }) -> an object for globalThis.__mwScenario: person n is signed in on their own page. */
export function scenario(o = {}) {
  const n = o.me || 1, owner = pubOf(n);
  const base = {
    auth: 'signed-in', role: 'owner', mode: 'hub', siteId: ledgerId(n), me: owner, owner, short: shortIdOf(owner), siteName: 'Social', btih: '0123456789abcdef0123456789abcdef01234567',
    height: 5, peers: 2, inSync: 2, replay: true, source: 'peers', enforceCfg: true,
    home: { policy: { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [] }, profiles: { [owner]: o.name || 'Ada' }, lists: o.lists || {}, kv: o.kv || {} },
    ledgers: (o.ledgers || []).slice(), followed: (o.followed || []).map(ledgerId), chat: o.chat, pointers: o.pointers || {},
  };
  return Object.assign(base, o.extra || {});
}

// ---- a pointer whose derived ledger id is known, so a link can be followed in a test (the template derives ids from pointers itself)
import { parsePointerText, ledgerIdFromPointer } from '../../examples/social/js/hub.js';
export function pointerFor(n) {
  const pointer = 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; owner=' + pubOf(n) + '; chain=chain' + String(n).padStart(17, '0') + '; seq=3; exp=1900000000; sig=' + 'S'.repeat(86);
  const id = ledgerIdFromPointer(parsePointerText(pointer));
  return { pointer, id, label: hubLabelFor(id) };
}
