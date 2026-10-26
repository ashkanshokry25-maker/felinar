## Open questions

1. How do iOS Safari, Android Chrome/Samsung Internet and Firefox behave with the shim of R4/R5 across background/foreground and screen lock on real devices and carrier NAT (not tested; Playwright only)? Does a hidden mobile tab answer server pings? (expected yes, untested)
2. Firefox: the Playwright build would not launch here, so the `xs`+`ws` degradation path and the tracker shim are unverified on Firefox desktop/Android.
3. Does Oracle reclaim a lightly loaded A1 that hosts only this tracker, and does a PAYG upgrade or a busy-loop prevent it? (still unverified; two waves)
4. Cloudflare production behaviour of the Durable Object tracker: real hibernation timing, edge latency, deploy-time disconnect scale, Free-plan enforcement of the 20:1 rule, cost at real traffic (only `workerd` local mode was tested).
5. Real-world per-IP and rate limits of the four public trackers beyond ≤ 3 connections per 5 minutes; whether the operators accept our expected load (R12).
6. Who runs what behind `tracker.openwebtorrent.com` (Node process per `/stats.json` memory keys; site last modified 2023-07-06) and for how long; the C++ `openwebtorrent-tracker` repo (last push 2021-06-27) is probably not it.
7. Why did the one-off timeout at 21:30:06Z hit three operators at once? Attributed to the local load test (same window), but a coincident upstream/ISP event cannot be excluded without a second vantage point.
8. DNS-category and corporate gateway classification of `rtc.<domain>` and of the public trackers (Cisco Umbrella, Zscaler, Palo Alto, Fortinet): not tested; need accounts or a pilot network.
9. How many real visitors sit behind HaGeZi/BlockListProject-style DNS filtering (no data); decides how much the neutral-hostname tracker is worth versus its operating cost.
10. Is the `getAnnounceOpts` + `torrent.discovery.tracker` shim acceptable as an internal-API dependency, or should the project fork/patch `bittorrent-tracker` (a 20-line change to `websocket-tracker.js`) and vendor it?
11. Tracker egress with real STUN candidates (offers measured at 0.69-0.74 KB with host candidates only) and with TURN-relayed paths.
12. Hetzner Cloud (and Vultr) current prices: not retrievable here; check the consoles before choosing a paid VPS.

