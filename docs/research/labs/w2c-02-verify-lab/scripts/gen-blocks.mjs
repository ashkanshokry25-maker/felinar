// Generates ARCHITECTURE v0.2 section 6.1 blocks (ECDSA P-256, RFC 8785 canonical JSON) for the
// claim-5 verification. Output goes to <outDir>; nothing is written inside the project.
// usage: node gen-blocks.mjs <outDir> <N> <profile: few|many> [mix: post|tiny|ctl]
import { writeFile, mkdir } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const PROJ = '$HOME/Documents/Projects/magnet-web/src/chain/';
const { canonicalize, hex, b64url, utf8, byteLength } = await import(PROJ + 'canonical.js');

const [,, outDir, nArg, profile = 'few', mix = 'post'] = process.argv;
const N = Number(nArg);
const A = profile === 'many' ? N : 200;
const subtle = webcrypto.subtle;
const KEY = { name: 'ECDSA', namedCurve: 'P-256' };

const rb = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const sha256hex = async (s) => hex.encode(new Uint8Array(await subtle.digest('SHA-256', utf8.encode(s))));

const site = 'mw1:' + b64url.encode(rb(24)).slice(0, 27);
const authors = [];
for (let i = 0; i < A; i++) {
  const kp = await subtle.generateKey(KEY, true, ['sign', 'verify']);
  const pub = b64url.encode(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  authors.push({ priv: kp.privateKey, pub, seq: 0 });
}

const words = 'the quick brown fox jumps over a lazy dog and says hello to every visitor of this little guestbook page'.split(' ');
const sentence = (n) => { let s = ''; while (s.length < n) s += words[(Math.random() * words.length) | 0] + ' '; return s.slice(0, n).trim(); };

const blocks = [];
const heads = [];
let sizes = { e: 0, v: 0, json: 0, eMin: 1e9, eMax: 0 };
for (let i = 0; i < N; i++) {
  const a = authors[i % A];
  a.seq += 1;
  const prev = i === 0 ? [] : (heads.length > 1 && i % 7 === 0 ? [heads[heads.length - 1], heads[heads.length - 2]] : [heads[heads.length - 1]]);
  prev.sort();
  const ts = Math.floor((1760000000000 + i * 1000) / 60000) * 60000;
  let op; let v;
  const kind = mix === 'ctl' ? 'ctl' : mix === 'tiny' ? 'tiny' : (i % 9 === 0 ? 'put' : 'post');
  if (kind === 'post') { v = { name: 'visitor' + (i % 1000), text: sentence(120) }; op = { t: 'append', l: 'guestbook', vh: await sha256hex(canonicalize(v)) }; }
  else if (kind === 'put') { v = { n: i }; op = { t: 'put', k: 'counter/' + (i % 50), vh: await sha256hex(canonicalize(v)) }; }
  else if (kind === 'tiny') { v = 1; op = { t: 'put', k: 'like', vh: await sha256hex(canonicalize(v)) }; }
  else { op = { t: 'tombstone', h: heads.length ? heads[0] : '0'.repeat(64) }; }
  const e = { v: 1, site, author: a.pub, seq: a.seq, prev, ts, bits: 16, op, nonce: b64url.encode(rb(4)) };
  const ce = canonicalize(e);
  const h = await sha256hex(ce);
  const s = b64url.encode(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, a.priv, utf8.encode('mw-block-v1\n' + h))));
  const block = v === undefined ? { e, h, s } : { e, h, s, v };
  blocks.push(block);
  heads.push(h); if (heads.length > 4) heads.shift();
  const eB = byteLength(ce); const vB = v === undefined ? 0 : byteLength(canonicalize(v)); const jB = byteLength(JSON.stringify(block));
  sizes.e += eB; sizes.v += vB; sizes.json += jB; sizes.eMin = Math.min(sizes.eMin, eB); sizes.eMax = Math.max(sizes.eMax, eB);
}
await mkdir(outDir, { recursive: true });
const file = `${outDir}/blocks-${profile}-${mix}-${N}.json`;
await writeFile(file, JSON.stringify(blocks));
const avg = (x) => (x / N).toFixed(1);
const meanBlockBytes = (sizes.e + sizes.v) / N;
console.log(JSON.stringify({
  file, N, authors: A, mix,
  avgCanonicalE: +avg(sizes.e), eMin: sizes.eMin, eMax: sizes.eMax, avgCanonicalV: +avg(sizes.v),
  avgBlockBytes_eplusv: +meanBlockBytes.toFixed(1), avgBlockJsonBytes: +avg(sizes.json),
  blocksIn8MiB_ifCapCountsEplusV: Math.floor(8388608 / meanBlockBytes),
  blocksIn8MiB_ifCapCountsWholeJson: Math.floor(8388608 / (sizes.json / N)),
}, null, 1));
