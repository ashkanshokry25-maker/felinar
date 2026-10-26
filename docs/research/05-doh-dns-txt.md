# 05 - DNS TXT publishing and DNS-over-HTTPS (JSON) from browsers

- Project: magnet-web (static loader, WebTorrent site delivery by magnet link, P2P log as DB)
- Topic: how a static page finds a site's magnet link in DNS and which DoH endpoints it can really call
- Research date: 2026-10-14 (all "today" statements below mean this date)
- Method: official docs and specs (read as raw text, not summaries, wherever possible) plus **direct measurement**: curl header probes, an RFC 8484 wire-format probe, and a real browser engine (headless Brave 155.1.97.56, Chromium 155, on a local origin) running `fetch()` against every endpoint, with a Chromium net-log to see which HTTP version was used. Test code and raw results are described in Appendix B.
- Confidence legend: **High** = measured today and/or two independent sources agree. **Medium** = one primary source, or behaviour observed today but undocumented by the provider. **Low** = inference, single secondary source, or not verified.
- Source IDs like [S1] are listed with URL and date in Appendix C. Anything older than 2024 is flagged "(OLD)".

---

## Summary

1. **Reading a TXT record from page JavaScript works, but only through a short list of DoH servers.** Verified in a real Chromium engine today. Servers that send `Access-Control-Allow-Origin` and are usable: **Cloudflare** (JSON + wire), **Google** (JSON + wire GET), **dns.sb** (JSON + wire), plus AliDNS (JSON, but it never sets the DNSSEC AD flag), Control D and DNS4EU (wire format only).
2. **Quad9, NextDNS, AdGuard, Mullvad and OpenDNS cannot be called from page JS today.** NextDNS, AdGuard, Mullvad and OpenDNS send no CORS headers at all. Quad9 retired its JSON API on 2025-05-05, and its HTTP/3 front end (enabled 2026-03-31) sends no CORS headers, so Chromium fails every Quad9 hostname request (it learns HTTP/3 from Quad9's HTTPS DNS record). This is my own measurement; no other source mentions it. Design-critical if Quad9 was the "privacy-friendly" pick.
3. **The two JSON dialects differ in TXT quoting.** Cloudflare returns RFC 1035 presentation format (`"part1" "part2"`, each string quoted, split mid-token at 255 bytes). Google and dns.sb return the strings already concatenated, unquoted. Google's own docs show the quoted form, but the live API does not (docs dated 2024-09-03 are stale). A 25-line normaliser fixes this; I verified it gives byte-identical TXT sets across 5 retrieval paths (3 JSON, 2 wire) for 8 names, in a browser.
4. **Request-shape traps (design-critical):** Cloudflare JSON requires `Accept: application/dns-json` (the `ct=` parameter is Google-only and gives HTTP 400 on Cloudflare). Google answers CORS preflights without `Access-Control-Allow-Origin`, so any extra request header (or an RFC 8484 POST) fails. Send only `Accept`, as GET.
5. **DNSSEC:** every JSON API exposes the validation result as the `AD` flag (no `do` parameter needed). `AD:true` only appears for signed zones, and only about 4-5% of .com domains are signed (2023-24 figures), so DNSSEC cannot be a requirement for typical sites. A bogus-signature domain returns `Status:2` (SERVFAIL); never send `cd=1`. No maintained browser-capable DNSSEC validation library exists that I could find.
6. **Rate limits / terms:** Cloudflare documents no numeric limit, no SLA, "limited" support and refers to its general terms. Google documents about 1,500 QPS per IPv4 address (or IPv6 /64), no SLA, and applies the Google APIs Terms of Service. Neither forbids embedding in a web app, but neither promises anything. Use at least two providers.
7. **Privacy:** the DoH provider learns the visited hostname and the visitor's IP. Google additionally forwards the visitor's /24 to the site's authoritative DNS servers by default (measured); `edns_client_subnet=0.0.0.0/0` stops that. Cloudflare and dns.sb do not forward it.
8. **Precedents exist, no standard does.** Closest: `anacrolix/btlink` (`_btlink.<domain>` TXT containing a magnet link, still receiving commits as of 2026-09-08), Dat DEP-0005 (`datkey=` TXT + `.well-known`, 2018 draft, resolved over Google/Cloudflare DoH), and DNSLink (`_dnslink.<domain>` TXT `dnslink=/<namespace>/<id>`, namespace-extensible). BEP 34 is the only DNS-related BEP and concerns tracker ports only. `_magnet`, `_btlink`, `_dnslink` and `_atproto` are all **unregistered** in the IANA underscored-names registry (policy: Expert Review, bar is low; `_x402` was registered 2026-08-11 on an Internet-Draft).
9. **Record format recommendation:** `_magnet.<exact-host> TXT "magnet:?xt=urn:btih:<40 hex>&dn=...&tr=wss%3A%2F%2F..."`, ASCII only, percent-encoded trackers, one string of at most 255 bytes. 3 trackers + `dn` = 191 B (fits). A hybrid v1+v2 magnet with 3 trackers = 257 B (does not fit: needs two strings).
10. **Publishing:** TXT works everywhere (Route 53, Cloudflare, Namecheap, Porkbun). Route 53 has no URI record type; TXT is the only portable choice. Quoting differs: Route 53 console/API need explicit `"..."`, the Terraform AWS provider adds quotes itself (verified in source), Cloudflare adds quotes for you. Minimum TTL: Cloudflare 60 s (30 s Enterprise), Porkbun typically 600 s.
11. **First-load cost:** one extra DoH round trip, measured at 100-460 ms cold and 2-20 ms warm from one vantage point (Cloudflare colo YYZ). Cache the answer (TTL-aware) and run it in parallel with fetching the torrent client bundle.
12. **Blocked-DoH fallback is needed:** enterprise firewalls block known DoH hostnames/IPs by practice (Infoblox, Cisco Umbrella guidance). Provide `.well-known` / URL-fragment fallbacks.

---

## Findings

### F1. Which DoH endpoints a browser page can actually call (CORS matrix)

**Claim:** Only providers that return `Access-Control-Allow-Origin` on a GET with an `Origin` header are usable from page JS. Measured 2026-10-14 with (a) curl `--http2` + `Origin` header on every endpoint and (b) real `fetch()` calls from `http://127.0.0.1:<port>` in Brave 155 (Chromium 155) for the main ones. The browser result is the authoritative column.

| Provider | Copy-paste endpoint | JSON API | RFC 8484 GET | ACAO on GET (curl) | Real browser `fetch` (Brave 155) | Notes |
|---|---|---|---|---|---|---|
| Cloudflare | `https://cloudflare-dns.com/dns-query?name=<fqdn>&type=TXT` + header `Accept: application/dns-json` | yes | yes | `*` (also on 400 errors) | JSON ok, wire GET ok, wire POST ok | Same schema as Google. Aliases with identical behaviour in curl: `https://1.1.1.1/dns-query`, `https://one.one.one.one/dns-query`, `mozilla.`/`security.`/`family.cloudflare-dns.com`. In browser: cloudflare-dns.com, 1.1.1.1, mozilla.cloudflare-dns.com ok. Used over HTTP/3 (QUIC) by Brave with CORS intact. |
| Google | `https://dns.google/resolve?name=<fqdn>&type=TXT` (JSON, GET only); `https://dns.google/dns-query?dns=<b64url>` (wire) | yes | yes | `*` on GET; **OPTIONS reply has no ACAO** | JSON ok (no header, `Accept`, `cache:'no-store'`, `referrerPolicy`, `credentials:'omit'`); **custom header fails**; wire GET ok; **wire POST fails** | `https://8.8.8.8/resolve` also works (curl). Used over HTTP/3 by Brave, CORS intact. |
| dns.sb | `https://doh.sb/dns-query?name=<fqdn>&type=TXT` | yes (Google-like, `application/json; charset=UTF-8`) | yes | `*`; allows `GET, HEAD, OPTIONS, POST`, header `Content-Type` | JSON ok, wire GET ok, wire POST ok | Aliases `https://doh.dns.sb/dns-query`, `https://dns.sb/dns-query`. Answers SERVFAIL with **HTTP 503** (see F4). No ECS forwarding observed. |
| AliDNS | `https://dns.alidns.com/resolve?name=<fqdn>&type=TXT` | yes (`application/json`) | `/dns-query` has no ACAO | `*` on /resolve | JSON ok | `AD` is always false, even for signed zones (no validation signal). China-based operator. |
| Control D | `https://freedns.controld.com/p0?dns=<b64url>` (p1-p3 are filtered variants) | no (ignores `name`/`type`) | yes | `*`, `allow-headers: *` | wire GET ok (HTTP/3) | Free tier, no logging per vendor docs. |
| DNS4EU | `https://unfiltered.joindns4.eu/dns-query?dns=<b64url>` (`protective.` variant also ok) | no (400) | yes | `*` | wire GET ok | EU public resolver. Cold latency was highest (about 460 ms). |
| CleanBrowsing, Tiarap | `https://doh.cleanbrowsing.org/doh/security-filter/`, `https://doh.tiar.app/dns-query` | not tested | yes | `*` | **not browser-tested** | curl only. Filtered / small operators. |
| **Quad9** | `https://dns.quad9.net/dns-query` (+ dns9/10/11/12, `9.9.9.9`, `149.112.112.112`) | **no (retired 2025-05-05)** | yes, **HTTP/2+ only** (HTTP/1.1 disabled 2025-12-15) | `*` over HTTP/2; **no CORS headers over HTTP/3** | **hostname URLs fail every time**; IP-literal URLs: requests 1-2 ok, then fail (see below) | Do not use from page JS until Quad9 fixes HTTP/3 CORS. |
| NextDNS | `https://dns.nextdns.io/dns-query` | yes (`application/dns-json`, AD works) | yes | **none** (OPTIONS 405) | fails | Usable from servers only. |
| AdGuard | `https://dns.adguard-dns.com/dns-query` (wire); `/resolve` (undocumented JSON, `application/x-javascript`, quoted data, `AD:false`) | at `/resolve` only | yes | **none** (`/dns-query` rejects OPTIONS with 400; `/resolve` answers OPTIONS like a GET, still without CORS headers) | fails | Same for unfiltered/family variants. |
| Mullvad | `https://dns.mullvad.net/dns-query` (+ `base.`) | no | yes | **none** (OPTIONS 501) | fails | |
| OpenDNS | `https://doh.opendns.com/dns-query` | no | yes | **none** (OPTIONS 501) | fails | |
| DNSPod | `https://doh.pub/dns-query` | yes | yes (200) | **none** | fails | |
| Others with no ACAO (curl only) | CIRA, Wikimedia, Hurricane Electric, LibreDNS, Switch, Digitale Gesellschaft, Applied Privacy, UncensoredDNS, FFMUC, Yandex, Xfinity | - | yes | none | not tested | |

- **Confidence: High** for the table rows marked browser-tested (two methods agree). **Medium** for curl-only rows (not run in a browser).
- **Quad9 detail (design-critical, single-source measurement, High confidence in the observation, Low confidence it is permanent):** the Chromium net-log shows Brave resolved Quad9's HTTPS DNS record (`supported_protocol_alpns: h3,h2,http/1.1`), opened a QUIC session, and received `HTTP 200` with only `content-type` and `content-length` (no `access-control-allow-origin`, no `cache-control`). The same request over HTTP/2 (forced by curl, or by using the IP-literal URL before Chromium learns `alt-svc: h3`) carries `access-control-allow-origin: *`. In an 8-request sequence against `https://9.9.9.9/dns-query`, requests 1-2 succeeded and 3-8 failed. Cloudflare, Google, dns.sb and Control D were 8/8 and use QUIC in the same browser, so HTTP/3 itself is not the problem. Quad9 enabled DoH3/DoQ globally on 2026-03-31 [S10], which is the likely start date of the regression (exact date unverified). I found no other report of this. Firefox/Safari/mobile not tested.
- **Cloudflare detail:** Cloudflare's CORS preflight lets the browser send arbitrary extra headers and POST with `Content-Type: application/dns-message`; Google's does not. Do not generalise from Cloudflare to Google.
- **Sources:** local measurements (Appendix B); Cloudflare docs [S1] (2026-05-05); Google docs [S3] (2024-09-03); Quad9 [S8][S9][S10]; dns-query README warning that "not all endpoints send CORS headers" [S16].

### F2. The JSON format is a de-facto vendor schema, not a standard

**Claim:** "DoH JSON" is Google's schema, copied by Cloudflare, dns.sb, AliDNS, NextDNS, AdGuard. It has no RFC. Media type `application/dns-json` is **not** in the IANA application registry; the registered JSON type is `application/dns+json` (RFC 8427), which uses a different schema. Cloudflare's own docs say: "The DNS over HTTPS JSON format does not have a formal RFC, which means behavior might be different between providers... For critical use cases, it is recommended to use the DNS over HTTPS wireformat" [S1].

- **Confidence: High.** Sources: Cloudflare docs [S1] (2026-05-05); IANA media-types CSV fetched 2026-10-14 (`dns`=RFC 4027, `dns+json`=RFC 8427, `dns-message`=RFC 8484; no `dns-json`) [S14].
- Response shape (verified live on Cloudflare, Google, dns.sb):
  - `Status` (DNS RCODE: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, 5 REFUSED), `TC`, `RD`, `RA`, `AD`, `CD`.
  - `Question: [{name, type}]`, `Answer: [{name, type, TTL, data}]` (the key is **absent** when empty, not `[]`), `Authority: [...]` (SOA on NXDOMAIN/NODATA).
  - `Comment`: Cloudflare = array of Extended DNS Error strings (e.g. `"EDE(9): DNSKEY Missing no SEP matching the DS found for dnssec-failed.org."`), Google = string (`"DNSSEC validation failure. Check http://dnsviz.net/..."` or `"Response from <authoritative IP>."`), dns.sb = null.
  - Google only: top-level `edns_client_subnet`.
- Request parameters: Cloudflare supports `name`, `type`, `do`, `cd` (plus the required `Accept` header). Google supports `name`, `type`, `cd`, `ct`, `do`, `edns_client_subnet`, `random_padding`. `type` can be numeric (`16`) or text (`TXT`, case-insensitive): both verified on all three. (An old Helia bug with numeric `type=16` concerned `resolver.cloudflare-eth.com`, not `cloudflare-dns.com`; text is still the safer choice [S16].)
- `Question.name` / `Answer.name` differ: Cloudflare omits the trailing dot (`example.com`), Google adds it (`example.com.`). Case is preserved. Compare case-insensitively and strip one trailing dot.
- Typed records are rendered as presentation text (verified: HTTPS RR `1 . alpn=h3,h2 ipv4hint=...` on both) and, per Cloudflare, as hex for unknown types.

### F3. TXT quoting, multi-string records and how to reassemble them

**Claim:** A TXT RDATA is one or more `<character-string>`s, each at most 255 octets (one length byte) [S13: RFC 1035]. Consumers must join them with nothing in between: SPF says the record "MUST be treated as if those strings are concatenated together without adding spaces" (RFC 7208 sec 3.3) and DKIM says strings "MUST be concatenated together before use with no intervening whitespace" (RFC 6376 sec 3.6.2.2). The two JSON dialects render this differently. Measured on the same RRset (`github.com` TXT, one record split 255 + 65 bytes mid-token):

| Source | `data` field for a two-string record |
|---|---|
| `dig +short` / RFC 8484 wire | two strings: `"v=spf1 ... ip4:62.253.2" "27.114 ip4:166..."` |
| Cloudflare JSON | `"\"v=spf1 ... ip4:62.253.2\" \"27.114 ip4:166...\""` (each string quoted, one space between; single-string records are quoted too) |
| Google JSON | `v=spf1 ... ip4:62.253.227.114 ...` (already concatenated, no quotes) |
| dns.sb JSON | same as Google |
| AdGuard `/resolve` | same as Cloudflare |

- **Confidence: High.** Measured today on live records `github.com`, `_spf.facebook.com`, `s1024._domainkey.yahoo.com`; the browser test normalised all five paths to byte-identical sets (SHA-1 of the sorted set matched for all 8 names). Sources: local measurement; RFC 1035 sec 3.3.14, RFC 7208 sec 3.3, RFC 6376 [S13]; Route 53 docs [S24]; `@helia/dnslink` source (strips outer quotes only; works for DNSLink because CIDs fit one string) [S16].
- **Discrepancy:** Google's JSON documentation (last updated 2024-09-03) shows quoted data and `""`-joined multi-strings in its examples but also says "All TXT records are encoded as a single JSON string"; the live API follows the latter [S2]. Treat the docs as stale.
- **Reassembly algorithm (verified):** if `data` starts and ends with `"` and parses as a space-separated sequence of quoted strings (with `\"`, `\\` and `\DDD` decimal escapes), decode and join with **no separator**; otherwise use `data` unchanged. Never join with a space: the split points fall mid-token. Known ambiguity: a Google-style value that itself starts and ends with `"` is indistinguishable; irrelevant for magnet links (`magnet:?` prefix).
- Escapes for quote/backslash/non-printables in Google/dns.sb output were **not** verified (no live sample found). Magnet URIs built with percent-encoding contain only `[A-Za-z0-9:?=&%._~-]`, so none arise.
- Full code in Appendix A.

### F4. Error and edge-case semantics (what a parser must handle)

All verified live on Cloudflare and Google (dns.sb noted):

- **NXDOMAIN** (`nonexistent-zzz-98127.com`): `Status:3`, no `Answer`, SOA in `Authority`. HTTP 200.
- **NODATA** (name exists, no TXT, e.g. `ns3.cloudflare.com`): `Status:0`, no `Answer`, SOA in `Authority`. A zone hosted at some providers also answers `NOERROR/NODATA` for a nonexistent name under an existing zone (seen for `_magnet.<x>.example.com`, hosted on Cloudflare). Treat NXDOMAIN and NODATA identically as "no record".
- **CNAME chain** (`www.github.com`, `_dnslink.docs.ipfs.tech`): `Answer` contains the `type:5` CNAME first, then the target's `type:16` records whose `name` is the **CNAME target**, not the queried name. Filter on `type === 16` and do not require `name` to equal the query. One DoH call resolves the whole chain.
- **Dangling CNAME** (`_dnslink.libp2p.io`, the dnslink.dev tutorial example, currently points to a Fleek name with no TXT): `Status:0` with only the `type:5` record. Treat as "not found".
- **DNSSEC-bogus** (`dnssec-failed.org`): Cloudflare and Google `HTTP 200` + `Status:2` (SERVFAIL) + `Comment`; **dns.sb returns HTTP 503** with a JSON body `Status:2`. With `cd=1` both Cloudflare and Google return the unvalidated A record, so a loader must never set `cd`.
- HTTP statuses (Google docs [S3]): 200 for all DNS-level errors; 400 (bad parameters), 413/414/415, 429 (with `Retry-After`), 500, 501, 502. Cloudflare returns 400 with an empty body when the `Accept` header is wrong, and 400 + `{"error": "..."}` for bad parameters [S1]. Cloudflare sends ACAO on its 400s, so error bodies are readable.
- Name limits (Google docs [S2]): total length 1-253 after unescaping, labels 1-63. Prefixing `_magnet.` (8 chars) caps the host at **245 characters** (the atproto spec makes the same point for `_atproto.` [S23]).
- **Wildcards:** a wildcard TXT such as `*.example.com` can answer `_magnet.foo.example.com` with a record not meant for it [S13: RFC 8552 sec 1.4]. Validate the `magnet:?` prefix strictly.
- **Confidence: High** (live) except the dns.sb HTTP 503 on SERVFAIL, which is Medium (observed once, in the browser run; the earlier curl probe only showed the JSON body).

### F5. DNSSEC: what the JSON APIs expose and what that is worth

- **`AD` flag:** returned by Cloudflare, Google and dns.sb without any `do` parameter. Meaning (Cloudflare docs): "every record in the answer was verified with DNSSEC" [S1]. Measured: `cloudflare.com`, `example.com`, `ietf.org`, `_atproto.jay.bsky.team` -> `AD:true` on all three; `github.com`, `google.com`, `_dnslink.docs.ipfs.tech` -> `AD:false` on all three (and `_atproto.bsky.app` on Cloudflare and Google). A CNAME chain that leaves a signed zone yields `AD:false`.
- **Wire format differs:** a validating resolver only sets AD in a reply if the query had DO=1 or AD=1 [S13: RFC 6840 sec 5.8]. Measured on the signed zone `cloudflare.com`: `AD:0` with DO=0 and `AD:1` with DO=1 on Cloudflare, Google, dns.sb, Control D and DNS4EU (browser); Quad9 over HTTP/2 verified with DO=1 only (curl/Python). Set DO=1 in the EDNS0 OPT record.
- **Failure signalling:** bogus data -> `Status:2` + `Comment` (EDE code on Cloudflare, free text on Google). So "DNSSEC failed" is distinguishable on Cloudflare/Google, not on dns.sb.
- **Resolvers that do not validate:** AliDNS and AdGuard `/resolve` reported `AD:false` for signed zones. Quad9: strict DNSSEC validation on every endpoint from 2026-06-15 [S10].
- **How many sites benefit:** about 4-5% of .com domains are signed (APNIC 2023: under 4.5% of .com 2LDs; Verisign about 4.2% .com / 5.1% .net; SIDN 2024: about 5%) [S30] (2023-24 data, OLD for 2026). google.com, amazon.com and microsoft.com are unsigned (SIDN) and `google.com` measured `AD:false`.
- **Client-side validation:** the only maintained JS validator I found, `@relaycorp/dnssec` (latest 1.12.1, 2025-04-05), is documented as a Node.js library (`engines.node >=16`, no browser field) [S33]. WebCrypto in current browsers includes Ed25519 (Chrome 137, Firefox 129, Safari 17 per MDN BCD 8.1.5 [S27]), so a custom validator is possible but would be a project of its own. I did not find a browser-ready one (one library inspected, plus searches): **Low-Medium confidence** that none exists.
- **Design consequence:** `AD` from a DoH provider protects against on-path/cache-poisoning attackers *upstream of the provider*; it does not remove the provider as a trust root. Dat DEP-0005 reached the same conclusion in 2018: "DNS-over-HTTPS still requires trust in the provider" and DNSSEC "does not have the same level of support" [S20] (OLD).

### F6. Rate limits, terms of service, reliability promises

| Provider | Numeric limit | SLA / support | Terms that apply | Source |
|---|---|---|---|---|
| Cloudflare 1.1.1.1 | none documented anywhere I read (FAQ, ToU, docs) | "no service level agreements (SLAs) are provided"; "dedicated technical support is limited" | Cloudflare Website and Online Services Terms of Use; forbids use that could "damage, disable, overburden, disrupt or impair any Cloudflare servers or APIs" | [S7] (ToU page updated 2026-04-30) |
| Google Public DNS | about 1,500 QPS per IPv4 address (or IPv6 /64) default; short bursts allowed; HTTP 429 + `Retry-After` when exceeded | "free service with no SLA"; "configure alternative DNS resolvers" | Google APIs Terms of Service (Europe: Google Ireland Limited) | [S3][S4][S5] (all 2024-09-03) |
| dns.sb | not found | not found | "No Logging" policy page; terms page 404 at the URLs I tried | [S32] |
| Quad9 | not found | not found | free service run by a "Swiss-based, non-profit organization" (its docs home page) | [S8][S9] |
| AliDNS, Control D, DNS4EU | not found | not found | Control D: free resolvers have no logging or history | [S32] |

- **Confidence: High** for Cloudflare and Google rows; **Low** for the rest (absence of evidence).
- Implication: per-IP limits matter on carrier-grade NAT mobile networks where many visitors share one IPv4. One query per page load is far below 1,500 QPS per IP, but a viral site on a CG-NAT'd carrier is untested. Whether either provider objects to being embedded in a third-party site's client code at scale: **unknown** (not addressed in the terms I read).
- Reliability trend in the last 18 months (why resolvers must be a runtime-configurable list): Quad9 retired JSON (2025-05-05), disabled HTTP/1.1 (2025-12-15), enabled DoH3 (2026-03-31, breaking browser CORS as measured).

### F7. Maximum practical TXT length

- RFC 1035: each string 0-255 octets; RDLENGTH is 16-bit (so RDATA can reach 65,535 octets); UDP messages 512 octets without EDNS [S13].
- DNS Flag Day 2020: "An EDNS buffer size of 1232 bytes will avoid fragmentation on nearly all current networks" [S29]. Larger answers fall back to TCP at the recursive-to-authoritative hop; the browser-to-DoH hop is HTTPS and has no such limit (a 3,983-byte JSON answer for the 29-record apex of `cloudflare.com` came back intact).
- Provider limits: Route 53 value up to **4,000 characters**, strings of at most 255 each, written `"s1" "s2"` [S24]. Cloudflare API: strings over 255 bytes "are automatically split"; a total length limit is **not stated** in the docs I read [S25]. Namecheap and Porkbun limits: **not found**.
- Practical rule: keep the value in **one string of at most 255 bytes** and the whole RRset at that name under about 1,200 bytes. Size table for a 40-hex btih (computed, fake hash, example trackers):

| Magnet content | Bytes | One string? |
|---|---|---|
| `xt=urn:btih` only | 60 | yes |
| + `dn=example.com` | 75 | yes |
| + 1 wss tracker | 98 | yes |
| + 3 wss trackers | 176 | yes |
| + `dn` + 3 trackers | 191 | yes |
| btmh only (v2, `1220`+64 hex) | 88 | yes |
| hybrid btih + btmh | 141 | yes |
| hybrid + 3 trackers | **257** | **no (2 strings)** |
| hybrid + `dn` + 3 trackers | **272** | **no (2 strings)** |

  (Each percent-encoded tracker costs about 38 bytes for `wss://tracker.webtorrent.dev`.)
- Place the record on a dedicated label (`_magnet.`), not the apex: apex TXT sets are crowded (measured: `cloudflare.com` 29 TXT records, `amazon.com` 65, `microsoft.com` 60).
- **Confidence: High** (specs + computed).


### F8. DNSLink precedent and what IPFS tooling actually does

**Spec (dnslink.dev [S15], undated page, fetched 2026-10-14; Medium confidence because single site):**
- A DNSLink is a TXT record in RFC 1464 `key=value` form: `dnslink=/<namespace>/<identifier>`, e.g. `dnslink=/ipfs/bafybei...`.
- Records "MUST be specified on the `_dnslink` subdomain" (so CNAME delegation and sandboxed zones work).
- "Implementations should never error on invalid record. Simply ignore and move to the next one." Several records and several namespaces may coexist (`/ipfs/`, `/hyper/`, "etc."); sort lexicographically before evaluating because TXT order is not stable.
- CNAME delegation is "the suggested way"; the spec recommends a low TTL ("60 seconds or so") so a site can be updated at deploy time.
- Real records (queried today through both JSON APIs): `_dnslink.docs.ipfs.tech` -> CNAME `_dnslink.docs-ipfs-tech.dnslinks.ipshipyard.tech` -> TXT `dnslink=/ipfs/bafybeier6...` (TTL 300); `_dnslink.en.wikipedia-on-ipfs.org` direct TXT (TTL 3600); `_dnslink.libp2p.io` is a CNAME to `_dnslink.libp2p-io.on.fleek.co` which now has **no TXT** (the spec's own tutorial example is dead: a delegated name can rot).

**In-page implementations (the relevant precedent for a loader, High confidence: source read):**
- `@multiformats/dns` **1.0.15** (published 2026-06-25): default *browser* resolvers are exactly `dnsJsonOverHttps('https://cloudflare-dns.com/dns-query')` and `dnsJsonOverHttps('https://dns.google/resolve')`. It calls `fetch(url, { headers: { accept: 'application/dns-json' }, signal })` and nothing else, limits concurrency to 4 because "Browsers limit concurrent connections per host (~6)", and sends `type` as text. [S16]
- `@helia/dnslink` **2.0.2** (published 2026-07-03): queries `_dnslink.<domain>` TXT, sorts answers, strips one pair of outer quotes (`startsWith('"') && endsWith('"')`), requires the `dnslink=` prefix, **skips unknown namespaces** (logs and continues), has a recursion limit, caches by record TTL, and falls back to a CNAME query. [S16] A `dnslink=/btih/...` record would therefore be ignored by Helia, not break it.
- `@helia/service-worker-gateway` **3.5.0** README lists "DNSLink resolution via DNS-over-HTTPS (DoH)" as a feature of a Service-Worker-based gateway that verifies content in the user's browser. This is the production precedent for the whole shape: DNS TXT -> content address -> retrieval and verification in the page. [S18]

**Extension behaviour (IPFS Companion 3.4.0 [S17], source read):** it does not query DNS at all. It asks the local Kubo node: `POST <api>/api/v0/resolve?arg=/ipns/<fqdn>&recursive=false`. Results are cached in an LRU (max 1000 entries, 12-hour TTL; a TODO says to use the DNS TTL instead), lookups run in the background (4 concurrent), and the first visit to a DNSLink site is upgraded afterwards ("We never do a blocking lookup here, as MV3 cannot hold a request open"). Different constraints from a loader, which can show a loading state and block on the lookup.

**Do not depend on:** `dnslink-std/js` (the "reference implementation", archived by its owner 2026-07-31); the `dnslink` npm package (0.2.8, last published 2019, OLD); `dohjs` (0.3.3, 2022) and `dns-query` (0.11.2, 2022) are also stale [S28]. `@multiformats/dns` is maintained.

### F9. RFC 8552 underscored names and the IANA registry

- RFC 8552 (BCP 222, 2019): "If a public specification calls for use of an underscored node name, the global underscored node name ... MUST be entered into this registry." Registration policy: **Expert Review**; the expert only checks that "the details for creating the registry entry are sufficiently clear, precise, and complete" and that the (name, RR type) pair is unique. Experts listed today: Frederico A C Neves, Paul Wouters. [S13][S14]
- Registry state fetched 2026-10-14 (69 entries, 16 of type TXT). **Not registered:** `_dnslink`, `_atproto`, `_magnet`, `_btlink`, `_bittorrent`, `_torrent`, `_btih`, `_webtorrent`, `_ipfs`, `_dmarc`, `_dnsaddr`. **Registered TXT names:** `_acme-challenge`, `_domainkey`, `_mta-sts`, `_spf`, `_tcp`, `_udp`, `_tls`, `_vouch`, `_sztp`, `_er`, `_splitdns-challenge`, `_validation-contactemail/phone`, `_for-sale` (RFC 10023, 2026-02-09), `_x402` (**Internet-Draft** `draft-hawkins-x402-dns-discovery-01`, 2026-08-11), `_nnu-verification` (a URL as specification, 2026-08-28).
- Reading: ecosystem conventions that are widely deployed (DNSLink, atproto, DMARC) never registered. `_magnet` is not claimed by anyone in the registry, and I found no prior use besides btlink's `_btlink` (F10). Registering `TXT _magnet` would take a short public spec; recent entries show a draft or URL is accepted. **Confidence: High** (registry parsed from IANA XML; RFC text read).
- Wildcard caveat from the same RFC (sec 1.4): `*.example.com` can answer `_magnet.x.example.com`; also `label.*.example.com` is not a wildcard, so you cannot wildcard-publish per-subdomain magnets.

### F10. Prior art: magnet links / infohashes published in DNS

No BEP, RFC or Internet-Draft for "magnet link or infohash in a DNS record" was found (searches in several phrasings, the full BEP index, the IANA URI-scheme and underscored-name registries). What exists:

| Prior art | What it does | DNS shape | Date / status | Notes |
|---|---|---|---|---|
| **btlink** `anacrolix/btlink` [S19] | P2P web hosting on BitTorrent (Go, proxy/PAC + gateway). "Domains may link/alias into the `.{tld}` address scheme by use of a `_btlink` DNS record ... `_btlink.chromecast.link` TXT record. The `_btlink` record contains a magnet link (or just the btlink domain)". Regular magnets map to `{infohash}-ih.{tld}`; BEP 46 (`magnet:?xs=urn:btpk:...`) maps to `-pk.{tld}`. Cites DNSLink as inspiration. | TXT at `_btlink.<domain>` containing a magnet URI | README undated; commits from 2022-06-22; latest 2026-09-08 (Go CI, test port) and 2024-01-03; 95 commits, 59 stars | Closest match. Its own flow diagram marks parts of the DNS-link path as "not implemented yet"; whether `_btlink` lookups work today is **unverified**. Not in-browser. |
| **Dat DEP-0005** [S20] | Map a domain to a 64-hex key. Two methods: TXT `datkey=<64 hex>` (may match "anywhere in the TXT record", clarified 2019-09-01) and `/.well-known/dat` (`dat://<key>` + optional `TTL=`, default 3600). Resolution: cache -> TXT via DoH (named: Google, Cloudflare) -> HTTPS well-known. | TXT on the **bare** domain | Informative draft, 2018-04-27 (OLD) | Same architecture as ours (DoH from a client + HTTPS fallback). |
| **BEP 34** DNS Tracker Preferences [S21] | TXT record on a tracker's host: `BITTORRENT UDP:1337 TCP:80` declares tracker ports. | TXT on the tracker hostname | Draft, created 2012-07-26, last modified 2016-07-21 (OLD) | Only DNS-related BEP. About trackers, not content. Warns that "this could potentially allow ISPs to prevent trackers from operating by injecting entries into DNS records". |
| Alifrangis blog [S22] | Informal "magnet in TXT" schema: the magnet URI followed by extra fields such as `episode:s01e01` and `quality:1080p`, joined with the pipe character; long TTL (86400), split at 255, under 4,096 total. | TXT on a dedicated subdomain | 2024-11-21; author calls it "a bad Idea" | Not a standard. Confirms the idea recurs independently. |
| `magnet` URI scheme | IANA URI-scheme registry lists `magnet` as **Provisional** (contact Dave Thaler). `bittorrent:` and `btih:` are not registered. [S14] | - | fetched 2026-10-14 | |
| multicodec [S34] | Draft codecs `torrent-info` (0x7b), `torrent-file` (0x7c), `bittorrent-pieces-root` (0xb702). | - | draft | IPLD identifiers; no DNS use known. Interop with CIDs/DNSLink unexplored. |

**Related, non-BitTorrent designs worth copying (High confidence, read directly):**
- **atproto handles** [S23]: `_atproto.<handle>` TXT `did=did:plc:...` (RFC 1464 style), ignore records not starting with `did=`, **fail if several valid records disagree**, and a parallel `https://<handle>/.well-known/atproto-did` method; "ok to attempt both resolution methods in parallel, and to use the first successful result"; prefer DNS on conflict; "DNSSEC is not required"; handle limit 244 chars because of the 9-char prefix; DNS TTLs "probably too aggressive" as cache lifetimes. Deployed at very large scale.
- Typed record alternatives: HTTPS/SVCB RRs are returned as presentation text by both JSON APIs (verified: `1 . alpn=h3,h2 ipv4hint=...`), the URI RR (RFC 7553) fits "name -> URI" semantically and Cloudflare can host it, but **Route 53 supports no URI type** (its list: A AAAA CAA CNAME DS HTTPS MX NAPTR NS PTR SOA SPF SRV SSHFP SVCB TLSA TXT [S24]). TXT is the only record type every DNS host accepts. Not tested: whether JSON APIs render URI RRs usefully (no live sample).

### F11. Publishing the TXT record (syntax per provider)

Target record: name `_magnet.example.com`, type TXT, value = the magnet URI (percent-encoded trackers, ASCII only, so no characters needing zone-file escaping: no `"`, `\`, `;`, spaces or non-ASCII). I did **not** create any DNS records; syntax below is from provider docs/source, not from executing it.

| Provider | Console / UI | API / IaC | Quoting and splitting | TTL floor | Source |
|---|---|---|---|---|---|
| **AWS Route 53** | Name `_magnet`, Type TXT, Value `"magnet:?xt=..."` (must include the double quotes; several strings: `"a" "b"` on one line; several values: one per row) | `aws route53 change-resource-record-sets` with `"ResourceRecords":[{"Value":"\"magnet:?xt=...\""}]` (inner quotes escaped). **Terraform `aws_route53_record`: `records = ["magnet:?xt=..."]` without your own quotes** (provider source `flattenTxtEntry` wraps TXT/SPF values in `"..."`; to split use `\"\"` inside the string) | string max 255 chars, whole value max **4,000** chars; chars 0-32 and 127-255 need `\ddd` octal escapes; `"` needs `\"`; case preserved | no floor stated; docs advise starting at 300 | [S24] (docs undated; Terraform source main branch, fetched 2026-10-14) |
| **Cloudflare DNS** | Type TXT, Name `_magnet`, Content `magnet:?xt=...` (if saved without quotes, Cloudflare adds them; inconsistent quotes give a validation error) | `POST /zones/{zone_id}/dns_records` with `{"type":"TXT","name":"_magnet","content":"...","ttl":300}`; Terraform provider v5 `cloudflare_dns_record` | API doc: content must be quoted character strings of up to 255 bytes, longer strings "are automatically split"; a total-length cap is not stated in what I read | 60 s (30 s Enterprise); Auto = 300 s | [S25] (pages 2026) |
| **Namecheap** | Domain List -> Manage -> Advanced DNS -> Add new record -> TXT Record; Host `_magnet` (subdomain only, `@` for root); Value as-is | none checked | KB says nothing about quotes or length | TTL options not documented in the KB; KB says new host records "normally" take 30 minutes | [S26] (single source, summarised by WebFetch; **Low-Medium**) |
| **Porkbun** | DNS Records -> Add: Type TXT, Host `_magnet`, Answer, TTL | `POST /api/json/v3/dns/create/{domain}` `{"name":"_magnet","type":"TXT","content":"...","ttl":600}`; `name` is the subdomain without the domain | quoting/splitting not documented | "Minimum is determined by account settings (typically 600)" | [S26] (API reference v3.63) |

- Publisher checklist: lowercase 40-hex hash; ASCII; TTL 300 during active development; publish the TXT **before** the first visit (negative caching, F12); verify with `dig +short TXT _magnet.example.com @1.1.1.1` and with the JSON API.
- **Confidence:** High for Route 53 and Terraform (docs + source), Medium for Cloudflare, Low-Medium for Namecheap/Porkbun quoting (not documented).

### F12. TTL, caching layers and propagation

- Layers between a TXT edit and a visitor: authoritative DNS -> DoH provider cache (TTL) -> browser HTTP cache (RFC 8484 requires the DoH response's HTTP freshness to be <= the smallest answer TTL [S12]; observed `cache-control`: Google JSON `private, max-age=<ttl>`, Quad9 `max-age`, dns.sb `private, max-age=3600`, **Cloudflare JSON sends none**) -> the loader's own cache. Pass `cache:'no-store'` on the `fetch` to bypass the browser HTTP cache (verified: it does not cause a preflight on Cloudflare or Google in Chromium).
- **Negative caching:** a not-found answer is cached for min(SOA TTL, SOA MINIMUM) [S13: RFC 2308 sec 3 for the SOA rule, sec 5 for resolver caching]. Measured SOA TTLs in `Authority`: 300 s (`cloudflare.com`), 1,800 s (`example.com`), 900 s (`.com` NXDOMAIN). If any visitor (or a pre-flight check) queries before the record exists, resolvers may keep "no record" for that long.
- **Purge tools (manual web forms):** Cloudflare `https://one.one.one.one/purge-cache/` ("refresh 1.1.1.1's DNS cache for domain names", per record type); Google `https://dns.google/cache` (docs: flush both the registered domain and the exact name) [S7][S3]. Useful for publishers; not callable from the loader.
- Guidance from precedents: DNSLink recommends about 60 s [S15]; atproto says DNS TTLs are too short for cache lifetimes and clients should cache longer [S23]; IPFS Companion caches 12 h [S17]; Dat defaults to 3,600 s [S20].
- Expected worst-case staleness after an update = old TTL (positive) or negative TTL, plus the loader's cache. With TTL 300: about 5 minutes. With Porkbun's usual 600 s minimum: about 10 minutes.
- **Confidence: High.**

### F13. Privacy of the lookup

- **Who learns what:** the DoH provider learns the queried hostname and the visitor's IP (plus timing). The visitor's normal resolver has already seen the site's hostname when the loader was fetched, so the *hostname* is not new to *them*; but a JS-initiated DoH call discloses it to a **new third party** even if the user configured a different resolver. In hub mode it is also an arbitrary site the user chose to visit.
- **Provider retention (their statements):** Cloudflare: no source IP in non-volatile storage, logs deleted within 25 hours, anonymised query names shared with APNIC for research [S7]. Google: temporary logs with IP and query for 24-48 hours, permanent anonymised logs (domain, type, city/region level location) [S6]. dns.sb: "We do not log DNS queries" [S32]. Control D free resolvers: no logging or history [S32].
- **EDNS Client Subnet (measured 2026-10-14 with `o-o.myaddr.l.google.com` TXT):** Google's JSON API forwards the visitor's **/24** to authoritative servers by default (`edns0-client-subnet <a.b.c.0/24>` appeared in the answer); with `edns_client_subnet=0.0.0.0/0` it did not. Cloudflare sends no ECS (FAQ, and measured). dns.sb: none observed. [S2][S7] **High.** The site's DNS host (Route 53, Cloudflare...) would otherwise see the visitor's /24 on each uncached lookup.
- **Headers:** the default Referrer-Policy sends the loader's origin as `Referer`. Use `referrerPolicy:'no-referrer'` and `credentials:'omit'`; Google's DoH page itself recommends minimal headers [S3]. The verified fetch options (`cache:'no-store'`, `referrerPolicy`, `credentials:'omit'`, `Accept`) did not trigger a preflight on either Cloudflare or Google.
- Cache-timing: Google notes web apps could infer recently visited domains from DoH cache timing and suggests POST for sensitive apps [S3]; POST is not usable from a browser against Google (F1).

### F14. Browser and mobile compatibility of the lookup path

MDN browser-compat-data 8.1.5 (published 2026-10-08) [S27]; versions are first full support:

| API used | Chrome / Android | Edge | Firefox / Android | Safari / iOS | Samsung Internet |
|---|---|---|---|---|---|
| `fetch()` + `Response.json()` | 42 | 14 | 39 | 10.1 / 10.3 | 4.0 |
| `AbortController` | 66 | 16 | 57 | 12.1 / 12.2 | 9.0 |
| `AbortSignal.timeout()` | 103 (aborts with `AbortError` instead of `TimeoutError` until 124) | 103 (same caveat) | 100 | 16 / 16 | 20.0 (same caveat until 27.0) |
| `Promise.any` | 85 | 85 | 79 | 14 / 14 | 14.0 |
| `fetch` `cache`, `referrerPolicy` options | 64 / 52 | 14 | 48 / 47 | 10.1 / 10.1 | 9.0 / 7.2 |
| `TextDecoder` | 38 | 79 | 19 | 10.1 / 10.3 | 3.0 |
| `crypto.randomUUID` (not needed) | 92 | 92 | 95 | 15.4 | 16.0 |

- The lookup needs nothing newer than Safari 12.1 if `AbortController` + `setTimeout` is used instead of `AbortSignal.timeout()` (Appendix A does). No browser API gives page JS a raw DNS query, so DoH-by-`fetch` is the only route.
- **Tested engines:** Chromium 155 (Brave) only. **Not tested:** Safari/iOS, Firefox, Samsung Internet, Android Chrome. CORS and `fetch` semantics are standardised, but the Quad9-type failure depends on whether the engine picks HTTP/3 (via HTTPS RR or `alt-svc`) and on server behaviour; Safari and Firefox both use HTTPS RRs / `alt-svc` for HTTP/3 (not verified here). Treat the CORS matrix as Chromium-verified and re-run the same harness on the others before launch.
- CSP: the loader's `connect-src` must list every DoH origin it may call (e.g. `https://cloudflare-dns.com https://dns.google https://doh.sb`), and a Service Worker must let those requests pass through untouched.

### F15. Availability, blocking and drift

- Enterprise and school networks block known DoH hostnames and IPs by policy: Infoblox sells DoH domain/IP feeds; Cisco Umbrella documents blocking known DoH provider IPs and notes new providers evade category blocking [S31]. A Pi-hole thread reports collateral damage when blocking IPs shared with other sites. Expect some visitors to fail the lookup entirely.
- **Bootstrap:** the DoH hostname itself is resolved by the visitor's system resolver; if that resolver is filtered or poisoned, `cloudflare-dns.com` may not resolve. IP-literal URLs avoid this and work in the browser for Cloudflare (`https://1.1.1.1/dns-query`, JSON verified) and Google (`https://8.8.8.8/resolve`, JSON verified in curl). Quad9's IP literals worked only until HTTP/3 kicked in (F1).
- **Provider drift** is real (F6): behaviour changed three times within about 18 months for one provider (Quad9: JSON retirement announced 2024-11, HTTP/1.1 off 2025-12, DoH3 2026-03). Keep the resolver list and capability flags in data, not code, and add a scheduled canary that runs the F1 checks.
- Content blockers: no blocking of the four working providers was seen in Brave's default Shields (fresh profile); other blockers not tested.

### F16. Measured latency (one vantage point, treat as order of magnitude)

Vantage: one wired host served by Cloudflare colo YYZ; Brave 155 headless; `fetch` wall time per request:

| Provider | Cold (first request to that host: DNS + TLS/QUIC + query) | Warm |
|---|---|---|
| Cloudflare JSON | 109-137 ms | 2-16 ms |
| Google JSON | 104-239 ms | 2-19 ms |
| dns.sb JSON | 104-375 ms | - |
| AliDNS JSON | 333-346 ms | - |
| Control D (wire) | 124-135 ms | 5 ms |
| DNS4EU (wire) | 460 ms | 2 ms |

- The reference resolver (2-of-3 quorum, early exit at the second agreeing answer) took **356-360 ms** for its first, cold lookups and 13-206 ms for the following names. [S35]
- Not measured: mobile networks, other regions, Safari/Firefox. **Confidence: Medium.**

---

## Recommendations for our design

Ordered by impact. "Evidence" points at the finding that supports each.

1. **Record shape (F7, F9, F10, F11).** Publish one TXT record at `_magnet.<exact hostname>` whose value is a bare magnet URI: `magnet:?xt=urn:btih:<40 lowercase hex>[&xt=urn:btmh:1220<64 hex>][&dn=<name>][&tr=wss%3A%2F%2F...]`.
   - ASCII only, trackers percent-encoded (nothing needing zone-file escaping), **one string of at most 255 bytes**, TTL 300.
   - The leading `magnet:?` is the discriminator: it mirrors the `dnslink=` / `did=` "ignore anything else" rule and defeats wildcard-TXT collisions (RFC 8552 sec 1.4). No extra `magnet=` prefix needed.
   - Query the **exact** `location.hostname` only (no walking up the tree). `www.` vs apex is solved by the publisher with `_magnet.www.example.com CNAME _magnet.example.com` (one DoH call follows CNAMEs, F4).
   - Host length limit 245 characters.
   - Optional interop (not for v1): a copy at `_btlink.<host>` for btlink gateways [S19]; `dnslink=/btih/<hex>` at `_dnslink.<host>` is ignored by Helia but unregistered (F8).

2. **Resolver policy (F1, F4, F5).** JSON via **Cloudflare + Google (+ dns.sb as tie-breaker)** with a **2-of-3 quorum and early exit**; all as `GET` with only the `Accept: application/dns-json` header; Google with `edns_client_subnet=0.0.0.0/0`; never `cd=1`; `Status 3`/empty answer = not found; any other non-zero Status = error (do not fall through to a non-validating resolver); more than one *distinct valid* magnet from one resolver = conflict (RRset order is random, so "first wins" would make the site non-deterministic; atproto fails in the same situation [S23]).
   - Disclosure-minimising variant: ask Cloudflare and Google first; only call dns.sb if they disagree or one fails (the tested module queries all three at once; staging is a small wrapper change and was not separately tested).
   - Verified implementation: Appendix A (32/32 checks pass in Chromium 155).

3. **Keep an RFC 8484 wire-format path as the second implementation (F2, F5).** Cloudflare itself recommends wire format "for critical use cases" [S1]. About 45 lines (Appendix A.2) were validated: byte-identical to the JSON path on Cloudflare and Google, and parse-tested on dns.sb, Control D and DNS4EU. Use GET with `?dns=` (base64url, no padding, DNS ID 0) and set DO=1 to receive `AD`. CORS-capable wire endpoints: Cloudflare, Google (GET only), dns.sb, Control D, DNS4EU. Do **not** use POST (fails on Google, and Quad9).

4. **Do not use Quad9, NextDNS, AdGuard, Mullvad, OpenDNS or DNSPod from page JS (F1).** Re-test Quad9 on a schedule; if it regains HTTP/3 CORS it becomes a good third (Swiss non-profit per its docs [S9], DNSSEC-strict on every endpoint since 2026-06-15 [S10]).

5. **Plan for DoH being unavailable (F15).** In order: last-known-good cache entry (still valid or stale-but-flagged) -> same-origin `/.well-known/magnet` (plain text, same magnet URI; mirrors Dat/atproto; works when DoH hostnames are blocked, but it carries no trust beyond the loader's own origin, so show a "DNS unavailable, using site file" notice) -> `#magnet:` fragment (hub mode) -> user-configured resolver URL. Offer IP-literal DoH URLs (`https://1.1.1.1/dns-query`) as a bootstrap fallback when the hostnames do not resolve.

6. **Cache TTL-aware (F12).** Store `{host, magnet, ttl, fetchedAt, resolvers, adVotes}` in IndexedDB (localStorage is fine for a first cut; wrap in try/catch). Revalidate when `age > clamp(ttl, 30 s, 1 h)`; negative-cache "not found" for 30-60 s. Render from a fresh cache entry immediately and revalidate in the background; swap only if the quorum answer differs.

7. **Make the DNS answer visible (F5, F13).** Show "example.org -> btih 3a1b... (Cloudflare, Google agree; DNSSEC verified by 2 resolvers)" in a details panel. Do not run torrent-delivered site code until the quorum is met. Offer a "require DNSSEC" mode (AD from at least 2 resolvers); it only works for signed zones (about 4-5% of .com), so it cannot be the default.

8. **Latency (F16).** Fire the DoH lookups from an inline script at the very top of the loader, in parallel with loading the WebTorrent bundle; expect +100-400 ms cold, a few ms warm.

9. **CSP and Service Worker (F14).** `connect-src` must include `https://cloudflare-dns.com https://dns.google https://doh.sb` (plus tracker `wss:` origins). The Service Worker must not call `respondWith` for these requests and must not add headers. Never set `Cache-Control`/`X-*`/`Content-Type` as explicit request headers on DoH fetches (Google preflight, F1); the `fetch` option `cache:'no-store'` is fine (verified, no preflight).

10. **Privacy defaults (F13).** `referrerPolicy:'no-referrer'`, `credentials:'omit'`, Google ECS opt-out, a short privacy notice naming the resolvers, and a user-editable resolver list.

11. **Publisher experience (F11, F12).** Ship copy-paste snippets per provider (Route 53 console/CLI/Terraform without manual quotes, Cloudflare, Namecheap, Porkbun), a "check my record" page that runs the same quorum code and prints each resolver's raw answer and TTL, and one rule: **create the TXT before anyone visits** (negative caching). Recommend TTL 300 (60 where allowed) while iterating.

12. **Governance (F9, F10).** Write a one-page spec for `_magnet` (format, size rules, conflict rule, TTL advice) and request registration of `TXT _magnet` in the IANA underscored-names registry (Expert Review; `_x402` shows a draft suffices). Consider contacting the btlink author about aligning on one label before either project hardens.

13. **Testing before launch (F1, F14).** Re-run the Appendix B harness in Safari (macOS and iOS), Firefox, Chrome for Android and Samsung Internet, with HTTP/3 in play, and add a daily canary for the CORS/h3/JSON status of each configured endpoint.

14. **Updates without DNS churn (cross-topic, open).** If the design wants releases to propagate faster than DNS TTLs allow, put a signing key in the record's query string and carry signed releases over the P2P log; keep the parser tolerant of unknown `&key=value` pairs (the tested parser ignores them). This is for the identity/log researchers to decide; DNS only needs to supply the bootstrap magnet and, optionally, the key.

---

## Gotchas

1. **Cloudflare JSON needs `Accept: application/dns-json`.** Without it (or with `Accept: */*`) you get HTTP 400 and an empty body. `ct=application/dns-json` works only on Google and does nothing on Cloudflare.
2. **Google answers OPTIONS without CORS headers.** Any non-simple request (extra header such as `X-*` or `Cache-Control`, or `POST` with `Content-Type: application/dns-message`) fails with an opaque "Failed to fetch". `Accept`, `cache:'no-store'`, `referrerPolicy` and `credentials:'omit'` are fine.
3. **TXT `data` is quoted-and-split on Cloudflare, joined-and-unquoted on Google/dns.sb.** Never join strings with a space (splits fall mid-token). Google's docs show the old quoted form.
4. **`Answer` is missing, not empty, when there is nothing;** a CNAME answer comes first and TXT records carry the CNAME *target* as owner name; a dangling CNAME gives `Status:0` with only a type-5 record.
5. **Trailing dot and case:** Google appends `.` to names, Cloudflare does not; case is preserved. Compare normalised.
6. **dns.sb returns HTTP 503 for SERVFAIL** (Cloudflare/Google return 200 with `Status:2`). Read the JSON body regardless of `r.ok`.
7. **Quad9:** JSON gone since 2025-05-05; HTTP/1.1 off since 2025-12-15 (HTTP/2 required); its HTTP/3 path has no CORS headers (browsers pick HTTP/3 via the HTTPS DNS record or `alt-svc`, so failures can be intermittent: IP-literal URLs worked twice and then failed).
8. **Wire-format AD needs DO=1** (RFC 6840 sec 5.8); the JSON APIs set `AD` without it.
9. **Never send `cd=1`:** it disables validation and a bogus domain then returns data.
10. **AliDNS and AdGuard `/resolve` report `AD:false` for signed zones;** do not count them toward a "DNSSEC-verified" badge.
11. **Hybrid v1+v2 magnet with 3 trackers is 257 bytes:** two DNS strings. Route 53 console/API then need `"part1" "part2"`; Terraform AWS wants one HCL string with an escaped pair of quotes in the middle, `"part1\"\"part2"` (the provider adds the outer quotes, per its docs); Cloudflare splits automatically.
12. **Terraform AWS provider adds the surrounding quotes itself** (source: `flattenTxtEntry`). Adding your own produces a malformed TXT.
13. **Negative caching:** querying before publishing can pin "no record" for min(SOA TTL, SOA MINIMUM) (RFC 2308), measured SOA TTLs of 300-1,800 s.
14. **Wildcard TXT** (`*.example.com`) can answer `_magnet.x.example.com`; the strict `magnet:?` check is the defence.
15. **A delegated `_magnet` CNAME can rot** (the dnslink.dev tutorial's `_dnslink.libp2p.io` target has no TXT today). Treat CNAME-only answers as not found.
16. **`ws://` trackers are unusable from an `https://` page** (mixed content); the tested validator drops them.
17. **Enterprise networks block DoH** hostnames/IPs; the DoH hostname is itself resolved by the visitor's possibly filtered system DNS.
18. **Provider terms give no uptime promise** (Cloudflare: no SLA; Google: no SLA, about 1,500 QPS per IP, 429 with `Retry-After`). Carrier-grade NAT concentrates many mobile users on one IPv4 (untested).
19. **Google forwards the visitor's /24 as ECS by default;** opt out with `edns_client_subnet=0.0.0.0/0`.
20. **Stale libraries:** `dnslink` (2019), `dohjs` (2022), `dns-query` (2022) and the archived `dnslink-std/js` should not be adopted; `@multiformats/dns` and `dns-packet` are maintained.
21. **Early exit leaves slower requests running;** harmless, but pass a shared `AbortController` if you care about connection use (browsers cap about 6 connections per host).
22. **My tests were local-origin (`http://127.0.0.1`) in one Chromium engine.** CORS behaviour does not depend on the page being `https`, but nothing here is verified on Safari, Firefox or mobile.

---

## Open questions

1. **Safari (macOS/iOS), Firefox, Chrome Android, Samsung Internet:** does each pass the F1 matrix, and does any of them fail Quad9 differently? (Needs real devices or a hosted harness; not possible from this session.)
2. **Is Quad9's missing HTTP/3 CORS header intentional, and will it be fixed?** Worth a report to Quad9 support; no public mention found.
3. **Namecheap and Porkbun:** TXT quoting, maximum length, automatic splitting, and Namecheap TTL options are undocumented in what I could read.
4. **Cloudflare DNS:** total TXT length cap and dashboard behaviour for values over 255 bytes (API says strings are auto-split).
5. **Rate limits for dns.sb, Control D, DNS4EU, AliDNS and Cloudflare (numeric):** not documented in what I found. Does heavy use from a popular site's visitors risk blocks? Do terms allow embedding in third-party web apps at scale?
6. **Label choice:** `_magnet` vs `_btlink` vs `_dnslink`+`/btih/`. Is the btlink author (anacrolix) interested in aligning? Is `_btlink` lookup actually implemented in btlink today (the README flow marks parts as unimplemented)?
7. **Browser-side DNSSEC validation:** feasible with WebCrypto (Ed25519 shipped in Chrome 137, Firefox 129, Safari 17) but no maintained browser library was found; effort and value (4-5% of .com signed) unclear.
8. **Typed records:** can the JSON APIs return a URI RR usefully (no live sample found), and would any mainstream DNS host besides Cloudflare accept one? Route 53 does not.
9. **Cross-verification channel:** should the TXT also carry a public key so the P2P log can deliver signed updates faster than DNS TTLs (cross-topic with the identity and log researchers)?
10. **Quorum privacy trade-off:** is disclosing the hostname to two (or three) resolvers acceptable, versus a single resolver plus DNSSEC `AD`?
11. **Escaping in Google/dns.sb output** for quotes, backslashes and non-printable bytes in TXT: not verified (no live sample); irrelevant for percent-encoded magnet URIs.
12. **CG-NAT / mobile carrier behaviour** under Google's per-IP limit: untested.

---

## Appendix A - Reference code (executed and verified)

Both listings below are the exact files that were run in headless Brave 155 (Chromium 155): the module passed **32/32 checks** (7 live-DNS cases, 9 stubbed failure/conflict scenarios, 16 unit tests of the TXT normaliser and magnet validator). The wire helpers were validated by the 8-name byte-identity test against the JSON path (Cloudflare wire and Google wire), and parse-tested on dns.sb, Control D and DNS4EU. They are research code, not production code: add your own retries, abort-on-finish and telemetry.

### A.1 `doh-magnet.mjs` (JSON path, quorum, validator)

```js
// doh-magnet.mjs -- resolve _magnet.<host> TXT over DoH JSON with N-of-M quorum. ES2018, no dependencies.
export const RESOLVERS = [
  { id: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { id: 'google',     url: 'https://dns.google/resolve', params: { edns_client_subnet: '0.0.0.0/0' } }, // don't leak your /24 to authoritative servers
  { id: 'dns.sb',     url: 'https://doh.sb/dns-query' },
];

// Cloudflare/AdGuard: presentation format  "part1" "part2"  (RFC 1035 escapes)  ->  join WITHOUT separator
// Google/dns.sb: already joined, no quotes.  Anything that is not a clean sequence of quoted strings is returned as-is.
export function txtFromJsonData(data) {
  if (data.length < 2 || data[0] !== '"' || data[data.length - 1] !== '"') return data;
  const bytes = []; let i = 0; const n = data.length;
  while (i < n) {
    while (i < n && data[i] === ' ') i++;
    if (i >= n) break;
    if (data[i] !== '"') return data;
    i++;
    while (i < n && data[i] !== '"') {
      if (data[i] === '\\') {
        i++;
        if (/\d/.test(data[i]) && /\d/.test(data[i + 1] || '') && /\d/.test(data[i + 2] || '')) { bytes.push(parseInt(data.substr(i, 3), 10)); i += 3; }
        else { bytes.push(data.charCodeAt(i)); i++; }
      } else { bytes.push(data.charCodeAt(i)); i++; }
    }
    if (data[i] !== '"') return data;
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// One DoH JSON query. Only the CORS-safelisted Accept header is sent (Google answers OPTIONS without ACAO => any extra header breaks it).
export async function queryTxt(resolver, fqdn, { timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const u = new URL(resolver.url);
  u.searchParams.set('name', fqdn);
  u.searchParams.set('type', 'TXT');
  for (const [k, v] of Object.entries(resolver.params || {})) u.searchParams.set(k, v);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(u.toString(), { headers: { accept: 'application/dns-json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ac.signal });
    let j; try { j = await r.json(); } catch (e) { throw new Error(`${resolver.id}: HTTP ${r.status}, unreadable body`); }
    if (j.Status === 0) {
      const ans = (j.Answer || []).filter(a => a.type === 16);               // drop CNAME (type 5) and any DNSSEC records
      return { resolver: resolver.id, ad: j.AD === true, txt: ans.map(a => txtFromJsonData(a.data)), ttl: ans.length ? Math.min(...ans.map(a => a.TTL)) : null };
    }
    if (j.Status === 3) return { resolver: resolver.id, ad: false, txt: [], ttl: null };      // NXDOMAIN
    throw new Error(`${resolver.id}: DNS status ${j.Status}${r.ok ? '' : ' (HTTP ' + r.status + ')'}`); // 2=SERVFAIL (incl. DNSSEC bogus), 5=REFUSED...
  } finally { clearTimeout(timer); }
}

// Strict magnet validation. Publish 40-hex btih (and/or btmh); wss:// trackers only (https pages cannot open ws://).
export function parseMagnetTxt(text) {
  const s = text.trim();
  if (s.length > 1024 || !/^magnet:\?/i.test(s)) return null;
  const p = new URLSearchParams(s.slice(s.indexOf('?') + 1));
  let btih = null, btmh = null;
  for (const xt of p.getAll('xt')) {
    let m;
    if ((m = /^urn:btih:(.+)$/i.exec(xt))) { if (btih || !/^[0-9a-f]{40}$/i.test(m[1])) return null; btih = m[1].toLowerCase(); }
    else if ((m = /^urn:btmh:(.+)$/i.exec(xt))) { if (btmh || !/^1220[0-9a-f]{64}$/i.test(m[1])) return null; btmh = m[1].toLowerCase(); }
  }
  if (!btih && !btmh) return null;
  const trackers = [...new Set(p.getAll('tr').filter(t => /^wss:\/\/[^\s]+$/i.test(t)))];
  return { key: `${btih || ''}|${btmh || ''}`, btih, btmh, trackers, name: p.get('dn') };
}

// Generic quorum resolver: resolves as soon as `quorum` resolvers agree; rejects on conflict/no consensus. null = not found.
export function resolveTxtQuorum(fqdn, parse, { resolvers = RESOLVERS, quorum = 2, timeoutMs = 4000, fetchImpl } = {}) {
  return new Promise((resolve, reject) => {
    const total = resolvers.length;
    const votes = new Map();            // canonical key -> { n, ad, ttl, rec }
    let none = 0, done = 0, settled = false; const errors = [];
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const check = () => {
      if (settled) return;
      for (const v of votes.values()) if (v.n >= quorum) return finish(resolve, { ...v.rec, ttl: v.ttl, adVotes: v.ad, agreeing: v.n, of: total });
      if (none >= quorum) return finish(resolve, null);
      const best = Math.max(none, 0, ...[...votes.values()].map(v => v.n));
      if (best + (total - done) < quorum) finish(reject, new Error(`no ${quorum}-of-${total} consensus (distinct answers: ${votes.size}, not-found: ${none}, errors: ${errors.join('; ') || '-'})`));
    };
    resolvers.forEach(r => queryTxt(r, fqdn, { timeoutMs, fetchImpl }).then(res => {
      done++;
      const recs = res.txt.map(parse).filter(Boolean);
      const keys = new Set(recs.map(x => x.key));
      if (keys.size > 1) errors.push(`${r.id}: conflicting records`);              // RRset order is random: never "pick the first"
      else if (keys.size === 0) none++;
      else {
        const k = [...keys][0];
        const v = votes.get(k) || { n: 0, ad: 0, ttl: Infinity, rec: recs[0] };
        v.n++; if (res.ad) v.ad++; v.ttl = Math.min(v.ttl, res.ttl == null ? Infinity : res.ttl);
        votes.set(k, v);
      }
      check();
    }, err => { done++; errors.push(String(err && err.message || err)); check(); }));
  });
}

export const resolveMagnet = (host, opts) => {
  const fqdn = '_magnet.' + host.toLowerCase().replace(/\.$/, '');
  if (fqdn.length > 253) return Promise.reject(new Error('hostname too long for the _magnet. prefix'));
  return resolveTxtQuorum(fqdn, parseMagnetTxt, opts);
};
```

Usage:

```js
import { resolveMagnet } from './doh-magnet.mjs';
const m = await resolveMagnet(location.hostname);   // null = no record; throws = DNS error or no consensus
// m = { key, btih, btmh, trackers, name, ttl, adVotes, agreeing, of }
```

What the checks covered: live signed zone (`_atproto.jay.bsky.team`, AD from 2 resolvers); live CNAME chain (`_dnslink.docs.ipfs.tech`); live NXDOMAIN; live NODATA (`_magnet.example.com`); live dangling CNAME (`_dnslink.libp2p.io`); live DNSSEC-bogus (`dnssec-failed.org` rejects); over-long hostname; three dialects agreeing; two agree plus one hang (resolved in under 300 ms without waiting for the timeout); one dissenter; all differ (rejects); one resolver returning two valid magnets (excluded); junk TXT only (null); dns.sb HTTP 503; one resolver only (rejects); CNAME+TXT mixed answer with TTL taken from the TXT; escape handling; ambiguous raw quoted value; and magnet validation (uppercase hex, base32 rejected, wrong length, duplicate btih, `ws://` dropped, `javascript:` rejected, hybrid v1+v2, oversize).

### A.2 RFC 8484 wire helpers (GET `?dns=`, ID 0, EDNS0 1232, optional DO)

```js
// ---------- RFC 8484 wire helpers ----------
function buildQuery(name, qtype, doBit) {
  const labels = name.replace(/\.$/, '').split('.');
  const parts = [];
  parts.push(new Uint8Array([0,0, 1,0, 0,1, 0,0, 0,0, 0,1]));            // id=0, RD=1, QD=1, AR=1 (OPT)
  for (const l of labels) { const b = new TextEncoder().encode(l); parts.push(new Uint8Array([b.length]), b); }
  parts.push(new Uint8Array([0, qtype>>8, qtype&255, 0,1]));
  parts.push(new Uint8Array([0, 0,41, 4,208, 0, 0, doBit?0x80:0, 0, 0,0]));   // OPT: udp 1232, DO flag
  let len = parts.reduce((a,p)=>a+p.length,0), out = new Uint8Array(len), o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function readName(v, off) { let jumped=false, ret=0; const labels=[]; for(;;){ const l=v[off]; if(l===0){off++;break;} if((l&0xC0)===0xC0){ if(!jumped){ret=off+2;jumped=true;} off=((l&0x3F)<<8)|v[off+1]; continue;} labels.push(String.fromCharCode(...v.slice(off+1,off+1+l))); off+=1+l;} return [labels.join('.'), jumped?ret:off]; }
function parseWire(buf) {
  const v = new Uint8Array(buf), dv = new DataView(buf);
  const flags = dv.getUint16(2), qd = dv.getUint16(4), an = dv.getUint16(6);
  let off = 12;
  for (let i=0;i<qd;i++){ off = readName(v,off)[1] + 4; }
  const txt = [];
  for (let i=0;i<an;i++){ let nm; [nm,off]=readName(v,off); const t=dv.getUint16(off), ttl=dv.getUint32(off+4), rl=dv.getUint16(off+8); off+=10;
    if (t===16){ let p=off, strs=[]; while(p<off+rl){ const n=v[p]; strs.push(String.fromCharCode(...v.slice(p+1,p+1+n))); p+=1+n; } txt.push({name:nm,ttl,strs}); }
    off+=rl; }
  return { rcode: flags&15, ad: !!(flags&0x20), tc: !!(flags&0x200), txt };
}
```

Wire usage:

```js
const q = b64u(buildQuery(name, 16 /* TXT */, true /* DO=1 so AD is returned */));
const r = await fetch(endpoint + '?dns=' + q, {
  headers: { accept: 'application/dns-message' },   // only safelisted header: no preflight
  credentials: 'omit', referrerPolicy: 'no-referrer'
});
const p = parseWire(await r.arrayBuffer());          // { rcode, ad, tc, txt: [{ name, ttl, strs: [...] }] }
const text = p.txt[0].strs.join('');                  // join strings with NO separator
```

Verified: byte-identical TXT sets versus the JSON path on Cloudflare and Google (8 names); parsed correctly (29 TXT records for `cloudflare.com`) on dns.sb, Control D and DNS4EU in the first matrix run. `parseWire` skips non-TXT answers (CNAMEs are skipped by type). It does not follow a truncated (`tc`) reply; DoH rarely truncates, but check `p.tc`.

---

## Appendix B - What was run (so it can be reproduced)

**Environment.** 2026-10-14 about 23:48 UTC to 00:15 UTC. macOS 27.0 (Darwin 27.0.0), network vantage: one wired host served by Cloudflare colo YYZ (`cf-ray` suffix). System curl 8.7.1 (SecureTransport, no HTTP/3), Python 3.14. Browser: **Brave 155.1.97.56 headless** (user agent `HeadlessChrome/155.0.0.0`, Chromium 155), a fresh profile per run, `--disable-extensions --disable-component-update --disable-background-networking`, default Shields. The test page was served from a local Python server on `http://127.0.0.1:<random port>` (a different origin from every DoH server, so all calls were genuine cross-origin CORS requests) and posted its results back to that server. The user's own browser instance was not touched. No DNS records were created or modified; no domain of the user's was used.

**Test sets.**
1. *Header probes (curl, `Origin: https://example-loader.test`, HTTP/2):* status, `content-type`, `access-control-*`, `cache-control` for GET and OPTIONS on 35+ endpoints (JSON and wire).
2. *Wire probe (Python builds an RFC 8484 query, curl `--http2` transports it):* parses flags (AD/RA/TC/RCODE) and TXT strings individually. Needed because Quad9 rejects HTTP/1.1 (Python's urllib got `HTTP 505`).
3. *Browser matrix (31 fetches, then 18 fetches, repeated; results stable across runs):* JSON and wire GET/POST against Cloudflare, Google, dns.sb, AliDNS, NextDNS, AdGuard, DNSPod, Quad9, Control D, DNS4EU, Mullvad, OpenDNS; fetch-option variants (`Accept`, `cache:'no-store'`, `referrerPolicy`, `credentials:'omit'`, custom header, `?ct=`); DO=0 vs DO=1.
4. *Quad9 diagnosis:* `mode:'no-cors'` returns an opaque response (so the request reaches the server and the failure is the CORS check); hostname URLs (`dns.quad9.net`, `dns9`-`dns12`) fail while IP-literal URLs initially pass; Chromium net-log shows the HTTPS DNS record (`supported_protocol_alpns: h3,h2,http/1.1`), a QUIC session, and a response with headers `content-type` and `content-length` only; over HTTP/2 the same request carries `access-control-allow-origin: *`. An 8-request sequence per target, 700 ms apart, gave `ok ok FAIL FAIL FAIL FAIL FAIL FAIL` for both Quad9 IP literals and `ok x8` for cloudflare-dns.com, dns.google and doh.sb.
5. *Protocol check (net-log of the main run):* QUIC sessions were opened to `cloudflare-dns.com`, `dns.google`, `doh.sb`, `freedns.controld.com`, `mozilla.cloudflare-dns.com` and `dns.quad9.net`; HTTP/2 sessions to the rest. So Cloudflare, Google, dns.sb and Control D work over HTTP/3 in the same browser.
6. *Byte-identity test:* 8 names (`_spf.facebook.com`, `github.com`, `_dnslink.docs.ipfs.tech`, `s1024._domainkey.yahoo.com`, `cloudflare.com`, `_atproto.jay.bsky.team`, a real NXDOMAIN, `dnssec-failed.org`) x 5 paths (Cloudflare JSON, Google JSON, dns.sb JSON, Cloudflare wire, Google wire), TXT strings normalised and compared by SHA-1 of the sorted set: identical for every name (for `dnssec-failed.org` all paths report SERVFAIL; dns.sb JSON answered HTTP 503).
7. *Reference module (Appendix A.1):* 32/32 checks pass.
8. *ECS test:* TXT of `o-o.myaddr.l.google.com` (Google's diagnostic record) via each JSON API, with and without `edns_client_subnet=0.0.0.0/0` (client address redacted from this report).

**Not covered / limitations.** One vantage point and one browser engine; local `http://` origin (CORS does not depend on the page's scheme, but I have not run it from an `https://` origin); no Safari, Firefox, iOS, Android or Samsung Internet (automating the user's own Safari was out of scope, and Firefox is not installed here); no long-running or high-volume tests (rate limits not probed on purpose); no attempt to create real DNS records at any provider.

---

## Appendix C - Sources (URL, date of source)

Dates are the page's own "last updated"/publication date where shown, otherwise the fetch date (2026-10-14) with "undated". Items marked (OLD) predate 2024. Items marked (via search summary) are figures I did not verify on the page itself.

- **[S1]** Cloudflare 1.1.1.1 docs, "Using JSON" (last updated 2026-05-05): https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
- **[S2]** Google Public DNS, "JSON API for DNS over HTTPS" (2024-09-03): https://developers.google.com/speed/public-dns/docs/doh/json
- **[S3]** Google Public DNS, "DNS-over-HTTPS (DoH)" (2024-09-03): https://developers.google.com/speed/public-dns/docs/doh ; troubleshooting/flush: https://developers.google.com/speed/public-dns/docs/troubleshooting ; flush tool: https://dns.google/cache
- **[S4]** Google Public DNS for ISPs, rate limits and "no SLA" (2024-09-03): https://developers.google.com/speed/public-dns/docs/isp
- **[S5]** Google Public DNS Terms of Service (2024-09-03): https://developers.google.com/speed/public-dns/terms
- **[S6]** Google Public DNS Privacy Statement (2024-09-03): https://developers.google.com/speed/public-dns/privacy
- **[S7]** Cloudflare 1.1.1.1: Terms of use (updated 2026-04-30) https://developers.cloudflare.com/1.1.1.1/terms-of-use/ ; SLA and support (undated) https://developers.cloudflare.com/1.1.1.1/infrastructure/sla-and-support/ ; FAQ incl. ECS and Purge Cache (undated) https://developers.cloudflare.com/1.1.1.1/faq/ ; Public resolver privacy (undated) https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/ ; Website and Online Services Terms https://www.cloudflare.com/website-terms/ ; Purge Cache tool https://one.one.one.one/purge-cache/
- **[S8]** Quad9, "JSON-based DNS service retires 5 May, 2025": https://quad9.net/news/blog/quad9-json-based-dns-service-retires-5-may-2025/
- **[S9]** Quad9 FAQ, HTTP/1.1 disabled for DoH on 2025-12-15: https://docs.quad9.net/FAQs/ ; service addresses: https://docs.quad9.net/services/
- **[S10]** Quad9, "Enables DNS Over HTTP/3 and DNS Over QUIC" (2026-03-31): https://quad9.net/news/blog/quad9-enables-dns-over-http-3-and-dns-over-quic/ ; DNSSEC strict validation on all endpoints from 2026-06-15: https://quad9.net/news/
- **[S12]** RFC 8484 DNS Queries over HTTPS (2018-10): https://www.rfc-editor.org/rfc/rfc8484 (older than 2024, normative)
- **[S13]** RFC 1035 (1987), RFC 1464 (1993-05, Experimental), RFC 2308 (1998), RFC 6376 (DKIM, 2011), RFC 6840 (2013), RFC 7208 (SPF, 2014), RFC 7553 (URI RR, 2015), RFC 8427 (2018), RFC 8552 (BCP 222, 2019): https://www.rfc-editor.org/rfc/rfc1035 , /rfc1464 , /rfc2308 , /rfc6376 , /rfc6840 , /rfc7208 , /rfc7553 , /rfc8427 , /rfc8552 (all OLD but normative)
- **[S14]** IANA registries, fetched 2026-10-14: underscored names https://www.iana.org/assignments/dns-parameters/dns-parameters.xml ; URI schemes https://www.iana.org/assignments/uri-schemes/uri-schemes.xml ; media types https://www.iana.org/assignments/media-types/application.csv
- **[S15]** DNSLink specification (undated): https://dnslink.dev/ (the spec repo page github.com/dnslink-std/spec was not retrievable)
- **[S16]** `@multiformats/dns` 1.0.15 (npm 2026-06-25) https://github.com/multiformats/js-dns ; `@helia/dnslink` 2.0.2 (npm 2026-07-03) https://github.com/ipfs/helia/tree/main/packages/dnslink ; Helia issue about numeric `type=16` (2024-03-19 to 2024-04-06; read via summary) https://github.com/ipfs/helia/issues/474 ; `dns-query` README https://github.com/martinheidegger/dns-query ; `dnslink-std/js` (archived 2026-07-31) https://github.com/dnslink-std/js
- **[S17]** IPFS Companion 3.4.0, `add-on/src/lib/dnslink.js` and README (main branch): https://github.com/ipfs/ipfs-companion
- **[S18]** IPFS Service Worker Gateway (`@helia/service-worker-gateway` 3.5.0), README feature list: https://github.com/ipfs/service-worker-gateway
- **[S19]** btlink README (master) https://github.com/anacrolix/btlink and https://raw.githubusercontent.com/anacrolix/btlink/master/README.md ; commit history read 2026-10-14 (latest 2026-09-08)
- **[S20]** Dat DEP-0005 DNS (draft 2018-04-27, changelog to 2019-09-01) (OLD): https://www.datprotocol.com/deps/0005-dns/
- **[S21]** BEP 34 DNS Tracker Preferences (created 2012-07-26, last modified 2016-07-21) (OLD): https://www.bittorrent.org/beps/bep_0034.html ; BEP index https://www.bittorrent.org/beps/bep_0000.html
- **[S22]** Christine Alifrangis, "DNS Schema for Torrent Magnet Links" (2024-11-21; read via summary): https://christinealifrangis.com/dns-schema-to-store-and-replicate-torrent-magnet-links/
- **[S23]** AT Protocol, Handle specification (c) 2026: https://atproto.com/specs/handle
- **[S24]** AWS Route 53: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/ResourceRecordTypes.html and https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-basic.html (undated); Terraform AWS provider docs and source `internal/service/route53/record.go` (`flattenTxtEntry`), main branch read 2026-10-14: https://github.com/hashicorp/terraform-provider-aws
- **[S25]** Cloudflare DNS: https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/ , https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/ , API schema https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/ ; Terraform provider v5 `cloudflare_dns_record` https://github.com/cloudflare/terraform-provider-cloudflare/blob/main/docs/resources/dns_record.md
- **[S26]** Namecheap KB (read via summary): https://www.namecheap.com/support/knowledgebase/article.aspx/317/2237/how-do-i-add-txtspfdkimdmarc-records-for-my-domain/ ; Porkbun KB https://kb.porkbun.com/article/68-how-to-edit-dns-records and API reference v3.63 https://porkbun.com/llms-full.txt
- **[S27]** MDN browser-compat-data 8.1.5 (published 2026-10-08): https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data@8.1.5/data.json
- **[S28]** npm registry metadata fetched 2026-10-14: `@multiformats/dns` 1.0.15 (2026-06-25), `@helia/dnslink` 2.0.2 (2026-07-03), `dns-packet` 5.6.1 (2023-08-25), `@leichtgewicht/dns-packet` 6.0.3 (2022-06-01), `dohjs` 0.3.3 (2022-11-03), `dns-query` 0.11.2 (2022-07-20), `@relaycorp/dnssec` 1.12.1 (2025-04-05), `dnslink` 0.2.8 (2019-01-31): https://registry.npmjs.org/
- **[S29]** DNS Flag Day 2020 (1232-byte EDNS buffer): https://www.dnsflagday.net/2020/
- **[S30]** DNSSEC adoption (2023-24, **via search-result summaries; I did not open these pages**): APNIC 2023-09-18 https://blog.apnic.net/2023/09/18/measuring-the-use-of-dnssec/ ; Verisign https://blog.verisign.com/security/dnssec-algorithm-update/ ; SIDN https://www.sidn.nl/en/news-and-blogs/none-of-the-biggest-internet-services-are-dnssec-enabled
- **[S31]** DoH blocking practice (**via search summary**): Infoblox https://infoblox-docs.atlassian.net/wiki/x/eDccAg ; Cisco Umbrella https://support.umbrella.com/hc/en-us/articles/230904088-How-to-Prevent-Users-from-Circumventing-Cisco-Umbrella-with-Firewall-Rules ; Pi-hole forum https://discourse.pi-hole.net/t/blocking-dns-over-https-doh/69404/2
- **[S32]** dns.sb https://dns.sb/doh/ and https://dns.sb/privacy/ ; Control D https://docs.controld.com/docs/free-dns ; DNS4EU https://www.joindns4.eu/learn
- **[S33]** `@relaycorp/dnssec`: https://github.com/relaycorp/dnssec-js (README and package.json read)
- **[S34]** multicodec table: https://github.com/multiformats/multicodec/blob/master/table.csv
- **[S35]** Local measurements: Appendix B above.
