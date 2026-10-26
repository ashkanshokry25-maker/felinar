# felinar: Architecture Specification v0.2 (2026-10-17), amended to v0.2.1 (2026-10-19)

Status: NORMATIVE for the v0.2 build. Supersedes v0.1 (kept at `docs/review/ARCHITECTURE-v0.1.md`).
**v0.2.1:** the research-derived amendments (`docs/review/DIGEST-AMENDMENTS.md`, with a Status column per item)
are applied in place; every changed rule carries a "v0.2.1" mark naming its item (A1 to F8).
Rationale and acceptance checks for every change live in `docs/review/DESIGN-REVIEW.md` (items 1 to 25,
S1 to S13); this document states the rules, that one explains them. Research behind the facts is in
`docs/research/`. Builders: read this file, then `docs/INTERFACES.md`, then the review items named in
the section you implement. Deviations go to `docs/deviations/<agent>.md` with reasons.

Wording rules for anything user-facing (UI strings, README, docs): see DESIGN-REVIEW §4. In short: the
data layer is the **site ledger** ("a signed, hash-linked log that every visitor copies and verifies. No
mining, no consensus, no finality"); the system has **no backend** (never "serverless", "no servers",
"unstoppable", "censorship-resistant", "fully decentralized"); never claim isolation for a shared-origin
hub; never say "sub-second" for proof-of-work; no em dashes, straight quotes.

## 0. Summary

A static **loader** served from an HTTPS static host (1) resolves a signed **pointer** (torrent infohash,
`.torrent` URL, web seed, trackers, owner key) from a `<meta>` tag, a DNS TXT record read over
DNS-over-HTTPS, the URL fragment, or its cache; (2) fetches the site's files **by magnet/infohash over
WebTorrent** from other visitors and from an HTTP **web seed** on the same static host; (3) serves them at
the site's own origin through a **Service Worker**, in a same-URL iframe (shell mode) or underneath the
host's own HTML pages (drop-in mode for existing sites); (4) keeps the files and seeds them while the page
is open, within a bandwidth and battery policy the visitor controls; and (5) runs a **site ledger** node:
a per-site signed Merkle-DAG log with deterministic ordering, owner moderation and a hashcash fee per
entry, gossiped to the same peers, persisted in IndexedDB, exposed to the site through a small SDK.

What is still needed and must be stated plainly: an HTTPS static host (serves the loader on every visit
and is the trust root; its files are the web seed and keep the site loading when nobody is online),
WebSocket trackers and STUN servers (public or the owner's own), a DNS-over-HTTPS service when pointers
are published in DNS, and, for the ledger, a snapshot file on the host or a pinned node for durability.
The site is reachable with no visitor online **only if the pointer carries `ws=` and `xs=`**.

## 1. Facts established from source and experiments (webtorrent@3.0.21, re-verified 2026-10-17)

- `dist/webtorrent.min.js` is an ES module, 223 KB. It calls `Uint8Array.prototype.toHex()`,
  `.toBase64()` and `Uint8Array.fromHex()` unguarded and uses `BigInt`/`BigInt64Array`; those methods exist
  only in Chrome/Edge 140+, Firefox 133+, Safari 18.2+ → `boot.js` installs polyfills first (§5.1).
- Browser peers speak WebRTC only; discovery only via WebSocket trackers; one announce carries ≤ 5 offers;
  tracker sockets are closed by public trackers after ~125 to 185 s idle and the client reconnects after 10 s
  up to 5 min → **v0.2.1 (B1)**: we keep sockets alive with an offer-free announce (`numwant: 0`) at most
  every 55 s, never a `scrape` (`tracker.openwebtorrent.com` closes the socket on `scrape`), and a
  per-instance fast-reconnect shim brings a dropped socket back in 1 to 2 s instead of the stock backoff (§8).
- `client.maxConns` gates only TCP dials; WebRTC wires are not capped → we cap in the `'wire'` handler.
- `throttleUpload(0)` stalls every outbound byte on every wire (web seeds included); `torrent.pause()`
  only stops new connections → "uploads off" is a **choke lock** (`wire.choke()` on every wire, kept).
- `bittorrent-protocol` `_onMessageLength` buffers any 32-bit length with no cap → remote memory
  exhaustion; the method name survives minification → we wrap it per wire and destroy wires that declare
  > 256 KiB (§13).
- Default browser chunk store `fsa-chunk-store` deletes the OPFS `chunks` directory of every tab on the
  origin when its module loads, and polyfills `createWritable` with a module Worker per write on Safari
  15.2 to 18.1 → never use the default; we pass our own `MemoryChunkStore` and keep file Blobs ourselves.
- `xs=` works: `_getMetadataFromServer()` fetches the `.torrent` over HTTP(S) and checks the infohash;
  web seeds attach only after metadata → cold start from the host needs `xs=` (§4, §5).
- Web seed requests (`lib/webconn.js`) send `Cache-Control` and `user-agent` headers and use
  `AbortSignal.timeout`, so every request is CORS-preflighted → **v0.2.1 (B3)**: the vendored bundle is
  patched at build time to send `Range` only (no preflight; the loader's `probeWebseed` sends the same);
  for multi-file torrents the URL is `<ws base>/<torrent name>/<file path>`; Safari < 16 lacks
  `AbortSignal.timeout` → polyfilled.
- **v0.2.1 (B2)**: the ledger swarm is a bare rendezvous infohash `sha1hex("mw-ledger/1/" + ledgerId)`
  announced with `left: 1` and never seeded (metadata-less wires held 15/15 local, 18/20 live; the
  one-piece anchor torrent connected 0/15 and never paired two seeders on `tracker.openwebtorrent.com`).
- **v0.2.1 (B5)**: `bittorrent-protocol` reads the length prefix signed, so `0x7FFFFFFF` buffers without
  limit and `0x80000000`+ read as keep-alives; we read it unsigned and destroy a wire above 256 KiB before
  buffering, with a periodic `_bufferSize` watchdog above ~512 KiB.
  **v0.2.1 (B3):** `build.mjs` ships the bundle with a hash-asserted string patch (`WEBTORRENT_PATCHES`):
  web-seed requests send only `Range` (the fetch option `cache: 'no-store'` stays; browsers add
  `Cache-Control: no-cache` at the network layer, which is never preflighted), and the `xs=` metadata fetch
  and `.torrent` URLs send no `user-agent`. Chromium 156 and WebKit 27.2 then send no preflight at all
  (measured: 6 of 24 hosts usable before, 13 of 24 after). Every patch point must match exactly once and
  the patched bytes must equal `build.lock.json` `patched.sha256`, or the build fails; `build.json` records
  `patched: true`. Our own bundle replaces the patch later (ROADMAP). **Code review round 1:** two
  more patch points: `opfs-chunks-cleanup` (fsa-chunk-store's import-time
  `navigator.storage.getDirectory().then(d => d.removeEntry('chunks', { recursive: true }))` deleted any OPFS
  `chunks/` directory of the site's own origin on every visit, shell and drop-in) and
  `fsa-createwritable-polyfill` (its guard is false, so `FileSystemFileHandle`, `FileSystemDirectoryHandle`
  and `FileSystemWritableFileStream` of a host page are never replaced). Importing the bundle touches no
  origin storage.
- `create-torrent`: `info = { name, 'piece length', pieces, files|length, private? }`; same files, name and
  piece length ⇒ same infohash; `creation date`, `created by`, `announce`, `url-list` are outside `info`.
- Per-torrent `client.add(id, { private: true })` stops client-level trackers from being appended
  (torrent.js L342-347) without changing the infohash.
  **0.3.0 (IND-11):** the bundle's own third-party defaults (simple-peer's STUN `stun.l.google.com:19302` and
  `global.stun.twilio.com:3478`, create-torrent's announce list with `wss://tracker.btorrent.xyz` and five UDP trackers) stay unused
  only because `src/loader/torrent.js` passes an explicit `rtcConfig` (or `tracker: false`) and `private: true` on every add;
  `test/unit/bundle-defaults.test.mjs` fails when either option leaves the source or the bundle's list of those hosts changes.
- Wire extensions: `torrent.on('wire', w => w.use(Ext))` where `Ext.prototype.name` is set; register
  synchronously on the `Torrent` returned by `client.add()` and also walk `torrent.wires`.
- A sandboxed iframe without `allow-same-origin` is not controlled by the origin's Service Worker (WPT
  29/29 on Chrome 155, Firefox 158, Safari 27, research R04) → no sandbox variant isolates SW-served sites.
- Firefox private windows have Service Workers since Firefox 140; module Service Workers need Firefox
  147+ → `/mw-sw.js` and the PoW worker are classic bundles.
- Headless Chromium needs `--disable-features=WebRtcHideLocalIpsWithMdns` for tab-to-tab WebRTC; the
  loopback spike moved a 3-file site in ~170 ms (a loopback figure, not a network one).
- DoH JSON with CORS: Cloudflare (`cloudflare-dns.com/dns-query`, `Accept: application/dns-json`), dns.sb,
  Google (`dns.google/resolve`, forwards the visitor's /24 unless `edns_client_subnet=0.0.0.0/0`).
  AdGuard and NextDNS send no CORS headers; Quad9's JSON API is retired.
- Live public wss trackers on 2026-10-14: `wss://tracker.webtorrent.dev`, `wss://tracker.openwebtorrent.com`,
  `wss://tracker.novage.com.ua`, `wss://open.ftorrent.com`. `tracker.btorrent.xyz` resolves to 127.0.0.1 and
  `tracker.files.fm:7073` answers 403 without its own Origin. STUN: `stun.cloudflare.com:3478`,
  `global.stun.twilio.com:3478`.

## 2. Goals and non-goals

Goals: G1 load a static site by infohash in the browser, no plugin; G2 render it at its own origin with
unchanged URLs (root-relative links, History routers, `fetch('/x')` all work); G3 visitors seed while the
page is open, within explicit policy and consent; G4 a per-site ledger every visitor replicates and
verifies, with owner moderation; G5 pointer discovery from `<meta>`, DNS/DoH, fragment, cache; G6 desktop
and mobile browsers at the declared floor (§5.1) with precise degradation; G7 no backend of ours; G8
**existing static sites migrate by adding one script tag** (drop-in mode, §3.4).

Non-goals (v1): anonymity; consensus/finality/tokens; streaming media before completion; sites above the
size caps; dynamic server logic; TURN relays; BitTorrent v2.

## 3. Modes, origins, reserved paths

| Mode | Documents from | Other files from | Engine lives | Origin | For |
|---|---|---|---|---|---|
| Shell (per-domain) | torrent, same-URL iframe | torrent | one long-lived shell page | the site's domain | P2P-first sites; returning visitors survive a host outage |
| Drop-in | the static host | torrent (stamped version), else host | one page view | the site's domain | migrating existing static sites |
| Hub, subdomain | torrent | torrent | one long-lived page | `<label>.<hub>` | magnet links from many publishers |
| Hub, shared origin | torrent under `/_mw/s/<btih>/` | torrent | one long-lived page | the hub | one publisher, demos; never claims isolation |

### 3.1 Shell mode (per-domain)
`https://example.com/` serves the shell (`/index.html`); any unknown path returns the shell too (host SPA
fallback). The shell mounts a full-viewport iframe whose `src` is the **top-level URL itself**
(`/about.html` stays `/about.html`): the Service Worker answers top-level document navigations with the
shell and iframe navigations and subresources with the site's files for the origin's current infohash.
`location.pathname` inside the frame equals the address bar; History-API routers, root-relative assets and
`fetch('/data.json')` work unchanged. Host layout: `/index.html`, `/404.html` (copy), `/mw-sw.js` (root,
classic), `/_mw/*` (loader assets, physically present so `/_mw/sdk.js` is a real file without a SW).
Reserved on every loader origin: `/_mw/*`, `/mw-sw.js`, `/ws/*` (dev web seed), `/.mw/*` (inside
torrents: routing manifest and file list). **v0.2.1 (E1):** `publish.mjs` refuses a site file at any of
them, in both modes; the worker answers `GET /_mw/keepalive` itself (D1).

### 3.2 Hub, subdomain (production hubs)
`https://hub.example/#magnet:...` or `#host:example.com` shows the §8 gate, then redirects to
`https://<label>.hub.example/#<pointer>` where **code review round 1**
`label = base32(sha256("mw-label-v1\n" + kind + "\n" + id)).slice(0,32)`, kind `ledger` with the ledger id
for signed pointers and kind `btih` with the 40-hex btih for bare magnets: the two label sets are disjoint
(v0.2's `base32(btih)` shared the 160-bit space of the signed labels, so an unsigned record could name a
signed site's subdomain). A `#host:` link on the hub root waits for the first-run card (C1) before its DoH
lookup, then redirects. On a hub every record arrives by a link, so an unsigned `st=` there is never acted
on (refused as `unsigned-withdrawal`), and a signed withdrawal that arrives by a link deletes the stored
copy only after a click; a copy downloaded while the gate is open is stored only after Load or Host only,
and the gate is skipped only by a stored choice for the origin (never by a stored copy); the hosts of an
unsigned link (`xs=`, `ws=`) are contacted only after the click. On a hostname matching `^[a-z2-7]{32}\.` the
loader runs shell mode with the pointer from the fragment (or cache). Hub operators need a domain they own (no
platform name such as `github.io` gives them a wildcard certificate, and nip.io and sslip.io are not on the Public Suffix
List; a domainless site uses doors and light links, 15.15), a wildcard certificate, and should list the hub suffix on
the Public Suffix List. Identity, ledger database and pins are
keyed by ledger id on every origin. **v0.2.1 (C3, arrival safety):** nothing that arrives by fragment, protocol
handler, share target or paste loads without an explicit click (the gate); `parseFragment` decodes once, only
for an encoded scheme (`#magnet%3A...`, `#v%3Dmw1...` from a handler-built `/#%s`) and the `host:` value, and
leaves a literal magnet or record to its own parser; a site's own anchor (`#section`) is never read as a pointer (`test/unit/loader-app-arrival.test.mjs`: literal and handler-built links, `?mw=`,
`btih:`/`host:`/record forms, trackers with `?key=a&b=c`, encoded `=` and `%`).

### 3.3 Hub, shared origin (demo only)
Sites render under `/_mw/s/<btih>/<path>`; root-relative URLs are documented as unsupported; a top-level
navigation into `/_mw/s/...` gets a 302 to `/#btih:<hex>`. Before any tracker or peer connection a blocking
interstitial shows name, btih, size once known, trackers and publisher fingerprint, with the button "Load
anyway: this site can read and change everything other sites stored on this hub"; nothing auto-loads from
`#magnet:`, `?mw=` or the protocol handler; a permanent banner says "Sites on this hub share one browser
origin and can access each other's data." **v0.2.1 (C4):** no v0.1 `SANDBOX_HUB`/`HUB_CSP` flags remain (a test
asserts it over `src/` and `dist/`); the shared-origin hub exists only as this localhost demo or a
single-publisher mode behind the gate, and no `registerProtocolHandler` call ships.

### 3.4 Drop-in mode (existing static sites)

**3.4.1 What a site adds.** Every HTML page gets
`<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>` (**v0.2.1, D4 tag guards:**
`data-cfasync="false"` before `src` keeps Cloudflare Rocket Loader from rewriting the tag, and
`publish --dropin` reports pages whose tag lacks it; a page that includes the tag twice, even under two
URLs, starts one engine: the second module instance returns the first `window.__mwDropin`). The deploy
pipeline runs
`publish.mjs --dropin <dir>`, which (1) builds a v1 torrent of every non-HTML file (fixed `name`, sorted
paths, 256 KiB pieces, plus `/.mw/files.json` with each file's SHA-256 and `/.mw/site.json`), (2) writes
`/_mw/t/<btih>.torrent`, the runtime under `/_mw/` and `/mw-sw.js`, (3) stamps
`<meta name="mw-pointer" content="...; xs=/_mw/t/<btih>.torrent; ...">` as the first child of `<head>` in
every HTML file, and (4) refuses to run if the site already uses `/_mw/` or `/mw-sw.js`. HTML stays out of
the torrent: a document cannot carry the pointer to a torrent that contains it, and host-served documents
keep the host's redirects, clean URLs, 404s, response headers and SEO exactly as they are. Drop-in delivers
subresources peer-to-peer after the first page view, offline use of pages already visited, and the site
ledger with the SDK. It does not keep the site up for new visitors when the host is down.

**3.4.2 The Service Worker over existing pages.** `/mw-sw.js` is a classic script at the root path (static
hosts cannot send `Service-Worker-Allowed`), served with `Cache-Control: no-cache`, registered with scope
`/` and `updateViaCache: 'none'` after `load`. **v0.2.1 (D4):** after a cold start (no index in memory) a
subresource waits at most 40 ms (`limits.coldStartWaitMs`) for the mode mark and the index, which are read
from Cache Storage and IndexedDB (the client-to-btih map is persisted in `meta.clients`), then passes
through when still unsure; a shell origin (mode mark "shell") waits for the index, because its files exist
only in the torrent. Rules: (a) navigations go to the network untouched; a 200 HTML
response without `no-store` is copied to an LRU-capped Cache Storage for offline use, and its stamped
pointer is read from the first 4 KiB of a `tee()` of the body to map the new client (`resultingClientId`,
falling back to the document URL) to a btih; offline, the cached copy is served. **v0.2.1 (D4):** a document
answered `Cache-Control: no-store` is never kept, and the worker tells its page so in the `mw-map-client`
ack (`doc: { noStore: true }`): that page runs host-only (3.4.6). (b) A same-origin GET
subresource whose client maps to a btih that is complete in IndexedDB and lists the path is served from
IndexedDB after per-file verification (§7.3), honouring `Range`. (c) `/_mw/ws/*` is the web-seed rewrite
(3.4.7), `/_mw/t/*` passes through, the rest of `/_mw/*` comes from the precache. (d) Everything else,
including worker scripts, manifests, non-GET and cross-origin requests, is not touched. The SW never
synthesizes redirects, 404s or headers for the host's URLs.

**3.4.3 The first load is not controlled.** A browser's first page view, and any hard reload, loads
entirely from the host. `/_mw/mw.js` registers the SW after `load` and starts the engine at
`requestIdleCallback`; `clients.claim()` lets that page's later requests use IndexedDB once the copy
exists, and `/_mw/mw.js` posts the page's btih to the SW on `controllerchange`. Drop-in never forces a
reload: the page already works.

**3.4.4 A site with its own Service Worker.** `/_mw/mw.js` calls
`navigator.serviceWorker.getRegistration('/')`; if an active worker's `scriptURL` is not `/mw-sw.js` it does
not register, runs the ledger and seeding without serving, and logs one console line with the recipe: the
site's worker calls `importScripts('/_mw/sw-core.js')` first (a module worker, `register(url, { type: 'module' })`,
where `importScripts()` throws: `import '/_mw/sw-core.js'` as its first statement; code review round 1) and, at
the top of its fetch handler,
`if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))`. `owns()` is synchronous and true
only for rules (b) and (c). `data-mw-sw="off"` on the script tag disables serving entirely.

**3.4.5 Hashed assets and versions.** Each document names its asset version through its stamped btih. The
SW serves a subresource only from that btih, never from "the latest", so one page never mixes versions.
After a deploy, IndexedDB keeps the previous version while any controlled client maps to it, then deletes it
together with cached documents stamped with it (§5.8). The host keeps the previous deploy's files for at
least 7 days; `publish.mjs --dropin` prints this rule and uploads non-HTML files before HTML. A new
version's copy is filled from the host web seed (where the HTTP cache answers the files it holds, after the
stale entries of changed files are refreshed: `refresh.js`) and from peers. **Code review round 1:** it is
not filled from the previous version in IndexedDB (same path and same SHA-256 in `/.mw/files.json`); the
TorrentManager has no way to seed a download with stored files (`docs/deviations/dropin.md` deviation 5),
so that reuse is a ROADMAP item.

**3.4.6 Engine lifetime on multi-page sites.** Every navigation destroys the page and with it the client,
tracker sockets and peer connections (`RTCPeerConnection` exists only in windows). Rules: start the engine
at idle after `load` and announce only after 3 s visible; restore from IndexedDB with `seedFromCache`
without re-hashing (§7.3 verifies pieces on upload); one engine per origin across tabs (§5.9); on `pagehide`
close sockets and peers so pages keep back/forward-cache eligibility, rebuild on `pageshow`; open the ledger
from IndexedDB and catch up with a HELLO/SYNC delta. README states the consequence: drop-in visitors seed
and gossip in page-view-sized bursts; sustained seeding needs shell mode or `pin.mjs`. **v0.2.1 (D4):** a page
the host served with `Cache-Control: no-store` runs host-only (`rules.announceAllowed({ noStore })` is
false: no tracker socket, no peer), because Chromium keeps such a page out of the back/forward cache for
life after any WebSocket or WebRTC use; the HTTP-side fill of the copy still runs. While the copy downloads
through the worker's `/_mw/ws/` rewrite the page sends `mw-keepalive` at most every 20 s (D1).

**3.4.7 The static origin is the web seed.** BEP 19 multi-file URLs are `<ws>/<torrent name>/<path>`, which
cannot address files at the site root without a rewrite rule that GitHub Pages and plain S3 do not have.
The SW provides it: the engine adds the web seed `https://<host>/_mw/ws/`, and the SW answers
`GET /_mw/ws/<name>/<path>` with `Range` by fetching `/<path>` same-origin with `cache: 'force-cache'` and
returning the 206 slice. No CORS is involved. **v0.2.1 (D4):** concurrent requests for one path (and version)
share one host download; an answer with `Cache-Control: no-store` is used but never kept; a file above
`limits.webseedWholeMaxBytes` (32 MiB) is not fetched whole per piece: the `Range` is forwarded to the host
and its 206 passed on (a host that answers 200 falls back to slicing). **Code review round 1:**
the rewrite serves the engine's fetches only: a navigation, or a document, frame, worker or manifest load
of `/_mw/ws/...` is not taken by the SW (the host answers it, normally 404); a request is answered only when
its client is mapped to a version (`mw-map-client`, which the engine sends before its first web-seed request)
and that version's torrent (the stored copy's, or else the host's `/_mw/t/<btih>.torrent`, whose infohash
must match) lists the torrent name and the decoded path, otherwise 404 and the host is never asked;
BEP 47 pad files are answered with zeros; every answer is `application/octet-stream` with
`X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and
`Cross-Origin-Resource-Policy: same-origin`, so no host page renders through the rewrite without its own
headers. Egress rule: this web seed is added only on unmetered networks
at idle, to complete the copy for seeding and offline use, within `maxSiteBytes`; on cellular or saveData
the copy fills from peers only. Without our SW there is no web seed, only peers.

**3.4.8 The static origin is also the crawler and no-JS fallback.** Every file stays a plain static file at
its URL, so crawlers, link unfurlers, no-JS clients, Lockdown Mode, in-app WebViews and any engine failure
see today's site. Drop-in fails open. Shell mode, by contrast, answers every URL with the shell, so crawlers
that do not run the loader see no content; DEPLOY.md says so and shell deployments keep `robots.txt` and
Open Graph fallbacks on the host.

**3.4.9 Trust, SDK, consent, CSP.** The engine runs in the site's own origin. `window.mw` is the §9 API
bound directly to the engine (no Bridge); `/_mw/sdk.js` re-exports it, so a site moving between drop-in and
shell keeps its code. The consent notice (§8) renders in a closed shadow root before the first announce.
**v0.2.1 (C1):** it is the first-run card with the shell's strings and a same-layer refusal, [Share and load]
[Load from host only] [Settings] (`panel.showConsentCard`); `consent=gate`, or an `aud=` gate token (§4: personal
data, an EEA, UK or Quebec audience, kids or sensitive content), shows the gate instead; the choice is the versioned per-origin record of §8
(prefs key `consent`, read with this pointer's recipients), so a v0.2 choice is asked again. The rules are
shared with the shell (`src/loader/consent.js`). **v0.2.1 (A4):** the panel's Settings carries Export / Import
identity (passphrase-wrapped, the shell's file format), the only way the SDK and the runtime let an identity
leave or enter a drop-in origin.
**v0.2.1 (A4):** with `data-mw-consent="site"` the site explains sharing itself and calls
`mw.consent.request()`, which opens the same loader-owned card; the visitor decides there. The SDK cannot
accept for the visitor (there is no `mw.consent.accept()`), and the panel ignores events a script made
(`event.isTrusted === false`). **Code review round 1:** `window.__mwDropin` is a frozen handle
`{ version, started, inspect(), openSettings(), rectOf(label) }`; it used to carry the engine, through which
any page script could accept consent or export the identity. **Scope of these guarantees:** they stop a site's
own code from doing either *by accident through the API*, not a hostile script: code in the site's origin
(the site's, or a third-party script it includes) shares its IndexedDB, so it can read the stored identity key
and write the consent record. Site code is trusted with the per-site identity and storage, as it is with
signing. Sites with a CSP must allow `worker-src 'self'`,
`connect-src` for the tracker `wss:` URLs and, with DNS pointers, the DoH endpoints; `publish.mjs --dropin`
prints the exact additions. **v0.2.1 (D4):** the drop-in script never inserts a CSP `<meta>` (a script-inserted
policy would restrict the host page at once; the host's CSP is the host's, and §5.1 step 6 is shell-only);
`publish --dropin` prints the measured set (`script-src` with a nonce or the tag's integrity hash for
`strict-dynamic` sites, `worker-src 'self'`, `connect-src` trackers and DoH) and says that STUN/TURN hosts,
`blob:`, `data:`, `'unsafe-inline'` and `'unsafe-eval'` are not needed. **F7:** the drop-in panel's host element
is created with `data-nosnippet` (the shell's `#mw-bar` carries it in static HTML), so search engines never
quote loader text as page content.

## 4. Pointer record v1

Grammar: split on `;`, trim each part, split at the first `=`, lowercase the key, keep the value verbatim.
`publish.mjs` percent-encodes values containing `;`, `=`, newline or non-ASCII; only `dn` and `why` are
decoded for display. Repeatable keys: `tr`, `ws`, `xs`. Unknown keys are kept (and signed).

    v=mw1; st=ok|withdrawn; btih=<40 lowercase hex>; dn=<name>; xs=<https URL of the .torrent>;
    ws=<web seed base URL>; tr=<wss URL>; chain=<label>; max=<bytes>; owner=p256:<b64url raw P-256 public
    key, 65 bytes>; gen=<hex h of the genesis policy block>; rot=<b64url signature by the previous owner>;
    cs=<https URL of a ledger snapshot>; consent=notice|gate; aud=<token>[,<token>...]; ct=<https or
    mailto contact>; lg=<https URL of the privacy and terms page>; why=<reason shown on a withdrawal>;
    seq=<uint>; exp=<unix seconds>; sig=<b64url ECDSA-P256-SHA256, raw r||s>

**v0.2.1 (DIGEST-AMENDMENTS A2, A3).** The grammar is a stated profile, **MW-PTR/1**: an RFC 6376
tag-list with three stated deviations (keys are case-folded, `tr`/`ws`/`xs` repeat, unknown keys are kept
and signed); `v=mw1` is written first; a record split over several DNS character-strings is joined with
no separator (`splitTxt`, `joinTxtData`). Size budget: a record SHOULD stay at or under 450 bytes and MUST
stay at or under 900 bytes (pkarr-compatible); a realistic signed record is about 520 to 540 bytes and
spans 3 TXT strings, so `publish.mjs` warns above 450 and refuses above 900.
- `owner=` (and every key a record or block carries) is **algorithm-tagged**: `p256:` + the base64url of
  the 65-byte point. Untagged keys are refused (`bad-owner`); an unknown tag is "unsupported key type".
- `st=` is **fail-closed**: absent or `ok` is active; any other value, an unknown one included, means
  **withdrawn**. A valid withdrawal (signed by the pinned owner or with a valid `rot`, `seq` above the
  cached record) makes the loader stop serving and seeding the scope, delete **every** stored version
  (not "keep the previous one", §5.8) and show the owner's `why=` text. `publish.mjs --withdraw` writes
  `v=mw1; st=withdrawn; btih=<40 zeros>; owner=...; [ct=...;] [why=...;] seq; exp; sig` (the zero
  infohash leaves loaders that predate `st` nothing to fetch); a withdrawal may omit `btih` and is then
  read as 40 zeros. `verifyPointer` reports a valid withdrawal as `{ ok: true, withdrawn: true }`, never as
  a failure, because a caller that fell back to the cache would keep serving the withdrawn site.
- `aud=` (the declared audience, a comma-separated token list), `ct=` (abuse and legal contact) and `lg=`
  (privacy and terms page) are parsed fields; like every key they are signed. **The `aud=` token table (code
  review round 1, one table for the docs, `config.consent.gateAudiences`, `consent.js` and `pointer.js`):**
  `general` is a content class with no effect on consent; `kids` and `sensitive` (content classes) and
  `personal`, `eea`, `eu`, `uk`, `qc`, `quebec` (personal data, or an EEA, UK or Quebec audience) make the
  consent gate the default (§8). `publish` refuses other tokens; the loader ignores them.
- Golden vectors for MW-PTR/1 are in `test/vectors/pointer.json` (append only, §12).

- Also accepted: a bare `magnet:?xt=urn:btih:...` (unsigned; `tr`, `ws`, `xs`, `dn` taken from it).
- Signing input (UTF-8): `"mw-pointer-v1\n"` + every pair except `sig` as `key=value` (value verbatim, as
  parsed), sorted by key then by value, joined by `\n`, then `"\n" + scope`. `scope` = lowercase A-label
  hostname (`new URL(...).hostname`) for per-domain and `#host:` records, `btih:<hex>` for hub-by-magnet.
- Signed records **require** `seq` and `exp`; `exp - now ≤ 400 days` (publish default 90 days; UI warns the
  owner at 14 days left; **Code review round 1:** verifiers allow one day of clock skew on top, and the tools sign at most
  399 days, the withdrawal default included, so a visitor whose clock lags never refuses a fresh record).
  `seq` is monotonic per scope; a lower `seq` than the cached record for the scope is refused.
  **Code review round 1:** a fresh record whose `seq` is more than a day ahead of the verifier's
  clock (in seconds) is refused (`seq-future`) and `publish --seq` refuses values later than the clock, so
  one record cannot set a floor nobody can pass; a cached `seq` that far ahead (saved before this rule) is
  ignored as a floor; the owner is judged before the floor, so a new key without `rot` reaches the TOFU
  prompt instead of `seq-rollback`, and a key change the visitor confirms starts a new floor. Expiry applies
  to fresh sources (fragment, meta, DNS); an expired cached record still renders with "Pointer expired on
  <date>; showing the last known version."
- `st=` with an empty value is a withdrawal like any value other than `ok` (code review round 1).
- Several TXT records: the highest valid `seq` wins, ties to the smallest `sig`.
- `rot=` = signature by the previous owner key; **Code review round 1:** over `"mw-rot-v2\n" + <scope> + "\n" + (chain or
  '') + "\n" + <new owner> + "\n" + seq`, so a rotation signed for one site is no rotation for another site
  pinned to the same key (v0.2.1's unbound `"mw-rot-v1\n" + <new owner> + "\n" + seq` still verifies and is
  never written; it is retired before release together with the frozen vector `ptr-010`). With a valid
  `rot` a key change is silent (the shell trusts the record: it pins the new key with `rotatedAt`, and an
  update or a withdrawal applies at once), otherwise the TOFU prompt appears.
- Ledger id: signed → `"mw1:" + b64url(sha256(utf8(ledgerOwner + "|" + (chain || scope)))).slice(0, 27)`
  with **code review round 1** `ledgerOwner` = `lo=` when present, else `owner=`. After a key rotation `publish
  --prev-key` reuses the ledger's genesis and writes `lo=<genesis owner>`, so the ledger id, its database,
  rendezvous swarm and history stay; the owner in effect is checked through `rot=` and the ledger's own
  hand-over (§6.2), and `--prev-key` without the genesis refuses (or `--new-genesis` says the ledger
  restarts). Unsigned → `"btih:" + btih` with no owner and a permanent "unmoderated" badge (`chain` ignored).
- `max` lowers (never raises) the size cap. `consent=gate` forces the gate (§8) in per-domain and drop-in.

Sources and order:
1. URL fragment / `?mw=` (hub modes; shows the gate first, never auto-connects).
2. `<meta name="mw-pointer" content="...">` in the shell or stamped page: **primary bootstrap** for
   per-domain and drop-in.
3. DNS TXT at `_magnet.<hostname>` over DoH: the **update channel**. Sequential resolvers: Cloudflare JSON
   (`Accept: application/dns-json`), then dns.sb, then Google with `edns_client_subnet=0.0.0.0/0`; GET with
   `Accept` only; operator override `<meta name="mw-doh" content="<url template>">`; answers cached per TTL
   (minimum 5 min) and re-checked on that schedule and on `focus`. Skipped for `localhost`, IP literals,
   `.local`, `.localhost`, `.test`, single labels. **v0.2.1 (C1)**: the lookup waits for a consent choice
   that allows it (a stored record with `dns`, or the first-run card); a `<meta>` pointer, a cached pointer or a
   cached DNS answer still resolves without a lookup. "Share and load" (or the gate's "Load") allows it, "Load from
   host only" does not, and both buttons of the blocking card of a DNS-only site do. **Post-wave fix:** the card
   and the gate name the DoH service on every page that will ask it (`dnsHost` not skipped), not only on a
   DNS-only site; an `mw-doh` override's host replaces the default names. With both meta and DNS valid: DNS wins only if signed by
   the pinned owner (or with valid `rot`) and `seq` is higher; otherwise meta. **Code review round 1:** with no pin yet
   (first visit), the page tag's owner is the anchor: a DNS record signed by another key wins only with a
   `rot` valid from that owner, and is never pinned otherwise; the update checks apply the same rule. A
   higher `seq` found after render shows "Update available: reload".
   **v0.3 C2 (built; e2e E-ZS-1):** the skip list also holds `nip.io` and `sslip.io` and every name that ends in `.nip.io` or `.sslip.io` (an
   address-embedding name such as `203-0-113-7.nip.io`), because neither service can carry a `_magnet` TXT record (S2 F2: the
   query answers NOERROR with no data). A site on such a name has its page tag as the only pointer, and that record expires like any
   other (90 days by default, 399 at most, §10 `ship`). `check-site` prints "DNS pointer: not possible for this name (page tag only)"
   and makes no lookup. A name such as `nip.io.example.com` is still looked up. (Before C2 the loader, after consent, and
   `check-site` asked the resolvers for `_magnet.<ip>.nip.io`, S2 F16.)
   **0.3.0 (IND-10, built; unit tests; no e2e row opens a platform name, the first-visit rows 7, W7, F7 and E-ZS-1 pass):** the skip list also holds hosting-platform names where no user can publish a TXT record,
   `NO_TXT_SUFFIXES` in `src/loader/doh.js` (`github.io`, `gitlab.io`, `codeberg.page`, `pages.dev`, `workers.dev`, `netlify.app`,
   `vercel.app`, `surge.sh`, `trycloudflare.com`, `ts.net`, each with every name under it at a dot boundary; `xgithub.io` and
   `github.io.example.com` are still looked up), kept apart from `WILDCARD_DNS_SUFFIXES`, which `tools/name-check.mjs` uses as its name
   services; `dedyn.io` and `duckdns.org` are not on it (their users can set TXT). The consent recipients do not change (they cover
   trackers and STUN only), so no consent version bump. The list is an inference; each zone is checked with `dig` by the owner before
   the release.
4. Cached last-known-good record for the scope.

Owner key TOFU: the first signed record for a scope pins `owner`; a different key without valid `rot`
shows "publisher key changed" with both fingerprints and a confirm button (decision stored); unsigned
records never override a pinned scope. "First time on this device" appears whenever a signed record arrives
with no pin.

## 5. Loader flow

### 5.1 Boot (`/_mw/boot.js`, classic script, ES5 syntax: built at target es5, code review round 1)
Order: (1) insecure context → "This page must be served over HTTPS (or localhost)" and stop; (2)
`window.top !== window` → "Open this page directly" and stop; (3) non-root deployment (shell served from a
sub-path) → stop with the message that `/mw-sw.js` needs the origin root. **Code review round 1:** the shell
names `/_mw/boot.js` with an absolute path, so on a sub-path deployment boot.js 404s and never runs; the
static `#mw-boot` line of `index.html` therefore carries the root-path hint itself (shown after 6 s when
`ui.css` loads, at once when it 404s too; boot.js replaces the line when it runs), and `check-site` reports
"non-root deployment" for a page under a sub-path whose root `/_mw/boot.js` (or `/_mw/mw.js`) is missing; (4) feature checks: dynamic
`import()`, `Promise`, `indexedDB`, `crypto.subtle`, `BigInt`, `TextEncoder`, `ReadableStream`, `fetch`,
`AbortController`, `MessageChannel`; `RTCPeerConnection` is a **soft** check (absent → "Host only, not
sharing" badge, no gossip; Lockdown Mode gets "Turn off Lockdown Mode for this website"); `serviceWorker` is
soft (absent → degraded mode, §7.4); (5) install guarded polyfills: `Uint8Array.prototype.toHex/toBase64`,
`Uint8Array.fromHex/fromBase64` (honouring `alphabet` and `omitPadding`, `SyntaxError` on bad input),
`AbortSignal.timeout`, then self-test them; a failing self-test is reported like a missing feature with the
browser versions that have it; (6) insert the CSP `<meta>` (§13; the degraded variant when degraded); (7)
`import('/_mw/loader.js')` → `start()`. Declared floor: Safari/iOS 15.4, Chromium 110 (Chrome, Edge, Samsung
Internet, Brave, Android WebView), Firefox 115 ESR; recorded in `config.js` and README.

### 5.2 Service Worker
Register `/mw-sw.js` (scope `/`, `updateViaCache: 'none'`). Degrade only when `serviceWorker` is absent or
`register()` rejects; otherwise await `navigator.serviceWorker.ready` with a 15 s cap ("Preparing offline
engine..."). Shell mode: if still uncontrolled after `ready`, reload once (sessionStorage guard) before
mounting. Every SW↔page message carries `proto: 1`; a mismatch after `controllerchange` shows "Reload".

### 5.3 Resolve
§4 (v0.2.1 C1: no DoH lookup before a consent choice that allows it; C3: fragment arrival rules in §3.2). Show the pointer badge ("Pointer: page tag, signed" / "Pointer: DNS via Cloudflare, signed, key
remembered since <date>" / "Pointer: magnet link, unsigned").

### 5.4 Cache, verify, download
If `sites[btih]` is complete: verify `sha1(bencode(info)) === btih` from the stored `.torrent` once per
page, mount (§7) and **render immediately**; per-file piece verification happens before first serve and
before first upload (§7.3). Then start the engine as a seeder (`seedFromCache`).
Otherwise: if the record has `xs`, fetch the `.torrent` (CORS) and `client.add(torrentBytes, ...)`; else
`client.add(magnet, ...)`. Trackers and web seed start together; peers only after consent (§8). Options:
`{ store: MemoryChunkStore, announce: <exact tr list>, private: true, urlList: <ws after the probe> }`. When
metadata arrives enforce `maxSiteBytes` (`E_TOO_LARGE`). Build each file's Blob on `file.on('done')`,
write manifest + Blobs in one IndexedDB transaction when all files are done (no `await` inside), then
mount. `E_NO_PEERS` only when the pointer has neither `xs` nor `ws`; the message is "This link has no web
seed or torrent URL. It only loads while another visitor is online."

### 5.5 Ledger (v0.2.1)
Open `ChainNode` for the ledger id with `expectedOwner` from the pointer (mismatch → "pointer and ledger
owner differ", shown, not re-reduced). Attach gossip to the site torrent's wires and to the **ledger
rendezvous swarm** (B2, replacing the v0.2 anchor torrent; `TorrentManager.addRendezvous`, with `addAnchor`
as a deprecated alias for one release): a bare infohash `sha1hex("mw-ledger/1/" + ledgerId)` added with the
site torrent's exact announce list and `getAnnounceOpts: () => ({ left: 1, numwant: clamp(softCap - wires,
0, 3) })`, never seeded, so visitors of different site versions meet in one swarm; a 0 to 1.5 s join jitter,
a glare watchdog (peers reported but no wire after 20 s → re-announce with jitter, at most 3 times),
`ut_metadata.cancel()` on its wires. On a metered or unconfirmed mobile network, leave the version swarm
once the site is complete and uploads are off; the rendezvous swarm keeps the ledger in sync. If the pointer
has `cs`, fetch the snapshot after render and ingest up to `maxChainBytes`. The site renders before the
ledger syncs; signatures verify in a worker pool.

### 5.6 Mount and SDK
§7 and §9. In shell mode the Bridge connects the iframe to the engine; in drop-in `window.mw` binds
directly.

### 5.7 Policy, consent, lifecycle
§8. Consent before the first announce. Lifecycle: `visibilitychange`, `pagehide`/`pageshow`, `online`,
battery (`navigator.getBattery` where present), `freeze`/`resume`.

### 5.8 Updates and takedown
Re-check the pointer per DNS TTL (min 5 min) and on `focus`. A newer valid record for the scope: show
"Update available: reload"; stop seeding the old btih at once; `deleteSite(old)` when no client maps to it
(drop-in pages may still need lazy chunks); keep at most the current version and the previous one.
**v0.2.1 (A3): a withdrawal** (`verifyPointer` → `ok` and `withdrawn`, §4) keeps **no** version: stop
serving and seeding the scope, `deleteSite` every stored version of it (the previous version may be the one
complained about), keep the withdrawal as the cached record, and show "This content is no longer available
here" with the owner's `why=` text and `ct=` contact when present. Shell: at boot nothing is mounted or
fetched; a withdrawal found by the page-tag check or the DNS re-check while the page is open applies at
once (the torrent client is destroyed, the frame removed), and the next load picks the cached withdrawal
because the stale shell's page tag is a `seq` rollback. Drop-in: the engine goes off (`withdrawn`), deletes
the copies, and the worker neither maps such a page to a stored copy nor keeps it for offline use; the host
keeps serving its own pages. Helpers: `src/common/withdrawal.js`. E2E: `FMT-WITHDRAW`
(`test/e2e/scenarios-formats.mjs`).

**Code review round 1, several tabs:** "stop seeding the old btih at once" holds in every tab: a
tab that finds the update sends `version` on the tab channel, and every tab (the engine tab included) checks
that the scope's stored pointer names that btih, then stops sharing its superseded version and never seeds
it again (not on a later promotion either). The shell keeps a superseded version while the worker reports
a live client rendering it (`mw-get-clients`, as drop-in's `planVersions`) and prunes it after a later render.

### 5.9 One engine per origin
`navigator.locks.request('mw-swarm-' + ledgerId, ...)` elects the engine tab; other tabs receive state and
forward writes over `BroadcastChannel('mw-' + ledgerId)` (Safari 15.4+). Required in drop-in. **Code review round 1:**
a follower that renders a version the engine tab does not hold sends `need-site`; the
engine tab, once the scope's stored pointer confirms that version, downloads and stores it and answers
`site`. A follower that gets nothing within `timeoutsExtra.followerSiteMs` (20 s) downloads the copy itself
(a bounded fallback, logged), instead of waiting for the lock forever. Tab-channel messages are never trusted
by themselves: a `consent` or `version` message is adopted only when the stored record confirms it.

### 5.10 UI (`ui.js`, `ui.css`)
Status bar (bottom on mobile, padded by `env(safe-area-inset-bottom)`; top on desktop), progress, peers,
ledger line ("Ledger: 1,204 entries, in sync with 3 peers"), identity, source badge, pointer badge,
consent notice/gate, Settings (Share with other visitors On/Off; Host only; Share on this network (mobile);
storage usage and "Forget this site"; Export/Import identity; Export ledger JSON; debug panel with the
failure matrix: tracker unreachable / nobody online / N peer connections failed (likely NAT) / no web seed
in the pointer, each with the owner's remedy), error cards with next actions, banners (hub, update
available, pointer expired, key changed, first time on this device). Everything via `textContent`, no
innerHTML with untrusted data, `aria-live` for status, system fonts, dark/light.

## 6. Site ledger: `src/chain/*`

### 6.1 Data model (block v1)
```
e = { v: 1, site: <ledgerId>, author: <p256:b64url P-256 pub>, seq: <uint, informational>,
      prev: [<hex sha256>...] (sorted, unique, ≤ 8; ≥ 1 unless the block is the owner's genesis),
      ts: <unix ms rounded to the minute>, bits: <uint>, op: <Op>, nonce: <string> }
Op (payload):  { t:'put', k, vh } | { t:'append', l, vh } | { t:'profile', vh }
Op (control):  { t:'policy', ...Policy } | { t:'owner', next } | { t:'tombstone', h } | { t:'ban', author }
             | { t:'allow', add: [pub], remove: [pub] }
Op (reserved, v0.2.1): checkpoint, vanish, grp (invalid in v1: 'unknown-op')
Block = { e, h, s, v?, z? }  h = hex(sha256(utf8(canonical(e))))
                             s = b64url(ECDSA-P256-SHA256(author, utf8("mw-block-v1\n" + h)))
vh = hex(sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(v))))  for payload ops (v0.2.1, salted);
     z = 16 random bytes, base64url (22 characters), carried beside v as block.z, present iff v is.
Policy = { writers: 'owner'|'allow'|'open', bits, maxValueBytes, maxChainBytes, moderators: [pub], allow: [pub] }
DEFAULT_POLICY = { writers:'owner', bits:16, maxValueBytes:2048, maxChainBytes: 8 MiB, moderators:[], allow:[] }
LIMITS = { maxBlockBytes: 4096 (canonical(e) + canonical(v) + z), maxPrev: 8, maxKey: 256, maxListName: 64,
           maxName: 48, maxChainBytesCeiling: 64 MiB, maxAllow: 1000, maxModerators: 50 }
```
A block verifies on `h`, PoW and `s`; when `v` is present also the salted `vh` with its `z` and
`byteLength(canonical(v)) ≤ maxValueBytes`. A block without `v` is valid and counts only as a DAG node.
Tombstone = drop `v` **and** `z`, keep `{e, h, s}`. Control ops carry their full content inside `e` and can
never be redacted.

**v0.2.1 (DIGEST-AMENDMENTS A1, A2).** (1) The value hash is salted: an unsalted `vh` of a short value
("yes", a name) lets anyone confirm guesses against a tombstoned stub forever (EDPB Guidelines 02/2025).
`z` is a fresh 128-bit random value per block (never the hashcash nonce), travels only together with `v`
(store, gossip `WANT { h, v: true }` answers, snapshots) and is deleted with it, so the stub `{ e, h, s }`
reveals nothing guessable. `v` without `z`, or `z` without `v`, is `shape`. (2) Every public key in `e`
(author, `owner.next`, `ban.author`, `allow` lists, policy `moderators`/`allow`) is algorithm-tagged:
`p256:` + 87 base64url characters, one canonical spelling; untagged keys are invalid (`shape`/`op`). (3)
Op names: `put`, `append`, `profile` (payload) and `policy`, `owner`, `tombstone`, `ban`, `allow` (control)
are the v1 ops; `checkpoint`, `vanish`, `grp` are reserved for later control ops. **Unknown-op rule:** an
`op.t` v1 does not define, reserved names included, makes the block invalid (`unknown-op`): it is rejected
at ingest, never stored and never relayed, and counts as an invalid block from that peer. (4) Golden
vectors for blocks and the salted hash are in `test/vectors/block.json` (append only, §12). PoW: `leadingZeroBits(h) ≥ e.bits` and `e.bits ≥ max(CONFIG.chain.minBits, governing policy
bits)`; blocks by the owner or a moderator in effect are exempt (`bits` may be 0). Mining uses a
synchronous JS SHA-256 in a worker with progress and cancel; verification uses WebCrypto. The ingress
throttle (per author, local, `rate: {n: 30, perMs: 600000}`) is never part of validity.

Identity: ECDSA P-256; the CryptoKey pair is the whole value of a dedicated `keys` store, keyed by ledger
id; a round-trip self-test (put, get, sign, verify) runs at creation and, on failure (iOS `DataCloneError`),
the private JWK is stored and imported non-extractable per session. Export/Import identity (passphrase-
wrapped, AES-GCM under PBKDF2) in Settings. Fingerprint = first 8 hex of sha256(raw pub).

### 6.2 Owner, roots, succession, moderators
- **code review round 1: a succession is a revocation.** The succession chain `K0 → K1 → ...`
  starts at the genesis author `K0`; the candidates at level m are the `{t:'owner'}` blocks by `Km` (a
  hand-over to oneself is a no-op) that have the chosen succession of level m−1 in their causal past,
  minimal ones only. One candidate is chosen. Several (the key signed two hand-overs: theft, or a sold key
  used again) are never decided by total order: the one **endorsed** by the pointer's owner key
  (`expectedOwner`, the visitor's trust anchor, not already in the chain) wins, endorsed meaning a block
  signed by that key whose causal past holds that hand-over and no other; otherwise the chain stops and the
  ledger reports `ownerConflict` (owner changes paused, UI warning) until the owner endorses one
  (`ledger-admin owner --accept-key`, or `ledger-admin accept --after <h>` later).
  `level(B)` = the number of chosen successions in B's causal past; `ownerAt(B) = K(level(B))`. **Owner
  standing** of B (control ops; the owner's PoW and ban exemptions): `author === ownerAt(B)` and, when a
  succession away from that key was chosen, B is in its causal past (or is it). What the old key signed
  before its hand-over stays valid; anything it signs beside or after it has none (a side-branch
  `policy`, `ban` or second hand-over is a no-op everywhere). Under `ownerConflict` the contested key keeps
  standing only for what precedes every contested hand-over. Only the owner creates roots (`prev: []`):
  `publish.mjs` mints the genesis `policy` block in Node and the pointer carries `gen=<h>`; a non-owner root
  is rejected.
- Control ops are valid only with owner standing; `tombstone` and `ban` are also valid from a moderator in
  effect; `tombstone` is also valid from the target block's author.
- The owner's private key never enters a browser: there is no "owner login". Moderator keys may be imported
  in a browser (Settings → Import moderator key); moderators may `tombstone`, `ban` and write `_`-prefixed
  keys, never `policy` or `owner`. `mw.owner.policy` fails with `E_NOT_OWNER` in browsers.
- HELLO carries `owner`; peers with a different `(site, owner)` are detached.

### 6.3 Validation at ingest (`block.js`, `node.js`)
Shape and limits → `h` recomputes → PoW → signature → `v` matches `vh` (if present) → control-state check
under the control state at the local heads (§6.5; owner standing is the owner at the heads at the last
level of the succession chain, so a key that has handed over has none; blocks WANTed as parents of held
blocks are exempt from this step but still verified, except control blocks signed by a key that has handed
over, outside its hand-over's causal past, which are refused even then; contested hand-overs stay
admissible there so the anchor can decide) → ingress throttle → dedupe → `dag.add`. Rejected blocks are neither stored
nor relayed; reasons are counted for the debug panel. Never cache rate rejections by hash; **code review round 1:**
cap (`E_CAP`) rejections are remembered while the node stays at its cap and forgotten on
any control change or below the cap, so two nodes at the cap with different subsets stop re-fetching each
other's surplus. The solicited allowance (`2 × maxChainBytes + 1 MiB` per peer) counts only blocks that were
added, never blocks of the owner, moderators or allow-listed authors, and a peer whose new heads are all held
or refused keeps its sync back-off.
Beyond `maxChainBytes` only owner, moderator and allow-listed blocks are ingested, and the UI says so.

### 6.4 Deterministic order (`dag.js`)
`depth(b) = 0` for roots, else `1 + max(depth(p) for p in prev)` (iterative, computed on acceptance). Total
order = sort by `(depth, h)`; every `prev` has a strictly smaller depth, so causality is respected and the
tie-break is content-addressed. Orphans wait in a bounded pool (256 per peer, 2 000 total) and are retried
when parents arrive. Depth windows of 64 levels have digests `dg(k) = hex(sha256(concat(sorted hashes in
window k as bytes)))` with counts, used by SYNC (§6.6).

### 6.5 State (`state.js`)
Two passes over the total order. Pass 1 collects control blocks whose author is valid (§6.2) and memoises
each one's ancestor set. Pass 2 reduces: for each block B, `controlFor(B)` = fold, in total order, of the
control blocks C with `B ∉ ancestors(C)` (this is how a tightening governs concurrent and later writes and
how a later `ban` or `tombstone` reaches a block). A payload block takes effect only if, under
`controlFor(B)`: the author is the owner/moderator, or `writers === 'open'`, or `writers === 'allow'` and
the author is in the allow set; the author is not banned; `_`-prefixed keys are owner/moderator-only; the
block is not tombstoned; and `e.bits` meets the governing `bits` (non-owner). `put` is last-writer-wins
in total order; `append` pushes `Item = { h, author, ts, v }`; `profile` sets the author's name. Output:
`{ kv, lists, profiles, owner, policy (current control state: writers, bits, limits, moderators, allow,
banned), tombstoned, height, bytes, authors }`. Under 50 ms for 5 000 blocks on a laptop.

### 6.6 Gossip (`gossip.js`, transport-agnostic) and wire adapter (`wire-ext.js`)
Extension name `mw_chain1`. Frames: `byte0 = type`, remainder UTF-8 JSON, ≤ 15 KiB.
```
1 HELLO  { v:1, site, owner, n, d, root, heads }   // owner: null or an algorithm-tagged key (v0.2.1)
                                                   // n blocks, d = max depth, root = hex sha256 of the sorted
                                                   // h set, heads ≤ 32 by (depth desc, h asc)
2 WANT   { h:[≤64], v?:true }                      // v:true also asks for payloads of v-less blocks
3 BLOCKS { b:[Block...] }                          // batched to the frame cap
4 ANN    { h:[...] }                               // hashes only
5 SYNC   { w:[{ k, dg, n }...] }                   // our depth-window digests, ≤ 128 per frame, paged
6 INV    { k, h:[...], more }                      // our hashes in window k, ≤ 200 per frame, paged
```
Flow: attach → HELLO. HELLO with a different `(site, owner)` → detach. Equal `root` → in sync. Otherwise
send SYNC for windows `0..ceil((max(d, peer.d)+1)/64)`; on SYNC compare digests and send INV for every
window that differs; on INV, WANT the hashes we lack (≤ 64 per frame); on BLOCKS/ANN ingest and WANT
unknown hashes and missing parents (from the orphan's sender first); first acceptance of a block → ANN to
all other peers (every node relays) and HELLO after any head change (250 ms coalesced); HELLO also every
30 s. A `v`-less block is relayed only together with the tombstone that justifies it; a node holding one
without such a tombstone sends `WANT { h, v:true }`. Two windows in flight per peer, round-robin across
peers with the same `root`. Budgets: unsolicited 64 KiB/s per peer; solicited (answers to our WANT/SYNC)
up to 1 MiB/s and `maxChainBytes`; one in-flight peer per hash (10 s, then the next); > 50 invalid blocks
from a peer → ignore for the session. The adapter attaches only to wires whose extended handshake
advertises `mw_chain1`, skips `webSeed` wires, ignores messages before the extended handshake, and
detaches on `wire` close. **v0.2.1 (B2)**: gossip rides `mw_chain1` on both the content swarm and the
ledger rendezvous swarm (§5.5), so visitors of different site versions of one ledger sync.

### 6.7 Persistence (`stores.js`)
IndexedDB `mw-chain-<sanitised ledger id>`: `blocks` (keyPath `h`), `meta` (heads, root, bytes).
Write-through: a block is in IndexedDB before `put()` resolves and before it is relayed; `meta` flushes on
`visibilitychange` to hidden. **Code review round 1:** a local write is stored before it enters the DAG, so
when IndexedDB refuses it (quota, a closing database) `put()` rejects and the block is not kept, relayed or
used as the next write's `prev`. A block from a peer whose store write failed stays in memory and is
written again with the next batch, by `tick()` (at most every `persistRetryMs`, 30 s) and at `close()`.
`tombstone(h)` deletes `v` only. Startup loads all blocks; the cap is
`maxChainBytes` (owner may raise up to 64 MiB). Export/import = JSON array of blocks (Settings, `pin.mjs`,
`snapshot.mjs` for `cs=`).

### 6.8 Node API (`node.js`)
```
const node = await ChainNode.open({ siteId, expectedOwner, store, identity, miner, verifierPool, now, config })
node.state / node.snapshot() / node.height / node.peers / node.identity / node.role ('owner'|'moderator'|'writer'|'reader')
await node.put(k, v, opts) / del(k, opts) / append(l, v, opts) / profile(name, opts) / tombstone(h, opts) / ban(author, opts) (moderator+)
  // opts (code review round 1) = { signal, onProgress }: onProgress({ hashes, bits }) while the fee is
  // computed; an aborted signal rejects E_POW_ABORTED, and a write aborted before ingest is never stored
node.subscribe(fn) → unsubscribe        node.attachTorrent(torrent) → detach
await node.ingest(blocks, peerId) / node.exportBlocks() / await node.importSnapshot(blocks) / await node.close()
```
`del(k)` = `put(k, null)`. Owner-only ops (`policy`, `owner`, `allow`) exist only in `tools/`.

## 7. Rendering: `src/sw/*`, `src/loader/render.js`

### 7.1 Service Worker (`/mw-sw.js` = `src/sw/sw.js` + `src/sw/core.js`, classic bundle)
Install: precache the `/_mw/` shell files except `webtorrent.min.js` (cached on first fetch; **code review
round 1:** after its bytes match the build's hash, which `build.mjs` adds to the integrity map, else the
worker answers 502 and keeps nothing) under
`mw-shell-<BUILD_ID>`; `skipWaiting`; activate: delete other `mw-shell-*` caches, `clients.claim()`.
**Code review round 1:** the install fetches `/index.html` first: the loader shell means shell mode, any
other page drop-in mode, and only that mode's files are precached (drop-in: `mw.js`, `sdk.js`,
`pow-worker.js`; shell: everything but `mw.js` and `sw-core.js`; no answer: everything, as before), with
`cache: 'no-cache'` (revalidate what the page just fetched) and the integrity check; `inspect().installMode`.
**v0.2.1 (D2): the install is atomic.** `build.mjs` writes the SRI value (sha384) of every precached JS and
CSS file into `build.json` (`integrity`) and into `/mw-sw.js` (`self.__INTEGRITY__`); those files are the
critical set: each is fetched with `Request.integrity` (and hashed again in the worker), and one failure (a
network error, a non-200, a mismatch from a mixed deploy or a stale CDN copy) deletes the half-filled
`mw-shell-<BUILD_ID>` and rejects the install, so the previous worker keeps control (verified in Chromium 156
by the e2e scenario SW-INSTALL: the failed worker goes installing > redundant). HTML (`/index.html`) and the
icons stay best-effort, because some hosts rewrite HTML. Without the map (unbuilt development) every entry is
best-effort, as in v0.2.
Routing (same-origin GET only; everything else untouched):
- `/_mw/ws/<name>/<path>` → drop-in web-seed rewrite (3.4.7). `/_mw/t/*`, `/ws/*` → pass through, never
  cached (never cache a 206 anywhere).
- `/_mw/*` → precache (cache-first, revalidate in background). `/_mw/sdk.js` is also a real host file.
- `request.destination === 'document'` (top-level navigation): shell mode → the precached `/index.html`
  (cache-first; every navigation is answered, since Firefox unregisters a worker whose navigations fault
  three times); drop-in → network untouched (3.4.2 a).
- **v0.2.1 (D1, D2) navigation safety.** Every navigation is answered within `limits.navigationDeadlineMs`
  (25 s; Firefox stops an idle worker after about 60 s, Safari allows 70 s): past the deadline the worker
  answers a "Still loading" interstitial (503, `Retry-After: 5`) that reloads itself; the reload-loop guard
  allows at most `reloadGuardMax` (3) automatic retries per URL in `reloadGuardWindowMs` (60 s), then the
  interstitial waits for the visitor. A navigation whose handling throws fails open: the network
  (`fetch(request)`), then the offline page; a frame navigation of shell mode gets the error page instead
  (the host would answer it with the shell). No required state lives only in worker memory: `meta.current`,
  `meta.clients` and the mode mark persist, and a restarted worker serves from them without any message.
- `GET /_mw/keepalive` → 204 `no-store` (v0.2.1 D1), answered before any other route.
- Shell mode, any other request from the site frame or its subresources (iframe navigations, scripts,
  styles, images, `fetch`): the site file at that path from the origin's current btih (`meta.current` in
  IndexedDB, mirrored in memory), after per-file verification (§7.3), with the routing manifest applied
  (`/.mw/site.json`: `spa`, `cleanUrls`, `trailingSlash`, `redirects`, `headers`, `index`, `notFound`).
  Missing → the site's `notFound` page with 404, else a plain-text 404.
- Drop-in: 3.4.2 (b) to (d), keyed by client → btih.
- Shared-origin hub: `/_mw/s/<btih>/<path>` as above with the btih from the path; a top-level navigation
  into it → 302 to `/#btih:<hex>`.
Headers on site documents: `Content-Type` from a 50-entry map, `X-Content-Type-Options: nosniff`,
`Accept-Ranges: bytes`, `Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'self'`,
`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, plus manifest `headers`. On the shell:
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. `Range` by Blob slicing
(206 + `Content-Range`; 416 when unsatisfiable; suffix ranges supported). Messages: `{ proto: 1, type }`;
`mw-ping` → `mw-pong { buildId }`; `mw-set-current { btih }`; `mw-map-client { clientId, btih }`.
**v0.2.1 (D1): the versioned protocol is one module, `src/sw/protocol.js`** (`PROTO`, the message types, the
builder, `checkProto`, `createKeepAlive`), imported by the worker and the drop-in runtime. Added:
`mw-keepalive` (a page that depends on the worker pings it at most every 20 s, `KEEPALIVE_MS`) and
`mw-doc-info` / the `doc` field of the `mw-map-client` ack (drop-in no-store pages, 3.4.6). A message of another
`proto` gets `mw-ack { ok: false, error: 'proto', expected }`; `mw-ping` is answered whatever its proto.
Update safety: the SW URL never changes; `Cache-Control: no-cache` on the host; kill switch = deploying the
self-unregistering `src/sw/kill-switch.js` as `/mw-sw.js` (clears `mw-*` caches, unregisters, claims and
navigates clients). Purge the CDN on every deploy.

### 7.2 Renderer (`render.js`, shell mode)
One `<iframe>` with `position: fixed; inset: 0`, `src = location.pathname + location.search`,
`allow="fullscreen; clipboard-write; picture-in-picture"`, `sandbox="allow-scripts allow-same-origin
allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation"`,
`referrerpolicy="no-referrer"`. On each frame `load`: mirror the frame's path+search into the top URL with
`history.replaceState` (never `pushState`; guard loops), copy `document.title`, and add a capture-phase
click listener in the frame document that opens cross-origin links without a target in a new tab with
`noopener`; if reading `iframe.contentWindow.location` throws, navigate the frame to `about:blank` and
show "This site tried to open an external page" with an open-in-new-tab action. `popstate` sets the frame
location. Hub shared-origin: same, minus `allow-downloads`, `src = /_mw/s/<btih>/<path>`.
**Code review round 1 (item 7, the site's own viewport):** an iframe has no viewport of its own, so the
shell's `<meta name="viewport">` decides how the site lays out on phones. After each frame load (and after
each limited-mode write) the shell takes the site's viewport content as is (`viewport-fit=cover` and
`interactive-widget` only when the site declares them); a site without one gets `width=980`, the default of
the phone engines (removing the meta does not reset Chromium's viewport). The loader's own screens keep the
shell's viewport, which is put back when the site frame is removed. E2E `VIEWPORT` (Chromium phone
emulation, 390x844): pages without a meta, with `width=1024` and with `width=device-width` lay out at 980,
1024 and 390 CSS px in the frame, as on the plain host.

### 7.3 Never serve or upload unverified cached bytes
The expected btih comes from the currently resolved pointer, never from IndexedDB alone. Once per context
check `sha1(bencode(info)) === btih` (own bencode decoder + `crypto.subtle.digest('SHA-1')`). Before the SW
first serves a file, SHA-1 every piece covering it; before `BlobChunkStore.get` first returns a piece, SHA-1
it. Memoise verified piece indices in memory only. On mismatch `deleteSite(btih)` and fall back to network
(drop-in) or re-download (shell). Piece math follows the `.torrent` `files` order; pad files are zero-filled
and never served. Stated limit: offline, with only the cached pointer, a same-origin attacker can rewrite
pointer and files consistently.

### 7.4 Degraded mode (no Service Worker)
Only when `serviceWorker` is absent or `register()` rejects (iOS in-app WebViews, Lockdown Mode, Tor,
Firefox ESR 128). The CSP inserted by `boot.js` adds `blob:` to `script-src`, `style-src`, `font-src`,
`media-src`, `connect-src` and `'unsafe-inline'` to `script-src`. The renderer rewrites the entry HTML:
`src`/`href`/`srcset`/`poster` and CSS `url()` that resolve to torrent files → `blob:` URLs, inline
`<script>` → `blob:` module/classic scripts, injects `<base>`, renders via `iframe.srcdoc`, and shows
"Limited mode: this browser has no offline engine". `mw.ready()` still resolves (bridge works). Relative
`fetch` by the site's JS does not work; documented.
**Code review round 1:**
- **Late decisions.** Limited mode is also used when the worker is never ready (15 s, or at once when the
  installing worker turns redundant, e.g. a mixed deploy failing D2), when `register()` fails after
  boot.js's 3 s probe, and when the site cannot be stored (`QuotaExceededError`, a blocked IndexedDB).
  boot.js has then already fixed the normal CSP, which blocks what limited mode needs and cannot be
  relaxed: the loader sets the one-time `sessionStorage` flag `mw:degraded` and reloads once; boot.js reads
  it first, skips `register()` and inserts the degraded CSP, so the tab session continues in limited mode
  (never a reload loop; without `sessionStorage` the site renders unstyled, with a log line). A
  `register()` that never settles is bounded by the same 15 s. Serving files the worker lacks from the
  page's memory (so a full disk keeps SW mode) is a later optimisation.
- **Third-party subresources.** The degraded policy also allows `https:` (and, in development,
  `http://127.0.0.1:*` and `http://localhost:*`) in `script-src`, `style-src`, `img-src`, `media-src`,
  `font-src` and `frame-src`, so CDN stylesheets and scripts, web fonts, images and embeds load as in SW
  mode (where the site document is not under the shell policy at all).
- **The page URL.** Shell mode writes the page into a fresh same-origin `about:blank` frame with
  `document.open()`/`write()`/`close()`: the frame's URL is the address-bar path, so `location.pathname`,
  `history.pushState()` and relative URLs behave as on the host (with `srcdoc` the document was
  `about:srcdoc` and `pushState` threw). The shared hub keeps `srcdoc`.
- **Module graphs.** Where import maps exist (Chrome 89, Firefox 108, Safari 16.4), every module gets one
  `blob:` URL behind one import map keyed by its site URL (merged with the site's own import map), so a
  graph with a cycle (Rollup and Vite code splitting) links with one instance per module. Safari and iOS
  15.4 to 16.3 have no import maps: there the recursive rewrite stays, and a module cycle breaks the lazy
  chunk (a documented limit of limited mode on those versions).

## 8. Policy, consent, lifecycle: `src/loader/policy.js` (v0.2.1: four classes, B6 caps, B7 ICE, C1 consent, C2 mobile)

v0.2.1 (C2) classifies the network into four classes (`classifyNetwork`, only `navigator.connection`, Save-Data
wins) and the policy into four columns (`policyClass`): a metered network (cellular or Save-Data) is
`mobileMetered` on any device; otherwise a desktop is `desktop` and a phone is `mobileUnmetered` (Wi-Fi
confirmed) or `mobileUnknown` (iOS, Firefox, most WebViews).

| | desktop | mobileUnmetered | mobileUnknown | mobileMetered |
|---|---|---|---|---|
| maxConns (content soft; hard = soft + ceil(soft/2)) | 30 | 8 | 6 | 4 |
| rendezvous wires (soft/hard) | 6/9 | 3/5 | 3/5 | 3/5 |
| tracker numwant | 3 | 3 | 3 | 2 |
| uploads | on, 1 MiB/s | **off** until "Share on this network" (then 128 KiB/s) | **off** (then 128 KiB/s) | **off** (then 128 KiB/s) |
| maxSiteBytes | 128 MiB | 48 MiB | 24 MiB | 24 MiB |
| hidden tab | keep seeding; on battery destroy after 10 min | lock uploads at once, rebuild on return | same | same |

Uploads off = choke lock on every wire (never `throttleUpload(0)`); shaping only at 32 KiB/s or more.
`pointer.max` lowers `maxSiteBytes`. **Wire caps (B6)**: per swarm, applied after the extended handshake (a
wire with no handshake within 10 s is counted); over the hard cap the lowest-scored wire is dropped first
(a wire that speaks `mw_chain1` scores highest, then bytes exchanged, newest first on ties); `numwant` is
driven to 0 at the soft cap; peers are counted by unique `peerId`, web seeds excluded. **Tracker keepalive
(B1)**: an offer-free announce (`numwant: 0`) on any socket silent for 55 s (never `scrape`); a per-instance
fast-reconnect shim (500 ms + jittered backoff, capped at 60 s) and a `kick()` on `visibilitychange`,
`pageshow` and `online`. The site torrent and the rendezvous swarm share one pooled socket per tracker URL, so
the shim also hooks `connect` for an instance that joins a pooled socket that is still connecting, and
restarts the regular announce interval after a reconnect (both lost a swarm's announces before), and `kick()`
reopens only instances that wait with no socket (reopening one that is attached would count it twice in the
pool, so after the next blip every instance would attach to the dead socket) (v0.2.1 verifier). **ICE (B7)**: TURN off, at least two STUN operators, a boot-time STUN probe
(`src/loader/connectivity.js`, 2.5 s budget, never blocking render) that gates the ICE server list and feeds
the diagnostics panel; a 1.5 to 2 s non-trickle offer timeout installed before the bundle loads (shell
`app.js`; drop-in `createDeps().webtorrent`, which runs no STUN probe: a page-view-sized engine has no
diagnostics panel, and the offer timeout bounds a dead STUN server to 1.5 s). **Lifecycle
(C2)**: hidden time is measured by timestamps (not timers); a phone locks uploads at once when hidden and
rebuilds the client (fresh sockets, re-joined swarms, the ledger re-attached) on `pageshow.persisted`,
`online`, or visible after more than 10 s (60 s on desktop); `beforeunload` and `unload` are never used.
**Code review round 1:** the drop-in runtime follows the same plan (`lifecyclePlan`, now in `policy.js`; it
destroyed the client on every hide and used the 60 s desktop value). The network class is detected again on
`navigator.connection` `change` (`watchNetwork`), on `online` and when the page becomes visible, and the
policy is recomputed (caps, `maxSiteBytes`, `leaveVersionSwarm`); a drop-in copy that runs through the
host's web seed when the network becomes metered is aborted and started again from peers only (3.4.7).

Consent (strings in DESIGN-REVIEW §4.5 and PRODUCTION-DIGEST §9.2, verbatim), always **before the first
tracker, peer connection and DoH lookup (C1)**:
- Per-domain and drop-in: the first-run card, non-blocking, with a same-layer refusal **[Share and load]
  [Load from host only]**; the web seed download starts at once (HTTP only); peers, trackers and the STUN
  probe start after "Share and load" or a stored choice. `consent=gate`, or an `aud=` gate token (§4: personal
  data, an EEA/UK/Quebec audience, kids or sensitive content), forces the blocking gate.
- The DoH lookup waits until a choice allows it. A `<meta>` pointer, a cached pointer or a cached DNS answer
  still renders the site without a lookup; a site known only through DNS shows the card (or the gate) first.
  The update checks of §4 then run right after the choice (or after render on a later visit), every
  `pointer.minTtlMs` or the TTL, and on `focus` at most every `focusRecheckMinMs`; the card (`consentDnsUpdate`)
  and the gate (`gateDnsUpdate`) say so on every shell or hub page whose `dnsHost` is not skipped (post-wave
  fix), and the DNS-only card adds `consentDnsAgain`.
- The choice is a versioned record `{ v, choice, dns, day, scope, rcpt }` stored per origin; a record of
  another version, or whose tracker/STUN recipients differ, is asked again.
- Hub: the gate, unless the site is cached. While gated, load from the web seed only when the pointer has
  `xs`/`ws`, otherwise nothing.
- Settings: "Share with other visitors: On / Off" (Off stops sharing the site's files; posts are still passed
  between connected visitors and the IP stays visible: code review round 1, DESIGN-REVIEW §4.5), "Host only:
  no peer connections", and "Change your sharing choice" (re-opens the card).
`navigator.storage.persist()` is requested only from the consent click itself (never at load: Firefox
prompts). Storage budget 512 MiB desktop / 128 MiB mobile, LRU by last visit (never the current site),
"Forget this site".

**No incentive layer** (a v1 compatibility promise; IMPROVEMENTS-DIGEST P0-25, research w2c-07 R2): no tokens,
points, credits, rankings or referral rewards for seeding or hosting, and no API that reports one visitor's
contribution to anyone else. The page itself gets read-only local counters (`progress` `uploaded`, `peerBytes`,
`webseedBytes`); INTERFACES has no reward or credit symbol. A recognition feature, if one is ever added, stays
local, non-transferable and derived from local counters; anything beyond that needs an RFC (GOVERNANCE.md).

### 8.1 Smart seeding (v0.3 C2)

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (2026-10-22 to 2026-10-24, R 5.4).** Built by the C2 lanes seed-policy, seed-engine, pin-node and wire-ui and integrated on
> 2026-10-20 ([deviations/integration-c2.md](deviations/integration-c2.md)); 8.1.11 lists what the integration changed. Not run on any
> phone (every G-PS row of 8.1.10 is open), and the owner decisions SZ-1, SZ-2 and SZ-4 to SZ-6 (15.11) are unsigned (SZ-3, the record lifetime, was accepted on 2026-10-25), so every phone still keeps K and
> E off until "Share on this network" or dock mode, exactly as section 8 says. One piece is **(proposed)**: no path carries a pin
> request from a member's page to the pin node (8.1.6), because no lane built the page side (integration-c2 O-1; ROADMAP "Next"). Source: [research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md)
> ("SZ") 3.1, built on [S1](research/v03/S1-smart-phone-seeding.md). A number is documented (with a source id of S1 or SZ 7),
> measured, arithmetic (derived in place) or chosen (a design parameter that a gate row confirms or tunes). Browser only (owner
> decision, 2026-10-20): nothing here asks a member to install anything, and an installed web app counts as the browser.

**8.1.0 What the platforms forbid.** The policy below is the most a page can do, not a promise of availability.
- A hidden iPhone page is suspended 20 s after WebKit's prepare-to-suspend message (`processSuspensionTimeout`, S1 WK6), and Apple
  says that once an app is suspended "all low-level networking stops" (S1 AP1; said of apps, applied to the web process by
  inference). Android Chrome's cached processes "may receive limited or no execution time" (Android 13 and later, AN2), and Doze cuts the network of a
  phone that is unplugged, still and dark (AN1).
- `RTCPeerConnection` is `[Exposed=Window]` in the W3C WebRTC Recommendation of 2025-03-13 (ST2). Push, Background Sync, Periodic Sync
  and Background Fetch run in a Service Worker, so none of them can open a peer wire: a perfect wake-up still cannot seed, relay,
  hold or ring.
- Screen Wake Lock is the only documented way to keep a page in the foreground (screen on, released when the page is hidden; S1 F2).
  It is the honest basis of dock mode (8.1.4). The audio-session trick and push-to-wake tell the operating system something false
  and are rejected (8.1.10).

**8.1.1 Tiers.** T0 **pin node** (the owner's or a hub's infrastructure, `tools/pin.mjs`): durability. T1 **keeper tab or dock
mode** (a member's open desktop tab, or a phone on a charger with the screen on): availability while open. T2 **visitors** (phones
only while visible): peaks. Members add availability, never durability. Availability at a random instant is 1 - (1 - p)^r for r
holders that are each online and allowed to serve with probability p (arithmetic, S1 F6): for 99% that takes about 108 phones open
one hour a day (p = 4.2%), or 12 docks on for 8 hours (33%), or one pin at 99%. With the same total storage and p = 5%, 10 full
copies of a 64-piece item are available 40.1% of the time and 20 half copies 0.06%, so partial copies never make a whole item
available. Real uptime is correlated (evenings), so the night is worse (S1 F6, inference).

**8.1.2 Lanes in spending order** (S1 D1). Three lanes share the budget of 8.1.3, in this order:
- **H Hand-off.** The member's own new items (posts, files, media) until a pin receipt or two complete peer copies exist. On by
  default everywhere, with the MF-45 per-upload card. It is the only copy, so it spends first.
- **K Keep.** Items the member chose to share ("Help share this file", saved items) and the site torrent while sharing is on. It
  counts against the monthly cap.
- **E Echo.** Items already held, ordered by copy deficit (target 3 complete online copies, chosen, for speed and not for
  durability: 3 phone copies are 12% available, S1 F6), then recency; rarest pieces first, ranked by durability gap and not by
  download speed; it skips an item a pin keeps; it never fetches what the person did not open.

Ledger gossip (`mw_chain1`, `mw_chain2`) and chat stay outside the lanes and keep their own budgets (15.10). "Authors seed what they
made" is H; "viewers re-seed what they read" is E plus K for what they chose. Re-seeding shows peers and the tracker which items a
member holds, more than an IP address: one site-level sentence says so for E and "Others can see which files you share" sits on each K item.

**8.1.3 Budgets** (S1 D2, chosen; `seedBudget(env, prefs, config)` in `src/loader/seed-budget.js`; `computePolicy` returns the
result as `seedBudget` and every other field of section 8 stays as it is):

| Context | H | K | E | Session | Month (K + E) |
|---|---|---|---|---|---|
| Desktop, not metered | 1 MiB/s | 1 MiB/s | 256 KiB/s | none | 20 GB (Delivery Optimization default, S1 MS1) |
| Phone, Chromium, Wi-Fi by `connection.type`, charging, battery 50%+ | 1 MiB/s | 256 KiB/s | 256 KiB/s | 64 MiB | 1 GiB |
| Phone, Wi-Fi proven, unplugged, battery 50%+ | 512 KiB/s | 128 KiB/s | 0 | 32 MiB | 256 MiB |
| Phone, battery 20% to 49%, or nothing provable (iOS, Firefox) | 128 KiB/s; 512 after "I am on Wi-Fi" | 128 KiB/s after "I am on Wi-Fi" | 0 | 32 MiB | 256 MiB |
| Cellular, Save-Data, or under 20% unplugged | 128 KiB/s with the card | 0 | 0 | 16 MiB | 0 |
| Any phone, local wire (host-to-host pair) | 1 MiB/s | 512 KiB/s | 256 KiB/s | 128 MiB | not counted |
| During a call (15.14) | phones 128 KiB/s | phones 0; desktop halved while the call is bandwidth-limited | 0 | | |

- Host-only gives 0 everywhere. With sharing off K and E are 0 and H keeps its rate, because the per-upload card is the person's
  explicit choice. The month is the UTC calendar month and counts K and E only; local wires are not counted.
- A lane at its rate, its session cap or the month cap is **choke-locked** (never `throttleUpload(0)`; shaping only at 32 KiB/s or
  more, section 8) and unlocked on refill with about one second of hysteresis. The month cap never stops H.
- A **local wire** is a host-to-host candidate pair whose addresses are private, mDNS or hidden (`isLocalPair`,
  `src/loader/localwire.js`); server-reflexive, peer-reflexive and relayed pairs are not local. It costs battery and no data
  (Delivery Optimization likewise leaves LAN peers outside its download bandwidth limits, MS1).
- Arithmetic that shapes the table: 128 KiB/s is 0.472 GB an hour, so a 256 MiB month is gone in 34 minutes at 128 KiB/s and in 8.5
  minutes at 512 KiB/s, and the cap binds before the rate (S1 F5). The meters are local counters in the per-origin store, never
  sent and never ranked (the no-incentive rule of section 8).
- K and E on phones stay behind "Share on this network" until the owner signs SZ-1 (15.11); row 2 then becomes the one default-on
  case, asked once, when it matters (the `seed.ask` card). Budgets are recomputed on charging, battery level, network, visibility,
  dock and call changes.
- **C2 build (lane seed-policy, [deviations/seed-policy.md](deviations/seed-policy.md)), readings the table left open:** the Session
  figure applies to each active lane and not as one total (the owner may prefer a total, which is one function to change); the most
  restrictive row that applies wins, so a metered network or a battery under 20% unplugged is row 5 on any phone, and a metered
  desktop too; "I am on Wi-Fi" counts only where the browser reports no network type, and proof from `connection.type` beats a
  declaration; dock mode counts as the opt-in for K and E while it runs, because it is a click-started, time-boxed choice to share;
  during a call a desktop sends no E and halves K only while the call is bandwidth-limited; local wires never lift a metered network
  or a battery under 20% unplugged (a carrier can hand a phone a private address). Every rate and cap stays chosen until a gate row
  confirms it.

**8.1.4 Windows.** Open and visible: everywhere. A **hidden phone** locks K and E at once, as in section 8; H keeps sending until the
browser suspends the page only if the owner signs SZ-2 (`CONFIG.seed.handoffWhileHidden`, default off; G-PS-8 hides the page at +10 s).
**Dock mode:** "Keep this screen on and share for 2 hours" (cap 8 hours, chosen) takes a Screen Wake Lock from a click and shows a
dim page; it ends when the page is hidden, when the phone is unplugged or the battery falls under 20% (Chromium, where the Battery
API exists) or at the cap; on iOS and Firefox, which expose no battery or network API (S1 F4), the person declares "plugged in, on
Wi-Fi". No audio element, media element or other keep-alive is used. **Keeper tab:** a desktop tab in "Keep this site" mode shows
what it keeps and its month counter. Dock mode is the only web route to a high p on a phone (8 hours is p = 33%); heat and battery
health of a phone left on a charger are unmeasured (G-PS-5).

**8.1.5 Evidence and labels** (S1 D6). Every availability label comes from an evidence tier, and a label never shows a number above
its evidence.

| Tier | Evidence | Window |
|---|---|---|
| E0 | this device holds every piece, verified | now |
| E1 | complete bitfields on live wires: "reported", because a bitfield can lie; a phone sees at most 8 wires, so a count is "at least" | 60 s |
| E2 | a spot-check was answered by a claimed holder (v0.4) | |
| E3 | the web seed answered a probe | 10 minutes |
| E4 | a `mw_pin1` receipt (8.1.6), or a pin heartbeat listing the item | heartbeat at most 15 minutes old |

`evidence({ local, wires, webseed, pin, now })` in `src/loader/availability.js` returns `{ tier, count, atLeast, reported, checkedAt,
label }`. The SDK's `available` ('kept', 'online', 'unknown') stays for compatibility and gains that object (INTERFACES, C2).
Never "forever". A tracker's scrape count appears only as "{n} connected to this site (tracker report, {time})", never as copies.

| Label key | English text | Needs |
|---|---|---|
| `avail.onlyHere` | Only on this device. Keep this page open until it is sent. | E0 alone |
| `avail.heldBy` | Kept by you and at least {n} others online now (reported) | E0, E1 |
| `avail.keptBySite` | Kept by the site (checked {age} ago) | E3 or E4 |
| `avail.nobody` | Nobody who has this is online right now. | none |
| `avail.noPin` | No always-on copy exists for this site. This file is available only while someone who has it is online. | no pin |
| `handoff.waiting` | Waiting for the site to accept it. | queued request |
| `handoff.sending` | Sending to the site: {pct}% | pin wire |
| `seed.monthUsed` | Sharing paused: this site's limit of {cap} for this month is used. Your own uploads still go out. | month cap |
| `seed.ask` | Help keep this available? While this page is open and your phone charges on Wi-Fi, it shares what you keep, up to {cap} a month on this site. Others can see your IP address and which files you share. | moment of value |
| `dock.on` | Keeping the screen on and sharing until {time}. Leave the page to stop. | dock mode |
| `meter.visit` | This visit: {p}% of the bytes came from {n} visitors, {h}% from the host. | counters |

The texts are in `src/loader/strings.js` (`SEED_TEXT`, English and French; the same keys with `seed.declareWifi`, `seed.declarePlugged`,
`keeper.on`, `keeper.toggle`, `dock.start` and `meter.tracker`). The carry meter shows measured bytes by source, never points or a
ranking, and the one adoption line that may be used is "Readers who agree help carry this site while their page is open".

**8.1.6 Hand-off, pin identity and heartbeat.** The pin's key is `_mw.cfg.pin` (R 2.5.5), a P-256 key of its own and not the owner key, which never enters a browser.
- **Hand-off.** The phone announces the item on the site's own tracker (a private swarm; never the public default trackers, MF-44). A
  pin joins and pulls it. The UI moves from `avail.onlyHere` to `handoff.sending` to `avail.keptBySite`. The owner key's H items are
  requested and accepted automatically (owner decision SZ-6); a member's items wait in the moderator queue (R 2.8.6) and the pin
  never opens or renders a file. With no pin the card says `avail.noPin`. **(proposed)** How a request reaches the pin: in the C2
  build nothing in a member's page carries one (the services get no `pin` seam, so `files.pinRequest` and `media.pinRequest` answer
  `E_POLICY` and SZ-6 requests nothing from the browser); the pin's queue is filled by its own page's bridge (`file.request`) and the
  operator approves with `tools/pin.mjs --approve`. Since the v0.3 code review the bridge takes a request only when its author signed it
  (`src/pin/frames.js` `makePinRequest`, verified by the node over `pinRequestBytes`, 15.17); a member's page that signs and sends one is
  the v0.4 proposal (deviations/pin-node.md O-1). Static buckets cannot ingest from phones, so the always-on
  side must be a node that pulls. Target (chosen): 5 MiB reaches "Kept by the site" in under 60 s median on Wi-Fi (G-PS-8). Time
  arithmetic: 25 MiB takes 200 s at 128 KiB/s, 50 s at 512 KiB/s and 25 s at 1 MiB/s, and WebKit's 20 s moves about 2.5 MiB at
  128 KiB/s, so a phone hand-off keeps the page visible.
- **`mw_pin1`**, a BEP 10 extension on site and file torrent wires (JSON frames of at most 1 KiB). The browser sends `{ t: 'chal', n }`
  (16 random bytes) once per wire. The pin answers `{ t: 'hello', key, ih, n, at, sig }` over `"mw-pin1-hello\n" + ih + "\n" + n + "\n" + at`
  and, once it holds every piece verified, `{ t: 'rcpt', key, ih, total, at, sig }` over `"mw-pin1-receipt\n" + ih + "\n" + total + "\n" + at`
  (ECDSA P-256, raw P1363; `|now - at|` at most 5 minutes). A verified `hello` anchors the wire; a verified `rcpt` is the E4 evidence
  for that infohash.
- **Heartbeat.** The pin writes `{ v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap, sig }` at
  `<ws base>/pin-status.json`; `items` holds the first 16 bytes of SHA-256("mw-pin-status-v1|" + ih), base64url, so a private
  infohash is never in the clear. A page reads it at most every 10 minutes and verifies it against `_mw.cfg.pin`.
- **The key never enters a page.** A page answers as a pin only when `tools/pin.mjs` exposes its Node signer to the pinned page,
  and that signer signs only the two forms above and nothing else (`isPinSignable`), so site code on the pinned page cannot make
  the pin key sign a pointer, a block or a sign-in.
- **Super-seeding** (BEP 16) of H items on phones is built behind `CONFIG.seed.superSeed` (default off): a plain seed "might have to
  upload 150% to 200%" of an item and a super-seed managed "105%" before another full copy exists (S1 TO1). It becomes the default
  after G-PS-8, if it does not break Fast Extension handling (S1 Q4, open).

**8.1.7 Partial seeding.** Keep whole: site torrents and items up to 8 MiB (chosen). Slices of large media, chosen by a hash of the
member's key, the infohash and the piece index and topped up from the rarity map, are v0.4 after G-PS-10; durability stays with full
copies at pins. The vendored `bittorrent-protocol` has no BEP 21 `upload_only` flag, so a partial holder looks like a peer that never
asks for the rest, and a tracker scrape under-counts partial seeds as "incomplete" (S1 TO2).

**8.1.8 When the tab is gone.** A closed or suspended page seeds, relays, holds and rings nothing and keeps no call. The Service Worker
still serves the site from its cache. **(proposed, P3; SZ section 2; not built: P3 work after 1.0)** Where the platform allows, it could also run HTTP-only tasks:
Background Sync retries (Chromium), Periodic Sync refreshing the pointer and the `cs=` snapshot (installed Chromium apps only, "a few
minutes at a time", CH1), Background Fetch downloading web-seed bytes (Chromium), Web Push showing a notice (every push shows a
notification on iOS, WK1). None of these is built: `src/sw/` registers no `sync`, `periodicsync`, `backgroundfetch*` or `push` handler
and nothing calls `registration.sync`, `periodicSync` or `backgroundFetch` (a unit test, `docs-claims`, keeps this sentence true).
When they are built, each needs a feature check (`'periodicSync' in registration` with a permission query inside `try`,
`'backgroundFetch' in registration`, `'sync' in registration`), because Safari and Firefox have none, and none of them may open a peer
connection. iPhone has no Background Sync, Periodic Sync or Background Fetch, no battery or network API (WK5), and Safari deletes a
tab's script-writable data after 7 days without use (a Home Screen app is exempt).

**8.1.9 Contribution rules** (a lint, `test/unit/lint-contrib.test.mjs`, run as a unit test): no silent or keep-alive media; no
`navigator.audioSession` writes; `new Audio(`, `createOscillator` and `.loop = true` only in `src/loader/call-ui.js`; Wake Lock only in
`src/loader/dock.js` and `src/calls/session.js`; `getUserMedia` and `getDisplayMedia` only under `src/calls/`.

**8.1.10 Gate rows, tests, and what is rejected.**
- Real devices: S1's rows G-PS-1 to G-PS-14 join [DEMO-RESULTS.md](DEMO-RESULTS.md). **Rows G-PS-1 to G-PS-4 and G-CL-2 run on one
  iPhone and one Android phone before any card or document describes what phones do in the background.** Nothing is quoted before its
  row has run, and failures are published too.
- Loopback end to end, added by the C2 integrator and passing (`test/e2e/scenarios-c2.mjs`): E-PS-1 (hand-off to a pin fixture,
  receipt, label; 5 MiB was "Kept by the site" 5.1 s after the approval on loopback), E-PS-2 (lying bitfields stay "reported"), E-PS-3
  (the month cap stops K and E and not H), E-PS-4 (dock mode takes and releases the Wake Lock), E-ZS-1 (no DNS-over-HTTPS query for a
  nip.io name, section 4).
- **Rejected by the owner (2026-10-20) and recorded here so nobody rediscovers it:** a keeper CLI or container for members, a browser
  extension, a desktop app, keeper pods and an operating-system `felinar:` handler (S3 K1 to K3); native Android and iOS wrappers and
  a wrapper push inbox (S1 O6 to O8); the audio-session trick and push-to-wake for seeding (S1 F3). The forms kept are all
  browser forms: a desktop tab, a phone in dock mode, an installed web app, and the owner's or hub's pin node.

**8.1.11 C2 integration** (2026-10-20, [deviations/integration-c2.md](deviations/integration-c2.md) C2-7, C2-8, C2-10).
- **mw_pin1 in the page.** Every page whose site names `_mw.cfg.pin` runs the verifier of 8.1.6 on its site and file wires; it looks for
  the key each second during the first minute (the ledger arrives just after the torrent manager starts), then every 10 s. Only the
  pin's own page (the top frame where `tools/pin.mjs` exposes `__mwPinCall` and `pin.key` equals `_mw.cfg.pin`) answers as the pin:
  it offers `window.__mwPinHost` (pinned files in IndexedDB stores `pin-<infohash>`) and runs without a member budget. That host starts
  only an infohash the node lists as pinned and not paused (`file.pinned`), so the site's own code on that page cannot make the node join
  a swarm nobody approved. `tools/pin.mjs`
  asks the page for that host at every status tick until it has offered it once. A page reads the heartbeat at its first `ws=` base.
- **The carry meter** is in Settings, "Sharing", not in the loader bar (the bar lies over the top of the site and stays open while a
  notice is shown, and its lines covered the site's own controls), and its lines appear only when they report someone else: the visit
  line once a visitor carried bytes, the tracker line once the report counts more than this visitor.
- **Local wires in tests.** Two tabs on one machine are a host-to-host pair, which the month cap does not count; e2e E-PS-3 makes its
  wires read as server-reflexive to test the cap.

## 9. SDK: `src/sdk/sdk.js`, `src/loader/bridge.js`

Shell mode: the site loads `<script type="module" src="/_mw/sdk.js">`; `sdk.js` posts `{ mw: 'hello' }`
with a `MessagePort` to `window.parent` (same origin); the Bridge accepts only `event.source ===
iframe.contentWindow && event.origin === location.origin` (commented: source equality is not an origin
check). Drop-in: `/_mw/mw.js` creates `window.mw` bound directly to the engine and `/_mw/sdk.js` re-exports
it. Protocol: `{ id, method, params }` → `{ id, ok, result | error: { code, message } }`, push `{ event, data }`.
```
await mw.ready()  → { siteId, btih, mode, identity: { pub, short, name }, role, peers, height, owner: pub|null, unmoderated: bool }
mw.db.get(key) / set(key, value) / del(key) / list(name, { limit = 100, newestFirst = true }) / append(name, value) → { h }
mw.db.subscribe(fn) → unsubscribe   // fn(snapshot: { height, peers, inSync, kv, lists, profiles, policy })
mw.db.tombstone(h)                  // own entries; moderators and owner: any
mw.mod.ban(pub)                     // moderators (E_NOT_MODERATOR otherwise)
mw.identity.setName(name)
// every write above also takes a last argument { onProgress, signal } (code review round 1, below)
mw.net.peers() → number             mw.net.on('peers'|'progress'|'status'|'sync'|'pow', fn)
mw.site.info() → { name, files: [{ path, length }], btih, source: 'peers'|'webseed'|'cache'|'mixed', mode }
mw.consent.request() → Promise<'pending'|'accepted'|'host-only'>   mw.consent.state() → 'pending'|'accepted'|'host-only'
mw.owner.policy(...)                // always rejects E_NOT_OWNER in browsers (exists for API symmetry)
```
**v0.2.1 (DIGEST-AMENDMENTS A4): the site-callable surface.** In per-domain and drop-in modes site code
runs with loader privilege, so the SDK must not hand it the visitor's identity or the visitor's consent:
`identity.export`, `identity.import` and `consent.accept` are removed (over the Bridge they are unknown
methods, `E_BAD_REQUEST`). `mw.consent.request()` opens the loader-owned consent card (shell:
`ui.openConsent()`; drop-in: the panel's notice or gate) and resolves with the visitor's choice there
(`pending` when the card is closed without one); a decided state resolves at once and opens nothing;
concurrent requests share one card and a card closed undecided cannot be reopened by the site for 10 s.
Export, import and the consent decision live only in loader-owned UI: a closed shadow root (drop-in panel)
or the shell's own document (`ui.openIdentityExport()` in Settings), acting only on `event.isTrusted`
input with transient activation. Public keys the SDK returns (`identity.pub`, `owner`, item `author`) are
`p256:` strings.
**Code review round 1: the write fee (DESIGN-REVIEW item 4).** While the browser computes a post's spam fee
(the proof-of-work), the host reports it: the Bridge pushes `{ event: 'pow', data: { id, hashes, bits } }`
(`id` = the write request's id; the drop-in binding pushes `{ hashes, bits }`), the write's `onProgress`
gets `{ hashes, bits }`, `mw.net.on('pow', fn)` gets every report, and the loader's status line says
"Posting: working out the spam fee for this post". A write request gets an answer within 30 s or
`E_TIMEOUT`; each `pow` report restarts that timer, for at most 10 minutes. When the SDK gives up (timeout)
or the site's `signal` aborts, the SDK sends `{ method: 'write.cancel', params: { id } }` (not a write, not
rate limited) and the host aborts the mining; a write aborted before it is ingested is never stored or
published, so a write the site saw fail does not appear later. Writes forwarded by a follower tab carry the
same progress (`pow`) and cancel (`cancel`) messages over the tab channel.
Errors: `E_POLICY`, `E_LIMIT`, `E_RATE`, `E_NOT_OWNER`, `E_NOT_MODERATOR`, `E_POW_ABORTED`, `E_IDENTITY`,
`E_NO_HOST`, `E_CAP` (ledger at `maxChainBytes`), `E_BANNED`, `E_TIMEOUT` (shell: no answer within 30 s,
see above). Bridge limits: 20 writes/min per page, JSON only, size per `maxValueBytes`.

## 10. Tooling: `tools/*.mjs`, `build.mjs` (Node ≥ 22)
- `keygen.mjs [--out owner.jwk]`: extractable P-256 pair → JWK file mode 0600; prints the fingerprint and
  `owner=` only. Refuses to overwrite without `--force`.
- `publish.mjs <dir> --name <n> --scope <hostname> --key owner.jwk [--ws <base>] [--xs <url>] [--tr <wss>]...
  [--chain <label>] [--max <bytes>] [--cs <url>] [--consent notice|gate] [--exp <days>=90] [--seq <n>]
  [--policy open|allow|owner] [--moderator <pub>]... [--allow <pub>]... [--bits <n>] [--dropin] [--keep-days 7]
  [--verify-ws] [--out <dir>]`: refuses group/world-readable keys; ignore list (dotfiles, `README.md`,
  `node_modules`); writes `/.mw/site.json` (from flags and `_redirects`/`_headers` if present) and
  `/.mw/files.json` (sha256 per file) into the publish copy; builds the torrent (fixed name, sorted paths,
  256 KiB pieces, `urlList` from `--ws`, `createdBy: 'felinar'`); mints the **genesis policy block** with
  the owner key; signs the pointer; outputs `site.torrent`, `magnet.txt`, `pointer.txt`, `dns.txt` (record name
  `_magnet.<scope>`, value split into ≤ 255-byte quoted strings, plus a Route53 change batch and Cloudflare
  API example), `meta.html`, `webseed-layout.txt` (keys `<ws>/<name>/<path>`, S3 CORS JSON with OPTIONS,
  CloudFront note; shell mode only since the post-wave fix), `genesis.json`, `summary.json`, `csp.txt` (the
  shell CSP, or the drop-in CSP additions, which name no DoH endpoint). `--dropin` additionally
  stamps HTML files and lays out `/_mw/` + `/mw-sw.js` + `/_mw/t/<btih>.torrent`. Will not print the pointer
  until `--verify-ws` passes when `--ws` is given. Deterministic (two runs ⇒ same infohash).
  **v0.2.1 publishing discipline** (`tools/publish-policy.mjs`; DIGEST-AMENDMENTS E1 to E4, F4, B4), all before
  anything is written: (E1) the path policy refuses `? # % \` and control characters, dot segments, leading
  or trailing spaces, trailing dots, segments over 255 bytes, paths over 1,024 bytes, case and NFC twins and
  the reserved paths `_mw/`, `.mw/`, `ws/`, `mw-sw.js`; a non-NFC name is published under its NFC spelling
  (torrent and deploy copy); Windows-reserved characters only warn; dot paths follow an explicit table
  (`.well-known/` stays on the host, VCS data, `.env`, credentials and tooling are never published, any other
  dot path is dropped unless `--include-dot <path>`), and every dropped path is listed with its reason (output
  and `summary.json` `dropped`). (E2) budget gates with a printed size report: files warn at 5,000 and fail
  above 20,000 (`--max-files`), the `.torrent` warns at 1 MB and fails above the loader's 8 MiB cap (or above
  10 MB without `xs=`), a shell site above the desktop cap fails (drop-in warns), the largest file is checked
  against host profiles (Cloudflare Pages 25 MiB, GitHub Pages, S3/R2/B2). (E3) the secrets and personal-data
  lint refuses key, token, dump and backup files and private keys or tokens inside files (`--allow-secret
  <path>` after checking), and a raw WordPress export with commenter e-mail or IP addresses; `--from-wxr
  <export.xml>` imports approved comments as plain text into `comments/<slug>.json` and prints what it dropped
  (e-mail and IP addresses, unapproved, spam and trashed comments, pingbacks, comments of unpublished posts).
  (E4) the `.torrent` creation date is an input (`--date`, else `SOURCE_DATE_EPOCH`, else the git commit time,
  else none) and `--double-pack` packs twice and fails on any difference. (F4) `--policy open` without `--ct`
  (abuse and legal contact) warns; `--ct`, `--lg` and `--aud` go into the signed pointer (`--aud` is a comma
list of the §4 tokens: `general`, and the gate tokens `kids`, `sensitive`, `personal`, `eea`, `eu`, `uk`, `qc`,
`quebec`; unknown tokens are refused). `summary.json` names `rendezvousBtih`, the ledger's rendezvous
infohash (B2; `anchorBtih` stays one release as a deprecated alias with the same value), so `tracker.mjs
--allow summary.json` admits the ledger swarm. (B4) `--verify-ws`
  runs the seed mode of the verification gate (below) and `--verify-host <url>` (drop-in) its host mode; both
  withhold every pointer output on failure. (D4) the injected runtime tag carries `data-cfasync="false"`, and the
  report prints the measured CSP additions. (E5) a drop-in report states the egress multiplier with the copy size
  (`egressNote`: each unmetered visitor completes the whole copy from the host once). (F7) `<out>/sdk-static.js` is the static `/_mw/sdk.js` stub for a
  plain copy of the site or after the runtime is removed. (A3) `publish.mjs --withdraw --scope <host> --key
  owner.jwk [--why <reason>] [--ct <url>]` writes a signed `st=withdrawn` record (`pointer.txt`, `meta.html`,
  `dns.txt`, `summary.json`; `tools/withdraw.mjs`): publish it wherever the pointer lives (the shell's
  `<meta>`, every stamped drop-in page, the `_magnet` TXT record).
- `tracker.mjs [--port 8000] [--interval 120000] [--allow <btih|file>]... [--open] [--tls cert key]`:
  WebSocket tracker; refuses to start without `--allow` unless `--open`. **v0.2.1:** an allow file's
  `rendezvousBtih` (and the deprecated `anchorBtih`) are admitted; `createTracker()` tracks the live WebSockets
  (`close()` ends them; `dropConnections()` simulates a tracker blip for tests).
- `dev-server.mjs [--root dist] [--port 8080] [--host 127.0.0.1] [--tls] [--webseed <dir>] [--pointer "<record>"] [--dev]`:
  SPA fallback, correct MIME, `Cache-Control: no-cache` for `/mw-sw.js` and HTML, `/ws/` web seed with
  OPTIONS/CORS/Range, `--pointer` injects the `<meta>`, `--dev` relaxes the CSP for `ws://127.0.0.1:*`,
  `ws://localhost:*`, `wss://<lan-ip>:*`; `--tls` uses mkcert certificates if present. **v0.2.1:** a root without
  `/_mw/sdk.js` gets the static SDK stub there (F7); ETags include the inode (two files of equal size and mtime
  never share one).
- `check-webseed.mjs <base> <site.torrent> [--mode seed|origin|host] [--pieces first-last|all|none]
  [--allow-no-preflight]`: **v0.2.1 (B3, B4): the single verification gate**, also used by `publish --verify-ws`,
  `publish --verify-host` and `check-site`. Seed mode (a BEP 19 base, cross-origin): OPTIONS with
  `Access-Control-Request-Headers: range` per file (required unless `--allow-no-preflight`), the stock
  WebTorrent set `cache-control, range, user-agent` probed once and reported; per file a GET sent the way a
  browser sends a Range request (Range, `Accept-Encoding: identity`, Origin; no Cache-Control or User-Agent) that
  must answer 206 with the exact `Content-Range`, one byte, no `Content-Encoding` and `Access-Control-Allow-Origin`
  (a 200 is "Range ignored"); the SHA-1 of the first and the last piece from ranged GETs across the files they
  span (wrong bytes fail); `--xs` URLs fetched with CORS and infohash-checked. Origin mode: a full GET of every
  file at `<origin>/<path>` (drop-in) with every piece hash checked and one Range probe (a 200 is reported, not
  failed: the worker fetches whole files). Host mode: the same with browser `Accept` and `Accept-Encoding`
  headers (catches edge transforms). Verdicts: PASS, PASS-needs-patched-client, PASS-no-preflight,
  FAIL-range-ignored, FAIL-wrong-bytes, FAIL-cors, FAIL. A missing `Access-Control-Expose-Headers` only warns.
- `check-site.mjs <url>`: resolve the pointer (meta and DoH), fetch `xs`, probe the web seed, connect each
  tracker, optional headless load; non-zero exit on any failure (CI/cron health probe). **v0.2.1:** `ws=` gets
  the seed mode of the gate, a drop-in host its host mode (every file, every piece); `--allow-no-preflight`;
  `--full` adds the origin mode over each web seed (a full GET of every file, every piece hashed).
- `snapshot.mjs <url|export.json> --out <file>`: ledger snapshot (gzip JSON) for `cs=`.
- `seed.mjs <site.torrent> <dir>`: Node seeder if `node-datachannel` is installed, else instructions.
- `pin.mjs <url> [--headless]`: keeps the real loader open in Playwright Chromium; logs status every 60 s.
- `demo.mjs [--tls]`: prints its tier (desktop localhost = full mode; phone on the LAN needs `--tls` with
  the mkcert root on the phone, otherwise boot stops with the insecure-context message); builds, publishes
  the example (with `--policy open` so the guestbook works), starts tracker + dev server, seeds from a
  headless page, prints the URL. On the desktop tier it also builds the identity page and serves it on its own
  loopback port (`--idp-port`, default 8081), and the pointer names it (`idp=`), because a write signs in first (R 2.4.1);
  the LAN tier has no identity page (v0.3 verify fix round 2).
- **v0.3 C2 (built), tools of the zero-setup ladder and the pin node** (SZ 3.1.6, 3.2; lanes zero-setup and pin-node; not run against
  a real server or certificate authority, gate rows G-ZS1 to G-ZS4):
  - `ship.mjs <site dir> --ip <a.b.c.d> --to ssh://<user>@<host> --ct <mailto:|https:> [--name <n>] [--key owner.jwk] [--suffix nip.io|sslip.io]
    [--remote-dir /opt/felinar] [--exp <days>] [--policy owner|allow|open] [--bits <n>] [--staging-only] [--dry-run]` (`npx felinar
    ship`): one command from a folder to a site on a
    rented server with no domain. It derives `a-b-c-d.nip.io` from `--ip`; `nameCheck` resolves it in Node, stops with the plain text
    of S2 Z4 when the name answers the block page or another address, and tries sslip.io; makes or reuses the owner key locally and
    **never copies it to the server**; publishes with `--chain <name> --ws https://<name>/ws/ --cs https://<name>/ws/genesis.json
    --tr wss://<name>/tracker --shell --exp 399` (owner decision SZ-3) without the 450-byte DNS warning, because such a name cannot
    carry a TXT record; copies `site/` and `allow/allow.txt` to `<server>/deploy/one-box/`; writes `.env` (`LW_SITE`, and `LW_ACME_CA`
    set to the staging authority first, to production after a staging certificate); runs `docker compose up -d` and `check-site`; and
    prints S2's Z1, Z2, Z3 and Z6 (the re-sign date comes from `--exp`). Every external step is injectable, it names every host
    before it contacts it, and `--dry-run` prints the commands. It starts no tunnel (a tunnel's operator sees all traffic and the name
    changes every run; S2 F13).
  - `name-check.mjs`: `ipName(ip, suffix = 'nip.io')` and `nameCheck({ ip, suffix, resolve4 })` -> `{ ok, name, got, reason: 'ok' | 'blocked' | 'other' | 'nxdomain' }`.
    The service's block-page addresses `64.176.22.9` and `2001:19f0:c800:2315::` mean `blocked` (S2 F3).
  - `publish.mjs`: for a scope that is an IP literal or ends in `.nip.io` or `.sslip.io`, `--chain` defaults to `--name` and the
    450-byte warning reads "This name cannot carry a DNS record; the page tag is the only pointer (expires <date>)."; `--calls`
    turns the feature on for the publish gate as `--chat` does and implies `--chat`, so the site must name its own tracker and STUN
    (MF-44). The setting itself is written by `ledger-admin.mjs cfg --calls off|contacts` and removed by `--clear calls`, validated
    like `--chat`.
  - `dev-server.mjs --tracker-proxy <port>` proxies WebSocket upgrades on `/tracker` to `ws://127.0.0.1:<port>`, so the origin that
    serves the page also carries the tracker (`wss` with `--tls`); `demo.mjs --tls` uses it and prints the phone steps of S2 rung 1.
  - `pin.mjs` gains `--pin-key <jwk file>` (a P-256 key made with `keygen.mjs`; a group- or world-readable file is refused, as for the
    owner key; it prints the public key and the command `node tools/ledger-admin.mjs cfg --pin <pub>`), `--status <file>
    [--status-every 300]` (the signed heartbeat of 8.1.6, written atomically with mode 0644, listing the site torrent and every pinned
    file with `monthBytes` and `monthCap`), `--auto-accept owner` (owner decision SZ-6; files are still never opened or rendered) and
    `--month-cap <bytes>` (uploaded bytes of pinned files per UTC calendar month, counted from the page's progress counters; at the
    cap `window.__mwPinHost.stop` is asked for pinned files and they start again next month; the site torrent always seeds). Two new
    operations on the `__mwPinCall` binding of the pinned page's top frame: `pin.key` (the public key) and `pin.sign` (b64url bytes
    -> b64url signature, refused unless `isPinSignable`). `deploy/pin/Dockerfile` reads `PIN_URL`, `PIN_KEY` (a path in a volume, never
    baked into the image), `PIN_STATUS`, `PIN_MONTH_CAP` and `PIN_AUTO_ACCEPT`.
  - `bin/felinar.mjs` gains the command `ship` (also `npm run ship`). `deploy/one-box/` holds the validated Caddyfile and compose
    change of S2 rung 2a, with a `pin` profile that builds `deploy/pin/Dockerfile`; CI runs `caddy validate` and `docker compose config` on it.
  - `ledger-admin.mjs doors --key owner.jwk --file <ledger.json> --door <host>... | --clear-doors | --show` writes the owner's `_doors`
    item (15.15). `pin.mjs` (C2 integration) starts pinned files as soon as the page offers its pin host, not only after a reload.
- `build.mjs`: esbuild targets `['es2020', 'safari15.4', 'chrome110', 'firefox115']`; outputs
  `dist/index.html`, `dist/404.html`, `dist/mw-sw.js` (classic), `dist/mw-sw-kill.js`, `dist/_mw/boot.js`
  (classic IIFE), `dist/_mw/loader.js` (ESM), `dist/_mw/sdk.js` (ESM), `dist/_mw/mw.js` (ESM, drop-in),
  `dist/_mw/sw-core.js` (classic), `dist/_mw/pow-worker.js` (classic), `dist/_mw/webtorrent.min.js` (copied
  after a syntax gate through esbuild at the target), `dist/_mw/ui.css`, `dist/_mw/manifest.webmanifest`
  (code review round 1: without `protocol_handlers`; the `magnet:` handler stays LATER per DESIGN-REVIEW §3),
  `dist/_mw/icons/icon.svg`, `dist/build.json`. `build.lock.json` pins the sha256 of the vendored bundle and
  the build fails on mismatch; SRI on the two static script tags only. **v0.2.1:** the bundle is patched (B3,
  §1; the lock also pins `patched.sha256` and the patch ids, `build.json` records `patched: true`,
  `patchedSha256`, `patches`); `build.json` `integrity` lists the sha384 of every precached JS and CSS file,
  and `/mw-sw.js` embeds the same map (`self.__INTEGRITY__`, D2); `dist/_mw/sdk-static.js` is the static
  `/_mw/sdk.js` stub (F7, never precached). `npm test` lints `src/` against
  post-floor APIs (`Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, Set methods, `URL.parse`,
  `AbortSignal.any`, iterator helpers, regex `v` flag; code review round 1 added `DecompressionStream`,
  static `Response.json`, `URL.canParse`, constructable stylesheets, `.bytes()`, `for await` over a stream,
  `navigator.userActivation`, popover, `Intl.Segmenter`, `checkVisibility`, `Array.prototype.with`,
  `import.meta.resolve`), and `build.mjs` runs the same rules over the patched vendored bundle (allowed: the
  Uint8Array hex/base64 conversions that `boot.js` and `polyfills.js` install on windows). `.npmrc` has `ignore-scripts=true`.

## 11. Examples and fixtures
- `examples/peer-guestbook/` "Peer Guestbook": published with `--policy open --bits 16`; shows peers, ledger line, how
  the page arrived, identity + name, guestbook (append/tombstone), owner notice (`_notice` key), a moderator
  demo (import moderator key → ban/tombstone), a short MP4 (Range from the SW), `about.html`, root-relative
  URLs and `fetch('/data/about.json')`.
- `examples/existing-site-dropin/`: a multi-page "existing" site with root-relative assets and links, hashed
  asset names, a History-API router page with an SPA fallback route, `fetch('/data.json')`, and a variant
  with its own hand-written Service Worker (for 3.4.4).
- `examples/social/` (v0.3): the hub template of V03-DESIGN-REVIEW Part 3, plain ES modules; every person and every group
  is its own site with its own ledger, and every write goes to the ledger of the page's own origin. It uses the public SDK
  and the hub amendment ([SDK.md](SDK.md)) and nothing else; what it assumes is in its README and
  [deviations/examples.md](deviations/examples.md). Contracts the v0.3 code review fixed there: "Create my page" runs only
  with a hub identity (`ready().identity.mode === 'hub'`), because `mw.hub.createPage()` signs the genesis with the key of
  the address it is called on; a report follows R 3.5 (`mw.report.send` for a post of the group on screen, which reads
  `{ sent }`; the hub's `moderationContact` from `config.json` for a personal page); "Delete my page" tombstones the
  person's list items and deletes the keys they set, and says the name and the address stay until the loader can clear
  and withdraw them. **(proposed)** The hub directory's entry format, which nothing signs yet, because the directory stays off
  pending counsel (R N-7; no lawyer is engaged for 0.3.0): shards
  `/_dir/<first 12 bits of sha256(lowercase name)>.json` of `{ name, ledgerId, pointer, t, sig, hubSig }`; `sig` by the
  pointer's `owner=` key over `"mw-dir-v1\n" + canonical({ ledgerId, name, pointer, t })`, `hubSig` by the key in
  `config.json` `directoryKey` over `"mw-dir-hub-v1\n" + canonical({ ledgerId, name, pointer, sig, t })` (ECDSA P-256 with
  SHA-256, 64-byte base64url signatures; canonical is the JSON with sorted keys and no spaces); an entry is followable
  only when both verify and the pointer names `ledgerId` (`examples/social/js/directory.js`).

## 12. Tests
Unit (`node --test test/unit`): canonical (RFC 8785 vectors), crypto, PoW (low bits, abort), block v1
(every rejection reason; `v`/`vh`; redaction keeps `h`/`s` valid), DAG (1 000 shuffles identical order;
depth; windows; orphans), state (causal policy: owner switches to `writers:'owner'` then a non-owner block
with `prev` at depth 0 is a no-op on 1 000 shuffles; `bits` increase; ban; allow; succession keeps earlier
tombstones; `_` keys; cap), gossip (codec, two-node convergence, loss + reorder, line topology A-B-C relay
within 2 s, bootstrap of an 8 MiB ledger from one peer without banning it, tombstone sync of a `v`-less
block, budgets), pointer v1 (vectors for key case, whitespace, unknown key appended after signing, `;` in
a percent-encoded URL, IDN scope, expired fresh vs cached, seq rollback across rotation, `rot`), DoH
(fixtures per resolver, edns param, TTL cache), bencode/torrent-file (round trip, info hash, piece math
with pad files), chunk stores (piece math across files, verification refusal), SW lib (MIME, Range incl.
`bytes=0-1`, suffix, 416; routing manifest; `owns()`), tools (publish determinism, dns.txt chunking,
genesis block, dropin stamping), the message-length patch point grep on the bundle, the post-floor lint.
**v0.2.1 golden vectors (A2):** `test/vectors/pointer.json` (MW-PTR/1: signing input, canonical format,
verification results incl. withdrawn and unknown `st`, ledger id, size), `test/vectors/block.json` (salted
value hashes; valid genesis, salted payload, stub, tombstone; wrong salt, value without salt, reserved op,
untagged author) and `test/vectors/hello.json` (HELLO frame bytes, untagged owner refused). They are
**append only**: `test/vectors/LOCK.json` chains the hash of every vector in the order added and
`test/unit/formats-vectors.test.mjs` freezes the chain head, so editing, removing or forgetting to lock a
vector fails the suite.
E2E (`node test/e2e/run.mjs`, Playwright Chromium with the mDNS flag; WebKit where noted): (1) shell renders
the example from a seeder tab (heading, CSS, image, `fetch`, MP4 range); (2) second tab appends a guestbook
entry → first tab within 10 s, equal `root`; (3) close the seeder, reload → instant render from cache; a
third tab downloads from the second alone; a flipped byte in IndexedDB → network/redownload and
`deleteSite`; (4) moderator tombstone from a browser that never held `owner.jwk` hides the entry in all
tabs; (5) offline reload renders shell and site; (6) per-domain simulation with `--pointer` (unsigned and
signed) and no DoH; (7) cold start with no seeder through `xs` + `ws` within 3 s, `source === 'webseed'`;
(8) hub gate: no WebSocket before the click; (9) kill switch restores host serving; (10) drop-in fixture:
JS-off parity, second view from IndexedDB, foreign SW untouched, `location.pathname` correct; (11,
**v0.2.1 B5**) a peer declaring a `0x7FFFFFFF`-byte message (not "4 GiB": `0xFFFFFFFF`+ read as keep-alives
by the stock parser) is dropped within 1 s before buffering; (12) uploads off: peer download, web-seed download and
two-way gossip still complete; (13) publish `seq+1` → old btih gone from IndexedDB and announces; (14)
WebKit completes a download with the polyfills; a context with `serviceWorkers: 'block'` renders styled
with `mw.ready()` resolving. **v0.2.1 (serving and publishing, `test/e2e/scenarios-serving.mjs`):** (SW-INSTALL)
a new `/mw-sw.js` whose integrity for `/_mw/loader.js` does not match the host fails its install, leaves no
cache behind and the worker in control keeps its build, then a consistent update takes over; (PUBLISH-WS) a
cold start from a cross-origin web seed that answers every OPTIONS with 405 completes from the web seed with
zero preflights (the patched bundle), and the gate reports FAIL-cors strictly and PASS-no-preflight with
`--allow-no-preflight`. Unit level: the navigation deadline, the reload-loop guard, the 40 ms cold-start
wait, no-store pages, the web-seed rewrite rules, the protocol module, the B3 patch and lock, the verification
gate's three modes, and every publishing rule (`test/unit/tools-publish-v021.test.mjs`).
**v0.2.1 (network, `test/e2e/peer-scenarios.mjs`):** (PEER-CONSENT) no WebSocket, peer connection or STUN
probe before a choice; "Load from host only" keeps it so; the versioned record per origin; "Share and load"
starts them (C1). (PEER-11) a real peer writing a `0x7FFFFFFF` length prefix is dropped within 1 s and the
visitor keeps working (B5). (PEER-RV) two site versions of one ledger meet in the rendezvous swarm (every
announce `left: 1`) and exchange a post there (B2). (PEER-BLIP) the tracker drops every socket; both visitors
re-announce within seconds, not minutes (B1; code review round 1: the shim waits 500 ms plus up to 1 s of
jitter, the test accepts up to 6 s, and runs measured 1.5 to 1.6 s). (PEER-WS) a web seed that serves wrong bytes is stopped after
3 failures with a visible message and no hot loop; the copy then comes from a peer (B4). Unit level
(`test/unit/loader-app-{policy,connectivity,consent,arrival}.test.mjs`, `loader-app-torrent.test.mjs`): the
four-class classifier and caps, the STUN probe and offer timeout, the versioned consent record and
no-DoH-before-consent, `parseFragment` arrival safety, the tracker shim and keepalive, the wire guard and
`_bufferSize` watchdog, the web-seed breaker, and the rendezvous swarm.
**v0.2.1 (verifier):** PEER-BLIP drops the tracker's WebSockets for real (`dropConnections()`) after both visitors
announced both swarms, and requires both swarms of both visitors to re-announce; PEER-CONSENT checks that a
script click on "Share and load" decides nothing; 10B clicks the drop-in card's "Share and load" and checks
its same-layer refusal and the versioned record. `test/unit/loader-app-tracker-shim.test.mjs` runs the real
bittorrent-tracker client against a local tracker (the pooled-socket reconnect and the interval restart);
`test/unit/v021-integration.test.mjs` covers the cross-module contracts (publish `--aud` against the consent
rule, `rendezvousBtih`, versions, the shell click guard, consent waiters, the tools' consent labels).
Release gate (manual, `docs/DEMO-RESULTS.md`): a real domain with a `_magnet` TXT record; iPhone iOS 18.x
and one iOS 16/17 device; Android Chrome on LTE; Samsung Internet; Firefox normal and private; Brave Shields
aggressive; Edge sleeping tabs; LTE phone ↔ home-Wi‑Fi laptop connect rate both ways; cold start; update
flow; key-change prompt; kill switch; drop-in fixture; 7-day persistence on iOS. No "production-ready" claim
until it passes.

## 13. Security requirements (summary; threat model in docs/SECURITY-MODEL.md)
- Content integrity protects the files against tampering by peers, not by the host: the static host is
  the trust root on every visit, including SW updates; SRI on the two static script tags is defence in
  depth only. Per-file verification before serve/upload (§7.3).
- Shell CSP (inserted by `boot.js`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  connect-src 'self' https: wss:; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self';
  worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'` (dev adds `ws://127.0.0.1:*
  ws://localhost:* wss://<lan-ip>:*`; degraded variant per §7.4). Framing headers per §7.1.
- Transport message length cap of 256 KiB on every wire; `wire.setTimeout(60000, true)`,
  `wire.setKeepAlive(true)`; wire count cap; gossip frame cap 15 KiB; per-peer budgets; orphan pools.
- Pointer trust: owner signature, TOFU pin, `seq` rollback refusal, required `exp`, `rot` for silent
  rotation, `<meta>` as primary bootstrap, DoH only as the update channel, DNSSEC `AD` surfaced.
- Trackers scoped to the signed `tr` list (`private: true` per add); defaults only for unsigned pointers.
- No owner key in browsers; moderators instead; the ledger id binds the owner key.
- Privacy and consent per §8; no analytics, no third-party scripts; hub shared origin never claims isolation.
- Supply chain: `.npmrc ignore-scripts`, `build.lock.json`, immutable versioned assets, kill switch.
  **v0.2.1:** the vendored bundle is shipped patched only through hash-asserted patch points (B3) and pinned
  twice (stock and patched sha256); the worker installs only a precache whose JS and CSS match the build's
  sha384 values (D2), which protects consistency (a mixed deploy, a stale CDN copy), not against a hostile
  host; `publish` refuses secrets and personal data before anything enters a torrent (E3).

## 14. Deviations and open items
Record deviations in `docs/deviations/<agent>.md`. Items the editor could not verify (DESIGN-REVIEW §6)
stay open until the release gate on real devices (code review round 1: the integration tests do not settle
them, and Firefox does not launch in this environment): Safari `resultingClientId`, first-visit iframe
control in Firefox and WebKit, the iOS `DataCloneError` path. **v0.2.1 (B2)**: the metadata-less-wire open item is closed: the
ledger rendezvous swarm is a bare infohash (the one-piece anchor torrent fallback is removed), and PEER-RV
confirms two site versions meet and gossip there on Playwright Chromium. Real-device behaviour (iOS suspend
timing, the connectivity-probe classes on a real phone, the fast-reconnect shim across background/foreground)
stays on the manual release gate.
**v0.2.1 open items after verification** (`docs/deviations/harden-verify.md`): Firefox was not launchable
here, so D1 (navigation deadline, keep-alive) is unit-tested and Chromium-tested only; the floor browsers'
treatment of a simple `Range` request header (CORS-safelisted or not) is unmeasured, so the gate requires the
range preflight by default; the CI double-pack step (E4) and the documentation items (E5 in README and
DEPLOY, F1 to F6) belong to the documentation and CI waves.

## 15. v0.3: identity, sign-in for any site, records, chat, files, private media

> **v0.3, built (final integration, 2026-10-20).** This section records the contracts of the v0.3 design review
> ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R" with its section numbers). All twelve build lanes
> landed; their recorded contract changes are folded in below as "Wave 1 build" items and in 15.13 ("Final integration"),
> with the details in [deviations/integration-v03.md](deviations/integration-v03.md). A subsection or item marked
> **(proposed)** describes something that is not built yet and says why; everything else describes the code in the tree
> and is normative. The review round of R Part 5 (the six judges, the eight red-team attackers and two conformance agents
> against the built v0.3 and C2 code) ran from 2026-10-22 to 2026-10-24 (R 5.4,
> [deviations/review-round.md](deviations/review-round.md)); the contracts its fixes changed are 15.20. None of the
> real-device gate rows (R 4.3, `docs/DEMO-RESULTS.md`) has run, and the independent audit of R 2.19 has not happened: this
> is the specification of the v0.3 code, not a claim that it is safe. Where it conflicts with sections 1 to 14, this section
> governs the v0.3 code. Wording: "no backend", "site ledger"; "chosen" marks a design parameter a gate row confirms or tunes.
>
> **v0.3 C2, built and reviewed in the review round (R 5.4).** Section 8.1 (smart seeding), 15.14 (calls), 15.15 (doors), the owner decisions SZ-1 to SZ-6 at the end
> of 15.11, and the notes in sections 4 and 10 (the nip.io and sslip.io DNS-over-HTTPS skip, `ship`, the pin flags) are the phase C2
> specification from [research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ") and its inputs S1 to S4 in the
> same folder. The eight C2 lanes built it and the C2 integration of 2026-10-20 (15.16, [deviations/integration-c2.md](deviations/integration-c2.md))
> joined it to the v0.3 code; what is still not built keeps the mark **(proposed)** in place. No C2 gate row has run on a real device or
> network, and the owner decisions are unsigned. Owner decision, 2026-10-20: **browser only**. There is no native app,
> desktop keeper or extension for members, an installed web app counts as the browser, and the owner's or a hub's pin node is infrastructure
> beside the static host and the tracker.

### 15.1 Identity origin and key labels (R 2.1, 2.2; v0.3)
- One **identity origin (IdO)** per person (the static bundle of the release, `felinar-<version>-idp.zip`, served by
  whoever runs it; by design the project hosts none, owner decision N-2, decided for 0.3.0; an extension build later). It is used only as a top-level window (popup, or a redirect round trip), sends
  `frame-ancestors 'none'`, and its CSP is `script-src 'self' 'wasm-unsafe-eval'`. It holds the root
  (16 bytes, 12 BIP-39 words, optional extra passphrase) wrapped by a passkey PRF for its own RP ID or by a
  passphrase (Argon2id m = 64 MiB, t = 3, p = 1; PBKDF2-SHA-256 600,000 iterations where WebAssembly is
  unavailable, named on the card), and a vault of random per-label keys (chat epochs, record keys, own-media
  key, `K_local`) wrapped by the PRF key and by the backup-file key, never by a key derived from the phrase alone.
- **No site origin ever holds the root, the phrase, the PRF output, the vault key or another label's keys.**
  A site origin receives only the working keys of its label through an ECIES bundle posted to the verified
  opener's `event.origin`.
- **Labels:** `o|<event.origin>` by default; `l|<ledgerId>` only when the IdO verifies the site's signed pointer,
  its lineage (`owner == lo` or a verified `rot=` chain) and that `event.origin` is the pointer's host or in its
  `org=` list; `h|<hub suffix>` when the person opted into hub scope on a hub of the IdO's built-in hub list (15.18); a
  linked label when the person chose "same identity". Shared-origin hubs (the IdO's built-in list) get "this visit only".
- Derivation: `labelSeed = HKDF(root*, "mw/id/v2", "seed|" + label)`; `signKey = scalar(HKDF(labelSeed,
  "sign|" + i, 48))`; `recoverKey = scalar(HKDF(root*, "recover|" + label, 48))`, never leaving the IdO.
  Vectors `test/vectors/identity.json`.
- **Wave 1 build (lane idcore, [deviations/idcore.md](deviations/idcore.md)):** `root* = HKDF(ikm, salt "mw/id/v2", info "", 32)`,
  the per-key HKDFs use an empty salt (the vectors pin both); the extra word is NFKD-normalised, wrapping passphrases NFC.
  The public point of a derived scalar comes from `src/identity/p256.js` (BigInt, not constant time, run only at the IdO;
  signing stays in WebCrypto) instead of `@noble/curves`, which is not installed. Argon2id is plain JavaScript (RFC 9106
  vector matches), measured 1.3 to 2.5 s at 64 MiB on an M3 (Node, Chromium, WebKit), against about 0.1 s assumed for
  WebAssembly: that code needs no `'wasm-unsafe-eval'`, and the passphrase card says unlocking takes a few seconds; a
  WebAssembly build can replace it behind the same `argon2id()` call. `labelFor` is async and takes the pointer verifier and
  the public-suffix check from the IdO. The backup file is `{ type: 'mw-identity', v: 3, kdf, params, salt, iv, ct }` with a
  passphrase floor of 12 characters and about 60 bits.

### 15.2 Sign-in for any site (R 2.3; v0.3)
- Format **`mw-signin-v1`**: the IdO signs `c = { v: 1, t: 'mw-signin', domain, origin, ledger | null, pub,
  keyMode, nonce, statement, resources, iat, nbf, exp, requestId, idp, build }` as raw P1363 ECDSA P-256 over
  `"mw-signin-v1\n" + JCS(c)` (RFC 8785). `domain`, `origin`, `ledger`, `pub`, `keyMode` come from the IdO,
  never from the page; `exp - iat` at most 300,000 ms; purpose `server` requires a verifier nonce. Vectors
  `test/vectors/signin.json`.
- **`@felinar/verify`** (Node 22 and browsers, zero dependencies): `createVerifier({ origin, ledger,
  allowKeyModes, allowIdps, maxAgeMs, maxSkewMs, nonces, now }).verify(proof)`; checks cheap first, consumes the
  nonce atomically, returns the verified object, never roles.
- Flows: felinar sites (keys and proofs), any existing site through the self-hosted SRI drop-in widget
  (`/_mw/signin.js`), server-backed sites (challenge, proof, verify). Pages must not send
  `Cross-Origin-Opener-Policy: same-origin` (use `same-origin-allow-popups`).
- **Wave 1 build (lanes idcore and ui):** the page posts the proof text (its JSON) to its server, so the verifier also refuses
  duplicate keys; `<mw-signin>` does (integration I-2, e2e E-SI-1). The verifier checks shape, statement, origin, domain, ledger,
  key mode, IdO, lifetime and clock before it consumes the nonce, then the signature; a nonce store has
  `put(nonce, exp, meta)`, `consume` (true, the issued meta, `'used'` or false) and `markUsed` for stateless nonces
  (`t || r || HMAC[:16]` under `"mw-nonce-v1|" + origin`). A local proof is `{ c: { v: 1, t: 'mw-local', origin, pub, epoch, nonce,
  iat, exp }, alg, sig }` over `"mw-local-v1\n" + JCS(c)`; a server refuses it (`version`, e2e E-SI-3).

### 15.3 Sessions and peer authentication (R 2.4; v0.3)
- States `guest` and `signed-in`. Sign out deletes the label's working keys; "Stay signed in" keeps them
  non-extractable in IndexedDB; "Shared computer" keeps them in memory. Local proofs at most 15 minutes, in-tab.
- `mw_chat1` wires begin with a Noise XX handshake (P-256, HKDF-SHA-256, AES-256-GCM, chat keys as static keys,
  prologue `"mw-wire-v1" || ledgerId`); the peer id is never an identity.

### 15.4 Ledger freeze group (R 2.5.3, 2.10; v0.3)
Adopted together before any public ledger exists; until a peer runs that release they are `unknown-op`
(section 6.1 rule unchanged):
```
{ t:'unban', author }                                  owner; or moderator when every effective ban was a moderator's
{ t:'ban', author, until? }                            until: ms; the ban governs blocks with ts < until
{ t:'keyinfo', rc }                                    the key itself, if it may write, as its first word here (15.17); not redactable
{ t:'rotate', from, next, by:'self'|'recover', rp?, rsig? }   recover overrides self in any order; lowest (depth,h) among recovers;
                                                        next inherits bans and allow membership, never moderator or owner standing;
                                                        a revocation of from (15.17); bans cover the rotation family both ways
{ t:'checkpoint', heads:[<=32], snap, n, bytes }       owner; copies holding S (verified by snap) may drop the causal past
{ t:'tombstone', authors:[<=64], before }              bulk form, moderator or owner
Policy += { modAllowPerDay = 20, modActionsPerHour = 60, reservedPool = 25 (percent), voided: [{ author, after }] (<= 50) }
State rules: moderator tombstones of owner-standing payload have no effect; '@<16 chars of b64url(sha256(author))>/' put
keys take effect only from that author; moderator allow additions beyond modAllowPerDay have no effect.
Admit and node rules: reserved byte pool for unvetted authors; moderator tombstone values deleted after 24 h (not P0).
Pointer (unknown keys are already kept and signed): org= (<= 4), nx=<sha256 of the next owner key>, ml=<min loader>, idp=.
```
`vanish` and `grp` stay reserved. Schemas of `mw.*` lists and `_mw.*` keys (R 2.10.2) are state rules: a
non-matching item is hidden; its block stays valid, stored and relayed. Built as (review round, 15.20): a self rotation carries
an optional `nsig` and links `next` only with it; moderator caps also count per checkpoint epoch; a moderator acts only with its
appointment in its causal past; moderator bans and bulk tombstones keep values for the grace; owner-written `_` entries are
protected from moderators' puts; every author has a lifetime block cap.

**Wave 1 build (lanes freeze and harden-loader; [deviations/freeze.md](deviations/freeze.md),
[deviations/harden-loader.md](deviations/harden-loader.md)).** Validity stays a function of `e`; the only new validity checks are
shapes and the rotate `rsig` over `rotateSigningInput(ledgerId, from, next)` (`"mw-rotate-v1\n"`). Decided where R left a detail:
- A `checkpoint` without `heads` stays the reserved v0.2.1 form (`unknown-op`; locked vector blk-007); with heads it is exactly
  `{ t, heads, snap, n, bytes }`: `n` the cumulative covered count, `bytes = byteLength(canonical(S))`, `S = { v: 1, covered, state }`.
  Once in effect every covered block is in the causal past of every uncovered block, uncovered blocks are ordered by
  (relative depth, h), moderator caps restart and covered control effects stand, so full, pruned and `reduceFromCheckpoint`
  copies agree. A checkpoint is ignored while its covered set has an owner conflict.
- `unban` lifts the bans in its causal past for blocks in its future (owner: any; moderator: moderator bans only). `ban.until`:
  the longest unlifted ban governs. The first `keyinfo` per author wins (since the v0.3 code review: only as the key's first word,
  15.17) and bans never remove it. Recover beats self in either
  order, the lowest (depth, h) recover wins, `next` inherits bans and allow membership transitively, never moderator or owner
  standing; `@`-scoped keys stay with the old key. `voided` never touches blocks with owner standing. A moderator allow that
  removes has no effect (admit refuses it); day and hour caps count in total order. A bulk tombstone needs `before` in its causal
  past and hides strictly later blocks. Items keep `{ h, author, ts, v }`; owner standing is `state.ownerWritten`.
- Measured: a 4,096-byte block holds at most 39 bulk-tombstone authors and 20 `voided` entries, so `maxBlockBytes` binds before
  the 64 and 50 caps; reduce of 5,000 blocks takes a median 1.7 ms (Node 24, M3).
- Pointer: `rot=` v1 is deleted (frozen vector ptr-010 now verifies `owner-changed`; ptr-023 supersedes it). `nx=` is sticky under
  one owner: a same-owner record with another or no `nx=` is refused `nx-changed` (otherwise a thief with the current key
  re-commits, then rotates); a record whose owner matches the previous `nx=` rotates without `rot=`. Withdrawals carry `nx=`.

### 15.5 Sealed items (R 2.6; v0.3)
`append('mw.s', { enc: 'mw-seal-v1', iv, ct, hint? })`, plaintext exactly 1,024 bytes (kind, ver, seq,
count, len, data, padding), AES-256-GCM, AAD `"mw-seal-v1\n" + ledgerId + "\n" + authorPub`, random IV;
kinds rec-index, rec-data, media-own, grant, join; at most 32 effective per author and one synced update an
hour (SDK convention). Value about 1,450 bytes; accounted cost 1,877 bytes at one parent (measured, judge DS).
**Wave 1 build:** the freeze schema accepts exactly 1,040 bytes of ciphertext, for every kind. Kinds 4 and 5 therefore use the chat
lane's sealed box with the sender's chat key as the ephemeral (epk = the sender's key, which the recipient already needs for
the hint), not a fresh ephemeral packed into `ct` (1,105 bytes, hidden by every v0.3 reducer; integration I-4, unit-tested).
`src/identity/sealed.js` reads any `ct` of at least 1,024 bytes, but the reducer hides other sizes before a reader sees them.
**(proposed)** Durable grants (kind 4 items read back by `hintFor` and the chat box): no lane was given the reader, so no module reads them yet, and
`media.share({ durable: true })` sends the grant over chat only (the v0.3 reconciliation, R-9).

### 15.6 Chat lane (R 2.7; v0.3, built in `src/chat`)
- `mw_chat1` on rendezvous wires; a separate lane `sha1("mw-chat1|" + ledgerId)` only when fewer than 2
  rendezvous neighbours speak it; group lanes and private media swarms are never announced to the public
  default trackers; chat and files require the site's own tracker and STUN.
- Frames: 14-byte clear header `type | version | hop | flags | day | stampNonce`; `frameId` excludes `hop`;
  relay stamp `leadingZeroBits(SHA-256("mw-relay-v1" | frameId | stampNonce)) >= bits` (10 for contacts, the
  recipient's `chatBits` for strangers, default 20); types HELLO, XX handshake, ENV, ROOM, WANT-TAGS (prefixes),
  HELD, CK, HOLDING, COLLECTED, PRES, SIG, INBOX-CHAL/RESP, each with stated bounds; frames at most 16,384 bytes.
- DMs: deniable sealed box keyed by `K_pair` (static-static ECDH) and an ephemeral ECDH; buckets 256, 1,024,
  4,096, 16,000 bytes (frames 371, 1,139, 4,211, 16,115 bytes). Rooms are signed. Groups use an `epochId`
  chain with signed admin lists and rekey on add and removal. Concurrent rekeys (code review v0.3): removals win (a
  child whose creator a known epoch below its parent removed is refused, or stops counting when the removal arrives
  later), a sibling is accepted only while its parent is current or within 7 days of its replacement, the rank is the
  largest removal set, then SHA-256(prev | creator) (a creator cannot grind it), and members apply the union of removals
  at once (incoming group frames, group members for shares and calls); under a replaced epoch only messages written before
  the replacement count. Every epoch of the grace window survives a reload.
- Delivery after a reload or days offline (code review v0.3): the sealed chat store keeps the contacts' CK records (until
  `exp`) and the ids this device delivered (a copy refused as a replay gets its ACK again); held mail keeps the day it
  was stamped on and is accepted from HELD for the 7 days of the hold; the interest follows the UTC day in long-lived
  tabs; a message is sealed once per UTC day, so holders keep it once; HOLDING counts once per neighbour wire.
- Chat-key records (`CK`) are off-ledger frames cached by peers; a ledger copy (`mw.ck`) is opt-in.
- Built with recorded deviations ([deviations/chat.md](deviations/chat.md)), among them: stranger frames are keyed by the
  ephemeral ECDH alone and authenticated by an HMAC under `K_pair` inside (the recipient cannot compute `K_pair` before
  it reads the sender's CK); Noise XX uses 65-byte SEC1 keys with the x coordinate as DH output; group signatures and
  presence signatures use newline separators and new prefixes (`mw-grp-admin-v1`, `mw-grp-commit-v1`, `mw-pres-v1`);
  HOLDING carries the conversation tag for routing back. New cryptographic code: not called secure before R 2.19.

### 15.7 Files and private media (R 2.8, 2.9; v0.3)
- Reserved worker routes `/_mw/f/<ref>` (attachment, octet-stream, `nosniff`, `sandbox` CSP, CORP same-origin,
  never the extension map) and `/_mw/media/<sid>` (Range: 206 and 416; several ranges 200), routed before the
  navigation catch-all; added to the reserved paths of section 3.1.
- File torrents: one file, length equal to the listing, 16 KiB to 4 MiB pieces, at most 16,384 pieces, no
  pad files or paths, `.torrent` at most 256 KiB; stored in a writable IndexedDB chunk store; retained across
  `rebuild()`.
- Private media: per-item random `fk`, `fid`, `base`, `x-mw-nonce`; chunk i = AES-256-GCM(fk, base || i,
  P - 16 bytes, AAD `"mw-media-v1" || fid || 0x01 || i || total || region`) of exactly one piece P (256 KiB at or
  above 2 MiB padded size, else 64 KiB); padded to 2^k x (1 + j/8) buckets. Keys held by the worker for the
  session; never returned by the SDK. Vectors `test/vectors/media.json`.
- Upload pipeline: sniff, metadata removal (image re-encoding; MP4, MOV and WebM box removal), faststart,
  on-device poster, encryption, padding, torrent.
- Code review v0.3: MP4 and MOV removal also zeroes the samples of timed metadata and subtitle tracks (gpmd, camm, mett,
  mebx, tx3g) and frees their `trak`; image removal falls back to `createImageBitmap` without options and then an `<img>`
  (24-megapixel cap) before "Upload anyway"; video posters play the muted inline video for a frame. Manifests name only
  allow-listed media types of their kind, and the Blob fallback is typed only when the decrypted bytes sniff as that
  type. Own items and accepted grants keep `M` and `fk` in the working keys' sealed per-origin cache (`src/media/vault.js`,
  the store chat already uses) until the identity-origin vault holds file keys (R 2.9.4, MF-72); private file keys too.
- **Wave 1 build (lane media, [deviations/media.md](deviations/media.md)):** the manifest gains `plen` and `pmime` (the poster's
  bytes and type); region bytes are poster 0x01, media 0x02, pad 0x03, and `regions` are half-open chunk ranges. Route ids are
  128-bit session ids (`/_mw/f/<sid>` too), registered with `mw-session-register { sid, kind, exp, M?, fk?, file? }` on a private
  port (`mw-chunk-need` / `mw-chunk`), closed with `mw-session-close`; a worker that lost a session (it was stopped) broadcasts
  `mw-session-lost`, waits 3 s (chosen) for the page to register it again, else answers 410 (e2e E-MD-7). `GET /_mw/idp-return`
  is reserved too; worker-built navigations carry COOP `same-origin-allow-popups` (a routing manifest's COOP wins) and
  `Referrer-Policy: no-referrer`. Private files use F2 STREAM records of 65,536 bytes, AAD prefix `mw-file-v1`. `stripMp4`
  turns `udta`, `meta` and XMP `uuid` boxes into `free` boxes of the same length. Owners block a sniffed tier with
  `_mw.cfg.blockTiers` (in the readers' schema since the v0.3 code review, 15.17; `ledger-admin cfg --block-tiers`). The file-torrent handle offers the surface the lanes call (`on('verified')`, `metadata()`,
  `prioritize`, `stopSeeding`, `destroy`; integration I-3): before it, deleted, revoked and unshared items kept seeding.
- Measured in the wave 1 e2e (loopback only, Apple M3, Chromium 156 and WebKit 27.2, 2026-10-20): the whole upload pipeline (strip,
  faststart, poster, encryption, IndexedDB store, own-index item) took 252 to 334 ms for the 20 MiB reference MP4 in four Chromium
  runs and 326 to 463 ms in three WebKit runs; it pads to 88 pieces of 256 KiB = 23,068,672 bytes, as R 2.9.5 computes. Through the
  worker the first frame came after 3 to 44 ms and seeks after 10 to 148 ms (210 ms when the seek restarted the worker). One seek made the worker read up to 353 chunks of a 79-chunk item: the worker keeps no chunk
  cache and the browser issues overlapping Range requests. A candidate optimisation, to measure on phones (G-MD-1, G-MD-4).

### 15.8 Hub follow lane (R 3.2.2; v0.3)
`mw_chain2` on `sha1("mw-hub-lane1|" + hubSuffix + "|" + shard)`: `mw_chain1` frames with a `ledger` field,
plus `RECENT { ledger, fromDepth }` and `HAVE { ledgers }`; at most 4 ledgers syncing at once per tab; recent
windows of 200 posts plus control blocks. The loader joins the lane on the personal pointer's own tracker, holds the
member's own ledger in full, and runs `MultiGossip.tick()` once a second and `setHidden()` with the page's visibility
(final integration, 15.13; e2e E-SO-2). **(proposed)** The first screen from the hub's recent-window `cs=` snapshots
(`loadRecentSnapshot`; E-SO-6): not specified yet, because nothing says where a followed ledger's window is published and
found (a personal pointer carries no `cs=`; [deviations/rows-social.md](deviations/rows-social.md), C-1). A page's own `cs=`
may already be a `recent-v1` window (`snapshot.mjs --recent-out`), which the loader applies as it applies any snapshot (e2e
E-SO-6, partial). **(proposed)** Shard counts above 1: no lane built them. Built as (review round, SCALE-6): the lane is a
swarm kind of its own, `'hub'`, with its own cap, a floor of 1 and first place in the wire budget while it syncs
(`src/loader/torrent.js:93`, `src/loader/policy.js` `withHub`, `MultiGossip.syncing`); the loader joins it with that kind
(`src/loader/app.js` `joinHubLane`).
Since the v0.3 code review (15.17) a follower's view keeps only blocks with an effect (a lane peer is anyone in the hub swarm),
credits and strikes the peer by what it kept, and a RECENT answer cut to the block cap says `truncated`.

### 15.9 SDK v0.3 (R 2.11; v0.3)
`SDK_VERSION = '0.3.0'`; namespaces `auth`, `identity`, `me`, `db` (author-scoped helpers), `mod` (UI-gated),
`chat`, `files`, `media`, `report`. The A4 rule extends to keys, playback keys, links and the sign-in origin;
`LOADER_ONLY_METHODS` = `identity.export`, `identity.import`, `identity.root`, `consent.accept`, `link.accept`,
`keys.export`, `media.key`.

### 15.10 Policy and storage (R 2.7.1, 2.8.8, 3.2.3; v0.3)
One wire budget per tab across every swarm (desktop 40, phones 8, chosen), priority site > rendezvous > chat >
open group > files; ledgers counted in the storage budget (64 MiB phones, 256 MiB desktop, chosen); files at
most half of what remains after the site and its ledger. Built as (review round, SCALE-6): the hub follow lane is a swarm kind
of its own, after rendezvous and before chat (`SWARM_PRIORITY` in `src/loader/policy.js:327`), with a floor of 1, and first of
all while it syncs (`withHub`).
**Wave 1 build (lane harden-loader):** floors site 2, rendezvous 2, chat, group and file 1; caps count wires, not peer ids
(`tm.peers` still counts ids); eviction among equal scores is random; anchors keep at most half of a swarm's hard cap;
`ignoreWire` closes the wire and never bans the self-declared peer id; a 'no-progress' event after 60 s, doubling to 15 min.
The R 2.16.4 loader hardening (signed pins, expiring refusals, TTL clamps, read-only ownerless hub ledgers, rotation delay,
`ml=` floor) ships as tested helpers in `src/loader/harden.js` and is live once lane sdk wires `app.js`.

### 15.11 Amendments to earlier sections (v0.3)
Section 2: TURN moves from a non-goal to an owner option, off by default (R 2.7.8; `_mw.cfg.turn`, `publish --turn`). Section
6.2: for the personal-site class only, the person's key is the genesis owner and owner ops run in the browser behind the
IdO card (R 3.3; e2e E-SO-1). Section 8 B7: TURN as above. Section 9: the v0.3 SDK. Section 13: the IdO CSP, the media and
file route headers, COOP for loader pages, the self-hosted SRI widget (e2e E-SI-1W). **(proposed)** The kill switch's purge
mode (R SC-6, SC-8) is not built: no lane was given it (R 5.4 residuals).

**v0.3 C2: owner decisions (SZ-1 to SZ-6).** The questions of [SZ](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) section 6.
SZ-3 is decided (2026-10-25, the independence design: [deviations/independence-design-docs.md](deviations/independence-design-docs.md));
the other five are not signed. The C2 build ships each open one behind a flag or a default that keeps today's behaviour, so the
code decides nothing for the owner; the third column says what the build does until the owner signs.

| Id | Question | The build does, until signed | Where |
|---|---|---|---|
| SZ-1 | Phones run K and E by default in the one provable case (Chromium, Wi-Fi by `connection.type`, charging, battery 50% or more) after the consent card? It reverses section 8 ("off until Share on this network"). | `CONFIG.seed.phoneDefaultOn = false`: K and E on phones stay behind "Share on this network" | 8.1.3 |
| SZ-2 | H keeps sending after the page is hidden, until the browser suspends it? | `CONFIG.seed.handoffWhileHidden = false`: a hidden phone locks every lane at once, as in section 8 | 8.1.4 |
| SZ-3 | Rungs without DNS default to `--exp 399` with a printed re-sign date, or keep 90 days as a retention clock (S2 Q7, S3 2.11)? | **Decided: 399 days accepted**, together with a calendar reminder file (the record's expiry minus 30 days, written next to `summary.json`; planned for 0.3.x, not built in 0.3.0). `ship` signs 399 days (`SHIP_DEFAULT_EXP_DAYS`) and prints the date; `publish` keeps 90; the owner key never goes on a server or into CI | section 10 |
| SZ-4 | Call caps 6 audio and 4 video, audio only by default on metered and unknown networks | the caps and the audio-only start are constants in `src/calls/limits.js` (chosen); calls stay `off` until the owner sets `_mw.cfg.calls` | 15.14 |
| SZ-5 | Plan for 10% to 30% of pairs failing without a relay (a planning range from vendor estimates, not a measurement), or offer R 2.7.8 option (a) for calls? | no relay unless the owner set `_mw.cfg.turn`; the card says so when none exists (`call.noPath`) | 15.14 |
| SZ-6 | The pin accepts the owner key's own items without the moderator queue (amends R 2.8.6, "never automatic", for the owner only)? | `tools/pin.mjs --auto-accept owner`; without the flag every request waits in the queue | 8.1.6 |

Open questions that the build leaves open: whether super-seeding breaks Fast Extension handling (S1 Q4); what Android does to a call
with the screen off (G-CL-3); whether "Others can see which files you share" is enough notice in law (S1 Q7; no lawyer has reviewed
it, and none is engaged for 0.3.0); who answers abuse notices for one-box sites.

### 15.12 Signing and AAD prefixes added by the wave 1 build (for the R 2.10.3 list; v0.3)
R 2.10.3 says a new purpose gets a new prefix. The lanes added: `mw-vault-v2` (vault blob AAD), `mw-identity-v3` (backup file
AAD), `mw-nonce-v1` (stateless verifier nonces), `mw-selftest-v1` (the self-test message), `mw-local-v1` (local proofs),
`mw-rotate-v1` (the rotate `rsig`), `mw-grp-admin-v1` and `mw-grp-commit-v1` (group admin lists and rekey commits), `mw-pres-v1`
(public presence), `mw-file-v1` (F2 file records). `mw-idp-wrap-v1` is both the HKDF info of K_unlock and the wrap AAD prefix (one
purpose). `mw-identity-v1` (0.2.1) is read only.
**v0.3 C2:** the pin node adds `mw-pin1-hello` and `mw-pin1-receipt` (the only two forms the pin signer signs on a wire,
8.1.6), `mw-pin-status-v1` (the signed heartbeat, over `"mw-pin-status-v1\n" + JCS(status without sig)`) and the domain separator
`mw-pin-status-v1|` of the hashed item ids. Calls add none: a SIG is sealed under `K_pair` with the chat lane's own prefixes (R 2.7.4).
**v0.3 code review (proposed, examples):** `mw-dir-v1` (a person's hub directory record) and `mw-dir-hub-v1` (the hub's
countersignature of it), checked by `examples/social/js/directory.js` (section 11); nothing in felinar signs them yet, because
the directory stays off pending counsel (R N-7; no lawyer is engaged for 0.3.0).
**v0.3 hardening and code review (review round, 2026-10-24):** prefixes in the built code that neither R 2.10.3 nor the lines
above listed. Identity: `mw-idp-bundle-v1`, `mw-idp-record-v1` and `mw-idp-legacy-v1` (the HKDF info of the ECIES boxes between the
identity page and a site page, `src/identity/client.js`), `mw-local-cache-v1` (the AAD of caches sealed under K_local,
`sealLocal`), `mw-vault-gone-v1` (the key tag of a shredded vault key, `src/identity/vault.js`). Loader: `mw-pin-v1` and
`mw-refusal-v1` (the device key's signed pins and refusals, `src/loader/harden.js`, 15.10). Pointer: `mw-rot-v2` (the scoped
`rot=` input; `mw-rot-v1` of 0.2.1 is deleted and never verifies) and `mw-label-v1` (a hub label's hash,
`src/common/pointer.js`). Pin node: `mw-pin1-request` (a file pin request its author signs, `src/pin/frames.js`
`PIN_REQUEST_PREFIX`, 15.17; the pin key never signs it). Release: `mw-release-v1` (the signed per-file hash list,
`tools/verify-release.mjs`). Chat: `mw-inbox-v2` (the stranger inbox tag, `src/chat/tags.js`), and the sub-purposes of
`mw-dm-v2|`: `mw-dm-v2|<ledger id>|stranger` (the stranger frame key), `mw-dm-v2|auth|` (the stranger frame's MAC) and
`mw-dm-v2|<ledger id>|box` (the sealed box to a chat key), all in `src/chat/seal.js`; `mw-collect-v1` (the COLLECTED hash lock: a
contact frame's iv is SHA-256 of it and the pair's secret, `src/chat/seal.js` `collectIv`, review round). Ledger: `mw-rotate-self-v1` (the `nsig` the next key signs to agree to a self rotation,
`src/chain/block.js` `selfRotateSigningInput`, review round). `mw-identity-v1` (0.2.1) is read only.

### 15.13 Final integration (v0.3)
The final integration ran the examples and the identity origin through the real loader end to end (e2e E-SO-*, E-ID-*,
E-SI-1W, E-CH-*, E-FI-*, E-MD-3 to 5) and changed these contracts, each in the code and in INTERFACES v0.3
([deviations/integration-v03.md](deviations/integration-v03.md), "Final integration", F-1 to F-14):
- **A personal pointer repeats the template's transport** (R 3.3 lists the fields; this adds to them): `tr=`, `ws=`, `xs=` and
  `idp=` of the page the person creates their page from, signed by the person's key (`transportOf` in
  `src/loader/personal-site.js`). A signed record is announced only on its own `tr=` and fetched only from its own `ws=` and
  `xs=` (section 4 and `announceListFor`), so without them a new personal page could never load the template. Nothing that
  names the template's ledger (`cs=`, `gen=`, `chain=`, `lo=`, `rot=`, `nx=`, `org=`) is copied.
- **`mw.ready()` answers again on every call once the loader has answered once** (shell, hub and drop-in alike), so `auth`,
  `identity`, `role` and `features` follow the sign-in as the SDK documents; calls made while the first is pending share it.
- **The hub follow lane's clock** (15.8): the loader calls `MultiGossip.tick()` once a second and `setHidden()` on
  visibility changes, which the chain-net lane's contract asked for and nothing did.
- **A file torrent's `metadata()` waits for the info dictionary**: WebTorrent builds a `torrentFile` as soon as a magnet is
  added, without `info`; resolving with it made every file and media item fetched by infohash fail its torrent check.
- **The identity origin of a drop-in page**: `resolveIdp` reads `idp=` from the page's own stamped pointer
  (`<meta name="mw-pointer">`) when no pointer is passed, so `<mw-signin>` on a page published with `--idp` finds it.
- **One consent card for chat**: `<mw-chat-panel>` calls `mw.chat.enable()` inside the click and shows no card of its own;
  the chat service's loader card is the consent (the panel showed the same text first, so a visitor answered it twice).
- **`mw.files.preview(ref)`** resolves with `{ kind: 'text', text }`, `{ kind: 'image', url, w, h }` (a `blob:` address of
  the PNG the loader drew) or `{ kind: 'none' }`; `/_mw/f/` is the address of `files.save`.
- **The shell's Settings** carry the 0.2.1 passphrase and file fields only in a build without the identity service (R
  MF-03, E-ID-10); the drop-in panel already did.
- **Loopback test builds** (`build({ testPsl })`, `tools/build-idp.mjs --test --test-psl`) add Public Suffix List entries for
  the loader and the identity origin alike; the loader reads `PSL_TEST_RULES` next to the bundled snapshot, empty in every
  other build. The development CSP (`mw-dev`, loopback only) allows `http://127.0.0.1:*` and `http://localhost:*` in
  `connect-src` for a web seed on another loopback origin.

### 15.14 Calls (v0.3 C2)

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (2026-10-22 to 2026-10-24, R 5.4).** Built by the lanes calls and wire-ui and integrated on 2026-10-20 (15.16); e2e E-CL-1, E-CL-2,
> E-CL-3 (Chromium) and E-CL-1W (WebKit) pass on loopback; no gate row G-CL has run. [SZ](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) 3.5 as contract, with the evidence of the
> [c2-calls-lab](research/labs/c2-calls-lab/README.md) (Playwright 1.64.1, Chromium 156 and WebKit 27.2, loopback only). Calls reuse the
> chat lane's keys, frames and consent (15.6) and put no server in the media path. Browser only. The price is stated on the first
> card, before any address leaves the device: every participant learns your IP address once you accept. Source ids (RFC1, BG1, CRA,
> WKB1 and the others) resolve in SZ section 7.

**Scope.**
- Signed-in members, where `_mw.cfg.calls = contacts` (default `off`). It needs chat on and the site's own tracker and STUN (MF-44).
  `ledger-admin cfg --calls off|contacts` sets it (section 10).
- 1:1 with an accepted contact, or a mesh from a chat group (R 2.7.7) or from the caller's contacts. Caps (chosen, owner decision
  SZ-4): 6 with audio only, 4 with video. Shell and hub modes. Drop-in answers `E_UNSUPPORTED` in C2, because a page load would end
  the call. A call rings only while the callee has the site open: a closed page rings nothing (8.1.8), and there is no push in v0.3.
- `calls` is a new `_mw.cfg` key. `cfgOk` in `src/chain/state.js` refuses a key it does not list, so the C2 build must add
  `calls: ['off', 'contacts']` there (a state rule, MF-21; a request to the C2 integrator). A peer on a build without the rule hides
  the whole `_mw.cfg` item, not only the key (its block stays valid), so for that peer chat, files and media read as off until it updates.

**Signalling.** SIG frames (type 0x0B, 15.6) are parsed and relayed like ENV, hop at most 4. A SIG carries the plaintext kind `sig` (5)
in the sealed box keyed by `K_pair` (R 2.7.4), in the smallest bucket that fits; an offer or an answer needs the 16,000-byte bucket
(a frame of 16,115 bytes, 15.6). In the lab an offer was 5,734 to 7,135 bytes and an answer 5,440 to 5,787 bytes with audio, video and
one data channel, so one sealed bucket holds either with room for candidates (measured, loopback). The body is JSON of at most 15,000 bytes:

    { v: 1, c: <callId, 16 bytes b64url>, k: 'ring'|'accept'|'decline'|'busy'|'offer'|'answer'|'ice'|'hangup'|'leave',
      s: <seq>, t, sdp?, cand?: [at most 16], media?: { a, v, s }, roster?: [at most 5 pubs], g?: <groupId> }

`sdp` is at most 14,000 bytes and carries `a=fingerprint:sha-256`; a candidate string is at most 512 bytes. Rules (chosen): contacts, or the
members of the named group, only; never stranger-flagged and never held; one pending ring per contact and at most 10 an hour; a ring
expires after 45 s; `t` within 60 s of the receiver's clock; `s` rises; duplicates are dropped by `(c, s)`. SIG has its own replay
conversation (`'sig|' + pub`), so direct-message gap detection is untouched; it is never kept in history and never acknowledged. The
chat service hands the call service a seam, `sig` (INTERFACES, C2): a `sig` message inside a SIG frame from an accepted, unblocked
contact, or from a key in an active listen set (a call roster, at most 2 hours), goes to the call service; a `sig` inside an ENV, or
any other kind inside a SIG, is dropped. `chat.direct.connect` answers `E_POLICY` when `_mw.cfg.calls` is off and `E_UNSUPPORTED` when
it is on (direct data channels stay P2).

**Binding.** Offers and answers exist only inside SIG sealed with `K_pair`, which only the two parties can compute. The `a=fingerprint`
lines are therefore authenticated end to end, and the browser's DTLS check binds the media to the chat keys with no trust in a
signalling service. RFC 8827 says that without identity assertions security needs "minimal trust in the signaling service not to
perform a man-in-the-middle attack" (4.3; SZ RFC1), "Media traffic MUST NOT be sent over plain (unencrypted) RTP or RTCP" and
"DTLS-SRTP MUST be offered for every media channel" (6.5): every pair runs DTLS-SRTP. After the connection is up the service compares
the remote certificate fingerprint of the certificate statistics with the fingerprint in the SDP it received over SIG and ends the call with
`E_CALL_FAILED` on a mismatch. A contact verified with `chat.contacts.verify` gives a verified call. A stolen chat key impersonates in
calls as in chat. A spoken safety code is P1.

**Flow and IP exposure.** ring (no SDP) -> the callee's loader card -> accept -> the caller creates its connection and sends the offer ->
answer -> trickled `ice`. The callee creates no connection before it accepts, and the caller sends no candidate before the accept, so a
declined or ignored call shows nobody's address. Then a negotiated data channel (`id 0`, label `mw-call`, JSON of at most 16 KiB)
carries mute, camera, screen, roster, leave and renegotiation (perfect negotiation: the higher public key is polite), independent of
the swarm wires a phone rebuilds after 10 s hidden. Mesh: the caller sends the roster and offers to each person who accepts; every
other pair connects once, with the lower public key offering; a leaver's pairs close within 5 s. The peer learns one's IP address
(RFC 8827 6.4; SZ RFC1), and in a mesh every participant learns every other's.

**ICE and relay.** `iceServers` is the site's own STUN list and never a default public server. TURN is used only with R 2.7.8 option (a)
or (b) and its card (`call.startRelay` names the operator; static credentials add that the relay is open to anyone who loads the site).
A relay forwards encrypted packets and sees both addresses, sizes and times, never content. "Hide my IP from people I call" sets
`iceTransportPolicy: 'relay'` when a relay exists; 0.3.0 has no switch or strings for it, and only a development build can set it
(`window.__mwShell.setCallPrefs`, below). Received private, loopback and link-local candidates are dropped unless both chose
"same local network"; mDNS candidates pass; the caller strips its own private host candidates before it sends; ICE restarts on a
network change. Plan for 10% to 30% of pairs needing a relay to connect (a planning range from vendor estimates, with 22% of
conferences in 2016 callstats data; w2b-03 F-01, F-03; not a measurement). Without a relay those pairs fail with `call.noPath`; whether
to offer option (a) is owner decision SZ-5.

**Media and adaptation** (per stream, chosen unless marked):

| Stream | 1:1 | Mesh | Notes |
|---|---|---|---|
| Audio | 32 kbit/s (the default send target the lab measured) | 32 kbit/s | 24 kbit/s on a metered network |
| Video | 800 kbit/s at 640x360 on desktop and Wi-Fi; phones 500 | 400; phones 300 | a metered network starts with audio only, and video there runs at 300 kbit/s scaled down by 2 |
| Screen | 1,200 kbit/s | 600 | 15 frames a second, `contentHint 'detail'` |

Every 2 s the loop reads `availableOutgoingBitrate`, `qualityLimitationReason`, loss and round-trip time. 5% loss or 4 s of
"limited" halves the video bit rate (floor 100 kbit/s), then scales the picture down by 2 and by 4, then pauses the video and keeps the
audio; one step back after 10 s clean. Arithmetic: a 4-way video mesh sends 3 x (400 + 32) = 1,296 kbit/s; 300 kbit/s of video is
2.25 MB a minute; audio is about 0.4 MB a minute each way (with about 20 kbit/s of headers, assumed). Seeding yields to calls
(8.1.3): on phones torrent wires drop to their floors, and call connections (at most 5) count apart from the wire budget.

**Platform handling.** Back to visible, muted or ended tracks are re-acquired with `replaceTrack` (WebKit bug 204681; bug 208516 was seen only as a search result). On a
track `mute` the card says `call.paused`. A Screen Wake Lock is held during a visible video call and released on hide or end. Media
Session `togglemicrophone` and `togglecamera` are set where supported, and `hangup` too (the lab: `hangup` works in Chromium and
throws a TypeError in WebKit 27.2). `getDisplayMedia` is called inside the click handler (WebKit refused it outside a user gesture
in the lab). What the platforms do to a call (documented; iOS 26 and 27 are unmeasured, G-CL-2): a page that captures the microphone
"will not get suspended if in the background" (a WebKit engineer, 2020-03-23, bug 204681); video stops in the background; a Home Screen
app can "lose the microphone as soon as they go into background (or screen locked)" (a report of 2023-12-26, bug 239602, open); a
phone call mutes capture. Android Chrome and Firefox for Android have no `getDisplayMedia` (MDN data). None of this is
said on a card yet: the call state names `call.ios` or `call.android` only with `CALL_FLAGS.phoneNotes` (src/calls/limits.js),
false until G-PS-1 to G-PS-4 and G-CL-2 run (SZ section 4 P0, 3.1.10; code review v0.3).

**UI** (`src/loader/call-ui.js`, loader-owned, over the site frame so it survives site navigation in shell mode): the incoming card;
mute, camera, screen and hang up; each participant as ringing, connecting, direct, relayed, reconnecting or left; a ring sound only
where the page may play sound (Chrome allows autoplay only after an interaction with the site, earlier media engagement on desktop,
or installation; SZ CRA), else a title flash and an Android vibration. The screen button is shown only where `getDisplayMedia`
exists. Keyboard shortcuts, focus management and live-region announcements are part of the card.

| Key | English text |
|---|---|
| `call.start` | Call {name}? Your browsers connect directly, so {name} will see your IP address. Nobody else is in the media path. |
| `call.startRelay` | If a direct connection fails, the call goes through {operator}'s relay, which sees both IP addresses and how much you send, not what you say. |
| `call.incoming` | {name} is calling ({kind}). Accepting shows your IP address to {name}. [Accept with audio] [Accept with video] [Decline] |
| `call.group` | Join a call with {names}? Each of them will see your IP address. |
| `call.metered` | You are on mobile data, so the call starts with audio only. Video uses about 2 MB a minute. |
| `call.ios` | On iPhone, video stops when you leave this page, and an app on the Home Screen loses the microphone too. Keep this page open during the call. |
| `call.android` | Keep this page open during the call. Android may cut the connection when the screen is off. |
| `call.noPath` | Could not connect to {name} directly. Some networks block direct connections, and this site has no relay. |
| `call.screen` | Everyone in this call will see the screen or window you pick. |
| `call.notHere` | {name} is not connected now. Calls ring only while {name} has this site open. |
| `call.ended` | Call ended ({duration}). |
| `call.declined` | {name} declined. |
| `call.busy` | {name} is in another call. |

The controls and states (`call.accept.audio`, `call.accept.video`, `call.decline`, `call.mute`, `call.unmute`, `call.camera.on`,
`call.camera.off`, `call.screen.start`, `call.screen.stop`, `call.hangup`, `call.state.ringing`, `call.state.connecting`,
`call.state.direct`, `call.state.relayed` ("Relayed by {operator}"), `call.state.reconnecting`, `call.state.left`, `call.paused`,
`call.videoPaused`, `call.ringTitle`, `call.calling`, and `call.kind.audio` and `call.kind.video` for `{kind}`) and the six error
sentences are in `src/loader/strings.js` (`CALL_TEXT`, `ERROR_TEXT`), English and French.

**SDK** (`mw.calls`, INTERFACES C2): `start({ to: pub | [pubs] | groupId, video? })` (a UI method), `accept(id, { video? })` (UI),
`decline(id)`, `hangup(id)`, `mute(id, on)`, `camera(id, on)`, `screen(id, on)` (UI), `state(id)`, `list()`, `on('ring' | 'state' |
'peer' | 'ended', fn)`, and `mw.ready().features.calls`. The SDK never returns a `MediaStream`; same-origin site code can still call
`getUserMedia` itself, which the browser's own permission prompt and indicator govern (R 2.1 rule 2: site code is trusted for its own
site and nothing else). New errors: `E_BUSY`, `E_DECLINED`, `E_NO_ANSWER`, `E_MEDIA_DENIED`, `E_NO_DEVICE`, `E_CALL_FAILED`. Reused:
`E_NOT_SIGNED_IN`, `E_HOST_ONLY`, `E_POLICY`, `E_NOT_CONTACT`, `E_PEER_UNREACHABLE`, `E_LIMIT`, `E_UNSUPPORTED`. The gating order is the SDK
boundary's ([SDK.md](SDK.md#the-a4-rule-and-gating), [deviations/sdk.md](deviations/sdk.md) item 4): `E_HOST_ONLY` before any request,
then `E_NEEDS_GESTURE` for a UI method without transient activation, then the service: `E_POLICY` (calls off), `E_NOT_SIGNED_IN`. A
call that fails both the click and the calls setting reports `E_NEEDS_GESTURE` (`src/loader/api.js`; the calls service's own guard,
`src/calls/service.js`, checks `E_POLICY` first, but the boundary answers before it runs). A call is never started or accepted by a script: the loader card and its click are the consent.

**End-to-end** (loopback, `iceServers: []`; Chromium always with both fake-media flags, because the fake-UI flag alone granted the
machine's real camera and microphone in the lab; WebKit with context permissions, one browser per participant, because a second
capturing page of one WebKit browser muted the first, and `getDisplayMedia` from `page.click`). **E-CL-1** (Chromium): ring, accept
with video, connected within 10 s; audio and video bytes both ways; the remote certificate fingerprint equals the one in the sealed
answer; the chat-lane bytes hold no `v=0`, `a=fingerprint` or `candidate:` text; mute and camera off reach the peer over `mw-call`;
hang up closes both connections and ends every capture track. **E-CL-2** (Chromium): a group call of four from a context forced to the
metered class is audio only; each context has 3 connected pairs with audio from 3 peers; a leaver's pairs close within 5 s; a video call
to five people fails with `E_LIMIT`. **E-CL-1W:** E-CL-1 in two WebKit browsers, plus screen share. **E-CL-3:** a non-contact's ring
creates no `RTCPeerConnection` (an init script counts them); after a decline no offer leaves the caller; host-only gives `E_HOST_ONLY`;
calls off gives `E_POLICY`. The C2 integrator wired them (`CALLS_ORDER = ['E-CL-3', 'E-CL-1', 'E-CL-2']`, `CALLS_WEBKIT_ORDER = ['E-CL-1W']`); measured
on loopback: connected 629 to 716 ms (Chromium, seven runs) and 650 to 686 ms (WebKit, three runs) after the accept. Two browsers on
one machine have only loopback and private candidates, so the scenarios set "same local network" through `window.__mwShell.setCallPrefs` (development builds only, this page only; C2
has no switch for it).
WebKit offers only an mDNS host candidate until the page has captured, and two WebKit browsers never connected the swarm with those
(measured): E-CL-1W captures in each shell before "Share and load".

**Gate rows** ([DEMO-RESULTS.md](DEMO-RESULTS.md), none run): G-CL-1 1:1 audio, a phone on LTE to a laptop on Wi-Fi, 50 attempts (connect
rate without a relay, time to connect); G-CL-2 iPhone Safari tab and Home Screen app, audio and video after 5 s, 30 s and 2 min hidden,
on lock, during a phone call, and recovery (iOS 26 and 27); G-CL-3 Android tab and installed app with the screen off, plugged and
unplugged; G-CL-4 a desktop mesh, 4 with video and 6 audio only (CPU, uplink, loss, jitter); G-CL-5 the same with two phones (battery,
temperature); G-CL-6 screen share from desktops and from iOS 27 Safari; G-CL-7 the share of pairs that need the relay and the relayed
bytes a minute; G-CL-8 1 Mbit/s at 5% loss and a Wi-Fi to LTE handover (time to recover audio); G-CL-9 comprehension of the call cards by
5 to 8 people.

**What a call does not do.** It has no recording feature. It has no mixing server: above 6 participants (4 with video) a call
needs one, which v0.3 does not have; a mesh sends N-1 streams, so its uplink grows with every person (a mesh suits 2 to 5 participants,
SZ BG1). It does not ring a closed page. It does not hide your address from the people in it: the planned choice "Hide my IP from people I
call", which would send the call through the owner's relay so that only the relay's operator sees both addresses, has no switch in 0.3.0.

### 15.15 Doors (v0.3 C2)

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (2026-10-22 to 2026-10-24, R 5.4).** Built by the lane doors from [research/v03/S4-doors.md](research/v03/S4-doors.md) and integrated
> on 2026-10-20 (15.16; the lane's notes, readings and measurements are in [deviations/doors.md](deviations/doors.md)). e2e DOOR-DOWN, DOOR-HASH
> and DOOR-GUEST (and DOOR-GUEST-W in WebKit) pass on loopback; no gate row G-DR has run, and Firefox was not run. **(proposed)** S4's
> second phase: a zip export from the page, the door kit published as a site, a stand-alone light viewer, updates of page code over the
> swarm and signed update continuity; not built, because C2 took only S4's first phase.

The site lives at its key; domains are doors (research/v03/S4-doors.md). A door is any host that serves the loader; every build has the
door page `/_mw/open.html`, which `resolveMode` answers with mode `door` whatever the page tag or `mw-hub` says. The light link is
`https://<door>/_mw/open.html#<record percent-encoded once>[#mwgen=<blocks>][#mwd=<host>,...]`; the record is signed for the hub scope
`btih:<hex>` and may carry `org=` (at most 4 owner origins, the identity mirror list: never a third-party host) and `dr=` (one key, a comma
list of 1 to 8 lowercase `host[:port]`, https implied, http only for loopback; a malformed one is `bad-value`). `#mwd=` holds at most 4
unsigned hints, used last and only for public host names; like `dr=` guest doors and the ledger's `_doors`, they serve the loader only
and are never asked for the site's `.torrent` or web-seed bytes (15.18, `byteDoors` in `src/loader/doors.js`). `parseFragment` takes any number of
`#name=value` segments after the record (`mwgen`, `mwd`; others ignored), removes a `web+felinar:` prefix (literal or encoded by a
handler's `%s`), decodes an encoded record once, and restores only separator spaces in a literal one. The door page reloads once into
the limited-mode policy (`requestDegradedReload`, reason `door`), shows the gate (one stored choice per site), and renders the site in
a frame with `sandbox="allow-scripts"` whose own renderer (`/_mw/door-frame.js`, written inline) receives the files over a
MessagePort; the Bridge accepts that frame with origin `"null"`; identity is for this visit only (`sharedHub`); stored copies are
flagged `viaDoor` and evicted first; the worker serves the door page from its precache, never answers `/_mw/door.json`, and never
takes a current site from the door page. Candidates, in order: the current door, the last door that served the `.torrent`, `org=`,
`dr=`, the ledger's `_doors`, the hints; at most 12. On the door page the `.torrent` comes from the record's `xs=` or the
`/_mw/t/<btih>.torrent` of a byte door (an `org=` door, the last door that served it, or a host the signed record names in `ws=` or
`xs=`), raced with 250 ms between starts, 3 in flight, 4 s to the first byte and 12 s per door, kept when its infohash
matches; up to 3 byte doors join the web seeds; a failing door pauses 10 minutes. After each render a page probes its own
`/_mw/door.json` (network, no store); on failure it probes up to 3 other doors and shows "This address is not answering. The owner
lists: ..." with one button each; nothing navigates by itself. `_doors` = `{ v: 1, d: [host, ...] }`, owner-authored only, at most 24
hosts and 2,048 bytes, at most one accepted change an hour per device; invalid items are hidden and their blocks stay valid (MF-21).
Only the door manifest (`/_mw/door.webmanifest`) has `protocol_handlers` (`web+felinar` to `/_mw/open.html#%s`), `share_target` and
`launch_handler`. Tools: `publish --door`, `publish --door-kit`, `check-site --door` (DEPLOY.md, "Doors").

### 15.16 C2 integration (v0.3 C2)
The C2 integration (2026-10-20, [deviations/integration-c2.md](deviations/integration-c2.md), C2-1 to C2-24) joined the eight C2 lanes to the
v0.3 code and changed these contracts, each in the code and in INTERFACES "v0.3 C2":
- **`_mw.cfg.calls`** (`off` | `contacts`) is in the reader schema of 15.4 (`CFG.calls`; MF-21 state rule, blocks stay valid). Before it,
  a `_mw.cfg` that named calls was hidden whole.
- **mw_pin1 in the page** (8.1.11): the verifier on every page whose site names a pin, the responder and `window.__mwPinHost` only in the
  pin's own page; `inspect().pin` reads it out (read-only). The files and media services get `owner`, `pinEvidence` and `evidenceInputs`.
- **The call panel** sits at the top right on computers too (it overlapped the loader cards at the bottom, and the two overlays' redress
  guards cancelled each other's buttons), and takes its rules from the shell's loaded `/_mw/ui.css` into a `<style>` in its closed root (in
  WebKit its `<link>` never loaded there). The loader cards' slots take no pointer events, so a click beside a card reaches the site.
- **`window.__mwShell.setCallPrefs({ sameLan, hideIp })`**, in development builds only (loopback or `<meta name="mw-dev">`): the "same
  local network" and "Hide my IP from people I call" choices for this page, never stored (C2 has no switch or strings for them; both start
  off, and a production page has no way to change them).
- **The door view's SDK hello** (15.15): `sdk.js` accepts a parent for a frame whose origin is `"null"` when the door renderer marked it
  (`window.__mwDoor`), and posts the hello there with `'*'`; `boot.js` imports the loader by an absolute URL; `ActivationTracker.watch`
  ignores a cross-origin target instead of throwing.
- **`tools/pin.mjs`** offers pinned files to the page as soon as it offers its pin host; `ledger-admin doors` writes `_doors`.

### 15.17 Code review v0.3: ledger and tools (lane ledger-tools)
The v0.3 code review ([review/code-review-v03-security.md](review/code-review-v03-security.md), [correctness](review/code-review-v03-correctness.md),
[conformance](review/code-review-v03-conformance.md), [browser](review/code-review-v03-browser.md)) changed these contracts, each in the code, in
INTERFACES "v0.3 code review" and in the tests named there. The site ledger stays a signed, hash-linked log: no mining, no consensus.
- **Recovery (MF-20).** A `keyinfo` counts only as the key's first word on the ledger: the keyinfo blocks of a key with one rc count when
  every other block the key signed (roots and recover rotations to the key itself aside) is in the causal future of one of them; several with
  that rc are one commitment (two devices), two rcs with neither first are none, and a key that wrote in the history a checkpoint covers gets
  none later (the genesis owner and a key a settled recover rotation moved to aside). So a thief cannot plant one for a key that has already
  written, and admit refuses a late one (`E_POLICY` 'keyinfo-late'). The key a valid recover rotation moves to may write its own keyinfo with
  its from's allow membership. A rotation is a revocation, as a hand-over is: blocks of `from` outside the causal past of the rotation in effect
  have no effect (its keyinfo and rotate blocks and blocks with owner standing aside; a moderator allow of `from` is not revoked, the owner
  removes the key from moderators), and admit refuses them (`E_POLICY` 'rotated'). Bans and unbans cover the rotation family in both
  directions. ChainNode writes `{ t: 'keyinfo', rc }` before an identity's first other block when the identity carries `rc` (after it when that
  first block is a recover rotation to the key). Test vectors lg-021 to lg-024.
- **Bans in time.** `policy.banned` holds permanent bans; `policy.banUntil` every key a ban reaches. `isBanned(pub, state, now)`,
  `roleOf(pub, state, now)` and `snapshot(state, { now })` read the clock (the snapshot adds `banUntil`), and ChainNode passes its own
  (`node.roleOf`, `node.isBanned`, `node.snapshot()`; the chat and identity services ask the node first). Subscribers hear a ban run out.
- **Claimed times.** A remote or snapshot block more than 5 minutes ahead of the node's clock is not stored or relayed until then (it waits
  in the deferred pool up to an hour ahead; further, `E_FUTURE`), so a banned author cannot post past a ban's until. A live moderator ban,
  unban, tombstone or allow must claim a time within 15 minutes of its arrival (`E_CLOCK`, not remembered: it may come as history), and the
  state rule counts moderator day and hour caps at the block's time, max(ts, the newest ts in its causal past) (vector lg-025).
- **Checkpoints (MF-24 to MF-26).** Every copy prunes on its own: ChainNode's tick applies the checkpoint that came into effect with the S
  reduce() computed (`state.checkpoint.S`, not enumerable). The stored checkpoint row keeps the covered blocks' depths
  (`dag.coveredDepths(S)`, `dag.pruneTo(block, S, { depths })`), so a reopened copy has the depths and windows of one that pruned live, and
  orphans that waited only on covered parents enter the DAG and the store. A pruned copy's export and its `cs=` file start with
  `{ mw: 'checkpoint-v1', ledger, checkpoint: { h, snap, S } }` (`node.exportSnapshot()`, `tools/snapshot.mjs`, `tools/pin.mjs`, which reads the
  row from the page's IndexedDB); `node.importSnapshot()` applies such a header (or a recent window's) first, and `ledger-admin` loads such files.
- **Hub follow lane.** A follower's view keeps a checked block only when it has an effect in the view's state (writers, allow list, bans,
  the fee; a block more than 5 minutes ahead is not kept), at most 1,024 payload blocks per key that is not the owner or a moderator, and trims
  by depth, never by claimed ts. A refusal for lack of standing counts against the lane peer, a peer is credited only with what the view kept,
  and an answer the view kept nothing of is a failed pull. The first RECENT answer page carries `truncated`. Frames 1 to 6 skip the lane
  budget only when they open with the ledger field of a held ledger and parse to that same ledger.
- **`_mw.cfg`.** The readers' schema takes `blockTiers` (distinct sniffed kinds, `CFG_TIERS`), `wall` (everyone, follow, nobody, approve) and
  `requests: 'introduced'`; `ledger-admin cfg --block-tiers`, `--wall` and `--requests introduced` write them. A test scans the documents and
  lanes for every `_mw.cfg` key they name.
- **Pin node.** The bridge's top-frame check is no boundary (a same-origin site frame calls `window.top.__mwPinCall`), so a file pin request
  counts only with its author's signature over `pinRequestBytes` (the ledger id, the five queue fields and a time; `src/pin/frames.js`), and only
  one the owner key signed skips the moderator queue (`--auto-accept owner`). A browser that may reach the internet (pin, check-site,
  snapshot of a URL) runs with Chromium's sandbox and keeps WebRTC's mDNS host-candidate hiding on (`MW_CHROMIUM_NO_SANDBOX=1` drops the
  sandbox, loudly). `tools/lint-floor.mjs` has guarded rules for the post-floor APIs v0.3 feature-detects (getClientCapabilities, PRF results,
  wakeLock, getDisplayMedia, BarcodeDetector, OffscreenCanvas, requestIdleCallback, getBattery, navigator.connection, Media Session actions,
  createImageBitmap option values).

### 15.18 Code review v0.3: identity origin, loader and worker (lane loader-sw)
The same review changed these contracts of the identity origin, the loader, the drop-in and the worker, each in the code, in INTERFACES
"v0.3 code review: lane loader-sw" and in the tests named there (`test/unit/idp-review-v03.test.mjs`, `loader-review-v03.test.mjs` and
`loader-review-v03-torrent.test.mjs`; in Chromium and WebKit with `MW_BROWSER=1`, `loader-review-v03-browser.test.mjs` for the header
at 390 x 844 and `idp-browser.test.mjs` for frames during Argon2id and the backup download).
- **One vault, many windows.** Every change to the vault or the IdO's state runs under the Web Lock `mw-idp-vault` and re-reads the stored
  copy inside it, so two windows never save over each other, and the vault carries a version that only goes up. The vault copy a site
  keeps (escrow) is merged on every sign-in, never adopted whole: chat epochs by epoch, record keys by id, `own` and `local` only where this
  copy has none (a different key under one epoch is archived, not lost), links, sites and private records per field by time, pointer seq
  floors by max. A shredded key leaves a tag (`keyTag`) that keeps it from coming back from an older copy.
- **Escrow.** A site keeps the wrapped root only when a passkey PRF wrapped it: a passphrase-wrapped root never leaves the IdO, and the
  passphrase card says the phrase or the backup file is the way back after Safari or a reset clears the identity page. The strength check
  counts list words by position and keyboard rows, sequences and repeats as short. One origin's private record at the IdO is at most
  31,403 bytes and the vault at most 200,000; a larger record is not taken (the site keeps its copy), and an oversized vault copy is left
  out of the request, never the sign-in.
- **Requests.** `want` is one of the R 2.3.2 sets; a `challenge` comes only with purpose `server`, and a site proof carries the IdO's own
  nonce. The hub label exists only for the one-operator hub suffixes built into the IdO (`MW_HUB_SUFFIXES`; platform suffixes of the
  Public Suffix List never), its box starts unchecked whatever the page asks (`hubDefault` is ignored), and "this visit only" holds for
  the origins of `MW_SHARED_ORIGINS` whatever the request says. Built as (review round, 15.20): the hub label goes only to the hub's
  template pages, and the box is ticked by default only for a page of a build-listed template that asks for it (`buildDefault`). The card's lines follow the mode (linked, hub, mirror, own key).
- **Pointers.** An expired pointer gives no ledger label (the origin label instead); the seq floors live in the vault, so they travel with
  escrow and backups. A personal page at its own hub address (`ownHubAddress`) shows no look-alike line. The owner's loader re-signs its
  personal pointer when fewer than 30 days remain and writes it at `_mw.ptr`, where the followers' views take it; a follow whose pointer
  only expired stays, marked as not refreshed. A `#host:<name>@<fp>` link uses only a pointer signed by the key it names, and the DNS
  badge says "(DNSSEC: resolver says validated)". The signed `minSeq` of MF-30 is not built (15.4 has no such field).
- **Gestures (MF-09).** The salt for the PRF and the stored records are read before the press, so the WebAuthn call is the press handler's
  first await. A refusal faster than one second shows "Tap to finish", whose click makes the call again; a second refusal, or a browser
  without passkeys, goes on to the passphrase card in the same window. Argon2id runs in slices that yield to the event loop after the busy
  card has painted, with a progress line. The backup file downloads from a button on its own card, its URL lives 60 seconds, and
  `fileSaved` is set only after "I saved the file"; where downloads fail the text can be copied.
- **Replace my keys.** The next sign-in of a replaced label at a ledger writes the recover rotation `{ t: 'rotate', from, next, by:
  'recover', rp, rsig }` before any other block (shell and drop-in), so allow membership follows the key (15.17). A label that made or
  owns a page keeps its key, because a page cannot move to a new key yet, and a moderator role stays with the old key until the owner
  adds the new one; the card says both.
- **Loader cards.** The first meaningful action (a ledger write, a message, an upload, keeping chat history) brings the loader's "Save your
  recovery kit" card while the kit is not saved. When the popup is blocked or never answers, "Continue in this tab" starts the redirect
  round trip in the person's click, and an iOS Home Screen app starts with it. The signed-in header says how the keys were unlocked and
  whether a backup exists; on a phone it folds into a 44 px chip after 5 seconds and opens on a tap. The public upload card says details
  were removed only when the stripper removed some, and otherwise that the file is shared as it is. Installing working keys restores the
  person's own private media (shell, hub and drop-in). The identity origin no longer offers its page for the Home Screen (it would start
  empty), and its iOS lines wait for the MF-63 flag.
- **Swarms.** Chat, group, file and private media swarms gather ICE only through the site's own STUN list (`publish --stun`,
  `/.mw/site.json`; host candidates when it names none), as 15.6 requires, and the chat card names that list (the drop-in reads it only
  when a swarm or the card needs it, from its stored copy, else from the host); the site, rendezvous and hub ledger-sync swarms keep
  the probe-gated defaults of section 8 (B7). A seek puts its pieces in front of the whole-file selection until they verify, and the
  worker tells the page when a range stream is cancelled (`mw-chunk-cancel`), so abandoned seeks do not pile up.
- **Doors.** Only owner doors, the last good door and the hosts of the record's `ws=` and `xs=` are asked for `.torrent` and web seed
  bytes; a guest door or a hint serves the loader only and never learns which site the visitor opens.
- **Moderation.** A deny writes `_deny/<b64url(sha256(utf8(id)))>` for the item's infohash, its sha256 and the report target's infohash, and
  tombstones the listing in the same step (a media report carries the infohash). A public listing by a key that is not the owner's, a
  moderator's or allow-listed, and has no accepted listing, waits in the moderators' queue; accepting writes `_listed/<key>`
  (`listingVisible`). Built as (review round, MAL53-1, 15.20): the key names the infohash and the author. The pin key of `_mw.cfg` counts only from an entry written with owner standing.
- **Local wires.** 100.64/10 (carrier-grade NAT) is not private, and a phone whose network type is unknown counts no local wire unless the
  person declared Wi-Fi. A followed ledger opens on a memory store with no tick, in batches of 32.

### 15.19 Code review v0.3: round 2 integration (cross-area requests)
The four area fixers of the review left requests for areas they did not own; the integrator applied the ones that are fixes, each in the code,
in INTERFACES "v0.3 code review: round 2 integration" and in the tests named there, and put the rest on [ROADMAP.md](ROADMAP.md) ("Left open by
code review round 2"). The record is [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md), section 8.
- **Premoderation (R 2.17.1, MF-53).** Honest copies apply the rule of `src/loader/mod.js` `listingVisible` in the files lane: a public listing
  by a key that is not the owner's, a moderator's or on the `allow` list, with no accepted listing of that author yet, is listed only for its
  author (`pending: true`), and `files.fetch` of it answers `E_POLICY` elsewhere. A moderator accepts it in the loader's moderation queue; the
  owner can accept it offline (`ledger-admin listed --ih <infohash> [--author <key>]`). Built as (review round, MAL53-1, 15.20): both
  write `_listed/<b64url(sha256(utf8(ih + "\n" + author)))>` = `{ by, t, ih, author }` (the tool takes the sole lister in the ledger
  file when `--author` is not given, and asks for it when none or more than one key listed the infohash: `tools/ledger-admin.mjs:834`);
  a legacy `_listed/<b64url(sha256(utf8(ih)))>` still credits a sole lister whose listing is older than the acceptance.
- **The pin key.** The files and media lanes take the pin key from the loader (`ownerCfgPin`: only a `_mw.cfg` written with owner standing),
  for the owner's automatic pin requests (SZ-6) and for "the site names a pin" in the evidence, never from `_mw.cfg.pin` alone.
- **Chat keys after a recovery (MF-20).** The chat service's CK cache refuses a CK whose signer the ledger shows as rotated away and drops one it
  cached before the rotation arrived, and its ledger copies too; a CK epoch may rise by one over the cached one (plus one per CK lifetime
  since it was taken), and no epoch is above 2^20. Without the node's clock-aware `roleOf` and `isBanned`, the chat and identity services read
  the reduced state with their own clock, so a temporary ban ends on time there too.
- **A frame right behind a CK frame.** The chat lane reads a wire's next frame only after the CK frame before it is handled (the chat key
  cached and the interest refreshed), and an interest refresh that a later one replaced waits for that one, so a SIG or a message a new
  neighbour sends right behind its CK frame is no longer dropped as nobody's (found by the unit runs under load: E-CL-1's first ring).
- **Sign-in for any site.** `<mw-signin>` calls the identity client in the click before anything is awaited, and the challenge fetch travels as
  a promise (the client opens its window first, then awaits it), so Safari and a slow server no longer block the window. The verifier
  library builds the signing input before it uses the nonce: a proof whose strings do not serialise is `parse` and burns no nonce.
- **Private media.** A cancelled range stream (`mw-chunk-cancel`) stops the page answering that chunk and takes its piece out of the front of
  the download; the worker reports a page message it could not read (`messageerror`, pushed as `mw-message-error`), and a register that
  carried a CryptoKey retries with the raw key bytes at once; after a reload, own items kept on this device join their swarms again in lane K,
  newest first, at most 8 (chosen).
- **Storage.** A ledger meta flush whose IndexedDB transaction fails keeps what it held for the next flush (a value set meanwhile wins).
- **Personal pages.** `mw.hub.createPage()` refuses (`E_POLICY`) unless the working keys are the person's hub key: a page owned by a key private
  to one label could never be signed in at.
- **Identity origin build.** `tools/build-idp.mjs --hub-suffix <suffix>` (a one-operator hub on the Public Suffix List, two labels or more) and
  `--shared-origin <https origin>` define `MW_HUB_SUFFIXES` and `MW_SHARED_ORIGINS`; both enter the build id and `build.json`, and
  `readBuild()` reports them. A build without them (and without a `--test` build's loopback suffixes) offers no hub label.
- **Calls on phones.** While `CALL_FLAGS.phoneNotes` keeps the platform notes off, a phone shows "Keep this page open during the call."
  (`call.keepOpen`) on the ring card and in the call panel.
- **Wording.** "Handed to N peers" becomes "N peers reported holding it" (HOLDING is unauthenticated; R 2.7.5 item 6 amended); the identity
  page's removal card states the limit the loader's card states (a backup or an older escrow copy still holds the key); its weak-passphrase
  message names the rule (too easy to guess, not only too short).
- **The pin container.** `deploy/pin/Dockerfile` sets `MW_CHROMIUM_NO_SANDBOX=1`: Docker's default seccomp profile does not let an
  unprivileged process create the user namespaces Chromium's sandbox needs, so the container is the boundary (the one-box pin service drops
  every capability and privilege gain); with a seccomp profile that allows user namespaces the variable can be emptied.
- **Group rekeys.** R 2.7.7 is amended: removals win, then the largest removal set, then `SHA-256(prev | creator)`, then `epochId`
  (`src/chat/groups.js`, lane chat-calls-media).

### 15.20 Review round (R 5.3, 2026-10-22 to 2026-10-24)
The ten area fixers of the review round changed these contracts, each in the code with a regression test that fails on the code
before. Every finding, its status and the file and line of the change are in the fixers' notes, indexed by
[deviations/review-round.md](deviations/review-round.md); the results are R 5.4. No existing vector or LOCK entry changed (the chain
fixer appended blk-023 to blk-025 and lg-026 to lg-029). A fix a fixer could only request, for a file it did not own, is not
folded in here until the code does it; R 5.4.7 lists those.
- **Self rotation (HUB-1, SYB-1, HUB-7, SYB-4).** `{ t:'rotate', from, next, by:'self', nsig? }`: `nsig` is `next`'s ECDSA P-256
  signature over `"mw-rotate-self-v1\n" + ledgerId + "\n" + from + "\n" + next` (`src/chain/block.js:83`); a malformed `nsig` is
  invalid 'op', one that does not verify 'sig'. With `nsig` the rotation links `next` to `from` (bans, allow membership and history
  follow, as for a recover rotation); without it `from` is only retired and `next` gains nothing. A self rotation needs the write
  right, the first one of `from` with that right wins, and a banned key's rotate is refused `E_BANNED`. `ledger-admin rotate --by self
  --next-key` signs `nsig` (review-round-chain.md:15 to :18).
- **Moderators (HUB-2, HUB-4, HUB-6, SYB-2).** A moderator ban and a moderator bulk tombstone keep values for the 24-hour grace like a
  single tombstone; owner bans, owner bulk tombstones, author tombstones and P0 takedowns still drop at once. A moderator block has
  standing only with the policy that appointed it in its causal past. Per checkpoint epoch a moderator has at most
  `EPOCH_ACTION_HOURS` (24) hours of `modActionsPerHour` and `EPOCH_ALLOW_DAYS` (7) days of `modAllowPerDay` in effect, whatever
  times the blocks claim (`src/chain/state.js:125`). A put without owner standing does not replace an owner-written `_` entry, a
  `_deny/` entry changes only by the owner or its author, and a voided author's `_` writes have no effect (admit: `E_POLICY`
  'owner-protected') (review-round-chain.md:19 to :22).
- **Sync and fees (MP-1, MP-2, MP-6, MP-11, SCALE-8, MAL53-13).** A sync session takes at most n + c + 64 listed hashes from a peer and
  holds at most 8,192 (`maxSessionBacklog`); a peer starts at most one session per 2 s; one peer's HELLO heads hold at most 256 wants;
  the parents of a paid orphan do not skip the writer fee; every author, vetted ones included, stops at `maxLifetimeBlocks`
  (`MAX_LEDGER_BLOCKS` - 64, `E_CAP`); a `ws=` web seed in a `mw.files` value must be https on a public host
  (review-round-chain.md:24 to :34).
- **Announcement delay (STALK-8).** Each ledger peer hears of a new local block after its own random delay of 0.5 to 3 s (up to 1 s for
  a relayed block), the HELLO that carries the head last, and the hub lane's announcement of a held ledger's new head waits 0.5 to 3 s
  (`src/chain/gossip.js:574`) (review-round-chain.md:27).
- **Hub follow lane (STALK-3, DS-3, SCALE-11).** `follow(ledgerId, { private })`: a private follow is never listed in HAVE and is asked
  for only among three same-shape decoy RECENT requests, from a peer that holds enough other ledgers; no HAVE after a pull; a refresh
  every 30 minutes asks for the newest 20 posts; one answer per ledger per wire per minute unless the root moved. The loader does not
  pass `private` yet, and still holds a viewed page in full (review-round-chain.md:29 to :31; Requests 3, 4).
- **Pointers in the loader (PTR-1 to PTR-5, PTR-9, PTR-11, PTR-13, PTR-14, GATE-1).** `pointerLineage(record, ...)` in
  `src/common/pointer.js` answers `owner`, `rot` (a `rot=` signed by the key `lo=` names, one step), `carried` (continues a record or a
  per-ledger memory this device accepted with proven lineage, or matches its `nx=`) or `unproven`. A hub address refuses an unproven
  record; a shared hub or a door mounts it read only, with no restored sign-in, no moderator key and never as the current site. A
  `#host:name@<fp>` link matches `owner=`, and `lo=` only with lineage `rot` or `carried`. Both update paths run `nx=` and the owner
  change through `rotationDecision`. Each device keeps `ledger:<ledgerId>` = `{ seq, owner, nx, at }` from records with proven
  lineage and refuses a lower `seq` of that ledger from any source; DoH moves to the next resolver on an empty, NXDOMAIN or
  unacceptable answer and refuses bodies over 64 KiB. A first visit holds a recorded rotation younger than 24 hours. Every mode but shell
  waits for the gate before any byte request. The floor and the previous record come from the saved signed text. A refused key
  change can be reviewed again ("Review the key change"). The page's `mw-doh` override waits until the scope has a pin or a saved signed
  record (review-round-loader-pointer.md:18 to :32). Built as: the signed `minSeq` of MF-30 is still not built (15.18).
- **Web seeds and doors (PTR-8, PTR-14).** `isPublicWebHost` refuses wildcard-DNS names and names that embed a private IPv4;
  `filterWebseeds` applies the host rule to signed records too, at most 8 `ws=` and 4 `xs=`; `cs=` and the pin web seed base must be
  public https. "The owner lists" names only owner, guest and ledger doors. **(proposed)** The torrent manager applying the filter to a
  signed record's lists and to `tr=` hosts: `src/loader/torrent.js` is not changed yet (review-round-loader-pointer.md:24, Request 2).
- **Identity origin (SEC-1 to SEC-4, STALK-1, STALK-5, STALK-6, PHISH-2, PHISH-4 to PHISH-6, PHISH-9, PHISH-11, PHISH-12, PRIV-4,
  UX-4, UX-9, UX-12).** Each site gets escrow copies made for its origin: the root copy wrapped again under the PRF output with a fresh IV
  and no `credId`, the vault copy encrypted again with a fresh IV, padded to a size bucket (16,384 bytes up to about 20 sites, then
  powers of two) and named `escrowIdOf(root*, origin)`. A redirect may carry only a key sign-in or the record read, and its sign-in is
  `unverified` (no approval, hub decision, same-identity link or vault site; the card says the page cannot be confirmed). A restore on a
  device that has an identity shows its check code first and never replaces it silently; `#restore` and `#link` in a window a site
  opened only say "open the identity page yourself". A device link takes up to 396 vault parts within 20 minutes or fails. The create
  card offers the extra word. Settings lists sites only after an unlock; "Shared computer" stores nothing about the site in the clear
  record. A label is a page owner only with evidence. The identity windows open while `no-referrer` is in force. Requests are checked
  against mw-signin-v1 section 5 before any card; inside a frame the page draws one card and stops (review-round-identity.md:28 to :58).
- **Hub identity (PHISH-1, HUB-3, UX-12).** Built as: the hub label goes only to one of the hub's own pages, a verified pointer whose
  address is this origin and whose btih is one of the build's hub templates (`MW_HUB_TEMPLATES`, `src/idp/psl.js:96`) or, without a
  build list, the template of the page where the person turned the hub identity on; any other label gets its own key, and the card says
  "a page of <hub> that you sign in to can post as you on every page of <hub>". The hub box is ticked by default only for a template page
  that asks for it, and Settings offers "Ask me again on <hub>". **(proposed)** The loader loading only template code on a hub and
  `createPage` taking the template from the operator's list, and a page-owner key apart from the member key (review-round-identity.md
  Requests 2, 9).
- **Chat (DS-1, DS-5 to DS-9, MP-3 to MP-8, MP-13, PRIV-1, SEC-7, SEC-10, STALK-7, STALK-9, SYB-3, SYB-5 to SYB-10, SYB-14 to
  SYB-17, UX-6, UX-14).** A WANT-TAGS route adds a neighbour to a random half and never replaces the flood. Own frames leave at a
  random hop (0 to 2), after a first-send jitter when there is more than one neighbour, to a random half (at least two). Contact tags
  are directional: `HMAC(K_pair, "tag|" + day + "|" + senderEk)[:8]`. A contact frame's iv is `SHA-256("mw-collect-v1" | s)[:12]` with
  `s = HMAC(K_pair, "collect|" | tag | epk)`, and COLLECTED carries `s`, so a holder deletes only what the collector can open (chat
  O-1 closed). A stranger frame shows one byte of the inbox tag (the full tag stays the HKDF salt). `ACK_TIMEOUT_MS` is 40 s. Per-wire
  ingress budgets for WANT, CK, PRES, ICHAL, IRESP and HELD; ROOM signature checks at 20 a second per wire and 100 in all; a 1 MiB
  backlog; a full queue drops from the source holding the most bytes; holders key sources by the Noise static key. One open request
  per sender (`requestsDropped`), `chat.requests.decline({ all } | { from } | { id })`; `introduced` takes no requests until
  introductions are built; 64 groups, 16 from one inviter; chat resumes after a reload once turned on; `secureRandom` replaces
  `Math.random`. The CK policy `ckShare: 'reason'` (a neighbour gets this tab's CK only when there is a reason) is built and tested
  (review-round-chat.md:21 to :58, :62 to :69). Built as (review round, integration: review-round-integration.md:39) the loader's
  default: `src/loader/api.js:2156` passes `ckShare: 'reason'`, and the two test fixtures add contacts first or hand a stranger's key
  over as a ledger copy would (`test/fixtures/calls/peers.mjs:200`, `test/e2e/scenarios-chat-rows.mjs:420`).
- **Files and media (SCALE-1, SCALE-13, MAL53-2 to MAL53-5, MAL53-7, MAL53-9, MAL53-11, MAL53-12, PRIV-5, STALK-10, SYB-13,
  HUB-10).** `listingOk` refuses `len` above 25 MiB, and one read path (`_shown`) applies the first 20 listings per author in ledger
  order, one row per infohash under its first visible listing, and the 256 MiB site total. Own public uploads are stored as
  `f-<infohash>` and survive a reload (lane K, at most 8); fetched copies live under a storage budget, least recently used first. Every
  public fetch computes the plaintext SHA-256 and checks it against `_deny/` before the bytes are used. One deny check covers every way
  into a files or media swarm, and a later deny stops what this device holds. A GIF's size is max(screen, first frame); a received
  private picture is checked before a decoder sees it. LNK, CHM, OneNote, compiled AppleScript, CAB, VHD, VHDX, ISO and UDF are named
  by their bytes; unknown, html, svg, xml and pdf need a second confirmation. TIFF, BigTIFF and camera RAW are re-encoded or refused;
  MP3 loses ID3 and APE tags; AVI and WAV keep only the chunks a player reads; MP4 and MOV keep an allow-list of boxes (every other box
  becomes a zeroed `free` box) and zero their creation and modification times; WebM also loses its date, apps, attachments and
  chapters. File names lose the rest of the Default_Ignorable set and invisible blanks (review-round-media.md:25 to :38).
  Built as (review round, integration: review-round-integration.md:64 to :65; review-round-media.md R4, R5): the pin page host
  refuses an item the site's ledger denies (`src/loader/pinwire.js:648` to `:653` returns `'denied'`, wired at `src/loader/app.js:4525`,
  `denyChecker`), and the hand-off counts only copies this device served (`src/loader/torrent.js:2230` marks a served copy,
  `:2274` to `:2288` `_copies({ served })`, `:2437` `_handoffCheck`). Built in the extra wave after verifier round 1
  (review-round-media.md, "R4 outcome"): the pin page host leaves an item it already holds when a later `_deny/` entry names it, by
  infohash or declared SHA-256 (`src/loader/pinwire.js:626` to `:637` `sweep()`, run from `status()` at `:687` to `:691`, which
  `tools/pin.mjs` reads every 2 s), and the pin node's queue quarantines a denied item in `decide('accept')` and `restore()`
  (`tools/pin.mjs:465` to `:486`, `:501` to `:515`; `FilePins` takes `isDenied` at `:349`). A left item's bytes and kept `.torrent`
  are deleted from the pin's browser profile (`discard`, `src/loader/pinwire.js:604`, `:624`, passed at `src/loader/app.js:4527`).
  Not built: a deny check in the node's Node process itself (it learns of a deny from the page host's `'denied'` answer, so an
  offline `--approve` or the month cap leaves the item on disk until the next status tick or the month's end), and dropping a
  left item from the heartbeat before that tick.
- **Loader (MAL53-1, MAL53-6, SCALE-14, SYB-11, UX-1 to UX-3, UX-11, UX-13, UX-17, UX-18, MP-10, MP-14, MP-15).** Built as (15.18,
  15.19): an acceptance writes `_listed/<b64url(sha256(utf8(ih + "\n" + author)))>` = `{ by, t, ih, author }` and covers that author's
  listing and that author's later ones, never another key that lists the same infohash; a legacy `_listed/<b64url(sha256(utf8(ih)))>`
  (what `ledger-admin listed` wrote before the review round; it now writes the author-bound key) credits only a sole lister whose listing is older than the acceptance (`src/loader/mod.js`
  `listingVisible`). A join accept checks the moderator's UTC-day room and the 1,000-key allow cap, else `E_LIMIT` and nothing is
  written. Moderation queues are bounded per kind (`QUEUE_CAPS`), refuse rather than evict, and hold one open join per sender and one
  report per reporter and target. A file wire's `ut_metadata` is bounded by the listing (256 KiB without one). Card guards re-arm and
  close only their own card; the redress notice has OK and goes after 6 s; every SDK error code has its own English and French
  sentence; the cards follow a French browser; focus returns to the page; reported copies count as one at most in the seed planner; a
  pin wire that never reports a revealed piece stops blocking after a deadline (review-round-loader-ui.md:13 to :29,
  review-round-loader-pointer.md:29).
- **Tools (SCALE-2, SCALE-10, SEC-5, SEC-6, PTR-7, SUP-5, SUP-11).** `tools/tracker.mjs --allow summary.json` serves the site, its
  ledger and its chat lane, and with files or media turns on uploads mode (unlisted swarms under caps); an unlisted swarm count is capped
  at 256 per connection, a socket uses at most 4 peer ids per swarm, and closing it stops every peer id it announced.
  `verify-release.mjs verify` needs `--expect-version`, `--min-version` or `--any-version`, and `sign` needs `--rebuilt`; a door kit's
  host settings must equal `doorKitFiles(version)`. A withdrawal keeps the previous record's `nx=`. `publish`, `ship` and the CI template
  check the loader against the signed release list before the key is used. `build.mjs --update-lock` refuses a new release of a
  provenance package without an attestation unless `--accept-no-provenance` (review-round-tools.md:29 to :41).
