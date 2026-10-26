# Review: requirements fidelity and honesty

Lens: REQUIREMENTS FIDELITY & HONESTY. Reviewed: `docs/ARCHITECTURE.md` (v0.1, 2026-10-14) and
`docs/INTERFACES.md`, complete. Review date: 2026-10-14. Facts in ARCHITECTURE §1 are treated as true.

Method: each requirement in the user's own words is compared with the design; every deviation is
judged on (a) whether it is forced by browser reality, (b) whether the spec says so where the user
will read it, and (c) whether the closest achievable alternative is offered. Then visitor/developer
UX is walked through (first visit, consent, errors, publishing, the example). Only items that cause
a real failure, a security hole, a broken browser, a misleading claim, or an undeliverable
requirement are listed. Each item names the file/section and the exact change.

Verified from source during this review (not from memory):

- `node_modules/webtorrent/lib/torrent.js` L370-377: for a magnet without `info`, metadata comes
  from `_getMetadataFromServer()` (only when `this.xs` is set) or from a peer's `ut_metadata` after
  discovery. L484-552: `xs` must be `http(s)`, is fetched with `fetch`, parsed and infohash-checked.
  L575-581: web seeds are attached only inside `_onMetadata`. A web seed can never bootstrap a
  magnet-only load.
- `node_modules/magnet-uri/index.js` L36, L101-102, L160: `ws` maps to `urlList`; `xs` is kept and
  re-emitted by `toMagnetURI` when it is not a `urn:btpk:` key.
- Repository state: `README.md`, `docs/CRITIQUE.md`, `docs/DEPLOY.md`,
  `docs/research/RESEARCH-DIGEST.md`, `docs/DEVIATIONS.md` do not exist. `src/`, `tools/`, `test/`,
  `examples/peer-guestbook/` are empty directories. Nothing runs yet; all UX timings below are estimates.

---

## 1. Scorecard: user requirement vs design

| # | User requirement (their words) | Design answer | Deviation | Forced? | Said to the user? | Verdict |
|---|---|---|---|---|---|---|
| R1 | "serverless… only front end… no backend or backend DB" | Static shell + WebTorrent + per-site chain in IndexedDB. Commodity deps: static host, WS trackers, STUN, DoH, web seed. | Visitors need no backend. The publisher still needs one always-on commodity (web seed bucket or a pinned browser) for 24/7 reachability, and a tracker someone runs. | Yes: browsers cannot listen for connections; WebRTC needs signalling. | §0 yes, internally. No user-facing text exists (B4). | Met with caveats. |
| R2 | "compatible with all major browsers" | G6 list, boot feature-detect, degraded (no-SW) mode. | HTTPS/secure context is mandatory; in-app WebViews and Firefox private get degraded mode; Safari evicts storage after 7 idle days; Lockdown Mode untested. | Yes. | Partly (§5 step 2). Secure context and iOS eviction are not stated (B3, M3). | Achievable; spec incomplete. |
| R3 | "needs a html javascript loader first" | `boot.js` → `loader.js` → SW. | None. | | | Met. |
| R4 | "a browser blockchain node connected to any other visitors… to keep the DB" | Signed, hash-linked DAG, hashcash, deterministic order, owner policy, gossip over torrent wires. No mining, consensus or finality. | Not a proof-of-work ledger. | Yes: anonymous, ephemeral browser nodes cannot do Sybil-resistant consensus, and a guestbook does not need global ordering. | §2 and §6 say so but defer to `docs/CRITIQUE.md`, which does not exist. Three real gaps are unstated: gossip bound to one version's swarm (M1), open-writer flooding (M5), 50k-block ceiling. | Closest honest alternative chosen; gaps must be stated. |
| R5 | "the loader is also a torrent client… loads websites by magnet link… seeded by other visitors" | WebTorrent download; re-seed from IndexedDB via `BlobChunkStore` + `skipVerify`. | WebRTC-only swarm: desktop torrent clients cannot seed to browsers; seeding only while the tab is open; cold start needs `xs=` and the spec has none. | Yes (browser constraint), except the missing `xs`. | §1 states the mechanics; the consequence for the owner is not spelled out. | Met for a warm swarm. Cold start broken as specified (B1). |
| R6 | "instead of a domain url now websites load with magnet url" | Hub mode `#magnet:` / `#btih:`; manifest `protocol_handlers`. | All hub sites share one origin and one identity key (B2). Protocol handler works only for an installed app on desktop Chromium (m1). | Isolation is not forced: wildcard subdomains fix it. | §3 mentions wildcard as optional; §13 calls the banner + sandbox "isolation". | Partially met; unsafe default. |
| R7 | "put the magnet link into a dns record so once we visit a domain the loader would load the website" | `_magnet.<host>` TXT over DoH (Cloudflare + Google), signed record, TOFU owner pin. | The browser cannot read DNS: third-party resolvers see the hostnames. The domain must still serve the shell; DNS cannot replace the host. `<meta>` wins over DNS in per-domain mode. | Yes. | §0 names DoH. "The host is still required" is implicit only. Not demonstrated by the example. | Met; needs plain statement and a live demo (M11). |
| R8 | "main website delivers the loader through a static S3 or something" | Any static host; SPA fallback; S3 web seed layout. | S3 *website endpoints* are HTTP-only. No Service Worker and no WebCrypto over HTTP, so bare S3 cannot host the loader; CloudFront+ACM (or Pages) is required. | Yes. | Not stated anywhere (B3). | Met only with an HTTPS host. |
| R9 | "all visitors help keep the chain alive by their visit" | Every visitor stores all blocks and gossips; cheap gossip continues while hidden. | Only while a tab is open; iOS suspends background tabs within seconds; storage is evictable; desktop pauses file seeding after 10 min hidden; zero concurrent visitors = nothing alive except a pin/web seed. | Mostly yes. The desktop pause is a choice (M10). | G3 says "while the tab is visible". The 24/7 reading the user has is impossible in browsers and nothing says so to him. | True while tabs are open; the uptime reading must be corrected in README. |
| R10 | "work on mobile browser" | Policy table, mobile-first UI, size caps, cellular download-only. | STUN-only WebRTC fails for many phone-to-phone pairs on carrier NAT (M2); the LAN demo is HTTP, so phones fail boot (B3); iOS storage eviction (M3). | NAT: yes (TURN is a bandwidth server). Demo: no. | Not stated. | Designed for; demo path and NAT story must be fixed. |
| R11 | "be precise, be accurate… smartest and worst critic" | §1 is exemplary: every library fact verified. | §0 and §13 overstate web-seed reachability and content integrity (B1, M4); the honesty artefacts are missing (B4). | | | Internally rigorous; user-facing honesty absent. |

---

## 2. Issues, ranked

### BLOCKERS

#### B1. Cold start from a web seed cannot work as specified; §0's reachability promise is false

- Where: ARCHITECTURE §0 ("strongly recommended an HTTP web seed so the site is reachable when no
  visitor is online"), §4 pointer grammar, §5 step 4, §10 `publish.mjs` outputs; INTERFACES
  `parsePointer`, `formatPointer`, `magnetFromRecord`, `TorrentManager.download`.
- Problem: a magnet-only `client.add()` obtains metadata only from a WebRTC peer (`ut_metadata`) or
  from an `xs=` http(s) URL; web seeds are attached only after metadata exists (torrent.js
  L575-581). The pointer grammar has no `xs`, `magnetFromRecord` merges only `tr`/`ws`/`dn`, and
  `webseed-layout.txt` never places `site.torrent` anywhere reachable. With zero visitors online the
  loader spins until `metadataMs` (45 s) and shows `E_TIMEOUT`. That is the exact scenario the
  sentence promises to cover.
- Change:
  1. §4 grammar: add `xs=<https URL of site.torrent>` (repeatable), included in the signed input.
  2. `publish.mjs`: default `xs = <ws base>/<name>.torrent`; list `site.torrent` at that key in
     `webseed-layout.txt`; include `xs=` in `pointer.txt`, `dns.txt`, `meta.html`, `magnet.txt`.
  3. INTERFACES `parsePointer` record gains `xs: []`; `magnetFromRecord` emits `xs` params
     (magnet-uri re-emits non-btpk `xs` unchanged); `TorrentManager.download({ magnet, torrentFile?,
     maxBytes, signal })` prefers `torrentFile` bytes when present (repeat visits, imports).
  4. Web seed CORS note (§1 bullet 7 and DEPLOY): the `.torrent` object needs the same
     `Access-Control-Allow-Origin: *` because it is fetched with `fetch`.
  5. §12 E2E add case (7): no seeder tab, web seed + `xs` only → renders; assert `source ===
     'webseed'`.
  6. §0 wording: "reachable when no visitor is online, provided the pointer carries `ws=` and
     `xs=`".

#### B2. Hub mode as specified hands every magnet-loaded site the loader's data for all other sites, including the visitor's signing key

- Where: ARCHITECTURE §3 (hub mode), §7 (iframe `sandbox` and the CSP `sandbox` header both carry
  `allow-same-origin`), §13 "Hub mode isolation: CSP sandbox header + iframe sandbox + banner".
- Problem: with `allow-same-origin` the site document is same-origin with the hub. It can open
  `mw-sites` and every `mw-chain-*` database: load `identity.me` (non-extractable, but usable with
  `crypto.subtle.sign`, so it can forge chain blocks as the visitor on every site ever visited via
  that hub); read and overwrite cached `files` of other btih keys (the SW serves `files` without
  re-hashing, so one malicious hub site poisons every other cached site on that origin until the
  visitor clears the cache); rewrite `pointers` and `pins`. The banner changes none of this. R6 is
  the hub, so the flagship "load any site by magnet" feature is unsafe as written. Dropping
  `allow-same-origin` is not a drop-in fix: an opaque-origin frame is not controlled by the Service
  Worker in Chromium (verify Firefox/Safari), so `/_mw/s/...` serving stops.
- Change (choose one and write it into §3 and §13):
  - (a) Untrusted content is supported only on wildcard subdomains (`<btih>.hub.example`, already
    designed). Bare `hub.example/#magnet:` renders in degraded mode (srcdoc + `blob:` URLs, opaque
    origin, no IndexedDB access, no SDK/chain) behind a banner "demo isolation only".
  - (b) Keep bare hub mode but give each hub site in-memory identity and chain stores and mount it
    in an opaque-origin sandbox served in degraded mode.
  - Either way: §13 must stop describing `allow-same-origin` + banner as isolation; namespace hub
    chain databases by btih so a pointer's `chain=` cannot select another site's local copy on the
    same origin; and the SW should refuse `/_mw/s/<X>/...` requests from clients whose URL is not
    under `/_mw/s/<X>/` or the shell.

#### B3. The documented demo and the "static S3" deployment do not run on phones (secure context)

- Where: ARCHITECTURE §11 ("prints the hub URL to open in any browser on the LAN"), §10
  `dev-server.mjs`, §5 step 1 feature-detect, every S3 reference (§3, §10), the missing DEPLOY.md.
- Problem: Service Workers and `crypto.subtle` exist only in secure contexts (HTTPS or
  `localhost`). On `http://192.168.x.x:8080` from a phone, `crypto.subtle` is `undefined`, so
  `boot.js` prints "your browser lacks WebCrypto" (false: the page is insecure) and SW registration
  throws. A self-signed certificate accepted through the interstitial still fails SW registration in
  Chrome and Safari (certificate-error origins are refused), so "accept the cert on the phone" yields
  degraded mode at best. S3 website endpoints are HTTP-only; HTTPS needs CloudFront+ACM or another
  host. `ws://` trackers are mixed content on an HTTPS shell.
- Change:
  1. `boot.js`: test `window.isSecureContext` first; message "This page must be served over HTTPS
     (or localhost). Current: http://…" before any feature message.
  2. §11 / `npm run demo`: document three tiers and print which one is running: (1) desktop
     `http://localhost` = full mode; (2) phone on the LAN = needs a trusted certificate (mkcert root
     installed on the phone) or a tunnel, otherwise degraded mode; (3) real test = deploy `dist/` to
     GitHub Pages / Cloudflare Pages / CloudFront. Add `dev-server.mjs --https --cert --key` and
     `tracker.mjs --https` so tier 2 is possible.
  3. DEPLOY.md: "S3 website endpoints are HTTP-only. Front the bucket with CloudFront, or use
     GitHub Pages / Cloudflare Pages. The loader must be served from the origin root (m2)."
  4. §13 CSP: keep `wss:`; allow `ws://localhost:*` only when the shell itself is `http://localhost`.

#### B4. The honesty layer the user asked for does not exist, and the frozen spec depends on it

- Where: §2 and §13 cite `docs/CRITIQUE.md` for the central deviation and the security model; §3
  cites `DEPLOY.md`; §14 and INTERFACES `config.js` cite `docs/research/RESEARCH-DIGEST.md`
  ("builders must read the digest's decisions before finalising config.js"); §11 cites a README.
- Problem: none of these files exist. The single most important deviation ("not a proof-of-work
  blockchain"), the trust model, the deployment constraints and the tracker/STUN/DoH decisions are
  all delegated to missing documents. The user explicitly asked to be told precisely what is and is
  not delivered; today nothing user-facing says anything. `config.js` cannot be finalised against a
  digest that has not been written.
- Change: write before implementation freezes: (1) `README.md` with a "What this is / what it is
  not" section containing at least the twelve statements in §4 of this review; (2) `CRITIQUE.md`:
  why no PoW/consensus, Sybil and flooding reality, host as trust root, privacy (IP to peers and
  tracker, hostnames to DoH), availability (tab-open only; pin or web seed), deletion best-effort;
  (3) `RESEARCH-DIGEST.md` decisions for trackers/STUN/DoH, or mark `config.js` values "unverified
  placeholder" in the UI debug panel until it lands; (4) `DEPLOY.md`.

### MAJOR

#### M1. The chain gossips only inside the current version's swarm, so the DB forks across versions and mirrors

- Where: §6.5 (gossip rides the site torrent's wires), §4 `chain=` ("keep its database across
  versions and mirrors"), §5 step 8 "Update available".
- Problem: visitors on btih A (old) and btih B (new) sit in different swarms and never exchange
  blocks; hub `#host:` visitors and per-domain visitors likewise whenever they resolved different
  versions. `chain=` equalises the identifier but gives no connectivity, so during every rollout the
  "DB" is split and posts appear to vanish and reappear. Seeding splits the same way.
- Change: join a second, metadata-less "chain swarm" per chain id:
  `btihChain = sha1("mw-chain/" + chainId)` via `client.add(btihChain, …)`; wires form and the
  `mw_chain` extension works before metadata (§1 already relies on this). Attach the gossip to wires
  of both torrents. Verify in the spike that WebTorrent keeps metadata-less wires open; if it drops
  them, have `publish.mjs` create a deterministic one-piece "chain anchor" torrent whose content is
  the chain id string and use its infohash instead. Record in §6.5 and INTERFACES `attachToTorrent`.

#### M2. No TURN and no explicit relay: some visitor pairs can never connect, and the spec is silent

- Where: §0 ("public STUN servers"), INTERFACES `config.js` `stun`, §6.5 HELLO trigger ("after
  local head changes"), §8.
- Problem: STUN-only WebRTC fails for symmetric-NAT / carrier-CGNAT pairs, which is common for
  phone-to-phone on cellular. Files fall back to the web seed. The chain converges only if blocks
  relay through a third, mutually reachable visitor; if "local head changes" excludes remotely
  ingested blocks, that relay does not exist and partitioned visitors never converge. TURN is
  incompatible with "no backend" (it relays bandwidth and needs credentials), so the honest answer
  is disclosure plus guaranteed multi-hop.
- Change: §6.5: "HELLO is re-sent (250 ms coalesced) after any head change, local or remote; every
  node relays". INTERFACES `Gossip`: an `ingest` result with `added.length > 0` schedules `hello()`.
  UI: after 20 s with zero peers show "0 peers (NAT?)" next to the web seed badge instead of a bare
  0. README/CRITIQUE: "no TURN; some pairs (more on cellular) cannot connect directly; downloads use
  the web seed, chain data flows through other visitors". Do not add a TURN key with static
  credentials to the pointer.

#### M3. Visitor-held copies are evictable; on iOS they are ephemeral by default; persistence is never requested

- Where: §6.6, §5 step 4 (render from cache), G5 "cache (offline)", §12 E2E (5).
- Problem: Safari deletes all script-writable storage (IndexedDB, Cache Storage, SW registrations)
  for a site after seven days of Safari use without interaction with that site, unless it is
  installed to the home screen. Chromium evicts best-effort storage under pressure. "Visitors keep
  the chain alive" and "instant render from cache / offline" are therefore weaker than the spec
  reads, on iOS considerably so, and nothing calls `navigator.storage.persist()`.
- Change: `cache.js`/`app.js`: call `navigator.storage.persist()` once after the first successful
  render (Chromium grants silently for engaged/installed sites; Firefox prompts; Safari decides).
  `ui.js`: an install hint on iOS Safari ("Add to Home Screen keeps this site and its data
  offline"); the manifest already exists for this. README: state the seven-day rule. Mark as not
  E2E-testable.

#### M4. The static host is the trust root on every load, not only the first; §13 overstates what the torrent protects

- Where: §13 "Content integrity: … a third party cannot substitute content"; §7 SW navigation route
  "network first (3 s timeout) then precached index.html"; the user's premise "S3 delivers the
  loader, then the loader does the rest".
- Problem: the infohash protects against peers, not against the host. Because navigations are
  network-first, every reload fetches the shell from the host while online; whoever controls the
  host, its DNS, or an expired domain replaces the loader, the SRI hashes it ships and the pointer.
  The user's mental model ("S3 only bootstraps") is wrong as designed and nothing tells him.
- Change: (1) README/CRITIQUE: "Your host and your DNS remain a full trust root for every visitor on
  every visit. P2P delivery protects the site files against tampering by peers, not by your host.
  Treat the host like your web server." (2) Decide in §7 whether shell navigation becomes
  cache-first with the standard SW update flow (byte-diff check → new SW → "Loader updated, reload"
  notice), which makes a host swap visible and deferred after the first visit; keep network-first
  only when no cached shell exists. Record the decision either way.

#### M5. Default chain policy lets anyone exhaust a site's DB in minutes; 14-bit hashcash is presented as a defence

- Where: §6.1 Policy defaults (`bits: 14`, `writers: 'open'`, `maxValueBytes: 8192`), §6.2 rate
  limit "per author", §6.6 cap 50 000 blocks, INTERFACES `LIMITS.maxBlockBytes: 16384`.
- Problem: keys are free, so a per-author limit bounds nothing; 14 bits is about 16k SHA-256
  (milliseconds on a laptop). An attacker can mint 50 000 blocks of 16 KiB (about 800 MB) in
  minutes; every visitor downloads and stores them, the cap is hit, and the UI "warns". The
  requirement "keep the DB for that website" fails under the mildest abuse. Detail belongs to the
  security lens; the fidelity point is that the defaults and the wording promise more than they do.
- Change: §6.1: default `writers: 'owner'` for owned (signed) sites, with `open` an explicit owner
  opt-in (the example opts in and the README says why); default `maxValueBytes` 1024 and block
  4 KiB; a per-site byte budget (e.g. 32 MiB) after which only owner/allow-listed blocks are
  ingested; owner-tunable `bits` with a UI estimate ("20 bits ≈ 2 s on a phone"). README: "open
  writing is a public wall anyone can flood; your tools are allow-lists, tombstones and difficulty".

#### M6. A 3-second Service Worker deadline turns slow phones into "limited mode", where site JavaScript breaks

- Where: §5 step 2 ("Do not block on controller longer than 3 s… continue in degraded render
  mode"), INTERFACES `registerServiceWorker({ timeoutMs = 3000 })`, §7 install precache.
- Problem: first-visit SW install precaches the shell including the 223 KB webtorrent bundle; on
  low-end Android or 3G, install + activate + claim can exceed 3 s. Degraded mode disables relative
  `fetch` from the site's own JS (§7), so a timing heuristic silently produces a broken site on
  exactly the devices the user asked about.
- Change: choose degraded mode only when `!('serviceWorker' in navigator)` or `register()` rejects;
  otherwise await `navigator.serviceWorker.ready` behind a visible "Preparing offline engine…" line
  with a 20 s hard cap. Keep `install` light: precache `index.html`, `boot.js`, `loader.js`,
  `sw.js`, `sdk.js` only; fetch `webtorrent.min.js` and `pow-worker.js` into the cache from
  `activate` without blocking. Record in §7.

#### M7. Consent is a notice shown after the IP is already exposed; in hub mode that is the wrong order

- Where: §8 Consent; §5 step 4 (WebTorrent starts before the notice); §13 privacy disclosure.
- Problem: the tracker learns IP + infohash (which site you are reading) and peers learn your IP
  before you can act. On the owner's own domain an informational notice is defensible (the owner
  chose P2P hosting and discloses it). In hub mode the visitor followed an arbitrary link, and the
  notice text omits the tracker.
- Change: §8: state "notice, not a consent gate" for per-domain mode; in hub mode gate on a click
  ("Load peer-to-peer. Peers and the tracker will see your IP address") unless the site is already
  cached; add "and the tracker" to the text. Settings: besides "uploads off", offer "web seed only"
  (no WebRTC) when `ws=` exists; it is the honest no-peer-exposure path.

#### M8. Wildcard-subdomain hub and bare-magnet hub compute different chain ids; unsigned magnets have no owner

- Where: §3 (`^[0-9a-f]{40}\.` → per-domain mode), §4 chain id default, INTERFACES `chainIdFor`.
- Problem: `X.hub.example` → mode `domain` → `host:X.hub.example`; `hub.example/#btih:X` →
  `btih:X`. Same site, two DBs, and §6.5 makes peers with mismatched `site` ignore each other inside
  one swarm. Separately, a bare `magnet:` carries no `owner`, so no policy, no owner tombstone, no
  moderation ever; acceptable, but unstated.
- Change: `chainIdFor`: when the hostname matched the btih pattern, default to `btih:<hex>`. README:
  "A site published as a bare magnet has no owner: nobody can moderate or remove posts. Publish a
  signed pointer if you want to be the owner."

#### M9. An expired pointer kills the cached and offline copy

- Where: §4 validity ("exp must be in the future"), source 4 "cached last-known-good", §10
  `publish.mjs --exp <days>`.
- Problem: validity is evaluated identically for the cached record, so when `exp` passes the site
  stops rendering from cache, even offline, until the owner re-signs: a certificate-expiry time bomb
  in a design sold as offline-first.
- Change: §4: expiry applies to fresh sources (1-3); for source 4 an expired record is used with a
  visible "pointer expired on <date>; showing last known version" warning. `publish.mjs`: no expiry
  by default; `--exp` opt-in with a printed renewal reminder.

#### M10. Desktop seeding pauses after 10 minutes hidden, discarding most of the capacity that could keep a site alive

- Where: §8 table "seed when hidden: yes, up to 10 min then pause".
- Problem: most open desktop tabs are hidden. Browsers throttle timers in hidden tabs, but WebRTC
  data-channel traffic is event-driven and keeps flowing, so hidden seeding is feasible. The default
  throws away the one population that could give the swarm uptime, which cuts directly against R9.
- Change: desktop default = keep seeding while hidden (chain gossip already does) unless
  `navigator.getBattery()` reports discharging or uploads are off; re-announce at the tracker
  interval. Keep mobile as specified and say "iOS suspends background tabs within seconds regardless
  of this setting".

#### M11. The example does not demonstrate the parts of the concept the user cares most about

- Where: §11, §12 E2E list.
- Problem: E2E covers tab-to-tab transfer, SW serving, chain sync, tombstone, cache/offline and the
  `<meta>` pointer. It does not cover DNS TXT discovery (needs a real domain), cold start from a web
  seed (B1), the update flow (seq+1 → banner → new btih), the owner key-change prompt, two machines
  across NATs, or any phone. The demo runs over HTTP on a LAN, so phones fail (B3). The user asked
  for an example of this concept: DNS → magnet → P2P → chain, on mobile.
- Change: add E2E (7) cold start via `ws`+`xs`, (8) update flow, (9) key-change prompt. Add one
  documented manual run: publish the example to a real domain (GitHub Pages or CloudFront), set the
  `_magnet` TXT, open from a phone on cellular and a laptop on another network, record peer counts
  and timings in `docs/DEMO-RESULTS.md`. Until that exists the README says "DNS path: unit-tested
  against fixtures, not demonstrated live".

### MINOR

- m1. `manifest.webmanifest` `protocol_handlers: magnet` works only for an installed app on desktop
  Chromium, never on iOS. §10 should say so and the UI install hint must not promise that magnet
  links will open the loader on phones. The hub URL form is the universal answer.
- m2. Root-path requirement. `/sw.js` scope `/`, `/_mw/*` and `/404.html` assume the loader sits at
  the origin root; GitHub Pages project sites (`user.github.io/repo/`) and any sub-path deployment
  break. State it in DEPLOY.md; `boot.js` should detect a non-root shell via
  `document.currentScript.src` and refuse with a clear message.
- m3. `boot.js` detects `BigInt`, which nothing in the spec uses (the chain restricts itself to safe
  integers). Detect only what is used, or the "which feature is missing" message misleads. Also test
  under Safari Lockdown Mode (the user runs it daily); if WebRTC or Workers are unavailable there,
  name Lockdown Mode as the likely cause rather than "unsupported browser".
- m4. Publishing-workflow facts to put in README (documentation, not design): losing `owner.jwk`
  means a TOFU-pinned domain can never be updated without every visitor seeing "publisher key
  changed"; the same master key is pasted into a browser for moderation ("owner login"), so plan a
  separate moderator key (v1 workaround: owner sets `policy.allow` and keeps the master key
  offline); every publish creates a new infohash and the swarm restarts from the web seed; `name`
  must never change; some registrars mangle multi-string TXT (the `dns.txt` instructions are the
  right mitigation).
- m5. Error timing: `metadataMs 45000` and `noPeersMs 60000` mean a visitor watches a spinner for
  45-60 s before learning a site is unreachable. Show a live diagnosis within 5 s ("tracker
  connected, 0 peers, no web seed in pointer") and the owner-facing remedy in the error ("add
  `ws=`/`xs=` or run `pin.mjs`"). README should also say plainly that with zero visitors online a
  P2P load is strictly slower than plain static hosting; the benefits are concurrency, integrity,
  offline and the chain.
- m6. DoH privacy: every `#host:` resolution sends the hostname to Cloudflare and Google in
  parallel. Disclose in README; let Settings disable a resolver; DEPLOY.md should say that `<meta>`
  (already first in priority) avoids the third party entirely for per-domain deployments.
- m7. SDK documentation must say that everything written through `mw.db` is public to every visitor
  and that tombstone is best-effort (nodes that never receive the tombstone keep the payload). The
  guestbook's "delete my post" button otherwise over-promises.

---

## 3. UX walk-throughs

### 3.1 First visit (per-domain mode, `<meta>` pointer, warm swarm). Estimates; nothing is measured yet except the spike's ~170 ms LAN transfer.

| Step | What happens | Typical cost | Where it can go wrong |
|---|---|---|---|
| 1 | Shell HTML + `boot.js` + `loader.js` + `webtorrent.min.js` (223 KB min, ~70 KB gzipped) | 0.3-1.5 s on 4G | Non-HTTPS host: boot fails with a misleading message (B3). Sub-path host: SW scope wrong (m2). |
| 2 | SW register/install/activate/claim in parallel | 0.5-4 s on low-end phones | 3 s deadline → spurious degraded mode (M6). |
| 3 | Pointer: `<meta>` 0 ms; DoH 100-400 ms (two resolvers in parallel) | | Hub `#host:` leaks hostname to two resolvers (m6). |
| 4 | Tracker WebSocket connect, announce with up to 5 offers | 0.2-0.6 s | Public trackers down → silent wait (m5). |
| 5 | First wire (ICE) and metadata via `ut_metadata` or `xs` fetch | 1-5 s / 0.1-0.3 s | CGNAT pair: no wire, no web seed → `E_NO_PEERS` after 60 s (M2, m5). Magnet without `xs` and no peers → 45 s then `E_TIMEOUT` (B1). |
| 6 | Pieces download, SHA-1 verify, Blob + manifest to IndexedDB | site size / bandwidth | Cap exceeded → `E_TOO_LARGE`; quota → UI. |
| 7 | Iframe mounted at `/_mw/s/<btih>/<entry>`, consent notice shown | ~100 ms | Notice arrives after IP exposure (M7). |

Realistic total: 3-8 s on a phone, under 1 s on a repeat visit (render from IndexedDB, then seed).
With zero visitors online and a correct `ws=`+`xs=` pointer it is roughly static hosting plus 1-2 s
of tracker/metadata overhead; the README should say so (m5).

### 3.2 Consent and disclosure

The notice text is good ("they can see your IP address"). It should add the tracker, state that it
is a notice rather than a gate in per-domain mode, and become a gate in hub mode (M7). The
"uploads off" setting and the absence of analytics are real strengths.

### 3.3 Error states (as specified)

| Code | Visitor sees | Actionable? |
|---|---|---|
| boot feature missing | Which feature and which browser versions have it | Yes, except the insecure-context case, which is reported as a missing feature (B3). |
| `E_TIMEOUT` (45 s) | Timeout | Too late and too vague; needs the 5 s live diagnosis (m5) and, for owners, "add `xs=`". |
| `E_NO_PEERS` (60 s) | No peers | Same; should distinguish "tracker unreachable" from "tracker fine, nobody online" from "peers exist but ICE failed" (M2). |
| `E_TOO_LARGE` | Cap exceeded | Yes, if the message states the cap and the visitor-overridable setting. |
| `QuotaExceededError` | UI message | Yes. |
| Publisher key changed | Both fingerprints + confirm | Yes; good design. |
| Pointer expired | Hard failure, even offline | Must degrade to a warning for cached records (M9). |

### 3.4 Publishing workflow (owner)

`keygen` → `publish.mjs` → upload `dist/` shell to an HTTPS static host at the root → upload site
files (and, after B1, `site.torrent`) under `<ws base>/<name>/` with CORS → paste TXT or `<meta>` →
done. Updates: re-run `publish.mjs` (seq+1) → new infohash → visitors see "Update available". The
flow is simple and the generated artefacts (`dns.txt` with Route53 JSON, `meta.html`,
`webseed-layout.txt`) are the right idea. Bites: HTTPS/root constraints are unstated (B3, m2); the
master key doubles as the moderation key (m4); every publish restarts the swarm (m4); DB split
during rollouts (M1); expiry time bomb (M9).

### 3.5 Does the example prove the concept?

| Claim | Proven by the spec's E2E? |
|---|---|
| Site loads by magnet from another visitor | Yes (tab to tab, same machine). |
| Rendered at its origin with CSS/JS/fetch/images | Yes. |
| Visitors re-seed from cache, same infohash | Yes. |
| Chain append, sync, owner tombstone | Yes. |
| Offline reload | Yes. |
| `<meta>` pointer | Yes. |
| DNS TXT pointer over DoH | No (fixtures only). |
| Cold start from web seed, no visitors | No, and impossible as specified (B1). |
| Update flow, key-change prompt | No. |
| Cross-network NAT traversal | No (LAN, local tracker, one machine). |
| Any phone | No (HTTP LAN demo fails boot, B3). |

Verdict: the example proves the engine, not the user's scenario. M11 lists the additions.

---

## 4. Twelve statements the README must contain (the honesty checklist)

1. Visiting your domain always downloads a small loader from your host over HTTPS. The DNS record
   points at the site; it cannot replace the host.
2. Your host and your DNS remain a full trust root on every visit. Peer-to-peer integrity protects
   the site files against peers, not against your host.
3. Browsers can only exchange data with other browsers (WebRTC). Ordinary torrent clients cannot
   seed your site to visitors; the swarm is your visitors plus, optionally, a WebRTC-capable seeder
   or web seed.
4. Visitors share the site only while the tab is open; phones stop within seconds of backgrounding.
   When nobody is online nothing is served unless you keep a web seed (any static bucket with CORS)
   or a pinned browser.
5. The "blockchain" is a signed, hash-linked, replicated log with deterministic ordering, owner
   moderation and a small proof-of-work per write. There is no mining, no consensus, no finality,
   no token.
6. Everything written to the chain is public to every visitor and may persist on nodes that never
   receive a deletion.
7. Peers and the tracker see each visitor's IP address and which site they are loading. The loader
   says so on first run. "Web seed only" avoids peer exposure.
8. Signalling needs a WebSocket tracker and STUN. Some visitor pairs (carrier NAT) cannot connect
   directly; downloads then use the web seed and chain data relays through other visitors.
9. DNS discovery uses Cloudflare's and Google's DNS-over-HTTPS, which see the hostnames; a
   `<meta>` pointer avoids them.
10. Browser storage can be evicted (Safari: seven idle days unless installed to the home screen).
    Visitor copies are a cache, not a backup; export or pin for durability.
11. Open writing means anyone can flood a site's log; owner policy, allow-lists and difficulty are
    the tools.
12. Full mode requires HTTPS, a root-path deployment and a browser with Service Workers; otherwise
    a limited mode runs in which the site's own JavaScript cannot fetch its files.

---

## 5. Requirements quietly dropped or narrowed

- "connected to any other visitors" → only visitors holding the same version (btih) until M1.
- "all visitors help keep the chain alive by their visit" → while a tab is open and visible; not on
  iOS in the background; until storage eviction; desktop file seeding pauses after 10 min hidden
  (M3, M10).
- "the torrent network" → the WebRTC-only subset; no DHT; trackers mandatory; a magnet alone is not
  enough without `xs=` (B1).
- "load any website by magnet url" → hub mode is unsafe as specified (B2); magnet protocol handler
  is desktop-installed-app only (m1).
- "static S3" → an HTTPS host at the root is required (B3, m2).
- "keep the DB" → 50 000-block ceiling with no compaction in v1; open-writer flooding (M5);
  unsigned sites have no owner (M8); expiry can disable the cached copy (M9).
- "no backend" → true for visitors; the publisher needs a tracker (public or own) and a web seed or
  pin for 24/7 reachability (R1, honest in §0, absent for the user).

---

## 6. Strengths worth keeping

- §1 is the right kind of rigour: every library behaviour the design leans on was verified against
  webtorrent 3.0.21 source and a working spike, including the subtle ones (fsa-chunk-store wipes
  on load; the `wire` listener must be registered synchronously; multi-file web-seed URL layout).
- The chain design picks the honest alternative to a blockchain: a content-addressed DAG with
  deterministic (depth, hash) ordering, pure reducer, owner policy as data, tombstones that keep the
  DAG connected, and no reliance on timestamps for ordering.
- The pointer record is well thought out: scope-bound signatures (no cross-domain replay), seq
  rollback protection, TOFU owner pinning with a visible key-change prompt, and `<meta>` as a
  zero-third-party option.
- Same-origin rendering through a Service Worker with correct MIME, Range, directory and 404 rules
  is what makes "a real website" rather than a demo; deep links and history mirroring are covered.
- The visitor policy table (cellular download-only, caps, visibility handling) and the plain-language
  IP disclosure show the right instincts for mobile and privacy.
- Tooling outputs (`dns.txt` with registrar-ready splitting, `webseed-layout.txt`, `meta.html`)
  turn the publishing workflow into a paste job, which is what a static-host owner needs.
- Shared Node/browser chain code with injected storage and PoW makes the unit and E2E test plan
  credible.

---

## 7. Not verified in this review

- Whether Firefox and Safari let a Service Worker control an opaque-origin sandboxed frame (B2
  mitigation design).
- Whether WebTorrent keeps metadata-less wires open indefinitely (M1 fix); the anchor-torrent
  fallback is given for that case.
- Behaviour under Safari Lockdown Mode (m3).
- CORS on the Cloudflare and Google DoH JSON endpoints (spec marks this RESEARCH-PENDING).
- Any runtime timing; nothing is built yet. All numbers in §3 are estimates and labelled as such.
