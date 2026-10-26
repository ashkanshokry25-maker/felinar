# Code review v0.3: security and cryptography

Lens: SECURITY AND CRYPTOGRAPHY (label `review:security`). Date: 2026-10-20, about 21:50 to 22:40 ET. Tree reviewed:
checkpoint `8835d01` (auto, 22:31 ET); `src/`, `tools/`, `bin/`, `build.mjs`, `test/`, `deploy/` and `examples/` are identical
to `470f7ea`, the checkpoint the C2 integration results describe (the two later checkpoints changed only CHANGELOG.md,
INTEGRATION-STATUS.md, deviations/integration-c2.md and the conformance review). Code in scope: everything written since
`709feff` (`git diff 709feff --stat`), read together with the wave 1 modules it calls (`src/identity/*`, `src/chat/*`,
`src/media/*`, `src/files/encrypt.js`, `src/sw/media-route.js`, `src/chain/state.js`, `packages/verify/verify.js`), because the
focus list of this lens (derivation, wrapping, sealed items, the handshake, groups, media chunks) lives in those modules.

Normative inputs, read first: [V03-DESIGN-REVIEW.md](V03-DESIGN-REVIEW.md) ("R"; 1.3 must-fix list, Part 2),
[SEEDING-AND-ZERO-SETUP-DESIGN.md](../research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ", 3.1.6 and 3.5),
[ARCHITECTURE.md](../ARCHITECTURE.md) (15.1 to 15.7), [INTERFACES.md](../INTERFACES.md) (v0.3 parts),
[INTEGRATION-STATUS.md](../INTEGRATION-STATUS.md), [deviations/integration-v03.md](../deviations/integration-v03.md),
[deviations/integration-c2.md](../deviations/integration-c2.md), the lane notes they cite (idp, chat, freeze, doors), the
[mw-signin-v1 spec](../specs/mw-signin-v1.md) and the wording rules of [DESIGN-REVIEW.md](DESIGN-REVIEW.md) section 4. IP
visibility to peers is the stated premise of the light web and is not reported. Nothing in the repository was changed
except this file.

What was run (Node 24.22; every browser local-only: Chromium with `chromiumArgs()`, WebKit on `http://127.0.0.1` only; no
dist/ rebuild and no e2e port was opened):

| Run | Where | Result |
|---|---|---|
| `npm test` | the shared tree (allowed in place) | lint-floor clean; 1,967 tests, 1,966 pass, 1 fail: `pinwire.test.mjs` "a late wire gets the extension..." (timing; passed 3 of 3 runs on its own, not a finding of this lens) |
| Probes against the real modules, no browser | session scratchpad `sec/` | `escrow-stale.mjs` (finding 1), `record-proof.mjs` (7), `vault-bloat.mjs` (8), `group-fork.mjs` (3), `rotate.mjs` (4), `replace-keys.mjs` (5), `media-blob.mjs` (6), `verify-surrogate2.mjs` (17); each prints the failure described below |
| Local-only Playwright probes | session scratchpad `sec/` | `pin-bridge.mjs` (finding 12: a same-origin child frame passes the pin bridge's top-frame check, Chromium); `blob-nav.mjs` (finding 6: a `text/html` blob URL made by a page runs script in that page's origin with its storage, Chromium) |

Severity (as the task defines it): critical = exploitable, key or data loss, or a privacy promise broken; high = a documented
behaviour is wrong in a floor browser or a must-fix item of R is unimplemented; medium = edge case; low = hygiene.
Calibration used here: critical where a remote party (another site, an insider of a group) can cause key loss, a total
identity compromise or the failure of a stated privacy guarantee without unusual preconditions; high where the exploit needs
hostile code on the person's own site, a specific browser mode, or where an R must-fix decision is not effective in the code.

## Summary

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | critical | After the identity origin loses its storage, the first site's (older) vault escrow is adopted whole and the newer escrows are never read: labels created later get fresh random chat, record, own and local keys, so their sealed records, own media, chat history and caches become unreadable | `src/idp/idp.js:290`, `:330`, `:635-648`; `src/identity/store.js:268` |
| 2 | critical | A passphrase-wrapped root is handed to every site as "escrow", an offline-guessing target; the strength floor accepts the alphabet, a keyboard row and the first six BIP-39 words | `src/idp/idp.js:715`; `src/idp/store.js:177`; `src/identity/vault.js:386-408` |
| 3 | critical | Groups: a removed admin (or any admin) forks the group from an earlier epoch, grinds a low `epochId`, wins "lowest id" and every member encrypts to its key again | `src/chat/groups.js:61-67`, `:221-305`; `src/chat/service.js:616` |
| 4 | high | MF-20 recovery is not effective: no `keyinfo` is ever written for member keys, no client writes `rotate`, a rotated-away key keeps its writes and allow membership (and dodges bans of its successor), and whoever writes the first `keyinfo` for a key owns its recovery | `src/chain/state.js:877`, `:1105`, `:1868`; `src/identity/service.js:404`; `src/loader/personal-site.js:76` |
| 5 | high | "Replace my keys on all sites" strands the person's own personal site: the genesis owner key (index i) is never issued again and nothing hands the ledger or the pointer to key i + 1 | `src/idp/idp.js:817-830` |
| 6 | high | Private media in the Blob fallback is typed with the sender's manifest `mime`: a grant claiming `text/html` or `image/svg+xml` yields a script-capable `blob:` URL of the site origin | `src/media/session.js:162`; `src/media/lane.js:692`; `src/media/format.js:238` |
| 7 | high | `want: ['record', 'proof']` (or `purpose: 'site'` with a verifier nonce) gets a server-verifiable `mw-signin-v1` proof with no sign-in card and no statement shown | `src/idp/idp.js:571`, `:737`; `src/identity/client.js:116-121`; `src/identity/signin.js:230` |
| 8 | high | One site can bloat the vault through its private record (no size cap at the identity origin); every later sign-in at every site is then refused before it is sent ("escrow size"), and escrow rescue and the device link break | `src/idp/idp.js:653-659`; `src/identity/client.js:142`; `src/idp/store.js:186`; `src/idp/link.js:102` |
| 9 | medium | The hub label is offered for multi-tenant hosting suffixes (github.io, netlify.app, pages.dev, vercel.app, workers.dev and more) where anyone registers a 32-character name, and the page sets the box's default | `src/idp/psl.js:23-52`; `src/idp/idp.js:532`, `:586`, `:620` |
| 10 | medium | The ledger label accepts expired pointers forever, and the seq floor lives in plaintext state that the 7-day rule deletes: an origin once listed in `org=` keeps getting the person's ledger keys | `src/idp/idp.js:161`, `:167`, `:751` |
| 11 | medium | A removed group member keeps posting into the group for 7 days through the previous epoch, and members display it | `src/chat/service.js:544`; `src/chat/groups.js:184-192` |
| 12 | medium | The pin bridge's "top frame only" check is passed by the same-origin site frame through `window.top.__mwPinCall`: site code can sign, request pins as the owner (auto-accept bypasses the moderator queue) and drive the mailbox | `tools/pin.mjs:1175`, `:1066`, `:948` |
| 13 | medium | `_mw.cfg.pin`, the key that authenticates pin receipts, heartbeats and anchored pin wires, can be set by any moderator | `src/loader/app.js:4021-4025`; `src/chain/state.js:298`, `:1110` |
| 14 | medium | MP4 stripping removes `udta` and `meta` only; GPS in timed-metadata tracks (GoPro `gpmd`, `camm`, `mebx`, drone subtitle tracks) passes through while the card says "Location and camera details removed" | `src/media/strip.js:65-115` |
| 15 | medium | The 0.2.1 key is deleted from the site origin when any backup file ever existed, including one made before the key entered the vault | `src/identity/migrate.js:71` |
| 16 | medium | The pin node runs Playwright Chromium without its sandbox (Playwright's default) and with mDNS candidate hiding off, on an internet-facing machine that renders peer data; the pin container has none of the tracker's hardening | `tools/live.mjs:42`, `:45`; `test/e2e/browser-args.mjs:17`; `deploy/one-box/docker-compose.yml` (pin) |
| 17 | low | `@magnet-web/verify` throws (TypeError "jcs: lone surrogate") for a proof whose `resources` hold an escaped lone surrogate, after consuming the nonce | `packages/verify/verify.js:348`, `:365` |
| 18 | low | Any neighbour that relayed a frame can forge HOLDING for it: the sender shows "Handed to N peers" with N chosen by the neighbour | `src/chat/lane.js:445-449`; `src/chat/outbox.js:113-120` |
| 19 | low | The sign-in card always says "This site gets a key that works only here. It cannot see your other sites.", also in hub and linked modes | `src/idp/cards.js:321-322` |
| 20 | low | The identity origin takes "shared-origin hub, this visit only" from a page flag (`req.shared`); a shared-origin page that omits it gets a persistent key | `src/idp/idp.js:537` |

Overlap with the parallel conformance review (`code-review-v03-conformance.md`, in progress at 22:31 ET): its C1 (no client
writes `rotate`) and H1 (`hubDefault` preselects the hub link) touch findings 4, 5 and 9; the angle here is what an attacker
or a key thief gains.

---

## 1. critical: a stale vault escrow is adopted whole after the identity origin loses its storage

**Where.** `src/idp/idp.js:290-336` (`unlock`: with no wrapped record of its own, the IdO takes the request's escrow and
`if (fromEscrow)` stores that vault as its own); `:635-648` (`vault.label(label, { now })` creates a new entry with random
chat, record, own and local keys for any label the adopted vault lacks); `:729` (the bundle carries the new vault as
`vaultEscrow`); `src/identity/store.js:268` (`install` overwrites the site's escrow with it).

**Defect.** R 2.2.5 makes the escrow the way to survive Safari's 7-day rule. Each site holds the vault as it was at that
site's last sign-in. After the IdO's own copy is gone, the first site the person opens hands back its copy, which can be
weeks older than others; the IdO adopts it and, from then on, has a wrapped record of its own, so it never reads another
site's escrow again. No merge, no version check.

**Failure scenario** (reproduced by `sec/escrow-stale.mjs` with the real IdO in process). Day 1: sign in at a.example. Day 3:
sign in at c.example (label `o|https://c.example` is created with random chat key, K_rec, K_own, K_local). The IdO's storage is
then deleted (7 days without interaction on iOS Safari). The person opens a.example first: its day-1 vault is adopted. Then
c.example: the IdO ignores c.example's newer escrow and issues new random keys. Output: signing key kept (derived), chat key
kept: false, K_rec kept: false, K_own kept: false, K_local kept: false. c.example's synced `mw.s` items, its own-index items
(the keys of every private photo and video), the local record cache and every message sealed to the old chat key are now
unreadable, and c.example's escrow, the last copy of the old keys, is overwritten by the next install. Shredded keys also come
back the other way (idp lane item 18), so neither "deleting a key retires it" nor "nothing is lost on eviction" holds.

**Fix.** Treat every vault escrow a request carries as a candidate to merge, not to adopt: open it with K_vault (it is
authenticated), then take the union per label (chat epochs by `e`, record keys by `r`, `own` and `local` when absent,
contacts, links and `me` by their timestamps), keep a monotonic vault version and tombstones for shredded keys so a merge
never resurrects them, and do it on every sign-in, not only when the IdO has no record. Until then the card should say that
signing in to an older site first after a purge loses keys.

**Test.** Unit (idp-protocol style, in-process IdO): two sites signed in on different days, wipe the IdO store, sign in at the
older site then at the newer one; assert the newer site's chat, rec, own and local keys are the originals, and that a key
shredded by `me.erase` before the wipe does not come back.

## 2. critical: the passphrase-wrapped root is escrowed to every site, and the floor accepts trivial passphrases

**Where.** `src/idp/idp.js:715` (`escrow: s.wrappedRec.blob` for every method that is not "this visit only", the passphrase
blob included); `src/idp/store.js:177-182` (`acceptEscrow` takes `kind: 'pass'` blobs back); `src/identity/vault.js:386-408`
(`passphraseStrength`, also the gate of the unlock passphrase at `idp.js:246`).

**Defect.** R 2.2.5 escrows the blob because "the passkey-wrapped blob is opaque without the PRF output". The code escrows
the passphrase-wrapped blob too (root* and K_vault under Argon2id m = 64 MiB, t = 3, or PBKDF2 600,000), which is not opaque:
any site the person signs in to, hostile ones included, can guess offline. PRIVACY.md says the sites "hold only opaque wrapped
copies (escrow) that they cannot open". The floor is a character-class heuristic: `passphraseStrength` returns ok for
"abcdefghijklmnopqrstuvwxyz" (61 bits), "qwertyuiopasdfghjklzxcvbnm" (61) and "abandon ability able about above absent" (66,
the first six words of the list in order).

**Failure scenario.** A person on a browser without PRF (the floor, Firefox, WebKit where PRF is "flag only" per R 2.13)
unlocks with a passphrase. evil.example asks for a normal sign-in, stores `K.escrow`, and runs a dictionary of keyboard walks
and word-list prefixes through native Argon2id. A hit yields root* and K_vault: every label's signing key on every site, and
the vault (all random keys, records, contacts, legacy keys).

**Fix.** Never hand a passphrase blob to a site (escrow PRF blobs only; for passphrase users the card names the phrase and the
backup file as the way back after a purge), or wrap the escrow copy under a key that needs the IdO's own random secret.
Replace the heuristic with a check that refuses sequences, keyboard rows, repeated and ordered list words (zxcvbn-style), for
the unlock passphrase and the backup file alike.

**Test.** Unit: an identity unlocked by passphrase signs in; assert the bundle's `escrow` is null (or not `kind: 'pass'`).
Unit: `passphraseStrength` refuses the three strings above.

## 3. critical: a removed admin forks the group back; "lowest epochId wins" is grindable and has no time bound

**Where.** `src/chat/groups.js:61-67` (`resolveConcurrent`: lowest `epochId` wins), `:36-41` (`epochId = SHA-256(prev |
creator | SHA-256(secret))`, the creator chooses `secret`), `:221-254` (`verifyRecord`: the creator only needs to be an admin of
the parent epoch), `:262-305` (`receive` walks from the root and follows the lowest child at every level);
`src/chat/service.js:600-627` (`onInvite` takes any record whose parent is known).

**Defect.** R 2.7.7: "Rekey on every add and every removal ... the admin list ... checked on every rekey; concurrent rekeys:
the child with the lowest epochId wins". The code treats any two children of one epoch as concurrent, whenever the second
arrives, and the winner is the one whose creator ground the lowest hash. The union of removals only changes
`effectiveMembers()`; the winning epoch's secret is the one members encrypt to.

**Failure scenario** (reproduced by `sec/group-fork.mjs`). A creates a group with B and C and makes B an admin (E1). A
removes B (E2; B gets no secret). Three days later B, still an admin of E1, makes a child of E1 with members A, B, C, grinding
4,096 secrets for a low `epochId`, and sends the invite to C. C accepts it (conflict: true), C's current epoch is B's fork,
`secretFor(current)` equals B's secret, and every message C sends from then on is readable by B. A's "re-apply the removal"
makes a child of B's fork, and B can fork again: B keeps access for as long as B grinds harder. Any admin can also discard
every later epoch by forking from an early one.

**Fix.** A removal must win: refuse a child whose creator is removed in a sibling or a known descendant, and never adopt a
secret distributed by a key in the union of removals; accept a sibling only while its parent is current or within the grace
window after its replacement (and refuse children of epochs replaced earlier); make the tie-break among true concurrent
children something the creator cannot grind (for example the largest removal set first, then the lowest hash of the parent id
and the creator key).

**Test.** Unit (chat-lane-groups): the scenario above; assert C's current epoch secret is not B's and B's record is refused
(or loses). A second case: a fork from an epoch replaced more than 7 days ago is refused.

## 4. high: MF-20 recovery is not effective (keyinfo, rotate, retirement of the old key)

**Where.** `src/chain/state.js:877-885` (keyinfo: first per author in total order), `:1105` (`mayWrite(cs, chainOf(author))`:
nothing makes a rotated-away key ineffective), `:1868` (admit refuses a second keyinfo, `keyinfo-set`);
`src/loader/personal-site.js:76` (the only `keyinfo` any client writes: personal-site genesis); `src/identity/service.js:404` (a
`rotateNotice` with its `rsig` only becomes a `keychange` event; no code writes the `rotate` op); `src/chat/ck.js:105` (the CK
cache keeps the highest `epoch`, a number the signer chooses).

**Defect.** MF-20 decides `keyinfo` (a non-redactable commitment to the recover key) and `rotate` (recover beats self,
rotation inherits bans) so that a stolen key can be recovered. In the code: (a) member keys never get a keyinfo (the bundle's
`rc` is used only for personal-site genesis), so `rotate by: 'recover'` can never apply to them; (b) nothing writes `rotate`, so
"Replace my keys on all sites" changes nothing on any ledger; (c) after a rotation the old key keeps full effect, including
its allow membership, and a ban of the successor does not reach it (state test "a ban of next does not reach from" asserts
that the old key's later post shows); (d) since no keyinfo exists, the first one anybody writes with the key wins, and admit
then refuses the person's own.

**Failure scenario** (reproduced by `sec/rotate.mjs` against `reduce` and `admit`). (1) Ana writes keyinfo, her key is
stolen, she recovers to ANA2: the thief's post with the old key after the recovery takes effect and admit accepts new ones
(`{ ok: true }`). (2) Ana never wrote a keyinfo (the normal case). Hostile code on the site while she is signed in signs
`{ t: 'keyinfo', rc: H(attacker recover key) }` with her key; later the attacker writes a recover rotation of Ana's key to
its own key, which inherits her allow membership and shows contacts "key changed"; Ana's own keyinfo is refused
(`keyinfo-set`) and her recover rotation has no effect. The attacker can also keep a CK with `epoch` 2^53 - 1 signed by her key
in every contact's cache, so DMs go to the attacker's chat key and Ana cannot supersede it.

**Fix.** Write a keyinfo with the bundle's `rc` before a key's first write on any ledger (the loader already has `keys.rc`),
and write `rotate by: 'recover'` when a `rotateNotice` with `rsig` arrives for this ledger. In the reducer, make a rotation a
revocation as owner succession is (blocks by `from` not in the causal past of the winning rotation have no effect), make bans
cover the whole rotation family in both directions, and count a keyinfo only when every block of its author is in its causal
future (so a key that has already written cannot get a late commitment). Have the CK cache refuse CKs signed by a key the
ledger shows as rotated away, and bound `epoch` (for example epoch at most the previous plus one per 90 days).

**Test.** Reducer: after a recover rotation, a block by `from` outside the rotation's causal past is not effective and admit
refuses it; a keyinfo written after the author's first block is ignored. Loader: the first `db.append` of a signed-in key on
a ledger is preceded by a keyinfo carrying `keys.rc`; a `rotateNotice` with `rsig` produces a `rotate` block.

## 5. high: "Replace my keys on all sites" strands the person's own personal site

**Where.** `src/idp/idp.js:817-830` (`replaceAllKeys` bumps every label's sign index and records `rotated`); `:722-723` (the
next bundle carries a `rotateNotice`); no code writes an `owner` hand-over or a new pointer for the personal site.

**Defect.** A personal site's genesis owner is the person's key at index i (`writers: 'owner'`), and its pointer commits
`nx=` to index i + 1. After the button, every sign-in issues index i + 1 only; index i, the owner of the ledger, is no longer
reachable through any UI, and the ledger's owner succession needs a block signed by index i. The card text ("Each site gets a
new key for you, and people who know your old key see that it changed.") does not say this.

**Failure scenario** (reproduced by `sec/replace-keys.mjs`). "Create my page" (genesis owner index 1, `nextPubHash` set), then
Settings, "Replace my keys": the next sign-in at the page returns index 2, a different key. The person can no longer post on
their own wall (writers 'owner') or change its policy; only a phrase-only restore on a fresh vault (index 1 again, idp lane
item 8) gets the key back, at the price of the vault.

**Fix.** For labels whose current key owns a ledger, let the IdO card sign one `owner` hand-over from index i to i + 1 and a
pointer with `owner` = key(i + 1) (accepted through `nx=`), written by the loader on the next sign-in; or exclude owner labels
from the bulk replacement and say so on the card.

**Test.** Unit (in-process IdO plus ChainNode): create a page, replace keys, sign in again; assert an `owner` block from index
1 to index 2 is written and the new key has owner standing.

## 6. high: the media Blob fallback trusts the sender's `mime`

**Where.** `src/media/session.js:152-162` (`new Blob(parts, { type: info.mime })`, `info.mime` is `M.mime` or `M.pmime`);
`src/media/lane.js:688-697` (`onGrant` accepts the sender's manifest after `checkManifest`); `src/media/format.js:238`
(`checkManifest` checks only that `mime` is a non-empty string; `pmime` likewise).

**Defect.** R 2.8.5 and 2.9.6: types come "from the sniffed allow-list only", and the Blob fallback runs "after the same
checks". The worker route does this (`mediaHeaders` falls back to octet-stream with `sandbox`), but the Blob fallback (no
active worker: degraded mode, a drop-in page whose worker is not active, the iOS default if G-MD-2 says so) types the
decrypted bytes with whatever the grant says.

**Failure scenario** (reproduced by `sec/media-blob.mjs` and `sec/blob-nav.mjs`). A contact grants a "photo" whose manifest says
`kind: 'image', mime: 'text/html'` (or `image/svg+xml`) and whose bytes are a page with a script. The person accepts the offer
on a browser without an active worker; `media.open` returns `blob:https://site/...` typed `text/html`. The social template
shows it in `<img>` (inert), but "Open image in new tab", or any site code that navigates to `out.url`, renders it as a
document of the site origin: in Chromium the script ran with `location.origin` of the site and read its storage, so it can
use the stay-signed-in CryptoKeys, the sealed caches and the SDK as the person.

**Fix.** In `checkManifest` (or in `onGrant` and `restore`) require `mime` in `MEDIA_TYPES`, `pmime` empty or an image type of
that list, and `kind` consistent with `mime`; in `MediaSessions.open` type the Blob with the allow-listed value or
`application/octet-stream`; sniff the first decrypted chunk before playing.

**Test.** Unit: a grant with `mime: 'text/html'` is refused by `onGrant` (or opened in blob mode with a Blob type in
`MEDIA_TYPES` or octet-stream). Browser test: with the worker disabled, the opened URL never has a script-capable type.

## 7. high: a server-verifiable sign-in proof without the sign-in card or the statement

**Where.** `src/identity/client.js:116-121` (`validateRequest` allows `want: ['record', 'proof']` with `purpose: 'site'`);
`src/idp/idp.js:571-575` (a request with `record` and without `keys` shows only the "read private record" card), `:737-744`
(any `want` with `proof` signs); `src/identity/signin.js:230` (for `purpose: 'site'` a page-supplied `challenge.nonce` is used
as the nonce).

**Defect.** R 2.3.9: "statement verbatim; no silent proofs for servers (each server proof shows the card)"; R 2.3.2: proofs
for a page's own use carry an IdO nonce, so `@magnet-web/verify` "rejects them by construction". The signed object has no
purpose field, so a `purpose: 'site'` proof with the server's nonce is accepted by the server, and with `want: ['record',
'proof']` it is made behind a card about something else.

**Failure scenario** (reproduced by `sec/record-proof.mjs`). Script on forum.example (an injected tag, a compromised
dependency) fetches a challenge for "I agree to close my account and give my username to someone else", opens the IdO through
`window.top` (the shell frame is same-origin with `allow-popups`) and asks `want: ['record', 'proof'], purpose: 'site'` with
that challenge. Cards shown: recordRead (and the passkey prompt); the statement appears on none. The server's verifier
answers `{ ok: true, statement: 'I agree to close my account ...' }`.

**Fix.** Accept only the combinations of R 2.3.2 (`['keys']`, `['proof']`, `['keys', 'proof']`, plus `record` and `erase`
alone); refuse `challenge` unless `purpose` is `'server'`, and never take a page nonce for `'site'`; whenever `want` has
`proof`, show the sign-in card with the statement.

**Test.** Unit: `validateRequest` refuses `['record', 'proof']`; `handleRequest` with `purpose: 'site'` and a challenge nonce
gives a proof whose nonce is not the page's (or `E_BAD_REQUEST`); a request with `proof` always calls the `signin` card with the
statement (scripted cards record it).

## 8. high: one site can make sign-in fail everywhere by bloating the vault

**Where.** `src/idp/idp.js:653-659` (the site's private record, sealed under its own K_local, is merged into
`entry.me[origin]` with no size or field cap); `src/identity/client.js:142` (a request whose `escrow` is over 400,000
characters is refused before it is sent) and `:48`; `src/idp/store.js:186` (an escrow vault over 350,000 characters is
ignored); `src/idp/link.js:102` (at most 200 parts of 900 characters); `src/identity/client.js:181` (a sealed answer over 1 MiB
is "malformed").

**Defect.** `mw.me.set` caps a record at 31,403 bytes in the site's own code, but the IdO accepts any record the site seals,
up to the request limit, and merges fields across requests, so the vault grows without bound. Every site gets the whole vault
as `vaultEscrow` and sends it back with every request.

**Failure scenario** (reproduced by `sec/vault-bloat.mjs`). evil.example sends two records of one 200,000-character field each.
good.example's next sign-in succeeds and stores a 534,959-character vault escrow; the sign-in after that is refused in the
page ("escrow size"), and so is every later one at every site the person signs in to after the bloat. The escrow rescue after
a purge (over 350,000) and the device link (over 180,000) no longer work either; with more bloat the answer itself exceeds 1
MiB.

**Fix.** At the IdO, cap each origin's record (the 31 x 1,013-byte budget) and the vault size, refuse larger records; do not
send the vault escrow with every request (send it only when the IdO asks for it after `mw-idp-ready`), and drop an oversized
escrow instead of failing the request.

**Test.** Unit (in-process IdO): a 300 KB record from one origin is refused; after it, two sign-ins at another origin succeed.

## 9. medium: the hub label covers multi-tenant hosting platforms, with a page-set default

**Where.** `src/idp/psl.js:23-52` (the curated list: appspot.com, github.io, netlify.app, pages.dev, vercel.app, workers.dev,
herokuapp.com, glitch.me, ngrok.io, trycloudflare.com and others); `src/idp/idp.js:532` (`hubSuffixOf(host)`), `:586`
(`defaultOn: req.hubDefault === true`), `:620` (the choice is stored once per suffix); `src/identity/derive.js:278-285`.

**Defect.** The hub label `h|<suffix>` gives one key for every host `<32 base32>.<suffix>` once the person opts in. On these
platforms any stranger can register a 32-character name, so "one hub" is every site anyone deploys there, run by unrelated
people; the PSL listing means the opposite of a single operator. The box's default comes from the page (`hubDefault`, also
finding H1 of the conformance lens).

**Failure scenario.** An attacker publishes a magnet-web page at `aaaa...aaaa.pages.dev` (32 letters), asks for sign-in with
`hubDefault: true`; the person taps Continue with the box checked. From then on every hub-shaped magnet-web site on pages.dev
that the person signs in to gets the same signing key, chat key, K_rec and K_own (the card only shows "One identity on all of
pages.dev"): the attacker's other sites link the person across them, and a genuine site there shares the person's keys with
the attacker, who can post as the person there and read their synced records, own media and DMs on that site.

**Fix.** Offer the hub label only for suffixes of a hub list built into the IdO (hubs that serve one operator's personal
sites), never for platform suffixes; never let a page set the default.

**Test.** Unit: `hubSuffixOf('<32 letters>.netlify.app')` is null in a production build; the signin card's hub box is
unchecked whatever `hubDefault` says.

## 10. medium: the ledger label accepts expired pointers and forgets its rollback floor

**Where.** `src/idp/idp.js:161` (`verifyPointer(record, scope, { now, allowExpired: true })`), `:167-168` (the seq floor),
`:749-752` (floors are kept in the IdO's plaintext state, which a purge deletes).

**Defect.** An expired record still yields `l|<ledgerId>` as long as it is signed and lists the origin in `org=`; the only
defence is a seq floor this IdO recorded earlier, which exists only for people who signed in through a newer record on this
device and is lost with the IdO's storage.

**Failure scenario.** A site listed `https://mirror.example` in `org=` last year, then dropped it; the domain lapses and is
re-registered. The new holder serves the old signed record (scope hint = the site's host) and asks for sign-in: people whose
IdO has no floor for that ledger (new devices, purged storage) get the ledger label, that is their signing key on the real
ledger, K_rec (synced records), K_own (own media) and chat keys.

**Fix.** Refuse expired records for the ledger label (fall back to the origin label), keep the seq floors in the vault so they
travel with the escrow and the backup, and say on the card when a mirror gets the site's label.

**Test.** Unit: `verifyPointerFor` with an expired record listing the origin in `org=` gives `ok: false` and the request gets
`o|<origin>`.

## 11. medium: removed group members keep posting for 7 days

**Where.** `src/chat/service.js:537-554` (a group message is accepted when its sender is a member of the epoch of its tag);
`src/chat/groups.js:184-192` (`listening()` keeps replaced epochs for 7 days).

**Defect.** Members listen on the previous epoch so that stragglers' messages arrive, but the membership checked is the old
epoch's, so the key removed by the rekey is still accepted there.

**Failure scenario.** A removes B. B (who gets no new secret) keeps sending under the old epoch for 7 days; A and C display
B's messages in the group as if B were a member.

**Fix.** On a replaced epoch accept only senders who are members of the current epoch (minus the removal union), and only
messages with `t` before the replacement plus the skew.

**Test.** Unit: after the removal, a message from B sealed under the previous epoch emits no `group` event.

## 12. medium: site code reaches the pin bridge through `window.top`

**Where.** `tools/pin.mjs:1175-1180` (`exposeBinding('__mwPinCall')` with the check `source.frame !== page.mainFrame()`),
`:1066` (`file.request`), `:927-949` (auto-accept when the request's `author` equals the site owner; `author` is not
authenticated), `:1085-1108` (`mailbox.*`, `pin.sign`); the comment at `:1171` and DEPLOY say site code "cannot reach the pin
store".

**Defect.** The shell's site frame is same-origin with the top frame (`allow-scripts allow-same-origin`, `src/loader/render.js:30`).
Calling `window.top.__mwPinCall` runs the top frame's binding, so Playwright reports the main frame as the source
(`sec/pin-bridge.mjs`: "own frame: refused | top binding called from the child frame: accepted").

**Failure scenario.** Hostile code in the pinned site (a third-party tag, a stored script in user content) on the pin's
browser calls `top.__mwPinCall('file.request', { ih, size, author: <owner key> })`: with `PIN_AUTO_ACCEPT=owner` the pin
fetches and seeds that infohash at once, bypassing the moderator queue MF-50 requires; it can also read and delete mailbox
frames and ask for receipt signatures of kept items.

**Fix.** Do not expose security-relevant operations to page script: have the Node side drive the page for signing, or require
every `file.request` to be signed by `author` and verified in Node (no auto-accept for unsigned requests); fix the comment and
DEPLOY.

**Test.** A local-only Playwright test like `sec/pin-bridge.mjs` in tools-c2-pin: a same-origin child frame's call through
`top` is refused.

## 13. medium: a moderator can name the pin key

**Where.** `src/loader/app.js:4021-4025` (`pinKeyOf` reads `_mw.cfg.pin` whoever wrote `_mw.cfg`); `src/chain/state.js:298-299`
(`cfgOk` accepts `pin`), `:1110` (`_` keys are open to moderators).

**Defect.** R 2.5.5: "Every `_mw.cfg` value is advisory ... nothing security-relevant is stored there". The pin key decides
which node's receipts and heartbeats count as "Kept by the site" (E4) and which wires are anchored.

**Failure scenario.** A moderator sets `_mw.cfg.pin` to a key of their own node, which answers hello and receipts without
keeping anything: members see "Kept by the site" and close their pages, the items disappear with them, and the node holds
anchor slots on every visitor's swarm.

**Fix.** Take the pin key only from an `_mw.cfg` entry written with owner standing (`state.ownerWritten`), or move it to the
policy or the pointer.

**Test.** Unit: a moderator-written `_mw.cfg` with `pin` gives `pinKeyOf` null.

## 14. medium: MP4 stripping leaves GPS in timed-metadata tracks

**Where.** `src/media/strip.js:65-115` (only `udta` and `meta` inside `moov`, and top-level `udta`, `meta` and XMP `uuid`, become
`free` boxes); the media and files lanes then show "Location and camera details removed".

**Defect.** Action cameras, drones and 360 cameras record position as a track (`trak` with a `meta` or `text` handler and a
`gpmd`, `camm`, `mett` or `mebx` sample entry, samples in `mdat`). Those tracks stay.

**Failure scenario.** A GoPro clip uploaded as private media or a public file keeps its GPMF GPS5 stream; anyone who receives
it can extract the route, while the person was told the location was removed.

**Fix.** For timed-metadata and subtitle tracks, zero their samples in `mdat` (located through the track's `stco` or `co64` and
`stsz` tables) and replace the `trak` box with a `free` box of the same length, as is done for `udta` (freeing the box alone
leaves the GPS bytes in `mdat`); or refuse a public upload and warn before a private one when such a track exists. Never show
"removed" for a file that still has one.

**Test.** Unit with a fixture MP4 carrying a `gpmd` track: the stripped file has no such track, or `E_MEDIA_STRIP` is raised.

## 15. medium: the 0.2.1 key can be deleted before any backup holds it

**Where.** `src/identity/migrate.js:71` (`deleteLegacy = stored && K.status.fileSaved`; `fileSaved` is a lifetime flag set by
any earlier backup, `src/idp/idp.js:872`).

**Defect.** R 2.2.7: deleted "from the site origin after a backup exists", meaning a backup that contains it.

**Failure scenario.** The person made a backup file last month, then signs in on a 0.2.1 site today: the legacy key moves into
the vault and is deleted from the site at once. If this device's IdO data is lost (or finding 1 replaces the vault), the old
backup does not contain the key and the 0.2.1 identity on that ledger is gone.

**Fix.** Report from the IdO whether the newest backup file postdates the legacy entry (`legacy[].t` against `backup.fileAt`)
and delete only then.

**Test.** Unit: `legacyOutcome` with a backup older than the legacy key keeps the key.

## 16. medium: the pin node's browser runs without the Chromium sandbox

**Where.** `tools/live.mjs:42` and `:45` (`launchPersistentContext` and `launch` without `chromiumSandbox: true`, so Playwright
passes `--no-sandbox`, as the pin Dockerfile notes); `test/e2e/browser-args.mjs:17` (`--disable-features=WebRtcHideLocalIpsWithMdns`
is kept for `allowRemote` tools); `deploy/one-box/docker-compose.yml` (the `pin` service has no `cap_drop`, `no-new-privileges` or
`read_only`, unlike `tracker`).

**Defect.** The pin is an always-on, internet-facing browser that renders the site and processes blocks, pieces and mailbox
frames from any peer. Without the sandbox a renderer bug is code execution as the container user with the pin key in reach; the
disabled mDNS feature puts the container's private addresses in every ICE host candidate.

**Fix.** Launch with `chromiumSandbox: true` (with the seccomp profile or user namespaces the image needs), add the tracker's
container hardening to `pin`, and drop the mDNS feature flag for remote-capable runs.

**Test.** Tools test: `launchBrowser({ allowRemote: true })` passes `chromiumSandbox: true` and no `WebRtcHideLocalIpsWithMdns`;
a compose lint asserts the pin service's hardening keys.

## 17. low: the verifier throws on a lone surrogate in `resources`

**Where.** `packages/verify/verify.js:348` (`resources` entries are only checked with `startsWith('https://')`), `:365` (`jcs(c)`
throws for a lone surrogate; the `.catch` covers only the WebCrypto promise); the nonce is consumed at `:358`.

**Failure scenario** (`sec/verify-surrogate2.mjs`). A body with `"resources":["https://\ud800"]`, a valid issued nonce and any
valid P-256 key: `verify()` rejects with "TypeError: jcs: lone surrogate" instead of `{ ok: false }`, after burning the nonce.
The recipe server catches it (500); a server that awaits `verify()` without a catch gets an unhandled rejection.

**Fix.** Check every string field for lone surrogates (as `statementBad` does) before the nonce step, and wrap `jcs` in the
`'parse'` path. **Test.** A negative vector with that body: `{ ok: false, reason: 'parse' }` and the nonce still unused.

## 18. low: HOLDING is unauthenticated

**Where.** `src/chat/lane.js:445-449` (a HOLDING whose `frameId` is one of our own frames is believed from any neighbour);
`src/chat/outbox.js:113-120` (each one increments `handed`).

**Failure scenario.** A neighbour that relayed a DM sends 50 HOLDING frames with fresh stamps: the sender sees "Handed to 50
peers" (MF-35: no string may claim what the protocol cannot know). Retries continue, so delivery is not stopped.

**Fix.** Count distinct wires, at most one per neighbour, and word the state as reported by neighbours; or have holders sign
HOLDING with a key the sender can check. **Test.** Unit: repeated HOLDING from one wire counts once.

## 19. low: the card's isolation sentences are wrong in hub and linked modes

**Where.** `src/idp/cards.js:321-322` add `keyOnlyHere` and `cannotSeeOthers` on every sign-in card, also when the mode line says
"One identity on all of {hub}" or "Same as on {site}". **Fix.** Pick the sentences by mode (R 2.3.5 and 2.14 texts).
**Test.** Card unit test: the hub and linked cards do not contain `keyOnlyHere`.

## 20. low: "this visit only" is a page flag

**Where.** `src/idp/idp.js:537` (`req.shared === true` selects the visit-only key); R 2.2.3: a shared-origin hub "never receives
a persistent key". A page on a shared origin that omits the flag gets a persistent `o|<origin>` key shared by every publisher
there. Shared-origin hubs are a loopback demo today (ARCHITECTURE 3.3), hence low. **Fix.** Decide shared-origin status at the
IdO (a path-based hub list in the build) rather than from the request. **Test.** Unit: a request from a listed shared origin
without `shared` still gets `keyMode: 'visit-only'`.

---

## Checked and found sound (no finding)

- **Identity origin messaging.** Requests only from `event.source === window.opener`, the requester from `event.origin`,
  answers with `targetOrigin` = that origin, one request per window, the count and legacy rounds bound to opener and origin
  (`src/idp/idp.js:882-955`); redirect mode binds `ret` exactly to `origin + '/_mw/idp-return'` (`client.js:159-168`) and the
  answer is sealed to the requester's key, so a third page cannot read it; the return page finds the pending key by
  `requestId` only on its own origin.
- **The key bundle and caches.** ECIES with HKDF info bound to the origin and AAD over prefix, origin, `requestId` and `epk`
  (`client.js:188-230`); K_local caches bound to label and name; the 0.2.1 key travels sealed to an IdO ephemeral key.
- **Derivation and wrapping.** HKDF tree and `scalar()` as R 2.2.2; the wrap header bound as AAD, KDF bounds checked before
  use, escrow KDF parameters pinned (`wrap.js`, `store.js:171-190`); Argon2id matches RFC 9106 5.3 (unit test).
- **Device link.** Commit (SHA-256 of eB) before eA, SAS over eA, eB and nonceB, 120 s windows, ciphertext only after the
  person confirms; a substituted key matches with probability about 10^-6 (`src/idp/link.js`).
- **mw-signin-v1.** Builder and both parsers refuse duplicate keys, DER signatures and unknown fields; `exp - iat` at most
  5 minutes; the verifier checks origin, domain, ledger, key mode, idp and age before the nonce (findings 7 and 17 aside).
- **Sealed items.** 1,024-byte plaintext, random IV, AAD over ledger and author, strict padding check, kinds 4 and 5 through
  the box (`src/identity/sealed.js`).
- **Chat crypto.** The Noise XX transcript follows the spec step by step (mixHash, mixKey, ee, es, se, split; points checked on
  the curve); the contact box keys on K_pair and the recipient's static key (a reflected frame does not open); stranger frames
  carry an inner K_pair MAC after the CK check; frames, HELD, WANT, ICHAL/IRESP and PRES are bounded; the relay stamp binds
  `frameId`; the replay guard (window, high-water mark, Bloom days) is sound.
- **Private media and files.** Chunk nonces `base || i` under a per-item random key, AAD over fid, version, index, total and
  region; STREAM records with the last flag; the worker routes answer only allow-listed types or octet-stream with `sandbox`,
  `nosniff`, CORP and `no-store`; `files.preview` re-encodes; grants are redacted before any site event (`api.js:1192`).
- **Calls.** No `RTCPeerConnection` before accept; SDP and candidates only inside K_pair-sealed SIG; received private,
  loopback and link-local candidates dropped and our own masked (`src/calls/ice.js`); the DTLS fingerprint rechecked through
  `getStats`.
- **Ledger.** HELLO bounds (`n + c`, `-1 <= d < n + c`, window index bound) and pre-parse budgets (`src/chain/gossip.js`);
  unban standing (owner bans only by the owner), `ban.until`, `voided`, owner-protected payload, author-scoped keys and the rotate
  author and `rsig` validity checks (`block.js:437`, `:520`); the wire budget is the device policy, not a site value.
- **Pointer.** `nx=` is sticky under one owner; `org=` at most 4; `dr=` hosts parsed strictly; door hints only for public hosts.
- **Tools.** `ship` keeps the owner key local (mode 600) and passes only checked words to ssh; `verify-release` verifies against
  a pinned key only; the one-box Caddyfile logs nothing by default and keeps the tracker internal.

## Not verified here

- The e2e suites (run by the conformance lens on its own copy) and any real device: iOS Safari's Blob or worker choice for
  media (G-MD-2), PRF availability (decides how many people hit finding 2), Safari's handling of a top-level `blob:` navigation
  (Chromium confirmed finding 6; WebKit refused the probe's cross-page navigation).
- Firefox: not run.
- The hub follow lane (`src/chain/multi.js`, `recent.js`) was read for trust rules only; a peer that withholds control blocks
  from a window behaves as it does in full sync (stated), and no separate finding was made.
- The checkpoint reducer and the reserved pool were read, not attacked.
