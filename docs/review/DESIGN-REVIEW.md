# magnet-web design review: synthesis (ARCHITECTURE v0.1 to v0.2)

Date: 2026-10-17. Editor's synthesis of the four critic reviews: `security.md` (SEC), `browser-mobile.md`
(BRW), `distributed-systems.md` (DS), `requirements-fidelity.md` (REQ); finding ids are as in each file.
Tie-breaks use `docs/research/01..06` (R01..R06), `docs/deviations/{chain-base,example}.md` (EX), the
current `src/` tree and `node_modules`. `[ED]` marks an item no critic raised.

Two requirements arrived after the critics wrote: (a) any existing static site must migrate easily, so a
drop-in mode (one script tag on a site whose files stay on its static host, which doubles as the web seed)
is in scope beside the iframe shell; (b) the system must be production-ready.

Build state on 2026-10-17, which sets the cost of each fix. Written: `src/chain/{canonical,crypto}.js`,
`src/common/magnet.js`, `src/loader/{app,boot,bridge,config,policy,render,torrent,ui}.js`, `src/sw/*`,
`src/sdk/sdk.js`. Not written: `src/chain/{block,dag,state,gossip,wire-ext,stores,node,pow*}.js`,
`src/common/pointer.js`, `src/loader/{cache,doh,blob-chunk-store}.js`, `tools/*`, README, CRITIQUE,
DEPLOY, RESEARCH-DIGEST. Items 1-5 and 11 cost nothing to change now and must land before those modules
are written; most items in groups B to D rework code that exists (`render.js`, `torrent.js`, `sw.js`,
`config.js`, `boot.js`, `app.js`).

Item format: Sources (with the decision where critics conflict), Change, Amend (where in
ARCHITECTURE/INTERFACES), Accept (the check that closes the item).

## 1. MUST-FIX

### A. Site ledger: data model and sync

#### 1. Redactable blocks: payload outside the hash
Sources: SEC B3, DS B2. Decision: DS B2's layout wins over SEC B3's whole-op hash (`oph`). Op type,
key/list name and every control op stay inside `h`, so a stub still proves what it was and control ops
can never be redacted. SEC's relay rule is kept.
- Change: `e = {v, site, author, seq, prev, ts, bits, op, nonce}`. Payload ops carry a value hash:
  `put {t,k,vh}`, `append {t,l,vh}`, `profile {t,vh}`, `vh = hex(sha256(canonical(value)))`. Control ops
  (`policy`, `owner`, `tombstone`, `ban`, `allow`) keep their full content. `Block = {e, h, s, v?}`,
  `h = hex(sha256(canonical(e)))`, `s` signs `"mw-block-v1\n" + h`. A block verifies on `h`, PoW and `s`;
  when `v` is present also `sha256(canonical(v)) === op.vh` and the size limits. A block without `v` is
  valid and counts only as a DAG node. Tombstone = drop `v`, keep `{e,h,s}`. Relay a `v`-less block only
  together with the tombstone that justifies it; a node holding one without such a tombstone sends
  `WANT {h, v:true}` to other peers (bounded like orphan requests). Tombstones are final.
  `maxBlockBytes` covers `canonical(e) + canonical(v)`.
- Amend: ARCH §6.1, §6.4 (tombstone), §6.6 (delete the `verified:false` stub paragraph); INTERFACES
  `block.js`, `stores.js`, `gossip.js` (WANT `v` flag).
- Accept: unit: node A holds 50 blocks including a tombstoned one, a fresh node B syncs to the same `root`
  and state (DS §7 test 2); a stub with an altered `prev` fails `h`; a stub without its tombstone triggers
  a `v` request; a `policy` block cannot be stored without content.

#### 2. Owner policy applies causally and is enforced at ingest
Sources: SEC B2, DS M6, R06 §3.1.5. Decision: SEC's causal rule wins over DS's `fence` flag and R06's
`minEpoch`. It needs no owner judgement about when to fence, and it leaves no unfenced edit (for example
a `bits` increase) bypassable by a shallow `prev`. Accepted and documented cost: writes concurrent with a
tightening that violate it are dropped.
- Change: a non-owner block B is evaluated under the latest owner policy block P (in total order) such
  that B is not an ancestor of P; "applies from that point in the order" is deleted. `e.bits` must meet
  the governing policy's `bits` and `CONFIG.chain.bits` (checked first). Ingest rejects (does not store or
  relay) blocks that are invalid under the policy in effect at the local heads, except blocks WANTed as
  parents of blocks already held. Memoise each policy block's ancestor set.
- Amend: ARCH §6.2, §6.4; INTERFACES `state.js`, `node.js`.
- Accept: unit: owner switches to `writers:'owner'`, then a non-owner block with `prev` at depth 0 is a
  no-op on 1,000 shuffles; same for a `bits` increase; reducer stays under 50 ms at 5,000 blocks.

#### 3. Owner identity: owner-bound ledger id, owner-only roots, key succession, no root key in the browser
Sources: SEC M2.1, M3, M1.3; DS M5; REQ M8, m4. Decision: DS M5's hash-bound id wins over SEC's
`chain=<fp8>:<name>` prefix (8 hex digits = 32 bits, grindable).
- Change: (a) ledger id = `"mw1:" + b64url(sha256(ownerPub + "|" + (record.chain || scope))).slice(0, 27)`
  for signed pointers; unsigned pointers get `btih:<hex>`, no owner and a permanent "unmoderated" badge;
  `chain=` is ignored on unsigned records. (b) Only the owner creates roots: `publish.mjs` mints a genesis
  `policy` block, the pointer carries `gen=<h>`, non-owner blocks need at least one `prev`. (c) Succession
  op `{t:'owner', next}`; the reducer tracks the owner in effect causally (item 2), so a key rotation never
  re-interprets history; `ChainNode.open({expectedOwner})` reports "pointer and ledger owner differ"
  instead of re-reducing. Pointer `rot=` (signature by the previous owner over
  `"mw-rot-v1\n" + next + "\n" + seq`) makes a rotation silent; without it the TOFU prompt remains.
  (d) Remove "owner login" (root key import into the site origin). The owner signs
  `{t:'policy', moderators:[pub]}` in Node (`tools/`); browsers hold moderator keys only; moderators may
  `tombstone`, `ban` and write `_`-prefixed keys, never `policy` or `owner`; `mw.owner.policy` fails with
  `E_NOT_OWNER` in browsers. (e) HELLO carries `owner`; peers with a different `(site, owner)` are detached.
- Amend: ARCH §4 (`gen`, `rot`), §5 step 7 (settings), §6.1, §6.4, §6.5, §6.7, §9, §10 (keygen, genesis);
  INTERFACES `pointer.js chainIdFor`, `node.js`, `bridge.js`.
- Accept: unit: after an owner rotation, earlier tombstones still apply; a non-owner root is rejected; an
  ownerless view and an owned view of the same site get different ids. E2E: a moderator tombstones a post
  from a browser that never held `owner.jwk`.

#### 4. Abuse defaults and byte caps; proof-of-work described as a fee
Sources: SEC M1, DS M7, REQ M5, BRW m1, R06 §3.1.6. Decisions: REQ's default (`writers:'owner'` for owned
ledgers) wins over SEC's "keep `open` with budgets": secure by default, and the example opts in explicitly.
DS's caps win over SEC's 64 MiB and REQ's 32 MiB (phone storage and first-sync cost; R06 also lands on
4 KiB blocks). SEC's identity PoW (`bits + 6`) is rejected: about 4M hashes costs a phone seconds to a
minute and a GPU microseconds.
- Change: `DEFAULT_POLICY = {writers:'owner', bits:16, maxValueBytes:2048, maxChainBytes:8 MiB, ...}`
  (owner may raise the cap to 64 MiB), `LIMITS.maxBlockBytes = 4096`. Open writing is an explicit opt-in in
  the genesis policy. Past `maxChainBytes` only owner, moderator and allow-listed blocks are ingested, and
  the UI says so. Owner blocks are exempt from PoW. New owner ops: `ban{author}` (the author's blocks become
  no-ops and lose `v`) and `allow{add, remove}`. Mine with a synchronous JS or WASM SHA-256 in the worker,
  verify with WebCrypto, show progress and cancel. Rename the per-author "rate limit" to "ingress throttle"
  (local, never part of validity). Delete "sub-second on phones" and every "spam protection" phrase.
- Amend: ARCH §6.1, §6.2, §6.6 (replaces the 50,000-block cap); INTERFACES `block.js` (`LIMITS`,
  `DEFAULT_POLICY`), `pow.js`, `pow-worker.js`; examples/peer-guestbook genesis policy.
- Accept: a script minting 10,000 valid blocks into an open ledger leaves every node at 8 MiB or less;
  owner blocks are still accepted after the cap; PoW median and p95 on a mid-range Android are recorded.

#### 5. Ledger sync that is bounded, scales with depth and relays
Sources: SEC M2.2-3, m1; DS B4, M14; REQ M2; R06 §3.1.7. Decision: DS's depth-window reconciliation
replaces SEC's `HEADS` paging, because it also fixes the one-round-trip-per-depth bootstrap; SEC's
owner-only roots (item 3) bound the head count.
- Change: HELLO `{v, site, owner, n, d, root, heads}` with `d` = max depth, `root` = sha256 of the sorted
  `h` set, `heads` at most 32 by (depth desc, h asc), frame at most 15 KiB. New `SYNC`/`INV`: compare digests
  of 64-depth-level windows; equal = done; at most 64 blocks = `BLOCKS`; more = paged `INV` and the
  requester WANTs the misses; two windows in flight per peer, round-robin across peers with the same
  `root`. `ANN` carries hashes only and goes to all other peers on first acceptance, so every node relays;
  HELLO follows any head change, local or remote. Budgets: unsolicited 64 KiB/s per peer; solicited
  (answers to our WANT/SYNC) up to 1 MiB/s and `maxChainBytes`; one in-flight peer per hash (10 s, then the
  next); orphan pool 256 per peer and 2,000 total; WANT a missing parent from the orphan's sender first;
  never cache rate or budget rejections by hash. `dag.depth` is iterative; `order()` is a sort by
  (depth, h). Signatures are verified in a worker pool; the site renders before the ledger syncs.
- Amend: ARCH §6.3, §6.5; INTERFACES `gossip.js` (`MSG` adds SYNC, INV), `dag.js`, `node.js`.
- Accept: DS §7 tests 3 and 4; line topology A-B-C with A and C unconnected, a block written on A
  appears on C within 2 s; a fresh node bootstraps an 8 MiB ledger from one honest peer without banning it.

### B. Origins, rendering and loader security

#### 6. Hub mode: no isolation claim, shared origin only behind a gate, one origin per untrusted site
Sources: SEC B1, REQ B2; R04 F11 settles the open question both raised: a sandboxed frame without
`allow-same-origin` is not controlled by the Service Worker (WPT 29/29 on Chrome 155, Firefox 158,
Safari 27), so no sandbox variant can isolate SW-served sites. Decision: SEC's stable subdomain label
(derived from the ledger id) wins over R04's btih label, which would reset identity, pins and the ledger
database on every publish.
- Change: delete "stricter sandbox" and "hub mode isolation" (§3, §7, §13); drop the CSP `sandbox`
  response header (it adds nothing) and `allow-modals` (SEC m2). Shared-origin hub: a blocking interstitial
  before any tracker or peer connection (name, btih, size once known, trackers, publisher fingerprint, and the button
  "Load anyway: this site can read and change everything other sites stored on this hub"); never auto-load
  from `#magnet:`, `?mw=` or the protocol handler; banner "Sites on this hub share one browser origin and
  can access each other's data." Identity and ledger database are keyed by ledger id (stops cross-site
  linkage, not misuse). Untrusted or production hubs serve each site from its own origin,
  `https://<label>.<hub>/`, with `label = base32(sha256(ledgerId))[0:32]` for signed pointers and
  `base32(btih)` for bare magnets, wildcard TLS, and a Public Suffix List entry (stops cookie tossing).
- Amend: ARCH §3, §7, §13; INTERFACES `render.js`, `cache.js` (`identity:<ledgerId>`); DEPLOY.md.
- Accept: E2E: a `#magnet:` hub link opens no tracker or peer connection before the click; two subdomain
  sites cannot see each other's IndexedDB databases; a docs grep finds no isolation claim for shared hubs.

#### 7. Shell mode runs existing sites unchanged: same-URL iframe, `/_mw/` namespace, routing manifest [ED]
Sources: R04 R2/F12 (tested in Chromium 156); EX (the example had to forbid root-relative URLs and parse
`/_mw/s/<btih>/` in its 404 page); new requirement (a). Problem: mounting the site at
`/_mw/s/<btih>/<path>` breaks root-relative assets and links (`/css/app.css` misses, `<a href="/about">`
loads a nested shell), `fetch('/data.json')`, and every History-API router (`location.pathname` is
wrong). Most existing sites use all of these.
- Change: in per-domain and subdomain modes the iframe `src` is the top-level URL. SW dispatch: `/_mw/*`
  = loader assets; a navigation with `destination:'document'` = the shell; every other same-origin request
  from a site frame (iframe navigations, subresources) = the site file at that path, from the btih mapped
  to that client; requests made by the shell itself (web seed, `xs`) pass through. Loader assets live physically under `/_mw/` on the host, so `/_mw/sdk.js` is a real JS file even
  without a SW (this also fixes BRW B2's second defect). The SW script is `/mw-sw.js`: root path, because
  static hosts cannot send `Service-Worker-Allowed`, and no clash with a site's own `/sw.js`. A routing
  manifest `/.mw/site.json` inside the torrent (written by `publish.mjs` from flags or from
  `_redirects`/`_headers`) holds `spa` fallback, `cleanUrls`, `trailingSlash`, `redirects` and `headers`
  (CSP, Permissions-Policy, COOP/COEP), which the SW applies to site documents. `/_mw/s/<btih>/` survives
  only in the shared-origin demo hub, where root-relative URLs are documented as unsupported and top-level
  navigations into it get SEC M5.2's 302.
- Amend: ARCH §3 (reserved paths, shell asset list), §7 (routing, renderer; history mirroring becomes
  trivial), §10 (build outputs), §11 (drop the relative-URL rule); INTERFACES `sw/lib.js splitSitePath`,
  `render.js mountSite`, `build.mjs` outputs. Code: `src/sw/sw.js`, `src/sw/lib.js`, `src/loader/render.js`
  and `config.js paths` implement the old mount.
- Accept: E2E fixture site with root-relative assets and links, a History-API router,
  `fetch('/data.json')` and an SPA fallback route: it renders, deep-link reload and back/forward work, and
  `location.pathname` inside the frame equals the address-bar path.

#### 8. Framing and navigation safety
Source: SEC M5 (its top-level `/_mw/s/*` case mostly disappears with item 7).
- Change: the SW adds `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`
  to every site document, `frame-ancestors 'none'` and `X-Frame-Options: DENY` to the shell, and
  `Referrer-Policy: no-referrer` to both. The shell refuses to boot when
  `window.top !== window` ("Open this page directly"; this also stops a nested shell). DEPLOY: send
  `frame-ancestors 'none'` on the shell where the host allows headers. On each iframe `load` the shell adds a
  capture-phase click listener to the same-origin frame document that opens cross-origin links without a
  target in a new tab (`noopener`); if reading `iframe.contentWindow.location` throws, navigate the frame to
  `about:blank` and show "This site tried to open an external page" with an open-in-new-tab action. Keep
  both bridge checks and comment that `source` equality is not an origin check.
- Amend: ARCH §7, §13; INTERFACES `render.js`, `sw.js`.
- Accept: E2E: a foreign page framing the site renders nothing; an external link inside the site opens a
  new tab while the shell stays; the key-change "Confirm" cannot be clicked through a frame.

#### 9. Never serve or upload unverified cached bytes
Sources: SEC M4, DS m18. Decision [ED]: verify per file on serve and per piece on upload. SEC's full-site
hash before every mount costs about 0.5-1 s per cached render on a phone (and per page view in drop-in);
DS's "one random piece now, the rest at idle" lets poisoned bytes render in the meantime.
- Change: the expected btih comes from the currently resolved pointer, never from IndexedDB alone; check
  `sha1(bencode(info)) === btih` once per context; SHA-1 every piece covering a file before the SW first
  serves it, and every piece before `BlobChunkStore.get` first returns it; memoise verified piece indices in
  memory only (never persist a "verified" flag a same-origin script could forge); on mismatch
  `deleteSite(btih)` and fall back to network or download. Piece math follows
  `parseTorrent(torrentFile).files` order; pad files are zero-filled and never served (DS m18). State the
  limit: offline, with only the cached pointer, a same-origin attacker can rewrite pointer and files
  consistently.
- Amend: ARCH §5 step 4, §7, §13; INTERFACES `blob-chunk-store.js`, `sw.js`, `torrent.js seedFromCache`.
- Accept: flip one byte of a stored blob and the SW returns the network response and deletes the site;
  `BlobChunkStore.get` refuses the bad piece; verifying a 2 MB page is measured in the debug panel (target
  under 50 ms on desktop).

#### 10. Cap transport message length below the gossip layer
Sources: SEC B4, DS M10. Decision: SEC's pre-buffer patch wins over DS's one-second `_parserSize`
watchdog: it rejects before buffering and needs no timer per wire. The patch point `_onMessageLength`
exists in the vendored `webtorrent.min.js` (checked 2026-10-17).
- Change: in the torrent `'wire'` handler wrap `wire._onMessageLength` and destroy any wire that declares
  more than 256 KiB; set `wire.setTimeout(60000, true)` and `wire.setKeepAlive(true)`; count drops in the
  debug panel; a unit test fails the build if the patch point disappears from the bundle; send upstream a
  `maxMessageLength` option; record the patch in DEVIATIONS.
- Amend: ARCH §13 Peer DoS ("transport message length cap of 256 KiB on every wire"); INTERFACES
  `torrent.js`.
- Accept: DS §7 test 8: a peer declaring 4 GiB is dropped within 1 s and the heap stays flat.

#### 11. Pointer record v1: exact parse and signing rules, required expiry, new keys
Sources: SEC M7, REQ M9, DS m17. Decision: `exp` is required on signed records (SEC: it bounds replay of
an old signed record to new visitors) but never disables a cached copy (REQ M9). DS m17's "no `exp` by
default" is rejected.
- Change: parse by splitting on `;`, trimming, splitting at the first `=`, lowercasing keys and keeping
  values verbatim; `publish.mjs` percent-encodes values containing `;`, `=`, newline or non-ASCII, and only
  `dn` is decoded. Signing input: `"mw-pointer-v1\n"` + every pair except `sig` (unknown keys included) as
  `key=value`, sorted by key then value, joined by `\n`, then `"\n" + scope`; scope = lowercase A-label
  hostname (`new URL(...).hostname`) or `btih:<hex>`. Signed records require `exp` and `seq`;
  `exp - now` at most 400 days, publish default 90 days, owner warning at 14 days left; `seq` is monotonic
  per scope across key changes. Expiry applies to fresh sources (fragment, meta, DNS); an expired cached
  record still renders with "Pointer expired on <date>; showing the last known version." Several TXT
  records: highest valid `seq`, ties to the smallest `sig`. New keys: `xs` (repeatable), `gen`, `rot`, `cs`.
- Amend: ARCH §4; INTERFACES `pointer.js` (not yet written).
- Accept: unit vectors for key case, whitespace, an unknown key appended after signing (fails), `;` inside
  a percent-encoded URL, an IDN scope, an expired fresh record (rejected), an expired cached record
  (renders with the warning), and a `seq` rollback across a key rotation (refused).

#### 12. Third parties and consent: say who sees a visit, and say it before it happens
Sources: SEC M6, REQ M7, m6, DS m16; R05 F1 and summary items 2 and 7. Decisions: scope trackers with the
`client.add` option rather than SEC M6.1's info-dict `private` flag (webtorrent `lib/torrent.js` L140-141
and L342-347: a per-torrent `private:true` stops client-level trackers being appended, without changing the
infohash). DoH resolvers per R05; DS m16's AdGuard and NextDNS send no CORS headers. REQ's notice/gate split
with SEC's ordering.
- Change: (a) Trackers: build the client without `tracker.announce` (or pass `private:true` to `client.add`); a
  signed pointer's `tr` list is used exactly, defaults apply only to unsigned or raw magnets, and `magnetFromRecord` stops merging defaults into
  signed records. (b) DoH [ED for the subnet leak]: sequential Cloudflare JSON, then dns.sb, then Google with
  `edns_client_subnet=0.0.0.0/0` (by default Google forwards the visitor's /24 to the zone's name servers);
  GET with `Accept` only; operator override `<meta name="mw-doh">`; cache per TTL (minimum 5 min) and
  re-check on that schedule and on focus instead of every 10 min. The `<meta>` pointer is the primary
  bootstrap for per-domain sites and DNS is the update channel. Remove the `[RESEARCH-PENDING]`.
  (c) Consent: render the notice before the first announce. Per-domain and drop-in: notice (owner may set
  `consent=gate`). Hub: gate, unless the site is already cached. While gated, load from the web seed only
  when the pointer has `xs`/`ws`, otherwise nothing. Settings gain "Host only (no peer connections)" and an
  honest "Sharing off" label (section 4.5). (d) `tracker.mjs` refuses to start without
  `--allow <btih|file>` unless `--open` is given.
- Amend: ARCH §0, §4 (sources, DoH), §5 steps 3-4, §8 (consent), §10 (`tracker.mjs`), §13; INTERFACES
  `doh.js RESOLVERS`, `torrent.js`, `config.js`, `pointer.js`. Code: `app.js` shows the notice but starts
  downloading without waiting.
- Accept: E2E: a signed pointer with a local `tr` makes zero connections to `CONFIG.trackers` (network
  log); a hub first run opens no WebSocket before the click; a 30-minute session makes one DoH request per
  TTL.

### C. Availability and browsers

#### 13. Cold start from the web seed: add `xs=`
Sources: BRW M9, DS B1, REQ B1, all agreeing (webtorrent `lib/torrent.js` L370-377, L484-552, L575-581:
web seeds attach only after metadata; `xs` fetches the `.torrent`).
- Change: pointer `xs=<https URL of site.torrent>`, signed. `publish.mjs` writes `site.torrent` to
  `<ws base>/<name>.torrent` (drop-in: `/_mw/t/<btih>.torrent`) and sets `xs` whenever `--ws` or `--dropin`
  is given, in `pointer.txt`, `dns.txt`, `meta.html` and `magnet.txt`. `magnetFromRecord` emits `xs`;
  `TorrentManager.download({magnet, torrentFile?, maxBytes, signal})` prefers stored `.torrent` bytes;
  trackers and web seed start together; `E_NO_PEERS` only when neither `xs` nor `ws` exists. A bare magnet
  without either shows "This link has no web seed or torrent URL. It only loads while another visitor is
  online." §0 reads "reachable when no visitor is online, provided the pointer carries `ws=` and `xs=`".
- Amend: ARCH §0, §4, §5 step 4, §10; INTERFACES `pointer.js`, `torrent.js`.
- Accept: E2E "no seeder page": hub and per-domain render through `xs` and `ws` within 3 s on localhost,
  with `site.info().source === 'webseed'`.

#### 14. Web-seed HTTP contract: preflight, Range, timeouts
Sources: BRW M4, DS M11. Fact: webconn sends `Cache-Control` and `user-agent` request headers and uses
`AbortSignal.timeout` (`lib/webconn.js` L125-134), so every web-seed request is CORS-preflighted, and
Safari before 16 throws before sending.
- Change: ARCH §1 and DEPLOY state the whole contract: OPTIONS answered with
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: *` (at least `Range, Cache-Control`),
  `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, ETag`; GET with `Range`
  returns 206. `publish.mjs` emits the S3 CORS JSON and the CloudFront note (allow OPTIONS, a
  CORS-with-preflight response-headers policy, HTTP/2). `tools/check-webseed.mjs` (also
  `publish --verify-ws`) probes OPTIONS and `Range: bytes=0-0`; the loader runs the same probe once per btih
  and drops `ws` with "Web seed misconfigured (no Range support)". `boot.js` polyfills
  `AbortSignal.timeout`. The SW passes web-seed requests through (they come from the shell client),
  except its own drop-in rewrite path `/_mw/ws/` (section 5, 3.4.7), and never caches a 206; `/ws/` is
  reserved on loader origins. Tracker and web-seed `warning` events reach the UI.
- Amend: ARCH §1 (web-seed bullet), §7, §10; DEPLOY.md; INTERFACES `torrent.js`, tools.
- Accept: `check-webseed` passes against `dev-server` and fails with a clear message on a host that
  answers `Range` with 200; Playwright web-seed-only downloads pass in Chromium, Firefox and WebKit.

#### 15. Discovery plane fit for production [ED]
Sources: R02 summary items 1-4, 7, 10; R03 summary item 4; BRW m8; DS m16. Facts: `src/loader/config.js`
ships `tracker.btorrent.xyz` (its DNS answer is 127.0.0.1) and `tracker.files.fm:7073` (403 unless
`Origin: https://files.fm`), so half the default list is dead; public trackers close idle sockets after
about 125-185 s, and the stock client then waits 10 s plus up to 5 min before reconnecting.
- Change: default list `wss://tracker.webtorrent.dev`, `wss://tracker.openwebtorrent.com`,
  `wss://tracker.novage.com.ua`, `wss://open.ftorrent.com` (live on 2026-10-14), checked against EasyList,
  EasyPrivacy and Brave's lists before it is frozen. Production default: the owner's own tracker
  (`aquatic_ws` or `wt-tracker`, allow-listed per item 12) plus two public ones in the signed `tr`. Keep
  every tracker socket alive with a `scrape` for the torrent every 90 s (no offers, unlike an announce);
  rebuild discovery on `online` and on visible-after-hidden (item 19). STUN: `stun.cloudflare.com:3478` and
  `global.stun.twilio.com:3478` (Google's server has no published terms). Record all of it in
  RESEARCH-DIGEST.md.
- Amend: INTERFACES `config.js`; ARCH §0, §14; DEPLOY.md (running a tracker).
- Accept: a 30-minute idle desktop tab keeps at least one tracker socket open; the block-list check passes;
  DEMO-RESULTS.md records connect times per tracker.

#### 16. Browser floor and polyfills
Sources: BRW B1, M5, M4(1); REQ m3. Verified: the vendored bundle calls `e.toHex()`,
`Uint8Array.fromHex(e)` and `e.toBase64()` without guards, and those exist only in Chrome/Edge 140+,
Firefox 133+ and Safari 18.2+. Conflict: REQ m3 says `BigInt` is unused; BRW M5 is right (the bundle's
bencoder calls `BigInt()`, uint8-util's `equal()` uses `BigInt64Array`), so the check stays.
- Change: declare the floor, polyfills included: Safari/iOS 15.4, Chromium 110 (Chrome, Edge, Samsung
  Internet, Brave, Android WebView), Firefox 115 ESR; record it in `config.js` and README. `boot.js` installs
  guarded `Uint8Array.prototype.toHex/toBase64` and `Uint8Array.fromHex/fromBase64` (honouring `alphabet`
  and `omitPadding`, `SyntaxError` on bad input) and `AbortSignal.timeout`, then self-tests them; a failure
  is reported like a missing feature, with browser versions. `build.mjs` targets
  `['es2020', 'safari15.4', 'chrome110', 'firefox115']` for loader, SDK, SW and worker; the SW and the PoW
  worker are classic bundles (module SWs need Firefox 147+, R04 R3); the vendored bundle goes through
  esbuild at that target as a syntax gate; `npm test` lints `src/` against post-floor APIs
  (`Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, Set methods, `URL.parse`,
  `AbortSignal.any`, iterator helpers, regex `v` flag). Code: `boot.js` is already parse-safe and checks
  `isSecureContext`.
- Amend: ARCH §1, §5 step 1, §10; INTERFACES `boot.js`, `config.js`, `build.mjs`.
- Accept: Playwright WebKit, and Chromium with the four `Uint8Array` methods deleted, both complete a
  download; the lint fails on `Promise.withResolvers` in `src/`.

#### 17. Service Worker registration timing, and a degraded mode that renders
Sources: BRW M6, B2; REQ M6; R04 F10, F15, F20. Decision: BRW's 15 s cap over REQ's 20 s (either works).
Correction: Firefox private windows have Service Workers since Firefox 140 (R04 F15), so BRW B2's
Firefox-private test does not exercise degraded mode. Degraded mode still matters for iOS in-app WebViews,
Lockdown Mode, Tor and Firefox ESR 128.
- Change: degrade only when `!('serviceWorker' in navigator)` or `register()` rejects; otherwise await
  `navigator.serviceWorker.ready` (15 s cap, "Preparing offline engine..."). Shell mode: if the page is
  still uncontrolled after `ready`, reload once (sessionStorage guard) before mounting, unless a spike shows
  Firefox and WebKit control the first iframe navigation (R04 F10 tested Chromium only). Install precaches
  the `/_mw/` shell files except `webtorrent.min.js`, which is cached on first fetch. `index.html` carries no
  static CSP meta: `boot.js` inserts the §13 policy, or in degraded mode one that adds `blob:` to
  `script-src`, `style-src`, `font-src`, `media-src` and `connect-src` and `'unsafe-inline'` to
  `script-src` (srcdoc and blob documents inherit their creator's CSP). `/_mw/sdk.js` is a real file
  (item 7).
- Amend: ARCH §5 step 2, §7 (degraded mode), §13 (CSP); INTERFACES `render.js registerServiceWorker`.
  Code: `config.js timeouts.swMs = 3000` and the timeout path in `render.js` change.
- Accept: E2E first visit under slow-3G throttling renders in SW mode; a Playwright context with
  `serviceWorkers: 'block'` renders the example styled with `mw.ready()` resolving.

#### 18. Browser storage correctness: chunk store, IndexedDB transactions, identity key
Sources: BRW M7, m4; R06 F53 and §3.1.8 [ED for the identity part].
- Change: never use WebTorrent's default store. `fsa-chunk-store` deletes the `chunks` directory of every
  tab on the origin when its module loads, and on Safari 15.2-18.1 its `createWritable` polyfill spawns a
  module Worker per write. Download with `client.add(magnet, {store: MemoryChunkStore})` (a 25-line store in
  `src/loader/`) and build each file's Blob on `file.on('done')`. IndexedDB: build every Blob before opening
  a readwrite transaction and never `await` inside it (Safari and Firefox auto-commit, giving
  `TransactionInactiveError`; Chrome is lenient, so the spike could not show it); handle `onversionchange`
  and `blocked` (SW and page both hold connections); retry once on Safari `UnknownError`. Identity: store the
  CryptoKey as the whole value of a dedicated `keys` store (WebKit bug 177350), run a round-trip self-test
  (put, get, sign, verify) at creation, and on failure (iOS Safari reports `DataCloneError` for ECDSA key
  pairs, R06 F53) store the private JWK and import it non-extractable per session. Settings: Export and
  Import identity.
- Amend: ARCH §1 (chunk-store bullet), §5 step 4, §6.1 (identity); INTERFACES `cache.js` (identity store),
  `torrent.js download`.
- Accept: two tabs downloading different sites on one origin both complete; Playwright WebKit saves a
  30-file site; the identity survives a reload in WebKit; the forced self-test-failure path can still post.

#### 19. Upload and visibility policy that matches what platforms allow
Sources: BRW M2, M3; DS B3, M12; REQ M10. Decision: REQ M10 wins for desktop (keep seeding while hidden)
over the 10-minute pause, because hidden desktop tabs are the swarm's main steady peer capacity and
data channels keep flowing there; DS's destroy-after-budget applies on battery and mobile.
- Change: an unknown network type on a mobile device (iOS and Firefox expose no Network Information API)
  uses the cellular column (uploads off, 24 MiB cap) until the visitor picks "Share on this network". Mobile
  hidden = nothing runs: persistence is write-through (a block is in IndexedDB before `put()` resolves and
  before it is relayed; `meta` is flushed on `visibilitychange` to hidden); `pagehide` is best effort; on
  `pageshow` with `persisted`, on visible after more than 60 s hidden, and on `online`, destroy and rebuild
  the client (resets tracker backoff and dead peers). Desktop hidden keeps seeding unless uploads are off or
  the battery is discharging; after 10 min hidden on battery, `client.destroy()` (`pause()` keeps
  announcing five offers per interval). Uploads off = choke lock, never `throttleUpload(0)` (rate 0 stalls
  every outbound byte, web seed included). Code: `torrent.js` already uses a choke lock; §8 still says
  `throttleUpload(0)`. Shaping only at 32 KiB/s or more.
- Amend: ARCH §5 step 8, §8 (table and text); INTERFACES `policy.js`.
- Accept: DS §7 test 5 (uploads off: peer download, web-seed download and two-way gossip complete); iOS
  manual: background for 2 min, foreground, peers above 0 within 10 s; Playwright WebKit with a mobile UA
  has uploads off by default.

### D. Production and honesty

#### 20. Service Worker update safety, kill switch, and the trust root
Sources: R04 F13, F15, F20, R6 [ED]; REQ M4; SEC M10. Decision: REQ M4's cache-first shell navigation is
adopted for speed and offline use, but SEC's wording wins: it protects nothing against the host, because
the host serves `/mw-sw.js`.
- Change: the SW URL never changes (`/mw-sw.js`), is served with `Cache-Control: no-cache` and registered
  with `updateViaCache: 'none'`. Every SW-to-page message carries a protocol version, with a handshake on
  `controllerchange`; the page reloads at most once per load (sessionStorage guard); every navigation is
  answered (Firefox bypasses a SW whose navigations fault and unregisters it after three faults). Kill
  switch, documented in DEPLOY: deploying the ten-line self-unregistering `/mw-sw.js` (clears our caches,
  claims clients, navigates them) restores the plain site for every returning visitor; purge the CDN on
  every deploy. Top-level shell navigations are cache-first from the precache. §13's SRI sentence becomes:
  "The static host is the trust root on every visit, including SW updates. SRI on the two static script
  tags is defence in depth only."
- Amend: ARCH §7, §13; DEPLOY.md; INTERFACES `sw.js`, `render.js`.
- Accept: E2E: after deploying the kill-switch worker, the next navigation is uncontrolled and the plain
  host response renders; an old page with a new SW shows "Reload" instead of breaking.

#### 21. Takedown: superseded versions are deleted and stop seeding
Source: SEC M8.1.
- Change: when a newer valid pointer replaces a btih for a scope, stop seeding the old btih at once and
  `deleteSite(old)` as soon as no client maps to it (drop-in pages may still need lazy chunks); keep at most
  the current version and that one. DEPLOY: "To remove content, publish a new version. Visitors drop the old
  one on their next load; devices that stay offline keep it until they reconnect." Posts are taken down with
  a tombstone (best effort, item 1).
- Amend: ARCH §5 step 8, §6.6; DEPLOY.md.
- Accept: E2E: publish `seq + 1` and reload; the old btih is gone from IndexedDB and absent from tracker
  announces.

#### 22. HTTPS, root path and deploy order
Sources: SEC M9, BRW M8, REQ B3, m2; deploy order [ED].
- Change: `boot.js` reports an insecure context before anything else (present in code; the text must be
  "This page must be served over HTTPS (or localhost)") and refuses a non-root deployment with a clear
  message (the `/mw-sw.js` scope needs the origin root). `npm run demo` prints its tier: desktop localhost =
  full mode; phone on the LAN = `dev-server --tls` and `tracker --tls` with the mkcert root installed on the
  phone (or `adb reverse` on Android), otherwise boot stops with the insecure-context message; real test = GitHub Pages, Cloudflare
  Pages or CloudFront. The dev CSP allows `wss://<lan-ip>:*`. DEPLOY.md: S3 website endpoints are HTTP-only
  (put CloudFront in front, or use Pages); SW served as `text/javascript`; deploy order is (1) upload site
  files and `.torrent` (drop-in: every non-HTML file before any HTML file), (2) `check-webseed`, (3) switch
  the pointer (shell meta, stamped HTML or TXT), (4) keep the previous version's files for at least 7 days.
- Amend: ARCH §10, §11; DEPLOY.md; INTERFACES tools (`dev-server`, `tracker --tls`).
- Accept: `npm run demo -- --tls` loads in full mode on an iPhone and an Android phone over the LAN;
  `publish.mjs` will not print the pointer until `--verify-ws` passes.

#### 23. Specify drop-in (embedded) mode
Source: new requirement (a). The constraints come from SEC (same-origin trust), BRW (SW lifecycle, CSP),
DS (engine churn, web-seed egress) and REQ (crawler parity, honesty).
- Change: add ARCH §3.4 as written in section 5 of this review, and the mode table to §3. INTERFACES:
  `src/dropin/mw.js`, `src/sw/core.js` (`owns(event)` synchronous, `handle(event)`), build outputs
  `dist/_mw/*` and `dist/mw-sw.js`, `publish.mjs --dropin`.
- Amend: ARCH §3, new §3.4, §9 (direct SDK binding), §10, §12; INTERFACES as listed.
- Accept: E2E fixture "existing site" (multi-page, root-relative URLs, hashed assets, a variant with its
  own Workbox SW): (1) with JavaScript off it is identical to the host; (2) the second page view serves
  assets from IndexedDB (network log) and never mixes versions across a deploy; (3) with the site's own SW
  present ours does not register and the site's SW keeps working; (4) the kill switch restores host-only
  serving; (5) Lighthouse LCP and CLS on the first page view stay within 5% of the same site without the tag.

#### 24. The honesty layer
Sources: REQ B4, M4, M11, m4, m7; DS M9, M13, M21; SEC section 4; BRW m7.
- Change: write README ("What it is / what it is not": REQ §4's twelve statements plus drop-in versus
  shell and the SEO consequence), CRITIQUE.md, DEPLOY.md and RESEARCH-DIGEST.md (decisions: trackers per
  R02, STUN per R03, SW per R04, DoH per R05, ledger per R06). Fix in ARCH: §0 web-seed sentence (item 13);
  §13 content integrity ("protects the files against tampering by peers, not by your host"); §6.1
  "sub-second"; §11 LAN claim; §10 protocol handler (installed desktop PWAs only); §2 and G4 wording per
  section 4; the spike's "about 170 ms" labelled as a loopback figure. Use section 4's strings verbatim.
- Amend: README.md, docs/CRITIQUE.md, docs/DEPLOY.md, docs/research/RESEARCH-DIGEST.md; ARCH §0, §2, §6.1,
  §10, §11, §13, §14.
- Accept: a grep of docs and UI strings for "blockchain", "serverless", "isolation" and "sub-second" finds
  only approved phrasing; every `[RESEARCH-PENDING]` is resolved or listed in RESEARCH-DIGEST.md.

#### 25. Release gate before anything is called production-ready
Sources: BRW device matrix; DS M9 gate and §7; REQ M11; R04 R9; R06 §3.1.11.
- Change: §12 gains a manual gate, run per release and recorded in `docs/DEMO-RESULTS.md`: a real domain
  with a `_magnet` TXT record; iPhone on iOS 18.x plus one iOS 16 or 17 device; Android Chrome on LTE;
  Samsung Internet; Firefox normal and private; Brave with Shields aggressive; Edge with sleeping tabs; LTE
  phone against home-Wi-Fi laptop connect rate in both directions; cold start from the web seed; update
  flow; key-change prompt; kill switch; the drop-in fixture; 7-day persistence on iOS. No production-ready
  claim until it passes.
- Amend: ARCH §12; docs/DEMO-RESULTS.md (new).
- Accept: DEMO-RESULTS.md holds dates, versions and numbers for every row, with failures linked to issues.

### Critic claims corrected by research or code
- Firefox private windows have Service Workers since Firefox 140 (R04 F15). ARCH §5 step 2, SEC and BRW
  treat them as no-SW; test degraded mode with SWs blocked instead (item 17).
- REQ m3 ("BigInt is unused"): wrong; see item 16.
- DS m16's third-resolver candidates (AdGuard, NextDNS) send no CORS headers and Quad9's JSON API is
  retired (R05 summary 2); dns.sb is the usable third (item 12).
- SEC M6.1 (`private` in the info dict): unnecessary; the `client.add` option has the same effect without a
  new infohash (item 12).
- DS B3 (`throttleUpload(0)`): already avoided in `src/loader/torrent.js`; the spec text and test are the
  remaining work (item 19).
- BRW M5(a) (literal `import()` in `boot.js`) and REQ B3's secure-context check: already handled in code.
- REQ B4 ("research missing"): R01-R06 now exist; RESEARCH-DIGEST.md, README, CRITIQUE and DEPLOY do not.

## 2. SHOULD-FIX

#### S1. Ledger gossip across versions
Source: REQ M1 (visitors on btih A and btih B sit in different swarms, so the ledger splits during every
rollout until someone straddles both).
- Change: each node also joins a deterministic one-piece "anchor" torrent whose content is the string
  `mw-ledger/<ledgerId>` (every node can build and seed it, so its metadata is always available) and
  attaches gossip to both swarms. If the spike shows WebTorrent keeps metadata-less wires open, a bare
  infohash `sha1("mw-ledger/" + id)` is enough. On cellular, leave the version swarm once the site is
  complete and uploads are off, so the anchor does not double the announce cost.
- Amend: ARCH §6.5; INTERFACES `wire-ext.js attachToTorrent`, `torrent.js`.
- Accept: a tab on version A and a tab on version B exchange a guestbook entry within 10 s.

#### S2. Ledger durability floor
Source: DS M13.
- Change: pointer `cs=<https URL>` of a gzip JSON export; `tools/snapshot.mjs` (fed by `pin.mjs` or the
  owner's export) writes it next to the web seed; the loader fetches it after render and ingests up to
  `maxChainBytes`.
- Amend: ARCH §4, §6.6, §10.
- Accept: a fresh visitor with no peers online sees every entry up to the snapshot.

#### S3. Identity and storage durability
Sources: BRW M1, m6; DS M15; REQ M3; SEC M8.2, M8.4.
- Change: `navigator.storage.persist()` after consent, result shown in Settings; passphrase-wrapped
  identity export (AES-GCM under PBKDF2) on top of item 18's JWK path; "First time on this device" whenever
  a signed record arrives without a pin; storage budget 512 MiB desktop and 128 MiB mobile with LRU by last
  visit (never the current site) and "Forget this site"; usage in Settings; on iOS the hint "Add to Home
  Screen keeps this site and your identity" (amended in code review round 1, because a Home Screen app has
  its own storage and starts empty: "Safari may delete this site's copy and your identity after 7 days
  without a visit. Added to the Home Screen, the site keeps its own copy and identity, but it starts empty
  there: export your identity here and import it in the Home Screen app.", shown on iPhone and iPadOS).
- Amend: ARCH §4 (TOFU), §5, §6.1; INTERFACES `cache.js`, `ui.js`.
- Accept: WebKit with site data cleared shows the first-time notice; an over-budget hub evicts the oldest site.

#### S4. Enforce `maxConns` on WebRTC wires
Source: DS M8 (`client.maxConns` gates only TCP dials, which browsers lack).
- Change: in the `'wire'` handler destroy new wires above `policy.maxConns`, keeping at least two for
  gossip while seeding; disclose that each announce still opens five short-lived connections.
- Amend: ARCH §8; INTERFACES `torrent.js`.
- Accept: DS §7 test 6 (40 offered wires, at most 10 kept on the mobile profile).

#### S5. Diagnose within 5 seconds
Sources: REQ m5; DS m16, M9.
- Change: the status line separates tracker unreachable, nobody online (announce `complete`/`incomplete`),
  N peer connections failed (likely NAT), and no web seed in the pointer, each with the owner's remedy
  ("add `xs=` and `ws=`, or run `pin.mjs`"); implement DS m16's failure-matrix texts.
- Amend: ARCH §5; INTERFACES `ui.js`, `torrent.js` events.
- Accept: each matrix row produces its text in an E2E fault-injection run.

#### S6. One swarm node per origin
Sources: DS m20; R06 §3.1.8.
- Change: `navigator.locks.request('mw-swarm-' + btih, ...)` elects the node; other tabs get state and
  forward writes over BroadcastChannel (Safari 15.4+). Required in drop-in, where many tabs of one site are
  normal.
- Amend: ARCH §5; INTERFACES `app.js`, `src/dropin/mw.js`.
- Accept: two tabs of one site open one set of tracker sockets.

#### S7. Supply chain
Sources: SEC M10; BRW m7a.
- Change: `.npmrc` with `ignore-scripts=true` (or a real `@lavamoat/allow-scripts`; the current
  `allowScripts` key is inert); `build.lock.json` pins the sha256 of `webtorrent.min.js` and the build fails
  on mismatch; SRI stays on the static script tags only.
- **Correction (v0.2.1, DIGEST-AMENDMENTS F8; PRODUCTION-DIGEST P0-12, C14; research w2b-05 F34):** "the
  `allowScripts` key is inert" is wrong for current npm. npm 11.19 and later read `allowScripts` itself as a
  working default-deny: a planted `postinstall` was blocked unless listed (measured on npm 11.19.1). The key
  stays in `package.json`, `.npmrc` keeps `ignore-scripts=true` as the belt to those braces, and CI should
  use npm >= 11.19 (`min-release-age=7`, `save-exact` and `npm audit signatures` are the digest's further
  supply-chain items, D17).
- Amend: ARCH §10, §13; `package.json`, `build.mjs`.
- Accept: the build fails after a one-byte change to the vendored bundle.

#### S8. Browsers without WebRTC load from the host
Sources: BRW m2; REQ m3; R03 summary item 8.
- Change: `RTCPeerConnection` becomes a soft check: absent means a "Host only, not sharing" badge, the
  ledger from the snapshot (S2) if any, no gossip. Lockdown Mode gets its own message ("Turn off Lockdown
  Mode for this website"), since it also removes Service Workers.
- Amend: ARCH §5 step 1; INTERFACES `boot.js`.
- Accept: Playwright with `RTCPeerConnection` deleted renders through `xs` and `ws`.

#### S9. Ledger hygiene
Sources: DS M6, m17; SEC M8.3, m5; REQ m7.
- Change: `prev` = own last block + the max-depth head + the oldest heads; `seq` is informational and never
  validated; lists and "newest" follow total order only; `ts` is rounded to the minute and shown as
  claimed; keys starting with `_` are writable only by the owner and moderators (item 3); the wire adapter skips `webSeed` wires, ignores `mw_chain`
  messages before the extended handshake and detaches on a `(site, owner)` mismatch; HELLO and the
  extension name (`mw_chain1`) carry a protocol version.
- Amend: ARCH §6.1, §6.4, §6.5, §9; INTERFACES `node.js`, `wire-ext.js`.
- Accept: one unit test per rule.

#### S10. Mobile viewport
Source: BRW m3.
- Change: viewport `width=device-width, initial-scale=1, viewport-fit=cover,
  interactive-widget=resizes-content`; iframe `position: fixed; inset: 0`; `100dvh` with a `100vh`
  fallback; status bar padded by `env(safe-area-inset-bottom)`.
- Amend: `src/loader/index.html`, `src/loader/ui.css`.
- Accept: iPhone and Android screenshots with toolbars and the keyboard open.

#### S11. Media `Range` from the SW
Source: BRW m5.
- Change: unit vectors in `sw/lib.js parseRange` for the `bytes=0-1` probe, suffix ranges and 416; a short
  MP4 in the example site.
- Amend: ARCH §7; INTERFACES `sw/lib.js`.
- Accept: playback and seeking on iOS, manual.

#### S12. Tools hygiene
Sources: SEC m4; EX.
- Change: `keygen.mjs` writes `owner.jwk` with mode 0600 and prints only the fingerprint; `publish.mjs`
  refuses group- or world-readable keys and has an ignore list (README.md, dotfiles).
- Amend: ARCH §10.
- Accept: unit tests in `test/unit/tools*`.

#### S13. Owner health probe [ED]
Source: production readiness; the design has no analytics, so owners need another way to learn their site
is unreachable.
- Change: `tools/check-site.mjs <url>` for CI or cron: resolve the pointer (meta and DoH), fetch `xs`,
  probe the web seed, connect each tracker, optionally load headless; non-zero exit on any failure.
- Amend: ARCH §10; DEPLOY.md.
- Accept: a CI job turns red when the web seed is removed.

## 3. LATER / v2
- Owner-signed checkpoints, history pruning and range-based set reconciliation (negentropy) for large
  ledgers (R06 §3.1.5, §3.1.7).
- Ed25519, algorithm-tagged identities (R06 F50: only if P-256 persistence fails on real devices).
- BitTorrent v2/hybrid torrents for per-file roots and cross-version deduplication (webtorrent has no
  BEP 52, R01 summary item 4).
- TURN with short-lived credentials minted in CI or by a tiny edge function, opt-in (R03 summary 5-6).
- A second discovery plane over Nostr or MQTT (R02 summary 9-10).
- An isolated bare-magnet hub: opaque-origin degraded renderer, in-memory identity, SDK handshake with
  `'*'` and the MessagePort as capability (REQ B2(b), SEC B1.5, m3).
- Drop-in on multi-page sites: opt-in soft navigation, or "upgrade to shell" after the first page.
- Capability write mode, deterministic per-author quotas, local mute lists and local "hide and purge"
  (R06 §3.1.5-3.1.6, DS M7, SEC M8.3).
- Cross-origin isolation (COOP/COEP) for hosted sites (R04 R8).
- Streaming media before the download completes; partial copies that seed only viewed files.
- IANA registration of `_magnet` (R05 summary 8); a PSL listing service for hub operators.
- The `magnet:` protocol handler (installed desktop Chromium PWAs only, BRW m7b); not advertised in v1.

## 4. Wording decisions for user-facing docs
All strings below are final. No em dashes, straight quotes, contractions allowed.

### 4.1 The ledger (the "chain")
Verdict: "blockchain" is not defensible as a description. The structure is blockchain-shaped (hash-linked,
signed), but the properties people infer from the word (global agreement, finality, Sybil-resistant
ordering, availability without online peers) are exactly the ones it lacks (R06 summary 1-3, DS §6).
"Blockchain" may appear once, in README's "Why not a blockchain?" paragraph, as an analogy. Never in the
UI, `package.json`, SDK names or the tagline. Product name: "site ledger" (code keeps `src/chain/`; the
SDK stays `mw.db`).
- One-liner (README lede, `package.json` description): "Site ledger: a signed, hash-linked log that every
  visitor copies and verifies. No mining, no consensus, no finality."
- Info panel: "Shared data on this site is kept in a signed log. Every visitor keeps a copy and checks
  every entry, so nobody can forge or quietly rewrite one. There's no mining and no single 'latest'
  version. Two visitors can briefly see different states, and they catch up when they connect."
- README, "What it is not": "It isn't a cryptocurrency chain. There's no proof-of-work consensus; the small
  proof-of-work on each post is a spam fee, not security. There's no finality: an entry that arrives late
  can change what 'latest' means. Nothing is available while nobody with a copy is online, so the snapshot
  on your host and a pinned node are the floor. There's no anonymity: peers see each other's IP addresses."
- "Visitors keep it alive": "Each visit copies the log to one more device and serves it to others while
  the page is open. At any moment the log is reachable only if someone with a copy is online, and for small
  sites that's usually nobody. Your host's snapshot keeps it loadable and a pinned node keeps it always on."
- SDK docs: "Everything written with mw.db is public and copied to every visitor. Deleting an entry hides
  it for visitors who receive the deletion. Copies on devices that never sync again stay where they are."
- Status bar: "Ledger: 1,204 entries, in sync with 3 peers" (in sync = same `root`).

### 4.2 "Serverless"
Verdict: unqualified "serverless" is misleading. Every visit loads the loader from an HTTPS host, which is
the trust root; WebSocket trackers and STUN servers connect visitors; DNS pointers need a DoH service; and
availability with nobody online needs the files on the host and, for the ledger, a snapshot or pinned
node. "No backend" is accurate.
- Tagline: "Websites loaded by magnet link, peer-to-peer, from a plain static host. No backend."
- Directly under it: "No backend means there's no application server or database for you to run. You
  still need an HTTPS static host, which serves the loader on every visit and keeps the site loading when
  nobody else is online. Visitors find each other through WebSocket trackers and STUN servers, public ones
  or your own. If you publish the pointer in DNS, a DNS-over-HTTPS service reads it for the browser."
- Never: "serverless", "no servers", "unstoppable", "censorship-resistant", "fully decentralized".

### 4.3 Mobile
- README: "Phones load the site and sync the ledger while the page is open and on screen. iOS stops peer
  connections within seconds of switching apps or locking the screen, and Android can do the same. On
  mobile data, sharing is off unless the visitor turns it on. Safari may delete the site's local copy and
  the visitor's posting identity after 7 days without a visit, unless the site is added to the Home Screen."
- Status line on phones: "Sharing only while this page is open and on screen."
- Mobile data or unknown network: "On mobile data: downloading only. Tap to share."
- Do not promise offline use on iOS; say "saved on this device until Safari clears it".

### 4.4 DNS and DoH trust
- README: "Your domain still serves a small loader over HTTPS. A DNS record can't replace your host. By
  default the pointer is a <meta> tag in that loader page. If you publish it in DNS instead, the loader reads
  it through a DNS-over-HTTPS service (Cloudflare first, then dns.sb or Google), because browsers can't read
  DNS records directly. That service sees the site's name and the visitor's IP address. Pointers are signed
  with your site key and the key is remembered on the first visit. Later visits refuse a pointer signed by a
  different key unless the visitor confirms. DNSSEC is shown when your zone has it, but it isn't required."
- Trust root: "A first visit trusts your HTTPS host and your DNS. Later visits also check the remembered site
  key. Peer-to-peer delivery protects the site's files from tampering by other visitors, not by your host:
  whoever controls your host or your DNS controls what visitors run."
- Pointer badge: "Pointer: DNS via Cloudflare, signed, key remembered since 2026-10-17" or "Pointer: page
  tag, signed".

### 4.5 Visitor IP exposure and seeding consent
- Notice (per-domain and drop-in default): "This site is delivered peer-to-peer. While it's open, your
  browser connects to other visitors and to connection servers, and they can see your IP address and that
  you're viewing this site. On Wi-Fi your browser also shares this site's files and posts with other
  visitors. [Settings] [OK]"
- Gate (hub, or `consent=gate`): "Load this site peer-to-peer? Other visitors and the connection servers
  will see your IP address and that you're viewing this site. [Load] [Load from host only] [Cancel]" ("Load
  from host only" appears only when the pointer has a web seed.)
- Settings (amended in code review round 1: Off never stopped relaying posts): "Share with other visitors:
  On / Off. Off stops sharing this site's files. Posts are still passed between connected visitors, and your
  IP stays visible. Choose Host only to stop all peer connections." and "Host only: no peer connections.
  Slower, and shared data won't sync."
- README: "There's no private mode. Peers, trackers and STUN servers see each visitor's IP address, and
  anyone who knows the site's infohash can see who's online. There are no relay (TURN) servers, so some
  visitors, often on mobile data, can't reach peers and load from your host instead. While the page is
  open, visitors pass on your site's files and its posts. To remove files, publish a new version; visitors
  drop the old one on their next load. To remove a post, delete it; visitors honour that when they receive
  it."
- Owner-facing (DEPLOY, CRITIQUE): "With open writing, every visitor stores and passes on posts by
  strangers. You moderate what your site makes visitors redistribute."

## 5. Spec delta: drop-in mode (add to ARCHITECTURE.md)

Add this table to §3, then paste §3.4 after it.

| Mode | Documents from | Other files from | Engine lives | Origin | For |
|---|---|---|---|---|---|
| Shell | torrent, same-URL iframe (item 7) | torrent | one long-lived page | the site's domain | P2P-first sites; returning visitors survive a host outage |
| Drop-in | the static host | torrent (stamped version), else host | one page view | the site's domain | migrating existing static sites |
| Hub, subdomain | torrent | torrent | one long-lived page | `<label>.<hub>` | magnet links from many publishers |
| Hub, shared origin | torrent under `/_mw/s/<btih>/` | torrent | one long-lived page | the hub | one publisher, demos (item 6) |

**§3.4 Drop-in mode (existing static sites)**

**3.4.1 What a site adds.** Every HTML page gets `<script type="module" src="/_mw/mw.js" async></script>`.
The deploy pipeline runs `publish.mjs --dropin <dir>`, which (1) builds a v1 torrent of every non-HTML
file (fixed `name`, sorted paths, 256 KiB pieces, plus `/.mw/files.json` with each file's SHA-256),
(2) writes `/_mw/t/<btih>.torrent`, the runtime under `/_mw/` and `/mw-sw.js`, (3) stamps
`<meta name="mw-pointer" content="...; xs=/_mw/t/<btih>.torrent; ...">` as the first child of `<head>` in
every HTML file, and (4) refuses to run if the site already uses `/_mw/` or `/mw-sw.js`. HTML stays out of
the torrent: a document cannot carry the pointer to a torrent that contains it, and documents served by the
host keep its redirects, clean URLs, 404s, response headers (CSP, COOP/COEP) and SEO exactly as they are.
Drop-in delivers subresources peer-to-peer after the first page view, offline use of pages already
visited, and the site ledger with the SDK. It does not keep the site up for new visitors when the host is
down.

**3.4.2 The Service Worker over existing pages.** `/mw-sw.js` is a classic script at the root path
(static hosts cannot send `Service-Worker-Allowed`), served with `Cache-Control: no-cache`, registered with
scope `/` and `updateViaCache: 'none'` after `load`. It decides every request synchronously from in-memory
state, never delays a request to decide, and passes the request through when unsure (for example right
after a cold start, before its index is loaded). Rules: (a) navigations go to the network untouched; a 200
HTML response without `no-store` is copied to an LRU-capped Cache Storage for offline use, and its stamped
pointer is read from the first 4 KiB of a `tee()` of the body to map the new client (`resultingClientId`,
falling back to the document URL) to a btih; offline, the cached copy is served. (b) A same-origin GET
subresource whose client maps to a btih that is complete in IndexedDB and lists the path is served from
IndexedDB after per-file verification (item 9), honouring `Range`. (c) `/_mw/ws/*` is the web-seed rewrite (3.4.7), `/_mw/t/*` passes through, and the rest of `/_mw/*`
comes from the precache.
(d) Everything else, including worker scripts, manifests, non-GET and cross-origin requests, is not
touched. The SW never synthesizes redirects, 404s or headers for the host's URLs.

**3.4.3 The first load is not controlled.** A browser's first page view, and any hard reload, loads
entirely from the host as before. `/_mw/mw.js` registers the SW after `load` and starts the engine at
`requestIdleCallback`; `clients.claim()` lets that page's later requests (lazy chunks, below-the-fold
images) use IndexedDB once the copy exists, and `/_mw/mw.js` posts the page's btih to the SW on
`controllerchange`, because no navigation was intercepted. Drop-in never forces a reload: the page already
works.

**3.4.4 A site with its own Service Worker.** One registration controls a scope, and `register()` on the
same scope replaces its script, so drop-in must never register over a site's worker. `/_mw/mw.js` calls
`navigator.serviceWorker.getRegistration('/')`; if an active worker's `scriptURL` is not `/mw-sw.js` it does
not register, runs the ledger and seeding without serving, and logs one console line with this recipe:
the site's worker calls `importScripts('/_mw/sw-core.js')` first and, at the top of its fetch handler,
`if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))`. `owns()` is synchronous and true
only for rules (b) and (c), so Workbox or hand-written routes run unchanged for everything else.
`data-mw-sw="off"` on the script tag disables serving entirely.

**3.4.5 Hashed assets and versions.** Each document names its asset version through its stamped btih. The
SW serves a subresource only from that btih, never from "the latest", so one page never mixes versions;
content-hashed names keep this cheap, because unchanged files keep their URL and their HTTP-cache entry.
After a deploy, IndexedDB keeps the previous version while any controlled client maps to it, then deletes
it together with cached documents stamped with it (item 21). The host keeps the previous deploy's files for
at least 7 days (lazy chunks of open pages, peers still on the old version); `publish.mjs --dropin` prints
this rule and uploads non-HTML files before HTML (item 22). BitTorrent v1 does not deduplicate across
versions, so a new version's copy is filled first from the HTTP cache and from the previous version in
IndexedDB (same path and same SHA-256 in `/.mw/files.json`), then from peers.

**3.4.6 Engine lifetime on multi-page sites.** Every navigation destroys the page, and with it the
WebTorrent client, the tracker sockets and the peer connections. `RTCPeerConnection` exists only in
windows (R03 summary item 12), so no worker can keep them. Rules: start the engine at idle after `load` and
announce only after 3 s visible, so click-through visitors do not churn the swarm; restore from IndexedDB
with `seedFromCache` without re-hashing (item 9 verifies pieces on upload); run one engine per origin across
tabs (S6); on `pagehide` close sockets and peers so the site keeps its back/forward-cache eligibility, and
rebuild on `pageshow`; open the ledger from IndexedDB and catch up with a HELLO/SYNC delta. README states
the consequence: drop-in visitors seed and gossip in page-view-sized bursts, and each page view costs one
announce per tracker (up to five offers). Sustained seeding needs shell mode or `pin.mjs`.

**3.4.7 The static origin is the web seed.** BEP 19 multi-file URLs are `<ws>/<torrent name>/<path>`
(`webtorrent/lib/webconn.js` L107-109), which cannot address files at the site root without a rewrite rule
that GitHub Pages and plain S3 do not have. The SW provides the rewrite: the engine adds the web seed
`https://<host>/_mw/ws/`, and the SW answers `GET /_mw/ws/<name>/<path>` with `Range` by fetching `/<path>`
same-origin with `cache: 'force-cache'` and returning the 206 slice. No CORS is involved, and HTTP-cache
hits cost the host nothing. Egress rule: this web seed is added only on unmetered networks at idle, to
complete the copy for seeding and offline use, within `maxSiteBytes`; on cellular or saveData the copy
fills from peers only. Completing a copy from the host costs about one extra download of the non-HTML
files per new device, and README says so. Without our SW (unsupported browser, or a foreign worker that is
not integrated) there is no web seed, only peers.

**3.4.8 The static origin is also the crawler and no-JS fallback.** Every file stays a plain static file
at its URL, so crawlers, link unfurlers, no-JS clients, Lockdown Mode, in-app WebViews without Service
Workers and any engine failure see today's site. Drop-in fails open: if `/_mw/mw.js` throws, the SW is
missing or stale, IndexedDB is unavailable or verification fails, requests go to the host. Shell mode, by
contrast, answers every URL with the shell, so crawlers that do not run the loader see no content; DEPLOY.md
must say so, and shell deployments keep `robots.txt` on the host.

**3.4.9 Trust, SDK, consent, CSP.** The engine runs in the site's own origin, as in per-domain mode: the
site's code can use the visitor's per-site ledger identity (the normal web-app trust model), and isolation
between sites comes from origins, which meets R06 §3.1.9 at site granularity. `window.mw` is the §9 API
bound directly to the engine, with no Bridge; `/_mw/sdk.js` re-exports it, so a site moving between
drop-in and shell keeps its code. The consent notice (item 12) renders in a closed shadow root before the
first announce, or the site renders its own and calls `mw.consent.accept()`. Sites with a CSP must allow
`worker-src 'self'` (PoW worker), `connect-src` for the tracker `wss:` URLs and, with DNS pointers, the DoH
endpoints; `publish.mjs --dropin` prints the exact additions.

**3.4.10 INTERFACES additions.** `src/dropin/mw.js` (registration with the foreign-worker check,
consent, engine bootstrap, direct SDK binding, Web Lock); `src/sw/core.js` (`owns(event) -> boolean`,
synchronous; `handle(event) -> Promise<Response>`; used by `/mw-sw.js` and published as
`/_mw/sw-core.js`); `tools/publish.mjs --dropin <dir> [--keep-days 7]`; build outputs `dist/_mw/*` and
`dist/mw-sw.js`; `cache.js` site records gain `kind: 'site' | 'assets'`.

## 6. Not verified by the editor
- Safari support for `FetchEvent.resultingClientId` (3.4.2 falls back to the document URL).
- Whether Firefox includes `user-agent` in web-seed preflights (item 14 asks for `Allow-Headers: *` anyway).
- Whether WebTorrent keeps metadata-less wires open (S1 carries the anchor-torrent fallback).
- First-visit iframe control in Firefox and WebKit (item 17 reloads once until a spike settles it).
- The cause of the iOS `DataCloneError` for ECDSA keys (item 18 self-tests either way).
- Every time budget here (2 s relay, 3 s cold start, 50 ms verification, 5% LCP) is a target to measure,
  not a measurement.

## 7. Code review round 1 (2026-10-19)

Sources: `docs/review/code-review-{security,conformance,browser,correctness}.md` (workflow `review-only.js`),
58 findings merged and numbered F01 to F58 in the fixer's brief: 2 critical, 8 high, 22 medium, 26 low.
Every finding was checked against the code before it was changed (the reviews carry their own reproductions);
several regression tests were also run against the code before the fix and fail there, for example F06's scale
test (10.5 MB of re-fetched surplus before, 76 KB after), F16's and F31's node tests, F19's and F43's e2e checks.
No finding was rejected: each described real behaviour. Where a fix covers only part of a finding, the rest is
listed under "Deferred" with its reason and is on `docs/ROADMAP.md`.

### Normative amendments made in this round
- ARCHITECTURE: §1 (B3 patch list: no OPFS cleanup, no File System Access polyfill), §3.2 (hub labels), §3.4.4
  (module-worker recipe), §3.4.5 (no IndexedDB reuse yet), §3.4.7 (`/_mw/ws/` serves the engine only; pad files),
  §3.4.9 (A4 scope: same-origin site code is trusted), §4 (`lo=`, `rot=` v2, seq rules, empty `st=`, the `aud=`
  token table), §5.1 (ES5 boot, the static non-root hint), §5.8 and §5.9 (two tabs across a publish), §6.2 and
  §6.3 (a hand-over revokes the old key; endorsement; gossip at the cap), §6.7 and §6.8 (write-through for local
  writes, write options), §7.1 (the bundle hash-checked on fetch; mode-specific install), §7.2 (the site's
  viewport), §7.4 (limited mode), §8 (network re-evaluation; drop-in lifecycle; Settings wording), §9 (the write
  fee: `pow`, `write.cancel`, `E_TIMEOUT`), §10 (manifest without `protocol_handlers`; lint), §12 (PEER-BLIP
  timing), §13 (threat model in `docs/SECURITY-MODEL.md`), §14 (open items wait for real devices).
- INTERFACES: `pointer.js` (`lo`, `rot` v2, `hubLabelFor`, `ledgerOwnerOf`), `state.js` (`ownerStanding`,
  `revokedAuthor`, `reduce` options), `node.js` (`expectedOwner`, `ledgerOwner`, write options, write-through and
  retries), `gossip.js` (`group`), `wire-ext.js` (one gossip peer per wire), `cache.js` (`addKey`), `bridge.js`
  (`CONTROL_METHODS`, `pow`, `ui.setWriteProgress`), `api.js` and the drop-in binding (write options, `pow`),
  `ui.js` (`setWriteProgress`), `sdk.js` (write options, timer), `tools/ledger-admin.mjs accept`.
- This document: §4.5 Settings sentence ("Off stops sharing this site's files. Posts are still passed between
  connected visitors, and your IP stays visible. Choose Host only to stop all peer connections."), S3 (the Home
  Screen hint). New string: `writeFee` ("Posting: working out the spam fee for this post (N tries so far)").
- `docs/DEVIATIONS.md` item 12 and `docs/deviations/chain-net.md` item 12 (one gossip peer per wire).
- New documents (first versions for the documentation wave): `docs/DEPLOY.md`, `docs/SECURITY-MODEL.md`,
  `docs/PRIVACY.md`, `docs/ROADMAP.md`, `docs/DEMO-RESULTS.md`, `CHANGELOG.md`.

### Fixed
| ID | Sev | Finding | Fix (files) | Regression tests |
|---|---|---|---|---|
| F01 | critical | Owner succession never revoked the old key | A hand-over is a revocation: blocks by a key that handed over (or whose hand-over is contested) have no owner standing outside its causal past; contested hand-overs settle on the new owner's endorsement, anchored to the pointer owner (`src/chain/state.js` `computeSuccession`, `ownerStanding`, `revokedAuthor`; `src/chain/node.js` exempt parents, `expectedOwner`; `tools/ledger-admin.mjs accept`, `--accept-key`) | `chain-core-state`, `chain-net-node`, `tools-ledger` |
| F02 | critical | Importing the vendored bundle deleted the origin's OPFS `/chunks` | Two more hash-asserted patch points (`opfs-chunks-cleanup`, `fsa-createwritable-polyfill`) in `build.mjs`, `build.lock.json` | `tools-build` (stock vs patched import probe); e2e `OPFS` (shell and drop-in keep `chunks/keep.txt`) |
| F03 | high | A keyless hub withdrawal deleted signed sites | Domain-separated hub labels (`pointer.js hubLabelFor`); unsigned withdrawals on hubs never delete signed copies, link withdrawals ask first (`app.js vetCandidate`, `presentWithdrawal`) | `common-pointer`, `loader-app-review1`, vector `ptr-018` |
| F04 | high | `/_mw/ws/` re-served any same-origin URL | `owns()` only for engine fetches; served only for a mapped version's torrent and its listed files, as `application/octet-stream` with `nosniff`, sandbox CSP and CORP (`src/sw/core.js serveWebseed`) | `sw-core`; e2e 10 (a navigation there is the host's 404) |
| F05 | high | Two tabs across a publish: the new tab hung, the old version stayed announced | Verified `version` messages mark the old version superseded in every tab; followers ask the engine tab for the site (`need-site`) and download it themselves after `followerSiteMs`; versions in use are kept (`app.js markSuperseded`, `serveNeededVersion`, `recordVersion`, `pruneVersions`) | `loader-app-review1`; e2e 13 (second tab after a third publish) |
| F06 | high | At the size cap peers re-fetched each other's surplus forever | Cap refusals remembered while at the cap; only added solicited bytes count; privileged authors exempt; HELLO backoff kept (`gossip.js`, `node.js`) | `chain-net-scale` |
| F07 | high | Limited mode under the normal CSP | `boot.js` honours a session `mw:degraded` flag; the loader reloads once into limited mode with its own CSP; redundant installs and a bounded register probe (`boot.js`, `render.js requestDegradedReload`, `app.js`) | `loader-app-render`; e2e 14 (storage full, install never settles, late 500) |
| F08 | high | `window.__mwDropin` exposed the engine | A frozen public handle (`inspect`, `rectOf`); the engine only from `start()` (`src/dropin/mw.js`) | `dropin-mw` |
| F09 | high | A key rotation started a new, empty ledger | `lo=` names the ledger owner; `ledgerIdFor` binds it; `publish --prev-key` keeps the genesis; the node takes `ledgerOwner` (`pointer.js`, `tools/publish.mjs`, `node.js`, loader and drop-in) | `tools-publish`, `common-pointer`, vectors `ptr-014`, `ptr-015` |
| F10 | high | Item 24 documents missing | First versions of the referenced documents; publish points at `docs/DEPLOY.md` "Owner duties"; stale pointers repointed | `docs-links` (every referenced `*.md` exists; wording rules) |
| F11 | medium | A valid `rot=` treated as untrusted | `vetCandidate` uses `verifyPointer`'s rotated verdict | `loader-app-review1` |
| F12 | medium | Unbounded seq floor | `seq-future` (more than a day ahead) refused; a poisoned floor ignored; the owner judged first; tools bound `--seq` | `common-pointer`, `loader-app-review1`, `dropin-stamp`, `tools-publish` |
| F14 | medium | A cancelled hub gate was skipped next time | The gate follows the stored choice; copies persist only after it (`app.js needsGate`, `downloadSite`) | `loader-app-review1` |
| F15 | medium | Tools launched a remote-capable Chromium for loopback URLs | `live.allowRemoteFor` in pin, snapshot and check-site | `tools-lib` |
| F16 | medium | A refused local write stayed in the DAG and was relayed | Local writes are stored before they enter the DAG; failed remote writes are retried (`node.js _wouldPlace`, `_persist`, `tick`) | `chain-net-node` (2) |
| F17 | medium | Identity creation raced between tabs | Atomic `cache.addKey`; followers never create (`app.js ensureIdentity`, `src/dropin/identity.js`, `cache.js`) | `loader-app-review1`, `dropin-identity`, `loader-common-browser` |
| F18 | medium | Cold start ran xs fetches and probes sequentially first | The torrent starts at once; xs fetches and web-seed probes run in parallel and a passing seed joins (`torrent.js`) | `loader-app-torrent` |
| F19 | medium | The shell replaced the site's viewport | The shell takes the site's viewport after each load (`render.js syncViewport`) | `loader-app-render`; e2e `VIEWPORT` (980, 1024, 390 as on the plain host) |
| F20 | medium | Gzip snapshots unreadable on Safari 15.4 to 16.3 | `src/common/inflate.js` fallback through `src/common/snapshot-read.js` (shell and drop-in) | `common-inflate`, `dropin-engine`, `tools-snapshot` |
| F21 | medium | The degraded CSP blocked third-party subresources | `https:` (and dev loopback) sources in both CSP builders | `loader-app-render` |
| F22 | medium | Limited mode broke module cycles | Import-map module strategy (`render.js mountDegraded`) | `loader-common-browser` (Chromium, WebKit) |
| F23 | medium | Limited mode ran at `about:srcdoc` | `document.open`/`write` into a fresh `about:blank` frame (shell) | `loader-common-browser`; e2e 14 |
| F24 | medium | The network class was never re-evaluated | `policy.watchNetwork`; re-detection on `online` and visible; a drop-in copy through the host web seed restarts from peers on a metered network (`policy.js`, `app.js`, `src/dropin/engine.js`) | `loader-app-policy`, `dropin-engine` |
| F25 | medium | A DNS record by an unrelated key beat the page tag | `anchorCandidate` in `resolvePointer` and both update checks | `loader-app-review1` |
| F26 | medium | Signatures never verified in a worker pool | The worker URL in shell and drop-in; `inspect().verifierPool` | `dropin-engine`; e2e 2 |
| F27 | medium | A `ready()` timeout rendered limited mode under the normal CSP | As F07 | e2e 14 ("install never settles") |
| F28 | medium | The non-root message could never appear | The static `#mw-boot` line explains it (CSS delay); `check-site` reports a non-root deployment | `tools-build`, `tools-check` |
| F29 | medium | pin.mjs could not give consent on drop-in pages | `tools/live.mjs acceptConsent` clicks the drop-in card through `rectOf` and checks the stored choice | e2e `OPFS` (live.mjs on a drop-in page) |
| F30 | medium | A default withdrawal was refused by a lagging clock | 399-day default and cap, a one-day skew margin | `tools-withdraw`, `common-pointer` |
| F31 | medium | PoW had no progress or cancel; a failed write was still published | Write options `{ signal, onProgress }` from the SDK to the node; `pow` pushes, status line, `write.cancel`, the timer re-armed by progress; tab links forward both (`node.js`, `bridge.js`, `api.js`, `sdk.js`, `src/dropin/binding.js`, `src/dropin/leader.js`, `app.js`) | `chain-net-node`, `sw-sdk`, `loader-app-review1`, `dropin-leader`, `dropin-binding` |
| F32 | medium | A `#host:` link never resolved on the hub root | `runHubRoot` reads the consent record and asks before DNS | `loader-app-review1` |
| F33 | low | Gossip links keyed by the self-declared peer id | One gossip peer per wire; the peer id only groups the counts (`wire-ext.js`, `gossip.js`) | `chain-net-wire` (impostor wire) |
| F34 | low | xs and cs bodies buffered before the size check | Streaming caps (`src/common/read-capped.js`), capped inflate | `loader-app-torrent`, `common-inflate` |
| F35 | low | Hub links contacted xs and ws hosts before the gate | Unsigned hub links wait for the gate | `loader-app-review1` |
| F37 | low | `webtorrent.min.js` cached without an integrity check | In the integrity map; checked before it is kept or served (502 otherwise) (`build.mjs`, `src/sw/core.js`) | `sw-core`, `tools-build` |
| F38 | low | Dev server redirected `/.//dir` to `//dir/` | Location from decoded segments; request targets parsed as paths | `tools-dev-server` |
| F40 | low | Shared non-atomic `dist/`; wall-clock targets as failures | A per-run e2e build; atomic `build()` swap; the C4 test builds its own; targets reported with generous bounds | `tools-build`, `loader-app-arrival` |
| F41 | low | `boot.js` wrapper was an ES2015 arrow | Built at target es5 | `tools-build` |
| F42 | low | lint-floor missed post-floor APIs and the bundle | Twelve rules; the patched bundle is linted in `build.mjs` (allowed: the polyfilled Uint8Array conversions) | `tools-lint-floor` |
| F43 | low | Light mode showed the shell grey under transparent sites | `.mw-site-frame { background: Canvas }` | `tools-build`; e2e `VIEWPORT` (light-mode pixels equal the plain host) |
| F44 | low | Home Screen hint missing on iPad and misleading | iPadOS detection (`iosHintFor`); reworded (S3 above) | `loader-app-review1` |
| F45 | low | iOS zoomed on loader inputs | 16 px fields on phones (`ui.css`, `src/dropin/panel.js`) | `tools-build` (CSS check) |
| F46 | low | The recipe broke module service workers | `import '/_mw/sw-core.js'` for module workers (recipe, §3.4.4, RUNBOOK); the built file attaches when imported as a module | `dropin-swreg` |
| F47 | low | The install downloaded both modes' assets with `reload` | `/index.html` decides the mode; only that mode's files, with `no-cache` and the integrity check | `sw-core` |
| F48 | low | The manifest advertised a `magnet:` handler | Removed for v1 | `tools-build` |
| F49 | low | `aud=` tokens defined three ways | One table (§4, config, `consent.js`, `pointer.js`) | `loader-app-consent` |
| F50 | low | Drop-in phones destroyed the client when hidden | `lifecyclePlan` (moved to `policy.js`) in the drop-in runtime | `dropin-engine`, `dropin-engine-tabs` |
| F51 | low | The A4 wording promised too much | ARCH §3.4.9 scoped to the SDK surface | (documentation) |
| F52 | low | ARCH stated behaviour the code did not have | §3.4.5, §12, §14 amended | (documentation) |
| F54 | low | package.json said 0.1.0 | 0.2.1 (and the lock file root) | `v021-integration` |
| F55 | low | A browser test loaded `http://localhost` in WebKit | A DoH stub on a second 127.0.0.1 listener | `loader-common-browser` |
| F56 | low | "Share: Off" text did not say posts are still relayed | §4.5 amended; `strings.settingsShare` | `dropin-panel` |
| F57 | low | An empty `st=` read as active | Withdrawn (fail-closed); the format keeps `st=` | `common-pointer`, vector `ptr-017` |
| F58 | low | Drop-in asked for persistent storage outside the click | `ConsentState.set({ gesture })`; tab-channel choices adopted only when the stored record confirms | `dropin-engine-tabs` |

### Fixed in part (the rest deferred)
| ID | Sev | Fixed now | Deferred, and why |
|---|---|---|---|
| F13 | medium | Tools write `rot=` v2, bound to scope and chain; loaders verify it (vector `ptr-016`) | v1 (unbound) is still accepted: the frozen v0.2.1 vector `ptr-010` uses it and the vectors are append-only; retire it in the next pointer revision |
| F36 | low | ARCH §3.4.9 states the scope; the drop-in handle is frozen; tab-channel consent needs the stored record | A non-extractable identity with a separate wrapped-export path (export needs an extractable key today) |
| F39 | low | The drop-in rewrite answers BEP 47 pad paths with zeros; an external `ws=` is dropped with a warning when the torrent has non-empty pad files | Patching WebTorrent's web-seed connection to skip pad files (a new patch point in the vendored bundle, better done with the own bundle on the roadmap) |
| F53 | low | Behavioural tests: e2e `OPFS` runs `tools/live.mjs acceptConsent` on a drop-in page; `tools-publish-v021` reads the E5 note from the publish output; PEER-CONSENT (script click ignored) and FMT-SDK (`consent.request` waits for the click) already cover the shell guard and the waiters | Behavioural tests for the remaining guarded buttons (gate, identity export and import); the regex checks stay as smoke tests |

### Deferred (not started) and observations
- F07 option (b), serving from memory when the worker cannot store anything: the one-time reload into limited
  mode covers the case.
- E2E variants left at unit level: a module worker integrating `sw-core.js` (F46), a Wi-Fi to mobile data change
  during a drop-in copy (F24), a post written before a key rotation (F09), an unsigned withdrawal link on a
  shared hub (F03).
- Observation from the new `VIEWPORT` scenario: the consent record is written to IndexedDB after the click, and a
  top-level reload in the same instant can abort that write, so the card asks again. Rare and harmless (the
  visitor answers again); on the roadmap.
- The real-device release gate (`docs/DEMO-RESULTS.md`) has not run; phone viewport, input zoom and iPad checks
  were done in Chromium emulation or by CSS checks only.

### Verification
`npm test` (lint-floor and unit), `npm run test:browser`, `npm run test:e2e` and `node test/e2e/run.mjs --webkit`
were run after the last change; the counts are in `docs/INTEGRATION-STATUS.md` ("Code review round 1").
New e2e scenarios: `VIEWPORT`, `OPFS`; extended: 2 (worker verifier pool), 10 (`/_mw/ws/` navigation), 13 (two
tabs across a publish), and the targets of 7, 3, PEER-11 and PEER-BLIP are reported as measurements.

## 8. Code review round 2 (v0.3, 2026-10-20 to 2026-10-21)

Sources: `docs/review/code-review-v03-{security,correctness,browser,conformance}.md` (workflow `v03-review.js`), 84 findings on the
v0.3 and C2 code: 9 critical, 29 high, 29 medium, 17 low (security 20, correctness 23, browser 16, conformance 25). Four area fixers
(ledger-tools, loader-sw, chat-calls-media, examples-docs) checked each finding against the code before changing it, fixed it with a
regression test where one was named, and kept ARCHITECTURE and INTERFACES in step; what a fix needed in another area they wrote down as a
request (41 in all). The integrator applied the requests that are fixes, with tests, and put the rest on [ROADMAP.md](../ROADMAP.md) ("Left
open by code review round 2"). The integrator's new tests were run against the code before its change, and each fails there.

**Rejected: none.** Every finding described real behaviour. One request needed no change: moving the mDNS flag change of remote-capable
runs into `chromiumArgs({ allowRemote: true })` (ledger-tools request 8), because `tools/live.mjs` `launchOptions` is the only launcher that
asks for remote-capable arguments.

### Normative amendments made in this round
- [V03-DESIGN-REVIEW.md](V03-DESIGN-REVIEW.md): R 2.7.7, concurrent rekeys (removals win, then the largest removal set, then
  `SHA-256(prev | creator)`, then `epochId`; siblings only within 7 days of the parent's replacement); R 2.7.5 item 6, "N peers reported
  holding it at 14:02. They may go offline." (HOLDING is unauthenticated).
- ARCHITECTURE: 15.17 (ledger and tools), 15.18 (identity origin, loader, worker), 15.19 (this round's integration), and in place 8.1.8
  (background APIs "(proposed)"), 11 (examples/social), 15.1, 15.4, 15.6, 15.7, 15.8 and the calls platform paragraph.
- INTERFACES: "v0.3 code review: lane ledger-tools", "v0.3 code review: lane loader-sw", "v0.3 code review: round 2 integration", and in
  place the chat, media, files and calls entries.
- [THREAT-MODEL.md](../THREAT-MODEL.md): SYB A10 is **open** (MF-77 cannot be built as stated); `minSeq` is "(proposed)" in the HUB H4, PTR
  A4 and loader-state rows; MAL A12 names the warning and premoderation; the pin mailbox is "(proposed)" in residual 13; "Stolen working
  keys" names what "Replace my keys" keeps.
- [OPERATIONS.md](../OPERATIONS.md): the `_mw.cfg` keys the schema takes, premoderation and `ledger-admin listed`, the open-writing warning,
  and what "Replace my keys" moves.

### Fixed: lane ledger-tools (11 of 11)
| # | Sev | Finding | Fix (files) | Tests |
|---|---|---|---|---|
| 1 | high | MF-20 recovery did nothing: no keyinfo for member keys, no rotate writer, a rotated-away key kept its rights | A keyinfo counts only as a key's first block; a rotation revokes the old key outside its causal past; bans cover the rotation family; ChainNode writes the keyinfo before an identity's first other block (`src/chain/state.js`, `node.js`; the rotate writer is `src/loader/api.js writeRotation`) | `freeze-state`, `chain-v03-review`; vectors `lg-021` to `lg-024` |
| 2 | high | One lane peer could wipe a followed page | The recent view keeps only blocks that have an effect, caps 1,024 payload blocks per unprivileged key, trims by depth, strikes refusals; a peer is credited only for kept blocks (`src/chain/recent.js`, `multi.js`) | `hub-lane-recent`, `hub-lane-multi` |
| 3 | high | No copy ever applied a checkpoint (MF-24 to MF-26) | `tick()` applies the checkpoint in effect with reduce()'s S; the stored row keeps covered depths; exports and imports carry a `checkpoint-v1` header (`src/chain/node.js`, `dag.js`; `tools/pin.mjs`, `live.mjs`, `snapshot.mjs`, `ledger-admin.mjs`) | `chain-v03-review`, `tools-snapshot` |
| 4 | medium | The pin bridge's top-frame check was bypassed by a same-origin site frame | `file.request` needs its author's signature over `pinRequestBytes` (`src/pin/frames.js makePinRequest`, `verifyPinRequest`; `tools/pin.mjs`) | `pin-frames`, `tools-c2-pin`, `tools-c2-pin-browser` |
| 5 | medium | The pin's Chromium ran without its sandbox and with mDNS hiding off | `launchOptions()`: remote-capable runs use the sandbox and keep mDNS hiding; `MW_CHROMIUM_NO_SANDBOX=1` drops it loudly (`tools/live.mjs`) | `tools-demo` |
| 6 | medium | Claimed timestamps defeated `ban.until` and the hourly cap | Far-future blocks wait or are refused (`E_FUTURE`); live moderator blocks must claim a time near arrival (`E_CLOCK`); caps count at max(ts, newest past ts) (`src/chain/node.js`, `state.js`) | `freeze-state`, vector `lg-025` |
| 7 | medium | An expired temporary ban still counted | `policy.banned` holds permanent bans; `isBanned`, `roleOf` and `snapshot` take the clock (`src/chain/state.js`, `node.js`) | `freeze-state`, `chain-v03-review` |
| 8 | medium | `_mw.cfg.blockTiers` hid the whole `_mw.cfg` | The schema takes `blockTiers`, `wall`, `requests: 'introduced'`; `CFG_KEYS`; `ledger-admin cfg` writes them (`src/chain/state.js`, `tools/ledger-admin.mjs`) | `freeze-schema`, `tools-v03-ledger` |
| 9 | low | RECENT answers dropped `truncated` | Carried to `applyWindow` and `peerFor()`; `maxWindowBlocks` (`src/chain/multi.js`) | `hub-lane-multi` |
| 10 | low | Lane budget bypass with a duplicate ledger key | A frame whose parsed ledger differs pays as unsolicited and is a strike (`src/chain/multi.js`) | `hub-lane-multi` |
| 11 | low | lint-floor had no rules for the post-floor APIs v0.3 uses | Guarded rules for eleven APIs (`tools/lint-floor.mjs`) | `tools-lint-floor` |

### Fixed: lane loader-sw (35 of 36; #22 is documented and on the roadmap)
| # | Sev | Finding | Fix (files) | Tests |
|---|---|---|---|---|
| 1 | critical | A stale escrow copy was adopted whole | Merged on every sign-in (`Vault.mergeFrom`); a shredded key leaves a `keyTag` tombstone (`src/idp/idp.js`, `src/identity/vault.js`) | `idp-review-v03` |
| 2 | critical | A passphrase-wrapped root was escrowed; the floor took trivial passphrases | Escrow only for a PRF root; the strength estimate counts sequences, rows and list order (`src/idp/idp.js`, `store.js`, `src/identity/vault.js`) | `idp-review-v03` |
| 3 | critical | Lost vault updates across windows | Web Lock `mw-idp-vault` and a re-read inside it (`src/idp/idp.js`) | `idp-review-v03` |
| 4 | critical | "Replace my keys" wrote no rotate op | The loader writes the recover rotation before any other block (`src/loader/api.js writeRotation`, `app.js`, `src/dropin/engine.js`) | `loader-review-v03` |
| 5 | critical | The upload card claimed removed details for files never stripped | `stripped` only when something was removed; `uploadAsIs` (`src/loader/api.js cardFor`, `ui.js`, `strings.js`) | `loader-review-v03`, `sdk-v03-wiring` |
| 6 | critical | Chat, files and media used the default STUN servers | The site's own list only, host candidates when none (`src/loader/torrent.js`, `app.js`, `api.js`, `src/dropin/engine.js`) | `loader-review-v03-torrent` |
| 7 | critical | Doors learned which site a visitor opens | `byteDoors`: owner doors, the last good door, `ws=` and `xs=` hosts only (`src/loader/doors.js`, `app.js`) | `loader-doors`; e2e DOOR-GUEST |
| 8 | high | "Replace my keys" stranded a personal site | Labels that own a page keep their key (`src/idp/idp.js`, `src/identity/vault.js`) | `idp-protocol` |
| 9 | high | A proof without the card or the statement | `validateRequest` in `handleRequest`; a challenge only with purpose server (`src/identity/client.js`, `signin.js`, `src/idp/idp.js`) | `idp-review-v03` |
| 10 | high | One site could bloat the vault | `RECORD_MAX_BYTES`, `VAULT_MAX_BYTES`, `fitEscrow` (`src/identity/vault.js`, `client.js`, `src/idp/idp.js`) | `idp-review-v03` |
| 11 | high | `media.restore()` had no caller | `restoreMedia` whenever keys are installed (`src/loader/api.js`); re-seeding by the integrator (below) | `loader-review-v03`, `media-service` |
| 12 | high | Seeks did not reprioritise pieces | A stream selection plus critical, dropped once verified; `mw-chunk-cancel` from the worker (`src/loader/torrent.js`, `src/sw/protocol.js`, `media-route.js`); the page side by the integrator | `loader-review-v03-torrent`, `media-service` |
| 13 | high | Personal pointers expired and follows were dropped | `refreshPersonalPointer` under 30 days; `_mw.ptr`; expired follows kept (`src/loader/personal-site.js`, `app.js`) | `loader-review-v03` |
| 14 | high | The redirect round trip never started | `{ fallback: 'redirect' }` and "Continue in this tab"; iOS Home Screen apps redirect (`src/identity/client.js`, `src/loader/ui.js`, `api.js`) | `loader-review-v03`, `ui-v03-cards` |
| 15 | high | MF-09 "Tap to finish" missing | The ceremony is the press's first await; a fast refusal retries in that click (`src/idp/idp.js`, `passkey.js`, `cards.js`) | `idp-review-v03` |
| 16 | high | The backup file could fail to save on iOS | Its own save button, URL kept 60 s, "I saved the file" (`src/idp/idp.js`, `cards.js`) | `idp-review-v03`, `idp-browser` |
| 17 | high | The phone header covered the site | A 44 px chip after 5 s (`src/loader/ui.js`) | `loader-review-v03`, `loader-review-v03-browser` |
| 18 | high | The recovery kit was never offered | `noteMeaningful` and the kit card (`src/loader/api.js`, `src/identity/service.js`) | `loader-review-v03`; e2e E-CH-1 |
| 19 | high | A deny never matched | `denyIdsOf`, `_deny/` for each id, the listing tombstoned (`src/loader/mod.js`) | `loader-review-v03` |
| 20 | high | MF-30 in part: no `minSeq`, no `#host:name@fp`, a "(DNSSEC)" badge | Badge "resolver says validated"; fingerprint links (`src/loader/strings.js`, `app.js`); `minSeq` on the roadmap | `loader-review-v03` |
| 21 | high | MF-53: no premoderation | Moderator queue and accept (`src/loader/mod.js`, `api.js`); the readers' half by the integrator (below) | `loader-review-v03`, `files-c2-handoff`; e2e E-FI-1 |
| 22 | high | MF-77 not built while THREAT-MODEL said mitigated | Not buildable as stated (no dialable address, a new peer id each session); THREAT-MODEL SYB A10 is open (integrator); a signed peer-hint record is on the roadmap | (documentation) |
| 23 | medium | Hub label on multi-tenant suffixes, page-controlled default | `HUB_SUFFIXES` built into the IdO, the box starts unchecked (`src/idp/psl.js`, `idp.js`, `cards.js`, `src/identity/client.js`); build flags by the integrator | `idp-protocol` |
| 24 | medium | Expired pointers gave ledger labels; floors lost | `expired` reason; floors in the vault (`src/idp/idp.js`, `src/identity/vault.js`) | `idp-review-v03` |
| 25 | medium | Any moderator could set the pin key | `ownerCfgPin` (`src/loader/api.js`, `app.js`); the lanes by the integrator | `loader-review-v03`, `files-c2-handoff` |
| 26 | medium | The 0.2.1 key was deleted too early | Only after a backup made after it entered the vault (`src/identity/migrate.js`, `src/idp/idp.js`) | `idp-review-v03` |
| 27 | medium | A Home Screen promise on iOS | `kitIos` reworded, iOS lines behind a flag (`src/idp/strings.js`, `cards.js`) | `idp-cards` |
| 28 | medium | Argon2id froze the page | `argon2idAsync` in slices (`src/identity/argon2.js`, `wrap.js`, `derive.js`, `vault.js`, `src/idp/idp.js`) | `idp-review-v03`, `idp-browser` |
| 29 | medium | The header always said passkey, no backup | `identityHeaderOf` (`src/loader/api.js`, `app.js`) | `loader-review-v03` |
| 30 | medium | A look-alike warning on every hub label | `ownHubAddress` (`src/idp/idp.js`, `psl.js`) | `idp-review-v03` |
| 31 | low | Card lines ignored the mode | Lines by mode (`src/idp/cards.js`, `strings.js`) | `idp-review-v03` |
| 32 | low | The page decided "this visit only" | `MW_SHARED_ORIGINS` (`src/idp/idp.js`, `psl.js`); build flag by the integrator | `idp-review-v03`, `idp-protocol` |
| 33 | low | Every follow opened a full ChainNode | Memory stores, no tick, batches of 32 (`src/loader/app.js`, `personal-site.js`) | `loader-review-v03` |
| 34 | low | A VPN overlay counted as local | `100.64/10` public; phones need declared Wi-Fi (`src/loader/localwire.js`, `seed-budget.js`) | `localwire`, `seed-budget` |
| 35 | low | 15 px inputs | 16 px (`src/idp/idp.css`) | `idp-review-v03`, `tools-build` |
| 36 | low | "cannot match you" without "by key" | Reworded EN and FR (`src/idp/strings.js`, `src/loader/strings.js`) | `idp-review-v03`, `ui-v03-strings` |

### Fixed: lane chat-calls-media (20 of 21; #7 is documented and on the roadmap)
| # | Sev | Finding | Fix (files) | Tests |
|---|---|---|---|---|
| 1 | critical | A removed admin forked the group and won by grinding | Removals win; `tieKey`; 7-day sibling window; one genesis (`src/chat/groups.js`) | `chat-lane-groups` |
| 2 | critical | Private media keys had no persistent home | `src/media/vault.js keysVault()`; restore once per key (`src/media/lane.js`, `service.js`, `src/files/lane.js`, `service.js`) | `media-service` |
| 3 | high | The Blob fallback took the sender's mime | `checkManifest` allow-list; `blobType` sniffs (`src/media/format.js`, `session.js`) | `media-service` |
| 4 | high | Contacts' CK records were not persisted | Persisted and verified at enable (`src/chat/service.js`) | `chat-lane-service` (p7) |
| 5 | high | Held mail older than a day was never collected | `dayWithin`, `heldDays` (`src/chat/lane.js`, `tags.js`, `stamp.js`) | `chat-lane-service` (p4) |
| 6 | high | A lost ACK was never re-sent | ACK again on a replay of a delivered id; invites ACKed (`src/chat/service.js`, `outbox.js`) | `chat-lane-service` (p3) |
| 7 | high | The pin mailbox never received a frame, yet five documents described it | Marked "(proposed)" in DEPLOY, the hub-pin recipe, WHY, the social README and THREAT-MODEL (integrator); building it is on the roadmap | (documentation) |
| 8 | medium | Removed members kept posting through the previous epoch | Current members after the union of removals; `GROUP_SKEW_MS` (`src/chat/service.js`) | `chat-lane-service` |
| 9 | medium | MP4 timed metadata kept GPS | Samples zeroed, `trak` to `free`; fragmented with such a track refused (`src/media/strip.js`) | `media-strip` |
| 10 | medium | Interest tags never refreshed on a day change | `refreshInterest` each tick; the newest refresh wins (`src/chat/service.js`) | `chat-lane-service` (p8) |
| 11 | medium | Group state did not survive a reload | `GroupState` v2 `toJSON`/`fromJSON`; `readopt()` (`src/chat/groups.js`, `service.js`) | `chat-lane-service` (p5) |
| 12 | medium | The union of removals was never applied | `effectiveMembers()`, `reapplyPlan` (`src/chat/groups.js`, `service.js`) | `chat-lane-groups` |
| 13 | medium | The replay guard was saved only after a DM was delivered | Saved 2 s after any accept and on pagehide (`src/chat/service.js`) | `chat-lane-service` |
| 14 | medium | Every re-send deposited a new held copy | One sealed copy per message per day; none after a HOLDING (`src/chat/outbox.js`, `service.js`) | `chat-lane-service` |
| 15 | medium | Re-encryption kept the old id | Moves to `idOf(new M)`, keeps previous ids (`src/media/lane.js`) | `media-service` |
| 16 | medium | No fallback image decoder | `decodeImage()` with three decoders (`src/media/strip.js`) | `media-strip` |
| 17 | medium | Video posters waited for a video never played | Muted play to the first frame; "No preview" (`src/media/poster.js`) | `media-service` |
| 18 | medium | The raw-key fallback ran only on a synchronous DataCloneError | Retry with raw bytes after a timeout (`src/media/session.js`); the worker's `messageerror` report by the integrator | `media-service` |
| 19 | medium | Call cards described phones before the gate rows ran | `CALL_FLAGS.phoneNotes` (`src/calls/limits.js`, `service.js`); `call.keepOpen` by the integrator | `calls-service`, `call-ui` |
| 20 | low | Any relaying neighbour set "Handed to N peers" | One count per neighbour wire (`src/chat/outbox.js`); the wording by the integrator | `chat-lane-service`, `ui-v03-strings` |
| 21 | low | IndexedDB hygiene | `src/files/store-idb.js tx()` observed; the ledger store's flush by the integrator | `media-service`, `chain-net-stores` |

### Fixed: lane examples-docs (16 of 16; three by the integrator)
| # | Sev | Finding | Fix (files) | Tests |
|---|---|---|---|---|
| 1 | high | `<mw-signin>` opened the identity window outside the click | (integrator) the client is called before anything is awaited and the challenge travels as a promise; static import (`src/widget/signin.js`; the e2e lab's stand-in `test/e2e/v03/signin-lab.js`) | `widget-signin`; e2e E-SI-1, E-SI-1W |
| 2 | high | "Create my page" made a page its owner could not post to | The template stops unless the identity is the hub key (`examples/social/js/views/profile.js`, `hub.js`, `strings.js`); `createPage` refuses without the hub key (integrator, `src/loader/app.js`); the page can no longer preselect the hub box (loader-sw #23) | `social-browser-people`, `social-lib`, `loader-review-v03`; e2e E-SO-1 |
| 3 | high | A report reached nobody from the home page | `reportDialog` follows R 3.5 (`examples/social/js/views/post-card.js`); `report.send({ ledger })` is on the roadmap | `social-browser`, `social-browser-more` |
| 4 | high | "Leave this site" offered but missing | Marked (proposed); every row names where it is (`docs/PRIVACY.md`) | `docs-claims` |
| 5 | high | "Delete my page" kept the name and reactions | Deletes own keys, promises only what runs (`examples/social/js/data.js`, `views/settings.js`); `setName('')` and `withdrawPage` are on the roadmap | `social-browser-people`, `social-data` |
| 6 | high | Docs relied on an open-writing warning and a byte quota (MF-54) | Docs say what exists (`docs/OPERATIONS.md`, `THREAT-MODEL.md`); the warning is built by the integrator (`tools/ledger-admin.mjs`, `tools/publish.mjs`); the quota is on the roadmap | `docs-claims` |
| 7 | medium | Docs claimed Background Sync, Periodic Sync and Background Fetch | Marked (proposed) (`docs/ARCHITECTURE.md` 8.1.8, `docs/COMPATIBILITY.md`) | `docs-claims` |
| 8 | medium | E-SI-5 counted as written without the identity origin | E-SI-5W written (`test/e2e/scenarios-dropin-v03.mjs`); it passes since round 2, so the row is "pass" again | e2e E-SI-5W, `docs-claims` |
| 9 | medium | SDK.md said site code never sees the working keys | Reworded (`docs/SDK.md`) | `ui-v03-strings` |
| 10 | medium | Docs said a removed record key cannot come back | The limit stated (`docs/PRIVACY.md`, `FAQ.md`, `SDK.md`, `src/loader/strings.js`); the identity page's card by the integrator (`src/idp/strings.js`) | `ui-v03-strings`, `docs-claims` |
| 11 | low | `@magnet-web/verify` threw on a lone surrogate after using the nonce | (integrator) the signing input is built before the nonce is used (`packages/verify/verify.js`; its sha256 in `packages/verify/README.md` and `docs/specs/mw-signin-v1.md`) | `signin-verify` |
| 12 | low | Test flakiness: wall-clock and heap bounds, a hand-picked lab file list | `copyLab` copies all of `src/` (`test/e2e/scenarios-v03.mjs`); (integrator) generous sanity bounds (`test/unit/harden-chain-hello.test.mjs`) and the pin-wire receipts awaited (`test/unit/pinwire.test.mjs`) | the suites |
| 13 | low | Safe-area insets ignored | `max(n px, env(safe-area-inset-*))` (`examples/social/css/app.css`) | `social-site` |
| 14 | low | The template dropped `_mw.cfg` keys it did not know | Writes back every visible key (`examples/social/js/data.js`) | `social-data` |
| 15 | low | "Download my data" lacked the record | The record's fields; signed entries through the loader's export (`examples/social/js/views/settings.js`); `db.exportBlocks` is on the roadmap | `social-data` |
| 16 | low | Directory entries shown unchecked | `sig` and `hubSig` checked (`examples/social/js/directory.js`); signing tooling is on the roadmap | `social-lib`, `social-browser` |

### Cross-area requests the integrator applied
| From | Request | What was done (files) | Tests |
|---|---|---|---|
| loader-sw #21 | Hide premoderated listings in the files lane | `list()` shows another author's pending listing to nobody and an own one with `pending: true`; a fetch of it is `E_POLICY` (`src/files/lane.js`, `service.js`); `ledger-admin listed` accepts offline (`tools/ledger-admin.mjs`) | `files-c2-handoff`, `tools-v03-ledger`; e2e E-FI-1, E-PS-3 |
| loader-sw #25 | The lanes take the pin key from `pinKey()` | `_pinKey()` in both lanes (`src/files/lane.js`, `src/media/lane.js`, both services) | `files-c2-handoff` |
| loader-sw #12 | Answer `mw-chunk-cancel` | `MediaSessions.open({ cancelChunk })`, `deprioritize` (`src/media/session.js`, `lane.js`) | `media-service` |
| loader-sw #11 | Re-seed own items after a restore | Lane K, newest first, at most `RESEED_MAX` 8 (`src/media/lane.js`) | `media-service` |
| loader-sw #23, #32 | Build flags for hub suffixes and shared origins | `--hub-suffix`, `--shared-origin`; `readBuild()` reports them (`tools/build-idp.mjs`, `src/idp/idp.js`) | `idp-protocol` |
| loader-sw #4, #8, #2, #24 (docs) | Say what "Replace my keys" and escrow do | `docs/OPERATIONS.md`, `THREAT-MODEL.md`, `SECURITY-MODEL.md`, `PRIVACY.md` | `docs-links` |
| loader-sw #20, #22 (docs) | `minSeq` (proposed); SYB A10 open | `docs/THREAT-MODEL.md` | `docs-links` |
| chat-calls-media #18 | The worker reports `messageerror` | `core.messageError`, `MSG.messageError`, listeners (`src/sw/core.js`, `sw.js`, `protocol.js`); the page retries at once (`src/media/session.js`) | `sw-core`, `media-service` |
| chat-calls-media #19 | `call.keepOpen` on phones | `CALL_TEXT`, `noticesOf({ phone })`, `createCallUi({ phone })` (`src/loader/strings.js`, `call-ui.js`, `app.js`) | `call-ui`, `strings-c2` |
| chat-calls-media #20 | "reported" wording | `DELIVERY_TEXT.handed` (`src/loader/strings.js`; R 2.7.5 amended) | `ui-v03-strings` |
| chat-calls-media #21 | The ledger store keeps a failed flush | `IdbBlockStore.flush()` (`src/chain/stores.js`) | `chain-net-stores` |
| chat-calls-media #7, #1 (docs) | Mailbox "(proposed)"; R 2.7.7 amended; the deviations recorded | `docs/DEPLOY.md`, `recipes/hub-pin.md`, `WHY.md`, `examples/social/README.md`, `THREAT-MODEL.md`, `review/V03-DESIGN-REVIEW.md`, `deviations/chat.md`, `deviations/media.md` | `docs-links` |
| ledger-tools 1 | E-PS-1 signs or enters its request | The bridge refusal is asserted, then the request is entered at the store (`test/e2e/scenarios-c2.mjs`) | e2e E-PS-1 |
| ledger-tools 2 | CK cache after a rotation (MF-20) | `CkCache({ rotated })`, `ck-rotated`, `ck-epoch-jump`, `CK_EPOCH_MAX` (`src/chat/ck.js`, `limits.js`, `service.js`) | `chat-core-seal`, `chat-lane-service` |
| ledger-tools 3 | The pin container and Chromium's sandbox | `MW_CHROMIUM_NO_SANDBOX=1` in the image, documented; `cap_drop: [ALL]`, `no-new-privileges` (`deploy/pin/Dockerfile`, `README.md`, `deploy/one-box/docker-compose.yml`) | `deploy-one-box` |
| ledger-tools 4, 5, 9 (docs) | Signed pin requests, the schema keys, the changelog lines | `docs/DEPLOY.md`, `OPERATIONS.md`, `DEVIATIONS.md`, `deviations/examples.md`, `CHANGELOG.md` | `docs-links` |
| ledger-tools 6 | Clock-aware fallbacks | `isBanned(pub, st, now())`, `roleOf(pub, st, now())` (`src/chat/service.js`, `src/identity/service.js`) | `chat-lane-service` |
| examples-docs R-1 (part) | `createPage` needs the hub key | `src/loader/app.js` | `loader-review-v03` |
| (integrator, found in e2e) | A refused passphrase looped until the step timed out; the IdO's weak message did not match the rule | The driver fails at once (`test/e2e/idp-driver.mjs`); the social e2e passphrases are longer; `passphraseWeak` names the rule (`src/idp/strings.js`) | e2e E-SO-1 |
| (integrator, found in e2e) | The kit card queued every later card in the members scenarios | `dismissKitCard` in the card helpers; E-CH-1 checks the card (`test/e2e/lib.mjs`, `scenarios-members.mjs`, `scenarios-c2.mjs`) | e2e E-CH-1, E-FI-1, E-FI-2, E-MD-4 |
| (integrator, found in e2e) | Full doors were guest doors, which byteDoors never asks | The scenarios list full doors in `org=` too; DOOR-GUEST checks that a guest door gets no byte request (`test/e2e/scenarios-doors.mjs`) | e2e DOOR-DOWN, DOOR-HASH, DOOR-GUEST |
| (integrator, found in the unit runs) | A SIG or a message sent right behind a CK frame was dropped as nobody's: the CK's interest refresh ran in the background (E-CL-1 shape in `calls-service` lost its ring in 4 of 7 full runs) | The lane awaits the CK listeners before the wire's next frame (`_emitWait`, `src/chat/lane.js`); `onCk` awaits `refreshInterest`, and a refresh that a later one replaced waits for that one (`src/chat/service.js`) | `chat-lane-service` (fails on the code before), `calls-service` |
| (integrator, found in the unit runs) | The moderator-cap test named a late tombstone's target that could already be hidden, leaving 19 effects in 1 of 40 runs alone | The late tombstone names a post that is not hidden yet, so the check stays exact (`test/unit/chain-v03-review.test.mjs`) | `chain-v03-review` |

### Deferred (on [ROADMAP.md](../ROADMAP.md), "Left open by code review round 2")
Members' signed pin requests and the pin mailbox's sender (chat-calls-media 7, ledger-tools 7); the per-author byte quota (MF-54); a signed
`minSeq` (MF-30); an owner hand-over for personal pages (loader-sw #8); a signed peer-hint record (MF-77); an identity-origin vault API for
file keys (MF-72); `setName('')` or "Leave this site"; `mw.hub.withdrawPage()` and `report.send({ ledger })`; `mw.db.exportBlocks()`; an
identity-page switch for a hub identity after a "no"; refusing `chat.enable` without a STUN list (defense in depth only); directory signing
tooling (pending counsel); a read-only pin container or a shipped seccomp profile; the call phone notes and delivery states (gate rows);
the copy sign-off of the new strings; the end-to-end variants the fixers listed; the media device rows; the passphrase floor with people.

### Verification
`npm test`, `npm run test:browser`, `npm run test:example`, `node test/e2e/run.mjs` and `node test/e2e/run.mjs --webkit` were run after
the last change, in a copy of the tree for the e2e runs (loopback only, every request checked); the counts are in
[INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md) ("v0.3 code review round 2 integrated").
