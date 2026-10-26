# w2c-06 VERIFY - skeptical re-check of "Standards alignment and existing ecosystem efforts (do not reinvent)"

- **Subject:** the eight design-critical claims asserted in `docs/research/w2c-06-standards-and-ecosystem.md` (read only, not modified by this pass).
- **Checked on:** 2026-10-17, fetches between about 21:45 and 22:01 UTC (17:45 to 18:01 ET). "Today" for every "current" statement below is 2026-10-17.
- **Resume note:** on resume, `docs/research/` held no `w2c-06-standards-and-ecosystem-VERIFY.md` and no partial copy of it in the scratchpad, so nothing was lost or overwritten. The original researcher's scratch directory (`.../scratchpad/w2c06/`, notes plus saved IANA files) was found and used as a cross-check.
- **Method:** every claim was re-tested against primary text fetched directly (RFC text, IANA registry XML/XHTML/CSV, datatracker API records by exact name, GitHub HTML pages and Atom feeds, raw GitHub files, npm registry JSON, the local `node_modules` source). Downloads were saved in separate scratch directories under `/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/v06/` and parsed with `python3 -I`.
- **Limits (read this):**
  - The shared WebSearch budget (200 calls per turn, all agents) was already used up. Two attempts returned "budget used up". I did NOT work around it (no search engines, archives or proxies were queried). So "fresh searches" in the literal sense were not possible; "re-open the primary source" was. Claims that are absences ("no registry", "no known consumer") can only be checked against the sources named below, and are marked accordingly.
  - GitHub's unauthenticated API is rate limited and shared, so repository state comes from HTML pages, embedded page JSON and Atom feeds.
  - Datatracker API calls were by exact group or document name (registry lookups), not searches.
- **Verdict legend:** confirmed = every sub-statement holds on primary text; nuanced = substance holds but a number, scope or strength must be corrected; refuted = false; unverifiable = cannot be checked from reachable primary sources.

## Summary

| # | Claim (short) | Verdict | Headline correction |
|---|---|---|---|
| 1 | RFC 8552 registry: Expert Review, experts, review scope, stable Reference, MUST register, IANA form | **confirmed** | None to the substance. Refinements: "stable" is applied loosely in practice; RFC 8552 itself never mentions a form (the form rule is IANA's generic one). |
| 2 | Registry has 69 records; none of 5 names; 3 recent reference types | **nuanced** | **72 records, not 69** (60 distinct node names, 17 TXT rows). The rest holds. `_x402` is now draft revision -03, the registry still cites -01. |
| 3 | TXT syntax conventions disagree; v0.2 deviates; DNSOP draft -13 | **nuanced** | Every quoted rule is real. Qualify: draft strengths are SHOULD or conditional and it targets domain-verification records; v0.2's repeat-key deviation covers only `tr/ws/xs` (+ unknown keys; single-valued duplicates are rejected as in DKIM) and its key lowercasing matches RFC 6763 and the draft; RFC 10023 (July 2026) adds an opposite rule (exactly one character-string). |
| 4 | DNSLink spec content; `dnslink=/btih/` has no consumer | **nuanced** | Text claims hold. "Helia skips unknown namespaces" is only the default: `@helia/dnslink` has a public `namespaces` plug-in option. Kubo/Boxo and Companion do ignore non-IPFS namespaces. "No known consumer" is an absence claim, not provable here. |
| 5 | DNSLink has no steward; Shipyard ended; 8 projects maintainerless | **nuanced** | DNSLink and Shipyard parts hold. **Service Worker Gateway is NOT maintainerless**: its README names `@nymd` and `@byo` for the IPFS Foundation (since 2026-09-22). Helia has no maintainer banner. Seven others carry "no dedicated maintainer". |
| 6 | BEP process dormant; statuses | **nuanced** | All dates and statuses hold. But community submissions continue unmerged through 2026, including an open "draft BEP: Magnet-URI Webseeding" (PR #171) that formalises `ws`/`xs`. Highest BEP is 55 only if meta BEP 1000 is excluded. |
| 7 | webtorrent 3.0.21 BEP support, `xs=` behaviour, magnet-uri parse | **confirmed** | "Maintenance mode" is an inference from the commit log (no project statement). `bittorrent-dht` (Node dependency) does implement BEP 44, but WebTorrent does not expose it and the browser build excludes DHT. |
| 8 | Web Packaging is a dead end | **nuanced** | All dated facts hold. "Dead end" overstates: Signed Web Bundles are alive as the Isolated Web Apps container (`wbn-sign` 0.3.3 on 2026-10-15; `WICG/webpackage` commits on 2026-10-15). Dead for ordinary-browser site delivery. |

---

## Claim 1 - RFC 8552 registry mechanics

**Claim (abridged):** the "Underscored and Globally Scoped DNS Node Names" registry uses Expert Review (experts Frederico A C Neves, Paul Wouters); the review checks only that an entry is sufficiently clear, precise, complete and unique; the Reference MUST have a stable resolution to the controlling organization; public specifications MUST register their global underscored name; requests go through IANA's General Protocol Registration Request Form.

**Verdict: confirmed.** No correction to the substance. Refinements below change how much weight to put on "stable" and on the form.

**Evidence (primary text, re-read):**
- IANA XML (`dns-parameters.xml`, `<updated>2026-10-16</updated>`, HTTP Last-Modified Fri 2026-10-16 20:31:26 GMT) registry `underscored-globally-scoped-dns-node-names`: `<registration_rule>Expert Review</registration_rule>`, `<expert>Frederico A C Neves, Paul Wouters</expert>`, `<xref type="rfc" data="rfc8552"/>`. The XHTML page shows the same ("Registration Procedure(s) Expert Review; Expert(s) Frederico A C Neves, Paul Wouters; Reference RFC 8552").
- RFC 8552 (BCP 222, March 2019, still not obsoleted or updated per the rfc-editor JSON) section 4.1: "This registry operates under the IANA rules for "Expert Review" registration; see Section 4.1.5." and "The required Reference for an entry MUST have a stable resolution to the organization controlling that registry entry."
- Section 4.1.5: "This review is solely to determine adequacy of a requested entry in this registry, and it does not include review of other aspects of the document specifying that entry." The review ensures "The details for creating the registry entry are sufficiently clear, precise, and complete" and "The combination of the underscored name, under which the listed resource record type is used, and the resource record type is unique in the table". "For the purposes of this expert review, other matters of the specification's technical quality, adequacy, or the like are outside of scope."
- Section 2: "If a public specification calls for use of an underscored node name, the global underscored node name -- the underscored name that is closest to the DNS root -- MUST be entered into this registry."
- IANA `https://www.iana.org/protocols/apply`: "If we don't have a registry-specific form, the General Protocol Registration Request Form should be used." The registry-specific forms listed are only PEN, multicast addresses, media types, ports/service names, ifTypes, tunnelTypes and media feature tags; "All other protocol registries" points to the General form (`/form/protocol-assignment`). That page is titled "General Request for Assignments" and asks for contact name and email, request description, which registry, why, and a reference to the specification.

**Refinements (not corrections):**
1. "Unique" means the pair (RR Type, `_NODE NAME`) is unique. `TXT _magnet` would be unique if no `TXT _magnet` row exists; other RR types under the same name are separate rows.
2. RFC 8552 never mentions a form. Its section 3 only gives a text template for a specification's IANA Considerations ("Per RFC 8552, please add the following entry ..."). The "form" part rests on IANA's generic rule, which is sound because no DNS-specific form exists, but it is an inference from the apply page, not from the RFC or the registry.
3. "Stable resolution" is applied loosely. `_x402` is registered against `draft-hawkins-x402-dns-discovery-01`, but the datatracker now shows revision 03 (2026-08-23), an individual draft that expires 2027-02-24. `_nnu-verification` is registered against a vendor URL; the text at that URL says "Revised 28 August 2026" (the registration date), "not an IETF document", change controller Grid Heap, Inc.
4. "Public specification" is not defined in RFC 8552 and the MUST binds specification authors, not DNS users. Widely used unregistered names exist (`_dnslink`, `_atproto`).

**Residual uncertainty:** how the experts apply the review in practice (no public review record was read) and IANA turnaround time were not measured.

---

## Claim 2 - registry state on 2026-10-17

**Claim (abridged):** registry XML updated 2026-10-16 has **69 records** and none of `_magnet`, `_dnslink`, `_atproto`, `_btlink`, `_ipfs`; recent entries were accepted with an Informational RFC (`_for-sale`, RFC 10023), an Internet-Draft (`_x402`, 2026-08-11) and a plain URL specification (`_nnu-verification`, 2026-08-28).

**Verdict: nuanced.** The record COUNT is wrong; everything else holds.

**Correction (exact):** the registry has **72 records** (not 69). Three independent representations of the same snapshot agree:
- XML: 72 `<record>` elements inside `<registry id="underscored-globally-scoped-dns-node-names">`.
- CSV `underscored-globally-scoped-dns-node-names.csv` (2,146 bytes, HTTP Last-Modified Tue 2026-10-13 20:07:00 GMT): header plus **72 data rows**.
- XHTML table: **72 body rows**.
- Breakdown: 60 distinct node names; 72 distinct (RR type, name) pairs; by RR type SRV 14, TLSA 4, TXT **17**, URI 28, and one each of `*`, CDNSKEY, CDS, DSYNC, HTTPS, NULL, OPENPGPKEY, SMIMEA, SVCB.
- **This is a counting error, not a registry change.** The original researcher's own saved files (`.../scratchpad/w2c06/dl/iana/underscored.csv`, `dns-parameters.xml`, fetched about 20:51 UTC) are byte-identical (same SHA-256) to my fetch at 21:45 UTC: CSV `21d84657bb70...a6d1`, XML `8cf6389cfb70...5093`. Both contain 72 records. Wave-1 `05-doh-dns-txt.md` line 172 ("69 entries, 16 of type TXT", fetched 2026-10-14) is also inconsistent with the file: it lists 16 registered TXT names and omits `_dmarc` (the file has 17 TXT rows). Because the CSV Last-Modified (2026-10-13) predates that 2026-10-14 fetch, the 72-row state most likely already held on 2026-10-14, but that cannot be proven from here.

**What holds (verified in the XML/CSV):**
- Absent: `_magnet`, `_dnslink`, `_atproto`, `_btlink`, `_ipfs` (also absent: `_dnsaddr`, `_bittorrent`, `_torrent`). `_dmarc` IS present (2018-11-29, `updated` 2025-03-27, RFC 9989).
- `_for-sale`: `TXT _for-sale`, reference RFC 10023, registry record date 2026-02-09 (so the entry predates the RFC's July 2026 publication date). RFC 10023 per rfc-editor JSON: "The "_for-sale" Underscored and Globally Scoped DNS Node Name", status INFORMATIONAL, source "IETF - NON WORKING GROUP", draft `draft-davids-forsalereg-21`, author M. Davids (SIDN Labs), "July 2026".
- `_x402`: `TXT _x402`, date 2026-08-11, reference `draft-hawkins-x402-dns-discovery-01`. Correction: datatracker shows the draft is now **-03** (time 2026-08-23T17:36:34Z), states "Active" and "I-D Exists", no stream (individual draft), expires 2027-02-24. The registry still cites -01.
- `_nnu-verification`: `TXT _nnu-verification`, date 2026-08-28, reference `https://nnu.us/specifications/nnu-domain-verification-1.0.txt` (HTTP 200, `cache-control: no-store`; document says "Revised 28 August 2026" and "It is not an IETF document").
- Extra: `_tls` (RFC 8460, a 2018 RFC) was added 2026-08-20, so retroactive registration of legacy usage by reference to an old RFC is also accepted.

**Residual uncertainty:** none on the count. Whether the registry had 69 entries on 2026-10-14 is unknown.

---

## Claim 3 - written TXT syntax conventions and the v0.2 pointer grammar

**Claim (abridged):** RFC 6376 s3.2 makes tags case-sensitive and invalidates lists with duplicate tags (v0.2 lowercases keys and repeats `tr/ws/xs`); RFC 7208 s3.3 requires concatenating strings without spaces; RFC 6763 treats each string as an attribute; the not-yet-RFC DNSOP domain-verification draft -13 (2026-06-22) wants space-separated pairs with the token first and DNSSEC-signed zones.

**Verdict: nuanced.** Every quoted rule exists. The qualifications below (items 1 to 4) change how the claim should be read; item 5 is a note.

**Verified quotes:**
- RFC 6376 s3.2 (Internet Standard, updated by RFC 8301, 8463, 8553, 8616; not obsoleted): "Tags MUST be interpreted in a case-sensitive manner." / "Tags with duplicate names MUST NOT occur within a single tag-list; if a tag name does occur more than once, the entire tag-list is invalid." / "Unrecognized tags MUST be ignored." Separator is ";".
- RFC 7208 s3.3 (Proposed Standard, updated by 7372, 8553, 8616): "If a published record contains multiple character-strings, then the record MUST be treated as if those strings are concatenated together without adding spaces."
- RFC 6763 s6.3: "Each key/value pair is encoded as its own constituent string within the DNS TXT record, in the form "key=value"". s6.4: "Case is ignored when interpreting a key"; "A given key SHOULD NOT appear more than once"; "the client MUST silently ignore all but the first occurrence".
- Draft -13: datatracker record `draft-ietf-dnsop-domain-verification-techniques` rev 13, time 2026-06-22T00:41:16Z, expires 2026-12-24, 24 pages, intended BCP, `rfc: None`; states "Active", "I-D Exists", "Waiting for WG Chair Go-Ahead", tag "Revised I-D Needed - Issue raised by WG". Revisions -14 and -15 return HTTP 404 on the ietf.org archive, so -13 is the latest. It is not an RFC.
- ARCHITECTURE v0.2 s4 and `src/common/pointer.js`: "split on `;`, trim each part, split at the first `=`, lowercase the key, keep the value verbatim", "Repeatable keys: `tr`, `ws`, `xs`. Unknown keys are kept (and signed)." `joinTxtData()` joins character-strings "with NO separator".

**Qualifications / corrections:**
1. **Draft -13 strengths and scope.** (a) It is about Domain Control Validation records (challenge tokens), not general data records, so it is an analogy for a pointer record, not a binding precedent. (b) s6.1.2: "When specified, metadata SHOULD be encoded in the RDATA via space-separated ASCII key-value pairs, with the key "token" prefixing the Unique Token." "The token MUST be the first element in the key-value list" applies when metadata is used; with no metadata the bare token is the whole RDATA ("If the TXT record RDATA is not prefixed with token= then the entire RDATA should be assumed to be the token"). (c) s9.7: "A domain owner SHOULD sign their DNS zone using DNSSEC"; Application Service Providers "MUST use a trusted DNSSEC validating resolver" and "SHOULD take additional steps" when the AD bit is not set. DNSSEC for the zone is a SHOULD, not a requirement. (d) "Keys are considered to be case-insensitive" and "If there are multiple character-strings within the RDATA, the Application Service Provider MUST treat them as a concatenated string."
2. **v0.2's deviation from RFC 6376 is narrower than "repeats".** Only `tr`, `ws`, `xs` (and unknown keys, kept as arrays) may repeat. For the 13 single-valued keys a duplicate makes the parse fail (`duplicate-key`), which matches DKIM's "entire tag-list is invalid". Real deviations from RFC 6376: (i) lowercasing keys (DKIM: case-sensitive), (ii) repeatable `tr/ws/xs`, (iii) unknown keys are kept and signed (DKIM: ignored).
3. **Lowercasing is a disagreement among standards, not a lone deviation.** RFC 6763 and draft -13 are case-insensitive, so v0.2 matches them and differs from RFC 6376. Duplicates are handled three ways: RFC 6376 invalid list, RFC 6763 first occurrence wins, draft -13 one token per RR.
4. **A newer IETF convention goes the other way (not in the claim, but it strengthens "conventions disagree").** RFC 10023 (July 2026) s2.1 and s2.4: the version tag comes first and is case-sensitive (`v=FORSALE1;`), "only one tag-value pair per record", and "The RDATA of each "_for-sale" TXT record MUST consist of a single character-string [RFC1035] with a maximum length of 255 octets, to avoid the need to concatenate multiple character-strings during processing." The example `"v=FORSALE1;" "ftxt=foo" "bar" "invalid"` is declared invalid. v0.2's realistic signed pointer (about 480 bytes per the original doc F5) needs two strings, so a `_magnet` spec must say explicitly that it follows RFC 7208/draft -13 concatenation and not RFC 10023's single-string rule. dnslink.dev's FAQ also notes "a convention of storing multiple space separated values in a single TXT record".
5. The original doc's table says v0.2 does not state "`v=` first"; ARCHITECTURE s4 indeed has no first-element rule (the example just lists `v=mw1` first). Still true.

**Residual uncertainty:** whether the DNSOP chairs will advance -13 and with what changes (tag says a revision is needed).

---

## Claim 4 - DNSLink specification and consumers of `dnslink=/btih/<hex>`

**Claim (abridged):** dnslink.dev defines `dnslink=/<namespace>/<identifier>` at `_dnslink.<domain>`, tells implementations to ignore invalid or unknown records, allows several namespaces, contains no namespace registry; `dnslink=/btih/<hex>` would be grammatical yet has no known consumer (Helia skips unknown namespaces; IPFS Companion only asks a local Kubo node to resolve `/ipns` names).

**Verdict: nuanced.** The spec-text half is confirmed. The consumer half needs one correction (Helia's default is not a hard limit) and one caveat (an absence cannot be proven here); the Boxo and Companion checks confirm the claim.

**Verified (dnslink.dev HTML fetched 2026-10-17; HTTP Last-Modified Fri 2026-07-31 21:24:51 GMT):**
- "DNSLink records are of the form: dnslink = /<namespace>/<identifier>"; "Starting with /<namespace>/ ensures multiple links can coexist. This prefix allows clients to ignore records linking to unsupported protocols or addressing systems. Implementations should never error on invalid record. Simply ignore and move to the next one." "DNSLink records MUST be specified on the _dnslink subdomain".
- Multiple namespaces: example lists `dnslink=/ipfs/..`, `/hyper/..`, `/foo/..`.
- No registry: the page has zero occurrences of "IANA", "steward", "maintain" or "archiv"; every "regist" hit is about domain registrars; no namespace list exists on the page, in `dnslink-std/community` README (only a discussion-forum link) or elsewhere on the site navigation. FAQ: "Is there an IETF RFC spec? Not yet. We should write one."

**Corrections / caveats on consumers:**
1. **Helia: "skips unknown namespaces" is only the default.** `@helia/dnslink` 2.0.2 (`packages/dnslink/src/dnslink.ts`, `main`) builds `this.namespaces = { ipfs, ipns, ...init.namespaces }` and for an unknown protocol does `this.log('unknown protocol "%s" in DNSLink record for domain: %s', ...)` then `continue`. `DNSLinkOptions.namespaces` is documented in `index.ts`: "By default `/ipfs/...`, `/ipns/...` and `/dnslink/...` record values are supported - to support other prefixes pass other value parsers here". So any Helia user can register a `btih` parser; a custom consumer is possible without any registry. (The built-in `/dnslink/` namespace follows a record to another DNSLink domain.)
2. **Kubo/Boxo ignore other namespaces (confirms the intent).** Boxo `namesys/dns_resolver.go`: "Filter only the IPFS and IPNS paths." and a second IPFS/IPNS record gives `ErrMultipleDNSLinkRecords`. So a `/btih/` record next to a `/ipfs/` record is dropped and causes no conflict.
3. **IPFS Companion: confirmed.** `add-on/src/lib/dnslink.js` (`ipfs/ipfs-companion` `main`; `ipfs-shipyard/ipfs-companion` now 301-redirects there) POSTs `${state.apiURLString}api/v0/resolve?arg=/ipns/${fqdn}&recursive=false` to the local node and throws unless the result passes `IsIpfs.path`. It never parses DNS itself.
4. The generic reference library `@dnslink/js` 0.13.0 returns `links` "for the different namespaces" (README), so a `/btih/` record would be parsed and exposed, just not acted on. (Only its README was read; the code was not.)
5. **"No known consumer" cannot be proven here.** It holds for every source checked (dnslink.dev, dnslink-std, Helia, Boxo, Companion). The web search that would test it ecosystem-wide was unavailable, so state it as "no consumer found in the checked sources".

**Residual uncertainty:** third-party resolvers and gateways that might consume unusual namespaces (for example ENS-style DNS gateways named in the FAQ) were not examined.

---

## Claim 5 - DNSLink has no steward; IPFS Shipyard ended; eight projects without dedicated maintainers

**Claim (abridged):** all five dnslink-std repositories are archived (org archived 2026-07-31; `@dnslink/js` last published 2022-06-03); Shipyard's funding was not renewed with its work ending 2026-09-30, leaving Kubo, Helia, Boxo, Rainbow, IPFS Desktop, IPFS Companion, Someguy and the Service Worker Gateway without dedicated maintainers.

**Verdict: nuanced (one list member refuted).**

**Confirmed:**
- `github.com/dnslink-std` banner: "This organization was marked as archived by an administrator on Jul 31, 2026. It is no longer maintained." All five repositories show "Public archive": `dnslink-website` (archived by the owner on Jul 31, 2026, "It is now read-only", 8 issues and 4 PRs left open), `go` (last updated Jul 6, 2022), `js` (Jun 3, 2022), `test` (Jun 3, 2022), `community` (Jul 14, 2021).
- npm `@dnslink/js`: latest 0.13.0, published 2022-06-03T06:28:53Z, `modified` the same instant, 20 versions, not deprecated. Do not confuse it with the unrelated unscoped npm package `dnslink` (0.2.8, 2019-01-31, repository `common-theory/dnslink`, not the dnslink-std org); the original doc's "`dnslink`/`@dnslink/js` (last release 2022-06-03)" reads as one package with that date, but the unscoped `dnslink` last released in 2019.
- Shipyard post "The end of IPFS at Shipyard" (dated Aug 24, 2026; "UPDATE (August 25)"): "Protocol Labs has informed us that it will not be renewing Shipyard's funding." "Our final day of our IPFS related work will be September 30, 2026." "Projects maintained by Shipyard will no longer have dedicated maintainers responsible for new features, bug fixes, releases, or long-term stewardship. These include: Kubo, Helia, Boxo, Rainbow, IPFS Desktop, IPFS Companion, Someguy, Service Worker Gateway, IPFS Check, and others."

**Correction - state as of 2026-10-17, per project (README banner, newest commit in the `main`/`master` Atom feed):**

| Project | README says | Newest commit seen | Verdict for this project |
|---|---|---|---|
| Kubo | "There is no dedicated maintainer at the moment." | 2026-09-27 | maintainerless (banner) |
| Boxo | same banner | 2026-09-21 | maintainerless (banner) |
| Rainbow | same banner ("ended with 2026 Q3") | 2026-09-27 | maintainerless (banner) |
| IPFS Desktop | same banner | 2026-09-27 | maintainerless (banner) |
| IPFS Companion | "Important There is no dedicated maintainer at the moment." | 2026-09-16 | maintainerless (banner) |
| Someguy | same banner ("ended with 2026 Q3") | 2026-09-22 | maintainerless (banner) |
| IPFS Check (not in the claim) | same banner | not fetched | maintainerless (banner) |
| Helia | **no maintenance banner** (README 11,965 bytes, no hit for maintain/Shipyard/Foundation) | 2026-09-29; npm `helia`, `@helia/dnslink`, `@helia/http`, `@helia/car` last published 2026-09-29 (`@helia/verified-fetch` 2026-09-22) | covered only by Shipyard's post; not confirmed by the repo |
| **Service Worker Gateway** | "**@nymd and @byo maintain it now, on behalf of the IPFS Foundation**, as noted here" | **2026-10-15** (release 3.5.1; also commits by `TakGN` on 2026-10-06 and 2026-10-15) | **REFUTED: has named maintainers** |

- The SW Gateway statement is in the repository's own `README.md` (a source the claim itself cites) and rests on issue #1197, comment by `mishmosh` created 2026-09-22T14:29:00Z: "Hi all, @nymd and @byo will be maintainers for this repo going forward. They'll catch up on this thread and sync with @achingbrain if there are any questions before releasing." An earlier comment the same day by `achingbrain` says the Cloudflare account is "being migrated out of Shipyard control and to the IPFS Foundation".
- No commit after 2026-09-30 appears in the newest-first feed of Kubo, Boxo, Rainbow, IPFS Desktop, IPFS Companion, Someguy or Helia. npm `kubo` latest 0.43.1 (2026-09-15); `@helia/verified-fetch` 8.1.2 (2026-09-22).
- The IPFS blog post "IPFS is moving beyond the sponsored gateways" (dated 2026-08-25; page modified 2026-10-14) does NOT itself say funding was not renewed. It announces redirects of ipfs.io/dweb.link to the Service Worker Gateway and "changing how core IPFS maintainership is organized ... specs, conformance tests, implementation diversity, grants to maintainers and builders". The non-renewal statement is only in Shipyard's post, so cite that one for it.

**Qualifications:** "DNSLink has no steward" is an inference. The spec site is read-only and its own FAQ says no RFC exists, but implementations persist (Helia `@helia/dnslink` 2.0.2 and Boxo both still implement it), so the format has users and no owner. The Shipyard post and READMEs are the maintainers' own statements; I did not verify activity inside the IPFS Foundation or Protocol Labs.

---

## Claim 6 - the BEP process is dormant

**Claim (abridged):** the bittorrent.org repository's newest commit is 2020-05-01, the highest BEP is 55 (created 2018-12-29); BEP 44, 46, 47, 49, 52, 53 are Draft; BEP 9, 10, 19, 55 are Accepted; BEP 3 is Final.

**Verdict: nuanced.** Every date and status holds; the word "dormant" needs a qualifier because submissions continue while merging does not.

**Confirmed (raw `.rst` headers, BEP index, Atom feed):**
- `bittorrent/bittorrent.org` `master` Atom feed: newest entry 2020-05-01T21:48:22Z "Merge pull request #101 from arvidn/update-announce-logic-bep-7"; 608 commits total.
- `:Status:` headers: BEP 3 **Final**; BEP 9, 10, 19, 55 **Accepted**; BEP 44, 46, 47, 49, 52, 53 **Draft**. BEP 55 `:Created: 29-Dec-2018`. (BEP 44 created 19-Dec-2014, BEP 46 24-Jul-2016, BEP 52 10-Jan-2008, BEP 53 24-May-2017.) The index page `bep_0000.html` groups the same way (Final and Active Process: 0-4, 20, 1000; Accepted: 5, 6, 9, 10, 11, 12, 14, 15, 19, 23, 27, 29, 55; Draft: 7, 16, 17, 21, 24, 30-36, 38-54; Deferred: 8, 18, 22, 26, 28; Withdrawn and Rejected: none).
- The `beps/` directory holds 56 numbered `.rst` files; the numbers end at 55 plus **BEP 1000**.

**Qualifications:**
1. **"Highest BEP is 55" excludes BEP 1000**, a Process BEP ("Pending Standards Track Documents", Status Active) that lists BEP 13 as awaiting a formal document. Write "highest standards-track BEP".
2. **Dormant means no merges, not no proposals.** Open: 65 issues and 22 PRs. Embedded page data shows issues/PRs updated as late as 2026-09-04 and created as late as 2026-07-12, for example #179 "add BEP for already wildly implemented MSE, suggest, protocol AES" (2026-07-12), #178 "[Proposal] DHT Hole Punching Extension Protocol" (2026-03-10), #176 "draft BEP: Want Bitfields of Leech-Only Clients", #174 "draft proposal for announcing signed peers" (updated 2026-09-04), and **PR #171 "draft BEP: Magnet-URI Webseeding"** (OPEN, created 2025-04-20, updated 2026-02-18). None is merged. The bittorrent.org site itself answers with `Last-Modified: Wed, 22 Jan 2025 22:15:00 GMT`, so it was redeployed after the last repo commit, but the index content is the same.
3. **PR #171 matters to magnet-web.** The added file `beps/bep_draft.rst` (status Draft, "Work in Progress", header `:Created: 02-Mar-2012`, linking a wiki.theory.org discussion page) "formalize[s] the "ws" parameter" and "adds additional interpretations of the "ws", "as" and "xs" parameters", with a new `cas` parameter, and describes fetching metadata from a webseed. That is the closest thing to a standard for the `ws=`/`xs=` pair magnet-web depends on. Track it; do not assume the BEP editors will act.

**Residual uncertainty:** whether any maintainer still has merge rights and is simply inactive was not checked.

---

## Claim 7 - webtorrent 3.0.21, `xs=` behaviour, magnet-uri 7.0.10

**Claim (abridged):** webtorrent 3.0.21 (published 2026-07-27, maintenance mode) implements BEP 9/10/19/53 in the browser; its source fetches an http(s) `xs=` `.torrent` and discards it unless the infohash matches; magnet-uri 7.0.10 parses `xs=urn:btpk` and `xt=urn:btmh`; BEP 44, 46 and 52 are not implemented (webtorrent#886, #1117).

**Verdict: confirmed.** One wording caveat ("maintenance mode") and one scope caveat (BEP 44 in Node).

**Verified:**
- npm registry: `webtorrent` `dist-tags.latest` = **3.0.21**, published **2026-07-27T21:32:33.508Z**, registry `modified` 2026-07-27T21:32:33.830Z (still the latest on 2026-10-17); not deprecated; `engines.node >=22`; ESM. Versions 3.0.17 to 3.0.21 were all published on 2026-07-27. `magnet-uri` 7.0.10 published 2026-07-26T17:58:14Z; `parse-torrent` 11.0.24 (2026-07-26); `create-torrent` 6.1.3 (2026-07-23); `bittorrent-tracker` 11.2.3 (2026-05-25).
- Local install: `node_modules/webtorrent/package.json` version 3.0.21; `node_modules/magnet-uri` 7.0.10.
- Upstream `docs/bep_support.md` (master), browser column: BEP 6, **9 ("Magnet links")**, **10**, **19**, 27, 48, **53** implemented; BEP 5 and PEX (BEP 11, webtorrent#1191) not implemented; **BEP 44** not implemented (no issue link); **BEP 46** not implemented (#886); **BEP 52** not implemented (#1117); BEP 14, 15, 29 marked "cannot be implemented" in the browser.
- `lib/torrent.js`: `_onListening()` calls `this._getMetadataFromServer()` when `this.xs` is set and no full metadata is present. `_getMetadataFromServer()` accepts only `http://` or `https://` URLs (else `skipping non-http xs param`), does a `fetch` GET, warns on non-200, parses with `parseTorrent`, and then `if (parsedTorrent.infoHash !== self.infoHash) { self.emit('warning', new Error('got torrent file with incorrect info hash from xs param: ...')); return cb(null) }`; otherwise `self._onMetadata(parsedTorrent)`. `so` handling carries the comment "Select only specified files (BEP53)". A `urn:btpk:` `xs` therefore only produces the non-http warning; BEP 46 resolution does not happen.
- `magnet-uri/index.js`: `urn:btih:` (40 hex or 32 base32), `/^urn:btmh:1220(.{64})/` into `infoHashV2`, `xs` matching `/^urn:btpk:(.{64})/` into `publicKey`; `so` parsed with `bep53-range`.
- Issues (GitHub pages): #886 "Mutable torrents (BEP46)" OPEN, created 2016-08-17, last update 2023-06-25, 45 comments; #1117 "BitTorrent v2: Transition to a new hash function, info structure and merkle trees" OPEN, created 2017-04-26, last update 2025-05-27; #1191 "PEX over WebRTC in browser" OPEN.

**Caveats:**
1. **"Maintenance mode" is an inference, not a project statement.** The README has no maintenance, deprecation or unmaintained wording. Support for the inference: the newest 20 `master` commits (2026-07-27 to 2026-10-15) are renovate dependency bumps and semantic-release commits plus one human docs edit (2026-09-13 "Update FAQ to reflect new P2P service"). Say "dependency-bump cadence only".
2. **BEP 44 and the issue numbers.** #886 is BEP 46 and #1117 is BEP 52 only; BEP 44 has no tracking issue in `bep_support.md`. WebTorrent proper does not expose BEP 44, but `webtorrent` 3.0.21 depends on `bittorrent-dht ^11.0.12` (latest 11.0.12, 2026-05-25), whose README says it "supports BEP44 for storing arbitrary data in the DHT". The webtorrent `browser` field maps `bittorrent-dht` and `ut_pex` to `false`, so browsers have no DHT or PEX at all. For the Node-side `publish.mjs` this means a BEP 44 implementation already exists in the dependency tree (not evaluated further here; BEP 44 needs Ed25519 while v0.2 owner keys are P-256).
3. A non-matching `xs` torrent is dropped with a `warning` event, not an error; the client then continues with trackers and `ut_metadata`.

**Residual uncertainty:** browser behaviour was read from source and the upstream table, not exercised in a live browser in this pass.

---

## Claim 8 - Web Packaging "is a dead end"

**Claim (abridged):** the IETF WPACK WG concluded (2023-02-02); `draft-ietf-wpack-bundled-responses` last revised -01 (2021-12-25); Chrome removed Web Bundles navigation in February 2023; WICG Bundle preloading's last commit is 2023-02-14; the Google Search signed-exchange doc URL now 301-redirects to a 2026-07-01 AMP documentation note; IANA has no `application/webbundle` or signed-exchange media type.

**Verdict: nuanced.** All dated sub-facts hold. The headline "dead end" is true for standards and web-facing use but overstated for the Web Bundle format as a whole.

**Confirmed:**
- Datatracker group `wpack` ("Web Packaging"): state `conclude`, record time 2023-02-02T17:52:10Z; the group history page lists "2023-02-02 Cindy Morgan: State changed to Concluded from Active" and "2023-02-02 Francesca Palombini: Requested closing group".
- `draft-ietf-wpack-bundled-responses` ("Web Bundles"): rev **01**, time **2021-12-25T08:36:37Z**, expires 2021-12-26T01:25:22Z, states Expired, I-D Exists, WG Document, no RFC. `draft-ietf-wpack-use-cases` rev 00 (2022-04-28), also expired.
- Chrome "Get started with Web Bundles": "Warning: The experimental implementation of navigation to Web Bundles was removed from Chrome in February 2023." Also "currently only supported in Chromium-based browsers behind an experimental flag" (page header Last-Modified 2019-11-11).
- `WICG/resource-bundles` answers a redirect to `WICG/bundle-preloading`; newest `main` commit **2023-02-14T03:09:54Z** (byung-woo). Its README: "Bundle preloading ... efficient preloading of multiple resources using bundled HTTP responses in the Web Bundles format".
- `https://developers.google.com/search/docs/appearance/signed-exchange` returns HTTP 301 with `location: /search/updates#updating-amp-documentation`. The Search updates entry "July 1 Updating our AMP documentation": "Simplified our AMP documentation by removing outdated references to the AMP viewer, AMP Cache, and signed exchange ... Google Search ... will now take users directly to the publisher's AMP host pages ... they no longer need to update the AMP cache or configure signed exchanges." It sits directly above the "June 2026" group, which is how the year (2026) is established.
- IANA `application.csv` (1,812 data rows, Last-Modified Tue 2026-10-13 20:07:00 GMT): no name containing `webbundle`, `signed-exchange`, `wbn`, `sxg` or `web-package`; the only "bundle"/"exchange" matches are unrelated vendor types. (It does contain `application/vnd.ipfs.ipns-record`, `application/dns-message`, `application/dns+json`.)

**Correction ("dead end" is too strong):**
- Dead: the IETF track (`wpack-wg/bundled-responses` newest commit 2021-09-22, 17 commits; npm `wbn` 0.0.9 on 2023-03-23, "defined in draft-ietf-wpack-bundled-responses-01"), navigation and preloading, and Google Search's use of signed exchanges.
- Alive: `WICG/webpackage` `main` has commits on **2026-10-14 and 2026-10-15** (`zgroza`: "fix(wbn-sign): request SHA-256 explicitly for ECDSA P-256 signatures", dependency bumps); npm `wbn-sign` **0.3.3 published 2026-10-15T12:14:18Z** ("Tool to sign web bundles and manage signatures of signed web bundles"; 12 versions, previous 0.3.1 on 2026-04-20). Chrome's Isolated Web Apps documentation (Last updated 2026-02-06 UTC) still packages apps as signed web bundles with "Ed25519 or ECDSA P-256" keys, and says IWAs "will only be available to Chrome Enterprise administered ChromeOS devices and select development partners". `WICG/isolated-web-apps` newest commit 2025-02-19.
- Suggested wording: "Web Bundles and Signed Exchanges are not a foundation for ordinary-browser site delivery; the format survives only as the signed container for Chrome Isolated Web Apps, with active signing tools."

**Residual uncertainty:** Chrome's IWA roadmap beyond the 2026-02-06 doc, and any non-Chromium implementation, were not checked.

---

## Edits this pass implies for `w2c-06-standards-and-ecosystem.md` (not applied here)

1. Summary item 2 and F2: "69 records" becomes "72 records (60 distinct node names, 17 TXT rows)". Note that `_x402` is registered against draft revision -01 while the draft is now -03, and that "stable resolution" is read loosely (I-D revision, vendor URL).
2. Appendix B: add that wave-1 `05-doh-dns-txt.md` ("69 entries, 16 of type TXT") and this doc's "69" both disagree with the saved IANA CSV and XML (72 rows; the 2026-10-17 snapshots are byte-identical to the original researcher's own copy).
3. F4 / Summary item 4: add the RFC 10023 row (version tag first, case-sensitive, one tag-value pair per record, exactly one character-string, which conflicts with the 2-string reality of a 480-byte pointer). Describe draft -13 as a domain-verification draft: metadata SHOULD be space-separated, token first when metadata is present, DNSSEC signing a SHOULD, keys case-insensitive, concatenation MUST. State v0.2's deviations precisely (lowercased keys; repeatable `tr/ws/xs` and unknown keys; unknown keys signed), and that duplicates of the 13 single-valued keys are rejected as in DKIM.
4. F7: add that `@helia/dnslink` has a public `namespaces` option (so "skips unknown namespaces" is the default only), that Boxo filters to `/ipfs` and `/ipns`, and rephrase "no known consumer" as "no consumer found in the sources checked".
5. F8: remove the Service Worker Gateway from the "no dedicated maintainer" list (README names `@nymd` and `@byo` for the IPFS Foundation since 2026-09-22; commits through 2026-10-15). Helia has no banner. The seven others (Kubo, Boxo, Rainbow, IPFS Desktop, IPFS Companion, Someguy, IPFS Check) do. Cite Shipyard's post, not the IPFS blog, for the non-renewal. Separate the unscoped npm `dnslink` (2019) from `@dnslink/js` (2022-06-03).
6. F10: add the open community drafts (PR #171 Magnet-URI Webseeding and others), BEP 1000, and "no merges since 2020-05-01" in place of an unqualified "dormant".
7. F11: describe "maintenance mode" as an inference from dependency-bump commits; note `bittorrent-dht` 11.0.12 (BEP 44) is a Node-side dependency; #886 is BEP 46 only.
8. F15 / Summary item 7: replace "dead end" with "not a foundation for ordinary-browser delivery; alive only as the Isolated Web Apps signed container"; add `WICG/webpackage` commits through 2026-10-15 and `wbn-sign` 0.3.3 (2026-10-15).

## Not verified in this pass

- Ecosystem-wide absences (no consumer of `dnslink=/btih/`, no other DNSLink steward, no IETF draft for DNSLink): the web search needed was unavailable; only the sources named above were checked.
- How the IANA experts decide in practice, and turnaround time.
- Whether the registry held 69 entries on 2026-10-14 (the 2026-10-13 CSV timestamp suggests 72).
- Activity inside the IPFS Foundation or Protocol Labs; whether Helia has maintainers despite the missing banner.
- Whether any BitTorrent.org editor still has merge rights.
- WebTorrent behaviour in a live browser (source and upstream table only).
- IWA roadmap beyond the 2026-02-06 Chrome doc.

## Evidence snapshots (SHA-256) for reproduction

Fetched 2026-10-17 21:45 to 21:47 UTC into `/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/v06/` (session scratchpad; may not persist). Byte-identical to the original researcher's copies under `.../scratchpad/w2c06/dl/iana/`.

| File | SHA-256 |
|---|---|
| `iana-csv/underscored.csv` (72 rows) | `21d84657bb701797ac4c4961591e3c372fea0ec720cdbd18818303a2c376a6d1` |
| `iana-xml/dns-parameters.xml` (`<updated>2026-10-16`) | `8cf6389cfb7040b3a325f54975dcf7630bc5d749f251482056706520cd785093` |
| `iana-xhtml/dns-parameters.xhtml` | `fcc34e358993702b877dffd7b5f55ad62082efd04e5f0d2bd2202d0cc58fd008` |
| `iana-media/application.csv` (1,812 rows) | `15e2989e3948846d0897f564c5ec997bfd375ee75c0e10023d11ebed234e5012` |

## Sources actually read (all fetched 2026-10-17)

**Standards and registries:** https://www.rfc-editor.org/rfc/rfc8552.txt ; https://www.rfc-editor.org/rfc/rfc6376.txt ; https://www.rfc-editor.org/rfc/rfc7208.txt ; https://www.rfc-editor.org/rfc/rfc6763.txt ; https://www.rfc-editor.org/rfc/rfc10023.txt ; https://www.rfc-editor.org/rfc/rfc10023.json (and `rfc{8552,8553,6376,7208,6763,1464}.json`) ; https://www.iana.org/assignments/dns-parameters/dns-parameters.xml ; https://www.iana.org/assignments/dns-parameters/dns-parameters.xhtml ; https://www.iana.org/assignments/dns-parameters/underscored-globally-scoped-dns-node-names.csv ; https://www.iana.org/protocols/apply ; https://www.iana.org/form/protocol-assignment ; https://www.iana.org/assignments/media-types/application.csv ; https://www.ietf.org/archive/id/draft-ietf-dnsop-domain-verification-techniques-13.txt (and -14, -15: HTTP 404) ; https://datatracker.ietf.org/api/v1/doc/document/draft-ietf-dnsop-domain-verification-techniques/ ; https://datatracker.ietf.org/api/v1/doc/document/draft-hawkins-x402-dns-discovery/ ; https://nnu.us/specifications/nnu-domain-verification-1.0.txt ; datatracker WPACK: https://datatracker.ietf.org/api/v1/group/group/?acronym=wpack , https://datatracker.ietf.org/group/wpack/history/ , https://datatracker.ietf.org/api/v1/doc/document/draft-ietf-wpack-bundled-responses/ , https://datatracker.ietf.org/api/v1/doc/document/draft-ietf-wpack-use-cases/

**DNSLink and IPFS:** https://dnslink.dev/ ; https://github.com/dnslink-std ; https://github.com/dnslink-std/dnslink-website ; https://raw.githubusercontent.com/dnslink-std/community/main/README.md ; https://registry.npmjs.org/@dnslink%2fjs ; https://registry.npmjs.org/dnslink ; https://raw.githubusercontent.com/ipfs/helia/main/packages/dnslink/src/dnslink.ts (and `index.ts`, `README.md`, `package.json`, `namespaces/ipfs.ts`) ; https://raw.githubusercontent.com/ipfs/boxo/main/namesys/dns_resolver.go ; https://raw.githubusercontent.com/ipfs/ipfs-companion/main/add-on/src/lib/dnslink.js ; https://ipshipyard.com/blog/2026-the-end-of-ipfs-at-shipyard/ ; https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/ ; https://github.com/ipfs/{kubo,helia,boxo,rainbow,ipfs-desktop,ipfs-companion,someguy,service-worker-gateway,ipfs-check} (repo pages) and `https://github.com/ipfs/<repo>/commits/<branch>.atom` ; https://raw.githubusercontent.com/ipfs/service-worker-gateway/main/README.md ; https://github.com/ipfs/service-worker-gateway/issues/1197 ; npm registry for `helia`, `@helia/{dnslink,verified-fetch,car,http}`, `kubo`, `kubo-rpc-client`

**BitTorrent and WebTorrent:** https://www.bittorrent.org/beps/bep_0000.html ; https://raw.githubusercontent.com/bittorrent/bittorrent.org/master/beps/bep_{0003,0009,0010,0019,0044,0046,0047,0049,0052,0053,0055,1000}.rst ; https://github.com/bittorrent/bittorrent.org (repo, `/commits/master.atom`, `/issues`, `/tree/master/beps`, `/pull/171`, `/pull/171.diff`) ; https://raw.githubusercontent.com/webtorrent/webtorrent/master/docs/bep_support.md ; https://github.com/webtorrent/webtorrent (commits Atom, issues 886, 1117, 1191) ; npm registry for `webtorrent`, `magnet-uri`, `parse-torrent`, `create-torrent`, `bittorrent-tracker`, `bittorrent-dht` ; local `node_modules/webtorrent/{package.json,lib/torrent.js}` and `node_modules/magnet-uri/index.js`

**Web Packaging:** https://developer.chrome.com/docs/web-platform/web-bundles ; https://developer.chrome.com/docs/iwa/introduction ; https://developers.google.com/search/docs/appearance/signed-exchange (HTTP 301) and https://developers.google.com/search/updates ; https://github.com/WICG/{resource-bundles,bundle-preloading,webpackage,isolated-web-apps} and https://github.com/wpack-wg/bundled-responses (commit Atom feeds) ; https://raw.githubusercontent.com/WICG/resource-bundles/main/README.md ; npm registry for `wbn`, `wbn-sign`

**Project files:** `docs/ARCHITECTURE.md` (s4), `src/common/pointer.js`, `docs/research/05-doh-dns-txt.md`, `docs/research/w2c-06-standards-and-ecosystem.md`, and the original researcher's scratch notes and IANA snapshots at `.../scratchpad/w2c06/`.
