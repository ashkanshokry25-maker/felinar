# S2: Zero-setup hosting for Lightweb

- **Date:** 2026-10-20 (ET). **Applies to:** magnet-web 0.2.1 going to 0.3, being renamed Lightweb. **Status:** research and design proposal; nothing here is built or binding until the owner signs off.
- **Question (owner):** anyone should start in minutes with no S3 and no domain registrar, for example with `<IP>.nip.io`; IP visibility to peers is accepted.
- **Method:** project files read (ARCHITECTURE 3, 4, 8; `policy.js`, `torrent.js`, `doh.js`; the tools; DEPLOY; QUICKSTART; R5, R7, R8; V03-DESIGN-REVIEW 2.8, 2.9, 2.17.5; judge-scale; w1-10; w2c-04; the sibling files S1 (phone seeding) and S3 (adoption)); vendor pages opened on 2026-10-20 (Sources); and runs marked *measured*: DNS queries, exact-line checks of the Public Suffix List and a DNS block list, `publish` runs, and a Caddy 2.11.7 template run on loopback against the repo's `check-webseed` and `check-site`. No browser, server, phone or certificate authority was used; the only non-local contacts were vendor pages, nip.io DNS, public lists and one Caddy release.
- **Labels:** *documented* (page read), *measured*, *reported* ([r]: search result or page not read in full), *arithmetic*, *inference*. Effort: S under a day, M a few days, L a week or more. Examples use `203.0.113.7`, a documentation address (RFC 5737).

## Summary

1. **Four rungs:** *try* (this computer, no DNS), *share on my LAN* (phones trust a local CA, or a tunnel carries the page), *publish with no domain* (a rented server named `203-0-113-7.nip.io`, a free static host, or a link on a hub), *my own domain* (today's path). A nip.io name cannot carry the `_magnet` TXT record (*measured*), so rungs 0 to 2 rely on the signed page-tag pointer; the DNS update channel starts at rung 3.
2. **nip.io and sslip.io are one free DNS service run by two volunteers**, with no uptime promise, terms or privacy statement, and a block list. Neither is on the Public Suffix List (*measured*). A first address on a rented server, not a permanent home. Default to nip.io: a DNS block list covers sslip.io and not nip.io (*measured*).
3. **Automatic HTTPS needs no DNS credentials:** Caddy uses HTTP-01 on port 80 or TLS-ALPN-01 on 443; DNS-01 through a provider is impossible on these names. Let's Encrypt has issued bare-IP certificates since 2026-01-15 (6-day lifetime), which drops the naming service but cannot carry passkeys.
4. **A home computer is not zero-setup:** port forward, blocked port 80, carrier-grade NAT. Only Tailscale Funnel gives a stable name without inbound ports (beta); quick tunnels rename on every run.
5. **Free hosts:** GitHub Pages and Netlify can carry the shell-mode contract (same-origin web seed, 206); Cloudflare Pages cannot be the web seed; Neocities free cannot hold a `.torrent`; Surge and Codeberg are unverified.
6. **New and measured:** the one-box Caddy template passes `check-webseed` and `check-site` on loopback; with `--chain` one site can live at several addresses as one swarm and one ledger; `ship` can keep the owner key off the server; `shouldSkipDoh` should skip nip.io names and does not.
7. **Limits to say aloud:** the name is the IP (a new IP is a new origin); DNS and the block list belong to others; the signed pointer expires (default 90 days, at most 399) and new visitors are then refused; free tiers change under you (Glitch 2025, Oracle 2026).

## Findings with sources

### A. nip.io and sslip.io

**F1. One service, two volunteers, no SLA** (*documented*, [1]). A DNS service that "when queried with a hostname with an embedded IP address, returns that IP address" ("over ten years", "over 20k queries every second": operator claims). nip.io was registered in 2012 by Roopinder Singh (died 2024-05-03); the domain passed to Brian Cunnie on 2025-07-06; Cunnie and Kenneth Lakin run both names, and `https://sslip.io` answers 301 to `https://nip.io/` (*measured*). No terms, privacy or uptime statement; abuse goes to abuse@nip.io, answered "within 24 hours" (claim). No outage reports found [r].

**F2. What resolves** (*measured* by `dig`, 2026-10-20 14:07Z; [1], [2]). `203-0-113-7.nip.io`, `203.0.113.7.nip.io` and `app.203-0-113-7.nip.io` answer `203.0.113.7` (TTL 3600), likewise under sslip.io; `192-168-1-20.nip.io` answers `192.168.1.20`. `TXT _magnet.203-0-113-7.nip.io` answers NOERROR with no data; the service defines TXT only for `ip.nip.io` and `*.status.nip.io`. Any prefix label works, so one IP can carry many hostnames.

**F3. Block list and takedown** (*documented*, [2], [3]). Addresses "used in phishing attacks" (1,150 lines with comments), and CIDRs, make names that embed them resolve to the operators' block page (`64.176.22.9`, `2001:19f0:c800:2315::`). A counter tracks responses "blocked because we've received a takedown notice". A recycled server address can be blocked before you start; anyone can ask for a block later.

**F4. Public Suffix List** (*measured*, [5], VERSION 2026-10-20_08-40-56_UTC, exact line). **Not listed:** nip.io, sslip.io, traefik.me, localtest.me, neocities.org, localhost.run. **Listed:** github.io, gitlab.io, codeberg.page, pages.dev, netlify.app, surge.sh, trycloudflare.com, ngrok-free.app, ts.net, dedyn.io, duckdns.org. Effect (Chrome 156 stand-in runs of 2026-10-17, w2c-04 F7): storage and Service Worker scope are per origin with or without an entry. Without one, siblings are same-site: a sibling can set `Domain=<parent>` cookies (a cookie bomb made a 16 KiB-header server answer 431), `Sec-Fetch-Site` reads same-site, the HTTP cache is shared. The loader sets no cookies, but same-origin web seed requests carry them, so a hostile `*.nip.io` page could break one browser's fetches (inference). V03 2.17.5, from red-team A8, has the loader disable persistent identity and passkeys on a hub suffix that fails a cookie probe; whether per-domain sites are probed is open (Q3).

**F5. Let's Encrypt limits** (*documented*, [6], updated 2026-08-05; [1]). 50 certificates per registered domain per 7 days (an override takes "a few weeks"); 5 per exact name set per 7 days (no override); 5 failed validations per name per hour; ARI renewals exempt. The PSL defines the registered domain, so every `*.nip.io` name shares one (inference). The nip.io page says LE "bumped our limit from 50 to 250,000 certificates" (window unstated), supports no wildcard certificates (a 2015 wildcard key was published for a week and revoked), and suggests an IP-address certificate or the other domain when rate-limited. For IPv4 certificates LE counts "the exact address as the registered domain".

**F6. DNS filters** (*measured*, [10]). HaGeZi's DynDNS list (version 2026.1016.0959.51, 1,541 entries) **lists sslip.io, dedyn.io, duckdns.org, freeddns.org, mooo.com** and **not** nip.io, trycloudflare.com, ngrok-free.app, github.io, pages.dev, netlify.app, surge.sh, localhost.run, ts.net or codeberg.page. Unit 42 calls wildcard DNS a phishing tool [r, 12]; I found no vendor policy blocking either domain wholesale. Pi-hole, NextDNS, corporate proxies and Safe Browsing: unmeasured.

### B. Automatic TLS

**F7. Challenges** (*documented*, [7], updated 2026-02-12; [9]). HTTP-01: port 80 only, validates IPs, no wildcards, "fails if an ISP blocks port 80". TLS-ALPN-01: port 443, validates IPs, works when 80 is unavailable. DNS-01: "cannot be used to validate IP Addresses", the only wildcard route. Caddy enables HTTP and TLS-ALPN by default, tries Let's Encrypt then ZeroSSL, retries on staging, and needs a persistent `$HOME`. A nip.io site needs only its name in the Caddyfile.

**F8. IP-address certificates** (*documented*, [8], [9]). Since 2026-01-15: IPv4 and IPv6, `shortlived` profile only (160 hours), HTTP-01 or TLS-ALPN-01. Caddy's ACME issuer has `profile <name>` (EXPERIMENTAL); `default_sni` is reported to be needed for IP connections [r]. A Caddyfile with both parsed on 2.11.7 (*measured*); it was not run against Let's Encrypt. Browsers reject an IP address as a WebAuthn RP ID [r, 19], so an IP origin cannot hold its own passkeys; passkeys live at the identity origin (V03 2.1), so popup sign-in should still work (inference).

**F9. DNS-01 by delegation** (*measured* against the authoritative server `5.78.28.211`, 2026-10-20; [2], [4]). `NS _acme-challenge.203-0-113-7.nip.io` is answered with the delegation `203-0-113-7.nip.io.` and glue `203.0.113.7`: a public host running its own DNS server on port 53 could answer its own DNS-01 challenge and obtain wildcard certificates for `*.203-0-113-7.nip.io`. Not tried end to end; no use for private addresses, since the CA must reach the server (inference).

### C. Secure context, phones, LAN

**F10. What the platforms forbid** (*documented*). Service Workers need a secure context: https, `localhost`, `127.0.0.0/8`, `::1` or `*.localhost` ([14]); `http://192.168.x.x` is none of these, and piece hashing needs `crypto.subtle` (w1-10 F35). An `https://` page cannot open `ws://` to a LAN host (mixed content; w1-10 F37). iOS does not trust an installed root until you enable it under Settings, General, About, Certificate Trust Settings ([15]). Android 7.0+ apps trust only system CAs by default ([16]); Chrome trusting a user CA is *reported* by `demo.mjs`. The mkcert CA key "gives complete power to intercept secure requests from your machine" ([17]). Chrome 154 (October 2026) warns on public HTTP, not on private addresses such as `192.168.0.1` ([18]; rollout not verified).

**F11. The existing LAN tier** (`demo.mjs`, `dev-server.mjs`). `demo --tls` binds `0.0.0.0`, makes an mkcert certificate for `localhost`, loopback, every LAN address and `--lan-host`, signs the pointer for the LAN address (a new DHCP lease is a new origin), serves the tracker over TLS on 8000 and prints the phone steps. Routers with DNS rebinding protection (dnsmasq on OpenWrt, home routers, ISP DNS) drop the private answer for `192-168-1-20.nip.io` ([13]). Inference: one CA install per own phone is fine, 30 phones is not, and Wi-Fi client isolation could block phone-to-laptop traffic (unmeasured).

### D. Reaching a machine

**F12. Home NAT and CGNAT.** HTTP-01 needs inbound port 80 ([7]); TLS-ALPN-01 covers a blocked 80 only if 443 is open. CGN permits no inbound: "10% of the ISPs we tested have some form of CGN" (5,121 vantage points, Europe and US fixed broadband, 2017, ISP-level; [20]); no newer subscriber-level figure found.

**F13. Tunnels** (*documented*).

| Tool | Signup, cost | Name | Who decrypts | Limits |
|---|---|---|---|---|
| Cloudflare quick tunnel ([21], 2026-09-30) | none, free | "changes each time" | Cloudflare edge (inference) | 200 in-flight requests then 429; no SSE; "no uptime guarantee"; "for testing and development" |
| Tailscale Funnel ([22]) | account, tailnet, MagicDNS, HTTPS certs | stable `*.ts.net` | your device; "relay server cannot decrypt" | beta; ports 443, 8443, 10000; "non-configurable bandwidth limits"; macOS needs the open-source variant |
| ngrok free ([23]) | account (implied) | one assigned `*.ngrok-free.app` | ngrok | 1 GB and 20,000 requests a month; interstitial for HTML browser traffic |
| localhost.run ([24]) | none; ssh; $9 a month for a stable name | free names change after hours | provider, in HTTP mode | speed limit |

A named Cloudflare tunnel needs a website on Cloudflare ([21]), so it is rung 3. Tailscale Serve (tailnet only, device-terminated certificate) suits your own phones. A random tunnel name means "start the tunnel, then publish for that hostname", and each restart is a new origin with empty storage (w1-10 item 20).

### E. Free static hosts and servers

**F14. Hosts** (*documented*, [25] to [29]; Range and headers from DEPLOY.md and w1-10).

| Host | Address, signup | Free limits | Shell-mode fit | Custom domain later |
|---|---|---|---|---|
| GitHub Pages | `<user>.github.io`, repo of that name; HTTPS automatic; R7: 11 steps, up to 10 min | 1 GB; 100 GB/month soft; no commercial sites | passes (same-origin seed, 206); no headers; `max-age=600` | CNAME file, DNS check, Let's Encrypt |
| Cloudflare Pages | `<project>.pages.dev`; account; drag and drop 1,000 files, wrangler 20,000 | 25 MiB a file | no web seed (`Range` gives 200); `_headers` works | yes |
| Netlify | `*.netlify.app`; Drop needs no account; `--allow-anonymous` claim within one hour | 300 credits; 20 per GB | 206 measured earlier; `_headers` works | yes (not re-read) |
| Surge | `<name>.surge.sh`; email and password in the terminal | none listed | unverified | free, CNAME |
| Neocities | `<name>.neocities.org`; account | 1 GB; whitelist lacks `.torrent` and `.wasm` | no | on the Supporter page, tier unclear |
| Codeberg Pages | `<user>.codeberg.page`; account, repo `pages`; new users get git-pages only (v2 closed "due to abuse") | none stated | unverified | yes (git-pages) |

**F15. Free and cheap things change.** Glitch ended hosting 2025-07-08 for cost and abuse ([30]). Oracle cut Always Free A1 from 4 OCPUs and 24 GB to 2 and 12 on 2026-06-15, unannounced (InfoQ, 2026-07-03). Hetzner repriced twice in 2026 [r] and marks its cheapest line "Currently not available". Servers ([31], 2026-10-20): DigitalOcean $4.00 a month with 500 GiB transfer and IPv4; Hetzner from EUR 5.99 and 6.49 excluding VAT. Arithmetic: 500 GiB / 5 MiB = 102,400 first visits a month with no peer help.

### F. The repository today (*measured* here, Node 24.22.0)

**F16. Pointer, chain, DoH.** `publish --scope 203-0-113-7.nip.io` with the flags of 2a gives a **602-byte** pointer; without `--cs --ct` **528**; own tracker plus `--tr public` **699**. All warn "should stay at or under 450 bytes" (a DNS budget; maximum 900). `--ws` must be absolute, though `webseedBases` resolves relative values against the page. The same key and `--chain my-site` under `203-0-113-7.nip.io` and `example.com` gave the same ledger id, rendezvous infohash and torrent infohash; the origin still changes with the hostname. `shouldSkipDoh` skips localhost, IP literals, single labels and special-use suffixes but not nip.io or sslip.io, so the loader (after consent) and `check-site` ask Cloudflare, dns.sb or Google for `_magnet.<ip>.nip.io`.

**F17. One-box template.** Caddy 2.11.7 (archive SHA-512 matched the release checksums) validated the Caddyfile below and served a test site (test copy plus `bind 127.0.0.1` and `admin off`): `/` and `/mw-sw.js` `no-cache`; `Range` on `/ws/` 206, identity; gzip on `/_mw/boot.js` only; missing seed or loader file 404 `Not found`; unknown page the shell with status 404; `/.env` 404, `/ws/my-site/.mw/files.json` 200; WebSocket upgrade on `/tracker` reached the tracker, other paths 404; `check-webseed` **PASS**; `check-site` **OK: 0 failure(s), 0 warning(s)**. TLS and ACME were not exercised. `docker compose config` accepted the compose change.

**F18. Expiry.** `verifyPointer` refuses a fresh page-tag pointer past `exp`; only the cached record renders, with a banner (`pointer.js`, `strings.js`). Rungs 0 to 2 have no DNS record to refresh it. S3 calls the clock free retention; for a zero-setup owner it is also a cliff (Q7).

## Design options with costs

| Option | Steps | Money | Others involved | Verdict |
|---|---|---|---|---|
| O1 `localhost` | `npm run demo` | 0 | none | rung 0 |
| O2 LAN with mkcert, or Android over USB | `demo --tls` and trust the CA on each device; or `adb reverse` | 0 | none | rung 1, own devices |
| O3 Quick tunnel | one command | 0 | provider decrypts; name changes every run | show a friend, not publish |
| O4 Tailscale Serve or Funnel | account, app; Funnel adds 3 settings | 0 | Tailscale | Serve: own devices; Funnel: beta home hosting |
| O5 Rented server, nip.io, Caddy | rent, Docker; 7 commands by hand, 1 with `ship` | $4 to $7 a month | nip.io DNS, Let's Encrypt, host; name tied to the IP | **rung 2, most control** |
| O6 Rented server, bare-IP certificate | as O5 plus `profile shortlived` | same | Let's Encrypt, host | experiment (P2) |
| O7 GitHub Pages | account, repo, push | 0 | GitHub; `<user>.github.io` | **rung 2, least effort** |
| O8 Netlify Drop, Surge | drag a folder, `surge` | 0 | host; name assigned or chosen, may vanish | throwaway |
| O9 Hub link | pointer in a link | 0 | hub operator | needs a hub and a seeder that stays on |
| O10 Free subdomain with TXT (deSEC `dedyn.io`) | account, API token | 0 | deSEC (non-profit [r, 32]) | only no-registrar TXT path; on the DynDNS list (F6) |

## The zero-setup ladder

"exists" means the flag is in `tools/*.mjs` today; "proposed" is new. `lightweb` is the planned command; today use `node tools/<x>.mjs` or `npx magnet-web <x>`.

### Rung 0: try

```sh
npm run demo                                          # exists: http://localhost:8080/ with the example guestbook
node tools/demo.mjs --site ~/my-site --name my-site   # exists: your folder, its own ledger
npx lightweb try ./my-site                            # proposed (R7 5.3): same pipeline, no clone
```
Gives full mode on this computer (`localhost` is secure, F10). Cannot be reached by anyone else, prove public performance, or reach the public identity origin without a remote call (sign-in then needs a local identity origin: open, inference). Open `localhost`, not `127.0.0.1`: the pointer is signed for the hostname.

### Rung 1: share on my LAN

```sh
brew install mkcert nss && mkcert -install        # once; the CA key stays on this computer
node tools/demo.mjs --tls                         # exists: https://<lan-ip>:8080/, prints the phone steps
adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000   # exists (demo text): Android over USB, no certificate
npx lightweb try ./my-site --lan                  # proposed: QR code, CA fingerprint, trust page on :8081
npx lightweb try ./my-site --tunnel               # proposed: prints one command below, starts nothing
cloudflared tunnel --url http://localhost:8080    # quick tunnel; publish after the name appears
tailscale serve --bg --https=443 localhost:8080   # your tailnet only, valid certificate
```
`--tunnel` only prints, because DEV-NETWORK.md says the tools never open tunnels. The dev server needs `--tracker-proxy` (proposed) so the tracker shares the origin at `/tracker` (w1-10 F37). Cannot serve a classroom without a CA install on every phone, or work on Wi-Fi with client isolation (unmeasured).

### Rung 2: publish with no domain

A rented server (or one you will rent) is 2a; no server and a GitHub account is 2b; only a friend who keeps a computer on is 2c.

**2a. A rented server, one box.** Needs a public IPv4 address, Docker with Compose 2.17 or newer, ports 80 and 443 open, and a clone of this repository on the server (here `/opt/magnet-web`; the tracker image builds from it, as in `deploy/tracker`). The owner key stays on your computer.

```sh
npx lightweb ship ./my-site --ip 203.0.113.7 --to ssh://root@203.0.113.7 --ct mailto:you@example.org   # proposed
```
It derives `203-0-113-7.nip.io`, checks the name (F3), publishes with `--chain`, copies the tree, starts the stack against Let's Encrypt staging (`LW_ACME_CA`), switches to production and runs `check-site`. By hand, every flag exists:

```sh
node tools/keygen.mjs --out ~/keys/my-site.jwk
node tools/publish.mjs ~/my-site --name my-site --chain my-site --scope 203-0-113-7.nip.io \
  --key ~/keys/my-site.jwk --ws https://203-0-113-7.nip.io/ws/ --cs https://203-0-113-7.nip.io/ws/genesis.json \
  --tr wss://203-0-113-7.nip.io/tracker --tr wss://tracker.webtorrent.dev --ct mailto:you@example.org \
  --exp 399 --shell --out dist-publish        # the 450-byte warning is expected here (F16)
mkdir -p site/ws allow && cp -R dist-publish/shell/. site/ && cp -R dist-publish/my-site dist-publish/my-site.torrent dist-publish/genesis.json site/ws/
jq -r '.btih, .rendezvousBtih' dist-publish/summary.json > allow/allow.txt
rsync -a site allow root@203.0.113.7:/opt/magnet-web/deploy/one-box/
ssh root@203.0.113.7 'cd /opt/magnet-web/deploy/one-box && echo LW_SITE=203-0-113-7.nip.io > .env && docker compose up -d'
node tools/check-site.mjs https://203-0-113-7.nip.io/
```

`deploy/one-box/Caddyfile` (proposed; Caddy 2.11.7 validated it and served it on loopback, F17):

```caddyfile
{
	acme_ca {$LW_ACME_CA:https://acme-v02.api.letsencrypt.org/directory}
	grace_period 30s
	servers {
		timeouts {
			read_header 10s
			idle 5m
		}
	}
}
(lw_headers) {
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	# Shell and loader files are always revalidated (DEPLOY.md).
	@loader path / /index.html /404.html /mw-sw.js /_mw/*
	header @loader Cache-Control "no-cache"
	# Only a response header can say frame-ancestors.
	@shell path / /index.html /404.html
	header @shell {
		Content-Security-Policy "frame-ancestors 'none'"
		X-Frame-Options DENY
	}
	# The web seed answers Range with 206 and identity bytes: revalidate it, never compress it.
	header /ws/* Cache-Control "no-cache"
	@compress not path /ws/*
	encode @compress zstd gzip
}

{$LW_SITE} {
	root * {$LW_ROOT:/srv/site}

	# Add the log block of deploy/tracker/Caddyfile here (client addresses masked to /24 and /48).
	# 1. The tracker: only WebSocket upgrades on /tracker reach it.
	@tracker {
		path /tracker
		header Connection *Upgrade*
		header Upgrade websocket
	}
	handle @tracker {
		reverse_proxy {$LW_TRACKER:tracker:8000} {
			stream_close_delay 30s
			stream_timeout 24h
		}
	}

	# 2. Everything else is static files. Dot paths are never served, except .mw (inside the torrent)
	# and .well-known.
	handle {
		@hidden {
			path_regexp dot /\.[^/]
			not path_regexp ok /\.(mw|well-known)(/|$)
		}
		respond @hidden "Not found" 404
		import lw_headers
		file_server
	}

	# 3. Unknown paths get the shell with status 404 (the loader renders it). A missing loader file or seed
	# file is a plain 404, never the shell as 200 text/html.
	handle_errors {
		import lw_headers
		@reserved path /mw-sw.js /_mw/* /ws/* /.mw/*
		handle @reserved {
			respond "Not found" {err.status_code}
		}
		handle {
			rewrite * /404.html
			# No matcher here: header runs before rewrite, so a path matcher would see the old path.
			header Cache-Control "no-cache"
			header Content-Security-Policy "frame-ancestors 'none'"
			header X-Frame-Options DENY
			file_server
		}
	}
}
```

`deploy/one-box/docker-compose.yml` is `deploy/tracker/docker-compose.yml` with three changes (compose accepted it). In `caddy`: `environment` becomes `LW_SITE: ${LW_SITE:?set LW_SITE, for example 203-0-113-7.nip.io}` plus `LW_ACME_CA: ${LW_ACME_CA:-https://acme-v02.api.letsencrypt.org/directory}` (an empty value breaks the Caddyfile), and `- ./site:/srv/site:ro` joins `volumes`. A `pin` service (`profiles: ["pin"]`, `build: { context: ../.., dockerfile: deploy/pin/Dockerfile }`, `PIN_URL: https://${LW_SITE:-localhost}/`, a `mw-pin` volume) starts with `--profile pin` and makes the box the always-on holder S1 asks for. Keep the `caddy_data` volume: losing it re-requests the certificate, and the duplicate limit is 5 a week (F5). Bare-IP variant (parsed only): site address `203.0.113.7`, global `default_sni 203.0.113.7`, `tls { issuer acme { profile shortlived } }`.

Cannot: keep the address if the IP changes; outlast nip.io or its block list; carry a DNS pointer. Returning visitors keep their saved copy if DNS fails (ARCHITECTURE 3.1); new visitors cannot open the name.

**2b. A free static host.**

```sh
node tools/publish.mjs ~/my-site --name my-site --chain my-site --scope <user>.github.io --key ~/keys/my-site.jwk \
  --ws https://<user>.github.io/ws/ --cs https://<user>.github.io/ws/genesis.json --tr public --ct mailto:you@example.org --exp 399 --shell --out dist-publish
# then QUICKSTART A3 and A4 (deploy tree, .nojekyll, push to <user>/<user>.github.io), then: node tools/check-site.mjs https://<user>.github.io/
```
Netlify Drop and Surge pick or assign the name at upload: drop once to learn it, publish for that name, drop again (Surge: `surge deploy-root my-site.surge.sh`, usage not run). Cannot: run your own tracker (public trackers only, and all four are on at least one DNS block list, DEPLOY.md), set headers on GitHub Pages, or promise the host keeps your account (F15).

**2c. A link on a hub, no host.**

```sh
npx lightweb share ./my-site --hub https://hub.example/   # proposed: prints https://hub.example/#<signed pointer> and a QR code
npx magnet-web seed dist-publish/site.torrent dist-publish   # exists (tools/seed.mjs, needs node-datachannel)
```
Needs a hub to exist (an owner decision; DEPLOY.md "Hubs"; S3 item 8: curated at first). Loads only while someone seeds or a pin holds it. The hub is a third party; its label is opaque; an unsigned magnet shows as unmoderated. A mini hub on one IP (`<label>.203-0-113-7.nip.io`, on-demand TLS) would spend the shared certificate pool, list every label in Certificate Transparency logs and, with no PSL entry, lose persistent identity (F4): not recommended.

### Rung 3 and moving up

Today's path (QUICKSTART A1 to A6; DNS TXT in DEPLOY); not free, and resolvers cache a missing TXT for 5 to 30 minutes, so create it before visitors come. Move with the **same key and `--chain`**: ledger id, rendezvous swarm and infohash stay (F16), and old and new addresses can run together as one swarm; the new hostname is a new origin, so saved copies, consent, key pins and working keys start over. Proposed `publish --move --scope 203-0-113-7.nip.io --to https://example.com/` signs `st=moved; mv=<URL>` at the old address: old loaders treat any `st` other than `ok` as withdrawn (ARCHITECTURE 4), so they fail closed; new loaders offer a link. A grammar change needs an RFC (GOVERNANCE).

### Strings

| Id | Where | Text |
|---|---|---|
| Z1 | `ship`, first lines | `Your site will be at https://203-0-113-7.nip.io/. The name is your server's IP address with dashes. It costs nothing and needs no sign-up.` |
| Z2 | same | `If this server gets another IP address, the address changes and visitors start again. A domain you own does not have this problem.` |
| Z3 | same | `nip.io is a free DNS service run by two volunteers with no uptime promise. If it stops, new visitors cannot open this address; people who already opened the site keep their saved copy.` |
| Z4 | name check fails | `203-0-113-7.nip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Try 203-0-113-7.sslip.io, use another server, or use a domain you own.` |
| Z5 | certificate check fails | `The certificate authority could not reach this server on port 80 or 443. At home a router may need a port forward, some providers block port 80, and a provider that shares one address between customers cannot be reached. Use a rented server, a free static host or a tunnel.` |
| Z6 | after publish (date for 2026-10-20) | `Your signed address record expires on 2027-11-23. After that new visitors cannot load the site until you publish again. Add this date to your calendar.` |
| Z7 | `--tunnel` | `This address belongs to <provider>. They can see everything sent through it. It changes every time you restart, so each restart is a new site to your visitors. Use it to show a friend, not to publish.` |
| Z8 | `--lan` | `Phones run this site only over https. Trust the certificate on each phone once, or connect an Android phone by USB. Whoever gets the key of this local certificate authority can read the secure traffic of every phone that trusts it: keep it on this computer and remove the certificate afterwards.` |
| Z9 | free host | `This address belongs to GitHub. They can remove it, change their limits or close the account. Your files and your key stay yours: publish the same site elsewhere with the same key.` |

## Recommendations, P0 to P3

| Id | Pri | Effort | What, where, test |
|---|---|---|---|
| Rc1 | P0 | S to M | `deploy/one-box/` (Caddyfile, compose change, README) from this file; CI runs `caddy validate`, `docker compose config` and a loopback test with `check-webseed` and `check-site` (done by hand here) |
| Rc2 | P0 | S | `src/loader/doh.js`: `shouldSkipDoh` skips IP-embedded `nip.io` and `sslip.io` names; unit tests; update ARCHITECTURE 4 item 3; `check-site` reports the skip (F16) |
| Rc3 | P0 | S | Rung 2 defaults in `ship`: `--chain` = `--name`; offer `--exp 399` and print the re-sign date (Z6); no 450-byte DNS warning when the scope cannot carry TXT |
| Rc4 | P0 | S | `nameCheck(ip)`: the name resolves to its own IP, not the block page; default `nip.io`, fall back to `sslip.io` (F6); pure function, canned-DNS test; used by `ship --ip` (Z4) |
| Rc5 | P0 | S | "Start without a domain" in QUICKSTART, DEPLOY and FAQ: the ladder, the limits, Z1 to Z9; wording lint |
| Rc6 | P0 | M | Gate rows: G-ZS1 real server, nip.io name, Caddy staging, production, one renewal; G-ZS2 iOS Safari and Android Chrome load it; G-ZS3 a returning visitor opens the site with DNS failing; G-ZS4 GitHub Pages end to end with `check-site` |
| Rc7 | P1 | M each | `ship --ip --to ssh://` and `try --lan --tunnel` (R7 5.1, 5.3) |
| Rc8 | P1 | M per host | Host adapters: GitHub Pages first, Netlify Drop second (R7 5.5) |
| Rc9 | P1 | S | Decide the A8 probe scope (Q3); encode it in `src/loader/harden.js` |
| Rc10 | P1 | M | LAN trust page, QR code, CA fingerprint; dev-server `--tracker-proxy` |
| Rc11 | P1 | M | `publish --move` (`st=moved`), after an RFC |
| Rc12 | P2 | S to test | Bare-IP certificate rung, after a real-server run (Q5) |
| Rc13 | P2 | S to M | `.ics` re-sign reminder; relative `--ws --xs --cs` for same-origin layouts (the loader already resolves them) |
| Rc14 | P2 | L | Mini hub on one IP: blocked by the denylist, PSL and identity decisions; not recommended |
| Rc15 | P3 | L | Project white-label `*.ip.<domain>` with the open-source server (`-public`, `-txt`) and a PSL entry, if feasible (w2c-04 F6: small projects likely declined); pkarr or DHT pointer channel (needs Ed25519; ours is P-256); per-IP wildcard certificates by delegation (F9) |

## Open questions

Verified here: F2, F4, F6, F9, F16, F17. Not verified: any issuance by Let's Encrypt, any phone, any browser at a non-local address, any tunnel or free host beyond its documents.

1. **Q1.** Does Let's Encrypt issue for a fresh nip.io name today under the shared pool, and does Caddy fall back to ZeroSSL if not?
2. **Q2.** Do iOS Safari, Android Chrome and Firefox treat `*.nip.io` names normally (Safe Browsing, phishing heuristics)?
3. **Q3.** Does the A8 cookie probe disable persistent identity on per-domain nip.io sites? Which outcome do we want?
4. **Q4.** Do quick tunnels and Funnel pass the tracker's WebSocket, and does the ngrok interstitial break a Service-Worker-served page (w1-10 Q7)?
5. **Q5.** Is `profile shortlived` (EXPERIMENTAL) reliable over many 6-day renewals, and does an IP origin look odd in any browser?
6. **Q6.** Is a project domain on the PSL realistic, and who pays and answers abuse notices?
7. **Q7.** Rungs without DNS: keep 90 days as retention (S3) or default to 399 with a reminder? Owner decision.
8. **Q8.** Do Surge and Codeberg answer `Range` with 206 and allow `no-cache` on `/mw-sw.js`? Does the Netlify free plan still pause projects?
9. **Q9.** How common is Wi-Fi client isolation in schools (S3's classroom kit)?
10. **Q10.** Will HaGeZi keep listing sslip.io and not nip.io? Can the pin container reach its own public name?

## Sources

Opened 2026-10-20 unless dated. [r] = search result or page not read in full.

- **[1]** https://nip.io/ **[2]** https://nip.io/experimental.html **[3]** https://github.com/cunnie/sslip.io-blocklist/blob/main/blocklist.txt (raw, 1,150 lines) **[4]** https://github.com/cunnie/sslip.io/blob/main/README.md
- **[5]** https://publicsuffix.org/list/public_suffix_list.dat (VERSION 2026-10-20_08-40-56_UTC, COMMIT 5dd321ff) **[6]** https://letsencrypt.org/docs/rate-limits/ (updated 2026-08-05) **[7]** https://letsencrypt.org/docs/challenge-types/ (updated 2026-02-12) **[8]** https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability
- **[9]** https://caddyserver.com/docs/automatic-https, /docs/caddyfile/directives/tls, /docs/caddyfile/options; Caddy v2.11.7, released 2026-10-03 **[10]** https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/dyndns-onlydomains.txt (version 2026.1016.0959.51)
- **[11]** Measurement log: `dig`, PSL and HaGeZi line checks, `publish`, `caddy validate` and `run`, `check-webseed`, `check-site`, `docker compose config` (session scratchpad). **[12]** https://unit42.paloaltonetworks.com/wildcard-dns-abuse/ [r] **[13]** https://forum.openwrt.org/t/nip-io-doesnt-work-for-local-network-behind-lede-solved-dns-rebind-protection/7766 (2017-10-22); https://tailscale.com/docs/reference/faq/dns-rebinding
- **[14]** https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts **[15]** https://support.apple.com/en-us/102390 (2025-03-26) **[16]** https://developer.android.com/privacy-and-security/security-config **[17]** https://github.com/FiloSottile/mkcert **[18]** https://blog.google/security/https-by-defau/ (2025-10-28) **[19]** https://lists.w3.org/Archives/Public/public-webauthn/2020Feb/0052.html [r] **[20]** https://arxiv.org/abs/1704.01296 (2017)
- **[21]** https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/ (updated 2026-09-30); .../get-started/create-remote-tunnel/ **[22]** https://tailscale.com/kb/1223/funnel; https://tailscale.com/kb/1242/tailscale-serve **[23]** https://ngrok.com/docs/pricing-limits/free-plan-limits/ **[24]** https://localhost.run/docs/ (and /docs/custom-domains, /docs/forever-free, /docs/faq, /docs/security)
- **[25]** https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits; .../securing-your-github-pages-site-with-https **[26]** https://developers.cloudflare.com/pages/platform/limits/ (2026-09-05); .../pages/get-started/direct-upload/ **[27]** https://docs.netlify.com/site-deploys/create-deploys/ (2026-09-24); https://www.netlify.com/pricing/ **[28]** https://surge.sh/; https://surge.sh/docs/getting-started **[29]** https://neocities.org/site_files/allowed_types; https://neocities.org/supporter; https://docs.codeberg.org/codeberg-pages/; [r] https://docs.codeberg.org/codeberg-pages/migrating-from-pages-v2/
- **[30]** https://blog.glitch.com/post/changes-are-coming-to-glitch/; https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ (2026-07-03) **[31]** https://www.digitalocean.com/pricing/droplets; https://www.hetzner.com/cloud/; [r] https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do **[32]** https://desec.readthedocs.io/en/latest/dns/domains.html; [r] https://jpmens.net/2025/03/04/a-look-at-domain-hosting-with-desec/ (2025-03-04)
