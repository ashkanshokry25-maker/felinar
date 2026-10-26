# Research index

This folder holds the research behind magnet-web: 42 research files written on 2026-10-14 and 2026-10-17, their lab
and probe folders (all under [`labs/`](labs/) since 2026-10-19), and four digests written on 2026-10-19. None of it is
normative. The normative documents are `docs/ARCHITECTURE.md` v0.2, `docs/INTERFACES.md` v0.2 and
`docs/review/DESIGN-REVIEW.md` (its section 4 sets the wording rules). Start with the digest for the wave you care
about, then open the research file it cites.

**Status key**

- **verified**: a research file exists and a second-pass `-VERIFY` file re-checked its design-critical claims.
- **researched**: a research file exists, single pass, with no `-VERIFY` file. "Draft" marks an interim or checkpoint
  file whose final version was never written.
- **missing**: the topic was planned but never researched; there is no research file.

**Totals:** 40 planned topics in four waves: 35 researched (7 of them verified, 4 of them drafts) and 5 missing
(see [Gaps](#gaps)). The 42 files are 35 topic files plus 7 `-VERIFY` files.

## Digests (start here)

| Digest | Covers | Date | What it adds |
|---|---|---|---|
| [`RESEARCH-DIGEST.md`](RESEARCH-DIGEST.md) | Wave 1: files 01-06 and w1-07 to w1-13 | 2026-10-19 | Decisions D1-D38, endpoints, prior-art lessons, mobile policy, 63 merged recommendations (P0-1 to P3-11), a 41-row contradiction table saying which source wins, the minimum-browser matrix, 45 open questions |
| [`MIGRATION-DIGEST.md`](MIGRATION-DIGEST.md) | Wave 2a: migration | 2026-10-19 | Per-framework recipes, dynamic-feature replacements, SEO rules, a reference CI/CD outline, a hosting provider matrix, and what ARCH already decided for the three missing 2a topics |
| [`PRODUCTION-DIGEST.md`](PRODUCTION-DIGEST.md) | Wave 2b: production readiness | 2026-10-19 | Reference tracker and pin-node deployments, the observability plan, an ops and legal checklist with templates, the Nostr mirroring decision, and a placeholder latency model for the missing topic 07 |
| [`IMPROVEMENTS-DIGEST.md`](IMPROVEMENTS-DIGEST.md) | Wave 2c: improvements with precedent | 2026-10-19 | A three-tier roadmap, standards alignments to adopt now, honest economics (Little's law), identity UX decisions for v1 and v2 |
| `_w1-part-a.md`, `_w1-part-b.md` | The two halves of wave 1 (01-06; w1-07 to w1-13) | 2026-10-19 | Intermediate working files, merged into `RESEARCH-DIGEST.md`; read the merged digest instead |

## Wave 1: foundations

Planned as 14 topics. A first run on 2026-10-14 wrote topics 01-06 (files without a wave prefix) and was interrupted.
A completion run on 2026-10-17 (prefix `w1-`) wrote topics 07-13 and was also meant to verify 01-06; it verified only
07 and 09. Topic 14 was never researched. Digest: [`RESEARCH-DIGEST.md`](RESEARCH-DIGEST.md).

| # | Title | File | One-line summary | Date | Status | Evidence folder |
|---|---|---|---|---|---|---|
| 01 | WebTorrent in the browser: state of play on 2026-10-14 | [`01-webtorrent-browser.md`](01-webtorrent-browser.md) | `webtorrent@3.0.21` is WebRTC-only and BitTorrent-v1-only; a pointer with `xs=` and `ws=` loads with nobody online; the stock `createServer()` SW cannot render a site; engine traps measured in 12 experiments. | 2026-10-14 | researched (claims re-tested later by DR 16 and `w2c-06` VERIFY claim 7) | [`labs/01-webtorrent-lab/`](labs/01-webtorrent-lab/) |
| 02 | Public WebSocket trackers and self-hosting | [`02-wss-trackers.md`](02-wss-trackers.md) | Four public `wss://` trackers pass a full signaling test, ten historic ones are dead and none has an SLA; self-hosting options and free tiers; Nostr and MQTT as fallback planes. | 2026-10-14 | researched (five corrections in `w2b-01`) | [`labs/02-wss-trackers-probes/`](labs/02-wss-trackers-probes/) |
| 03 | WebRTC connectivity, NAT traversal, TURN and privacy | [`03-webrtc-nat-privacy.md`](03-webrtc-nat-privacy.md) | Direct P2P is probabilistic (plan for 15-30 % of peer pairs needing a relay), STUN and TURN vendor terms, platform limits (Lockdown Mode, Tor, iOS background), and why there is no private mode. | 2026-10-14 | researched | none (Appendix B inside) |
| 04 | Serving P2P-fetched sites via Service Worker | [`04-service-worker-serving.md`](04-service-worker-serving.md) | Our own SW plus a same-URL, same-origin iframe; opaque sandboxes bypass the SW, so only separate origins isolate; SW lifetime, `Range` and MIME rules per engine. | 2026-10-14 | researched | [`labs/04-sw-experiment/`](labs/04-sw-experiment/) |
| 05 | DNS TXT publishing and DNS-over-HTTPS (JSON) from browsers | [`05-doh-dns-txt.md`](05-doh-dns-txt.md) | Page JS can read a TXT pointer only through Cloudflare, Google and dns.sb (plus limited AliDNS, Control D, DNS4EU); multi-string TXT handling, resolver privacy, and how rare DNSSEC is. | 2026-10-14 | researched (registry count corrected by `w2c-06` VERIFY claim 2) | none (Appendices A-B inside) |
| 06 | Browser "blockchain" nodes vs signed DAG/CRDT replication | [`06-browser-chain-vs-crdt.md`](06-browser-chain-vs-crdt.md) | A browser proof-of-work chain is unsound; the site ledger should be an in-house signed op-DAG with deterministic order; Hashcash, canonical JSON, WebCrypto key and storage facts. | 2026-10-14 | researched (numbers re-tested by the `w2b-04`, `w2c-02` and `w2c-03` VERIFY files) | none (Appendices A-B inside) |
| 07 | Prior art: websites delivered by torrent or content hash, and why they stalled | [`w1-07-prior-art.md`](w1-07-prior-art.md) | Every stalled precedent lacked always-on seeding and every survivor is origin-first; lessons from ZeroNet, Beaker, IPFS gateways, Arweave, PeerTube and others. | 2026-10-17 | verified | none |
| 07V | Second-pass fact-check of "Prior art" | [`w1-07-prior-art-VERIFY.md`](w1-07-prior-art-VERIFY.md) | Re-checks 8 design-critical claims: 2 confirmed, 6 nuanced, 0 refuted; a SW takedown experiment shows that only a new 200 worker script evicts installed workers. | 2026-10-17 | verified (the verification pass) | [`labs/w1-07-verify-lab/`](labs/w1-07-verify-lab/) |
| 08 | Mobile browser constraints (iOS Safari, Android Chrome, Samsung Internet, Firefox Android) | [`w1-08-mobile-constraints.md`](w1-08-mobile-constraints.md) | Phones share only while visible; Mobile policy v1, the base64/hex polyfill (78/78 test262) and the minimum-browser matrix, whose hard floor `RESEARCH-DIGEST.md` corrects (4.1 row 27). | 2026-10-17 | researched | [`labs/w1-08-mobile-lab/`](labs/w1-08-mobile-lab/) |
| 09 | Opening `magnet:` links in a web loader (registerProtocolHandler, manifest protocol_handlers) | [`w1-09-protocol-handler-magnet.md`](w1-09-protocol-handler-magnet.md) | `magnet:` can be claimed only on desktop Chromium-family browsers and Firefox; share `https://<hub>/#btih:<hex>` links plus a paste box and a QR code. | 2026-10-17 | verified | [`labs/w1-09-lab/`](labs/w1-09-lab/) |
| 09V | Skeptical re-check of "Opening magnet: links in a web loader" | [`w1-09-protocol-handler-magnet-VERIFY.md`](w1-09-protocol-handler-magnet-VERIFY.md) | Re-checks 8 claims: 4 confirmed, 4 nuanced, 0 refuted; the SW still sees the `#` fragment, and Firefox Android's handler method exists but does nothing. | 2026-10-17 | verified (the verification pass) | [`labs/w1-09-verify-lab/`](labs/w1-09-verify-lab/) |
| 10 | Static hosting of the loader and web seed (S3/CloudFront, GitHub Pages, Cloudflare Pages/R2, wildcard origins, CSP/SRI, caching, cost, phone demos) | [`w1-10-static-hosting-bootstrap.md`](w1-10-static-hosting-bootstrap.md) | WebTorrent's own headers make most hosts fail the CORS preflight; host facts, SRI and CSP limits, caching, a 10k-visits/day cost model, phone demos; its compressed-`Range` finding is superseded for browsers by `w2a-07` F1. | 2026-10-17 | researched | none (appendices inside) |
| 11 | Security threat model for a torrent-loaded, multi-site, peer-backed web | [`w1-11-security-threats.md`](w1-11-security-threats.md) | Assets, adversaries, threats T1-T24 and P0-P3 mitigations: origin-only isolation, the wire length cap, a salted redaction commitment, `fj=` against SHA-1 collisions, consent, and a legal summary. | 2026-10-17 | researched | [`labs/w1-11-opaque-frame-lab/`](labs/w1-11-opaque-frame-lab/) |
| 12 | Signaling libraries and wire-extension messaging (Trystero, P2PT, bugout, simple-peer, libp2p, Hyperswarm) | [`w1-12-signaling-libs.md`](w1-12-signaling-libs.md) | Keep site-ledger gossip on `mw_chain1` over WebTorrent wires and add a bare-infohash rendezvous swarm (the one-piece anchor torrent fails); no Trystero, P2PT, bugout, libp2p or Hyperswarm in v1. | 2026-10-17 | researched | [`labs/12-signaling-lab/`](labs/12-signaling-lab/) |
| 13 | Toolchain facts (create-torrent, parse-torrent, magnet-uri, bittorrent-tracker, bundling, Playwright) | [`w1-13-toolchain.md`](w1-13-toolchain.md) | Executed facts on create-torrent determinism, magnet-uri parsing, an own header-stripped bundle (zero preflights), Node seeding, Playwright limits, the tracker server and BEP 47 padding. | 2026-10-17 | researched (checkpoint draft; the final version was never written) | [`labs/w1-13-lab/`](labs/w1-13-lab/) |
| 14 | Operational reality: PeerTube lessons, CDN-P2P hybrids, consent, costs | none | Never researched (see [Gaps](#gaps)). | - | missing | none |

## Wave 2a: migration (2026-10-17)

How an existing site (static export, SPA, CMS export) moves onto magnet-web, including the one-script-tag drop-in
mode. Twelve topics planned; nine written, three of them interim drafts; three missing. No `-VERIFY` file exists for
this wave. Digest: [`MIGRATION-DIGEST.md`](MIGRATION-DIGEST.md).

| # | Title | File | One-line summary | Date | Status | Evidence folder |
|---|---|---|---|---|---|---|
| 01 | What site generators and SPA frameworks emit, and what breaks under a SW-served, path-prefixed or iframe-hosted deployment | [`w2a-01-site-generator-output.md`](w2a-01-site-generator-output.md) | Most generators emit root-absolute URLs and client routers read `location.pathname`, so the `/_mw/s/<btih>/` prefix rendered only 3 of 9 default builds; four summary points only, the lab is complete. | 2026-10-17 | researched (interim draft) | [`labs/w2a-01-lab/`](labs/w2a-01-lab/) |
| 02 | Migrating CMS-driven sites (WordPress, Ghost, Drupal, Squarespace, Wix, Webflow) to static files plus client-side features | [`w2a-02-cms-export.md`](w2a-02-cms-export.md) | Migration works only where a static export exists (WordPress via Simply Static or Staatic, Ghost, Drupal Tome); WP2Static is dead; feature loss, URL hazards and re-export deltas. | 2026-10-17 | researched | [`labs/w2a-02-experiments/`](labs/w2a-02-experiments/) |
| 03 | Replacing server features with client-only or chain-backed equivalents: a catalogue | [`w2a-03-dynamic-feature-replacements.md`](w2a-03-dynamic-feature-replacements.md) | Dynamic features fall into four classes; comments and guestbooks fit the site ledger, counters, personal data and money do not; never put personal data on the ledger, even encrypted. | 2026-10-17 | researched | [`labs/w2a-03-experiments/`](labs/w2a-03-experiments/) |
| 04 | Drop-in embedded mode: precedents and constraints for injecting a P2P / Service Worker layer into an existing site | [`w2a-04-dropin-embedded-mode.md`](w2a-04-dropin-embedded-mode.md) | The v0.2 one-script-tag skeleton matches the strongest precedents; no reload is needed; a SW over every navigation is cheap on desktop; bfcache and `no-store` HTML are the sharp edges. | 2026-10-17 | researched | [`labs/w2a-04-experiment/`](labs/w2a-04-experiment/) |
| 05 | SEO, crawlers and link previews for a P2P-delivered site | [`w2a-05-seo-crawlers.md`](w2a-05-seo-crawlers.md) | Crawlers see only what the static origin serves over HTTP, so complete per-URL HTML on the host is mandatory and P2P can only be progressive enhancement; shell and hub modes are not indexable. | 2026-10-17 | researched (written against ARCH v0.1 names) | none (Appendix B inside) |
| 06 | Publishing automation: CI/CD that builds a site, makes the torrent, uploads the web seed and updates the DNS pointer | [`w2a-06-cicd-automation.md`](w2a-06-cicd-automation.md) | A pipeline order (upload before DNS, verify the public seed, sign, compare-and-swap the pointer, verify from outside), deterministic packing, DNS providers and signing-key custody. | 2026-10-17 | researched (read ARCH v0.1 §4) | [`labs/w2a-06-lab/`](labs/w2a-06-lab/) |
| 07 | Static hosting and web-seed providers compared: cost, CORS, Range, wildcard TLS, and how many bytes peers really save | [`w2a-07-hosting-cost-bandwidth.md`](w2a-07-hosting-cost-bandwidth.md) | A 24-host browser matrix: WebTorrent's headers, not `Range`, break most seeds; supersedes `w1-10`'s compressed-`Range` hazard for browsers; request count drives cost; peers save little on small sites. | 2026-10-17 | researched | [`labs/w2a-07-evidence/`](labs/w2a-07-evidence/) |
| 08 | Multi-page site UX inside the iframe shell: everything that behaves differently | none | Never researched (see [Gaps](#gaps)); raw runs with no write-up sit in `labs/w2a-08-lab/`. | - | missing | [`labs/w2a-08-lab/`](labs/w2a-08-lab/) (orphan) |
| 09 | Existing conventions to adopt: IPFS website rules, `_redirects`/`_headers`, Beaker/Dat, PWA and migration checklists | [`w2a-09-migration-checklists-and-conventions.md`](w2a-09-migration-checklists-and-conventions.md) | Adopt the `_redirects` and `_headers` file names with a Netlify-superset grammar, compiled at publish time into `/.mw/site.json`; the labs and recommendations were never written. | 2026-10-17 | researched (interim draft) | [`labs/w2a-09-lab/`](labs/w2a-09-lab/) |
| 10 | Large sites and media over WebTorrent: piece selection, streaming, partial loading, multi-torrent sites | [`w2a-10-large-sites-media.md`](w2a-10-large-sites-media.md) | Checkpoint findings: `critical()` reorders nothing, stream selections do, BEP 53 `so=` is a no-op, `deselect()` strands neighbours, and the auto piece-length table; the write-up was never finished. | 2026-10-17 | researched (interim draft) | [`labs/w2a-10-lab/`](labs/w2a-10-lab/) |
| 11 | Updating a torrent-addressed site: versioning, cache invalidation, delta reuse, rollback, channels | none | Never researched (see [Gaps](#gaps)). | - | missing | none |
| 12 | Loader shell quality bar: performance budgets, accessibility, PWA/installability, protocol handler UX | none | Never researched (see [Gaps](#gaps)). | - | missing | none |

## Wave 2b: production readiness (2026-10-17)

Infrastructure resilience, connectivity, observability, security hardening, abuse and legal operations, and
performance. Seven topics planned; six written; one missing. Digest: [`PRODUCTION-DIGEST.md`](PRODUCTION-DIGEST.md).

| # | Title | File | One-line summary | Date | Status | Evidence folder |
|---|---|---|---|---|---|---|
| 01 | WebSocket tracker resilience and self-hosting at production scale | [`w2b-01-tracker-resilience.md`](w2b-01-tracker-resilience.md) | The same four public trackers held (16/16 counted samples each) but DNS block lists block them; a reconnect shim, a count-aware announce policy and a hardened self-hosted tracker; corrects `02-wss-trackers.md` in five places. | 2026-10-17 | researched | [`labs/w2b-01-tracker-resilience-ref/`](labs/w2b-01-tracker-resilience-ref/) |
| 02 | Nostr relays and Blossom as commodity durable storage for ledger blocks and signaling | [`w2b-02-nostr-durability.md`](w2b-02-nostr-durability.md) | Relays and Blossom servers are usable only as an untrusted, lossy, replaceable cache for site-ledger durability, cold start and signaling; relay lists rot (38-58 % of old list entries still answer). | 2026-10-17 | researched | [`labs/w2b-02-probes/`](labs/w2b-02-probes/) |
| 03 | TURN and connectivity at scale: how many visitors fail P2P, and what to do | [`w2b-03-turn-connectivity.md`](w2b-03-turn-connectivity.md) | No rigorous recent relay-share data exists (plan for 10-30 % of pairs); failure belongs to the pair, not the visitor; TURN is an optimisation, never a correctness requirement. | 2026-10-17 | researched | [`labs/w2b-03-turn-connectivity-lab/`](labs/w2b-03-turn-connectivity-lab/) |
| 04 | Observability without a backend: diagnostics, canaries, opt-in telemetry | [`w2b-04-observability-no-backend.md`](w2b-04-observability-no-backend.md) | Split diagnosis by vantage point because browsers hide failure reasons from scripts: an in-page panel and debug bundle, Node canaries, and opt-in telemetry with zero servers or one Worker. | 2026-10-17 | verified | [`labs/w2b-04-probes/`](labs/w2b-04-probes/) |
| 04V | Skeptical fact-check of "Observability without a backend" | [`w2b-04-observability-no-backend-VERIFY.md`](w2b-04-observability-no-backend-VERIFY.md) | Re-checks 8 claims: 3 confirmed, 5 nuanced, 0 refuted; for example, page script sees every WebSocket failure as close code 1006, and a 16-bit mint over the v0.2 header takes 39-49 ms with 5 Workers. | 2026-10-17 | verified (the verification pass) | [`labs/w2b-04-verify-probes/`](labs/w2b-04-verify-probes/) |
| 05 | Production security hardening: loader integrity, owner keys, kill switch, Service Worker update safety | [`w2b-05-security-hardening-prod.md`](w2b-05-security-hardening-prod.md) | Loader self-attestation cannot be a runtime security boundary (use a signed release manifest and tooling); P-256 owner keys with hardware-backed signing paths; kill-switch and SW update safety; confirms the wire-length findings. | 2026-10-17 | researched | [`labs/w2b-05-probes/`](labs/w2b-05-probes/) |
| 06 | Abuse handling, legal and privacy operations for a P2P-distributed web | [`w2b-06-abuse-legal-ops.md`](w2b-06-abuse-legal-ops.md) | Liability attaches to services, not to hashes; Cox v. Sony narrowed US contributory liability; elsewhere the test is knowledge plus expeditious action; consent, notice-and-action and takedown drafts (not legal advice). | 2026-10-17 | verified | none |
| 06V | Skeptical re-check of eight design-critical claims (abuse, legal and privacy operations) | [`w2b-06-abuse-legal-ops-VERIFY.md`](w2b-06-abuse-legal-ops-VERIFY.md) | Re-checks 8 claims: 3 confirmed, 5 nuanced, 0 refuted; for example, Safe Browsing ignores private PSL entries, so a listing of a hub's parent domain covers every label. | 2026-10-17 | verified (the verification pass) | none |
| 07 | Performance engineering for WebTorrent-delivered small sites | none | Never researched (see [Gaps](#gaps)); unreviewed scripts and raw outputs sit in `labs/w2b-07-perf-lab/`. | - | missing | [`labs/w2b-07-perf-lab/`](labs/w2b-07-perf-lab/) (orphan) |

## Wave 2c: improvements with precedent (2026-10-17)

Complementary content layers, site-ledger production features, identity UX, hub operations, production-grade
testing, standards alignment and incentives. All seven topics written. Digest:
[`IMPROVEMENTS-DIGEST.md`](IMPROVEMENTS-DIGEST.md).

| # | Title | File | One-line summary | Date | Status | Evidence folder |
|---|---|---|---|---|---|---|
| 01 | Complementary content layers: IPFS/Helia, Blossom, Arweave, BitTorrent v2, and multi-source fetch | [`w2c-01-content-layer-alternatives.md`](w2c-01-content-layer-alternatives.md) | The best second content layer is more, better-behaved HTTP sources feeding WebTorrent's web-seed path, so fix the web seed first (request headers, ignored `Range`, wrong bytes). | 2026-10-17 | researched (a verify lab exists, but no VERIFY report was written) | [`labs/w2c-01-lab/`](labs/w2c-01-lab/), [`labs/w2c-01-verify-lab/`](labs/w2c-01-verify-lab/) |
| 02 | Chain / database production features: snapshots, compaction, queries, encryption, access control, GDPR deletion | [`w2c-02-chain-production-features.md`](w2c-02-chain-production-features.md) | Three compaction tiers, a hiding redaction commitment, redaction as an ordered op, and erasure that reaches only cooperating peers. | 2026-10-17 | verified | [`labs/w2c-02-lab/`](labs/w2c-02-lab/) |
| 02V | Skeptical fact-check of "Chain / database production features" | [`w2c-02-chain-production-features-VERIFY.md`](w2c-02-chain-production-features-VERIFY.md) | Result table of 8 claims: 2 confirmed, 6 nuanced, plus one side finding refuted (the y-indexeddb transaction is atomic); the detailed write-up stops after claim 7. | 2026-10-17 | verified (the verification pass) | [`labs/w2c-02-verify-lab/`](labs/w2c-02-verify-lab/) |
| 03 | Visitor identity UX: portability, passkeys, naming, moderation experience | [`w2c-03-identity-ux.md`](w2c-03-identity-ux.md) | "Non-extractable" protects a key against theft, not use; the v1 identity is a seed-derived key with a recovery phrase created at the first write; passkeys only as a v2 wrapper. | 2026-10-17 | verified | [`labs/w2c-03-identity-lab/`](labs/w2c-03-identity-lab/) |
| 03V | Skeptical verification of eight design-critical identity claims | [`w2c-03-identity-ux-VERIFY.md`](w2c-03-identity-ux-VERIFY.md) | Re-checks 8 claims: 4 confirmed, 4 nuanced, 0 refuted; a non-extractable key can even be structured-cloned to another origin. | 2026-10-17 | verified (the verification pass) | `labs/w2c-03-identity-lab/verify/` |
| 04 | Running a public hub / gateway: origin isolation, PSL, quotas, abuse, federation | [`w2c-04-hub-gateway-operations.md`](w2c-04-hub-gateway-operations.md) | Per-site origins and v0.2's 32-character labels are sound; the closest precedent (ipfs.io, dweb.link) retired on 2026-09-21; label enforcement, takedown that reaches installed visitors, abuse operations. | 2026-10-17 | researched | [`labs/w2c-04-hub-reference/`](labs/w2c-04-hub-reference/) |
| 05 | Testing and QA at production grade for a P2P web loader | [`w2c-05-testing-qa-production.md`](w2c-05-testing-qa-production.md) | Web-seed failure modes are the biggest untested risk; a hostile-peer wire harness; cross-engine and real-device testing; six additions to ARCH §12. | 2026-10-17 | researched | [`labs/w2c-05-testing-lab/`](labs/w2c-05-testing-lab/) |
| 06 | Standards alignment and existing ecosystem efforts (do not reinvent) | [`w2c-06-standards-and-ecosystem.md`](w2c-06-standards-and-ecosystem.md) | No standards body will define this for us; registering `_magnet` is cheap and not urgent; do not build on DNSLink; publish the pointer and ledger formats with test vectors. | 2026-10-17 | verified | none |
| 06V | Skeptical re-check of "Standards alignment and existing ecosystem efforts" | [`w2c-06-standards-and-ecosystem-VERIFY.md`](w2c-06-standards-and-ecosystem-VERIFY.md) | Re-checks 8 claims: 2 confirmed, 6 nuanced, 0 refuted; for example, the IANA underscored registry has 72 records and `_magnet` is still unregistered. | 2026-10-17 | verified (the verification pass) | none |
| 07 | Why would visitors seed? Incentives, fairness and realistic P2P offload | [`w2c-07-incentives-economics.md`](w2c-07-incentives-economics.md) | Visitors seed because of a default, a cause or enforcement, not rewards; tit-for-tat changes nothing at small scale; offload needs a crowd that small sites do not have. | 2026-10-17 | researched | [`labs/w2c-07-lab/`](labs/w2c-07-lab/) |

## Gaps

Five planned topics were never researched. No research file exists for any of them; the table says what was planned,
what exists instead, and where the gap is partly covered.

| Topic | Planned title | Planned scope (from the wave plan) | What exists | Partly covered by |
|---|---|---|---|---|
| w1-14 | Operational reality: PeerTube lessons, CDN-P2P hybrids, consent, costs | Why PeerTube moved from WebTorrent to HLS plus P2P Media Loader; CDN-P2P hybrid products and their offload ratios; the "last visitor leaves" durability problem; consent and disclosure norms for visitor uploads and IP exposure (GDPR, ePrivacy, CCPA) and regulator cases; mobile data costs; Little's-law sizing; the power and data cost of idle WebRTC on phones | Nothing | `w1-07` F21 (PeerTube), `w1-11` §D (legal), `w1-10` §J (costs); later `w2b-06` and its VERIFY, `w2a-07`, `w2c-07`; `RESEARCH-DIGEST.md` §5.5 and §6.5 |
| w2a-08 | Multi-page site UX inside the iframe shell: everything that behaves differently | Deep links and back/forward, scroll restoration, `target=_top`/`_blank`, forms, downloads, print, Web Share, hash routing, 404 pages, storage inside the frame, `window.open`, fullscreen and permissions policy, focus and screen readers across the frame boundary, mobile viewport quirks, `beforeunload`; exact iframe attributes | `labs/w2a-08-lab/`: raw Chromium and WebKit runs (history mirroring, sandbox tokens, external links) with no write-up and no review | ARCH v0.2 §3.1, §7.2; `MIGRATION-DIGEST.md` "Missing topics: what the architecture already decided" (lists what is decided and what is not covered) |
| w2a-11 | Updating a torrent-addressed site: versioning, cache invalidation, delta reuse, rollback, channels | Content-addressed immutability against DNS TXT mutability (TTL, DoH caching), update detection and UX, delta reuse between versions (piece alignment, BEP 47, v2 per-file roots), rollback by re-pointing, channels, staged rollouts, atomic publish order, garbage collection, IPNS/DNSLink precedents | Nothing | ARCH v0.2 §3.4.5, §4, §5.8, §7.1; `w2a-06` (rollback as roll-forward, channels as hostnames); `w2a-02` F22 (piece reuse); `MIGRATION-DIGEST.md` "Missing topics" |
| w2a-12 | Loader shell quality bar: performance budgets, accessibility, PWA/installability, protocol handler UX | Core Web Vitals when content arrives via P2P and a SW, a shell performance budget, Save-Data, accessibility of the status bar and the iframe, 2026 installability criteria, iOS Add to Home Screen, `protocol_handlers` UX, i18n, error-state copy; a checklist with pass criteria | Nothing | ARCH v0.2 §5.1, §5.4, §5.10, §7.4, §8, §10; `w2a-05` F46-F49 (loader budget); `w2a-04` F9, F24 (SW and client costs); `MIGRATION-DIGEST.md` "Missing topics" |
| w2b-07 | Performance engineering for WebTorrent-delivered small sites | Measured browser throughput and setup latency (announce to first peer to first piece), piece length for small sites, `RTCPeerConnection` cost on mobile, rendering before completion, bundle size targets, SHA-1 and IndexedDB costs on mobile; a tuning table and an honest latency model | `labs/w2b-07-perf-lab/`: unreviewed scripts and raw outputs (a cold P2P timeline, bundle evaluation cost, ICE gathering, IndexedDB, `RTCPeerConnection` cost, SHA-1 throughput, a bundle size breakdown) | `PRODUCTION-DIGEST.md` §11 (a placeholder latency model and the list of what to measure) |

## Other known limits

These are not missing topics, but they limit how far the research can be trusted.

- **Drafts never finalised:** `w1-13-toolchain.md` (checkpoint), `w2a-01-site-generator-output.md` (four summary
  points; its lab is complete), `w2a-09-migration-checklists-and-conventions.md` (no labs or recommendations),
  `w2a-10-large-sites-media.md` (checkpoint; the raw memory runs in `labs/w2a-10-lab/` have no write-up).
- **Verification never ran** for 01-06 (planned for the wave-1 completion run), w1-08, w1-10 to w1-13, every wave-2a
  file, w2b-01, w2b-02, w2b-03, w2b-05, w2c-01, w2c-04, w2c-05 and w2c-07. Some 01-06 claims were re-tested indirectly
  by later VERIFY files (`RESEARCH-DIGEST.md` §4.3). `w2c-02-chain-production-features-VERIFY.md` covers 8 claims in its
  result table but its detailed write-up stops after claim 7.
- **Superseded or corrected findings:** `w1-10` F12 (compressed `Range`) for browsers, by `w2a-07` F1; `w1-08`'s hard
  "refuse below" floor, by `RESEARCH-DIGEST.md` §4.1 row 27; `02-wss-trackers.md` F13 and F17, by `w2b-01`; and the
  others listed in `RESEARCH-DIGEST.md` §4.3.
- **Written against ARCHITECTURE v0.1:** `w2a-05` (old names such as `--embed` and `/_mw/boot.js`) and `w2a-06` (the
  v0.1 pointer grammar); v0.2 wins where they differ.
- **Orphan evidence folders** (no matching report): `labs/w2a-08-lab/`, `labs/w2b-07-perf-lab/`, `labs/w2c-01-verify-lab/`.
- **Shared evidence limits:** no real phone was used; Firefox never ran (Playwright Firefox would not start on this
  Mac); "WebKit" means Playwright's WebKit 27.2 build, which gathers no ICE candidates here; all WebRTC timings are
  loopback; the shared web-search budget ran out in every 2026-10-17 session; nothing in this folder was reviewed by
  counsel and none of it is legal advice.
- **Re-running the labs:** several harnesses predate `docs/DEV-NETWORK.md` and launch browsers or contact public
  endpoints. Any re-run must follow that policy: Chromium only through `chromiumArgs()` from
  `test/e2e/browser-args.mjs`, WebKit only on `http://127.0.0.1` URLs, and remote probes only from the Node tools.
