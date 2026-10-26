# w2c-06 - Standards alignment and existing ecosystem efforts (do not reinvent)

- **Project:** magnet-web (static loader + Service Worker, sites fetched by magnet link over WebTorrent, signed site ledger, pointer from fragment / `<meta>` / DNS TXT over DoH / cache)
- **Topic:** which existing standards, registries, protocols and 2024-2026 projects magnet-web should align with, reuse, or deliberately ignore; what to propose as a spec for the pointer record and the ledger format
- **Research date:** 2026-10-17. Every "current" statement is as of this date. Sources older than 2024 are marked **(OLD)**.
- **Resume note:** on resume, `docs/research/` held no `w2c-*` file, so nothing for this topic was lost or overwritten. Sibling files written the same day (`w1-07`, `w1-09`, `w1-10`, `w1-11`) overlap parts of this topic; I cite them instead of repeating them (see "Overlap" below).
- **Method limits (read this):** the shared WebSearch budget (200 calls per turn, all agents) ran out after three searches (Planktos, PeerWeb, Brave/IPFS). After that I used only direct fetches of known primary URLs (RFC and IANA text, raw GitHub files, npm registry, vendor docs). I did not use search engines, archives or proxies. Things I could not search are listed in "Open questions". GitHub's unauthenticated API was rate-limited by sibling agents, so repository status comes from Atom feeds, raw files and the npm registry.
- **Confidence legend:** **High** = primary text read in this session and a second independent source or a local code check agrees. **Medium** = one primary source, or a model-summarised fetch ("WebFetch summary") of a primary page. **Low** = search-result snippet or inference (labelled).
- **[DESIGN-CRITICAL]** = would change the architecture or a compatibility promise if wrong.
- **Overlap:** `05-doh-dns-txt.md` (F8-F11: DNSLink, IANA registry state on 2026-10-14, btlink, atproto), `01-webtorrent-browser.md` (BEP coverage), `06-browser-chain-vs-crdt.md` (Ed25519 in WebCrypto, chain data model), `w1-07-prior-art.md` (ZeroNet, IPFS SW gateway, PeerTube, nsite, PeerWeb), `w1-09-protocol-handler-magnet.md` (registerProtocolHandler in depth, with experiments), `w1-10-static-hosting-bootstrap.md` and `w1-11-security-threats.md` (PSL, signature-based SRI, WAICT, IWA). This file adds: RFC 8552 mechanics and a correction, DNS TXT syntax standards vs the v0.2 pointer grammar, DNSLink governance, BEP status and dormancy, the status of Web Bundles / SXG / IWA, key-encoding standards (Multikey, JCS, Ed25519), key-addressed names without DNS (pkarr, BEP 46, btlink), and spec skeletons.
- **Baseline I checked recommendations against:** `docs/ARCHITECTURE.md` v0.2 (2026-10-17, normative), `docs/review/DESIGN-REVIEW.md` (items 1-25), `src/chain/crypto.js` (ECDSA P-256, 65-byte uncompressed public keys as base64url).

---

## 1. Summary

1. **No standards body will define this for us; everything adjacent is de-facto or stalled.** The BEP repository's newest commit is **2020-05-01** and the highest BEP number is 55 (created 2018-12-29); BEP 44, 46, 47, 49, 52 and 53 are all still *Draft*. The DNSLink "standard" organisation (`dnslink-std`) is **fully archived** (org archived 2026-07-31, no namespace registry). The IETF Web Packaging WG is **concluded** (2023), Chrome removed navigation to Web Bundles in **February 2023**, and Google Search Central's signed-exchange documentation URL now redirects to a **2026-07-01** note that removed the signed-exchange references. Plan: publish two small specs of our own with test vectors, and align *syntax and encodings* with mature standards (RFC 6376 tag-lists, RFC 7208 string joining, RFC 8785 JCS, RFC 8552 registry, W3C Multikey, BEP 9/19/53). [DESIGN-CRITICAL]
2. **Registering `_magnet` is cheap, precedented and not urgent.** RFC 8552 makes the registry *Expert Review*; the expert checks only that the entry is "sufficiently clear, precise, and complete" and unique, and the Reference "MUST have a stable resolution to the organization controlling that registry entry". In 2026 the registry accepted an Informational RFC (`_for-sale`, RFC 10023), an Internet-Draft (`_x402`, 2026-08-11) and a plain URL specification (`_nnu-verification`, 2026-08-28). `_magnet`, `_dnslink`, `_atproto`, `_btlink`, `_ipfs` are absent (registry XML updated 2026-10-16). **Correction to `05-doh-dns-txt.md` F9: `_dmarc` IS registered** (since 2018-11-29, now RFC 9989). [DESIGN-CRITICAL: the label is a public compatibility promise]
3. **DNSLink can technically carry other namespaces, but do not build on it.** The page says `dnslink=/<namespace>/<identifier>` at `_dnslink.<domain>`, "never error on invalid record", several namespaces may coexist. There is no namespace registry, the organisation is archived, and IPFS's own stewardship collapsed in 2026 (Shipyard's funding was not renewed; its work ended 2026-09-30; IPFS Companion, Helia, Kubo and the Service Worker Gateway lost dedicated maintainers). `dnslink=/btih/<hex>` would be harmless and unconsumed. Decision: no dual-publish in v1. [DESIGN-CRITICAL]
4. **The v0.2 pointer grammar is "DKIM-like" but deviates from RFC 6376 in two places, and from the IETF DNSOP draft in its separator.** RFC 6376 s3.2 says tags are case-sensitive and a duplicate tag makes the whole list invalid; v0.2 lowercases keys and allows repeated `tr`, `ws`, `xs`. The IETF DNSOP domain-verification draft (rev 13, 2026-06-22, not yet an RFC) wants space-separated pairs with the token first. That is fine if the spec says so explicitly. A realistic signed pointer is **about 480 bytes** (two TXT strings), so also state the size budget (RFC 6763 s6.2: 400 B fits a 512-byte UDP answer, 1300 B is the hard "NOT RECOMMENDED" line; pkarr packets are capped at 1000 B). [DESIGN-CRITICAL]
5. **Ed25519 is now in WebCrypto in every current engine** (Chrome/Edge/WebView 137, Firefox 129, Safari/iOS 17, Samsung Internet 30; MDN data of 2026-10-15; WICG issue thread agrees). ARCHITECTURE v0.1 s6.1's "Ed25519 is not yet universal" is outdated and v0.2 still fixes raw P-256 in `owner=`. Because the **owner key never enters a browser** (v0.2 s6.2), the iOS CryptoKey-persistence worry that justified deferring Ed25519 does not apply to it; only in-browser *verification* matters. Cheap, compatibility-preserving step: make key strings algorithm-tagged now (W3C Multikey or a `p256:`/`ed25519:` prefix) and keep P-256 as the default. This unlocks BEP 44/46, pkarr, IWA and DID alignment later without a pointer version bump. [DESIGN-CRITICAL]
6. **BEPs that matter for web delivery, and what WebTorrent actually does with them.** Implemented in browser WebTorrent: BEP 9, 10, 19 (web seeds), 53 (`so=`). I verified in the local `webtorrent@3.0.21` source that an `xs=` http(s) URL makes the client fetch the `.torrent` from the server and ignore it unless the infohash matches, and that `magnet-uri@7.0.10` parses `xs=urn:btpk:` and `xt=urn:btmh:1220...`. Not implemented in the browser: BEP 44, 46, 52 (webtorrent#886, #1117), DHT, PEX. BEP 47 padding files are not understood by WebTorrent either (a hybrid v1+v2 torrent would surface `.pad/N` files). BEP 10 extension names must carry a 1-2 character client prefix (`mw_chain` complies; extra top-level handshake keys must be prefixed too).
7. **Browser-platform proposals are not a foundation.** Web Bundles: IETF draft stuck at -01 (Dec 2021), WG concluded, Chrome navigation support removed 2023-02, `wbn` parser last released 2023-03. Signed Exchanges: Google Search Central's 2026-07-01 AMP-documentation update removed the signed-exchange references and the former SXG documentation URL now answers HTTP 301 to that note. Isolated Web Apps: Chrome docs (updated 2026-02-06) still limit them to Chrome Enterprise-managed ChromeOS and select partners; Direct Sockets (TCP/UDP) is IWA-only, so no native-style BitTorrent in ordinary browsers. What IWA *does* offer as precedent: identity derived from a signing key (`isolated-app://<key-derived id>`), Ed25519 **or** ECDSA P-256 keys, and signing key kept offline.
8. **Closest production precedent for the architecture is the IPFS Service Worker Gateway (`inbrowser.link`)**: Helia in a Service Worker, one subdomain origin per content root, DNSLink via DoH, designed so that the operator's server only serves small static files (under 10 MiB). `ipfs.io` and `dweb.link` have redirected browsers to it since 2026-05-11 (phased; announced as complete on 2026-08-25). Its lessons transfer (subdomain isolation + PSL, a visitor-side `?ipfs-sw-unregister=true` escape hatch, and the IPFS post's conclusion that interoperability, "clear specs, real conformance tests", is the scarce thing); its organisational fragility is the warning.
9. **WebTorrent-based "website loaders" (2016-2026) never combined a signed mutable pointer with DNS.** Planktos (last commit 2018-09-18, "not recommended for production"), Bugout (2024-05-08), PeerWeb (Omodaka9375, last commit 2025-10-07; HN critique: unsigned magnet links, peers missing, sandbox weakened), WEB25.cloud (a PeerWeb fork, commits through 2026-10-14: signed `.torrentchain`, EVM wallet in a WebAuthn-PRF vault, sandboxed opaque-origin iframe, HTTP mirror after an 8 s P2P deadline). Separately, **PeerTube removed WebTorrent from its player in the 6.0.0 release line (issue #5465, closed 2023-07-10)**, citing bundle size, slow start and unused P2P, and kept P2P only under HLS. Both support treating P2P as an accelerator over an HTTP origin (`ws=`/`xs=` always present).
10. **Key-addressed mutable names without DNS are an active, converging pattern we lack:** pkarr (Ed25519 key = domain, BEP 44 over the Mainline DHT, HTTP relays with CORS; repo active 2026-10-16; public relay `pkarr.pubky.app` answered with CORS on 2026-10-17), btlink (`<base36 pubkey>-pk.<tld>`, BEP 46), bt-fetch (`bittorrent://<64-hex public key>`; same author as Agregore), nsite NIP-5A (base36 pubkey subdomains), IWA (key-derived origin). Today a magnet-web site without a domain is immutable (`#magnet:`). A pkarr/BEP 46 source would give a domain-free updatable address, but it needs an Ed25519 owner key (see 5).
11. **Hostname grammar precedents agree:** one DNS label (63 octets), lowercase, base32 or base36 (IPFS subdomain spec, NIP-5A, btlink). A SHA-256 infohash in hex is 64 characters and cannot be a label; base32 is 52. v0.2's hub label `base32(sha256(ledgerId))[0:32]` is already compatible. A wildcard Public Suffix List entry is the established companion (dweb.link and inbrowser.link are on the PSL); requirements: more than 2 years of registration left, a `_psl` TXT record pointing at the PR, no SLA.
12. **Reuse / avoid.** Reuse: RFC 6376 ABNF, RFC 7208 string joining, RFC 8785 JCS, W3C Multikey (format only), BEP 9/19/53, WebTorrent's `xs=`/`so=`, IPFS subdomain-gateway label rules, SW unregister parameter, pkarr relay protocol (client-side, about 100 lines, not the 1.7 MB WASM package), btlink naming for interop. Avoid as dependencies: `dnslink`/`@dnslink/js` (last release 2022-06-03), Helia packages (maintenance in flux), `wbn`/Web Bundles, Planktos/PeerWeb code, `bt-fetch` (AGPL-3.0-or-later, last release 2023-06-29), Iroh WASM (browser traffic is relay-only).
13. **Top actions (section 3):** write down the pointer grammar as a conformant "tag-list profile" with a size budget and a v-first rule (P0, S); algorithm-tag key strings before freezing v1 (P1, S); publish `MW-PTR/1` and `MW-LOG/1` as stable specs with test vectors (P1, M); then ask IANA for `_magnet` (P2, S); add a `pkarr`/BEP 46 source once Ed25519 owner keys exist (P2, M).
14. **Not verified:** Brave's historical `magnet:` handling is taken from `w1-09` (primary reading there), not re-derived; libtorrent's BEP 46 support (its features page does not list it); WAICT; whether any public pkarr relay other than `pkarr.pubky.app` exists; IANA expert turnaround time.

---

## 2. Findings

Source IDs (S1...) are defined in Appendix A; every URL there was actually fetched. "Source date" is the publication or last-update date of the source where one was visible.

### 2.1 DNS names, registries and TXT syntax

**F1 [DESIGN-CRITICAL] RFC 8552 registration mechanics.** *Confidence: High.*
- The registry "Underscored and Globally Scoped DNS Node Names" has registration procedure **Expert Review**; experts listed: Frederico A C Neves, Paul Wouters. Key = (RR Type, `_NODE NAME`), name recorded lowercase. [S1][S2]
- RFC 8552 s2: "If a public specification calls for use of an underscored node name, the global underscored node name ... MUST be entered into this registry." s4.1.5: the review is "solely to determine adequacy of a requested entry" and checks only that "the details for creating the registry entry are sufficiently clear, precise, and complete" and that (RR type, name) is unique; "other matters of the specification's technical quality, adequacy, or the like are outside of scope." s4.1: "The required Reference for an entry MUST have a stable resolution to the organization controlling that registry entry." s3 gives the request template: `Per RFC 8552, please add the following entry ... | RR Type | _NODE NAME | Reference |`. [S1]
- Requests go through IANA's "General Protocol Registration Request Form" (the forms page lists no registry-specific form for this registry; it says to check the registry's procedure first; early allocation applies only to RFC-required procedures). [S3]
- Source dates: RFC 8552 March 2019 **(OLD)** but it is still the governing BCP 222; IANA pages read 2026-10-17 (registry XML `updated` 2026-10-16).
- Implication: `_magnet TXT` needs a public, stable, clear specification (A3 below). Nothing about the topic's popularity or technical merit is reviewed.

**F2 Registry state and what recent entries used as a "Reference".** *Confidence: High* (IANA XML, XHTML and CSV agree). [S2]
- 69 records on 2026-10-17. **Absent:** `_magnet`, `_dnslink`, `_atproto`, `_btlink`, `_ipfs`, `_dnsaddr`, `_bittorrent`, `_torrent`.
- Entries from the last two years and their reference type: `_er` (RFC 9567, 2024-03-06); `_signal` (RFC 9615, 2024-06-03); `_splitdns-challenge` (RFC 9704, 2024-07-27); `_dsync` (RFC 9859, 2025-03-20); `_stun/_stuns/_turn/_turns` (RFC 8489/8656, 2025-09-11); **`_for-sale` (RFC 10023, Informational, IETF stream, SIDN Labs, July 2026; registry record 2026-02-09)**; **`_x402` (Internet-Draft `draft-hawkins-x402-dns-discovery-01`, 2026-08-11)**; `_tls` (RFC 8460, added 2026-08-20); **`_nnu-verification` (a plain URL: `https://nnu.us/specifications/nnu-domain-verification-1.0.txt`, 2026-08-28)**. [S2][S4]
- Reading: within the last ten weeks the experts accepted both a draft and a URL-hosted text specification. A one-document spec at a permanent URL is a realistic reference.

**F3 Correction to `05-doh-dns-txt.md` F9: `_dmarc` is registered.** *Confidence: High.* The XML record is `TXT _dmarc`, date 2018-11-29, `updated="2025-03-27"`, reference RFC 9989 (DMARC, May 2026, obsoletes RFC 7489); RFC 8552 s4's initial table already listed `_dmarc [RFC7489]`. Widely deployed conventions that never registered are `_dnslink` and `_atproto`, not `_dmarc`. The conclusion of 05 (registration of `_magnet` is possible and cheap) is unchanged. [S1][S2][S11]

**F4 [DESIGN-CRITICAL] The written TXT-record syntax standards disagree with each other, and v0.2 sits between them.** *Confidence: High* (all rule texts read). [S5][S6][S7][S8][S9]

| Rule | RFC 6376 s3.2 (DKIM; the DMARC, MTA-STS and TLS-RPT records use a similar `v=...; tag=value` shape, not re-read here) | RFC 7208 s3.3 (SPF) | RFC 6763 s6.3 (DNS-SD) | IETF DNSOP domain-verification draft -13 | RFC 1464 / DNSLink / atproto | magnet-web v0.2 s4 |
|---|---|---|---|---|---|---|
| Separator | `;` between tag-specs | (SPF terms) | one `key=value` per character-string | space | one attribute per record | `;` |
| Multiple character-strings | not stated here | MUST concatenate "without adding spaces" | each string is a separate attribute | MUST concatenate | n/a | concatenate (`joinTxtData`) |
| Tag/key case | tags **case-sensitive** | n/a | "Case is ignored when interpreting a key" | keys case-insensitive | n/a | keys **lowercased** |
| Duplicate tag | "Tags with duplicate names MUST NOT occur ... the entire tag-list is invalid" | n/a | "SHOULD NOT appear more than once" | each token in its own RR | multiple records | `tr`, `ws`, `xs` **repeatable** |
| Unknown tags | "MUST be ignored" | n/a | n/a | n/a | "ignore and move to the next" | kept **and signed** |
| First element | `v=` by convention of each family | `v=spf1` first | n/a | "The token MUST be the first element" | n/a | not stated |

- The draft is **not yet an RFC** (rev 13, 2026-06-22, intended BCP, lead author S. Sahib of Brave Software; expires 2026-12-24). Its other recommendations: TXT is the RECOMMENDED validation record; an application-specific underscore label; use the IANA registry and avoid existing labels; the domain owner SHOULD sign the zone with DNSSEC; short TTL. [S9]
- Implication: the grammar need not follow any of them, but the spec must (a) state the deviations (case-folded keys, repeatable keys, signed unknown keys), (b) require `v=mw1` first, (c) state string-joining as concatenation without spaces. None of this changes parsing code materially; it removes ambiguity before the first record is published.
- Source dates: RFC 6376 September 2011 **(OLD)**, RFC 7208 April 2014 **(OLD)**, RFC 6763 February 2013 **(OLD)**, RFC 1464 May 1993 **(OLD)**; DNSOP draft -13 dated 2026-06-22; ARCHITECTURE v0.2 s4 dated 2026-10-17.

**F5 Measured size of a realistic pointer, and the limits that apply.** *Confidence: High (computed locally; limits from RFCs and specs).*
- A signed pointer with `ws`, `xs`, two `tr`, `chain`, `max`, `owner`, `seq`, `exp`, `sig`: **479 bytes** with the raw 65-byte P-256 owner (87 characters), **435-442 bytes** with a 43-50 character owner encoding. Always two TXT strings. Adding `rot`, `gen`, `cs`, `consent` can exceed 600 B.
- Limits: 255 B per character-string (RFC 1035 via RFC 7208 s3.3); RFC 6763 s6.2: typical 200 B, "under 400 bytes should allow it to fit in a single 512-byte DNS message", "TXT records larger than 1300 bytes [are] NOT RECOMMENDED"; pkarr signed packet DNS payload "less than 1000 bytes" and relay PUT cap 1072 B; BEP 44 `v` "may" be rejected above 1000 B. [S7][S57][S21]
- Implication: set a budget in the spec: SHOULD stay under 450 B for DNS, MUST stay under 900 B so the surrounding DNS packet (12-byte header, a 62-byte owner name `_magnet.<52-char key>`, 10 bytes of RR fields, one length byte per 255-byte string) still fits pkarr's 1000-byte limit. `xs` could be derived by convention (`<ws>/<name>.torrent`) if space is tight.
- Source dates: computed 2026-10-17; RFC 6763 February 2013 **(OLD)**; BEP 44 created 2014-12-19 **(OLD)**; pkarr design documents read 2026-10-17.

**F6 Other registries a magnet-web spec may touch.** *Confidence: High* (registries read). [S13][S14][S16][S12]
- URI schemes: provisional registration is **First Come First Served** (RFC 7595 s4); permanent is Expert Review. Provisional entries exist for `ipfs`, `ipns`, `dweb`, `hyper`, `dat`, `did`, `magnet` (contact Dave Thaler); `ni` is Permanent (RFC 6920). **`bittorrent`, `bt`, `btih` are not registered.** (bt-fetch uses `bittorrent://` and `bt://` unregistered; btlink avoids a new scheme by using HTTPS hostnames.) No new scheme is needed: `https://<hub>/#magnet:` works everywhere.
- Well-known URIs: **Specification Required**, "provisional" status allowed, requests by the IANA form or `wellknown-uri-review@ietf.org` (RFC 8615 s3.1). Only needed if a `/.well-known/` pointer file is introduced. Community precedents in the registry (CSV read 2026-10-17): `nostr.json` (provisional, 2024-03-18, Reference a GitHub NIP URL), `did.json` (provisional, 2023-01-31), `tor-relay` (provisional, 2020-10-06); `atproto-did` and `dat` are not registered.
- Media types: IANA's `application` registry has no `application/x-bittorrent`, `application/webbundle` or `application/signed-exchange`; it has `application/dns-message` (RFC 8484) and `application/dns+json` (RFC 8427). [S16]
- Link relations: RFC 6249 (Metalink/HTTP, Proposed Standard, June 2011 **(OLD)**) shows `Link: <http://example.com/example.ext.torrent>; rel=describedby; type="application/x-bittorrent"`: an existing, standards-track way to advertise a torrent from an HTTP resource. [S12]
- IETF Internet-Drafts: a datatracker name search on 2026-10-17 found **no draft with `dnslink`, `magnet`, `btih` or `webseed` in its name**, and for `torrent`/`bittorrent` only three BEHAVE/PCP drafts from 2011-2012 about port and address sharing. [S10]
- Source dates: RFC 7595 June 2015 **(OLD)**, RFC 8615 May 2019 **(OLD)**, RFC 6249 June 2011 **(OLD)**, RFC 6920 April 2013 **(OLD)**; IANA registries and datatracker queries read 2026-10-17.

### 2.2 DNSLink

**F7 [DESIGN-CRITICAL] What the DNSLink specification allows.** *Confidence: High for the text; Medium for "no registry" (absence evidence from one page plus the organisation listing).* [S30][S31]
- Record: TXT at **`_dnslink.<domain>`** (MUST), RFC 1464 `dnslink=/<namespace>/<identifier>`. "Implementations should never error on invalid record. Simply ignore and move to the next one." Multiple records and namespaces coexist (`/ipfs/`, `/hyper/`, `/foo/`); sort lexicographically before evaluating; CNAME delegation is suggested; a TTL of about 60 s is recommended. The page contains no namespace registry or registration process.
- The page's own rationale matches magnet-web: publish DNSLink records for "website content addressed with non-HTTP protocols" so "user agents ... opportunistically upgrade to more modern and decentralized transports".
- So `dnslink=/btih/<40 hex>` is grammatical and would be skipped by compliant resolvers (`@helia/dnslink` skips unknown namespaces: `05` F8, source read there). Nobody consumes it. IPFS Companion does not query DNS itself: per `05` F8 (source read there) it asks the local Kubo node to resolve `/ipns/<fqdn>`, so a `/btih/` entry would never reach any handler, and Companion is one of the projects that lost its maintainers (F8).
- Source dates: the dnslink.dev page is undated (fetched 2026-10-17); the GitHub organisation listing was read 2026-10-17.

**F8 [DESIGN-CRITICAL] DNSLink has no steward, and the IPFS tooling around it lost its maintainers in 2026.** *Confidence: High* (the organisation page, the npm registry, two IPFS posts and the repository README agree). [S31][S26][S33][S32][S34]
- `github.com/dnslink-std`: all five repositories (`dnslink-website`, `go`, `js`, `test`, `community`) are archived; the organisation was archived 2026-07-31 (WebFetch summary of the org page; `05` F8 independently recorded the same date for `dnslink-std/js`). npm `@dnslink/js` 0.13.0 was last published 2022-06-03.
- IPFS Shipyard (post dated 2026-08-24): Protocol Labs did not renew funding; final day of IPFS work **2026-09-30**; projects losing dedicated maintainers: Kubo, Helia, Boxo, Rainbow, IPFS Desktop, **IPFS Companion**, Someguy, **Service Worker Gateway**, IPFS Check; Shipyard stops operating ipfs.io, dweb.link, delegated-ipfs.dev and the bootstrap nodes. The IPFS blog (2026-08-25) says community resources go to "specs, conformance tests, ... interoperability" instead. The SW Gateway README now names two maintainers acting for the IPFS Foundation; the repo still released v3.5.1 on 2026-10-15. `ipshipyard/drop-in-service-worker` states "This project is no longer maintained."
- Implication: do not take a dependency on DNSLink libraries or Helia packages; keep the ~25-line TXT/DoH normaliser planned in `05`. A `/btih/` namespace has nobody to register with. Revisit only if an IPFS-Foundation-led DNSLink revival appears.

**F9 BitTorrent-side attempts to reuse DNSLink never shipped.** *Confidence: High.* bt-fetch's README TODO lists "Support some sort of DNS based on DNSLink"; btlink's README says its name comes from "the plan to implement something similar to DNSLink" and marks its DNS flows as not implemented. Wave-1 `05` F10 found no BEP/RFC for magnet-in-DNS. [S56][S55] Source dates: bt-fetch README undated (npm release 2023-06-29, **OLD**); btlink README undated (repository head 2026-09-08).

### 2.3 BitTorrent BEPs and WebTorrent

**F10 [DESIGN-CRITICAL] BEP status: the process is dormant and the BEPs magnet-web would lean on are all Drafts.** *Confidence: High* (raw `.rst` headers plus the index page agree). [S20][S21][S22]

| BEP | Title | Status | Created | Relevance to magnet-web | Browser WebTorrent |
|---|---|---|---|---|---|
| 3 | Protocol | Final | 2008 | core | yes |
| 4 | Assigned numbers | Active | 2008 | bit allocations by mail to editor@bittorrent.org; not needed for LTEP names | n/a |
| 9 | Magnet / ut_metadata | Accepted | 2008 | `xt=urn:btih` (40 hex or 32 base32), `xt=urn:btmh:<multihash hex>`, `x.pe`; "Since no URI scheme identifier has been allocated for bittorrent `xs=` is not used for this purpose" | yes |
| 10 | Extension protocol | Accepted | 2008 | `mw_chain` wire extension; naming rule (F13) | yes |
| 19 | Web seeds (GetRight) | Accepted | 2008 | `ws=`; `url-list` outside `info` | yes |
| 44 | Arbitrary data in DHT | Draft | 2014 | pkarr / BEP 46 substrate: ed25519, `v` <= 1000 B, expire ~2 h, re-announce hourly | no |
| 46 | Mutable torrents via DHT | Draft | 2016 | `xs=urn:btpk:<hex>&s=<hex salt>`; value is only `{ih: 20-byte}` | no (webtorrent#886) |
| 47 | Padding files, `attr` | Draft | 2016 | required for hybrid v1+v2 (BEP 52 upgrade path); path `.pad/N` | no |
| 49 | Distributed feeds | Draft | 2016 | feed of torrents; not a site-delivery mechanism | no |
| 52 | Protocol v2 | Draft | 2008 (rev.) | per-file Merkle roots, `urn:btmh`; hybrid upgrade path | no (webtorrent#1117, open since 2017) |
| 53 | Magnet `so=` | Draft | 2017 | select file indices | yes |
| 55 | Holepunch | Accepted | 2018-12-29 | native only | n/a |

- The `bittorrent/bittorrent.org` repository's newest commit on `master` is **2020-05-01** (merge of a BEP 7 PR); the highest BEP number is 55 (created 2018-12-29). Draft status of BEP 52 persists although libtorrent and other clients ship v2. [S20][S22]
- Implication: do not wait for or plan to propose a BEP. Treat BEP 44/46/52/53 as de-facto standards documented in the BEP repo, and publish our own specs (A3).

**F11 What WebTorrent 3.0.21 actually implements, checked in the local source.** *Confidence: High* (upstream `bep_support.md` and the installed code agree). [S23][S24][S26]
- Upstream table: browser column BEP 5 not implemented, 6 yes, 9 yes, 10 yes, 11 not implemented (webtorrent#1191), 19 yes, 27 yes, 48 yes, **53 yes**, **44/46 not implemented** (#886 for 46), **52 not implemented** (#1117).
- Local code, `lib/torrent.js`: `_onListening` calls `_getMetadataFromServer()` when the magnet has `xs`; it accepts only `http://` and `https://` URLs (others: warning "skipping non-http xs param"), GETs with `fetch`, parses, and **drops the response unless `parsedTorrent.infoHash === self.infoHash`**. `so` handling: `if (this.so && !this._startAsDeselected) ... this.files[i].select()` for listed indices, otherwise the whole torrent is selected at low priority. `magnet-uri@7.0.10` parses `xs=urn:btpk:<64 hex>` into `publicKey`, `xt=urn:btmh:1220<64 hex>` into `infoHashV2`, and `so` via `bep53-range`.
- Release state: `webtorrent` 3.0.21 published 2026-07-27 and still `latest`; the newest `master` commits (2026-10-15 and 2026-09-29) are dependency bumps (maintenance mode). `bittorrent-tracker` 11.2.3 (2026-05-25), `create-torrent` 6.1.3 (2026-07-23), `parse-torrent` 11.0.24 and `magnet-uri` 7.0.10 (2026-07-26). [S26][S27]
- Implication: the planned `xs=` cold-start path (DESIGN-REVIEW 13) is supported by shipped code; the `.torrent` must be CORS-readable if it is not same-origin. `so=` is optional because the Service Worker can read files on demand.

**F12 BEP 46 and pkarr use the same BEP 44 slot mechanics differently.** *Confidence: High for the specs.* BEP 44: key `k` is a 32-byte ed25519 public key; signature is over `[4:salt<len>:<salt>]3:seqi<seq>e1:v<len>:<value>`; target is `SHA-1(k || salt)`; stores "MAY reject" `v` above 1000 bytes; items "MAY expire in 2 hours" and "SHOULD be re-announced once an hour". BEP 46 stores `{ih: <20-byte infohash>}` and the magnet is `magnet:?xs=urn:btpk:<hex key>&s=<hex salt>`. pkarr ignores the salt and uses `seq` = a microsecond timestamp. One Ed25519 key can therefore host a BEP 46 item (which must then use a non-empty salt) and a pkarr packet (the unsalted slot). Native client support for BEP 46 is claimed by bt-fetch, btlink and SpawnDev.WebTorrent; libtorrent's published feature list does not mention it (**unverified**). [S21][S57][S55][S56][S25][S62] Source dates: BEP 44 created 2014-12-19 and BEP 46 created 2016-07-24 (both **OLD**, both Draft); pkarr documents read 2026-10-17; libtorrent features page undated.

**F13 BEP 10 naming rule.** *Confidence: High.* "[Extension names] should be prefixed with the two (or one) character code that is used to identify the client that introduced the extension. This applies for both the names of extension messages, and for any additional information put inside the top-level dictionary. All one and two byte identifiers are invalid to use unless defined by this specification." `mw_chain` complies; any extra handshake-level key (for example a protocol version) must be prefixed (`mw_v`). BEP 4 notes that with LTEP "message ID collisions also become impossible because message IDs are allocated on demand at the beginning of the connection" and that name collisions "become possible, but the probability is much less likely", so no registry is involved. [S21] Source date: BEP 10 created 2008 **(OLD)**, status Accepted.

**F14 BEP 19 operational warnings.** *Confidence: High.* BEP 19 (Accepted): `url-list` sits outside `info`, so it does not change the infohash; a trailing `/` means "add the `name` from the torrent"; multi-file torrents use `<root>/<name>/<path>`; HTTP range requests per piece "show in the server's logs" and look like abuse; GetRight made pieces form large gaps to avoid that. PeerTube's v6.3.0 notes say removing WebTorrent from the player ended "a large amount of small HTTP requests" to the origin. With 256 KiB pieces, a large site served from an S3/CDN web seed multiplies small ranged GETs; tune piece length or request coalescing. [S21][S61] Source dates: BEP 19 created 2008-02-21 **(OLD)**; the PeerTube CHANGELOG file does not show release dates.

### 2.4 Browser-platform standards and vendor direction

**F15 [DESIGN-CRITICAL] Web Packaging (Web Bundles, Signed Exchanges) is not a usable foundation.** *Confidence: High* (IETF datatracker API, WICG README, Chrome docs and Google Search Central agree). [S10][S44][S45][S46][S26]
- IETF **WPACK working group: state `concluded`** (datatracker record time 2023-02-02). Its drafts stopped early: `draft-ietf-wpack-bundled-responses` last revision **-01 (2021-12-25)**, expired the next day; `draft-ietf-wpack-use-cases` -00 (2022-04-28). The editors' copy says "Published: 22 September 2021, Expires 26 March 2022".
- WICG/webpackage README: the repository now holds Signed HTTP Exchanges (`draft-yasskin-http-origin-signed-responses`) and tooling; Web Bundles "moved to the wpack-wg/bundled-responses repository". The "Subresource loading with Web Bundles" explainer (`<script type="webbundle">`) says "Last updated: Apr 2022".
- "Bundle preloading" (the proposal behind the name `bundle-preload`) lives in `WICG/resource-bundles`: it proposes preloading many resources from a Web Bundle with per-resource caching; its newest commit is **2023-02-14**, and its README states WICG documents "are not by themselves on a standards track". The subresource-loading explainer records that its earlier `<link rel="webbundle">` API was abandoned for a `<script>`-based one. No browser ships either. [S46][S46b]
- Chrome's Web Bundles page: "**The experimental implementation of navigation to Web Bundles was removed from Chrome in February 2023.**" and the API is "only supported in Chromium-based browsers behind an experimental flag" (page last updated 2019-11-11 **(OLD)**, warning added later).
- Signed Exchanges: `developers.google.com/search/docs/appearance/signed-exchange` now answers **HTTP 301 to `/search/updates#updating-amp-documentation`**, the note dated July 1 (2026) that removed "outdated references to the AMP viewer, AMP Cache, and signed exchange" because Google Search "will now take users directly to the publisher's AMP host pages". [S45]
- Tooling state: `wbn` 0.0.9 (2023-03-23, W3C license); `wbn-sign` 0.3.3 (2026-10-15), the Isolated Web Apps signer; IANA has no `application/webbundle` or `application/signed-exchange` registration. [S26][S16]
- Implication: do not adopt Web Bundles/SXG as a site container or signature format. For a future single-file container, a torrent file plus our own index (as WEB25.cloud's `site.bundle.json.gz` does) is no riskier.

**F16 [DESIGN-CRITICAL] Isolated Web Apps are enterprise-only; their identity model is the useful precedent.** *Confidence: Medium-High* (Chrome docs updated 2026-02-06; sibling `w1-11` records the same). [S43]
- "The initial release of Isolated Web Apps ... will only be available to Chrome Enterprise administered ChromeOS devices and select development partners. We are looking to expand this to additional partners and unmanaged and cross-platform devices in the future."
- An IWA is a **signed web bundle** (`.swbn` = bundle + integrity block); "signing keys are **Ed25519 or ECDSA P-256**"; the app is "identified by the bundle's public key" and runs at `isolated-app://<Web Bundle ID>/` (a base32 string derived from the key); "servers and DNS can no longer be explicitly trusted"; script may come only from the bundle (CSP). Direct Sockets (TCP/UDP) and Controlled Frame are IWA-only APIs.
- Implication: no path to a native-style BitTorrent client (DHT, uTP, TCP) in ordinary browsers. Precedent value: identity derived from a signing key, offline signing key, both P-256 and Ed25519 accepted. Matches magnet-web's "owner key never enters a browser" rule.

**F17 `registerProtocolHandler` and the manifest member, as standards.** *Confidence: High* (HTML Standard text fetched live and MDN compat data of 2026-10-15; `w1-09` adds experiments). [S40][S41][S76]
- HTML Standard: safelisted schemes are `bitcoin ftp ftps geo im irc ircs magnet mailto matrix mms news nntp openpgp4fpr sftp sip sms smsto ssh tel urn webcal wtai xmpp`; any other scheme must be `web+` followed by **"one or more ASCII lower alphas"** (letters only: `web+mw1` is invalid); the handler URL must contain `%s`, be http(s) and same-origin with the caller; `%s` is replaced with the component-percent-encoded URL.
- MDN compat: `registerProtocolHandler` Chrome 13, Edge 79, Firefox 2 (Android 4), Opera 11.6; **not** Safari, iOS Safari, Chrome Android, Samsung Internet, WebView. `magnet` scheme: Chrome 30, Edge 79, Firefox 2. Chromium 86+ additionally records experimental, non-standard support for `cabal dat did dweb ethereum hyper ipfs ipns ssb` (not Firefox, not Safari). Manifest `protocol_handlers`: Chrome/Edge 96, Opera 82 only, flagged experimental.
- Implication: consistent with DESIGN-REVIEW LATER ("not advertised in v1") and with `w1-09`'s top actions. Never register a custom scheme with digits; do not rely on any handler for mobile.

**F18 Vendor direction: browsers are retreating from native decentralised-web handlers toward gateway or Service Worker approaches.** *Confidence: High for the facts, Medium for the trend statement (my inference).* [S47][S75][S76]
- Brave: issue `brave/brave-browser#37735` opened 2024-04-19 by a Brave maintainer, retitled 2024-04-26 to "Deprecate local node support and ipfs:// scheme", closed, milestone 1.69.x; it states the plan to keep "decentralized DNS handling" via an interstitial that redirects to an https gateway. The Brave wiki: "As the IPFS support has been deprecated ...". `w1-07` records the removal on 2024-08-22 with Brave's reason (below 0.1% usage).
- Brave WebTorrent: per `w1-09` (primary reading there), default-off in 1.78.94 (2025-05-01), disabled for all users in 1.81.131 (2025-08-06), code removed in 1.82.161 (2025-09-04). My own observation is consistent: `brave-core/components/brave_webtorrent` now contains only a `browser` subfolder (WebFetch summary). I did not re-derive the version numbers.
- IPFS: `ipfs.io` and `dweb.link` redirect browsers to the Service Worker gateway (F30).
- Implication: magnet-web should not expect any browser to add native `magnet:`-site handling; the loader page is the product.

**F19 [DESIGN-CRITICAL] Ed25519 is universal in WebCrypto now; the v0.1 premise is outdated.** *Confidence: High* (MDN compat data 8.1.6 timestamp 2026-10-15; WICG issue #20 thread; sibling `06` summary item 5). [S41][S42][S74]
- `SubtleCrypto.generateKey/sign/verify/importKey/exportKey` with `Ed25519`: Chrome 137, Chrome Android 137, Edge 137, **Firefox 129**, **Safari 17** (macOS and iOS), Samsung Internet 30, WebView 137, Opera 121. The issue thread: Safari 17.0 shipped without flags (Oct 2023); Firefox 129 expected from Nightly (Jul 2024); Chrome "enabled by default as of version 137" (Jun 2025, a contributor's statement). The secure-curves proposal is now developed in `w3c/webcrypto`.
- Caveats from `06`: Safari's Ed25519 signatures are randomised (never derive ids from signature bytes; v0.2 derives `h` from the entry, which is correct); `@noble/ed25519` 3.2.0 (2026-08-27) is the fallback for older engines.
- Implication: algorithm choice for the *owner* key can follow the ecosystem (BEP 44/46, pkarr, IWA, DID) at no persistence risk because the owner key lives in Node (v0.2 s6.2). Author keys stay browser-held and may stay P-256.

**F20 Integrity features that also point at Ed25519 (cross-reference only).** *Confidence: Medium* (secondary, from sibling docs; not re-verified). `integrity="ed25519-<key>"` signature-based SRI is Chrome 141 experimental and needs response headers that S3/GitHub Pages cannot emit; WAICT is a prototype behind a Firefox Nightly pref (`w1-10` F30, `w1-11` summary 9). If publisher-key pinning ever becomes a platform feature, it will use Ed25519. [S77][S78]

### 2.5 Key, signature and identifier standards

**F21 W3C Multikey and DID Core give the standard textual form for public keys.** *Confidence: High* (spec text fetched 2026-10-17). [S48]
- **Controlled Identifiers v1.0 (W3C Recommendation, 15 May 2025)** defines `Multikey` with `publicKeyMultibase`: **P-256 = varint 0x8024 (the varint of multicodec 0x1200) + 33-byte compressed point; P-384 = 0x8124 + 49 bytes; Ed25519 = 0xed01 + 32 bytes**, base58btc multibase prefix `z` (`z6Mk...` for Ed25519). DID Core is a Recommendation of 19 July 2022 **(OLD)**.
- Caveat: Multikey P-256 needs the **compressed** point; WebCrypto exports the 65-byte uncompressed point, so compression and decompression are hand-written (a few lines of BigInt arithmetic; I did not verify whether any engine accepts compressed `raw` import). The cheaper alternative is an explicit prefix (`p256:`, `ed25519:`) on the existing base64url strings.

**F22 JCS and the W3C Data Integrity suites.** *Confidence: High for status; Medium for the claim that our scheme is "inspired by" rather than "conformant to" them.* RFC 8785 JCS is Informational (June 2020 **(OLD)**) and is what v0.2 s6.1 uses. W3C **Data Integrity ECDSA Cryptosuites v1.0** (`ecdsa-jcs-2019`, P-256/P-384) and **EdDSA Cryptosuites v1.0** (`eddsa-jcs-2022`) are Recommendations of 15 May 2025 and use JCS, but they hash and sign canonicalised proof options together with the document; signing `"mw-block-v1\n" + h` is a simpler scheme and must not be advertised as Data Integrity conformant. [S11][S48]

**F23 Transparency-log standards exist but do not fit a DAG.** *Confidence: Medium.* RFC 9943 (SCITT architecture, June 2026), RFC 9942 (COSE Receipts, June 2026) and RFC 9162 (Certificate Transparency 2.0, Experimental, 2021) standardise signed statements plus Merkle receipts for *linear* logs with a single tree head. magnet-web's ledger is a causal DAG with no single head. Possible later use: owner-signed checkpoints (DESIGN-REVIEW LATER) as COSE_Sign1 statements. Not adopted now. [S11]

**F24 RFC 6920 `ni:` URIs and `/.well-known/ni/` exist for naming content by hash** (Proposed Standard, April 2013 **(OLD)**): `ni:///sha-256;<base64url>` plus an HTTP form on any static host. No evidence of ecosystem use for torrents; mentioned only because it is the standards-track way to name a SHA-256 digest. [S15]

### 2.6 Key-addressed mutable names without DNS

**F25 [DESIGN-CRITICAL for the new pointer channel] pkarr: Ed25519 key as a DNS-like name over the Mainline DHT, with browser-reachable HTTP relays.** *Confidence: High for the specification and repository state; Medium for relay availability (one public operator observed).* [S57][S26]
- Spec (`design/base.md`): `SignedPacket = public-key(32) signature(64) timestamp(8, microseconds, big-endian) dns-packet(<1000 bytes, compressed)`; signing follows BEP 44 with `seq` = timestamp and the salt ignored; the 32-byte key is **z-base32** encoded to a 52-character "TLD" (optional `pk:` prefix); records inside are ordinary DNS RRs (A, AAAA, TXT, CNAME), names relative to the key.
- Relays (`design/relays.md`): `GET /:z-base32-key` and `PUT /:z-base32-key`, public relays "need to setup cors headers"; GET returns `Cache-Control: public, max-age=300`, `Last-Modified`, `Memento-Datetime`, body `signature timestamp dns-packet`; 404 when absent; PUT limit 1072 bytes. Docs: "Browsers cannot open UDP sockets. Only HTTP relays work."
- Live probe 2026-10-17: `https://pkarr.pubky.app/<key>` returned HTTP 404 for a sample key but with `access-control-allow-origin` reflecting the request Origin and `x-ratelimit-limit: 1000`. The relay binary `pkarr-relay` can be self-hosted.
- Repository activity: commits on 2026-10-16; npm `@synonymdev/pkarr` 8.1.0 (2026-10-02, **1.7 MB unpacked**, WASM). Old `pkarr` on npm: 1.4.1 (2024-03-13).
- Implication: a loader-side client is small (fetch, split 64/8/rest, verify Ed25519 with WebCrypto, parse one DNS packet); do not ship the WASM package. Requires an Ed25519 key, so a pkarr source is blocked on A2.

**F26 btlink, bt-fetch and Agregore: the BitTorrent community's own addressing conventions.** *Confidence: High for README content; Medium for adoption.* [S55][S56]
- btlink (Go proxy/gateway, last commit 2026-09-08): hostnames `{infohash}-ih.{tld}` and `({salt}[.-])?{base36(public key)}-pk.{tld}` (BEP 46) and `{target}-44.{tld}`; separate hostnames "to provide origin isolation"; the working TLD `.bt` was reconsidered because of Bhutan's ccTLD; a domain can alias into the scheme with a `_btlink` DNS record (README: "Domains may link/alias into the `.{tld}` address scheme by use of a `_btlink` DNS record"), but the architecture diagram marks parts of that flow as "flows that aren't implemented yet".
- bt-fetch (npm 3.3.3, 2023-06-29, AGPL-3.0-or-later): `bittorrent://<infohash>/path`, `bt://`, and "now also supports public keys `bittorrent://64CharacterPublicKeyHere`". Agregore (same author) 2.24.0 on 2026-04-24, commits to 2026-07-13, offers a "Set as Default Torrent" menu action.
- Implication: if magnet-web ever exposes infohash or key in a hostname, `-ih`/`-pk` suffixes and base36 keys are the existing convention (optional interop, P3).

**F27 NIP-5A (nsites): a signed site manifest addressed by public key.** *Confidence: High for the text (`draft optional` in the NIPs repo master); Medium for adoption (npm `nsite-gateway` 1.4.1, 2026-01-02).* [S58]
- Manifest events (kinds 15128 root, 35128 named, 5128 snapshot) map absolute paths to SHA-256 hashes; blobs live on Blossom servers addressed by SHA-256; the **aggregate hash** is `sha256` of the sorted lines `"<sha256> <path>\n"` and identifies a site version independent of publisher; origin labels are single DNS labels: base36 pubkey (50 characters) or `<pubkeyB36><dTag 1-13 chars>` ("avoids wildcard certificate limitations with multi-level subdomains"), snapshots `v<50-char id>`.
- Relevance: same shape as pointer + manifest + per-key origin. It runs on Nostr relays (secp256k1/BIP-340 signatures, not available in WebCrypto) so it is a convention to learn from, not a channel to add.
- Source date: NIP-5A text as of `master` on 2026-10-17 (the file carries no date).

**F28 Hostname and label conventions agree across ecosystems.** *Confidence: High.* [S36][S58][S55][S43]
- DNS labels are at most 63 octets, case-insensitive (RFC 2181 s11, quoted by the IPFS Subdomain Gateway spec). IPFS: CIDs in base32; ED25519 libp2p keys in base36 "to safely fit"; DNSLink names inlined into one label (`.` becomes `-`, `-` becomes `--`); wildcard TLS; the spec says representing hashes longer than 63 characters (for example sha2-512) "remains an open question".
- A SHA-256 infohash in hex is 64 characters (too long); base32 is 52. v0.2's hub label `base32(sha256(ledgerId))[0:32]` and `base32(btih)` are compatible. IWA ids are base32 strings derived from the signing key (the Chrome docs' example id is 56 characters, which is consistent with a 32-byte key plus a 3-byte suffix; that decomposition is my inference).
- Public Suffix List: the IPFS spec says operators "SHOULD register a wildcard entry"; `*.dweb.link` and `*.inbrowser.link` are listed. PSL private-section requirements: registration with **more than 2 years** remaining at PR time, a `_psl` TXT record pointing at the PR (kept in place), no SLA on review time. [S37] (`w1-10` F25 and `w1-11` F3 cover this in depth.)
- Source dates: the IPFS Subdomain Gateway spec page is undated (a sibling document records 3 April 2025); PSL guidelines read 2026-10-17; NIP-5A and btlink README as above.

### 2.7 Ecosystem projects, 2016-2026

**F29 Status table (all as of 2026-10-17).** *Confidence: High for dates (npm registry, Atom feeds, raw READMEs); Medium where marked "(WebFetch summary)".* [S26][S50]-[S63]

| Project | What it does | Latest activity | Status | Lesson for magnet-web |
|---|---|---|---|---|
| Planktos (`xuset/planktos`) | Service Worker + CLI that bundles a site into a torrent; web seed required; the SW cannot use WebRTC, so a controlled page is injected to download | npm 0.3.1 (2017-03-04); last commit 2018-09-18 | dormant; README: "not recommended for production use yet" | Same architecture a decade ago. Its blockers (no streaming, no sharding, re-run CLI per change) are the problems v0.2 addresses; "drop-in" (include `install.js`) is the same migration promise |
| Bugout (`chr15m/bugout`) | Browser-to-browser networking over WebTorrent trackers; a "server" in a browser tab | npm 0.0.13 (2022-06-21); last commit 2024-05-08 | dormant, "pre-alpha" | Wire-extension gossip precedent |
| KayleePop/magnet-web | Service Worker + iframe + WebTorrent ("View webtorrents like they're an http server using a service worker"); URL scheme `/{infoHash}/path` | last commit 2022-12-14 (per `04` F3, not re-read) | dormant | Same idea **and same name** as this repository; `04` R10 already recommends a rename or namespacing |
| PeerWeb (`Omodaka9375/peerweb`, peerweb.lol) | Drag a folder, get a hash, open `?orc=<hash>`; SW + IndexedDB cache (7-day expiry) | last commit 2025-10-07; about 100 stars (WebFetch summary) | stale; HN thread (item 46829582, early 2026, 377 points, 124 comments; exact date not captured) | Criticised (HN thread, WebFetch summary) for unsigned plain magnet links with no publisher key, no update story, missing peers (users stuck on a connecting screen), a weak sandbox (its raw README shows `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"`) and a single-point-of-failure host. Validates magnet-web's signed pointer, web seed and origin-per-site choices |
| WEB25.cloud (`adigeo08/web25.cloud`) | PeerWeb fork: signed `.torrentchain` root file verified before render, EVM (secp256k1) wallet in a WebAuthn-PRF passkey vault, Nostr NIP-59 messaging, ephemeral GoFile HTTP mirror after an 8 s P2P deadline, default single-file `site.bundle.json.gz` | commits through 2026-10-14 | active (README self-description; not tested by me) | Independent convergence on signed provenance, opaque-origin iframe with a MessagePort allowlist, and "P2P first, mirror after a short deadline". A signature file inside the torrent cannot name the torrent's own final infohash (inference), one more reason that signing the pointer outside the torrent, as magnet-web does, is the sounder design |
| PeerWebSite (`Weedshaker`), peerweb.js (`retrohacker`) | Browser site hosts using WebTorrent/IPFS links | last commits 2024-11-02 and 2016-02-15 | low activity / dead | none |
| btlink (`anacrolix/btlink`) | HTTPS addressing for BitTorrent: `-ih`, `-pk`, `-44` hostnames, gateway/proxy | last commit 2026-09-08 | alive, partly unimplemented | Naming conventions (F26) |
| bt-fetch / Agregore | `bittorrent://` fetch; browser with torrent handler | bt-fetch 2023-06-29; Agregore 2.24.0 (2026-04-24) | bt-fetch dormant, AGPL; Agregore maintained | URL scheme precedent; do not depend on AGPL code |
| IPFS Service Worker Gateway | Helia + `verified-fetch` in a Service Worker, subdomain per content root, DNSLink via DoH | v3.5.1 2026-10-15 | active under community maintainers after Shipyard (F8) | The production precedent (F30) |
| nsite / NIP-5A | Signed manifest events + Blossom blobs | NIP `draft optional`; `nsite-gateway` 1.4.1 (2026-01-02) | niche | Aggregate-hash and label conventions (F27) |
| pkarr / Pubky | Key-addressed DNS packets over the Mainline DHT | commits 2026-10-16 | active | Key-addressed pointer channel (F25) |
| Trystero | Serverless WebRTC rooms; signalling via BitTorrent trackers, Nostr (default), MQTT, IPFS, Supabase, Firebase, self-hosted relay | 0.26.0 (2026-10-04) | active | Its README ranks signalling robustness MQTT > BitTorrent > IPFS and defaults to Nostr ("hundreds of active relays"); relevant to the "second discovery plane" LATER item, not to the wire-extension design |
| P2P Media Loader (Novage) | Hybrid CDN + WebRTC P2P for HLS/DASH | commits 2026-09-10 | active | "For smaller setups (1,000-2,000 simultaneous viewers), public trackers alone can handle peer connections"; P2P as an offload, origin always present |
| SpawnDev.WebTorrent (`LostBeard`) | C# WebTorrent-compatible client/server (browser Blazor + desktop), BEP 52 hybrid output, BEP 44/46 Ed25519, BEP 10 extension API, WebRTC peers interoperable with the same tracker, TCP listener for mainline clients | v4.2.8 (2026-09-16) | active, **one independent maintainer**, claims are the README's | Candidate always-on seeder that speaks v2/hybrid and BEP 10 (to evaluate, not depend on) |
| Iroh (n0) in browsers | QUIC-based P2P compiled to WASM | docs | browser traffic is **always relayed** ("they don't support sending UDP packets ... from inside the browser sandbox"); may later use WebTransport or WebRTC | Not a browser-to-browser content layer today |
| WebTorrent | the substrate | 3.0.21 (2026-07-27); dependency-only commits since | maintenance mode | BEP 52/46/44 gaps are unlikely to close upstream soon (my inference: issues open since 2017 or earlier, releases in maintenance mode) |

**F30 The IPFS Service Worker Gateway is the production precedent, and these parts transfer.** *Confidence: High* (README, two IPFS posts, subdomain spec). [S32][S33][S34][S36]
- Design: a Service Worker registered on first load intercepts `/ipfs/*` and `/ipns/*`, retrieves blocks over HTTPS/WSS from providers, verifies hashes in the browser; **runs exclusively in subdomain mode** ("Origin isolation"); DNSLink resolved via DoH; a gateway operator "could potentially run a simple HTTP server on a Raspberry Pi, serving only small static HTML+JS files (<10MiB)". Public good instances: `inbrowser.link` (production), `inbrowser.dev` (staging).
- Scale and timing: `ipfs.io` and `dweb.link` redirect browsers to it (phased from 2026-05-11, announced complete 2026-08-25); IPFS handles "roughly 250 million requests per day" (all access paths, not only the Service Worker gateway).
- Transferable specifics: (a) visitor-side escape hatch `?ipfs-sw-unregister=true` (the SW unregisters itself and reloads controlled clients); (b) subdomain label and PSL rules (F28); (c) compliance with the gateway specifications is tested with the shared `gateway-conformance` suite (also used by Kubo and Rainbow); the IPFS post's own conclusion is that "the scarce thing now is interoperability ... clear specs, real conformance tests"; (d) a recent fix, "share the installer HTML cache entry across subdomains" (commit 2026-10-15), shows the per-origin first-visit cost that a subdomain-per-site hub also pays.

**F31 PeerTube's retreat from WebTorrent is the strongest warning about the content layer.** *Confidence: High* (CHANGELOG and issue agree). [S61][S60]
- PeerTube 6.0.0 notes (raw CHANGELOG): "Remove WebTorrent support in player: 'WebTorrent videos' are renamed to 'Web Video' ... we just stop to use P2P for these videos ... We still use P2P with the HLS player." Issue #5465 (opened 2022-12-15, closed 2023-07-10; quotes below are from a WebFetch summary of the issue): WebTorrent had "many limitations", "a bigger bundle size for a bad user experience", "slow start time, hacky resolution change", and P2P was "not really used since most of new and popular videos are using HLS now". They moved P2P to segment-level HLS (P2P Media Loader).
- Implication: it is evidence about video, not about static sites, but the failure modes (bundle size, start-up latency, little real P2P) are exactly the ones a website loader has. Keep `ws=`/`xs=` mandatory, race the web seed against peers from t=0 (as `w1-07` recommends), and record how much of each page load actually came from peers.

**F32 What nobody else has: a signed, expiring, rollback-protected pointer in DNS plus an owner-moderated replicated log, rendered by a Service Worker at the site's own origin.** *Confidence: Medium (comparison of READMEs and specs; not an exhaustive survey).* Planktos/PeerWeb/WEB25 have no DNS pointer and no mutable name (PeerWeb: "the problem is always updating regularly"); DNSLink/IPFS have mutable names but no replicated database; nsite has signed manifests but needs relays and a host server; btlink/pkarr give key-addressed names but no in-browser renderer. The combination is the differentiator; each part has a precedent worth aligning with.

---

## 3. Concrete recommendations for magnet-web (alignments to adopt)

Priority: **P0** = settle before the v1 freeze or first public record; **P1** = should do for v1; **P2** = valuable, can follow; **P3** = optional or watch. Effort: **S** < 1 day, **M** 1-3 days, **L** > 3 days. "Status" compares with ARCHITECTURE v0.2 and `docs/review/DESIGN-REVIEW.md` (DR).

| # | Alignment | Pri | Eff | Status vs v0.2 / DR |
|---|---|---|---|---|
| A1 | State the pointer grammar as a conformant profile of the RFC 6376 tag-list; `v=mw1` first; string joining; size budget | P0 | S | partly in DR 11; v-first, joining rule and budget are new |
| A2 | Algorithm-tag every public-key string now (`p256:` / `ed25519:`; Multikey mapping documented) | P1 | S (tag) + M (Ed25519 verify) | conflicts with DR LATER ("only if P-256 persistence fails"): pull the *tag* forward, keep Ed25519 itself later |
| A3 | Publish `MW-PTR/1` and `MW-LOG/1` as stable, versioned specs with test vectors | P1 | M | new |
| A4 | Request IANA `TXT _magnet` once A3 is stable | P2 | S | DR LATER; route and precedents now known |
| A5 | `xs`/`ws` stay mandatory at publish; spec the `xs` contract; surface WebTorrent's `warning` events | P1 | S | DR 13 planned; two additions |
| A6 | BEP 10 hygiene: prefixed `mw_v` in the extended handshake; no BEP attempt | P2 | S | new |
| A7 | Hostname grammar rules written down; relax the 32-character label regex for v2 ids; reuse `-ih`/`-pk` only if direct id hostnames appear | P2 | S | mostly compatible |
| A8 | Key-addressed pointer channel: pkarr relay GET (+ BEP 46 magnet export), after A2 | P2 | M-L | new |
| A9 | `<link rel="describedby" type="application/x-bittorrent">` hint for drop-in sites (RFC 6249 form) | P3 | S | new, optional |
| A10 | Decision record: no `_dnslink` / `_btlink` dual-publish in v1 | P2 | S | new (documentation) |
| A11 | `conformance/` vectors usable from other languages | P2 | S | overlaps DR tests |
| A12 | Visitor-side `?mw-sw-unregister=1` next to the deployer kill switch | P2 | S | complements DR 20 |
| A13 | Protocol handlers: no new scheme; `web+` letters only if ever; follow `w1-09` | P3 | S | consistent with DR LATER |
| A14 | JCS vectors from RFC 8785; do not claim W3C Data Integrity conformance | P3 | S | wording only |
| A15 | Dependency policy page: what we will not import and why | P3 | S | new |
| A16 | One-day spike: SpawnDev.WebTorrent as an always-on seeder (hybrid v1+v2, BEP 46, `UseExtension`) | P3 | M | new, optional |
| A17 | Reserve `btmh=` now; do not emit v2/hybrid torrents yet | P2 | S | DR LATER lists v2 |
| A18 | Fix stale statements (`05` F9 `_dmarc`; any "Ed25519 not universal") | P2 | S | documentation |
| A19 | RFC 8484 wire-format DoH as a second resolver family, sharing a DNS-packet codec with A8 | P2 | M | new; builds on `05` F1 |
| A20 | Cross-origin `/.well-known/magnet-web` as a DoH-free route for hub `#host:` resolution; provisional well-known registration | P3 | S-M | new; `05` rec. 5 proposed a same-origin variant |

**A1 [P0, S] Pointer grammar as a conformant tag-list profile.** *Why:* F4: the written standards disagree and v0.2 deviates from RFC 6376 in two ways; nothing is published yet, so this is free. *What:* in ARCH s4 and the spec: (1) normative ABNF = RFC 6376 s3.2 `tag-list` with tag names `ALPHA *(ALPHA / DIGIT / "_")` and values `%x21-3A / %x3C-7E` (so no `;`, no whitespace, percent-encode); (2) list the three deliberate deviations: names are case-folded before use, `tr`/`ws`/`xs` may repeat, unknown tags are ignored for meaning but included in the signed bytes; (3) `v=mw1` MUST be the first tag, otherwise the record is not a pointer (same discriminator rule as SPF/DKIM/DMARC and the DNSOP draft's "token first"); (4) character-strings are joined by concatenation without spaces (RFC 7208 s3.3); (5) size: SHOULD be at most 450 bytes for DNS, MUST be at most 900 bytes so the same record fits a pkarr packet (F5); `publish.mjs` prints the size and warns above 450. *Acceptance:* unit vectors for mixed-case keys, `v` not first, duplicate `v`, 255-byte string boundaries with and without a space, and a 901-byte record rejected by `publish.mjs`. *Amend:* ARCH s4, INTERFACES `pointer.js`, `tools/publish.mjs`.

**A2 [P1, S + M] Algorithm-tagged key strings before the freeze.** *Why:* F19, F21, F25: Ed25519 is in every current WebCrypto engine; the owner key never enters a browser (v0.2 s6.2), so the iOS CryptoKey-persistence issue that motivated deferring Ed25519 does not apply to it; BEP 44/46, pkarr, IWA and DID all use Ed25519 keys. Key strings appear inside hashed block bodies (`author`), in pointers (`owner`) and in the signed rotation payload (`rot`): changing their encoding after any block or record exists forces a new pointer version and a ledger fork. *What:* one textual form everywhere, `<alg>:<b64url>` with `p256` (65-byte uncompressed point, today's value) and `ed25519` (32 bytes); unknown `alg` is "unsupported key type", never a silent accept; document the one-to-one mapping to W3C Multikey (`ed25519` to `z6Mk...`, `p256` to `zDn...`, which needs point compression). Keep P-256 as the only generated type until the Ed25519 verify path (WebCrypto, `@noble/ed25519` 3.2.0 fallback for engines before Chrome 137 / Firefox 129 / Safari 17 / Samsung 30) ships; then allow Ed25519 for **owner** keys first. *Acceptance:* vectors with both algorithms; a P-256 record from before the change either does not exist or is rejected with a clear message. *Amend:* ARCH s4, s6.1, s6.2; INTERFACES `crypto.js`, `pointer.js`, `block.js`; DR LATER entry.

**A3 [P1, M] Two stable specs with test vectors.** *Why:* F1 (the IANA Reference must resolve stably), F10 (no BEP venue), F30 (the IPFS post's own conclusion: specs plus conformance tests). *What:* extract `MW-PTR/1` and `MW-LOG/1` from ARCH s4 and s6 into standalone documents (skeletons in section 4), RFC 2119/8174 keywords, public-domain licence, a versioned permanent URL (a tagged release or a domain the project controls, not a mutable `main` README), a change-log policy, and the vectors the unit tests already contain.

**A4 [P2, S] Ask IANA for `TXT _magnet`.** *Why:* RFC 8552 s2 MUST for public specifications; recent entries show URL and draft references are accepted (F2); the cost is one form. *What:* after A3, submit the "General Protocol Registration Request Form" with the s3 template (`TXT | _magnet | <spec URL>`); no deployment depends on the answer. If longevity matters, an Informational Internet-Draft is the heavier route (RFC 10023 shows it works for a single-purpose TXT convention). Re-check the registry for `_magnet` immediately before submitting.

**A5 [P1, S] `xs`/`ws` contract.** DR 13 already makes them mandatory. Add to the spec: `xs` MUST be https; WebTorrent ignores non-http(s) `xs` and drops a `.torrent` whose infohash differs, emitting a `warning` event (F11), so the loader should surface that event as "the torrent file at xs does not match this pointer", and `publish.mjs --verify-ws` should fetch `xs` and compare. `so=` is optional: the Service Worker reads files on demand.

**A6 [P2, S] BEP 10 hygiene.** Keep the extension name `mw_chain`; advertise the ledger protocol version as a prefixed top-level key in the extended handshake (`mw_v`, BEP 10 requires the prefix for additional keys) so incompatible peers detach before any frame is parsed; document frames in `MW-LOG/1`. Do not pursue a BEP (F10).

**A7 [P2, S] Hostname grammar.** Write the rules into ARCH s3.2: one label, lowercase, at most 63 octets, RFC 4648 base32 without padding for hashes (IPFS spec, NIP-5A and btlink all converge). The loader regex `^[a-z2-7]{32}\.` hard-codes 32 characters; a SHA-256 `btmh` needs 52. Make the length a parameter or tag the id kind. If direct infohash or key hostnames are ever offered, reuse btlink's `-ih` and `-pk` suffixes and base36 for raw 32-byte keys instead of inventing new ones. Add a test that every supported id type yields a label of at most 63 characters.

**A8 [P2, M-L] Key-addressed pointer channel (pkarr, with a BEP 46 export).** *Why:* F25-F28: domain-free, updatable, self-certifying addresses are the capability gap against btlink, bt-fetch/Agregore, nsite and IWA. *What* (requires A2 and an Ed25519 owner key): (1) `publish.mjs --pkarr` builds a pkarr SignedPacket whose TXT at `_magnet` carries the same signed pointer (the whole DNS packet must stay under 1000 bytes, so the pointer text under about 900); (2) the loader accepts `#pk:<52-char z-base32>` and `<meta name="mw-pkarr">`, fetches `GET <relay>/<key>` from a configurable relay list (default `https://pkarr.pubky.app`; operators may self-host `pkarr-relay`), splits `signature(64) timestamp(8) dns-packet`, verifies with Ed25519, requires a newer timestamp than the cache, then still verifies the inner pointer's own `sig`, `seq` and `exp` and applies TOFU; (3) `tools/pin.mjs` republishes every hour (BEP 44 items "MAY expire in 2 hours"); (4) optionally print a BEP 46 magnet (`xs=urn:btpk:<hex>&s=<salt hex>`) for desktop clients. *Risks:* only one public relay observed; hourly republish is an operational duty; do not ship the 1.7 MB WASM package (write the ~100-line client). Shares the DNS-packet codec with A19.

**A9 [P3, S] Metalink-style hint.** For drop-in sites add `<link rel="describedby" type="application/x-bittorrent" href="/_mw/t/<btih>.torrent">` (the RFC 6249 form). Treated like a bare magnet: never overrides a signed pointer. Many static hosts cannot emit arbitrary response headers (`w1-10` F30 makes the same point for S3 and GitHub Pages), so the HTML form is the portable one.

**A10 [P2, S] Decision record: no DNSLink or btlink dual-publish.** One paragraph in DEPLOY/FAQ citing F7-F9: `dnslink=/btih/...` is grammatical but unconsumed and DNSLink has no steward; `_btlink` is a single-maintainer convention whose DNS flows are partly unimplemented. Revisit if an IPFS-Foundation-led DNSLink revival defines namespaces.

**A11 [P2, S] `conformance/` directory.** JSON vectors for pointer parse, sign and verify (including malformed and boundary cases), block hash and signature, DAG order, TXT joining, DoH normalisation, plus a runner that does not depend on Node-only APIs so another implementation can use them (precedent: `gateway-conformance`).

**A12 [P2, S] Visitor-side Service Worker escape hatch.** `?mw-sw-unregister=1` on any controlled page unregisters the worker, clears caches and reloads controlled clients (precedent: the SW gateway's `?ipfs-sw-unregister=true`). It must not touch identity or ledger storage. Trade-off: anyone can link to it and force a re-registration; acceptable because only caches are cleared.

**A13 [P3, S] Protocol handlers.** No new scheme and no `bittorrent:`/`bt:` registration (the browsers reject unknown names; provisional IANA registration is first-come-first-served but achieves nothing without browser support). If a handler is ever added: `web+` plus letters only (`web+magnetsite`), desktop only, from an explicit click, never auto-load (`w1-09`).

**A14 [P3, S] Canonicalisation wording.** Keep JCS (RFC 8785) and include its published test vectors; describe the block signature as "inspired by" W3C `ecdsa-jcs-2019`/`eddsa-jcs-2022`, not conformant (F22).

**A15 [P3, S] Dependency policy.** A short page recording: not importing `dnslink`/`@dnslink/js`, `dohjs`, `dns-query`, Helia packages, `wbn`, `bt-fetch` (AGPL), pkarr WASM; `@multiformats/dns` 1.0.15 is a reference implementation only; `@noble/ed25519` only after A2 ships.

**A16 [P3, M] Seeder spike.** One day to try SpawnDev.WebTorrent (C#, hybrid v1+v2, BEP 44/46, BEP 10 `UseExtension`, TCP listener for mainline clients) against `pin.mjs` and `node-datachannel`; success = a headless always-on seeder that carries `mw_chain`. Single maintainer and self-reported claims: evaluate, do not depend.

**A17 [P2, S] Reserve `btmh=`; do not emit v2 or hybrid torrents yet.** WebTorrent has no BEP 52 (F11) and BEP 47 padding files would show up as ordinary `.pad/N` files. Since unknown tags are kept and signed, reserving the tag name now means adding it later is not a version bump. BEP 52's own upgrade path is a hybrid torrent with BEP 47 padding.

**A18 [P2, S] Fix stale statements.** `05-doh-dns-txt.md` F9 lists `_dmarc` as unregistered (it is registered, F3); any remaining "Ed25519 is not yet universal" text (v0.1 s6.1 is archived at `docs/review/ARCHITECTURE-v0.1.md`; v0.2 does not repeat it).

**A19 [P2, M] RFC 8484 wire format as a second resolver family.** `application/dns-message` (RFC 8484) is the only standardised DoH; the JSON dialect is vendor-defined and RFC 8427's JSON is a different schema (`05` F2). `05` F1 measured that Control D and DNS4EU are usable from page JS in wire format only, and Cloudflare, Google and dns.sb accept wire GET. The DNS-packet encoder/decoder needed (about 100 lines) is also what pkarr (A8) requires.

**A20 [P3, S-M] `/.well-known/magnet-web` for hub `#host:` resolution.** In shell mode the same-origin `<meta>` pointer already works without DoH, so a same-origin well-known file adds little. In hub mode `#host:example.com` has no same-origin page and today depends on DoH, which enterprise networks block (`05` F15). A CORS-enabled `https://example.com/.well-known/magnet-web` (the same signed string as plain text) can be fetched in parallel with DoH, using atproto's resolution rule (`05` F10): accept the first valid record, reject the pair if two valid records disagree, prefer DNS on conflict. Registration route: provisional suffix, Specification Required (RFC 8615 s3.1), precedents `nostr.json`, `did.json`, `tor-relay` (F6). Do it only when DoH blocking is observed in practice.

### 3.1 Reuse, avoid, considered and not adopted

| Item | Decision | Reason (finding) |
|---|---|---|
| RFC 6376 ABNF, RFC 7208 joining, RFC 8785 JCS, RFC 8552 registry | **Reuse** | mature, small, precise (F1, F4, F22) |
| W3C Multikey encoding | **Reuse the format as a documented mapping** | Recommendation 2025-05-15; needs P-256 compression (F21) |
| BEP 9 / 19 / 53, WebTorrent `xs=` | **Reuse** | implemented and verified in 3.0.21 (F11) |
| BEP 10 name rule | **Follow** | `mw_chain`, `mw_v` (F13) |
| IPFS subdomain-gateway label rules + PSL | **Reuse** | convergent across ecosystems (F28, F30) |
| IPFS SW gateway `?ipfs-sw-unregister` idea, conformance-suite practice | **Reuse the idea** | F30 |
| pkarr relay protocol (client side only) | **Reuse later** | F25 (needs Ed25519) |
| btlink `-ih` / `-pk` naming, base36 keys | **Reuse only if direct-id hostnames appear** | F26, F28 |
| DNSLink (`_dnslink`, `/btih/`) | **Do not adopt** | no steward, no registry, no consumer (F7-F9) |
| Helia / `@helia/dnslink` / `dnslink` npm / `dohjs` / `dns-query` | **Do not import** | maintenance in flux or stale (F8; `05` F8) |
| Web Bundles, Signed Exchanges, `wbn` | **Do not adopt** | concluded WG, removed from Chrome, retired by Google Search (F15) |
| Isolated Web Apps, Direct Sockets | **Do not plan on** | enterprise ChromeOS only (F16) |
| BEP 46 / BEP 44 in the browser | **Not available**; reach them through pkarr relays | F11, F12, F25 |
| BEP 49 feeds, BEP 17, BEP 34 | **Ignore** | wrong problem (F10) |
| SCITT / COSE receipts / CT 2.0 | **Not now** | linear logs, ledger is a DAG (F23) |
| RFC 6920 `ni:` | **Ignore** | no ecosystem use (F24) |
| NIP-5A / Nostr relays as a pointer channel | **Learn from, do not add** | secp256k1 not in WebCrypto (F27) |
| Iroh WASM | **Do not use as content layer** | browser traffic always relayed (F29) |
| Planktos, PeerWeb, WEB25 code | **Do not reuse** | dormant (Planktos), unsigned with a weak sandbox (PeerWeb), or a fast-moving single-author fork (WEB25); read for ideas only (F29) |

---

## 4. Spec skeletons to propose

### 4.1 `MW-PTR/1` - magnet-web pointer record

1. **Scope and conformance** (RFC 2119 / 8174 keywords; producers, resolvers, verifiers).
2. **Transport bindings** (all carry the *same* signed string; one verification path):
   a. DNS TXT at `_magnet.<fqdn>` (RR type TXT; IANA registration request A4).
   b. `<meta name="mw-pointer" content="...">` in the loader or stamped page.
   c. URL fragment `#<pointer>` / `?mw=` (hub modes).
   d. Optional: `/.well-known/magnet-web` (Specification Required, provisional status acceptable, RFC 8615 s3.1).
   e. Optional: pkarr SignedPacket TXT at `_magnet` (A8).
   f. Optional unsigned hint: `<link rel="describedby" type="application/x-bittorrent">` (A9).
3. **Syntax**: RFC 6376 s3.2 tag-list profile (A1); `v=mw1` first; three stated deviations; value encoding; character-string joining; size budget (450 B SHOULD, 900 B MUST).
4. **Tags**: `btih` (40 lowercase hex; base32 accepted only in bare magnets), reserved `btmh` (`1220` + 64 hex), `dn`, `xs`, `ws`, `tr` (repeatable, percent-encoded), `chain`, `max`, `owner` (algorithm-tagged key, A2), `gen`, `rot`, `cs`, `consent`, `seq`, `exp`, `sig`. Unknown tags: ignored for meaning, kept for the signature.
5. **Signature**: algorithm identifiers; signing input = `"mw-pointer-v1\n"` + sorted `key=value` lines excluding `sig` + `"\n" + scope` (already in v0.2); scope rules (A-label hostname, `btih:<hex>`); key encodings with Multikey mapping; **test vectors** (valid, wrong scope, unknown tag appended after signing, expired, `seq` rollback, algorithm confusion).
6. **Resolution**: source order (fragment, meta, DNS, cache), multiple records (highest valid `seq`, tie to smallest `sig`), DoH requirements (JSON and RFC 8484 wire; `Accept` only; CNAME handling; negative caching), DNSSEC `AD` as an advisory display only, TTL floor, TOFU pin and `rot` rotation, rollback protection.
7. **Security considerations**: wildcard TXT matching an underscored name (RFC 8552 s1.4), CNAME delegation rot, resolver trust and privacy, replay and expiry, key compromise and rotation, size and parsing limits.
8. **IANA considerations**: `TXT _magnet`; optional well-known suffix; no URI scheme.
9. **Versioning**: `v=mw1` changes only for incompatible grammar or signing changes; additive tags never bump.
10. **Example** (placeholders, not real keys):

```
_magnet.example.com. 300 IN TXT "v=mw1; btih=<40 hex>; dn=My%20Site; xs=https://cdn.example.com/mw/my-site.torrent; ws=https://cdn.example.com/mw/; tr=wss%3A%2F%2Ftracker.example.net; chain=main; owner=ed25519:<43 chars>; seq=12; exp=1805000000; sig=<86 chars>" 
```
(a record of this size is about 440-480 bytes and is split by the publisher into two character-strings of at most 255 bytes; resolvers concatenate them without spaces.)

### 4.2 `MW-LOG/1` - site ledger block and wire format

1. **Data model**: block `{e, h, s, v?}`; entry fields as ARCH s6.1; algorithm-tagged `author` (A2).
2. **Encoding and hashing**: RFC 8785 JCS bytes; `h = hex(SHA-256(bytes))` (prefixing `1220` yields a standard sha2-256 multihash, so ids can be handed to multihash/CID tooling if ever needed); domain-separated signature `"mw-block-v1\n" + h` (already in v0.2); never derive identifiers from signature bytes (Safari randomises Ed25519 signatures, `06`).
3. **Validity**: shape and limits, PoW (`bits` committed inside the entry), signature, policy (owner, moderators, allow-list), `prev` rules, orphan handling; validity is a pure function of the block set.
4. **Order and state**: `(depth, h)` Kahn order; reducer semantics for `put`, `append`, `profile`, control ops, tombstones, succession.
5. **Wire**: BEP 10 extension `mw_chain`, extended-handshake key `mw_v`, frame types HELLO / WANT / BLOCKS / ANN, size caps, per-peer budgets, detach rules (`(site, owner)` mismatch).
6. **Security and privacy**: peer IP exposure, Sybil and spam limits, moderation semantics, storage persistence caveats.
7. **Vectors**: RFC 8785 JCS vectors, block hash and signature vectors for both key algorithms, shuffled-insertion order vectors, malformed-frame vectors.
8. **Non-goals**: consensus, finality, tokens; claims of W3C Data Integrity conformance.

---

## 5. Gotchas

1. **`web+` schemes are letters only.** The HTML Standard requires `web+` followed by "one or more ASCII lower alphas": `web+mw1` throws `SecurityError`. `%s` is replaced with the component-percent-encoded URL, so a handler template `/#%s` receives `magnet%3A%3F...` and the loader must decode once (`w1-09` F5). `magnet` is safelisted, but registering it makes the loader the handler for every torrent magnet on the machine.
2. **TXT multi-string semantics differ by ecosystem.** SPF/DKIM-style and the DNSOP draft concatenate strings; DNS-SD treats each string as an attribute. State the rule (concatenate, no spaces) and never mix a DNS-SD-style per-string parser into the resolver.
3. **"DKIM-style" is a claim you must qualify.** RFC 6376: case-sensitive tags, duplicate tag invalidates the list, unknown tags ignored. v0.2 lowercases, repeats `tr`/`ws`/`xs`, and signs unknown tags. Say so in the spec or drop the DKIM comparison.
4. **The DNSOP domain-verification text is a draft** (rev 13, 2026-06-22, expires 2026-12-24), not an RFC. Do not cite it as normative; its space-separated grammar is the opposite of `;`-separated lists.
5. **An unregistered underscore name is not "taken" and a registered one is not required for operation.** RFC 8552's MUST applies to public specifications; DNSLink, atproto and (until now) most conventions run unregistered. Registration prevents later collisions and is cheap, nothing more. Do not rely on `05` F9's `_dmarc` statement (wrong).
6. **IANA Reference stability.** A mutable `main` README or a repository that may be archived is a poor Reference; the DNSLink repositories were archived in 2026. Use a tagged release and a domain the project controls.
7. **BEPs are frozen drafts.** Cite them as "BEP 46 (Draft)". The BEP repository has had no commit since 2020-05-01, so there is nobody to approve, amend or register anything.
8. **BEP 46 carries only a 20-byte v1 infohash**; BEP 44 values above 1000 bytes may be rejected and items expire in about two hours unless re-announced hourly. Whoever publishes must keep republishing (a cron or `pin.mjs`), and a lapsed publisher silently becomes "not found".
9. **pkarr is Ed25519-only** (z-base32 of the 32-byte key). Today's P-256 owner keys cannot be pkarr keys. The one public relay observed is operated by a single party; a 1.7 MB WASM client is not appropriate for the loader's critical path.
10. **Multikey for P-256 requires compressed points.** WebCrypto exports a 65-byte uncompressed point; compressing is trivial, decompressing needs modular square roots (BigInt). The prefix form (`p256:`) avoids this; Multikey is then a conversion done only at interop edges.
11. **Ed25519 availability is by engine version.** Chrome/Edge/WebView before 137, Firefox before 129, Safari/iOS before 17 and Samsung Internet before 30 lack it; verification needs a pure-JS fallback or a clear "unsupported" message. Safari signs Ed25519 non-deterministically (`06`).
12. **WebTorrent ignores what it does not know.** Hybrid torrents surface BEP 47 padding as ordinary files named `.pad/N`; `file tree` and `urn:btmh` are parsed by `magnet-uri` but unused (`01` F9). Do not publish v2/hybrid until the loader and Service Worker explicitly skip padding files.
13. **`xs=` is fetched with `fetch`.** Cross-origin `.torrent` URLs need CORS; the response is parsed and discarded on infohash mismatch with only a `warning` event, so a stale CDN object looks like "no metadata" unless the loader listens for it.
14. **Web-seed request amplification.** BEP 19 warns that per-piece range requests look like abuse in server logs; PeerTube listed "a large amount of small HTTP requests" as a WebTorrent cost. With 256 KiB pieces, a CDN-hosted site generates many small ranged GETs (billing and rate limits).
15. **`ecdsa-jcs-2019` is not "ECDSA over JCS bytes".** The W3C suites hash canonicalised proof options and the document and sign the concatenation. Do not advertise Data Integrity compatibility.
16. **One origin per site costs a first visit per origin.** The IPFS gateway's own fix "share the installer HTML cache entry across subdomains" (2026-10-15) shows the pain; caches and Service Workers are not shared across subdomains.
17. **IWA documentation is dated.** The "ChromeOS enterprise only" banner is on a page last updated 2026-02-06; re-check before ruling out IWA-only features for any future desktop product.
18. **Ecosystem fragility is organisational, not technical.** Shipyard's exit (2026-09-30), the archived DNSLink organisation, an unmaintained IPFS "drop-in" Service Worker, single-maintainer btlink and SpawnDev.WebTorrent, and WebTorrent itself in dependency-bump mode: pin versions, vendor small pieces, and keep the specs implementable without any of them.
19. **Process gotcha for future research runs:** the unauthenticated GitHub API is shared and was exhausted by sibling agents (use Atom feeds, raw files and the npm registry), and the shared WebSearch budget (200 per turn) ran out; plan searches first.

---

## 6. Open questions

1. **IANA turnaround and acceptance of a repository-hosted Reference for `TXT _magnet`.** Precedents are positive (F2); the elapsed time between request and entry is unknown. Worth asking the experts (Frederico A C Neves, Paul Wouters) informally before filing.
2. **`;` or space separator for `mw1`?** The IETF DNSOP draft may become a BCP with space-separated pairs and a "token first" rule; the DKIM family uses `;`. v0.2 chose `;`. Should the parser also accept spaces as separators (value alphabet forbids spaces anyway)? Decide before the first public record.
3. **Prefix (`p256:`) or Multikey (`zDn...`) as the canonical key string?** The prefix is cheaper; Multikey interoperates with DID tooling. Which interop surface matters first: pkarr/BEP 46 (Ed25519 raw), IWA, or DID?
4. **Ed25519 for owner keys only, or for author keys too?** Owner keys are Node-held; author keys are browser-held and face the iOS CryptoKey persistence bugs recorded in `06` (cited as R06 F50 in DR LATER). Does the project want mixed-algorithm ledgers?
5. **Will anyone revive DNSLink?** If the IPFS Foundation takes it over, a `/btih/` or `/magnet/` namespace could be proposed; no signal either way on 2026-10-17.
6. **Public pkarr relay diversity.** Only `pkarr.pubky.app` was observed; unknown whether other operators exist or whether the project should self-host `pkarr-relay` (Rust binary) alongside a hub.
7. **Brave and other browsers.** Brave's WebTorrent removal versions are taken from `w1-09`; not re-derived. Whether Chromium will keep its experimental `ipfs`/`ipns`/`dweb` handler allowance (BCD) is unknown.
8. **libtorrent and qBittorrent BEP 46 support.** The libtorrent features page does not list BEP 46/44/52; I could not confirm whether any mainstream native client follows `xs=urn:btpk:` links, which decides how useful a BEP 46 export (A8) is outside Agregore, bt-fetch and SpawnDev.
9. **WAICT and signature-based SRI.** Not researched by me (budget); `w1-10`/`w1-11` treat them as unverified/early. If they mature they will use Ed25519 and affect trust-root claims.
10. **WebTorrent upstream future.** BEP 52 (#1117, since 2017) and BEP 46 (#886) are open; releases are in maintenance mode. Is a fork or a second engine (SpawnDev.WebTorrent in browsers, Blazor) worth tracking?
11. **A `/.well-known/magnet-web` pointer file.** Useful when DoH is blocked (`05` rec.), but is the provisional registration worth the paperwork (RFC 8615, Specification Required)?
12. **PSL timing for the hub domain.** The domain must have more than 2 years of registration left at PR time and must be controlled by the requester; which domain, and is a user-content hub accepted under the "minimal entries" expectation? (`w1-10` open question 9.)
13. **Search terms I could not run.** The brief named GitHub searches for `torrent-web`, `magnet site`, `wtsite` and `planktos fork`; the search budget was gone, so only projects reached through the first three searches, sibling documents and direct README fetches are covered. Other 2024-2026 website-over-WebTorrent loaders may exist.

---

## Appendix A - Sources actually read

All fetched on 2026-10-17 unless another date is stated. "(WFS)" = read through a WebFetch model summary; "(WS)" = WebSearch result used only as a pointer; "(raw)" = raw file via curl; "(local)" = file in this repository or `node_modules`.

**Standards and registries**
- S1 RFC 8552 (raw): https://www.rfc-editor.org/rfc/rfc8552.txt (March 2019, OLD)
- S2 IANA DNS Parameters registry: https://www.iana.org/assignments/dns-parameters/dns-parameters.xml (`updated` 2026-10-16), https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml, https://www.iana.org/assignments/dns-parameters/underscored-globally-scoped-dns-node-names.csv
- S3 IANA protocol registration forms: https://www.iana.org/protocols/apply
- S4 RFC 10023 (raw): https://www.rfc-editor.org/rfc/rfc10023.txt (July 2026)
- S5 RFC 6376 (raw): https://www.rfc-editor.org/rfc/rfc6376.txt (Sept 2011, OLD)
- S6 RFC 7208 (raw): https://www.rfc-editor.org/rfc/rfc7208.txt (April 2014, OLD)
- S7 RFC 6763 (raw): https://www.rfc-editor.org/rfc/rfc6763.txt (Feb 2013, OLD)
- S8 RFC 1464 (raw): https://www.rfc-editor.org/rfc/rfc1464.txt (May 1993, OLD)
- S9 IETF DNSOP draft -13 (raw): https://www.ietf.org/archive/id/draft-ietf-dnsop-domain-verification-techniques-13.txt (2026-06-22)
- S10 IETF datatracker API queries (group `wpack`; documents by name for wpack, dnslink, magnet, torrent, bittorrent, btih, webseed, domain-verification): https://datatracker.ietf.org/api/v1/doc/document/ and https://datatracker.ietf.org/api/v1/group/group/?acronym=wpack
- S11 RFC index (raw): https://www.rfc-editor.org/rfc-index.txt (statuses of RFC 8785, 9530, 9942, 9943, 9162, 9989, 10023, 6920)
- S12 RFC 6249 (raw): https://www.rfc-editor.org/rfc/rfc6249.txt (June 2011, OLD)
- S13 RFC 7595 (raw): https://www.rfc-editor.org/rfc/rfc7595.txt (June 2015, OLD)
- S14 RFC 8615 (raw): https://www.rfc-editor.org/rfc/rfc8615.txt (May 2019, OLD); IANA Well-Known URIs: https://www.iana.org/assignments/well-known-uris/well-known-uris-1.csv
- S15 RFC 6920 (raw): https://www.rfc-editor.org/rfc/rfc6920.txt (April 2013, OLD)
- S16 IANA URI schemes and application media types: https://www.iana.org/assignments/uri-schemes/uri-schemes-1.csv, https://www.iana.org/assignments/media-types/application.csv

**BitTorrent**
- S20 BEP index: https://www.bittorrent.org/beps/bep_0000.html
- S21 BEP sources (raw): https://raw.githubusercontent.com/bittorrent/bittorrent.org/master/beps/bep_0003.rst (and 0004, 0009, 0010, 0017, 0019, 0034, 0044, 0046, 0047, 0049, 0052, 0053, 0055)
- S22 BEP repository activity: https://github.com/bittorrent/bittorrent.org/commits/master.atom
- S23 WebTorrent BEP table (raw): https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/bep_support.md
- S24 (local) `node_modules/webtorrent/lib/torrent.js` (3.0.21), `node_modules/magnet-uri/index.js` (7.0.10), `node_modules/bittorrent-tracker/README.md`
- S25 libtorrent features: https://www.libtorrent.org/features.html
- S26 npm registry packuments: https://registry.npmjs.org/{webtorrent,create-torrent,bittorrent-tracker,parse-torrent,magnet-uri,@helia/verified-fetch,@helia/dnslink,@multiformats/dns,trystero,bugout,planktos,wbn,wbn-sign,pkarr,@synonymdev/pkarr,bt-fetch,webtorrent-hybrid,@noble/ed25519,hyperdrive,hyperswarm,@hyperswarm/dht-relay,nsite-gateway,@dnslink/js,@number0/iroh}
- S27 WebTorrent repository activity: https://github.com/webtorrent/webtorrent/commits/master.atom

**DNSLink and IPFS**
- S30 DNSLink spec site (raw): https://dnslink.dev/ (undated)
- S31 (WFS) https://github.com/dnslink-std
- S32 IPFS Service Worker Gateway: https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/README.md; https://github.com/ipfs/service-worker-gateway/commits/main.atom
- S33 Shipyard announcement: https://ipshipyard.com/blog/2026-the-end-of-ipfs-at-shipyard/ (2026-08-24)
- S34 IPFS blog: https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/ (2026-08-25)
- S35 Drop-in SW: https://raw.githubusercontent.com/ipshipyard/drop-in-service-worker/main/README.md
- S36 IPFS Subdomain Gateway spec: https://specs.ipfs.tech/http-gateways/subdomain-gateway/
- S37 (WFS) Public Suffix List guidelines: https://github.com/publicsuffix/list/wiki/Guidelines

**Browser platform**
- S40 HTML Standard, custom handlers: https://html.spec.whatwg.org/multipage/system-state.html
- S41 MDN browser-compat-data 8.1.6 (timestamp 2026-10-15): https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data/data.json
- S42 (WFS) https://github.com/WICG/webcrypto-secure-curves/issues/20 ; (raw) https://raw.githubusercontent.com/WICG/webcrypto-secure-curves/main/README.md
- S43 Chrome IWA docs: https://developer.chrome.com/docs/iwa/introduction (updated 2026-02-06), https://developer.chrome.com/docs/iwa , https://developer.chrome.com/docs/iwa/direct-sockets (2025-12-17), https://developer.chrome.com/docs/iwa/controlled-frame (2025-09-18)
- S44 Chrome Web Bundles: https://developer.chrome.com/docs/web-platform/web-bundles (last updated 2019-11-11 plus later warning)
- S45 Google Search Central: https://developers.google.com/search/docs/appearance/signed-exchange (HTTP 301) and https://developers.google.com/search/updates
- S46 WICG webpackage: https://raw.githubusercontent.com/WICG/webpackage/main/README.md, https://raw.githubusercontent.com/WICG/webpackage/main/explainers/subresource-loading.md; https://wpack-wg.github.io/bundled-responses/draft-ietf-wpack-bundled-responses.html
- S46b WICG Bundle preloading: https://raw.githubusercontent.com/WICG/resource-bundles/main/README.md ; https://github.com/WICG/resource-bundles/commits/main.atom
- S47 (WFS) Brave: https://github.com/brave/brave-browser/issues/37735, https://github.com/brave/brave-browser/wiki/How-to-remove-IPFS-protocol-association, https://github.com/brave/brave-core/tree/master/components/brave_webtorrent ; (WS) search summary on Brave's IPFS deprecation
- S48 W3C: https://www.w3.org/TR/vc-data-integrity/ , https://www.w3.org/TR/vc-di-ecdsa/ , https://www.w3.org/TR/vc-di-eddsa/ , https://www.w3.org/TR/cid/ , https://www.w3.org/TR/did-core/

**Projects**
- S50 Planktos: https://raw.githubusercontent.com/xuset/planktos/master/README.md ; https://github.com/xuset/planktos/commits/master.atom ; (WS) search results
- S51 Bugout: https://raw.githubusercontent.com/chr15m/bugout/master/README.md ; https://github.com/chr15m/bugout/commits/master.atom
- S52 PeerWeb: https://raw.githubusercontent.com/Omodaka9375/peerweb/main/README.md ; (WFS) https://github.com/Omodaka9375/peerweb ; (WFS) https://news.ycombinator.com/item?id=46829582 ; https://github.com/Omodaka9375/peerweb/commits/main.atom
- S53 WEB25.cloud: https://raw.githubusercontent.com/adigeo08/web25.cloud/main/README.md ; https://github.com/adigeo08/web25.cloud/commits/main.atom
- S54 PeerWebSite and peerweb.js: https://raw.githubusercontent.com/Weedshaker/PeerWebSite/master/README.md ; https://github.com/Weedshaker/PeerWebSite/commits/master.atom ; https://github.com/retrohacker/peerweb.js/commits/master.atom
- S55 btlink: https://raw.githubusercontent.com/anacrolix/btlink/master/README.md ; https://github.com/anacrolix/btlink/commits/master.atom
- S56 bt-fetch and Agregore: https://raw.githubusercontent.com/RangerMauve/bt-fetch/master/README.md ; https://raw.githubusercontent.com/AgregoreWeb/agregore-browser/master/README.md ; https://github.com/AgregoreWeb/agregore-browser/releases.atom ; https://github.com/AgregoreWeb/agregore-browser/commits/master.atom
- S57 pkarr: https://raw.githubusercontent.com/pubky/pkarr/main/README.md , .../design/base.md , .../design/relays.md , .../docs/integration.md , .../docs/introduction.md ; https://github.com/pubky/pkarr/commits/main.atom ; live probe https://pkarr.pubky.app/<sample key>
- S58 Nostr: https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md , .../5A.md , .../B7.md
- S59 Trystero: https://raw.githubusercontent.com/dmotz/trystero/main/README.md
- S60 P2P Media Loader: https://raw.githubusercontent.com/Novage/p2p-media-loader/master/README.md ; https://github.com/Novage/p2p-media-loader/commits/main.atom
- S61 PeerTube: https://raw.githubusercontent.com/Chocobozzz/PeerTube/develop/CHANGELOG.md ; (WFS) https://github.com/Chocobozzz/PeerTube/issues/5465
- S62 SpawnDev.WebTorrent: https://raw.githubusercontent.com/LostBeard/SpawnDev.WebTorrent/master/README.md ; https://github.com/LostBeard/SpawnDev.WebTorrent/commits/master.atom
- S63 Iroh: https://docs.iroh.computer/deployment/wasm-browser-support

**Project-internal (local)**
- S70 `docs/ARCHITECTURE.md` v0.2 (2026-10-17); S71 `docs/review/DESIGN-REVIEW.md`; S72 `docs/research/01-webtorrent-browser.md`; S73 `docs/research/05-doh-dns-txt.md`; S74 `docs/research/06-browser-chain-vs-crdt.md`; S75 `docs/research/w1-07-prior-art.md`; S76 `docs/research/w1-09-protocol-handler-magnet.md`; S77 `docs/research/w1-10-static-hosting-bootstrap.md`; S78 `docs/research/w1-11-security-threats.md`; S79 `src/chain/crypto.js`.

## Appendix B - Corrections and inconsistencies found

1. `05-doh-dns-txt.md` F9 lists `_dmarc` among names "not registered"; the IANA registry has `TXT _dmarc` (2018-11-29, now RFC 9989). Conclusions of F9 stand.
2. ARCHITECTURE v0.1 s6.1 (archived) said "Ed25519 is not yet universal"; MDN data (2026-10-15) shows Ed25519 in all current engines. v0.2 does not repeat the sentence but still fixes raw P-256 in `owner=` and `author`; DR LATER defers Ed25519 "only if P-256 persistence fails". See A2 for the narrower change proposed here.
3. v0.2 s4 describes the pointer as split on `;` with case-folded, repeatable keys; any comparison to DKIM/DMARC must carry the deviations (F4, A1).
4. `w1-07` says Brave removed `ipfs://` on 2024-08-22; the Brave issue I read (`#37735`) gives no removal date, only the plan and a milestone (1.69.x). The date rests on `w1-07`'s reading of Brave's own notice (and on one search summary I saw), so treat the exact day as single-source.
5. Packages named in earlier docs as "maintained" should be re-checked after Shipyard's exit: `@helia/*` packages still publish (verified-fetch 8.1.2 on 2026-09-22, dnslink 2.0.2 on 2026-07-03) but their maintainers changed on 2026-09-30.
