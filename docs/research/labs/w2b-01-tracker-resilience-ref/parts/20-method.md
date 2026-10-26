## Method, constraints and corrections to the first wave

**Resumed run.** The target file did not exist when this run resumed; the only earlier tracker research was `02-wss-trackers.md` (2026-10-14, read in full) with its probes (reused). Project context read: `docs/ARCHITECTURE.md`, `INTERFACES.md`, the four reviews (tracker-relevant sections: B1, M4, M6, M8, M9, m8, security M6), `src/loader/config.js`, `src/loader/torrent.js`, and the installed `bittorrent-tracker` 11.2.3, `torrent-discovery`, `webtorrent` 3.0.21 sources.

**What I ran (all under `w2b-01-tracker-resilience-ref/`, every number below is reproducible from there):** a 2-hour liveness soak of the public trackers (`probes/soak.py`, 24 samples planned at 5-minute spacing from 2026-10-17T20:50Z); browser and DNS block-list evaluation (`probes/filterlist-check/`); Nostr/MQTT/NIP-66 re-probes; a hardened reference tracker (`tracker/`) with 16 black-box tests, run on macOS 27 and on Ubuntu 24.04.5 (arm64, systemd 255, a short-lived OrbStack machine that was deleted afterwards; the engine was returned to "stopped"); synthetic load benchmarks of the stock library and the wrapper (`bench/`); Caddy 2.11.7 behaviour tests (`caddytest/`); a Cloudflare Durable Object tracker prototype tested in `workerd` (`cf-do/`); browser experiments with the project's real `webtorrent.min.js` in Chromium 156 and WebKit 27.2 (`e2e/`); `promtool` 3.15.0 validation of the Prometheus files.

**Constraints and limits.**
- *Search budget:* the shared WebSearch budget (200 per turn) ran out partway; everything after that was direct fetching of known primary URLs (no search engines, readers or archives). The unauthenticated GitHub REST API (60/h) was also exhausted, so GitHub data came from raw files and HTML pages. Hetzner's and Vultr's price pages could not be read.
- *Pages read through the fetch tool's summariser are marked [S] in the source list;* load-bearing numbers from them are flagged medium confidence unless a second source or a raw read confirms them.
- *Machine:* MacBook Air M3 (4 performance + 4 efficiency cores, 24 GB), macOS 27.0, Node 24.22.0, **shared with other jobs** (1-minute load average 2.5-7.8 during benchmarks): treat CPU numbers as ±25%. One network vantage point (one IPv4 address), no mobile network, no real phones, Firefox could not be launched by Playwright.
- *Load on third parties:* at most 3 short connections per public tracker per 5 minutes (about 60 short sessions per tracker over the soak), one GET per stats endpoint per sample, about 12 Nostr relays and 4 MQTT brokers probed twice, block lists downloaded once (about 300 MB from list hosts and CDNs).
- *Confidence scale:* high = read in primary source/code and/or reproduced here; medium = one good source or consistent indirect evidence; low = estimate, vendor claim or anecdote; **unverified** = said explicitly.

**Corrections to the first wave (`02-wss-trackers.md`).**
1. F13's "hardened programmatic server" imported `{ Server }` (it is a default export) and left the crash, ping, backlog, scrape and swarm-count defects open; superseded by `tracker/tracker.mjs`.
2. F17 said no public WebTorrent-protocol Durable Object tracker existed; `manalejandro/cf-feditorrent` has a partial one (F6). A working prototype now exists in `cf-do/`.
3. F6's inference "openwebtorrent runs wt-tracker" is strengthened (its `/stats.json` `memory` object has the keys of Node's `process.memoryUsage()`, and the schema matches), while the `OpenWebTorrent/openwebtorrent-tracker` repository is an unmaintained C++ project (last push 2021-06-27); the name "openwebtorrent-tracker" in the research brief therefore refers to that repo, not to what runs at tracker.openwebtorrent.com.
4. F19/F18: MQTT/Nostr results re-measured; MQTT brokers are on mainstream DNS block lists (new).
5. R3's keepalive proposal is refined: keepalive announces must carry `numwant: 0`, and the cadence/reconnect changes need per-instance patches of internal objects (F7).

**How to reproduce (from `docs/research/labs/w2b-01-tracker-resilience-ref/`, Node >= 22, Playwright from the repo's `node_modules`):**
```
cd tracker && npm ci && npm test                                  # 16 black-box tests;  node test/stock-crash-demo.mjs  /  node test/stock-ghost-demo.mjs  show the stock defects
python3 -I probes/soak.py results.jsonl 300 24                    # liveness soak;  python3 -I probes/soak_summary.py results.jsonl --exclude-file probes/results/soak-exclusions.txt
python3 -I probes/check_trackers.py --min-ok 3 --relay wss://tracker.webtorrent.dev wss://rtc.example.com      # the health check used for monitoring
python3 -I probes/check_webseed.py https://host/ws/site/file.bin https://host/site.torrent                     # Range + CORS check of a web seed
sh probes/filterlist-check/fetch-lists.sh /tmp/lists && (cd probes/filterlist-check && npm ci && node check.mjs /tmp/lists/browser/*.txt && python3 -I dnscheck.py /tmp/lists/dns)
node bench/bench.mjs --target hardened --conns 4000 --gens 3 --interval-ms 1000     # needs tracker/ installed; --target stock for the library as shipped
node caddytest/run.mjs (CADDY=/path/to/caddy)  |  node e2e/degrade.mjs  |  node e2e/tuning.mjs  |  node e2e/reconnect.mjs stock 12  (BROWSER=webkit MEMSTORE=1 for WebKit)
cd cf-do && npm ci && npx wrangler dev --local --port 8787 & node do-test.mjs && node ../e2e/do-e2e.mjs
```

**Evidence folder map.** `probes/` (soak, health check, list check, Nostr/MQTT scripts; `results/` raw outputs), `tracker/` (reference tracker, tests, stock crash demo), `deploy/` (Caddyfile, systemd unit, env, Dockerfile, fly.toml, cloud-init, `linux-verify.sh`, `results/`), `monitoring/` (Prometheus, rules, GitHub Actions example), `bench/` (harness, raw logs, `bench_summary.py`), `caddytest/`, `cf-do/`, `e2e/` (browser experiments, `results/`). Reused from wave 1: `docs/research/labs/02-wss-trackers-probes/`.

