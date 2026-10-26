# w2c-03 identity UX: skeptical verification of eight design-critical claims

- **Date:** 2026-10-17. **Subject:** `docs/research/w2c-03-identity-ux.md` (the "source doc") and its lab `docs/research/labs/w2c-03-identity-lab/`.
- **Role:** skeptic. Every claim was re-checked against primary sources fetched directly this session, and every experimental claim was re-run independently.
- **Resume note:** this verification was interrupted earlier. No `w2c-03-identity-ux-VERIFY.md` existed before this file, so it was redone from scratch. Nothing in the source doc, ARCHITECTURE, INTERFACES or the original lab was edited. New evidence (scripts, pages, raw results, README) is archived in `docs/research/labs/w2c-03-identity-lab/verify/`.
- **Limits (read first):**
  - The shared WebSearch budget (200 calls per turn, all agents) was already used up. The first search attempted this session was refused. So there were **no web searches**. (The only queries beyond direct URL fetches were two quicksearch queries for "argon2" on Mozilla's own Bugzilla, made before the refusal; they found only the 2016 meta bug 1310762.) Every check below is a direct fetch of a URL that the claim or the source doc names, or one reachable from it (Gerrit, Bugzilla, bugs.webkit.org, GitHub, npm registry, MDN BCD, chromiumdash and chromestatus APIs). Where a claim needed a source that I could not reach, the text says "unverified".
  - **Firefox is untested** everywhere: the Playwright Firefox build still fails to launch ("Could not find profile folder"), reproduced with the scratchpad TMPDIR, an existing TMPDIR and the default /tmp. No real iPhone or Android. Virtual authenticators are software.
  - Machine: Apple M3 (8 cores), macOS 27, Node 24.22.0, Playwright 1.64.1, Chromium 156.0.8078.4 and WebKit 27.2 (Playwright builds; WebKit 27.2 here is not Safari).
  - Sources dated before 2024 are flagged "older".
- **Verdicts:** confirmed / refuted / nuanced (core holds, a detail or the wording needs correcting) / unverifiable. No claim was refuted outright.

---

## 0. Result at a glance

| # | Claim (short) | Verdict | The correction that matters |
|---|---|---|---|
| 1 | Non-extractable key usable by any same-origin script; opaque sandbox loses IDB and SW | **confirmed** | Re-run in Chromium 156 and WebKit 27.2: the forged signature verifies under the visitor's public key. Stronger than stated: the key object can be structured-cloned to another origin (the spec says so; tested), so "use" is not limited to the page lifetime. |
| 2 | Safari ITP 7-day wipe; Home Screen exempt; persist() heuristics | **nuanced** | The clock is "7 days of Safari use" without interaction, only while Prevent Cross-Site Tracking is on, and the unit is the registrable domain. The doc's copy "after a week without a visit" is inexact. persist() = false reproduced, also in a persistent profile. |
| 3 | open-chat DataCloneError; WebKit lab round trip | **nuanced** | Figures are the 2026-09-10 opening snapshot; October is 7-15 a day, not 5-15. The diagnosis is an unverified, AI-written hypothesis. The Playwright context was NOT "normal": it is incognito-like. A persistent WebKit profile also round-trips keys across restarts. New variant: `indexedDB` missing entirely. |
| 4 | Ed25519 in every engine; P-256 for WebAuthn, did:key, VC | **nuanced** | Engine support confirmed. The "not yet universal" sentence is only in archived ARCHITECTURE-v0.1; v0.2 does not repeat it, so R10 is moot. P-256 is not the only curve in those ecosystems (WebAuthn L3 lists EdDSA first; `eddsa-jcs-2022` is a W3C Rec; did:key's flagship example is Ed25519). |
| 5 | Argon2 not in Chrome's shipping WebCrypto set | **confirmed** | Ship milestone moved from 154 (Intent text) to 155 (chromestatus, updated 2026-09-11). Installed Chromium 156 has ML-KEM, ML-DSA, ChaCha20-Poly1305, X-Wing and no Argon2. WebKit's umbrella position is neutral with explicit Argon2 reservations; its "support" was for the separate X-Wing issue. JS-vs-WASM ratio reproduced (4.7x to 5.9x). |
| 6 | SSB forks; ARCHITECTURE seq harmless; 06 draft would fork | **confirmed** | The "not opened" SSB sources are now opened and say it. 06's strict rule is worse than a fork: all later ops of a cloned key are ignored. SSB sources are older (2021 draft, 2023 archive). |
| 7 | PRF support matrix | **nuanced** | Most rows hold. Corrections: Windows Hello "Feb 2026 / KB5077181" is not in Microsoft's KB text; the Apple hybrid-PRF bug has a 2026 recurrence report; iOS security-key PRF still has an open bug; MDN BCD is stale for Safari; Dashlane needs a role qualifier. |
| 8 | PRF semantics and lab | **confirmed** | Spec text matches. Add: only the with-UV PRF is exposed; `eval` at create() does return results in the virtual authenticator; FIDO CXF can carry hmac-secret material, so provider migration need not destroy the key. |

---

## 1. Claim 1: a non-extractable key in the loader origin's IndexedDB is usable by any same-origin script

**Claim.** In Chromium 156 a `sandbox="allow-scripts allow-same-origin"` iframe read the visitor's non-extractable CryptoKey from IndexedDB and signed arbitrary bytes; `exportKey` is refused but signing is not. A `sandbox="allow-scripts"` iframe gets `SecurityError` on `indexedDB.open` but also loses Service Worker control.

**Verdict: confirmed (with one extension that makes it worse).**

**Evidence.**
1. Spec, WebCrypto Level 2 editor's draft, 11 August 2026, Security considerations (https://w3c.github.io/webcrypto/): "The only requirement is that key material is not exposed to script, except through the use of the exportKey and wrapKey operations." Same-origin scope: "any application that shares the same scheme, host, and port have access to the same storage partition".
2. Independent re-run (`verify/e1.mjs`, results `verify/results/e1-chromium.json`, `e1-webkit.json`). A loader page stores a non-extractable ECDSA P-256 pair in IndexedDB and registers a Service Worker; three frames then try to use it.

| Frame | Chromium 156.0.8078.4 | WebKit 27.2 |
|---|---|---|
| `allow-scripts allow-same-origin` | found key, `extractable:false`, 64-byte signature that **verifies under the visitor's public key**, `exportKey` -> `InvalidAccessError`, SW controlled (`fetch('/who')` = "sw") | identical |
| no sandbox | identical | identical |
| `allow-scripts` (opaque origin) | `SecurityError: Failed to execute 'open' on 'IDBFactory': access to the Indexed Database API is denied in this context.`; `navigator.serviceWorker` -> `SecurityError`; `fetch('/who')` = "network" | `SecurityError: IDBFactory.open() called in an invalid security context`; `navigator.serviceWorker` -> `SecurityError`; `fetch('/who')` = "network" |

   The SW half of the claim is sourced in the source doc from 04 F11 (WPT results), not from lab2; the re-run above reproduces it in two engines.
3. **Extension (not in the claim): the capability can leave the origin.** Same Security considerations: "Applications may share a CryptoKey object across security boundaries, such as origins, through the use of the structured clone algorithm and APIs such as postMessage ... once a key is shared with a destination origin, the source origin can not later restrict or revoke access to the key ... in the event of script injection on the source origin, attackers may post the key to an origin under attacker control. Any time that the user agent visits the attacker's origin, the user agent may be directed to perform cryptographic operations using that key". Tested (`verify/e4.mjs`): hostile same-origin code posted the non-extractable private key to a different origin (`localhost` -> `127.0.0.1`); the receiving origin got `type:"private"`, `extractable:false`, stored it in its own IndexedDB and signed with it, in both Chromium 156 and WebKit 27.2. In Chromium a fresh top-level attacker page later read the key from that IndexedDB and produced a signature that verified under the visitor's public key (`exportKey` still refused). **Caveat:** Playwright launches Chromium with `--disable-features=...ThirdPartyStoragePartitioning...` (playwright-core 1.64.1, `lib/coreBundle.js` around line 36187), so that persistence is an artifact of unpartitioned third-party storage; in WebKit (partitioned) the later top-level attacker page found no object store (`NotFoundError`). Stock Chrome with partitioning on was not tested. What is established: the `CryptoKey` can be handed to another origin and used there.

**Corrections and nuance.**
- 06 F51 says a same-origin script can sign "while the page is open". The spec text and the E4 run show the capability can be cloned out, so the right statement is "while the attacker holds a reference or a stored copy", not "while the page is open".
- `allow-scripts allow-same-origin` gives no isolation (Chromium logs "can escape its sandboxing", quoted in 04 F11); consistent with the claim.
- Firefox untested.

**Impact on the source doc.** F1 and R7 stand. Add the clone-out sentence to F1 and to the privacy copy ("the site you are on can act as you, and can hand that ability to another origin").
**Confidence:** High (spec + two-engine reproduction); Medium for the E4 persistence part (Playwright flag).

---

## 2. Claim 2: Safari ITP deletes script-writable storage after 7 days without interaction; persist() heuristics

**Claim.** ITP deletes all script-writable storage (IndexedDB, localStorage, Service Worker registrations and caches) after 7 days without user interaction (click, tap, keyboard; scrolling does not count); Home Screen web apps are exempt. Eviction removes all of an origin's data at once; `navigator.storage.persist()` is auto-decided by heuristics in Safari and Chromium and prompts in Firefox; it returned false in both headless engines.

**Verdict: nuanced (every element is supported; three qualifiers change how the UX copy must be written).**

**Evidence.**
- https://webkit.org/tracking-prevention/ (fetched 2026-10-17): "ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website. The latter storage forms are: IndexedDB, LocalStorage, Media keys, SessionStorage, Service Worker registrations and cache". "User interaction is a user click, tap, or keyboard entry on a website ... Scrolling is not considered user interaction." "The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage".
- https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24, older, the origin of the rule): "deleting all of a website's script-writable storage after **seven days of Safari use** without user interaction on the site"; home-screen web apps "have their own counter of days of use".
- https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria (current): "Safari proactively evicts data when **cross-site tracking prevention is turned on**. If an origin has no user interaction, such as click or tap, in the last seven days of **browser use**, its data created from script will be deleted." "When an origin's data is evicted by the browser, all of its data, not parts of it, is deleted at the same time." "In Firefox, when a site chooses to use persistent storage, the user is notified with a UI popup"; "Safari and most Chromium-based browsers ... automatically approve or deny the request based on the user's history of interaction with the site".
- https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10): "WebKit currently grants a request based on heuristics like whether the website is opened as a Home Screen Web App." https://web.dev/articles/persistent-storage: Chromium heuristics are site engagement, installed or bookmarked, notification permission.
- Re-run (`verify/e2.mjs`, `verify/results/e2-persistence.txt`): `persisted()` and `persist()` both **false** in Chromium 156 and WebKit 27.2, in Playwright's default context and in a persistent profile.

**Corrections.**
1. **The clock counts days of Safari use, not calendar days** (2020 blog and MDN both say "of Safari/browser use"). The current WebKit page and the source doc's F2 wording ("after 7 days of no user interaction") drop that qualifier. The source doc's UX copy "Safari does this after a week without a visit" (section 4.2 step 3) is therefore inexact. Suggested wording: "Safari can erase this site's saved data if you use Safari on 7 days without tapping or typing on this site." The exact implementation of "days of use" is not documented beyond that sentence: unverified.
2. **Condition:** applies when Prevent Cross-Site Tracking is on (default). MDN states the condition; the 7-day section of the WebKit page does not.
3. **Unit:** ITP deletes "a website's" storage; WebKit defines a website as a registrable domain including all subdomains (same page, Terminology). MDN's "origin" wording is for eviction in general. Inference, not tested: interaction on any subdomain should reset the clock for all subdomains of that registrable domain, which matters for wildcard-subdomain hubs unless the hub suffix is on the Public Suffix List.
4. `persist()` in Safari is granted only on heuristics; the one WebKit names is being a Home Screen web app ("heuristics like whether the website is opened as a Home Screen Web App"). Do not depend on it in a normal tab, and show `persisted()` truthfully as R4 already says.

**Confidence:** High on the rule; Medium on the three qualifiers' UX consequences (documented, not tested on a device).

---

## 3. Claim 3: CryptoKey persistence fails in the wild on iOS Safari (open-chat #9343)

**Claim.** open-chat reports `DataCloneError` persisting an ECDSA CryptoKeyPair in IndexedDB: 254 occurrences, 88 IPs, five months, 5-15 per day in Oct 2026; suspected private browsing or Lockdown Mode, unverified, no fix. Playwright WebKit 27.2 round-tripped non-extractable P-256 and Ed25519 pairs in a normal context, so the failure is environment-specific and unreproduced.

**Verdict: nuanced (the issue is real; two framing errors and one design gap).**

**Evidence** (https://github.com/open-chat-labs/open-chat/issues/9343, fetched 2026-10-17; opened 2026-09-10 by a repo collaborator, label `bug`, open):
- Body: "Rollbar #30870 DataCloneError: The object can not be cloned. 254 occurrences from 88 IPs over five months, about 5 a day, still on 2.0.2054. Almost all iOS Safari (latest: Safari 26.6.1 on iOS 18.7)". "The most likely environment is Safari private browsing ... Lockdown Mode may behave the same. Not verified against a device". The issue text ends "Generated with Claude Code": the diagnosis was written by an AI session.
- Comments: 2026-10-02 "12 occurrences from 12 IPs in the last day, against about 5 a day the week before"; 10-04 "about 7 a day"; 10-09 8 in a day; 10-12 "11 in total against 15 the day before"; 10-14 12 (yesterday 10); 10-17 "10 occurrences in total ... all iOS. Flat". 10-02: "Nothing on master touches this path yet. It still waits on the decision about a Safari key-storage fallback." No fix reported through 10-17.
- Second failure mode in the same issue: `ReferenceError: Can't find variable: indexedDB` (#32017: 3 occurrences from 3 IPs, iOS and Mac Safari; #31804 the same on 2.0.2054; #32087 iOS, 2026-10-17) and `indexedDB is not defined` on a Windows browser that also had a stubbed canvas (#32041, 2026-10-07, which the maintainers read as a hardened or automated environment).
- Apple's Lockdown Mode page (https://support.apple.com/en-us/105120) says only "Certain complex web technologies are blocked"; it does not mention IndexedDB or CryptoKey storage. The Lockdown hypothesis has no primary support.
- Lab: `docs/research/labs/w2c-03-identity-lab/lab4-engines.mjs` creates its context with `browser.newContext()`. Playwright documents contexts as "equivalent to incognito-like profiles" (https://playwright.dev/docs/browser-contexts) and `launchPersistentContext` as the persistent variant (https://playwright.dev/docs/api/class-browsertype). Re-run (`verify/e2.mjs`): after closing and relaunching, the default context in both Chromium 156 and WebKit 27.2 has **lost** its localStorage marker and IndexedDB records; a persistent profile keeps them, and the non-extractable ECDSA P-256 and Ed25519 pairs **read back and sign after a full browser restart** in both engines (64-byte signatures, verify true, `extractable:false`).

**Corrections.**
1. "254 occurrences, 88 IPs, five months" is the opening snapshot for Rollbar item #30870 only. October daily counts across the three items are about 7 to 15, not 5 to 15; "about 5 a day" is the September baseline.
2. "in a normal context" is wrong for the lab: it ran in Playwright's incognito-like default context. That is, if anything, weak counter-evidence to the private-browsing hypothesis for a desktop WebKit test build, but Playwright's WebKit is a macOS build, not iOS Safari, so neither the private-browsing nor the Lockdown hypothesis is tested. "Environment-specific and unreproduced" remains the right conclusion.
3. Design gap: R2's seed fallback needs storage too. If `indexedDB` is undefined or throws (the second variant), a persisted seed cannot be saved either. The identity layer needs a memory-only mode and a UI state "this browser cannot keep an identity", and R11 should test "IndexedDB undefined" and "open() throws".

**Impact on the source doc.** Edit F3 (counts, context wording, second variant) and add to R2/R11. **Confidence:** High on the facts above; the root cause stays unknown.

---

## 4. Claim 4: Ed25519 is in WebCrypto in every major engine; algorithm choice and tagging

**Claim.** Safari 17.0, Firefox 129 (Aug 2024), Chrome 137 (May 2025), so ARCHITECTURE s6.1's "Ed25519 not yet universal" is stale; P-256 remains the curve of WebAuthn ES256, did:key `zDn` keys and the VC `ecdsa-jcs-2019` suite, so the choice should be deliberate and tagged.

**Verdict: nuanced.**

**Evidence.**
- MDN browser-compat-data, fetched 2026-10-17 (https://bcd.developer.mozilla.org/bcd/api/v0/current/api.SubtleCrypto.json; keys `generateKey.ed25519`, `sign.ed25519`, `verify.ed25519`, `importKey.ed25519`, `exportKey.ed25519`): Chrome 137 (2025-05-27), Edge 137 (2025-05-29), Firefox 129 (2024-08-06), Safari and iOS 17 (2023-09-18), Samsung Internet 30.0 (2026-05-11), WebView Android 137. Safari note on `sign`: "Generates randomized signatures as per draft-irtf-cfrg-det-sigs-with-noise, instead of deterministic signatures as per RFC 8032."
- https://blog.ipfs.tech/2025-08-ed25519/ (2025-08-13): "Ed25519 is now supported in every major browser engine, reaching 79% and counting of web users"; "around 2027" before it can be relied on in most users' browsers. So "universal" is true per engine, not yet per user.
- Re-run: Ed25519 `generateKey`, IndexedDB round trip and signing work in Chromium 156 and WebKit 27.2 (`verify/results/e2-persistence.txt`, `e5-*.txt`).

**Corrections.**
1. **Where the stale sentence lives.** "Identity: ECDSA P-256 (universal WebCrypto support; Ed25519 is not yet universal)" is at `docs/review/ARCHITECTURE-v0.1.md` line 199 (the archived v0.1). The live `docs/ARCHITECTURE.md` is v0.2 (2026-10-17) and does not contain "Ed25519" or "universal" anywhere; s6.1 now just says "Identity: ECDSA P-256". So R10's "ARCHITECTURE s6.1 ... is stale" is a no-op for the live file (the w2c-06 doc already recorded this: lines 21, 300 and 489). What remains true: v0.2 fixes P-256 in `author` and `owner=` without stating the reason.
2. **P-256 is not the only curve in those ecosystems.**
   - WebAuthn Level 3 (W3C Recommendation 2026-08-25, https://www.w3.org/TR/webauthn-3/): "Relying Parties that wish to support a wide range of authenticators SHOULD include at least the following COSEAlgorithmIdentifier values: -8 (EdDSA), -7 (ES256), -257 (RS256)"; user agents MUST return a non-null `getPublicKey()` for ES256, RS256 and EdDSA (Ed25519). The argument for P-256 is what platform authenticators actually produce (I could not verify that with a primary source: unverified), not the spec.
   - did:key v0.9 (https://w3c-ccg.github.io/did-key-spec/): multicodec `0xed` (Ed25519) and `0x1200` (P-256 compressed) are both defined; the flagship example is Ed25519 (`z6Mk...`), P-256 gives `zDn...`.
   - W3C Data Integrity EdDSA Cryptosuites v1.0 is a Recommendation of the same date as the ECDSA one (2025-05-15, https://www.w3.org/TR/vc-di-eddsa/) and defines `eddsa-rdfc-2022` and `eddsa-jcs-2022`; `ecdsa-jcs-2019` (https://www.w3.org/TR/vc-di-ecdsa/) is one of two JCS suites, not the only one. So VC and DID alignment do not favour P-256; only the WebAuthn root-delegation idea does, and that idea cannot sign arbitrary bytes today (F18).
3. User-level coverage lags: 79% of users in 2025-08 (IPFS blog citing caniuse); Samsung Internet only from 30.0 (2026-05-11). 06 s3.1.11 already plans iOS 16 and WebView < 137 in the device matrix.

**Impact.** Keep F4's recommendation (tag `author`, decide deliberately). Reword R10 ("v0.1 sentence only; v0.2 needs a one-line rationale for P-256"). **Confidence:** High on engine support and spec status; Medium on the platform-authenticator point.

---

## 5. Claim 5: Argon2 is not in the WebCrypto set Chrome is shipping

**Claim.** The Intent to Ship (2026-09-02, Chrome 154) lists ML-KEM, ML-DSA, ChaCha20-Poly1305 and X-Wing only; the WICG draft (2026-09-14) includes Argon2d/i/id but is an unofficial proposal; Mozilla's position is neutral. So browser Argon2 means WASM (hash-wasm 4.12.0, 11 kB gzipped) or JS (noble-hashes, about 6x slower and outside its Cure53 audit), or scrypt/PBKDF2; the KDF choice becomes part of any backup-file compatibility promise.

**Verdict: confirmed (one detail corrected, one reinforced, one position misattributed in the source doc).**

**Evidence.**
- Intent to Ship, `blink-dev`, Wed 02 Sep 2026 (http://www.mail-archive.com/blink-dev@chromium.org/msg17349.html): "ML-KEM - 768, 1024 * ML-DSA - 44, 65, 87 * ChaCha20-Poly1305 * X-Wing"; no Argon2. Approved 2026-09-09: LGTM1 Rick Byers (msg17412), LGTM2 Chris Harrelson (msg17411), LGTM3 Philip Jagenstedt (msg17413, msg17419).
- WICG draft (https://wicg.github.io/webcrypto-modern-algos/): "Draft Community Group Report 14 September 2026", "Latest published version: none", "This is an unofficial proposal." Section 17 registers `Argon2d`, `Argon2i`, `Argon2id` with `Argon2Params {nonce, parallelism, memory, passes, version, secretValue, associatedData}`; the usage example feature-detects with `SubtleCrypto.supports?.('importKey', 'Argon2id')`.
- **Direct test of what an engine ships** (`verify/e5.mjs`, `results/e5-*.txt`): Chromium 156.0.8078.4 supports ML-KEM-768/1024, ML-DSA-65, ChaCha20-Poly1305, `MLKEM768-X25519` (X-Wing) and Ed25519; Argon2id (`importKey` with `raw-secret` and `raw`), scrypt and SHA3-256 throw `NotSupportedError`; `SubtleCrypto.supports('importKey','Argon2id')` = false and `supports('generateKey','ML-KEM-768')` = true. WebKit 27.2 (Playwright build) supports none of the new set, has no `SubtleCrypto.supports`, and supports only Ed25519 of the probes.
- Positions. Mozilla #1282 (https://github.com/mozilla/standards-positions/issues/1282): `position: neutral`, 2025-08-14: "Many applications will be better served by supplying a WASM cryptographic algorithm that can be run synchronously." WebKit #641 (https://github.com/WebKit/standards-positions/issues/641): `position: neutral` (2026-04-16); on 2026-04-08: "We have reservations about including Argon2 in WebCrypto, as its memory-hard design raises resource consumption concerns in the browser environment." Mozilla's Frosne on that issue, 2026-03-26: "we are looking at adding ML-KEM, ML-DSA, ChaCha20-Poly1305, and SHA-3. Maybe at some point we will add Argon2, but not soon." Bugzilla's meta bug 1981476 ("Modern Algorithms in WebCrypto support", NEW, updated 2026-09-21) has one dependency (2074087, ML-KEM jwk/pkcs8); the only Argon2 bug found is the 2016 meta bug 1310762 (NEW, last changed 2023-12-11).
- Libraries. hash-wasm README table: "Argon2: Argon2d, Argon2i, Argon2id (v1.3) 11 kB" gzipped; npm latest 4.12.0, published 2024-11-19 (https://registry.npmjs.org/hash-wasm); the README makes no audit statement. `@noble/hashes` latest 2.4.0 (2026-08-27); README: "Argon2 can't be fast in JS, because there is no fast Uint64Array. It is suggested to use Scrypt instead. Being 5x slower than native code means brute-forcing attackers have bigger advantage." and "audited ... at version 1.0.0, in Jan 2022, independently, by Cure53 ... Scope: everything, besides blake3, sha3-addons, sha1 and argon2, which have not been audited" (older audit).
- Speed ratio re-run (`verify/kdf/`, M3, quiet run): Chromium 156: WASM 19 MiB t=2 20 ms vs noble 111 ms (5.5x); 64 MiB t=3 111 ms vs 520 ms (4.7x). WebKit 27.2: 21 vs 123 ms (5.9x); 109 vs 551 ms (5.1x). Node 24.22.0: 5.5x and 4.9x. noble scrypt N=2^16: 120 to 125 ms. A first run under machine load (other agents were using the machine) gave 4.2x to 5.2x in the browsers and 5.9x and 3.2x in Node; absolute times varied by up to 1.5x, the ratio much less.

**Corrections.**
1. **Milestone.** The Intent text says "Shipping on desktop 154". Chrome Platform Status (https://chromestatus.com/api/v0/features/5198951632470016, updated 2026-09-11) now lists the shipping stage at **155** for desktop, Android and WebView (origin trial 151 to 154). chromiumdash: M154 stable 2026-09-22, M155 stable 2026-10-06, M156 stable 2026-10-20 (https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=155). I did not test a stable 155 build; the installed 156 build has the set on by default.
2. **WebKit "support" is the wrong issue.** The source doc F6 relays Daniel Huigens' 2026-09-03 reply (msg17363): "WebKit have resolved their standard position with 'support'". That position is WebKit #704 "Web Crypto: Hybrid KEMs" (X-Wing), `position: support` on 2026-09-02 ("We are looking at implementing X-Wing"). The umbrella proposal stays neutral, with the Argon2 reservation above. This strengthens the claim's conclusion.
3. **Mozilla** is neutral, but the Intent adds "Despite being neutral, Firefox is shipping anyway" without naming algorithms; Mozilla's own comment lists ML-KEM, ML-DSA, ChaCha20-Poly1305 and SHA-3 as the ones it is looking at, and Argon2 as "not soon".
4. **"About 6x"** holds for 19 MiB t=2 (5.5x to 5.9x). At the profile the source doc recommends (64 MiB, t=3) it is about 5x (4.7x to 5.1x), about 520 to 550 ms for noble versus about 110 ms for WASM. Gotcha 10 should give both.
5. hash-wasm is 23 months since its last release and unaudited; noble's audit is of v1.0.0 (2022) and excludes argon2.

**Impact.** F6, F7, R3 stand. Put the KDF id and its parameters in the backup header; the WICG `SubtleCrypto.supports` check gives a future native path, and the WASM output must stay byte-identical (use the RFC 9106 test vectors). **Confidence:** High.

---

## 6. Claim 6: same key on two devices forks a linear feed (SSB); the repo's DAG tolerates it, the 06 envelope does not

**Claim.** SSB forks a linear feed when two devices post with one identity (clients tell users not to); later proposals use per-device keys with consent and proof messages. ARCHITECTURE s6.1 uses a DAG with informational `seq`, so cloning is harmless, but the 06 draft's strict per-author `s` and previous-op `p` would fork on a cloned key. (Their confidence: medium; SSB pages "not opened".)

**Verdict: confirmed.** The SSB pages are now opened and say what the claim says.

**Evidence.**
- Manyverse FAQ (undated, current): https://www.manyver.se/faq/account-on-many-devices/: "Sorry, you cannot. ... Some people misuse the 24-word recovery feature to have the same account authoring messages on several devices, but this is risky: it can 'fork' your account and cause it to be irrecoverably stuck. The recovery from 24 words is only intended for bringing back your account once it has been lost ... You have to create a separate account for each device. In the future, we plan to have an easy feature to automatically 'bind' all of your accounts together". This is exactly the failure the source doc's recovery phrase would invite.
- Scuttlebutt Protocol Guide (https://ssbc.github.io/scuttlebutt-protocol-guide/): "Each message (except the first one) references the ID of the previous message"; "Fusion Identities solve the challenge of using multiple devices with Secure Scuttlebutt. Each device still uses it's own identity, there is no avoiding that".
- Fusion Identity Spec v1 DRAFT (https://github.com/ssbc/fusion-identity-spec; meeting notes dated 2021-04 to 2021-07, so older): `init`, `invite`, `consent(yes)`, `entrust(sk)`, `proof-of-key`; "Only new members can be added to a fusion, there is no removal of members only tombstoning."
- Metafeeds spec (https://github.com/ssbc/ssb-meta-feeds-spec; repository archived 2023-03-09, older): "A metafeed is tied to a single identity and thus should only be used on a single device. There is a separate fusion identity protocol that only deals with how to relate multiple devices to a single identity."
- Repo. ARCHITECTURE v0.2 s6.1: `seq: <uint, informational>`; `docs/review/DESIGN-REVIEW.md` S9: "`seq` is informational and never validated"; s6.3 validation has no per-author uniqueness rule; s6.5: `put` is last-writer-wins in total order, `profile` sets the author's name. 06 (`docs/research/06-browser-chain-vs-crdt.md`) s3.1.2: `s` "starts at 1, strictly +1", `p` the author's previous op; validity rule 7 (line 433): "**No equivocation**: if the set contains two different ops with the same `(a, s)`, every op of `a` with sequence >= `s` is **ignored**."

**Nuance.**
- "Harmless" means harmless for validity in v0.2. Clones still interleave deterministically (last-writer-wins `put`, `profile`), share one author throttle (local, 30 blocks per 10 minutes), and a `ban` or `tombstone` by the author hits both devices. Surprising, not breaking.
- Under the 06 draft the result is worse than a fork: the cloned key's later ops are all ignored, and only a new key recovers (the same "irrecoverably stuck" as the Manyverse FAQ).
- The "later proposals" are a 2021 draft and an archived 2023 spec: SSB shows the problem, not a finished solution. Treat as older evidence.

**Impact.** R9 stands (decide now). Cite the Manyverse FAQ in F9 and drop the "snippets only" caveat. **Confidence:** High.

---

## 7. Claim 7: PRF support is uneven and should be an enhancement, not a dependency

**Claim.** Apple Passwords and Google Password Manager work (Safari 18+/iOS 18.4+, Android Chrome/Edge/Samsung Internet); Windows Hello lacked hmac-secret until a Feb 2026 update (then Chrome/Edge 147+ and Firefox 148+); 1Password works; Bitwarden is partial; Dashlane does not support it; security-key PRF on iOS needs 26.4+; iOS 18.0-18.3 had data-loss bugs as a cross-device source; a capability flag is not a guarantee. Vendor-sourced (Corbado), cross-checked only against Yubico's mid-2025 table.

**Verdict: nuanced.** The conclusion ("enhancement, not dependency") is strengthened. Individual rows need the qualifiers below. The vendor article is https://www.corbado.com/blog/passkeys-prf-webauthn (created 2025-04-16, updated 2026-09-29), which itself says its community percentages are "small samples ... a direction, not a benchmark".

| Sub-claim | Verdict | Evidence from primary or independent sources |
|---|---|---|
| Apple Passwords works, Safari 18+ | confirmed | WebKit, "Safari 18.0": "adds support for the WebAuthn prf extension" (https://webkit.org/blog/15865/webkit-features-in-safari-18-0/; Safari 18 shipped 2024-09-16 per MDN BCD). Chromium CL 6001891, 2024-11-06 (commit message, paraphrased): Chromium matches Safari's output on macOS 15 at creation and at assertion, so iCloud Keychain PRF is default-enabled ahead of the 132 branch. **Stale data to ignore:** MDN BCD (`api.CredentialsContainer.get.publicKey_option.extensions.prf`) marks Safari `get()` as unsupported with `impl_url` webkit.org/b/259934, but that WebKit bug is RESOLVED FIXED (last change 2026-01-09), and Yubico and Corbado both show Safari get() working. |
| iOS 18.4+ fixed; 18.0-18.3 had "data loss" as a cross-device source | confirmed, with a caveat | Apple Developer Forums thread 764730 (https://developer.apple.com/forums/thread/764730; read via WebFetch because curl hits a verification page): Apple engineer, Feb 2025: "Yes this was a bug. The PRF values returned over hybrid should match the ones returned locally for the same input. This issue should be fixed in the current iOS 18.4 and macOS 15.4 betas." The "data loss" is key mismatch: data encrypted under the wrong hybrid output cannot be decrypted after upgrading, not Apple deleting anything. **Caveat:** a 2026-04 post in the same thread reports the same hybrid-vs-local mismatch on iOS 26.3.1(a) with Chrome 146 on Windows 10 (PRF `07f318...` locally, `2444f1...` over hybrid), filed as FB22434584, with no Apple reply shown. Not proven recurring, not shown fixed. |
| Google Password Manager; Android Chrome/Edge/Samsung Internet | unverified at the first party | Corbado only ("every passkey stored in GPM supports PRF", 91-100% on create, 100% on get in its demo data). The Google pages I opened (https://developers.google.com/identity/passkeys/supported-environments, https://developer.android.com/identity/passkeys, https://developer.android.com/identity/sign-in/credential-manager) never mention PRF. API level only: MDN BCD has Chrome and Chrome Android 116, Samsung Internet 24.0, Firefox Android 149 (Bugzilla 1958716, fixed in 149). |
| Windows Hello lacked hmac-secret until a Feb 2026 update; Chrome/Edge 147+; Firefox 148+ | **nuanced** | Lack until recently: Yubico (mid-2025) "Windows Hello lacks hmac-secret". The "Feb 2026 update" is Corbado's attribution to KB5077181 (builds 26100.7840 and 26200.7840). **Microsoft's own KB5077181 text (2026-02-10) lists only [Gaming], [Networking] (WPA3-Personal) and [Secure Boot] improvements; it does not mention WebAuthn, passkeys, Windows Hello or hmac-secret.** The Bitwarden community post Corbado cites (https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236/21, "Wall-E", 2026-03-23; read via WebFetch because the forum blocks crawlers) reports "Windows Hello seems to be returning PRF assertion values regardless of whether PRF was requested during creation" on **build 26200.8037**, which Microsoft's list maps to the 2026-03-10 update KB5079473, and names no KB. Independent traces of the platform plumbing: microsoft/webauthn commit "Update API Version to WEBAUTHN_API_VERSION_8" adds PRF `eval` (HMAC-SECRET salts) to make-credential and get-assertion options; Firefox bug 1993280, filed 2025-10-08 by a Microsoft engineer: "PRF Evaluation at credential creation time is supported on Windows when WebAuthNGetApiVersionNumber() API returns WEBAUTHN_API_VERSION_8 or higher" (fixed in Firefox 147, target "147 Branch", not 148); Chromium CL 7569106 (2026-02-17) "disabled by default as we need to test it on a machine that has a current version of Windows 11" and CL 7600513 (2026-02-23) "PRF on create seems to be working fine on Windows 11. Enable the feature by default." So "Windows Hello returns PRF values on current Windows 11 24H2/25H2, via Chrome/Edge 147+ (create) or Firefox 147/148+" is supported; "because of KB5077181 on 2026-02-10" is **unverified**. |
| 1Password works | confirmed | 1Password blog, 2024-07-18 (https://1password.com/blog/encrypt-data-saved-passkeys): PRF in Android beta 8.10.38 and browser-extension beta 2.26.1, "will also be available on iOS 18". Corbado test: macOS 26.3 + Chrome 150, identical value at create and get. A "June 2026 regression" thread in the source doc was not opened: unverified. |
| Bitwarden partial | vendor-only | Corbado: no PRF result on macOS 26.3 + Chrome 151; demo data 100% on get (Linux Firefox), 29% (Android), 0% (iOS Safari). A discussion in Bitwarden's GitHub org (#13838, 2025-03-14, started by a community contributor, not an official statement) says the browser extension "at the moment ... lacks support for the PRF extension" as a passkey provider; no Bitwarden first-party statement found. |
| Dashlane does not support it | confirmed, role-qualified | Corbado s5.3.1 separates two roles: as a relying party "Dashlane and Bitwarden have both shipped" PRF for their own vault; as a provider Dashlane "returns nothing to third-party sites" (tested macOS 26.3 + Chrome 151 and again August 2026). The claim should say "does not return PRF results to relying parties". |
| security-key PRF on iOS needs 26.4+ | confirmed; 26.4 is necessary, not sufficient | WebKit, "Safari 26.4" (https://webkit.org/blog/17862/webkit-features-for-safari-26-4/, 2026-03-24): "The PRF extension enables credential-bound cryptographic secrets during both credential creation and authentication flows with security keys." Yubico mid-2025: roaming keys unsupported on iOS. Open defects: WebKit 311099 (encrypted hmac-secret returned undecrypted; reporter 2026-04-09: "Confirmed to be fixed in Safari TP 241", tracker status still NEW) and WebKit 314934 (null PRF for YubiKey C Bio; open; a 2026-10-16 comment reproduces it on iOS 27.0.1 through AuthenticationServices). |
| a capability flag is not a guarantee | confirmed | Corbado s5.3.6: Chrome reported `extension:prf` supported while Bitwarden and Dashlane returned no result; the reverse for Enpass (flag false, PRF worked); create and get are separate (Samsung Pass: nothing at create, value at get; Microsoft Password Manager: create ok, get fails with `NotAllowedError`). Consistent with WebAuthn L3, where `enabled` is reported only at registration. Vendor-tested, small samples. |

**Cross-check status.** The "only Yubico" caveat can be retired for Apple, Windows platform plumbing, 1Password and iOS security keys (sources above). It stays for GPM, Bitwarden, Dashlane, Samsung Pass, Microsoft Password Manager and every percentage: Corbado is the sole source.

**Impact on the source doc.** F15 table: change the Windows Hello row ("KB5077181" -> "Feb to Mar 2026 Windows 11 24H2/25H2 builds; attribution unverified; Firefox 147/148"), the iOS row (add WebKit 314934 and the FB22434584 report), the Dashlane row (role), and note that MDN BCD is stale for Safari `get`. Add the Apple forum thread to F16 as evidence on cross-device equality. **Confidence:** Medium-High on the conclusions, Medium on row-level detail.

---

## 8. Claim 8: PRF semantics and the virtual-authenticator lab

**Claim.** Per-credential 32-byte secret, salts hashed with a fixed prefix, access enforced by RP ID, constant per credential so nonces must be unique, `second` input for rotation. In a Chromium virtual CTAP2 authenticator `create({prf:{}})` returned `enabled:true` with no results, `get()` returned 32 stable bytes, a different salt gave a different value, a second credential gave a different secret. Deleting the credential destroys the derived key.

**Verdict: confirmed (spec and lab both reproduce; four precision points and one correction to F19).**

**Evidence.**
- WebAuthn Level 3 s10.1.4 (https://www.w3.org/TR/webauthn-3/, Recommendation 2026-08-25): "The PRFs provided by this extension map from BufferSources of any length to 32-byte BufferSources." Salt: `SHA-256(UTF8Encode("WebAuthn PRF") || 0x00 || eval.first)`, same for `second`. `enabled` "is only reported during registration and is not present in the case of authentication"; registration "Outputs may not be available during registration".
- Explainer (https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md): "per-credential, 32-byte secret key"; "the PRF evaluation points are hashed with a fixed prefix"; "Access control is enforced based on RP ID"; "Since the key will be constant for a given credential, it's vitally important to ensure the the nonce used when encrypting is unique."; two inputs allow "automatic key rotation"; "it can never be triggered silently".
- Re-run, Chromium 156.0.8078.4 CDP virtual CTAP2.1 authenticator with `hasPrf:true` (`verify/e3.mjs`, `e3d.mjs`, `e3e.mjs`; `results/e3*.json`): `getClientCapabilities()` reports `extension:prf` true; `create({prf:{}})` -> `enabled:true`, no results; `get` -> 32 bytes, stable over repeated calls, different salt differs, `second` equals `first` of the same salt, a second credential gives a different value, `evalByCredential` equals `eval`, `enabled` absent at get. Deleting the credential (`WebAuthn.clearCredentials`) makes the get fail, and re-registering the same RP and user handle yields a **different** PRF value (e3d).

**Precision points.**
1. **"Per-credential 32-byte secret"** is shorthand. The credential holds a PRF key; each input maps to its own 32 bytes (reproduced).
2. **User verification.** CTAP hmac-secret keeps two secrets per credential (with and without UV). L3: "This extension only exposes a single PRF per credential and, when implementing on top of hmac-secret, that PRF MUST be the one used for when user verification is performed. This overrides the UserVerificationRequirement if necessary." Reproduced: with the authenticator reporting UV off, PRF `get` fails with `NotAllowedError` even for `userVerification:"discouraged"` (e3e). "Constant per credential" therefore holds only because the client forces UV. Apple's engineer in thread 764730: "These values should match, assuming your use of UV matches in both cases."
3. **Create-time results.** `prf:{}` returns none (reproduced), but `prf:{eval:{first}}` at create **did** return results in the same virtual authenticator (e3: `createWithEval.hasResults: true`), and Corbado places iCloud Keychain and Google Password Manager in a "CTAP 2.2" bucket that can return the first output at create. So gotcha 2 ("PRF at creation usually returns no result") should read "do not depend on it".
4. **Deletion versus provider migration.** FIDO Credential Exchange Format, Review Draft 2025-03-13, s3.3.12.3 (https://fidoalliance.org/specs/cx/cxf-v1.0-rd-20250313.html), `Fido2HmacCredentials {algorithm, credWithUV, credWithoutUV}`: "it is of utmost importance that the operation generating the symmetric key MUST provide the same output regardless of the provider generating the secret"; the importing provider "MUST store and use these credential as-is". So CXF can carry the PRF secrets: **this answers the source doc's open question F19/Q7 (low confidence there)**. A provider switch preserves derived keys only if both providers implement `hmacCredentials`; maturity of CXF after the 2025 review draft is unknown to me.

**Still open (not a correction).** Whether a synced passkey returns the same PRF on every device. Evidence both ways: Chromium (CL 6001891) matches Safari on one Mac; Apple's hybrid mismatch on iOS 18.0-18.3 and the 2026-04 recurrence report above. The virtual authenticator holds at most 3 resident credentials (a 4th `create` fails with `NotAllowedError`, e3c) and cannot test sync or platform behaviour.

**Confidence:** High on semantics and lab; unverified on real hardware.

---

## 9. Edits the source doc needs (proposed, not applied)

| Where | Change |
|---|---|
| F1 | Add: the CryptoKey object can be structured-cloned to another origin and used there (spec + test); privacy copy "the site you are on can act as you" should add "and hand that on". |
| F2, section 4.2 step 3, R4 | "after 7 days of Safari use without interacting with the site"; condition: Prevent Cross-Site Tracking on; unit: registrable domain; replace "a week without a visit". |
| F3, R2, R11 | Counts are the 2026-09-10 snapshot; Oct is 7 to 15 a day; Playwright default context is incognito-like, not "normal"; add the persistent-profile restart result; add the `indexedDB`-undefined variant and a memory-only identity mode; note the diagnosis is an AI-written unverified hypothesis and that Apple's Lockdown page does not support the Lockdown theory. |
| F4, R10 | The "not yet universal" sentence exists only in `docs/review/ARCHITECTURE-v0.1.md:199`; v0.2 has no such text. Add that WebAuthn L3 lists EdDSA first and that `eddsa-jcs-2022` and did:key `z6Mk` are equally standard; the P-256 case rests on platform authenticators and root-delegation, not on spec alignment. |
| F6, gotcha 10 | Chrome ship milestone 155; WebKit umbrella position neutral with Argon2 reservations (the "support" was for X-Wing, #704); noble is 5.5x to 5.9x slower at 19 MiB t=2 and 4.7x to 5.1x at 64 MiB t=3. |
| F9 | Cite the Manyverse FAQ; state 06 rule 7 would ignore a cloned key's ops; mark SSB sources as older. |
| F15 table | Windows Hello attribution; Firefox 147; iOS security-key defects and FB22434584; Dashlane role; MDN BCD stale for Safari get(). |
| F16, F19, gotchas 2 and 4 | UV note; `eval` at create can return results; CXF `hmacCredentials` carries PRF secrets; Apple hybrid mismatch as evidence on cross-device equality. |

---

## 10. Verified, not verified, assumed

- **Verified this session (primary or independent):** WebCrypto L2 ED security text; ITP rule text (WebKit page, 2020 and 2023 blogs, MDN); open-chat #9343 content through 2026-10-17; MDN BCD for Ed25519 and PRF; Chrome Intent to Ship thread, chromestatus, chromiumdash; WICG draft text; Mozilla and WebKit position issues #1282, #641, #704; hash-wasm and noble READMEs and npm metadata; SSB guide, fusion and metafeeds specs, Manyverse FAQ; WebAuthn L3 PRF and algorithm text; did:key and Data Integrity ECDSA/EdDSA status; WebKit blogs 18.0 and 26.4; WebKit bugs 259934, 311099, 314934; Chromium CLs 6001891, 7569106, 7600513; Firefox bugs 1993280, 1958716; microsoft/webauthn v8 commit; Apple forum thread 764730 (via WebFetch); Bitwarden post #21 (via WebFetch); 1Password blog; CXF review draft; Microsoft KB5077181 text. Experiments in two engines (Chromium 156.0.8078.4, WebKit 27.2): e1, e2, e3, e3c, e3d, e3e, e4, e5, kdf.
- **Not verified:** anything on Firefox (does not launch here); real iOS or Android behaviour (private browsing, Lockdown Mode, Home Screen apps, 7-day wipe in practice); Google Password Manager, Bitwarden, Samsung Pass, Microsoft Password Manager and Enpass rows beyond Corbado; the Windows Hello Feb 2026 attribution to KB5077181; stable Chrome 155 behaviour for the new algorithms; which authenticators produce Ed25519 credentials; whether CXF is still a Review Draft; the 1Password June 2026 regression thread; sync equality of PRF across devices.
- **Assumed:** that Playwright's WebKit and Chromium builds reflect the stated engine versions; that Corbado's per-row tests were run as described; that the Apple forum posts quoted are what the page shows (read through a summarizing fetch tool, so quotes should be re-read on the page before they are republished).

---

## 11. Sources opened (all fetched 2026-10-17 unless noted)

- WebCrypto L2 ED: https://w3c.github.io/webcrypto/ . WebAuthn L3: https://www.w3.org/TR/webauthn-3/ . PRF explainer: https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md . CXF review draft: https://fidoalliance.org/specs/cx/cxf-v1.0-rd-20250313.html .
- WebKit: https://webkit.org/tracking-prevention/ ; https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020, older); https://webkit.org/blog/14403/updates-to-storage-policy/ (2023); https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ ; https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ ; bugs https://bugs.webkit.org/show_bug.cgi?id=259934 , 311099 , 314934 , 312279 , 177350 ; positions https://github.com/WebKit/standards-positions/issues/641 and /704 .
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ; https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist ; BCD API https://bcd.developer.mozilla.org/bcd/api/v0/current/api.SubtleCrypto.json and `api.CredentialsContainer.create|get.publicKey_option.extensions.json`. web.dev: https://web.dev/articles/persistent-storage .
- Chrome: https://www.mail-archive.com/blink-dev@chromium.org/msg17349.html (and msg17351, 17360, 17361, 17363, 17392, 17404, 17411, 17412, 17413, 17419); https://chromestatus.com/api/v0/features/5198951632470016 ; https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=155 ; Gerrit https://chromium-review.googlesource.com/c/chromium/src/+/6001891 , 7569106 , 7600513 .
- Mozilla: https://github.com/mozilla/standards-positions/issues/1282 ; Bugzilla 1981476, 2074087, 1993280, 1958716, 1310762 . WICG: https://wicg.github.io/webcrypto-modern-algos/ .
- Libraries: https://github.com/Daninet/hash-wasm , https://registry.npmjs.org/hash-wasm , https://github.com/paulmillr/noble-hashes , https://registry.npmjs.org/@noble/hashes .
- open-chat: https://github.com/open-chat-labs/open-chat/issues/9343 . Apple Lockdown Mode: https://support.apple.com/en-us/105120 . Playwright: https://playwright.dev/docs/browser-contexts , https://playwright.dev/docs/api/class-browsertype .
- Ed25519 and standards: https://blog.ipfs.tech/2025-08-ed25519/ ; https://www.w3.org/TR/vc-di-ecdsa/ ; https://www.w3.org/TR/vc-di-eddsa/ ; https://w3c-ccg.github.io/did-key-spec/ .
- SSB: https://www.manyver.se/faq/account-on-many-devices/ ; https://ssbc.github.io/scuttlebutt-protocol-guide/ ; https://github.com/ssbc/fusion-identity-spec ; https://github.com/ssbc/ssb-meta-feeds-spec .
- PRF support: https://www.corbado.com/blog/passkeys-prf-webauthn ; https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html ; https://1password.com/blog/encrypt-data-saved-passkeys ; https://github.com/orgs/bitwarden/discussions/13838 ; https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236/21 ; https://developer.apple.com/forums/thread/764730 ; Microsoft KB5077181 https://support.microsoft.com/en-us/topic/february-10-2026-kb5077181-os-builds-26200-7840-and-26100-7840-f0fa9e54-a22a-4a06-96b6-bf5b2aded506 ; https://github.com/microsoft/webauthn/commit/706d98d73a8c3d888e77f0d524f630d551b194c3 ; https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis .
- Repo: `docs/ARCHITECTURE.md` (v0.2), `docs/review/ARCHITECTURE-v0.1.md:199`, `docs/review/DESIGN-REVIEW.md` S9, `docs/research/06-browser-chain-vs-crdt.md` (F34, F51, F52, s3.1.2 rule 7, s3.1.9), `docs/research/04-service-worker-serving.md` F11, `docs/research/w2c-06-standards-and-ecosystem.md` (lines 21, 300, 489), `docs/research/labs/w2c-03-identity-lab/` and `.../verify/`.
