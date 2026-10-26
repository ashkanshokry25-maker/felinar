# Red team: poisoned pointers, DNS and hosts

Scope: hostile DNS answers and DoH resolvers, a compromised static host, pointer rollback and rotation abuse, withdrawal abuse, hub subdomain tricks, kill-switch abuse, cache poisoning through the worker, and what a visitor sees and can verify. Read against IDENTITY-AUTH-DESIGN.md (v0.3 identity, plus the 2026-10-20 cross-site sign-in addendum) and the v0.2.1 code. Status tags: works today, works against the proposal, blocked by, needs measurement. Nothing was run in a browser; every claim below is from reading the cited lines.

Attacker model: has the public code and designs. Can run a DoH resolver or sit on a network path (TLS intact, so withhold, delay, replay, or fail over only), can compromise a site's DNS zone or registrar, can compromise a site's static host or deploy credentials, can publish their own site and links, and can steal an old owner key.

## What the design already stops (do not re-report)

- Forging a pointer through DNS or DoH: the record is signed (pointer.js verifyPointer), so a resolver can withhold or replay, not forge. Blocked by the signature plus pin.
- Bare-magnet label squatting on a hub: hubLabelFor separates kinds `ledger` and `btih` (pointer.js hubLabelFor, ARCHITECTURE 3.2). Blocked by the disjoint label sets.
- Unsigned or unpinned withdrawal on a hub: refused as `unsigned-withdrawal` (app.js:149-152). A pinned scope refuses unsigned records (app.js:146).
- Cross-scope reuse of a new-format rotation: rot v2 is bound to scope and chain (pointer.js rotationInput).
- A giant seq used as a permanent floor: `seq-future` at a day ahead, and a cached seq that far ahead is ignored (ARCHITECTURE 4).
- Ledger takeover through expectedOwner: expectedOwner only breaks ties among equivocating hand-overs (state.js 10-17, 258-260). An attacker key named in a pointer cannot become ledger owner.

## Attacks that work

### A1. Ledger-id squatting through lo= and chain= (blocker; works today, and worsens in v0.3)

Preconditions: the victim's genesis owner key and `chain=` label are public (they are in the victim's pointer). The attacker has any key A.

Steps:
1. Attacker builds a record `owner=A; lo=<victim genesis owner>; chain=<victim chain>; btih=<attacker site>`, signs it with A. verifyPointer only checks that `lo` is a well-formed key (pointer.js:489 region); nothing proves A descends from `lo`.
2. ledgerIdFor hashes `lo|chain` (pointer.js ledgerIdFor), so the record yields the victim's ledger id exactly. On a hub, hubLabelFor therefore yields the victim's subdomain label, and the label check at app.js:922-927 passes.
3. Attacker sends the link `https://<victim label>.hub/#<record>`. A visitor with no pin for that scope (new device, new profile, private window) pins A as the publisher (TOFU, app.js:352-357). A visitor with a pin for the victim sees "publisher key changed" and can confirm it.
4. The loader opens the victim's real ledger (app.js:2118-2123) with `expectedOwner=A`. The only reaction to the mismatch is a warning banner (`ownerMismatch`, app.js:2144, node.js:373-376). The attacker's site mounts at the victim's origin, over the victim's real ledger data.

Gain and harm: attacker code runs on the victim's real origin and ledger id with the victim's real posts around it. In v0.3 the site key is derived per ledger id ("Per ledger id, not per origin", IDENTITY-AUTH-DESIGN line 44), so the visitor's loader offers the victim-site identity to attacker code, and the sign-in card names the victim's origin. A mirror on any other domain with the same `chain=` and `lo=` also receives the same public identity key, which links the visitor to their account on the victim's site (a cross-site linkability break; it contradicts "sites cannot link a person across sites"). Scales to every site whose pointer is public, with one link per target.

Status: works today for the site mount; works against the proposal for identity.

Cheapest defence: make lineage a precondition, not a banner. Before the loader derives or offers any key for a ledger id, require (a) `owner == lo`, or (b) a rot= chain from `lo` to `owner` that verifies, or (c) the opened ledger's own succession already names `owner` as current owner (`ownerMismatch` false and `gen=` matching). If not, mount read-only with identity disabled and a blocking card, not a banner. Also mix the origin into the default derivation, and make "use the same identity here" an explicit per-mirror choice that shows the mirror's origin and the original origin. Cost to honest users: a mirror owner publishes a lineage rot= once; honest single-owner sites see nothing.

### A2. Uncapped DNS TTL: freeze, takedown delay and a request loop (major; works today)

doh.js defines MAX_TTL_SECONDS = 86400 and `ttlUntil` clamps to it, but the loader does not call it. app.js:234 computes `Math.max(minTtlMs, ttl*1000)` with no ceiling, and app.js:2374 feeds `ttlUntil - now` into setTimeout (app.js:2362).

Steps and effects:
1. A hostile resolver (or an honest zone owner who set a week-long TTL) returns the real, old, validly signed record with TTL 2,000,000 s or more.
2. The answer is cached as `dns:<host>` and reused while `ttlUntil > now` (app.js:225). Updates and withdrawals via DNS are not looked at for that long; the update timer sleeps for the same time. The spec promises "min 5 min" and the code comment promises 1 day.
3. A TTL above 2^31-1 ms (about 24.8 days) overflows the browser timer limit; browsers fire such timers almost at once, which makes the update check re-run `fresh` lookups back to back (needs measurement in Chrome, Firefox, Safari). Result: a battery and DoH load loop, and a lookup flood aimed at the three public resolvers from every visitor.

Gain: delay a legal takedown or a security fix, or burn a victim's battery. Status: works today; the loop part needs measurement.

Cheapest defence: clamp in app.js with `ttlUntil(ttl, now)` from doh.js (5 min to 1 day) and cap setTimeout at 2^31-1 ms; honour `focus` re-checks with `fresh` at most every 5 minutes. Cost: none for honest users beyond one lookup per day.

### A3. First-use trust in DNS: zone or registrar compromise pins the attacker key (major; works today)

For a DNS-only site or a `#host:` hub link there is no page tag; the DNS record is the only anchor (ARCHITECTURE 4, source 3). An attacker who controls the zone (registrar account, DNS-provider takeover, dangling subdomain) publishes their own signed record. Every first-time visitor, and every visitor on a new device, pins the attacker key and is told "First time on this device" (strings.js:151), which looks normal. DNSSEC is "shown, never decisive" (SECURITY-MODEL 115). The AD flag shown in the badge is read from the resolver's JSON (doh.js interpret: `json.AD`), so a hostile resolver can claim AD=true and the badge suggests validation that never happened (minor, works today).

Cheapest defence: let the share link carry the owner fingerprint, `#host:example.com@<fp>` or a QR with it, and refuse a first pin that does not match when given; show the fingerprint and "no earlier record seen" on first use; label AD as "resolver says validated". Cost: the link is a little longer; owners who skip it keep today's behaviour.

### A4. Rollback and resurrection on a cold device (major; works today)

The seq floor and the pin are local (app.js:158, 277). On a device with no cache (new browser, private window, after "forget", storage eviction, iPhone ITP purge) the floor is absent. Any validly signed record that has not expired (up to 399 days old) is accepted: a DoH resolver, a stale CDN copy, or a hostile host's page tag replays an old vulnerable version, or a pre-withdrawal record. In v0.3 this also downgrades to a version with a broken challenge check or key handling. A withdrawal published with a short `exp` (the tool defaults long, but `--exp` is free) lapses in DNS (fresh sources must not be expired), after which an older record can resurrect the withdrawn content for new visitors. SECURITY-MODEL line 48 says replay "is bounded by seq and expiry"; for cold devices that bound is the expiry only.

Cheapest defence, two layers: (1) the owner signs a `minSeq` into the ledger policy (peers gossip it, the loader checks it after sync and refuses or warns when the mounted version is below it); (2) publish tools refuse `--exp` shorter than the previous record's `exp` for withdrawals, and refuse to leave a withdrawal expiring before the latest non-withdrawn record. Optional: query two resolvers and take the higher valid seq (cost: the hostname reaches two third parties, against the stated goal in doh.js header). Cost: step (1) needs a ledger sync before the strongest guarantee; ship it as a post-render warning so first paint is not delayed.

### A5. Rotation without revocation (major; works today)

A stolen or leaked old owner key K1 can sign `rot=` to any new key K3 at any time. A device pinned to K1 (anyone who has not visited since the honest rotation to K2) accepts K3 silently (verifyPointer, `rotated: true`, app.js:353-356), and the honest K1 to K2 rotation has no priority over the attacker's K1 to K3. Delivery needs a channel (zone, host, or a hub link), but the key theft is permanent and silent for stale devices. There is no key-compromise recovery for the pointer owner key. The deprecated rot v1 (no scope or chain) is still accepted (pointer.js verifyRotation, last return) until ptr-010 is retired; no v1 signature exists in the wild before first release, so this is only a cleanup item.

Cheapest defence: delete the v1 path before release (free). Add pre-rotation commitment: each record carries `nx=<sha256 of the next owner key>`; a rotation is valid only if the new key hashes to the previous record's `nx`. A stolen K1 cannot then rotate to K3 unless it also held the commitment for K2, which is stored offline. Cost: one 43-character field and a one-time offline step at rotation.

### A6. Withdrawal abuse (minor to major)

- Withhold (works today): a resolver returning NXDOMAIN or an empty answer is accepted as "usable" with no failover (doh.js resolveTxt, Status 3 returns), so one resolver can hide a withdrawal or update from everyone who reaches it first (Cloudflare). A network that blocks all three DoH hosts leaves the DNS channel dead and the loader silent. Defence: on Status 3 or empty for a host that already had a record, try the next resolver; show "last verified fresh <date>" and warn after 7 days. Cost: one extra lookup in the rare case; one line of UI.
- Hostile text in loader chrome (works today, minor): a key holder (or the owner) shows `why=` up to 200 characters and a `ct=` button in the loader's own card (withdrawal.js withdrawalNotice). The filter strips bidi controls but not zero-width characters. Defence: show the text in a quote frame labelled "written by the publisher", and show the `ct` host name on the button.
- `purgeWithdrawn({ all: true })` (engine.js:472; app.js:1471 for every mode except hub-shared) deletes every site stored on the origin. Safe while an origin holds one site; on a drop-in origin that serves several scoped sites it takes the others with it (needs measurement of whether any supported deployment stores several).
- A withdrawal with `seq` up to now plus one day is unrecoverable for the thief only if the owner key is also theirs; with a stolen key the owner needs a higher seq signed by a key they no longer control alone. Ties to A5.

### A7. Compromised static host or DNS hijack: the loader card is not trustworthy, and the root identity is on that origin (blocker against the proposal)

Everything the loader shows (pointer badge, sign-in card, recovery phrase prompt) is served by the same host as the site. SECURITY-MODEL line 46 states the host is the trust root; for v0.2 that bounded the harm to one site. In v0.3 it does not:

1. The root identity store is `mw-id` in the origin's IndexedDB (IDENTITY-AUTH-DESIGN line 62), and the design itself admits same-origin code can read unlocked data and trigger the passkey prompt (lines 74, 194, 199). The identity origin that would fix this is "design note only; build after the gate" (line 199, P3 line 352).
2. With the cross-site addendum, one root identity covers every site. A host (or zone) compromise on any one site ships a perfect copy of the loader card asking for the recovery phrase, or the drop-in widget (closed shadow root, built by the host's own script) does the same. One phrase phished on one compromised site yields the person on every site.
3. The kill switch (kill-switch.js) is available to whoever controls deploy: it removes the worker and clears `mw-*` caches but leaves IndexedDB, then the host serves a plain page that reads the same origin's IDB. The same deploy path installs any worker update (the install check is SHA-384 of files the host also serves, SECURITY-MODEL 76). A hostile worker update is persistent until the visitor clears site data.
4. Dangling-DNS or zone takeover of a drop-in site gives the same position with a valid certificate; a challenge relayed live to the real server is the same exposure as any login to that domain, but the phrase prompt is the new loss.

Status: works against the proposal.

Cheapest defence: build the identity origin before cross-site sign-in ships, not after. A fixed loader-owned origin (for example id.<project domain>, with a documented self-hosted option and mirrored copies pinned by SRI) holds the root, shows the card, and answers `postMessage` calls with per-site signatures only; the site's origin never holds the root and never sees a prompt it can imitate. Passkeys get a single RP ID there, which also gives the "one tap, passkey sync across devices" experience. The card shows the requesting origin as reported by the browser's `event.origin`, never as text from the page. A site that cannot reach the identity origin falls back to session-only, per-site keys with no recovery phrase prompt on the site's origin at all. Rule on the site's origin: the phrase is never typed there (a card on the site origin can only create a per-site key, never ask for the phrase). Cost: one more origin to operate, a popup or top-level redirect where iframes lose storage (Safari and others partition third-party storage), and the identity origin becomes a trust root of its own (disclose it; keep it static and mirrored).

### A8. Hub subdomain tricks (major if the operator skips the Public Suffix List)

- Opaque labels (works today): the sign-in `domain` for a hub site is a 32-character label; nobody can judge it. An attacker's hub site named "Chase Bank" in `dn=` is a ready phishing page under a hub the person trusts. Defence: the card never shows `dn=` without "name chosen by the publisher" and shows the label plus "first seen on this device"; recovery phrases and passwords are never requested by site cards (see A7).
- No PSL, no isolation (works against the proposal): ARCHITECTURE 3.2 only says hub operators "should list the hub suffix on the Public Suffix List". Without it, sibling labels are same-site: any label can set cookies for `.hub.example` (cookie tossing into other labels and the hub root), and WebAuthn lets a sibling name `hub.example` as RP ID. Defence: a startup probe in the loader (try to set a cookie with `domain=<hub suffix>`; if accepted, the suffix is not a public suffix) that disables persistent identity and passkey creation on that hub and says why. Cost: one probe; hub operators have to do the PSL listing, which takes weeks.
- Blocked: label collision between ledger and magnet kinds (see the list above).

### A9. State poisoning by same-origin site code (major; works today)

In shell mode the site frame is `allow-scripts allow-same-origin` and shares the loader's IndexedDB (SECURITY-MODEL line 73 concedes this). Hostile or XSS-injected site code can rewrite the `pins`, `pointers`, `dns:` and `keyRefused:` entries directly: it can set the pin to a key the attacker holds, which makes the owner's later fix or withdrawal appear as "publisher key changed", and it can store `keyRefused:<scope>:<owner>` so that the real new key is auto-refused (app.js `refusedKey`) without ever asking. That keeps a bad version alive past a takedown or fix on the poisoned devices. Defence: move loader state (pins, pointers, identity) out of the site's origin, which is the same identity-and-state origin as A7; short of that, sign each stored pointer and pin with a per-device non-extractable key so the loader can detect edits it did not make (cost: a key per device; same-origin code can still delete state but not forge it). Mark the bridging of `keyRefused` as expiring after 7 days at minimum, so a refusal is not permanent.

### A10. Resolver override and failover (minor)

`<meta name="mw-doh">` is host-controlled (doh.js dohOverrideFromMeta), so a compromised host can route the lookup to its own resolver: no forgery (signed), but it receives the visitor's IP and host name, and can replay (A4) and freeze (A2). The consent card names the override host (ARCHITECTURE 4), so this is disclosed; keep the override from applying to the first lookup of a device that has no pin. Blocked for forgery; open for replay and privacy only.

## Summary table

| # | Attack | Status | Severity |
|---|---|---|---|
| A1 | Ledger-id squatting via lo=, chain= | works today; works against the proposal | blocker |
| A7 | Compromised host or zone, root on site origin, phrase phishing | works against the proposal | blocker |
| A2 | Uncapped TTL, freeze and loop | works today (loop needs measurement) | major |
| A3 | First-use DNS trust, spoofable AD badge | works today | major |
| A4 | Cold-device rollback and withdrawal resurrection | works today | major |
| A5 | Rotation without revocation | works today | major |
| A8 | Hub PSL and phishing by label | works against the proposal | major |
| A9 | State poisoning by same-origin code | works today | major |
| A6 | Withdrawal withhold, text, purge scope | works today; purge needs measurement | minor |
| A10 | mw-doh override | works today (privacy, replay only) | minor |

## Residual exposure after the cheap defences

Even with every fix above: the first pin on a device is still trust on first use unless the link carries the fingerprint; a resolver or network can always withhold, so fresh-or-stale is detectable only through the "last verified" timestamp; a host that serves the loader code can lie to a person who has no identity origin or who never checks the address bar; and a stolen owner key plus control of a delivery channel is a full compromise of that site's pointer until pre-rotation commitments exist and are used.

## Wording check

No uses of the banned terms; numbers cited (399 and 400 days, 5 minute and 1 day TTL bounds, 200 characters, 2^31-1 ms) come from the cited code and spec lines, except the 24.8 day figure, which is arithmetic on 2^31-1 ms.
