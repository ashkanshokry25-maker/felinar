# magnet-web — Architecture Specification (v0.1, 2026-10-14)

Status: DESIGN FROZEN FOR BUILD unless a line is marked `[RESEARCH-PENDING]`.
Audience: the engineers (agents) implementing modules in parallel. Every module boundary
below is a contract. If you must deviate, write the deviation into `docs/DEVIATIONS.md`.

## 0. One-paragraph summary

A static **loader** (HTML + JS + Service Worker) is served once from any static host. The loader
(1) resolves a **pointer** for the current site (magnet infohash + options) from the URL fragment,
a `<meta>` tag, a **DNS TXT record read over DNS-over-HTTPS**, or its own cache; (2) downloads the
site's files **by magnet link over WebTorrent** (WebRTC) from other visitors and/or an HTTP web
seed; (3) stores the files in IndexedDB and **renders the site at the same origin through a
Service Worker** inside a full-screen iframe while the loader page stays alive to **seed**; and
(4) runs a **chain node**: a per-site, signed, hash-linked, replicated append-only log gossiped to
the same WebTorrent peers over a BitTorrent protocol extension, persisted in IndexedDB, exposed to
the site through a small SDK. There is **no backend of ours**. Third-party commodity pieces we do
depend on and must be honest about: a static host (first visit only), WebSocket trackers for
WebRTC signalling, public STUN servers, a DoH resolver when DNS pointers are used, and (strongly
recommended) an HTTP web seed so the site is reachable when no visitor is online.

## 1. Facts established from source (webtorrent@3.0.21, verified 2026-10-14)

- `node_modules/webtorrent/dist/webtorrent.min.js` is an **ES module** (`export { i as default }`),
  223 KB minified. Load with `<script type="module">` / `import WebTorrent from './webtorrent.min.js'`.
  It is NOT a UMD global.
- Browser peers connect only over WebRTC; peer discovery only via WebSocket trackers
  (`tracker: { announce: [...], rtcConfig }` client option). `dht`, `lsd`, `utPex`, `utp`, TCP are
  Node-only / excluded in the browser build. One announce carries at most **5 offers**
  (`numwant` capped to 5 in `websocket-tracker.js`), offers time out after 50 s, tracker
  reconnect backoff 10 s → 1 h. bittorrent-tracker server default interval is 10 min
  (`interval` option; the ws response interval is `intervalMs/5`).
- Default browser chunk store is `fsa-chunk-store` (OPFS) when
  `navigator.storage.getDirectory` AND `FileSystemFileHandle.prototype.createWritable` exist,
  otherwise `memory-chunk-store`. **fsa-chunk-store deletes its `chunks` directory on every
  page load** (module top-level `removeEntry('chunks')`), so it is NOT a persistence mechanism.
  Persistence is ours (IndexedDB, §6).
- Custom store: `client.add(torrentId, { preloadedStore, skipVerify: true })` seeds immediately from
  an object implementing abstract-chunk-store (`chunkLength`, `put(i, buf, cb)`,
  `get(i, {offset,length}, cb)`, `close(cb)`, `destroy(cb)`).
- File API in browser: `file.arrayBuffer()`, `file.blob()`, `file.stream()`, `file.type` (mime),
  `file.path` (includes the torrent name as first segment for multi-file torrents), `file.length`.
- Wire extensions: `torrent.on('wire', wire => wire.use(Ext))` where `Ext` is a class with
  `Ext.prototype.name = 'mw_chain'`, constructor `(wire)`, optional
  `onHandshake(infoHash, peerId, extensions)`, `onExtendedHandshake(hs)` (peer supports us iff
  `hs.m && hs.m.mw_chain`), `onMessage(buf: Uint8Array)`. Send with
  `wire.extended('mw_chain', uint8array)`. **Register the listener synchronously on the
  `Torrent` object returned by `client.add()`** — the ready/metadata callback fires after the
  first wire exists, and that wire would be missed (observed in the spike). Also iterate
  `torrent.wires` at attach time. `wire.type === 'webrtc' | 'webSeed'`; `wire.peerId` hex.
- Web seeds (BEP 19) work in the browser via `fetch` + `Range`. For a **multi-file torrent the
  request URL is `<ws base>/<file.path>`** where `file.path` starts with the torrent name
  (`webconn.js`). So the web seed base must be a directory that contains `<torrent name>/...`.
  The HTTP host must send CORS: `Access-Control-Allow-Origin: *`, allow header `Range`, expose
  `Content-Range, Content-Length, Accept-Ranges`.
- `create-torrent` info dict = `{ name, 'piece length', pieces, files|length, private? }`;
  `creation date`, `created by`, `comment`, `announce(-list)`, `url-list` are outside `info`
  and do not change the infohash. Same files + same name + same piece length ⇒ same infohash.
- Headless Chromium needs `--disable-features=WebRtcHideLocalIpsWithMdns` for two tabs on one
  machine to connect (mDNS candidates do not resolve headless). Spike: 3-file site transferred
  tab→tab in ~170 ms, 5/5 runs; SW served the files from IndexedDB into an iframe with CSS and
  JS working.

## 2. Goals and non-goals

Goals
- G1 Load a static website by magnet link, in the browser, no plugin.
- G2 Render it at its own origin (per-domain mode) with correct relative URLs, MIME types, deep links.
- G3 Visitors seed while the tab is visible, within explicit bandwidth/data/battery policy.
- G4 Per-site replicated signed log ("chain") as the site's database; every visitor is a node.
- G5 Pointer discovery: URL fragment, `<meta>`, DNS TXT via DoH, cache (offline).
- G6 Desktop and mobile browsers (Chrome, Edge, Firefox, Safari, iOS Safari, Android Chrome,
  Samsung Internet, Brave). Graceful degradation, precise error messages.
- G7 No backend of ours. Everything we depend on must be replaceable commodity infrastructure.

Non-goals (v1)
- Anonymity or hiding visitor IPs from each other (WebRTC exposes them; we disclose it).
- Global consensus / finality / tokens. The chain is a signed Merkle-DAG with deterministic
  ordering, not a proof-of-work ledger (see `docs/CRITIQUE.md` for why).
- Streaming large media before download completes; sites larger than the configured cap.
- Dynamic server-side logic. Sites are static files + chain data.

## 3. Modes, URLs, origins

Per-domain mode (primary): `https://example.com/` serves the loader (static host). The
pointer is resolved for `location.hostname`. The site is the owner's own site, so it runs at the
domain's origin inside a same-origin iframe. Deep link `https://example.com/about.html` works
because the static host returns the shell for unknown paths (SPA fallback) and the shell mounts
the iframe at that path.

Hub mode: `https://hub.example/#magnet:?xt=urn:btih:<hex>...`, `#btih:<hex>`, or
`#host:example.com` (resolve another domain's TXT record). Many unrelated sites share the hub
origin, so hub mode shows an "untrusted content" banner and uses a stricter iframe sandbox
(§7). Hub operators who want real isolation serve wildcard subdomains: the loader detects a
hostname matching `^[0-9a-f]{40}\.` and treats it as per-domain mode with pointer `btih` taken
from the hostname (documented in DEPLOY.md; needs a wildcard certificate, i.e. CloudFront+ACM
or Cloudflare).

Reserved paths on every loader origin (never used by sites):
- `/_mw/s/<btih>/<path>`  site files served by the SW from IndexedDB
- `/_mw/sdk.js`           the site-facing SDK, served by the SW from Cache Storage
- `/_mw/*`                reserved
Shell assets at root: `/index.html`, `/loader.js`, `/sw.js`, `/sdk.js`, `/pow-worker.js`,
`/webtorrent.min.js`, `/manifest.webmanifest`, `/icons/*`, `/404.html` (= copy of index.html
for GitHub Pages).

## 4. Pointer record

Grammar (one string; whitespace around `;` ignored; keys case-insensitive; unknown keys ignored):

    v=mw1; btih=<40 lowercase hex>; dn=<name, URL-encoded>; ws=<url>; tr=<url>; tr=<url>;
    chain=<chain id>; max=<bytes>; owner=<b64url raw P-256 public key, 65 bytes>; seq=<uint>;
    exp=<unix seconds>; sig=<b64url ECDSA-P256-SHA256 r||s 64 bytes>

- Also accepted: a bare `magnet:?xt=urn:btih:...` (unsigned, `v` absent). `btih` may be base32
  in a magnet (`magnet.js` normalises to hex).
- Signature input (UTF-8): the record's `key=value` pairs **excluding `sig`**, each
  `key=value` with the value exactly as it appears, sorted by key then value, joined by `\n`,
  then `\n` + `scope`, where `scope` is the lowercase hostname the record is published for
  (per-domain / `#host:`), or the string `btih:<hex>` in hub-by-magnet mode. Binding the scope
  prevents replaying one domain's record on another.
- Validity: `exp` (if present) must be in the future (clock skew tolerance 24 h). `seq` is
  monotonic per scope; the resolver refuses a signed record with `seq` lower than the cached
  one for the same owner key (rollback protection).
- Chain id default: per-domain → `host:<hostname>`; hub-by-magnet → `btih:<hex>`. `chain=`
  overrides so that a site can keep its database across versions and mirrors.
- `max` caps the accepted torrent size (bytes). Loader default caps apply if absent (§8).

Sources, in priority order (first VALID source wins; "valid" = parses, not expired, and if a
pinned owner key exists for the scope then signed by it):
1. URL fragment / `?mw=` query (explicit intent, hub mode).
2. `<meta name="mw-pointer" content="...">` in the shell HTML (deploy-time, same-origin).
3. DNS TXT at `_magnet.<hostname>` via DoH (`doh.js`), queried on two resolvers in parallel
   (Cloudflare `https://cloudflare-dns.com/dns-query?name=&type=TXT` with
   `Accept: application/dns-json`; Google `https://dns.google/resolve?name=&type=TXT`),
   first valid answer wins; if both answer and disagree, prefer the DNSSEC-validated (`AD:true`)
   one, else the higher `seq`, else Cloudflare; surface the disagreement in the UI. `[RESEARCH-PENDING: add Quad9/others if they support CORS JSON]`
   TXT reassembly: concatenate every `"..."` segment of `Answer[].data` (unescape `\"` and `\\`);
   if no quotes, use the raw string. Skip the DoH step for `localhost`, IP literals, `.local`.
4. Cached last-known-good pointer for the scope (IndexedDB) → offline / resolver-down operation.

Owner key TOFU: first signed record seen for a scope pins `owner`. A later record signed by a
different key is NOT accepted silently: UI shows "publisher key changed" with both fingerprints
and a confirm button (stored decision). Unsigned records never override a pinned-signed scope.

## 5. Loader flow (`src/loader/app.js`)

1. `boot.js` (classic script, ES2017 syntax only): feature-detect `ES modules`, `Promise`,
   `indexedDB`, `RTCPeerConnection`, `crypto.subtle`, `BigInt`, `TextEncoder`, `ReadableStream`.
   Missing → render a precise static message (which feature, which browser versions have it).
   Then `import('./loader.js')`.
2. Register `/sw.js` (scope `/`). Do not block on `controller` longer than 3 s; if the SW is
   unavailable (Firefox private window, SW disabled) continue in **degraded render mode** (§7).
3. Resolve pointer (§4). Show which source was used and whether it is signed/pinned.
4. Cache check (`cache.js`): if `sites[btih]` is complete → **render immediately** from IndexedDB,
   then start WebTorrent as a seeder using `BlobChunkStore` + `skipVerify` with the stored
   `.torrent` bytes. Else start WebTorrent as a downloader (magnet with `tr`/`ws` from the
   pointer merged with defaults), show progress (bytes, peers, source: peer/web seed), on
   `done` write every file's Blob + the `torrentFile` + manifest to IndexedDB, then render.
5. Mount the chain node (§6) as soon as the `Torrent` object exists (wires may appear before
   metadata). Expose it to the site through `bridge.js` (§9).
6. Policy (`policy.js`, §8) governs upload limits, connection counts, pause/resume on
   visibility, cellular behaviour, and consent UI.
7. UI (`ui.js`): a 1-line status bar (collapsible, bottom on mobile), progress, peer count,
   chain height, identity short id, source badge, errors with next actions, settings (upload
   on/off, clear cache, owner login, copy magnet, install hint). No framework, no fonts,
   dark/light via `prefers-color-scheme`, mobile first.
8. Lifecycle: `visibilitychange` (pause/resume per policy), `pagehide` (flush chain, destroy
   client), `online/offline`, periodic pointer re-check every 10 min and on `focus` → if a
   new signed `seq` appears, show "Update available — reload".

## 6. Chain ("site ledger") — `src/chain/*`

Purpose: a per-site database that every visitor replicates and verifies. Blockchain-shaped
(hash-linked, signed, self-verifying) but **without** mining consensus: concurrent writes form
a DAG and merge deterministically; no fork is ever orphaned. Properties: tamper-evident,
authenticated authorship, offline-first, eventually consistent, owner-moderated.

### 6.1 Data model
```
Entry e = { v: 1, site: <chain id>, author: <b64url P-256 pubkey>, seq: <uint per author>,
            prev: [<hex sha256> ... up to 8 current DAG heads known to the author],
            ts: <unix ms, informational only>, op: <Op>, nonce: <string, hashcash> }
Block  = { e, h: hex(sha256(canonical(e))), s: b64url(ECDSA-P256-SHA256(author, bytes(h))) }
Op     = { t: 'put', k, v } | { t: 'del', k } | { t: 'append', l, v } | { t: 'profile', name }
       | { t: 'policy', ...Policy }        (owner only)
       | { t: 'tombstone', h }              (owner, or the block's own author)
Policy = { bits: 14, writers: 'open'|'owner'|'allow', allow: [pubkeys], maxValueBytes: 8192,
           rate: { n: 30, perMs: 600000 } }   (defaults shown)
```
- `canonical()` = RFC 8785 (JCS) serialisation: sorted keys, no whitespace, strings escaped per
  JSON, numbers per ES `Number.prototype.toString` (we only allow safe integers), `null`, booleans.
  Reject: non-finite numbers, non-plain objects, `undefined`.
- Limits (`LIMITS`): block ≤ 16 384 bytes canonical; `v`/`value` ≤ `policy.maxValueBytes`;
  `prev` ≤ 8; key ≤ 256 chars; list name ≤ 64 chars; `name` ≤ 48 chars.
- Hashcash: the block hash `h` must have ≥ `policy.bits` leading zero bits (nonce is inside `e`).
  Default 14 bits (~16k SHA-256, sub-second on phones). Mined in a Web Worker (`pow-worker.js`),
  inline in Node.
- Identity: ECDSA P-256 (universal WebCrypto support; Ed25519 is not yet universal). Private key
  non-extractable, stored as a CryptoKey in IndexedDB. Public key exported raw (65 bytes) →
  base64url. Fingerprint for UI = first 8 hex of sha256(pub).

### 6.2 Validation at ingest (`block.js` + `node.js`)
Structural (shape, limits) → `h` recomputes → PoW → signature → policy (`writers`, owner-only
ops) → rate limit per author (sliding window by local receipt time; not part of state so
determinism is preserved) → dedupe by `h` → `dag.add`. Rejected blocks are dropped with a
reason counter (shown in UI debug panel). Orphans (unknown `prev`) are held in a bounded
orphan pool (≤ 2 000) and their parents requested.

### 6.3 Deterministic ordering (`dag.js`)
`depth(b) = 0` for roots, else `1 + max(depth(p) for p in prev)`. Total order = Kahn's algorithm
over `prev` edges where, among all ready blocks, the next emitted is the minimum by
`(depth, h)`. Causal order is respected; the tie-break is content-addressed, so every node with
the same block set computes the same order (property-tested with shuffled insertions).
`ts` and claimed counters never influence ordering (prevents "future timestamp wins" games).

### 6.4 State (`state.js`)
`reduce(orderedBlocks, { ownerPub })` → `{ kv: Map, lists: Map<name, Item[]>, profiles,
policy, tombstoned: Set, height, authors: Set }` where `Item = { h, author, ts, v }`.
Semantics: `put` is last-writer-wins in the total order; `del` removes; `append` pushes;
`policy` applies from that point in the order (only if `author === ownerPub`); `tombstone`
removes the effect of block `h` (if by owner, or by `h`'s author) and the loader drops the
payload from storage while keeping `{h, prevs}` so the DAG stays connected. `writers:'owner'`
makes non-owner ops no-ops from that point on (they are still stored, so later policy changes
can't be gamed by re-ordering). The reducer is pure and incremental-friendly (v1 may recompute
fully; must stay < 50 ms for 5 000 blocks on a laptop).

### 6.5 Gossip (`gossip.js`, transport-agnostic) and wire adapter (`wire-ext.js`)
Frames: `byte0 = type` (1 HELLO, 2 WANT, 3 BLOCKS, 4 ANN), remainder UTF-8 JSON. Every frame
≤ 16 KiB (batching splits `BLOCKS`). HELLO `{site, heads, n}` on attach, every 30 s, and
250 ms-coalesced after local head changes. On HELLO with unknown heads → WANT `{h:[≤64]}`.
On WANT → BLOCKS for the hashes we have. On BLOCKS/ANN → validate+add; for each orphan, WANT
its missing `prev` (bounded, deduped, 10 s re-request). Peers that send > 64 KiB/s sustained or
> 50 invalid blocks are ignored for the session. The adapter attaches to every WebTorrent wire
whose extended handshake advertises `mw_chain`; it detaches on `wire.on('close')`.
`site` mismatch → ignore peer (same swarm can host several chain ids only by design choice; we
keep one chain per site).

### 6.6 Persistence (`idb-store.js`)
Database `mw-chain-<chain id>`: store `blocks` (key `h`), `meta` (heads, height). Startup loads
all blocks (cap 50 000; above it the UI warns and v2 snapshotting applies). Tombstoned payloads
are replaced by `{e:{...e, op:{t:'tombstoned'}}}` with the original `h` kept (hash will no
longer recompute → mark `verified:false, tombstoned:true`; such blocks are trusted from local
storage only and re-fetched from peers never).
Export/import: JSON array of blocks (UI buttons; also used by `tools/pin.mjs`).

### 6.7 Node API (`node.js`) used by `bridge.js` and tests
```
const node = await ChainNode.open({ siteId, ownerPub, bits, storage, identity, now })
node.state            // current reduced state (read-only snapshot object)
node.height, node.peers, node.identity.pub
await node.put(k, v) / del(k) / append(l, v) / profile(name) / policy(p) / tombstone(h)
node.subscribe(fn)    // fn(stateSnapshot, { reason })  → unsubscribe()
node.attachWire(wire) // used by torrent.js on 'wire'
node.ingest(blocks)   // used by gossip + import
await node.close()
```
Node and browser share all chain code; only `storage` (IDB vs memory) and `pow` (worker vs
inline) are injected.

## 7. Rendering — `src/sw/sw.js`, `src/loader/render.js`

Service Worker:
- Install: precache shell assets listed in a build-time `PRECACHE` array with `BUILD_ID` in the
  cache name; `skipWaiting`; activate → delete old caches, `clients.claim()`.
- Fetch routing (same-origin only):
  - `/_mw/s/<btih>/<path>`: look up `files` store key `<btih>/<path>` in IndexedDB (`mw-sites`
    DB, shared schema in `cache.js`; the SW has its own minimal IDB helper). Directory requests
    (`/` or no extension and no file) → `<path>/index.html`. Missing → site's `404.html` if
    present else a JSON 404. Response headers: `Content-Type` from a 50-entry extension map
    (`text/html; charset=utf-8`, `text/css`, `text/javascript`, `application/json`,
    `application/wasm`, images, fonts, `application/manifest+json`, …), `X-Content-Type-Options:
    nosniff`, `Accept-Ranges: bytes`, `Cache-Control: no-store`. `Range` honoured by Blob
    slicing (206 + `Content-Range`). In hub mode (flag stored in `meta`), add
    `Content-Security-Policy: sandbox allow-scripts allow-forms allow-same-origin allow-popups
    allow-modals` and `Referrer-Policy: no-referrer`.
  - `/_mw/sdk.js` → precached `/sdk.js` with `Content-Type: text/javascript`.
  - Navigation requests (`request.mode === 'navigate'`) for any path not under `/_mw/` → network
    first (3 s timeout) then precached `/index.html` (offline reload works).
  - Other shell assets → cache first, revalidate in background.
- Never touch cross-origin requests.

Renderer (`render.js`):
- Creates one full-viewport `<iframe>` with `src=/_mw/s/<btih>/<entry>` where `entry` is the
  top-level path (deep link) or `index.html`; `allow="fullscreen; clipboard-write"`;
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals
  allow-downloads allow-top-navigation-by-user-activation"` (hub mode: same minus
  `allow-downloads`, plus the CSP sandbox header above). `referrerpolicy="no-referrer"`.
- Mirrors the iframe's path into the top URL with `history.replaceState` on each iframe `load`
  (strip the `/_mw/s/<btih>` prefix); handles `popstate` by setting the iframe location.
- Degraded mode (no SW): rewrite the entry HTML's `src`/`href` attributes and CSS `url()` that
  resolve to files present in the torrent into `blob:` URLs (one pass, DOMParser), inject
  `<base>` and render via `iframe.srcdoc`; show a "limited mode" badge. Relative fetches made
  by the site's JS will not work in this mode; documented.
- Applies `document.title` from the iframe when same-origin.

## 8. Policy — `src/loader/policy.js`

Detection: `isMobile = matchMedia('(pointer: coarse)').matches || /Mobi|Android/i.test(UA)`;
`conn = navigator.connection` (Android/Chromium only): `saveData`, `type === 'cellular'`,
`effectiveType`.

| Setting | Desktop | Mobile Wi‑Fi | Cellular / saveData |
|---|---|---|---|
| maxConns | 30 | 10 | 6 |
| uploadLimit (bytes/s) | 1 048 576 | 262 144 | 0 (download only) |
| maxSiteBytes default | 128 MiB | 48 MiB | 24 MiB |
| seed when hidden | yes, up to 10 min then pause | pause after 30 s | pause immediately |
| chain gossip when hidden | yes | yes (cheap) | yes |

All overridable by the visitor in Settings (stored per origin); the pointer's `max=` lowers
(never raises) `maxSiteBytes`. "Pause" = `torrent.pause()` + `client.throttleUpload(0)`; on
resume, un-pause and re-announce. Consent: first run shows a persistent one-line notice:
"Delivered peer-to-peer. While this tab is open your browser shares this site's files with other
visitors and they can see your IP address. Settings". Dismissal is stored. In Settings the
visitor can turn uploads off completely (then the loader still downloads via peers/web seed).

## 9. SDK — `src/sdk/sdk.js` (served at `/_mw/sdk.js`) and `src/loader/bridge.js`

The site includes `<script type="module" src="/_mw/sdk.js"></script>` (or imports it). It
communicates with the host page through a `MessageChannel` established with
`window.parent.postMessage({ mw: 'hello' }, location.origin, [port])`; the host accepts only
events where `event.source === iframe.contentWindow && event.origin === location.origin`.
Requests are `{ id, method, params }`, responses `{ id, ok, result | error }`, push events
`{ event, data }`.

```
import mw from '/_mw/sdk.js'        // also window.mw
await mw.ready()                      // → { siteId, btih, mode, identity: { pub, short, name }, peers, height, owner: bool }
mw.db.get(key) → value | undefined     mw.db.set(key, value)     mw.db.del(key)
mw.db.list(name, { limit = 100, newestFirst = true }) → Item[]   mw.db.append(name, value) → { h }
mw.db.subscribe(fn)  → unsubscribe     // fn(snapshot: { height, peers, kv: object, lists: object, profiles })
mw.db.tombstone(h)                    // own blocks; owner: any
mw.identity.setName(name)
mw.net.peers() → number                mw.net.on('peers'|'progress'|'status', fn)
mw.owner.isOwner → bool                mw.owner.policy(partial)
mw.site.info() → { name, files: [{path, length}], btih, source: 'peers'|'webseed'|'cache' }
```
All values are plain JSON ≤ `policy.maxValueBytes`. Errors are `{ code, message }` with codes
`E_POLICY`, `E_LIMIT`, `E_RATE`, `E_NOT_OWNER`, `E_POW_ABORTED`, `E_IDENTITY`.

## 10. Tooling — `tools/*.mjs` (Node ≥ 22)

- `keygen.mjs [--out owner.jwk]` → extractable P-256 key pair as JWK (private) + prints `owner=`.
- `publish.mjs <dir> --name <n> [--ws <base url>] [--tr <wss>]... [--key owner.jwk]
  [--scope <hostname>] [--chain <id>] [--exp <days>] [--seq <n>] [--out <dir>]`
  → `site.torrent`, `magnet.txt`, `pointer.txt` (full record), `dns.txt` (TXT value split into
  ≤ 255-byte quoted strings + ready-to-paste Route53 JSON and Cloudflare/Namecheap instructions),
  `meta.html` (`<meta name="mw-pointer">` line), `webseed-layout.txt` (exact S3 key layout
  `<ws base>/<name>/<path>`), `summary.json`. Deterministic: fixed `pieceLength` (256 KiB),
  files sorted by path, `name` required. Uses `create-torrent` + `parse-torrent`.
- `tracker.mjs [--port 8000]` → WebSocket-only bittorrent-tracker for dev/self-hosting.
- `dev-server.mjs [--port 8080] [--root dist]` → static server with SPA fallback, correct MIME,
  CORS + Range for a local web seed directory (`--webseed <dir>` served at `/ws/`).
- `seed.mjs <site.torrent> <dir>` → Node seeder over WebRTC if `node-datachannel` is installed
  (`optionalDependencies`), otherwise prints how to run `pin.mjs`. `[RESEARCH-PENDING: confirm the
  recommended Node WebRTC shim for webtorrent 3.x]`
- `pin.mjs <url> [--headless]` → keeps the real loader open in Playwright Chromium (a durable
  visitor): the simplest "always-on node" that needs no special code path.
- `build.mjs` → esbuild: `src/loader/boot.js`→`dist/boot.js` (ES2017, IIFE),
  `src/loader/app.js`→`dist/loader.js` (ESM, ES2020, minified, sourcemap), `src/sw/sw.js`→
  `dist/sw.js`, `src/sdk/sdk.js`→`dist/sdk.js`, `src/chain/pow-worker.js`→`dist/pow-worker.js`,
  copy `webtorrent.min.js`, `index.html` (+ SRI hashes for `boot.js`/`loader.js` injected),
  `404.html`, `manifest.webmanifest` (`protocol_handlers: [{protocol:'magnet', url:'/#%s'}]`),
  icons. `BUILD_ID` = sha256 of the bundle contents (first 8 hex), injected into `sw.js`.

## 11. Example site — `examples/peer-guestbook/`

"Peer Guestbook": mobile-first static site (HTML/CSS/JS + one PNG + one JSON to prove binary and
`fetch` serving) using the SDK: live peers count, chain height, your identity + name field,
guestbook (append to list `guestbook`, newest first, 200 max shown), owner notice
(`kv notice`), "how this page reached you" panel (source, bytes from peers vs web seed),
delete-my-post (tombstone). Built into `dist-example/` by `tools/publish.mjs` in the demo
script `npm run demo` (starts tracker + dev server, seeds the example from a seeder page,
prints the hub URL to open in any browser on the LAN; see README).

## 12. Tests

Unit (`node --test test/unit`): canonical JSON (RFC 8785 vectors), crypto sign/verify/export
round-trip, PoW mine/verify at low bits, block create/validate incl. every rejection reason,
DAG order determinism (1 000 shuffles of concurrent DAGs), reducer semantics (LWW, lists,
policy switch, tombstone by owner/author/non-author), gossip sync between two in-memory nodes
with message loss and reordering, magnet/pointer parsing (hex/base32, multi-string TXT quoting
variants, expiry, bad signature, scope mismatch, seq rollback), DoH response parsing with
fixtures, `BlobChunkStore` piece math across file boundaries, SW MIME/range helpers.

E2E (`node test/e2e/run.mjs`, Playwright Chromium with
`--disable-features=WebRtcHideLocalIpsWithMdns`): local tracker + dev server; a seeder page seeds
the built example; (1) loader in hub mode renders the example (heading text, CSS applied,
image loaded, `fetch` of JSON works); (2) second loader tab appends a guestbook entry → appears
in the first within 10 s with equal heights; (3) close the seeder, reload tab 2 → instant render
from cache; a third tab downloads from tab 2 alone (re-seeding works, same infohash); (4) owner
login + tombstone hides the entry in all tabs; (5) `context.setOffline(true)` + reload → shell
and site still render; (6) per-domain simulation: `--host` flag serves the loader with a
`<meta name="mw-pointer">` and `location.hostname` resolution works without DoH.

## 13. Security requirements (summary; full model in CRITIQUE.md)

- Content integrity: infohash (SHA-1, BitTorrent v1) verifies every piece; a third party cannot
  substitute content (second-preimage), only the publisher could craft colliding content —
  a non-threat here. `[RESEARCH-PENDING: hybrid v2 torrents in webtorrent 3.x]`
- Shell integrity: self-hosted `webtorrent.min.js` and bundles with SRI on the shell's script
  tags; immutable versioned assets; `Content-Security-Policy` meta on the shell:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'
  https: wss:; img-src 'self' blob: data:; frame-src 'self'; worker-src 'self' blob:;
  object-src 'none'; base-uri 'none'; form-action 'none'` (dev build adds `ws://127.0.0.1:*
  ws://localhost:*`).
- Bridge: strict `event.source`/`origin` checks, JSON-only payloads, size limits, per-method
  rate limits, no `eval`, no HTML injection (UI uses `textContent`).
- Hub mode isolation: CSP sandbox header + iframe sandbox + banner; wildcard subdomains for
  real isolation.
- Peer DoS: frame size cap 16 KiB, per-peer byte and invalid-block budgets, orphan pool cap,
  block count cap, IDB quota handling (`QuotaExceededError` → UI).
- Pointer trust: owner signature + TOFU pin + seq rollback protection + dual resolver + DNSSEC
  flag surfaced; meta-tag pointer for deployments that do not want a third-party resolver.
- Privacy disclosure (§8), upload opt-out, no analytics, no third-party scripts.

## 14. Deviations and open questions

Write deviations to `docs/DEVIATIONS.md` with the reason. Open `[RESEARCH-PENDING]` items are
resolved by `docs/research/RESEARCH-DIGEST.md`; builders must read the digest's "decisions"
section before finalising `config.js` (tracker list, STUN list, DoH endpoints, limits).
