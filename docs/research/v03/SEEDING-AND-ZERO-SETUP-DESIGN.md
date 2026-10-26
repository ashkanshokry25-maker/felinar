# Seeding, zero-setup hosting, adoption and calls: the phase C2 design

- **Date:** 2026-10-20. **Status:** amendment text for ARCHITECTURE 8, DEPLOY and QUICKSTART, the calls design and the C2 lanes; proposed, nothing built; section 6 needs the owner's sign-off.
- **Inputs:** [S1](S1-smart-phone-seeding.md), [S2](S2-zero-setup-hosting.md), [S3](S3-adoption-mechanics.md); ARCHITECTURE 8, 15; `policy.js`, `torrent.js`, `src/chat/*`; R5, R8; V03-DESIGN-REVIEW ("R") 2.7 to 2.11; the scale judge; DEPLOY; QUICKSTART; tools; w2b-03; for calls, pages read 2026-10-20 and the loopback [c2-calls-lab](../labs/c2-calls-lab/README.md).
- **Binding owner decisions:** IP visibility to peers is the premise of the light web. **Browser only:** no native app, desktop keeper or extension, nothing a member installs; an installed web app counts as the browser; the owner's or hub's pin node is infrastructure beside the static host and tracker. Calls are a C2 lane.
- **Labels:** documented, measured, arithmetic, chosen (a gate row confirms it), [s] (search result only). Ids such as [WK6] resolve in S1 to S3, new ones in section 7. Effort: S under a week, M one to four weeks, L more.

## 0. Summary

1. **Phones cannot be reliable seeders of other people's content.** WebKit suspends a hidden page after 20 s, then "all low-level networking stops"; `RTCPeerConnection` exists only in a window, so no Service Worker wake-up can seed (S1 F1, F2). A phone can reliably hand its own uploads to an always-on holder while open, give budgeted bytes while open, and label availability honestly.
2. **Durability comes only from pin nodes run by the owner or a hub:** a 99% pin does what about 108 phones open an hour a day do (S1 F6). Members add availability (open tabs, installed web apps, dock mode), never durability.
3. **Smart seeding:** three lanes in spending order (Hand-off, Keep, Echo) under budgets by device, network proof, power, visibility, session and month; local wires sit outside the data cap (3.1).
4. **Honest availability:** evidence tiers E0 to E4 decide every label; "Kept by the site" needs a pin receipt (`mw_pin1`, new) or a fresh signed heartbeat.
5. **Rejected by the owner, recorded:** S3's keeper CLI for members (K1), extension (K2), desktop app (K3), keeper pods and OS `lightweb:` handler; S1's native wrappers (O7, O8) and wrapper push inbox (O6).
6. **Zero-setup ladder:** try (localhost), share on my LAN (mkcert or Android USB), publish with no domain (a rented server named `203-0-113-7.nip.io` behind one Caddy box, GitHub Pages, or a hub link), own domain. Rungs 0 to 2 have no DNS pointer and the page tag expires (90 days by default, 399 at most); `ship` never copies the owner key to the server (3.2).
7. **Adoption:** C2 ships honest labels, the carry meter, dock mode, the one-box rung, the pin heartbeat and calls; v0.4 ships comments, `try`, the classroom kit, owner `status`, the showcase hub and plug-ins (3.3).
8. **Calls:** audio, video and screen sharing between signed-in contacts, 1:1 and mesh up to 6 audio or 4 video (chosen; mesh suits "2-5 participants" [BG1]); offers and answers travel only in SIG frames sealed with the pair key, so DTLS fingerprints are authenticated end to end; DTLS-SRTP per pair; no server in the media path unless the owner runs the R 2.7.8 relay (3.5).
9. **Lab:** fake (Chromium) and mock (WebKit) devices carry a loopback call; WebKit mutes the first capturing page when another captures and needs a gesture for `getDisplayMedia`; an offer or answer fits one sealed bucket.
10. **Seven C2 lanes** (section 5); each edits files of phase C lanes, so all run after phase C's final integration.

## 1. Findings with sources

### 1.1 What the browser allows (S1 F1 to F4; call rows new)

| Platform | Allows | Forbids or lacks |
|---|---|---|
| iOS Safari tab, Home Screen web app | Wake Lock (16.4; Home Screen 18.4) [ST1]; Web Push in Home Screen apps [WK2] | suspended 20 s after prepare-to-suspend [WK6], then no networking [AP1]; no Background Sync, Periodic Sync, Background Fetch [ST1]; no battery or network API [WK5]; every push visible [WK1]; tab storage deleted after 7 days unused, Home Screen exempt [WK5] |
| iOS during a call | a page capturing the microphone "will not get suspended if in the background" (WebKit engineer, 2020-03-23) [WKB1] | video stops in the background; Home Screen apps "lose the microphone as soon as they go into background (or screen locked)" (report, 2023-12-26) [WKB2]; a phone call mutes capture [WKB1] |
| Android Chrome tab, installed PWA | `getBattery`, `connection.type`, `saveData` [ST1]; Background Sync; Periodic Sync when installed, "a few minutes at a time" [CH1]; Background Fetch [CH2] | cached processes get "limited or no execution time" [AN2]; Doze cuts the network when unplugged, still and dark [AN1] |
| Desktop Chromium | hidden pages with an open data channel escape intensive throttling [CH3] | nothing after the browser closes or the laptop sleeps |
| Service Worker | short HTTP event handlers (fetch, push, sync, background fetch) | `RTCPeerConnection` is `[Exposed=Window]` [ST2]: no seeding, relaying, holding or calls |
| Screen sharing | `getDisplayMedia`: Chrome 72, Firefox 66, Safari 13, iOS Safari 27 (MDN data, unverified on a device) [BCD] | Chrome and Firefox for Android: none [BCD] |

### 1.2 Arithmetic that decides (S1 F5, F6)

Availability 1 - (1 - p)^r: for 99%, 108 phones open 1 h a day (p = 4.2%), 12 docks on for 8 h (33%), or one 99% pin. Same storage at p = 5%: 10 full copies 40.1%, 20 half copies 0.06%. 25 open phones at 128 KiB/s offer 3.1 MiB/s. A 256 MiB month cap is gone in 34 minutes at 128 KiB/s. Super-seeding uploads about 105% before another full copy exists, a plain seed 150% to 200% [TO1]. About 8.4% of visits can serve files today (0.3 x 0.35 x 0.8, a planning model; S3 2.2).

### 1.3 Hosting and adoption (S2, S3)

nip.io and sslip.io: one free DNS service of two volunteers, a phishing block list, no uptime statement (S2 F1, F3); not on the Public Suffix List (F4); no `_magnet` TXT (F2); certificates by HTTP-01 or TLS-ALPN-01, IP certificates since 2026-01-15, no passkeys on an IP origin [r] (F7, F8); carrier-grade NAT at 10% of ISPs tested in 2017 (F12); quick tunnels rename every run (F13); GitHub Pages and Netlify carry the shell contract, Cloudflare Pages cannot be the web seed (F14); the one-box Caddyfile passed `check-webseed` and `check-site` on loopback (F17). Adoption followed shocks and one-click starts, retention a job that works with no peers online; 99.96% of NetSession installs with uploads off never turned them on (S3 F1, F2).

### 1.4 Calls

- RFC 8827: "Media traffic MUST NOT be sent over plain (unencrypted) RTP or RTCP", "DTLS-SRTP MUST be offered for every media channel" (6.5); without identity assertions security needs "minimal trust in the signaling service not to perform a man-in-the-middle attack" (4.3); "the peer learns one's IP address" (6.4) [RFC1].
- Relay need belongs to the pair; plan for 10% to 30% of pairs (vendor estimates; 22% of conferences in 2016 callstats data; w2b-03 F-01, F-03).
- Mesh uplink is "High (N-1 streams)", scale "2-5 participants" [BG1]. Chrome autoplays sound only after an interaction with the site, earlier media engagement on desktop, or installation [CRA].
- **Lab (measured 2026-10-20, Playwright 1.64.1, Chromium 156, WebKit 27.2):** Chromium's `--use-fake-device-for-media-stream` with `--use-fake-ui-for-media-stream` gives fake camera, microphone and screen; the fake-UI flag alone granted the machine's real camera and microphone. WebKit gives mock devices under context permissions, muted the first page's tracks when a second page of the same browser captured, and refused `getDisplayMedia` outside "a user gesture handler". Both connected with `iceServers: []`, applied `setParameters` and `replaceTrack(null)`, and targeted 32,000 bit/s audio. Offers 5,734 to 7,135 bytes, answers 5,440 to 5,787. Media Session `hangup` works only in Chromium.

## 2. Design options with costs

| Option | Effort | Running cost | Verdict |
|---|---|---|---|
| In-page smart seeding: lanes, budgets, windows, labels (S1 O2) | M to L | battery within budget | **C2** |
| Dock mode and keeper tab (S1 O5; S3's keeper in browser form) | S | the member's power; heat unmeasured (G-PS-5) | **C2** |
| Pin node: `tools/pin.mjs` plus `mw_pin1`, heartbeat, owner auto-accept, month cap | M | $0 on a machine already on; $4.00 a month VPS with 500 GiB (S2 F15) | **C2** |
| Super-seeded hand-off (S1 D4) | M | none | C2 behind a flag |
| Node-only pin; hub R2 copy at $0.015 per GB-month [CF1]; partial seeding (S1 D5) | M each | unmeasured; storage | P2 |
| Background Fetch, Periodic Sync, Web Push from a hub pin | M | data; a push sender | P3: HTTP and notices only |
| Keeper CLI, extension, desktop app, keeper pods, OS handler (S3 K1 to K3); native wrappers and push inbox (S1 O6 to O8) | M to L | installs, store fees | **rejected by the owner** |
| Audio-session trick, push-to-wake (S1 F3) | S | the person's battery | **rejected**: lies to the OS |
| One-box server with nip.io and Caddy (S2 O5) | S to M | $4 to $7 a month | **C2**, rung 2a |
| GitHub Pages, tunnels (S2 O3, O4, O7) | none | 0 | documented; tools never start tunnels |
| Mesh calls over SIG signalling, no media server | L | none; a relay only if the owner runs one | **C2** |
| Mixing server (SFU) at a hub | L | a server that sees media unless frames are end-to-end encrypted | out of scope |

## 3. The design

### 3.1 Smart seeding policy (amends ARCHITECTURE 8)

**3.1.1 Tiers.** T0 pin node (owner or hub infrastructure): durability. T1 keeper tab or dock mode (a member's open desktop tab, or a phone on a charger with the screen on): availability while open. T2 visitors (phones only while visible): peaks.

**3.1.2 Lanes in spending order** (S1 D1). **H Hand-off:** the member's own new items until a pin receipt or two complete peer copies exist; on by default everywhere, with the MF-45 per-upload card. **K Keep:** items the member chose to share, and the site torrent while sharing is on. **E Echo:** items already held, by copy deficit (target 3 complete online copies, chosen, for speed, not durability), then recency; rarest pieces first; skips what a pin keeps; never fetches what the person did not open. Ledger gossip stays outside the lanes.

**3.1.3 Budgets** (S1 D2, chosen; `seedBudget()` in `src/loader/seed-budget.js`; counters local, never a reward):

| Context | H | K | E | Session | Month (K + E) |
|---|---|---|---|---|---|
| Desktop, not metered | 1 MiB/s | 1 MiB/s | 256 KiB/s | none | 20 GB (Delivery Optimization default [MS1]) |
| Phone, Chromium, Wi-Fi by `connection.type`, charging, battery 50%+ | 1 MiB/s | 256 KiB/s | 256 KiB/s | 64 MiB | 1 GiB |
| Phone, Wi-Fi proven, unplugged, battery 50%+ | 512 KiB/s | 128 KiB/s | 0 | 32 MiB | 256 MiB |
| Phone, battery 20% to 49%, or nothing provable (iOS, Firefox) | 128 KiB/s; 512 after "I am on Wi-Fi" | 128 KiB/s after "I am on Wi-Fi" | 0 | 32 MiB | 256 MiB |
| Cellular, Save-Data, or under 20% unplugged | 128 KiB/s with the card | 0 | 0 | 16 MiB | 0 |
| Any phone, local wire (host-to-host pair) | 1 MiB/s | 512 KiB/s | 256 KiB/s | 128 MiB | not counted |
| During a call (3.5) | phones 128 KiB/s | phones 0; desktop halved while the call is bandwidth-limited | 0 | | |

K and E on phones stay behind "Share on this network" until the owner signs SZ-1; row 2 then becomes the one default-on case, asked once when it matters. Budgets are recomputed on charging, level, network, visibility, dock and call changes.

**3.1.4 Windows.** Open and visible: everywhere. Hidden phone: K and E lock at once (unchanged); H sends until the browser suspends the page (SZ-2; G-PS-8 hides it at +10 s). Dock mode: "Keep this screen on and share for 2 hours" (cap 8 h, chosen), Wake Lock, a dim page; ends on hide, unplug, battery under 20% (Chromium) or the cap; on iOS and Firefox the person declares "plugged in, on Wi-Fi". Keeper tab: a desktop tab in "Keep this site" mode shows what it keeps and its month counter.

**3.1.5 Evidence and labels** (S1 D6). E0 this device holds every piece; E1 complete bitfields on live wires within 60 s ("reported": a bitfield can lie; a phone sees at most 8 wires); E2 a spot-check answered (v0.4); E3 the web seed answered a probe within 10 minutes; E4 a `mw_pin1` receipt, or a pin heartbeat at most 15 minutes old listing the item. The SDK's `available` gains `{ tier, count, atLeast, reported, checkedAt }`. Never "forever"; never a number above its evidence; tracker counts only as "{n} connected to this site (tracker report)".

| Key | Text (English) | Needs |
|---|---|---|
| `avail.onlyHere` | Only on this device. Keep this page open until it is sent. | E0 alone |
| `avail.heldBy` | Kept by you and at least {n} others online now (reported) | E0, E1 |
| `avail.keptBySite` | Kept by the site (checked {age} ago) | E3 or E4 |
| `avail.nobody` | Nobody who has this is online right now. | none |
| `avail.noPin` | No always-on copy exists for this site. This file is available only while someone who has it is online. | no pin |
| `handoff.waiting` / `handoff.sending` | Waiting for the site to accept it. / Sending to the site: {pct}% | queued request / pin wire |
| `seed.monthUsed` | Sharing paused: this month's limit of {cap} is used. Your own uploads still go out. | month cap |
| `seed.ask` | Help keep this available? While this page is open and your phone charges on Wi-Fi, it shares what you keep, up to {cap} a month. Others can see your IP address and which files you share. | moment of value |
| `dock.on` | Keeping the screen on and sharing until {time}. Leave the page to stop. | dock mode |
| `meter.visit` | This visit: {p}% of the bytes came from {n} visitors, {h}% from the host. | counters |

**3.1.6 Hand-off, pin identity, heartbeat.** The pin's key is `_mw.cfg.pin` (R 2.5.5). `mw_pin1`, a BEP 10 extension on site and file torrent wires (JSON frames at most 1 KiB): the browser sends `{ t: 'chal', n }` (16 random bytes) once per wire; the pin answers `{ t: 'hello', key, ih, n, at, sig }` over `"mw-pin1-hello\n" + ih + "\n" + n + "\n" + at` and, once it holds every piece verified, `{ t: 'rcpt', key, ih, total, at, sig }` over `"mw-pin1-receipt\n" + ih + "\n" + total + "\n" + at` (ECDSA P-256, raw P1363, `|now - at|` at most 5 minutes). The pin writes a signed heartbeat `{ v: 1, t: 'mw-pin-status', key, site, at, items: [b64url of 16 bytes of SHA-256("mw-pin-status-v1|" + ih)], monthBytes, monthCap, sig }` at `<ws base>/pin-status.json` (hashed ids keep private infohashes private). The owner key's H items are requested and accepted automatically (SZ-6); members' items wait in the R 2.8.6 moderator queue. Target (chosen): 5 MiB reaches "Kept by the site" in under 60 s median on Wi-Fi. A page answers as a pin only when `tools/pin.mjs` exposes its Node signer; the key never enters the page.

**3.1.7 Partial seeding.** Keep whole: site torrents and items up to 8 MiB (chosen); slices of large media in v0.4; durability stays with full copies at pins.

**3.1.8 When the tab is gone.** A closed or suspended page seeds, relays, holds and rings nothing and keeps no call. The Service Worker still serves the site from cache and, where allowed, runs HTTP-only tasks: Background Sync retries, Periodic Sync refreshes the pointer and `cs=` snapshot, Background Fetch downloads web-seed bytes (all Chromium), Web Push shows a notice. None opens a peer connection.

**3.1.9 Contribution rules** (a lint run as a unit test): no silent or keep-alive media; no `navigator.audioSession` writes; Wake Lock only in `src/loader/dock.js` and `src/calls/session.js`; `getUserMedia` and `getDisplayMedia` only in `src/calls/`.

**3.1.10 Gate rows.** S1's G-PS-1 to G-PS-14 join DEMO-RESULTS; rows 1 to 4 run before any card describes phones in the background.

### 3.2 The zero-setup ladder (amends DEPLOY and QUICKSTART)

"exists": in `tools/*.mjs` today; `lightweb` names come with the phase D rename (until then `npx magnet-web`).

| Rung | Commands | Honest limit |
|---|---|---|
| 0 try | `npm run demo`; `node tools/demo.mjs --site ~/my-site --name my-site` (exist); `npx lightweb try ./my-site` (v0.4) | this computer only; open `localhost`, not 127.0.0.1 |
| 1 share on my LAN | `brew install mkcert nss && mkcert -install`, `node tools/demo.mjs --tls`; `adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000` (exist); `dev-server --tracker-proxy` (C2: tracker at `/tracker`) | each phone trusts the CA by hand; the CA key can read every trusting phone's secure traffic; client isolation and rebinding protection can block it |
| 2a rented server, no domain | `npx magnet-web ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org` (C2); by hand: S2 rung 2a, every flag exists | the name is the IP; nip.io is two volunteers and a block list; ports 80 and 443 must be reachable; no DNS pointer |
| 2b free static host | `publish --scope <user>.github.io ... --tr public --exp 399 --shell`, then QUICKSTART A3, A4 | public trackers only; no headers on GitHub Pages; the account can be closed |
| 2c hub link | `npx lightweb share ./my-site --hub <hub>` (v0.4); `npx magnet-web seed` (exists) | loads only while a pin or a seeder holds it |
| 3 own domain | QUICKSTART A1 to A6; DNS TXT in DEPLOY | move up with the same key and `--chain`: ledger, rendezvous and infohash stay, the origin changes |

**`ship` (C2).** Derives `a-b-c-d.nip.io` from `--ip`; `nameCheck` resolves it in Node, stops with S2's Z4 on the block page or another address and tries sslip.io; makes or reuses the owner key locally (never copied); publishes with `--chain <name> --ws https://<name>/ws/ --cs https://<name>/ws/genesis.json --tr wss://<name>/tracker --shell --exp 399` (SZ-3), without the 450-byte DNS warning for names that cannot carry TXT; rsyncs `site/` and `allow/allow.txt` to `<server>/deploy/one-box/`; writes `.env` (`LW_SITE`; `LW_ACME_CA` staging first, production after a staging certificate); runs `docker compose up -d` and `check-site`; prints Z1, Z2, Z3, Z6. It names every host before contacting it; `--dry-run` prints the commands.

**`deploy/one-box/` (C2).** S2's validated Caddyfile and compose change, with the `pin` profile building `deploy/pin/Dockerfile` (`PIN_URL=https://${LW_SITE}/`, a `mw-pin` volume, the heartbeat written to `site/ws/pin-status.json`); keep `caddy_data` (5 duplicate certificates a week, S2 F5); CI runs `caddy validate` and `docker compose config`.

**Loader and tools.** `shouldSkipDoh` skips IP-embedded `nip.io` and `sslip.io` names; `check-site` reports "DNS pointer: not possible for this name"; `ledger-admin cfg --calls off|contacts` and `publish --calls` (implies `--chat`; own tracker and STUN required). CLI strings: S2's Z1 to Z9 verbatim.

### 3.3 Adoption mechanics, chosen, with costs

| When | Mechanic | Effort | Basis |
|---|---|---|---|
| C2 | Evidence labels, hand-off states, carry meter, and the qualified line "Readers who agree help carry this site while their page is open" (never "every reader is a mirror") | M | S1 D6; S3 2.2 |
| C2 | Dock mode and keeper tab | S | S1 D3 |
| C2 | `ship`, one-box, LAN tracker proxy | M | S2 |
| C2 | Pin receipts and heartbeat: measured counts of keys, not people | M | S1 D4; S3 2.4 |
| C2 | Calls: a reason to be online together | L | 3.5 |
| v0.4 | `<mw-comments>` and `add comments` (works with no peers online) | S to M | S3 2.5 |
| v0.4 | `try`, classroom kit (QR, trust page, CA fingerprint), `share --hub` | M to L | S3 2.5; R7 5.3 |
| v0.4 | Owner `status` and the signed status badge; probed count of owner-listed pins | M | S3 2.2, 2.4 |
| v0.4 | Showcase hub H1a, lifeboat pages, Hugo and Astro plug-ins, host adapters | S each; M per adapter | S3 2.6 to 2.9; S2 Rc8 |
| v0.4 | `web+lightweb:` links (desktop only), Light Drop file, crawler shell | S; M; M | S3 2.3; R5 F12 |

No tokens, points, rankings or public per-member counts (ARCHITECTURE 8).

### 3.4 What cannot be done (plain words for FAQ, WHY, DEPLOY and the cards)

**On phones.** A phone stops sharing, passing on messages and keeping files available seconds after you leave the page or lock the screen (iPhone: about 20 seconds). No website can wake a phone to share: the background tasks browsers allow only make web requests. An iPhone gives web pages no background sync, no battery or network information, and a notification for every push. Safari deletes a site's saved data after 7 days without use; a Home Screen app keeps it. Android cuts the network of a phone that is unplugged, still and dark. On iPhone, call video stops when you leave the page, a Home Screen app loses the microphone too, and a phone call pauses it. Android browsers cannot share the screen. A call rings only while the site is open.

**Without a domain.** The address record lives in the page and expires; after that date new visitors cannot load the site until you publish again. A name made from the server's IP address changes with the IP, and visitors start again. nip.io is run by two volunteers with no uptime promise and blocks addresses used in phishing. A bare IP address cannot keep passkeys. Home connections behind carrier-grade NAT cannot be reached. Free hosts can close accounts; tunnels see everything and rename every run.

**Anywhere.** Without a pin node or a host copy, nothing stays available while nobody who has it is online. Peers see your IP address, and sharing a file shows which file you hold. Calls above 6 people (4 with video) need a mixing server, which v0.3 does not have. Plan for 10% to 30% of pairs needing a relay to connect (a planning range, not a measurement).

### 3.5 Peer-to-peer calls (C2 lane `calls`)

**Scope.** Signed-in members where `_mw.cfg.calls = contacts` (default `off`; needs chat on and the site's own tracker and STUN, MF-44): 1:1 with an accepted contact, or a mesh from a chat group (R 2.7.7) or the caller's contacts. Caps (chosen, SZ-4): 6 audio only, 4 with video. Shell and hub modes; drop-in answers `E_UNSUPPORTED` in C2 (a page load would end the call).

**Signalling.** SIG frames (0x0B, parsed and relayed like ENV, hop at most 4) carry plaintext kind `sig` (5) in the sealed box keyed by `K_pair` (R 2.7.4), in the smallest bucket that fits (offers and answers: 16,000). Body (JSON, at most 15,000 bytes): `{ v: 1, c: <callId, 16 bytes b64url>, k: 'ring'|'accept'|'decline'|'busy'|'offer'|'answer'|'ice'|'hangup'|'leave', s: <seq>, t, sdp?, cand?: [at most 16], media?: { a, v, s }, roster?: [at most 5 pubs], g?: <groupId> }`. Contacts or the named group's members only; never stranger-flagged or held; one pending ring per contact, at most 10 an hour; rings expire after 45 s; `t` within 60 s; rising `s`; duplicates dropped by `(c, s)` (chosen).

**Binding.** Offers and answers exist only inside SIG sealed with `K_pair`, which only the two parties can compute, so the `a=fingerprint` lines are authenticated end to end and the browser's DTLS check binds the media to the chat keys (no trust in a signalling service, unlike RFC 8827 4.3 [RFC1]); a contact verified with `chat.contacts.verify` gives a verified call. A stolen chat key impersonates in calls as in chat. A spoken safety code is P1.

**Flow and IP exposure.** ring (no SDP) -> callee card -> accept -> the caller creates its connection and sends the offer -> answer -> trickled `ice`. The callee creates no connection before accepting and the caller sends no candidate before the accept, so a declined or ignored call shows nobody's address. Then a negotiated data channel (`id 0`, `mw-call`) carries mute, camera, screen, roster, leave and renegotiation (perfect negotiation), independent of the swarm wires a phone rebuilds after 10 s hidden. Mesh: the caller sends the roster and offers to each person who accepts; other pairs connect once, the lower public key offering; a leaver's pairs close within 5 s.

**ICE and relay.** `iceServers` = the site's own STUN; TURN only with R 2.7.8 option (a) or (b) and its card; a relay forwards encrypted packets and sees both addresses, sizes and times, never content. "Hide my IP from people I call" sets `iceTransportPolicy: 'relay'` when a relay exists. Received private, loopback and link-local candidates are dropped unless both chose "same local network"; mDNS candidates pass; ICE restarts on network change.

**Media and adaptation** (per stream, chosen): audio 32 kbit/s (the measured default), 24 metered; video 800 kbit/s 1:1 at 640x360 on desktop and Wi-Fi, 400 in a mesh, phones 500 and 300; metered networks start audio only, and video there runs at 300 kbit/s scaled by 2; screen 1,200 kbit/s 1:1, 600 in a mesh, 15 frames a second, `contentHint 'detail'`. Every 2 s the loop reads `availableOutgoingBitrate`, `qualityLimitationReason`, loss and round-trip time: 5% loss or 4 s limited halves video (floor 100 kbit/s), then scales by 2 and 4, then pauses video, keeping audio; one step back after 10 s clean. Arithmetic: a 4-way video mesh sends 3 x (400 + 32) = 1,296 kbit/s; 300 kbit/s video is 2.25 MB a minute; audio about 0.4 MB a minute each way (with about 20 kbit/s of headers, assumed). Seeding yields (3.1.3); on phones torrent wires drop to their floors and call connections (at most 5) count apart.

**Platform handling.** Back to visible: re-acquire muted or ended tracks with `replaceTrack` [WKB1, WKB3]; on track `mute`, show "Your camera is paused by the browser"; Wake Lock during a visible video call; Media Session `togglemicrophone`, `togglecamera`, and `hangup` where supported; `getDisplayMedia` called inside the click handler.

**UI** (`src/loader/call-ui.js`, loader-owned, over the site frame, so it survives site navigation in shell mode): incoming card; mute, camera, screen, hang up; participants as ringing, connecting, direct, relayed, reconnecting or left; a ring sound only where the page may play sound [CRA], else a title flash and an Android vibration.

| Key | Text (English) |
|---|---|
| `call.start` | Call {name}? Your browsers connect directly, so {name} will see your IP address. Nobody else is in the media path. |
| `call.startRelay` | If a direct connection fails, the call goes through {operator}'s relay, which sees both IP addresses and how much you send, not what you say. |
| `call.incoming` | {name} is calling ({kind}). Accepting shows your IP address to {name}. [Accept with audio] [Accept with video] [Decline] |
| `call.group` | Join a call with {names}? Each of them will see your IP address. |
| `call.metered` | You are on mobile data, so the call starts with audio only. Video uses about 2 MB a minute. |
| `call.ios` | On iPhone, video stops when you leave this page, and an app on the Home Screen loses the microphone too. Keep this page open during the call. |
| `call.android` | Keep this page open during the call. Android may cut the connection when the screen is off. |
| `call.noPath` | Could not connect to {name} directly. Some networks block direct connections, and this site has no relay. |
| `call.screen` | Everyone in this call will see the screen or window you pick. |
| `call.notHere` | {name} is not connected now. Calls ring only while {name} has this site open. |
| `call.ended` / `call.declined` / `call.busy` | Call ended ({duration}). / {name} declined. / {name} is in another call. |

**SDK** (`mw.calls`): `start({ to: pub | [pubs] | groupId, video? })` UI; `accept(id, { video? })` UI; `decline(id)`; `hangup(id)`; `mute(id, on)`; `camera(id, on)`; `screen(id, on)` UI; `state(id)`, `list()`; `on('ring'|'state'|'peer'|'ended', fn)`; `mw.ready().features.calls`. The SDK never returns a `MediaStream` (same-origin code can still call `getUserMedia`; R 2.1 rule 2). New errors `E_BUSY`, `E_DECLINED`, `E_NO_ANSWER`, `E_MEDIA_DENIED`, `E_NO_DEVICE`, `E_CALL_FAILED`; reused `E_NOT_SIGNED_IN`, `E_HOST_ONLY`, `E_POLICY`, `E_NOT_CONTACT`, `E_PEER_UNREACHABLE`, `E_LIMIT`, `E_UNSUPPORTED`.

**End-to-end** (loopback, `iceServers: []`; Chromium always with both fake flags; WebKit with context permissions, one browser per participant, `getDisplayMedia` from `page.click`). **E-CL-1** (Chromium): ring, accept with video, connected within 10 s; audio and video bytes both ways; the remote certificate fingerprint (certificate stats) equals the one in the sealed answer; chat-lane bytes hold no `v=0`, `a=fingerprint` or `candidate:` text; mute and camera off reach the peer over `mw-call`; hang up closes both connections and ends every capture track. **E-CL-2** (Chromium): a group call of four from a context forced to the metered class is audio only; each context has 3 connected pairs with audio from 3 peers; a leaver's pairs close within 5 s; a video call to five people fails with `E_LIMIT`. **E-CL-1W:** E-CL-1 in two WebKit browsers, plus screen share. **E-CL-3:** a non-contact's ring creates no `RTCPeerConnection` (an init script counts them); after a decline no offer leaves the caller; host-only gives `E_HOST_ONLY`; `calls` off gives `E_POLICY`.

**Gate rows.** G-CL-1 1:1 audio, phone on LTE to laptop on Wi-Fi, 50 attempts: connect rate without a relay, time to connect. G-CL-2 iPhone Safari tab and Home Screen app: audio and video after 5 s, 30 s, 2 min hidden, on lock, during a phone call, recovery (iOS 26, 27). G-CL-3 Android tab and installed app, screen off, plugged and unplugged. G-CL-4 desktop mesh, 4 with video, 6 audio only: CPU, uplink, loss, jitter. G-CL-5 the same with two phones: battery, temperature. G-CL-6 screen share from desktops and iOS 27 Safari. G-CL-7 share of pairs needing the relay; relayed bytes a minute. G-CL-8 1 Mbit/s at 5% loss, and a Wi-Fi to LTE handover: time to recover audio. G-CL-9 call-card comprehension, 5 to 8 people.

## 4. Recommendations, P0 to P3

| Pri | Item | Effort |
|---|---|---|
| P0 | Owner signs SZ-1 to SZ-6 (section 6) before C2 starts | S |
| P0 | G-PS-1 to G-PS-4 and G-CL-2 on one iPhone and one Android before any card describes phones in the background | M |
| P0 | The seven C2 lanes (section 5): seeding and pin M each, zero-setup M, docs-strings M, calls with wire-ui L | M to L |
| P1 | Super-seeding by default after G-PS-8; spot-checks (E2); call safety code; desktop Picture-in-Picture calls; LAN QR and trust page; `publish --move` RFC; nip.io cookie probe (S2 Q3) | S to M each |
| P2 | Partial seeding after G-PS-10; Node-only pin; hub R2 copy; own-devices hand-off; bare-IP certificate rung; calls in the drop-in widget | M each |
| P3 | Web Push rings from a hub pin; Background Fetch and Periodic Sync uses; SFU with end-to-end frame encryption; WordPress plug-in, site packs, open hub (counsel); a PSL project domain | M to L |

## 5. Phase C2 build lanes

| Key | Model | Depends on | Owns (summary; exact lists in the lane JSON) |
|---|---|---|---|
| seed-policy | Opus | none | `policy.js`, `config.js`, new `seed-budget.js`, `seed-meters.js`, `seed-planner.js`, `dock.js`, `localwire.js`, the lint test |
| pin-node | Opus | none | `tools/pin.mjs`, new `src/pin/frames.js`, `src/pin/heartbeat.js`, `deploy/pin/*`, `test/vectors/pin.json`, tests, a pin fixture |
| calls | Opus | none | new `src/calls/*`, `src/chat/service.js` (SIG hook), tests, `test/vectors/calls.json`, `test/e2e/scenarios-calls.mjs`, `test/fixtures/calls/` |
| zero-setup | Sonnet | none | new `ship.mjs`, `name-check.mjs`, `deploy/one-box/*`; `publish`, `ledger-admin`, `dev-server`, `demo`, `check-site`, the bin, `doh.js`, CI, DEPLOY, QUICKSTART, FAQ |
| docs-strings | Sonnet | none | `src/loader/strings.js`, ARCHITECTURE, INTERFACES, COMPATIBILITY, PRIVACY, DEMO-RESULTS, ROADMAP, WHY, SECURITY-MODEL, THREAT-MODEL, docs/README |
| seed-engine | Opus | seed-policy, pin-node | `torrent.js`, new `availability.js`, `superseed.js`, `pinwire.js`; files and media `lane.js`, `service.js` |
| wire-ui | Opus | seed-policy, seed-engine, calls, docs-strings | `app.js`, `api.js`, `bridge.js`, `ui.js`, `ui.css`, new `call-ui.js`; `sdk.js`, `sdk-static.js`, `binding.js`, SDK.md |

Every lane edits files of phase C lanes (pin-node: the tools lane's `pin.mjs`) or of its integrators (ARCHITECTURE, INTERFACES), so all start after phase C's final integration. The C2 integrator owns `test/e2e/run.mjs`, `lib.mjs`, INTEGRATION-STATUS, DEVIATIONS, `LOCK.json`, the `formats-vectors` and `docs-links` tests (adding `docs/research/v03` to its search list), CHANGELOG, `package.json`, `build.mjs`, `dist/`, and adds E-PS-1 (hand-off to a pin fixture, receipt, label), E-PS-2 (lying bitfields stay "reported"), E-PS-3 (the month cap stops K and E, not H), E-PS-4 (dock mode Wake Lock taken and released), E-ZS-1 (no DoH query for a nip.io name).

## 6. Open questions and owner decisions

- **SZ-1:** Phones run K and E by default in the one provable case (Chromium, Wi-Fi by `connection.type`, charging, battery 50%+) after the consent card? It reverses ARCHITECTURE 8 ("off until Share on this network").
- **SZ-2:** H keeps sending after the page is hidden, until the browser suspends it?
- **SZ-3:** Rungs without DNS default to `--exp 399` with a printed re-sign date, or keep 90 days as a retention clock (S2 Q7, S3 2.11)?
- **SZ-4:** Call caps 6 audio and 4 video; audio only by default on metered and unknown networks.
- **SZ-5:** Without a relay plan for 10% to 30% of pairs failing; offer R 2.7.8 option (a) for calls?
- **SZ-6:** The pin accepts the owner key's own items without the moderator queue (amends R 2.8.6 "never automatic" for the owner only).
- Open: does R 2.10.2's `_mw.cfg` schema accept `calls`? What does Android do to a call with the screen off (G-CL-3)? Does super-seeding break Fast Extension (S1 Q4)? Will counsel accept "Others can see which files you share" (S1 Q7)? Who answers abuse notices for one-box sites?

## 7. Sources

Read 2026-10-20 unless dated; S1 to S3 resolve their own ids.

- [BCD] MDN browser-compat-data, `api/MediaDevices.json`: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaDevices.json
- [RFC1] RFC 8827, sections 4.3, 6.4, 6.5, 9.1: https://www.rfc-editor.org/rfc/rfc8827.html
- [WKB1] WebKit bug 204681, comments 1 and 5 by a WebKit engineer (2019-12-03, 2020-03-23): https://bugs.webkit.org/show_bug.cgi?id=204681
- [WKB2] WebKit bug 239602, reports of 2022-04-21 and 2023-12-26, open: https://bugs.webkit.org/show_bug.cgi?id=239602
- [WKB3] [s] WebKit bug 208516 (re-acquire, `replaceTrack`): https://bugs.webkit.org/show_bug.cgi?id=208516
- [BG1] bloggeek.me glossary, SFU (updated October 2026): https://bloggeek.me/webrtcglossary/sfu/
- [CRA] Chrome autoplay policy (last updated 2017-09-13): https://developer.chrome.com/blog/autoplay
- Lab: [c2-calls-lab](../labs/c2-calls-lab/README.md) (`probe.mjs`, `results-2026-10-20.json`). Repository: w2b-03 F-01, F-03; R 2.5.5, 2.7 to 2.11; ARCHITECTURE 8, 15.10; `src/chat/frames.js`, `limits.js`, `service.js`.
