# S1: Smart phone seeding for Lightweb

- **Date:** 2026-10-20. **Applies to:** magnet-web 0.2.1 going to 0.3, being renamed Lightweb. **Status:** research and design proposal; nothing here is built or binding until the owner signs off.
- **Question (owner, 2026-10-20):** phones seed badly; can smart, dynamic policy make phone seeding reliable, and what should we rely on phones for? IP visibility to peers is accepted as the premise of the light web.
- **Method:** project files read (ARCHITECTURE 8 and 15; `policy.js`, `torrent.js`, `config.js`; `tools/pin.mjs`, `seed.mjs`, `publish.mjs`, `dev-server.mjs`; R5; R8; V03 review; judge-scale; w1-08; DEPLOY; QUICKSTART) and vendor pages opened with WebFetch on 2026-10-20 (ids in Sources). Arithmetic ran in a local Node script. No phone was used, no browser launched, nothing ran against a non-local address.
- **Labels:** *documented* (page read), *reported* (forum, bug thread, secondary article, or a search result whose page was not opened: [s]), *arithmetic* (from stated inputs), *chosen* (a parameter a gate row confirms), *unmeasured* (no published number; none invented). Effort as R5: S under a week, M one to four weeks, L more.

## Summary

1. **Answer.** Phones cannot be reliable seeders of other people's content, and no policy changes that. They can be reliable at three things: not losing what the member made (hand it to an always-on holder before the page closes), giving useful bytes while the page is open (inside a budget), and telling the truth about availability (D9 gives the per-platform table). Swarm reliability comes from a durability tier: the owner's always-on desktop (a pin-light) and, where one exists, a hub pin. Pins are the base load, desktops the shoulder, phones the peak shavers (25 open phones at 128 KiB/s offer 3.1 MiB/s together; arithmetic).
2. **What the platforms forbid (documented, F1, F2).** iOS: once suspended, "all low-level networking stops"; WebKit's suspension timer is 20 s; Safari has no Background Sync, Periodic Sync or Background Fetch; every push must show a notification; no battery or network API. Android: cached processes may get "limited or no execution time"; Doze cuts the network when the phone is unplugged, still and dark, and ends when a charger connects. A service worker cannot hold a WebRTC connection (`[Exposed=Window]`), so no wake-up mechanism can seed.
3. **The arithmetic decides (F6).** Independent-uptime model: a phone open an hour a day (p = 4.2%) needs 108 holders for 99%; a plugged-in phone with the screen on for 8 h (p = 33%) needs 12; a 99% pin needs 1. Ten full copies at p = 5% reach 40%; twenty half copies, same storage, 0.06%. Phone count never buys durability; partial seeding never buys whole-item availability.
4. **Smart seeding is three lanes in spending order (D1).** Hand-off (the member's own new items until a durable holder has them), Keep (items the member chose to share, and the site), Echo (items already held, fewest copies first, rarest pieces first, good states only). Echo skips what a pin keeps and never fetches what the person did not open (R8 F9, V03 2.8.4).
5. **Budgets (D2).** By device, network proof, power state and visibility; a monthly cap; local-network wires outside it. Default on only where cheap and provable (Chromium, proven Wi-Fi, charging, battery 50% or more); elsewhere asked once, when the person posts or keeps something.
6. **Hand-off is the reliability feature (D4).** A pull-based pin (no new endpoint), super-seeded to the pin first (BEP 16: "105%" uploaded against "150% to 200%"), with honest states from "Only on this device" to "Kept by the site".
7. **Honest labels need evidence tiers (F8, D6).** A scrape counts partial holders as "incomplete" (BEP 21), a phone sees at most 8 wires, a bitfield can lie. The UI says "at least N online now" with its age, and "Kept by the site" only when a pin authenticates and a probe or receipt is fresh.
8. **Innovations that survive scrutiny:** local-network wires outside the data cap; super-seeded hand-off; dock mode (an old phone on a shelf is an honest, screen-on pin); echo that idles when a pin exists; evidence-tier labels.
9. **Rejected.** The audio-session trick (Chrome: "a silent audio track doesn't count"; it tells the OS the page plays media when it does not). Push-to-wake (WebKit: Web Push "is not an invitation for silent background runtime"). Native wrappers before the web path is measured.
10. **Measurements missing.** No published measurement of WebRTC or BitTorrent seeding battery on a current phone was found; nearest: LTE "as much as 23 times less power efficient" than Wi-Fi (2012), Android's 18 s radio tail. The gate needs 14 rows (D8); the first four are P0.

## Findings with sources

### F1. What each platform allows

Source ids are in Sources. "Inference" marks a statement no source makes.

| Platform | Documented limits | What it adds |
|---|---|---|
| iOS Safari tab (every iOS browser is WebKit) | WebKit: `processSuspensionTimeout { 20_s }` after a prepare-to-suspend message [WK6]. Apple DTS, about native apps (the web process is suspended the same way: inference): "Once your app gets suspended, however, all low-level networking stops" [AP1], WebSockets and WebRTC alike. No Background Sync, Periodic Sync or Background Fetch [ST1]. Push is "not an invitation for silent background runtime"; breaking `userVisibleOnly` revokes the subscription [WK1]. No Battery, Network Information or Device Memory API, "decided to not yet implement" [WK5]. Script-writable storage is deleted "after 7 days" without user interaction [WK5] (plan for 7; w1-08 summary 6). | Screen Wake Lock since 16.4 [ST1]. |
| iOS Home Screen web app | Same suspension rules; no source gives it more background time (inference). | Exempt from the 7-day cap [WK5]; Web Push since 16.4 [WK2, WK3]; Declarative Web Push and Wake Lock since 18.4 [WK3, ST1]; on iOS 26 every site added to the Home Screen opens as a web app [WK4]. |
| iOS native wrapper | The web view keeps the web rules. BGProcessingTask "can take minutes to complete", flags `requiresExternalPower` and `requiresNetworkConnectivity` [AP3]; iOS schedules such activity adaptively and unpredictably [MB1]. BGContinuedProcessingTask (iOS 26): starts in the foreground, Live Activity progress, little-progress tasks ended [AP4]. App Store 2.5.4 limits background services to "VoIP, audio playback, location, task completion, local notifications, etc."; 2.4.2 bars "unrelated background processes" [AP5]. Mobius Sync: "No iOS app can run continuously in the background", "1-2h of sync activity per day" once stable [MB1]. Briar has no iPhone app for this reason (2018) [BR1]. | URLSession background sessions keep HTTP transfers going while suspended [AP1]. $99 a year [AP7]. |
| Android Chrome tab (Samsung Internet, Edge: inference) | Cached processes "may receive limited or no execution time" (Android 13+) [AN2]. Doze (unplugged, still, screen off) suspends the network and defers JobScheduler and WorkManager; "connecting a charger" exits Doze and App Standby releases apps [AN1]. Chrome's intensive throttling starts after 5 min hidden and spares a page with an open data channel [CH3]; WebRTC is also among protections against discard [CH4]; Chrome 133+ Energy Saver freezing of hidden CPU-heavy tabs exempts it too, platform unnamed [CH5]. What Chrome for Android does to an open channel when the screen goes off is unmeasured. OEM battery managers add risk (Samsung, Xiaomi, OnePlus, Huawei rated worst in an undated community list) [DK1]. | `getBattery` (Chrome 38+), `connection.type` on Android (38+), `saveData` (65+) [ST1]. |
| Android installed PWA | As the tab (inference). One-off Background Sync since Chrome 49 [ST1]. Periodic Sync: installed only, "won't be fired at all unless the engagement score is greater than zero", runs "a few minutes at a time" [CH1]. Background Fetch since Chrome 74; the only official page (2018) says "currently only accepts requests without a body" [CH2, ST1]; later change unverified. | |
| Android native wrapper | WorkManager: 15 min minimum, constraints such as charging plus `UNMETERED`, timing not guaranteed [AN6]. Foreground service `dataSync`: 6 h per 24 h on Android 15+, reset when the user brings the app forward [AN3]; every type declared and reviewed in Play Console [AN10]. User-initiated data transfer jobs (Android 14) need a notification and may run long [AN5]. Play bars asking for a Doze exemption unless the core function suffers [AN1]. | $25 once [AN11]. |
| Extensions | Chrome MV3 offscreen document, reason `WEB_RTC`: "All other reasons don't set lifetime limits" [CH6]. Chrome for Android: no general support in the reports found [CR1, s]. Firefox Android: API subset, processes killed [FX1]. iOS Safari: "you must make your background page nonpersistent" [AP6]. | Little over a pin-light. |

### F2. Why no wake-up mechanism can seed

- `RTCPeerConnection` is `[Exposed=Window]` in the W3C WebRTC Recommendation of 13 March 2025 [ST2]. Push, Background Sync, Periodic Sync and Background Fetch run in a service worker: HTTP and notifications, never a swarm wire. A perfect wake-up still cannot seed.
- Web Push needs a sender (a server); iOS requires a visible notification per push [WK1]; Declarative Web Push drops the service worker, not the notification [WK3].
- The only documented way to keep a page in the foreground is Screen Wake Lock: screen on, released when the page is hidden (w1-08 R-16). The honest basis for dock mode (D3).

### F3. The audio-session trick, and why it is a dark pattern

- **What it is.** Set `navigator.audioSession.type = 'playback'` and loop a silent media element so the OS treats the page as a media player and does not suspend it. WebKit fixed Web Audio suspension in the background on 2024-03-01; reporters disagree on whether a silent element helps [WK7].
- **It is fragile.** Chrome: "a silent audio track doesn't count" [CH3]. The W3C draft defines an audible context as sending "non-zero samples"; its privacy and security sections are empty [ST3].
- **Why it is a dark pattern.** (1) It tells the OS something false: no media plays. (2) The cost lands on the person without consent: battery, a Now Playing entry, audio focus (the draft says playback sessions "should not mix with other playback audio") [ST3]. (3) It serves the site, not the person, and invites the fix that closes it. (4) In a wrapper it risks App Store 2.4.2 and 2.5.4 [AP5].
- **What stays legitimate.** Real playback of media the member chose keeps the page alive by design; seeding that item within budget is fine. Wake Lock in dock mode is visible, revocable and does what it says.

### F4. Signals a page can read

| Signal | iOS (any browser) | Android Chrome, Samsung, Edge | Firefox Android | Desktop |
|---|---|---|---|---|
| Battery, charging | none [WK5] | `getBattery` [ST1] | removed in 52 [ST1] | Chromium only |
| Network type | none [WK5] | `connection.type` [ST1] | removed in 99 [ST1] | Chrome: ChromeOS only [ST1] |
| Data saver | none | `saveData` [ST1] | none | none |
| Metered truth | none | Wi-Fi is "a poor proxy" for unmetered [AN8] | none | none |
| Local network | ICE candidate pair type via `getStats` on all (`networkType` was deprecated for privacy [s]) | | | |
| Intent | user-declared: the only reliable signal on iOS | | | |

### F5. Battery and data: what has been measured

- **Nothing direct.** No page found measures WebRTC or WebTorrent seeding battery on a current phone; a 2012 IETF mobile WebRTC draft names keepalives as the main idle cost, without numbers [s].
- **Radio.** LTE "as much as 23 times less power efficient compared with WiFi", the long high-power tail "a key contributor" (MobiSys 2012 user traces) [AC1]. Android: a transfer session draws radio energy "for at least 18 seconds", so one second of transfer three times a minute keeps the radio active (w1-08 F-13). ICE consent checks run about every 5 s per connection (RFC 7675, w1-08 F-13), so an open cellular wire keeps the radio awake with no piece moving (judge-scale 2.8).
- **A home device as proxy.** A 2010 study ran BitTorrent on home routers and desktops and pushed content to phones in bursts, improving phone energy efficiency [AC2]: the pin-light idea.
- **Delivery Optimization defaults [MS1].** "By default, devices won't upload while on battery" (40% suggested as the floor if enabled); monthly upload cap 20 GB; no peering over VPN by default; LAN peers are outside its download bandwidth limits.
- **Arithmetic.** 128 KiB/s is 0.472 GB an hour. A 256 MiB monthly cap is gone in 34 minutes at 128 KiB/s and 8.5 minutes at 512 KiB/s: the cap binds before the rate, so spend it on the highest-value bytes.

### F6. Availability: why phones cannot carry durability

Model (arithmetic): each holder is online and allowed to serve with probability p, independently; availability at a random instant is 1 - (1 - p)^r. Real uptime is correlated (evenings; inference), so night-time availability is worse. The 8 h overnight window is an assumption: no neutral charging-habit dataset was found. The Poisson form reproduces judge-scale 2.4 to within a point.

| Holder | p | Holders for 90% | 99% | 99.9% |
|---|---|---|---|---|
| Phone, page open 20 min a day | 1.4% | 164 | 327 | 490 |
| Phone, 1 h a day | 4.2% | 54 | 108 | 161 |
| Phone, 2.4 h a day | 10% | 22 | 44 | 66 |
| Phone or desktop, 8 h (dock, overnight) | 33% | 6 | 12 | 18 |
| Pin on a machine that is on 95% of the time | 95% | 1 | 2 | 3 |
| Pin at 99% | 99% | 1 | 1 | 2 |

- **A pin plus helpers.** Owner desktop at 60% uptime alone: 60%; plus 25 one-hour phones: 86%; plus 25 seven-hour desktops: 100%. A 99% pin plus 25 phones: 99.7%. Phones add points, not durability.
- **Partial seeding does not raise whole-item availability.** A 64-piece item at p = 5%, same total storage: 10 full copies 40.1%; 20 halves 0.06%; 40 quarters 0.00%. At p = 33% and 20 copies' worth of storage: full 100%, halves 96%, quarters 94%. Slices pay off when many holders are online together (dock mode, peaks) or readers need ranges (video seek).
- **The replication form is not the lever.** Coded or replicated, the binding term is holder uptime, which neither raises.

### F7. What the code does today

- `computePolicy` (`policy.js`): every mobile class has `uploadLimit: 0`; "Share on this network" gives 128 KiB/s; phones lock every wire when hidden and rebuild after 10 s; phone wire budget 8 (`config.js`, ARCHITECTURE 8). `torrent.js`: choke lock, per-file `uploadException` (MF-45), stores retained across `rebuild()`, `_leaveFile` once a file is saved. `readBattery` is wired (`app.js` 888) but only the desktop "hidden on battery" path uses it; nothing gates uploads on charging or level.
- Missing: lane meters and monthly counters, an availability estimate, a seed planner, partial selection, super-seeding, local-network detection, a pin identity on the wire. `src/chat/lane.js` already has a three-way device class (iOS relays nothing; Android 8 KiB/s and 2 MiB a session after opt-in; desktop 64 KiB/s); reuse it.
- Pin side: `tools/pin.mjs` runs Chromium ("$0 to about $6 a month", cost per site unmeasured, no heartbeat; DEPLOY). `tools/seed.mjs` already seeds a published site from Node over WebRTC with the optional `node-datachannel`, no Chromium. `src/chain/stores.js` has only memory and IndexedDB block stores, so a Node ledger peer needs a file store.

### F8. Availability signals without a backend

- **Tracker scrape** (BEP 48: `complete`, `incomplete`, `downloaded`) [TO3]. BEP 21 says partial seeds are counted as "incomplete" [TO2], so a scrape under-counts exactly the holders partial seeding creates. `tracker.openwebtorrent.com` closes the socket on a scrape (`torrent.js` header); the site's own tracker answers. Use it only for "N connected to this site".
- **Bitfields.** WebTorrent keeps a rarity map from wire bitfields (`node_modules/webtorrent/lib/rarity-map.js`) for rarest-first downloading. libtorrent's `distributed_copies` is the same measure: the integer part is the copies of the rarest piece, the fraction the share of pieces with more [TO4]. A phone sees at most 8 wires: any count is a sample, "at least".
- **Lying.** A peer can advertise a full bitfield and serve nothing. A spot-check (one random piece from a claimed holder, SHA-1 verified) costs one piece: desktops and dock mode can afford it; phones label unverified counts "reported".
- **Pin evidence.** `probeWebseed` shows a host holds the bytes. Today `src/media/lane.js` `_available` returns "kept" from a `ws` field or a pinned flag, with no probe or authentication.

## Design options with costs

### D1. Lanes, in spending order

| Lane | What | Runs | Rule |
|---|---|---|---|
| H Hand-off | The member's own new posts, files and media, until a durable holder has them | Always, with the per-upload card (MF-45) | Highest value: the only copy. Ends at "Kept by the site" or two other verified complete holders |
| K Keep | Items the member chose to share ("Help share this file", saved items) and the site while sharing is on | After one opt-in | Counts against the monthly cap |
| E Echo | Other items already held, ordered by copy deficit, then recency; rarest pieces first | Only where D2 gives E a rate | Skips any item a pin keeps. Target 3 complete online copies, for performance not durability (chosen; 3 phone copies are 12% available, F6). Never fetches what the person did not open |

"Authors seed what they made" is H. "Viewers re-seed what they read" is E, plus K for items they chose. Re-seeding shows peers and the tracker which items a member holds, more than an IP address: keep one site-level sentence on E and "Others can see which files you share" on each K item.

### D2. Budgets (all chosen; the gate confirms or tunes)

| Context | H | K | E | Session | Month (K+E) |
|---|---|---|---|---|---|
| Desktop, not metered | 1 MiB/s | 1 MiB/s | 256 KiB/s | none | 20 GB (Delivery Optimization default [MS1]) |
| Phone, Chromium, proven Wi-Fi, charging, battery 50%+ (the one default-on case, after the consent card) | 1 MiB/s | 256 KiB/s | 256 KiB/s | 64 MiB | 1 GiB |
| Phone, proven Wi-Fi, unplugged, battery 50%+ | 512 KiB/s | 128 KiB/s | 0 | 32 MiB | 256 MiB |
| Phone, battery 20 to 49%, or nothing provable (iOS, Firefox Android) | 128 KiB/s; 512 after "I am on Wi-Fi" | 128 KiB/s after "I am on Wi-Fi" | 0 | 32 MiB | 256 MiB |
| Cellular, Data Saver, or battery under 20% unplugged | 128 KiB/s with the card | 0 | 0 | 16 MiB | 0 |
| Any phone, local wire (host-to-host candidate pair) | 1 MiB/s | 512 KiB/s | 256 KiB/s | 128 MiB | not counted |

The hidden lock stays (a phone has 5 to 20 s, F1). Unplugging on Chromium drops a phone to row 3. Counters are local, never a reward (ARCHITECTURE 8, no incentive layer). A local wire costs battery, not data; Delivery Optimization likewise leaves LAN peers outside its download limits [MS1]. Chat keeps its `relayBudget`.

### D3. Windows

- **Open and visible:** all platforms, the default.
- **Dock mode (S):** "Keep this screen on and share for 2 hours" (cap 8 h, chosen) using Wake Lock. On iOS and Firefox Android the person declares "plugged in, on Wi-Fi". Ends on hide, unplug or level under 20% (Chromium), or the cap; shows a dim black page. The only web route to p up to 33% (8 h) on a phone (F6); on the person's word it applies D2 row 2. An old phone left on a charger runs it permanently: an honest, screen-on pin; battery health and heat are unmeasured (G-PS-5).
- **Native windows (O7, O8):** WorkManager (charging, unmetered) or an iOS background task, not before the web path is measured.

### D4. Hand-off: pull-based pin, super-seeded

1. The phone announces the item on the site's own tracker (private swarm, never the public default trackers, MF-44).
2. A pin (pin-light or hub pin; the owner's own posts automatically, others through the moderator queue, V03 2.8.6) joins and pulls.
3. Super-seed: the phone sends an empty bitfield, then `have(i)` for one piece at a time to the pin first, the next only after the pin has it. BEP 16: a plain seed "might have to upload 150% to 200%", a super-seed managed "105%" [TO1]. The vendored WebTorrent 3.0.21 sends `wire.bitfield(...)` at `torrent.js` line 1494, so this is a wrapper in `_onWire`.
4. The pin verifies, writes to disk (optionally copies to R2 and fills `ws`), and returns a signed receipt over the wire.
5. The UI moves from "Only on this device. Keep this page open." to "Sending to the site: 62%" to "Kept by the site".

Arithmetic: 25 MiB takes 200 s at 128 KiB/s, 50 s at 512 KiB/s, 25 s at 1 MiB/s; at 128 KiB/s super-seeding is 210 s against 300 to 400 s. WebKit's 20 s moves about 2.5 MiB at 128 KiB/s, so hand-off keeps the page visible (offer Wake Lock for the transfer). Target (chosen): 5 MiB reaches "Kept by the site" in under 60 s median on Wi-Fi (10 s of transfer at 512 KiB/s plus unmeasured setup). With no pin: "No always-on copy exists for this site. This file is available only while someone who has it is online." Static buckets cannot ingest from phones (judge-scale 2.7: no credential endpoint), so the always-on side must be a pulling node. The swarm path to a pin-light needs no stable name (browsers reach it through the tracker and ICE); only the HTTP `ws=` entry and the loader origin do, and a name derived from an IP changes with the IP, forcing a pointer re-sign (certificates: another topic).

### D5. Partial seeding and rarest first

Rarest-first here ranks pieces by durability gap, not download speed. Keep whole: site torrents and items up to 8 MiB (chosen). For larger media keep the head (poster and first chunk, which V03 2.9.5 places first) plus slices: piece i is kept when H(member key, infohash, i) falls under the member's fraction, topped up from the rarity map with `select`, `deselect` and the retained bitfield. The vendored `bittorrent-protocol` has no BEP 21 `upload_only` flag, so a partial holder looks like a peer that never asks for the rest. Slices serve ranges, peaks and dock mode; durability stays with full copies at the pin.

### D6. Availability labels, honest by construction

Evidence tiers (windows chosen): **E0** this device holds every piece, verified. **E1** complete bitfields on live wires in the last 60 s. **E2** a holder answered a spot-check. **E3** the web seed answered a probe in the last 10 minutes. **E4** a pin authenticated on a wire with a complete bitfield, or returned a receipt.

| Label | Needs |
|---|---|
| Only on this device | E0 and none of E1 to E4 |
| Kept by you and 3 others online now | E0 plus an E1 count of 3 ("at least 3" when the wire cap bounds it; "reported" without E2) |
| Kept by the site (checked 4 min ago) | E3 or E4, with its age |
| Nobody who has this is online right now | no E0 and none of E1 to E4 |

Never show a number above the evidence. Scrape counts appear only as "N connected to this site". No "forever". A "Why?" line lists the evidence. Private media shows own devices and grants only.

### D7. Options and costs

| Option | Effort | Running cost | Gain | Limit | Verdict |
|---|---|---|---|---|---|
| O1 Status quo (phones download only) | none | none | none | authored media is lost when the page closes | no |
| O2 In-page smart seeding (D1 to D6) | M to L | battery within budget | hand-off, peaks | foreground only | yes |
| O3 Pin-light: extend `tools/seed.mjs` | M | $0 on a machine already on | durability tier, LAN hand-off | machine sleeps; Node ledger peer needs a file store | yes |
| O4 Hub pin plus R2 copy | M | $0.015 per GB-month, 10 GB free, egress free [CF1]; 100 GB is $1.35 a month (arithmetic) | durability without the owner's machine | central storage by definition and must be worded so (judge-scale M10) | optional |
| O5 Dock mode | S | battery, heat unmeasured | p up to 33% | screen on | yes |
| O6 Push inbox (HTTP PUT to the pin) | M | an endpoint to run | background hand-off for wrappers | the one write endpoint | only with a wrapper |
| O7 Android wrapper | L | $25 [AN11], Play review, 6 h per 24 h | charging-window seeding | notification, upkeep | after the gate |
| O8 iOS wrapper | L | $99 a year [AP7], App Store review | background upload | "minutes", unpredictable | later |
| O9 to O12 Desktop extension; audio-session trick; Web Push to wake; coded redundancy | M; S; M; L | none; the person's battery; a sender; CPU, storage | little over O3; none lasting; notices only; none on uptime (F1, F3, F2, F6) | | no; reject; reject for seeding; research |

### D8. Measurements the release gate must add

Phone rows need HTTPS: the demo's `--tls` tier with the mkcert root on the phone (DEPLOY, "HTTPS and phone demos") and a Node pin-light on the LAN logging when each wire closes. Nothing is quoted before its row has run; failures are published too.

| Row | Measures | Device |
|---|---|---|
| G-PS-1 | iOS Safari tab: seconds from lock to last wire close (5, 10, 20, 60 s) | iPhone, iOS 26 and 27 |
| G-PS-2 | same, Home Screen app | iPhone |
| G-PS-3 | Android Chrome tab, screen off, unplugged and plugged (1 to 60 min) | two phones, one Samsung |
| G-PS-4 | same, installed PWA | Android |
| G-PS-5 | dock mode 2 h: Wake Lock held, wires alive, battery, temperature, bytes | iPhone (tab, Home Screen), Android |
| G-PS-6 | 30 min on Wi-Fi and LTE at 0 wires, 8 idle wires, 128 and 512 KiB/s (Battery Historian, iOS energy log) | both |
| G-PS-7 | data per hour of idle wires on LTE | both |
| G-PS-8 | hand-off of 5 and 25 MiB, Wi-Fi and LTE, 50 attempts, with and without super-seeding, page hidden at +10 s | both |
| G-PS-9 | label accuracy against synthetic swarms with known holders and liars, 8 wires | phone, Node peers |
| G-PS-10 | echo lane, 14 days on staging: copies over time, bytes per added copy | staging |
| G-PS-11 | candidate pair types on LAN, hotspot, VPN, IPv6-only | Safari, Chrome, Firefox |
| G-PS-12 | pin-light, 14 days: uptime, sleep and wake recovery, CPU, RAM | macOS or Windows |
| G-PS-13 | kept pieces after 8 days, Safari tab against Home Screen (extends G16) | iPhone |
| G-PS-14 | comprehension of each label, 5 to 8 people (as G-ID-9) | any |

### D9. What "reliable" can mean, per platform

| Platform | Reliable can mean | Reliable cannot mean |
|---|---|---|
| iOS Safari tab or Home Screen app | The member's post reaches a pin while the page is visible (G-PS-8); what they read stays on the device (7 days of no use in a tab, exempt in a Home Screen app); labels tell the truth | Seeding with the screen locked or the page hidden for more than about 20 s; waking the page; any battery or network signal |
| Android Chrome tab or installed PWA | The same, plus a charging window in dock mode (Doze ends on a charger) and battery and network gating | Seeding with the screen off and unplugged; Periodic Sync as a seeder (HTTP only); OEM battery managers behaving |
| Android native wrapper | Seeding in charging plus unmetered windows, or up to 6 h per 24 h as a foreground service with a notification | Always-on, free of upkeep, free of Play review |
| iOS native wrapper | Background HTTP upload to a pin that runs an inbox (O6); opportunistic tasks of "minutes" | Continuous seeding (1 to 2 h a day reported) |
| Desktop tab | Seeding while the tab stays open | Surviving a closed browser or a sleeping laptop |
| Pin-light or hub pin | Always-on while the machine is on and reachable: the durability tier | Surviving a switched-off machine or an operator who removes it |

## Recommendations (P0 to P3, with effort)

| Pri | Item | Effort |
|---|---|---|
| P0 | Run G-PS-1 to G-PS-4 (one iPhone, one Android) before any card or document says what phones do in the background | M |
| P0 | Availability labels (D6) for files and media; remove or qualify any "kept" wording that lacks E-tier evidence | S |
| P0 | Hand-off states and a keep-awake offer on phone uploads; "sent" only when a peer or pin holds every piece (extends MF-45) | S |
| P0 | Pin-light: extend `tools/seed.mjs` to pull queued file and media torrents, keep a ledger snapshot, sign a heartbeat, obey a byte budget (needs a file block store) | M |
| P0 | Seed budget module: per-lane meters, session and month caps, the three-way device class shared with chat `relayBudget`, `computePolicy` returns `seedBudget` | M |
| P0 | Contribution rules and a lint: no keep-alive media, no silent audio, no wake lock outside dock mode (F3) | S |
| P1 | Seed planner (pure, tested): lanes, deficit, recency, rarest-first, skip what a pin keeps | M |
| P1 | Pin identity on the wire and a `pn=` pointer field (a freeze-window decision) | S, then M |
| P1 | Super-seeded hand-off behind a flag | M |
| P1 | Local-network detection from candidate pairs; local wires outside the cap | S to M |
| P1 | Dock mode (Wake Lock); battery and network gating on Chromium; declared Wi-Fi and plug on iOS and Firefox | S |
| P1 | Spot-check of claimed holders ("reported" against "verified"); pin probe and heartbeat age in the UI | M |
| P2 | Partial seeding for large range-read media, after G-PS-10 | M |
| P2 | Hub pin: the pin-light copies to R2 and fills `ws`; cost table into DEPLOY | M |
| P2 | Android wrapper decision after G-PS-3, 4 and 6; old-phone-as-pin recipe with a safety note | L, S |
| P3 | iOS wrapper; push inbox; Declarative Web Push "new post" notices from the pin-light; coded-redundancy study | L |

## Open questions

1. How long does an open data channel survive after lock on iOS (the 20 s timer suggests 5 to 20 s), what does Chrome for Android do with the screen off, unplugged and plugged, and does Wake Lock hold for 2 h on a charger, at what heat and battery cost? Nothing measures any of it (G-PS-1 to 5).
2. Pin identity: a `pn=` pointer field or a ledger role, and which wire frame proves it? A format decision before the freeze window closes.
3. Does Chrome's Background Fetch accept request bodies today? The only official page says no (2018). It decides O6 on the web path.
4. Can the loader super-seed (custom bitfield and `have`) without breaking Fast Extension `haveAll` and `haveNone` handling or peers' rarity maps?
5. Is a three-copy echo target right? It should follow concurrent demand, not durability (G-PS-10).
6. Is dock mode acceptable (screen on), or does the old-phone recipe stay documentation only?
7. IP visibility is accepted; reading-history visibility on re-seeding is a different exposure (D1). Does counsel (R6) want the sentence on the card?
8. May the single proven case (Chromium, Wi-Fi, charging, battery 50%+) default to on? That reverses ARCHITECTURE 8 ("off until Share on this network") and needs the owner's sign-off.

## Sources

External pages were opened with WebFetch on 2026-10-20 unless marked [s] (search result only, page not opened); dates shown are the page's own. Repository sources are cited by file and section.

- **Apple.** AP1 https://developer.apple.com/forums/thread/799259 (Sep 2025). AP3 https://developer.apple.com/documentation/backgroundtasks/bgprocessingtaskrequest. AP4 https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask. AP5 https://developer.apple.com/app-store/review/guidelines/ (2.4.2, 2.5.4). AP6 https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari. AP7 https://developer.apple.com/programs/enroll/.
- **WebKit.** WK1 https://webkit.org/blog/12945/meet-web-push/ (2022-06-07). WK2 https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ (2023-02-16). WK3 https://webkit.org/blog/16574/webkit-features-in-safari-18-4/ (2025-03-31). WK4 https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ (2025-06-09). WK5 https://webkit.org/tracking-prevention/. WK6 https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/ProcessThrottler.cpp. WK7 https://bugs.webkit.org/show_bug.cgi?id=261554.
- **Standards.** ST1 MDN browser-compat-data, https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ (SyncManager, PeriodicSyncManager, BackgroundFetchManager, WakeLock, BatteryManager, NetworkInformation). ST2 https://www.w3.org/TR/webrtc/ (Recommendation 2025-03-13). ST3 https://w3c.github.io/audio-session/ (Editor's Draft 2024-11-13). TO1 https://www.bittorrent.org/beps/bep_0016.html. TO2 https://www.bittorrent.org/beps/bep_0021.html. TO3 https://www.bittorrent.org/beps/bep_0048.html. TO4 https://www.libtorrent.org/reference-Torrent_Status.html.
- **Chrome.** CH1 https://developer.chrome.com/docs/capabilities/periodic-background-sync (2025-08-19). CH2 https://developer.chrome.com/blog/background-fetch (2018-12-03). CH3 https://developer.chrome.com/blog/timer-throttling-in-chrome-88 (2021-01-18). CH4 https://developer.chrome.com/docs/web-platform/page-lifecycle-api (2026-10-16). CH5 https://developer.chrome.com/blog/freezing-on-energy-saver (2025-01-20). CH6 https://developer.chrome.com/docs/extensions/reference/api/offscreen (2026-09-21).
- **Android and Play.** AN1 https://developer.android.com/training/monitoring-device-state/doze-standby (2026-08-18). AN2 https://developer.android.com/guide/components/activities/process-lifecycle (2025-02-10). AN3 https://developer.android.com/develop/background-work/services/fg-service-timeout. AN5 https://developer.android.com/develop/background-work/background-tasks/uidt. AN6 https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work. AN8 https://developer.android.com/develop/connectivity/network-ops/reading-network-state (AN3 to AN8: 2026-10-16). AN10 https://support.google.com/googleplay/android-developer/answer/13392821. AN11 https://support.google.com/googleplay/android-developer/answer/6112435.
- **Others.** MS1 https://learn.microsoft.com/en-us/windows/deployment/do/waas-delivery-optimization-reference (2026-05-20). MB1 https://mobiussync.com/faq/. BR1 https://briarproject.org/news/2018-1.0-released-new-funding/. DK1 https://dontkillmyapp.com/ (undated, no method). FX1 https://extensionworkshop.com/documentation/develop/differences-between-desktop-and-android-extensions/ (2024-01-17). CR1 [s] https://chromeunboxed.com/a-development-version-of-chrome-for-android-now-supports-extensions. CF1 https://developers.cloudflare.com/r2/pricing/ (2026-10-01).
- **Research.** AC1 Huang et al., MobiSys 2012, https://experts.umn.edu/en/publications/a-close-examination-of-performance-and-power-characteristics-of-4/. AC2 Kelenyi, Ludanyi, Nurminen, Green Computing 2010 (abstract only), https://researchportal.helsinki.fi/en/publications/bittorrent-on-mobile-phones-energy-efficiency-of-a-distributed-pr/.
- **[s] only, no id:** WebRTC stats `networkType` deprecation (https://www.w3.org/TR/webrtc-stats/); the 2012 IETF mobile WebRTC draft (https://potaroo.net/ietf/idref/draft-isomaki-rtcweb-mobile).
