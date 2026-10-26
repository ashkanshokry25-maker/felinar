# magnet-web — Module interface contract (binding for parallel implementation)

All code is ES modules (`"type": "module"`), vanilla JavaScript (no TypeScript, no frameworks,
no bundler-only syntax), 2-space indent, no semicolon-free style requirements (be consistent per
file). Shared code (`src/common`, `src/chain`) must run unchanged in Node ≥ 22 and in browsers:
use `globalThis.crypto.subtle`, `TextEncoder`, `Uint8Array` only (no `Buffer`, no `node:` imports
in shared code). Browser-only code lives in `src/loader`, `src/sw`, `src/sdk`. Node-only code in
`tools/` and `test/`.

Toolchain on this machine: Node 24 at `~/.local/share/node/current/bin` (prepend to PATH in
every shell command: `export PATH=$HOME/.local/share/node/current/bin:$PATH`). Dependencies are
already installed in `node_modules` (webtorrent 3.0.21, create-torrent 6, parse-torrent 11,
magnet-uri 7, bittorrent-tracker 11, esbuild 0.28, playwright 1.64, http-server). Do not
install anything else without recording it in your deviations file.

Encoding helpers (from `src/chain/canonical.js`): `hex.encode/decode`, `b64url.encode/decode`,
`utf8.encode/decode`, `canonicalize(value)`.

## src/common/magnet.js
```
export function normalizeBtih(str)            // 40-hex (any case) or 32-char base32 → lowercase hex40, else null
export function parseMagnet(uri)              // → { btih, dn, tr: string[], ws: string[], xs: string[] } | null
export function formatMagnet({ btih, dn, tr = [], ws = [] })  // deterministic param order: xt, dn, tr..., ws...
```

## src/common/pointer.js   (record grammar: ARCHITECTURE §4)
```
export function parsePointer(text)            // record string OR magnet URI → { ok: true, record } | { ok: false, error }
   // record = { v: 'mw1'|null, btih, dn, ws: [], tr: [], chain, max, owner, seq, exp, sig, raw, signed: bool }
export function formatPointer(record)         // → canonical "k=v; k=v" string (tr/ws repeated), sig last
export function signingInput(record, scope)   // → string per §4 (sorted k=v lines excluding sig, then scope)
export async function signPointer(record, scope, privateKey)   // → new record with sig (uses src/chain/crypto.js)
export async function verifyPointer(record, scope, { now = Date.now() } = {})  // → { ok, reason }  (sig + exp)
export function splitTxt(value)               // → string[] of ≤255-byte UTF-8 chunks, quoted for zone files by caller
export function joinTxtData(data)             // DoH `Answer[].data` → reassembled string (quotes/escapes handled)
export function magnetFromRecord(record, { defaultTrackers = [] } = {})  // merges tr/ws, dn
export function chainIdFor(record, scope, mode)   // record.chain || (mode==='domain' ? 'host:'+scope : 'btih:'+btih)
```

## src/chain/canonical.js
```
export function canonicalize(value)           // RFC 8785; throws TypeError on unsupported values
export const utf8 = { encode(str) → Uint8Array, decode(u8) → string }
export const hex  = { encode(u8) → string, decode(str) → Uint8Array }
export const b64url = { encode(u8) → string, decode(str) → Uint8Array }
export function concatBytes(...u8s)
export function byteLength(str)
```

## src/chain/crypto.js
```
export async function sha256(u8) → Uint8Array
export async function generateKeyPair({ extractable = false } = {}) → { publicKey, privateKey }   // ECDSA P-256
export async function exportPublicKey(publicKey) → string      // b64url of raw 65-byte point
export async function importPublicKey(pubB64url) → CryptoKey
export async function sign(privateKey, data) → Uint8Array      // raw r||s (64 bytes) — WebCrypto ECDSA default
export async function verify(pubB64url, data, sig) → boolean   // never throws on bad input → false
export async function exportPrivateJwk(privateKey) → object    export async function importPrivateJwk(jwk, { extractable = false } = {}) → CryptoKey
export async function publicFromPrivateJwk(jwk) → string       // pub b64url (strip d)
export function fingerprint(pubB64url) → Promise<string>       // first 8 hex of sha256(raw pub)
```

## src/chain/pow.js
```
export function leadingZeroBits(u8) → number
export async function hashEntry(entry) → { hashU8, hashHex }   // sha256(utf8(canonicalize(entry)))
export async function mine(entry, bits, { signal, onProgress, startNonce = 0 } = {}) → { entry, h }  // sets entry.nonce (string), stops on signal → throws { code: 'E_POW_ABORTED' }
export async function verifyPow(hashHex, bits) → boolean
```
`src/chain/pow-worker.js`: Worker script; `onmessage({ id, entry, bits })` → posts `{ id, entry, h }` or
`{ id, error }`; progress `{ id, progress: n }` every 2 000 hashes; `{ id, cancel: true }` aborts.
`src/chain/pow-client.js`: `createMiner({ workerUrl })` → `{ mine(entry, bits, { signal }), destroy() }`
falling back to inline `mine` when `Worker` is unavailable.

## src/chain/block.js
```
export const LIMITS = { maxBlockBytes: 16384, maxValueBytes: 8192, maxPrev: 8, maxKey: 256, maxListName: 64, maxName: 48 }
export const DEFAULT_POLICY = { bits: 14, writers: 'open', allow: [], maxValueBytes: 8192, rate: { n: 30, perMs: 600000 } }
export async function createBlock({ identity: { privateKey, pub }, site, seq, prev, op, ts, bits, miner }) → Block
export async function validateBlock(block, { bits, maxValueBytes = LIMITS.maxValueBytes } = {}) → { ok: true } | { ok: false, reason }
   // reasons: 'shape','size','hash','pow','sig','op','limit'
export function blockBytes(block) → number
export function opIsOwnerOnly(op) → boolean  // policy
```

## src/chain/dag.js
```
export class Dag {
  add(block) → 'added' | 'duplicate' | 'orphan'     // orphan = some prev unknown; kept in orphan pool and retried when parents arrive
  has(h), get(h), heads() → string[] (sorted), missing() → string[] (sorted unknown prevs), size, orphanCount
  order() → Block[]   // deterministic (depth, h) Kahn order; cached until next add
  depth(h) → number
  blocks() → Iterable<Block>
}
```

## src/chain/state.js
```
export function reduce(orderedBlocks, { ownerPub = null } = {}) → State
   // State = { kv: Map<string, { v, author, h, ts }>, lists: Map<string, Item[]>, profiles: Map<pub, name>,
   //           policy, tombstoned: Set<string>, height, authors: Set<string> }  Item = { h, author, ts, v }
export function snapshot(state) → plain JSON object { height, kv: {k: v}, lists: {name: Item[]}, profiles: {pub: name}, policy, authors: n }
export function policyAt(state) → effective policy
```

## src/chain/gossip.js  (transport-agnostic, no timers inside except via injected `setTimeout`)
```
export const MSG = { HELLO: 1, WANT: 2, BLOCKS: 3, ANN: 4 }
export function encode(type, obj) → Uint8Array      export function decode(u8) → { type, obj } | null
export class Gossip {
  constructor({ site, dag, ingest /* async (blocks, peerId) → { added: string[] } */, limits = { frameBytes: 16384, wantMax: 64 } })
  attach(peer)   // peer = { id, send(u8) }  → sends HELLO
  detach(peerId)
  handle(peerId, u8)                   // dispatch; returns Promise
  announce(block)                      // ANN to all peers (fire and forget)
  hello()                              // HELLO to all peers (call every 30 s and after head change)
  peers → number ; stats → { in, out, invalid, dropped }
}
```

## src/chain/wire-ext.js
```
export function makeWireExtension(gossip, { name = 'mw_chain' } = {}) → class WireExt   // WireExt.prototype.name = name
export function attachToTorrent(torrent, gossip)   // wires existing + 'wire' event; returns detach()
```

## src/chain/stores.js
```
export class MemoryBlockStore { async open(siteId), async getAll() → Block[], async put(block), async putMany(blocks), async tombstone(h), async getMeta(k)/setMeta(k, v), async close() }
export class IdbBlockStore  { same API; DB name `mw-chain-<siteId>` (sanitised), stores 'blocks' (key h), 'meta' }
```

## src/chain/node.js  (ARCHITECTURE §6.7)
```
export class ChainNode {
  static async open({ siteId, ownerPub = null, bits, store, identity /* { privateKey, pub } */, miner, now = () => Date.now(), setTimeoutFn })
  state, snapshot(), height, peers, identity, isOwner
  async put(k, v) / del(k) / append(l, v) / profile(name) / policy(p) / tombstone(h)   → Block (throws { code, message })
  subscribe(fn) → unsubscribe        // fn(snapshot, { reason: 'local'|'remote'|'load' })
  attachWire(wire)                   // uses wire-ext
  async ingest(blocks, peerId = 'local') → { added: string[], rejected: [{ h, reason }] }
  exportBlocks() → Block[]           // for backup / pin
  async close()
}
```

## src/loader/doh.js
```
export const RESOLVERS = [ { name: 'cloudflare', url: (name, type) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, headers: { accept: 'application/dns-json' } },
                           { name: 'google', url: (name, type) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, headers: {} } ]
export async function resolveTxt(name, { fetch = globalThis.fetch, timeoutMs = 4000, resolvers = RESOLVERS } = {})
   // → { answers: [{ resolver, strings: string[] /* each TXT record reassembled */, ad: boolean, ttl, status }], errors: [{ resolver, error }] }
export function shouldSkipDoh(hostname) → boolean   // localhost, IP literals, .local, .localhost, .test, single label
```

## src/loader/cache.js  (single source of truth for the IndexedDB schema; `src/sw/sw.js` re-implements a minimal reader with identical names)
```
export const DB_NAME = 'mw-sites', DB_VERSION = 1
export const STORES = { sites: 'sites', files: 'files', pointers: 'pointers', pins: 'pins', prefs: 'prefs', identity: 'identity' }
// sites:    key btih → { btih, name, torrentFile: Uint8Array, files: [{ path, length, type }], total, savedAt, complete: true }
// files:    key `${btih}/${path}` → Blob            (path = file.path WITHOUT the leading torrent-name segment, i.e. site-relative, e.g. 'css/app.css')
// pointers: key scope → { record, raw, source, savedAt }
// pins:     key scope → { owner, decidedAt }
// prefs:    key string → any   (e.g. 'consent', 'upload', 'hubMode:<btih>')
// identity: key 'me' → { privateKey: CryptoKey, publicKey: CryptoKey, pub: string }
export async function openDb()
export async function saveSite(manifest, blobs /* Map<path, Blob> */)   export async function getSite(btih)   export async function getFile(btih, path)   export async function listSites()   export async function deleteSite(btih)
export async function getPointer(scope) / savePointer(scope, value)   export async function getPin(scope) / savePin(scope, owner)
export async function getPref(key, fallback) / setPref(key, value)   export async function getIdentity() / saveIdentity(obj)   export async function estimateUsage()
```
Path convention: WebTorrent `file.path` for a multi-file torrent is `<torrent name>/<relative path>`;
strip the first segment when storing and when serving. Single-file torrents: path = file name.

## src/loader/blob-chunk-store.js
```
export class BlobChunkStore { constructor(chunkLength, { files: [{ path, length, blob }], length })   // abstract-chunk-store
  put(index, buf, cb) → cb(null)  (no-op; store is read-only)   get(index, opts, cb)   close(cb)   destroy(cb)   chunkLength, length }
```

## src/loader/torrent.js
```
export class TorrentManager extends EventTarget
  constructor({ WebTorrent, config, policy })     // config.trackers, config.stun; policy.maxConns, policy.uploadLimit
  async download({ magnet, maxBytes, signal }) → { torrent, manifest, blobs }   // manifest per cache.js; rejects { code: 'E_TOO_LARGE' | 'E_TIMEOUT' | 'E_NO_PEERS' | 'E_ABORTED' }
  async seedFromCache({ manifest, blobs }) → torrent                            // same infohash, skipVerify + BlobChunkStore
  torrent, client, peers, downloaded, total, source /* 'peers'|'webseed'|'cache'|'mixed' */
  pause() / resume() / setUploadLimit(bps) / destroy()
  // CustomEvents: 'progress' { downloaded, total, peers, downloadSpeed, uploadSpeed, webseedBytes }, 'peers' { count }, 'wire' { wire }, 'done', 'error' { error }, 'status' { text }
```

## src/loader/policy.js
```
export function detectEnvironment() → { isMobile, cellular, saveData, effectiveType, online }
export function computePolicy(env, prefs) → { maxConns, uploadLimit, maxSiteBytes, hiddenPauseMs, uploadsEnabled }   // table in ARCHITECTURE §8
export function watchVisibility({ onHidden, onVisible }) → stop()
```

## src/loader/render.js
```
export async function registerServiceWorker({ url = '/sw.js', timeoutMs = 3000 } = {}) → { ok, controlled, degraded, error }
export function mountSite({ container, btih, entryPath = 'index.html', mode = 'domain', onNavigate }) → { iframe, navigate(path), currentPath(), destroy() }
export async function mountDegraded({ container, btih, entryPath, files /* [{ path, blob, type }] */ }) → same shape
export function pathFromLocation(loc) → string        // '/about.html' → 'about.html', '/' → 'index.html'
```

## src/loader/bridge.js  (host side of SDK; protocol in ARCHITECTURE §9)
```
export class Bridge { constructor({ iframe, node, torrentManager, info /* { siteId, btih, mode, name, files } */, onIdentityName })
  attach() / destroy() / push(event, data) }
```
Messages: child → parent `{ mw: 'hello' }` with a MessagePort; then on the port: request `{ id, method, params }`,
response `{ id, ok: true, result }` / `{ id, ok: false, error: { code, message } }`, push `{ event, data }` with events
`state` (snapshot), `peers` ({ count }), `progress`, `status`. Methods: `ready`, `db.get`, `db.set`, `db.del`, `db.list`,
`db.append`, `db.tombstone`, `identity.setName`, `net.peers`, `owner.policy`, `site.info`.

## src/loader/ui.js
```
export function createUI(root) → { setStatus(text, kind /* 'info'|'ok'|'warn'|'error' */), setProgress({ downloaded, total }), setPeers(n), setHeight(n),
   setIdentity({ short, name }), setSource(text), setPointerInfo({ source, signed, pinned, owner }), showError({ title, detail, actions }),
   showConsent({ onSettings, onDismiss }), onSettings(fn), setSettingsModel({ uploadsEnabled, cacheBytes, isOwner }), debug(line), setBanner(text|null) }
```

## src/loader/config.js
```
export const CONFIG = { trackers: [...wss...], stun: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }],
  doh: 'see doh.js', limits: { maxSiteBytesDesktop: 134217728, maxSiteBytesMobile: 50331648, maxSiteBytesCellular: 25165824 },
  timeouts: { metadataMs: 45000, noPeersMs: 60000 }, chain: { bits: 14 }, version: '0.1.0' }
```
Tracker list is a placeholder until `docs/research/RESEARCH-DIGEST.md` lands; keep it in ONE place.

## src/sw/sw.js and src/sw/lib.js
```
// lib.js (unit-testable, no SW globals)
export function mimeFor(path) → string            export function parseRange(header, size) → { start, end } | null | 416
export function splitSitePath(pathname) → { btih, path } | null   // '/_mw/s/<btih>/<path>'
export function entryFor(path, hasFile /* (p) => boolean */) → string   // directory → index.html rules
// sw.js: self.__BUILD_ID__ and self.__PRECACHE__ are replaced by build.mjs (string + JSON array)
```

## src/sdk/sdk.js
Default export `mw` per ARCHITECTURE §9; works as `<script type="module">` and classic `<script>` (assigns `window.mw`).
`mw.ready()` resolves after the bridge handshake; all methods reject with `{ code, message }` on failure.

## tools/*.mjs, build.mjs, package.json scripts  (owned by the tools agent)
```
"scripts": { "build": "node build.mjs", "test": "node --test test/unit", "test:e2e": "node test/e2e/run.mjs",
  "tracker": "node tools/tracker.mjs", "dev": "node tools/dev-server.mjs", "publish:site": "node tools/publish.mjs",
  "keygen": "node tools/keygen.mjs", "pin": "node tools/pin.mjs", "seed": "node tools/seed.mjs", "demo": "node tools/demo.mjs" }
```
`build.mjs` outputs to `dist/` exactly: `index.html`, `404.html`, `boot.js`, `loader.js`(+map), `sw.js`, `sdk.js`,
`pow-worker.js`, `webtorrent.min.js`, `manifest.webmanifest`, `icons/icon.svg`. `index.html` source lives at
`src/loader/index.html` and is owned by the loader-app agent; build.mjs only injects SRI + version strings into it.

## Ownership (write only inside your paths; others are read-only for you)
- chain-core:  src/chain/{canonical,crypto,pow,pow-worker,pow-client,block,dag,state}.js, test/unit/chain-core*.test.mjs
- chain-net:   src/chain/{gossip,wire-ext,stores,node}.js, test/unit/chain-net*.test.mjs
- loader-common: src/common/*, src/loader/{doh,cache,blob-chunk-store}.js, test/unit/common*.test.mjs, test/unit/loader-common*.test.mjs
- loader-app:  src/loader/{index.html,boot.js,app.js,config.js,torrent.js,policy.js,render.js,bridge.js,ui.js,ui.css}, test/unit/loader-app*.test.mjs
- sw-sdk:      src/sw/*, src/sdk/*, test/unit/sw*.test.mjs
- tools:       tools/*, build.mjs, package.json (scripts only), test/unit/tools*.test.mjs
- example:     examples/peer-guestbook/*
- integration: test/e2e/*, docs/DEVIATIONS.md (merged), any file, after all others finish
Each agent writes its notes to docs/deviations/<agent>.md (create; never edit others').
