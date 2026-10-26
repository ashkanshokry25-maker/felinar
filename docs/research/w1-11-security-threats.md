# w1-11 - Security threat model for a torrent-loaded, multi-site, peer-backed web

Research date: **2026-10-17** (every "today" below). Topic owner: wave 1, topic 11. Builds on, and does not replace:
`docs/review/security.md` (B1-B4, M1-M10), `04-service-worker-serving.md` (F5, F11, F20), `03-webrtc-nat-privacy.md` (F-15..F-17, F-25, F-26),
`05-doh-dns-txt.md` (F5, F13), `01-webtorrent-browser.md` (F9), `02-wss-trackers.md` (F23), `06-browser-chain-vs-crdt.md` (3.1.9).
Where this file disagrees with an earlier one it says **CORRECTS** (list in section 7). The reference point for "what the spec already says" is `docs/ARCHITECTURE.md` **v0.2 (2026-10-17, normative)** and `docs/review/DESIGN-REVIEW.md`, which appeared while this research ran and already adopted most of the earlier security review; section 4.1 states what this research confirms, corrects and adds relative to them.

Evidence labels used on every finding:
- **[S]** primary source read this session (URL and source date in Appendix A);
- **[X]** executed here: local experiments, code in `docs/research/labs/w1-11-opaque-frame-lab/` (reproducible, results saved there);
- **[C]** project or dependency source code read (file and line cited);
- **[R]** taken from an earlier research file of this repo and not re-verified here;
- **[I]** inference or arithmetic derived from the above (stated as such).

Confidence: **High** = primary source or executed test, cross-checked; **Medium** = one primary source or code reading only; **Low** = single secondary source or inference.
"design_critical" = if the claim were wrong the architecture, the pointer grammar or a compatibility promise would change.

Not legal advice. Legal material below is a research summary of public sources for the engineers; the owner should have counsel review the consent and takedown design for the jurisdictions in which sites will be served.

---

## 1. Summary

1. **The origin is the only isolation boundary, and the code still carries a v0.1 "hub mode" that pretends otherwise.** Sandbox flags cannot isolate service-worker-served content: an attribute-sandboxed `sandbox="allow-scripts"` frame gets **zero** fetch events and is not a SW client; a CSP-header sandbox lets the SW answer the navigation but the page is uncontrolled; and `allow-scripts allow-same-origin` on same-origin content is, per MDN, "no more secure than not using the `sandbox` attribute at all". The proven pattern is **one origin per site plus a Public Suffix List wildcard entry** (IPFS: `*.dweb.link`, `*.inbrowser.link`, `*.inbrowser.dev`; also `*.eth.limo`, `ipfs.w3s.link`; the IPFS spec warns that without it "a single problematic CID could trigger widespread blocking of the entire gateway by software like Safe Browsing"). ARCH v0.2 already drops the isolation claim (shared-origin hub = demo only, subdomain hubs for production), but `src/` was last modified on 2026-10-14 and `src/loader/render.js` (`SANDBOX_HUB`) and `src/sw/sw.js` (`HUB_CSP`) still carry `allow-scripts allow-same-origin`. (F1-F4, F6)
2. **A no-wildcard "isolated preview" is possible but narrow.** Executed in Chromium 156: an opaque-origin frame fed by `srcdoc` and bytes over a MessageChannel, with the frame creating its **own** `blob:` URLs, loads CSS, images, classic scripts and single-file ES modules while staying isolated (`origin "null"`, localStorage/IndexedDB/cookies/`navigator.serviceWorker` all `SecurityError`). Parent-created `blob:` URLs do **not** load in it; relative `fetch()` goes to the network with `Origin: null`; relative imports and link navigation break. Use it only as an explicit "untrusted preview" fallback. (F5)
3. **The wire parser has no message-length cap and buffers quadratically.** `bittorrent-protocol@5.0.9` (identical to upstream master and to the npm `latest` published 2026-07-27) accepts any length prefix; because `getUint32` is signed, the worst case that actually buffers is `0x7FFFFFFF` (2 GiB-1), not 4 GiB (**CORRECTS** review B4's number, not its conclusion). Measured: after a `0x7FFFFFFF` prefix, 16 KiB chunks took 2.6 s per 2000 chunks at 31 MiB buffered and 57 s per 2000 at 188 MiB, with process RSS up to 8,212 MiB (about 8.0 GiB). libtorrent defaults to a 2 MiB receive buffer; Bitcoin Core caps messages at 4 MB. No upstream issue or advisory exists. ARCH v0.2 item 10 already specifies a 256 KiB per-wire wrap; the code does not have it yet, and its test ("a peer declaring 4 GiB") exercises a prefix the unpatched parser does not even buffer, so the test and the guard need the fixes in R1. (F11, F12)
4. **Peer abuse beyond length:** webtorrent 3.0.21 caps only block length (128 KiB) on `request`, has no request-queue cap, no peer attribution for failed pieces (libtorrent ships a smart-ban plugin), and ignores `maxConns` for incoming connections (issue #703, open since 2016). (F13)
5. **SHA-1:** a chosen-prefix collision is now an order-of-$10k computation (SHA-mbles forecast "<10k USD by 2025", re-derived in 2025 at under $10k for two RTX 5090s), while preimage/second-preimage resistance is unbroken. A third party still cannot substitute content for a given infohash; **anyone who contributes bytes to a published torrent can prepare a bait-and-switch pair**. NIST retires SHA-1 by 2030-12-31. webtorrent has **no BEP 52** (issue #1117 open since 2017-04-26, no PR); libtorrent handles v2/hybrid torrents, and libtorrent 2.1.0 (2026-07-07) enables WebTorrent by default with the maintainers' warning that it "significantly widens the attack surface". Fix: bind the SHA-256 list that v0.2 already writes (`/.mw/files.json`, today used only for cross-version reuse) to the signed pointer with `fj=` and verify files against it (R10). (F7-F10) *design_critical*
6. **Privacy/legal:** IP addresses are online identifiers (GDPR Recital 30; Breyer C-582/14 for dynamic IPs); uploading pieces is "making available to the public" even if the pieces are unusable alone (Mircom C-597/19), a conclusion the Court tied to a user who subscribed to the client "after having duly been informed" and acts "in full knowledge of the consequences"; EDPB Guidelines 2/2023 (2024-10-16) say ePrivacy Art. 5(3) reaches an entity that instructs a device (through a protocol or SDK) to send IP or session identifiers. Therefore: **informed, opt-in seeding, shown before the first tracker announce**, a takedown/denylist path, and no auto-load of arbitrary magnets. (F16-F21) *design_critical*
7. **Chain-level threats have precedents to copy:** key rotation (TUF: threshold of old keys AND of new keys; did:plc: priority-ordered rotation keys plus a 72 h recovery window; KERI: pre-committed next-key digest), time (Bitcoin `MAX_FUTURE_BLOCK_TIME` 2 h; Nostr NIP-11 `created_at_lower_limit/upper_limit`), replay (EIP-155 chain id in the signed hash), spam (Nostr NIP-13 committed target difficulty; NIP-11 advertised limits; GossipSub v1.1 peer scoring), redaction (Matrix: signatures and event IDs over the redacted form, content hash kept; Fabric: hash on ledger, data purgeable; CT label redaction: never standardised). **EDPB Guidelines 02/2025 v2 (2026-07-07): a salted or keyed hash of personal data is still personal data and an unsalted hash is not sufficient**, so the v0.2 redaction commitment `vh` (unsalted) needs a secret per-block salt; the public Hashcash `nonce` cannot serve. v0.2's `rot=` is signed by the routine owner key alone, which the same precedents avoid. (F22-F30) *design_critical*
8. **Pointer/DoH:** `AD` from a DoH resolver is only meaningful over a secure channel to a trusted resolver (RFC 4035 4.6/4.9.3), so the resolver stays a trust root; the defence is the owner signature plus pin plus cross-channel consistency (meta vs DNS vs cache disagreement = hard stop, not "first valid wins"). The DoH lookup sends every visitor's IP and the site name to a third party outside the consent gate. Unsigned `ws=`/`xs=`/`tr=` values are a request primitive against third parties: in Chromium 156 and WebKit 27.2 a cross-origin fetch with a simple `Range` header is sent without preflight, but webtorrent's own `Cache-Control` header forces one. (F31-F33)
9. **Nothing browser-native protects a SW-hosted loader in 2026:** WAICT is a prototype behind a Firefox Nightly pref (Mozilla, 2026-05-05) and "very early" (Cloudflare, 2025-10-16); signature-based SRI (`integrity="ed25519-..."`) is Chrome 141 only and needs `Unencoded-Digest`/`Signature` response headers; Isolated Web Apps are limited to Chrome Enterprise-managed ChromeOS (docs updated 2026-02-06); Meta Code Verify and WEBCAT are extensions (WEBCAT alpha). `serviceWorker.register()` and `new Worker()` have no `integrity` option. The static host stays the trust root. `npm audit --omit=dev`: 4 high, all via `ip@2.0.1` (absent from the browser bundle); 6 of 251 locked packages run install scripts. (F34-F37) *design_critical*
10. **Same-origin XSS means loader privilege.** In per-domain mode the site's code is the loader's origin; the bridge is an API, not a boundary. v0.2's site-callable SDK includes `identity.export`, `identity.import` and `consent.accept`, so any script in the page can wrap out the visitor's key or grant consent; move those into loader-owned UI. Keep per-site keys, confirm-to-sign UI gated on `isTrusted`, and optionally a WebAuthn-PRF-wrapped key. (F38-F39)

Bottom line: the P0 list in section 4 is short. It makes the wire guard correct and testable (R1), removes the leftover v0.1 hub flags (R2), makes the PSL entry and a separate site domain a launch condition for multi-publisher hubs (R3), and fixes two interface decisions **before** `block.js` and the SDK freeze: a salted redaction commitment (R4) and a site-callable SDK without key export or consent grant (R5), plus hub abuse operations (R7). Most other items in the earlier review are already in v0.2 and only need to be implemented as written.

### Coverage of the assigned questions

| Question in the assignment | Where |
|---|---|
| Same-origin risk of many untrusted sites on one origin; IPFS subdomain gateways; PSL entries | F1, F3, F4, T1; R2, R3 |
| Sandbox flags; can an opaque-origin iframe be served by the parent origin's SW (spec, Chromium) | F2, F5 (experiments), F6; gotchas 3-5 |
| SHA-1 collision vs second preimage in 2026 and consequences | F7, F8, F10; R10 |
| BEP 52 in webtorrent 3.x and other browser clients | F9 |
| bittorrent-protocol message-length limits; CVEs for length-prefix exhaustion | F11, F12 (no CVE survey possible, open question 5); R1 |
| Poisoned pieces, tracker spoofing, IP exposure, GDPR, WebRTC leak behind VPNs, IP-handling policies | F13, F15, F16, F18, F19; R8, R9, R6, R23 |
| DoS by gossip floods and oversized DataChannel messages | F11, F13, F14, F22, F23; R1, R8, R17 |
| Chain threats: Sybil/spam, replay, time, key compromise, rotation, multi-sig | F22-F27; R11, R12, R17, R18, R27 |
| DoH resolver as pointer MITM and mitigations | F31, F32, F33; R6, R13, R26 |
| Supply chain: SRI, immutable files, signed manifest, Code Verify / WAICT / IWA | F34-F37; R15, R16, R28 |
| Legal exposure of seeding visitors and opt-in norms | F16-F21; R6, R7, R24 |
| XSS inside a loaded site hitting the SDK bridge | F38, F39; R5 |
| Commitment-based redaction and precedents | F28-F30; R4 |
| Prioritised mitigation list | section 4 |

---

## 2. Threat model

### 2.1 Assets
A1 integrity of code executing at a domain's origin (site files, loader, SW). A2 the owner root key (signs pointers and policy). A3 the visitor identity key and local data in IndexedDB. A4 the visitor's network identity (IP, and the infohash = which site they read). A5 availability of the site and of gossip. A6 integrity and moderation authority of the chain. A7 reputation of the loader domain (Safe Browsing, DNS blocklists, ad blockers). A8 legal position of owners, hub operators and visitors.

### 2.2 Adversaries
Adv1 malicious peer (any WebRTC peer; Sybil). Adv2 malicious third-party operator (tracker, STUN, DoH resolver, web seed host). Adv3 on-path or DNS attacker. Adv4 malicious publisher or contributor (hub mode, or bytes inside someone else's torrent). Adv5 compromised static host, CDN or DNS account. Adv6 compromised owner key. Adv7 XSS in an otherwise legitimate site. Adv8 supply-chain attacker (npm, build machine). Adv9 right-holder or enforcer monitoring swarms. Adv10 regulator or abuse reporter.

### 2.3 Trust boundaries (what is the same security principal)

```
                       static host / CDN  (trust root for shell + SW on every load, F34)
                              |
   +--------------------------v-------------------------------------------------+
   | Origin O  (e.g. https://example.com, or https://<label>.hub.example)         |
   |   shell + loader.js + sw.js + IndexedDB(O) + CryptoKeys + chain node         |
   |   +-------------------------------+                                          |
   |   | site iframe, SAME origin O    |  <- site code == loader privilege (F1,F38)|
   |   +-------------------------------+                                          |
   +--------------------------^-------------------------------------------------+
        outside the origin:   |  WebRTC peers (hostile by default, F11-F15)
        tracker (signalling MITM possible, F15) | STUN | DoH resolver (F31) | web seed
        DNS TXT _magnet.<host> (unsigned channel; owner signature is the authority, F32)
```

### 2.4 Threat catalogue (T-ids are referenced from sections 3 and 4)

| ID | Threat | Adv | Findings | Where it bites today | Mitigation (short) | Pri |
|---|---|---|---|---|---|---|
| T1 | Many publishers on one origin read and poison each other's cache, chain, identity, pins | 4 | F1-F5 | `render.js` SANDBOX_HUB, `sw.js` HUB_CSP | per-site origin + PSL; else single-publisher only | P0 |
| T2 | Drive-by load of attacker site from `#magnet:`/protocol handler | 4 | F1, F21 | spec fixed (ARCH 3.3), code pending | explicit user action, interstitial, no auto-load | P0 |
| T3 | Wire length prefix exhausts CPU and memory | 1 | F11-F12 | `torrent.js` (no guard) | cap before buffering; upstream PR | P0 |
| T4 | Request flood from an unchoked peer; incoming-connection flood | 1 | F13 | webtorrent 3.0.21 | per-wire caps; cap incoming wires | P1 |
| T5 | Poisoned pieces waste bandwidth, no blame | 1 | F13 | webtorrent 3.0.21 | attribute and ban; web-seed fallback | P1 |
| T6 | Gossip flood, invalid blocks, orphan flood, HELLO bloat | 1 | F14, F22-F23 | ARCH v0.2 6.3, 6.6 (budgets specified) | three-valued validation, advertised limits, per-IP caps | P1 |
| T7 | Chain spam with free identities and cheap PoW | 1 | F22-F23 | ARCH 6.1 | global open-writer budgets; surcharge for new authors | P1 |
| T8 | Policy bypass via shallow `prev` (review B2) | 1 | review | fixed in ARCH v0.2 6.5 (`controlFor`), code pending | keep the shuffle test | P1 |
| T9 | Cross-chain or cross-protocol signature replay | 1,4 | F24 | ARCH 4, 6.1 | domain-separated signing inputs | P1 |
| T10 | Timestamp games | 1 | F25 | ARCH v0.2 6.1, 6.4 (ts rounded, not in ordering) | keep ordering ts-free; admission window only | P2 |
| T11 | Owner key compromise or loss | 6 | F26-F27 | ARCH v0.2 4 (`rot` by routine key), 6.2 | pre-rotation `nk`, scope in `rot`, offline next key | P1 |
| T12 | Pointer rollback/freeze/replay | 3,5 | F31-F32 | ARCH 4 | mandatory `exp`, `seq` per scope | P1 |
| T13 | DoH/DNS pointer substitution | 2,3 | F31-F32 | ARCH 4 source 3 | signature, pin, cross-channel check | P1 |
| T14 | Unsigned `ws=`/`tr=` used as request primitive | 4 | F33 | ARCH 4 | signed-only, probe first | P3 |
| T15 | Malicious tracker MITMs DTLS via SDP | 2 | F15 | all tracker use | integrity from hashes/signatures; do not claim confidentiality | P3 |
| T16 | SHA-1 bait-and-switch by a contributor | 4 | F7-F10 | `files.json` SHA-256 exists but unanchored | bind `files.json` hash to the signed pointer (`fj`), verify files | P1 |
| T17 | IP and interest exposure; swarm enumeration | 9 | F16-F19 | ARCH v0.2 8 gates peers and trackers but not the DoH lookup; code still starts downloading after showing the notice | consent before peers, trackers and DoH; relay mode; host-only | P1 |
| T18 | Illegal or infringing content seeded by visitors | 4,9,10 | F17, F20, F21 | hub-by-magnet | gating, denylist, takedown | P0 |
| T19 | Loader/SW supply chain (host, npm) | 5,8 | F34-F36 | `package.json`, build | ignore-scripts, hash-pin, signed manifest | P1 |
| T20 | Malicious SW persists | 5 | F37 | SW update model | kill switch, short `exp`, revocation list | P2 |
| T21 | XSS in site abuses SDK/identity | 7 | F38-F39 | `bridge.js` | per-site keys, confirm-to-sign, CSP | P1 |
| T22 | Redaction and erasure obligations | 10 | F28-F30 | ARCH 6.1 (`vh` unsalted) | salted commitment (R4), tombstone semantics | P0 (design) |
| T23 | Shared-domain reputation blast radius | 5,10 | F3-F4 | hub domain | PSL, separate registrable domains, abuse page | P1 |
| T24 | IndexedDB poisoning, path tricks in torrent | 4,7 | review M4 | `cache.js` | verify cache vs pointer; path validator | P1 |

---

## 3. Findings

Format: **Fn. claim.** Confidence / design_critical. Evidence. Sources (dates).

### A. Origin isolation, sandbox flags, service workers, Public Suffix List

**F1. Content served by the loader's SW and framed with `allow-same-origin` runs with the loader origin's full privileges; sandbox flags do not change that.** Confidence **High**. design_critical: **yes**.
- MDN: "When the embedded document has the same origin as the embedding page, it is **strongly discouraged** to use both `allow-scripts` and `allow-same-origin`, as that lets the embedded document remove the `sandbox` attribute, making it no more secure than not using the `sandbox` attribute at all." [S]. Without `allow-same-origin` the resource gets "a special origin that always fails the same-origin policy".
- Consequence for hub mode [I]: every site shares IndexedDB (`mw-sites`, chains, identity, pins), Cache Storage, the SW registration, cookies and localStorage; one site can read or poison the others (review B1/M4).
- Repo today [C]: `src/loader/render.js` line 10 `SANDBOX_HUB = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation'`; `src/sw/sw.js` line 25 `HUB_CSP = 'sandbox allow-scripts allow-forms allow-same-origin allow-popups allow-modals'`; ARCH v0.1 3/7/13 said hub mode used a "stricter iframe sandbox"; v0.2 removed that (3.3, DESIGN-REVIEW 6) but the code was not updated.
- Sources: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe (undated, fetched 2026-10-17); repo files read 2026-10-17; `docs/review/security.md` B1.

**F2. A sandboxed frame without `allow-same-origin` cannot be controlled by the parent origin's service worker; with the attribute even the navigation bypasses the SW, with the CSP header the SW only serves the main document.** Confidence **High**. design_critical: **yes**.
- Spec (Service Workers Editor's Draft, 17 September 2026, section 2.5.1 note): "Sandboxed iframes without the sandboxing directives, allow-same-origin and allow-scripts, result in having the active service worker value of null as their origin is an opaque origin." [S]
- WPT `service-workers/service-worker/sandboxed-iframe-fetch-event.https.html` (master, read 2026-10-17) asserts: normal iframe controlled; `<iframe sandbox="allow-scripts">` -> `data.requests.length == 0` and not a client; `sandbox="allow-scripts allow-same-origin"` -> request seen and controlled; response header `Content-Security-Policy: allow-scripts` (sic, the test's sandbox param) -> `requests.length == 1` ("Service worker should provide the response") but "should NOT control the sandboxed page"; header with `allow-same-origin` -> controlled. [S]

| Frame | SW sees the navigation request | SW controls the document |
|---|---|---|
| plain `<iframe>` | yes | yes |
| `sandbox="allow-scripts"` (attribute) | **no** (0 fetch events) | no |
| `sandbox="allow-scripts allow-same-origin"` | yes | yes (and no isolation, F1) |
| CSP header `sandbox allow-scripts` | yes (SW can answer) | **no** (subresources go to the network) |
| CSP header `sandbox allow-scripts allow-same-origin` | yes | yes |

- Engine results: wpt.fyi stable runs of 2026-10-13/14: Chrome 155.0.8059.79, Safari 27.0, Firefox 158.0 all 29/29 [R, `04` F11]. The SW-interception matrix itself was executed in Chromium 156 by `04` [R]; experiments A and B below only confirm that an opaque-origin frame has no `navigator.serviceWorker` and no access to the parent's storage [X].
- Chromium source: `content/browser/service_worker/service_worker_main_resource_loader_interceptor.cc` (main, read 2026-10-17) contains no sandbox-specific logic (only a "no service worker for the storage key" fast path), so the behaviour comes from the document's storage key (opaque origin gets a nonce key) [I]. In the attribute case the key is known before the request; in the header case the response (and its sandbox flags) arrives after the SW already intercepted [I, matches the WPT split].
- `navigator.serviceWorker` inside an opaque-origin frame throws `SecurityError` [X: experiments A and B]. Prior art: w3c/ServiceWorker #1437 (VS Code asked for SW in opaque origins; open since 2019; vendor answer: use wildcard subdomains) [R].
- Sources: https://w3c.github.io/ServiceWorker/ (ED 2026-09-17); https://raw.githubusercontent.com/web-platform-tests/wpt/master/service-workers/service-worker/sandboxed-iframe-fetch-event.https.html (fetched 2026-10-17); https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/service_worker/service_worker_main_resource_loader_interceptor.cc (fetched 2026-10-17).

**F3. One origin per site, with a wildcard Public Suffix List entry for the host domain, is the established pattern for serving untrusted content from a gateway.** Confidence **High**. design_critical: **yes**.
- IPFS Subdomain Gateway spec (dated 3 April 2025): "operators SHOULD register a wildcard entry like `*.example.net` with the Public Suffix List (PSL)", "treating each identifier (e.g., `cid.ipfs.example.net`) as a distinct top-level Origin"; "Wildcard TLS certificates SHOULD be set for `*.ipfs.example.net` and `*.ipns.example.net`". [S]
- PSL private section (list `VERSION: 2026-10-16_23-32-13_UTC`, read and grepped 2026-10-17) [X]: `*.dweb.link`, `*.inbrowser.link`, `*.inbrowser.dev` (IPFS Project, submitted by Interplanetary Shipyard); `ipfs.w3s.link`, `ipfs.storacha.link` (Storacha); `ipfs.nftstorage.link`; `*.eth.limo`; `cf-ipfs.com`, `cloudflare-ipfs.com` (Cloudflare). Static-hosting defaults are listed too: `github.io`, `githubusercontent.com`, `pages.dev`, `workers.dev`, `vercel.app`, `netlify.app`, `web.app`, `firebaseapp.com`, `cloudfront.net`, `s3.amazonaws.com`, which is why each project on those platforms is its own site while a custom apex with wildcard subdomains is not.
- IPFS public gateways `ipfs.io` and `dweb.link` began redirecting browser users to `inbrowser.link` (a Service Worker gateway; the post says it is on the PSL like `dweb.link` and gives each CID its own subdomain/origin) on **2026-05-11**; the post says additional rate limits will be rolled out on the legacy gateways during the year [S]. The SW gateway v3.0.0 (2026-02-05) removed path-gateway mode: "Path-only gateways do not provide Origin isolation" [R, `04` F5].
- Why the PSL matters: a "site" is scheme + eTLD+1; subdomains of one registrable domain are same-site but cross-origin (web.dev); Chromium Site Isolation defines a site as "the scheme and registered domain name, including the public suffix, but ignoring subdomains, port, or path" and says "This allows multiple origins within a site to share the same process" [S]. So `a.hub.example` and `b.hub.example` are same-site (SameSite cookies, `Sec-Fetch-Site: same-site`, possibly one renderer process); a wildcard PSL entry makes each label its own site [I from the definitions].
- PSL submission constraints [S, publicsuffix list wiki Guidelines]: a `_psl` TXT record pointing at the PR, which must stay in place; domain registered with more than 2 years left; submitter must represent the domain owner; entries meant only to dodge third-party rate limits are refused; changes "may take time to percolate to clients" and "there is no way to expedite". Time to reach Chromium/Firefox/Safari stable is **unknown/unverified**.
- Sources: https://specs.ipfs.tech/http-gateways/subdomain-gateway/ (2025-04-03); https://ipshipyard.com/blog/2026-ipfs-gateways-redirect-inbrowser-link/ (2026-05-11); https://publicsuffix.org/list/public_suffix_list.dat (2026-10-16 build); https://github.com/publicsuffix/list/wiki/Guidelines (undated); https://web.dev/articles/same-site-same-origin (undated); https://www.chromium.org/Home/chromium-security/site-isolation/ (undated).

**F4. A shared loader domain concentrates reputation risk: one reported site can get the whole host flagged.** Confidence **Medium** (spec statement, one project's issue; Safe Browsing's granularity was not independently verified). design_critical: no.
- IPFS spec: without PSL separation "a single problematic CID could trigger widespread blocking of the entire gateway by software like Safe Browsing" [S]. The SW gateway's tracker records "inbrowser.tld being blocked (#78)" and a BadBits denylist enforced at the edge for subdomains since v3.5.0 [R, `04` F6 items 7-8].
- Per-domain mode (each owner on its own domain) already isolates reputation; only hubs concentrate it.
- Sources: IPFS spec above; `04-service-worker-serving.md` F6.

**F5. Executed: an opaque-origin frame fed by `srcdoc` plus bytes pushed over a MessageChannel is strongly isolated and can render simple multi-file sites, but only if the frame builds its own `blob:` URLs; it cannot give relative fetch, deep links or a SW.** Confidence **High** for Chromium 156.0.8078.4 (Playwright build, macOS arm64, headless); **not tested** in Firefox or Safari (Firefox failed to launch here). design_critical: **yes** (decides whether a no-wildcard isolated hub mode exists).

| Probe inside `sandbox="allow-scripts"` `srcdoc` frame | Result |
|---|---|
| `location.origin` / `location.href` | `"null"` / `about:srcdoc` (base URI = parent's) |
| `parent.document`, `localStorage`, `document.cookie`, `indexedDB.open`, `navigator.serviceWorker` | all `SecurityError` |
| message to parent | parent sees `event.origin === "null"` and `event.source === iframe.contentWindow` |
| `<script src>`, `<link href>`, `<img src>`, `fetch()` of a `blob:` URL **created by the parent** | all fail: script never ran, CSS not applied (`rgb(0,0,0)`), image `naturalWidth` 0, fetch `TypeError` |
| same resources, but bytes sent by `postMessage` and `blob:` URLs created **inside the frame** (experiment B) | CSS applied (`rgb(1,2,3)`), image decoded (width 1), classic script ran, `import()` of a single-file module returned `x = 42`, `fetch(ownBlob)` ok |
| module blob containing `import "./sibling.js"` | `TypeError` (no base to resolve against) |
| relative `fetch('/data.json')` | network request with `Origin: null`, `Sec-Fetch-Site: cross-site`; `TypeError` (CORS) unless the server answers with `Access-Control-Allow-Origin` (the `-cors` variant returned its JSON) |
| click on `<a href="about.html">` | the frame navigated over the network to `http://host/about.html` (`Sec-Fetch-Dest: iframe`, cross-site); on a static host that URL returns the SPA shell, so the loader would boot inside the frame |

- Why parent-created blob URLs fail is not established here; blob-URL partitioning by storage key (opaque origin = nonce key) is the likely reason [I].
- Verdict [I]: an "isolated preview" mode is feasible for small static sites (single page or few files, classic scripts, no module graph, no relative fetch) with a bootstrap shim (virtual file system, patched `fetch`/XHR, link interception, import map or rewriting). It is **not** a substitute for per-site origins: no SW, no real deep links, no module graphs, a large shim surface.
- Lab files: `docs/research/labs/w1-11-opaque-frame-lab/exp-a-parent-blob-urls.mjs`, `exp-b-frame-builds-own-blobs.mjs`, `results-chromium-156-2026-10-17.txt` (re-run twice, same results).

**F6. Repo state at the time of writing (what the review items look like in code).** Confidence **High** [C]. Review B1 (hub isolation), B4 (wire cap) and M5 (frame-ancestors) are specified in v0.2 but **not yet applied in code**: no `frame-ancestors`, `X-Frame-Options` or wire-length guard anywhere under `src/`. Positive: `src/loader/bridge.js` lines 201-202 check both `ev.source !== this.iframe.contentWindow` and `ev.origin !== this.origin`; the shell CSP is a `<meta>` (cannot carry `frame-ancestors`, review M5).

### B. Content integrity: SHA-1, collisions, BitTorrent v2

**F7. SHA-1 collision cost is now roughly an order of $10k; preimage and second-preimage resistance are not broken.** Confidence **High** for the cited numbers; **Medium** for "nothing newer" (2025-2026 cryptanalysis literature was not searched; search quota). design_critical: no (feeds F8).

| Item | Value | Source (date) |
|---|---|---|
| Identical-prefix collision | 2^61.2 SHA-1 evaluations; "just about 11k USD" | sha-mbles.github.io (2020, OLD) |
| Chosen-prefix collision | 2^63.4; "about 75k USD" for the 2019 run (about two months on 900 GTX 1060); about 45k USD at 2020 prices; "should cost less than 10k USD ... by 2025" | sha-mbles.github.io; eprint 2020/014 (2020, OLD) |
| 2025 re-estimate | 2 x RTX 5090 at $1999 plus about $5,065 electricity => "less than $10,000"; the post's "413 days" does not match its own arithmetic (about 1,021 days from its figures), so treat as order of magnitude | docs.drand.love blog (2025-01-31) |
| Preimage | "remains unbroken as of today" | sha-mbles.github.io (2020, OLD) |
| Second preimage | "There are no known pre-image or second pre-image attacks that are specific to the full round SHA-1 algorithm" (section 3.2) | RFC 6194 (March 2011, OLD) |
| Standards position | "phased out by Dec. 31, 2030" | NIST news (2022-12-15) |
| Ecosystem | Git moved to a hardened SHA-1 in 2.13.0 and still calls SHA-1 "weak"; SHA-256 object format via `extensions.objectFormat` | git-scm.com hash-function-transition (docs 2.55.0, 2026-06-29) |

**F8. The realistic SHA-1 exposure for a torrent-loaded site is a bait-and-switch by anyone who contributes bytes to a published torrent, not substitution by a third party.** Confidence **Medium** (derived from the attack's properties; no collision was built here). design_critical: **yes** (adds a pointer field and a verification step).
- v1 verifies each piece against `SHA-1(piece)` in the info dict and the infohash is `SHA-1(bencode(info))` [R `01` F9: `parse-torrent` hashes the re-encoded info dict with SHA-1; BEP 3 behaviour]. A third party with no influence on the bytes needs a second preimage: infeasible (F7).
- A contributor (an uploaded avatar, a vendored asset, a theme author, or the publisher) can use a chosen-prefix collision to prepare two byte strings with equal SHA-1 after the same prefix, get the benign one published and serve the other later, with infohash and signed pointer unchanged [I]. Needs: knowledge of the prefix in that piece (earlier files' bytes), a format that tolerates the random-looking collision blocks (images, PDFs and archives do; JS/CSS/HTML only in comments or strings), and a budget of order $10k [I from F7].
- ARCH 13 ("only the publisher could craft colliding content, a non-threat here") is true only if every contributor is trusted. **CORRECTS/REFINES** that sentence.
- Mitigation basis: after assembling files, verify per-file SHA-256 against the `/.mw/files.json` list, whose hash is bound into the signed pointer (R10).

**F9. BitTorrent v2/hybrid is not available in the browser stack, and the native client that now has WebRTC is a different, larger attack surface.** Confidence **High** (webtorrent), **Medium** (libtorrent/qBittorrent interplay). design_critical: **yes** (keeps the system on SHA-1 v1 for now).
- webtorrent `docs/bep_support.md` (master, fetched 2026-10-17): BEP 52 is not implemented for Node or Browser, linked to issue #1117. Issue #1117 "BitTorrent v2: Transition to a new hash function, info structure and merkle trees": opened 2017-04-26, open, labels accepted/enhancement, no branch or PR; feross 2018-05-04 "I'd like to support BitTorrent v2 ... welcome a PR"; ThaUnknown 2025-05-26 "just make a PR". [S]
- BEP 52: status Draft, Standards Track, last modified 2017-08-31; v2 info-hash uses SHA2-256; a torrent can contain both formats for interoperability; per-file merkle trees over 16 KiB blocks. [S]
- libtorrent: handles v2 and hybrid torrents (the 2.1 notes mention v2 hashes, merkle trees and hybrid loading; a search snippet, not opened, dates v2 to 2.0); **2.1.0 released 2026-07-07** (v2.1.1 2026-08-19, v2.1.2 2026-09-25) with WebTorrent "now enabled by default", built on libdatachannel (per the commit log), fuzz targets for WebRTC features, and the maintainers' note "the webtorrent support significantly widens the attack surface of libtorrent, if you don't need this feature, it's probably best disabled (`webtorrent=off`)". 2.1.0 also lists "authenticate webtorrent tracker certificates by default", "harden merkle_tree proof validation", `max_directory_depth`, "improve sanitization of filenames, and symlinks"; 2.1.2 fixes out-of-bounds reads in `bdecode` and hybrid-torrent loading. [S: release notes and Atom feed]
- qBittorrent: `v5.3.0rc1` 2026-09-28 is the newest entry in its release feed (no stable 5.3 yet); the rc1 release page does not mention WebTorrent. The only claim that qBittorrent 5.3 "answers browser peers over WebRTC" is webtorrent.org's own client table (single source, unverified here). Whether libtorrent's WebRTC peers interoperate with browser WebTorrent on v1-only and hybrid torrents was **not verified**. [S]
- No other browser-capable BitTorrent v2 client was found (one C#/WASM project appeared only in a search snippet and was not opened).
- Sources: https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/bep_support.md (2026-10-17); https://github.com/webtorrent/webtorrent/issues/1117; https://www.bittorrent.org/beps/bep_0052.html; https://github.com/arvidn/libtorrent/releases/tag/v2.1.0 and releases.atom; https://www.libtorrent.org/upgrade_to_2.1-ref.html; https://github.com/qbittorrent/qBittorrent/releases (atom and tag page); https://webtorrent.org/.

**F10. Consequence for the design.** Keep publishing v1-only torrents (create-torrent 6, per `01` F9) and bind the SHA-256 list that v0.2 already writes (`/.mw/files.json`) to the signed pointer (R10). If webtorrent gains BEP 52 later, hybrid torrents would add per-file SHA-256 merkle roots without changing this scheme.

### C. Wire and protocol layer

**F11. `bittorrent-protocol` accepts any length prefix and re-concatenates its entire receive buffer on every chunk: unbounded memory and quadratic CPU, reachable by any WebRTC peer.** Confidence **High** [C][X]. design_critical: **yes** (needs a patched or vendored dependency; changes the "no custom fork" assumption).
- Code (`node_modules/bittorrent-protocol/index.js`, version 5.0.9): `_write` (lines 849-859) does `this._bufferSize += data.length; this._buffer.push(data); if (this._buffer.length > 1) this._buffer = [concat(this._buffer, this._bufferSize)]` for every incoming chunk; `_onMessageLength` (lines 945-953) does `const length = getUint32(buffer); if (length > 0) this._parse(length, this._onMessage)` with no upper bound. `concat` (`uint8-util@2.3.2`, `dist/src/util.js` lines 8-20, the same function for Node and browser builds) allocates `new Uint8Array(size)` and copies everything. Upstream master `index.js` is byte-identical to 5.0.9; npm `latest` is 5.0.9 (published 2026-07-27). [C][S]
- `getUint32` is `(b[0] << 24) | ...`, i.e. **signed**: prefixes `0x80000000`-`0xFFFFFFFF` become negative, hit the `else` branch (treated as keep-alive) and buffer nothing. The largest prefix that actually waits is `0x7FFFFFFF` (2 GiB-1). Executed: prefix `0xFFFFFFFF` left `_parserSize = 4`; prefix `0x7FFFFFFF` set `_parserSize = 2147483647`. [X]
- Executed (Node v24.22.0, macOS arm64, 16 KiB chunks after a `0x7FFFFFFF` prefix, message never completes) [X]:

| Buffered | Time for the last 2000 chunks | Process RSS |
|---|---|---|
| 31 MiB | 2.7 s | 2,194 MiB (2.1 GiB) |
| 63 MiB | 8.8 s | 4,411 MiB (4.3 GiB) |
| 94 MiB | 15.6 s | 6,245 MiB (6.1 GiB) |
| 125 MiB | 22.3 s | 8,212 MiB (8.0 GiB) |
| 156 MiB | 30.9 s | 6,801 MiB (6.6 GiB) |
| 188 MiB | 57.4 s | 4,710 MiB (4.6 GiB) |

  12,000 chunks (187.5 MiB) took 137.7 s in total. RSS is dominated by garbage from the repeated full-buffer copies, so the damage precedes the logical buffer size. Browser memory behaviour was **not measured**; the same `concat` code ships to the browser, so a tab freeze or out-of-memory kill is the expected outcome [I].
- Preconditions: complete the BitTorrent handshake over WebRTC (needs only the public infohash and a tracker or peer introduction). No authentication, no PoW and no per-peer budget applies because no complete message ever reaches application code, so the gossip frame cap (15 KiB, ARCH v0.2 6.6) is never evaluated.
- **CORRECTS** review B4: "4 GiB" becomes "2 GiB-1", and the quadratic amplification is new; the remedy (cap in `_onMessageLength` before buffering) stands. Note that a patch using an unsigned `DataView.getUint32` also destroys wires on `0x80000000`+ prefixes instead of treating them as keep-alives, which is stricter and fine.
- Lab: `docs/research/labs/w1-11-opaque-frame-lab/wire-length-prefix-poc.mjs` and `wire-length-prefix-results-2026-10-17.txt`.

**F12. Mature BitTorrent and P2P stacks cap message and buffer sizes explicitly; webtorrent's stack has no cap and no report of the problem.** Confidence **High** for the comparators; **Medium** for "no prior report" (searched GitHub only). design_critical: no.
- libtorrent `settings_pack` defaults (reference-Settings, read 2026-10-17) [S]: `max_peer_recv_buffer_size` 2 MiB ("the max number of bytes a single peer connection's receive buffer is allowed to grow to"); `max_metadata_size` documented as `3 * 1024 * 10240`; `max_allowed_in_request_queue` 2000; `max_out_request_queue` 500; `max_pex_peers` 50; `max_rejects` 50 ("considered abusive and is disconnected"); `max_peerlist_size` 3000.
- Bitcoin Core `src/net.h`: `MAX_PROTOCOL_MESSAGE_LENGTH = 4 * 1000 * 1000` ("no message over 4 MB is currently acceptable") [S].
- webtorrent side: `ut_metadata` enforces `MAX_METADATA_SIZE = 1E7` (10 MB) on the extended handshake [C]; nothing equivalent at the transport layer.
- GitHub issue search on 2026-10-17 (webtorrent/bittorrent-protocol): 0 results for "DoS", no relevant result for "limit" or "memory"; webtorrent/webtorrent security search shows only #3012 (path traversal, Node side, open since 2026-03-21). Published security advisories: **none** for webtorrent and **none** for libtorrent (GitHub pages, 2026-10-17); absence of advisories is not absence of bugs. webtorrent's SECURITY.md asks for reports by email to the lead maintainer with a 48 h acknowledgement target. [S]
- A CVE/NVD survey for length-prefix memory exhaustion in other BitTorrent clients was **not completed** (search quota); see Open questions.
- Sources: https://www.libtorrent.org/reference-Settings.html; https://raw.githubusercontent.com/bitcoin/bitcoin/master/src/net.h; local `ut_metadata/index.js`; https://github.com/webtorrent/webtorrent/security; https://github.com/arvidn/libtorrent/security/advisories (all fetched 2026-10-17).

**F13. webtorrent 3.0.21 has no request-queue cap, no attribution or ban for peers that send corrupt data, and ignores `maxConns` for incoming connections.** Confidence **Medium-High** (code reading of 3.0.21; request flood not measured). design_critical: no.
- `lib/torrent.js` lines 1482-1489: `wire.on('request', ...)` only destroys the wire when `length > MAX_BLOCK_LENGTH` (128 KiB) and ignores requests for unverified pieces; otherwise it calls `this.store.get(...)`. `bittorrent-protocol._onRequest` ignores requests only while we are choking; an unchoked peer (10 upload slots by default: 9 regular plus 1 optimistic, `lib/torrent.js` lines 147-149 and 1833-1851) can queue unlimited 17-byte requests, each answered by a store read (in our case an IndexedDB/Blob read) [C, I]. libtorrent bounds this with `max_allowed_in_request_queue` 2000 and `max_rejects` 50.
- Piece verification (`lib/torrent.js` ~1989-2012): on hash mismatch it resets the piece (`new Piece(...)`), emits `'warning'` "Piece N failed verification" and re-requests; no record of which wire supplied the blocks, so a hostile peer in a small swarm can stall progress indefinitely. libtorrent's `create_smart_ban_plugin()` "keeps track of the data peers have sent us for failing pieces and once the piece completes and passes the hash check bans the peers that turned out to have sent corrupt data" [S].
- webtorrent issue #703 "`maxConns` option is ignored for incoming connections": opened 2016-03-29, open, labels bug/help wanted/area/perf, no fix PR; it proposes "not ever returning an offer when we're at capacity" for WebRTC [S]. A tracker or any announcer can therefore cause us to answer offers beyond our policy limits (see also `02` F23 [R]).
- Web-seed handling: failed web-seed requests are retried per piece after `RETRY_DELAY = 10000` ms indefinitely [C `webconn.js`].

**F14. SCTP/DataChannel limits bound each message but not a BitTorrent wire message, so an application-level cap is still needed.** Confidence **High** [R, `03` F-25/F-26]. design_critical: no.
- Chromium/WebKit advertise `max-message-size` 262144 (256 KiB), Gecko accepts about 1 GiB locally; RFC 8831 says to keep messages to 16 KB; libwebrtc caps queued received data at 16 MiB; dcSCTP's own send buffer is unbounded and the 16 MiB limit is enforced at the data-channel layer. A BitTorrent message spans many SCTP messages (F11), so these limits do not protect the parser.

**F15. The signalling server (tracker) can man-in-the-middle the DTLS handshake; integrity must come from piece hashes and block signatures, and the product must not claim confidentiality.** Confidence **High**. design_critical: no.
- RFC 8827 section 9.1: if the identity mechanism is not used, "any on-path attacker can replace the DTLS-SRTP fingerprints in the handshake"; "even if HTTPS is used, the signaling server can potentially mount a man-in-the-middle attack unless implementations have some mechanism for independently verifying keys"; a malicious service "can strip off any such identity assertions, though it cannot forge new ones". [S] Trackers also see IP, infohash and SDP (`02` F23 [R]).
- Content is protected by SHA-1 piece verification (F7-F8) and chain blocks by signatures; nothing in the system uses peer identity from the wire (`peerId` is unauthenticated), so chain code must authenticate blocks, never peers.
- Source: https://www.rfc-editor.org/rfc/rfc8827.html (read 2026-10-17).

---

### D. Privacy, GDPR and legal exposure of seeding visitors

**F16. IP addresses are online identifiers; a dynamic IP is personal data for the site operator when the operator has legal means to identify the visitor through the ISP.** Confidence **High** for the rule, **Medium** for applying it to swarm peers (no judgment decides that exact case). design_critical: **yes** (shapes the consent flow, ARCH 8).
- GDPR Recital 30: "Natural persons may be associated with online identifiers ... such as internet protocol addresses, cookie identifiers ... This may leave traces which, in particular when combined with unique identifiers and other information received by the servers, may be used to create profiles of the natural persons and identify them." [S, regulation text via gdpr-info.eu; the official EUR-Lex page sat behind a bot challenge and was not retrieved]
- CJEU, Breyer, C-582/14, 19 October 2016 (OLD, decided under Directive 95/46/EC), Court press release 112/16: "The dynamic internet protocol address of a visitor constitutes personal data, with respect to the operator of the website, if that operator has the legal means allowing it to identify the visitor concerned with additional information about him which is held by the internet access provider." The same release: an operator "may have a legitimate interest in storing certain personal data relating to visitors ... in order to protect itself against cyberattacks". [S; the full judgment text could not be fetched, so no paragraph numbers are quoted]
- What each party sees (T17): trackers see IP, infohash and SDP; every connected peer sees the IP; STUN servers see the IP; the DoH resolver sees IP and hostname; the web seed host sees IP and `Origin` (`02` F23, `03` F-16/F-17 [R]). The infohash identifies the site, so the pair says who reads what.

**F17. Uploading pieces is "making available to the public", the Court tied that to informed use of the client, and systematic recording of swarm IPs by right-holders is permissible in principle.** Confidence **High** for the holding as summarised by the Court; **Medium** for how it applies to a browser visitor who never "subscribed" to a client. design_critical: **yes**.
- CJEU, Mircom (C-597/19), 17 June 2021, Court press release 105/21 [S]: "the uploading of pieces, previously downloaded, of a media file containing a protected work using a peer-to-peer network constitutes 'making [a work] available to the public', even though those pieces are unusable in themselves and the uploading is automatically generated when the user has subscribed to the BitTorrent client sharing software in giving his or her consent to its application after having duly been informed of its characteristics." And: "any act by which he or she gives access to protected works in full knowledge of the consequences of his or her conduct may constitute an act of making available."
- Same release: EU law "does not preclude, in principle, the systematic registration, by the holder of intellectual property rights or by a third party on his or her behalf, of IP addresses of users of peer-to-peer networks ... or the communication of the names and of postal addresses of users ... for the purposes of an action for damages", provided initiatives are "justified, proportionate, not abusive and provided for by a national legislative measure" (GDPR Art. 6(1)(f) with Art. 15(1) of Directive 2002/58).
- Reading for this project [I]: (a) anyone can join a swarm for a site's infohash, record visitor IPs and, where national law allows, seek subscriber identities; (b) the Court's reasoning ties liability to knowing, informed use, which favours a clear pre-connection notice and a real choice; (c) a download-only client that never uploads (ARCH 8 "choke lock", never `throttleUpload(0)`) is outside the "uploading of pieces" holding, but still exposes the IP; (d) the owner and any hub operator who point visitors at infringing content carry their own exposure that this research did not analyse.
- Sources: https://curia.europa.eu/jcms/upload/docs/application/pdf/2021-06/cp210105en.pdf; https://curia.europa.eu/jcms/upload/docs/application/pdf/2016-10/cp160112en.pdf (both fetched 2026-10-17).

**F18. ePrivacy Art. 5(3) reaches an entity that instructs a browser, through a protocol or SDK, to send the device's IP address or session identifiers to third parties; whether an exemption applies is left open.** Confidence **Medium-High** (EDPB text; application is interpretation). design_critical: no.
- EDPB Guidelines 2/2023 v2 (final, 16 October 2024) [S]: para 34 "Instructing the device to send already stored information (for example, through the use of a protocol, or an SDK that imply the proactive sending of information by the terminal equipment) makes an intrusion into the terminal equipment possible, therefore such an access triggers the applicability of Article 5(3) ePD"; para 42 identifiers include "routing identifiers such as the MAC or IP address of the terminal equipment, but also session identifiers (SSRC, Websocket identifier), or authentication tokens"; para 55 an IP address falls in scope when it "originates from the terminal equipment" (a static outbound IPv4 from the user's router, IPv6 "partly defined by the host") and "Unless the entity can ensure that the IP address does not originate from the terminal equipment of a user or subscriber, it has to take all the steps pursuant to the Article 5(3) ePD"; para 56 "the applicability of this article does not systematically mean that consent needs to be collected" and the guidelines "do not analyse the application of the exemptions".
- Reading [I]: peer connections and tracker announces are not needed to show the requested page (the web seed can), so peer sharing is the part that most needs consent; this matches ARCH 8 ("peers and trackers start after [OK]"). **Gap:** the DoH lookup (F32) also sends the visitor's IP and the site hostname to a third party and runs outside the consent gate.

**F19. Swarm membership is publicly enumerable and WebRTC does not hide the public IP; a vendor FAQ statement about VPNs should not be relied on.** Confidence **High** for enumeration and for the mDNS/IP facts [R]; **Medium** for the FAQ criticism (not tested here). design_critical: no.
- mDNS replaces only private host candidates; the public (server-reflexive) IP is always shared; RFC 8828 modes and split-tunnel VPN exposure (`03` F-16/F-17 [R]). Trackers allow listing infohashes (`02` F23 [R]).
- webtorrent.io FAQ (fetched 2026-10-17): "If you have a VPN enabled, then WebRTC data channels will not connect to peers using your true public IP address" and "WebRTC data channels do not allow a website to discover your public IP address". Both conflict with RFC 8828's split-tunnel discussion as summarised in `03`; do not copy the FAQ wording into our docs. The same page says "libtorrent library has experimental (disabled by default) support for WebTorrent", which is stale after libtorrent 2.1.0 (F9).
- DESIGN-REVIEW 4.5 README text ("There's no private mode ... anyone who knows the site's infohash can see who's online") is accurate and should stay.

**F20. Comparable systems let the operator decide P2P defaults, scope their own trackers, and keep denylists; none of this is a legal safe harbour.** Confidence **Medium**. design_critical: no.
- PeerTube `config/production.yaml.example` (develop, read 2026-10-17) [S]: `defaults.p2p.webapp.enabled: true` ("Can be enabled/disabled by anonymous users and logged in users") and `defaults.p2p.embed.enabled: true` ("Can be enabled/disabled by URL option"); built-in tracker `private: true` ("Only handle requests on your videos ... If you set this to false it means you have a public tracker"), `reject_too_many_announces`; STUN servers "used by web browser to discover its public IP address". So P2P is default-on with a per-user toggle there; this project's ARCH 8 is stricter (peers only after OK), which is the safer EU posture.
- IPFS compact denylist format (24 August 2023, status reliable) [S]: Kubo and Rainbow ship an implementation; entry types CID, CID+path, IPNS name/path, double-hash rules, negation; double-hashing "avoids making the denylist a directory of bad content" at the cost of transparency and a hashing cost per check. The SW gateway enforces a BadBits denylist at the edge for subdomains since v3.5.0 [R `04`].

**F21. Hub-by-magnet loads arbitrary publishers' content and makes visitors redistribute it; the gate informs about IP exposure but not about content, and nothing yet gives the operator a takedown or denylist hook.** Confidence **Medium** (reasoning from F17 and F20; ARCH 3.3/8 read). design_critical: **yes** for any multi-publisher hub.
- ARCH 3.2/3.3/8: the gate shows name, btih, size once known, trackers and publisher fingerprint; consent text covers IP exposure and sharing. It does not show the hosts of `ws=`/`xs=` (F33), and there is no operator-side block list.
- No technical control can classify content in a P2P swarm; the only levers are who may be loaded (allow-list), a deny-list checked at the gate and at boot on `<label>.hub` origins, a visible report channel and a documented takedown process. Treat as an operations feature, with counsel review. Not legal advice.

### E. Chain-level threats (ledger)

**F22. Proof-of-work in the ledger is a fee measured in milliseconds, not a Sybil barrier; the real controls are policy defaults and byte budgets.** Confidence **High** [R measurement, I arithmetic]. design_critical: no.
- Measured SHA-256 rates in a Worker (Chromium 155, Apple M3): about 3.2-3.7 million hashes/s for specialised JS, 0.7-0.75 million/s for `crypto.subtle.digest` awaited per call (`06` F36 [R]). At `bits = 16` the expected work is 2^16 = 65,536 hashes, so about 18-20 ms per block per thread on that machine, 5 ms at 14 bits [I]. Native or GPU hashing is orders of magnitude faster [I, not measured]. DESIGN-REVIEW item 4 already describes PoW "as a fee" and defaults to `writers:'owner'`, `maxChainBytes` 8 MiB, 4 KiB blocks, which is the right answer.
- Precedent: Nostr NIP-13 defines difficulty as leading zero bits of the event id and mines via a `nonce` tag whose third element commits the target difficulty ("allows clients to protect against situations where bulk spammers targeting a lower difficulty get lucky") [S]; v0.2 `e.bits` matches that idea.

**F23. Mature relay and gossip systems advertise limits and score peers with a three-way validation result; adopting both keeps honest peers from being penalised for budget drops.** Confidence **Medium-High**. design_critical: no.
- Nostr NIP-11 `limitation` object (read 2026-10-17): `max_message_length` (example 16384), `max_subscriptions`, `max_event_tags`, `max_content_length`, `min_pow_difficulty` (example 30), `restricted_writes`, `payment_required`, `created_at_lower_limit` (example 31,536,000 s) and `created_at_upper_limit` (example 3 s) [S]. A machine-readable limits advertisement lets clients avoid sending what will be refused.
- GossipSub v1.1 (Candidate Recommendation, latest revision r8, 2021-12-14) [S]: peer score from P1 time in mesh, P2 first deliveries, P3/P3b mesh delivery rate and failures, P4 invalid messages, P5 application-specific, P6 IP-colocation factor, P7 behavioural penalty; thresholds `gossipThreshold` (no gossip emitted), `publishThreshold` (own messages not propagated), `graylistThreshold` (RPCs ignored), ordered graylist < publish <= gossip < 0; validators return Accept, Reject (P4 penalty) or Ignore (neither delivered nor forwarded, **no** penalty); "IHAVE messages are capped"; IWANT responses limited per peer.
- Fit with ARCH 6.3/6.6 [I]: v0.2 already says "Never cache rate or budget rejections by hash" and ignores a peer after more than 50 invalid blocks. Make the distinction explicit in code: **Reject** only for structurally/cryptographically invalid blocks (counts toward the 50), **Ignore** for over-budget, over-cap or stale-by-policy blocks (no penalty, not cached). Add a P6-style rule: limit wires per remote IP and per `/24` (the IP is known from ICE candidates) [I].

**F24. Cross-context replay is prevented by putting the context into what is signed; v0.2 does this everywhere except the `rot` signature input.** Confidence **High** (precedent) / **Medium** (gap, derived from the spec text). design_critical: no.
- EIP-155 (created 2016-10-14, Final): the chain id is hashed with the transaction so a transaction valid on one chain is not valid on another; `v = {0,1} + CHAIN_ID * 2 + 35` [S].
- v0.2 signs `e.site` inside `h`, and uses `"mw-block-v1\n"`, `"mw-pointer-v1\n"` (with scope) and `"mw-rot-v1\n"` tags [S: ARCH 4, 6.1]. The `rot` input is `"mw-rot-v1\n" + <new owner> + "\n" + seq`: it omits the scope and the old key. An owner who uses one key for several domains could have a rotation for domain A replayed on domain B (valid if B pins the same old key and has a lower `seq`) [I]. Fix: sign `"mw-rot-v1\n" + scope + "\n" + old + "\n" + new + "\n" + seq`.

**F25. Timestamps are best-effort metadata in every system that tolerates clock skew; keep them out of validity and ordering, bound them only at admission.** Confidence **High**. design_critical: no.
- Bitcoin Core `src/chain.h`: `MAX_FUTURE_BLOCK_TIME = 2 * 60 * 60`; Nostr NIP-11 `created_at_lower_limit`/`created_at_upper_limit` [S]. v0.2 already excludes `ts` from ordering (depth then hash), rounds it to the minute and shows it "as claimed" [S: ARCH 6.1, 6.4; DESIGN-REVIEW S9].
- Residuals [I]: the visitor's local clock decides `exp` validity (ARCH 4 does not state a skew tolerance); a wrong device clock either rejects fresh pointers or accepts expired ones. State a tolerance (v0.1 used 24 h) and surface "your device clock looks wrong" when a signed pointer is far in the future.

**F26. Every mature key-rotation design makes rotation authority stronger than, or independent of, the routine signing key; v0.2's `rot` is signed by the previous owner key alone and is then accepted silently.** Confidence **High** (precedent) / **Medium** (severity). design_critical: **yes** (pointer grammar and the `{t:'owner'}` op).
- TUF Specification 1.0.37 (last modified 2026-10-08) [S]: a new root (version N+1) "MUST have been signed by (1) a THRESHOLD of keys specified in the trusted root metadata file (version N) and (2) a THRESHOLD of keys specified in the new root metadata file" (section 5.3 step 4); version must be exactly N+1 (rollback protection); "Clients MUST NOT trust an expired file"; compromise below threshold is handled by revoking trust, at or above threshold "the Root keys should be updated out-of-band" (2.1.1). TUF keeps the root role separate from the timestamp and snapshot roles, whose keys can be rotated independently (section 5.3 step 11).
- did:plc v0.3.0 (December 2025) [S]: `rotationKeys` is a priority-ordered list of 1-5 `did:key`s ("in order of descending authority"); the spec describes a 72 h recovery window (currently 72hr) during which a higher-authority rotation key can override an operation signed by a lower-authority one; signing keys "do not have control over the DID document" and "Best practice is to maintain separation between rotation keys and atproto signing keys"; updates carry a `prev` hash pointer. The 72 h window needs a shared ordering authority (the PLC directory), which this project does not have.
- KERI (Internet-Draft `draft-ssmith-keri`, 2022, OLD) [S]: inception commits "a list of digests of the set of pre-rotated public keys"; a rotation "MUST include a list of the set of pre-rotated public keys (not their digests)"; "an attacker can't forge and sign a verifiable rotation operation without first unblinding the pre-rotated keys"; limit: "The window for an attacker is the network latency for the first published event."
- v0.2 [S: ARCH 4, DESIGN-REVIEW 3]: `rot=` is "signature by the previous owner key", and "with a valid `rot` a key change is silent". `publish.mjs --key owner.jwk` reads the owner key on the publishing machine, which tends to be a CI runner (see `w2a-06`). A stolen signing key can therefore mint a silent rotation to an attacker key; delivering it to visitors still needs control of the host, DNS or a fragment link (review M3), so the realistic harm is a permanent lock-out of the real owner after a combined compromise [I].
- Proposed (R12, with R11): a pre-rotation commitment `nk=<b64url sha256(next owner pub)>` in the signed pointer and in the genesis/`owner` control block; a rotation is valid only if `sha256(new owner) == pinned nk`, it is signed by the new key (and optionally the old one), it carries scope and old key in the signed input (F24), it sets a new `nk` and increments a key-epoch (`ke`); records from an older epoch are refused once a newer one has been seen. Keep the TOFU prompt for rotations without a matching `nk`. The next key lives offline; the routine signing key can then sit in CI without being able to rotate.

**F27. Threshold signing and hardware custody have precedents but are not needed for most sites.** Confidence **Medium**. design_critical: no.
- TUF thresholds (above). Sigstore root-signing (README, read 2026-10-17): five current keyholders who sign "with their personal hardware keys", signing events run as pull requests, a recorded initial ceremony, online (KMS) signatures re-signed "at least every three days because of online signature expiry"; the README does not state the numeric threshold [S].
- A WebAuthn credential is a P-256 ECDSA key held in a token; a verifier could accept an assertion signature over `authenticatorData || SHA-256(clientDataJSON)` where `clientDataJSON` carries the pointer hash as the challenge [I; the WebAuthn spec was not read this session]. It would fit the existing P-256 pointer format, bound to an RP ID. Treat as an option to study (R20), not a recommendation.

**F28. A signature or ID computed over a redacted form, plus a retained content hash, is the established way to let redacted records keep verifying; v0.2's `{e,h,s}` stub with `vh` is equivalent.** Confidence **High**. design_critical: no (confirms the design).
- Matrix Server-Server API (`main`, read 2026-10-17) [S]: "Before signing the event, the *content hash* of the event is calculated ... stored in the event object, in a `hashes` object, under a `sha256` key. The event object is then *redacted* ... Finally it is signed"; on receipt "The event is redacted ... Note that this step should succeed whether we have been sent the full event or a redacted copy"; "If the hash check fails, then it is assumed that this is because we have only been given a redacted version of the event"; the event ID (room v3+) is the reference hash of the redacted form; the content hash "covers the complete event including the *unredacted* contents". Redaction keeps `hashes`, `signatures`, `prev_events`, `depth`, `sender`, `room_id`, `type`, `state_key`, `origin_server_ts` and selected content keys per event type (room v11 client considerations).
- Hyperledger Fabric private data (docs `latest`, read 2026-10-17) [S]: "a hash of that data, which is endorsed, ordered, and written to the ledgers of every peer on the channel"; the data itself goes peer-to-peer "to only the organization(s) authorized"; purging leaves "a hash of the data on the blockchain to serve as immutable evidence"; `DelPrivateData` leaves history that `PurgePrivateData` removes.
- Certificate Transparency domain-label redaction (`draft-strad-trans-redaction-01`, latest revision 2017-01-17, "Expired & archived", "not endorsed by the IETF") tried to keep private labels out of logs while keeping most CT benefits and was never standardised [S]. Lesson [I]: redaction that removes what auditors need to verify does not get adopted; keep type, author, DAG position and the commitment verifiable, as v0.2 does.
- Sigstore Rekor: the overview page says entries are "never mutated or removed" and does not describe stored fields or privacy, so it is not used as evidence here.

**F29. A hash of personal data is personal data and an unsalted hash is not sufficient; v0.2's `vh` is unsalted and `k`/`l` stay in clear in every stub.** Confidence **High** (EDPB text) / **Medium** (application to this ledger). design_critical: **yes** (block format before `block.js` freezes).
- EDPB Guidelines 02/2025 on blockchain technologies, v2 final, dated 07 July 2026 (PDF read 2026-10-17) [S]: para 52 "store only a salted or keyed hash of the personal data ... the GDPR will still apply to that processing activity and ... the hash will also be considered personal data"; "after deletion of the secret key or salt, the hash should not be linkable to the original data, provided that the algorithm has not been broken, the keys have not been compromised or leaked, and the salt was not leaked or poorly chosen"; "the use of unsalted or unkeyed hashes should, in general, not be considered sufficient to guarantee the necessary level of confidentiality protection for storing personal data on a public blockchain". Para 53 commitments: with a "perfectly hiding" scheme "once the original data and its witness are deleted, the commitment persisting in the blockchain is useless". Para 103-104 erasure may be "technically impracticable"; "It is therefore not advisable to register personal data in those forms [clear text, encrypted or hashed] on a blockchain. Instead, personal data in those forms should be stored off-chain." Para 109 recommends storing additional personal data off-chain. Para 43 nodes of public permissionless chains "should be qualified as controllers or joint controllers" in some circumstances. Para 91-92: a DPIA is mandatory where processing is likely to result in high risk, and the controller may choose a different model of chain.
- v0.2 [S]: `vh = hex(sha256(canonical(value)))`; `put {t,k,vh}`, `append {t,l,vh}`; tombstone "= drop `v`, keep `{e,h,s}`" (ARCH 6.1, DESIGN-REVIEW 1). For a guestbook, `v` is a name and a message; low-entropy values (reactions, votes, short names) can be confirmed by guessing against `vh`, and the stub keeps `author`, `ts` (minute) and `k`/`l`.
- Fix (R4): `vh = sha256("mw-vh-v1\n" + z + canonical(v))` (byte concatenation) with a fresh 128-bit CSPRNG salt `z` carried beside `v` in the block (`{e,h,s,v?,z?}`) and dropped with it on tombstone. The Hashcash `nonce` (public, inside `e`) cannot play this role because it survives redaction. Document that `k`/`l` are public metadata and never hold personal data, or move them under the commitment for ops flagged private. Ledgers with personal data need a DPIA decision by the controller (para 91).
- Limits [I]: salting protects against inference from stubs; it cannot force a hostile replica to delete a payload it already holds (F30).

**F30. Deletion in a replicated log is a request honoured by cooperating replicas, and mature protocols say so.** Confidence **High**. design_critical: no.
- Nostr NIP-09 (read 2026-10-17): relays "SHOULD delete or stop publishing any referenced events"; clients "MAY choose to inform the user that their request for deletion does not guarantee deletion because it is impossible to delete events from all relays and clients." [S]
- v0.2 README text ("To remove a post, delete it; visitors honour that when they receive it") is consistent. EDPB para 103 says erasure on such structures can be technically impracticable; the owner should not promise more.

### F. Pointer record, DNS and DoH

**F31. The `AD` flag is evidence only over a secure channel to a trusted resolver, so a DoH provider stays a trust root; its absence says little because most zones are unsigned.** Confidence **High**. design_critical: no.
- Cloudflare DNS JSON (read 2026-10-17): "AD: If true, it means that every record in the answer was verified with DNSSEC"; request flags `do`/`cd` default false [S].
- RFC 4035 section 4.6: "A resolver MUST disregard the meaning of the CD and AD bits in a response unless the response was obtained by using a secure channel or the resolver was specifically configured to regard the message header bits without using a secure channel"; section 4.9.3: a stub resolver "MUST NOT place any reliance on signature validation allegedly performed on its behalf, except when ... obtained ... from a trusted security-aware recursive name server via a secure channel" [S].
- Measured earlier: JSON endpoints return `AD` without `do`; about 4-5% of .com domains are signed (2023-24, OLD) [R `05` F5]. A browser-ready JS DNSSEC validator was not found [R].

**F32. The pointer's authenticity should rest on the owner signature plus a pin; channel diversity is a detection tool, and a disagreement between channels should stop the load instead of silently preferring one.** Confidence **Medium-High**. design_critical: no.
- Defences, strongest first [I]: owner signature over scope (ARCH 4); `exp` required and `seq` monotonic per scope (ARCH 4, consistent with TUF's expiry and version rules above); TOFU pin and "first time on this device" banner; independent channels (`<meta>` from the host, DNS TXT from the DNS provider, cache); `AD` as a hint; resolver diversity for availability only.
- v0.2 rule: "With both meta and DNS valid: DNS wins only if signed by the pinned owner (or with valid `rot`) and `seq` is higher; otherwise meta." [S: ARCH 4]. If the two channels carry **different owner keys** (no `rot` link) on a first visit, at least one of them is wrong or hostile, and "otherwise meta" silently picks the one the host controls. Proposed: on first visit, a key mismatch between independent channels is a hard stop with both fingerprints; on later visits keep the pin rule and add a warning banner.
- Privacy: each DoH lookup discloses the visitor IP and `_magnet.<hostname>` to Cloudflare/dns.sb/Google and happens whether or not the visitor accepted peer sharing (F18). Proposed: do the DNS lookup only after consent, or only when the meta pointer carries a flag (for example `dns=1`) saying a DNS channel exists, or when `exp` is within a window; `<meta>` stays the primary bootstrap (R6, R13).

**F33. Values taken from an unsigned magnet (`ws=`, `xs=`, `tr=`) make the visitor's browser a request source against third parties; webtorrent's own headers turn the web-seed case into an OPTIONS preflight.** Confidence **High** for the executed results, **Medium** for impact. design_critical: no.
- Executed [X] (Playwright Chromium 156.0.8078.4 and WebKit 27.2, macOS arm64; Firefox failed to launch here, untested): a cross-origin `fetch()` with a simple `Range: bytes=0-262143` or `bytes=100-` reaches the third-party server as a plain GET with no preflight (the page still gets a CORS error); suffix (`bytes=-500`) and multi-range values preflight. With webtorrent's exact headers (`Cache-Control: no-store`, `user-agent`, `range`) both engines preflight (`Access-Control-Request-Headers: cache-control` in Chromium; `cache-control,user-agent` in WebKit), so a non-cooperating host sees OPTIONS only.
- The Fetch Standard text read 2026-10-17 lists `range` among CORS-safelisted request headers when it parses as a simple range with a start value, which matches the executed behaviour [S].
- `webconn.js` retries a failed piece after `RETRY_DELAY = 10000` ms with no limit [C]; `xs=` makes the loader GET an arbitrary URL for a `.torrent` (ARCH 5.4). The hub gate lists trackers but not the `ws`/`xs` hosts (ARCH 3.3).
- Lab: `docs/research/labs/w1-11-opaque-frame-lab/exp-c-range-preflight.mjs`, `results-range-preflight-2026-10-17.txt`.

### G. Loader integrity and supply chain

**F34. The browser integrity primitives cover script tags and, in newer browsers, the module graph; they do not cover the Service Worker script, workers or the HTML shell, and signature-based SRI exists only in Chrome.** Confidence **High**. design_critical: **yes** (the static host remains the trust root).
- MDN `ServiceWorkerContainer.register()` options: `scope`, `type`, `updateViaCache` (no `integrity`); `Worker()` options: `credentials`, `name`, `type` (no `integrity`) [S].
- MDN BCD `main`, read 2026-10-17 [S]: `<script integrity>` Chrome 45 / Firefox 43 / Safari 11.1; import map `integrity` key Chrome 127 / Firefox 138 / Safari 18 (MDN: "ensure the integrity of dynamically or statically imported modules"); `integrity="ed25519-..."` (signature-based SRI) **Chrome 141 only**, Firefox and Safari `false`.
- WICG Signature-based SRI, Draft Community Group Report 8 April 2026 [S]: `integrity` takes `ed25519-<base64 public key>`; the server sends `Unencoded-Digest`, `Signature-Input` (with `tag="ed25519-integrity"`) and `Signature` headers per RFC 9421; "does not easily support key rotation" but supports pinning multiple keys; rollback by serving older signed versions is possible unless `expires` is set; "If a key is compromised, security falls back to the status quo". Needs response headers that some static hosts cannot set [I].

**F35. As of 2026-10-17 there is no browser-native web-app integrity mechanism an open-web loader can rely on.** Confidence **High**. design_critical: **yes**.
- WAICT: Cloudflare (2025-10-16): "We are still very early in the standardization process"; manifest fields `version`, `integrity-policy`, `hashes`; per-site hash chain of manifests, witnesses that sign consistency proofs, preload list of enrolled sites, 24-hour cooldowns; transparency spec "a draft". Mozilla Hacks (2026-05-05): "An early prototype of WAICT is available behind a pref in Firefox Nightly"; "The implementation is a work in progress, not a finished solution"; collaborators Cloudflare, Freedom of the Press Foundation, Meta. Explainer: a CSP-like `integrity-manifest` with `integrity-manifest-src` and `integrity-enforcement-level`; next step a W3C WebAppSec draft; service workers and dynamic imports not addressed [S].
- Meta Code Verify (2022-03-10, updated 2023-06-16): an extension that compares the code running in the page with a hash "source of truth" given to Cloudflare; Chrome, Edge, Firefox; useless to visitors who do not install it. WEBCAT (SecureDrop/FPF, 2026-05-04): alpha extension, "heading toward a beta", academic evaluation "Trust on Reload" (ACM Web Conference 2026) [S].
- Isolated Web Apps (developer.chrome.com, last updated 2026-02-06): the initial release "will only be available to Chrome Enterprise administered ChromeOS devices and select development partners"; apps ship as signed `.swbn` bundles with Ed25519 or ECDSA P-256 keys that can be kept offline; desktop Chrome and Android not listed [S].
- Practical stand-in [I]: independent canary monitors (`check-site.mjs` from infrastructure the site owner does not host on) that fetch the live shell and SW and compare them with the signed release manifest published at release time. This is "Code Verify without an extension" and also detects a compromised CDN edge.

**F36. Dependency posture, measured: 4 high advisories (all `ip@2.0.1`, not in the browser bundle) and 6 of 251 locked packages with install scripts.** Confidence **High** [X]. design_critical: no.
- `npm audit --omit=dev --json` (npm 11.19.1, 2026-10-17): vulnerabilities `bittorrent-tracker`, `ip`, `torrent-discovery`, `webtorrent`, all via GHSA-2p57-rm9w-gvfp "ip SSRF improper categorization in isPublic" (range `*`, no patched release; npm's suggested "fix" downgrades to webtorrent 0.7.3, which is not a fix). `grep -c isPublic dist/webtorrent.min.js` = 0, so the browser bundle does not contain it; it matters for Node-side tools (`tools/tracker.mjs`, seeders). Dependencies: 251 locked (165 prod, 74 dev, 39 optional).
- Install scripts (`hasInstallScript` in `package-lock.json`): `bufferutil`, `utf-8-validate`, `utp-native` (optional native addons), `esbuild` (dev), `ip-set` (`preinstall: npx only-allow pnpm`, which fetches and runs a package at install time), `node-datachannel` (`install: prebuild-install -r napi || ...`, downloads a prebuilt binary).
- ARCH 10/13 already specify `.npmrc ignore-scripts=true` and `build.lock.json` hash pinning; with `ignore-scripts` the `ip-set` preinstall does not run, and `node-datachannel` has no native binary, so `seed.mjs` correctly falls back to instructions.

**F37. A malicious Service Worker persists until the next successful update fetch from a clean host; the kill switch only helps visitors who come back.** Confidence **High** [R `04` F20; S ARCH 7.1]. design_critical: no.
- SW update is a byte comparison checked on navigation and at most every 24 h for functional events; `/mw-sw.js` is served `no-cache` with `updateViaCache: 'none'` and the kill switch is a self-unregistering `/mw-sw.js` (ARCH 7.1, DESIGN-REVIEW 20). A host compromise window therefore leaves a hostile SW on any browser that visited during it until that browser returns after the clean redeploy. Short `exp` on pointers does not shorten this.

### H. XSS inside a loaded site and the SDK

**F38. In per-domain and drop-in modes the site's code runs in the loader's origin, so the SDK is the attack surface; v0.2's SDK exposes `identity.export`, `identity.import` and `consent.accept` to any script in the page.** Confidence **High** (spec text) / **Medium** (impact; not exercised). design_critical: **yes** (SDK freeze).
- ARCH 3.4.9: "The engine runs in the site's own origin. `window.mw` is the §9 API bound directly to the engine (no Bridge)"; ARCH 9 lists `mw.identity.setName(name) / export(passphrase) -> string / import(blob, passphrase)` and `mw.consent.accept()` [S]. Shell mode adds a MessagePort Bridge that checks `ev.source` and `ev.origin` (`bridge.js` 201-202 [C]), which is correct but is not a boundary because the frame is same-origin (review B1).
- MDN postMessage: "always verify the sender's identity using the `origin` and possibly `source` properties ... still ... always verify the syntax of the received message"; "Always specify an exact target origin, not `*`" [S].
- Consequences [I]: an XSS or third-party script can export a passphrase-wrapped copy of the visitor's identity key to a passphrase it chooses, import an attacker's identity, and set consent to "accepted" without any user action, which also undermines the consent record (F17/F18).
- Fix (R5): keep `export/import/consent` in loader-owned UI only (closed shadow root, `event.isTrusted` required, transient user activation); give sites `mw.consent.request()` which opens that UI; keep identity operations out of the site-callable surface; keep per-site (per ledger id) keys, which v0.2 has.

**F39. Further options to protect signing, ordered by cost.** Confidence **Medium**. design_critical: no.
- Rate limits and size limits at the SDK boundary (v0.2: 20 writes/min per page) bound abuse but not key theft.
- Confirm-to-sign for destructive or high-value actions (`tombstone` of others, moderator `ban`) in loader-owned UI.
- WebAuthn PRF: MDN describes the `prf` extension as a way to "generate a symmetric key for encrypting sensitive data, and that can only be decrypted by a user who has the seed and the associated authenticator"; BCD (2026-10-17): `create` Chrome 116 / Firefox 139 / Safari 18 (Firefox Android 149), `get` Chrome 116 / Firefox 139, Safari `false` in BCD (may lag). Wrapping the identity key under a PRF-derived key would make signing sessions need the authenticator [I]; UX and device coverage cost (R20).

---

## 4. Concrete recommendations for magnet-web (prioritised)

Reference point: `docs/ARCHITECTURE.md` **v0.2 (2026-10-17, normative)** and `docs/review/DESIGN-REVIEW.md`, which already adopted most of the earlier security review (hub subdomain mode, wire cap, consent before the first announce, causal policy, `exp`/`seq`/domain separation, no owner key in browsers, kill switch, `ignore-scripts`). The code under `src/` was last modified 2026-10-14 and predates v0.2 (F6), so "CONFIRM" items below mean "the spec is right; make sure the code and tests do exactly this". Tags: **[CONFIRM]** spec already says it, evidence agrees; **[CORRECT]** spec or test needs a change; **[NEW]** not in the spec. Effort S (under a day), M (days), L (weeks). Priority P0 = before any public deployment or before the named file freezes; P1 = before calling v1 production-ready; P2 = soon after; P3 = watch or optional.

### P0

| ID | Tag | Eff | What to build or change | Why (findings) |
|---|---|---|---|---|
| R1 | CONFIRM + CORRECT | S | In `src/loader/torrent.js` wrap `wire._onMessageLength` per wire before the handshake completes; read the prefix **unsigned** (`>>> 0` or `DataView.getUint32`) and `wire.destroy()` when it exceeds 256 KiB; add a second guard on `wire._bufferSize` (destroy above about 512 KiB) for any other parse state; keep `setTimeout(60000, true)` and `setKeepAlive(true)`. **Change the tests**: replace "4 GiB" (ARCH 12 test 11, DS test 8) by prefixes `0x7FFFFFFF`, `0xFFFFFFFF` and a 300 KiB message, and assert **wire destroyed within 1 s, heap flat and CPU time bounded** (unpatched baseline in the lab: 137 s wall time, CPU-bound, for 187 MiB). Send upstream an issue/PR for a `maxMessageLength` option; report privately first (SECURITY.md) since no advisory exists. | F11, F12; T3 |
| R2 | CONFIRM | S | Delete the v0.1 hub flags still in code (`render.js` `SANDBOX_HUB`, `sw.js` `HUB_CSP` with `sandbox allow-scripts allow-same-origin`); shared-origin hub = demo and single-publisher only, behind the blocking gate, never auto-loading from `#magnet:`/`?mw=`/protocol handler; grep the docs for any isolation claim (ARCH 3.3 acceptance). | F1, F2, F6; T1, T2 |
| R3 | CORRECT (SHOULD -> MUST for multi-publisher hubs) | M | Hub domain layout: (a) site origins on a **separate registrable domain** from the gate/landing (IPFS: `ipfs.io` vs `*.dweb.link` / `*.inbrowser.link`); (b) submit the wildcard PSL entry **early** (`_psl` TXT, more than 2 years of registration left, "no way to expedite", propagation time unknown); (c) set no cookies on the hub apex; (d) wildcard certificate and a host that supports wildcard custom domains (verify per host); (e) refuse IP-literal and non-label hosts. A hub without the PSL entry is not production-grade. | F3, F4; T1, T23 |
| R4 | NEW | S-M | Before `block.js` freezes: make the payload commitment **salted**: `vh = sha256("mw-vh-v1\n" + z + canonical(v))` (byte concatenation) with a fresh 128-bit CSPRNG `z` carried beside `v` (`{e,h,s,v?,z?}`) and dropped with `v` on tombstone; do not reuse the public Hashcash `nonce`; state that `k`/`l` are public metadata (or put them under the commitment for private ops). Add unit tests: redaction keeps `h`/`s` valid; stub reveals nothing guessable without `z`. | F28, F29, F30; T22 |
| R5 | NEW | S | Before the SDK freezes: remove `identity.export`, `identity.import` and `consent.accept` from the site-callable `window.mw`/Bridge; keep them in loader-owned UI (closed shadow root, `event.isTrusted`, transient user activation); add `mw.consent.request()` that opens that UI. | F38; T21 |
| R7 | NEW | M | For any multi-publisher hub (n/a to single-owner deployments): a **denylist** (compact-denylist-style, double-hashed rules over `label`/`btih`) served from the hub's own host and checked at the gate and at boot on `<label>.hub` origins; the gate also lists the `ws=`/`xs=` hosts; a visible report/abuse page and a written takedown process. Counsel review for the target jurisdictions. | F17, F20, F21; T18 |

### P1

| ID | Tag | Eff | What to build or change | Why |
|---|---|---|---|---|
| R6 | CONFIRM + NEW | S | Consent: implement "before the first announce" exactly as ARCH 8, and (a) put the **DoH lookup behind the same consent** or behind an explicit `dns=1` flag in the meta pointer (today every visitor's IP and `_magnet.<host>` go to a third party outside the gate); (b) give the per-domain notice first-layer choices of equal weight ([OK], [Host only], [Settings]) (whether this is legally required was **not verified**; ask counsel); (c) store consent per origin with timestamp and notice-text version, revocable in Settings. | F16-F18, F32; T17 |
| R8 | NEW | M | Per-wire resource caps beyond ARCH 8: cap queued upload requests per wire (start at 64-128), rate-limit requests, destroy offenders; cap wires per remote IP and per /24; keep the `maxConns` destroy-in-`'wire'` rule (webtorrent #703 is open since 2016). libtorrent precedent: queue 2000, `max_rejects` 50. | F13; T4 |
| R9 | NEW | M | Poisoned-piece attribution: record which wire supplied each block, on "Piece N failed verification" add strikes to the contributors, ban after K (3) strikes for the session, prefer the web seed after two strikes. libtorrent `create_smart_ban_plugin()` is the precedent. | F13; T5 |
| R10 | NEW | S-M | Bind and use the existing SHA-256 list: add `fj=<b64url sha256 of /.mw/files.json>` to the signed pointer; at first serve verify `files.json` against `fj` and each file against `files.json` (memoise per context). Unsigned magnets stay SHA-1-only and say so. Closes the chosen-prefix bait-and-switch independently of SHA-1; ARCH 3.4.1/10 write `files.json` but use it only for cross-version reuse. | F7-F10; T16 |
| R11 | CORRECT | S | `rot` signing input must include scope and the old key: `"mw-rot-v1\n" + scope + "\n" + old + "\n" + new + "\n" + seq` (today a rotation for domain A is replayable on domain B when one key serves both). Unit-test the cross-scope replay. | F24; T9 |
| R12 | NEW | M | Pre-rotation: add `nk=<b64url sha256(next owner pub)>` to the signed pointer and the genesis/`owner` control block; a silent rotation requires `sha256(new owner) == pinned nk`, the new key's signature, a key-epoch increment and a fresh `nk`; keep the TOFU prompt otherwise; `keygen.mjs --recovery` creates the next key for offline storage so the CI signing key cannot rotate. Do this before the v1 grammar ships. | F26, F27; T11 |
| R14 | CONFIRM | S-M | Implement ARCH 7.1/7.3 exactly: `frame-ancestors 'self'` / `X-Frame-Options` on site documents, shell `frame-ancestors 'none'`, 302 for top-level `/_mw/s/...`, verify `sha1(bencode(info)) === btih` and every piece before first serve/upload; E2E: flipped byte in IndexedDB triggers `deleteSite`. | F1; review M4/M5; T3, T24 |
| R15 | CONFIRM + NEW | S-M | Supply chain: `.npmrc ignore-scripts=true`, `npm ci`, `build.lock.json`; add (a) import-map `integrity` entries for the module graph generated by `build.mjs` (Chrome 127 / Firefox 138 / Safari 18) plus SRI on classic tags; (b) a CI check that fails when the set of packages with install scripts changes from today's six (bufferutil, utf-8-validate, utp-native, esbuild, ip-set, node-datachannel); (c) document that the `ip@2.0.1` advisory has no patched release and affects Node tools only; (d) consider release provenance/attestation (not researched). | F34, F36; T19 |

### P2

| ID | Tag | Eff | What to build or change | Why |
|---|---|---|---|---|
| R13 | NEW | S | Channel-disagreement rule: on a first visit, `<meta>` and DNS carrying different owner keys (no `rot`/`nk` link) is a hard stop showing both fingerprints; on pinned scopes keep v0.2's pin rule and add a warning banner. | F32; T13 |
| R16 | NEW | S-M | External canary: a scheduled job on infrastructure the owner does not host on fetches `/index.html`, `/mw-sw.js` and `/_mw/*` and compares hashes with the signed release manifest; alert on mismatch (the extension-free analogue of Code Verify; detects a compromised edge). Extend `check-site.mjs`. | F35, F37; T19, T20 |
| R17 | NEW | M | Gossip admission: three-valued validation (Accept / Reject = counts toward the 50-strike rule / Ignore = over-budget, no penalty, never cached by hash); advertise `maxBlockBytes`, `bits`, `maxChainBytes` in HELLO; admission-only `ts` window (drop blocks more than 24 h in the future; never part of validity). | F23, F25; T6, T7 |
| R21 | NEW | M | Upstream: PRs to `webtorrent/bittorrent-protocol` (`maxMessageLength`, buffer cap) and `webtorrent` (request-queue cap, hash-failure attribution hook). | F11-F13 |
| R22 | NEW | M | Evaluate libtorrent 2.1 (WebTorrent on by default) as an always-on seed for v1 torrents: interoperate with browser WebTorrent? run it isolated (container, no secrets) given the maintainers' "significantly widens the attack surface" warning. qBittorrent 5.3 is at rc1 (2026-09-28). | F9 |
| R23 | NEW | M | Privacy mode: optional `iceTransportPolicy: 'relay'` when a TURN tier exists (`03` R-05); "Host only" already exists. | F19 |
| R24 | NEW | S | Ship a DPIA and roles template for ledger sites that collect personal data (owner = controller; hub operator role to be decided with counsel); make open writing with personal data an explicit owner decision in `publish.mjs --policy open`. EDPB 02/2025 v2 paras 43, 91-92, 103-104. | F29; T22 |
| R25 | NEW | S | Torrent path validator at metadata time: reject `..`, absolute paths, backslashes, control characters, case-fold/NFC duplicates, reserved top-level `_mw` and `.mw`, depth over 32 (libtorrent 2.1.0 added `max_directory_depth` and filename/symlink sanitising; webtorrent #3012 is the Node-side path-traversal report). | F9; T24 |
| R29 | NEW | M | Run the experiments of F2, F5 and F33 in Firefox and Safari (Firefox failed to launch in this environment; Safari/iOS not tried). | F2, F5, F33 |

### P3

| ID | Tag | Eff | What | Why |
|---|---|---|---|---|
| R18 | NEW | S | State a clock-skew tolerance for `exp` (v0.1 had 24 h) and warn when a signed pointer is far in the future. | F25 |
| R19 | NEW | L | Optional "untrusted preview" for the shared-origin hub: opaque-origin frame, `srcdoc` bootstrap, bytes over MessageChannel, blob URLs built inside the frame, shim for fetch/XHR/links. Prefer deleting shared-origin hub outside localhost demos. | F5 |
| R20 | NEW | L | Study WebAuthn P-256 assertions as owner pointer signatures and PRF-wrapped identity keys. | F27, F39 |
| R26 | NEW | S | For unsigned magnets: show `ws`/`xs`/`tr` hosts in the gate, probe once, mark a web seed dead after the first CORS failure instead of the per-piece 10 s retry loop. | F33 |
| R27 | NEW | L | Threshold (m-of-n) owner keys for high-value sites (TUF dual-threshold model). | F26, F27 |
| R28 | NEW | S | Watch list: WAICT (adopt an `integrity-manifest` when two engines ship it), signature-based SRI outside Chrome, Isolated Web Apps beyond managed ChromeOS, qBittorrent 5.3 final and libtorrent browser interop, PSL propagation timing. | F34, F35 |

### 4.1 What this research confirms, corrects and adds relative to v0.2

- **Confirms** (independent evidence): sandbox cannot isolate SW-served sites (WPT source read, spec note, Chromium 156 runs by `04` and here); one origin per site plus PSL (IPFS spec, PSL data); 256 KiB wire cap and `ignore-scripts`/`build.lock.json`; consent before announce; PoW as a fee; `exp`/`seq`/domain-separated signing input (TUF and EIP-155 precedent); payload-outside-hash redaction (Matrix precedent).
- **Corrects:** 4 GiB -> 2 GiB-1 and the test values (R1); PSL SHOULD -> MUST for multi-publisher hubs (R3); `rot` input lacks scope/old key (R11); `rot` signed only by the routine key (R12); unsalted `vh` (R4); site-callable `export`/`consent.accept` (R5).
- **Adds:** request-queue and poisoned-piece handling (R8, R9); SHA-256 anchoring of `files.json` (R10); DoH outside the consent gate (R6); denylist and abuse operations (R7); external canary (R16); admission-control details (R17); DPIA template (R24); path validator (R25); no-wildcard preview experiment (F5/R19).

---

## 5. Gotchas

1. `getUint32` in `bittorrent-protocol` is **signed**: `0x80000000`-`0xFFFFFFFF` look like keep-alives and desynchronise the stream instead of buffering. A guard that reuses the library's own conversion would miss them; read the prefix unsigned.
2. Enforce the length cap **before** buffering: `_write` re-concatenates the whole buffer on every chunk, so a cap checked after accumulation still costs quadratic CPU and RSS (8,212 MiB, about 8.0 GiB, observed with 125 MiB buffered).
3. `sandbox` as an **attribute** and as a **CSP header** behave differently for service workers (WPT): the header lets the SW serve the document but not control it. Do not "fix" hub isolation by switching one for the other.
4. `allow-scripts allow-same-origin` on same-origin content is inert as a boundary (MDN). It still restricts popups, modals and top navigation until the framed page removes the attribute; treat it as hygiene, not isolation.
5. Parent-created `blob:` URLs do not load in an opaque-origin frame (Chromium 156); only blob URLs created inside the frame work. A `srcdoc` frame's base URL is the parent's, so relative requests leave as cross-site `Origin: null` fetches.
6. A wildcard PSL entry (`*.example.net`) makes `ipfs.example.net` a public suffix and `<cid>.ipfs.example.net` a registrable domain; the PSL needs a `_psl` TXT record that must stay, a domain with more than 2 years left, and has no expedite path. Default platform domains (`github.io`, `pages.dev`, `cloudfront.net`, ...) are already listed; custom domains are not.
7. Subdomains of an unlisted hub domain are same-site: they share SameSite cookies, may share a renderer process, and `Domain=hub.example` cookies can be tossed across siblings. The PSL is the fix; the loader must not rely on cookies at all.
8. A hash of personal data is personal data (EDPB 02/2025 para 52). Matrix-style unsalted content hashes and the v0.2 `vh` are fine for integrity and wrong for confidentiality or erasure claims.
9. The Hashcash `nonce` is public inside `e` and survives redaction; it cannot be a salt.
10. `AD:false` is normal (about 95% of .com zones are unsigned); absence is not evidence of an attack, and presence is not independent of the resolver (RFC 4035 4.6).
11. A simple `Range: bytes=N-M` is CORS-safelisted (Fetch Standard) and reached a third-party server without preflight in Chromium 156 and WebKit 27.2; webtorrent's `Cache-Control` and `user-agent` headers force the preflight, so web seeds need `Access-Control-Allow-Headers` for them (`01`) and a hostile `ws=` host sees OPTIONS only.
12. libtorrent's own release notes say enabling WebTorrent "significantly widens the attack surface"; do not co-locate a libtorrent-based seeder with secrets.
13. `rot` as specified lets any holder of the routine signing key rotate silently; a signing key held in CI is a plausible compromise path.
14. The same `owner` key on several domains makes the current `rot` input replayable across them (R11).
15. Tombstones are requests: a hostile replica can keep the payload and the salt. Do not promise erasure; promise "honoured by cooperating copies" (NIP-09 wording; EDPB para 103).
16. IWA, WAICT and signature-based SRI do not help a SW-hosted loader on the open web in 2026; signature-based SRI also needs response headers many static hosts cannot set.
17. `serviceWorker.register()` and `new Worker()` have no `integrity` option; the SW script and the PoW worker cannot be pinned by SRI.
18. `npm audit` shows four "high" findings that are all `ip@2.0.1` and absent from the browser bundle; do not "fix" them by downgrading webtorrent as npm suggests.
19. `ip-set` runs `npx only-allow pnpm` as a `preinstall` script: with scripts enabled that fetches and runs a package during `npm install`.
20. Court press releases were read, not the judgments (EUR-Lex sat behind a bot challenge, BAILII returned 403, Curia is a JS application): no paragraph numbers from the CJEU decisions are quoted here.
21. Public key and fingerprint of an author are themselves pseudonymous identifiers in every stub; GDPR treatment is for counsel.
22. A signed pointer in a hub fragment still lets an attacker choose *which* signed pointer (replay of an old valid one within `exp`); `seq` rollback refusal only works for scopes the visitor has already pinned.

---

## 6. Open questions

1. Do Firefox and Safari match Chromium on the opaque-frame blob behaviour (F5) and on `Range` preflight (F33)? Firefox failed to launch under Playwright here; Safari/iOS were not tried.
2. Why exactly do parent-created blob URLs fail in an opaque-origin frame (blob URL partitioning by storage key is suspected, not shown)?
3. How long does a new PSL entry take to reach stable Chrome, Firefox, Safari and Brave? The Guidelines give no number.
4. Does libtorrent 2.1's WebRTC transport interoperate with browser WebTorrent for v1-only and hybrid torrents, and does qBittorrent 5.3 final enable it by default? (rc1 notes are silent; the claim exists only on webtorrent.org.)
5. A CVE/NVD survey for length-prefix memory exhaustion in BitTorrent clients and similar P2P stacks was not done (search quota); is the webtorrent finding new beyond GitHub's advisories (none)?
6. Are chosen-prefix collisions practical against typical web assets laid out in 256 KiB BitTorrent pieces (JS/CSS/HTML tolerate collision blocks only in comments or strings)? No collision was built.
7. Legal, per jurisdiction: does a non-blocking notice with [OK] satisfy consent for peer sharing, must [Host only] be equally prominent, how do DoH lookups before consent fare, and what is the hub operator's role (controller, joint controller, host)? Needs counsel; CNIL/ICO guidance and EDPB Guidelines 05/2020 were not surveyed.
8. Does EDPB 02/2025 apply to a signed DAG that is not a "blockchain" in the strict sense, and are visitor replicas "nodes" that can be (joint) controllers (paras 43-44)?
9. Which static hosts support wildcard custom domains with wildcard certificates (CloudFront+ACM, Cloudflare, Netlify, GitHub Pages)? Not checked.
10. Will WAICT's integrity manifest cover service workers, workers and dynamic imports? The explainer says they are not addressed.
11. WebAuthn: can pointer signing via a hardware token fit the 255-byte TXT limits and the existing P-256 verifier, and what is the PRF coverage on security keys? Not tested.
12. Safari's `get`-time WebAuthn PRF (BCD says `false` while `create` is 18) - lag or real?

---

## 7. Corrections to earlier documents

| Where | Statement | Correction | Evidence |
|---|---|---|---|
| `docs/review/security.md` B4 | "send a 4-byte prefix of 0xFFFFFFFF ... accumulates up to 4 GiB" | `getUint32` is signed, `0xFFFFFFFF` is a keep-alive; the largest buffering prefix is `0x7FFFFFFF` (2 GiB-1); the cost is also quadratic CPU/allocation | F11 |
| `docs/review/DESIGN-REVIEW.md` item 10, ARCH 12 test 11 | test "a peer declaring a 4 GiB message is dropped within 1 s" | use `0x7FFFFFFF`, `0xFFFFFFFF` and a 300 KiB message; assert CPU and heap | R1 |
| ARCH 1 (v0.2) | "`_onMessageLength` buffers any 32-bit length with no cap" | any positive 31-bit length | F11 |
| ARCH 4 (v0.2) | `rot` input `"mw-rot-v1\n" + new + "\n" + seq` | add scope and old key; consider pre-rotation | F24, F26 |
| ARCH 3.2 (v0.2) | hub suffix "should" be on the PSL | must, for multi-publisher hubs; use a separate registrable domain | F3 |
| ARCH v0.1 13 / `docs/review/ARCHITECTURE-v0.1.md` | "only the publisher could craft colliding content, a non-threat" | true only if every contributor is trusted | F8 |
| `docs/research/01-webtorrent-browser.md` F9 | BEP 52 unsupported in webtorrent | re-verified 2026-10-17; also note libtorrent 2.1.0 | F9 |
| `docs/research/04-service-worker-serving.md` F11 | sandbox/SW matrix | re-verified from the WPT source and spec note; added the CSP-header case split | F2 |

---

## 8. Verification tail

**Verified by reading primary sources or running code (2026-10-17):** installed `bittorrent-protocol@5.0.9`, `uint8-util@2.3.2`, `ut_metadata`, `webtorrent@3.0.21` `lib/torrent.js`/`lib/webconn.js` source; upstream `bittorrent-protocol` master identical; npm registry (`latest` 5.0.9, 2026-07-27); wire PoC (Node 24.22.0); opaque-frame experiments A/B and `Range` preflight experiment C (Playwright Chromium 156.0.8078.4; WebKit 27.2 for C); PSL file grep (list version 2026-10-16); WPT test source; Fetch Standard text; MDN pages; BCD JSON; TUF, did:plc, KERI, Matrix, Fabric, GossipSub, NIP-09/11/13, EIP-155, IPFS specs; EDPB 2/2023 and 02/2025 PDFs; CJEU press releases 112/16 and 105/21; GDPR Recital 30; libtorrent release notes, Atom feeds and docs; npm audit and lockfile; ARCH v0.2 and DESIGN-REVIEW.

**Not verified or only partly:** Firefox behaviour of F2/F5/F33 (cited from `04` for F2 engines); Safari/iOS; browser memory under the wire PoC; the full CJEU judgments and any national law; CNIL/ICO/EDPB consent guidance; WebAuthn spec details; Chromium blob-URL partitioning cause; Safe Browsing's blocking granularity; 2025-2026 cryptanalysis of SHA-1 beyond the cited estimates; CVE/NVD surveys; Sigstore Rekor details; any search result that was not opened (listed in Appendix A).

**Process note:** the shared web-search quota was exhausted partway through the legal and CVE research, so those parts rely on directly fetched primary documents only; no search engine was queried by other means after that.

---

## Appendix A - Sources actually read (all fetched 2026-10-17 unless stated; "source date" is the document's own date where one was visible)

**Platform and specifications**
- https://w3c.github.io/ServiceWorker/ (Editor's Draft, 17 September 2026; only the first 100,000 of 470,256 characters were read: section 2.5.1 note yes, Handle Fetch and Match Service Worker Registration steps no)
- https://raw.githubusercontent.com/web-platform-tests/wpt/master/service-workers/service-worker/sandboxed-iframe-fetch-event.https.html (master)
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/service_worker/service_worker_main_resource_loader_interceptor.cc (main; read through the fetch tool's extraction)
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe ; .../API/ServiceWorkerContainer/register ; .../API/Worker/Worker ; .../HTML/Reference/Elements/script/type/importmap ; .../API/Window/postMessage (all undated) ; .../API/Web_Authentication_API/WebAuthn_extensions (page modified 2026-09-17)
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/script.json ; .../api/CredentialsContainer.json (main)
- https://fetch.spec.whatwg.org/ (living standard; text extracted locally for "CORS-safelisted request-header")
- https://wicg.github.io/signature-based-sri/ (Draft Community Group Report, 8 April 2026)
- https://web.dev/articles/same-site-same-origin (undated) ; https://www.chromium.org/Home/chromium-security/site-isolation/ (undated)
- https://www.rfc-editor.org/rfc/rfc8827.html (WebRTC Security Architecture, January 2021; first 100,000 of 103,991 characters) ; https://www.rfc-editor.org/rfc/rfc4035.html (2005, OLD; first 100,000 of 139,650 characters) ; https://www.rfc-editor.org/rfc/rfc6194.html (March 2011, OLD)
- https://www.bittorrent.org/beps/bep_0052.html (Draft, last modified 2017-08-31, OLD)
- https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/ (undated)

**IPFS, Public Suffix List**
- https://specs.ipfs.tech/http-gateways/subdomain-gateway/ (3 April 2025) ; https://specs.ipfs.tech/compact-denylist-format/ (24 August 2023) ; https://ipshipyard.com/blog/2026-ipfs-gateways-redirect-inbrowser-link/ (11 May 2026)
- https://publicsuffix.org/list/public_suffix_list.dat (VERSION 2026-10-16_23-32-13_UTC; grepped locally) ; https://github.com/publicsuffix/list/wiki/Guidelines (undated)

**SHA-1 and BitTorrent ecosystem**
- https://sha-mbles.github.io/ (2020, OLD) ; https://docs.drand.love/blog/2025/01/31/how-many-5090-to-break-sha1/ (2025-01-31) ; https://www.nist.gov/news-events/news/2022/12/nist-retires-sha-1-cryptographic-algorithm (2022-12-15) ; https://git-scm.com/docs/hash-function-transition (docs for 2.55.0, 2026-06-29)
- https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/bep_support.md ; https://github.com/webtorrent/webtorrent/issues/1117 ; .../issues/703 ; https://github.com/webtorrent/webtorrent/security ; https://github.com/arvidn/libtorrent/security/advisories
- https://github.com/arvidn/libtorrent/releases/tag/v2.1.0 (first 100,000 of 113,560 characters) ; https://github.com/arvidn/libtorrent/releases (first 100,000 of 130,166) ; https://github.com/arvidn/libtorrent/releases.atom ; https://github.com/qbittorrent/qBittorrent/releases.atom ; https://github.com/qbittorrent/qBittorrent/releases/tag/release-5.3.0rc1
- https://www.libtorrent.org/upgrade_to_2.1-ref.html ; https://www.libtorrent.org/reference-Settings.html ; https://www.libtorrent.org/reference-Plugins.html ; https://webtorrent.org/ ; https://webtorrent.io/faq
- https://registry.npmjs.org/bittorrent-protocol (dist-tags and publish times) ; https://raw.githubusercontent.com/webtorrent/bittorrent-protocol/master/index.js ; GitHub issue-search API queries on webtorrent/bittorrent-protocol, webtorrent/webtorrent, webtorrent/ut_metadata (run before the web-search quota was exhausted)
- https://raw.githubusercontent.com/bitcoin/bitcoin/master/src/net.h ; .../src/chain.h

**Precedents for rotation, redaction, admission, replay**
- https://theupdateframework.github.io/specification/latest/ (v1.0.37, last modified 2026-10-08) ; https://web.plc.directory/spec/v0.1/did-plc (v0.3.0, December 2025) ; https://weboftrust.github.io/ietf-keri/draft-ssmith-keri.html (Internet-Draft, 2022, OLD; first 100,000 of 140,830 characters; the Trust over IP URL returned 404)
- https://raw.githubusercontent.com/matrix-org/matrix-spec/main/content/server-server-api.md (Signing Events) ; https://spec.matrix.org/latest/rooms/v11/
- https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html ; https://datatracker.ietf.org/doc/draft-strad-trans-redaction/ (latest revision 2017-01-17, expired) ; https://raw.githubusercontent.com/sigstore/root-signing/main/README.md ; https://docs.sigstore.dev/logging/overview/ (generic, not used as evidence)
- https://raw.githubusercontent.com/libp2p/specs/master/pubsub/gossipsub/gossipsub-v1.1.md (Candidate Recommendation, r8, 2021-12-14; read through the fetch tool's extraction)
- https://raw.githubusercontent.com/nostr-protocol/nips/master/09.md ; .../11.md ; .../13.md ; https://eips.ethereum.org/EIPS/eip-155 (2016-10-14)

**Legal and privacy**
- https://curia.europa.eu/jcms/upload/docs/application/pdf/2016-10/cp160112en.pdf (press release 112/16, Breyer C-582/14, 19 October 2016, OLD) ; https://curia.europa.eu/jcms/upload/docs/application/pdf/2021-06/cp210105en.pdf (press release 105/21, Mircom C-597/19, 17 June 2021)
- https://gdpr-info.eu/recitals/no-30/ (regulation text, non-official mirror)
- https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf (Guidelines 2/2023 v2, 16 October 2024) ; https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf (Guidelines 02/2025 v2, 07 July 2026; page https://www.edpb.europa.eu/documents/guideline/guidelines-022025-on-processing-of-personal-data-through-blockchain_en)
- https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/config/production.yaml.example ; .../default.yaml

**Loader integrity efforts**
- https://blog.cloudflare.com/improving-the-trustworthiness-of-javascript-on-the-web/ (2025-10-16) ; https://hacks.mozilla.org/2026/05/trustworthy-javascript-for-the-open-web/ (2026-05-05) ; https://github.com/beurdouche/explainers/blob/main/waict-explainer.md ; https://github.com/waict-wg/waict-transparency-spec (repository landing page only) ; https://engineering.fb.com/2022/03/10/security/code-verify/ (2022-03-10, updated 2023) ; https://securedrop.org/news/webcat-update-independent-evaluation-waict-and-a-growing-team/ (2026-05-04) ; https://developer.chrome.com/docs/iwa/introduction (last updated 2026-02-06)

**Project files read** (`$HOME/Documents/Projects/magnet-web/`): `docs/ARCHITECTURE.md` (v0.2), `docs/review/DESIGN-REVIEW.md`, `docs/review/security.md`, `docs/review/ARCHITECTURE-v0.1.md` (via the v0.1 copy of the same text), `docs/research/01..06`, `src/loader/render.js`, `src/loader/bridge.js`, `src/loader/torrent.js`, `src/sw/sw.js`, `package.json`, `package-lock.json`, `node_modules/{bittorrent-protocol,uint8-util,ut_metadata,webtorrent}`.

**Seen in search results but not opened (snippet only, not used as evidence):** qbittorrent/qBittorrent issue #4163; LostBeard/SpawnDev.WebTorrent; Wikipedia WebTorrent; blog.libtorrent.org 2020/09 "BitTorrent v2"; a Bird & Bird summary of the EDPB blockchain guidelines (used only to locate the document); eprint.iacr.org/2025/797 (WEBCAT paper); W3C mailing-list thread on WAICT; chromeos.dev IWA pages.

**Fetches that failed or returned nothing usable:** EUR-Lex (bot challenge, not bypassed), BAILII (HTTP 403), Curia judgment pages (JavaScript application), Trust over IP KERI specification (404), Google Security Blog 2012 "Content hosting for the modern web" (article body not returned), Sigstore Rekor overview (generic text), EUR-Lex CELEX pages.

## Appendix B - Experiments and where they live

`docs/research/labs/w1-11-opaque-frame-lab/` (run with `export PATH=$HOME/.local/share/node/current/bin:$PATH`; Playwright 1.64.1 from the project's `node_modules`; scripts import it by absolute path and may need that path adjusted):
- `wire-length-prefix-poc.mjs`, `wire-length-prefix-results-2026-10-17.txt` - F11. Feeds a crafted prefix and 16 KiB chunks to the installed `bittorrent-protocol` parser. Warning: the run takes about 2.5 minutes and drives process RSS above 8 GiB; do not run on a small machine.
- `exp-a-parent-blob-urls.mjs`, `exp-b-frame-builds-own-blobs.mjs`, `results-chromium-156-2026-10-17.txt` - F5. Chromium 156.0.8078.4, headless, localhost HTTP server, no service worker involved.
- `exp-c-range-preflight.mjs`, `results-range-preflight-2026-10-17.txt` - F33. Chromium 156.0.8078.4 and WebKit 27.2 (Firefox failed to launch in this environment, so it was removed from the script's browser list and is not in the results; add `['firefox', firefox]` back to test it).
