### F2. Ad-blockers, privacy lists and DNS blocklists: the public trackers are NOT in browser lists, but DNS anti-piracy/torrent lists block them (all four in HaGeZi Anti-Piracy) and two MQTT brokers sit on mainstream DNS lists `[DESIGN-CRITICAL]`

Closes review item `docs/review/browser-mobile.md` m8 ("grep each hostname against EasyList, EasyPrivacy and Brave's lists").

**Claim 1 (browser-level blockers: clean).** On 2026-10-17 none of the browser ad-block lists that Brave Shields, uBlock Origin, AdGuard and EasyList-based blockers ship by default blocks any of: `wss://tracker.webtorrent.dev`, `wss://tracker.openwebtorrent.com`, `wss://open.ftorrent.com`, `wss://tracker.novage.com.ua`, the dead `tracker.btorrent.xyz`, `tracker.files.fm:7073`, six Nostr relays (nos.lol, relay.damus.io, relay.primal.net, ...), the four Trystero MQTT brokers, `cloudflare-dns.com/dns-query` and `dns.google/resolve` (the DoH pointer lookups), or three invented neutral names (`rtc.`, `signal.`, `t.example-site.org`). Method: every list below was downloaded and evaluated with the `@ghostery/adblocker` 2.20.1 engine (a third-party engine, **not** uBO's or Brave's own matcher; it reproduces known blocks, sanity-checked with `googletagmanager.com/gtm.js` and `||tracker.affirm.com^`), request type `websocket` (or `xmlhttprequest` for DoH), third-party source page `https://example.com/`.

| List set (version seen) | Result |
|---|---|
| uBlock filters + Privacy + Badware + Unbreak + Quick fixes + Resource abuse (2026-10-13 .. 2026-10-17) + EasyList + EasyPrivacy (`202610172031`) | 0 blocks |
| Brave "Default Adblock Filters" bundle (uBO filters, 2020-2026 yearly files, general, badware, resource-abuse, unbreak, quick-fixes, link-shorteners + EasyList + URLhaus + Brave unbreak/specific/social/android/sugarcoat) + "Default Privacy Filters" (EasyPrivacy + uBO privacy) + first-party lists, from Brave's `list_catalog.json` | 0 blocks |
| AdGuard Base (without EasyList) + AdGuard Tracking Protection | 0 blocks |
| Firefox Enhanced Tracking Protection (Disconnect list `disconnect-blacklist.json`) | no entry for any of these hosts |

Only a handful of rules in these lists even use the `$websocket` type: EasyPrivacy `/ws_client?zone=gen$websocket`, `||neowin.net/ws/$websocket`, and **`||duckdns.org^$third-party,websocket` (a tracker or relay on a DuckDNS name would be blocked as a third-party WebSocket by every EasyPrivacy-based blocker)**; EasyList adult-site rules; `*$websocket,domain=linuxtracker.org` (uBO privacy and resource-abuse). uBO's Unbreak list contains **`@@||tracker.btorrent.xyz^$websocket`**, an exception that only makes sense if some rule had once blocked that WebTorrent tracker; I could not find the history (a web search returned nothing relevant, GitHub's commit and issue search returned 0 hits, then the unauthenticated API limit was exhausted), so the cause is **unverified**. EasyPrivacy lists 95 rules for hostnames that start with `tracker` (`||tracker.<domain>^`), none of ours: the word "tracker" in a hostname is a classification signal, not (today) a generic rule.

**Claim 2 (DNS-level lists: not clean).** DNS filters (Pi-hole, AdGuard Home, NextDNS, Control D, router firmware, school/office resolvers) block by hostname and parent domain, with no request-type nuance. Same date, lists downloaded and every hostname plus its parent domains checked:

| DNS list (version seen) | Blocks |
|---|---|
| **HaGeZi Light / Multi (normal) / Pro / Pro++ / Ultimate** (all `Last modified 17 Oct 2026`; "Pro" is the list's own recommendation) | **`broker.emqx.io`, `broker.hivemq.com`** (public MQTT brokers = Trystero's MQTT strategy defaults) |
| HaGeZi TIF (threat intelligence) and BlockListProject "malware" | `broker.hivemq.com` |
| BlockListProject "tracking" (2026-07-18) | **`stun.l.google.com`** (the first STUN server in simple-peer's default config) |
| **HaGeZi Anti-Piracy** (opt-in, 56,386 entries) | **all four live trackers** (`tracker.webtorrent.dev`, `openwebtorrent.com`, `open.ftorrent.com`, `tracker.novage.com.ua`) + `btorrent.xyz`, `tracker.files.fm`, `webtorrent.io` |
| **BlockListProject "torrent"** (opt-in) | `tracker.openwebtorrent.com`, `tracker.novage.com.ua`, `tracker.files.fm`, `webtorrent.io` |
| OISD small and big, StevenBlack unified hosts, AdGuard DNS filter, BlockListProject ads/abuse/piracy, HaGeZi Fake / Popup-Ads | none of the above |

The Nostr relays tested (`nos.lol`, `relay.damus.io`, `relay.primal.net` and the others in F8) were not blocked by any list.

**What this means for design.**
1. Browser-level blocking is *not* a reason to avoid the public trackers today; DNS-level "piracy/torrent" categories are. Visitors behind such filters (parental-control DNS, some schools and offices) lose *every* public tracker at once, and the failure is silent to JavaScript (a refused/NXDOMAIN WebSocket shows only `onerror` + close 1006).
2. The **MQTT fallback is a weaker "independent second plane" than F8 of the earlier note assumed**: two of its four default brokers are in mainstream default-recommended DNS lists. Nostr relays are not.
3. A self-hosted tracker on a **neutral hostname under our own domain** (`rtc.<domain>`, `sig.<domain>`) avoids hostname-keyword and "known tracker" listings. Do not use the strings `tracker`, `torrent`, `peer`, `bt`, or free dynamic-DNS suffixes such as `duckdns.org`.
4. Treat tracker reachability as a measurable property: ship a daily CI job that re-runs the list check for every hostname in `config.js` (scripts: `w2b-01-tracker-resilience-ref/probes/filterlist-check/`).
5. Corporate web gateways classify P2P and file-sharing hosts by category (vendor databases such as Cisco Umbrella, Zscaler, Palo Alto URL filtering). I did **not** test any of them (**unverified**); assume enterprise networks may block the public trackers, and that a neutral hostname on our domain is categorised as "uncategorised/newly seen" (many gateways block those too).

**Confidence:** high that these entries exist on 2026-10-17 (raw list lines quoted in `probes/results/filterlist-check-2026-10-17.txt`); medium for how many real visitors use HaGeZi/BLP (unknown); medium for "browser-level clean" (third-party engine, default lists only; user-added lists such as Fanboy's Annoyances or custom rules are out of scope; Edge/Safari/Samsung built-in lists are not public and not checked).
**Sources:** https://easylist.to/easylist/easylist.txt , https://easylist.to/easylist/easyprivacy.txt , https://ublockorigin.github.io/uAssets/filters/{filters,privacy,badware,unbreak,quick-fixes,resource-abuse}.min.txt and https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/*.txt , https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json , https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/*.txt , https://filters.adtidy.org/extension/ublock/filters/{2_without_easylist,3}.txt , https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock/{light,multi,pro,pro.plus,ultimate,tif,anti.piracy}.txt , https://small.oisd.nl/ , https://big.oisd.nl/ , https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts , https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt , https://blocklistproject.github.io/Lists/{torrent,piracy,tracking,ads,abuse,malware}.txt , https://raw.githubusercontent.com/mozilla-services/shavar-prod-lists/master/disconnect-blacklist.json , npm `@ghostery/adblocker` 2.20.1.
**Source date:** all downloaded 2026-10-17 (lists dated 2026-07-18 .. 2026-10-17).

