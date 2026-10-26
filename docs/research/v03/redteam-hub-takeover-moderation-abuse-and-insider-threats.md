# Red team: hub takeover, moderation abuse and insider threats

- **Attacker class:** a hostile or compromised hub operator; an abusive or compromised moderator; a thief or buyer of the owner key; someone abusing a denylist or a directory; and anyone who exploits what cannot be undone.
- **Scope:** magnet-web v0.2.1 as built, plus the v0.3 proposals in IDENTITY-AUTH-DESIGN.md (IA) and REALTIME-AND-FILES-DESIGN.md (RF), including the 2026-10-20 cross-site sign-in addition.
- **Method:** public code and design in hand. I read the files cited below. I did not run code or a browser, so every "works today" is a reading of the source, and each carries a one-line test that would confirm it. Only attacks that work or might work are listed.
- **Labels:** works today / works against the proposal / blocked by / needs measurement. Severity: blocker, major, minor.

## 0. Verdict table

| ID | Attack | Label | Severity |
|---|---|---|---|
| H1 | Hostile loader host or hub origin takes the identity root, hence every site key | works against the proposal | blocker |
| H2 | Moderator key lifted by same-origin site code, then silent mass ban and tombstone, no undo | works today | blocker |
| H3 | Stolen owner key: silent `rot=` pointer rotation, ledger hand-over, deliberate `ownerConflict` freeze | works today | blocker |
| H4 | Replay of an old signed withdrawal (or old pointer) to fresh visitors by the host or DNS path | works today | major |
| H5 | Moderator tombstones the owner's own payload entries | works today | major |
| H6 | Banning a moderator does not revoke the moderator's earlier bans | works today | major |
| H7 | Value dropped on a tombstone from a moderator the peer does not yet know was removed | needs measurement | major |
| H8 | D-9 (moderators write `allow`) and D-10 (`unban`, `rotate`) open new insider moves | works against the proposal | major |
| H9 | Forged or inflated "credible report" drives a one-hour withdrawal of a legitimate site | works today | major |
| H10 | Ownerless hub ledgers: nobody can moderate, the operator has no denylist | works today | major |
| H11 | Future hub denylist or directory becomes the censorship and extortion point | works against the proposal (roadmap) | major |
| H12 | Pointer seq race between thief and owner | works today | minor |
| H13 | Impersonation by `profile` name, and "use the same identity here" as a linkability lever | works today / against the proposal | minor |

## 1. What the design already stops (do not re-fix)

- **Owner key never enters a browser** (bridge.js:513-517 throws on `owner.policy`; SECURITY-MODEL line 81). A moderator cannot become the owner by browser compromise alone, and cannot change policy or hand over.
- **Succession is a revocation and not decided by total order.** A key that has handed over has no owner standing for anything beside or after the hand-over (state.js header lines 7-22). Two competing hand-overs by one key are not settled by hash order; only the pointer owner's endorsement settles them (state.js:260). A hub operator cannot pick a winner.
- **A removed moderator governs nothing concurrent or later.** `controlFor` applies a policy to every block that is not in the policy's ancestors (state.js:686-715). A moderator who withholds a private fork of bans and releases it after removal has those bans ignored. This is a real defence and I could not break it by fork withholding.
- **Control blocks can never be redacted** (state.js:517, block.js:16), so a moderator cannot tombstone a policy, a hand-over or another ban to hide their trail.
- **Owner is exempt from bans** at the block where it holds standing (state.js:548), so no moderator can ban the owner out.
- **Hub apex cannot mint names.** The edge rule accepts only 32-character base32 labels (DEPLOY.md hubs section); a shared-origin hub is documented as for one publisher.
- **Withdrawal is fail-closed** (`st=` anything but `ok` withdraws, ARCHITECTURE 4) and deletes every stored version.

## 2. Attacks

### H1. Hostile loader host or hub origin takes the identity root (works against the proposal; blocker)

- **Preconditions:** the attacker controls what a loader origin serves: a hub operator on a subdomain hub label (each label is its own origin), the host of a per-domain site, or a CDN or build compromise of `/_mw/`. IA says "whoever controls the host" is in the threat model (IA 6.4 row "Hostile code on the origin while unlocked") and that the root lives in IndexedDB `mw-id` at the loader origin (IA 3.4). The 2026-10-20 addition asks for one root per person usable on every site and through the drop-in widget, on pages whose origin is the host's own.
- **Steps:**
  1. Serve a loader build that behaves normally and also copies the unwrapped root, or the phrase typed into the "I already have one" card, or simply asks the passkey to unwrap and reads the result in loader memory.
  2. HKDF is deterministic: from the root the attacker derives the signing key for every ledger id and, with "use the same identity here", the shared key (IA 3.1).
  3. Sign in as the person on any magnet-web site, any server that accepts the SIWE-shaped challenge (domain binding does not help, the attacker holds the key and can sign a challenge for any domain), and decrypt the sealed record and chat keys.
- **Gain and harm:** total account takeover across all sites and servers for every visitor who unlocks on that origin; per-site derivation (anti-linkability) is defeated because the root, not a site key, is exposed. Scales with the number of visitors of the hostile origin, and on a hub with many labels, with the hub's users.
- **Already stopped:** IA 4.1 and 6.5 say site code cannot call `identity.root`; that is a UX boundary and IA 6.5 admits it does not hold against code on the loader origin. IA's proposed dedicated identity origin is "design note only".
- **Open.** Cheapest effective defences:
  1. **Root never lives on, or is unwrapped in, an origin the site controls.** Unlock and derive on one fixed identity origin; hand the site only a signature or its derived site key. Cost: a top-level redirect or popup round trip, because embedded iframes get partitioned storage (needs measurement on Safari, Chrome, Firefox; I have not tested). It also means a project-controlled origin becomes a takeover point itself (see 3.1).
  2. **Never accept the phrase on a site origin.** Phrase entry only on the identity origin; site-origin cards offer passkey or hand-off only. Cost: slower restore.
  3. **Document the line** for the 0.2.1-style flow: on a hostile host the root is lost; recommend session-only root on shared hubs (IA 3.4 already refuses persistent identity on shared-origin hubs; extend to subdomain hubs run by a party other than the site owner).
- **Cost to honest users:** one extra hop at sign-in, and a single fixed origin to trust.

### H2. Moderator key theft and silent mass moderation (works today; blocker)

- **Preconditions:** a moderator imported their key in a browser (Settings, Import moderator key; app.js:2641-2650). The record is stored as `{ kind: 'jwk', jwk, pub }` with the private scalar `d` in IndexedDB (app.js:517), and `ensureIdentity` itself comments the key is "extractable so Settings can export it". In shell and per-domain mode, site code is same-origin with the loader (IA 6.5; SECURITY-MODEL).
- **Steps (any one of):** (a) hostile site code or a compromised tag reads `moderator:<ledgerId>` from IndexedDB and exfiltrates `d`; (b) without reading it, calls `mw.db.tombstone(h)` and `mw.mod.ban(pub)` through the SDK in a loop: both are in `WRITE_METHODS` (bridge.js:25) with no user gesture, bounded only by 20 writes a minute (bridge.js:40, about 1,200 an hour), and moderators are exempt from proof-of-work. Step 2: enumerate every author from the ledger and ban each (state.js:513 adds to `banned`; state.js:548 redacts every payload of a banned author, old and new). Step 3: tombstone the rest.
- **Gain and harm:** a visitor-run site loses its content for every honest copy, and the owner cannot undo it: there is no `unban` and no undelete (OPERATIONS "The owner key is stolen": "there's no unban or undelete"). The owner can remove the moderator going forward (policy) but bans issued before the removal stand (state.js:686-715 only excludes blocks concurrent or later). Harm is the whole site's user content. Scales to any ledger whose moderator opens a page of a compromised site.
- **Blocked by:** nothing for (a) or (b). Rate limit slows, does not stop.
- **Cheapest defences:**
  1. **Moderator actions need a loader-owned confirm with user activation**, never an SDK call without it (as `consent.accept` already is, bridge.js header lines 8-9). Cost: one click per moderation, plus batch confirm "ban 40 keys".
  2. **Store the moderator key non-extractable** (CryptoKey, not JWK) and import it once from file without keeping `d`. Cost: no re-export; moderators keep their file.
  3. **Bound the blast radius with an owner-set cap** on bans and tombstones per moderator per hour, enforced by `admit` and the reducer (a policy field, so a format change). Cost: a freeze-window decision.
  4. **Ship `unban` and make moderator actions reversible within a window** (see H8); redaction already destroys values on honest copies, so also require a delay before values are dropped (H7).

### H3. Stolen owner key (works today; blocker)

- **Preconditions:** the attacker holds the owner JWK (CI secret, laptop). IA says nothing new here; it keeps the owner key outside browsers.
- **Steps and gains:**
  1. **Silent pointer rotation.** Sign a pointer for the hostname with `rot=` (a signature by the previous owner key, ARCHITECTURE 4) and a seq above the current one. "With a valid `rot` a key change is silent": no TOFU prompt. Needs the page host or DNS to deliver it (OPERATIONS: "the thief also needs your host or your DNS"). For a hub-by-magnet site, scope is `btih:` and the hub link itself is the delivery path.
  2. **Ledger hand-over to the thief's key**, then bans and policy changes under owner standing.
  3. **Deliberate `ownerConflict` freeze.** The thief signs two hand-overs from the stolen key. For visitors whose pointer owner is still the old key, `keys.indexOf(expectedOwner) < 0` is false (state.js:260), so no endorsement can pick one; `frozen = true` (state.js:262): owner changes pause, and the key keeps standing only for the common past. The real owner cannot hand over to a new key until the pointer owner is rotated, because their own hand-over is just a third contested candidate. That needs the owner to republish through the same host.
- **Harm:** hostile code to every first-time visitor of the hostname (via step 1), plus a ledger the owner cannot repair. Bans and tombstones the thief signed before the owner's hand-over stand (OPERATIONS).
- **Blocked by:** the pointer owner's endorsement for step 2 on visitors who got the owner's new pointer; the `lo=` field keeps history.
- **Open:** no pre-rotation (ROADMAP 1.0), no threshold, no delay or watch period on ownership changes, no way to commit a recovery key in advance.
- **Cheapest defences:**
  1. **Pre-committed recovery key** in the pointer (hash of the next owner key), so a stolen current key cannot rotate silently. Cost: the owner stores a second key offline.
  2. **Visible delay for hand-overs and rotations**: loaders show "owner changed N minutes ago" and refuse to apply a `rot` for new first-time visitors for a window unless a recovery commitment matches. Cost: slower emergency recovery.
  3. Document and test the freeze deliberately: a script that equivocates must not be able to lock out the true owner; allow `expectedOwner` already in the chain when it matches a block signed by a pre-committed key.

### H4. Replay of an old signed withdrawal or pointer (works today; major)

- **Preconditions:** whoever controls the host, the DNS resolver path or the CDN for the hostname. Signed pointers have `exp` up to 399 days and the withdrawal default is 399 days (ARCHITECTURE 4, lines about `exp`). Fresh visitors have no cached `seq` floor ("a lower `seq` than the cached record is refused" only against the cache). "Several TXT records: the highest valid `seq` wins" among records the visitor sees, and the attacker chooses which records it shows.
- **Steps:** after an owner withdrew a site and later restored it (or just updated), serve only the old withdrawn record (or an older vulnerable version) to first-time visitors or to targeted ones.
- **Gain:** targeted takedown of the live site, or rollback to a version with a known bug, for visitors with no cache. Signature is valid, so it is accepted.
- **Defences:** short `exp` on withdrawals (for example 30 days, re-signed), plus a second source check (page tag against DNS, already present in ARCHITECTURE 5.8) that treats disagreement as "unverified, show both". Cost: owners re-sign monthly; a CI job can do it.

### H5. Moderator tombstones the owner's own entries (works today; major)

- **Steps:** state.js:513-522: a tombstone is valid from any privileged author for any payload target; only control blocks are protected (line 517). The owner's `put` and `append` entries are payload. A moderator can tombstone the owner's `_roles/...` hints, site config keys and announcements. Values are dropped on honest copies.
- **Harm:** an insider moderator overrides the owner on content and on advisory roles IA 5 relies on (`_roles/`, D-8). The owner can re-put a key (last writer wins) but not restore a deleted `append` entry.
- **Defence:** exclude entries with owner standing from moderator tombstones (the reducer already knows `standing[i]`). Cost: a validity change in the freeze window; moderators lose nothing they should have.

### H6. A banned or removed moderator's earlier moderation survives (works today; major)

- `privileged` for ban and tombstone checks `cs.moderators.has(e.author)` only (state.js:510). Banning a moderator redacts that moderator's payload but does not invalidate their control blocks, and removing them by policy does not invalidate anything signed in the ancestors of the policy block. A compromised moderator therefore leaves a permanent effect (H2) that nobody can unwind.
- **Defence:** an `unban` (D-10) and a "revoke moderator and void their actions since T" policy field. Cost: a new control op, and more complexity in replay; both need the freeze window.

### H7. Irreversible value deletion before a revocation arrives (needs measurement; major)

- **Steps:** a moderator is removed by a policy block P. The ex-moderator signs tombstones concurrent to P and sends them first to peers that have not yet seen P. `admit` checks the current heads (state.js:740-770), which still name the moderator, so those peers accept and drop the value (`dropValue`, ARCHITECTURE 516). When P arrives, `controlFor` makes the tombstones invalid, but the dropped bytes are gone locally.
- **Harm:** content survives only on peers that had not yet applied the tombstone. For sites with few peers this is data loss.
- **To measure:** whether `node.js` deletes values at admission or at reduce time, and whether the dropped value can be re-fetched by WANT.
- **Defence:** keep the value for a grace period (for example 24 hours) before physical deletion; honest peers hide it immediately. Cost: copies persist a day longer in storage, which matters for illegal content (H9), so it should not apply to a P0 takedown.

### H8. The proposed D-9 and D-10 add insider levers (works against the proposal; major)

- **D-9(a), moderators write `allow` (add only).** A compromised moderator adds junk keys until the 1,000 cap (block.js limits) is reached; legitimate members cannot be added and add-only means the moderator cannot be undone except by the owner's offline `allow` change. Under `writers: 'allow'` the attacker also allow-lists their own sybils to evade per-key throttles. Defence: per-moderator `allow` additions capped and rate limited (for example 20 a day, owner-set) or option (c) `grant` with a numeric limit.
- **D-10 `unban`.** If a moderator can unban, a compromised or rogue moderator unbans keys banned by the owner or by a more careful peer moderator, restoring an abuser. Defence: `unban` valid only from the same or a higher standing than the ban it reverses; owner bans can be lifted only by the owner.
- **D-10 `rotate` and `recoverKey`.** (i) Race: a thief who holds a stolen site key signs `rotate by self` to their key; the victim signs `rotate by recover`. The proposal does not say which wins. If self-rotation can beat the recovery key, the victim is locked out. Defence: recover dominates self-rotation for a fixed window. (ii) A moderator can tombstone the victim's first write, which carries the `recoverKey` announcement, removing recovery for that key. Defence: put the announcement in a control-like op that cannot be redacted, or sign it by the site key once and pin it. (iii) Ban evasion: a banned key can `rotate` to a fresh key; if the rotation carries standing, the ban is meaningless. Defence: rotation inherits bans.
- **Cross-site "use the same identity here":** a ban now follows a stable public key; moderators on one site can publish bans that identify a person across sites that opted in. Defence: the loader card names this consequence (linkability is the user's choice, but it also gives moderators a stable key to ban).

### H9. Fake "credible report" to force a one-hour withdrawal (works today; major)

- OPERATIONS P0 priority: "block within 1 hour of a credible report" for child abuse and terrorist content. A malicious reporter sends a convincing report for a legitimate site, or for one post, to the `abuse@` contact in the pointer (`ct=`), to push the owner to `publish --withdraw`, which deletes every stored version at all loaders (ARCHITECTURE 5.8) and cannot be selective.
- **Harm:** the site is offline for every visitor until the owner restores with a higher seq. A hub operator without a denylist cannot respond more narrowly than the owner can.
- **Defence:** a narrower first action: ban and tombstone the named post (which ledger moderation can do, but the web seed bytes are not covered), then verify; use withdrawal only for the whole site. Document a verification step that never requires opening material. Cost: slower for true P0s, so keep the one-hour clock for the narrow action.

### H10. Ownerless hub ledgers cannot be moderated (works today; major)

- With an unsigned pointer (`btih:` or bare magnet) the ledger is ownerless: roots by anyone, no owner, no moderators; the only control block that is valid is a tombstone by the target's own author (state.js header lines 46-48). Anyone can post abusive or illegal text at the default proof-of-work with no one able to remove it, while the hub operator is a gateway-like party with legal exposure (OPERATIONS table, hub operator "none in 0.2.1 beyond infrastructure (no denylist)"; DEPLOY.md hubs section says do not run a public multi-publisher hub with 0.2.1).
- **Defence:** hub loaders refuse to enable `mw.db` writes on ownerless ledgers, or show it read-only. Cost: unsigned magnet sites lose write access on hubs.

### H11. Denylist and directory as the censorship and extortion point (works against the proposal (roadmap); major)

- The 1.0 plan is a signed, double-hashed denylist and a counsel-gated directory (ROADMAP lines 127 and 142). Neither exists today, so the attack is on the proposal.
- **Denylist abuse steps:** (a) the hub operator or whoever holds the denylist signing key lists a rival's or critic's infohash or scope; loaders on that hub drop it, and double hashing means the owner and public cannot see why or audit the list; (b) an attacker with the list key or an admin account adds a competitor; (c) a flood of notices for one popular site makes the operator list it to be safe; (d) because the list keys on infohash, a legitimate update (a new infohash) escapes while the old one is blocked, so the list also teaches abusers to change one byte.
- **Directory as censorship point:** whoever curates ordering or inclusion decides what is found; a hub-run directory is the first thing a regulator or a competitor asks the operator to change. Today the real directory is DNS plus the host; registrar and DNS takedown (H4 replay is the stealth form).
- **Defences if built:** the list is public in plain form (name, reason code, date, notice reference) with an appeal path and an expiry; entries signed by more than one key; client-side "denied by this hub" shows the notice and an "open anyway from host only" choice where lawful; no automatic propagation to other hubs; no directory without counsel. Cost: more work for the operator, and the operator loses silent discretion.

### H12. Pointer seq race (works today; minor)

- seq is capped one day ahead of the verifier's clock. A thief and the owner both publish at the cap; the later publisher has a larger clock and can exceed by the elapsed time, so the race goes to whoever controls the host last. Only matters with H3 and a host the thief also holds. Defence: H3 pre-commitment.

### H13. Impersonation and linkability levers (works today / against the proposal; minor)

- **Today:** `profile` names are free text, so a writer can take the name "Admin" or a moderator's display name (state.js `profile` op). The loader shows short key fingerprints but site code decides what to render. Defence: moderator and owner badges derived from ledger role only, never from the name; names shown with the fingerprint.
- **Proposal:** a site that offers "sign in with the same identity" (cross-site mode) and a hostile relying party can build the habit of the person clicking "use the same identity here" to link them. The explicit visible choice in the 2026-10-20 text is the right shape; the risk is dark-pattern pressure from the site's own UI (the card is loader-owned, but the page can call `signIn` repeatedly). Defence: the loader shows the choice once per site and remembers refusal; no auto prompt on load.

## 3. Cross-cutting findings

### 3.1 Every defence that centralises trust creates a hub-like target

H1's fix moves trust to one identity origin. H11's fix creates a denylist key. H3's fix adds an offline recovery key. These are real trade-offs, not free. The design should state, for each, who can abuse it and what honest users lose if it is compromised, in the same paragraph.

### 3.2 What cannot be undone (state it in user copy)

| Action | Why it cannot be undone | Honest limit |
|---|---|---|
| Ban | no `unban` in v1 (OPERATIONS) | proposed D-10 |
| Tombstone | value and salt are dropped on honest copies (block.js header, ARCHITECTURE 516) | other software and offline copies keep the bytes |
| A hand-over | revokes the old key | a competing hand-over freezes owner changes (H3) |
| Moderator removal | does not undo earlier actions (H6) | owner-side workaround only |
| Withdrawal | deletes every stored copy and caches the withdrawal | restore needs a higher seq and a new pointer (H4) |
| Private chat and files | no escrow (RF 8) | by design |

### 3.3 Server-backed sign-in (2026-10-20 addition)

A relying server that verifies a login proof against ledger state trusts whichever copy of the ledger it holds. A stale copy (a withheld ban or a withheld hand-over) lets a banned or former-owner key keep a role. Defence: the server library takes a freshness bound, rejects state older than N minutes, and treats `ownerConflict` as "no roles". Cost: the server has to sync a ledger or call a snapshot.

## 4. Priority order for the owner

1. H1 (identity root on a hostile origin): decide the identity-origin model before building cross-site sign-in.
2. H2 (moderator keys in browsers plus ungated SDK moderation): fix before v0.3, it is a v0.2.1 behaviour and cheap.
3. H3 (owner key theft): pre-committed recovery key, and a test that equivocation cannot lock out the real owner.
4. H5, H6, H8: freeze-window decisions, to be made together with D-9 and D-10.
5. H4, H9, H10: operations and hub-gate rules, no format change.
6. H11: write the denylist rules before building the list.

**Not tested:** none of the attacks were executed. Tests that would confirm: H2(b) a unit test that calls the bridge `mod.ban` 20 times without a gesture; H5 a reducer test with a moderator tombstone aimed at an owner `put`; H6 a reducer test with a ban by a moderator later removed by policy; H7 a node test with a late policy block.
