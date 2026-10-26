# w2a-06 - Publishing automation: CI/CD that builds a site, makes the torrent, uploads the web seed and updates the DNS pointer

- Project: magnet-web (wave 2, migration track: how an existing site moves onto the architecture, including the one-script-tag "drop-in" mode)
- Topic: GitHub Actions / GitLab CI recipes: build -> deterministic torrent -> web seed upload with correct CORS / Content-Type / Cache-Control -> `.torrent` for `xs=` -> DNS pointer update (Route 53, Cloudflare, deSEC, Gandi, OVH, Porkbun, Namecheap), DNSSEC and the DoH `AD` flag, TTL strategy, rollback, atomic ordering, signing-key custody, IPFS-land comparables, semver and channel records
- Research date: 2026-10-17 (Toronto). "Today" in this file means that date. Sources older than 2024 are marked (OLD).
- Method: official documentation and specs opened directly with the fetch tool, source code in `node_modules` (webtorrent 3.0.21, create-torrent 6.1.3, parse-torrent 11.0.24), the project's own `docs/` and `src/`, and **seven executed experiments plus a real-host header probe** (lab: `docs/research/labs/w2a-06-lab/`, Appendix C). The shared WebSearch budget for the session was already exhausted when this run reached its search steps, and the tool forbids working around it, so there was **no search-engine discovery**: every source below was opened by direct URL. Candidate comparables that need discovery (Fleek, Storacha, Pinata actions) were therefore **not examined**.
- Evidence tags: **[X]** executed or measured by me today; **[C]** read in source code; **[D]** read in official documentation or a specification today; **[I]** my inference; **[U]** unverified (stated so that nobody mistakes it for a finding).
- Confidence: **High** = executed, or two independent primary sources agree, or one primary source that is unambiguous. **Medium** = one primary source summarised by the fetch tool, or behaviour observed on a single real host. **Low** = inference or an absence of evidence.
- Source IDs `[S#]` are listed with URL and date in Appendix F.


**Contents:** [Summary](#summary) | [Findings](#findings) (A pipeline and determinism, B web seed hosting, C DNS, D signing and CI security, E channels and IPFS-land) | [Recommendations](#concrete-recommendations-for-magnet-web) | [Gotchas](#gotchas) | [Open questions](#open-questions) | Appendices: [A workflows](#appendix-a---reference-workflows-github-actions-gitlab-outline), [B tool contract](#appendix-b---toolsmwmjs-stage-contract-files-are-the-interface), [C experiments](#appendix-c---executed-experiments-code-and-results), [D provider matrix](#appendix-d---dns-provider-matrix-for-the-pointer-record), [E policies and configs](#appendix-e---policies-configs-and-checks-json-validated-with-jq-cli-parameters-validated-with-the-aws-cli-client-side-parser), [F sources](#appendix-f---sources-url-date-of-source-fetched-2026-10-17-unless-noted)

---

## Summary

1. **Pipeline and order.** `plan -> build (no secrets) -> pack (deterministic) -> seed upload to an immutable per-release prefix -> verify the PUBLIC seed -> sign -> write the pointer with compare-and-swap -> verify the pointer from outside -> browser smoke test -> GitHub Release`. Upload before DNS, always; verify between every step that a visitor could observe. A tested reference workflow trio (GitHub `publish.yml`, reusable `pointer.yml`, `rollback.yml`, plus a GitLab outline) is in Appendix A; all of it parses and passes a four-rule security lint [X].
2. **Seven findings change the design or a compatibility promise** (all `design_critical` in the JSON): (a) the pointer grammar has **no `xs=`**, but `ws=` alone cannot fetch metadata, so a peer-less first visit fails [C][X]; (b) a signed pointer is 246 to 487 bytes, so **two TXT strings is the normal case, not an edge case** [X]; (c) the loader refuses a lower `seq`, so **rollback must be a roll-forward** to old content with a higher `seq` and a fresh `exp` [D][I]; (d) **WebTorrent 3.0.21 never abandons a web seed that serves bad bytes**: 23,240 corrupt requests in 4 s against a loopback seed, whereas BEP 19 says discard the URL [C][X] - so seed prefixes must be immutable per release, a public-seed verification gate must run in CI, and the loader needs a failure budget; (e) **none of five real static hosts probed answers the CORS preflight WebTorrent triggers**, and CloudFront's managed "CORS-With-Preflight" policy documents no `Access-Control-Allow-Headers` [X][D] - "works from any static host" is false for cross-origin seeds; (f) **owner-key custody**: one TOFU-pinned key held by CI is a single point of takeover, so KMS-held (non-exportable) signing, environment approvals and a reserved delegation slot in the grammar are needed [D][I]. (g) **a pointer cannot live inside the payload it points to**: the loader has no same-origin pointer-file source and a `<meta>` tag in a drop-in site's own HTML would be a hash self-reference, so drop-in sites need DNS or a pointer file outside the packed tree (F6b) [C][I].
3. **Determinism is easy to lose.** `create-torrent` 6.1.3 in directory mode **drops `.well-known/` and every other dot-entry**, follows raw `readdir` order, writes `Date.now()` when `creationDate` is `new Date(0)`, bakes in 8 default trackers, and picks 16 KiB pieces for sites under about 16 MiB [X][C]. A manifest-driven `pack` (tested, Appendix C.7) gives identical `.torrent` bytes across different paths, creation orders, mtimes and file modes. The toolchain disagrees about hidden files (S3 upload includes them; artifact actions skip them), so upload the **staged tree** that `pack` emits, not `dist/`.
4. **Web seed hosting.** Immutable prefix `r/<semver>-<btih8>/` with `ws=` set per release (the pointer already carries `ws`), `Content-Type: application/octet-stream` and `Cache-Control: public, max-age=31536000, immutable` on the seed copy, never a `Content-Encoding`. S3 `If-None-Match: *` and R2 conditional writes can make "never overwrite" enforceable; `aws s3 sync` cannot send the header, `aws s3api put-object` can [X][D]. In **drop-in mode the seed is same-origin and needs no CORS at all**, but it inherits whatever the CDN does to bytes, which is why the verify gate exists.
5. **DNS.** Route 53 is the best fit: atomic change batches, record-name/type/action IAM conditions (a role that can write only `_magnet.<host>` TXT), OIDC, `DELETE`(exact old value)`+CREATE` as a compare-and-swap, `GetChange` to INSYNC (docs: generally within 60 s) [D]. deSEC has per-record token policies but a server-set minimum TTL (its documented example shows 3600 s; lower needs a support exception). Cloudflare tokens scope to a zone only (no record-level scoping documented), so use the **sandbox-zone CNAME delegation** that `ipshipyard/dnslink-action` documents. OVH needs an explicit zone refresh; Porkbun's `editByNameType` replaces all matching records; **Namecheap and GoDaddy could not be verified** (Namecheap docs return HTTP 403 to every fetch). A **no-DNS mode** (the signed pointer as a same-origin file outside the packed tree; `<meta>` only where a separate loader shell exists, F6b) must be first-class.
6. **Secrets.** OIDC to AWS for three separate roles (seed writer, signer, DNS writer); **GitHub changed the OIDC `sub` format for repositories created after 2026-07-15** (`repo:OWNER@OWNER-ID/REPO@REPO-ID:...`), which silently breaks copy-pasted trust policies [D]; KMS `Sign` returns **DER**, the project verifies **raw r||s**: 120 of 120 openssl DER signatures verified after conversion, naive truncation fails [X]. Evidence for caution: CISA's alert on tj-actions/changed-files (secrets exfiltrated: access keys, PATs, npm tokens, private RSA keys) [D].
7. **TTL and propagation.** TTL 300 s default but provider floors differ (deSEC server-set, documented example 3600; Porkbun typically 600; Gandi 300; Cloudflare 60). Verify against the **authoritative servers first** so CI never primes a negative cache for a new name, then through two DoH resolvers, then check `AD` if the zone is signed. Do not rely on DNS TTL for urgent rollbacks: carry the signed pointer over the peer wire as well (cross-topic recommendation).
8. **Channels and semver.** Immutable release = `{semver, git sha, btih}`; mutable channel = a signed pointer at `_magnet.<channel-host>` (`_magnet.beta.example.com`). npm dist-tags are the precedent. The signature binds the hostname, so **promotion beta to prod is a re-sign**, not a copy. PR previews need no DNS at all (hub-mode `#magnet:` URL).
9. **IPFS-land.** Copy the patterns (merkleize then pin as separate stages, CAR as workflow artifact, PR comment with preview link, `workflow_run` build/deploy split, sandboxed DNSLink zone), **do not depend on the tools**: `ipshipyard/ipfs-deploy-action` states "There is no maintainer at the moment" and Shipyard's IPFS maintenance ended 2026-09-30 [D].
10. **Not verified** (say so, do not guess): Firefox and Safari behaviour for `Accept-Encoding` on Range requests and for the preflight header set; a live CloudFront custom response-headers policy end to end; live DNS propagation latency; Namecheap, GoDaddy and Squarespace Domains APIs; TXT length handling at Porkbun, Gandi and OVH; the exact environment-scoped `sub` string under the new immutable format (inferred).

---

## Findings

### A. Pipeline order, determinism, pointer size

- **F1. Order of operations.** The only order that never exposes a pointer to bytes that cannot be served yet is: deterministic pack, upload to an immutable release prefix, verify the public seed, sign, publish the pointer (DNS, same-origin file, `<meta>`), verify the pointer from outside, smoke test. A pointer published first points `ws`/`xs` at 404s, and a bad seed is retried without limit (F7). The static-site copy for crawlers and no-JS visitors can be deployed after the seed and before the pointer; either skew is harmless because the torrent and the static copy come from the same staged tree (F3, R2). *Confidence: High [I][X]. Sources: S32 (ARCHITECTURE section 4), S34 (E6). Dates: project docs 2026-10-14; E6 2026-10-17.*

- **F2. `create-torrent` 6.1.3 traps (all executed).** (a) Directory input uses `get-files.js`, which filters names starting with `.` and junk: a tree of 11 site files (including `.well-known/security.txt`, `.well-known/assetlinks.json` and `.htaccess`, plus a `.DS_Store`) produced an **8-file** torrent in directory mode (`_headers` was kept); the explicit list produced all 11 [X][C]. (b) Order is `fs.readdir` order with no sort; this APFS volume returned byte order, so directory mode *looked* deterministic here, but POSIX gives no ordering promise on other filesystems [X][I - not measured on ext4]. (c) An explicit list of `fs.openAsBlob()` blobs with `blob.fullPath = "<name>/<rel>"`, sorted byte-wise, gave the same infohash for a tree built in reverse creation order, with different mtimes, modes and absolute path [X]. (d) `.torrent` **bytes** are identical only if `creationDate` is pinned; the infohash is unaffected; `creationDate: new Date(0)` is falsy and silently becomes "now" [X][C]. (e) Without `announce`/`announceList` the file carries **8 default trackers** (5 UDP, 3 WSS) [X][C]. (f) Default piece length from the `piece-length` package is **16 KiB for sites below about 16 MiB** (10 MiB gives 640 pieces, 40 at 256 KiB) [X]. *Confidence: High. Sources: S33, S34 (E1, E7). Dates: executed 2026-10-17.*

- **F3. The toolchain disagrees about hidden files.** `aws s3 cp --recursive` (CLI 2.38.1) uploads `.DS_Store`, `.htaccess` and `.well-known/*` [X]; `actions/upload-artifact` has `include-hidden-files` defaulting to false ("to avoid unintentionally uploading sensitive information") [D]; `actions/upload-pages-artifact` excludes hidden files and directories by default and always `.git` and `.github` [D]; `create-torrent` directory mode drops them (F2). Result: `.well-known` vanishes between jobs, or the seed objects differ from the torrent payload. Fix: one manifest-driven `pack` that emits the exact file list and a staged tree, and upload only that tree. *Confidence: High. Sources: S20, S34 (E1, local CLI check), S33. Dates: README fetched 2026-10-17; v7 line.*

- **F4. Build reproducibility is the site generator's job, and CI should prove it.** `SOURCE_DATE_EPOCH` is defined as integer seconds since the epoch, with `git log -1 --pretty=%ct` as the recipe; the list of tools that honour it names mkdocs, sphinx and docker buildx but not the common web generators [D]. Next.js documents `generateBuildId` for a consistent build id across rebuilds (docs updated 2026-10-01); that it differs per build by default is my reading of that text [D][I]. Any non-determinism changes the infohash, which starts a new swarm and shows every visitor "update available". CI should pack twice from different paths and compare (E7 does this). *Confidence: Medium. Sources: S31. Dates: 2026-10-01 (Next.js), spec undated.*

- **F5. `xs=` is required for a peer-less first visit, and the pointer grammar lacks it.** In webtorrent 3.0.21 `_getMetadataFromServer()` runs only when no metadata is available, fetches `xs` URLs with `http:`/`https:` only, requires status 200, parses the file and discards it if the infohash differs [C]. The earlier lab measured that `magnet:?xt=...&ws=...` alone never obtains metadata (0 peers in 6 s) while adding `xs` completes in 205 ms [X, S32 research 01 F10]. ARCHITECTURE section 4 defines `dn, ws, tr, chain, max, owner, seq, exp, sig` and no `xs`, although `src/common/magnet.js` already parses and formats `xs`. Without `xs` (or a live peer), a brand-new visitor cannot start even though the web seed is up. The sibling document `docs/research/w2a-02-cms-export.md` reaches the same conclusion from the metadata side: peer-supplied metadata travels in `ut_metadata` blocks and a peer advertising `metadata_size` above `MAX_METADATA_SIZE = 1E7` (10 MB) is rejected, while the `xs` GET has no such cap, so it calls `xs=` mandatory above roughly 500 files or 64 KB of metadata (as stated there) [S36]. *Confidence: High. Sources: S33, S32, S36. design_critical.*

- **F6. A signed pointer does not fit in one DNS string.** Computed with real field widths (65-byte owner key = 87 base64url characters, 64-byte signature = 86): minimal `v,btih,owner,seq,sig` = **246 B** (one string), typical with `dn, ws, tr, exp` = **363 B** (two strings, 255 + 108), with `xs`, `rel`, `chain` and a second tracker = **487 B** (two strings). The Route 53 value with quotes and spaces is 368 characters; the change batch JSON about 560 bytes [X]. Every provider recipe must therefore handle multi-string TXT, and the loader's reassembly (`joinTxtData`) is on the critical path. *Confidence: High. Sources: S34 (E3), S32. design_critical.*

- **F6b. A pointer cannot live inside the payload it points to, so the `<meta>` source is a loader-shell feature only.** `resolvePointer()` in `src/loader/app.js` tries four sources in order: explicit (fragment, `?mw=`, wildcard host), `<meta name="mw-pointer">` in the shell HTML (domain mode), DNS TXT over DoH (`_magnet.` + hostname), then the cached pointer; there is **no same-origin pointer-file source** [C]. In per-domain mode the loader's own `index.html` is the shell and is not part of the site torrent, so a meta tag is fine. In **drop-in mode the site's pages are both the shell and the torrent payload**: a `<meta>` carrying `btih=X` inside a file that belongs to torrent X is a hash self-reference (the infohash covers the very bytes that would contain it), and injecting it only into the served copy makes the served HTML differ from the seed bytes (F3, R2) [I]. The pointer must therefore travel outside the packed tree: DNS, or a same-origin file that is excluded from the manifest. **This contradicts `docs/research/w2a-05-seo-crawlers.md` R1**, where `tools/publish.mjs --embed` injects `<meta name="mw-pointer">` and the loader `<script>` into every `*.html` and then builds the torrent from the post-injection tree "so origin and swarm are identical" [S36]. That sequence is fine for the script tag, whose content does not depend on the hash, and impossible for a meta tag that carries `btih=`. Consistent variants: (a, recommended) inject only hash-independent parts before packing (the script tag, at most a pointer-free `<meta>` such as the owner key) and deliver the pointer by DNS or a pointer file outside the tree; (b) inject the full meta into the served copy after packing, which makes served HTML differ from the seed bytes and needs a separate seed tree for HTML (`seed-verify` would flag any same-origin seed that mixes them). *Confidence: High [C][I]. Sources: S33 (`src/loader/app.js` as of 2026-10-17), S32, S36. design_critical.*

### B. Web seed hosting

- **F7. BEP 19 and what WebTorrent actually does with a bad seed.** BEP 19: `url-list` sits outside `info`; a URL ending in `/` gets the torrent `name` appended; for multi-file torrents `url-list` is a root folder to which `name` and `path/file` are added (`http://mirror.com/pub/` + `michael` + `Readme.txt`); "If it successfully downloads a piece from a HTTP/FTP server, but the SHA checksum does not match, the connection must be closed and that URL should be discarded" [D, OLD, verified verbatim]. WebTorrent 3.0.21 does **not** discard: on a hash mismatch `lib/torrent.js` resets the piece, emits a `warning` (`Piece N failed verification`) and re-requests, without banning the source [C]. Executed against a loopback web seed serving a corrupted first piece: **23,240 corrupt Range requests and 23,240 warnings in 4 s (about 5,800 per second)**, the web-seed wire stayed attached, the torrent stalled at 92.9 percent and completed as soon as the seed was fixed (done at 4,002 ms, the end of the corruption window) [X]. Over a real network the rate is bounded by round trips and `maxWebConns` (default 4), but each visitor with a bad seed becomes a request generator against your bucket or CDN. *Confidence: High. Sources: S12 (BEP 19), S33, S34 (E6). Dates: BEP 19 OLD; code 3.0.21; executed 2026-10-17. design_critical.*

- **F8. Immutable per-release prefixes are possible and can be enforced.** `ws=` is a per-release pointer field and the torrent `name` can stay constant, so each release can live at `<cdn>/r/<semver>-<btih8>/<name>/<path>` (BEP 19 layout) [D][I]; the examples/peer-guestbook README's "name must stay the same" is satisfied. Enforcement: S3 conditional writes - `If-None-Match: *` on `PutObject`, `CopyObject` and `CompleteMultipartUpload` returns **412 Precondition Failed** if the key exists; a bucket policy can *require* the header (`s3:if-none-match` condition key, with `s3:ObjectCreationOperation` exemptions for multipart parts); copies into an enforced prefix fail with 403 or 501 [D]. `aws s3 cp` and `aws s3 sync` in CLI 2.38.1 have **no** conditional flags, `aws s3api put-object` has `--if-match` and `--if-none-match` [X], so hard enforcement means a per-object `s3api` loop or SDK uploader. R2's S3 API marks `If-Match`, `If-None-Match` and the date conditionals as supported and atomic ("at most one write succeeds and the others fail with 412") [D]; B2 conditional-write support was **not found** in what I read [U]. Cheap alternative: a pre-flight "prefix must be empty" check in CI (Appendix A). *Confidence: High (S3, R2), Low (B2). Sources: S28, S26, S27, S34. Dates: undated AWS pages; R2 S3 page read 2026-10-17.*

- **F9. Cross-origin web seeds need a real preflight answer, and no probed host gave one.** WebTorrent's seed fetch sends `Cache-Control: no-store`, `user-agent` and `range` (`lib/webconn.js` lines 125-133) [C]; `Cache-Control` is not CORS-safelisted, so Chromium preflights with `Access-Control-Request-Headers: cache-control` (confirmed [X], E4; `range` is safelisted, Chromium dropped `user-agent`) and the earlier lab showed that ACAO alone, without Allow-Headers, yields 0 bytes [S32]. Measured today with `curl` (preflight asking for `cache-control,range`):

  | Host (one real site each) | Range + identity | OPTIONS preflight | GET `Access-Control-Allow-Origin` |
  |---|---|---|---|
  | GitHub Pages (Fastly) | 206 correct | **405**, no CORS headers | `*` |
  | Vercel (nextjs.org immutable chunk) | 206 | 204, no CORS headers | `*` |
  | Netlify (www.netlify.com asset) | 206 | 200, no CORS headers | none |
  | Cloudflare-fronted (developers.cloudflare.com CSS) | **200, Range ignored** | 405, ACAO `*` but no Allow-Headers | `*` |
  | jsDelivr (CDN) | 206 | 200, ACAO `*` but **no Allow-Headers** | `*`, expose `*` |
  | CloudFront + S3 (a0.awsstatic.com) | 206 | **403** | none |

  One site per platform, so these are that site's configuration, not platform defaults; but none of the five general-purpose hosts passes unconfigured, so the claim "works from any static host" must be narrowed to "any host that can be configured to answer the preflight, or the same origin as the loader". Same-origin requests need no preflight; in E5 a server returning 405 to OPTIONS passed as same-origin. Firefox and Safari may add `user-agent` to the preflight list [U, S32]: answer with `Access-Control-Allow-Headers: *` or echo the request headers. *Confidence: High (Chromium), Medium (other engines and platform defaults). Sources: S33, S34 (E4, E5, host probe), S32. Dates: 2026-10-17. design_critical.*

- **F10. CloudFront needs a custom response-headers policy for seeds.** The managed `CORS-With-Preflight` policy (id `5cc3b908-e619-4b99-88e5-2cf7f45965bd`) adds `Access-Control-Allow-Methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`, `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: *` - **no `Access-Control-Allow-Headers`** [D]. Unless the S3 origin returns that header (S3 CORS `AllowedHeaders`) and CloudFront forwards the request headers, WebTorrent's `cache-control` preflight fails [I - not tested end to end]. A custom policy with `AccessControlAllowHeaders: ["*"]` passes AWS CLI parameter validation [X] (Appendix E). CloudFront compresses only objects of 1,000 to 10,000,000 bytes with compressible types and only responses with status 200, 403 or 404 [D]; in the probe, `Range` plus `Accept-Encoding: gzip, br` returned a **full compressed 200**, ignoring `Range` [X]. *Confidence: Medium. Sources: S28, S34. Dates: undated AWS pages; probe 2026-10-17.*

- **F11. `Range` and content coding: Chromium sidesteps the hazard; other engines are unverified.** Playwright Chromium 156: `fetch()` **with a Range header sends `Accept-Encoding: identity`**, a plain fetch sends `gzip, deflate, br, zstd`, same- and cross-origin [X]. So on-the-fly compression does not corrupt Chromium web-seed ranges. For a client that did send gzip, GitHub Pages and jsDelivr answered `206` with `Content-Range` over the **compressed** length (3,412 and 66,074 bytes instead of 12,226 and 222,929) [X], which no piece hash can survive; E5 reproduces it (PASS with `identity`, FAIL with `gzip, br`). Firefox and WebKit were not installed in this environment, so their behaviour is unmeasured [U]. Rule: never set `Content-Encoding` on seed objects, keep seeds off compressing/transforming paths where possible, and let the verify gate decide. *Confidence: High (Chromium), Low (Firefox/Safari). Sources: S34 (E4, E5, host probe). Dates: 2026-10-17.*

- **F12. GitHub Pages and the other static hosts as seeds.** Pages limits: published site 1 GB, 10-minute deployment timeout, 100 GB per month soft bandwidth, 10 builds per hour soft (not applicable to custom workflows), commercial and SaaS use restricted, 429 on rate limit [D]; no custom headers, so it can never be a cross-origin seed (F9). `_headers` files exist on Cloudflare Pages (100 rules, 2,000 characters per line, static assets only, updated 2026-08-25) and Netlify (which ignores user-set `Accept-Ranges`, `Content-Encoding`, `Content-Length` and `Content-Range`), but **neither page documents OPTIONS handling** [D][U]. Pages deployments also hide dotfiles by default (F3). Treat these hosts as **same-origin seed only**, verified by the gate. *Confidence: Medium-High. Sources: S21, S30, S20. Dates: Cloudflare 2026-08-25; others undated.*

- **F13. CDN features can change HTML bytes.** Cloudflare's own Rocket Loader page says Rocket Loader and Email Obfuscation "use non standard tags that fail strict HTML validation", i.e. the served markup differs from the origin's; it says nothing about `Range` or `Cache-Control: no-transform` [D]. Whether such rewriting applies to Range responses is undocumented, so a drop-in site behind such features can break piece hashes for HTML only. The verify gate (F9) is the detector; the mitigation is a separate seed hostname or path with those features off. *Confidence: Medium (existence), Low (behaviour on Range). Sources: S30. Date: undated.*

- **F14. Cost of seeding (quoted prices only).** R2: $0.015 per GB-month, Class A $4.50 per million, Class B $0.36 per million, egress free; free tier 10 GB, 1 M Class A, 10 M Class B per month (page "Last updated Oct 1, 2026") [D]. Backblaze B2: from $6.95 per TB-month, egress $0.01 per GB beyond a free allowance of 3x average monthly storage, Class A/B/C free for pay-as-you-go, Class D $0.004 per 10,000 [D]. AWS KMS: $1.00 per customer-managed key per month; the pricing page's file-signing example uses ECC_NIST_P256 at $0.15 per 10,000 requests; the 20,000-request free tier excludes asymmetric requests [D]. S3 and CloudFront prices were **not fetched** [U]. Request math: one Range GET per piece per file span, so a 10 MiB site is about 40 GETs at 256 KiB pieces and 640 at the 16 KiB default; at R2 Class B pricing 100,000 cold visitors cost about $1.44 at 256 KiB pieces [I]. *Confidence: High for quoted prices. Sources: S26, S27, S10. Dates: R2 2026-10-01; KMS (c) 2026; B2 undated.*

### C. DNS publishing

- **F15. Route 53.** Change batches are transactional ("either makes all or none"); `DELETE` requires "all the same values that you specified when you created it", so a batch of `DELETE(old exact value)` plus `CREATE(new)` is a **compare-and-swap** that fails atomically if the record changed under you [D][I - semantics from docs, not run against a live zone]; the AWS CLI accepted that batch shape in client-side validation and rejected a malformed one [X]. Propagation: `PENDING` until all Route 53 servers have the change, then `INSYNC`; "generally ... within 60 seconds" [D]. IAM condition keys `route53:ChangeResourceRecordSetsNormalizedRecordNames` (lowercase, no trailing dot), `...RecordTypes` and `...Actions` with `ForAllValues:StringEquals` scope a role to TXT writes on `_magnet.example.com`; AWS recommends allow-based policies [D]. Quotas: 1,000 ResourceRecord elements and 32,000 Value characters per request, both **counted twice for UPSERT**; 400 records per record set; `PriorRequestNotComplete` if the previous change on the zone is still processing; throttling is now two buckets - requests 50 burst / 10 per second, changes 1,500 burst / 100 per second (UPSERT costs 2) [D]. With DNSSEC enabled Route 53 caps TTL at one week and the KSK is a customer-owned KMS key; multi-vendor DNSSEC is unsupported [D]. *Confidence: High. Sources: S1-S5, S34. Dates: undated AWS pages, fetched 2026-10-17.*

- **F16. Cloudflare.** `POST /zones/{id}/dns_records/batch` runs deletes, patches, puts, posts in that order inside "a single database transaction", but propagation to the edge is not atomic; TXT `content` is quoted strings of at most 255 bytes and longer strings "are automatically split"; no overall length cap is stated [D]. API tokens scope to **zone-level resources with Read/Edit permission levels, optional client-IP filtering and a TTL**; the page does not describe record-name or record-type restriction and does not mention OIDC or workload identity federation [D][U - absence in this page]. Limits: 1,200 requests per 5 minutes per user or token, then HTTP 429 blocks the next five minutes; `Ratelimit`, `Ratelimit-Policy` and `retry-after` headers [D]. DNSSEC is one click (algorithm 13), DS added at the registrar (automatic for Cloudflare Registrar, `.ch`, `.cz`) [D]. *Confidence: High for quoted behaviour, Medium for "cannot scope to a record". Sources: S7. Dates: undated.*

- **F17. deSEC.** Token policies are keyed by `(domain, subname, type)` with `perm_write`, a default policy that must exist first, `max_age` and `max_unused_period` expiry; tokens with policies are "restricted" [D] - the most granular write scoping I found outside AWS IAM. Bulk `PATCH`/`PUT`/`POST` on `rrsets/` is atomic; TXT must be enclosed in double quotes; strings over 255 characters are split automatically [D]. **`minimum_ttl` is server-set and read-only** (the documented example shows 3600; lower values need a support exception, and the docs say "We reserve the right to reject applications at our discretion") [D]. RRset write limits are per domain: 2 per second, 15 per minute, 100 per hour, 300 per day, then 429 with `Retry-After` [D]. DNSSEC is automatic; the user hands the DS list to the registrar [D]. *Confidence: High (policies, bulk, limits), Medium (default minimum TTL value). Sources: S6. Dates: rolling "latest", undated.*

- **F18. Gandi, OVH, Porkbun.** Gandi LiveDNS v5: Personal Access Token as Bearer; `PUT /v5/livedns/domains/{fqdn}/records/{rrset_name}/{rrset_type}` with `rrset_values` and `rrset_ttl` (**300 to 2,592,000**), `PATCH` to add or remove values, snapshots can be listed, created and read but **no restore endpoint appeared** in what I read; TXT examples are quoted [D]. OVH: `POST /domain/zone/{zone}/record` creates, `PUT .../record/{id}` updates, `POST /domain/zone/{zone}/refresh` ("Refresh the zone") applies; credentials are requested with `accessRules` of method plus path [D, schema]. Porkbun v3.63: API keys in the body or `X-API-Key` headers, **API access is opt-in per domain**, `dryRun: true` on DNS writes, `editByNameType` "replaces the content of all records matching the given subdomain and type", minimum TTL "determined by account settings (typically 600)", 2,500 records per zone; **TXT quoting and length rules are not documented** in the parts read [D][U]. *Confidence: Medium. Sources: S29. Dates: Porkbun v3.63; others undated.*

- **F19. Registrars I could not verify.** Namecheap API pages returned HTTP 403 to the fetch tool and to `curl` with a browser user agent; GoDaddy's current developer page describes a v3 API with a Bearer PAT but lists no DNS endpoints and no access restrictions on the page read; Squarespace Domains (successor of Google Domains) was not examined [U]. From memory only, and therefore **not a finding**: Namecheap's host-record API replaces all records and needs an IP allowlist, which GitHub-hosted runners cannot satisfy. Plan for these registrars as "manual or delegated" (F20) and keep a `dns plan` output that a human can paste. *Confidence: Low. Sources: S29 (negative results).*

- **F20. CNAME delegation to a sandbox zone is the portable least-privilege pattern.** `ipshipyard/dnslink-action` README: "isolate DNSLink records on a separate domain ... even if your API token is compromised, attackers can only modify TXT records on the sandboxed domain"; setup is `_dnslink.docs.yourdomain.com CNAME _dnslink.docs.dnslinks.example.com` and a zone-scoped Cloudflare token [D]. The same shape works for `_magnet.<host>`: the site owner sets one CNAME once, CI holds a token for a zone that contains nothing else. Caveats: the loader must follow CNAMEs (the DoH JSON APIs do; S32 research 05 F4), a CNAME chain that leaves a signed zone gives `AD:false` unless the target zone is signed too (research 05 F5), and delegated targets can rot (the DNSLink tutorial's own example no longer has a TXT, research 05 F8). *Confidence: High. Sources: S24, S32.*

- **F21. DNS-as-code is an option, with whole-zone semantics.** DNSControl supports `ROUTE53`, `CLOUDFLAREAPI`, `DESEC`, `GANDI_V5`, `OVH`, `PORKBUN`, `NAMECHEAP`, `HETZNER_V2`, `GCLOUD`, `AZURE_DNS`, `NETLIFY`, `VERCEL` and many more (GoDaddy is not listed); TXT takes an array of strings and splits above 255 octets automatically; providers may still reject multiple strings [D]. Preserving unmanaged records (`NO_PURGE`/`IGNORE`) was **not covered** by the page read [U]. For one record, a 60-line provider module per vendor is safer than a zone-wide tool. If the zone is also in Terraform, the TXT must be excluded from drift (for example `lifecycle { ignore_changes = [records] }`) [I]. *Confidence: Medium. Sources: S29.*

- **F22. TTL, propagation and negative caching.** Floors: deSEC server-set (documented example 3600, read-only), Porkbun typically 600, Gandi 300, Cloudflare 60 (research 05 F11), Route 53 no floor stated and a one-week cap under DNSSEC [D]. Positive staleness after an update is the old TTL plus resolver and loader caches; a not-found answer is cached for min(SOA TTL, SOA minimum) (research 05 F12: measured 300 to 1,800 s). Consequence for CI: **query authoritative servers (`dig @ns`) first** and only then the public DoH resolvers, otherwise the check itself can pin "no record" for a brand-new name; create the record before the loader is ever enabled for a domain. Plan on 300 s as the default and pre-lower before a planned cutover. *Confidence: Medium-High. Sources: S2-S6, S32 (research 05).*

- **F23. DNSSEC in the pipeline.** CI does not manage DNSSEC keys, but must not break them: Route 53 recommends CloudWatch alarms on `DNSSECInternalFailure` and `DNSSECKeySigningKeysNeedingAction` and requires the parent to support DS queries; Cloudflare adds the DS automatically only for its own registrar and `.ch`/`.cz`; deSEC publishes the DS list for you to give the registrar [D]. The DoH JSON APIs expose validation as `AD` without a `do` flag, bogus data returns `Status:2`, never send `cd=1` (research 05 F5). Pipeline rule: after each update, if the parent has a DS for the zone then both DoH resolvers must return `AD:true`; a flip from true to false, or SERVFAIL, is an incident (validating resolvers will refuse the zone). Do not make `AD` a precondition for publishing: only about 4 to 5 percent of .com domains are signed (2023-24 data, OLD). *Confidence: High. Sources: S5, S6, S7, S32.*

### D. Signing, secrets and CI security

- **F24. External signers work after DER to raw conversion.** AWS KMS `Sign` returns ECDSA signatures "DER-encoded ... as defined by ANSI X9.62-2005 and RFC 3279 Section 2.2.3"; the project's `verify()` takes the raw 64-byte `r||s` [D][C]. A 20-line converter (strip ASN.1 sign-padding zeros, left-pad short integers) made **120 of 120 openssl-produced signatures verify** against `src/chain/crypto.js`, with DER lengths of 69 to 72 bytes; truncating the DER blob without converting always failed [X]. The same converter applies to KMS, PIV/PKCS#11 tokens and Vault-style signers [I]. *Confidence: High. Sources: S10, S33, S34 (E2).*

- **F25. KMS properties that matter here.** Message up to 4,096 bytes with `MessageType: RAW` (a pointer's signing input is under 1 KiB); `ECDSA_SHA_256` with an `ECC_NIST_P256` key; `kms:Sign` is a separate permission from key administration; the API reference advises to "limit the time during which any signature is effective" and to include a timestamp in the signed message, which is what `exp` and `seq` are for [D]. Cost in F14. *Confidence: High. Sources: S10.*

- **F26. GitHub changed the OIDC `sub` format on 2026-07-15.** Repositories created after July 15, 2026 default to `repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH`; older repositories keep the name-only format unless the organization or repository opts in; renames and transfers after that date also switch; not available on GitHub Enterprise Server [D]. The `aws-actions/configure-aws-credentials` README (v6.3.0) repeats it (workflows in repositories created before 15 July 2026 omit the `@<ORG_ID>`/`@<REPO_ID>` suffixes unless opted in, and jobs in GitHub environments include an `environment:` stanza) [D]; GitHub's stated reason is that a recycled owner or repository name could otherwise mint the same subject value [D, verified verbatim]. A trust policy must match whichever format the repository emits. The environment-scoped string in the new format is not shown on either page, so `repo:OWNER@OWNER-ID/REPO@REPO-ID:environment:NAME` is **inferred** [I]; print and decode the real token claims once (Appendix E) before writing a trust policy. IAM trust policies only see `aud` and `sub`; to bind the workflow file, customise the `sub` claim to include `job_workflow_ref` (documented example: `repo:...:environment:prod:job_workflow_ref:org/repo/.github/workflows/oidc.yml@refs/heads/main`) [D]. *Confidence: High (format and date), Low (environment string). Sources: S8, S9.*

- **F27. GitLab OIDC.** `id_tokens:` with `aud`; default `sub` is `project_path:{group}/{project}:ref_type:{type}:ref:{branch_name}`; claims include `ref_protected`, `environment_protected` and `deployment_tier` (GitLab 18.7+); on GitLab.com the AWS provider exposes `namespace_id`, `project_id`, `ref_protected`, `pipeline_source` and more as condition keys; GitLab recommends stable IDs over paths; tokens are RS256 and expire at the job timeout or after 5 minutes [D]. `resource_group` serialises deployments; process modes `unordered` (default), `oldest_first`, `newest_first`, `newest_ready_first` are set through the API, not YAML [D]. *Confidence: High. Sources: S13.*

- **F28. Human gates and the blast radius of a workflow.** GitHub environments: up to six required reviewers (one approval suffices), "prevent self-review", wait timers of 1 to 43,200 minutes, deployment branch and tag restrictions, and environment secrets withheld until approval; administrators can bypass unless disabled; on private repositories reviewers and timers need a paid plan (Free is not listed) [D]. Combined with the three-role split in Appendix A, a compromised build job can neither sign nor write DNS. *Confidence: High. Sources: S17.*

- **F29. Supply-chain evidence and current GitHub controls.** CISA (revised 2025-03-26): `tj-actions/changed-files` (CVE-2025-30066, exposure window 2025-03-12 to 03-15) and `reviewdog/action-setup@v1` (CVE-2025-30154) were compromised; secrets exposed included access keys, GitHub PATs, npm tokens and private RSA keys; both were added to the Known Exploited Vulnerabilities catalog on 2025-03-26 [D]. Controls now available: an Actions policy that fails any workflow using an action not pinned to a full commit SHA, plus a `!` denylist (changelog 2025-08-15); **workflow dependency lockfiles** (`.github/workflows/actions.lock`, generated by `gh actions-lock`, public preview) which GitHub says supersede SHA pinning for repositories that adopt them; `actions/checkout` v7 (GA 2026-06-18) refuses fork-PR checkouts in `pull_request_target` and `workflow_run` by default, with the `allow-unsafe-pr-checkout` opt-out backported to v4.4.0, v5.1.0, v6.1.0 (enforcement 2026-07-20; SHA-pinned workflows do not pick the backport up automatically) [D]. The IPFS deploy action documents the `workflow_run` split and a trap: `workflow_run.head_branch` is attacker-controlled for fork PRs, so gate production on `workflow_run.event == 'push'` as well [D]. *Confidence: High. Sources: S22, S14-S16, S24.*

- **F30. Rollback must be a roll-forward; precedents agree.** ARCHITECTURE section 4: `seq` is monotonic per scope and "the resolver refuses a signed record with `seq` lower than the cached one for the same owner key" [D, project]. TUF clients refuse metadata whose version is lower than one they already trust, metadata has an expiry time, and fast-forward-attack recovery exists (spec v1.0.37, last modified 2026-10-08); BEP 44 mutable items carry a monotonic `seq` and an optional `cas` that makes the store fail with error 301 on mismatch (OLD) [D]. So "rollback by re-pointing" means signing the **old btih again with a new, higher `seq` and a fresh `exp`**; an old signed record is never republished; the DNS write uses the CAS batch of F15 as the analogue of BEP 44's `cas`. Corollary: the old release prefix must still exist and still verify (retention, F8). *Confidence: High. Sources: S32, S11, S12.*

- **F31. `exp` and scheduled renewal can silently stop.** In public repositories "scheduled workflows are automatically disabled when no repository activity has occurred in 60 days"; schedule runs can be delayed under load and some queued jobs may be dropped; the shortest interval is 5 minutes; the workflow file must be on the default branch [D]. A monthly "renew pointer" cron that is the only thing keeping `exp` in the future will therefore die on a quiet repository. In `src/loader/app.js`, `vet()` runs `verifyPointer` (signature and `exp`, per INTERFACES) for every source including the cache fallback and treats any failure as a rejection, so an expired signed pointer with no valid alternative ends in `E_POINTER` [C][I]. Either the loader treats an expired pointer as stale-but-usable with a banner, or `exp` is omitted in v1, or an external heartbeat exists. *Confidence: High (GitHub behaviour), Medium (policy). Sources: S18. design_critical (it decides whether `exp` may be a hard failure).*

### E. Channels, semver, previews, IPFS-land

- **F32. Channels are mutable pointers to immutable versions; npm is the precedent.** npm dist-tags are aliases for versions: `latest` is the default, `--tag=beta` publishes to another stream, and a tag that is a valid semver range is rejected (so avoid tags that start with a number or `v`) [D]. Mapping: release = immutable `{semver, git sha, btih}`; channel = the signed pointer at `_magnet.<channel-host>`; tag names `prod` and `beta` (not `v1`). Because the signature binds the scope hostname (ARCHITECTURE section 4) and the default chain id is `host:<hostname>`, **promotion is a re-sign for the new scope** (same btih, new seq, same or shared `chain=`), and beta data does not leak into prod unless `chain=` is set. *Confidence: High. Sources: S23, S32.*

- **F33. PR previews need no DNS.** Hub mode accepts `https://<loader>/#magnet:?xt=urn:btih:...&ws=...&xs=...` (ARCHITECTURE section 3). The IPFS deploy action's pattern - a PR comment with the CID and preview link, posted by a privileged `workflow_run` job after an unprivileged build - maps directly: upload the staged tree to `pr/<n>/<btih8>/`, comment the hub URL, expire the prefix with a lifecycle rule, and allow it only for same-repository PRs [D][I]. `permaweb-deploy` (Arweave) offers the same idea (`preview: 'true'` derives a name from repo and PR number and comments) [D]. *Confidence: Medium-High. Sources: S24, S25, S32.*

- **F34. What IPFS-land does that is worth copying, and its status.** `ipshipyard/ipfs-deploy-action` separates *merkleization* (deterministic CAR and root CID, CAR attached as a workflow artifact) from *pinning* (follow-up steps for Kubo, IPFS Cluster, Filecoin, Pinata, Filebase), auto-comments the CID and preview links, and documents the two-workflow fork-safe pattern; `ipshipyard/dnslink-action@v1` upserts one TXT per provider (Cloudflare, DNSimple, Gandi; **no Route 53**), auto-discovers or creates the record id, and **fails if duplicate records exist**; it documents the sandbox-zone CNAME (F20) [D]. Status: the deploy action's README says "Provided as-is. There is no maintainer at the moment" and "Shipyard's IPFS maintenance work ended on September 30, 2026"; the Shipyard post of 2026-08-24 says Protocol Labs "will not be renewing Shipyard's funding", lists Kubo, Helia, Boxo, Rainbow, IPFS Desktop, IPFS Companion, Someguy, Service Worker Gateway and IPFS Check as losing dedicated maintainers, and says Protocol Labs will decide the future of ipfs.io, dweb.link and the bootstrap nodes [D]. The earlier DNS research relied on `@helia/dnslink` and `@multiformats/dns`; those libraries now have no dedicated maintainer [D][I]. Copy patterns, do not take dependencies. *Confidence: High. Sources: S24.*

- **F35. OIDC publishing and provenance have mainstream precedent.** npm trusted publishing (docs edited 2026-10-06): GitHub Actions, GitLab CI/CD and CircleCI on cloud runners, `id-token: write`, npm CLI 11.5.1+ and Node 22.14+, provenance generated automatically, and a trusted-publisher record that is bound to an exact, case-sensitive workflow filename and is not validated when saved [D]. GitHub artifact attestations give SLSA v1.0 Build L2 (L3 with reusable workflows); public repositories write to a public transparency log, private repositories use GitHub's own Sigstore instance with **no transparency log**; consumers run `gh attestation verify` [D]. *Confidence: High. Sources: S23, S19.*

- **F36. Serialising releases.** The default GitHub concurrency behaviour is one running plus one pending run, and a newer arrival **cancels** the older pending run; `queue: max` keeps up to 100 pending runs in FIFO order and cannot be combined with `cancel-in-progress: true` (docs example: `concurrency: { group: production-deploy, queue: max }`) [D]. A release pipeline that mints `seq` from published state must not drop a queued tag. GitLab: `resource_group` (F27). *Confidence: High. Sources: S18, S13.*

---

## Concrete recommendations for magnet-web

Priority: P0 = needed for correctness or security of the first production release; P1 = needed for a dependable operation; P2 = valuable, can follow; P3 = optional. Effort: S = under a day, M = days, L = a week or more. "F#" points at the finding that supports the row.

| # | What to build or change | Pri | Eff | Why (evidence) |
|---|---|---|---|---|
| R1 | **Add `xs=<https URL of site.torrent>` and an informational `rel=<semver>` to the pointer grammar** (ARCHITECTURE section 4, `parsePointer`/`formatPointer`, `pointer.txt`, `meta.html`). Loader tries `xs` first, then peers. CI always uploads the `.torrent` beside the seed: `Content-Type: application/x-bittorrent`, `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`. Unknown keys are already ignored and covered by the signature, so old loaders stay compatible. | P0 | S | F5 (ws alone cannot bootstrap; code + lab), F6 (size stays at 2 strings) |
| R2 | **Implement `mw pack` from the tested sketch** (Appendix C.7): manifest-driven allow/deny list (not a blanket dotfile rule), UTF-8 byte-wise sort, fixed `name`, fixed `pieceLength` (256 KiB), `creationDate` = commit time and `> 0`, `announce: []`, outputs `site.torrent`, `release.json` (no wall-clock fields) and a **staged `tree/`** that is the only thing uploaded. CI repacks a copy from another path and fails on any difference. | P0 | M | F2, F3, F4 (E1, E7) |
| R3 | **`mw seed-verify` as a hard gate** (tested prototype, Appendix C.5): preflight with `cache-control,range,user-agent`, then every piece via Range on the PUBLIC URL (status 206, exact `Content-Range`, SHA-1), sending `Origin` and `Accept-Encoding: identity`; warn on a second pass with `gzip, br`; skip the preflight when seed and loader share an origin. Run after upload, before every pointer change (rollback included), and sampled in the daily canary. It overlaps with `tools/verify-origin.mjs` in `docs/research/w2a-05-seo-crawlers.md` R2 (fetch every file over HTTP, compare to the torrent hashes, flag hosts that answer Range with 200): build **one** tool with two modes, an origin check by full GET and a seed check by Range plus preflight. | P0 | M | F7, F9-F13 (E5, E6, host probe), S36 |
| R4 | **Immutable release prefix** `r/<semver>-<btih8>/<name>/...` plus `r/<id>/site.torrent`; CI refuses to write into an existing prefix; optional hard enforcement with a per-object `aws s3api put-object --if-none-match '*'` uploader and the `s3:if-none-match` bucket policy (R2 supports the same header); retention = last 10 releases + every release any channel points to + a rollback window; a GC job. | P0 | S | F7, F8, F30 |
| R5 | **Rollback is roll-forward.** `rollback.yml` re-signs the old btih with `seq = published + 1` and a fresh `exp`; never republish a stored signed pointer; keep `release.json` + `.torrent` as GitHub Release assets as the rollback source. Derive `seq` from the published state (authoritative DNS), not the clock; write DNS with the DELETE+CREATE compare-and-swap; serialise with `concurrency: { group, queue: max }`. | P0 | S | F30, F15, F36 |
| R6 | **CI security baseline.** `permissions: {}` at workflow level; a build job with no `id-token`, no secrets, `npm ci --ignore-scripts`; **three OIDC roles** (seed writer, signer, DNS writer) each behind its own GitHub environment (prod: required reviewers, prevent self-review, tag-only deployment rule, admin bypass off); every action pinned to a full SHA (Dependabot) with the org policy that fails unpinned actions, or the lockfile once GA; `actions/checkout` v7 with `persist-credentials: false`; CODEOWNERS on `.github/workflows`; production jobs gated on `workflow_run.event == 'push'` where `workflow_run` is used; no third-party action ever receives DNS or signing credentials (`aws` CLI, `curl` and repo scripts only). The lint in `labs/w2a-06-lab/wf/lint.rb` encodes four of these rules. | P0 | M | F26-F29 (CISA tj-actions alert, GitHub controls) |
| R7 | **Signing paths.** Default: KMS `ECC_NIST_P256` key, `kms:Sign` role, `GetPublicKey` for the `owner=` value, DER to raw conversion in `mw pointer finish` (tested). Simple path: owner JWK as an environment secret (documented as weaker). Offline path: CI emits `signing-input.txt`, the owner signs with `openssl dgst -sha256 -sign` or a PIV/PKCS#11 token, uploads `sig.der`, CI verifies with the browser's own `verifyPointer` before publishing. | P0 | M | F24, F25 (E2) |
| R8 | **Ship tested CORS/header templates and a host decision table.** S3 CORS (`AllowedHeaders ["*"]`), CloudFront **custom** response-headers policy (`Access-Control-Allow-Headers: *`, methods GET/HEAD/OPTIONS, max age 86400) instead of the managed CORS-With-Preflight policy, R2 S3-style CORS JSON, B2 S3 CORS (max age 0 to 86400, XML under 100 KB). State plainly that GitHub Pages (405) and the sampled Vercel, Netlify and Cloudflare sites failed the cross-origin preflight, so treat those hosts as **same-origin seeds only** until a `seed-verify` run proves otherwise. | P0 | S | F9-F12 |
| R9 | **No-DNS mode as a first-class path.** CI emits `pointer.txt`, `meta.html` and publishes the signed pointer as a same-origin file at a **non-dot path** (for example `/_mw/pointer.txt`; `.well-known/magnet` only where dotfiles are served) so a site on any registrar migrates with zero DNS credentials. Add that file to the loader's source order (`resolvePointer()` has no such source today). A `<meta>` tag cannot carry a drop-in site's own pointer: it would be inside the payload it names (F6b). | P0 | S | F3, F6b, F12, F19 |
| R10 | **DNS publisher modules behind one interface** (`read(name)`, `cas(name, old, new, ttl)`, `wait()`): `route53` first, then `cloudflare` (batch endpoint, zone-scoped token) and `desec` (bulk atomic, policy-scoped token), then `gandi`, `ovh` (explicit refresh), `porkbun` (`editByNameType`, `dryRun`). Every module splits strings at 255 bytes and refuses to write when the name holds more than one TXT value (the `dnslink-action` rule). | P1 | M | F15-F21 |
| R11 | **CNAME delegation docs and `mw dns plan`.** For registrars without a safe API print the one-time CNAME (`_magnet.example.com CNAME example-com.<pointer-zone>`) and the sandbox-zone TXT, or a paste-ready Route 53 JSON / zone-file line. | P1 | S | F19, F20 |
| R12 | **Loader web-seed circuit breaker** (cross-topic, loader agent): count `Piece N failed verification` per web seed, drop the seed after N (suggest 5) in a window, back off, show "web seed is serving the wrong bytes (release `<id>`)". Protects the CDN bill. | P1 | M | F7 (E6) |
| R13 | **PR previews without DNS.** Unprivileged build workflow, then a `workflow_run` deploy job (same-repository PRs only) uploads the staged tree to `pr/<n>/<btih8>/` and comments the hub URL `https://<loader>/#magnet:?xt=urn:btih:...&ws=...&xs=...`; a lifecycle rule expires `pr/` after 14 days. | P1 | S | F33 |
| R14 | **Channels and semver.** Channels are hostnames (`_magnet.beta.example.com`); tags `vX.Y.Z` publish prod, pre-release tags and `main` publish beta; `promote.yml` re-signs a beta release for the prod scope with the same btih; channel names avoid a leading digit or `v`; `rel=` shown in the loader's details panel. | P1 | M | F32 |
| R15 | **TTL and verification policy.** Default TTL 300 s, pre-lowered before planned cutovers; verification order authoritative (`dig @ns`) then DoH (Cloudflare and Google) then `AD` check when the parent has a DS; 15-minute wait budget; never `cd=1`; alarm if `AD` flips. | P1 | S | F22, F23 |
| R16 | **`exp` policy.** v1 default: no `exp`, or at least 180 days, and the loader treats an expired pointer as stale-but-usable with a banner. If `exp` is used, pair the renew workflow with an EXTERNAL heartbeat. | P1 | S | F31 |
| R17 | **Production canary.** Daily scheduled job plus one external uptime check: resolve the pointer via DoH quorum (check `seq`, `exp` margin, signature, `AD`), run `seed-verify` on a sampled 10 percent of pieces, load the site in Chromium, open an issue on failure. | P1 | M | F31, F9 |
| R18 | **Provenance and records.** Each release creates GitHub Release `rel-<id>` with `site.torrent`, `release.json`, `pointer.txt`; public repositories add `actions/attest` for the torrent and `release.json` (private repositories get no transparency log). | P1 | S | F35 |
| R19 | **Reproducibility checklist per generator**: lockfile install, pinned Node, `SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)`, fixed build id (Next.js `generateBuildId` = git sha), no build timestamps in output; the double-pack guard fails the release on any btih difference. | P1 | S | F4 |
| R20 | **Split `tools/publish.mjs` into pure stages** with files as the interface (`pack`, `pointer build`, `pointer finish`, `seed-verify`, `dns publish`, `dns check`, `smoke`; contract in Appendix B) so CI jobs with different privileges run different stages, and every stage can run locally with `--dry-run`. | P1 | M | F1, F28 |
| R21 | **Delegated release key (TUF-style).** Reserve an optional `del=` slot in the grammar now (certificate signed by the pinned owner key naming a delegate public key, scope and `notAfter`) so CI can hold a short-lived key while the root stays offline and rotation avoids a TOFU re-confirmation prompt; implement after v1. | P2 | L | F30 (TUF), F24 |
| R22 | **Peer-carried pointer** (cross-topic, chain-net): gossip the newest signed pointer over the `mw_chain` extension so a hotfix or rollback is not bounded by DNS TTL or the 10-minute re-check. | P2 | M | F22, F30 |
| R23 | **GitLab CI template or component** equivalent to Appendix A (`id_tokens`, `resource_group`, protected environments; approval features by tier are unverified). | P2 | M | F27 |
| R24 | **Terraform/OpenTofu guidance**: exclude the pointer record from drift or manage it only from CI. | P2 | S | F21 |
| R25 | **Bucket lifecycle and cost report** using the quoted R2/B2/KMS prices and the request math. | P2 | S | F14 |
| R26 | **Hosting decision table for drop-in mode**: (A) second copy under `/_mw/seed/<rel>/<name>/` on the same origin; (B) an internal rewrite `/<name>/* -> /*` where the host supports it (unverified per host); (C) a separate seed hostname with CORS and CDN transforms off. | P2 | S | F12, F13 |
| R27 | **Optional IPFS interop** (CAR plus DNSLink beside the torrent) only if a maintained toolchain exists; today copy the patterns, not the tools. | P3 | M | F34 |


### Adoption path for an existing site (each step ships on its own)

1. **Dry run, no site change.** Run `pack` and `seed-verify` locally against the current build output and the current host (same-origin seed). Output: the infohash, the file list the torrent will contain, and a pass/fail on Range, compression and CORS for the host actually in use (F9-F13).
2. **Drop-in with no DNS.** Add the one idempotent `<script>` tag (built into the artifact before packing), add the `seed` job that uploads the staged tree, and publish the signed pointer as a same-origin file plus `<meta>` (R9). The static copy keeps serving crawlers and no-JS visitors from the same staged tree.
3. **Make releases immutable.** Per-release prefixes, the `seed-verify` gate before every pointer change, retention and GC (R3, R4).
4. **Move the signing key out of the repository.** KMS-held key or an environment secret behind a reviewer-gated environment; split roles (R6, R7).
5. **Add the DNS pointer as a second source.** Route 53 directly, or a CNAME to a sandbox zone for Cloudflare, deSEC and everything else; keep the same-origin file as the fallback (R10, R11).
6. **Add channels and previews.** `beta` host, `promote.yml`, PR previews through the hub URL (R13, R14).
7. **Operate it.** Canary, external heartbeat, `exp` policy, provenance (R15-R18).

---

## Gotchas

1. **`create-torrent` directory mode drops `.well-known/`, `.htaccess` and every dot-entry**, and follows raw `readdir` order. Pass an explicit sorted list. [X]
2. **`creationDate: new Date(0)` becomes the current time** (zero is falsy), and `.torrent` bytes then differ per run while the infohash does not. [X][C]
3. **8 default trackers** (5 UDP, 3 WSS) are baked into the file unless `announce: []`. [X]
4. **Default piece length is 16 KiB for sites under about 16 MiB**: 640 pieces and up to 640 Range requests for 10 MiB. Fix 256 KiB. [X]
5. **JavaScript's default sort is UTF-16 order**; use UTF-8 byte order (`Buffer.compare`). In byte order `😀.txt` sorts after `js/app.js`. [X]
6. **`aws s3 cp/sync` uploads `.DS_Store` and every dotfile**, while the torrent filters junk: upload the staged tree, not `dist/`. [X]
7. **`upload-artifact` and `upload-pages-artifact` skip dotfiles by default**: set the include-hidden input or `.well-known` vanishes between jobs and from Pages. [D]
8. **A signed pointer is more than 255 bytes.** Route 53 wants `"a" "b"` in `Value`; the Terraform AWS provider adds the outer quotes itself (research 05); Cloudflare, DNSControl and deSEC split long strings automatically (deSEC still requires the quotes); Gandi's examples are quoted. [D][X]
9. **Route 53**: `UPSERT` counts double against the 1,000-element and 32,000-character limits; `DELETE` needs the exact old values; `PriorRequestNotComplete` means retry with backoff; with DNSSEC the TTL is capped at one week and the KSK (a KMS key you own) needs alarms. [D]
10. **deSEC**: minimum TTL is server-set (documented example 3600); 100 RRset writes per hour per domain; tokens with `max_age` or `max_unused_period` expire and break CI silently. [D]
11. **Cloudflare**: a token cannot (per the page read) be limited to one record; one 429 blocks all calls for five minutes; the edge is not updated atomically by a batch. [D]
12. **Porkbun**: `editByNameType` replaces **all** matching records; API access is opt-in per domain; TXT quoting and length are not documented. [D][U]
13. **OVH**: the API schema has a separate `POST /domain/zone/{zone}/refresh` ("Refresh the zone"); changes are expected to be live only after it (behaviour from OVH practice, not verified here). [D][U]
14. **Namecheap, GoDaddy, Squarespace Domains**: not verified in this session; treat as manual or delegated. [U]
15. **GitHub OIDC `sub` changed on 2026-07-15** for new repositories (and for renames and transfers after that date); a name-only trust policy then fails. Decode a real token once before writing the policy. [D]
16. **IAM sees only `aud` and `sub`** from the GitHub token; to pin the workflow file, customise `sub` to include `job_workflow_ref`. [D]
17. **Environment approvals on private repositories need a paid plan**, and administrators can bypass protection rules unless disabled. [D]
18. **Scheduled workflows are disabled after 60 days without repository activity** in public repositories and can be delayed or dropped under load. [D]
19. **Default concurrency cancels the older pending run**; use `queue: max` or you can lose a release. [D]
20. **`workflow_run.head_branch` is forgeable by fork PRs**: gate on `workflow_run.event == 'push'`. [D]
21. **SHA-pinned workflows do not receive the checkout v7 `pull_request_target` backport automatically.** [D]
22. **WebTorrent keeps hammering a bad web seed** (about 5,800 requests per second on loopback). Overwriting a release prefix in place, or any CDN rewrite, therefore becomes a request storm. [X]
23. **Overwrite-in-place plus `Cache-Control: immutable`** serves mixed old and new bytes for as long as any cache keeps the old copy. [I]
24. **Preflight**: GitHub Pages answers OPTIONS with 405, the Netlify, Vercel and Cloudflare samples send no CORS headers, jsDelivr and the CloudFront managed policy send no `Access-Control-Allow-Headers`. [X][D]
25. **R2**: purge the hostname cache after changing CORS; browsers may cap the preflight cache at two hours whatever `MaxAgeSeconds` says. [D]
26. **Compression over Range**: GitHub Pages and jsDelivr return `Content-Range` for the compressed representation when gzip is accepted; CloudFront returned a full 200. Chromium sends `identity` with Range, other engines unverified. [X][U]
27. **A host that ignores Range answers 200**; WebTorrent only checks `res.ok`, hashes the body as a piece and fails the hash. [X][C]
28. **KMS returns DER**; the loader wants raw 64-byte `r||s`; asymmetric requests are outside the free tier; `RAW` messages are limited to 4,096 bytes. [D][X]
29. **Never poll public resolvers for a brand-new name** before it exists (negative caching up to the SOA minimum); check the authoritative servers first. [D]
30. **`seq` from the wall clock** is dangerous: one mistaken far-future value locks the channel because loaders refuse lower values. [I]
31. **Key rotation without delegation** forces a "publisher key changed" confirmation on every visitor, which is exactly the prompt an attacker wants to imitate. [I]
32. **Unicode file names**: HFS-era NFD and NFC names can differ only by normalization; pack bytes, and fail the build on case-fold or normalization collisions. [I]
33. **IPFS tooling has no maintainer after 2026-09-30**: the DNSLink and deploy actions are patterns, not dependencies. [D]
34. **Research environment note**: on this machine Homebrew Python's `urllib` hung with zero CPU while Apple `curl` worked (probable cause: the LuLu outbound firewall described in the user's notes; not verified), so every web probe uses `curl`. Not a project issue.

---

## Open questions

1. **Firefox and Safari**: do they send `Accept-Encoding: identity` with Range, and which request headers do they list in the preflight (`user-agent`)? Firefox and WebKit were not installed here; the Playwright run should be repeated with them (research 01 already asks for this).
2. **CloudFront end to end**: does a custom response-headers policy with `Access-Control-Allow-Headers: *` plus an S3 origin pass WebTorrent's preflight and Range with compression enabled? No distribution was available to test.
3. **Namecheap, GoDaddy and Squarespace Domains**: API availability, access gating, IP allowlists and whether a single TXT can be set without touching other records.
4. **Cloudflare**: any record-level token scoping or OIDC/workload-identity federation for CI that the pages read do not mention?
5. **Porkbun, Gandi, OVH**: behaviour for TXT values above 255 bytes and total length caps; Gandi snapshot restore.
6. **Exact environment-scoped `sub` string** under the immutable GitHub format (inferred in F26), and whether the AWS provider accepts `StringLike` with `@` in it without escaping.
7. **Is `queue: max` generally available** (it is in the docs today) and does it exist for reusable-workflow callers?
8. **Live propagation latency** from Route 53, Cloudflare and deSEC to Cloudflare and Google DoH caches. Needs a test zone the project controls; none was available.
9. **`exp` semantics**: hard failure or stale-but-usable? (R16) This decides whether the renew workflow is critical infrastructure.
10. **Grammar and loader decisions for the architect**: add `xs`, `rel`, a reserved `del`; add a same-origin pointer file as a loader source and decide its path (`/_mw/pointer.txt` is a suggestion) (R1, R9, R21, F6b).
11. **Drop-in seed layout**: second copy (2x storage) versus internal rewrite versus separate hostname; which does the migration agent want as the default?
12. **Who owns the web-seed circuit breaker and pointer gossip** (loader and chain-net agents)? Both reduce operational risk more than any CI step can.
13. **Wildcard and multi-record TXT at the apex of a channel host**: should staged rollouts (percentages) ever be expressed in DNS? The current rule treats two different valid records as a conflict.
14. **Reconcile `w2a-05` R1 with F6b before `tools/publish.mjs --embed` is written**: which parts of the embedded-mode injection may enter the torrent, and where the pointer lives (R1, R9).
15. **Unexamined comparables** because of the exhausted search budget: Fleek, Storacha/web3.storage `add-to-web3`, Pinata's action, Arweave ArNS undernames.

---

## Appendix A - Reference workflows (GitHub Actions, GitLab outline)

Files are in `docs/research/labs/w2a-06-lab/wf/`. They parse as YAML and pass `ruby wf/lint.rb` (top-level `permissions: {}`, every action pinned, no npm job with `id-token: write` or `contents: write`, `id-token: write` only where a role is assumed or a reusable workflow is called, `persist-credentials: false` on every checkout) [X]. The `tools/mw.mjs` subcommands they call are specified in Appendix B and are **not written yet**; `pack` and `seed-verify` have tested prototypes (Appendix C). Every action reference is pinned to a full commit SHA that was resolved through the GitHub API on 2026-10-17 (note after A.1).

**Trust boundaries.** Each privilege lives in exactly one job, behind its own environment:

| Job | Runs site dependencies? | Credentials | AWS role | Environment / approval |
|---|---|---|---|---|
| `plan`, `pack`, `smoke` | no site code (`smoke` installs the tool's own lockfile with `--ignore-scripts`) | none | none | none |
| `build` | **yes** (`npm ci`) | none, read-only token | none | none |
| `seed` | no | OIDC | `mw-seed-writer`: `s3:PutObject` under `r/*` | `production` (reviewers) or `beta` |
| `sign` | no | OIDC | `mw-signer`: `kms:Sign` on one key + read-only Route 53 | `production-sign` (a second approval) |
| `dns` | no | OIDC | `mw-dns-writer`: Route 53 writes limited by name, type and action | `production-dns` |
| `release` | no | `contents: write` | none | none |

### A.1 `.github/workflows/publish.yml`

```yaml
# .github/workflows/publish.yml  (reference outline; tools/mw.mjs subcommands are specified in section C, not yet written)
name: publish
run-name: publish ${{ github.ref_name }} (${{ github.event_name }})

on:
  push:
    tags: ['v[0-9]*.[0-9]*.[0-9]*']          # v1.4.2 -> prod channel; v1.5.0-rc.1 -> beta (decided in `plan`)
    branches: [main]                         # every merge to main -> beta channel
  workflow_dispatch:
    inputs:
      channel: { description: 'channel for a manual run', type: choice, options: [beta, prod], default: beta }

permissions: {}                              # deny everything; each job re-grants only what it needs

concurrency:
  group: mw-publish
  queue: max                                 # FIFO, up to 100 pending. The default (single) cancels older pending runs.

env:
  SITE_NAME: site                            # torrent name: constant across releases (part of the infohash and of the seed layout)
  PIECE_LENGTH: '262144'                     # 256 KiB; create-torrent's default would be 16 KiB for sites under ~16 MiB
  CDN: https://seed.example.com              # web seed origin. Drop-in mode: the site's own origin (same-origin, no CORS needed)

jobs:
  plan:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    outputs:
      channel: ${{ steps.p.outputs.channel }}
      host: ${{ steps.p.outputs.host }}
      version: ${{ steps.p.outputs.version }}
      epoch: ${{ steps.p.outputs.epoch }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - id: p
        env: { DISPATCH_CHANNEL: "${{ inputs.channel }}" }
        run: |
          set -euo pipefail
          case "$GITHUB_REF" in
            refs/tags/v*-*) CH=beta; V="${GITHUB_REF_NAME#v}" ;;
            refs/tags/v*)   CH=prod; V="${GITHUB_REF_NAME#v}" ;;
            *)              CH="${DISPATCH_CHANNEL:-beta}"; V="0.0.0-edge.$(git rev-parse --short=8 HEAD)" ;;
          esac
          if [ "$CH" = prod ]; then HOST=example.com; else HOST=beta.example.com; fi
          { echo "channel=$CH"; echo "host=$HOST"; echo "version=$V"; echo "epoch=$(git log -1 --pretty=%ct)"; } >> "$GITHUB_OUTPUT"

  build:                                      # runs the site's npm dependencies: NO id-token, NO secrets, read-only token
    needs: plan
    runs-on: ubuntu-latest
    permissions: { contents: read }
    env: { SOURCE_DATE_EPOCH: "${{ needs.plan.outputs.epoch }}" }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci --ignore-scripts && npm run build      # lockfile install; pin generators' build ids (e.g. Next.js generateBuildId = git sha)
      - run: node tools/mw.mjs inject dist --script /_mw/boot.js   # drop-in mode only: ONE idempotent <script> tag, added BEFORE the torrent is made
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with: { name: dist, path: dist, include-hidden-files: true, if-no-files-found: error, retention-days: 7 }

  pack:                                       # still no secrets: deterministic torrent + staged tree + release.json
    needs: [plan, build]
    runs-on: ubuntu-latest
    permissions: { contents: read }
    outputs:
      rel: ${{ steps.r.outputs.rel }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: dist, path: dist }
      - id: r
        env: { VERSION: "${{ needs.plan.outputs.version }}", EPOCH: "${{ needs.plan.outputs.epoch }}" }
        run: |
          set -euo pipefail
          node tools/mw.mjs pack dist --name "$SITE_NAME" --piece-length "$PIECE_LENGTH" --created "$EPOCH" --version "$VERSION" --out out
          cp -R dist /tmp/dist-again && node tools/mw.mjs pack /tmp/dist-again --name "$SITE_NAME" --piece-length "$PIECE_LENGTH" --created "$EPOCH" --version "$VERSION" --out /tmp/out-again
          cmp out/release.json /tmp/out-again/release.json   # determinism guard: same btih from a different path/mtime/walk order
          echo "rel=$(jq -r .rel out/release.json)" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with: { name: release, path: out, include-hidden-files: true, if-no-files-found: error, retention-days: 90 }

  seed:                                       # first job that can write anywhere: OIDC -> AWS role limited to the seed bucket
    needs: [plan, pack]
    runs-on: ubuntu-latest
    environment: ${{ needs.plan.outputs.channel == 'prod' && 'production' || 'beta' }}   # prod: required reviewers + tag-only deployment rule
    permissions: { id-token: write, contents: read }
    env: { REL: "${{ needs.pack.outputs.rel }}", BUCKET: example-mw-seed, HOST: "${{ needs.plan.outputs.host }}" }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: release, path: out }
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: arn:aws:iam::111122223333:role/mw-seed-writer   # trust policy: aud + sub only (repo-ID 'immutable' sub format since 2026-07-15, environment-scoped); to pin the workflow file, customise the sub claim to include job_workflow_ref
          aws-region: us-east-1
          role-duration-seconds: 900
      - name: upload staged tree + .torrent to an immutable release prefix
        run: |
          set -euo pipefail
          P="s3://${BUCKET}/r/${REL}"
          if [ -n "$(aws s3 ls "$P/" | head -n1)" ]; then echo "::error::$P exists; releases are immutable"; exit 1; fi
          aws s3 sync out/tree "$P/${SITE_NAME}/" --only-show-errors --content-type application/octet-stream --cache-control 'public, max-age=31536000, immutable'
          aws s3 cp out/site.torrent "$P/site.torrent" --only-show-errors --content-type application/x-bittorrent --cache-control 'public, max-age=31536000, immutable'
      - name: verify the PUBLIC seed exactly as a browser would use it (preflight + every piece via Range + sha1)
        run: node tools/mw.mjs seed-verify out/site.torrent "${CDN}/r/${REL}/" --origin "https://${HOST}" --retries 6

  pointer:                                    # sign -> publish -> verify -> smoke, shared with rollback.yml
    needs: [plan, pack, seed]
    permissions: { id-token: write, contents: read }
    uses: ./.github/workflows/pointer.yml
    with:
      channel: ${{ needs.plan.outputs.channel }}
      host: ${{ needs.plan.outputs.host }}
      rel: ${{ needs.pack.outputs.rel }}

  release:                                    # permanent record: .torrent + release.json on a GitHub Release; also the rollback source
    needs: [plan, pack, pointer]
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: release, path: out }
      - env: { GH_TOKEN: "${{ github.token }}", REL: "${{ needs.pack.outputs.rel }}" }
        run: gh release create "rel-${REL}" out/site.torrent out/release.json --repo "$GITHUB_REPOSITORY" --title "release ${REL}" --notes "channel ${{ needs.plan.outputs.channel }}"
```

**Pinned versions** (resolved through the GitHub API on 2026-10-17): `checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1`; `upload-artifact` v7.0.2 = `cf430e030ddbb5b0abf93d22962f4752f3646cd9`; `configure-aws` v6.3.0 = `e1253824e5c10ff9df46874f81ed3ec929e19cfd`; `setup-node` v7.1.0 = `949feb2413d6458794dcd2491c4babbbce0c15c1`; `download-artifact` v8.0.2 = `9000827ccba6bdab643e8b6fd33ac0654aef8333`. Re-resolve with `docs/research/labs/w2a-06-lab/gh_pin.sh <owner/repo>[@tag] ...` (unauthenticated API: 60 requests per hour per IP, and other agents on this machine share that quota; evidence in `gh-pins-2026-10-17.txt`) and let Dependabot keep them current. Each SHA is the dereferenced commit of the action repository's own release tag.

### A.2 `.github/workflows/pointer.yml` (reusable: the only place that signs and the only place that writes DNS)

```yaml
# .github/workflows/pointer.yml  (reusable; the ONLY place that can sign and the ONLY place that can write DNS)
name: pointer
on:
  workflow_call:
    inputs:
      channel:         { type: string, required: true }
      host:            { type: string, required: true }
      rel:             { type: string, required: true }
permissions: {}
env: { CDN: 'https://seed.example.com', ZONE_ID: Z0123456789ABC, TTL: '300' }

jobs:
  sign:
    runs-on: ubuntu-latest
    environment: ${{ inputs.channel == 'prod' && 'production-sign' || 'beta' }}   # prod: second approval, separate from the seed job
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: release, path: out }
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with: { role-to-assume: 'arn:aws:iam::111122223333:role/mw-signer', aws-region: us-east-1, role-duration-seconds: 900 }   # kms:Sign on ONE key + read-only Route 53
      - env: { HOST: "${{ inputs.host }}", REL: "${{ inputs.rel }}" }
        run: |
          set -euo pipefail
          # seq = (currently published seq) + 1, read from the authoritative servers; exp = now + 90 d; scope = the hostname being published
          node tools/mw.mjs pointer build out/release.json --scope "$HOST" --ws "$CDN/r/$REL/" --xs "$CDN/r/$REL/site.torrent" \
               --tr wss://tracker.example.com --exp 90d --seq-from dns --zone "$ZONE_ID" --out ptr
          aws kms sign --key-id alias/mw-owner --message fileb://ptr/signing-input.txt --message-type RAW \
               --signing-algorithm ECDSA_SHA_256 --query Signature --output text | base64 -d > ptr/sig.der
          node tools/mw.mjs pointer finish ptr --der ptr/sig.der   # DER -> raw r||s, append sig=, then run the browser's verifyPointer()
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with: { name: pointer, path: ptr, if-no-files-found: error, retention-days: 90 }

  dns:
    needs: sign
    runs-on: ubuntu-latest
    environment: ${{ inputs.channel == 'prod' && 'production-dns' || 'beta' }}
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
        with: { name: pointer, path: ptr }
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with: { role-to-assume: 'arn:aws:iam::111122223333:role/mw-dns-writer', aws-region: us-east-1, role-duration-seconds: 900 }   # ChangeResourceRecordSets limited by name/type/action condition keys
      - env: { HOST: "${{ inputs.host }}" }
        run: |
          set -euo pipefail
          node tools/mw.mjs dns publish route53 --zone "$ZONE_ID" --name "_magnet.$HOST" --value-file ptr/pointer.txt --ttl "$TTL" --cas   # DELETE(old exact value)+CREATE(new) in one batch, then wait INSYNC
          node tools/mw.mjs dns check "_magnet.$HOST" --expect ptr/pointer.txt --authoritative --doh cloudflare,google --wait 15m          # authoritative first: never prime negative caches

  smoke:
    needs: dns
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - run: npm ci --ignore-scripts && npx playwright install --with-deps chromium
      - env: { HOST: "${{ inputs.host }}", REL: "${{ inputs.rel }}" }
        run: node tools/mw.mjs smoke "https://${HOST}/" --expect-rel "$REL" --timeout 10m   # real browser: resolves the pointer, downloads, renders, reports source=peers|webseed
```

### A.3 `.github/workflows/rollback.yml` (roll forward to an old release with a new `seq`)

```yaml
# .github/workflows/rollback.yml : "rollback" = roll FORWARD to an old release with a NEW seq (loaders refuse a lower seq)
name: rollback
on:
  workflow_dispatch:
    inputs:
      channel: { type: choice, options: [beta, prod], required: true }
      release: { description: 'release id to restore, e.g. 1.4.1-9f8e7d6c', type: string, required: true }
permissions: {}
concurrency: { group: mw-publish, queue: max }
env: { CDN: 'https://seed.example.com' }
jobs:
  fetch:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with: { persist-credentials: false }
      - env: { GH_TOKEN: "${{ github.token }}", REL: "${{ inputs.release }}" }
        run: |
          set -euo pipefail
          gh release download "rel-${REL}" --repo "$GITHUB_REPOSITORY" --dir out
          node tools/mw.mjs seed-verify out/site.torrent "${CDN}/r/${REL}/" --origin "https://$([ '${{ inputs.channel }}' = prod ] && echo example.com || echo beta.example.com)"   # the old prefix must still be intact
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with: { name: release, path: out, if-no-files-found: error }
  pointer:
    needs: fetch
    permissions: { id-token: write, contents: read }
    uses: ./.github/workflows/pointer.yml
    with:
      channel: ${{ inputs.channel }}
      host: ${{ inputs.channel == 'prod' && 'example.com' || 'beta.example.com' }}
      rel: ${{ inputs.release }}
```

### A.4 `.gitlab-ci.yml` outline (same stage contract)

```yaml
# .gitlab-ci.yml (outline; same tools/mw.mjs contract as the GitHub workflows)
stages: [build, pack, seed, pointer, verify]
default: { image: 'node:24' }
variables: { SITE_NAME: site, PIECE_LENGTH: '262144', CDN: 'https://seed.example.com', AWS_REGION: us-east-1 }
.release_rules: &release_rules
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+/'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

build:
  stage: build
  <<: *release_rules
  script:
    - export SOURCE_DATE_EPOCH="$(git log -1 --pretty=%ct)"
    - npm ci --ignore-scripts && npm run build
  artifacts: { paths: [dist/], expire_in: 1 week }

pack:
  stage: pack
  <<: *release_rules
  needs: [build]
  script:
    - node tools/mw.mjs pack dist --name "$SITE_NAME" --piece-length "$PIECE_LENGTH" --created "$(git log -1 --pretty=%ct)" --out out
  artifacts: { paths: [out/], expire_in: 90 days }

seed:
  stage: seed
  <<: *release_rules
  needs: [pack]
  resource_group: mw-publish                  # one deploy at a time; set the process mode (oldest_first) through the API, not in YAML
  environment: { name: production }
  id_tokens: { AWS_TOKEN: { aud: 'sts.amazonaws.com' } }   # RS256 JWT, expires at job timeout or after 5 minutes
  script:
    - ./ci/aws-web-identity.sh "$SEED_ROLE_ARN"            # sts assume-role-with-web-identity (trust policy on project_id / namespace_id / ref_protected)
    - ./ci/upload-release.sh out
    - node tools/mw.mjs seed-verify out/site.torrent "$CDN/r/$(jq -r .rel out/release.json)/" --origin "https://example.com" --retries 6

pointer:
  stage: pointer
  <<: *release_rules
  needs: [seed]
  resource_group: mw-publish
  environment: { name: production-dns }
  when: manual                                # explicit approval gate (protected-environment approvals depend on the GitLab tier: unverified)
  id_tokens: { AWS_TOKEN: { aud: 'sts.amazonaws.com' } }
  script:
    - ./ci/aws-web-identity.sh "$SIGNER_ROLE_ARN" && ./ci/sign-pointer.sh out
    - ./ci/aws-web-identity.sh "$DNS_ROLE_ARN" && node tools/mw.mjs dns publish route53 --zone "$ZONE_ID" --name "_magnet.example.com" --value-file ptr/pointer.txt --ttl 300 --cas

verify:
  stage: verify
  <<: *release_rules
  needs: [pointer]
  script:
    - node tools/mw.mjs dns check "_magnet.example.com" --expect ptr/pointer.txt --authoritative --doh cloudflare,google --wait 15m
```

GitLab specifics from the docs read: `id_tokens` with `aud`; tokens expire at the job timeout or in 5 minutes; trust policies should use `project_id`, `namespace_id` and `ref_protected` rather than paths; `resource_group` process mode (`oldest_first` is the safer choice for deployments) is set through the API. The helper scripts under `ci/` are placeholders; the `export $(printf ...)` form of `sts assume-role-with-web-identity` is the usual GitLab recipe but was not verified on the page read.

### A.5 Workflows the outline deliberately leaves out (one-paragraph designs)

- **`promote.yml`** (`workflow_dispatch`: beta release id, target prod): downloads `rel-<id>` assets, runs `seed-verify` on the existing prefix, then calls `pointer.yml` with `host: example.com`. Same btih, new scope, new `seq`.
- **`preview.yml` + `preview-deploy.yml`**: `pull_request` builds and packs with no secrets and uploads the artifacts; a `workflow_run` job gated on same-repository PRs uploads the staged tree to `pr/<n>/<btih8>/` and comments the hub URL. Production-only steps additionally require `github.event.workflow_run.event == 'push'`.
- **`canary.yml`** (daily cron plus an external heartbeat): `dns check`, `seed-verify --sample 0.1`, `smoke`; opens an issue on failure. Public-repository crons are disabled after 60 days without activity.
- **`gc.yml`** (weekly): keeps the last 10 releases, every release any channel points to, and a rollback window; deletes the rest; reports bytes.
- **`renew.yml`** (only if `exp` is used): re-signs the current release with a fresh `exp` and `seq + 1`.

---

## Appendix B - `tools/mw.mjs` stage contract (files are the interface)

Node >= 22, ESM, no dependencies beyond the project's (`create-torrent`, `parse-torrent`, `playwright`) plus the AWS CLI for Route 53/KMS/S3 calls (no extra SDK needed for v1). Every stage is idempotent, reads and writes under `out/` or `ptr/`, supports `--dry-run`, and exits non-zero on any failed check.

| Subcommand | Purpose | Reads | Writes | Needs |
|---|---|---|---|---|
| `pack <dir> --name --piece-length --created --version --out` | deterministic torrent, staged tree, `release.json` | build directory | `out/site.torrent`, `out/release.json`, `out/tree/` | nothing |
| `inject <dir> --script <path>` (drop-in only) | add one idempotent `<script>` tag to every HTML file before packing | build directory | same directory | nothing |
| `seed-verify <torrent> <ws-url> [--origin] [--retries] [--sample 0.1] [--accept-encoding]` | preflight + per-piece Range fetch + SHA-1 on the PUBLIC URL | torrent, network | JSON on stdout | network |
| `pointer build <release.json> --scope --ws --xs --tr --exp --seq-from dns\|N --zone` | unsigned record and `signing-input.txt` (ARCHITECTURE section 4) | `release.json`, authoritative DNS (read) | `ptr/pointer.unsigned`, `ptr/signing-input.txt` | DNS read |
| `pointer finish <ptr> --der\|--raw\|--jwk` | DER to raw, append `sig=`, verify with the browser's `verifyPointer`, emit all forms | `ptr/` | `ptr/pointer.txt`, `ptr/dns.txt`, `ptr/meta.html`, `ptr/pointer-file.txt` | nothing (JWK path: the key) |
| `dns publish <provider> --zone --name --value-file --ttl [--cas] [--dry-run]` | split at 255 bytes, compare-and-swap where supported, wait for sync | `ptr/pointer.txt` | the provider | DNS-writer credentials |
| `dns check <name> --expect <file> [--authoritative] [--doh cloudflare,google] [--wait 15m]` | authoritative first, then DoH quorum, then `AD` | public DNS | JSON | network |
| `dns plan` | print paste-ready records for providers that cannot be automated | `ptr/pointer.txt` | stdout | nothing |
| `smoke <url> --expect-rel <id> [--timeout]` | headless Chromium resolves, downloads, renders, reports source | public site | exit code, screenshot | Chromium |
| `gc --keep N` | delete release prefixes not pointed to and older than the keep window | bucket listing, channel pointers | deletions | seed-writer plus list/delete |

---

## Appendix C - Executed experiments (code and results)

Everything here was run on 2026-10-17 on macOS 27.0 arm64 with Node 24.22, the project's `node_modules` and AWS CLI 2.38.1; scripts and raw outputs are in `docs/research/labs/w2a-06-lab/` (`RUN.txt` explains how to rerun).

### C.1 E1 - `create-torrent` 6.1.3 determinism (`e1-determinism.mjs`)

```text
--- raw fs.readdirSync order (this filesystem) ---
A root: .DS_Store .htaccess .well-known 404.html _headers about.html css data img index.html js
B root: .DS_Store .htaccess .well-known 404.html _headers about.html css data img index.html js

--- (1) directory-path input, default filters ---
A: 4b7dec99f4d64f184b731200777cd17cfa472303 8 files: 404.html, _headers, about.html, css/app.css, data/about.json, img/peer.png, index.html, js/app.js
B: 4b7dec99f4d64f184b731200777cd17cfa472303 8 files: 404.html, _headers, about.html, css/app.css, data/about.json, img/peer.png, index.html, js/app.js
same infohash A vs B (dir input, reversed creation order + other mtimes + other path)? true
.well-known present in dir-input torrent? false
dotfiles/_headers present? .htaccess:false _headers:true .DS_Store:false

--- (2) explicit sorted Blob list incl. dotfiles (what a CI publisher should do) ---
A: e046c1317941c559baab305360adaad4af04c132 11 files: .htaccess, .well-known/assetlinks.json, .well-known/security.txt, 404.html, _headers, about.html, css/app.css, data/about.json, img/peer.png, index.html, js/app.js
same infohash A vs B? true | .well-known included? true

--- (3) .torrent BYTES: creationDate pinned vs not ---
pinned creationDate: identical bytes? true
unpinned creationDate: identical bytes? false | same infohash? true
creationDate=new Date(0) gotcha -> "creation date" written = 1792270345 (0 is falsy -> Date.now() used)

--- (4) default piece length chosen by create-torrent for small sites ---
  0.5 MiB site -> default piece 16 KiB -> 32 pieces (vs 2 at 256 KiB)
    1 MiB site -> default piece 16 KiB -> 64 pieces (vs 4 at 256 KiB)
    5 MiB site -> default piece 16 KiB -> 320 pieces (vs 20 at 256 KiB)
   10 MiB site -> default piece 16 KiB -> 640 pieces (vs 40 at 256 KiB)
   32 MiB site -> default piece 32 KiB -> 1024 pieces (vs 128 at 256 KiB)
  100 MiB site -> default piece 128 KiB -> 800 pieces (vs 400 at 256 KiB)
  500 MiB site -> default piece 512 KiB -> 1000 pieces (vs 2000 at 256 KiB)

--- (5) default announce list added when announce is not set ---
trackers baked in by default: 8 udp://tracker.leechers-paradise.org:6969 udp://tracker.coppersurfer.tk:6969 udp://tracker.opentrackr.org:1337 udp://explodie.org:6969 udp://tracker.empire-js.us:1337 wss://tracker.btorrent.xyz wss://tracker.openwebtorrent.com wss://tracker.webtorrent.dev
```

### C.2 E2 - external signers: DER to raw (`e2-external-signer.mjs`)

Converter that made 120 of 120 openssl signatures verify with `src/chain/crypto.js`:

```js
/** DER ECDSA-Sig-Value -> raw r||s, 32 bytes each (strip ASN.1 sign-padding zero, left-pad short ints). */
export function derToRaw(der, size = 32) {
  let i = 0;
  const readLen = () => { let l = der[i++]; if (l & 0x80) { const n = l & 0x7f; l = 0; for (let k = 0; k < n; k++) l = (l << 8) | der[i++]; } return l; };
  if (der[i++] !== 0x30) throw new Error('not a DER SEQUENCE');
  readLen();
  const ints = [];
  for (let k = 0; k < 2; k++) {
    if (der[i++] !== 0x02) throw new Error('not a DER INTEGER');
    let len = readLen(); let v = der.subarray(i, i + len); i += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);          // drop sign-padding zero(s)
    if (v.length > size) throw new Error('integer too large for curve');
    const out = new Uint8Array(size); out.set(v, size - v.length); ints.push(out); // left-pad short integers
  }
  const raw = new Uint8Array(size * 2); raw.set(ints[0], 0); raw.set(ints[1], size); return raw;
}
```

```text
external-signer signatures verified by project verify(): ok=120 bad=0 (DER lengths seen: 69,70,71,72; min 69, max 72)
owner (b64url, 65-byte point): 87 chars
```

Turning a KMS `GetPublicKey` answer (SubjectPublicKeyInfo DER) into the pointer's `owner=` value (87 characters; matched an independent JWK-derived value) [X]:

```sh
aws kms get-public-key --key-id alias/mw-owner --query PublicKey --output text | base64 -d \
  | node -e "const b=require('fs').readFileSync(0); if (b[b.length-65]!==4) throw new Error('not an uncompressed P-256 point'); console.log(b.subarray(-65).toString('base64url'))"
```

### C.3 E3 - pointer size and TXT splitting (`e3-pointer-size.mjs`)

```js
function splitTxt(s, max = 255) { const b = enc.encode(s); const out = []; for (let i = 0; i < b.length; i += max) out.push(new TextDecoder().decode(b.subarray(i, i + max))); return out; }
```

```text
minimal     246 bytes -> 1 TXT string(s) of <=255 B (Route 53 value limit 4000 chars incl. quotes+spaces)
typical     363 bytes -> 2 TXT string(s) of <=255 B (Route 53 value limit 4000 chars incl. quotes+spaces)
withXsRel   487 bytes -> 2 TXT string(s) of <=255 B (Route 53 value limit 4000 chars incl. quotes+spaces)

chunk sizes: 255 + 108 | Route53 Value length incl quotes/spaces: 368
Route 53 ChangeBatch JSON bytes: 559 (API limit 32,000 chars per request)
round trip equals original: true
```

### C.4 Host probe and E4 (Chromium request headers)

`hostprobe.py` drives `curl` with four requests per URL (Range + identity, Range + `gzip, br`, GET with Origin, OPTIONS preflight asking for `cache-control,range`). The table is in F9; raw output:

```text
GitHub Pages           https://pages.github.com/css/pages.css
   server/via: GitHub.com | via: 1.1 varnish
   Range+identity : 206 total=12226 ce=-
   Range+gzip,br  : 206 total=3412 ce=gzip  <-- Content-Range over COMPRESSED bytes
   GET ACAO       : *  (expose=-)
   OPTIONS preflight: 405 ACAO=- ACAH=- ACAM=-
   cache-control  : max-age=600

Vercel                 https://nextjs.org/_next/static/immutable/chunks/2rm3-g0b_2tme.css
   server/via: Vercel | via: -
   Range+identity : 206 total=23306 ce=-
   Range+gzip,br  : 206 total=23306 ce=-  
   GET ACAO       : *  (expose=-)
   OPTIONS preflight: 204 ACAO=- ACAH=- ACAM=-
   cache-control  : public,max-age=31536000,immutable

Netlify                https://www.netlify.com/_astro/ClientRouter.astro_astro_type_script_in
   server/via: Netlify | via: -
   Range+identity : 206 total=15362 ce=-
   Range+gzip,br  : 206 total=15362 ce=-  
   GET ACAO       : -  (expose=-)
   OPTIONS preflight: 200 ACAO=- ACAH=- ACAM=-
   cache-control  : public,max-age=0,must-revalidate

Cloudflare (CDN)       https://developers.cloudflare.com/_nimbus/shiki.css
   server/via: cloudflare | via: -
   Range+identity : 200 total=- ce=-
   Range+gzip,br  : 200 total=- ce=br  
   GET ACAO       : *  (expose=-)
   OPTIONS preflight: 405 ACAO=* ACAH=- ACAM=-
   cache-control  : -

GitLab Pages           could not discover an asset on https://gitlab-org.gitlab.io/gitlab-ui/

CloudFront/S3          could not discover an asset on https://aws.amazon.com/

Firebase Hosting       could not discover an asset on https://firebase.google.com/

Fastly/jsDelivr        https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js
   server/via: ? | via: -
   Range+identity : 206 total=222929 ce=-
   Range+gzip,br  : 206 total=66074 ce=br  <-- Content-Range over COMPRESSED bytes
   GET ACAO       : *  (expose=*)
   OPTIONS preflight: 200 ACAO=* ACAH=- ACAM=-
   cache-control  : public, max-age=31536000, s-maxage=31536000, immutable
```

`e4-range-ae.mjs` (Playwright Chromium 156.0.8078.4 against two local servers on different ports) logged the headers actually sent:

```text

[chromium 156.0.8078.4] fetch results: {"same":206,"cross":206,"plain":200}
  A-same-origin  GET     /f.bin   range=bytes=0-99 accept-encoding=identity cache-control=no-store ACRH=null
  B-cross-origin OPTIONS /f.bin   range=null accept-encoding=gzip, deflate, br, zstd cache-control=no-cache ACRH=cache-control
  B-cross-origin GET     /f.bin   range=bytes=0-99 accept-encoding=identity cache-control=no-store ACRH=null
  A-same-origin  GET     /f2.bin  range=null accept-encoding=gzip, deflate, br, zstd cache-control=null ACRH=null
[firefox] not available: browserType.launch: Executable doesn't exist at $HOME/Library/Caches/ms-playwright/firefox-1555/firefox/Nightly.app/Contents/MacOS/firefox
[webkit] not available: browserType.launch: Executable doesn't exist at $HOME/Library/Caches/ms-playwright/webkit-2370/pw_run.sh
```

### C.5 E5 - `verify-seed.mjs` (the CI gate) and its behaviour against modelled hosts

```js
// verify-seed.mjs - CI gate: does the PUBLIC web-seed URL really serve the torrent's bytes to a browser-style client?
// usage: node verify-seed.mjs <site.torrent> <ws-base-url> [--origin https://example.com] [--accept-encoding identity|"gzip, br"] [--concurrency 8]
// Checks (all must pass): (1) CORS preflight as WebTorrent triggers it, (2) every piece: 206 + exact Content-Range, byte length, sha1 == torrent.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MODS = '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: parseTorrent } = await import(pathToFileURL(`${MODS}/parse-torrent/index.js`).href);

export async function verifySeed({ torrentPath, ws, origin = 'https://example.com', acceptEncoding = 'identity', concurrency = 8, log = () => {} }) {
  const t = await parseTorrent(fs.readFileSync(torrentPath));
  const base = ws.endsWith('/') ? ws : ws + '/';
  const problems = [];
  const urlFor = f => base + f.path.split('/').map(encodeURIComponent).join('/');   // f.path already starts with torrent name (BEP 19)
  // (1) preflight exactly as a cross-origin browser fetch with {Cache-Control, Range, User-Agent} would send it
  const probe = urlFor(t.files[0]);
  const pf = await fetch(probe, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control,range,user-agent' } });
  const acao = pf.headers.get('access-control-allow-origin'), acah = (pf.headers.get('access-control-allow-headers') || '').toLowerCase(), acam = (pf.headers.get('access-control-allow-methods') || '').toUpperCase();
  const sameOrigin = new URL(base).origin === origin;
  if (!sameOrigin) {
    if (!pf.ok) problems.push(`preflight: HTTP ${pf.status} (cross-origin seed needs a 2xx OPTIONS answer)`);
    if (acao !== '*' && acao !== origin) problems.push(`preflight: Access-Control-Allow-Origin=${acao} (need * or ${origin})`);
    const okH = acah.split(',').map(s => s.trim()).includes('*') || ['cache-control', 'range'].every(h => acah.includes(h));
    if (!okH) problems.push(`preflight: Access-Control-Allow-Headers="${acah}" lacks cache-control/range (and user-agent for Firefox/Safari)`);
    if (acam && !acam.includes('GET') && acam !== '*') problems.push(`preflight: Access-Control-Allow-Methods=${acam}`);
  }
  // (2) every piece, fetched the way webconn.js does it: one Range request per file span
  const sizes = new Map(t.files.map(f => [f.path, f.length]));
  const starts = []; let off = 0; for (const f of t.files) { starts.push(off); off += f.length; }
  const pieceLen = t.pieceLength, total = off, nPieces = t.pieces.length;
  async function fetchPiece(i) {
    const a = i * pieceLen, b = Math.min(a + pieceLen, total) - 1; const parts = [];
    for (let k = 0; k < t.files.length; k++) {
      const f = t.files[k], fs0 = starts[k], fe = fs0 + f.length - 1;
      if (f.length === 0 || fe < a || fs0 > b) continue;
      const ra = Math.max(a, fs0) - fs0, rb = Math.min(b, fe) - fs0;
      const res = await fetch(urlFor(f), { headers: { Range: `bytes=${ra}-${rb}`, 'Accept-Encoding': acceptEncoding, 'Cache-Control': 'no-store', Origin: origin }, cache: 'no-store' });
      if (res.status !== 206) throw new Error(`piece ${i} ${f.path}: HTTP ${res.status} (need 206; 200 means Range ignored)`);
      const cr = res.headers.get('content-range') || '';
      if (cr !== `bytes ${ra}-${rb}/${f.length}`) throw new Error(`piece ${i} ${f.path}: Content-Range "${cr}" != "bytes ${ra}-${rb}/${f.length}" (compressed representation or wrong size?)`);
      if (!sameOrigin && acao !== '*' && res.headers.get('access-control-allow-origin') == null) throw new Error(`piece ${i}: GET response lacks Access-Control-Allow-Origin`);
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
    const data = Buffer.concat(parts);
    if (data.length !== b - a + 1) throw new Error(`piece ${i}: got ${data.length} bytes, expected ${b - a + 1}`);
    if (createHash('sha1').update(data).digest('hex') !== t.pieces[i]) throw new Error(`piece ${i}: SHA-1 mismatch (bytes served differ from the torrent payload)`);
  }
  let next = 0, bad = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, nPieces) }, async () => {
    while (true) { const i = next++; if (i >= nPieces) return; try { await fetchPiece(i); } catch (e) { bad++; if (problems.length < 6) problems.push(e.message); } }
  }));
  log(`pieces=${nPieces} bad=${bad}`);
  return { ok: problems.length === 0, infoHash: t.infoHash, pieces: nPieces, bad, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [torrentPath, ws, ...rest] = process.argv.slice(2); const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const r = await verifySeed({ torrentPath, ws, origin: opt('--origin'), acceptEncoding: opt('--accept-encoding'), concurrency: Number(opt('--concurrency')) || 8 });
  console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1);
}
```

Results against local servers imitating the measured hosts (`e5-verify-seed-test.mjs`):

```text
good           accept-encoding=identity   -> PASS  pieces=5 bad=0  
no-preflight   accept-encoding=identity   -> FAIL  pieces=5 bad=0  preflight: HTTP 405 (cross-origin seed needs a 2xx OPTIONS answer) | preflight: Access-Control-Allow-Origin=null (need * or https://example.com)
acao-only      accept-encoding=identity   -> FAIL  pieces=5 bad=0  preflight: Access-Control-Allow-Headers="" lacks cache-control/range (and user-agent for Firefox/Safari)
range-ignored  accept-encoding=identity   -> FAIL  pieces=5 bad=5  piece 0 site/.well-known/security.txt: HTTP 200 (need 206; 200 means Range ignored) | piece 1 site/img/peer.png: HTTP 200 (need 206; 200 means Range ignored)
gzip-range     accept-encoding=identity   -> PASS  pieces=5 bad=0  
gzip-range     accept-encoding=gzip, br   -> FAIL  pieces=5 bad=5  piece 0 site/.well-known/security.txt: Content-Range "bytes 0-10/31" != "bytes 0-10/11" (compressed representation or wrong size?) | fetch failed
same-origin    (405 preflight ignored)           -> PASS  
```

### C.6 E6 - WebTorrent 3.0.21 against a web seed that serves corrupted bytes (`e6-badseed.mjs`)

```js
// E6: what does webtorrent 3.0.21 do when a web seed serves bytes that fail the piece hash (e.g. a release prefix overwritten in place)?
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const MODS = '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: createTorrent } = await import(pathToFileURL(`${MODS}/create-torrent/index.js`).href);
const { default: WebTorrent } = await import(pathToFileURL(`${MODS}/webtorrent/index.js`).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe6-')); const tree = path.join(root, 'r', 'rel1', 'site');
fs.mkdirSync(tree, { recursive: true });
const big = Buffer.alloc(200000); for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
fs.writeFileSync(path.join(tree, 'a.bin'), big); fs.writeFileSync(path.join(tree, 'b.txt'), 'hello\n'.repeat(5000));
const blobs = []; for (const r of ['a.bin', 'b.txt']) { const b = await fs.openAsBlob(path.join(tree, r)); b.fullPath = `site/${r}`; blobs.push(b); }
const tbuf = await new Promise((res, rej) => createTorrent(blobs, { name: 'site', pieceLength: 16384, announce: [], creationDate: new Date('2026-10-17T00:00:00Z') }, (e, b) => e ? rej(e) : res(b)));
fs.writeFileSync(path.join(root, 'r', 'rel1', 'site.torrent'), tbuf);

let corrupt = true; const reqs = [];
const srv = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const p = path.join(root, decodeURIComponent(req.url)); if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(p); const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (m) {
    const a = +m[1], b = Math.min(+m[2], body.length - 1); let part = Buffer.from(body.subarray(a, b + 1));
    if (corrupt && req.url.endsWith('a.bin') && a < 16384) { part[0] ^= 0xff; reqs.push({ t: Date.now(), range: `${a}-${b}`, bad: true }); }   // in-place overwrite / transformed bytes
    res.writeHead(206, { ...cors, 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': part.length }); return res.end(part);
  }
  res.writeHead(200, { ...cors, 'content-length': body.length }); res.end(body);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
const base = `http://127.0.0.1:${port}/r/rel1/`;
const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, tracker: false, webSeeds: true });
let warnings = 0; const t0 = Date.now();
const { default: parseTorrent } = await import(pathToFileURL(`${MODS}/parse-torrent/index.js`).href);
const parsed = await parseTorrent(tbuf);
const magnet = `magnet:?xt=urn:btih:${parsed.infoHash}&xs=${encodeURIComponent(base + 'site.torrent')}&ws=${encodeURIComponent(base)}`;
const torrent = client.add(magnet, { path: path.join(root, 'dl') });
torrent.on('warning', e => { if (/failed verification/.test(String(e.message))) warnings++; });
let doneAt = null; torrent.on('done', () => { doneAt = Date.now() - t0; });
await new Promise(r => setTimeout(r, 4000));
console.log(`phase 1 (web seed serves a corrupted first piece for 4 s): corrupted Range requests=${reqs.length}, 'failed verification' warnings=${warnings}, done=${torrent.done}, progress=${(torrent.progress * 100).toFixed(1)}%, webSeed wires still attached=${torrent.wires.filter(w => w.type === 'webSeed').length}`);
const mid = reqs.length; corrupt = false;
await new Promise(r => setTimeout(r, 4000));
console.log(`phase 2 (seed fixed): done=${torrent.done} after ${doneAt ?? 'n/a'} ms, total corrupted requests=${reqs.length} (phase-1 rate ~${(mid / 4).toFixed(1)}/s)`);
client.destroy(); srv.close(); fs.rmSync(root, { recursive: true, force: true }); setTimeout(() => process.exit(0), 200);
```

```text
phase 1 (web seed serves a corrupted first piece for 4 s): corrupted Range requests=23240, 'failed verification' warnings=23240, done=false, progress=92.9%, webSeed wires still attached=1
phase 2 (seed fixed): done=true after 4002 ms, total corrupted requests=23240 (phase-1 rate ~5810.0/s)
```

Source: `node_modules/webtorrent/lib/torrent.js` lines 1985-2012 (3.0.21): on `hex !== self._hashes[index]` the code does `self.pieces[index] = new Piece(piece.length)`, emits `warning` (`Piece ${index} failed verification`) and calls `onUpdateTick()`; no source is banned.

### C.7 E7 - `pack-sketch.mjs` (reference for `mw pack`) and its determinism test

```js
// pack-sketch.mjs - reference for `mw pack`: deterministic torrent + staged tree + release.json from a build directory.
// Rules learned in E1: explicit file list (directory mode drops dot-entries and trusts readdir order), byte-wise sort,
// creationDate pinned and > 0, announce: [] (no baked-in trackers), fixed name + piece length, nothing wall-clock in release.json.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const MODS = process.env.MW_MODULES || '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: createTorrent } = await import(pathToFileURL(`${MODS}/create-torrent/index.js`).href);
const { default: parseTorrent } = await import(pathToFileURL(`${MODS}/parse-torrent/index.js`).href);

// host config and OS junk are NOT site content; .well-known and other dot-paths ARE (an allow/deny list, not a blanket dotfile rule)
export const DEFAULT_IGNORE = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)\.git(\/|$)/, /^(_headers|_redirects|\.htaccess|netlify\.toml|vercel\.json)$/];

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r)); else if (e.isFile()) out.push(r);   // symlinks and specials are skipped on purpose
  }
  return out;
}
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));            // UTF-8 byte order, not UTF-16 code-unit order
const sha256 = s => createHash('sha256').update(s).digest('hex');

export async function pack(dir, { name, pieceLength = 262144, created, version, ignore = DEFAULT_IGNORE, outDir }) {
  if (!name) throw new Error('name is required (it is part of the infohash)');
  if (!(Number.isInteger(created) && created > 0)) throw new Error('created must be a positive unix-seconds integer (new Date(0) is falsy in create-torrent and silently becomes "now")');
  const rels = walk(dir).filter(r => !ignore.some(rx => rx.test(r))).sort(byBytes);
  if (!rels.length) throw new Error('no files to pack');
  const blobs = [];
  for (const r of rels) { const b = await fs.openAsBlob(path.join(dir, r)); b.fullPath = `${name}/${r}`; blobs.push(b); }
  const buf = await new Promise((res, rej) => createTorrent(blobs, { name, pieceLength, announce: [], creationDate: new Date(created * 1000) }, (e, x) => e ? rej(e) : res(x)));
  const t = await parseTorrent(buf);
  const files = t.files.map(f => ({ path: f.path.slice(name.length + 1), length: f.length }));
  const release = {
    v: 1, rel: `${version}-${t.infoHash.slice(0, 8)}`, version, btih: t.infoHash, name, pieceLength,
    files: files.length, bytes: files.reduce((n, f) => n + f.length, 0),
    manifestSha256: sha256(files.map(f => `${f.path}\0${f.length}`).join('\n')), created,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'site.torrent'), buf);
    fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    for (const r of rels) { const to = path.join(outDir, 'tree', r); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(dir, r), to); }   // upload THIS tree, so seed objects == torrent payload
  }
  return { buf, release, files: rels };
}
```

```text
release.json identical: true | site.torrent bytes identical: true | btih 9ffb4994ab8e16bd649149c6185bc5f6e4eb04a4 | rel 1.4.2-9ffb4994
packed files: .well-known/security.txt, Zeta.txt, about.html, alpha.txt, café/é.html, css/app.css, img/p.png, index.html, js/app.js, 😀.txt
excluded (junk/host config): .DS_Store, _headers, .htaccess | included dot-path: .well-known/security.txt
staged tree == torrent file list: true | sort check (UTF-8 byte order): .well-known/security.txt | Zeta.txt | about.html | alpha.txt | café/é.html | css/app.css | img/p.png | index.html | js/app.js | 😀.txt
rejects bad input -> created must be a positive unix-seconds integer (new Date(0) is falsy 
rejects bad input -> name is required (it is part of the infohash)
```

---

## Appendix D - DNS provider matrix for the pointer record

Rows are what the documentation read today supports; blanks mean "not found in what I read", not "unsupported".

| Provider | Write primitive | Atomic / compare-and-swap | Credential scoping | OIDC from CI | Long TXT handling | TTL floor | Limits | DNSSEC | Status |
|---|---|---|---|---|---|---|---|---|---|
| **Route 53** | `ChangeResourceRecordSets` CREATE / UPSERT / DELETE | batch is all-or-none; DELETE needs exact old values, so DELETE+CREATE is a CAS | IAM condition keys on record name, type and action | yes (AWS OIDC) | `"s1" "s2"` in `Value`, 255 per string, 4,000 characters per value | none stated; one-week cap under DNSSEC | requests 50 burst / 10 per s; changes 1,500 / 100 per s; UPSERT counts 2; 1,000 elements and 32,000 characters per request | KSK is a customer KMS key | [D] High |
| **Cloudflare** | `POST /zones/{id}/dns_records/batch` (deletes, patches, puts, posts); single-record PATCH/PUT | one DB transaction; edge propagation not atomic; no CAS | zone-level token (Read/Edit), optional IP filter and TTL; no record-level scope documented | none documented | quoted strings, auto-split above 255 bytes | 60 s (research 05) | 1,200 requests per 5 min; 429 blocks 5 min | one click, algorithm 13 | [D] High / Medium |
| **deSEC** | bulk `PATCH`/`PUT`/`POST` on `rrsets/` | bulk is atomic | token policies per domain, subname, type, `perm_write`; `max_age` | none | must be quoted; auto-split above 255 | server-set (documented example 3600) | RRset writes per domain: 2/s, 15/min, 100/h, 300/day | automatic, DS list for the registrar | [D] High |
| **Gandi LiveDNS v5** | `PUT .../records/{name}/{type}`, `PATCH` add/remove values | per-RRset replace | Personal Access Token (Bearer) | none | examples quoted; splitting not stated | 300 to 2,592,000 | not seen | not verified | [D] Medium |
| **OVH** | `POST` / `PUT /domain/zone/{zone}/record`, then `POST .../refresh` | no | consumer-key `accessRules` of method + path | none | not verified | not verified | not verified | not verified | [D] schema, Medium |
| **Porkbun** | `dns/create`, `dns/editByNameType` (replaces all matches), `dryRun` | no | account API key + secret; per-domain API access toggle | none | not documented | typically 600 (account setting) | 429 + `Retry-After`; zone cap 2,500 records | `createDnssecRecord` | [D] Medium |
| **Namecheap** | host-record API | - | - | - | - | - | - | - | [U] docs returned 403 |
| **GoDaddy** | - | - | Bearer PAT (v3 page) | - | - | - | - | - | [U] DNS endpoints not on the page read |
| **Squarespace Domains** | - | - | - | - | - | - | - | - | [U] not examined |
| **DNSControl** (bridge) | `TXT(name, [strings])` push | whole-zone diff | provider credentials | - | splits above 255 octets | provider's | provider's | provider's | [D] Medium; unmanaged-record protection not verified |

---

## Appendix E - Policies, configs and checks (JSON validated with `jq`; CLI parameters validated with the AWS CLI client-side parser)

IAM semantic validation (Access Analyzer or the policy simulator) was **not** run.

**E.1 Print the real OIDC claims once, before writing any trust policy** (run in a throwaway job with `permissions: { id-token: write }`):

```sh
TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])')
python3 - "$TOKEN" <<'PY'
import sys, json, base64
p = sys.argv[1].split(".")[1]; p += "=" * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
print({k: c.get(k) for k in ("sub", "aud", "environment", "job_workflow_ref", "repository", "repository_id", "repository_owner_id")})
PY
```

**E.2 Trust policy for the DNS-writer role** (`sub` in the new immutable format, environment-scoped; environment string inferred, see F26):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:production-dns"
      }
    }
  }]
}
```

**E.3 DNS-writer policy: only the pointer TXT names, only TXT, only these actions** (conditions from the Route 53 documentation; `ListResourceRecordSets` cannot be narrowed by name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteOnlyThePointerTxt",
      "Effect": "Allow",
      "Action": "route53:ChangeResourceRecordSets",
      "Resource": "arn:aws:route53:::hostedzone/Z0123456789ABC",
      "Condition": {
        "ForAllValues:StringEquals": {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["_magnet.example.com", "_magnet.beta.example.com"],
          "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"],
          "route53:ChangeResourceRecordSetsActions": ["CREATE", "DELETE", "UPSERT"]
        }
      }
    },
    { "Sid": "WaitForInsync", "Effect": "Allow", "Action": "route53:GetChange", "Resource": "arn:aws:route53:::change/*" },
    { "Sid": "ReadForCas", "Effect": "Allow", "Action": "route53:ListResourceRecordSets", "Resource": "arn:aws:route53:::hostedzone/Z0123456789ABC" }
  ]
}
```

**E.4 Signer policy** (create the key with `aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY` and give it the alias `alias/mw-owner`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "SignOnly", "Effect": "Allow", "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab" },
    { "Sid": "ReadCurrentSeq", "Effect": "Allow", "Action": "route53:ListResourceRecordSets", "Resource": "arn:aws:route53:::hostedzone/Z0123456789ABC" }
  ]
}
```

**E.5 Seed-writer policy** (new objects only under `r/`; for hard no-overwrite add the bucket policy from the S3 documentation "Enforce conditional writes", which requires `s3:if-none-match` on `PutObject`, and upload with `aws s3api put-object --if-none-match '*'` per object):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListReleasePrefixOnly", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::example-mw-seed",
      "Condition": { "StringLike": { "s3:prefix": ["r/*"] } } },
    { "Sid": "WriteNewObjectsOnly", "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::example-mw-seed/r/*" }
  ]
}
```

**E.6 S3 bucket CORS** (`aws s3api put-bucket-cors --bucket B --cors-configuration file://s3-cors.json`):

```json
{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Range","Content-Length","Accept-Ranges","ETag"],"MaxAgeSeconds":86400}]}
```

**E.7 CloudFront custom response-headers policy** (use instead of the managed `CORS-With-Preflight` policy, which documents no `Access-Control-Allow-Headers`; `aws cloudfront create-response-headers-policy --response-headers-policy-config file://cf-policy.json`):

```json
{"Comment":"magnet-web web seed CORS incl. preflight with Allow-Headers","Name":"mw-webseed-cors","CorsConfig":{"AccessControlAllowOrigins":{"Quantity":1,"Items":["*"]},"AccessControlAllowHeaders":{"Quantity":1,"Items":["*"]},"AccessControlAllowMethods":{"Quantity":3,"Items":["GET","HEAD","OPTIONS"]},"AccessControlAllowCredentials":false,"AccessControlExposeHeaders":{"Quantity":3,"Items":["Content-Range","Content-Length","Accept-Ranges"]},"AccessControlMaxAgeSec":86400,"OriginOverride":true}}
```

**E.8 R2 CORS** (dashboard JSON tab accepts the S3-style array, which the R2 CORS page documents with `AllowedOrigins`, `AllowedMethods`, `AllowedHeaders`, `ExposeHeaders`, `MaxAgeSeconds`; the Wrangler `rules/allowed` format shown on that page covers only origins and methods, so prefer the dashboard format for headers). After any change purge the hostname's cache:

```json
[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["Content-Range","Content-Length","Accept-Ranges"],"MaxAgeSeconds":86400}]
```

**E.9 Route 53 compare-and-swap batch** (DELETE the exact old value, CREATE the new one; the second TXT value has two strings):

```json
{"Comment":"magnet-web pointer seq=1792270345 rel=1.4.2","Changes":[{"Action":"DELETE","ResourceRecordSet":{"Name":"_magnet.example.com.","Type":"TXT","TTL":300,"ResourceRecords":[{"Value":"\"OLD-1\" \"OLD-2\""}]}},{"Action":"CREATE","ResourceRecordSet":{"Name":"_magnet.example.com.","Type":"TXT","TTL":300,"ResourceRecords":[{"Value":"\"NEW-1\" \"NEW-2\""}]}}]}
```

```sh
CID=$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch file://batch.json --query ChangeInfo.Id --output text)
aws route53 wait resource-record-sets-changed --id "$CID"        # PENDING -> INSYNC
dig +short TXT "_magnet.example.com" @"$(aws route53 get-hosted-zone --id "$ZONE_ID" --query 'DelegationSet.NameServers[0]' --output text)"   # authoritative first
curl -sS -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=_magnet.example.com&type=TXT'          # then DoH, read "AD"
curl -sS 'https://dns.google/resolve?name=_magnet.example.com&type=TXT'
```

---

## Appendix F - Sources (URL, date of source; fetched 2026-10-17 unless noted)

"Undated" means the page shows no date. Items marked (OLD) predate 2024. Items marked (via fetch summary) were summarised by the fetch tool and not re-read line by line.

- **[S1]** AWS Route 53, IAM policy conditions for fine-grained access (undated): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/specifying-rrset-conditions.html
- **[S2]** AWS Route 53 quotas (undated): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html
- **[S3]** AWS Route 53 API throttling (undated; text says the behaviour was updated): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/throttling-api-requests.html
- **[S4]** AWS Route 53 API reference (undated): https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html , https://docs.aws.amazon.com/Route53/latest/APIReference/API_Change.html , https://docs.aws.amazon.com/Route53/latest/APIReference/API_GetChange.html
- **[S5]** AWS Route 53 DNSSEC signing (undated): https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring-dnssec.html
- **[S6]** deSEC documentation (rolling "latest", undated): https://desec.readthedocs.io/en/latest/auth/tokens.html , https://desec.readthedocs.io/en/latest/dns/rrsets.html , https://desec.readthedocs.io/en/latest/dns/domains.html , https://desec.readthedocs.io/en/latest/rate-limits.html (via fetch summary)
- **[S7]** Cloudflare (undated): DNS records batch API https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/batch/ ; creating API tokens https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ; API rate limits https://developers.cloudflare.com/fundamentals/api/reference/limits/ ; DNSSEC https://developers.cloudflare.com/dns/dnssec/
- **[S8]** GitHub Actions OpenID Connect, concepts and reference (the immutable subject format states 2026-07-15): https://docs.github.com/en/actions/concepts/security/openid-connect , https://docs.github.com/en/actions/reference/security/oidc
- **[S9]** `aws-actions/configure-aws-credentials` README, v6.3.0 shown in examples: https://github.com/aws-actions/configure-aws-credentials
- **[S10]** AWS KMS `Sign` API reference (undated): https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html ; KMS pricing (page copyright 2026): https://aws.amazon.com/kms/pricing/
- **[S11]** The Update Framework specification v1.0.37, last modified 2026-10-08: https://theupdateframework.github.io/specification/latest/
- **[S12]** BEP 19 HTTP/FTP seeding (GetRight style) (OLD): https://www.bittorrent.org/beps/bep_0019.html ; BEP 44 storing arbitrary data in the DHT (OLD): https://www.bittorrent.org/beps/bep_0044.html
- **[S13]** GitLab CI/CD ID tokens (undated; mentions GitLab 18.7): https://docs.gitlab.com/ci/secrets/id_token_authentication/ ; resource groups https://docs.gitlab.com/ci/resource_groups/
- **[S14]** GitHub changelog, Actions policy supports blocking and SHA pinning, 2025-08-15: https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/
- **[S15]** GitHub changelog, safer `pull_request_target` defaults for `actions/checkout` (v7 GA 2026-06-18; backport enforcement moved to 2026-07-20): https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/ ; releases (v7.0.1, v6.1.0 dated 20 Jul): https://github.com/actions/checkout/releases
- **[S16]** GitHub secure use reference (undated): https://docs.github.com/en/actions/reference/security/secure-use ; workflow dependency lockfiles (public preview): https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles
- **[S17]** GitHub deployments and environments (undated): https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- **[S18]** GitHub workflow concurrency: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency ; events that trigger workflows (`schedule`, `workflow_dispatch`): https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
- **[S19]** GitHub artifact attestations (undated): https://docs.github.com/en/actions/concepts/security/artifact-attestations
- **[S20]** `actions/upload-artifact` README (v7 shown): https://github.com/actions/upload-artifact ; `actions/upload-pages-artifact` README: https://github.com/actions/upload-pages-artifact
- **[S21]** GitHub Pages limits (undated): https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- **[S22]** CISA alert on tj-actions/changed-files CVE-2025-30066 and reviewdog/action-setup CVE-2025-30154, published 2025-03-18, revised 2025-03-26: https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction
- **[S23]** npm trusted publishers (last edited 2026-10-06): https://docs.npmjs.com/trusted-publishers ; npm dist-tag: https://docs.npmjs.com/cli/v11/commands/npm-dist-tag
- **[S24]** `ipshipyard/ipfs-deploy-action` README (raw, read in full): https://raw.githubusercontent.com/ipshipyard/ipfs-deploy-action/main/README.md ; `ipshipyard/dnslink-action` README (raw, read in full): https://raw.githubusercontent.com/ipshipyard/dnslink-action/main/README.md ; Shipyard post "2026: the end of IPFS at Shipyard", 2026-08-24 (via fetch summary): https://ipshipyard.com/blog/2026-the-end-of-ipfs-at-shipyard/
- **[S25]** `permaweb/permaweb-deploy` README (via fetch summary; maintenance state not shown): https://github.com/permaweb/permaweb-deploy
- **[S26]** Cloudflare R2: CORS (updated 2026-09-23) https://developers.cloudflare.com/r2/buckets/cors/ ; pricing (updated 2026-10-01) https://developers.cloudflare.com/r2/pricing/ ; S3 API compatibility https://developers.cloudflare.com/r2/api/s3/api/ ; AWS CLI example https://developers.cloudflare.com/r2/examples/aws/aws-cli/
- **[S27]** Backblaze B2: pricing https://www.backblaze.com/cloud-storage/pricing ; S3-compatible API https://www.backblaze.com/docs/cloud-storage-s3-compatible-api ; CORS with the S3 API https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-s3-compatible-api (all undated)
- **[S28]** AWS: CloudFront managed response headers policies https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-response-headers-policies.html ; CloudFront compression https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html ; S3 conditional writes https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html and https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html ; AWS CLI configuration (checksum settings) https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html (all undated)
- **[S29]** Registrar and DNS-tool documentation: Porkbun API reference v3.63 https://porkbun.com/llms-full.txt (via fetch summary, first 300,000 of 361,577 characters read) ; Gandi LiveDNS v5 https://api.gandi.net/docs/livedns/ (first 155,872 characters, via fetch summary) ; OVH API schema https://eu.api.ovh.com/1.0/domain.json and https://eu.api.ovh.com/1.0/auth.json (read with `jq`) ; DNSControl https://docs.dnscontrol.org/language-reference/domain-modifiers/txt and https://docs.dnscontrol.org/provider/index ; GoDaddy https://developer.godaddy.com/doc/endpoint/domains
- **[S30]** Cloudflare Pages headers (updated 2026-08-25) https://developers.cloudflare.com/pages/configuration/headers/ ; Netlify headers https://docs.netlify.com/manage/routing/headers/ ; Cloudflare Rocket Loader https://developers.cloudflare.com/speed/optimization/content/rocket-loader/
- **[S31]** `SOURCE_DATE_EPOCH` https://reproducible-builds.org/docs/source-date-epoch/ ; Next.js `generateBuildId` (lastUpdated 2026-10-01) https://nextjs.org/docs/app/api-reference/config/next-config-js/generateBuildId
- **[S32]** Project documents (local): `docs/ARCHITECTURE.md` sections 3-5 and 10, `docs/INTERFACES.md`, `docs/research/01-webtorrent-browser.md` (F10 web seeds and `xs`), `docs/research/05-doh-dns-txt.md` (F4, F5, F7, F8, F11, F12) - all dated 2026-10-14.
- **[S33]** Local source: `node_modules/webtorrent` 3.0.21 `lib/torrent.js`, `lib/webconn.js`; `node_modules/create-torrent` 6.1.3 `index.js`, `get-files.js`; `src/chain/crypto.js`, `src/common/magnet.js`.
- **[S34]** Local executions E1-E7, host probe and local CLI checks: `docs/research/labs/w2a-06-lab/` (2026-10-17).
- **[S36]** Sibling wave-2 documents in the same directory, read in part for cross-checks (2026-10-17): `docs/research/w2a-02-cms-export.md` (`xs=` mandatory above roughly 500 files; peer metadata cap), `docs/research/w2a-05-seo-crawlers.md` (R1 embedded-mode injection, R2 `verify-origin.mjs`). Other wave-2 files were stubs or not read.
- **[S35]** Not readable: Namecheap API documentation (https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/ and https://www.namecheap.com/support/api/intro/ returned HTTP 403 to the fetch tool and to `curl`).
