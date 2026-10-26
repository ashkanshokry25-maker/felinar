# w2b-05 - Production security hardening: loader integrity, owner keys, kill switch, Service Worker update safety

- Date: 2026-10-17. Wave 2B (production readiness), topic 05. Written against `docs/ARCHITECTURE.md` v0.2 (643 lines, edited 2026-10-17 17:17), `docs/INTERFACES.md`, `docs/review/DESIGN-REVIEW.md` and the sibling notes `w1-10`, `w1-11`, `w2b-06` (relevant sections read) and `w2c-02` (skimmed by keyword); overlaps are cross-referenced, not repeated.
- Status: research note. Nothing here changes ARCHITECTURE or INTERFACES until a human merges it.
- Method: primary sources fetched and read (list in section 6), plus first-hand experiments (section 7; scripts and raw outputs in `docs/research/labs/w2b-05-probes/`). Environment of every experiment: macOS arm64, Node v24.22.0, Playwright 1.64.1 with Chromium 156.0.8078.4 headless shell, `bittorrent-protocol` 5.0.9, `webtorrent` 3.0.21, npm 11.19.1, OpenSSH_10.6p1. **Only Chromium was exercised. Firefox and WebKit behaviour of the Service Worker and Clear-Site-Data experiments is UNVERIFIED.**
- Budget note: the shared WebSearch quota (200 calls per turn across all agents) ran out part-way through this run. After that point every source was fetched by direct URL only. Consequences: Proton/Signal-specific web-integrity write-ups were not located beyond a FOSDEM 2020 abstract; Chrome-extension kill-switch and IPFS denylist precedents were not searched; those items are marked UNVERIFIED where they appear.
- Labels. Confidence: HIGH / MED / LOW. Evidence tags: **[EXP]** my experiment, **[READ]** primary source opened and read, **[VENDOR]** vendor blog or marketing page, **[SNIPPET]** seen only in a search-result snippet (not opened), **[OLD]** source older than 2024, **[CODE]** read in this repository or in `node_modules`, **[INFER]** my inference. Relation to existing project text: **CONFIRMS**, **EXTENDS**, **CORRECTS**, **NEW**. Wording rules of DESIGN-REVIEW section 4 (no "serverless", "unstoppable"; ledger = "site ledger") are followed.

---

## 1. Summary

**Verdicts**

1. **Loader self-attestation cannot be a runtime security boundary; build it as a signed release manifest plus verification tooling.** A hostile or compromised static host sees different `Sec-Fetch-Dest` / `Sec-Fetch-Mode` values for `<script>` (script / no-cors), `import()` (script / cors), page `fetch()` (empty / cors) and the browser's own SW update fetch (serviceworker, plus `Service-Worker: script`), and page JavaScript cannot set `Sec-` request headers (forbidden header names; standard rule, not re-read), so a "fetch yourself and compare hashes" check is cloakable [EXP, F1]. The SW update fetch bypasses every service worker, so the old SW can never veto its replacement [READ spec + EXP, F9]. SRI for service-worker scripts does not exist and the two proposals are still open (w3c/ServiceWorker #1680 open since 2023-05 with no vendor response; #1725 open since 2024-08 with one collaborator reply that a hash is feasible but has drawbacks) [READ, F2]. Every extension-based verifier surveyed at WWW 2026 had bugs that allowed secret exfiltration, and almost all of them ignored a pre-installed service worker [READ, F5]. What does remove the host from the trust base is not shippable to consumers in 2026: WAICT is a Firefox Nightly prototype, Isolated Web Apps are enterprise ChromeOS only [READ, F4, F8]. So: keep the claim "the static host is the trust root on every visit" (ARCH 13, DESIGN-REVIEW 20), add detection (pointer-bound release manifest, external canary), and emit the manifest in a WAICT-compatible shape so a future enforcing browser needs no redesign.
2. **Owner key custody: keep ECDSA P-256 verification, add hardware-backed signing paths that verify with plain WebCrypto; do not base the root identity on WebAuthn PRF.** Verified end to end: a real `ssh-keygen -Y sign` (OpenSSH_10.6p1) signature is accepted by a ~50-line WebCrypto-only verifier and by OpenSSH; a WebAuthn ES256 assertion whose challenge is `SHA-256(pointer signing input)` verifies with WebCrypto over `authenticatorData || SHA-256(clientDataJSON)` [EXP, F13, F14]. WebAuthn Level 3 became a W3C Recommendation on 2026-08-25 [READ, F10]; PRF works but the support matrix is still uneven and vendor-measured [VENDOR, F11]; the `sign` extension is an unmerged draft with no browser commitment [READ, F10]. Token2 PIN+ Release 3.3 lists FIDO2.1, PIV and OpenPGP; `hmac-secret` support is not stated [READ, F12].
3. **Rotation, threshold, revocation.** Use TUF-style double-signed rotation and a KERI-style pre-rotation commitment (`nk`, already proposed in w1-11 R12) with a "wait" rule for DNS-only key changes (RFC 5011 hold-down, 30 days or the TTL); prefer independent k-of-n signature lists to FROST because FIDO tokens cannot hold FROST shares and FROST(P-256) is Schnorr, not ECDSA [READ, F16, F17]. Prefer short expiry plus freshness over revocation lists (TUF timestamp role; Let's Encrypt announced in 2024 that it would end OCSP on 2025-08-06) [READ, F18].
4. **Kill switch.** Two independent levers, both measured: (a) site-level, a signed pointer state (`st`, see w2b-06 R2 `st=withdrawn`) that every v1 loader must fail closed on; (b) loader-level, a tombstone SW (recovers a bricked origin in a median 2.61 s after the next navigation, leaves IndexedDB intact) or `Clear-Site-Data: "storage"` on the `sw.js` response (works in Chromium 156, wipes everything including ledger identities) [EXP, F20, F21]. The `st` key must be in the v1 grammar before the first release, with "unknown value = kill" semantics, because loaders already in caches cannot learn new semantics later [INFER, R6].
5. **SW update safety, measured.** Chromium re-fetches `sw.js` about 1.98 s after a navigation (1978-1987 ms, n=6), debounced: navigations less than ~2 s apart starve the check, so reload-mashing prevents healing [EXP, F24, F25]. A redirect, wrong MIME, syntax error or install rejection in a new `sw.js` leaves the old SW active and serving; a SW whose navigation handler rejects bricks navigations (`net::ERR_FAILED`) but heals within ~3 s of the next navigation once a fixed `sw.js` is deployed, if the visitor waits [EXP]. ARCH v0.2 already specifies `no-cache`, `updateViaCache: 'none'`, a protocol handshake and the kill-switch worker; the gaps are an atomic install (critical precache failure must abort the install) and navigation fail-open [R3].
6. **Shell hardening.** Meta-delivered CSP cannot carry `frame-ancestors`, `sandbox`, `report-uri` or report-only [READ]; a SW-injected `frame-ancestors 'none'` is enforced by Chromium, so the SW can be the header layer for repeat visits on hosts that cannot send headers [EXP, F32]. Trusted Types is cross-browser since Firefox 148 (Chrome 83, Safari 26) [READ BCD]; the shell has four sinks and the vendored bundle one Blob-URL Worker [CODE, F30]. `Integrity-Policy` is in Chrome 138 / Firefox 145 / Safari 26 but Safari 26 blocks import-mapped modules under it [READ BCD].
7. **Supply chain.** **CORRECTION:** DESIGN-REVIEW S7 and `docs/review/security.md` M10 call the `allowScripts` key inert. With npm 11.19.1 (this machine) dependency install scripts are blocked by default unless listed in `allowScripts`; verified with a planted `postinstall` [EXP, F34]. `npm audit signatures`: 226 packages signed, 40 with provenance; 36 of 177 production packages have provenance, and the WebRTC transport `@thaunknown/simple-peer` is not among them [EXP, F35]. `webtorrent@3.0.21` has SLSA provenance (GitHub-hosted runner, repo webtorrent/webtorrent, commit 4df7cda7...) but its release workflow runs `npm i` with no lockfile committed, so its bundle is attested but not reproducible [EXP, F36]. esbuild 0.28.2 is deterministic in the cases tried [EXP, F37].
8. **Secure defaults.** `bittorrent-protocol` 5.0.9 buffers any announced length up to 0x7FFFFFFF and re-concatenates the whole buffer on every chunk. Measured in Node: 128 MiB of 16 KiB writes took 44.6-76.6 s and 8.4-8.5 GiB RSS; 1 KiB writes made 32 MiB cost 31-59 s [EXP, F41]. **CORRECTION:** the "4 GiB" example in docs/review/security.md B4 uses `0xFFFFFFFF` (ARCH E2E test 11, "a peer declaring a 4 GiB message", suggests the same pattern), which 5.0.9 reads as a negative number and treats as a keep-alive; the attack needs a length at or below 0x7FFFFFFF [EXP]. The 256 KiB per-wire cap already in ARCH 13 works (tested, legit messages unaffected); an upstream patch is ready (section 3.5).

**What is new relative to existing project text** (details in section 3): verified hardware-signing recipes (resolves w1-11 R20); the SW recovery measurements (confirms DESIGN-REVIEW 20, adds the debounce hazard and Clear-Site-Data results); the cloaking proof (turns w1-10 REC-18 "optional shell-hash pinning" into a consistency tool, not a defence); the npm correction; the provenance-versus-reproducibility finding; header allow-list for `/.mw/site.json` (Trust on Reload P3); `Request.integrity` for atomic SW installs.

### 1.1 Threat table (who can do what, what stops it, what this note adds)

| Attacker | Stopped today (ARCH v0.2) | Added or corrected here | Residual |
|---|---|---|---|
| A1 Compromised static host, CDN account or bucket serving a malicious shell or `/mw-sw.js` | Nothing on first visit or on SW update; per-file piece checks protect site files (7.3) | Detection: release manifest bound to the signed pointer, external canary, WAICT-shaped manifest (R10); cloaking limits stated (F1) | Targeted users can be served clean bytes to the canary and bad bytes to themselves |
| A2 DNS or registrar hijack | Pointer signature, TOFU pin, `seq` rollback refusal, required `exp` | Hold-down for DNS-only key changes (R8); `st` fail-closed (R6) | Unsigned or unpinned first visit |
| A3 Owner signing key stolen | Needs host or DNS write access to deploy | Hardware custody (R7), pre-rotation `nk` (R8), ledger control keys separated from routine key (already DESIGN-REVIEW 3) | Combined key + DNS compromise |
| A4 Malicious peer | Gossip budgets, 256 KiB wire cap (ARCH 13) | PoC numbers, regression test, upstream patch (R5) | Browser memory profile not measured |
| A5 Malicious dependency | `ignore-scripts`, `build.lock.json` | `allowScripts` default-deny is real (correction), `min-release-age`, provenance coverage, bundle reproducibility limits (R9, R12) | 141 of 177 production packages have no provenance |
| A6 Broken deploy or buggy SW | `no-cache`, `updateViaCache: 'none'`, kill-switch SW | Atomic install, fail-open navigation, runbook with measured timings (R2-R4) | Firefox and Safari timings unverified |

---

## 2. Findings

Source labels S1-S51 (and X1-X9 for snippet-only leads) are listed in section 6. "design-critical" = would change the architecture or a compatibility promise if wrong.

### 2.1 Loader integrity and self-attestation

**F1. A page cannot reliably verify the bytes the browser executes by fetching them again, because the server can tell the requests apart (design-critical).** Confidence HIGH. Source date 2026-10-17 [EXP]. Relation: EXTENDS w1-10 F38 and REC-18, CONFIRMS w1-11 F34-F35.
- [EXP `cloak-and-frame-probe`] What the origin server saw in Chromium 156 for one page load: `/` dest=document mode=navigate; `/probe.js` loaded by `<script src>`: dest=script mode=no-cors; `/mod.js` loaded by `import()`: dest=script mode=cors; `/probe.js` loaded by page `fetch()`: dest=empty mode=cors; `/sw.js` fetched by the browser for registration: dest=serviceworker mode=same-origin and the header `Service-Worker: script`.
- The SW spec makes `Service-Worker: script` mandatory on SW script fetches [S12]. Request headers whose names start with `Sec-` are forbidden header names in the Fetch standard, so page script cannot set them [INFER; standard rule, not re-read this session].
- Consequence: a check of the form "fetch /mw-sw.js and /_mw/loader.js and compare with the signed hash" can be answered with clean bytes while the browser is served different ones. It still catches accidental divergence (mixed deploys, stale edge copies, non-targeted CDN corruption). This matches the threat statement of S6: a server "can distribute a different version of a Web application to a user without them noticing".

**F2. Subresource integrity covers less than the shell needs, and not the Service Worker script.** Confidence HIGH. Source dates 2024-08 to 2026-10. Relation: CONFIRMS w1-11 F34, w1-10 F28.
- Before import-map integrity SRI "only applied to top-level scripts, styles, and preloads, and did not support imported JavaScript modules" (Shopify Engineering, 2024-08-02) [S19]. Import-map `integrity` key: Chrome 127, Firefox 138, Safari 18 [S15 BCD main, read 2026-10-17]. The inline import map is itself script and needs a CSP hash [INFER].
- `import()` takes no integrity argument; import-map `integrity` is how dynamically imported modules get checked ("That enables us to use dynamic imports without any change") [S19]. The loader's `import('/webtorrent.min.js')` (`app.js` line 449 in the v0.1 code) is therefore unchecked unless an import map or a preload entry covers it (w1-10 F28 reached the same point).
- `Request.integrity` (the `fetch()` option): Chrome 46, Firefox 51, Safari 10.1 [S15]. Usable inside a SW `install` to verify each precache entry (R3).
- No `integrity` option exists for `ServiceWorkerContainer.register()` or `importScripts()`. w3c/ServiceWorker #1680 "Support subresource integrity for service workers" (opened 2023-05-18, two community comments, last 2024-07-12, no labels, no vendor response): argues a pinned SW is "a programmable root of trust" and records the counter-risk that pinning "could make a takeover persist" [S10]. #1725 (opened 2024-08-26, retitled 2026-02-15 "expose installed service worker script contents or sum"): a collaborator wrote on 2026-02-16 that exposing the hash during `install`/`activate` is technically feasible but could read as endorsing manual integrity checks, could block updates, and "static SRI may not fit"; open, no assignee [S11].
- Signature-based SRI (`integrity="ed25519-<key>"`) is Chrome 141 only per w1-11 F34 (not re-verified here).

**F3. Header-level enforcement and hash-pinned CSP exist, with one Safari trap.** Confidence HIGH (BCD, spec text). Source dates 2026-09 to 2026-10.
- `Integrity-Policy` response header: Chrome 138, Firefox 145 (partial: reporting endpoints ignored, violations logged to the console), Safari 26. `blocked-destinations=(script)`: Chrome 138, Firefox 145, Safari 26 **partial**: "Module scripts are blocked even when the import map provides integrity metadata for them". `blocked-destinations` for styles: Firefox 142 behind `security.integrity_policy.stylesheet.enabled`, Chrome and Safari none [S15]. A search snippet names WebKit bug 326340 for the Safari behaviour [SNIPPET X6, not opened].
- CSP3 (W3C Working Draft 2026-09-16) section 8.4 "Allowing external JavaScript via hashes": a hash source expression matches an external script when that script element's integrity metadata is listed in the policy [S16]. MDN: "External scripts must also include the integrity attribute for this method to work", and hashes suit static pages because "both the CSP and the content can be static" [S17]. So `script-src 'sha384-<boot>' 'sha384-<loader>'` can replace `'self'`.
- Limit [INFER]: policy and HTML come from the same host, so this stops injected or third-party script, not a hostile host.

**F4. WAICT is the first cross-vendor path to enforceable web-app integrity; as of today it is a draft with one engine prototype (design-critical for the release-manifest format).** Confidence HIGH for facts, LOW for timeline. Source dates 2025-10-16 to 2026-05-05. Relation: CONFIRMS w1-11 F35 and R28.
- Mozilla Hacks 2026-05-05 (Firefox Security Team): sites "cryptographically bind their client-side code to a manifest" committed to a public log, with opt-in enforcement; "an early prototype ... behind a pref in Firefox Nightly"; collaborators Cloudflare, Freedom of the Press Foundation, Meta; test site waict.dev; Chrome and Safari not mentioned [S1].
- Draft integrity spec (README, undated, 73 commits) [S2]: response header `Integrity-Policy-WAICT-v1` (Structured Fields Dictionary) with `max-age`, `manifest` and `mode-document|frame|script|object|worker|style|image|font|media|wasm|inline-js|inline-css` set to `enforce|warn|report`; request hint `Sec-CH-WAICT`; manifest media type `application/waict-integrity-manifest` (marked TODO to reserve); manifest fields `url_hashes`, `wasm_hashes`, `fallback_hashes`, `wildcard_hashes`, inline hash sets, `resource_delimiter`, `emergency_opt_out` (a tombstone: no integrity checking); hashes are SHA-256, base64url without padding, keyed by URL. **Service workers**: when a UA first sees a valid header or the manifest URL changes it triggers an update check and "must prevent any existing Service Worker from intercepting covered fetches until that check completes"; `mode-worker` covers `serviceworker`, `sharedworker` and worklets; `blob:`/`data:` worker URLs are blocked unless hashed. Transparency spec: draft; files `merkle-patricia-tree.md`, `waict-proofs.md`, `waict-signalling.md`, `waict-apis.md` (names read, contents not) [S3].
- Cloudflare 2025-10-16: "very early in the standardization process"; consistency is mitigated, not solved (users "may still receive different unexpired versions"); "Malicious code is not detected or prevented. Transparency only makes it publicly auditable" [S4].
- Consequence: emit the release manifest as WAICT-shaped `url_hashes` including `/mw-sw.js` (R10). Do not claim enforcement.

**F5. Every extension-based verifier surveyed in 2026 was bypassable, and almost all of them missed pre-installed service workers (design-critical lesson for our own verifier design).** Confidence HIGH. Source date 2026-04 (WWW '26), DOI 10.1145/3774904.3792624 [S6].
- Surveyed: Meta Code Verify (Chrome and Firefox, "over 30k installations", verifies JS and CSS found in the DOM against Meta-published hashes), Accountable JS (unmaintained), Signed Pages, WAIT (Firefox-only, unmaintained), WEBCAT (Firefox; Sigstore and TUF trust model). 18 vulnerabilities disclosed; nine pitfalls.
- P4 "Missing Service Worker Verification": a SW installed before the extension, or by a fast reload, "can persistently exfiltrate secrets, even if all future Web pages are benign" because it can read IndexedDB and intercept fetches. P3: `Location` (redirects keep the URL fragment), `Link` (injects stylesheets) and `Refresh` headers change behaviour and were unverified. P5: fonts and images are not verified, enabling UI misrepresentation. Recursive imports and `@import` were not covered by Code Verify and Accountable JS. Proactive blocking needs `webRequest.filterResponseData`, which only Firefox has.
- Their proposal CodeSeal: signature over the main HTML in a response header; the extension adds `Integrity-Policy` and a CSP without `unsafe-eval` so every script and style needs SRI; verifies that `Location`, `Refresh`, `Link` are absent; each SW signed separately and previously installed SWs unregistered.
- Lessons for magnet-web [INFER]: our SW is exactly the P4 persistence primitive; anything we sign must also cover behaviour-changing headers (F7); a verifier that only checks the first document is not a verifier.

**F6. Code Verify, WEBCAT and Proton.** Confidence MED (single-source summaries).
- Code Verify (Meta engineering, 2022-03-10): WhatsApp gave Cloudflare "a cryptographic hash source of truth for WhatsApp Web's JavaScript"; "Subresource integrity applies only to single files, but Code Verify checks the resources on the entire webpage"; relies on Cloudflare as "a trusted third party"; the post does not mention service workers [S7]. Repository: MIT, 183 stars, 614 commits, store links for Chrome, Firefox, Edge, Safari; no releases listed [S8].
- WEBCAT (SecureDrop, 2026-05-04): alpha on Mozilla add-ons, "decentralized enrollment infrastructure", converging with WAICT [S5].
- Proton: FOSDEM 2020 talk by Daniel Huigens proposes "Source Code Transparency" and "Key Transparency" and asks for browser APIs [S9, OLD, abstract only]. Signal-specific web-integrity writing was not located [UNVERIFIED].

**F7. ARCH 7.1 applies `headers` from `/.mw/site.json` to site documents; that field needs an allow-list (NEW).** Confidence MED (design reading plus S6). 
- ARCH 7.1 lists "plus manifest `headers`". S6 P3 shows `Location`, `Refresh`, `Link` are the dangerous ones. Cloudflare Pages `_headers` (the format `publish.mjs` imports) documents no disallowed header [S44].
- Allow-list proposal: `Content-Security-Policy`, `Permissions-Policy`, `Referrer-Policy`, `X-Content-Type-Options`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Cache-Control` (clamped), `Content-Language`, `Link` only for same-origin `rel=preload`. Deny `Location`, `Refresh`, `Set-Cookie`, `Clear-Site-Data` (browsers ignore it on SW-synthesized responses anyway, F20), `Service-Worker-Allowed`, and any `Content-Security-Policy` that loosens the loader's `frame-ancestors`.

**F8. Isolated Web Apps are not an option for consumers in 2026, but their identity and rotation model is a precedent (design-critical: confirms no standards-based way to remove the host from the trust base).** Confidence HIGH. Source date 2026-02-06 (page update) [S33].
- "The initial release of Isolated Web Apps ... will only be available to Chrome Enterprise administered ChromeOS devices and select development partners"; expansion to "unmanaged and cross-platform devices" is only an intention. From Chrome 143 on ChromeOS only allowlisted apps are installable through the Admin Panel; allowlisting is by Google partner contact and review (about two business weeks). Developer mode exists on Chrome or ChromeOS 120+ behind `enable-isolated-web-app-dev-mode`.
- Model: bundle is a Signed Web Bundle (`.swbn`) signed with Ed25519 or ECDSA P-256 keys kept offline; identity is the public key (`isolated-app://`), not a domain; updates are checked every 4-6 hours; CSP default allows JavaScript only from the bundle (Wasm from anywhere); all permissions blocked unless declared.
- Key rotation: replace a leaked or lost key by dual-signing with old and new keys before Google processes the rotation; bundle ID and origin stay; lost key means contacting Google. A precedent for F16, not an option for us.

**F9. A compromised host can replace the Service Worker and the old worker cannot veto it; returning-visitor protection from the SW is therefore consistency, not security.** Confidence HIGH. Source dates 2026-09-17 (spec) and 2026-10-17 [EXP]. Relation: CONFIRMS DESIGN-REVIEW 20 and w1-11 F37.
- SW spec, Update algorithm [S12]: the script request carries `Service-Worker: script`; `service-workers mode` is "none" (no SW sees the request); redirect mode "error"; response MIME must be a JavaScript type; a new worker is installed when the main script or any imported script differs "byte-for-byte". Handle Fetch runs Soft Update on every non-subresource (navigation) request.
- [EXP] Chromium re-fetched `/sw.js` 1978-1987 ms after each navigation (n=6, F24). A malicious `sw.js` is therefore picked up at the next navigation and persists until the next clean fetch after a redeploy.
- So ARCH 13's sentence "the static host is the trust root on every visit, including SW updates" is correct and should stay; REQ M4's cache-first shell navigation adds speed, not integrity.

### 2.2 Owner key management

**F10. WebAuthn Level 3 is a W3C Recommendation (2026-08-25); `prf` is in it, `sign` is not.** Confidence HIGH. Source date 2026-08-25 [S20]. Relation: NEW (w1-11 F27 said "the WebAuthn spec was not read").
- Status line: "W3C Recommendation, 25 August 2026", "no substantive changes since the Candidate Recommendation Snapshot of 26 May 2026". Client extensions listed in its table of contents: `appid`, `appidExclude`, `credProps`, `prf`, `largeBlob`.
- `prf` (section 10.1.4): PRFs map any-length input to 32 bytes; "modeled on top of the CTAP hmac-secret extension"; client salt = `SHA-256(UTF8("WebAuthn PRF") || 0x00 || input)`; when built on hmac-secret it MUST use the user-verification PRF; motivating example is deriving symmetric keys, with rotation by evaluating two inputs per assertion.
- `sign` extension: w3c/webauthn PR #2078 "Add 'sign' extension" (opened 2024-05-28 by a Yubico engineer; still an unmerged draft; labels `@Risk` and `stat:Discuss`; milestone L4; last comment 2026-07-26): a separate signing key per credential that signs the input unaltered; "No commitments from other WG participants" recorded in 2024; depends on an IETF draft for COSE algorithm identifiers [S24]. A vendor blog says YubiKey 5.8 firmware has a preview [SNIPPET, X7]. Do not design around it.

**F11. PRF support is broad but uneven; the credible matrix is vendor-measured.** Confidence MED. Source date 2026-08 (Corbado, own tests on macOS 26.3, Windows 11 and a Galaxy phone plus community demo data) [S22, VENDOR]; Yubico table is "as of mid-2025" [S21, OLD].

| Platform | Platform authenticator | Security key | Notes (Corbado, Aug 2026) |
|---|---|---|---|
| Windows 11 before the Feb 2026 update | no (Hello lacks hmac-secret) | yes (Chrome/Edge 116+, Firefox 139+) | Windows 10: none |
| Windows 11 24H2/25H2 with KB5077181 (2026-02-10) | yes: Firefox 148+, Chrome/Edge 147+ (146 authenticates only, no PRF on create) | yes | |
| macOS 15+ | Safari 18+, Chrome 132+, Firefox 139+ | Safari 26.4+ with WebKit bugs (a bug returns null for YubiKey Bio-class keys), Chrome, Firefox | |
| iOS / iPadOS 18+ | Safari 18+ (all iOS browsers use WebKit) | 26.4+ | cross-device data loss on 18.0-18.3, fixed in 18.4 |
| Android | Chrome/Edge yes (Google Password Manager has PRF by default), Samsung Internet yes, Firefox 149+ (March 2026) | yes | Firefox hybrid path not measured |

- Providers (create / get): iCloud Keychain yes/yes; Google Password Manager yes/yes; Windows Hello yes/yes (conditions above); 1Password yes/yes (tested on Chrome 150); Proton Pass, KeePassDX, Enpass, Keeper yes/yes; Microsoft Password Manager in Edge yes/no ("every get() with PRF fails"); Samsung Pass no/yes; Bitwarden partial (works on Linux/Firefox, 29% Android, 0% iOS/Safari in the demo data); KeePassXC partial (no released version); Dashlane and NordPass no.
- Caveats stated there: the capability flag can disagree with real results; create and get support are separate; a lost passkey makes PRF-encrypted data unrecoverable. Yubico's table (mid-2025): roaming YubiKeys work on Windows 11 in all three browsers and on macOS in Chrome but not Safari; iOS "does not pass extension data to/from external keys" (a "Critical Limitation"); Android Chrome USB yes, NFC no.
- Anecdotes [SNIPPET, not opened]: Apple Developer Forums thread 774112 (PRF unsupported over Safari's cross-device flow in 18.0.1, partly fixed in 18.2, values then differed between hybrid and on-device use); a 1Password community thread (June 2026) reporting the PRF result returned as a plain Array instead of an ArrayBufferView in the Chrome and Firefox extensions (Chrome 149, Firefox 151.0.3 broken, Safari 26.5 fine), resolution not found.
- Consequence [INFER]: PRF-derived key material depends on the passkey provider's lifecycle and on per-platform quirks. Fine for wrapping a backup of an exportable key with at least two registered credentials (Yubico's envelope pattern); wrong as the only root of the owner identity.

**F12. Hardware tokens: Yubico's PRF guidance, and what is and is not known about Token2.** Confidence MED.
- Yubico guide [S21]: treat the 32-byte output as input keying material and run HKDF with a purpose-bound `info`; for several credentials use envelope encryption (each key derives a KEK that wraps a shared DEK), rotation by unwrap and rewrap. It does not cover asymmetric signing keys.
- Token2 T2F2-PIN+ Release3.3 TypeC product page [S28, VENDOR]: "FIDO2.1, U2F, TOTP, HOTP, PIV and OpenPGP"; "Version 3.3 adds PIV functionality"; up to 300 passkeys; FIDO "L2" certification field; 6-digit minimum PIN with complexity enforced; PIV and OpenPGP support "Yes". The page does not mention `hmac-secret`, PRF, or the key types of the PIV and OpenPGP applets: **UNVERIFIED**. A real-device test is needed before any Token2 claim goes into DEPLOY.md (section 5, Q3).

**F13. A WebAuthn assertion works as a signature over arbitrary data and verifies with plain WebCrypto (verified).** Confidence HIGH for Chromium virtual authenticator; MED across browsers. Source date 2026-10-17 [EXP `webauthn-sign-probe`, results in `results/webauthn-sign-probe.json`]. Relation: resolves w1-11 R20 / F27.
- Recipe: challenge = `SHA-256(pointer signing input)`; verifier checks `clientDataJSON.type == "webauthn.get"`, challenge equals base64url of that hash, `rpIdHash == SHA-256(rpId)`, flags UP (and UV if required), then ECDSA-P256-SHA256 over `authenticatorData || SHA-256(clientDataJSON)` after converting the DER signature to raw r||s. Yubico describes the same "challenge-as-hash" method [S23]. A tampered input gives a challenge mismatch.
- Measured sizes (Chromium 156): `authenticatorData` 37 B, `clientDataJSON` 244 B (Chrome adds `"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex"`), DER signature 71 B (64 B as r||s). In the TXT record that is +50 and +326 base64url characters on top of today's 86-character `sig`. `clientDataJSON` must be carried verbatim because the signature covers its exact bytes.
- Caveats [INFER]: synced platform passkeys (iCloud Keychain, Google Password Manager) are not bound to one device; the signing UI is a web page and so a second supply chain; loaders cannot check attestation; Firefox and Safari `clientDataJSON` formatting was not tested. PRF round trip on the virtual authenticator: `enabled: true` at create, same salt gives equal 32-byte outputs, different salts differ (semantics only, not a hardware test).

**F14. OpenSSH `ssh-keygen -Y sign` signatures, including FIDO-backed `sk-ecdsa`, are verifiable with about 50 lines of WebCrypto (verified for the plain ECDSA case).** Confidence HIGH (real signature), MED (sk path). Source date 2026-10-17 [EXP `sshsig/verify-sshsig.mjs`, `results/sshsig-verify.txt`]. Relation: resolves w1-11 R20.
- `ssh-keygen -Y sign -f <key> -n <namespace> file` supports `ecdsa-sk` and `ed25519-sk` keys, where "a per-device private key ... cannot be exported from the authenticator hardware" [S27]. Formats: SSHSIG blob (magic `SSHSIG`, version 1, public key, namespace, reserved, hash algorithm `sha256|sha512`, signature) and signed data `"SSHSIG" || string(namespace) || string(reserved) || string(hash_alg) || string(H(message))` [S25]; the sk signed data is `SHA256(application) || flags || counter || [extensions] || SHA256(message)` and the sk signature adds `flags` and a 32-bit `counter` after the ECDSA `r,s` [S26].
- [EXP] A signature produced by OpenSSH_10.6p1 for namespace `magnet-web-pointer-v1` verified in the WebCrypto-only verifier and in `ssh-keygen -Y verify`; a one-byte change of the message and a wrong namespace were rejected. Size: 260-byte blob (411 armored characters). The sk path was exercised only with a synthetic authenticator (software key standing in for the token), so it is a self-consistency check of my reading of PROTOCOL.u2f, not a hardware result (305-byte blob).
- A compact record form is possible: `r||s` + `flags` + `counter` = 69 bytes, with `application` fixed to `ssh:` (the default) and namespace and hash algorithm fixed by the record version. Device support for `ed25519-sk` varies; `ecdsa-sk` is the portable choice [INFER].

**F15. Algorithm availability.** Confidence HIGH [S15 BCD]. WebCrypto Ed25519 `sign`/`verify`: Chrome 137, Firefox 129, Safari 17; X25519 `deriveBits`: Chrome 133, Firefox 130, Safari 17. ECDSA P-256 is universal. The declared browser floor (Chromium 110, Safari 15.4, Firefox 115) predates Ed25519 in Chrome, so Ed25519 pointer or threshold signatures need a bundled fallback (`@noble/curves`, F17) or a higher floor for owners-only features.

**F16. Rotation precedents agree on three rules: continuity from the previous key set, rollback protection, and an out-of-band path when the key set is gone.** Confidence HIGH. Relation: EXTENDS w1-11 F24-F26 (TUF, did:plc, KERI), adds Android, IWA and RFC 5011.

| System | Rule | Source |
|---|---|---|
| TUF 1.0.37 (2026-10-08) | root N+1 "MUST have been signed by (1) a THRESHOLD of keys specified in the trusted root metadata file (version N), and (2) a THRESHOLD of keys specified in the new root"; version exactly N+1; an expired root is a freeze; compromise of a threshold needs out-of-band repair and "safely recovering from it is nearly impossible" | [S29] |
| Android APK Signature Scheme v3 | proof-of-rotation: a singly linked list where "the cert in each node sign[s] the next"; per-node trust flags; "not recommended for Android 12 (API level 31) and earlier" | [S31] |
| Chrome IWA key rotation | dual-sign with old and new keys before the rotation is processed; identity stays; lost key means an out-of-band contact | [S33] |
| KERI pre-rotation | each event commits to a digest of the next key set; an attacker "can't forge ... without first unblinding the pre-rotated keys" | [S32, OLD 2022 draft] |
| RFC 5011 (2007, OLD) | a new trust anchor is accepted only after an add hold-down of "30 days or the expiration time of the original TTL ... whichever is greater"; revocation is a self-signed REVOKE | [S30] |

- Mapping to the pointer: `rot` must include scope and old key (w1-11 R11) and be countersigned by the new key (TUF's second threshold); `nk` pre-rotation commitment (w1-11 R12) is the offline recovery path; a DNS-only key change with no valid `rot` or `nk` should wait out an RFC 5011-style hold-down in a visible "pending key change" state instead of an instant confirm button (R8).

**F17. Threshold signing: FROST is real and audited in JS, but fits software cosigners only.** Confidence HIGH (RFC, registry data), MED (audit scope). Source dates 2024-06 (RFC 9591) and 2026-08 (noble-curves).
- RFC 9591 (IRTF CFRG, June 2024): FROST(Ed25519) and FROST(Ed448) signatures "can be verified with a verifier that is compliant with [RFC8032]", but are not deterministic; FROST(P-256, SHA-256) uses Ne = 33, Ns = 32, i.e. a Schnorr signature on P-256, not ECDSA; key generation is out of scope (trusted dealer only in the appendix) [S34]. Consequence [INFER]: only an Ed25519 FROST group is verifiable by WebCrypto; P-256 FROST needs library verification code.
- `@noble/curves` 2.4.0 (registry modified 2026-08-27) implements RFC 9591 ciphersuites `p256_FROST`, `ed25519_FROST`, `ed448_FROST`, `ristretto255_FROST`, `secp256k1_FROST`, `schnorr_FROST` with a trusted-dealer helper; README lists a Trail of Bits audit "at version 2.3.0, in Aug 2026 ... Scope: everything" and a Cure53 audit at 1.6.0 (Sep 2024) whose listed scope does not include FROST; npm provenance attestation present [S35].
- FIDO2 tokens sign with their own ECDSA/EdDSA key and cannot hold FROST shares [INFER], so a hardware-backed quorum means several independent tokens each producing a normal signature. That is the TUF threshold model, needs no interactive rounds, and costs record size (n x 86 characters).

**F18. Freshness and expiry beat revocation lists; DNS is the arbiter.** Confidence MED (precedent) / HIGH (facts). Relation: CONFIRMS ARCH 4 (`exp` required, 90 days default), adds the freshness-key pattern.
- TUF separates a long-lived offline root from an online timestamp role: "an automated process periodically signs a timestamped statement ... Even though this timestamp key must be kept online, the risk posed to clients by the compromise of this key is minimal" [S29].
- Let's Encrypt "Ending OCSP Support in 2025" (2024-12-05) announces a timeline (Must-Staple requests fail from 2025-01-30, OCSP URLs dropped from certificates 2025-05-07, responders off 2025-08-06; whether it ran as planned was not checked): OCSP "represents a considerable risk to privacy" and CRLs replace it [S36]; the general point for us is that per-visit revocation queries leak visits, so we rely on expiry and the DoH recheck we already do.
- A DNS-published revocation list (for example a `_magnet-revoked.<domain>` TXT name) would be a second record fetched and cached per visit, signed by the key it revokes or by the next key, and trusted exactly as far as the pointer record itself; the precedent is the self-signed REVOKE of RFC 5011 [S30]. For this design it adds a lookup and a state machine without a new capability: `rot`, `nk`, `st` and a short `exp` already cover rotation, compromise and withdrawal [INFER]. Skip revocation lists; keep pre-generated revocation material only as the `nk` key held offline.
- DNS facts from `05-doh-dns-txt.md`: about 4-5% of .com domains are DNSSEC-signed, `AD` is advisory, TTL floors are 300-600 s. So a kill or rotation reaches online visitors in roughly TTL + the 5 minute recheck, and offline visitors only when they reconnect or `exp` passes [INFER from ARCH 4 and 5.8].

**F19. Recovery from total key loss has no vendor to ask.** Confidence MED [INFER]. IWA and Android route recovery through Google; TUF says out-of-band. For magnet-web the options are: (a) the offline `nk` key (immediate, needs the earlier setup); (b) a DNS-only key change after a hold-down (slow, visible, weakest); (c) a new scope (new domain or hub label) and a fresh TOFU. The README should say which of these the owner has set up at publish time (R8).

### 2.3 Kill switch

**F20. `Clear-Site-Data: "storage"` on the `sw.js` response unregisters the worker and wipes all origin storage in Chromium 156 (verified); `"cache"` alone does not touch Cache Storage (design-critical for the kill-switch design).** Confidence HIGH for Chromium; Firefox and Safari UNVERIFIED (BCD says supported). Source date 2026-10-17 [EXP `sw-recovery-probe-0` (the `"cache","storage"`, `"*"` and new-bytes variants) and `sw-recovery-probe-1` (the controlled comparison with page re-registration switched off), results in `results/`]; spec is a 2017 Working Draft [S13, OLD]; MDN [S14]; BCD [S15].
- Spec design: the header is honoured only on network responses, not on responses a SW synthesizes, but "a service worker update is a network response ... This is important in order to support the use case in 1.1.4 Kill Switch" [S13]. MDN: `"storage"` runs `IDBFactory.deleteDatabase` for every database and `ServiceWorkerRegistration.unregister` for every registration [S14]. BCD: header Chrome 61, Firefox 63, Safari 17; `"storage"` Chrome 61, Firefox 63, Safari 17; `"executionContexts"` Chrome none, Firefox removed in 68, Safari removed in 18.3; `"cache"` in Chrome is "partial" with notes about stale entries and "seconds-long hangs" [S15].
- Measured (state read 2.5-3.5 s after a navigation; a planted localStorage value, a Cache Storage entry and an IndexedDB record in the page's origin):

| Header sent on | Value | SW registration | localStorage | Cache Storage | IndexedDB |
|---|---|---|---|---|---|
| the `sw.js` update response (identical bytes) | `"storage"` | removed | cleared | cleared | cleared |
| the `sw.js` update response (new bytes) | `"storage"`, `"cache","storage"`, `"*"` | removed | cleared | cleared | cleared |
| the `sw.js` update response | `"cache"` only | kept | kept | **kept** | kept |
| the `sw.js` update response | `"cookies"` only | kept | kept | kept | kept |
| the `sw.js` update response | none (control) | kept | kept | kept | kept |
| a navigation response relayed by the SW with `respondWith(fetch(request))` | `"storage"` | removed | cleared | cleared | cleared |
| a navigation response with no SW fetch handler | `"storage"` | removed | cleared | cleared | cleared |
| a navigation response **synthesized by the SW** | `"storage"` | kept | kept | kept | kept |

- Consequences: (1) the static host can wipe every visitor's state (identity keys, pins, cached sites, ledgers) at will, a power it already has by shipping a new SW; (2) a hub site's own `_headers` file cannot do it, because those responses are SW-synthesized and ignored; (3) under ARCH v0.2 shell navigations are answered cache-first from the precache, so a header on `index.html` is never seen; the `sw.js` response is the only Clear-Site-Data path in shell mode, while drop-in navigations go to the network untouched (ARCH 3.4.2 a) and would honour it; (4) this is a last-resort lever: it destroys per-ledger identity keys (ARCH 6.1 `keys` store), which the tombstone SW does not.

**F21. A self-unregistering tombstone SW recovers a bricked origin in a median 2.61 s after the next navigation and keeps IndexedDB and localStorage (verified).** Confidence HIGH for Chromium. Source date 2026-10-17 [EXP `sw-timing-probe`, results in `results/sw-timing-probe.json`, n=6: 2579-2623 ms]. Relation: CONFIRMS DESIGN-REVIEW 20 (and ARCH 7.1 `kill-switch.js`), adds numbers.
- Setup: a registered SW answers every navigation with a cached "BROKEN" page; the server then serves the tombstone as `/sw.js`. The first navigation still shows the broken page (the old SW answers it); about 2 s later the browser re-fetches `sw.js` (F24), the tombstone installs (`skipWaiting`), its `activate` deletes caches, unregisters, and navigates all window clients; the next load comes from the network. No user action. Final state: registrations 0, Cache Storage emptied, localStorage and IndexedDB untouched.
- The tested worker is the ARCH pattern: `install: skipWaiting()`; `activate`: `caches.keys()` then `caches.delete`, `registration.unregister()`, `clients.matchAll({type:'window', includeUncontrolled:true})` then `client.navigate(client.url)`. Same shape as the README of NekR/self-destroying-sw [S49]. ARCH's version should delete only `mw-*` caches (the probe deleted all).

**F22. Other kill-switch precedents.** Confidence MED.
- WAICT manifests can set `emergency_opt_out` so the manifest becomes a tombstone and no integrity checking happens against it [S2].
- IPFS service-worker gateway offers `?ipfs-sw-unregister=true`; a stale CDN copy of its bootstrap bricked the gateway in July 2026 (issue #1155) [`04-service-worker-serving.md`, citing the gateway repo; not re-opened here].
- Not searched (quota): Chrome extension blocklists and IPFS gateway denylists [UNVERIFIED]. Takedown mechanics at the legal level are in `w2b-06` section 4 (levels L0-L5) and are not repeated.

**F23. A pointer-level kill reaches online visitors within TTL plus recheck and offline visitors only when they reconnect or `exp` passes; an unsigned kill is a denial-of-service lever.** Confidence MED [INFER from ARCH 4 and 5.8].
- ARCH 4: DNS answers are cached per TTL (minimum 5 minutes), rechecked on that schedule and on `focus`; an expired cached record "still renders with 'Pointer expired on <date>; showing the last known version.'". So a killed site stays visible on a device that never reconnects. The offline-first promise and a hard kill conflict; a signed `st` that is persisted in the `pointers` store stays in force offline once seen.
- An `st` honoured without a signature lets anyone who controls DNS switch a pinned site off; honour it only when signed by the pinned owner (or with a valid `rot`). For unsigned, unpinned scopes the DNS controller controls the content anyway.
- w2b-06 R2 proposes `st=withdrawn` with `btih` of 40 zeros so older loaders fail closed; the same fail-closed idea is why the key must exist in the v1 grammar now (R6).

### 2.4 Service Worker update safety

**F24. The browser, not the page, drives SW updates; in Chromium the re-fetch starts about 2 s after a navigation and is debounced (design-critical for recovery latency).** Confidence HIGH for Chromium; other engines UNVERIFIED. Source dates 2026-09-17 (spec) and 2026-10-17 [EXP `sw-timing-probe`, `sw-recovery-probe-1`].
- Spec (W3C Candidate Recommendation Draft, 2026-09-17) [S12]: Handle Fetch runs Soft Update for every non-subresource request, and for subresource requests only when the registration is stale (last update check more than 86,400 s ago). The update request sets cache mode `no-cache` when `updateViaCache` is not `all`, when forced, or when stale; "Even if the cache mode is not set to 'no-cache', the user agent obeys Cache-Control header's max-age value in the network layer". Request Soft Update (used by other specs) may be rate-limited by the UA. A navigation started with shift+reload is not handled by the SW at all.
- [EXP] First `/sw.js` request after `page.goto` resolved: 1978-1987 ms (median 1982, n=6), headers `Service-Worker: script`, `Sec-Fetch-Dest: serviceworker`. Three navigations 600 ms apart produced zero fetches during the burst and exactly one after 4 s of quiet. [EXP] A SW that bricks navigations was never re-fetched in 14 attempts spaced 400 ms apart, and healed in 3.04 s (two attempts) when attempts were spaced 3 s apart (F25).

**F25. Failure modes of a bad `sw.js` deploy (verified in Chromium 156).** Confidence HIGH for Chromium. [EXP `sw-recovery-probe-0` (redirect, wrong MIME), `sw-recovery-probe-1` (syntax error, install failure, handler rejection), `sw-recovery-probe-2-heal`].

| New `/mw-sw.js` is... | Result | Old SW |
|---|---|---|
| a 301 to another path | `update()` rejects (TypeError, redirect not allowed) | stays active, keeps serving |
| 200 with `text/html` (host SPA fallback or error page) | `update()` rejects (SecurityError, MIME) | stays active |
| a script with a syntax error | rejected (TypeError) | stays active |
| valid, but `install` rejects (precache failed) | new worker discarded | stays active |
| valid and active, but its navigation handler rejects | navigations fail with `net::ERR_FAILED`; fixed `sw.js` heals after one quiet navigation (sw.js re-fetched 1.03 s after the first post-fix attempt, healthy at 3.04 s with 3 s spacing); never healed with 400 ms spacing over 14 attempts | replaced by the bad one |

- Consequences: a CDN or host that answers `/mw-sw.js` with a redirect, an HTML fallback or a 404 during a deploy silently pins the previous worker (including a hostile one) with no error shown to visitors; fail-open navigation (R3) removes the `ERR_FAILED` class; the kill-switch runbook must tell people to wait a few seconds and not reload repeatedly.

**F26. CDN and host caching can defeat the update path.** Confidence HIGH [S43, S12].
- CloudFront: "If you opt out of using a cache policy, the default TTL ... is 24 hours"; with a minimum TTL above 0 "CloudFront uses the cache policy's minimum TTL, even if the `Cache-Control: no-cache` ... directives are present in the origin headers"; edge stale-serving directives exist (`stale-if-error`). S3 only carries user-defined `x-amz-meta-*` and a few system headers, so security headers need CloudFront or another front. The spec note above means the browser cannot bypass an edge that holds a stale `sw.js`.
- Relation: CONFIRMS DESIGN-REVIEW 20 ("purge the CDN on every deploy") and w1-10 REC-14; adds the minimum-TTL override as a concrete trap.

**F27. Install atomicity, integrity-checked precache, and the remaining SW options.** Confidence HIGH (BCD, repo reading, EXP).
- v0.1 code tolerates failed precache entries and still calls `skipWaiting()` (`src/sw/sw.js` install handler, lines 29-45: "a partial shell cache beats no Service Worker at all", `skipWaiting()` at line 43; its `guard()` at lines 93-98 turns any exception into a JSON 500) [CODE]; ARCH 7.1 says "Install: precache ...; skipWaiting" without stating failure handling. [EXP] An install that rejects leaves the previous worker active (F25), so a critical-set failure should reject the install. `Request.integrity` (F2) lets each critical fetch be hash-checked against build-time constants, turning a mixed deploy (new `sw.js`, stale edge copy of `loader.js`) into a failed install instead of an incoherent shell. This protects consistency, not against a hostile host (F9).
- Versioned caches: ARCH 7.1 keeps the shell under `mw-shell-<BUILD_ID>` and sweeps other `mw-shell-*` caches on activate. A failed install therefore leaves the new cache half-filled and orphaned until the next successful activation; delete it in a `catch` inside `install` so a flapping deploy cannot accumulate partial caches (R3).
- skipWaiting policy: unconditional skip with a protocol handshake (ARCH 5.2: `proto: 1`, reload once) is workable [`04-service-worker-serving.md` F20]; waiting for all clients to close is safest for consistency but strands visitors on the old (possibly compromised) code; a prompt adds UI. For security updates immediate activation is the right default.
- Navigation preload: Chrome 59, Firefox 99, Safari 15.4 [S15]; of use only when navigations go to the network (drop-in) because shell navigations are cache-first; Lockdown Mode disables it (`03-webrtc-nat-privacy.md`). Static routing `InstallEvent.addRoutes`: Chrome 123, Safari 27, Firefox none [S15]; could pin a recovery route to the network independent of handler bugs, but F25 shows self-healing already covers that and Firefox lacks it.

### 2.5 Shell hardening: CSP, Trusted Types, Permissions-Policy, headers

**F28. A meta-delivered CSP cannot do several jobs, and a late-inserted one does not cover what came before it.** Confidence HIGH [S16 CSP3 Working Draft 2026-09-16; S17]. Relation: EXTENDS w1-10 REC-13.
- CSP3 section 3.3: "The Content-Security-Policy-Report-Only header is not supported inside a meta element. Neither are the report-uri, frame-ancestors, and sandbox directives"; "policies in meta elements are not applied to content which precedes them"; later edits of the `content` attribute are ignored. MDN: nonces need a fresh value per response so they do not suit static HTML; hashes do; `'strict-dynamic'` lets a hash-matched script load others [S17].
- ARCH 5.1 step 6 inserts the CSP `<meta>` from `boot.js`, so `boot.js` itself and any markup before the insertion run unrestricted, and because multiple policies are enforced conjunctively a strict static policy could not be relaxed later for degraded mode (ARCH 7.4 adds `blob:` and `'unsafe-inline'`). That is presumably why it is inserted late. Alternatives [INFER]: a static strict meta as the first child of `<head>` in `index.html` plus a separate degraded entry document, or accept the gap and document it. Low severity (no untrusted markup reaches the shell's head), but it should be a conscious choice (R11).
- ARCH 13's `script-src 'self'` allows any same-origin script; hash pins with integrity (F3) narrow it to exact files.

**F29. Permissions-Policy is a response-header mechanism; the same-origin site frame inherits `self`-default features.** Confidence MED. Source: MDN [S18].
- `()` disables a feature for the top-level document and every nested frame; directives have a default allowlist of `*`, `self` or `none`; an `<iframe allow>` can only enable what the parent's policy allows; "By default, if an iframe navigates to another origin, the policy is not applied" [S18]. The MDN page does not say whether `<meta http-equiv="Permissions-Policy">` is honoured: **UNVERIFIED**.
- [INFER] A site frame at the loader's own origin keeps `self`-default features (camera, microphone, geolocation prompts) unless a header disables them. Because ARCH 7.1 already makes the SW add headers to site documents, adding `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), ...` there is cheap (R11); a site that needs a capability can opt in through the allow-listed manifest `headers` (F7). WebRTC itself is not controllable by Permissions-Policy (`03-webrtc-nat-privacy.md`).

**F30. Trusted Types is cross-browser; the shell has four sinks and the vendored bundle one dormant Blob-URL Worker.** Confidence HIGH (BCD) / MED (not run under enforcement). Source date 2026-10-17 [S15, CODE].
- BCD: `TrustedTypePolicyFactory` Chrome 83, Firefox 148 (February 2026), Safari 26; `ServiceWorkerContainer.register()` "enforces trusted types": Chrome 140, Safari 26, Firefox "preview" [S15].
- Sinks in this repository [CODE, v0.1 files]: `boot.js:142` `script.src = '/loader.js'` (TrustedScriptURL); `render.js:195` `sw.register(url, ...)` (TrustedScriptURL where enforced); `render.js:360` `DOMParser.parseFromString` and `render.js:402` `iframe.srcdoc =` (TrustedHTML sinks per the Trusted Types spec [INFER, not re-read], degraded mode only); `boot.js:23` a `new Function(...)` import-support probe (blocked by the CSP anyway, would need a policy under `'trusted-types-eval'`).
- Vendored `webtorrent.min.js` 3.0.21 [CODE]: 0 occurrences of `innerHTML`, `document.write`, `eval(`, `new Function`, `importScripts`; one `new Worker(blobURL, {type: "module"})` inside the `FileSystemFileHandle.createWritable` polyfill (the path ARCH 1 says never to reach by avoiding `fsa-chunk-store`) and one `e.src = this.streamURL` in `streamTo`. Under `require-trusted-types-for 'script'` that Worker would need a default policy unless proven dead.
- `require-trusted-types-for` and `trusted-types` are not on CSP3's meta-unsupported list, but report-only needs a header, so a trial belongs on header-capable hosts first (w1-10 REC-17).

**F31. What each static host lets us set.** Confidence HIGH for what was read [S43, S44, S45].
- Cloudflare Pages `_headers`: up to 100 rules, 2,000 characters per line, applied to static assets only, not to Pages Functions responses; the docs list no disallowed header.
- CloudFront: response headers policies (managed or custom) can add CSP and X-Frame-Options; S3 objects carry system metadata such as `Cache-Control` and user-defined `x-amz-meta-*` only, so security headers need CloudFront in front.
- GitHub Pages: the limits page read has no header controls [S45]; w1-10 REC-11 lists headers it cannot send (not re-verified here). For header-less hosts the SW is the only header layer (F32).

**F32. A Service Worker can add `frame-ancestors` to navigation responses and Chromium enforces it (verified).** Confidence HIGH for Chromium; Firefox and Safari UNVERIFIED. Source date 2026-10-17 [EXP `cloak-and-frame-probe`]. Relation: CONFIRMS ARCH 7.1 (headers on shell and site documents), adds proof.
- A SW answered `/protected` with `Content-Security-Policy: frame-ancestors 'none'`; a page on another origin embedding it got `chrome-error://chromewebdata/`; the control (same page without the SW) loaded. First visits are unprotected because the SW is not installed yet. Precedent: `coi-serviceworker` injects COOP/COEP the same way (`04-service-worker-serving.md`). `Permissions-Policy` and COOP via SW responses were not tested here.

### 2.6 Supply chain

**F33. The npm ecosystem precedent is current.** CISA alert 2025-09-23 on the "Shai-Hulud" worm: over 500 packages compromised, credential theft (GitHub PATs, cloud keys) and self-propagation by publishing as the victim; mitigations include pinning versions, rotating credentials, phishing-resistant MFA, secret scanning and branch protection [S41]. Confidence HIGH. Relevance: we install dev tooling with 251 locked packages (F34); provenance and delay controls (F34-F36) address the same class.

**F34. CORRECTION: with npm 11.19.1 (and 12.x) `allowScripts` is a real default-deny install-script policy; the repository's `allowScripts` key is not inert (verified).** Confidence HIGH. Source date 2026-10-17 [EXP; S37; local npm docs]. Corrects DESIGN-REVIEW S7 ("the current `allowScripts` key is inert") and `docs/review/security.md` M10.
- [EXP] A local tarball with `"postinstall"` was installed with npm 11.19.1 into an empty project: the script did not run; npm printed "npm warn install-scripts 1 package has install scripts not yet covered by allowScripts: evil-pkg@1.0.0 (postinstall: ...)"; `npm install-scripts ls` listed it. The bundled docs of 11.19.1 say "Dependency install scripts are blocked by default. Install commands silently skip lifecycle scripts for any dependency that does not have a matching entry in allowScripts".
- npm CHANGELOG [S37]: 12.0.0 (2026-07-08) "Dependency lifecycle scripts are now blocked by default unless allowed by the root package's `allowScripts` policy"; also `allow-git` and `allow-remote` default to "none"; `min-release-age` (days) and `min-release-age-exclude` exist; `strict-allow-scripts` turns the notice into an error; `--ignore-scripts` overrides `allowScripts`.
- Repository facts [CODE]: `package.json` has `"allowScripts": {"esbuild@0.28.2": true}` and `"engines": {"node": ">=22"}` (no npm range); `package-lock.json` is lockfile v3 with 251 entries, every registry package has `integrity`, and six packages have install scripts: `bufferutil`, `esbuild`, `ip-set`, `node-datachannel`, `utf-8-validate`, `utp-native`. `.npmrc` and `build.lock.json` do not exist yet (ARCH 10 specifies them). An older npm presumably ignores the unknown `allowScripts` field and would run all six [INFER, not tested], so the npm floor must be enforced.

**F35. Registry signatures are universal, provenance attestations are rare, and the WebRTC transport has none.** Confidence HIGH. Source date 2026-10-17 [EXP `npm audit signatures`, npm 11.19.1].
- 226 packages audited: 226 verified registry signatures, 0 invalid, 0 missing; 40 with verified attestations. Production (non-dev) lockfile entries: 36 of 177 attested. Attested: `webtorrent`, `bittorrent-protocol`, `bittorrent-tracker`, `create-torrent`, `parse-torrent`, `magnet-uri`, `bencode`, `bitfield`, `ut_metadata`, `ut_pex`, `fs-chunk-store`, `torrent-discovery`, `esbuild`, `playwright`. Not attested (selection): `@thaunknown/simple-peer` 10.1.2 (the WebRTC data path), `@thaunknown/simple-websocket`, `streamx`, `uint8-util`, `fsa-chunk-store` 1.3.0, `memory-chunk-store`, `ws`, `readable-stream`, `debug`.
- Because the shipped file is the pre-built `webtorrent.min.js`, only `webtorrent`'s own attestation covers its bytes (F36); the inlined transitive code has none.

**F36. `webtorrent@3.0.21` is attested but not reproducible from its repository.** Confidence HIGH. Source date 2026-10-17 [EXP; S42].
- The registry holds two attestations: npm publish v0.1 and SLSA provenance v1 (build type "github-actions-buildtypes workflow v1", workflow `.github/workflows/release.yml` on `refs/heads/master` of `webtorrent/webtorrent`, commit `4df7cda7a3e03ff07c56352d23bfe27493bdcc55`, run `actions/runs/30307025517`, builder `https://github.com/actions/runner/github-hosted`, one transparency-log entry each).
- At that commit there is no `package-lock.json` and no `.npmrc` (both HTTP 404 on raw.githubusercontent.com), and the release job runs `npm i` and then `npx semantic-release`; the package's `prepublishOnly` script runs `npm run build` (webpack configs in `scripts/`), which `npm publish` triggers [INFER that semantic-release publishes through npm; not read]. So the bundle depends on the dependency versions `npm i` resolved on release day: provenance proves where and when it was built, not that it can be rebuilt.
- [EXP] esbuild cannot rebuild it for the browser from the installed sources (unresolved `events` and `path`; webpack supplies Node polyfills), so "build our own from our lockfile" is not a quick win. Recomputed SRI of the vendored file: `sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7`, 222,929 bytes, equal to `01-webtorrent-browser.md`. Relation: CONFIRMS w1-10 REC-5 (hash-pin the vendored file), adds the reproducibility limit.

**F37. esbuild output is deterministic in the cases tried.** Confidence MED. Source date 2026-10-17 [EXP].
- esbuild 0.28.2 on `src/sw/sw.js` + `lib.js` (`--bundle --format=iife --minify --target=es2020 --legal-comments=none --define:self.__BUILD_ID__="abcd1234"`): 10,410 bytes, SHA-256 prefix `0ed18e331fd3d032`, identical across 3 runs and across two different absolute directories. With `--sourcemap=external` the JavaScript was identical but the `.map` files differed because `sources` are relative to the output location. Not tested: a Linux CI runner, other versions, the not-yet-written `app.js` graph.

**F38. Publishing and attestation options.** Confidence HIGH [S38, S39, S40].
- npm trusted publishing (OIDC, no long-lived token): GitHub Actions, GitLab CI/CD, CircleCI; "npm CLI version 11.5.1 or later and Node version 22.14.0 or higher"; provenance is generated automatically from GitHub Actions or GitLab for public packages from public repositories; "Require two-factor authentication and disallow tokens" is available; configurations created after 2026-09-03 default to `npm stage publish`; the page does not call it GA.
- GitHub artifact attestations "by itself provides SLSA v1.0 Build Level 2"; Level 3 needs builds in a reusable workflow that isolates the build; public repositories sign with the Sigstore public-good instance and a public transparency log, private repositories use GitHub's own instance without a transparency log. The SLSA site marks v1.1 "Retired" with v1.2 current; v1.1 Build L2 = hosted platform that generates and signs provenance, L3 = hardened builds where signing secrets are inaccessible to user-defined steps.

### 2.7 Secure defaults and the wire message limit

**F39. Precedents for peer message limits.** Confidence HIGH [S46, S47, CODE].
- libtorrent: `max_peer_recv_buffer_size` default `2 * 1024 * 1024`, "the max number of bytes a single peer connection's receive buffer is allowed to grow to"; `max_metadata_size` default `3 * 1024 * 10240` (31,457,280 bytes) [S46].
- Transmission `is_message_length_correct()` validates the length per message type: choke, unchoke, interested, not interested, have-all, have-none = 1; have, suggest, allowed-fast = 5; bitfield = 1 + ceil(pieces / 8) once the metainfo is known; request, cancel, reject = 13; piece payload at most one block (16 KiB); port = 3; extended at least 2; unknown ids invalid [S47].
- WebTorrent: `ut_metadata` `MAX_METADATA_SIZE = 1E7` (10 MB) and `MAX_BLOCK_LENGTH = 128 * 1024` for an incoming request's length; nothing at the framing layer [CODE].

**F40. Where the cap can be installed, and that it survives minification.** Confidence HIGH [CODE, EXP].
- `Peer` builds `new Wire(type, secure)`; `Peer.onHandshake` calls `swarm._onWire`, which emits the torrent's `'wire'` event; that happens inside the wire's `'handshake'` event, before `_onHandshakeBuffer` runs `this._parse(4, this._onMessageLength)`. An instance-level `_onMessageLength` set in the `'wire'` handler is therefore the one read for the first message. The vendored bundle keeps the names: `_onMessageLength(e){const t=Z(e);t>0?this._parse(t,this._onMessage):(this._onKeepAlive(),this._parse(4,this._onMessageLength))}` (4 occurrences of `_onMessageLength`). ARCH 12 already lists "the message-length patch point grep on the bundle" as a unit test.

**F41. Measured impact of an unbounded length prefix, and a correction (design-critical: no).** Confidence HIGH for Node; browsers not measured. Source date 2026-10-17 [EXP `wire-length-poc.mjs`, `results/wire-length-poc.txt`; two runs of each case on a machine whose load differed]. Relation: CONFIRMS ARCH 13 and w1-11 F11-F13; CORRECTS the example in `docs/review/security.md` B4 and the "4 GiB" wording of ARCH 12 test 11.

| Case (Node 24.22.0, `bittorrent-protocol` 5.0.9, wire fed after a valid handshake) | Result |
|---|---|
| prefix `0xFFFFFFFF`, 16 KiB writes, 32 MiB sent | parser stays at 4 bytes (negative length takes the keep-alive branch); nothing buffered; 0.8 s |
| prefix `0x7FFFFFFF`, 16 KiB writes, 32 MiB sent | parser waits for 2,147,483,647 bytes; 32 MiB buffered; 2.5-2.8 s; RSS 2.2-2.3 GiB |
| same prefix, 128 MiB sent | 44.6 s and 76.6 s (two runs); RSS 8.4-8.5 GiB |
| same prefix, 1 KiB writes, 32 MiB sent | 31.5 s and 59.4 s; RSS about 2.3 GiB |
| 256 KiB wrapper installed, either prefix | wire closed at the prefix, about 50 ms, RSS 52 MiB |

- Cause: `getUint32` is `(b0 << 24) | (b1 << 16) | (b2 << 8) | b3`, a signed 32-bit value, so lengths of 2^31 or more become negative and are treated as keep-alives; and `_write` pushes every chunk then, when more than one chunk is held, calls `concat(this._buffer, this._bufferSize)` over everything buffered so far (index.js lines 849-855), making the cost quadratic in the unfinished message [CODE].
- Not measured: V8/Blink and WebKit ArrayBuffer behaviour and tab-kill thresholds on phones. The algorithmic cost is the same, the memory profile will differ.

**F42. Upstream status and the tested patch.** Confidence HIGH [S48, EXP].
- `bittorrent-protocol` 5.0.9 (published 2026-07-27) is npm `latest`; the repository shows 2 open issues (#115, #57), none about limits; `SECURITY.md` asks for reports by email to the lead maintainer with acknowledgement in 48 hours; no published advisories. A minimal patch (option `maxMessageLength`, default 2 MiB, plus an unsigned length read) is in section 3.5; with it the legitimate messages in `wire-length-regress.mjs` (unchoke, 64-byte bitfield, 16 KiB piece, have) are accepted and a `0x7FFFFFFF` prefix closes the wire immediately. w1-11 R21 already plans an upstream PR; the disclosure email is an outbound action that needs Ash's explicit approval and was **not sent**.

**F43. Pointer- and magnet-supplied hosts are an amplification and probing surface (NEW, code reading).** Confidence MED [CODE, INFER]. 
- WebTorrent merges `urlList` into the parsed torrent and creates a web-seed connection per URL (`torrent.js` L352-359, L578-579), `maxWebConns` defaults to 4 per web seed, and a failed piece is retried every 10 s without limit (w1-11); `xs=` makes the loader GET an arbitrary URL for a `.torrent` (ARCH 5.4). An unsigned `#magnet:...&ws=https://third-party.example/` link therefore makes each visitor's browser send ranged GETs to a third party (CORS preflight blocks most reads but the requests are sent). ARCH 8 ("while gated, load from the web seed only when the pointer has `xs`/`ws`") implies HTTP requests to those hosts before the visitor confirms, and w1-11 notes the gate lists trackers but not `ws`/`xs` hosts.
- `ut_metadata` accepts up to 10 MB of metadata (libtorrent allows about 30 MiB); with `xs` present the loader never needs it, so it matters for bare magnets only.

---

## 3. Recommendations for magnet-web

Priority: **P0** before the first public release (or before the "migrate your site" launch), **P1** before general availability, **P2** first quarter in production, **P3** watch or optional. Effort: **S** under 2 days, **M** under 2 weeks, **L** more than 2 weeks of one engineer. "Relation" says how the item stands against ARCH v0.2 / DESIGN-REVIEW / sibling notes: ADOPTED (already specified; this note adds evidence), EXTENDS, NEW, CORRECTS.

| ID | Pri | Eff | What to build or change | Relation | Why (findings) |
|---|---|---|---|---|---|
| R1 | P0 | S | **Fix three statements.** (a) DESIGN-REVIEW S7 and `docs/review/security.md` M10: `allowScripts` is a working default-deny on npm 11.19+/12, not inert; keep the npm floor. (b) ARCH 12 E2E test 11 and `security.md` B4: use a length of `0x7FFFFFFF` (and keep `0xFFFFFFFF` as a second case); `0xFFFFFFFF` is a keep-alive in 5.0.9. (c) README and CRITIQUE: say that a page cannot verify itself, that the SW gives returning visitors consistency and offline use, not protection from a hostile host, and that WAICT/IWA are the only routes to remove the host from the trust base and neither is shippable. | CORRECTS | F1, F9, F34, F41 |
| R2 | P0 | S | **SW deploy contract plus a checker.** `check-site.mjs` / `verify-deploy.mjs` must assert for `/mw-sw.js`: HTTP 200 with `redirect: 'manual'` (no 3xx), a JavaScript `Content-Type`, `Cache-Control: no-cache`, and byte equality across two resolutions of the host; CloudFront cache policy with minimum TTL 0 for `/mw-sw.js` and HTML; an invalidation step in the deploy script. Without these a redirect, an HTML fallback or a stale edge silently pins the previous (possibly hostile) worker. | EXTENDS w1-10 REC-14 | F25, F26 |
| R3 | P0 | S-M | **Atomic install and fail-open navigation.** The critical precache set (index, boot, loader, sdk, core) must all fetch with `Request.integrity` equal to build-time constants or the install rejects, leaving the previous worker active (verified); optional entries stay best-effort; every navigation falls back to `fetch(request)` and then an offline page instead of a JSON 500 or a rejected promise (`ERR_FAILED`, Firefox three-fault unregistration). Delete the half-filled new cache when the install fails. Skip `integrity` for HTML if the host rewrites it (see Gotchas). Sketch in 3.4. | EXTENDS ARCH 7.1 | F25, F27 |
| R4 | P0 | S | **Kill-switch runbook with measured numbers, plus a second lever.** Ship `dist/mw-sw-kill.js` (ARCH 10 already lists it) and DEPLOY text: deploy it as `/mw-sw.js`, purge the CDN, expect the broken page on the first navigation and a healthy page about 3 s later in Chromium, tell people to wait and not reload repeatedly. Document `Clear-Site-Data: "storage"` on the `/mw-sw.js` response as the last-resort second lever and say exactly what it destroys (ledger identity keys, pins, caches). Add a Firefox and WebKit run of the probes to the release gate (R17). | ADOPTED + EXTENDS DESIGN-REVIEW 20 | F20, F21, F24 |
| R5 | P0 | S | **Wire message cap: keep, harden, upstream.** Keep the 256 KiB cap (ARCH 13); read the length unsigned; fail closed (destroy the wire and show a debug-panel error) if `_onMessageLength` is not a function at runtime, so a future rename cannot silently remove the cap; unit-test against the real bundle; add the regression test of `wire-length-regress.mjs`. Prepare the upstream patch (3.5). Sending the disclosure to the maintainer needs Ash's explicit approval. | ADOPTED (cap) + CORRECTS (test) + w1-11 R21 | F39-F42 |
| R6 | P0 | M | **Put the kill state in the v1 pointer grammar now.** Reserve `st`: absent or `ok` = active; `kill` = stop and purge; **any other value = kill** (fail closed), so future states are safe on loaders already cached. Honour only when signed by the pinned owner or with a valid `rot`; persist it in the `pointers` store; it needs `seq` above the cached record; clears only by a higher-`seq` `st=ok`. Align with w2b-06 R2 (`st=withdrawn`). Loader behaviour in 3.3. | NEW (extends w2b-06 R2) | F22, F23 |
| R7 | P1 | M | **Hardware-backed owner signing without WebAuthn pages.** Add an `alg` key (signed like every key). `alg=sshsig-es256`: signature = SSHSIG over the existing signing input with namespace `magnet-web-pointer-v1`; verify with the ~50-line WebCrypto verifier (probe file is a starting point), require the embedded public key to equal `owner`. `alg=sk-es256`: compact `flags(1) || counter(4) || r||s(64)` with application fixed to `ssh:`. `tools/sign-pointer.mjs` shells out to `ssh-keygen -Y sign`; `keygen.mjs --sk` wraps `ssh-keygen -t ecdsa-sk`. Test vectors from real OpenSSH output; hardware test on the owner's Token2 key before any DEPLOY claim. Keep plain ECDSA (`alg` absent) as the default. | NEW; resolves w1-11 R20 | F13, F14, F12 |
| R8 | P1 | M | **Rotation and recovery rules.** `rot` signing input includes scope and old key and is countersigned by the new key (w1-11 R11); `nk` pre-rotation commitment (w1-11 R12) with the next key on a second token kept offline; a key change that has neither a valid `rot` nor a matching `nk` enters a visible "pending key change" state for a hold-down (RFC 5011 uses 30 days or the TTL; choose the number, Q2) instead of an instant confirm button; document the three recovery paths (nk, hold-down, new scope). | EXTENDS w1-11 R11/R12 | F16, F19 |
| R9 | P1 | S | **Supply-chain configuration and CI tripwires.** `.npmrc`: `ignore-scripts=true` (ARCH 10), `min-release-age=7`, `save-exact=true`, `engine-strict=true`; `package.json` `engines.npm >= 11.19`; explicit `false` entries in `allowScripts` for `bufferutil`, `utf-8-validate`, `utp-native`, `ip-set`, `node-datachannel`; CI: `npm ci`, `npm audit signatures` (fail on any invalid or missing signature, report attested count), `npm install-scripts ls --json` compared with the committed set (w1-11 R15b), `build.lock.json` check. | EXTENDS ARCH 10, w1-11 R15 | F33-F35 |
| R10 | P1 | M | **Release manifest bound to the pointer, plus an external canary.** `build.mjs` emits `dist/release.json` in WAICT shape (`url_hashes`: SHA-256, base64url without padding, for `/mw-sw.js`, `/index.html`, every `/_mw/*` file) and the pointer gains `rel=<b64url sha256(release.json)>`; `check-site.mjs` runs from at least two networks outside the host's account, requests with browser-like `Sec-Fetch-Dest: script` / `Service-Worker: script`, and compares to `rel`. State the limit (a targeted user can still be served differently). Emit a `Integrity-Policy-WAICT-v1` snippet in DEPLOY as "report mode, experimental". | EXTENDS w1-11 R16, w1-10 REC-18 | F1, F4, F9 |
| R11 | P1-P2 | S-M | **Header and CSP hygiene.** (a) SW adds `Permissions-Policy` (deny list) to site documents next to the `frame-ancestors` ARCH 7.1 already adds; (b) allow-list for manifest `headers` in `/.mw/site.json` (F7); (c) decide on the CSP `<meta>` placement (static strict first child versus late insertion, F28); (d) import-map `integrity` for `/webtorrent.min.js` (Chrome 127 / Firefox 138 / Safari 18) with its CSP hash, and do not enable `Integrity-Policy: blocked-destinations=(script)` together with import maps while Safari 26 blocks them; (e) a Trusted Types report-only trial on a header host, then enforce with a default policy only if the dormant Worker is reachable. | EXTENDS w1-10 REC-5/13, w1-11 R15a | F2, F3, F7, F28-F32 |
| R12 | P1-P2 | M | **Signed, attested releases of magnet-web itself.** GitHub artifact attestations on `dist/` (SLSA v1.0 Build L2; L3 needs a reusable workflow), `SHA256SUMS` signed by maintainers (reuse R7 SSHSIG), `build.lock.json` recording sha256 and sha384 of the vendored bundle, the tarball integrity, and the webtorrent attestation commit; exclude source maps from the signed set or fix the output layout. | NEW | F36-F38 |
| R13 | P2 | M | **k-of-n owner signatures as a list, not FROST.** Allow `sig2`, `sig3` (each tagged by `owner2`, `owner3`) with a `thr=` field in the first signed record; verifier counts distinct keys (TUF rule). FROST(Ed25519) only as an optional mode for software cosigners with `@noble/curves`, never required; Ed25519 verification needs a noble fallback below Chrome 137. | NEW (w1-11 R27) | F15, F17 |
| R14 | P2 | M | **`alg=webauthn-es256` for passkey-only owners.** Challenge = SHA-256(signing input); record carries `authenticatorData`, `clientDataJSON` verbatim and the 64-byte signature (+376 base64url characters over plain ECDSA); pin `rpId` and origin; the signer page lives on its own origin with SRI; documented as weaker custody than R7 when the passkey is synced. Use PRF only to wrap an exported backup of the owner key, with at least two credentials registered. | NEW; resolves w1-11 R20 | F11, F13 |
| R15 | P2 | S | **Hardening of unsigned links.** For unsigned pointers: show the `ws`/`xs` hosts in the gate, allow at most two web seeds, require `https:`, refuse userinfo and private or loopback literals, stop after N consecutive failures instead of retrying every 10 s forever; consider a 1 MiB metadata budget for bare magnets. | NEW | F43 |
| R16 | P2 | S | **Optional freshness key.** A root-signed `fk=<pub>` authorising an online key to sign short-lived `{seq, ts}` statements (TUF timestamp role), so a 7-day freshness can coexist with a 90-day pointer `exp` signed by an offline hardware key. Only for sites that need fast kill propagation to offline-capable visitors. | NEW | F18, F23 |
| R17 | P1 | S | **Cross-browser CI for the SW probes.** Run `sw-timing-probe`, `sw-recovery-probe-1/2`, `cloak-and-frame-probe` against Playwright Firefox and WebKit (not installed here); record update delay, failure-mode behaviour, Clear-Site-Data on `sw.js`, tombstone recovery and frame-ancestors per engine in `docs/DEMO-RESULTS.md`; re-run on each Chromium major. | NEW | F20, F24, F25, F32 |
| R18 | P2 | S | **Kill-switch drill in the release gate** (w2b-06 R13): target "tombstone deployed to healthy page in Chromium within 10 s, no user action", and a pointer `st=kill` drill measuring purge time. | EXTENDS w2b-06 R13 | F21, F23 |
| R19 | P3 | S | Navigation preload for drop-in network navigations only, static routing only if measured; neither is needed for safety. | NEW | F27 |
| R20 | P3 | L | An own reproducible webtorrent bundle (replicate the webpack polyfill set, build from our lockfile) only if upstream stays unreproducible; first ask upstream to commit a lockfile and use `npm ci` in `release.yml`. | NEW | F36 |
| R21 | P3 | S | **Watch list** (re-check quarterly): WAICT (a second engine, a W3C draft), SRI for service workers (#1680, #1725), Isolated Web Apps beyond managed ChromeOS, WebAuthn `sign` (PR #2078), signature-based SRI outside Chrome, the Safari 26 import-map plus Integrity-Policy bug, Firefox Trusted Types enforcement in `register()`. | EXTENDS w1-11 R28 | F3, F4, F8, F10 |

**Decisions needed from Ash** (nothing below has been done): (1) approve or decline the coordinated disclosure email to the `bittorrent-protocol` maintainer (outbound; standing rule: no send without approval); (2) allow a hardware test of the Token2 key with `ssh-keygen -t ecdsa-sk` (touch required; no key material leaves the device) and, if it is a PIN+ Release 3.3 key, an inspection of the PIV and OpenPGP applets; (3) pick the hold-down length for DNS-only key changes (Q2); (4) decide the offline-versus-kill rule (Q1).

### 3.1 How the evidence maps to the three user goals

- **Migration ease (drop-in):** R3, R9 and R11(b) keep the added surface small; R15 applies to hub links and to any unsigned stamped pointer. The `_headers` convention (Cloudflare Pages and Netlify style) that `publish.mjs` already imports should feed the allow-listed manifest `headers`, so a migrating site keeps its security headers without reconfiguring the host (Cloudflare Pages limits: 100 rules, 2,000 characters per line, F31).
- **Production readiness:** R1-R6 are the cheap, high-evidence set; R7-R10 are the owner-key and release-integrity work that turns "trust root" statements into something operators can check.
- **Concrete improvements with precedent:** TUF double-signed rotation, KERI pre-rotation, RFC 5011 hold-down, Android proof-of-rotation, IWA dual-signing (F16); WAICT manifest shape (F4); Code Verify style external verification (F6, R10); SSHSIG hardware signatures (F14).

### 3.2 Pointer additions (sketch for ARCH 4 and `pointer.js`)

Keys added to `mw1` before the first release (all signed because unknown keys are kept and signed):

    v=mw1; ...existing keys...; owner=<b64url P-256 pub>; alg=sshsig-es256; nk=<b64url sha256(next owner pub)>;
    st=ok; rel=<b64url sha256(release.json)>; seq=7; exp=<unix>; sig=<alg-specific>

- `alg`: absent or `es256` = today's raw ECDSA r||s over the signing input. `sshsig-es256`: `sig` is the binary SSHSIG blob without the PEM armor (b64url) for message = the signing input bytes, namespace `magnet-web-pointer-v1`, hash `sha512` or `sha256`, public key must equal `owner`. `sk-es256`: `sig = b64url(flags || counter(be32) || r || s)`, signed data `SHA256("ssh:") || flags || counter || SHA256(SSHSIG signed-data)` per PROTOCOL.u2f and PROTOCOL.sshsig. `webauthn-es256`: `sig = b64url(authData) "." b64url(clientDataJSON) "." b64url(r||s)`, plus pinned `rpId` and origin (design when implemented).
- Unknown `alg` = signature invalid (fail closed). Unknown `st` = kill (fail closed). Unknown other keys keep today's rule (kept and signed).
- `nk`: SHA-256 of the next owner public key; a rotation is silent only if `sha256(new owner) == pinned nk`, it carries `rot` (old key over scope, old, new, seq) and a signature by the new key, and it sets a fresh `nk`.
- `rel`: lets a canary or an enforcing browser tie the live shell to the owner-signed record; absent for owners who do not run the loader themselves.
- Record size: today's record is already above one 255-byte TXT string (`splitTxt` handles it); `nk` + `rel` + `st` add about 100 characters; `sshsig-es256` replaces an 86-character `sig` with about 350; `webauthn-es256` with about 460.

### 3.3 Kill and withdrawal behaviour (sketch for `app.js`, `cache.js`, SW)

1. Resolve the pointer as in ARCH 4. If the record is valid for the scope (signature by pinned owner or valid `rot`, `seq` at least the cached one) and `st` is not `ok`: store it in `pointers[scope]`, stop.
2. Stop: do not announce, leave the swarm, `client.remove` every btih of the scope, `deleteSite` for all of them (not only superseded versions), tell the SW to drop `meta.current` (`mw-set-current {btih: null}`) so site routes return the shell notice, show `msg` (percent-decoded, rendered with `textContent`, 140 characters) and the signer fingerprint, `seq` and date.
3. Keep identities and pins (they belong to the visitor); purge ledger payloads only if the record asks (`purge=ledger`, keeping `{e,h,s}` stubs as ARCH 6.1 allows).
4. A later record with higher `seq` and `st=ok` re-enables; a cached killed record stays in force offline.
5. DNS-only (unsigned) `st`: ignored for pinned scopes; honoured for unsigned unpinned scopes (the DNS controller controls them anyway).
6. Loader-level lever, independent of any pointer: tombstone `/mw-sw.js` (F21) or `Clear-Site-Data: "storage"` on the `/mw-sw.js` response (F20). Pointer-level `st` cannot reach a visitor whose loader is itself the problem.
7. Honest limits to state (w2b-06 section 4 holds the legal side): peers and offline devices that ignore or never see the record keep the bytes; the infohash stays valid in any BitTorrent client.

### 3.4 Service Worker changes (sketch)

    // core.js install: all-or-nothing for the critical set (verified: a rejected install keeps the old worker)
    const CRITICAL = self.__CRITICAL__   // [{ path, integrity }] from build.mjs (JS and CSS; HTML only if the host never rewrites it)
    async function install () {
      const cache = await caches.open(CACHE)
      try {
        await Promise.all(CRITICAL.map(async ({ path, integrity }) => {
          const res = await fetch(new Request(path, { cache: 'reload', credentials: 'same-origin', integrity }))
          if (!res.ok) throw new Error('precache ' + path + ' ' + res.status)
          await cache.put(path, res)
        }))
      } catch (err) {
        await caches.delete(CACHE)   // do not leave a half-filled cache behind; rethrow so the install fails
        throw err
      }
      await self.skipWaiting()
    }
    // fetch: never leave a navigation to a rejected promise
    event.respondWith(handleNavigation(event).catch(() => fetch(event.request)).catch(() => offlineResponse()))

    // register (render.js / boot): explicit, even though the default also revalidates the main script
    await navigator.serviceWorker.register('/mw-sw.js', { scope: '/', updateViaCache: 'none' })

    // kill-switch.js (tested shape)
    self.addEventListener('install', () => self.skipWaiting())
    self.addEventListener('activate', (e) => e.waitUntil((async () => {
      for (const k of await caches.keys()) if (k.startsWith('mw-')) await caches.delete(k)
      await self.registration.unregister()
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.navigate(c.url).catch(() => {})
    })()))

### 3.5 Wire cap and the upstream patch

Application-level (tested on the real module and present in the minified bundle):

    // src/loader/torrent.js, in the 'wire' handler before wire.use(...)
    const MAX_WIRE_MSG = 256 * 1024   // bytes after the 4-byte length prefix
    function capWireMessages (wire) {
      if (typeof wire._onMessageLength !== 'function') { wire.destroy(new Error('wire cap unavailable')); return false }
      const orig = wire._onMessageLength.bind(wire)
      wire._onMessageLength = (buf) => {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0)   // unsigned; the library read is signed
        if (len > MAX_WIRE_MSG) { wire.destroy(new Error('oversized wire message: ' + len)); return }
        orig(buf)
      }
      return true
    }

Upstream patch for `bittorrent-protocol` 5.0.9 (`index.js`; full diff in `labs/w2b-05-probes/bittorrent-protocol-5.0.9-maxMessageLength.patch`):

    +const DEFAULT_MAX_MESSAGE_LENGTH = 2 * 1024 * 1024
    -  constructor (type = '', peEnabled = 0) {
    +  constructor (type = '', peEnabled = 0, { maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH } = {}) {
         super()
    +    this.maxMessageLength = maxMessageLength
     ...
       _onMessageLength (buffer) {
    -    const length = getUint32(buffer)
    +    const length = getUint32(buffer) >>> 0   // getUint32 is signed
    +    if (length > this.maxMessageLength) {
    +      this._debug('Error: message length %d exceeds maxMessageLength %d', length, this.maxMessageLength)
    +      this.destroy(new Error('message too large'))
    +      return
    +    }
         if (length > 0) {

`webtorrent`'s `Peer` would pass the option through (`new Wire(type, secure, { maxMessageLength })`). A per-type length check like Transmission's `is_message_length_correct` is the stricter follow-up; the 2 MiB default mirrors libtorrent's per-peer receive buffer cap (F39). Disclosure route: `SECURITY.md` of the repository (email to the lead maintainer); needs Ash's approval.

### 3.6 Supply-chain configuration (sketch)

    # .npmrc
    ignore-scripts=true
    min-release-age=7
    save-exact=true
    engine-strict=true

    // package.json (additions)
    "engines": { "node": ">=22.14", "npm": ">=11.19" },
    "allowScripts": { "esbuild@0.28.2": true, "bufferutil": false, "utf-8-validate": false, "utp-native": false,
                      "ip-set": false, "node-datachannel": false }

`min-release-age` is in days (npm docs, 11.19.1); `--ignore-scripts` overrides `allowScripts`, so keep both: the first works on any npm, the second documents intent and powers `npm install-scripts ls` as a tripwire. CI order: `npm ci` then `npm audit signatures` then the install-script set diff then the build, `build.lock.json` check, release manifest, attestation.

### 3.7 Header sets (sketch, to be tested before use)

For hosts that can send headers (Cloudflare Pages `_headers`, CloudFront response headers policy):

    /*
      Referrer-Policy: no-referrer
      X-Content-Type-Options: nosniff
      Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()
      Content-Security-Policy: <ARCH 13 policy> ; frame-ancestors 'none'
    /mw-sw.js
      Cache-Control: no-cache
    /index.html
      Cache-Control: no-cache

Do not send `Clear-Site-Data` on ordinary responses. For GitHub Pages and plain S3 the SW is the header layer for repeat visits (F32); the first visit stays unprotected and the README should say so.

### 3.8 Tests to add

- Unit: `pointer.js` vectors for `alg=sshsig-es256` (real OpenSSH output, tampered message, wrong namespace, embedded-key mismatch) and `sk-es256` (hardware vector once available); `st` unknown value kills; `nk`/`rot` rotation acceptance and rejection matrix; manifest `headers` allow-list; `capWireMessages` against the real bundle and a missing-method case.
- E2E (Chromium, then Firefox and WebKit): the five probes of `labs/w2b-05-probes/` as regression tests with the measured numbers as ceilings; a deploy that returns a redirect or HTML for `/mw-sw.js` is caught by `check-site.mjs`; the kill-switch drill in the release gate.

---

## 4. Gotchas

1. **Test 11 and the "4 GiB" example.** In `bittorrent-protocol` 5.0.9 a prefix of `0xFFFFFFFF` is a keep-alive. The memory attack needs a length of at most `0x7FFFFFFF`. A test that sends only `0xFFFFFFFF` detects a missing cap but would not notice a cap that mishandles values below 2^31. Use both (R1, R5).
2. **`ignore-scripts` overrides `allowScripts`.** With `ignore-scripts=true` the approved `esbuild` script does not run either (npm docs). Keep both settings for different reasons (R9) and use `npm install-scripts ls` as the tripwire.
3. **`Clear-Site-Data: "storage"` is not selective.** It deletes every IndexedDB database of the origin, including the per-ledger `keys` store (ARCH 6.1), pins and cached sites, in all tabs. It is a last resort. In Chromium `"cache"` alone did not clear Cache Storage, and BCD warns about stale-cache and multi-second hangs for `"cache"` in Chrome.
4. **Reload-mashing starves the update check.** In Chromium the `sw.js` re-fetch started about 2 s after a navigation and navigations closer together than that kept postponing it. A visitor who hits reload repeatedly on a bricked page can stay bricked while an operator who deployed the fix is waiting. Runbooks must say "wait about 3 seconds". Shift+reload bypasses the SW for one navigation per spec but does not unregister it.
5. **A host SPA fallback can pin the old worker.** If `/mw-sw.js` is missing during a deploy, a host that answers unknown paths with `index.html` and status 200 produces a MIME failure (SecurityError) and the previous worker keeps serving without any visible error. Redirects (trailing-slash rules, www/apex rules) do the same. `check-site.mjs` must assert status, MIME and no redirect (R2).
6. **CloudFront minimum TTL overrides origin `no-cache`.** A cache policy with a non-zero minimum TTL serves `/mw-sw.js` and `index.html` from the edge regardless of the origin header (F26).
7. **Integrity checks on HTML can brick the install.** Some hosts and CDNs rewrite HTML (minify, inject scripts; see w1-10 open question 10). Pin JS and CSS with `Request.integrity`, treat the HTML as best-effort, otherwise a rewriting edge makes every install fail and no worker is ever installed.
8. **Safari 26 and import maps.** `Integrity-Policy: blocked-destinations=(script)` blocks modules that an import map covers with `integrity` (BCD note; bug id only from a snippet). Do not combine them yet; import-map `integrity` alone is fine on Chrome 127, Firefox 138, Safari 18.
9. **Self-verification badges mislead.** A green "integrity verified" indicator produced by code the host controls says nothing about a hostile host (F1). Call such a check a consistency check in the UI and docs.
10. **PRF capability flags lie.** Some providers report support and return nothing, or support create but not get; the same provider differs by platform; a lost passkey is unrecoverable. Never make PRF the only path to the owner key (F11).
11. **A WebAuthn signing page is a second supply chain.** Whoever serves it chooses the challenge the authenticator signs; FIDO tokens have no display. The CLI path (`ssh-keygen -Y sign` over a locally built signing input) avoids that. Passkeys that sync (iCloud Keychain, Google Password Manager) are not device-bound; `clientDataJSON` carries Chrome's padding member and other engines may format it differently.
12. **FROST does not fit tokens, and P-256 FROST is not ECDSA.** Shares live in software; only the Ed25519 ciphersuite yields a signature a standard Ed25519 verifier accepts, and WebCrypto Ed25519 starts at Chrome 137, Firefox 129, Safari 17 (below the declared floor).
13. **Provenance is not reproducibility.** `webtorrent@3.0.21` has SLSA provenance and no committed lockfile (F36). 141 of 177 production packages have no provenance at all. SLSA Build L2 for our own releases proves where we built, not that someone else can rebuild; esbuild source maps differ by output layout (F37).
14. **A pointer-level kill does not recall bytes.** Peers and offline devices keep the files; anyone can re-seed the infohash with any BitTorrent client. An unsigned `st` would be a denial-of-service lever, so it is ignored for pinned scopes (F23).
15. **`min-release-age=7` delays security fixes by a week** unless the package is listed in `min-release-age-exclude`; decide who may use the exclusion.
16. **The WAICT names are from an undated draft README.** Header, manifest media type and field names will change; emit the data, not a hard dependency on the names (R10).
17. **What the probes do not cover:** Firefox and WebKit; real profiles with extensions and a disk HTTP cache; phones; the sk-ecdsa path on hardware; Windows or Linux Chromium; the drop-in SW next to a foreign SW; the `Permissions-Policy` and COOP headers injected by a SW. The headless shell served `http://localhost` (a secure context) with an in-memory profile.
18. **Lockdown Mode, private windows and in-app WebViews** may have no Service Worker; there the degraded mode applies (ARCH 7.4) and none of the SW-based safety nets (kill-switch SW, header layer) exist. The host then serves directly.
19. **Search quota.** Seventeen searches ran before the shared quota was exhausted; claims drawn only from search snippets are tagged [SNIPPET].

---

## 5. Open questions

1. **Offline versus kill (Q1).** ARCH 4 renders an expired cached record with a banner. Should a cached record that is more than N days past `exp`, or any cached `st=kill`, fail closed? What is N for sensitive sites (R16 would let a 7-day freshness coexist with a 90-day `exp`)?
2. **Hold-down length (Q2).** RFC 5011 uses 30 days or the TTL. Is 30 days acceptable when the owner lost all keys and has no `nk`? Does the pending key render content meanwhile, or does the old key's last good record stay in force?
3. **Token2 capabilities (Q3).** Does the owner's Token2 key (PIN+ Release 3.x?) support `hmac-secret`; which key types do its PIV and OpenPGP applets hold (P-256? Ed25519?); does `ssh-keygen -t ecdsa-sk` / `ed25519-sk` work through libfido2 on macOS 27 with it? Needs a hands-on test by the owner.
4. **Other engines (Q4).** Update delay and debounce, failure modes, `Clear-Site-Data` on `sw.js`, tombstone recovery, `frame-ancestors` from a SW response, and `clientDataJSON` shape in Firefox and WebKit.
5. **A verified launcher (Q5).** Do we ship a Code Verify style extension that checks `rel` (distribution and maintenance cost), or wait for WAICT? Is a signed-bundle PWA or native wrapper (Tauri, Electron) in scope for sites that need to remove the host from the trust base?
6. **Manifest format (Q6).** Is `release.json` the WAICT `url_hashes` shape itself or ours plus a converter, given the spec is still moving?
7. **PRF-wrapped backups (Q7).** Is an encrypted, PRF-wrapped backup of the owner key wanted at all for v1?
8. **Kill and ledger purge (Q8).** Should a pointer-level kill be allowed to redact ledger payloads on visitors' devices (legal and privacy angle, w2b-06), and who authorises it besides the owner (moderators)?
9. **Distribution of our own releases (Q9).** Publish the loader build to npm with trusted publishing (npm CLI 11.5.1 or newer, provenance automatic) or only as signed GitHub releases?
10. **Safari bug (Q10).** Status of the Safari 26 import-map plus `Integrity-Policy` behaviour (bug id from a snippet only).
11. **Browser memory behaviour (Q11).** How V8/Blink, WebKit and mobile tab-kill thresholds react to an unbounded buffered message; not measured.
12. **Header allow-list (Q12).** Final list of header names a site may set through `/.mw/site.json`, and whether same-origin `Link: rel=preload` is worth keeping.
13. **Upstream webtorrent (Q13).** Would the maintainers commit a lockfile and use `npm ci` in `release.yml`, making the attested bundle reproducible?

---

## 6. Sources

**Opened and read in this run** (date = date of the document or of retrieval 2026-10-17 when undated). Labels are used in section 2.

- S1 Mozilla Hacks, "Trustworthy JavaScript for the Open Web", 2026-05-05: https://hacks.mozilla.org/2026/05/trustworthy-javascript-for-the-open-web/
- S2 waict-wg/waict-integrity-spec README (draft, undated, 73 commits): https://github.com/waict-wg/waict-integrity-spec
- S3 waict-wg/waict-transparency-spec README (introduction only): https://github.com/waict-wg/waict-transparency-spec
- S4 Cloudflare blog, "Improving the trustworthiness of Javascript on the web", 2025-10-16: https://blog.cloudflare.com/improving-the-trustworthiness-of-javascript-on-the-web/
- S5 SecureDrop, "WEBCAT update", 2026-05-04: https://securedrop.org/news/webcat-update-independent-evaluation-waict-and-a-growing-team/
- S6 Schwarz, Bauckholt, Trampert, "Trust on Reload: Securing Browser-Based End-to-End Encryption", WWW '26, Dubai, April 2026, DOI 10.1145/3774904.3792624: https://syssec.cispa.de/papers/trust-on-reload-www2026.pdf (CodeSeal: https://github.com/cispa/codeseal, named in the paper, not opened)
- S7 Meta Engineering, "Code Verify", 2022-03-10 [OLD]: https://engineering.fb.com/2022/03/10/security/code-verify/
- S8 facebookincubator/meta-code-verify README: https://github.com/facebookincubator/meta-code-verify
- S9 FOSDEM 2020, Daniel Huigens (Proton), "Building a Web App that Doesn't Trust the Server" [OLD]: https://archive.fosdem.org/2020/schedule/event/dip_securing_protonmail/
- S10 w3c/ServiceWorker #1680: https://github.com/w3c/ServiceWorker/issues/1680
- S11 w3c/ServiceWorker #1725: https://github.com/w3c/ServiceWorker/issues/1725
- S12 W3C Service Workers, Candidate Recommendation Draft 2026-09-17: https://www.w3.org/TR/service-workers/
- S13 W3C Clear Site Data, Working Draft 2017-11-30 [OLD]: https://www.w3.org/TR/clear-site-data/
- S14 MDN Clear-Site-Data: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data
- S15 MDN browser-compat-data `main`, files fetched 2026-10-17 from https://raw.githubusercontent.com/mdn/browser-compat-data/main/ : `http/headers/Integrity-Policy.json`, `http/headers/Clear-Site-Data.json`, `html/elements/script.json`, `api/TrustedTypePolicyFactory.json`, `api/ServiceWorkerContainer.json`, `api/ServiceWorkerRegistration.json`, `api/NavigationPreloadManager.json`, `api/InstallEvent.json`, `api/Request.json`, `api/SubtleCrypto.json`, `api/PublicKeyCredential.json`
- S16 W3C Content Security Policy Level 3, Working Draft 2026-09-16: https://www.w3.org/TR/CSP3/
- S17 MDN CSP guide: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
- S18 MDN Permissions-Policy: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy
- S19 Shopify Engineering, "Shipping support for module script integrity in Chrome and Safari", 2024-08-02: https://shopify.engineering/shipping-support-for-module-script-integrity-in-chrome-safari
- S20 W3C Web Authentication Level 3, Recommendation 2026-08-25: https://www.w3.org/TR/webauthn-3/
- S21 Yubico, "Developers Guide to PRF" (table "as of mid-2025") [OLD]: https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html
- S22 Corbado, "Passkeys and WebAuthn PRF for end-to-end encryption" (Aug 2026 update) [VENDOR]: https://www.corbado.com/blog/passkeys-prf-webauthn
- S23 Yubico, "Using WebAuthn for Signing": https://developers.yubico.com/WebAuthn/Concepts/Using_WebAuthn_for_Signing.html
- S24 w3c/webauthn PR #2078 "Add 'sign' extension": https://github.com/w3c/webauthn/pull/2078
- S25 OpenSSH PROTOCOL.sshsig: https://raw.githubusercontent.com/openssh/openssh-portable/master/PROTOCOL.sshsig
- S26 OpenSSH PROTOCOL.u2f: https://raw.githubusercontent.com/openssh/openssh-portable/master/PROTOCOL.u2f
- S27 ssh-keygen(1) (OpenBSD manual): https://man.openbsd.org/ssh-keygen
- S28 Token2 T2F2-PIN+ Release3.3 TypeC product page [VENDOR]: https://token2.com/shop/product/t2f2-pin-release3-typec
- S29 The Update Framework specification v1.0.37, last modified 2026-10-08: https://theupdateframework.github.io/specification/latest/
- S30 RFC 5011, Automated Updates of DNS Security (DNSSEC) Trust Anchors, 2007 [OLD]: https://www.rfc-editor.org/rfc/rfc5011.txt
- S31 Android, APK Signature Scheme v3: https://source.android.com/docs/security/features/apksigning/v3
- S32 draft-ssmith-keri (Key Event Receipt Infrastructure), published 2022-07-16, expired 2023-01-17 [OLD]: https://weboftrust.github.io/ietf-keri/draft-ssmith-keri.html
- S33 Chrome for Developers, Isolated Web Apps: https://developer.chrome.com/docs/iwa/ , https://developer.chrome.com/docs/iwa/introduction (updated 2026-02-06), https://developer.chrome.com/docs/iwa/allowlist , https://developer.chrome.com/docs/iwa/key-rotation
- S34 RFC 9591 (FROST), June 2024: https://www.rfc-editor.org/rfc/rfc9591.txt
- S35 noble-curves README (FROST section, audits) and npm registry metadata for `@noble/curves` 2.4.0: https://raw.githubusercontent.com/paulmillr/noble-curves/main/README.md , https://registry.npmjs.org/@noble/curves
- S36 Let's Encrypt, "Ending OCSP Support in 2025", 2024-12-05: https://letsencrypt.org/2024/12/05/ending-ocsp/
- S37 npm CLI CHANGELOG (12.x entries to 2026-10-14) https://raw.githubusercontent.com/npm/cli/latest/CHANGELOG.md ; npm 11.19.1 bundled documentation (`npm-install-scripts`, `using-npm/config`, read locally)
- S38 npm docs, Trusted publishing: https://docs.npmjs.com/trusted-publishers
- S39 SLSA v1.1 levels (page marked Retired; v1.2 current): https://slsa.dev/spec/v1.1/levels
- S40 GitHub Docs, Artifact attestations: https://docs.github.com/en/actions/concepts/security/artifact-attestations
- S41 CISA alert, "Widespread Supply Chain Compromise Impacting npm Ecosystem", 2025-09-23: https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem
- S42 npm registry attestation for webtorrent@3.0.21: https://registry.npmjs.org/-/npm/v1/attestations/webtorrent@3.0.21 ; release workflow at the attested commit: https://raw.githubusercontent.com/webtorrent/webtorrent/4df7cda7a3e03ff07c56352d23bfe27493bdcc55/.github/workflows/release.yml (and HTTP 404 for `package-lock.json` and `.npmrc` at the same commit)
- S43 AWS CloudFront, expiration: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html ; response headers: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-response-headers.html ; S3 object metadata: https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html
- S44 Cloudflare Pages, Headers: https://developers.cloudflare.com/pages/configuration/headers/
- S45 GitHub Pages limits (no header controls on the page): https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- S46 libtorrent settings reference: https://www.libtorrent.org/reference-Settings.html
- S47 Transmission `libtransmission/peer-msgs.cc`: https://raw.githubusercontent.com/transmission/transmission/main/libtransmission/peer-msgs.cc
- S48 webtorrent/bittorrent-protocol issues and security pages: https://github.com/webtorrent/bittorrent-protocol/issues , https://github.com/webtorrent/bittorrent-protocol/security
- S49 NekR/self-destroying-sw README: https://raw.githubusercontent.com/NekR/self-destroying-sw/master/README.md
- S50 Project files read: `docs/ARCHITECTURE.md` (v0.2), `docs/INTERFACES.md`, `docs/review/DESIGN-REVIEW.md`, `docs/review/security.md`, `src/sw/sw.js`, `src/loader/{boot.js,index.html,render.js,torrent.js}`, `package.json`, `package-lock.json`, `node_modules/{bittorrent-protocol,webtorrent,ut_metadata}`; research notes `01`, `03`, `04`, `05`, `06`, `w1-10`, `w1-11`, `w2b-06`, `w2c-02`
- S51 npm registry metadata via `npm view` (bittorrent-protocol, webtorrent, @noble/curves) and `npm audit signatures` run in the project, 2026-10-17

**Seen only in search-result snippets, not opened** (treat as leads):
- X1 1Password community, PRF extension not spec-compliant (June 2026): https://www.1password.community/developers-69/browser-extension-webauthn-prf-extension-not-spec-compliant-24672
- X2 Apple Developer Forums 774112, PRF in Safari's cross-device flow: https://developer.apple.com/forums/thread/774112
- X3 Help Net Security, Bitwarden passkey login on Chromium, 2025-11-19: https://www.helpnetsecurity.com/2025/11/19/bitwarden-browser-extensions/
- X4 caniuse import-map integrity: https://caniuse.com/mdn-html_elements_script_type_importmap_integrity
- X5 web-features issue 4477: https://github.com/web-platform-dx/web-features/issues/4477
- X6 WebKit bug 326340 (Safari, Integrity-Policy and import maps; id only)
- X7 Yubico, YubiKey 5.8 signing preview: https://www.yubico.com/blog/yubico-will-introduce-secure-and-privacy-capable-passkey-enabled-digital-signatures-in-upcoming-5-8-firmware/
- X8 Chrome Platform Status, Isolated Web Apps entry: https://chromestatus.com/feature/5146307550248960
- X9 Cloudflare, "Cloudflare verifies the code WhatsApp Web serves to users", 2022: https://blog.cloudflare.com/cloudflare-verifies-code-whatsapp-web-serves-users/

Prompt-injection screen: no imperative text directed at an AI reader was found in any fetched page. One fetched page (SecureDrop) carried unrelated Tor Browser banner text; it was ignored as site boilerplate.

---

## 7. Experiments (appendix)

All scripts and raw outputs are in `docs/research/labs/w2b-05-probes/` (`RUN.txt` has the commands). They are throw-away test code. Environment: macOS arm64; Node v24.22.0; Playwright 1.64.1; Chromium 156.0.8078.4 headless shell with a fresh in-memory profile serving `http://localhost` (secure context); `bittorrent-protocol` 5.0.9; npm 11.19.1; OpenSSH_10.6p1. Run on 2026-10-17 on a machine shared with other agents, so wall-clock figures for the CPU-bound wire PoC vary between runs (both runs are reported).

| Probe (file) | What it tests | Key results |
|---|---|---|
| `wire-length-poc.mjs`, `wire-length-regress.mjs`, `bittorrent-protocol-5.0.9-maxMessageLength.patch` | Unbounded message length in `bittorrent-protocol` 5.0.9; app-level wrapper; upstream patch; legitimate traffic | F41, F42; `results/wire-length-poc.txt`, `results/wire-length-regress-*.txt` |
| `sw-timing-probe.mjs` | Delay until `sw.js` is re-fetched after a navigation; tombstone recovery time (n=6) | first fetch 1978-1987 ms (median 1982); recovery 2579-2623 ms (median 2610); `results/sw-timing-probe.json` |
| `sw-recovery-probe-0.mjs` | first harness: `Clear-Site-Data` variants on `sw.js`; navigation relay; redirect and wrong MIME on `sw.js`; tombstone recovery (single run, 2797 ms) | F20, F25; `results/sw-recovery-probe-0.json` |
| `sw-recovery-probe-1.mjs` | `Clear-Site-Data` on `sw.js` and on navigations with page re-registration off (SW relay, no handler, SW-synthesized, controls); syntax error, install failure, handler rejection | F20, F25 tables; `results/sw-recovery-probe-1.json` |
| `sw-recovery-probe-2-heal.mjs` | SW whose navigation handler rejects; healing with 400 ms versus 3 s spacing | no re-fetch in 14 attempts at 400 ms; healed at 3.04 s with 3 s spacing; `results/sw-recovery-probe-2-heal.json` |
| `cloak-and-frame-probe.mjs` | Request fingerprints for script, `import()`, `fetch()`, SW script; SW-injected `frame-ancestors` | F1, F32; `results/cloak-and-frame-probe.json` |
| `webauthn-sign-probe.mjs` | CDP virtual authenticator: assertion with challenge = SHA-256(input) verified by WebCrypto; PRF determinism | F13: sizes 37 / 244 / 71 bytes, verify true, tamper rejected, PRF stable; `results/webauthn-sign-probe.json` |
| `sshsig/verify-sshsig.mjs` | WebCrypto-only verifier for `ssh-keygen -Y sign` output; synthetic sk-ecdsa | F14: real ecdsa signature accepted, tampering and wrong namespace rejected, OpenSSH agrees; `results/sshsig-verify.txt` |

Additional one-off checks (commands in the text, not saved as files): `npm audit signatures --json --include-attestations` (F35); a planted `postinstall` under npm 11.19.1 (F34); esbuild determinism over three runs and two directories (F37); attestation decode and release-workflow fetch for `webtorrent@3.0.21` (F36); esbuild attempt to bundle `webtorrent` for the browser (F36); SHA-384 recomputation of the vendored bundle (F36).

Not run: Firefox, WebKit, Android or iOS; real FIDO hardware; the unbuilt `app.js` graph; a Linux CI runner.

---

## 8. Where this note touches existing documents

| Document and item | Effect of this note |
|---|---|
| ARCH 4 (pointer v1) | add `st` (fail closed), `alg`, `nk`, `rel`; `rot` scope and old key (w1-11 R11); required `exp` stays (R6, R7, R8, R10) |
| ARCH 5.1 step 6 | choose static strict CSP meta versus late insertion (R11c) |
| ARCH 7.1 | atomic install, navigation fail-open, `Request.integrity`, `Permissions-Policy`, manifest `headers` allow-list (R3, R11) |
| ARCH 10 | `.npmrc`, `engines.npm`, `allowScripts` denies, `release.json`, signed `SHA256SUMS`, attestation, `build.lock.json` content (R9, R10, R12) |
| ARCH 12 test 11 | add `0x7FFFFFFF` and an unpatched control; add the regression test (R1, R5) |
| ARCH 13 | keep the trust-root sentence; replace "supply chain: `.npmrc ignore-scripts`" by the R9 list (R1, R9) |
| DESIGN-REVIEW 20 | confirmed and quantified (F21, F24, F25); add the second lever and the wait-3-seconds rule (R4) |
| DESIGN-REVIEW S7 and `security.md` M10 | correction: `allowScripts` is not inert on npm 11.19+ (F34, R1) |
| `security.md` B4 | correction of the `0xFFFFFFFF` example (F41, R1) |
| w1-10 REC-14, REC-18 | REC-14 gains the SW contract assertions (R2); REC-18 becomes a consistency and canary feature, not a defence (R10) |
| w1-11 R11, R12, R15, R16, R20, R21, R27, R28 | R20 resolved with verified recipes (R7, R14); R21 patch ready (R5); R27 reframed as signature lists (R13); R16 and R28 reinforced (R10, R21) |
| w2b-06 R2, R13 | `st` semantics (R6); drill target (R18) |
