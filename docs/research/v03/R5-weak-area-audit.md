# R5: weak-area audit for v0.3

- **Date:** 2026-10-20. **Subject:** magnet-web 0.2.1 (`src/loader/config.js` line 14, `version: '0.2.1'`).
- **Role:** a demanding engineer who wants this to win. Every weak area below names its evidence (a file and line
  in the code, or a document and section) and says how much it hurts adoption, what fixes it, the effort (S under a
  week, M one to four weeks, L more) and whether v0.3 must include it.
- **Method:** read the code (`src/loader`, `src/sw`, `src/chain`, `src/dropin`, `src/sdk`, `tools/`,
  `test/e2e/run.mjs`) and the documents named in the brief (CRITIQUE, ROADMAP, COMPATIBILITY, DEMO-RESULTS,
  QUICKSTART, ARCHITECTURE sections 6, 8 and 9, the deviations notes, the identity research and its VERIFY report).
  Four external facts were checked on the web this session (sources at the end, accessed 2026-10-20). Nothing was
  run against a non-local address.
- **Scope:** builds on CRITIQUE.md rather than repeating it: each weakness becomes a ranked work item, the v0.3
  goals (self-owned identity, chat, files, private sharing) add new ones, and two doc-code mismatches are noted.

## Summary

1. **The release gate has never run.** All 22 rows of [DEMO-RESULTS.md](../../DEMO-RESULTS.md) say "not yet run";
   every test so far is one machine over loopback (`test/e2e/run.mjs` line 43: exit 0 only when "no request left
   127.0.0.1"). Every browser claim beyond Playwright Chromium and WebKit is design, not evidence. This is the single
   largest adoption risk, and it is cheap to start (one iPhone, one Android, Firefox).
2. **Durability without a visitor online rests entirely on the owner's host.** Files survive only through `ws=`;
   the ledger survives only through a `cs=` snapshot the owner refreshes by hand or a headless Chromium kept open
   (`tools/pin.mjs` lines 2 to 5). There is no heartbeat, no one-command pin recipe and no automatic snapshot upload.
3. **Phones are passengers, not peers.** Every mobile class uploads nothing until the visitor opts in
   (`src/loader/config.js` lines 59 to 61, `uploadLimit: 0`), iOS stops networking within seconds of backgrounding,
   and shell sites download whole into memory. For chat and files this means a phone cannot be relied on to hold or
   relay anything.
4. **Discovery depends on four volunteer WebSocket trackers and two STUN operators** (`config.js` lines 19 and 22),
   with no TURN (`config.js` line 116, `turn: []`). Plan for 10 to 30 percent of pairs failing to connect
   (CRITIQUE, "Swarm sizes"). Chat between two specific people makes this worse than file delivery, because there is
   no "other peer" to fall back to.
5. **The site ledger is a small public log, not a database.** 8 MiB default, 2 KiB per value, 4 KiB per block
   (`src/chain/block.js` lines 33, 46, 47), full replication, no index, no query, no cursor (`src/sdk/sdk.js` lines
   509 to 515), no unban (`block.js` line 60 lists the only control ops), and no encrypted record type. The v0.3
   goal "each visitor can decrypt their own auth and profile record" has no format today.
6. **The identity is extractable and readable by any script on the site's origin.** Both runtimes create the key
   with `extractable: true` (`src/loader/app.js` line 546, `src/dropin/identity.js` line 143) so Settings can export
   it. Since site code runs with loader privilege in per-domain and drop-in modes (ARCHITECTURE section 9), any
   site script, third-party tag or XSS can read IndexedDB and export the private key, not merely use it. There is
   one key per site ledger per browser profile, no recovery phrase, no device linking, and nothing that can do
   key agreement (P-256 ECDSA only), which end-to-end encrypted chat needs.
7. **Onboarding is about 10 to 14 commands and four new concepts** (owner key, signed pointer with a 90-day expiry,
   web seed with `Range` and CORS, deploy order) before the first visitor, plus a clone of the repository: the npm
   name `magnet-web` is not reserved ([deviations/fresh-eyes.md](../../deviations/fresh-eyes.md), "Not fixed" item 5).
   Cloudflare Pages cannot be the web seed (QUICKSTART A4).
8. **Shell mode is invisible to search and link previews; drop-in keeps search but only accelerates.** Neither mode
   has streaming media, partial copies or files above 128 MiB (COMPATIBILITY, known limitation 6). The media
   research (w2a-10) is an unfinished interim draft.
9. **Accessibility, internationalisation and observability are thin.** One `aria-live` status region and focus
   handling exist (`src/loader/ui.js` lines 90, 132 to 142), but no audit, English only (`src/loader/index.html`
   line 2, `lang="en"`, every string in `src/loader/strings.js`), and no way for an owner to learn that visitors
   fail other than an external probe they build themselves.
10. **Ten upgrades matter most** for "easy to use" and "full stack"; they are listed in the last section.

## Findings

Severity is for adoption: **Blocker** (people try it and leave, or it cannot be honestly offered), **High** (a
serious use case fails), **Medium** (a visible gap with a workaround), **Low** (polish).

### F1. The release gate has not run (Blocker)

- **Evidence.** [DEMO-RESULTS.md](../../DEMO-RESULTS.md), warning banner and rows G1 to G22, all "not yet run".
  [COMPATIBILITY.md](../../COMPATIBILITY.md), "How to read the status column": Firefox "does not start on the test
  machine"; every real phone, Safari itself and every real host are "Not yet tested". `test/e2e/run.mjs` line 43:
  the suite passes only when no request left loopback, which is correct for safety and means no real network was
  measured. CRITIQUE, "Maturity": 938 unit tests and 25 of 25 end-to-end scenarios on one machine.
- **Why it matters.** Every v0.3 addition multiplies assumed browser behaviour. Two risky ones are already open:
  iOS key storage (G22; the `DataCloneError` fallback in `src/loader/cache.js` lines 594 to 615) and 7-day storage (G16).
- **Fix.** Run G2, G4, G6, G11 and G20 first (the ROADMAP "Next" row), publish the numbers including failures, and add
  rows for the v0.3 features: login and logout across reloads on iOS, chat delivery between a phone on LTE and a
  laptop, a file shared from a phone, an encrypted record read back after an identity restore.
- **Effort:** M (devices and a domain exist; the procedures are written). **v0.3 must include it:** yes, a first pass.

### F2. Durability when no visitor is online (High)

- **Evidence.** CRITIQUE, "Durability without a pin node". `tools/pin.mjs` lines 2 to 5: the pin node is "the real
  loader open in Playwright Chromium". QUICKSTART, "Keep it running": the snapshot behind `--cs` is refreshed "from
  time to time" by the owner; ROADMAP 1.0 row "An availability plan owners can follow" (one-command recipe and a
  signed pinner heartbeat not built). Safari may delete a visitor's ledger copy and identity after 7 days of Safari
  use without interaction (w2c-03-VERIFY, claim 2).
- **Why it matters.** On a small site, shared data means a browser that never closes (CRITIQUE). For chat, a message
  to an offline recipient has nowhere to wait unless an always-on node holds it.
- **Fix.** (a) `pin.mjs --upload <target>` that writes the snapshot to the `cs=` host on a timer (S3, R2, a git push),
  plus a signed `_health` heartbeat by the pin key (w2b-04 finding 6). (b) A `deploy/pin` one-liner that runs it in a
  container with restart. (c) For chat, say plainly: offline delivery needs a store-and-forward node the users opt
  into (their own pin node or the site's), holding ciphertext only, with a retention limit; the default is live-only.
- **Effort:** M. **v0.3 must include it:** (a) and (c) yes; (b) yes if it is a compose file next to the tracker.

### F3. Mobile seeding and battery (High)

- **Evidence.** `src/loader/config.js` lines 59 to 61 (`uploadLimit: 0` for every mobile class) and line 62
  (`mobileOptInUploadLimit: 131072`). w1-08 summary 2 (iOS suspends networking after backgrounding; WebKit's 20 s
  prepare-to-suspend window) and 4 (iOS exposes no network, battery or memory API). CRITIQUE, "Mobile seeding": 63 to
  88 percent of Wikimedia views are mobile; uploading 15 MiB on mobile data costs a visitor about 30 times what the
  host saves. Phone site caps 48 and 24 MiB (`config.js` lines 27 and 28). G20 (posting fee on a phone) not run.
- **Why it matters.** Swarm help comes from desktops with long-open tabs. A file uploaded from a phone has one seed,
  which stops when the screen locks.
- **Fix.** Keep the defaults (they are right). Add: (a) phone uploads of shared files go to the web seed or a pin
  node by default when the owner configures one, with peers as a bonus; (b) a visible "this file is only available
  while you keep this page open" notice on phone uploads; (c) measure the fee time on phones (G20) and lower the
  default bits for signed-in members whose identity the owner allowed.
- **Effort:** S for (b), M for (a), S for (c) once G20 runs. **v0.3:** (b) and (c) yes; (a) yes if files ship.

### F4. Tracker and STUN dependence, no relay (High)

- **Evidence.** `config.js` line 19 (four public trackers, used only for unsigned pointers and bare magnets), line 22
  (Cloudflare and Twilio STUN), line 116 (`turn: []`). CRITIQUE, "Tracker dependence": HaGeZi Anti-Piracy blocks all
  four public trackers; one never pairs two seeders; ten earlier hostnames died. The reconnect shim patches WebTorrent
  internals (`config.js` line 108). ROADMAP "Not planned": TURN is a v1 non-goal and starts with a measurement.
- **What is new for v0.3.** Chat needs two named identities to connect, not any two peers in a swarm. A pair that
  cannot connect directly has no fallback at all, so 10 to 30 percent relay need (CRITIQUE) becomes 10 to 30 percent
  of conversations that fail silently. A TURN relay costs money: Cloudflare's TURN service is $0.05 per GB of
  outbound data when not used with its SFU (Cloudflare Realtime TURN docs, last updated 2026-09-25).
- **Privacy side.** A tracker sees every visitor's IP address and the infohash; the STUN operator sees IP addresses;
  a TURN operator would see both parties' IP addresses and traffic volume (never content when the payload is
  end-to-end encrypted). These are exposures the design can reduce (own tracker, own relay, relay-only mode for
  users who prefer the operator to strangers) but cannot remove.
- **Fix.** (a) Ship `deploy/tracker` and an optional TURN service (coturn with short-lived credentials signed by a
  static secret) in one compose file, with a `--turn` publish flag and a per-site toggle; (b) a "relay only" visitor
  setting that hides the visitor's IP from other visitors at the cost of revealing it to the relay operator;
  (c) count connect failures per session so the stranded share is measured before anyone claims a number.
- **Effort:** M. **v0.3:** (a) and (c) yes if chat ships; (b) yes for the privacy goal.

### F5. Swarm sizes for small sites (Medium, but it shapes the pitch)

- **Evidence.** CRITIQUE, "Swarm sizes for small sites" and [IMPROVEMENTS-DIGEST](../IMPROVEMENTS-DIGEST.md) 9.1 to
  9.4 (model outputs): at 1,000 visits a day and a 60 s mean visit, 0.69 visitors online at once; 0.06 eligible
  seeders; a 5 MiB site gets 0 percent of first-load bytes from peers. ROADMAP "Next": the swarm calculator
  (`tools/swarm-calc.mjs`) does not exist (`ls tools/` has no such file).
- **Why it matters.** Owners expecting cheaper hosting will be disappointed. For chat the number that matters is how
  often two members are online together.
- **Fix.** Build `swarm-calc`, print its estimate from `publish`, add "two members online together"; lead the pitch
  with what needs no peers (CRITIQUE, "What would make it succeed").
- **Effort:** S. **v0.3:** yes.

### F6. The ledger's limits as a database (High for "full stack")

- **Evidence.**
  - Caps: `src/chain/block.js` lines 33 (`maxBlockBytes: 4096`), 38 (`maxChainBytesCeiling: 67108864`), 46
    (`maxValueBytes: 2048`), 47 (`maxChainBytes: 8388608`). A 200-character comment is 798 to 1,267 bytes as a block
    (CRITIQUE, "The ledger as a database").
  - Write fee: `DEFAULT_POLICY.bits: 16` (`block.js` line 45); one GPU mints about 300,000 entries a second at 16 bits
    (CRITIQUE, "Proof-of-work is a fee"); phone cost unmeasured (G20). Bridge limit 20 writes a minute per page
    (`config.js` line 97).
  - No indexes, no queries, no cursor: the SDK offers `get`, `set`, `del`, `list(name, { limit, newestFirst })`,
    `append`, `subscribe`, `tombstone` (ARCHITECTURE section 9; `src/sdk/sdk.js` lines 495 to 515). State is one
    in-memory reducer over the whole log (ARCHITECTURE 6.5).
  - No unban: control ops are `policy`, `owner`, `tombstone`, `ban`, `allow` (`block.js` line 60);
    [deviations/onboarding-crud.md](../../deviations/onboarding-crud.md), "Open items". `mw.db.get` returns only the
    value, not its author or `h` (same).
  - No encrypted records: payload ops are `put`, `append`, `profile` with a public value (`block.js` line 59); keys
    (`k`) and list names (`l`) sit in the signed header of every copy and survive a tombstone (ROADMAP "Next", freeze
    group).
  - Full replication: every visitor downloads the whole ledger (CRITIQUE); a full 8 MiB ledger is a 3.1 to 3.9 MiB
    gzip snapshot.
- **Why it matters.** A developer who reads "backend-free create, read, update, delete" will try a user table, a
  query and a private field in the first hour, and none exist. For v0.3 identity: an "auth and profile record each
  visitor can decrypt and nobody else can" needs an encrypted payload, a key the visitor holds that can decrypt, and
  a key name that does not leak the visitor's identity (a `k` like `profile:<pub>` is public forever).
- **Fix.**
  - (a) An encrypted value envelope inside the existing `put` value (no new op, so no format version): `v = { enc:
    'mw-enc-v1', epk, iv, ct }` with ECDH P-256 (or X25519 where available) plus HKDF plus AES-GCM, addressed to the
    visitor's own encryption key; keys written under an opaque name (`k = HMAC(user secret, "profile")`) so the
    header reveals nothing guessable. Size grows by about 100 bytes per value; the 2 KiB cap still binds.
  - (b) `mw.db.list` cursor and order (ROADMAP P1-37, effort S); `mw.db.entry(key)` returning `{ value, author, h, ts }`.
  - (c) A client-side query helper over the reducer state (`where`, `orderBy`, prefix scans on `k`) with documented
    cost (it is a scan in memory), not an index.
  - (d) An `unban` as `allow`-style removal from the ban set: a new control op is a format change, so do it in the
    freeze window now (ROADMAP "Next" already says the freeze group is cheap only before public ledgers exist).
  - (e) Restrict `k` and `l` characters and state erasure semantics (ROADMAP "Next", ID P0-2, P0-4).
- **Effort:** (a) M, (b) S, (c) S, (d) S plus vectors, (e) S. **v0.3:** all five; (a) is the core of the identity goal.

### F7. Identity: extractable, no recovery, one key per site per browser, no cross-device, no encryption key (Blocker for the v0.3 identity goal)

- **Evidence.**
  - Extractable at rest: `src/loader/app.js` lines 545 to 548 and `src/dropin/identity.js` lines 142 to 144 call
    `generateKeyPair({ extractable: true })` and store the pair "so Settings can export it". ROADMAP F36 confirms:
    "Identity export needs an extractable key today."
  - Same-origin exposure: in per-domain and drop-in modes "site code runs with loader privilege" (ARCHITECTURE
    section 9, A4). The SDK removed `identity.export`, but site code can open the same IndexedDB directly. With an
    extractable key it can export the private key, which is worse than the use-without-export that w2c-03-VERIFY
    claim 1 confirmed for non-extractable keys (and that report also showed a `CryptoKey` can be cloned to another
    origin). On a drop-in site every third-party script the owner already embeds (analytics, chat widgets, ad tags)
    runs on that origin.
  - Scope: keyed `identity:<ledgerId>` (`app.js` line 542), so one identity per site ledger per browser profile; a
    second browser or device is a different person unless the visitor exports a file and imports it.
  - Creation: the identity is created when the ledger opens on a visit (`app.js` lines 2108 to 2111, `openLedger`
    calls `loadIdentity` with `create` true), not at the first write as IMPROVEMENTS-DIGEST 10.1 recommends.
  - Recovery: export is a passphrase-wrapped file (AES-GCM under PBKDF2, 600,000 iterations, `config.js` line 98);
    no recovery phrase, no reminder, no restore prompt after a wipe. ROADMAP 1.0: "Recoverable guest identity".
  - Encryption: the only key type is ECDSA P-256 for signing (ARCHITECTURE 6.1). There is no key-agreement key, so
    nothing today can encrypt a record or a message to a visitor.
  - Doc drift: [deviations/dropin.md](../../deviations/dropin.md), "Known limits", says the drop-in panel has no
    identity screens; `src/dropin/panel.js` lines 341 to 354 now render Export and Import (v0.2.1 A4). The deviation
    note is stale.
- **Why it matters.** "Visitors own their identity" is false in the practical sense while the site's own scripts
  can copy the key, and "each visitor can decrypt their own record and nobody else can" is false while the site's
  scripts can read the decryption key from the same origin. This is the hardest honest constraint in v0.3: a page
  cannot protect a secret from the code the page itself runs.
- **Fix.**
  1. Non-extractable keys at rest, created lazily at the first write or the first sign-in, derived from a 128-bit
     seed through HKDF (w2c-03 summary 3, verified to work in Chromium and WebKit): one signing key and one
     encryption key per site, both derived per ledger so sites cannot link a visitor by key.
  2. A recovery phrase (12 words, BIP-39 word list) shown once with a "write it down" step, plus the existing
     encrypted file as a second option, and a restore flow (IMPROVEMENTS-DIGEST 10.1).
  3. Device linking without a server: the new device shows a QR code with an ephemeral public key; the old device
     encrypts the seed to it over a peer connection or a copy-paste code. No relay sees the seed.
  4. State plainly that a malicious or compromised site script can act as the visitor on that site while the page
     is open, because the site frame and the loader share one origin. The fix that works is origin separation (a
     dedicated identity origin such as `id.<site>`, framed by the loader, talking over `postMessage`): design in
     v0.3, build in v1.x.
  5. Optional passkey protection of the seed through PRF later (ROADMAP "Later", identity v2), not as the base,
     because PRF support varies by provider (w2c-03 summary 5).
- **Effort:** 1 to 3 M; 4 L (design S); 5 M later. **v0.3:** 1, 2 and 3 yes; the honest statement in 4 yes; the
  identity origin as a design document only.

### F8. Sign-in without a backend (new requirement, High)

- **Evidence.** There is no login concept: `mw.ready()` returns the identity and a role (ARCHITECTURE section 9), and
  writers are `owner`, `allow` or `open` (`block.js` line 44 and section 6.1). An allow list holds at most 1,000 keys
  (`block.js` line 39) and only the owner can change it, from `tools/` (ARCHITECTURE 6.8: "Owner-only ops ... exist
  only in `tools/`"), so "sign up" today means the owner runs a command.
- **What "login" can honestly mean here.** The site has no server to check a password, so "signed in" is a local
  state: the visitor's browser holds an unlocked key, and other visitors and the site's code accept a signature as
  proof. "Logout" is locking the key (forgetting the unwrapped seed from memory and, if the visitor asks, from the
  device). Membership is either open (any key), owner-approved (an `allow` entry) or approved by a moderator key, all
  recorded in the ledger.
- **Fix.** (a) `mw.auth.signIn()`, `signOut()`, `state()`, `onChange()`; sign-in unlocks or creates the identity and
  writes an encrypted profile record (F6 a); (b) a member-request flow: the visitor appends a signed request, a
  moderator key in a browser approves it (needs the moderator-key import in the drop-in panel, ROADMAP "Next"),
  which writes an `allow` entry; (c) peer authentication for chat: a challenge signed by the identity inside the
  data channel, bound to the DTLS fingerprints of that connection so a relay cannot replay it.
- **Effort:** M. **v0.3:** yes (it is the owner's stated goal); (b) requires letting moderators write `allow`, which
  today only the owner key can sign: a policy decision and a format change, so decide it in the freeze window.

### F9. Chat, files and private sharing: residual exposures (new requirement, High)

- **Evidence.** None of it exists in the code. The relevant facts: WebRTC data channels already exist per content
  swarm (`src/chain/wire-ext.js`, the `mw_chain1` extension over BitTorrent wires); gossip relays every block to all
  peers (ARCHITECTURE 6.6), so anything written to the ledger reaches every visitor; tombstones keep `{e, h, s}` and
  the header fields.
- **Exposures that remain in any design built on these parts, to state in the documents:**
  - Peers see each other's IP addresses on a direct connection; relays see both; trackers see every announcer's IP
    and the infohash, so a per-chat or per-file swarm reveals who is in it to the tracker operator.
  - Metadata in the ledger is public: who posted a file reference, when, its size and its infohash, even when the
    file is encrypted. Use an encrypted reference (the infohash inside the ciphertext) for private shares.
  - A malicious member of a group learns everything the group sees, can screenshot or forward, and can show a third
    party the decrypted content; end-to-end encryption protects against outsiders and relays, not against members.
  - A malicious visitor can enumerate the site's audience over time through the tracker and the rendezvous swarm.
  - Timing and size correlations survive encryption.
- **Mitigations the design can give.** Per-conversation random swarm topics derived from a shared secret (so the
  tracker cannot link a topic to the site without the secret); relay-only mode; padding of message sizes to buckets;
  messages not written to the ledger by default (live data channel only); explicit "keep a copy" per conversation;
  group keys rotated on membership change.
- **Effort:** L in total (chat M to L, files M, private sharing M). **v0.3:** a design document with the exposure
  table is mandatory before code; ship one-to-one chat first if anything.

### F10. Onboarding friction (High)

- **Evidence.** [QUICKSTART.md](../../QUICKSTART.md), "The short version": Track A is four commands plus an upload
  step, but the publish command has nine flags (`--name --scope --key --ws --tr --cs --ct --shell --out`); the full
  track is Step 0 (clone, `npm ci`, `npm run build`, Node 22) plus A1 to A6, about 12 to 14 commands with the deploy
  tree assembly in A3 (five shell lines, including `.nojekyll` and `CNAME`) and a separate git repository in A4.
  Concepts an owner must learn first: the owner key, a pointer that expires (90 days by default, QUICKSTART "Keep it
  running"), the web seed's `Range` and CORS answers, deploy order, and optionally DNS TXT with 255-byte strings
  (CRITIQUE "Complexity for owners"). `npm ci` prints "4 high severity vulnerabilities" that the owner must read past
  (QUICKSTART Step 0). Only 6 of 24 hosts passed WebTorrent's stock web-seed request (CRITIQUE). Cloudflare Pages
  answers `Range` with 200 and cannot be the web seed (QUICKSTART A4). No sub-path deployments
  (COMPATIBILITY known limitation 2), so `<user>.github.io/<repo>/` fails. The npm name is unclaimed
  ([deviations/fresh-eyes.md](../../deviations/fresh-eyes.md), "Not fixed" 5), so `npx magnet-web` outside a clone
  could run someone else's package once the name is taken.
- **Why it matters.** The comparison is "drag a folder onto a host"; every step is a place to stop (CRITIQUE, prior
  art: Beaker).
- **Fix.** (a) Reserve the npm name or move to a scoped name now; (b) `magnet-web init` that asks three questions
  (domain, host, mode), writes a `magnet-web.json` with every flag, creates the key in the OS keychain or a file, and
  prints the next command; (c) `magnet-web deploy --to github-pages|r2|netlify|s3` adapters that assemble the tree,
  upload in the right order and run `check-site`; (d) a pointer re-sign reminder in CI (the workflow template exists:
  `deploy/github-actions/publish-site.yml`); (e) sub-path support (`--base`).
- **Effort:** (a) S, (b) M, (c) M per adapter, first two in v0.3, (d) S, (e) M. **v0.3:** (a), (b), (c) for GitHub
  Pages plus R2, (d).

### F11. The drop-in's limits (Medium)

- **Evidence.** ARCHITECTURE 3.4.1 and 3.4.3: no help for new visitors when the host is down, and the first view and
  every hard reload come from the host. A 20 MB copy after a 1.5 MB view costs the host 13.3 times that view (model,
  CRITIQUE). `/_mw/mw.js` is 323 KB, 105 KB gzip (ROADMAP 1.0). Follower tabs, integrated site workers and the
  unversioned 60 s blob cache ([deviations/dropin.md](../../deviations/dropin.md), "Known limits"). No moderator-key
  import in the panel (ROADMAP "Next").
- **Fix.** Split `mw.js` so the first view loads only the panel and the worker registration (ROADMAP 1.0, size
  budgets); a budgeted, peer-first copy (ROADMAP 1.0); the moderator import in the panel (ROADMAP "Next"); for v0.3
  identity, the drop-in needs the same sign-in panel as the shell.
- **Effort:** M. **v0.3:** the moderator import and the sign-in panel yes; the split is a stretch goal.

### F12. SEO and search (Medium for shell, Low for drop-in)

- **Evidence.** CRITIQUE "Shell mode hides the site from crawlers"; w2a-05 verdict items 1 to 4: crawlers run no
  service worker; the shell gives every URL `<title>magnet-web</title>`, no Open Graph tags and, on a
  GitHub-Pages-like host, an HTTP 404 on deep links. QUICKSTART A3 tells owners to put `robots.txt` next to the
  shell.
- **Fix.** `publish --shell` also writes one static HTML per site URL with the page's own title, description, Open
  Graph tags and a `<noscript>` body, each loading the loader: browsers keep shell mode, crawlers and link previews
  get real pages. Add an SEO lint (w2a-05 top actions).
- **Effort:** M. **v0.3:** recommended (it removes the most common reason to reject shell mode), not required.

### F13. Media and large files (Medium; High once files ship)

- **Evidence.** COMPATIBILITY known limitation 6: shell sites download whole before they render, within 128, 48 or
  24 MiB; streaming before completion is a v1 non-goal. CRITIQUE: about 548 MB of renderer memory for a 128 MiB site
  in one unreviewed desktop run. [w2a-10](../w2a-10-large-sites-media.md) is marked "INTERIM DRAFT ... the research
  run did not finish"; its checkpoint found that `torrent.critical()` does not reorder pieces and BEP 53 `so=` is a
  no-op in webtorrent 3.0.21 (checkpoint 1, items 1 and 6), so naive "select this file first" code will not work.
- **Why it matters for v0.3.** User files sit outside the site torrent and may exceed its cap: each upload needs its
  own torrent, cap and budget, stored in chunks, never assembled in memory on a phone.
- **Fix.** Finish w2a-10; a per-file torrent path with the blob chunk store (`src/loader/blob-chunk-store.js` exists)
  and a size cap per device class; stream selections (w2a-10 item 3: streams reorder, `select()` does not).
- **Effort:** M. **v0.3:** yes for files; streaming media stays later.

### F14. Accessibility (Medium)

- **Evidence.** Present: `role: 'status', 'aria-live': 'polite'` on the status line (`src/loader/ui.js` line 90),
  focus moved into and back out of overlays (`ui.js` lines 132 to 142), `:focus-visible` outlines and
  `prefers-reduced-motion` (`src/loader/ui.css` lines 209 and 366), 16 px inputs against iOS zoom (`ui.css` line 350).
  Missing: no audit against WCAG 2.2, no screen-reader test, no keyboard test of the consent card in the drop-in
  closed shadow root, and the research topic on the loader shell's quality bar (w2a-12, accessibility included)
  was never written (ROADMAP "Research still owed").
- **Why it matters.** If a screen-reader user cannot answer the consent card, the site does not load for them. The
  European Accessibility Act has applied to in-scope EU digital services since 28 June 2025; scope per site is a
  question for counsel (secondary sources only, see Sources).
- **Fix.** An axe-core run in the end-to-end suite on the consent card, Settings and the drop-in panel; a manual
  VoiceOver and TalkBack pass as a gate row; label every control; announce sync and posting progress politely.
- **Effort:** S for automation, S for the manual pass. **v0.3:** yes for the consent card and the new sign-in UI.

### F15. Internationalisation (Medium)

- **Evidence.** `src/loader/index.html` line 2, `<html lang="en">`; every visitor-facing string is an English
  constant in `src/loader/strings.js` (header lines 1 to 6) and the drop-in panel imports the same table
  (`src/dropin/panel.js` line 22). No locale selection, no right-to-left support (no `dir` handling in `src/`),
  dates printed as ISO (`strings.js` `isoDate`).
- **Why it matters.** The consent text is a legal notice for EU, UK and Quebec visitors (`config.js` line 121 lists
  the audiences that make the gate the default); Quebec visitors are owed French. A site in Farsi or Arabic gets an
  English, left-to-right card.
- **Fix.** Make `STRINGS` a per-locale table chosen from `navigator.languages` with an owner override in the pointer
  or a meta tag; mirror the layout under `dir="rtl"`; ship English and French first, with a contributor guide.
- **Effort:** M. **v0.3:** the mechanism and French yes.

### F16. Observability (Medium)

- **Evidence.** Visitors: shell Diagnostics and `inspect()` handles (DEMO-RESULTS); a drop-in page has no diagnostics
  list. Owners: `check-site` by hand, nothing scheduled; probes, canary and `health.html` not built (ROADMAP 1.0).
  The browser hides why a WebSocket failed (w2b-04 finding 1); GitHub cron disables itself after 60 idle days
  (finding 5). `progress.uploadSpeed` counts all wire bytes (ROADMAP "Next").
- **Fix.** (a) A downloadable local debug bundle (w2b-04 finding 3, the Element model); (b) a scheduled `check-site`
  workflow plus a dead-man's-switch ping; (c) bytes by source in the status line, as the ROADMAP's measured economics
  row asks; (d) no visitor telemetry on the ledger (w2b-04 finding 6).
- **Effort:** S each. **v0.3:** (a) and (b) yes.

### F17. Upstream and supply chain (Medium)

- **Evidence.** Five string patches on the minified WebTorrent bundle (`build.lock.json`; ROADMAP 1.0); the vendored
  3.0.21 is still npm's latest (registry, accessed 2026-10-20); releases carry an unsigned `SHA256SUMS` (ROADMAP 1.0).
- **Fix.** Own bundle (ROADMAP); signed sums and artifact attestations before v0.3 adds identity code that visitors
  must trust.
- **Effort:** M. **v0.3:** signed sums yes (S); own bundle later.

### F18. Consent and privacy friction, local network (Low today, watch)

- **Evidence.** The card on every first visit and a planning consent rate of 0.30 (CRITIQUE); the choice can be
  lost on a reload right after "Share and load" (ROADMAP "Left open"). Chrome's Local Network Access prompt launched
  in Chrome 142; WebRTC to the local network is "not yet gated", planned "soon" (Chrome blog, updated 2025-09-29), so
  two visitors on one LAN may later meet a permission prompt.
- **Fix.** Write the consent choice before the card closes (ROADMAP "Next"); add a G-row for LAN peers under Chrome
  LNA; keep peer-to-peer off until consent, as now.
- **Effort:** S. **v0.3:** the consent write yes.

### F19. Hubs and shared origins (Low unless a hub is offered)

A shared-origin hub has no isolation (COMPATIBILITY, known limitation 11), so self-owned identity must refuse to
create a persistent identity there (IMPROVEMENTS-DIGEST 10.1). **Effort:** S. **v0.3:** yes, as a guard.

## What this means for magnet-web

### Today (0.2.1, true of the code)

A static host plus one signing key gives offline revisits, integrity against other visitors and a moderated public
log every visitor verifies, with no application server. Visitors have a per-site signing key they can export as a
passphrase-wrapped file. Nothing on the ledger is private or encrypted; there is no login, chat or user files; no
result from a real phone, Firefox, Safari or a real network exists.

### What v0.3 can upgrade

Recoverable non-extractable identity with an encryption key and device linking; sign-in and membership; encrypted
per-visitor records; a fuller `mw.db`; one-command init, deploy and always-on; a crawler shell, French and an
accessibility pass; and, after a written exposure table, live encrypted chat and per-file torrents. Details and
priorities are in Recommendations.

### What the technology cannot do (state it in WHY and PRIVACY)

- Hide a visitor's IP address from the peers, trackers, STUN and relay servers it talks to. A relay moves the
  exposure from strangers to the relay operator; it does not remove it.
- Protect a visitor's key or decrypted data from scripts running on the same origin while the page is open. Only a
  separate origin for identity changes that, and the loader code itself always comes from the owner's host.
- Keep anything available when no visitor, no pin node and no host is online.
- Make a group message secret from a member of the group, or make deletion reach copies that already left.
- Recover an identity whose seed and backups are all lost: there is no one to ask.
- Make proof-of-work stop a determined spammer; it is a fee.

## Recommendations

| Pri | Item | Effort | v0.3 |
|---|---|---|---|
| P0 | Run the release gate first pass (G2, G4, G6, G11, G16, G20, G22) and publish numbers, failures included (F1) | M | yes |
| P0 | Non-extractable identity from a seed, lazy creation, recovery phrase, restore, per-site signing and encryption keys (F7) | M | yes |
| P0 | Encrypted value envelope and opaque record names for per-visitor records (F6 a) | M | yes |
| P0 | Sign-in, sign-out and membership flow, including the moderator decision on `allow` in the freeze window (F8) | M | yes |
| P0 | Chat, files and sharing design with the exposure table before any code (F9) | S | yes |
| P0 | Reserve the npm name or switch to a scoped name (F10 a) | S | yes |
| P0 | Freeze-group items: `k` and `l` character set, erasure semantics, unban op, vectors (F6 d, e) | S | yes |
| P1 | `init` plus `deploy` adapters for GitHub Pages and R2; CI re-sign reminder (F10 b to d) | M | yes |
| P1 | `pin.mjs --upload`, signed heartbeat, compose file with tracker, pin and optional TURN (F2, F4 a) | M | yes |
| P1 | `mw.db` cursor, `entry()`, query helper (F6 b, c) | S | yes |
| P1 | Device linking by QR (F7 fix 3) | M | yes |
| P1 | One-to-one encrypted chat, live-only, with relay-only mode and connect-failure counts (F9, F4 b, c) | L | if time |
| P1 | Per-file torrents for uploads with device-class caps; phone-upload notice (F13, F3 b) | M | if chat ships |
| P1 | Accessibility automation plus manual pass on consent and sign-in (F14) | S | yes |
| P1 | Locale mechanism, French, right-to-left layout (F15) | M | yes |
| P1 | Debug bundle and scheduled probe with a dead-man's-switch (F16 a, b) | S | yes |
| P1 | `swarm-calc` with a "members online together" estimate (F5) | S | yes |
| P2 | Crawler shell and SEO lint (F12) | M | recommended |
| P2 | Moderator import and sign-in in the drop-in panel; split `mw.js` (F11) | M | partly |
| P2 | Signed release sums and attestations (F17) | S | yes |
| P2 | Persist consent before the card closes; LNA gate row (F18) | S | yes |
| P2 | Refuse persistent identity on shared-origin hubs (F19) | S | yes |
| P3 | Dedicated identity origin (design in v0.3, build later) (F7 fix 4) | L | design only |
| P3 | Own WebTorrent bundle; finish w2a-10; streaming media (F13, F17) | L | no |
| P3 | Passkey PRF protection of the seed (F7 fix 5) | M | no |

## The ten upgrades that matter most for "easy to use" and "full stack"

1. **`magnet-web init` and `deploy`.** Three questions, one config file, one deploy command per host, `check-site`
   at the end. It turns 12 to 14 commands and nine flags into two commands. (F10)
2. **Sign-in that feels like sign-in.** A "Sign in to this site" button that creates or unlocks a recoverable
   identity, shows a 12-word phrase once, and a "Sign out" that locks it. (F7, F8)
3. **Private per-visitor records.** `mw.me.get()` and `mw.me.set()` backed by encrypted values under opaque names, so
   a profile, settings or a saved draft is readable only by the visitor's key. (F6 a)
4. **A real data API.** `mw.db` paging, `entry()` with author and hash, `where` and `orderBy` over the in-memory
   state, unban, documented costs. (F6)
5. **Always-on in one command.** One compose file that runs the tracker, the pin node with automatic snapshot upload
   and heartbeat, and an optional TURN relay. (F2, F4)
6. **Two devices, one person.** Link a phone to a laptop by scanning a QR code, no server in between. (F7)
7. **Chat with stated limits.** One-to-one, end-to-end encrypted, live by default, relay-only mode, and a visible list
   of who can see what. (F9)
8. **Files people can share.** Upload, fetch and encrypted share links as per-file torrents with caps per device
   class and an honest "only while open" notice on phones. (F13, F3)
9. **Visible on search and in link previews.** The crawler shell gives every URL its own title and preview while
   browsers still get shell mode. (F12)
10. **Proof it works where people are.** The first gate pass on an iPhone, an Android phone on LTE and Firefox,
    published with numbers, plus an accessibility and French pass on the first screen every visitor sees. (F1, F14, F15)

## Open questions

1. Will moderators be allowed to approve members (write `allow`)? Today only the owner key signs `allow`; changing
   that is a format decision for the freeze window.
2. Is a dedicated identity origin acceptable to owners (a second hostname and certificate), given that it is the only
   way to keep the visitor's keys from the site's own scripts?
3. Who runs the relay for chat on a small site, and who pays the $0.05 per GB (Cloudflare's price) or runs coturn?
4. Where may an offline message wait, if anywhere? A pin node holding ciphertext with a retention limit, or nothing
   (live only)?
5. Does iOS Safari keep the derived non-extractable keys across reloads and 7 days (G16, G22)? If not, the seed must
   live wrapped in storage and be unlocked at every visit.
6. How long does a 16-bit fee take on a mid-range phone (G20), and should signed-in members pay less?
7. Does Chrome gate WebRTC to local addresses behind Local Network Access in stable, and from which version? The
   official blog says "soon" as of 2025-09-29; a third-party article claims later changes that could not be verified.
8. Is a magnet-web site a service in scope of the European Accessibility Act? Counsel, not engineering.

## Sources

Project files: every file and document cited inline above, read 2026-10-20.

External (accessed 2026-10-20):

- Chrome for Developers, "Local Network Access", https://developer.chrome.com/blog/local-network-access (published
  2025-06-09, update note 2025-09-29): prompt launches in Chrome 142; WebRTC to the local network not yet gated.
- Cloudflare Realtime TURN, https://developers.cloudflare.com/realtime/turn/ (last updated 2026-09-25): $0.05 per GB
  outbound when not used with the SFU.
- npm registry, https://registry.npmjs.org/webtorrent/latest: latest version 3.0.21.
- European Accessibility Act application date 28 June 2025 and the WCAG version question: secondary vendor summaries
  only, for example https://www.acquia.com/blog/european-accessibility-act-and-en-301-549-your-complete-compliance-guide
  and https://pagecrawl.io/blog/european-accessibility-act-compliance-monitoring-wcag; check the Official Journal
  before relying on either.
