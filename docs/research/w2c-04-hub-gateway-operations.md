# w2c-04 - Running a public hub / gateway: origin isolation, PSL, quotas, abuse, federation

- Project: magnet-web (static loader, WebTorrent site delivery by magnet link, replicated signed log as DB)
- Topic: how to operate a public hub that serves many unrelated sites without a backend of ours
- Research date: 2026-10-17 ("today" below means this date). Wave 2, topic c-04.
- Method: primary documents read as text (specs, vendor docs, repo source, public price-list JSON) plus **direct measurement**: real Chromium (Chrome for Testing 156.0.8078.4, launched directly and driven over CDP), stock Caddy 2.11.7, Terraform 1.16.6 with `hashicorp/aws` 6.69.1 (`fmt` + `validate`), Node 24 unit tests. **Nothing was deployed to a cloud account.**
- Alignment with the repo: `docs/ARCHITECTURE.md` was rewritten to **v0.2 (normative, 2026-10-17)** while this run was in progress. I read v0.1 first, then re-read v0.2 and DESIGN-REVIEW items 6, 7, 20 and 21, and aligned the findings, the recommendations and the reference deployment to v0.2 (32-character base32 labels, `/mw-sw.js`, physical loader assets under `/_mw/`). Neighbouring notes read for consistency: `w1-10` (static hosting), `w1-11` (security threats), `w2b-05` (security hardening), `w2b-06` (abuse and legal), `w2c-03` (identity), `w2c-05` (testing), `w2c-06` (standards). Differences are listed in "Reconciliation with neighbouring notes".
- Limit of this run: the shared WebSearch budget ran out part-way through (200 calls per turn, shared by all agents). Leads that needed a search and could not be followed are listed in Appendix D as unverified. No search engines were queried through other channels.
- Confidence legend: **High** = measured today and/or two independent primary sources agree. **Medium** = one primary source, or behaviour observed but undocumented by the provider, or a summariser-extracted figure (WebFetch) that I could not cross-check. **Low** = inference or proposal.
- Source IDs like [S4] are in Appendix C with URL and date. Anything older than 2024 is flagged "(OLD)". Repo notes are cited by file name.
- Reference files (tested as stated in section "Reference hub deployment"): `docs/research/labs/w2c-04-hub-reference/`

---

## Summary

1. **Per-site origins are the right design, and ARCHITECTURE.md v0.2 already adopts them** (section 3.2: `https://<label>.<hub>/`; section 3.3: the shared-origin hub is demo-only). Evidence for the decision: a sandboxed frame without `allow-same-origin` is not served by the Service Worker (our spike, and WPT per DESIGN-REVIEW 6), so no sandbox variant isolates SW-served sites; every living precedent isolates by subdomain: IPFS (`<cidv1-base32>.ipfs.<gw>`), Arweave (52-character base32 sandbox label), ENS gateways (`*.eth.limo` is a PSL wildcard entry; the name-to-origin mapping was not read); the IPFS Service Worker Gateway "runs exclusively in subdomain mode" and removed path-gateway support in v3. What v0.2 does not yet have is the **operating layer** this note supplies: edge enforcement, takedown, abuse handling, cost, federation. [S3, S4, S13, S15, S30]
2. **The largest precedent just collapsed, and it is the closest cousin of this project.** On 2026-10-17 `ipfs.io` and `dweb.link` answer HTTP 429 with `Sunset: Mon, 21 Sep 2026` and a page saying the gateway "retires for good on September 21"; Shipyard (which ran them) stopped on 2026-09-30 after Protocol Labs ended funding; since 2026-05-11 browsers had been redirected to `inbrowser.link`, a **Service Worker gateway** whose own README says an operator "could potentially run a simple HTTP server on a Raspberry Pi, serving only small static HTML+JS files (<10MiB)". That repo is now maintained by two named maintainers on behalf of the IPFS Foundation. Lesson: design hubs to be cheap and sponsor-independent. [S4, S5, S6, S7, S8]
3. **The v0.2 label grammar `^[a-z2-7]{32}$` is sound; what remains is enforcement and two consequences.** 32 base32 characters are exactly 160 bits: DNS-safe (labels are <= 63 octets), one canonical spelling (a longer id, such as a 32-byte SHA-256, would leave four free padding bits and allow 16 spellings of one id, so ar.io rejects non-canonical labels), and a signed pointer's label is owner-bound through the ledger id (`base32(sha256(ledgerId))[0:32]`, ledger id = hash of owner key and chain), so another publisher cannot take over someone else's origin. Consequences: (a) the **edge must reject every other label**, which also removes attacker-chosen vanity hostnames such as `login-paypal.hub-sites.example`; (b) a signed label is a hash and cannot be turned back into a pointer, so a bare `https://<label>.hub/` link stops loading after a cache loss (Safari's 7-day eviction, a new device) unless the fragment or a `#host:` pointer travels with the link, whereas a bare-magnet label decodes back to its infohash. If BitTorrent v2 ever returns (a non-goal in v0.2), a 32-byte id needs 52 characters with a canonical `a`/`q` last character. [S3, S15, S30; design-critical]
4. **Wildcard TLS hosting matrix (vendor docs, read today; w1-10 F24 reached the same table):** CloudFront + ACM, Cloudflare **Workers** (static assets + wildcard route), Vercel and Caddy (DNS-01) can host `*.sites-domain`. **Cloudflare Pages and Workers Custom Domains cannot** ("Cloudflare Pages projects cannot use wildcard custom domains"), GitHub Pages does not document wildcard custom domains and strongly discourages wildcard DNS, Netlify lists wildcard certificates as a Netlify-DNS benefit. DEPLOY.md needs this table. [S18-S22; design-critical]
5. **The Public Suffix List (PSL) does real work, measured:** with the parent on the PSL, a sibling cannot set `Domain=<parent>` cookies (no tossing, no cookie bomb), `Sec-Fetch-Site` between labels becomes `cross-site`, and the HTTP cache is partitioned per label; without it all three are shared (Chrome for Testing 156). But the PSL is **gated** (>= 2 years of registration left, "projects not serving more than thousands of users are quite likely to be declined", `_psl` TXT proof, no SLA, OS-embedded copies update with OS releases) and it was exactly the missing piece in the **statichost.eu** Safe Browsing incident of 2025-10-10 and the **nftstorage.link** incidents of 2022 (OLD). w1-11 R3 turns "should list the hub suffix on the PSL" into a MUST for multi-publisher hubs; a MUST that the PSL maintainers may decline for a young hub needs a fallback: a dedicated sites domain separate from the control plane, cookie-free by construction, registered for >= 2 years, PSL application at launch and again with usage evidence. [S1, S2, S11, S12, S31; design-critical]
6. **A static-only hub cannot enforce per-site quotas or per-site rate limits** (it stores nothing per site, and the shell is the same bytes for every label). What it can do: label grammar, label denylist, per-IP edge rate limit. Client-side caps (`maxSiteBytes`, the section 8 storage budget) are advisory against hostile same-origin JavaScript, and browsers give one origin up to 60% of disk (Chromium, Safari) or 10 GiB per *site* group (Firefox: the PSL decides the group), with LRU eviction of *other* origins under pressure. [S16, S30; design-critical]
7. **Takedown for already-installed visitors, measured in Chromium 156:** answering 404/410/451/500 for the SW script does **not** remove an installed Service Worker or its data; a self-unregistering script (what ARCH section 7.1's kill switch is) removes the registration but keeps IndexedDB and localStorage; **`Clear-Site-Data: "storage"` wipes SW + IndexedDB + Cache Storage + localStorage of that origin only, whether it arrives on a `fetch()`, a navigation, or the SW script's own update response, and also when that response is a 451, 404 or 500**. Chromium re-fetches the SW script about 2-3 s after a navigation. So an edge that answers every path of a denylisted label with 451 + `Clear-Site-Data: "storage"` reaches returning Chromium visitors on its own; a boot-time ping of a network-only `/_mw/hub/status` is the cross-browser path and needs the SW to leave `/_mw/hub/*` alone (v0.2 routes `/_mw/*` to the precache). `"cookies"` is registrable-domain-wide: never use it. (Firefox and Safari not tested.) [S16, S25, S31, w2b-05 F20/F24; design-critical]
8. **Edge denylist pattern with production precedent:** the IPFS SW gateway refuses Bad-Bits hosts with `410` *before the SW installer is served* (about 513k list entries, about 60k refused requests per day, new entries live in about 8 minutes, fails open, deploy gate on list freshness). I implemented the same idea for CloudFront Functions + KeyValueStore, Cloudflare Workers + KV and Caddy against the v0.2 layout; the edge logic passes unit/behaviour tests (Node fake runtimes, stock Caddy 2.11.7 probed with curl). It is the delivery mechanism for the signed client denylist and hub gate proposed in w2b-06 (R3, L1). [S4, S31]
9. **Abuse reality 2026:** Netcraft says Shipyard-run gateways were 84% of the IPFS fronting used by phishing sites it took down so far in 2026 and `inbrowser.link` is the third most used fronting gateway. Whole-domain Safe Browsing flags hit hubs repeatedly, and a hash denylist is evaded when content is re-packed (Sokoto et al., USENIX Security 2024, via w2b-06 F10). Minimum viable abuse program: `abuse@` (RFC 2142), `security.txt` (RFC 9116), a report link inside the loader, 451 with `Link: rel="blocked-by"` (RFC 7725), a published takedown policy, a Search Console property for the sites domain. [S10, S11, S12, S25]
10. **The site and the loader share an origin, so a hostile site can delete any warning banner the loader draws.** Hub warnings belong on the apex gate (v0.2 section 3.2 already shows the gate before redirecting) and powerful features must be default-denied by `Permissions-Policy` on hub origins. [S30; design-critical]
11. **Cost reality (computed from the AWS price list of 2026-10-03, Cloudflare docs, R2/B2/Bunny pages):** a shell-only hub costs about **$21 per million cold visits** on CloudFront pay-as-you-go, about **$2.40 per million** on Cloudflare Workers Paid (static assets are free and unlimited; $5/month base), and CloudFront's $15/month Pro flat-rate plan covers 10M requests with KeyValueStore and WAF included. A **web-seed mirror** is where the money goes: 100,000 cold visitors x 50 MiB site = 4.9 TiB, about $466 on CloudFront, about $26 on Bunny Volume, about $7 on R2 (egress free), if peers serve nothing. Cloudflare's CDN terms restrict serving large files on Free/Pro/Business unless the Developer Platform (R2/Workers) is used. [S18, S19, S24]
12. **Legal position (overview only; `w2b-06-abuse-legal-ops.md` owns the analysis):** a shell-only hub stores no third-party content, but its domain is in the URL bar of every hosted site; w2b-06 R4 concludes the hub should have an apex gate only, an allowlist default and **no hub-run directory or search** (Ziggo: indexing and search can be a communication to the public). The safe-harbour machinery still needs an agent, a notice channel and a takedown path. Get counsel before launch. [S27]
13. **Federation = interchangeability, not shared state.** Hubs are interchangeable if they share the label grammar, the pointer format and a signed deny-list format (w2b-06 R3's `/_mw/deny.json`). Origin-bound state (identity key, ledger database, pins) does **not** move between hubs. Precedents: IPFS public-gateway-checker (`gateways.json`, origin-isolation column) and `gateway-conformance`, Nostr NIP-11 relay information document and NIP-66 monitors, Matrix moderation policy lists, AT Protocol signed labels. A hub directory is a legal risk (item 12) and is demoted to P3. [S26, S29]
14. **Testing at production grade:** `http://<32-char label>.hub.localhost:PORT` is a secure context in Chromium 156 with one SW registration and one storage partition per label (no certificates needed). Playwright's default launch flags (`--disable-features=...ThirdPartyStoragePartitioning...`) changed the cache-partitioning result in our first run; launch Chrome directly for partitioning tests. [S31]

---

## Findings

Format: **claim**, then confidence, sources with source date, and whether it is design-critical (would change the architecture or a compatibility promise if wrong).

### F1. A shared-origin hub has no isolation; per-site origins are mandatory for multi-publisher hubs

**Claim.** All sites loaded at `https://hub.example/...` (the v0.1 "hub mode", now the demo-only section 3.3) share one origin (IndexedDB, Cache Storage, localStorage, the identity key, the SW registration). Sandbox flags cannot fix it, because SW rendering needs `allow-same-origin`, and `allow-scripts allow-same-origin` on same-origin content is equivalent to no sandbox.

- Our spike (Chromium 156.0.8078.4, 2026-10-14, `docs/research/labs/04-sw-experiment/results-chromium-156-2026-10-14.txt`): iframes `normal` and `sandbox="allow-scripts allow-same-origin"` were answered by the SW (`who: "sw"`, `ctrl: true`); `sandbox="allow-scripts"` produced `NETWORK HIT /site/sandbox-scripts` and `ctrl: "ERR:SecurityError"`. So the opaque-origin frame is not SW-controlled. Confirms the premise of the security review's blocker B1. [S30]
- The IPFS docs say the same about path gateways: "all pages share a single origin", to be used "when site isolation does not matter"; the SW gateway's development notes: "NEVER use path-only gateways for loading dapps with sensitive information such as keys, passwords, or wallets"; the community gateway checker marks gateways without origin isolation with a warning: "all sites share localStorage, cookies, and session data". [S13, S4, S29]

ARCHITECTURE.md v0.2 resolved this in the right direction (section 3.2 subdomain hubs for production, section 3.3 shared origin demo-only behind a blocking interstitial, DESIGN-REVIEW 6); the rest of this note is about operating that design.

Confidence: **High**. Sources: [S30] (2026-10-14 and v0.2 2026-10-17), [S13] (undated, read 2026-10-17), [S4] (main branch, 2026-10-17), [S29]. Design-critical: **yes** (it is the reason for everything below).

### F2. How subdomain gateways map an origin to content: label encodings and their limits

| System | Host form | Encoding | Notes | Source |
|---|---|---|---|---|
| IPFS immutable | `{cid-mbase32}.ipfs.example.net` | CIDv1, lower-case base32 (59 chars for sha2-256) | Host must have >= 3 labels; `Host` -> content path | [S3] spec dated 2025-04-03 |
| IPFS mutable key | `{libp2p-key-mbase36}.ipns.example.net` | base36 | "Base36 must be used to ensure CIDv1 with ED25519 fits in a single DNS label (63 characters)" | [S3] |
| IPFS DNSLink name | `en-wikipedia--on--ipfs-org.ipns.example.net` | every `-` becomes `--`, every `.` becomes `-` | one label so one wildcard certificate and one origin per name | [S3] |
| IPFS identifiers longer than 63 chars (e.g. sha2-512) | none | "remains an open question"; implementations "should return HTTP 400 Bad Request" | the same limit hits a 64-hex BitTorrent v2 infohash | [S3] |
| IPFS SW gateway | `b<base32>.ipfs.<host>`, `k<base36>.ipns.<host>`, DNSLink inlined | multibase prefix character + payload | `toSubdomain()` in `src/cloudflare/snippets/subdomain.ts` | [S4] |
| Arweave (ar.io) | `<sandbox>.<ARNS_ROOT_HOST>/<id>` | 32-byte tx id as **52** base32 characters; middleware accepts only canonical labels (`a-z`, `2-7`, exactly 52 chars, re-encodes identically, so non-zero trailing bits are rejected) | `/<id>` redirects to the sandbox host; blocked items answer **451**; "abuse reports often cite" the bare sandbox root, so it also answers 451/404 | [S15] (PR #965, undated) |
| ENS gateways | `*.eth.limo`, `*.eth.link` | (mapping not read) | both are PSL wildcard entries by Last Mile Labs | [S2] |
| **magnet-web v0.2** | `<label>.<hub>` | 32 base32 characters: `base32(sha256(ledgerId))[0:32]` for signed pointers, `base32(btih)` for bare magnets (160 bits) | `hubLabelFor()` in INTERFACES; the ledger id hashes the owner key and the chain, so the label is owner-bound | ARCH section 3.2, DESIGN-REVIEW 6 |

Consequences for magnet-web: (1) 32 base32 characters are exactly 160 bits, so the spelling is canonical by construction: unlike a 32-byte id (256 bits = 51 x 5 bits + 1 bit, so the 52nd character has four free bits and **16 different spellings decode to the same id**, which is why ar.io rejects non-canonical labels) there are no padding bits to abuse, and one label is one origin and one denylist key. (2) The 63-octet DNS limit is respected with room to spare; a 64-hex SHA-256 would not fit (IPFS answers HTTP 400 for such CIDs). (3) Browsers lower-case the authority (IPFS docs list "some browsers and other user agents force lowercase for the authority part of URLs" as a known issue), so labels must be lower-case base32. (4) Because the signed label is owner-bound, another publisher cannot claim it; the **bare-magnet label** is attacker-mintable for arbitrary content (any btih), which is why the denylist needs owner-key and file-hash entries too (F11). (5) The signed label cannot be reversed to a pointer (F3). (I made the 52-character mistake in my own first draft of the edge regex and caught it while writing test vectors; v0.2's 32-character choice avoids it.) [S13]

Confidence: **High**. Design-critical: **yes** (URL compatibility promise; `src/loader/render.js` still carries the v0.1 `WILDCARD_HOST_RE` for 40 hex).

### F3. The first-load redirect, and what a static edge can and cannot do

- Spec behaviour: a path-style request (`/ipfs/<cid>/path?query`) returns **HTTP 301** with `Location: https://<cid-base32>.ipfs.<gw>/path?query`; the redirect "MUST preserve the originally requested {path} and {query}", converts the root id to the case-insensitive form first, and defers `_redirects`/IPLD traversal until after the redirect. The spec warns that some legacy clients "check for HTTP 200", so use a different domain if breaking them matters. [S3]
- The production SW gateway does this in a **Cloudflare Snippet** (no origin involved): 301 with `Cache-Control: public, max-age=31536000, immutable` (`01_path_gateway_to_subdomain.ts`). Path support was removed entirely in v3; `/ipfs/cid` always redirects to `cid.ipfs.example.com`. [S4]
- The page each subdomain serves is a small **installer**: identical for every URL on every subdomain; it registers the SW, which then handles all navigation. To avoid a cold miss per new subdomain the edge **normalizes the cache key to the base domain** (24 h TTL, only 2xx cached, always fetches `/` with `Accept: text/html` and `redirect: manual`). Reason (their issue #1155): an origin that answered a missing hashed chunk with `200 text/html` got pinned for 24 h under the shared key and every subdomain "served HTML where a .js file belonged", causing a reload storm and rate limiting. Lesson: **never SPA-fall-back anything but document navigations; a missing script must be a real 404.** [S4]
- For magnet-web the pointer lives in the URL **fragment** (never sent to a server), so the path-to-subdomain step is client-side, and v0.2 puts the gate there: `https://hub.example/#magnet:...` shows the section 8 gate (nothing connects before the click), then the apex page computes the label and does `location.assign('https://<label>.hub.example/#<pointer>')`. Two consequences: the apex page is tiny and holds the interstitial (F12); and a **signed label is a hash** (`base32(sha256(ledgerId))[0:32]`), so the label alone cannot recreate the pointer: if the cache is lost (Safari's 7-day eviction, a new device, a friend opening the link) the origin cannot load unless the link still carries the fragment or `#host:example.com`. A bare-magnet label decodes to the infohash but not to trackers or web seeds.
- On CloudFront the default cache key is "the domain name of the CloudFront distribution" plus the URL path; the viewer's Host is not part of it, so all labels already share one cached shell per edge location unless a cache policy adds Host. [S18]

Confidence: **High** (spec + code). Sources: [S3] (2025-04-03), [S4] (main, 2026-10-17), [S18]. Design-critical: no (but it fixes where the redirect lives).

### F4. Which static hosts can serve `*.sites-domain` with a wildcard certificate (vendor docs, read 2026-10-17)

| Host | Wildcard per-label hosting | What the docs say | Confidence |
|---|---|---|---|
| **CloudFront + ACM** | Yes | Alternate domain names may be wildcards, must be lower-case, covered by a TLS cert whose SAN covers them; `*.example.com` covers one level only (not `example.com`, not `a.b.example.com`); one certificate per distribution; 100 alternate names per distribution (adjustable); the distribution is chosen by the `Host` header, not SNI; cross-account domain fronting is answered with 421. ACM certs for CloudFront must be in us-east-1 | High |
| **Cloudflare Workers** (static assets + route `*.sites/*`) | Yes | "Customers on all plans can create and proxy wildcard DNS records"; route pattern `*.example.com/*` matches subdomains only; the DNS record must be proxied; Universal SSL "coverage is limited to the root domain... and first-level subdomains", deeper names need Advanced Certificate Manager or custom certs | High |
| **Cloudflare Workers Custom Domains** | **No** | "do not support wildcard DNS records" (as read in w1-10 F18; I read only the Routes page) | Medium |
| **Cloudflare Pages** | **No** | "Cloudflare Pages projects cannot use wildcard custom domains" (wildcard DNS reference); the Pages custom-domain page does not mention wildcards | High |
| **Vercel** | Yes | wildcard domain with Vercel nameservers, or delegate `_acme-challenge` NS records to Vercel; Hobby: 50 custom domains per project (page updated 2026-09-16) | High |
| **Netlify** | Probably, with Netlify DNS | the domains page lists "Wildcard SSL certificate provisioning and renewal (non-wildcard is supported with both)" as a Netlify-DNS benefit; no further wildcard text found | Low-Medium |
| **GitHub Pages** | **No (not documented)** | docs "strongly recommend that you do not use wildcard DNS records" ("immediate risk of domain takeovers"); no wildcard custom-domain feature described | Medium |
| **Caddy on a VPS** | Yes | wildcard certificate needs the ACME DNS challenge; as of Caddy 2.10 a wildcard certificate is used for matching subdomains; On-Demand TLS "must be both enabled and restricted to prevent abuse" (`ask` endpoint) | High |

Rate-limit trap for per-label certificates: Let's Encrypt allows **50 new certificates per registered domain per 7 days** (global, overrides need a form that takes "a few weeks") and "We use the Public Suffix List to identify registered domains". One wildcard certificate per sites domain avoids it, and keeps per-site hostnames out of Certificate Transparency logs (inference: CT logs record certificate SANs; a wildcard SAN hides the labels). [S21, S20]

Sources: [S18] CloudFront docs (undated), [S19] Cloudflare docs (undated), [S22] Vercel (2026-09-16), Netlify/GitHub docs (undated), [S20] Caddy docs + binary v2.11.7 (release archive files dated 2026-10-03, sha512 verified against the release checksums file), [S21] Let's Encrypt (undated). w1-10 F24 reached the same table independently. Design-critical: **yes** for the DEPLOY.md promise (v0.2 section 3.2 only says "wildcard certificate"; v0.1 said "CloudFront+ACM or Cloudflare", which is false for Pages).

### F5. CloudFront quotas and plans that shape a hub (AWS docs; price list published 2026-10-03)

- Quotas: alternate domain names per distribution **100**; distributions per account **500**; max request length incl. headers and query string **32,768 bytes**; URL **8,192 bytes**; one certificate per distribution; CloudFront Functions: **10 KB** code, **2 MB** memory, 100 functions per account; KeyValueStore: key <= **512 B**, value <= **1 KB**, store <= **5 MB**, <= **50 keys or 3 MB per update call**, 1 store per function, 200 stores per account; response-headers-policy CSP value <= **1,783 characters**; multi-tenant (SaaS) distributions: 10,000 distribution tenants per account (adjustable). [S18]
- KeyValueStore needs **JavaScript runtime 2.0**; helper methods `kvsHandle.get(key)` (throws when the key is missing), `exists(key)`, `meta()`; use `await` sequentially (promise combinators raise memory use). [S18]
- Flat-rate plans (docs, current): Free $0 (1M requests, 100 GB), Pro $15 (10M, 50 TB), Business $200 (125M, 50 TB), Premium $1,000 (500M, 50 TB; configurable up to 600 TB for $10,000). "No overage charges"; exceeding the allowance may "adjust" delivery (fewer or more distant edge locations) after about 2-3 months; first spike up to 3x is free of adjustment. A WAF web ACL is **mandatory**, IP-based rate limiting is included, **KeyValueStore is Pro and above** (the Free column is empty), 1 apex domain per plan, 3 Free plans per account, accounts on the AWS Free Tier are ineligible, multi-tenant distributions are unsupported. Whether wildcard aliases are accepted on a plan: **unverified**. [S18]
- Pay-as-you-go (price list v20261003000426): data transfer out $0.085/GB first 10 TB (US/CA/EU), HTTPS requests $0.0100 per 10,000 (US/CA) and $0.0120 (EU), CloudFront Function executions first 2,000,000 free then $0.10 per million, KeyValueStore edge reads first 2,000,000 free then $0.03 per million, KVS API operations $1 per 1,000, invalidations first 1,000 paths/month free then $0.005. AWS WAF (price list 2026-09-14): $5.00 per web ACL per month, $1.00 per rule per month, $0.60 per million requests. Route 53: $0.50 per hosted zone (first 25), alias queries free. [S18]

Confidence: **High**. Design-critical: no.

### F6. Public Suffix List: who has an entry, and what it takes to get one

- Entries for gateway-style hosts in the live list (VERSION 2026-10-16_23-32-13_UTC, commit 2dbfce14; about 3,450 private-section entries by my count): IPFS Project (submitted by Interplanetary Shipyard) `*.inbrowser.dev`, `*.dweb.link`, `*.inbrowser.link`; Last Mile Labs (eth.limo) `*.eth.limo`, `*.eth.link`; Cloudflare `cloudflare-ipfs.com`, `cf-ipfs.com`, `pages.dev`, `workers.dev`, `r2.dev`; Storacha `ipfs.w3s.link`, `ipfs.storacha.link`; `ipfs.nftstorage.link`; GitHub `github.io`, `githubusercontent.com`; Amazon CloudFront `cloudfront.net`; Netlify `netlify.app`; `vercel.app`. **Not listed:** `ipfs.io`, `arweave.net` (the path-gateway and Arweave sandbox hosts rely on other mitigations). The IPFS spec tells subdomain-gateway operators to "register a wildcard entry like `*.example.net`" so that `ipfs.example.net` becomes an eTLD and each `cid.ipfs.example.net` a distinct site. [S2, S3]
- Requirements and non-acceptance criteria (maintainers' guidelines, read today): authenticate with a **`_psl` TXT record** containing the PR URL on each suffix (leave it in place; missing records are a "flag used in determination of domains to remove"); private-section domains need **"at least two years remaining in the registration term"**; third parties cannot submit for a service; **no SLA** ("NO SERVICE LEVEL AGREEMENTS ON TIME"); "projects that are smaller in scale or are temporary or seasonal ... will likely be declined ... projects not serving more then thousands of users are quite likely to be declined"; entries "whose sole purpose is to circumvent rate limits of third parties (such as Let's Encrypt)" are not accepted; propagation: "there is no way to expedite", "some platforms have incorporated the PSL within the OS itself, so updates may not happen until the next OS update". [S1]
- Incidents where the PSL entry was the missing piece: **nftstorage.link, 2022-03-29 and 2022-04-21 (OLD)**: Google Safe Browsing flagged the whole gateway domain for 4+ hours each time (about 5,000,000 requests blocked in the first), triggered by one phishing CID; downstream vendors (Avast, Webroot, Swisscom, ...) copied the verdict; their own PSL request had not been accepted yet. **statichost.eu, 2025-10-10**: an influx of phishing sites on `SITE.statichost.eu` got the whole domain flagged; the operator moved new sites to a separate `statichost.page` domain and was "pending inclusion" on the PSL, noting the "large enough user base" criterion. [S11, S12]
- w1-11 R3 would turn the PSL "SHOULD" into a MUST for multi-publisher hubs. The Guidelines above make that unsafe as a launch condition for a young hub, so the fallback of F7 is needed; see "Reconciliation with neighbouring notes".
- Google publishes no explicit rule that PSL membership narrows Safe Browsing to subdomains; I found only operator reports and a backchannel assurance from 2022 that was broken a month later by "a bad regex statement"; w2b-06 F11 reads Google's canonicalization page (fragments are stripped, host suffixes are matched, so a listing of the parent can cover every label) and also leaves the PSL effect unverified. Treat the PSL as the best available lever, not a guarantee. [S11, S12]

Confidence: **High** for what the guidelines and list say; **Medium** for the Safe Browsing effect. Design-critical: **yes**. A new hub cannot assume PSL protection at launch.

### F7. What a PSL entry changes for sibling labels, measured (and what it does not)

Chrome for Testing 156.0.8078.4, headless=new, launched directly, hostnames mapped to 127.0.0.1 with `--host-resolver-rules` (no DNS), 2026-10-17. Stand-ins: `hub-lab.test` (not on the PSL), `cloudfront.net` (private-section entry), `*.inbrowser.link` (wildcard rule, parent `ipfs.inbrowser.link`). Script and raw results: `labs/w2c-04-hub-reference/lab/psl-effects.mjs`, `results-psl-effects.json`.

| Test (page A = `a.<parent>`, page B = `b.<parent>`) | Parent NOT on PSL | Parent on PSL (both stand-ins) |
|---|---|---|
| A sets a cookie with `Domain=<parent>` | accepted (`toss=1`) | **rejected** (empty cookie jar) |
| That cookie visible at B | **yes** | no |
| A sets 10 cookies x 3,900 B with `Domain=<parent>`; B then navigates | **B fails** (server with a 16 KiB header cap answers 431; CloudFront's cap is 32,768 B, so about 9 such cookies suffice) | B loads (200) |
| `Sec-Fetch-Site` when A fetches B | `same-site` | `cross-site` |
| Server hits for the same cross-site script requested by A, then B (HTTP cache) | **1** (cache shared) | **2** (cache partitioned) |
| localStorage written by A visible at B | no | no |

Reading: the **origin** boundary (storage, SW, IndexedDB) holds with or without the PSL; the PSL decides everything that works on the **site** (eTLD+1) level: cookie scope (RFC 6265 section 5.3 step 5: a user agent "configured to reject public suffixes" refuses a `Domain` attribute that is a public suffix), SameSite and Fetch-Metadata decisions, cache partition keys (Chrome keys on "scheme://eTLD+1", so "subdomains and port numbers are ignored" [S17]), Firefox's 10 GiB *group* quota [S16], and Chrome's process model (a site is "the scheme and registered domain name, including the public suffix, but ignoring subdomains", and "multiple origins within a site" may "share the same process"; Android isolates only a subset of sites) [S17]. `Origin-Agent-Cluster: ?1` is only a hint ("should not be viewed as a security feature") [S16].

Cookie integrity against same-site (sibling-subdomain) attackers is an active research area: "Cookie Crumbles" (USENIX Security 2023) reports 12 CVEs and 27 disclosures from bypasses of Secure, cookie-prefix and SameSite defences. [S28]

The cost of the PSL is that cross-label sharing disappears: with it, each new label re-downloads the shell (about 100-150 KB brotli, see F13); without it, a shared host could have been cached once. That is a small, accepted price.

What stays without a PSL (design response, not a fix): (a) keep the sites domain **cookie-free** and never run anything with sessions on it (the control plane and any admin console live on another registrable domain); (b) a cookie-bomb victim can only hurt their own browser (cookies are per-browser) but is then locked out of every sibling label until cookies are cleared; (c) never send `Clear-Site-Data: "cookies"` (F9); (d) accept shared Firefox quota group and shared Chrome process for siblings; (e) minimise blast radius of a Safe Browsing verdict by separating the sites domain from the control plane.

Confidence: **High** (measured; the cache result matches the documented Chrome design). Sources: [S31] (own measurement, 2026-10-17), [S17], [S16], [S25]. Design-critical: **yes**.

### F8. Per-site quotas and rate limits in a static-only hub: what is and is not possible

| Control | Possible on a shell-only hub? | How / limit |
|---|---|---|
| Bytes stored per site | No (hub stores nothing per site) | Browser quotas apply per origin: Chromium up to 60% of total disk per origin (80% overall), Safari about 60% (browser apps) and about 1/10 of that for cross-origin frames, Firefox the smaller of 10% of disk or 10 GiB **per site group** (the PSL defines the group) [S16] |
| `maxSiteBytes` / `max=` caps | Advisory only | enforced by loader code that a hostile **same-origin** site can bypass by writing IndexedDB/Cache Storage itself |
| Disk-fill by a hostile site | Cannot be prevented | Under storage pressure browsers evict the **least recently used origin** first, so a site that has just filled the disk makes *other* origins lose data [S16] |
| Per-IP request rate | Yes | AWS WAF rate-based rule (5 min window; included in flat-rate plans); Cloudflare rate limiting **Free = 1 rule, IP counting only, 10 s window** [S18, S19] |
| Per-host / per-label request rate | AWS WAF yes (custom aggregation keys, +30 WCU each); Cloudflare Free no | useless for the shell (same bytes for all labels); matters only if the hub also serves a web seed per label/path [S18, S19] |
| Per-site bandwidth | No | the shell is identical for all labels; the heavy bytes come from peers, trackers and web seeds that are not the hub |
| Which labels exist | Yes | label grammar + denylist at the edge (F10) |
| Which publishers may list | Only with an operator-curated allowlist (w2b-06 R4; F15) | an open directory is a legal risk, so none by default |
| Per-owner storage quota on a web-seed mirror | Needs a (tiny) backend | presigned-URL issuer with per-key accounting; conflicts with "no backend of ours" so make it an optional add-on |

v0.2 section 8 adds a storage budget (512 MiB desktop / 128 MiB mobile, LRU by last visit, "Forget this site"); like `maxSiteBytes` it is enforced by loader code and therefore advisory against a hostile same-origin site.

Safari adds a time dimension: with cross-site tracking prevention on, an origin with no user interaction "in the last seven days of browser use" has its script-created data deleted (cookies set by a server are exempt). With one origin per site this applies **per site**, and it silently deletes the identity key and TOFU pins of rarely visited sites (security review M8). [S16, S30]

Confidence: **High** for the numbers (MDN, AWS/Cloudflare docs), **Medium** for the design consequences. Design-critical: **yes** (the architecture's policy table in section 8 reads as if quotas were enforceable).

### F9. Taking a site down for visitors who already installed it: measured mechanics

Chrome for Testing 156.0.8078.4, 2026-10-17, page on `http://<label>.<x>.localhost:PORT` (a secure context) with an active SW, localStorage, Cache Storage and IndexedDB. Scripts and raw results: `lab/takedown-mechanics.mjs`, `csd-scope.mjs`, `csd-status-codes.mjs`, `csd-on-sw-update.mjs` and the matching `results-*.json`.

| Action by the server | SW registration afterwards | localStorage / Cache Storage / IndexedDB |
|---|---|---|
| the SW script answers **404**, **410**, **451** or **500** to the update check | **stays** (`registration.update()` rejects) | all kept |
| the SW script answers a self-unregistering script (this is ARCH section 7.1's kill switch; it wipes no data by itself) | removed (within about 1.5 s) | **all kept** |
| `Clear-Site-Data: "storage"` on a `fetch()` response | removed | **all cleared** |
| `Clear-Site-Data: "storage"` on a navigation response | removed | **all cleared** |
| the same header on a **404, 410, 451, 500 or 503** response, via `fetch()` and via navigation (12 combinations) | removed in all 12 | cleared in all 12 |
| the same header on the **SW script response during `update()`**, when that response is 200, **451**, 404 or 500 | removed in all 4 | cleared in all 4 |
| `Clear-Site-Data: "executionContexts"` alone | stays | kept |
| `"storage"` sent by label A, effect on sibling label B (same registrable domain, not on the PSL) | B untouched | B untouched |
| `"cookies"` sent by label A | n/a | clears the `Domain=` cookie for **both** A and B (registrable-domain-wide, as MDN says) |

`"cache", "storage"` behaved like `"storage"` in the earlier runs, but `"cache"` adds nothing a hub needs (the shell is `no-cache` anyway) and MDN/BCD describe Chrome's `"cache"` support as partial, so the reference uses **`"storage"` only**.

Why it matters:
- **Chromium re-fetches the SW script about 2-3 s after a navigation** even when the registration is not stale (2.84 s here, n=1, registered with `updateViaCache: 'none'` as ARCH section 5.2 specifies; w2b-05 F24 measured 1978-1987 ms, n=6, debounced). The spec's 24 h staleness rule (86,400 s) is only a floor. [S25]
- An installed offline-first SW answers navigations itself: **the network never sees a returning visitor on a navigation**. The IPFS gateway's own notes concede the edge "only sees a visitor's first request to a host" and list a check inside the SW as an open gap (their #840). [S4]
- So there are **three converging delivery paths** for an edge that answers 451 + `Clear-Site-Data: "storage"` on every path of a denylisted label: (1) a new navigation gets the tombstone page; (2) the browser's own SW update fetch (`/mw-sw.js`) gets the 451 + header, which wipes the origin about 2-3 s after the visitor's next navigation, with no loader code involved (Chromium only so far); (3) the loader's boot-time `GET /_mw/hub/status` (`cache: 'no-store'`) gets the same answer and also lets the loader show a tombstone and stop the torrent client. Path 3 is the cross-browser one and must stay: **ARCH section 7.1 routes `/_mw/*` to the precache, so `/_mw/hub/*` must be added to the SW's pass-through list** (like `/_mw/t/*` and `/ws/*`), and a response synthesized by the SW is ignored by Clear-Site-Data (w2b-05 F20), so the ping has to be a real network response.
- The loader should also wipe in JavaScript as a fallback (`getRegistrations().unregister()`, `caches.delete`, `indexedDB.deleteDatabase`, `localStorage.clear()`).
- w2b-05 F20 measured the 200-response case on the SW script and the tombstone-SW alternative (leaves IndexedDB intact); this note adds the non-2xx cases, the fetch/navigation cases and the sibling-scope check.
- **A stall to test for:** in my harness a navigation made right after a wipe in the *same* browser instance stalled for more than 10 s several times (with `"storage"` and with `"cache", "storage"`); one browser per scenario avoided it and I did not root-cause it. Treat the wipe as a rare event and test the UX on real devices.
- The SW gateway ships a manual escape hatch worth copying: `?ipfs-sw-unregister=true` makes the SW unregister itself. [S4]

Confidence: **High** for Chromium 156; **Low** for other engines (Firefox and Safari untested; MDN calls the header "Baseline widely available" since September 2023 with partial parts). Design-critical: **yes** (v0.2 has an owner-level kill switch and superseded-version deletion, but no hub-level takedown for installed visitors).

### F10. Edge denylist: production precedent and our implementations

- **IPFS SW gateway** (docs/BADBITS.md): per-CID subdomains "refuse hosts on the Bad Bits denylist with `410 Gone`, before the service worker installer is served"; about **60k refused requests per day** on inbrowser.link; list about **513k entries**, stored as 4,096 KV shards (5-10 KB each) plus a 4-byte-prefix index (about 2 MB) because per-request shard reads pushed subdomain p95 TTFB from about 60 ms to about 300 ms; new entries live "usually within about 8 minutes" (5 min sync + 60 s KV edge cache + 120 s shard reuse, worst case about 16 min); **fails open and loudly** (`badbits_lookup_error`), a deploy gate refuses to deploy unless the list has >= 450,000 entries and was synced in the last 24 h, a status endpoint (`/ipfs-sw-badbits-status`: 200 when the sync is under 2 h old, 503 otherwise) feeds a Cloudflare health check; blocks are added by *secret* because plain variables are removed by the next deploy. Until September 2026 the same check ran in Rainbow, the origin; moving the origin to Cloudflare Pages "removed that enforcement", which is why the Worker exists. [S4]
- The list format is public: the **Compact Denylist Format** (`.deny` files, double-hashed anchors `sha256("<cid>/<path>")`, append-only with negative items, 2023-08-24). [S29]
- Our reference (`labs/w2c-04-hub-reference/`): the same policy in three runtimes, written against ARCH v0.2. All implement: host must be `<label>.<sites-domain>` (else 421), label must match `^[a-z2-7]{32}$` (else 404), denylist (451 + `Clear-Site-Data: "storage"` + `Link: <policy>; rel="blocked-by"`, on **every** path including `/mw-sw.js`, fail open), `/_mw/hub/status`, other `/_mw/hub/*` is a real 404, physical shell files (`/mw-sw.js`, `/mw-sw-kill.js`, `/build.json`, `/_mw/*`) reach the origin unchanged so a miss stays a miss, only document navigations fall back to `/index.html`, subresource-looking misses are real 404s. Verified: **10 unit tests** for the CloudFront Function with a fake `cloudfront` module (Node 24), **7 mock tests** for the Worker, and **18 curl probes** against stock **Caddy 2.11.7** running `Caddyfile.test` (`tls internal`, port 18443) after earlier rounds against drafts. **Not verified:** the real CloudFront Functions runtime (run `aws cloudfront test-function`), a real Workers deploy, and Caddy with a DNS-01 provider module (stock Caddy rejects `dns cloudflare`: "module not registered").
- This is the **delivery mechanism** for w2b-06's L1 (hub gate) and R3 (signed, double-hashed client denylist `/_mw/deny.json`): the edge enforces on the first request of a label; the loader enforces after it has parsed the pointer (owner key, `btih`, file hashes). The KeyValueStore keeps cleartext labels (private to the operator); the public list is hashed. Use one source file (`denylist.tsv` with reason and `ref`) to generate both.
- w1-10 CFG-4's `mw-edge` function is a plain catch-all rewrite to `/index.html` for everything outside an allowlist, so a missing hashed script would come back as `200 text/html`; the function here replaces it for hubs (and its allowlist is v0.1 naming: `/sw.js`, `/v/*`).
- KeyValueStore propagation delay to all edges is **unknown** (AWS docs say updates are separate from code but give no number); measure it with the status endpoint after the first deploy.

Confidence: **High** (code and docs read; behaviour tested locally). Sources: [S4], [S29], [S18], [S20], [S31]. Design-critical: no, but it is the template for R3 below.

### F11. Abuse on gateways in 2026, and how operators respond

- **Netcraft, 2026-09-29** (summariser-extracted, Medium): "so far in 2026, Shipyard-maintained gateways account for 84%" of the IPFS fronting used by phishing sites Netcraft has taken down; `inbrowser.link` is the third most popular fronting gateway; gateway URLs let phishing "sit behind links that look like trusted domains"; takedowns are harder because "hosting and distribution are decoupled" and "content can reappear at the same content identifier"; Protocol Labs is expected to keep the Bad Bits denylist; the ecosystem may shift to gateways that do not enforce it; the article says risk should not be considered settled until new gateways have stable market share and known moderation policies. [S10]
- **IPFS's own abuse process** (docs, read today): web form `ipfs.fyi/report-abuse` or `abuse@ipfs.io`; requests are vetted by a takedown team, added to takedown lists, blocked content returns **HTTP 410**; "a single report covers all" three hostnames because they share a backend; the Foundation "does not host the data and cannot remove it from the network", and blocked content may still show from a browser's local cache. [S13]
- **Safe Browsing blast radius** (F6; w2b-06 F11 adds that Safe Browsing canonicalization strips the `#fragment` and matches host suffixes, so a listing of the parent can cover every label): one phishing CID took down a whole gateway domain twice in 2022 (OLD); one weekend of phishing took down statichost.eu in 2025. The nft.storage post lists what operators can do: subdomain-per-CID, a denylist, **block `text/html` if website hosting is not the point**, send restrictive headers (CSP, `Permissions-Policy`, `Clear-Site-Data`), and apply for the PSL. [S11, S12]
- **Hosting vs reporting URL:** ar.io found that abuse reporters paste the *bare sandbox URL*, so the denylist must be answered on every URL form of a site (they added 451/404 at the bare sandbox root). [S15]
- **Whack-a-mole scale:** the Bad Bits list is about 513k entries and inbrowser.link alone refuses about 60k requests/day. Sokoto et al. (USENIX Security 2024, read through w2b-06 F10) measured that re-adding the same content under a different hash evaded blocking of 97.4% of blocked CIDs on 56 of the 57 gateways that blocked anything. A phishing kit can likewise mint a fresh BitTorrent infohash per variant at no cost, and a bare-magnet label is `base32(btih)`, so **label-only denylists are weak for magnet-web**; add owner-key bans (enforced in the loader after the pointer is parsed), per-file SHA-256 entries (drop-in already publishes them), and plan for hash-prefix/shard formats if the list grows (F10). An ar.io content-scanner repository (rule-based plus ML phishing detection) turned up in a search snippet but returned 404 when fetched: **unverified**.

Confidence: **Medium-High** (primary docs for the process; Netcraft figures via summariser). Design-critical: no (but it sets the minimum abuse program, R5).

### F12. The loader and the hostile site share an origin: hub warnings are not trustworthy UI

In per-site-origin mode the site runs in an iframe with `allow-same-origin` at the same origin as the loader (needed for the SW, F1). Site JavaScript can therefore reach `window.parent.document` and remove or restyle any banner, consent prompt or "publisher key changed" dialog, call `sign()` on the loader's non-extractable key, and read the loader's IndexedDB (security review B1/M3/M4/m2). A hub warning ("untrusted content") drawn by the loader is advisory at best.

Responses that do work: (a) show the warning/interstitial on the **apex before** navigating to `<label>.<hub>` (v0.2 section 3.2 already routes through the gate; w2b-06 R4 adds: the apex serves the gate only, with an allowlist default); (b) default-deny powerful features with `Permissions-Policy` on every hub response (the policy intersects with iframe `allow`, so hostile content cannot ask for camera, microphone, geolocation, USB, serial, HID, payment, ...); (c) no `allow-modals`; (d) unreadable hash labels give no brand-impersonating hostname (F2); (e) fast label and owner-key bans (F10/F11). A cross-origin wrapper (control-plane page framing the label origin) would give trustworthy chrome but splits storage by top-level site (third-party storage partitioning) and needs a postMessage bridge; not evaluated here.

Confidence: **High** (follows from the same-origin model and the existing review). Design-critical: **yes**.

### F13. Economics: sponsored free gateways are ending; what a hub costs

**Precedent facts (2026).** The 429/`Sunset` response and the retirement page were read directly (High); the blog contents below are summariser-extracted (Medium).
- Cloudflare retired its public IPFS gateway: traffic moved 2024-05-14, hostnames stopped connecting 2024-08-14. [S14]
- IPFS gateways `ipfs.io`/`dweb.link`: Shipyard announced on 2026-08-24 that it would stop on 2026-09-30 because "Protocol Labs has informed us that it will not be renewing Shipyard's funding"; it says it re-architected its gateway infrastructure to handle roughly 3x more traffic while cutting operating and maintenance costs by around 80% (paraphrased from a summariser-extracted page). The IPFS blog (2026-08-25) says IPFS sees "roughly 250 million requests per day", is "moving away from subsidizing retrieval bandwidth", redirects browsers to `inbrowser.link`, rate-limits hotlinked and backend traffic, and points backends to self-hosted Rainbow/Kubo or paid pinning/retrieval providers (including x402/MPP pay-per-request options). The retirement page (`gatewaychanges.ipfs.io`, last modified 2026-08-31) says the gateway "steps aside a little each hour" from 2026-09-01 until it "retires for good on September 21 (UTC)"; on 2026-10-17 my `curl -I` to both hosts returned **HTTP 429 with `Sunset: Mon, 21 Sep 2026 00:00:00 GMT`**. [S5-S8]
- Traffic mix of those gateways on 2025-05-12..14 (their analysis, abuse filtered): browsers **9.2% of bandwidth / 9.4% of requests**, hot-linking/apps 21.3% / 23.1%, automated clients 69.5% / 67.4%. A magnet-web hub cannot be hot-linked or scripted (rendering needs a SW and WebRTC), so its traffic is human-shaped by construction. [S9]
- The SW gateway's maintainers: "created by the Shipyard team, who maintained it in 2024, 2025 and 2026"; "@nymd and @byo maintain it now, on behalf of the IPFS Foundation"; `gateway-conformance` has "no dedicated maintainer at the moment". [S4, S29]

**Cost model for a shell-only hub** (assumptions: 150,000 B brotli per cold origin visit, 8 HTTPS requests, 3 function/Worker invocations for the navigation, `/mw-sw.js` and the status ping with one KV read each, loader assets served without a function; planning figures; measured parts: `webtorrent.min.js` 222,929 B raw = 64,571 B gzip-9 = **55,969 B brotli-11**; the *unminified* loader/chain/sw/sdk sources present when measured were 167,447 B raw = 46,207 B brotli; the final bundle is not built yet). Prices: AWS price list 2026-10-03, Cloudflare docs, read 2026-10-17.

| Deployment | Cold visit | Per 1M cold visits | Notes |
|---|---|---|---|
| CloudFront pay-as-you-go (US/CA/EU) | $0.0000211 | **$21.14** (transfer 12.75, requests 8.00, functions 0.30, KVS 0.09) | warm visit (status ping only) $1.13 per 1M; plus WAF $6/month fixed if used |
| CloudFront flat-rate Pro $15/month | at allowance | $12.00 | 10M requests = about 1.25M cold visits/month; includes WAF, KVS, Route 53 zone, TLS |
| CloudFront flat-rate Free $0 | - | - | 1M requests/month = about 125k cold visits; **no KeyValueStore**, so no edge denylist |
| Cloudflare Workers Paid ($5/month) | $0.0000024 beyond the included 10M Worker requests | **$2.40** | static asset requests are free and unlimited; about 3.3M cold visits/month fit in the included requests |
| Cloudflare Workers Free | - | - | 100,000 Worker requests/day (about 33,000 cold visits/day) then HTTP 429 for `run_worker_first` routes; 10 ms CPU; KV free tier 100k reads/day, 1k writes/day |
| Caddy on a VPS | bandwidth only | provider-dependent | wildcard cert by DNS-01; Hetzner billing FAQ uses 20 TB included as its example, price per TB not retrieved (unverified) |

**Web-seed mirror** (`create-torrent` default piece 256 KiB = 4,096 range requests per GiB). Per GiB served: CloudFront PAYG $0.0954; R2 direct $0.0015 (Class B reads $0.36/M, egress free); Bunny Standard EU/NA $0.0107, Volume $0.0054; B2 with a partner CDN: egress free, storage $6.95/TB-month. Scenario 100,000 cold visitors x 50 MiB site (4,883 GiB total):

| If peers serve | CloudFront PAYG | R2 direct | Bunny Standard | Bunny Volume |
|---|---|---|---|---|
| 0% | $465.64 | $7.20 | $52.43 | $26.21 |
| 80% | $93.13 | $1.44 | $10.49 | $5.24 |

R2 storage for 10,000 sites x 50 MiB = $7.32/month; B2 = $3.31/month. **Cloudflare CDN terms:** on Free/Pro/Business, serving "video or a disproportionate percentage of pictures, audio files, or other large files" through the CDN without Paid Services (the Developer Platform, Images, Stream) can get access restricted; serve web seeds from R2 or Workers, not from a proxied bucket host. [S19, S24]

Confidence: **High** for prices and arithmetic, **Medium** for the per-visit assumptions. Design-critical: no, except the conclusion that a hub must not proxy site content.

### F14. Legal and standards levers for the operator (overview; `w2b-06-abuse-legal-ops.md` owns the analysis)

- **EU DSA (Regulation (EU) 2022/2065)**, text read via EUR-Lex: Art. 4 mere conduit, Art. 5 caching, Art. 6 hosting (no liability if no actual knowledge, and "upon obtaining such knowledge ... acts expeditiously to remove or to disable access"), Art. 8 no general monitoring, Arts. 11-12 single points of contact for authorities and recipients, Art. 13 legal representative for non-EU providers, **Art. 16 notice-and-action** for hosting services (electronic, substantiated notices with exact URL), Art. 19 exemptions for micro and small enterprises from some platform duties. Whether a shell-only hub is a "hosting service" at all is open; a hub that hosts a **directory** is.
- **US**: a service provider must register a DMCA agent with the Copyright Office and publish the same details on its site (online directory; fee and renewal interval not read); 18 U.S.C. 2258A and CDA 230 were **not** read in this wave.
- **Canada**: Copyright Act s. 41.25 lets a rights holder send a notice of claimed infringement to a person who provides digital memory or an information location tool (no settlement demands allowed); s. 41.26 consequences were **not** read.
- **Standards that make the operator discoverable and the block explicit:** RFC 2142 (`ABUSE@domain` mailbox), RFC 9116 `security.txt` (`Contact` and `Expires` are mandatory; served at `/.well-known/security.txt`), RFC 7725 HTTP 451 with `Link: <...>; rel="blocked-by"` naming the entity that implements the block, RFC 8615 well-known URIs (new names need IANA "Specification Required"). [S25, S27]
- Hubs also face registrar/DNS risk (single domain), TLS-issuer risk and the Safe Browsing risk of F6; keep the sites domain separate from the domain that carries the abuse mailbox.

w2b-06 reads the statutes and cases in depth (it cites Cox v. Sony, DSA Art. 16(3) as actual knowledge, Ziggo, s.512 mechanics, mandatory reporting; I did not re-verify those citations) and ends with a takedown ladder L0-L5; this section only lists what an operator must have in place.

Confidence: **Medium** (statutes partly read here). Design-critical: no. **Get qualified counsel before running a public hub.**

### F15. Directory, discovery and federation: precedents, a legal constraint, and a proposal

Precedents (what exists, read today):
- **IPFS public-gateway-checker**: community `gateways.json` (PR to add), column "Origin" with a warning that gateways without isolation "share localStorage, cookies, and session data"; "No central authority governs this list". Its checks run in the visitor's own browser (w2b-04 F18). [S29]
- **IPFS gateway-conformance**: vendor-neutral suite with `--specs +subdomain-gateway,-path-gateway`, Docker image, JSON report; used by Kubo, boxo, Rainbow, SW gateway CI; currently maintainer-less. [S29]
- **Nostr**: NIP-11 relay information document (static JSON at the relay URL with CORS, `name`, `description`, `pubkey`, `contact`, `terms_of_service`, `software`, `version`, `limitation`...), NIP-66 relay discovery/liveness by independent **monitors** publishing signed events (status `draft`), NIP-56 reports (kind 1984, report types incl. `malware`, `illegal`, `spam`, `impersonation`). [S26]
- **Matrix moderation policy lists**: bans as replicated state events (`m.policy.rule.user|room|server`, `entity` glob, `reason`, `recommendation: m.ban`); "the entity making the decisions on filtering is best positioned to interpret the rules"; subscription deliberately left to implementations. [S26]
- **AT Protocol labels**: self-authenticating annotations (`src`, `uri`, `cid`, `val`, `neg`, `cts`, `exp`, `sig`), signed over deterministic CBOR; clients choose labelers via a header; negation retracts. [S26]

**Legal constraint on a directory (w2b-06 F5/R4, not re-derived here):** a hub-run index or search over sites is the feature that most raises legal risk (CJEU Ziggo: "indexation of metadata ... and the provision of a search engine" can be a communication to the public); w2b-06 R4 therefore recommends an **apex that serves the gate only, an allowlist default, and no directory, search, "recent sites" or recommendation feed** unless the operator runs full notice-and-action. So my earlier idea of a hub-owned directory ledger is demoted: it is P3, conditional on counsel, and the safer shape is a directory that is just an ordinary magnet-web site run by someone else.

Proposal (Low confidence: design, no precedent for torrent-site hubs):
1. **Hub descriptor** `/.well-known/magnet-web/hub.json` (CORS `*`), shaped like NIP-11: sites domain, label grammar, operator contacts (abuse, security.txt, policy, takedown policy, DMCA agent), deny-list URL and key, services (trackers, web seed, DoH), mode (`allowlist` default or `open`), mirrors. Example: `spec/hub.example.json`. Registering the name in the IANA well-known registry needs "Specification Required" (RFC 8615; w2c-06 says the same).
2. **Deny list:** adopt w2b-06 R3's `/_mw/deny.json` (signed, double-hashed entries `{k, h, r, ref, t}`, monotonic `seq`, `exp`) and serve the same file on the apex and on every label origin (it lives in the shell bucket, so there is no cross-origin fetch). Removal is a new list with `seq+1` without the entry (AT Protocol's `neg` is not needed for a full-list model). Example with real hashes: `spec/deny.example.json`.
3. **One probe tool, not three:** ARCH section 10 has `check-site.mjs`, w1-10 REC-14 proposes `verify-deploy.mjs`, w2c-05 R-14 proposes `host-check.mjs`; add the hub checks (label grammar, 421/404/451, status ping, `/_mw/hub/*`, headers, no `Set-Cookie`, CORS on the web seed) as a `--hub` mode of whichever survives.
4. **Interchangeability, not shared state:** the same btih under two hubs is two origins, so identity key, ledger database and pins do not follow (w2c-03 R7 gates persistent identities on origin isolation for the same reason); document it, and let the identity-UX work provide export/import.

Design-critical: no (proposals), but R11-R12 depend on it.

### F16. Testing a hub at production grade: what I could measure

- `http://<32-char label>.hub.localhost:PORT` in Chromium 156: `isSecureContext: true`, `crypto.subtle` present, SW registers with scope = the label origin, and a second label sees neither the first's SW registration nor its localStorage (`lab/localhost-origins.mjs`, `results-localhost-origins.json`). MDN lists any host ending in `.localhost` as potentially trustworthy; Firefox and Safari behaviour not tested. This gives per-label isolation tests with no certificates and no DNS. [S31, S16]
- `Sec-Fetch-*` request headers are sent only to potentially trustworthy URLs (my plain-HTTP `hub-lab.test` run returned `null` for `Sec-Fetch-Site`; HTTPS with `--ignore-certificate-errors` returned values). [S16, S31]
- **Playwright default launch flags matter.** `playwright-core` 1.64.1 passes `--disable-features=...,ThirdPartyStoragePartitioning,...` and `--disable-field-trial-config`. In my first run through `chromium.launch()` the PSL stand-ins showed 1 server hit for a cross-site cached script (cache shared); launching Chrome for Testing directly with minimal flags and attaching with `connectOverCDP` showed 2 (partitioned), as documented. Any e2e that asserts storage/cache partitioning must use a direct launch (`lab/chrome.mjs`). [S31]
- Terraform: `terraform fmt -check` and `terraform validate` pass for `labs/w2c-04-hub-reference/aws` with AWS provider 6.69.1 (the schemas include `aws_cloudfront_function.key_value_store_associations`, `aws_cloudfront_key_value_store`, `aws_cloudfrontkeyvaluestore_key`, `aws_cloudfront_distribution_tenant`, `aws_cloudfront_multitenant_distribution`). **No `plan` or `apply` was run** (no credentials). [S31]
- Not tested: Firefox, Safari, iOS, real CDN behaviour (edge cache sharing across labels, KVS propagation).

Confidence: **High** for what was run.

---

## Delta to ARCHITECTURE.md v0.2 (what this research adds or changes)

v0.2 already contains: per-site subdomain hubs with `label = base32(sha256(ledgerId))[0:32]` or `base32(btih)` (section 3.2, `hubLabelFor`), wildcard certificate and "should list the hub suffix on the Public Suffix List", the shared-origin hub as demo-only behind a blocking interstitial (3.3), the gate before any tracker or peer connection (section 8), an owner-level kill switch `mw-sw-kill.js` (7.1) and superseded-version deletion (5.8).

| Section | v0.2 says | Change proposed here |
|---|---|---|
| 3.2 label | `^[a-z2-7]{32}\.` | keep; enforce at the **edge** and require the hostname to end in a **configured** sites domain; add test vectors (Appendix B) |
| 3.2 PSL | "should list the hub suffix on the PSL" | keep as a target, add the fallback in F6/F7 (separate registrable domain, cookie-free, apply at launch) because acceptance is gated; w1-11 R3 would make it a MUST |
| 3.2 share links | pointer from the fragment or the cache | a signed label cannot be reversed to a pointer: "copy link" must emit `https://<label>.hub/#<pointer>` or `#host:example.com`; bare-magnet labels decode to the btih |
| 3.1 / 3.2 reserved paths | `/_mw/*`, `/mw-sw.js`, `/ws/*`, `/.mw/*` | add `/_mw/hub/status` (network-only; generated by the edge; never precached or intercepted by the SW) |
| 5 loader flow | no hub takedown step | boot step "hub status ping" before render; on 451 wipe, stop the engine, show a tombstone (R3) |
| 5.8 "Updates and takedown" | only superseded versions | add the hub-level takedown path (F9) and cross-reference w2b-06 L1/L2/R3 |
| 7.1 SW routing | `/_mw/*` to the precache | exempt `/_mw/hub/*` (pass through, never cache); keep `/mw-sw.js` `no-cache` |
| 7.1 kill switch | owner deploys `mw-sw-kill.js` | note that it removes the registration but not IndexedDB/localStorage (F9); the hub-level lever is `Clear-Site-Data: "storage"` |
| 8 policy | `maxSiteBytes`, storage budget 512 MiB / 128 MiB | document as advisory against same-origin hostile JavaScript (F8) |
| 10 tooling | `check-site.mjs`, `dev-server.mjs` | add `--hub` checks (F15); `deny.json` signer; a `*.localhost` option in `dev-server` for multi-label e2e |
| 13 security | shell CSP, framing headers | add the hub response-header set (R9), `Permissions-Policy` default-deny, `X-Robots-Tag`, `Origin-Agent-Cluster` |
| 12 tests | (8) hub gate, (9) kill switch | add: two labels isolated (`*.localhost`), 451 path with a local edge stub, status ping not intercepted by the SW |

### Reconciliation with neighbouring notes

| Topic | Neighbour says | This note | Resolution |
|---|---|---|---|
| PSL | w1-11 R3: SHOULD becomes MUST for multi-publisher hubs | the Guidelines say small projects ("not serving more than thousands of users") are quite likely to be declined, 2 years of registration needed, no SLA | keep the PSL as the goal, make "separate registrable domain + no cookies + abuse program + documented residual risks" the launch condition, re-apply with usage evidence |
| Directory | w2b-06 R4: no hub-run directory or search | my first draft proposed a hub-owned directory ledger | withdrawn; P3 and conditional |
| Deny list format | w2b-06 R3: signed, double-hashed `/_mw/deny.json` | my first draft proposed an AT-Protocol-shaped labels file | use w2b-06's format; this note adds edge enforcement and the status ping |
| Kill switch | w2b-05 F20/F21: `Clear-Site-Data: "storage"` on the SW script response; tombstone SW leaves IndexedDB | measured the same, plus non-2xx responses, fetch/navigation, sibling scope | consistent; the hub lever is Clear-Site-Data, the owner lever is the tombstone SW |
| Edge function | w1-10 CFG-4 `mw-edge`: catch-all rewrite to `/index.html`, v0.1 names | grammar + denylist + real 404s, v0.2 names | replace for hubs |
| Probe tools | ARCH `check-site.mjs`, w1-10 REC-14 `verify-deploy.mjs`, w2c-05 R-14 `host-check.mjs` | I proposed a `hub-conformance` suite | fold into one tool with a `--hub` mode |
| Labels | DESIGN-REVIEW 6: ledger-derived label wins over R04's btih label | my first draft proposed hex40 / 52-char labels | superseded by `^[a-z2-7]{32}$`; the 52-char canonical rule only matters if v2 returns |
| SW update timing | spec: stale after 86,400 s | w2b-05 F24 and F9 here: Chromium re-fetches about 2-3 s after a navigation | use the measured behaviour for Chromium, the spec floor elsewhere |

---

## Concrete recommendations for magnet-web

Effort: S = under a day, M = a few days, L = a week or more. Priority: P0 = before any public hub, P1 = before calling the hub production-ready, P2 = soon after, P3 = later/optional. "w2b-06 Rn" are the abuse/legal note's recommendations, which these items extend, not duplicate.

| ID | Recommendation | Effort | Priority | Why (evidence) |
|---|---|---|---|---|
| R1 | **Enforce the v0.2 label grammar** `^[a-z2-7]{32}$` at the edge (reference `edge.js`, `worker.js`, `hub-sites.caddy`) and in the loader, with `location.hostname` required to end in a **configured** sites domain (today `render.js` has the v0.1 `WILDCARD_HOST_RE` for 40 hex and accepts any host that starts with one). Add the test vectors of Appendix B to `test/unit`. | S | **P0** | F2, F3; vanity hostnames are a phishing aid; edge and loader must agree |
| R2 | **Share links that survive a cache loss:** the loader's "copy link" and the apex gate emit `https://<label>.hub/#<pointer>` (or `#host:example.com`, short and DNS-recoverable); for a signed label verify `hubLabelFor(record, ledgerId) === label` before rendering; document that a bare signed-label URL cannot reload after eviction. | S | **P0** | F2/F3 consequence (b); Safari 7-day eviction (F8) |
| R3 | **Takedown path for installed visitors** (F9): edge answers 451 + `Clear-Site-Data: "storage"` + `Link: rel="blocked-by"` on every path of a denylisted label (including `/mw-sw.js`); loader pings `GET /_mw/hub/status` (`cache:'no-store'`, 3 s timeout, fail open) at every boot; the SW passes `/_mw/hub/*` through uncached; on 451 the loader wipes registrations/caches/IndexedDB/localStorage itself, stops the engine, shows a tombstone with the policy link; add `?mw-unregister=1`. Never send `"cookies"`. | M | **P0** | F9 (measured), F10; extends DESIGN-REVIEW 20/21 and w2b-06 L1/L2 |
| R4 | **Domain plan:** sites domain separate from the control-plane domain (and from the `abuse@` domain); no cookies and no sessions on the sites domain; register >= 2 years; CAA limited to the CA you use; Search Console domain properties for both; apply to the PSL at launch and again with usage evidence; `_psl` TXT stays in place. | S | **P0** | F6, F7; statichost.eu and nftstorage.link incidents; w1-11 R3 |
| R5 | **Minimum abuse program** before launch: `abuse@` mailbox (RFC 2142), `security.txt` on both domains (RFC 9116), policy and takedown-policy pages, "Report this site" in the loader banner (prefilled with label and `btih`), a documented SLA and time-to-block drill, a denylist pipeline with an audit trail, DMCA agent if US-facing, DSA contact point if EU-facing. Counsel review. This is w2b-06 R4/R5/R7. | S (M with counsel) | **P0** | F11, F14 |
| R6 | Ship the **reference hub** as `deploy/hub/` + DEPLOY.md (AWS Terraform, Cloudflare Workers, Caddy) with CI: `edge.test.mjs`, `worker.test.mjs`, `caddy validate` + curl probes, `terraform fmt/validate`. Satisfies w1-10 REC-8 and REC-15. | M | P1 | this folder; F10, F16 |
| R7 | **Hub checks in the one probe tool** (`check-site.mjs` / `verify-deploy.mjs` / `host-check.mjs`, F15): grammar, 421/404/451, status ping, `/_mw/hub/*`, missing-subresource 404, headers, no `Set-Cookie`, CORS on the web seed, `*.localhost` isolation; run against a deployed hub and in CI. Launch Chrome directly for any partitioning assertion. | M | P1 | F15, F16; ipfs/gateway-conformance precedent |
| R8 | **Update ARCHITECTURE.md and DEPLOY.md** per the Delta table; add the host-capability table of F4 (Pages and Workers Custom Domains cannot, Workers routes can). | S | P1 | F4, F8 |
| R9 | **Standard response headers on every hub response** (reference `main.tf` / `hub-sites.caddy` / `worker.js`): HSTS, nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`, the section-13 CSP (< 1,783 chars for CloudFront), `Permissions-Policy` default-deny, `Origin-Agent-Cluster: ?1`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, `X-Robots-Tag: noindex, nofollow`. | S | P1 | F12; `x-robots-tag: noindex, nofollow` observed on dweb.link and inbrowser.link responses |
| R10 | **Apex = gate only; allowlist default** (w2b-06 R4): the apex never renders third-party content; production hubs refuse unknown labels unless the operator has accepted "open hub" in writing; no directory, search or "recent sites". | S | P1 | F12, F15 |
| R11 | **Signed deny list** per w2b-06 R3, served as `/_mw/deny.json` on the apex and every label origin; edge KeyValueStore/KV holds cleartext labels, the public list is hashed; one source file (`denylist.tsv` with `ref`) generates both; owner-key and per-file-hash entries because a re-packed torrent gets a new infohash. | M | P2 | F10, F11; Sokoto et al. via w2b-06 F10 |
| R12 | Hub **directory** (only after counsel, never operator-run by default): demoted from my first draft. If wanted, an operator-curated allowlist behind full notice-and-action or an ordinary magnet-web site run by a third party. | L | P3 | F15; w2b-06 R4 (Ziggo) |
| R13 | **Cost guardrails:** default to Cloudflare Workers static assets or CloudFront Pro flat-rate; AWS Budgets + alarms; per-IP WAF rule; CI budget on shell size (target <= 150 KB brotli; `webtorrent.min.js` alone is 55,969 B); web seeds on R2 or B2 + partner CDN, never on a proxied Free-plan CDN host. | S | P2 | F13 |
| R14 | **Synthetics and monitoring:** after each deploy a headless-Chrome canary loads a canary label (SW active, status ping 200, tiny site renders); alarms on `kvs_error` / `denylist_lookup_error`, certificate expiry, 4xx/5xx; measure KeyValueStore propagation with a test label. | M | P2 | F10, F16; w2b-04 |
| R15 | **Multi-label `*.localhost` e2e** in `test/e2e` (two labels, per-label SW and storage, status ping, 451 path with a local edge stub) and a direct-Chrome launch helper. | S | P2 | F16 |
| R16 | **BYO-domain hosting** for per-domain mode (goal 1: existing sites migrate easily need the loader at their own domain): Cloudflare for SaaS (100 custom hostnames included, $0.10 each beyond, max 50,000; wildcard custom hostnames Enterprise-only) or CloudFront multi-tenant distributions (quota 10,000 tenants; price not read). Only if you want to offer managed hosting. | M | P2 | F4, F5 |
| R17 | **HSTS preload** for the sites domain once stable (`includeSubDomains; preload`, max-age >= 31536000); irreversible in practice. | S | P3 | hstspreload.org warnings |
| R18 | **PSL application** when eligible (PR + `_psl` TXT; >= 2 years left; usage evidence); track propagation per browser. | S | P3 | F6 |
| R19 | *Unproven:* shard labels over N registrable domains (first label character) to bound a Safe Browsing verdict if the PSL is unavailable and incidents occur. No precedent found. | M | P3 | F6 |

---

## Reference hub deployment

Directory: `docs/research/labs/w2c-04-hub-reference/` (about 150 KB with the lab results, no secrets, no generated state). Written against ARCHITECTURE.md v0.2: 32-character base32 labels (section 3.2), host layout `/index.html`, `/404.html`, `/mw-sw.js`, `/mw-sw-kill.js`, `/build.json` and physical loader assets under `/_mw/*` (sections 3.1 and 10).

### Topology

```
 control plane  hub.example                          sites domain  hub-sites.example   (separate registrable domain; PSL candidate)
 -------------------------------------               ----------------------------------------------------------------------------
 apex GATE (ARCH 3.2 / section 8), docs,             *.hub-sites.example  --DNS wildcard alias-->  CDN / Worker / Caddy
 policy + abuse pages, hub.json, deny.json,           1. host = <label>.hub-sites.example, label ^[a-z2-7]{32}$ else 404 (421 if foreign host)
 security.txt, status page                            2. denylist (KeyValueStore / KV / map) -> 451 + Clear-Site-Data "storage" (fail open),
 NO cookies on either domain                              on EVERY path incl. /mw-sw.js
 abuse@ mailbox lives HERE (not on the sites domain)  3. /_mw/hub/status -> 200 (network-only ping for returning visitors)
 no directory, no search (w2b-06 R4)                  4. /_mw/* (loader assets), /mw-sw.js, /mw-sw-kill.js, /build.json -> origin as-is
                                                         (/mw-sw.js no-cache; /_mw/* short TTL; a miss stays a real 404)
                                                      5. document navigation (Sec-Fetch-Dest: document, or extension-less / .html path)
                                                         -> /index.html; everything else that misses -> real 404
                                                      one wildcard certificate; one cached shell shared by all labels
```

### Request flows

1. **First visit from a magnet link.** `magnet:` handler or paste -> `https://hub.example/#magnet:?xt=urn:btih:H&tr=...&ws=...` -> apex gate (ARCH section 8: nothing connects before the click) -> `location.assign('https://<label>.hub-sites.example/#<pointer>')` (the fragment carries the pointer; servers never see it) -> edge: grammar ok, denylist miss -> shell -> loader registers `/mw-sw.js`, pings `/_mw/hub/status` (200), vets the pointer, fetches the torrent from peers/web seed, renders in the same-URL iframe.
2. **Returning visit.** The SW serves the shell and the cached site from the browser; the loader pings `/_mw/hub/status`: 200 -> continue; 451 -> wipe, stop the engine, tombstone. In Chromium the browser's own SW update fetch (about 2-3 s after the navigation) also hits the edge.
3. **Takedown.** Operator appends the label to `denylist.tsv` -> `denylist-sync.sh` updates the KeyValueStore (or `wrangler kv key put`, or regenerate `denylist.caddy` + `caddy reload`) and the public `/_mw/deny.json` is re-signed -> new visitors receive the 451 page; returning visitors receive 451 on the update fetch and the status ping and wipe themselves. Also remove the object prefix from the web-seed bucket and file the Safe Browsing review if the domain was flagged.

### Files and verification status

| Path | What | Verified how |
|---|---|---|
| `aws/edge.js` | CloudFront Function (viewer-request, JS 2.0, KVS) | `aws/edge.test.mjs`: 10 tests pass under Node with a fake `cloudfront` module; **not** run on the real runtime (use `aws cloudfront test-function`) |
| `aws/{versions,variables,main,outputs}.tf` | S3 + OAC, ACM wildcard (us-east-1), KVS, function, cache/headers policies, WAF rate rule, distribution with behaviors `/_mw/hub/*` (function), `/_mw/*` (no function), default (function), Route 53 wildcard + apex + CAA + `_psl` | `terraform fmt -check` + `terraform validate` pass (Terraform 1.16.6, aws 6.69.1); **no plan/apply** |
| `aws/deploy-shell.sh`, `aws/denylist-sync.sh` | publish the v0.2 `dist/` layout with the right cache/MIME and invalidate `/*`; sync `denylist.tsv` to KVS in <= 50-key all-or-nothing batches | `bash -n`; `denylist-sync.sh --dry-run` diff logic tested with a fake current state; AWS calls **not** run |
| `caddy/{Caddyfile,hub-sites.caddy,denylist.caddy}` | VPS variant, wildcard cert by DNS-01 | `Caddyfile.test` (same body, `tls internal`) validated and probed with 18 curl requests on stock Caddy 2.11.7; production `Caddyfile` needs a build with your DNS module (stock Caddy: "module not registered: dns.providers.cloudflare") |
| `cloudflare/{worker.js,wrangler.toml,_headers}` | Workers + static assets variant, KV denylist; `run_worker_first` excludes the loader assets `/_mw/*.js`, `*.css`, `*.svg` and `*.webmanifest` by extension so `/_mw/hub/status` and `/mw-sw.js` still reach the Worker | `cloudflare/worker.test.mjs`: 7 mock tests pass; **not deployed** |
| `spec/{hub.example.json,deny.example.json,security.txt.example}` | proposed hub descriptor, w2b-06-shaped signed deny list (real sha256 values), RFC 9116 file | parsed with `jq`; formats are proposals |
| `lab/*.mjs`, `lab/results-*.json` | the Chromium measurements behind F7, F9, F16 | re-runnable: `node lab/psl-effects.mjs`, `localhost-origins.mjs`, `takedown-mechanics.mjs`, `csd-scope.mjs`, `csd-status-codes.mjs`, `csd-on-sw-update.mjs` (need the repo's `playwright` dev dependency and Chrome for Testing) |

Run the tests: `node --test docs/research/labs/w2c-04-hub-reference/aws/edge.test.mjs docs/research/labs/w2c-04-hub-reference/cloudflare/worker.test.mjs`.

### Deploy checklist (AWS variant)

1. Register `hub-sites.example` for >= 2 years (separate from `hub.example`); create the Route 53 zone; (later) Search Console domain properties.
2. `terraform apply` with `sites_domain`, `sites_zone_id`, `control_domain`, `bucket_name`; wait for ACM DNS validation and the distribution (CloudFront deployments take minutes).
3. Build the loader (`tools/build.mjs`, specified in ARCHITECTURE.md section 10 but not in the repo yet), then `aws/deploy-shell.sh dist <bucket> <distribution-id>`.
4. Seed the KVS with a **test label** and confirm: 451 page, 451 on `/mw-sw.js`, status ping 451, `Clear-Site-Data` honoured in Chrome; time the propagation.
5. Publish `hub.json`, `deny.json`, `security.txt`, policy pages on the control plane; test the abuse mailbox end to end.
6. Run the hub checks (R7) and the canary (R14); only then announce the hub.
7. Optional: subscribe the distribution to a flat-rate plan (Pro for KeyValueStore; WAF is mandatory; one apex domain per plan; wildcard aliases on a plan **unverified**).

### Operating runbook (events -> action)

| Event | First action | Notes |
|---|---|---|
| Phishing/malware report for a label | add label (and owner key if signed, file hash if known) to the denylist; confirm 451 and status ping; reply to reporter | target hours, not days; Netcraft/APWG/Safe Browsing reports arrive by email |
| Safe Browsing warning on the sites domain | remove the offending labels first, then use Search Console "request review" | in 2022 review took hours via backchannel and "up to 72 hours" officially (OLD) |
| Court order / legal demand | counsel; if blocking, use 451 with `blocked-by`, keep an audit record | RFC 7725 |
| Copyright notice | follow the published DMCA / notice-and-notice procedure; block label; keep the notice | agent registration first (w2b-06 F2) |
| CSAM report | block immediately, preserve and report as the local law requires (counsel) | w2b-06 F8 and R10 |
| Edge denylist store failing | fails open by design: alert on `kvs_error`; consider temporary WAF block rules | IPFS gateway uses the same stance |
| Certificate renewal | ACM renews if the validation CNAME stays; Caddy renews automatically | do not delete the `_acme-challenge`/validation records |
| Cost spike | check Budgets; flat-rate plans cannot overrun; PAYG needs WAF rate rules | web seeds are the usual cause |

---

## Gotchas

1. **Wildcard certificate scope.** `*.example.com` covers one label only and not `example.com`; list the apex as a SAN. Cloudflare Universal SSL covers apex + first-level only: make the sites domain the zone apex (`hub-sites.example`), not `sites.hub.example`. CloudFront accepts only lower-case alternate names. [S18, S19]
2. **ACM for CloudFront lives in us-east-1**, as does the CLOUDFRONT-scope WAF ACL; wildcard and apex share one validation CNAME (`allow_overwrite = true` in Terraform).
3. **Never map 403/404 to `/index.html` with a CloudFront custom error response.** It returns `200 text/html` for missing scripts and poisons caches; the SW gateway lost a day to exactly this (#1155). Grant the OAC `s3:ListBucket` so S3 answers 404 (not 403) for missing keys.
4. **Wildcard DNS means any label resolves.** Without a grammar check anyone can mint `bank-login.hub-sites.example`; the edge must 404 non-address labels.
5. **A signed label is a hash.** `base32(sha256(ledgerId))[0:32]` cannot be turned back into a pointer, so a bare `https://<label>.hub/` link dies with the cache; share `.../#<pointer>` or `.../#host:example.com`. Bare-magnet labels decode to the btih but then lack trackers and web seeds.
6. **Use `Clear-Site-Data: "storage"` only.** `"cookies"` is registrable-domain-wide (MDN; measured: it clears the shared `Domain=` cookie of every sibling label); `"cache"` adds nothing needed and has partial support. The header is honoured on network responses, not on responses a SW synthesizes (w2b-05 F20).
7. **ARCH v0.2 section 7.1 sends `/_mw/*` to the precache.** Unless `/_mw/hub/*` is exempted, the SW answers the status ping from the cache and a takedown never lands for returning visitors.
8. **An installed SW never contacts the network on navigation**; the update fetch and the status ping are the only network contacts of a returning visitor. SW update timing: spec says stale after 24 h, Chromium re-fetches about 2-3 s after a navigation (debounced; w2b-05 F24).
9. **404/410 for the SW script does not uninstall a Service Worker** (measured in Chromium 156); a self-unregistering script removes the registration but not IndexedDB or localStorage.
10. **`Sec-Fetch-*` headers are sent only to potentially trustworthy URLs**; plain-HTTP tests on non-localhost names see `null`.
11. **Playwright's default flags disable `ThirdPartyStoragePartitioning`**; direct-launch Chrome for partitioning/cache tests.
12. **Flat-rate plan fine print**: Free has no KeyValueStore, WAF is mandatory, one apex domain per plan, 3 Free plans per account, AWS Free Tier accounts are ineligible, multi-tenant distributions unsupported, delivery may be "adjusted" after sustained overage.
13. **Workers Free**: `run_worker_first` routes return HTTP 429 once 100,000 requests/day are exceeded; `_headers` rules do not apply to Worker-generated responses; Snippets are not available on Free; negative `run_worker_first` patterns beat positive ones, so exclude `/_mw/` assets by extension, not by prefix.
14. **Let's Encrypt**: 50 certificates per registered domain per 7 days and 300 new orders per 3 hours per account; Caddy On-Demand TLS per label would hit it and also publish every label in CT logs. Use one wildcard certificate (DNS-01). The PSL maintainers refuse entries made only to dodge this limit.
15. **PSL timing and feasibility**: propagation to Safari/iOS follows OS releases; small projects are likely declined; keep the `_psl` TXT record; domains with < 1 year registration may be removed automatically.
16. **Cloudflare CDN terms** restrict large-file serving on Free/Pro/Business without Developer Platform products; keep web seeds on R2/Workers.
17. **Disk-fill and eviction**: a hostile origin can fill up to 60% of disk (Chromium/Safari) and LRU eviction then removes *other* origins first; the loader's quotas cannot stop same-origin JavaScript.
18. **Safari 7-day script-storage eviction** applies per origin (per site); rarely visited sites lose cached files, identity key and pins.
19. **A navigation right after a Clear-Site-Data wipe stalled in my harness** (same browser instance, more than 10 s, several times). Not root-caused; test on real devices before relying on it for UX.
20. **HSTS preload and `includeSubDomains` are effectively irreversible** (removal "takes months" to reach Chrome users).

---

## Open questions

1. How fast does a CloudFront KeyValueStore update reach all edges (seconds or minutes)? The SW gateway's KV design documents about 8 minutes end to end; measure ours with a test label.
2. Do **Firefox and Safari** honour `Clear-Site-Data: "storage"` for Service Worker registrations and Cache Storage on fetch, navigation and SW-script responses (including non-2xx), re-fetch the SW script soon after a navigation, and treat `*.localhost` as secure contexts with SW support? (Only Chromium 156 tested.)
3. Is a PSL entry realistic for a young hub ("thousands of users"), and does Safe Browsing really narrow to subdomains for listed suffixes? w2b-06 F11 documents fragment stripping and host-suffix matching but leaves the PSL effect unverified; ask the PSL maintainers and test with a controlled bad label before launch.
4. Pointer discovery for signed labels without a backend (fragment on first visit; cache; gossip; DNS TXT on a custom domain): the share-link problem of F3/R2 is partly a pointer-topic question.
5. Can a CloudFront **flat-rate plan** carry wildcard alternate names and a KeyValueStore-backed function together (docs list KVS under Pro; wildcard not mentioned)?
6. Real CloudFront Functions runtime: does `edge.js` pass `aws cloudfront test-function` and what is its compute utilization with a populated KVS? Does a viewer-request function's generated response skip the response-headers policy (I added the headers in code to be safe; w1-10 open question 1 asks the same)?
7. **BYO-domain** economics: CloudFront multi-tenant tenant pricing (price not read), Cloudflare for SaaS limits, and whether the loader can be served from a customer's CNAME with a per-tenant certificate.
8. Legal: is a shell-only hub an "intermediary service" or "hosting service" under the DSA, and what does Canadian law require for a small non-commercial hub? (w2b-06 and counsel.)
9. Trustworthy UI: is a cross-origin wrapper (control-plane page framing the label origin) workable given storage partitioning and the SW? Not evaluated.
10. Should hubs refuse sites above a size cap before the gate (needs a metadata fetch), and who pays for it? Interacts with trackers/web seeds (other topics).
11. Cross-hub identity: the same btih under two hubs is two origins; the identity-UX topic must decide on export/import or a shared signer origin.
12. KVS write cost: the price list shows "$1 per 1000 CloudFront KeyValueStore API Operations"; whether one `update-keys` call of 50 keys is one operation is unverified.
13. The stall after a Clear-Site-Data wipe (Gotcha 19): which directive or Chromium component causes it, and does it affect users?

---

## Appendix A - Measurement log (all 2026-10-17, macOS, Node v24.22.0)

| What | Tool and version | Result file / command |
|---|---|---|
| PSL effects on sibling labels | Chrome for Testing 156.0.8078.4, launched directly (`lab/chrome.mjs`), `--host-resolver-rules`, `--ignore-certificate-errors` for the HTTPS part | `node lab/psl-effects.mjs` -> `lab/results-psl-effects.json` |
| `*.localhost` per-label origins (32-char labels) | same browser | `node lab/localhost-origins.mjs` -> `lab/results-localhost-origins.json` |
| Takedown mechanics for installed SWs | same browser, `*.t.localhost` | `node lab/takedown-mechanics.mjs` -> `lab/results-takedown-mechanics.json` |
| Clear-Site-Data scope between sibling labels | same browser, `*.hub.localhost` | `node lab/csd-scope.mjs` -> `lab/results-csd-scope.json` |
| Clear-Site-Data on 200/404/410/451/500/503, fetch and navigation (value `"storage"`) | same browser, `*.c.localhost` | `node lab/csd-status-codes.mjs` -> `lab/results-csd-status-codes.json` |
| Clear-Site-Data on the SW script response during `update()` (200/451/404/500) and SW re-fetch timing after a navigation; one browser per scenario | same browser, `*.u.localhost` | `node lab/csd-on-sw-update.mjs` -> `lab/results-csd-on-sw-update.json` |
| Edge function logic | Node `node:test`, `vm` sandbox with fake `cloudfront` KVS | `node --test aws/edge.test.mjs` (10 tests) |
| Worker logic | Node `node:test`, mocked `ASSETS` and `DENYLIST` | `node --test cloudflare/worker.test.mjs` (7 tests) |
| Caddy variant | stock Caddy v2.11.7 (macOS arm64 release, sha512 checked against the release's checksums file), `Caddyfile.test` | `caddy validate`, then `curl --resolve` probes (18 requests against the v0.2 layout, after earlier rounds against drafts) |
| Terraform | Terraform 1.16.6, hashicorp/aws 6.69.1 | `terraform fmt -check`, `terraform validate` in a scratch copy (no plan/apply) |
| Shell size | `zlib` gzip level 9 / brotli quality 11 | `webtorrent.min.js` 222,929 B raw, 64,571 B gzip, 55,969 B brotli; the unminified sources of loader, sw, sdk and chain present on 2026-10-17 morning: 167,447 B raw, 46,207 B brotli (final bundle not built) |
| IPFS gateway state | `curl -I` | `https://dweb.link/ipfs/<cid>/` and `https://ipfs.io/ipfs/<cid>/`: HTTP/2 429, `sunset: Mon, 21 Sep 2026 00:00:00 GMT`, `link: <https://gatewaychanges.ipfs.io/>; rel="sunset"`, `retry-after: 900`, `x-robots-tag: noindex, nofollow`; `inbrowser.link` answered 403 to curl (Cloudflare; cause not investigated) |
| AWS price lists | public JSON | CloudFront `v20261003000426` (published 2026-10-03), WAF `20260914163921`, Route 53 `20260911124504` |

Playwright flag finding: `node_modules/playwright-core/lib/coreBundle.js`, `chromiumSwitches`: `--disable-features=...ThirdPartyStoragePartitioning...` and `--disable-field-trial-config` among the defaults of Playwright 1.64.1.

Housekeeping: a few small throwaway Chrome profile directories created by my crashed or interrupted lab runs remain under the OS temp directory (`/var/folders/.../T/mw-lab-*`, `lh-prof-*`) because the sandbox denied `rm -rf` on them; their processes were terminated. They are harmless and can be deleted.

## Appendix B - Label grammar test vectors (verified against the regex in `aws/edge.js`, `cloudflare/worker.js`, `caddy/hub-sites.caddy`)

The first two labels were computed with the repo's own `src/common/base32.js`; the ledger id is illustrative (ARCH section 4 formula with a fake owner string).

```
grammar: ^[a-z2-7]{32}$     (host is lower-cased and a trailing dot / port removed first; 32 chars = 160 bits = one canonical spelling)

resolves  aerukz4jvpg66ajdivtytk6n54asgrlh                          bare-magnet label: base32(btih 0123456789abcdef0123456789abcdef01234567); decodes back to the btih
resolves  g6svcl3fuffzbd4655voxi4whe7iceby                          signed-pointer label: base32(sha256("mw1:F5j6j_xE9YTYXlIxM1bs8XxIliO")).slice(0,32); not reversible
resolves  abcdefghijklmnopqrstuvwxyz234567                          any 32 characters of [a-z2-7]
404       abcdefghijklmnopqrstuvwxyz23456                           31 characters
404       abcdefghijklmnopqrstuvwxyz2345678                         33 characters
404       abcdefghijklmnopqrstuvwxyz234561                          digit 1 is not base32
404       abcdefghijklmnopqrstuvwxyz234580                          digits 8 and 0 are not base32
404       0123456789abcdef0123456789abcdef01234567                  40 hex (the v0.1 label form)
404       abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrsa      52 base32 (a 32-byte id; only relevant if BitTorrent v2 returns: then the last char must be a or q)
404       a.abcdefghijklmnopqrstuvwxyz234567                        nested subdomain
404       login-paypal                                              vanity name
404       www                                                       reserved-looking name
421       evil.example                                              host is not under the configured sites domain
```

## Appendix C - Sources actually read

IDs are used in the text. "summariser" = read through WebFetch's small-model extraction, so figures there are Medium confidence. Dates are the source's own date when it has one; otherwise "undated, read 2026-10-17".

| ID | Source | Date |
|---|---|---|
| S1 | Public Suffix List submission guidelines: https://github.com/publicsuffix/list/wiki/Guidelines (read as raw https://raw.githubusercontent.com/wiki/publicsuffix/list/Guidelines.md) | undated, current |
| S2 | Public Suffix List data: https://publicsuffix.org/list/public_suffix_list.dat | VERSION 2026-10-16_23-32-13_UTC, COMMIT 2dbfce14fe |
| S3 | IPFS Subdomain Gateway spec: https://specs.ipfs.tech/http-gateways/subdomain-gateway/ (source https://raw.githubusercontent.com/ipfs/specs/main/src/http-gateways/subdomain-gateway.md) | spec date 2025-04-03 |
| S4 | ipfs/service-worker-gateway, branch main: https://github.com/ipfs/service-worker-gateway - `README.md`, `docs/BADBITS.md`, `docs/CLOUDFLARE_SNIPPETS.md`, `docs/DEVELOPMENT.md`, `src/cloudflare/snippets/01_path_gateway_to_subdomain.ts`, `02_shared_sw_installer_cache.ts`, `subdomain.ts`, `src/cloudflare/workers/gateway-edge/wrangler.toml` | read 2026-10-17 (docs mention September 2026) |
| S5 | IPFS gateway retirement notice https://gatewaychanges.ipfs.io/ and live HTTP responses of dweb.link / ipfs.io | page Last-Modified 2026-08-31; probes 2026-10-17 |
| S6 | Shipyard, "The end of IPFS at Shipyard": https://ipshipyard.com/blog/2026-the-end-of-ipfs-at-shipyard/ (summariser) | 2026-08-24 |
| S7 | IPFS blog, "IPFS is moving beyond the sponsored gateways": https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/ (summariser) | 2026-08-25 |
| S8 | Shipyard, "IPFS Public Gateways are Redirecting to inbrowser.link": https://ipshipyard.com/blog/2026-ipfs-gateways-redirect-inbrowser-link/ (summariser) | 2026-05-11 |
| S9 | Shipyard, "A Post Gateway World": https://ipshipyard.com/blog/2025-a-post-gateway-world/ (summariser) | 2025-07-23 |
| S10 | Netcraft, "As Shipyard Winds Down, IPFS Phishing Enters a New Phase": https://www.netcraft.com/blog/as-shipyard-winds-down-ipfs-phishing-enters-a-new-phase (summariser) | 2026-09-29 |
| S11 | NFT.Storage, "Gateways and gatekeepers": https://blog.nft.storage/posts/2022-04-29-gateways-and-gatekeepers - **read from the web.archive.org snapshot 20230930054837 that S3 cites**; WebFetch refused that host, so it was fetched with curl before the search-budget notice appeared; no further archive fetches were made | 2022-04-29 **(OLD)** |
| S12 | Hacker News thread on the statichost.eu Safe Browsing incident: https://news.ycombinator.com/item?id=45538760 (first 100,000 of 130,296 characters; community report, summariser) | 2025-10-10 to 2025-10-12 |
| S13 | IPFS docs: https://docs.ipfs.tech/concepts/public-utilities/ and https://docs.ipfs.tech/how-to/address-ipfs-on-web/ (summariser) | undated |
| S14 | Cloudflare blog on retiring its IPFS gateway: https://blog.cloudflare.com/cloudflares-public-ipfs-gateways-and-supporting-interplanetary-shipyard/ (summariser) | 2024 (dates 2024-05-14, 2024-08-14) |
| S15 | ar.io: https://github.com/ar-io/ar-io-node/pull/965 and https://docs.ar.io/build/access/fetch-data (summariser) | undated |
| S16 | MDN: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria , .../HTTP/Reference/Headers/Clear-Site-Data , .../Origin-Agent-Cluster , .../Web/Security/Secure_Contexts , .../Headers/Sec-Fetch-Dest (summariser) | undated |
| S17 | web.dev https://web.dev/articles/same-site-same-origin ; Chrome HTTP cache partitioning https://developer.chrome.com/blog/http-cache-partitioning (**OLD, 2020**, Chrome 86); Chromium site isolation https://www.chromium.org/Home/chromium-security/site-isolation/ | undated / 2020 |
| S18 | AWS CloudFront docs (quotas `cloudfront-limits`, `CNAMEs`, `flat-rate-pricing-plan`, `distribution-config-options`, `kvs-with-functions`, `functions-custom-methods`, `functions-event-structure`, `cloudfront-function-restrictions`, `understanding-the-cache-key`) under https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ ; AWS WAF rate-based rules doc; price lists https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonCloudFront,awswaf,AmazonRoute53}/current/index.json ; https://aws.amazon.com/s3/pricing/ | docs undated; price lists 2026-10-03 / 2026-09-14 / 2026-09-11 |
| S19 | Cloudflare docs: Pages custom domains, wildcard DNS records, Universal SSL limitations, Workers routes, static assets (binding, billing, headers), Workers pricing and limits, Snippets, rate limiting rules, R2 pricing, Cloudflare for SaaS plans (https://developers.cloudflare.com/...); service-specific terms https://www.cloudflare.com/service-specific-terms-application-services/ | undated |
| S20 | Caddy automatic HTTPS docs https://caddyserver.com/docs/automatic-https ; Caddy v2.11.7 release https://github.com/caddyserver/caddy/releases/tag/v2.11.7 (binary tested) | release archive files dated 2026-10-03 |
| S21 | Let's Encrypt rate limits https://letsencrypt.org/docs/rate-limits/ | undated |
| S22 | Vercel https://vercel.com/docs/domains/working-with-domains/add-a-domain ; Netlify https://docs.netlify.com/domains-https/custom-domains/ ; GitHub Pages custom-domain docs under https://docs.github.com/en/pages/ | Vercel page `last_updated: 2026-09-16`; others undated |
| S23 | HSTS preload https://hstspreload.org/ | undated |
| S24 | R2 https://developers.cloudflare.com/r2/pricing/ ; Backblaze B2 https://www.backblaze.com/cloud-storage/pricing ; Bunny https://bunny.net/pricing/cdn/ ; Hetzner billing FAQ https://docs.hetzner.com/cloud/billing/faq/ (no prices) | read 2026-10-17 |
| S25 | RFC 6265, 7725, 8615, 9116, 2142 (rfc-editor.org); Service Workers spec https://w3c.github.io/ServiceWorker/ | RFCs 2011 / 2016 / 2019 / 2022 / 1997; spec living draft read 2026-10-17 |
| S26 | Matrix client-server API "Moderation policy lists" https://spec.matrix.org/latest/client-server-api/#moderation-policy-lists ; Nostr NIP-11, NIP-56, NIP-66 (https://github.com/nostr-protocol/nips, master); AT Protocol labels https://atproto.com/specs/label | living specs, read 2026-10-17 |
| S27 | Regulation (EU) 2022/2065 (EUR-Lex CELEX:32022R2065, Articles 4-6, 8, 11-13, 16, 19 read); US Copyright Office DMCA directory https://www.copyright.gov/dmca-directory/ ; Canada Copyright Act s. 41.25 https://laws-lois.justice.gc.ca/eng/acts/C-42/section-41.25.html | 2022 / undated |
| S28 | USENIX Security 2023, "Cookie Crumbles": https://www.usenix.org/conference/usenixsecurity23/presentation/squarcina (abstract only) | 2023 |
| S29 | ipfs/gateway-conformance https://github.com/ipfs/gateway-conformance ; ipfs/public-gateway-checker https://github.com/ipfs/public-gateway-checker ; Compact Denylist Format https://specs.ipfs.tech/compact-denylist-format/ (source `ipfs/specs` `src/compact-denylist-format.md`) | read 2026-10-17; format dated 2023-08-24 |
| S30 | This repo: `docs/ARCHITECTURE.md` (v0.1 read first, **v0.2 of 2026-10-17 re-read and used**), `docs/INTERFACES.md` (`hubLabelFor`), `docs/review/DESIGN-REVIEW.md` (items 6, 7, 20, 21), `docs/review/security.md` (2026-10-14), `docs/research/labs/04-sw-experiment/results-chromium-156-2026-10-14.txt`, `src/loader/render.js`, `src/common/base32.js` | 2026-10-14 / 2026-10-17 |
| S31 | Own measurements and code of this wave, `docs/research/labs/w2c-04-hub-reference/` | 2026-10-17 |
| S32 | Neighbouring research notes of this repo, read for consistency (sections quoted by id in the text): `w1-10-static-hosting-bootstrap.md` (F18, F24, REC-8/14/15, CFG-3/4), `w1-11-security-threats.md` (F3, R3), `w2b-04-observability-no-backend.md` (F18), `w2b-05-security-hardening-prod.md` (F20, F24, F25), `w2b-06-abuse-legal-ops.md` (F5, F10, F11, ladder L0-L5, R3, R4), `w2c-03-identity-ux.md` (R7), `w2c-05-testing-qa-production.md` (R-14), `w2c-06-standards-and-ecosystem.md` (item 11) | 2026-10-17 |

## Appendix D - Unverified, unfollowed or out of scope (be honest about it)

- **Search budget:** WebSearch was exhausted mid-run. Not followed: ACM public-certificate validity changes under the CA/Browser Forum 200-day rule, any official Google statement on Safe Browsing granularity for PSL-listed suffixes (w2b-06 F11 read Google's canonicalization page and reaches the same unverified conclusion), Hetzner included traffic and per-TB price, Netlify wildcard details beyond one docs line, CloudFront SaaS (multi-tenant) pricing.
- **Summariser-extracted pages** (Medium): S6-S10, S12-S16, S19 partly, S22, S24, S26, S27. Exact quotes inside them may be paraphrases.
- **Not read:** 18 U.S.C. 2258A, CDA 230, Canada Copyright Act s. 41.26 and the mandatory-reporting Act (w2b-06 covers them), ENS gateway (eth.limo) documentation, the full Hacker News thread, `ar-io-content-scanner` (404), Sokoto et al. (cited through w2b-06 F10, not read here).
- **Not tested:** Firefox, Safari, iOS; real CloudFront Functions runtime; real KeyValueStore propagation; Cloudflare Workers deploy and the `run_worker_first` negative patterns; Caddy with a DNS-01 module; edge cache sharing across labels on a real CDN; Terraform plan/apply; the post-wipe navigation stall.
- **Proposals, not facts:** `hub.json`, the hub-level takedown protocol (status ping + Clear-Site-Data), `--hub` probe mode, domain sharding (R19), the share-link rules of R2.
- **Superseded in this revision (kept for traceability):** my first draft used 40-hex / 52-character labels, `/sw.js` + `/assets/*`, `Clear-Site-Data: "cache", "storage"`, a hub-owned directory ledger and an AT-Protocol-shaped labels file. ARCH v0.2, DESIGN-REVIEW 6 and w2b-06 settled those differently; the reference files and this note follow them.
