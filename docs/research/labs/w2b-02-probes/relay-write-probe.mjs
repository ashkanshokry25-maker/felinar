// relay-write-probe.mjs  -  PREPARED, NOT RUN.   Part of docs/research/w2b-02-nostr-durability.md (R14).
//
// Purpose: measure what NIP-66 cannot: do public relays STORE a ledger wrapper event published by an unknown key,
// what do they answer, how do they treat created_at skew, and when do they rate-limit.
//
// SAFETY: publishing is an outbound action on third-party infrastructure. This script is a DRY RUN unless BOTH
//   (1) the flag --send is given, and
//   (2) the environment variable MW_PROBE_APPROVED is set to the exact string "yes: <relay list file> approved by Ash on <date>".
// Never set (2) yourself on Ash's behalf. Every event carries ["expiration", now+3600] and a plain-text marker; --cleanup
// sends NIP-09 deletions for events this run created (same throw-away key). At most 3 events per relay (+2 skew events
// with --skew, +N paced events with --burst on the first 3 relays only).
//
// Build (needs @noble/secp256k1 3.x; project node_modules does not ship it):
//   NODE_PATH=<dir containing node_modules/@noble/secp256k1> ../../../../node_modules/.bin/esbuild relay-write-probe.mjs \
//     --bundle --platform=node --format=esm --outfile=/tmp/relay-write-probe.mjs
//   node /tmp/relay-write-probe.mjs --relays relays.txt --kind-block 7777 --kind-ckpt 31111            (dry run)
//   MW_PROBE_APPROVED="yes: relays.txt approved by Ash on 2026-MM-DD" node /tmp/relay-write-probe.mjs --relays relays.txt --send --skew --cleanup
//
// Kind numbers are PLACEHOLDERS: check them against the registry first (R3). relays.txt = one wss:// URL per line.
import * as secp from '@noble/secp256k1';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : (args[i + 1]?.startsWith('--') || i + 1 >= args.length ? true : args[i + 1]); };
const KIND_BLOCK = +opt('kind-block', 7777), KIND_CKPT = +opt('kind-ckpt', 31111);
const relays = readFileSync(String(opt('relays', 'relays.txt')), 'utf8').split('\n').map((s) => s.trim()).filter((s) => /^wss:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(s));
const SEND = !!opt('send', false) && String(process.env.MW_PROBE_APPROVED || '').startsWith('yes: ');
const b64url = (u8) => Buffer.from(u8).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest();
const sk = secp.schnorr.keygen().secretKey, pk = Buffer.from(secp.schnorr.getPublicKey(sk)).toString('hex');
const now = () => Math.floor(Date.now() / 1000);

async function mkEvent(kind, tags, content, created_at = now()) {
  const id = sha(JSON.stringify([0, pk, created_at, kind, tags, content]));
  const sig = Buffer.from(await secp.schnorr.signAsync(id, sk)).toString('hex');
  return { id: id.toString('hex'), pubkey: pk, created_at, kind, tags, content, sig };
}
const ledger = 'mw-probe:' + b64url(randomBytes(9));
const exp = ['expiration', String(now() + 3600)];
const body = (n) => b64url(Buffer.from('magnet-web research probe, safe to delete, expires in 1 hour. ' + 'x'.repeat(n)));
async function plan() {
  const h1 = sha('a' + Math.random()).toString('hex'), h2 = sha('b' + Math.random()).toString('hex');
  const ev = [
    ['block-1.5KB', await mkEvent(KIND_BLOCK, [['t', ledger], ['x', h1], exp], body(706))],
    ['block-6KB', await mkEvent(KIND_BLOCK, [['t', ledger], ['x', h2], exp], body(4081))],
    ['checkpoint', await mkEvent(KIND_CKPT, [['d', ledger], ['n', '2'], ['root', sha('r').toString('hex')], exp], '')],
  ];
  if (opt('skew', false)) for (const d of [300, 1200]) ev.push(['skew+' + d + 's', await mkEvent(KIND_BLOCK, [['t', ledger], ['x', sha('s' + d).toString('hex')], exp], body(100), now() + d)]);
  return ev;
}
const events = await plan();
console.log(JSON.stringify({ mode: SEND ? 'SEND' : 'DRY-RUN', relays: relays.length, ledger, events: events.map(([n, e]) => ({ n, kind: e.kind, bytes: Buffer.byteLength(JSON.stringify(e)) })) }, null, 1));
if (!SEND) { console.log('Dry run only: nothing was sent. See the header for how to arm this script.'); process.exit(0); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function session(url, items) {
  const out = { relay: url, results: [] };
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connect')); setTimeout(() => rej(new Error('timeout')), 10000); }).catch((e) => { out.error = String(e.message); });
  if (out.error) return out;
  const pending = new Map();
  ws.onmessage = (m) => { try { const a = JSON.parse(m.data); if (a[0] === 'OK' && pending.has(a[1])) pending.get(a[1])({ accepted: a[2], msg: String(a[3] || '').slice(0, 160) }); } catch {} };
  for (const [name, e] of items) {
    const p = new Promise((r) => { pending.set(e.id, r); setTimeout(() => r({ accepted: null, msg: 'no OK within 8 s' }), 8000); });
    ws.send(JSON.stringify(['EVENT', e]));
    out.results.push({ name, id: e.id, ...(await p) });
    await wait(1500);
  }
  if (opt('cleanup', false)) {
    const del = await mkEvent(5, items.map(([, e]) => ['e', e.id]).concat([['k', String(KIND_BLOCK)], ['k', String(KIND_CKPT)]]), 'research probe cleanup');
    ws.send(JSON.stringify(['EVENT', del])); out.cleanup_sent = true; await wait(1500);
  }
  ws.close();
  return out;
}
const results = [];
for (const url of relays) { results.push(await session(url, events)); console.log(JSON.stringify(results[results.length - 1])); await wait(2000); }
// Read-back after 60 s (separate connection, REQ by #x). Later read-back (+1 h): run again with --readback-only and the printed ids.
await wait(60000);
for (const url of relays) {
  const ids = events.map(([, e]) => e.tags.find((t) => t[0] === 'x' || t[0] === 'd')[1]);
  const ws = new WebSocket(url); const got = new Set();
  await new Promise((res) => { ws.onopen = () => { ws.send(JSON.stringify(['REQ', 'rb', { '#x': ids.slice(0, 2) }, { '#d': [ledger] }])); }; ws.onmessage = (m) => { try { const a = JSON.parse(m.data); if (a[0] === 'EVENT') got.add(a[2].id); if (a[0] === 'EOSE') res(); } catch {} }; setTimeout(res, 8000); });
  ws.close(); console.log(JSON.stringify({ relay: url, readback_60s: [...got].length, of: events.length }));
}
