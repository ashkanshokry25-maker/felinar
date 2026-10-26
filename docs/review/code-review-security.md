# Code review: security lens (v0.2.1 code)

Date: 2026-10-19, 16:25 to 17:00 ET (extends the draft of the run that stopped at 16:05 ET). Lens: security.
Scope: the code under `src/`, `tools/`, `build.mjs` and `test/e2e/` at checkpoint `4b9178b` ("v0.2.1 hardening
applied", 14:40 ET); the only later commit (`29733c0`, 16:08 ET) adds the two review files, so the code is the code
the INTEGRATION-STATUS runs describe. Read first: `docs/INTEGRATION-STATUS.md`, `docs/DEVIATIONS.md` with
`docs/deviations/{formats,network,serving-publishing,harden-verify}.md`, `docs/review/DESIGN-REVIEW.md` and
`docs/review/DIGEST-AMENDMENTS.md` (Status column). Nothing in the repository was changed except this file.

What was run (Node 24.22; no request left loopback):
- `npm test` in the repository: lint-floor clean, 836 pass, 0 fail (6.6 s).
- `node build.mjs` in an isolated clone under the session scratchpad (the shared `dist/` was not touched), then a
  Playwright Chromium 156.0.8078.4 probe launched with `chromiumArgs({ allowRemote: false })`: the drop-in fixture
  published with `publish --dropin`, served by its own `.fixture/host.mjs` on 127.0.0.1 with a host CSP and
  `X-Frame-Options: DENY`, framing pages on 127.0.0.1 (another port) and on localhost. 0 non-local requests.
- Node probes against the real modules (no browser, no network) for findings 1, 2, 4, 5 and 6.

How the draft was handled: every draft finding was re-read against the current code and re-run where it was
reproducible. Changes: draft 1 is now critical (a ban by the old key deletes values on every node); draft 2 is
confirmed in Chromium and its framing claim corrected (cross-site frames are not reached, same-site ones are);
draft 5 also covers `check-site --headless` and `pin`; draft 6's open assumption is verified; draft 7 is merged
into the new finding 2, which shows the same link deletes copies of signed sites too. New: 2, 5, 6, 11, 13, 14.
Draft numbers: 1 -> 1, 2 -> 3, 3 -> 4, 4 -> 7, 5 -> 8, 6 -> 9, 7 -> 2, 8 -> 10, 9 -> 12.

Severity: critical = exploitable or data loss; high = a documented behaviour is wrong in a mainstream browser or a
must-fix item is unimplemented; medium = edge-case bug; low = hygiene. Calibration used here: critical where an
exploit causes lasting integrity or data loss for everyone who syncs; high where it is exploitable but the damage
stays with one visitor's copy, or needs a pre-existing flaw on the host.

## Summary

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | critical | Owner succession never revokes the previous key: the old key keeps owner powers on any branch that omits the handover, bans visitors (their values are dropped on every node) and can take the ledger back | `src/chain/state.js:467`, `:132-146`, `:291` |
| 2 | high | Hub: a keyless `st=withdrawn` link deletes the stored copies of any site on its own subdomain, signed sites included, and shows the attacker's reason and contact link (unsigned labels collide with signed ones) | `src/loader/app.js:825`, `:835`, `:1317`; `src/common/pointer.js:644-652` |
| 3 | high | `/_mw/ws/` is a same-origin proxy: any host URL, navigations included, is re-served without the host's CSP, framing and disposition headers (confirmed in Chromium) | `src/sw/core.js:1804`, `:1818`, `:1571-1633` |
| 4 | medium | The shell treats a valid `rot=` rotation as untrusted: rotated updates and rotated withdrawals are never applied while a page is open | `src/loader/app.js:165` |
| 5 | medium | `seq` has no upper bound and the rollback check runs before the owner check: one record with `seq` near 2^53 from a key the visitor trusts locks the scope for good; neither `rot=` nor the key-change prompt can replace it | `src/common/pointer.js:603-610` |
| 6 | medium | `rot=` signs only the new key and `seq`, not the scope: a rotation issued for one site silently moves every site pinned to the same key | `src/common/pointer.js:537-553` |
| 7 | medium | Hub subdomain: a site downloaded under an open gate is saved, so after Cancel the next open of the link renders it without a gate | `src/loader/app.js:1148`, `:1477`, `:1605` |
| 8 | medium | `snapshot.mjs`, `check-site --headless` and `pin` launch a remote-capable Chromium for loopback URLs and accept consent, so a local run contacts public STUN servers | `tools/snapshot.mjs:113`, `tools/check-site.mjs:560`, `tools/pin.mjs:109` |
| 9 | low | Gossip links are keyed by the remote's self-declared BitTorrent peer id | `src/chain/wire-ext.js:148-149`, `:55-58` |
| 10 | low | `xs=` and `cs=` bodies are buffered whole before the size check; gzip snapshots inflate without a cap | `src/loader/torrent.js:1331`, `src/loader/app.js:1956-1963`, `src/dropin/ledger.js:216-223` |
| 11 | low | Hub links contact the link's `xs=` and `ws=` hosts before the gate is answered (an unsigned link works as a tracking pixel) | `src/loader/app.js:1477-1482` |
| 12 | low | A4's stated guarantees do not hold against same-origin code (extractable identity, consent over the tab channel, the drop-in `window.__mwDropin.engine` handle) | `src/loader/app.js:497`, `:549`; `src/dropin/mw.js:99` |
| 13 | low | `webtorrent.min.js` is the one loader script cached without an integrity check, then served cache-first for the life of the build | `src/sw/core.js:1665` |
| 14 | low | Dev server: a directory redirect for `/.//dir` answers `Location: //dir/` (scheme-relative) | `tools/dev-server.mjs:289` |

## 1. critical: owner succession never revokes the previous key

**Where.** `src/chain/state.js:467` (`admit()`: `ownerHere = ownerAfter(dag, e.prev, genesisOwner)`), `:485-486`
(owner-only ops accepted when `isOwner`), the reducer's pass 1a, `:132-146` (a control block is valid when its
author is the owner in effect in the block's own causal past; at a merge the owner is the latest succession in
total order, whatever key issued it), and `:291` (`state.owner` is the last valid succession in total order).

**Defect.** Owner authority is judged from the block's own `prev`, which its author chooses. ARCHITECTURE 6.3 says
the ingest check runs "under the control state at the local heads", but `admit()` takes the owner of the block's
parents, not the owner at the heads. After S1 = `{t:'owner', next: K2}` by K1, any K1 block whose `prev` omits S1
still has K1 as its owner, so K1 keeps every owner power: `policy`, `allow`, `owner`, `ban`, `_` keys, and the PoW and
cap exemptions. A counter-succession by K1 placed deeper than S1 (owner blocks need no PoW, so a few padding blocks
are enough) makes every merged block see K1's chosen key as the owner.

**Why critical.** A ban makes the banned author's payload blocks redacted (`state.js:251-253`), and every node then
drops their values (`node.js:540-543` `dag.redact`, `:968` `store.dropValue`) and relays only stubs. So the old key
deletes visitors' posts from every node that merges its side branch, permanently, and takes owner powers back. Key
succession exists for the stolen-key and changed-hands cases; it protects against neither.

**Failure scenario (reproduced again in this run).** Genesis policy by K1 (`writers:'open'`), S1 = K1 -> K2, a
visitor's guestbook post on S1. K1 then builds `prev = [genesis]`: a policy `{ writers: 'owner', moderators: [M] }`,
a `ban` of the visitor, three padding `put`s and S2 = K1 -> K3. Against a DAG that holds S1, `admit()` returned
`ok` for all six. After one visitor block merges both heads, `reduce()` gives `owner === K3`, `writers 'owner'`, M a
moderator, the visitor banned and the guestbook empty. The unit test "succession: earlier tombstones still apply,
only the new owner issues control ops" (`test/unit/chain-core-state.test.mjs:197`) only covers old-key blocks that
descend from the handover.

**Fix.** Make a succession a revocation. A block authored by K loses owner standing when a valid succession away
from K exists that is not one of its descendants (history before the handover keeps its effect). `admit()` must use
the owner at the local heads for owner-only ops, as 6.3 says, and refuse blocks by a revoked key whose causal past
omits the revoking succession; the parent exemption in `node.js _place` must not bypass this. For two successions
by one key (equivocation) total order must not decide: anchor the canonical succession chain to the pointer's owner
(`expectedOwner`, which `rot=` already moves on the trust-root side) and ignore successions not on that chain.

**Test.** `chain-core-state`: the scenario above. After S1, a K1-authored policy, ban and owner block whose `prev`
excludes S1 are refused by `admit()` (E_NOT_OWNER, E_NOT_MODERATOR) and take no effect in `reduce()` under 200
shuffles; `st.owner === K2`; the visitor's post stays in effect and keeps its value in `chain-net-node`.

## 2. high: hub, a keyless withdrawal link deletes stored copies of any subdomain site, signed sites included

**Where.** `src/common/pointer.js:644-652` (`hubLabelFor`: signed records `base32(sha256(ledgerId)).slice(0, 32)`,
unsigned records `base32(btih)`; both are 32 base32 characters, 160 bits, with no separation between the two
sets); `src/loader/app.js:1224` (a fragment's scope is `btih:` + the record's own btih), `:145-147` (an unsigned
record is accepted for an unpinned scope), `:825` (the label check, the only thing that binds a subdomain to its
site), `:831` (the fragment is removed from the address bar), `:835-838` (the withdrawal runs right after
resolution, before any gate), `:1317` (`purgeWithdrawn` with `all: true` outside the shared hub).

**Defect.** For a signed site at `https://L.hub/`, `X = base32decode(L)` is 20 bytes and passes as an infohash. The
record `v=mw1; st=withdrawn; btih=<hex X>` needs no key: it is unsigned, so its scope `btih:X` has no pin and it is
accepted; its ledger id is `btih:X` and its label `base32(X)` is `L`, so the label check passes; `st=` is honoured
from an unsigned record; and the withdrawal deletes every site stored on the origin with no gate and no click. This
contradicts formats deviation 8 and ARCHITECTURE 5.8 (only the pinned owner, or a valid `rot=`, withdraws), DESIGN-
REVIEW item 6 (a subdomain belongs to one ledger id) and C3 (nothing that arrives by fragment acts without a click).
The attacker cannot serve content on the victim's origin this way (that would need a SHA-1 preimage of `X`); only a
content-free record, which a withdrawal is, gets through.

**Failure scenario (reproduced in Node against the real modules).** A signed site with `chain=guestbook` (label
`teif527mn3g5g65mfmfrharqmrbl3zli`) is stored in the visitor's browser. The attacker sends
`https://teif527mn3g5g65mfmfrharqmrbl3zli.hub.example/#v=mw1;st=withdrawn;btih=99105eebec6ecdd37bac2b0b1382306442bde568;why=Removed%20after%20a%20court%20order;ct=https://evil.example/appeal`.
`resolveMode` gives `hub-sub` with that label; `resolvePointer` gives `source: 'fragment', signed: false,
withdrawn: true, ledgerId: 'btih:99105e...'`; `hubLabelFor(record, ledgerId) === label` is true;
`purgeWithdrawn({ all: true })` deleted the signed site's stored copy. On the site's own origin, with the fragment
already gone from the address bar, the loader's own UI says "This content is no longer available here. Reason:
Removed after a court order. ... If you think this is a mistake, contact https://evil.example/appeal." with a
"Contact the publisher" button (`withdrawalNotice` keeps https contacts). The next visit has to download the site
again (from the host or peers; when the host is down, which is the case shell and hub copies exist for, it is gone).
On the shared-origin hub the same link form deletes the stored copy of any unsigned site through
`versions:btih:<X>` (the draft's finding 7).

**Fix.** (1) Never act on `st=` in an unsigned record that came from a link (fragment, `?mw=`, or the DNS of a
`#host:` the link names): such a record has no authority to withdraw anything, so refuse it in `vetCandidate` for
those sources (a host-served unsigned page tag or drop-in stamp comes from the trust root and can stay). (2) Make the
label sets disjoint, for example `label = base32(sha256("mw-label-v1\n" + kind + "\n" + id)).slice(0, 32)` with kind
`ledger` or `btih` (pre-release: ARCHITECTURE 3.2, INTERFACES `hubLabelFor`, a golden vector). (3) Defence in depth:
a withdrawal that arrives by fragment purges only after a click.

**Test.** `common-pointer`: for a signed record with label L, an unsigned record with `btih = hex(base32decode(L))`
gets a different label. A loader-app hub test with fakes: the fragment above ends in `hubLabelMismatch` (or a
refused record) and `deleteSite` is never called. `loader-app-arrival`: an unsigned withdrawal fragment on the
shared hub leaves the stored unsigned site in place.

## 3. high: `/_mw/ws/` re-serves any same-origin URL without the host's headers

**Where.** `src/sw/core.js:1804` (`owns()` takes every `/_mw/ws/*` GET, navigations included, before any mode or
navigation check, also inside a site's own worker that imports `/_mw/sw-core.js`), `:1818` (`route()` sends it to
`serveWebseed`), `:1571-1633` (`serveWebseed` fetches `origin + '/' + <rest>` for any path, never checks that the
path is a file of the requesting client's torrent, and answers with fresh headers: `Content-Type` from the
extension, `Accept-Ranges`, `Cache-Control`, `Content-Range`/`Content-Length`, nothing else).

**Defect.** The drop-in web-seed rewrite (ARCHITECTURE 3.4.7) works as a general same-origin proxy. Every host URL
is also reachable at `/_mw/ws/<anything>/<path>`, typed from its extension (`.html` is `text/html`), without the
host's `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `Content-Disposition`, `Permissions-Policy` or
COOP. That contradicts 3.4.1 and 3.4.2 (host documents keep the host's response headers, navigations go to the
network untouched, the worker never synthesizes headers for the host's URLs).

**Failure scenario (reproduced in Chromium 156, local only).** The drop-in fixture with a host CSP
`script-src 'self'; frame-ancestors 'none'` and `X-Frame-Options: DENY`, a returning visitor (our worker controls the
page). `GET /about.html`: 200 with the CSP and `DENY`. `GET /_mw/ws/x/about.html`: 200 `text/html; charset=utf-8`, no
CSP, no `X-Frame-Options`, rendered ("Existing Site: about"). An inline script that the host CSP blocks on
`/about.html` runs on `/_mw/ws/x/about.html`. A page on `http://127.0.0.1:<other port>` (cross-origin, same site)
cannot frame `/about.html` (blocked) but frames `/_mw/ws/x/about.html` (rendered). A page on `http://localhost:<port>`
(cross-site) got an error page for both: service workers are partitioned by top-level site, so the first-party
worker does not control a cross-site frame. Consequences: any DOM-XSS sink that the host's CSP neutralises runs
script in the site's origin through a link to `/_mw/ws/x/<page>#<payload>` (the ledger identity in IndexedDB, the
host's cookies); a host file with an `.html`, `.svg` or `.xml` name that the host serves as an attachment or as
plain text renders as a document there; sibling origins under the same registrable domain can frame host pages
(the drop-in engine is off in frames, so ledger writes are not reachable that way). In shell mode the host mostly
answers with the shell, which refuses to boot when framed, so the impact is drop-in and integrated site workers.

**Fix.** Take `/_mw/ws/` only for non-navigation requests (`!isNavigation(req)` and not a `DROPIN_PASS`
destination; navigations pass to the network). In `serveWebseed`, require that `lookupBtih()` maps the client to a
stored or downloading version whose `pathIndex` lists the decoded path, else 404; never answer HTML, SVG or XML types
through the rewrite; add `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`
and `Cross-Origin-Resource-Policy: same-origin` to every rewrite response.

**Test.** `sw-core`: (a) a top-level navigation to `/_mw/ws/x/page.html` is not owned (or is answered 404) and never
fetches `/page.html`; (b) a `fetch` of `/_mw/ws/<name>/secret.html` from a client mapped to btih B is 404 when B's
torrent does not list `secret.html`; (c) a rewrite response carries `nosniff` and the sandbox CSP. E2E scenario 10:
give the fixture host a CSP and assert `page.goto('/_mw/ws/x/about.html')` does not render the page.

## 4. medium: the shell treats a valid `rot=` rotation as untrusted

**Where.** `src/loader/app.js:165` (`trusted: !pinned || record.owner === pinned`; `rotated` is never copied from
`v.rotated`). The branch at `:155-162` cannot run for a valid `rot`, because `verifyPointer` has already returned
`ok: true, rotated: true` by then, and the `cand.rotated` pin updates at `:2010` and `:2047` are dead code.

**Defect.** `verifyPointer(record, scope, { pinnedOwner })` accepts a key change carrying a valid `rot=` and reports
`rotated: true`, but `vetCandidate` returns `{ status: 'ok', trusted: false, rotated: false }`. `isUpdate()` requires
`trusted`, so neither `checkForUpdate` (DNS channel) nor `checkPageTagUpdate` applies a rotated record while a page is
open: no "Update available", the superseded version keeps seeding, and a rotated withdrawal (`st=withdrawn` plus
`rot=`, the natural pair after a key compromise) is not applied at once as A3 requires. `decidePointer` also lets an
old `<meta>` beat a higher-seq rotated DNS record, and the pin never gets `rotatedAt`. The drop-in path
(`src/dropin/stamp.js:162`) uses `v.rotated` and is correct; only the shell is affected.

**Failure scenario (reproduced again).** Pinned owner K1, current record seq 5. A record signed by K2, seq 6,
`rot = sign_K1("mw-rot-v1\n" + K2 + "\n6")`: `verifyPointer` gives `{ ok: true, rotated: true }`, `vetCandidate`
gives `{ status: 'ok', trusted: false, rotated: false }`, `isUpdate(current, candidate)` is false, `decidePointer`
picks the seq-5 meta, and a rotated withdrawal at seq 7 is not an update either.

**Fix.** At `:165` return `rotated: !!v.rotated` and `trusted: !pinned || record.owner === pinned || !!v.rotated`;
drop the unreachable branch or keep it only for the owner-changed case without `rot`.

**Test.** A loader-app unit test: the scenario above gives `status 'ok'`, `trusted true`, `rotated true`; `isUpdate`
is true; `decidePointer` picks the DNS record; the withdrawal variant is applied by `checkForUpdate` through
`withdrawNow`.

## 5. medium: an unbounded `seq` floor locks a scope to the first record that sets it high

**Where.** `src/common/pointer.js:603-610` (`seq-rollback` is checked before the owner and rotation checks, and
nothing bounds `seq` from above; `UINT_RE` at `:77` admits 16 digits, up to 2^53-1), with the floor read from the
scope's saved record of any owner (`src/loader/app.js:152`, `:269`; `src/dropin/stamp.js:146` through
`engine.js:505`).

**Defect.** The rollback floor is the highest `seq` ever accepted for the scope, across key changes (DESIGN-REVIEW
item 11), and `seq` is whatever the signer writes (`publish` defaults to Unix time but takes any `--seq`). Once a
visitor accepts a record with `seq` 2^53-1, every later record is `seq-rollback`, so a rotation with a valid `rot=`
and a new key that the TOFU prompt would offer are both refused before the prompt. The saved record and copy keep
rendering, also after they expire (an expired cached record still renders, with a banner). Who can set such a
floor: a thief of the owner key (exactly the case rotation is for), a first-visit DNS attacker (on a first visit a
DNS record signed by another key beats the page tag, conformance finding 4), or any key a visitor confirmed at a
key-change prompt. A transient compromise becomes permanent for every visitor who saw the record.

**Failure scenario (reproduced in Node).** Scope `example.com` pinned to K1. A K1 record with `seq` 9007199254740991
is accepted and parses back exactly. The owner rotates: a K2 record at `seq` = Unix time with a valid `rot=` from K1
gives `verifyPointer: false, 'seq-rollback'`; a K3 record without `rot` gives the same, and the shell's
`vetCandidate` returns `rejected, 'seq-rollback'`, so no key-change prompt is shown.

**Fix.** Treat `seq` as the time it is by default: refuse fresh records whose `seq` is more than a day ahead of the
verifier's clock in seconds (make `publish --seq` refuse values above the current Unix time), so a planted floor
runs out; and judge the owner before the rollback: a record by a new key with a valid `rot=` from the pinned key, or
one the visitor confirms at the prompt, starts a new floor for that owner. Keep the rollback refusal for the same
owner.

**Test.** `common-pointer`: a fresh record with `seq = now + 2 days` is refused; after a saved `seq` of 2^53-1 by
K1, a K2 record with a valid `rot=` from K1 verifies (`rotated: true`) and a K3 record reports `owner-changed`
instead of `seq-rollback`. The same through `vetCandidate` and `evaluateStamp`.

## 6. medium: `rot=` is not bound to the scope

**Where.** `src/common/pointer.js:537-553` (`rotationInput(owner, seq)` = `"mw-rot-v1\n" + owner + "\n" + seq`;
`verifyRotation` takes no scope), used by `:607-610`, `src/loader/app.js:160` and `src/dropin/stamp.js:146`.

**Defect.** A rotation that key K1 signs for one scope is valid for every scope pinned to K1 at that `seq`. Owners
reuse one key for several sites (`keygen` writes one `owner.jwk`, `publish` takes `--key`). When the owner hands
`blog.example` to a buyer with `publish --prev-key`, the buyer's key is also accepted silently for `shop.example` by
every visitor pinned to K1, as soon as the buyer can put a `shop.example` record in front of them (that scope's DNS
or host) before `shop.example` publishes a higher `seq`. The TOFU promise ("Later visits refuse a pointer signed by
a different key unless the visitor confirms", DESIGN-REVIEW 4.4) is lost for that scope. Same for a rotation to a
key that is later compromised.

**Failure scenario (reproduced in Node).** `rot = signRotation({ owner: KB, seq }, K1)` issued for blog; a record for
scope `shop.example` signed by KB with that `rot=`: `verifyPointer(..., { pinnedOwner: K1 })` gives `ok: true,
rotated: true`.

**Fix.** Bind the rotation to the scope (and to the ledger id when `chain=` is used): `"mw-rot-v2\n" +
normalizedScope + "\n" + next + "\n" + seq`. Pre-release: A2 freezes formats now and lets vectors only be added, so
add the v2 vector beside the v1 one and stop accepting v1.

**Test.** `common-pointer`: a `rot=` signed for scope A fails `verifyRotation` for scope B and passes for A; a
golden vector in `test/vectors/pointer.json`.

## 7. medium: hub subdomain, a cancelled gate is skipped on the next open of the link

**Where.** `src/loader/app.js:1148` (`needsGate`: hub-sub gates only when nothing is cached), `:1477-1482`
(`obtainSite` waits for the gate only when the pointer has no `xs`/`ws`), `:1605` (`downloadSite` saves the copy
before `renderSite` waits for the gate at `:1652`), `:1195-1201` (gate Cancel aborts a download still running but
leaves a finished copy in IndexedDB).

**Defect.** With a web seed, a hub-sub site is downloaded and saved while the gate is still open (the download is
allowed by DESIGN-REVIEW item 12; the save is what goes wrong). Once saved the site counts as cached, and
`needsGate()` exempts cached hub-sub sites, so a visitor who pressed Cancel is never asked again: the next open of
the link renders the site at once behind the non-blocking card, and its scripts run (the site frame has no
`connect-src` restriction, so it can contact any third party). Side effect: the gate's "Show again" reload shows
"pointer not found", because `:831` strips the fragment before the gate and nothing wrote `meta.current`.

**Failure scenario.** Open `https://<label>.hub.example/#v=mw1;...;ws=...` for a small site; the web seed finishes in
under a second; press Cancel; open the same link again: `lookupCache` finds the copy, `needsGate(A, true)` is
false, `renderSite` mounts the frame without the gate. (Read from the code; a subdomain hub needs wildcard DNS, which
the local-only browser rules do not resolve.)

**Fix.** Do not save the copy (or do not let it count as cached for `needsGate`) until the visitor chose Load or Host
only; on Cancel delete a copy that was downloaded under the open gate; or base the hub-sub exemption on a stored
consent record for the origin rather than on the cache. Keep the fragment until the gate is answered.

**Test.** A loader-app unit test with fakes: hub-sub, `ws` present, the gate is cancelled after the download
settles; IndexedDB holds no site record afterwards, and a second `run()` with the same fragment opens the gate and
mounts no frame.

## 8. medium: tools launch a remote-capable Chromium for loopback URLs

**Where.** `tools/snapshot.mjs:113` (`launchBrowser({ allowRemote: true, ... })` for every HTML input, loopback
included; the `--remote` gate at `:154` applies only to non-loopback URLs), `tools/check-site.mjs:560` (`--headless`
passes `allowRemote: true` even for a loopback page, which `ignoreHTTPSErrors: loopbackPage` shows is a known case)
and `tools/pin.mjs:109`.

**Defect.** `node tools/snapshot.mjs http://127.0.0.1:<port>/ --out x.gz` needs no `--remote`, yet launches Chromium
without the resolver rule and clicks "Share and load" (`acceptConsent`); `check-site --headless --consent` and `pin`
do the same for a local site. The shell's STUN probe then resolves and contacts `stun.cloudflare.com:3478` and
`global.stun.twilio.com:3478` (`CONFIG.stun`), plus any non-local tracker in the pointer. `docs/DEV-NETWORK.md` says
remote probes run in Node, never in a browser, and local runs stay on 127.0.0.1; a loopback URL needs nothing remote.

**Fix.** `allowRemote: !isLoopbackUrl(url)` in all three, as `tools/demo.mjs` does.

**Test.** `tools-snapshot`, `tools-check`: inject a fake `launchBrowser` and assert `allowRemote === false` for an
`http://127.0.0.1:...` input and `true` only for a remote URL (with `--remote` for snapshot).

## 9. low: gossip links are keyed by the remote's self-declared peer id

**Where.** `src/chain/wire-ext.js:148-149` (`key = wire.peerId`), `:55-58` (`Link.send` sends on the first
handler), `:126-140` (frames from every wire of a dropped link are ignored).

**Defect.** Wires that claim the same handshake peer id share one gossip peer. webtorrent 3.0.21 does not compare the
BitTorrent handshake peer id with the tracker-level id (`lib/peer.js onHandshake` only refuses its own id; checked
in this run, which settles the draft's open assumption). Another swarm member learns visitors' peer ids from tracker
offers and can connect claiming one: if its wire attached first, our frames for that visitor go to the impostor; a
HELLO with another `(site, owner)` or more than 50 invalid blocks detaches or ignores the shared link, so the honest
visitor's ledger frames are ignored for the session (a targeted eclipse of one peer).

**Fix.** One gossip peer per wire, or merge wires into one link only after each sent a HELLO with the same
`(site, owner)`; never let one wire's detach or strikes drop another; send on the wire that last delivered a valid
frame.

**Test.** `chain-net-node`: two fake wires with the same `peerId`; the second sends a HELLO with another owner; the
first wire's frames are still processed and it still receives ANN and HELLO.

## 10. low: `xs=` and `cs=` bodies are buffered before the size check; gzip output is unbounded

**Where.** `src/loader/torrent.js:1331` (`res.arrayBuffer()` before the 8 MiB check; only the `xsMs` timeout bounds
it); `src/loader/app.js:1956-1963` and `src/dropin/ledger.js:216-223` (`Content-Length` is optional, there is no
timeout, and the gzip output of a snapshot of up to `snapshotMaxBytes` is read with no cap).

**Defect.** A hostile `xs`/`cs` host (any link author on a hub, where the `xs` fetch runs before the gate, finding
11) can send a multi-GB body within the timeout or a gzip bomb and exhaust the tab's memory.

**Fix.** Read with a stream reader and abort past the cap: 8 MiB for `xs`, `snapshotMaxBytes` for the compressed
snapshot and a separate cap (for example 2 x `maxChainBytes`) for the inflated bytes; give the snapshot fetch a
timeout.

**Test.** `loader-app-torrent`: a fake fetch streaming 9 MiB without `Content-Length` is aborted at 8 MiB; a 1 KiB
gzip that inflates past the cap is refused by `fetchSnapshot` (shell and drop-in).

## 11. low: hub links contact the link's `xs=` and `ws=` hosts before the gate is answered

**Where.** `src/loader/app.js:1477-1482` (`obtainSite` waits for the gate only when the pointer has no `xs`/`ws`),
`:1604` (the download starts while the gate is open), `src/loader/torrent.js:1381-1386` (the `xs` fetch) and `:1397`
(the web-seed probe).

**Defect.** ARCHITECTURE 8 allows "While gated, load from the web seed only when the pointer has `xs`/`ws`", but 3.2
(C3) says nothing that arrives by fragment loads without an explicit click, and the shared-hub gate tells the
visitor that others see the IP address only if they choose Load. For an unsigned hub link the `xs=` and `ws=` hosts
are the link author's: opening the link sends the visitor's IP address, the time and the infohash to them before any
choice. An `xs=` pointing at a logging endpoint is enough; the `.torrent` does not have to exist. E2E scenario 8
checks WebSockets and peer connections while the gate is open, not HTTP fetches.

**Fix.** On hubs, fetch nothing from a host named only by an unsigned link before Load or Host only. For signed
records the publisher chose the hosts; keep the current behaviour or say it in the gate.

**Test.** A loader-app hub-shared test with an unsigned fragment carrying `xs` and `ws`: the fake fetch is not called
until the gate's Load click, then the `xs` fetch runs.

## 12. low: A4's stated guarantees do not hold against same-origin code

**Where.** `src/loader/app.js:497` and `src/dropin/identity.js:125` (identity keys are generated extractable and
stored as a CryptoKey in the origin's IndexedDB; a plaintext JWK on the iOS fallback); `src/loader/app.js:549`,
`:1916-1921` (a `{ mw: 1, t: 'consent', state: 'accepted' }` message on the tab BroadcastChannel from any same-origin
context sets and stores consent); `src/dropin/mw.js:97-107` (`window.__mwDropin.engine` gives page scripts
`engine.consent.set()` and `engine.identityApi().export()`, conformance finding 1).

**Defect.** ARCHITECTURE 3.4.9 says the panel's Export is "the only way an identity leaves" a drop-in origin and that
"a site can never accept for the visitor". Any site script, or a third-party script the site includes, can read the
key from `mw-sites`/`keys` and `exportKey('jwk', ...)` it, post the consent message on `mw-<ledgerId>`, or call the
engine handle. ARCHITECTURE 9 itself says site code runs with loader privilege, so none of these can be boundaries;
the handle only makes it a one-liner.

**Fix.** Say it plainly in ARCHITECTURE 3.4.9 and 9 and the README: removing the SDK calls prevents accidental use,
not a hostile script. Expose a frozen `{ version, started, inspect(), openSettings(), rectOf(label) }` instead of the
engine. Optionally keep the signing key non-extractable (export from a passphrase-wrapped copy made at the visitor's
first Export) and let a tab-channel consent message trigger a re-read of the stored record instead of carrying the
state.

**Test.** `dropin-mw`: after `start()`, `win.__mwDropin.engine === undefined` and the handle is frozen; a docs grep
for "the only way an identity leaves" and "can never accept" after the wording fix.

## 13. low: `webtorrent.min.js` is cached without an integrity check

**Where.** `src/sw/core.js:1649-1669` (`serveAsset`: a `/_mw/` miss is fetched and cached when it is a 200, with no
integrity check, then served cache-first), `:383-384` (the bundle is left out of the precache), `build.mjs`
`integrityMap` (only precache entries; `dist/build.json` lists the patched bundle's sha256 `a34e85d7...`, but
`self.__INTEGRITY__` does not).

**Defect.** D2 makes the install atomic and integrity-checked for every loader script in the precache, against "a
mixed deploy or a stale CDN copy". The 223 KB bundle that parses every peer message and web-seed byte is fetched on
first use with no check and kept for the life of the build, so a stale or altered copy served once stays until the
next build. The host is the trust root (ARCHITECTURE 13), so this is defence in depth, but it is the one script the
D2 check misses.

**Fix.** Add `/_mw/webtorrent.min.js` to the integrity map (not to the precache) and check it in `serveAsset`
(`integrityMatches`) before caching or serving; or fetch it with `Request.integrity`.

**Test.** `sw-core`: a fetch of `/_mw/webtorrent.min.js` whose bytes do not match the map is neither cached nor
served.

## 14. low: dev server, scheme-relative directory redirect

**Where.** `tools/dev-server.mjs:288-289` (the directory redirect echoes `url.pathname`).

**Defect.** For `GET /.//assets` the URL parser removes the dot segment and leaves `pathname === '//assets'`
(checked in Node 24); when `assets` is a directory under `--root`, the answer is `301 Location: //assets/`, a
scheme-relative redirect to the host `assets`. Small impact: the server binds 127.0.0.1 by default and the host name
is limited to directory names (on a network with DNS search domains it can still resolve to an internal host).

**Fix.** Build the location from the decoded segments: `'/' + segs.map(encodeURIComponent).join('/') + '/' +
url.search`.

**Test.** `tools-dev-server`: `GET /.//sub` with a directory `sub` answers 301 with `Location: /sub/`.

## Related findings in the conformance review (security-relevant, not repeated above)

- Conformance 1 (drop-in `window.__mwDropin.engine`): folded into finding 12 here.
- Conformance 4 (first visit: a DNS record signed by an unrelated key overrides the page tag and is pinned): with
  finding 5 a transient DNS compromise pins first-time visitors to the attacker's key and floor for good.

## Checked and found sound

- Bridge and SDK: a hello is accepted only when `event.source` is the site frame and `event.origin` is the shell's
  origin; the SDK posts only to a same-origin parent with its own document origin as `targetOrigin` (limited mode
  included) and talks only over the transferred port; requests are plain JSON, at most 64 KiB, writes limited to 20
  per minute; the tab channel's `call` is limited to six ledger methods.
- Service Worker verification: every byte served from IndexedDB passes per-piece SHA-1 against the stored
  `.torrent`, whose infohash is checked against its record key; the check and the body use the same Blob within a
  request; pad files read as zeros; a Range verifies only the pieces it covers; a mismatch deletes the copy.
- Service Worker paths and headers: file keys are `btih + '/' + path`, so no request reaches another btih;
  `parseTorrentFile` checks `info.name` and every path segment (no empty, `.`, `..`, separators or NUL), refuses
  duplicate paths and non-canonical info dictionaries; redirect targets are re-anchored at the origin; a routing
  manifest cannot set `Set-Cookie`, `Content-Length`, `Location` or the framing headers, and `frame-ancestors` is
  stripped from site CSPs; frame paths collapse leading slashes and backslashes. The cached shell is replaced only by
  a shell of the same build.
- Pointer: the signing input is unambiguous (control characters refused, keys restricted, sorted `k=v` lines plus the
  verifier's scope, domain-separated prefixes for pointers, rotations and blocks); `exp` is required and capped at 400
  days; unsigned records are refused for pinned scopes; drop-in pins and rotations follow `verifyPointer`.
- Ledger: `validateBlock` checks exact shapes, sorted unique `prev`, sizes before hashing, the hash, the claimed PoW,
  the signature over a prefixed hash and the salted value hash; unknown ops are refused; gossip frames are capped at
  15 KiB before `JSON.parse`; WANTed parents and snapshot blocks skip `admit` but stay under the cap (as documented).
- Upload: `BlobChunkStore` verifies each piece on its first read, from immutable Blob snapshots.
- Wire guard: verified against bittorrent-protocol 5.0.9: `_onHandshakeBuffer` emits the handshake (webtorrent
  `onHandshake`, `_onWire`, our synchronous `wire` handler) before it arms `_parse(4, this._onMessageLength)`, and
  every re-arm looks the method up on the instance, so the unsigned 256 KiB check runs before any message is
  buffered; the buffer watchdog runs; peer wires are refused when the patch point is missing.
- Consent before announce and tracker scoping: the client is built with `tracker: false` until consent; `_add`
  defaults `private: true` for every torrent (seeding included); signed pointers use their `tr` list exactly; the
  rendezvous swarm and the STUN probe wait for consent; DoH waits for a stored choice; drop-in announces need
  consent, 3 s visible and a page without `no-store`.
- CSP and UI: `boot.js` inserts the policy before importing the loader and the degraded variant only when
  registration fails; shell and panel UI render with `textContent` only and ignore script-made clicks; withdrawal
  contact links are limited to https and mailto.
- Kill switch: clears `mw-*` caches, unregisters, and reloads only the pages it took over.
- Tools: `keygen` writes with `O_EXCL` and mode 0600 (temp file and rename with `--force`) and is the only writer of
  keys; `loadOwnerKey` refuses group- or world-accessible keys; `publish` restricts `--name`, lints paths, slugs WXR
  imports, refuses `--out` inside the site and never deletes a tree that contains the site; `seed.mjs` maps only
  checked torrent paths; `dev-server` rejects dot segments and encoded separators and checks the joined path and its
  realpath against the root (apart from finding 14); the tracker refuses to run open by default, caps frames and
  swarms, and answers bare scrapes with nothing; `build.mjs` pins the stock and the patched bundle by sha256 and fails
  when a patch point moves.
- E2E harness: Chromium always gets `chromiumArgs({ allowRemote: false })`, WebKit runs only against 127.0.0.1 with
  consent pending, ICE servers are stripped in every frame, and any non-loopback request or WebSocket fails the run.

## Accepted limits (documented elsewhere, not re-reported)

- Site code has loader privilege in shell and drop-in modes; the shared-origin hub has no isolation (ARCHITECTURE 3.3
  and 9, DESIGN-REVIEW item 6).
- Verified piece indices are memoised per worker instance, so bytes changed in IndexedDB after a check are served
  until the worker stops (integration-1 deviation 5, DESIGN-REVIEW item 9).
- Blocks WANTed as parents of held orphans skip PoW and policy at ingest, bounded only by `maxChainBytes` (chain-net
  deviation 9); the reducer still gives them no effect.
- Web-seed and `xs=` hosts of signed pointers see the visitor's IP before the consent card is answered (ARCHITECTURE
  8: "the web seed download starts at once"); finding 11 is about hosts that only a link author chose.
- BitTorrent v1 names content by SHA-1.

## Not verified

- Finding 2 was reproduced at module level (the real `resolveMode`, `resolvePointer`, `hubLabelFor` and
  `purgeWithdrawn`, with the scope computed as `resolveSitePointer` does); a browser run needs a subdomain hub, which
  needs wildcard DNS that `chromiumArgs()` does not resolve. Findings 4 to 6 were checked at module level; 7, 9 to 14
  by reading the code (14's URL parsing in Node).
- Finding 3's framing results are Chromium's; Firefox and Safari also partition service workers by top-level site,
  but they were not run. WebKit and Firefox were not run in this review.
- Probe scripts of this run (session scratchpad, not in the repository):
  `/private/tmp/claude-501/-Users-owner/a69aa364-28fd-4795-9307-1b393b2fc924/scratchpad/probes/`
  (`succession.mjs`, `label-collision.mjs`, `ws-rewrite-browser.mjs`, `rot-shell.mjs`, `seq-floor.mjs`,
  `rot-scope.mjs`).
