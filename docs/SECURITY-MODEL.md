# Security model

This is felinar's threat model for 0.3.0: what it protects, from whom, how, how that is
tested, and what it does not protect. The normative summary is section 13 of [ARCHITECTURE.md](ARCHITECTURE.md). The
sections before "v0.3" cover the parts that 0.3.0 kept from 0.2.1 (which was never published). The section at the
end, "v0.3", is the short model of what v0.3 adds, as built and as reviewed in the review round of the v0.3 design
review (2026-10-22 to 2026-10-24, [review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md) section 5.4); its long tables are in
[THREAT-MODEL.md](THREAT-MODEL.md). To report a problem, follow [SECURITY.md](../SECURITY.md) and never open a
public issue for anything exploitable.

The "Tested by" column below names automated tests that pass on one development machine, in Playwright Chromium
and WebKit over loopback ([INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)): E2E scenarios by their names in
`test/e2e/`, unit tests by their file names in `test/unit/`. Nothing has been checked on a real phone, in
Firefox or in Safari itself yet ([DEMO-RESULTS.md](DEMO-RESULTS.md)).

## In short

A first visit trusts your HTTPS host and your DNS. Later visits also check the remembered site key.
Peer-to-peer delivery protects the site's files from tampering by other visitors, not by your host: whoever
controls your host or your DNS controls what visitors run.

There's no private mode. Peers, trackers and STUN servers see each visitor's IP address, and anyone who knows the
site's infohash can see who's online.

Shared data lives in the site ledger: a signed, hash-linked log that every visitor copies and verifies. No
mining, no consensus, no finality. Nobody can forge or quietly rewrite an entry, but anyone online can withhold
one, and everything in it is public.

## What is being protected

| Asset | What it is |
|---|---|
| Code integrity at the site's origin | the loader, the Service Worker and the site's files, which all run with the origin's privileges |
| The owner key | signs pointers, withdrawals and the ledger's control blocks; whoever holds it speaks for the site |
| Moderator keys | delete posts, ban authors, write keys starting with `_` |
| Visitors' local data | their posting identity (a key pair), their copy of the ledger, saved sites, remembered site keys, their consent choice |
| Visitors' network identity | their IP address together with the site they view |
| Availability | of the site and of its ledger |
| Ledger integrity | entries, their order, and who may moderate |
| Reputation | of the domain that serves the loader (most of all a hub's) |
| Legal position | of owners, hub operators and visitors who share |

The asset and adversary lists follow the research threat model (`docs/research/w1-11-security-threats.md`,
section 2, digested in [RESEARCH-DIGEST](research/RESEARCH-DIGEST.md) 5.4).

## Who is trusted with what

| Actor | Trusted for | If malicious or compromised, it can | What limits it |
|---|---|---|---|
| Static host and CDN | serving the loader on every visit, including Service Worker updates | serve any code to anyone, including a worker that keeps doing so | nothing technical: it is the trust root. SRI on the two static script tags is defence in depth only |
| DNS operator and registrar | the hostname (and so TLS certificates), and the `_magnet` TXT record | point the domain at another host, which is host control; replace the TXT record | for the record: the owner signature, the remembered key, `seq` and expiry. A first visit to a site whose pointer is only in DNS trusts it |
| DNS-over-HTTPS resolver | answering the TXT lookup | see the site's name and the visitor's IP address; withhold an answer; replay an old one | it can't forge a signature; a replay is bounded by `seq` and expiry; DNSSEC is shown but never decides anything |
| Trackers | introducing visitors | see IP addresses, the infohash and WebRTC offers; refuse introductions; list who's online; tamper with offers to sit between two peers | file and entry integrity come from hashes and signatures, never from the connection; several trackers, your own among them; the web seed works without any |
| STUN servers | telling a browser its public address | see IP addresses; fail | the boot probe drops servers that don't answer; the web seed carries visitors who can't connect |
| Other visitors (peers) | nothing | send corrupt pieces or entries, oversized messages, floods; withhold entries; record IP addresses; surround a visitor with their own peers | every piece and entry is verified; the budgets below; the web seed and the snapshot as a floor |
| The site's own code | everything at its origin | in per-domain and drop-in modes it runs with the loader's privilege: it can read the posting identity from IndexedDB and write the consent record | the SDK doesn't hand out the identity or the consent decision, which stops accidents, not a hostile script |
| Visitors who post | writing what the policy allows | spam, illegal content, impersonation through names | the writer policy, the posting fee, a per-author throttle, byte caps, moderators, bans |
| The owner | the whole site | anything | there is no authority above the owner key, see [OPERATIONS.md](OPERATIONS.md) for key loss and theft |
| Moderators | deleting posts and banning authors | delete or ban wrongly; their keys sit in browsers | they can't change the policy or the owner; the owner removes them with a new policy |
| Hub operator | a shared-origin hub: everything; a subdomain hub: the gate | serve any code | per-site origins for production hubs; the shared-origin hub is for one publisher and demos only |
| The supply chain | npm packages, the vendored WebTorrent bundle, the build | ship a hostile loader | see [Supply chain](#supply-chain) |

## Protections, threat by threat

| Threat | Protection | Tested by | Limit |
|---|---|---|---|
| A peer or a web seed sends altered files | The stored `.torrent` must hash to the pointer's infohash (checked once per page). Every piece is checked against its SHA-1 from the torrent before the Service Worker first serves a file and before it is first uploaded; a mismatch deletes the copy and downloads again (ARCHITECTURE 7.3). | E2E 3 (a flipped byte in IndexedDB); unit `loader-common-verify`, `sw-core` | SHA-1: whoever adds bytes to a torrent could prepare two files with one hash (a chosen-prefix collision costs on the order of $10,000, [RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), D35). Each file's SHA-256 is recorded in `/.mw/files.json` but is not yet bound to the pointer or checked when serving (`fj=`, on the [ROADMAP](ROADMAP.md)) |
| A forged, stale or replayed pointer | ECDSA P-256 signature over a domain-separated input bound to the hostname (MW-PTR/1); `seq` and `exp` required (at most 400 days, one day of clock skew allowed); a lower `seq` is refused, one more than a day ahead is refused; the first signed key is remembered and a different key needs the visitor's confirmation ("publisher key changed", both fingerprints); a rotation (`rot=`) is signed by the old key over the scope, the ledger label, the new key and `seq`; on a first visit a DNS record signed by another key never beats the page tag | unit `common-pointer`, golden vectors `test/vectors/pointer.json`; E2E 6, 13 | a first visit trusts the host and DNS; rotations signed in the older unbound form (`rot=` v1) are still accepted until the next pointer revision (F13); a bare magnet link is unsigned and has no owner |
| A takedown that old loaders ignore | `st=` is fail-closed: anything but `ok` withdraws. A valid withdrawal stops sharing, deletes every stored version and shows the owner's reason; its infohash of 40 zeros leaves older loaders nothing to fetch. On hubs an unsigned withdrawal is ignored and a signed one that arrives by a link deletes only after a click | E2E FMT-WITHDRAW; unit `common-pointer`, vector `ptr-017` | devices that stay offline keep their copy; software that ignores the record keeps sharing |
| A forged or rewritten ledger entry | Each block's hash is recomputed, its signature and proof-of-work checked, and its value checked against a salted hash. Control blocks need owner standing, decided by the ledger's own history: a hand-over revokes the old key, and two competing hand-overs are settled only by the key in the visitor's pointer. Unknown operations are rejected and never relayed. Every copy orders entries the same way (by depth, then hash) | unit `chain-core-*`, `chain-net-*`, golden vectors `test/vectors/block.json`; E2E 2, 4 | no finality: an entry that arrives late can change what "latest" means; peers can withhold entries |
| A deleted post that can be recovered | A deletion drops the value and its salt and keeps a stub `{ e, h, s }` that reveals nothing guessable about the value (a 128-bit salt per block, ARCHITECTURE 6.1) | unit `chain-core-block`, vectors | copies on devices that never sync again stay; keys and list names sit in the signed header and are never deleted |
| Spam and storage exhaustion through the ledger | writers `owner` by default; a proof-of-work fee for everyone else (16 bits by default); a local throttle of 30 entries per author per 10 minutes; byte caps (below); at the cap only owner, moderator and allow-listed entries are taken | unit `chain-core-state`, `chain-net-scale` | the fee is a spam fee, not security: one RTX 4090 hashes about 1,650 times faster than a browser using five workers on an M3 ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), verdict 8) |
| Memory and CPU exhaustion over the wire | message lengths are read unsigned and a connection that announces more than 256 KiB is closed before anything is buffered; a watchdog closes any connection that buffers more than 512 KiB; per-swarm connection caps; gossip frames at most 15 KiB with per-peer budgets; a peer that sends more than 50 invalid blocks is ignored for the session; a web seed that fails 3 times in 30 seconds is skipped for 5 minutes | E2E PEER-11 (a `0x7FFFFFFF` length is dropped, 66 ms measured), PEER-WS; unit `loader-app-torrent` | the guard wraps a method inside the vendored library; the build asserts it exists, and at run time peer connections are refused if it is missing |
| Oversized downloads | `maxSiteBytes` per network class (128, 48 or 24 MiB); `max=` in the pointer lowers it; the `.torrent` is capped at 8 MiB; snapshots at 64 MiB (128 MiB inflated) with a 30-second timeout; bodies are read with streaming caps | unit `loader-app-torrent`, `common-inflate` | |
| A drive-by load from a link | nothing that arrives by a URL fragment, a share or a paste loads without a click; the hub gate opens no connection before the click; a site's own `#anchor` is never read as a pointer; unsigned hub links contact the hosts they name only after the click | E2E 8; unit `loader-app-arrival` | |
| IP exposure before the visitor decides | no tracker, peer connection, STUN probe or DNS-over-HTTPS lookup before a choice in the first-run card (or the gate); "Load from host only" uses only the web seed, except on a site found only through DNS, where either load button also makes the DNS-over-HTTPS lookup and the page keeps checking; the choice is a versioned record, asked again when the recipients change | E2E PEER-CONSENT, 10B | after "Share and load", peers and connection servers see the IP address |
| Site code taking the visitor's identity or consent | the SDK has no identity export or import and cannot accept consent; those live only in loader-owned UI (the shell's own document, or a closed shadow root in drop-in) and act only on trusted clicks with user activation; `window.__mwDropin` is a frozen handle; the shell's Bridge accepts messages only from its own frame at its own origin | E2E FMT-SDK, PEER-CONSENT (a script click decides nothing); unit `dropin-mw`, `sw-sdk` | same-origin code can still read IndexedDB: it has the identity key. The shell frame's sandbox (`allow-scripts allow-same-origin`) is not a security boundary |
| Framing and clickjacking | `boot.js` stops inside a frame ("Open this page directly"); the worker serves the shell with `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and site documents with `frame-ancestors 'self'` | unit `loader-app-render`, `sw-core` | a first visit gets whatever headers the host sends ([DEPLOY.md](DEPLOY.md)) |
| Script injection into the shell | `boot.js` inserts a Content-Security-Policy (`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`); loader UI text is set with `textContent` only; a site frame that navigates to another origin is blanked and offered in a new tab | unit `loader-app-render` | limited mode (no Service Worker) relaxes the policy to run the site from `blob:` URLs: `'unsafe-inline'` and any `https:` source for scripts and styles |
| A mixed deploy or a stale CDN copy | the worker installs only when every precached script and stylesheet matches the build's SHA-384 values, else the previous worker keeps control; `webtorrent.min.js` is hash-checked before it is kept or served; every navigation is answered within 25 seconds, and one whose handling fails goes to the network | E2E SW-INSTALL | this protects consistency, not against a hostile host, which also serves the hashes |
| A Service Worker that has to go | the kill switch removes it from returning visitors on their next navigation; `Clear-Site-Data` is the last resort | E2E 9 | the first page view after the deploy may still be the old one ([DEPLOY.md](DEPLOY.md#kill-switch)) |
| The drop-in web seed rewrite used as a proxy | `/_mw/ws/` answers only the engine's own fetches, for versions a page is mapped to and files their torrent lists, as `application/octet-stream` with `nosniff`, a sandbox CSP and `Cross-Origin-Resource-Policy: same-origin` | E2E 10; unit `sw-core` | |
| A library wiping the site's own storage | the vendored bundle is patched so that importing it touches no origin storage (it used to delete an OPFS `chunks` directory and replace File System Access globals) | E2E OPFS; unit `tools-build` | |
| One hub label posing as another | signed sites and bare magnets get labels from separate hash domains, so an unsigned record can't name a signed site's label | unit `common-pointer`, vector `ptr-018` | the edge must still refuse names that aren't labels ([DEPLOY.md](DEPLOY.md#hubs)) |
| The owner key leaking | for a site you publish with `keygen`, it never enters a browser (moderators get their own keys); a personal page on a hub is the exception, because the person's working key for that page is its owner key and sits in their browser ("A hub serving personal sites" below); `keygen` writes it with mode 600; `publish` refuses a key file that others can read | unit `tools-*` | a key in CI is only as safe as the workflow ([DEPLOY.md](DEPLOY.md#cicd)) |
| Publishing secrets by mistake | `publish` refuses key, token, dump and backup files, private keys or tokens inside files, and WordPress exports with commenter e-mail or IP addresses; dot files follow an explicit table | unit `tools-publish-v021` | it matches known patterns only |
| Your tracker relaying for anyone | `tools/tracker.mjs` refuses to start without an allow list unless `--open`; it validates offers and caps messages at 128 KiB | unit `tools-tracker` | no per-IP quota, no `Origin` check, no metrics ([DEPLOY.md](DEPLOY.md#your-own-tracker)) |

## What is not protected

- **Your host and your DNS.** They are the trust root on every visit, Service Worker updates included. The
  remembered key is checked by code your host serves. A page can't verify itself, and no browser offers a way to
  pin a loader in 2026 ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), D12).
- **Visitors' IP addresses.** Peers, trackers and STUN servers see them, and so does the DNS-over-HTTPS resolver
  when a shell page checks for a DNS update after the visitor shares ([PRIVACY.md](PRIVACY.md)). Anyone who knows the infohash can join the swarm and list who's online. The ledger's
  rendezvous infohash is derived from the ledger id, so anyone who knows a site can find its ledger swarm: it is a
  label, not a secret.
- **Confidentiality between peers.** A tracker can tamper with the WebRTC offers it relays and sit between two
  peers. Nothing felinar sends between peers is secret anyway: files and ledger entries are public.
- **Finality.** An entry that arrives late can change what "latest" means, and two visitors can briefly see
  different states.
- **Availability of the ledger.** Peers can withhold entries, and a visitor surrounded by hostile peers sees
  only what they pass on. With nobody online, the snapshot on your host and a pin node are the floor.
- **A shared-origin hub.** It gives no isolation: sites on it share one browser origin and can access each
  other's data. Only a hub that gives each site its own origin keeps sites apart.
- **Same-origin site code.** In per-domain and drop-in mode the site's own scripts, and any third-party script it
  includes, run with the loader's privilege and can use or copy the visitor's posting identity. In shell mode they can
  also use the device key that signs the remembered site keys and the refusals, so those signatures catch accidental
  edits, not hostile code; the seq floor and the committed next key are read from the signed saved pointer instead
  (review round PTR-11).
- **An attacker with the device.** Offline, with only the cached pointer, anyone who can write to the origin's
  storage can rewrite the pointer and the files consistently (ARCHITECTURE 7.3). Malicious browser extensions
  and compromised devices are out of scope.
- **SHA-1.** BitTorrent v1 names pieces by SHA-1. A third party without access to the torrent's bytes needs a
  second preimage, which is out of reach, but a contributor whose bytes go into a torrent could prepare a pair.
- **Takedown.** Devices that stay offline keep their copy, software that ignores withdrawals keeps sharing, and
  the same files can be published again under a new infohash.
- **Spam from a determined writer.** The posting fee slows a flood; allow lists, moderators and bans stop it.
- **A stolen owner key.** It can do everything the owner can until visitors stop trusting it, and bans or
  deletions it signs before a hand-over stand ([OPERATIONS.md](OPERATIONS.md)).
- **Clocks.** Expiry is checked against the visitor's clock, with one day of tolerance.
- **DNSSEC.** Shown when present, never required, never decisive.

## Budgets and caps

Each of these bounds what a stranger can make a visitor's browser store, download or compute. Sources:
`src/loader/config.js`, `src/chain/block.js`, `src/chain/gossip.js` and ARCHITECTURE sections 6 and 8.

| Limit | Value |
|---|---|
| Wire message length | 256 KiB, read unsigned; buffer watchdog at 512 KiB, checked every 2 s |
| Wire idle timeout | 60 s |
| Content connections per swarm (soft, hard) | desktop 30, 45; phone on Wi-Fi 8, 12; phone on an unknown network 6, 9; phone on mobile data 4, 6 |
| Ledger swarm connections (soft, hard) | desktop 6, 9; phones 3, 5 |
| Offers per tracker announce | 3 (2 on mobile data); 0 at the soft cap |
| Site size | 128 MiB desktop, 48 MiB phone on Wi-Fi, 24 MiB phone otherwise; `max=` lowers it |
| `.torrent` from `xs=` | 8 MiB |
| Ledger snapshot from `cs=` | 64 MiB downloaded, 128 MiB inflated, 30 s |
| Ledger size | 8 MiB by default, owner may raise it to 64 MiB |
| Block | 4,096 bytes; value 2,048 bytes; key 256 bytes; list name 64 bytes; at most 8 parents |
| Allow list, moderators | 1,000 and 50 keys |
| Posting fee | 16 bits of proof-of-work by default; owner and moderators exempt |
| Entries per author | 30 per 10 minutes, a local throttle per visitor |
| Gossip frame | 15 KiB; at most 64 hashes per request |
| Gossip from one peer | 64 KiB/s unsolicited; 1 MiB/s for answers, up to 2 x the ledger size + 1 MiB in total |
| Invalid blocks from one peer | 50, then the peer is ignored for the session |
| Blocks waiting for parents | 256 per peer, 2,000 in total |
| SDK writes | 20 a minute per page; requests up to 64 KiB |
| Web seed failures | 3 in 30 s, then that web seed is skipped for 5 minutes |
| Uploads | desktop 1 MiB/s; phones off until the visitor allows them, then 128 KiB/s |
| Storage | 512 MiB desktop, 128 MiB phone, least recently visited site evicted first |
| Navigation | answered within 25 s; at most 3 automatic reloads of one URL per minute |

## Supply chain

- **Install scripts never run.** `.npmrc` sets `ignore-scripts=true`, and `package.json` lists the one allowed
  install script under `allowScripts`, which npm 11.19 and later enforce as a default-deny (a planted
  `postinstall` was blocked in the research; [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), D17).
  Dependencies are locked in `package-lock.json`, and `.github/dependabot.yml` proposes updates weekly.
- **The vendored WebTorrent bundle is pinned twice.** `build.lock.json` holds the SHA-256 of
  `webtorrent@3.0.21`'s `dist/webtorrent.min.js` as published and of the patched copy shipped in `dist/_mw/`. The
  build applies five string patches, each of which must match exactly once (`webconn-request-headers`,
  `xs-metadata-user-agent`, `remote-torrent-user-agent`, `opfs-chunks-cleanup`, `fsa-createwritable-polyfill`),
  lints the result against the browser floor, and fails on any difference. Replacing the patches with a bundle
  the project builds itself is on the [ROADMAP](ROADMAP.md).
- **The loader checks its own files.** The static page carries SRI for `boot.js` and `loader.js`; the worker
  embeds the SHA-384 of every file it precaches and refuses an install that doesn't match.
- **Signed, attested releases.** A release from 0.3.0 on carries `SHA256SUMS`, a build provenance attestation
  (`gh attestation verify`) and two per-file hash lists that the owner signs offline with the release key
  (`tools/verify-release.mjs`, ECDSA P-256; `.github/workflows/release.yml` leaves a draft until then). `SHA256SUMS`
  alone catches a damaged download, not a forged one: check the signature with the public key pinned in
  [SECURITY.md](../SECURITY.md) (`node tools/verify-release.mjs verify`), or build the loader yourself from a tagged
  commit and compare. A release manifest bound to the pointer is on the [ROADMAP](ROADMAP.md).
- **The kill switch** is the way back if a bad loader ships ([DEPLOY.md](DEPLOY.md#kill-switch)).

## v0.3: identity, chat, files and private media

> **Status: v0.3, built and reviewed.** This section is the short model of v0.3
> ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; a number after R is its section). The code has
> landed with unit tests, the integrators' end-to-end runs on loopback, the code review of the v0.3 and C2 code and the
> review round of R 5.3 (2026-10-22 to 2026-10-24; its results are R 5.4, and the guarantees it changed name the finding
> below), and 0.3.0 carries it; the real-device gate has not run.
> The sections above stay true in 0.3.0. The long tables (what each observer sees before and after, every red-team attack and its status, the honest
> limits) are in [THREAT-MODEL.md](THREAT-MODEL.md). The "Planned test" column names the test ids of R Part 4;
> [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md) says which of them exist and pass on loopback, and none is a real-device result.

### In short, v0.3

- A person's root lives at one **identity origin**, a static, self-hostable, hash-pinned web origin opened only as a
  top-level window. No site origin ever holds the root, the 12 words, the passkey output, the vault key or another
  site's keys. A site gets working keys for its own label, and a server-backed site gets a signed proof.
- That adds one central trust point: the code the identity origin serves. It replaces the far larger one in the
  proposals, where every site host would have held every root.
- Each site's host and its code stay the trust root for that site. Code on a site you are signed in to can copy your
  keys for that site and read what the site can read. It cannot reach the root or any other site.
- Peers, trackers, STUN servers, relays and holders are untrusted for content and integrity, and are assumed to log
  everything they can see. The IP address is visible to everyone a browser connects to: identities are pseudonymous,
  not anonymous.
- Chat, sealed items, private files and media, and the sign-in format are new cryptographic code. None is called
  secure before the independent audit that R 2.19 requires before 1.0.

### What is being protected, v0.3

| Asset | What it is |
|---|---|
| The root and the vault | 16 random bytes as 12 words (with an optional extra word), wrapped by a passkey or a passphrase at the identity origin, and a vault of random chat, record and own-media keys |
| A site's working keys | the signing key, chat key, record key and local cache key for one label (one origin by default) |
| Sealed items | the encrypted visitor record, join requests and grants, 1,024 bytes of plaintext each, in the vault or on the site ledger |
| Chat | direct messages, rooms and groups, and the keys behind them |
| Files and private media | the bytes, their keys, their metadata (location and camera details), and who can open them |
| The sign-in proof | a short-lived signed statement that a key signed in to an origin |
| The moderation record | bans, allow lists, `_deny/` entries, and the owner's recovery commitments |
| The build | the identity origin bundle, the loader, `@felinar/verify` and the hash list that vouches for them |

### Who is trusted with what, v0.3

| Actor | Trusted for | If malicious or compromised, it can | What limits it |
|---|---|---|---|
| The identity origin's host | serving the identity page's code | serve altered code, which takes the roots of people who unlock afterwards; see the IP address and time of popup loads that miss its cache | a published bundle hash, a reproducible build, signed releases, a build id on every card; a person can run their own identity origin. This is the one central trust point the design adds |
| The passkey provider | storing one credential for the identity origin | know that the person has a felinar identity there; through its account recovery, become a recovery path for the identity | the credential is bound to the identity origin's RP ID; the PRF output is reachable only by that origin's code; phrase-only mode is offered |
| A site's host and its code | serving that site's loader, files and scripts | take that site's working keys, read that site's sealed items and the private media of people signed in there, act as them there | it cannot reach the root or another site: other sites' keys never leave the identity origin |
| A server-backed relying party | verifying sign-in proofs | see the person's key for that site, the IP address, the user agent and the time; link accounts if it joins its logs with another server's by IP and time | the library returns only what it verified; proofs are bound to its origin and a nonce it issued; pairwise keys by default |
| A hub operator | serving the loader for every personal site on its domain, and running a tracker, a pin mailbox and a pin node | take the owner keys of the personal sites it serves; see IP addresses, tags, sizes and times; its pin service is central storage that can be compelled to remove content | shared-origin hubs never hold a persistent identity; subdomain hubs need a Public Suffix List entry or persistent identity is disabled; hub-scoped identity only by the person's choice, and the hub key goes only to pages the identity origin takes for the hub's template (review round PHISH-1); with it, a page of the hub the person signs in to can post as them on every page of the hub, and the card says so (HUB-3) |
| Holders and a pin node's operator | holding ciphertext for others | see IP addresses, tags, sizes and times; link the address that left a message to the address that collected it; drop what they hold | they cannot read what they hold; quotas per source (the Noise static key) and eviction by stamp work; stranger mail is released only after a proof of the chat key; a contact's mail is deleted only with the COLLECTED hash-lock secret, which the holder checks (review round SYB-15, DS-7) |
| The site's own tracker, STUN servers and a TURN relay | introducing visitors; relaying a connection | see IP addresses and when people are active; sit in the middle of the WebRTC transport | content is end-to-end encrypted and handshakes bind transcripts; TURN is off unless the owner runs one and names the operator |
| Moderators | removing items and banning keys | act wrongly; their keys are hot keys | non-extractable key, UI-gated actions with `isTrusted` input, per-hour caps and, per checkpoint epoch, at most 24 hours of actions and 7 days of allow additions in effect whatever times the blocks claim (review round SYB-2), standing only with the appointment in the block's causal past (HUB-4), `unban`, owner-protected entries (a moderator's `put` cannot replace an owner-written one: HUB-6), voiding of a removed moderator's actions, a 24-hour grace before values are deleted (chosen), for bans and bulk tombstones too (HUB-2) |
| Other visitors, recipients and group members | nothing | keep, forward or screenshot what is sent to them; record the encrypted copies they see; record IP addresses | deniable direct messages; per-recipient grants; revocation (best effort) |
| The browser | enforcing origins, `event.origin`, WebAuthn RP IDs and Service Worker scope | nothing the design can limit: malicious extensions and compromised devices are out of reach | out of scope |

### Protections, threat by threat, v0.3

| Threat | Protection | Planned test | Limit |
|---|---|---|---|
| A site, its host or a script on it takes the root or another site's keys | the root exists only at the identity origin (top-level windows only, `frame-ancestors 'none'`); a site receives an encrypted bundle of its own label's keys, posted to the verified opener's `event.origin` | E-ID-5, U-ID-4 | that site's own keys remain exposed to its host and its code |
| A look-alike origin, or a page that names a victim's ledger id, receives the victim site's key | the key label comes from `event.origin`; the ledger label is used only when the identity origin verifies the site's signed pointer, its lineage and that the origin is in the pointer's `org=` list | U-ID-4, E-ID-8 | none known (R 2.16.3) |
| Phishing for the 12 words | the words are typed and shown only at the identity origin; site cards and widgets have no phrase field; the copy says "felinar never asks for your 12 words on the site you are signing in to." | E-ID-10 | a person who types the words into another page, or a fake identity page, loses every identity |
| A page paints over a high-risk card | first sign-in, "same identity", device link, showing the phrase and the first read of the private record run only in the identity window; in-page cards get topmost-element, opacity and mutation checks and are speed bumps, not locks | E-ID-15 | overlays on in-page cards are mitigated, not blocked |
| A reverse proxy of a real site mints proofs for the real origin | only the identity origin signs; it fills `domain` and `origin` from `event.origin`; the first approval of an origin needs a user-verified passkey or passphrase | E-SI-5 | a person who approves "Sign in to" a wrong origin |
| A proof is replayed or used on another site | the verifier issues a single-use nonce; `exp - iat` is at most 5 minutes; origin and domain are bound and checked; local proofs are refused by the library; the nonce is consumed before the signature is checked | U-SI-1, U-SI-2, E-SI-2, E-SI-3, E-SI-4 | a proof stolen inside its 5 minutes and used before the real one at the same verifier |
| Linking a person across sites | a different key on every site by default; linking only by the person's choice at the identity origin, at most once per origin per 30 days (chosen), never on page load and never preselected by a script; nothing is written to a ledger; each site's escrow copies are made for its origin (a fresh IV, an id per origin, a padded size), so they do not link sites (review round SEC-1, STALK-1, PHISH-2) | E-ID-4 | IP address, timing, reused names, writing style; the identity origin's host sees popup loads that miss its cache |
| A page that claims to be another site sends the person to the identity page by redirect | a redirect carries only a key sign-in or the record read; its sign-in is unverified (no approval, hub decision, same-identity link or vault site), and the card says the page cannot be confirmed (review round SEC-2, PHISH-9) | idp-review-round | a person who signs in anyway from a page they did not check |
| A restore or a device link started by a site replaces the identity | a restore on a device that has an identity shows its check code first and never replaces it silently; `#restore` and `#link` in a window a site opened only say "open the identity page yourself"; a device link takes the whole vault or fails (review round SEC-3, SEC-4, PHISH-4, PHISH-5) | idp-review-round, E-ID-3, E-ID-14 | a person who restores other words after seeing both check codes |
| A device link to an attacker's device | commit-then-reveal; a 6-digit code compared on the old device before any ciphertext exists (a substituted key matches with probability 1 in 10^6, arithmetic); in person only; accepted within 120 s (chosen) of a "Link a device" screen the person opened | U-ID-6, E-ID-14 | a person who links an attacker's device in person |
| Keys left behind after signing out | sign out deletes the label's working keys from memory and IndexedDB; "Stay signed in" is an explicit choice (30 days at most, chosen); shared-computer mode keeps keys in memory only; no proof is written to session storage | E-ID-2, E-ID-2b | sites where the person stays signed in; the identity page while its window is open |
| Losing the identity when a browser clears storage | escrow blobs on each signed-in site, for a passkey-wrapped root only (a passphrase identity is never escrowed and comes back from the 12 words or the backup file; code review v0.3); the recovery-kit card, which the loader offers after the first meaningful action | G-ID-1 (a device row) | losing both the phrase and the backup file |
| Offline guessing of the backup file | a generated 6-word passphrase (about 66 bits, arithmetic), or a chosen one above a stated floor; the file is labelled "Do not email" | none listed in R Part 4 | a chosen passphrase just above the floor |
| A flood of chat frames, or poisoned holders | a relay stamp bound to each frame (10 bits for contacts, 20 for strangers by default, both chosen), a bounded seen-set, fair queues, interest routing that adds to the flood and never replaces it, per-wire budgets for every control frame and for ROOM signature checks, a hold flag set only when the recipient is unreachable, per-source quotas, a COLLECTED hash lock the holder checks (review round DS-1, MP-8, SYB-10, SYB-15) | U-CH-1, U-CH-2, U-CH-7, E-CH-3, E-CH-9, E-CH-10 | an attacker with enough compute still pays per frame |
| A relay posing as a contact on a wire | a Noise XX handshake over P-256 with the chat keys; later frames are authenticated under the session key | U-AU-2, E-CH-12 | a tracker in the middle of the WebRTC transport sees both addresses and the timing |
| A third party proving what you wrote | direct messages are authenticated by a MAC under a key only the two parties can compute, so either could have made them | U-CH-3 | the recipient knows who wrote; rooms are public and signed, and groups let members prove what a member wrote |
| The public inbox tag as a key-to-address oracle | the stranger inbox tag is never sent in a want request; recipients ask by 1-byte prefix buckets mixed with decoys; a stranger frame shows one byte of the inbox tag and leaves at a random hop (review round STALK-7); stranger mail is released only after a proof of the chat key | U-CH-4, E-CH-11 | a holder can still link the depositing address to the collecting one; a first-hop neighbour can guess a frame's author by timing |
| A shared file runs as the site | the reserved routes answer `application/octet-stream` as an attachment with `nosniff`, a sandbox CSP and same-origin resource policy, and never consult the extension map; the SDK hands out Blobs typed `application/octet-stream`; only a short allow-list previews, in a worker, under a pixel cap | U-FI-2, E-FI-3, E-FI-3b, E-FI-3c | site code that renders a file itself; people who run what they download ("Verified" means only that the bytes match what the sender listed) |
| Visitors become seeders without choosing | nothing is fetched without a click on that row, there are no thumbnails from peers, and a fetched public or private file is never re-seeded unless the visitor clicks "Help share this file" | E-FI-1 | the visitor's address is visible to the swarm once they choose; a private photo or video the visitor opened stays in its swarm on the Echo lane (on a desktop by default after "Share and load", on a phone only with "Share on this network"), so its peers see which item the visitor holds |
| Location and camera details in photos and videos | images are re-encoded on the device, TIFF and camera RAW included; MP4 and MOV keep only an allow-list of boxes and lose their creation times; WebM tags, dates and attachments are removed; MP3, AVI and WAV lose their tags (review round PRIV-5, STALK-10); upload is refused, or warned about, when stripping fails | U-FI-5, E-FI-5, G-MD-8, media-review-round | faces, backgrounds and anything visible in the picture; other types get a warning only |
| Lying torrent metadata | exactly one file, a length equal to the listing, 16 KiB to 4 MiB pieces, no pad files or paths, a `.torrent` of at most 256 KiB, and a file wire's metadata bounded by the listing (review round MAL53-6); a mismatch aborts the fetch and hides the listing | U-FI-1, E-FI-6 | none known |
| A forged listing blocks honest uploads or floods the file list | every honest copy applies the caps when it reads listings: 25 MiB a file, 256 MiB a site, the first 20 listings per author, one row per infohash under its first listing (review round SCALE-1, SYB-13); a new key's listing waits for an acceptance bound to its author (MAL53-1) | media-review-round, review-round-loader-ui | none known |
| Private media read by peers, trackers or a pin node | each piece is AES-256-GCM under a random per-file key, padded to buckets, in a swarm with a random infohash announced only to the site's own tracker; the Service Worker decrypts for the session and the SDK never returns the key | U-MD-1, E-MD-1, E-MD-3 | hostile code on the site's origin; which pieces a viewer asks for (roughly where they seek) is visible to the peers serving them |
| A takedown that forgets what it removed | the moderator writes a `_deny/` entry in the same step as the tombstone; it is checked before any fetch or seed, and against every public fetch's own digest (review round MAL53-4) | E-FI-1, media-review-round | near-duplicates and re-encodings; the pin page host and the pin node's queue check it since the extra wave after verifier round 1, but the pin node's own process learns of a deny only from the page host (review round MAL53-3; review-round-media.md, "Still open after R4") |
| Moderator or owner keys misused | see "Who is trusted with what"; the owner commits in advance to the next owner key (`nx=`), checked on every pointer update path (review round PTR-3), and the old rotation path is removed; a self rotation passes bans, membership and history to the next key only with that key's signature `nsig`, so a banned key cannot hand its ban to a victim (HUB-1) | U-LG-1, U-HD-1, chain-review-round | both the current and the committed next owner keys stolen |
| A stranger's record mounted at a victim's address | a record whose `lo=` names a ledger it has not earned (no owner match, no `rot=` from that key, no lineage this device carried) is refused at a hub address and mounted read only elsewhere; a `#host:name@<fp>` link matches `owner=`, or `lo=` only with that lineage; each device keeps a seq floor per ledger (review round PTR-1, PTR-2, PTR-4) | review-round-loader-pointer | a first visit trusts the host and DNS, as above |
| A ledger filled with junk | a reserved byte pool for unvetted authors (25 percent, chosen), `E_LEDGER_FULL` at 80 percent (chosen), 32 sealed items per author, an owner `checkpoint`, a bulk tombstone, a lifetime block cap for every author and the fee on an orphan's parents (review round SCALE-8, MP-6) | U-LG-3, chain-review-round | keys cost only the fee: the design never claims Sybil resistance; one unvetted key can fill the reserved pool, because there is no per-author share (review round SCALE-4, an owner decision) |
| v0.3 and v0.2.1 peers disagreeing about which blocks are valid | schemas for `mw.*` lists and `_mw.*` keys are state rules: a non-matching item is hidden, and its block stays valid, stored and relayed | U-LG-2 | none known |
| A forged, swapped or backdoored release | the security program of [SECURITY.md](../SECURITY.md): immutable releases, provenance, a signed hash list, locked dependencies, reproducible builds; `verify` needs the expected version, `sign` needs a rebuild on the signing machine, and publish and ship check the loader against the signed list (review round SEC-6, SUP-3, SUP-5) | the cross-OS rebuild job of R 2.19, tools-v03-release | a malicious upstream that passes review; the open supply-chain items of the review round (SUP-1, SUP-2, SUP-4, SUP-10, SUP-11: [THREAT-MODEL.md](THREAT-MODEL.md), SC rows) |

### What is not protected, v0.3

The list below is a summary. Each point is argued in [THREAT-MODEL.md](THREAT-MODEL.md), "Honest limits".

- **Anonymity.** Everyone a browser connects to sees its IP address and when it is active, and can link activity on
  several sites by that address. Tor Browser does not run WebRTC, so in Tor Browser a person can read and sign in
  but cannot connect to other visitors.
- **Forward secrecy for retained envelopes.** Whoever later gets a recipient's chat private key can open the envelopes
  they recorded. Envelopes recorded now could be opened by a future break of P-256 (harvest now, decrypt later).
  Records and private media use symmetric keys and are not affected.
- **Hostile site code.** Code on a site you are signed in to can copy your keys for that site, read your record there
  and obtain that site's playback keys.
- **A hub serving personal sites.** A hostile hub can take the owner keys of the personal sites it serves. With
  hub-scoped identity, a page of the hub that the person signs in to can post as them on every page of the hub.
- **The identity origin's served code.** Altered code takes the roots of people who unlock afterwards.
- **A tracker between two peers.** It sees both addresses and the timing, and cannot read or forge sealed messages.
- **Anyone who learns the 12 words.** They act as the person on every site. They cannot open older content without the
  backup file or an unlocked device.
- **What recipients keep.** A recipient can keep, forward or screenshot what is sent. Revocation works in honest apps
  only.
- **Availability.** Private media plays only while a holder is reachable; offline delivery needs the hub mailbox or an
  opted-in holder.
- **Unreviewed cryptography.** See the last point of "In short, v0.3".

### Budgets and caps, v0.3

Every figure is chosen (a design parameter that a gate row confirms or tunes) unless the last column says otherwise.
None of the throughput figures is measured.

| Limit | Value | Basis |
|---|---|---|
| Wire budget for one tab across all swarms | desktop 40, phones 8 | chosen, R 2.7.1; row G-SC-2 measures the ceiling |
| Chat frame | at most 16,384 bytes; the 262,144-byte wire guard applies first | format limit, R 2.7.3 |
| Relay stamp | 10 bits for contacts, 20 bits by default for strangers: about 1,024 and 1.05 million hashes on average | chosen; hash counts are arithmetic; time on phones is row G-CH-6 |
| Decrypt attempts | 50 per wire per second and 200 per tag per second | chosen, R 2.7.3 |
| Strikes before a wire closes | 20 | chosen, R 2.7.3 |
| Seen-set of frames | 20,000 frame ids or 10 minutes | chosen, R 2.7.3 |
| Relay traffic | desktop 64 KiB/s per neighbour; Android 8 KiB/s and 2 MiB per session after "Share on this network"; iOS none | chosen, R 2.7.3 |
| Holders | 7 days, 64 frames per tag, 4 MiB per holder, at most 1/8 of a store from one neighbour | chosen, R 2.7.5 |
| Rooms | 10 messages per 10 s per author | chosen, R 2.7.4 |
| Groups | 32 members; 7 days of grace for the previous key | chosen, R 2.7.7 |
| Message requests inbox | 200 entries | chosen, R 2.17.2 |
| Public files | 25 MiB per file, 256 MiB per site, 20 active listings per author | chosen, R 2.8.8 |
| Private file or media | 100 MiB per item on desktop until row G-MD-5, 25 MiB on phones | chosen, R 2.8.8 |
| Preview | 24 megapixels | chosen, R 2.8.5 |
| Torrent of a file | one file, pieces of 16 KiB to 4 MiB, `.torrent` of at most 256 KiB (about 13,100 pieces fit under that cap, arithmetic: 262,144 / 20) | format limit, R 2.8.3; [deviations/media.md](deviations/media.md), item 15 |
| Playback memory | at most 4 decrypted chunks per stream, 1 MiB at 256 KiB pieces | chosen, R 2.9.6; the megabyte is arithmetic |
| Sealed items | 1,024 bytes of plaintext; at most 32 effective items per author; one synced update an hour | format, SDK convention and chosen, R 2.6.2 |
| Moderators | 20 additions to the allow list per moderator per UTC day; 60 actions per moderator per hour; per checkpoint epoch at most 24 hours of actions and 7 days of allow additions in effect (`EPOCH_ACTION_HOURS`, `EPOCH_ALLOW_DAYS`) | chosen, R 2.5.2 and 2.5.3; the epoch totals since the review round (SYB-2) |
| Reserved pool for unvetted authors | 25 percent of the ledger cap | chosen, R 2.5.3 |
| Sign-in proof | `exp - iat` at most 5 minutes; at most 4,096 bytes | format limits, [specs/mw-signin-v1.md](specs/mw-signin-v1.md) |
| Local proof | at most 15 minutes, in memory | chosen, R 2.4.2 |
| Passphrase wrapping | Argon2id with 64 MiB, 3 passes, 1 lane: 1.3 to 2.5 s in plain JavaScript on an Apple M3; PBKDF2-SHA-256 with 600,000 iterations: 57 ms in Node | chosen parameters; times measured by the identity lane ([deviations/idcore.md](deviations/idcore.md)); phones not measured, row G-ID-6 |

### Supply chain, v0.3

The identity origin makes the build the trust root for every person's root. The program that R 2.19 requires is in
[SECURITY.md](../SECURITY.md). Its code parts are in the tree and 0.3.0 uses them: the release workflow's build
provenance attestation, the per-file hash lists that the owner signs offline (`tools/verify-release.mjs`), every
bundled package pinned in `build.lock.json`, `npm-shrinkwrap.json`, the cross-OS rebuild job, the seeded fuzzers in
`test/fuzz/` (targets for: ledger gossip frames, ledger blocks, JCS, the pointer, pointer TXT records, magnet links,
bencode, torrent files, inflate, sign-in proofs, the verify package, file listings, chat frames, chat points; no target
yet for: the Noise handshake, the sealed box, sealed items, the media chunk format, MP4 and WebM rewriting, image
sniffing; [ROADMAP.md](ROADMAP.md), 1.0), and the runbooks for an identity origin compromise, a site host compromise and a leaked owner key
([OPERATIONS.md](OPERATIONS.md)). The parts that are repository settings or people are the owner's
([PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md), section 16.7): immutable releases, the tag ruleset, the reviewer
environment, the 14-day dependency cooldown (`.github/dependabot.yml`), a two-person rule on the lock file
(`.github/CODEOWNERS` names one person until there is a second), reserved npm names and an independent audit before
1.0. `@felinar/verify` carries no npm provenance: no workflow publishes it, so it is published by hand.

### v0.3 C2: seeding, the pin node, the zero-setup ladder and calls

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (R 5.4).** The short model of phase C2
> ([research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md), "SZ"; ARCHITECTURE 8.1 and 15.14). Built and integrated on
> 2026-10-20 and tested on loopback only (deviations/integration-c2.md), and in 0.3.0; no row is a claim about real devices or a public network. The "Planned test" column names the tests the lane briefs list; the long rows, the
> observers and the limits are in [THREAT-MODEL.md](THREAT-MODEL.md), "Threats added by v0.3 C2". Browser only: nothing here asks a member to
> install anything.

#### In short, C2

- Calls put no server in the media path. Offers and answers travel only inside SIG messages sealed with the pair key, so only the two contacts
  can read or alter them; the DTLS fingerprints in them are authenticated end to end, and a mismatch after the connection ends the call.
- A call's price is stated before it starts: every participant sees your IP address once you accept. A relay exists only if the owner runs
  one, and then its operator sees both addresses, sizes and times, never content.
- Code on a site you are signed in to can still use a microphone or camera permission you gave that site. The design never claims
  otherwise (R 2.1 rule 2). The SDK returns no media stream, and no call starts or is accepted without a click on a loader card.
- The pin's key is a key of its own. On a wire it signs two short forms and nothing else, and its Node tool signs the heartbeat; the key never
  enters a page.
- An availability label is a claim with an evidence tier. A count of holders is "reported" because a bitfield can lie; only a verified pin
  receipt, a fresh signed heartbeat or a web-seed probe may say "Kept by the site".
- Phones are bounded by budgets per lane, per session and per month, and are never durable: a closed or suspended page seeds, relays, holds
  and rings nothing. Only a pin node, run by the owner or a hub, is durable.
- A site on a `nip.io` or `sslip.io` name has a DNS operator that is a party to the site's trust root, as for any name you do not control.

#### Who is trusted with what, C2

| Actor | Trusted for | If malicious or compromised, it can | What limits it |
|---|---|---|---|
| The operator of a pin node (the owner, or a hub) | keeping files, answering with receipts, writing the heartbeat | drop what it holds; see the IP addresses of phones that hand off; read the bytes of public files it pins; with the pin key, sign receipts and heartbeats that say "Kept by the site" for items it does not keep, until the owner replaces `_mw.cfg.pin` | the pin key signs only the two wire forms (the Node tool signs the heartbeat itself); a file is never opened or rendered; the moderator queue and quarantine; the store caps and the month cap |
| The people in a call | nothing | record or capture the call, keep what they saw, see your IP address, and in a group call the other participants' addresses and the roster keys | contacts only, a loader card and your accept before any address is revealed, calls off by default, the browser's own camera and microphone indicators |
| The operator of a call relay (only if the owner runs one) | forwarding encrypted packets | see both addresses of a relayed pair, how much and when; drop the call | DTLS-SRTP runs between the two browsers, so content is unreadable to it; off by default; named on the card |
| The operators of `nip.io` or `sslip.io` (only for a site on such a name) | answering DNS for the name | point the name elsewhere, obtain a certificate for it from a certificate authority that validates over that DNS, and serve different loader code to anyone who loads the site (inference from how the validation works); block the name (they keep a phishing block list: S2 F3) | nothing in software. A domain you own moves this trust to a registrar and a DNS host you control |

#### Protections, threat by threat, C2

| Threat | Protection | Planned test | Limit |
|---|---|---|---|
| Forged or altered signalling (SIG spoofing) | offers, answers and candidates exist only inside SIG sealed with `K_pair`; a SIG from a non-contact, a `sig` inside an ENV, a stale `t` or a repeated `(c, s)` is dropped | calls-signal, calls-service, E-CL-3 | a stolen chat key impersonates in calls as in chat |
| Ring spam | contacts only, one pending ring per contact, at most 10 an hour, a 45-second expiry, calls off by default, and no connection exists before the callee accepts, so a ring costs only a loader card | calls-signal, E-CL-3 | a contact can still ring ten times an hour: block them |
| A man in the middle on the signalling path | the `a=fingerprint` lines are inside the sealed SIG; after the connection is up the remote certificate fingerprint must equal the one in the SDP received over SIG, or the call ends with `E_CALL_FAILED` | calls-browser (fingerprint passing, and failing when the relay alters it), E-CL-1 | a TURN relay in the media path still sees addresses, sizes and times |
| An address leaked by ringing | a ring has no SDP; the callee creates no connection before it accepts; the caller sends no candidate before the accept | E-CL-3 (a non-contact's ring creates no `RTCPeerConnection`; after a decline no offer leaves the caller) | an accepted call shows the addresses, and the card says so first |
| A contact makes your browser probe your network | received private, loopback and link-local candidates are dropped unless both chose "same local network"; mDNS candidates pass | calls-ice | the "same local network" choice |
| Same-origin code and the microphone | site code is trusted for its own site and nothing else (R 2.1 rule 2): the SDK returns no media stream; a call starts or is accepted only from a loader card and a verified click; `getUserMedia` and `getDisplayMedia` occur only under `src/calls/` (a lint) | lint-contrib, sdk-c2-calls | hostile code on the site's origin can call the browser's media APIs itself once the person has allowed the site; the browser's permission prompt and indicator are the control |
| The pin key misused through a page | the key signs only `"mw-pin1-hello\n" + ih + "\n" + n + "\n" + at` and `"mw-pin1-receipt\n" + ih + "\n" + total + "\n" + at`; `isPinSignable` refuses all other bytes; the key never enters the page; it is not the owner key | pin-frames, tools-c2-pin | a stolen pin key signs false receipts until the owner replaces `_mw.cfg.pin` |
| A replayed hello, receipt or heartbeat | a hello binds the infohash, a nonce of that wire and a time (5 minutes); a receipt binds the infohash, the total and a time; a heartbeat older than 15 minutes is not evidence | pin-frames and pin-heartbeat vectors | inside the window |
| Lying bitfields | a holder count is "reported" and "at least"; "Kept by the site" needs E3 or E4; spot-checks (E2) are v0.4 | E-PS-2, G-PS-9 | a liar can raise the N of "Kept by you and at least N others online now (reported)" |
| A pin filled with files | member requests wait in the moderator queue; the owner's items auto-accept only with `--auto-accept owner` (SZ-6); the pin store has a cap per file and in all (today's `PIN_LIMITS`: 100 MiB and 2 GiB); a month cap bounds the bytes the pin uploads for pinned files | tools-c2-pin | a stolen owner key can fill a pin up to its store caps |
| Peers draining a phone | per-lane rates, session and month caps; K and E lock when the page is hidden; local counters | E-PS-3, seed-budget | the cap binds before the rate: 256 MiB is gone in 34 minutes at 128 KiB/s (arithmetic) |
| A name that resolves somewhere else | `nameCheck` stops when the name answers the block page or an address other than the server's; `ship` prints the limits and the expiry date | name-check, tools-ship | the DNS operator is in the trust root (above) |
| The owner key copied to a server | `ship` never copies the owner key; it signs on the owner's machine | tools-ship (the key is absent from the file list) | the key lives on one machine |
| A local certificate authority on phones | the LAN demo asks each phone to trust a local authority; its text says that whoever gets the authority's key can read the secure traffic of every phone that trusts it | the S2 Z8 string | keep the key on one computer and remove the certificate afterwards |

#### What is not protected, C2

- **Addresses in a call.** Every participant sees your IP address. A relay hides it from them only when the owner runs one and you choose to hide
  it; its operator then sees both addresses.
- **A call in the background.** On iPhone call video stops when you leave the page, a Home Screen app can lose the microphone and a phone call
  pauses capture; Android can cut the network of a phone that is unplugged, still and dark. iOS 26 and 27 and Android with the screen off are unmeasured (G-CL-2, G-CL-3).
- **That a call is being set up.** The neighbours that carry the sealed SIG frames see their type, size and time and the day's tag for the pair, not their content.
- **What the people in a call keep.** Anyone can record the call or capture the screen.
- **Durability.** Without a pin node or a host copy nothing stays available while nobody who has it is online. Phones add availability only.
- **Cryptography without outside review.** SIG sealing reuses the chat sealed box (R 2.19). The pin's signatures are ECDSA P-256 over two fixed
  strings and the heartbeat.

#### Budgets and caps, C2

| Limit | Value | Basis |
|---|---|---|
| Seeding rate, session and month by context | the table of ARCHITECTURE 8.1.3 (desktop month 20 GB; phone month 0 to 1 GiB) | chosen (S1 D2); 20 GB is the Delivery Optimization default (S1 MS1) |
| Dock mode | 2 hours by default, 8 hours at most; ends under 20% battery where the browser reports it | chosen |
| Echo target and whole-item threshold | 3 complete online copies; items up to 8 MiB are kept whole | chosen |
| Pin frame and heartbeat | `mw_pin1` frames at most 1,024 bytes, hello and receipt within 5 minutes; a heartbeat at most 15 minutes old, at most 256 KiB and 4,096 items | format limits and chosen windows |
| A pin's month cap | uploaded bytes of pinned files per UTC month (`--month-cap`); the site torrent always seeds | chosen by the owner |
| A pin's store | 100 MiB a file and 2 GiB in all (`PIN_LIMITS` in `tools/pin.mjs`) | the per-file cap is a code constant; the total is a default that `--max-total <size>` changes (`tools/pin.mjs:89`) |
| Calls | 6 audio only, 4 with video; a ring expires after 45 s; 10 rings per contact per hour; `t` within 60 s; a payload of 15,000 bytes; a roster of 5; 16 candidates | chosen (SZ-4) and format limits |
| Call media | audio 32 kbit/s (24 metered); video 800 kbit/s 1:1 and 400 in a mesh, phones 500 and 300; screen 1,200 and 600 | chosen |
| Call connections on a phone | at most 5, counted apart from the wire budget | chosen |
| Pairs that need a relay | 10% to 30%: a planning range from vendor estimates, not a measurement | w2b-03 F-01, F-03 |

### Trust on first door (v0.3 C2)

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (R 5.4).** Doors ([research/v03/S4-doors.md](research/v03/S4-doors.md), ARCHITECTURE 15.15; the lane's notes in
> [deviations/doors.md](deviations/doors.md)), tested on loopback only (e2e DOOR-DOWN, DOOR-HASH, DOOR-GUEST).

A visitor trusts the first door they open a site at: a hostile or altered door can serve a hostile loader, and nothing a page does can
prove a door good on first use (S4 F10). What helps after that: the worker keeps the build it installed, `ml=` makes older loaders
refuse a site, the door page's frame has an opaque origin (the site there cannot read the door's storage, cookies or worker, and the
door gets nothing from the site but what the site sends through the Bridge), signed `dr=` doors cannot be stripped from a link, hints
from a link are used only for bytes that are checked by hash and only on public names, the `.torrent` from any door must hash to the
record's infohash and every piece is checked, and a withdrawal opened at a door deletes only that site's copies. Out of band: `node
tools/verify-release.mjs verify` against the pinned release key, and `node tools/check-site.mjs <door> --door`. Residual: a door sees
the visitor's IP address and the time; a site in the door view can hand its own API to a page it navigates its frame to (its identity
there is for this visit only); Browser-enforced transparency (WAICT) is a Firefox Nightly prototype.

## Reporting

Report vulnerabilities privately as [SECURITY.md](../SECURITY.md) describes. A report that shows a protection on
this page failing is exactly what we want; a report that restates a documented non-protection is not a
vulnerability, though a better mitigation is always welcome. A flaw in the identity origin or in
`@felinar/verify` is in its own severity class, because it can expose a person's identity on every site
([SECURITY.md](../SECURITY.md)). Changes to this model go through an RFC ([GOVERNANCE.md](../GOVERNANCE.md)).
