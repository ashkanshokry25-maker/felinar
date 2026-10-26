# Operating a felinar site

Day-2 operations for a site that is already deployed ([DEPLOY.md](DEPLOY.md)): how to watch it when there is
no backend and no analytics, what it costs as it grows, what to do when a part fails, and how to handle abuse
notices, legal requests and privacy requests. Everything here works with the tools in this repository and a
few free services; nothing requires a server of your own beyond the static host.

> [!NOTE]
> This page describes 0.3.0, the release being prepared (0.2.1 was never published). The section "v0.3: operating the
> new parts" near the end covers what v0.3 adds: owner settings, moderation caps and undo, the file lanes, takedown with
> `_deny/`, hub safeguards and the runbooks for the identity origin.
>
> The legal sections summarise the research in [research/PRODUCTION-DIGEST.md](research/PRODUCTION-DIGEST.md)
> (sections 5.3 and 9), the research note it digests and a second pass by AI research agents (2026-10-22, synthesised
> 2026-10-24) that read the laws' own texts and the regulators' guidance. They are not legal advice, no lawyer has
> reviewed them for any jurisdiction, and they describe the law as the research read it on those dates. Before you run
> a hub or host other people's content, do what the positions table asks of you, and get advice from a lawyer where
> you operate if you can.

Commands use `npx felinar <command>`, which runs `node tools/<file>.mjs` from a clone of this repository.

## What you operate

| Part | When it fails | Who notices first | How you find out |
|---|---|---|---|
| Static host (the loader) | new visitors can't load anything; returning shell visitors render their saved copy; drop-in visitors get the pages they visited before, from their browser | new visitors | `check-site` (page step), an uptime check |
| Web seed (`ws=`, `xs=`) | with nobody else online, new visitors can't download the site | first visitors at quiet hours | `check-site` (web seed step), `check-webseed` |
| Trackers (`tr=`) | visitors can't find each other; the site still loads from the web seed, but the ledger stops syncing between visitors | posters on open ledgers | `check-site` (tracker step) |
| STUN servers | more peer connections fail; the web seed carries those visits | nobody, usually | the diagnostics panel's connectivity class |
| DNS-over-HTTPS | only sites whose pointer is in DNS alone: first visits can't find the pointer | first visitors | `check-site` (DNS step), the `curl` checks below |
| Snapshot (`cs=`) | fresh visitors see no shared data until a peer has it, and can't post to an open ledger without the genesis block | first posters | `check-site` (snapshot step) |
| Pin node | the ledger has no copy that is always online; new posts reach only visitors who overlap | late visitors | its log, the tracker's seeder count |
| Owner key | you can't publish, re-sign, rotate or withdraw | you, on the next publish | keep it backed up offline |

## Monitoring without a backend

The loader sends nothing home: no analytics, no error reporting, no beacons. So you learn about problems in two
ways ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 8.1). The page tells a visitor *what* failed, and a
probe from outside tells you *why*. Browsers hide the reason a WebSocket or a `fetch` failed from page scripts
by specification, which is why the outside probe matters.

### What visitors can tell you

A shell page shows a diagnostics list under Settings, Diagnostics, with a remedy for the owner; when someone
reports a problem, ask for that list. A drop-in page has no such list: it writes each warning once to the
browser console and keeps a short log. On a desktop browser, or on a phone over remote debugging (Safari's Web
Inspector, `chrome://inspect`), the console gives you more:

- `window.__mwShell.inspect()` in a shell page returns the mode, pointer source, consent state, policy class,
  connectivity class, peers, web seed backoffs, the ledger's height and peers, and the diagnostics lines.
- `window.__mwDropin.inspect()` in a drop-in page returns the engine's state (and why it is off), consent
  state, the Service Worker's mode, the stored copy, peers, the policy column and the log.

What the shell's list says, and what it means:

| Visitor sees | Meaning | What the loader tells the owner |
|---|---|---|
| Connection servers unreachable | no tracker answered | add another tracker (`tr=`) to the pointer or run your own with `tools/tracker.mjs` |
| Nobody online to serve this site right now | a tracker answered and reports no other visitor, and the download isn't finished | add `xs=` and `ws=`, or run `pin.mjs` |
| N peer connections failed (likely NAT) | peers exist, direct connections failed | keep `ws=` in the pointer so these visitors load from your host |
| No web seed in the pointer | the pointer has neither `ws=` nor `xs=` | add `xs=` and `ws=`, or run `pin.mjs` |
| Web seed misconfigured (no Range support) | the loader's check of the web seed failed (no 206, CORS or the network) | answer `OPTIONS` with `Access-Control-Allow-Headers` and serve `Range` with 206 (`tools/check-webseed.mjs`) |
| Web seed skipped after repeated failures | 3 failures in 30 seconds; skipped for 5 minutes | serve every `Range` with 206 and the exact bytes |
| Cannot resolve pointer (DNS over HTTPS blocked) | no resolver answered for a DNS-only pointer | put the pointer in a `<meta name="mw-pointer">` tag on the host |
| N peer connections closed for oversized messages | a peer announced a message above 256 KiB | nothing to fix: the loader closes such connections |

The connectivity class comes from a 2.5-second STUN probe at boot: `easy-mapping`, `easy-probable`, `hard`
(strict NAT), `udp-blocked-or-no-stun`, `relay-only-reachable`, `unknown-single-stun` or `no-webrtc`.

### Probe from outside: check-site

`check-site` checks a live site the way a first visitor's browser would: the page and its loader files
(including the SRI hashes of the two static script tags, so a stale CDN copy shows up), the pointer in the page
and in DNS, its signature and expiry, the `.torrent`, the web seed (every file, the first and last piece
hashed), each tracker (a connection, a `stopped` announce and a scrape that counts seeders) and the snapshot.
It exits 0 when everything passes (warnings allowed), 1 on any failure and 2 on a usage error.

```sh
npx felinar check-site https://example.com/                          # human-readable
npx felinar check-site https://example.com/ --json > result.json     # { url, ok, failures, warnings, results }
npx felinar check-site https://example.com/ --tolerate-trackers 1    # one failing tracker is not a failure
npx felinar check-site https://example.com/ --full                   # also a full GET of every web seed file
npx felinar check-site https://example.com/ --headless --consent     # also load it in Chromium like a visitor
```

`check-site`, `check-webseed` and `pin` are the three tools allowed to reach the internet; each prints its
targets before it connects ([DEV-NETWORK.md](DEV-NETWORK.md)). `--headless` needs Playwright's Chromium
(`npx playwright install chromium`).

**From cron, with a dead-man's switch.** A scheduled check that silently stops is worse than none, so ping a
service such as Healthchecks.io on success and on failure, and let it alert when the pings stop:

```sh
#!/bin/sh
# check-site.sh: run every 30 minutes from cron or a systemd timer
URL=https://example.com/
HC=https://hc-ping.com/<your check uuid>
cd /opt/felinar || exit 1
curl -fsS -m 10 --retry 3 "$HC/start" > /dev/null
if npx felinar check-site "$URL" --json > /tmp/check-site.json; then
  curl -fsS -m 10 --retry 3 --data-binary @/tmp/check-site.json "$HC" > /dev/null
else
  curl -fsS -m 10 --retry 3 --data-binary @/tmp/check-site.json "$HC/fail" > /dev/null
fi
```

```text
7,37 * * * * /opt/felinar/check-site.sh
```

The ping URL is a secret: anyone who has it can mark the check healthy
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 5.2).

**From GitHub Actions.** A public monitor repository runs this for free. Scheduled runs start 5 to 60 minutes
late, with outliers of hours, and GitHub disables schedules after 60 days without activity in the repository,
so give the dead-man's switch a grace period of at least 60 minutes
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), D11 and 5.2). Pin each action to a full commit SHA.

```yaml
name: canary
on:
  schedule:
    - cron: '7,37 * * * *'
  workflow_dispatch: {}
permissions: {}
concurrency:
  group: canary
  cancel-in-progress: false
jobs:
  check-site:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<full commit sha>
        with:
          repository: ashkanshokry25-maker/felinar
          ref: v0.3.0
          persist-credentials: false
      - uses: actions/setup-node@<full commit sha>
        with:
          node-version: 24
      - run: npm ci --omit=dev
      - run: curl -fsS -m 10 --retry 3 "https://hc-ping.com/$HC_UUID/start"
        env:
          HC_UUID: ${{ secrets.HC_UUID }}
      - run: node tools/check-site.mjs "https://example.com/" --json > result.json
      - if: success()
        run: curl -fsS -m 10 --retry 3 --data-binary @result.json "https://hc-ping.com/$HC_UUID"
        env:
          HC_UUID: ${{ secrets.HC_UUID }}
      - if: failure()
        run: curl -fsS -m 10 --retry 3 --data-binary @result.json "https://hc-ping.com/$HC_UUID/fail"
        env:
          HC_UUID: ${{ secrets.HC_UUID }}
```

A runner sits in a data centre behind a clean NAT. It can't see what phones on mobile networks, carrier NAT,
corporate firewalls or iOS suspension do to real visitors; only visitors' diagnostics and the release gate
([DEMO-RESULTS.md](DEMO-RESULTS.md)) show that.

### Uptime checks for each part

| Part | Check | How | How often |
|---|---|---|---|
| Static host | the page and `/mw-sw.js` answer 200 | `check-site`; any HTTP uptime service for a second vantage point | 30 minutes; 5 minutes for the HTTP check |
| Web seed | ranges answer 206 with the right bytes | `check-site`; `check-webseed --pieces all` for every piece | 30 minutes; weekly |
| Trackers | a WebSocket opens and an announce is accepted | `check-site` | 30 minutes |
| DNS-over-HTTPS | each resolver returns your TXT record | the three `curl` commands below | 30 minutes, if you publish in DNS |
| Snapshot | `cs=` downloads and holds the genesis block | `check-site` | 30 minutes |
| Pin node | it is running and seeding | its log, and the tracker's seeder count (below) | 5 minutes |
| Pointer expiry | more than 14 days left | `check-site` warns under 14 days | daily |
| TLS certificates | more than 14 days left | your uptime service | daily |

```sh
curl -fsS -m 10 -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=_magnet.example.com&type=TXT'
curl -fsS -m 10 -H 'accept: application/dns-json' 'https://doh.dns.sb/dns-query?name=_magnet.example.com&type=TXT'
curl -fsS -m 10 'https://dns.google/resolve?name=_magnet.example.com&type=TXT&edns_client_subnet=0.0.0.0/0'
```

These are the three resolvers the loader asks, in that order, with 4 seconds each (`src/loader/doh.js`). Each
answer should have `"Status":0` and your record in `Answer`.

`check-site` treats a pointer that expires within 14 days as a warning, not a failure, so a cron job that only
looks at the exit code misses it. Fail on warnings too, or on that one:

```sh
jq -e '.warnings == 0' /tmp/check-site.json > /dev/null || echo "check-site has warnings"
```

**The pin node.** `pin.mjs` writes one status line to standard output every 60 seconds (none with `--quiet`)
and sends no heartbeat of its own. Two cheap signals: its log keeps growing, and your tracker reports at least
one seeder for the site. The tracker step of `check-site` prints the counts
(`... 1 seeder(s), 0 leecher(s) online now`):

```sh
# the pin's log was written in the last 3 minutes: in Docker (deploy/pin/README.md)...
docker logs --since 3m mw-pin 2>&1 | grep -q . || echo "pin node silent"
# ...or when you run it yourself with its output sent to a file
find /var/log/mw-pin.log -mmin -3 | grep -q . || echo "pin node silent"
# at least one seeder on some tracker (the pin, when nobody else is online)
jq -e '[.results[] | select(.step == "tracker") | .message | capture("(?<n>[0-9]+) seeder") | .n | tonumber] | max >= 1' \
  /tmp/check-site.json > /dev/null || echo "no seeder online"
```

### Alerts and service levels

Proposals from the research, not measured targets; adopt them, then tune them on your own data
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 8.2):

- Alert only after two failures in a row.
- Page someone: the static host is down; the web seed is down and no seeder is online; the pointer is invalid
  or expires within 3 days; the pin node is silent.
- Send a notification: one tracker is down; DNS-over-HTTPS resolvers disagree; a TLS certificate expires within
  14 days.
- Service levels: a cold load from the web seed succeeds in 99% of canary runs over 30 days; at least one seeder
  is online on at least two trackers 99.5% of the time; the pointer never has less than 14 days left.

## Capacity and economics

The numbers in this section are model outputs of `docs/research/labs/w2c-07-lab/little-calc.mjs`, from
[IMPROVEMENTS-DIGEST](research/IMPROVEMENTS-DIGEST.md) section 9, unless another source is named. Field data
will replace them. The tables behind them (visitors online at once, the share of visitors who can serve, and
where the bytes of a first load come from) are in [WHY.md](WHY.md#honest-economics); run the calculator with your
own visits, mean visit length and site size.

### How many visitors overlap

Visitors online at once = visits per day x mean seconds on the site / 86,400 (Little's law), and the chance that an
arriving visitor finds nobody else online is `exp(-visitors online)`. Use the mean time on site, not the median. At
1,000 visits a day of 60 seconds, 0.69 visitors are online and half of all visitors arrive alone. Only about 1
visit in 12 can serve (it shares, on a desktop or a confirmed network, with a direct connection that works), so 25
such seeders online take about 448,000 visits a day.

### When the web seed is the CDN

On a first visit the web seed and the peers race. A peer needs 1.5 to 3 seconds before bytes flow, and a fast
web seed delivers about 16 MiB in that time, so for small sites the web seed is the whole delivery network: a 2 MiB
site gets 0% of its first load from peers even with 100 seeders online, and a 128 MiB site with 10 seeders online
about 47%.

Plan the host's capacity and bill for all first-visit bytes unless your site is large, popular and visited for
minutes at a time. Peers buy resilience, offline revisits and ledger sync between visitors, not a smaller bill
([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), O2).

### Estimating host egress

- **Shell mode:** each visitor downloads each version once; a returning visitor whose copy is complete makes only
  small revalidation requests (the shell page and `/mw-sw.js`). Host egress per month is about new copies per
  month x site size x (1 - peer share), plus the loader on each first visit: about 117 KB for `loader.js` and
  64 KB for `webtorrent.min.js`, compressed ([WHY.md](WHY.md), "The loader costs bytes").
- **Drop-in mode:** each new device on an unmetered network fills a copy of all non-HTML files from the host
  once, at idle. Per device the host serves S x (1 - p) + p x B instead of B, where S is the copy size, B a
  typical visit and p the share peers fill: a multiplier of 13.3 for a 20 MB copy and a 1.5 MB visit with no peer
  help ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), M10; a model, not a measurement). `publish --dropin` prints the
  copy size.
- **Requests:** on hosts that bill per request, a cold shell visit costs about one ranged request per piece plus
  one per file, and the stock WebTorrent client adds a preflight per file, which felinar's patched client
  didn't send in Chromium 156 or WebKit 27.2 ([MIGRATION-DIGEST](research/MIGRATION-DIGEST.md), O3).

Uploads by visitors are rate-limited (1 MiB/s on a desktop, 128 KiB/s on a phone after the visitor opts in;
`src/loader/config.js`) but have no byte budget yet; budgets per visit and per day are on the
[ROADMAP](ROADMAP.md).

### What a visitor on mobile data pays

Uploading 15 MiB on mobile data costs a visitor about $0.038 at the 2023 global mean of $2.59 per GB, about 30
times the $0.00125 the host saves (2023 prices). That's why every phone downloads only, until its visitor turns
on "Share on this network" for the site.

### Your own tracker and a pin node

| Item | Figure | Source |
|---|---|---|
| Tracker memory | about 25 KiB per socket plus about 70 MB; 20,000 sockets in about 0.6 GB | [PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 7.1 |
| Tracker CPU | one core handles roughly 15,000 to 23,000 announces a second | same |
| Expected load of a small site | 10 to 1,400 concurrent sockets | same |
| Tracker hosting | $0 (Oracle Always Free, reclaimed when idle for 7 days) to about $7 a month | same |
| Pin node hosting | $0 to about $6 a month for a small VM; Chromium's cost per pinned site is not measured | same, 7.2 |
| Monitoring as above | $0 with free tiers | same, 8.2 |

## Incident runbook

Each entry: what you see, what to check, what to do, and what to do afterwards. Write down what happened and
when; the same log serves the transparency report.

### The static host is down

- **You see:** `check-site` fails at the page step; new visitors get the host's error. Returning shell visitors
  still render their saved copy ("From this device"), and drop-in visitors get the pages they visited before.
- **Do:** restore the host, or switch DNS to a standby host that holds the same deploy. The pointer is signed for
  the hostname, not for a provider, so an identical copy of `dist-publish/shell/` and the web seed on a second
  provider serves the same site. Keep the standby in step with every deploy; DNS changes take the record's TTL
  to spread.
- **Afterwards:** a web seed on a second provider (R2 behind a custom domain, say) lets returning visitors whose
  browser still holds the loader download the site again while the loader host is down. New visitors need the
  loader host, or a standby, either way.

### The web seed fails

- **You see:** `check-site` fails at the web seed step; visitors see "Web seed misconfigured (no Range support)",
  "Web seed unreachable (CORS preflight or network error)" or "The web seed <host> is serving the wrong bytes,
  so it is skipped for 5 minutes."
- **Check:** `npx felinar check-webseed <ws base> dist-publish/site.torrent` and read the verdict.
- **Do:** `FAIL-range-ignored`: the host stopped honouring `Range` (a CDN setting, or the wrong host); move the
  seed. `FAIL-wrong-bytes`: an edge transform (compression, image optimisation, minification) or a file
  overwritten in place; turn the transform off, upload the right bytes, purge the CDN. `FAIL-cors`: restore the
  CORS rules. `FAIL` with a 404: the files are missing; upload them again.

### A tracker is down

- **You see:** `check-site` fails at a tracker step; visitors see "Connection servers unreachable" when all are
  down. The site still loads from the web seed ("Peer discovery unavailable; loading from web seed").
- **Do:** for your own tracker, restart it and check that the allow file lists the current versions'
  `summary.json`. If files, media or member ledgers stopped finding peers while the site still works, check that the
  tracker runs in uploads mode (its start line says "unlisted swarms"; DEPLOY.md, "Your own tracker"); its
  `/stats.json` (from inside the container) showing `unlisted` near 10,000 means the unlisted swarms are taken and new
  uploads are refused: raise `--max-swarms`, or restart it. For a public tracker that stays down, publish a new version without it: the tracker list is
  part of the signed pointer. Changing it changes the recipients of visitors' consent, so every visitor who chose
  "Share and load" is asked again.
- **Meanwhile:** `check-site --tolerate-trackers 1` keeps your canary green while you decide.

### DNS-over-HTTPS is down or blocked

- **You see:** only for sites whose pointer is in DNS alone: "Cannot resolve pointer (DNS over HTTPS blocked)".
  Sites with a page tag are unaffected, because DNS is only their update channel. Enterprise networks often block
  the resolvers' hostnames ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), 5.3).
- **Do:** put the pointer in the page tag (it is the default for a reason). To use another resolver, add
  `<meta name="mw-doh" content="https://doh.example.net/dns-query?name={name}&type={type}">` to the shell's
  `index.html` and `404.html`; it must answer DNS JSON with CORS headers.

### A STUN server is down

- **You see:** connectivity classes such as `unknown-single-stun` or `udp-blocked-or-no-stun` in visitors'
  diagnostics, and more failed peer connections. The boot-time probe drops a server that doesn't answer, and the
  web seed carries the visits that can't connect.
- **Do:** nothing urgent. The STUN list is part of the loader (`CONFIG.stun` in `src/loader/config.js`), so
  changing it takes a new build and deploy, and it changes the consent recipients too.

### A bad loader deploy

- **You see:** first visits stuck on "Starting..."; `check-site` reports an SRI mismatch or a missing `/_mw/`
  file. Returning visitors are usually fine: a new worker whose files don't match the build's hashes fails its
  install, and the previous worker keeps control (ARCHITECTURE 7.1, item D2).
- **Do:** deploy one complete, consistent `dist/` (or the previous one) and purge `/index.html`, `/404.html`,
  `/mw-sw.js` and `/_mw/*`. If visitors are stuck with a worker that breaks navigation, deploy the kill switch
  ([DEPLOY.md](DEPLOY.md#kill-switch)).

### A bad site version

- **Do:** roll forward: publish the previous good files again with a new `seq` and deploy in order
  ([DEPLOY.md](DEPLOY.md#rollback)). Never re-upload an old pointer; visitors refuse its lower `seq`.

### The pointer expired

- **You see:** returning visitors see "Pointer expired on <date>; showing the last known version."; new visitors
  can't load the site ("Could not find this site's address").
- **Do:** run `publish` again with the same files (it only re-signs: same infohash) and deploy the new page tag
  and TXT record. Keep the expiry check in your monitoring so this doesn't happen twice.

### The owner key is lost

You can't sign anything for the site any more. A new key can sign a pointer, but without a rotation signed by the
old key every visitor who remembers the old one sees "publisher key changed" with both fingerprints and must
confirm. The ledger can't be handed to the new key either, so publishing with the new key starts a new, empty
ledger (`publish` says so). Keep the owner key backed up offline; there's no recovery.

### The owner key is stolen

Assume the thief can do everything you can with it: sign pointers and withdrawals for your hostname, and sign
ledger control blocks (a policy, bans, deletions, a hand-over to their own key) and spread them through the swarm.
For a per-domain site, a pointer reaches visitors only through your page tag and your TXT record, so the thief
also needs your host or your DNS to change what visitors load. Secure those accounts first.

Then move to a new key and hand the ledger over to it:

```sh
# 1. a new key
npx felinar keygen --out ~/keys/owner-2.jwk
# 2. the current ledger as a JSON file: the pin node's snapshot, an export from Settings ("Export ledger JSON")
#    or the file at your cs= URL
gunzip -c /var/lib/mw-pin/ledger.json.gz > ledger.json
# 3. hand the ledger to the new key, endorsed by the new key; the owner= value comes from keygen's output
npx felinar ledger owner --key ~/keys/owner.jwk --file ledger.json --next p256:<new owner key> \
  --accept-key ~/keys/owner-2.jwk
npx felinar snapshot ledger.json --out snapshot.json.gz
# 4. upload snapshot.json.gz to the URL your pointer's cs= names, then rotate the pointer (same --out as before)
npx felinar publish ./site --name my-site --scope example.com --key ~/keys/owner-2.jwk \
  --prev-key ~/keys/owner.jwk --cs https://example.com/ws/snapshot.json.gz <your other flags> --out dist-publish
```

Deploy the snapshot first and the new pointer right after it. Upload `snapshot.json.gz`, not `genesis.json`:
`publish` reminds you about `genesis.json`, which holds only the first block and not the hand-over. `rot=` lets
visitors switch keys without a prompt, and the pointer keeps naming the ledger's original owner (`lo=`), so the
ledger and its history stay. In the gap between the two steps a visitor may briefly see "pointer and ledger owner
differ".

What this doesn't undo:

- If the thief already published a rotation through your host or DNS, visitors who received it now trust the
  thief's key. Your new pointer reaches them as "publisher key changed", and they must confirm it.
- If the thief signed a hand-over of the ledger too, visitors follow the hand-over that the key in their pointer
  endorses, and pause owner changes until one is endorsed (`npx felinar ledger accept` writes an endorsement
  later). Deletions the thief signed before your hand-over stand, because there is no undelete. Bans can be lifted
  once you hold the ledger again (`npx felinar ledger unban`), but an unban does not bring back the payloads a ban
  dropped ([Moderation](#moderation-caps-undo-and-bulk-actions)).
- A key committed in advance closes the first gap: a 0.3.0 pointer published with `publish --next-key` commits to the
  next owner key (`nx=`), so a rotation to any other key is not accepted silently
  ([the v0.3 runbooks](#runbooks-for-v03-incidents)).

### A moderator key is misused

Moderators can delete any post, ban authors and write keys that start with `_`; they can't change the policy or
the owner. A moderator key imported in a browser is a hot key.

- **Do:** write a new policy that lists only the moderators you keep (into `ledger.json`, fetched as in step 2
  above), then publish it as the snapshot:

```sh
npx felinar ledger policy --key ~/keys/owner.jwk --file ledger.json --moderator p256:<kept moderator>
npx felinar snapshot ledger.json --out snapshot.json.gz
```

A policy block changes only the fields you give. `--moderator` sets the whole list, so name every moderator you
keep (repeat the flag), or pass `--clear-moderators`. Bans and deletions the moderator made before the change stand
until you undo them: list the moderator in `voided` (their control blocks after the point you trust then have no
effect), or lift their bans with `unban`. Both are in 0.3.0, the freeze group ([Moderation](#moderation-caps-undo-and-bulk-actions)).

### A spam flood on an open ledger

- **You see:** many posts from new authors; the ledger approaches its byte cap. At the cap a device takes only
  entries from the owner, moderators and allow-listed authors, and says "The ledger is full on this device. Only
  entries from the owner and moderators are added now."
- **Do, from mildest:** delete and ban; raise the fee (`ledger policy --bits 18`: each extra bit doubles the
  expected work); switch to an allow list (`--writers allow` with `ledger allow --add <pub>`); or close writing
  (`--writers owner`). Publish the new policy as the snapshot.
- **Know the limit:** the fee is a spam fee, not security. One RTX 4090 hashes about 1,650 times faster than a
  browser using five workers on an M3 laptop ([RESEARCH-DIGEST](research/RESEARCH-DIGEST.md), verdict 8), and a
  native attacker fills the default 8 MiB ledger in about 13 minutes on one core at 16 bits
  ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 4.1 claim 5). Allow lists and moderators are the real
  tools. Each visitor's loader also throttles every author to 30 entries per 10 minutes (`src/loader/config.js`),
  locally.

### The ledger is full

The default cap is 8 MiB and the ceiling 64 MiB (ARCHITECTURE 6.1). Raise it with
`ledger policy --max-chain-bytes <bytes>` and a new snapshot, or delete old posts. 0.3.0 can also prune old history
behind a checkpoint: after the owner's `checkpoint` (`npx felinar ledger checkpoint`), copies that hold its signed
snapshot drop every earlier block ([Moderation](#moderation-caps-undo-and-bulk-actions)). A snapshot of a full 8 MiB ledger is about 3.1 to 3.9 MiB gzip
([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), section 10).

### An abuse or legal notice arrives

Follow the notice-and-action runbook below.

## Abuse and legal operations

Not legal advice: a summary of research notes for planning ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md), 5.3
and 9; research `w2b-06-abuse-legal-ops.md`), checked against the statutes, rules and regulators' pages it cites by AI
research agents on 2026-10-22. No lawyer has reviewed it. If a notice, an order or a claim arrives, get advice from a
lawyer where you operate.

### Who is exposed to what

| Role | Who in felinar | Main exposure (research reading) | Levers |
|---|---|---|---|
| Site owner, publisher | you, with the owner key | copyright in the content; a controller under the GDPR and the UK GDPR, where they apply to you, for the data your loader makes browsers send and for what you hold; a hosting provider under the EU Digital Services Act for visitor posts you store, if the site has a substantial connection to the EU; the provider of a user-to-user service under the UK Online Safety Act if visitors can write, message or share files and UK people use the site (personally, if you are an individual and no organisation controls who can use it); in Canada, an organization under PIPEDA or an enterprise under Quebec's Act if your activity is commercial or, in Quebec, organized | withdraw, publish without the content, delete posts, ban authors, remove files from the web seed |
| Loader host and web seed host | GitHub, Cloudflare, AWS, Netlify | a hosting provider for the bytes it serves; its own terms and repeat-infringer policy | disable files or the account |
| Hub operator | whoever runs a hub | a controller of its own logs and, with the owner, probably of what a hub-run tracker, mailbox or pin does; under the DSA a hosting provider, and probably an online platform, for what it stores and shows to the public (and under the EU terrorist-content Regulation if it makes content public in the EU); under the Online Safety Act the provider of the parts where it controls who can use them, otherwise an "access facility" that a court can be asked to order to restrict a non-compliant site (the research's reading); in the US possibly a DMCA "service provider" (storage at users' direction, 512(c), for what its pin keeps, or a location tool, 512(d), for what it links to), a "provider" under 18 U.S.C. 2258A and a "covered platform" under the TAKE IT DOWN Act, none of it tested for a hub; Safe Browsing reputation for the whole hub domain | none in 0.3.0 beyond infrastructure (no hub denylist) |
| Tracker and STUN operators | public volunteers, or you | they see visitors' IP addresses and the infohash | drop the infohash from an allow list |
| Visitors who share | anyone who chose "Share and load" | they "make available" what their browser uploads, when duly informed (the CJEU's Mircom reading, which the court tied to an informed user) | pause sharing, "Load from host only", forget the site |
| Pin node operator | you | a hosting provider under the DSA for whatever it stores at members' request, and the controller of its own IP logs and of the public files it keeps and serves; in the US a DMCA 512(c) "service provider" for files stored at members' direction (it needs a registered agent and must act on notices; it does not have to scan, 512(m)), and a "provider" under 18 U.S.C. 2258A if it stores files for the public | stop pinning, quarantine by infohash |
| Project maintainers | this repository | inducement through marketing or examples (after Cox v. Sony, 2026-03-25, contributory liability needs intent); not a controller, a processor or the provider of any service, because the maintainers run none | neutral documentation and examples |

### Before launch

| Item | Who |
|---|---|
| A contact in the pointer (`publish --ct mailto:abuse@example.com`) and a privacy and terms page (`--lg`) | every owner |
| Mailboxes that a person reads: `abuse@`, `privacy@`, `security@` (and `dmca@` for a hub); send a test message to each | every owner |
| `/.well-known/security.txt` (template below) | every owner |
| A privacy notice ([PRIVACY.md](PRIVACY.md) has the template) linked from the site | every owner |
| A case log in an encrypted, access-controlled place | every owner with open writing |
| A takedown drill: time a test notice to a deployed withdrawal and to an open page that stops sharing; record it in [DEMO-RESULTS.md](DEMO-RESULTS.md) (row G19) | every owner |
| A registered DMCA agent (online at dmca.copyright.gov, $6, renewed every three years, with the operator's legal name and street address, and the agent's contact published on the site), terms with a repeat-infringer and counter-notice section, a transparency page, a lawyer if you can get one | hub operators, pin-node operators and owners who host other people's files or posts at scale |

```text
Contact: mailto:security@example.com
Expires: 2027-06-30T00:00:00.000Z
Preferred-Languages: en
Canonical: https://example.com/.well-known/security.txt
Policy: https://example.com/security
```

`security.txt` (RFC 9116) needs `Contact` and an `Expires` under a year away. In shell mode, put it next to the
shell on the host, as a plain file.

Without a domain of your own, the contact can be an `https:` page you control (`--ct` takes an `https:` or a `mailto:`
URL) or any mailbox you read at a mail provider. Never derive one from the site's name: a nip.io or sslip.io name, an IP
address or a platform name such as `<user>.github.io` receives no mail for you.

### Intake

Make reporting easy and make every report actionable. A static page at `/report` that lists what to send and
opens a prefilled email is enough:

```html
<a href="mailto:abuse@example.com?subject=Report%20for%20example.com&body=What%20is%20illegal%20or%20abusive%2C%20and%20why%3A%0A%0AWhere%20(page%20URL%2C%20file%20path%2C%20or%20the%20post%20id)%3A%0A%0AYour%20name%20and%20email%3A%0A%0AI%20believe%20in%20good%20faith%20that%20this%20report%20is%20accurate%20and%20complete.">Report a problem with this site</a>
```

A notice must name something you can act on: the hostname (or hub label), the infohash (`btih`), the file path,
and for a post the block hash `h`. A title alone isn't enough. Show each post's `h` in your site's UI (a "Copy
post id" button) so reporters can name it; the SDK gives it to you on every list item.

### The notice-and-action runbook

| Class | Examples | Acknowledge | Act |
|---|---|---|---|
| P0 | child sexual abuse material, terrorist content, an imminent threat to life or safety | within 1 hour | block within 1 hour of a credible report; report to the authority the same day; never open or copy the material; an EU removal order for terrorist content has a one-hour clock |
| P1 | a court or regulator order, a law-enforcement request | the same business day | by the order's deadline; counsel before you disclose anything about anyone |
| P2 | copyright, phishing and malware, privacy erasure, defamation | within 1 business day | phishing and malware within 24 hours, the rest within 2 business days |
| P3 | terms violations, spam | within 3 business days | within 5 business days |

Steps for every notice:

1. **Log it:** a case id, the time received (UTC), the channel, and the raw notice stored unmodified with its
   SHA-256.
2. **Acknowledge it** (template below).
3. **Validate it.** If it lacks something you need, say what. A credible P0 report is acted on first and
   questioned afterwards.
4. **Find the tuple:** hostname or label, `btih`, file path, block hash. No tuple, no action.
5. **Pick the narrowest lever that stops the harm** (next table).
6. **Apply it** and record what you did and when.
7. **Tell the owner** (when you aren't the owner) with a statement of reasons.
8. **Run the counter-notice route** (copyright): in the US, restore 10 to 14 business days after a valid
   counter-notice unless the claimant tells you they went to court; in the EU, offer a review by a person.
9. **Close it:** record the time to act and the outcome, and update the repeat-infringer record.
10. **Escalate to counsel** for any order, contact from law enforcement, child abuse or terrorism case, request to
    identify visitors, threatened litigation, or a flood of notices from one sender.

Levers in 0.3.0 (the v0.3 section adds temporary bans, unban, bulk deletion and moderator caps):

| Lever | How | Reaches | When |
|---|---|---|---|
| Withdraw the whole site | `publish --withdraw`, then the pointer everywhere it lives ([DEPLOY.md](DEPLOY.md#takedown)) | loaders that see it stop sharing and delete every stored version | open shell pages on focus or the next DNS check, others on their next load; offline devices keep their copy |
| Publish a version without the content | publish and deploy | visitors drop the old version on their next load | as above |
| Delete a post | a moderator key imported in the loader with the site's moderation buttons (`mw.db.tombstone(h)`), or `npx felinar ledger tombstone` and a new snapshot | visitors who receive the deletion | as fast as the deletion spreads between visitors |
| Ban an author | `mw.mod.ban(pub)` with a moderator key, or `npx felinar ledger ban` and a new snapshot | everything that author wrote, for visitors who receive the ban | as above |
| Remove files from the host and the web seed | delete the objects, purge the CDN | every new HTTP download | at once; peers that hold the files can still serve them |
| Drop the infohash from your tracker | remove its `summary.json` from `--allow` | visitors who find each other only through your tracker | at once |
| Remove the Service Worker | the kill switch | returning visitors | their next navigation |

What no lever can do: recall bytes from a device that stays offline or from software that ignores these signals,
stop the same files from being published again under a new infohash or domain, or delete what third-party
trackers, STUN servers and resolvers logged. Say so when you answer a notice.

### Templates

**Acknowledgement:** "We received your notice on <date> (case <id>). We will review it and tell you what we
decide. If anything required is missing we will say what."

**Deficient notice:** "We could not act on notice <id> because it does not yet identify <missing item>. We need
the site address, the infohash, and the file path or post id. A work title on its own does not let us find
content."

**Counter-notice received:** "We received your counter-notice on <date>. We have sent it to the claimant. Unless
they tell us they have started court action, we will restore access between <date range>."

**Statement of reasons** (to a site owner whose content you restricted; the fields of DSA Art. 17(3)):

1. The decision: removed, access disabled or suspended; where; for how long.
2. The facts: what and when, and whether it came from a notice or your own review.
3. Automated means used: none.
4. The legal or contractual ground, and why it applies.
5. How to challenge it: your internal review, out-of-court dispute settlement where available, the courts.

**Repeat infringers** (for a hub or a host of other people's sites): "In appropriate circumstances we end the
access of site owners who repeatedly infringe. We treat a site owner as a repeat infringer after <3> valid notices
within <24> months that were not successfully counter-noticed, counted by signing key, registered domain and
verified contact. We may block the key and the domain."

### Positions by jurisdiction

| Where | What the research found | What it means here |
|---|---|---|
| US, copyright | DMCA s.512 (17 U.S.C. 512) limits monetary relief against a "service provider" that stores material at a user's direction (512(c)) or links to it (512(d)), and limits injunctions to the forms in 512(j). Conditions: a designated agent registered with the Copyright Office, expeditious action on a notice with the elements of 512(c)(3), a repeat-infringer policy that is applied, and no actual or "red flag" knowledge and no direct financial benefit it could control. The statute sets no number of hours, and nothing makes a provider monitor (512(m)). A counter-notice restores the material 10 to 14 business days later unless the claimant has sued (512(g)(2)(C)); it must consent to a US federal court's jurisdiction (for an address abroad, any district where the provider may be found) and accept service (512(g)(3)(D)). Contributory liability needs intent: inducement, or a service tailored to infringement (Cox v. Sony, decided 2026-03-25, an internet-provider case that decided nothing about a peer-to-peer loader). | Hubs and anyone storing other people's files register an agent before launch. Which part of 512 fits a hub that only serves a loader is untested: no decision was found. The project and an owner who store nothing for others need no agent. Keep marketing and examples neutral. |
| US, Section 230 | 47 U.S.C. 230(c)(1): no provider or user of an "interactive computer service" is treated as the publisher or speaker of information provided by another. It does not limit intellectual property law (230(e)(2)), federal criminal law including the child exploitation chapter of title 18 (230(e)(1)) or sex trafficking claims (230(e)(5)). A person "responsible, in whole or in part, for the creation or development" of content is a content provider for it (230(f)(3)). | A hub or an owner who hosts visitors' posts may rely on it against claims such as defamation, not against copyright or child abuse material. No decision was found on a peer-to-peer loader. |
| US, abuse images and intimate images | (1) 18 U.S.C. 2258A: a "provider" (an electronic communication service, or a remote computing service to the public) must report apparent child sexual abuse material to the NCMEC CyberTipline as soon as reasonably possible after actual knowledge, and give NCMEC its contact details; no duty to monitor or scan (2258A(f)). (2) TAKE IT DOWN Act (Public Law 119-12), FTC-enforced since 2026-05-19: a "covered platform" (serves the public and primarily provides a forum for user-generated content, including images and videos) must run a notice and removal process for intimate images shared without consent, post a clear notice of it, and remove a valid request and make reasonable efforts to remove known identical copies within 48 hours. | A hub with a mailbox, a pin node or public file listings may be both; an owner whose site lets the public post images or video may be a covered platform. Neither law asks for scanning. A member's report, even one with only identifiers, may be actual knowledge: treat it as one. |
| EU | DSA: knowledge plus expeditious action (Art. 6). The DSA reaches a provider with a substantial connection to the EU, wherever it is: a significant number of EU users in relation to the population, or targeting one or more member states (Arts. 2(1), 3(d), (e); `--aud eu` or `eea` shows targeting). A service that stores what visitors post, at their request, is a hosting service (Art. 3(g)(iii)); one that also makes it public is an online platform unless that is a minor, purely ancillary feature (Art. 3(i), recital 13); private messages are outside it (recital 14). Every provider, of any size, owes contact points for authorities and for users, a legal representative if not established in the EU, and terms that describe moderation (Arts. 11 to 14); hosts also owe notice and action, statements of reasons and reports of threats to life (Arts. 16 to 18). Micro and small enterprises (under 50 people and EUR 10 million, Recommendation 2003/361/EC) skip the yearly report (Art. 15(2)) and the online-platform duties (Arts. 19 to 28) but must give their EU user numbers on request (Art. 24(3)). The Recommendation counts only an entity engaged in an economic activity and the DSA covers services "normally provided for remuneration" (recital 5), so whether an unpaid hobby site is in scope is not settled; no official guidance was found. Terrorist content: a host that makes content public in the EU must act within one hour of a removal order (Regulation 2021/784, Arts. 1(2), 3(3)), name a contact point (Art. 15) and, outside the EU, a legal representative (Art. 17). E-evidence representatives since 2026-08-18 (not re-checked). | An owner who lets visitors post, and any hub, offered to people in the EU needs the intake, the statement of reasons and, outside the EU, a legal representative, and the yearly report only if not micro or small. A site with no EU establishment, no significant EU audience and no EU targeting is outside the DSA. |
| Canada | Notice-and-notice: forward notices "as soon as feasible" and keep identifying records 6 months; statutory damages of $5,000 to $10,000 for failing the duty. A notice with a settlement offer or a demand for payment doesn't comply. | Forward copyright notices to the owner concerned; you can't identify visitors anyway. |
| UK | Online Safety Act 2023. A service on which content that a user generates, uploads or shares may be encountered by another user is a user-to-user service, even if nobody has shared anything yet (s. 3), and is regulated if it has links with the UK: a significant number of UK users, the UK as a target market, or, if it can be used there, a material risk of significant harm to people there (s. 4(5), (6)). The provider is whoever controls who can use the user-to-user part and, if no organisation does, the individual or individuals who do (s. 226(2), (3)); one who only provides an access facility is not (s. 226(12)). Exempt: services whose only user content is emails, SMS or MMS, one-to-one live voice calls, or comments and ratings on the provider's own content (Sched. 1); chat rooms, direct messages, file sharing and video calls are not. Every provider, of any size, must assess illegal-content risk, take proportionate measures and remove illegal content swiftly when alerted, let users report and complain, and keep records (ss. 9, 10, 20 to 23), scaled to the size and capacity of the provider (s. 10(10)); intimate image content must come down within 48 hours of a valid report (ss. 10(3A), 20A, in force since 2026-06-29 on the research's reading). Every provider must assess whether children can access the service (ss. 35, 36); it can conclude that they cannot only if age verification or estimation is used with that result (s. 35(2)), and one that does not assess is treated as likely to be accessed by children (s. 37(4), (5)). First assessments are due within three months of the service starting and before a significant change (Sched. 3; s. 9(4)). The maximum penalty is the greater of GBP 18 million and 10% of qualifying worldwide revenue (Sched. 13, para. 4), and a court can be asked to order internet access services and app stores to restrict a non-compliant service (ss. 144, 146). | An owner who lets visitors write, message or share files may be the provider, personally, if UK people use the site; a site where visitors can only comment on the owner's posts is exempt. Do the assessments before turning on chat, rooms or uploads, and write them down. Ofcom's guidance on small services could not be read for this review. |

### The worst content

For child sexual abuse material and terrorist content, act first and investigate later. Nobody opens or copies
the material to check it, and nobody reviews it alone. Block it (withdraw the version or the site, delete the
posts, remove the files from the host), then report it.

- **United States.** A "provider" (an electronic communication service or a remote computing service to the public; a
  hub with a mailbox or a pin node may be one) must report apparent child sexual abuse material to the NCMEC
  CyberTipline as soon as reasonably possible after it has actual knowledge, and must give NCMEC its contact details
  (18 U.S.C. 2258A(a)). There is no duty to monitor or scan (2258A(f)). A report is a request to keep its contents for
  one year, securely and with access limited (2258A(h)), and a knowing and willful failure to report is fined up to
  $600,000 for a first failure by a provider with fewer than 100,000,000 monthly active users (2258A(e)). Section 230
  does not protect against federal child exploitation law (47 U.S.C. 230(e)(1)). A credible report from a member, even
  one that carries only identifiers, can be actual knowledge: treat it as such.
- **Canada.** If you provide a service that hosts content for the public (a pin node, a hub pin, or a web seed or
  snapshot that serves other people's files or posts), report the address or URL you were told of to the Canadian
  Centre for Child Protection through its online system as soon as feasible, and notify the police in writing when you
  have reasonable grounds to believe your service is or was used to commit an offence (Mandatory Reporting Act ss. 2 and
  3; Internet Child Pornography Reporting Regulations ss. 10 and 11). Keep the related data for 21 days after that
  notification, in a secure offline copy (s. 4; Regulations s. 12). Nothing in the Act makes you look for the material
  (s. 6), and nobody can sue you for a report made in good faith (s. 7). The Act does not define "Internet content
  hosting", so who it covers is the research's reading; the maintainers host nothing and are outside it. Amendments in
  the Protecting Victims Act (S.C. 2026, c. 19, ss. 178 to 183, not yet in force on 2026-10-22) would widen "Internet
  service" and extend the preservation to one year: check Justice Laws before you rely on this.

Matching known images by hash works only where bytes are handled whole: your web seed or CDN (Cloudflare's
CSAM Scanning Tool covers content served through its cache) or a pinning service you run for others. Nothing can
scan the swarm.

### Transparency reporting

A yearly report is a legal duty only for providers above the DSA's micro and small threshold, but it is cheap
and it is the best evidence of good faith. Cover the calendar year and publish within two months; the first
harmonised DSA cycle is calendar 2026, due by 2027-02-28. Count: notices by type and source; actions and the
median time to act; counter-notices and outcomes; orders from authorities; your own moderation (deletions, bans,
withdrawals); repeat-infringer terminations; notices forwarded under Canadian rules. The case log gives you all
of it.

## Privacy operations

Not legal advice. [PRIVACY.md](PRIVACY.md) holds the facts this section relies on: who receives what, what stays
on a visitor's device, the exact consent texts, and a privacy-notice template.

### When visitors are asked again

The loader stores each visitor's choice as a versioned record per origin, `{ v, choice, dns, day, scope, rcpt }`,
in the visitor's browser only. It asks again when:

- the record's version changes (a loader release that changes the card or its rules);
- the recipients change, for visitors who chose "Share and load": the host names of the trackers in your pointer
  and of the loader's STUN servers. Adding or removing a tracker in `tr=` asks every sharing visitor again;
- the visitor opens Settings, "Change your sharing choice".

A pointer with `--consent gate`, or an `aud=` token for personal data, children, sensitive content or an EEA, UK
or Quebec audience, shows the blocking gate in place of the card.

### Requests from visitors

- **Access and erasure:** search what you actually hold: host or CDN logs if you keep them, your tracker's logs if
  you run one (keep none), the case log. You can't link a posting key to a person unless they tell you. If you can show that you cannot identify the person,
  access and erasure do not apply unless they give you information that identifies them (GDPR and UK GDPR Art. 11(2));
  here that means asking them to prove they control the key, for example by signing a text you send. Say so in your
  reply. Also search your own copy of the ledger, the snapshot at `cs=` and your pin node.
- **Posts:** the author can delete their own posts (`mw.db.tombstone(h)`), and you or a moderator can delete
  any. To act on an erasure request: tombstone the post; publish a new snapshot at `cs=` (the old one still holds the
  text); drop the item from your pin node; and, if the outline (the author's key, the minute and the list's name) must
  go too, write a checkpoint, which removes everything before it for honest copies, not this post only. Tell the
  requester plainly what remains: cooperating visitors' copies remove the text when the deletion reaches them, devices
  that never sync again keep it, the outline stays until a checkpoint, and you cannot reach copies other people made.
  Do not say "erased".
- **Deadline:** under the GDPR and the UK GDPR, answer within one month of receipt (Art. 12(3)), or tell the person
  within that month why you need up to two more. In Canada a request for access under PIPEDA must be in writing, and
  you answer with due diligence and in any case within 30 days; you may extend by up to 30 more days for the reasons in
  s. 8(4), by a notice sent within the first 30 days (PIPEDA s. 8). In Quebec the person in charge answers in writing
  within 30 days, and silence counts as a refusal (s. 32); a request to stop disseminating or to de-index a link (s.
  28.1) runs on the same clock.
- **Who received it:** PIPEDA asks for an account of the third parties to which you disclosed a person's information,
  or, when you cannot list them, those to which you may have disclosed it (Schedule 1, clause 4.9.3). The recipients
  register of [PRIVACY.md](PRIVACY.md#recipients-register) is that list.
- **Complaints (UK):** a person can complain to you and you must make that easy (a form that can be completed
  electronically), acknowledge it within 30 days, and respond and report the outcome without undue delay (Data
  Protection Act 2018 s. 164A, in force since 2026-06-19).

### Breaches

If personal data you hold leaks (host logs, the case log, mailboxes), the GDPR asks you to notify the supervisory
authority without undue delay and, where feasible, within 72 hours (Art. 33(1)). In Canada, PIPEDA asks you to
report to the Privacy Commissioner, and to tell the people affected, as soon as feasible after you determine that a
breach of security safeguards involving personal information under your control creates a real risk of significant
harm (s. 10.1), and to keep a record of every such breach, whatever the risk, for 24 months (s. 10.3; Breach of
Security Safeguards Regulations, s. 6). Quebec asks any enterprise to take reasonable measures to reduce the risk, to
notify the Commission d'accès à l'information and the people affected promptly when there is a risk of serious injury
(s. 3.5), and to keep a register of every confidentiality incident for at least 5 years after it learned of it (s.
3.8; Regulation respecting confidentiality incidents, s. 8). The site ledger is public by design, so what visitors
posted there is not a breach, but personal data that shouldn't be there is a reason to delete it. If you hold nothing
(no logs, no keys), you have little to report.

### Retention

| Record | Keep | Basis |
|---|---|---|
| Case files and notices | 3 years after closing | suggested |
| Moderation decisions and their reasons | the life of the decision plus 3 years | suggested |
| Host or CDN access logs | 7 to 30 days, or none; say which in your privacy notice | suggested |
| Your tracker's logs | none; never infohash together with IP address | suggested |
| CyberTipline report contents (US) | at least 1 year | 18 U.S.C. 2258A(h) |
| Canadian notice-and-notice records | 6 months, 1 year if proceedings are notified | Copyright Act s.41.26 |
| Visitors' consent records | on the visitor's device only | how the loader works |

### Children's content

COPPA (15 U.S.C. 6501 to 6506 and the FTC's COPPA Rule, 16 CFR Part 312) counts an IP address as personal information
when it is collected from a child under 13. It binds the operator of a commercial site or service directed to children,
and any operator that has actual knowledge that it is collecting personal information from a child, and such an
operator needs verifiable parental consent first. A click on "Load" is not parental consent, and felinar can neither
check an age nor get that consent. Canada and the EU and UK set their own ages and rules ([PRIVACY.md](PRIVACY.md#children)).

- **Do not use felinar for a site directed to children under 13.** Serve a plain static site. 0.3.0 has no owner
  setting that forces host-only, and `--aud kids` only makes the blocking gate the default. `--aud kids` with `--policy
  owner` lowers the exposure; it does not make the site compliant.
- **On a general-audience site, knowledge is the trigger.** A parent's message, a post that states an age, or an age
  check that flags a child is actual knowledge, and so can be reading public posts or a room. Once you know, get
  verifiable parental consent or delete what the child gave. Here that means: tombstone the posts, ban the key, say so
  in your reply, and know that copies on devices that never sync again stay. That may not meet COPPA's "delete" (16 CFR
  312.2), so keep children out of a ledger that anyone can read.
- **On a hub,** if you learn that a site on your hub is directed to children, your tracker and pin node collect from
  users of a child-directed service (16 CFR 312.2). Remove that site, or switch off the hub's peer features for it.
- **Terms do not decide it.** A ban on children in your terms does not stop the FTC from finding a site directed to
  children.
- **Not settled:** whether a free site that nobody earns from is "commercial" under COPPA. Do not rely on it.

Sources: the statute and Rule, the FTC's COPPA FAQ (staff views) and its age-verification enforcement policy statement
of 2026-02-25. Not legal advice, and no lawyer has reviewed it.

## v0.3: operating the new parts

> **Status: v0.3, built and reviewed.** This section is for owners and hub operators of v0.3
> ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), cited "R"; a number after R is its section). The
> commands named here are in this tree's tools, and 0.3.0, the release being prepared, carries them (it is the
> freeze-group release); where this page and a tool differ, its `--help` is the reference. The review round of R 5.3 ran
> from 2026-10-22 to 2026-10-24. Everything above stays true in 0.3.0, and this section adds to it. Not legal advice, and no lawyer has reviewed
> it. Before you turn on public uploads or a hub list, write down the assessments that this page and
> [PRIVACY.md](PRIVACY.md) describe; do not turn on chat for a site that children use.

### Parts you may operate in v0.3

| Part | When it fails | Who notices first | How you find out |
|---|---|---|---|
| The site's own tracker and STUN servers for chat and files (required when chat or files are on) | the chat lane and file swarms find nobody; the site and its ledger still load | people who chat or share | as for trackers above; the diagnostics panel's connectivity class |
| The hub pin and snapshot service (central storage, [DEPLOY.md](DEPLOY.md#central-storage-the-hub-pin-and-snapshot-service)) | recent windows and first screens come from peers only; pinned files and media become unavailable | members who were offline | its log; a probe of the snapshot URLs |
| The pin mailbox **(proposed: no page sends it frames yet)** | stranger mail and join requests are not held | people who were offline when something was sent | its log |
| A TURN relay, if you run one | calls whose direct connection fails do not connect; everything else works | people in those calls | its log |
| The identity origin, only if you host your own | nobody can unlock at a new device or sign in to a new site; sites keep the keys they already hold | people signing in | an uptime check on its page; compare the build id and bundle hash on its cards with the published ones |

### Owner settings

Chat, files, private media, synced records and message requests are all off until you turn them on. The settings
live in the advisory key `_mw.cfg` of your ledger: honest loaders enforce them, a moderator can also write them
through the Settings card (which then shows "set by" and the key), and nothing security-relevant is ever stored there
(R 2.5.5). `ledger-admin` is `npx felinar ledger`. `tools/init` (the setup wizard of the tools lane) asks all of
these in one pass and prints the commands.

| Setting | Stored in | Command | Default | Values the landed ledger schema accepts |
|---|---|---|---|---|
| Chat | `_mw.cfg.chat` | `ledger-admin cfg --chat members` (owner key, offline) | `off` | `off`, `members`, `open` |
| Public file listings | `_mw.cfg.files` | `ledger-admin cfg --files members` | `off` | `off`, `members` |
| Private files and private media | `_mw.cfg.media` | `ledger-admin cfg --media members` | `off` | `off`, `members` |
| Synced sealed records | `_mw.cfg.records`, with `maxItems` | `ledger-admin cfg --records sealed --max-items 4` | `off` | `off`, `sealed`; `maxItems` 1 to 32 |
| Message requests from strangers | `_mw.cfg.requests`, with `chatBits` | `ledger-admin cfg --requests on --chat-bits 20` | `off` | `off`, `on`; `chatBits` 0 to 32 |
| Your own tracker and STUN servers for chat and files | the pointer's `tr=` and the STUN list in the site configuration | `publish --tracker wss://... --stun stun:...` | required whenever chat or files are on (MF-44) | |
| Pin mailbox and pin node | `_mw.cfg.pin` (the node's key, never the owner key) | `tools/pin.mjs --mailbox --files` | none | a public key |
| TURN | `_mw.cfg.turn` | `publish --turn ...` | off | `{ urls, mode }` with 1 to 8 `turn:`, `turns:` or `https:` URLs and `mode` `static` or `endpoint` |
| Age method | `_mw.cfg.age` | `ledger-admin cfg --age none` | `none`: the children's defaults apply ([PRIVACY.md](PRIVACY.md#defaults)) | `none` or a verifier's public key |

Three cautions, from the landed schema (`src/chain/state.js`, lane freeze):

- A `_mw.cfg` value with a key or a value the schema does not list is **hidden as a whole** by honest loaders: it has
  no effect, and its block stays valid. Add a key only after the schema lists it (`src/chain/state.js` `CFG_KEYS`).
  Since code review v0.3 the schema takes `requests: 'introduced'` (R 2.17.2), `wall` (`everyone`, `follow`, `nobody`,
  `approve`, for the social example) and `blockTiers` (a list of the file kinds of `CFG_TIERS`, for the file lane), and
  `ledger-admin cfg` writes them (`--requests introduced`, `--wall`, `--block-tiers <kinds>|none`).
- `chatBits` is the work stamp that strangers must attach, in leading zero bits. Twenty (chosen, R 2.7.3) is about 1.05
  million hashes per first message (arithmetic); what that costs a phone is row G-CH-6 and is not measured. The schema
  accepts 0 to 32; the chat code bounds it to 10 to 32 ([deviations/chat.md](deviations/chat.md), D-11).
- Turning on chat or files obliges you to name your own tracker and STUN servers. The four public trackers and the two
  default STUN servers are not used for chat, groups or private media (R 2.7.1, MF-44), because they would see which
  addresses talk to which.

### Moderation: caps, undo and bulk actions

Keys cost only the fee, so the design never claims Sybil resistance. On an open ledger the controls are the fee
(`bits`), reserved byte pools, an `allow` list with moderator caps, work stamps bound to each message, and per-author
listing caps (20 active listings per author), and premoderation of a new key's first files (R 2.17.1, MF-53; built in code
review v0.3): a public listing by a key that is not the owner's, a moderator's or on the `allow` list, and has no accepted
listing yet, is listed only for its author ("pending") and waits in the moderators' queue; nobody else lists or fetches it.
A moderator accepts it in the loader's moderation queue, or the owner offline with
`node tools/ledger-admin.mjs listed --key owner.jwk --file ledger.json --ih <infohash> [--author <key>]`; either writes
`_listed/<hash of the infohash and the author's key>` with `{ by, t, ih, author }`, bound to that author, so another key that
lists the same infohash is not accepted with it, and that author's later listings show at once. Without `--author` the tool
takes the one key that listed the infohash in the ledger file; when none or more than one did, it asks for `--author`
(review round MAL53-1; `tools/ledger-admin.mjs:813`, `:834`). Declining is a tombstone of the listing (`tombstone --h`).
Counts in any label are counts of keys, not people. Under an
attacker with a graphics card, open writing stays usable only for vetted people: put an `allow` list in front of any
site that matters (R 2.17.1).

0.3.0 is the freeze-group release (R 2.5.3) and adds these. To a 0.2.1 peer (none was ever public) the new operations
are `unknown-op`.

| Action | Before v0.3 (0.2.1, never published) | 0.3.0 |
|---|---|---|
| Delete a post | `tombstone` by the author, a moderator or the owner | a moderator's tombstone hides the value at once and deletes it physically after 24 hours (chosen), unless the target is on the P0 path (`_deny/`), so that a late revocation can restore it. A moderator's tombstone of an item the owner wrote has no effect |
| Ban an author | `ban`, permanent | `ban` may carry `until` (a time in ms): it governs that author's blocks with `ts` before it. Absent means permanent |
| Undo a ban | none; the author can write again only under a new key | `unban`. The owner lifts any ban; a moderator lifts only bans made by moderators, so an owner ban stands until the owner lifts it. Blocks hidden before the unban stay hidden, and a ban drops the author's payloads, so an unban cannot restore dropped values (the unban card says so) |
| Remove a moderator and undo what they did | a new policy; their earlier bans and deletions stand | the policy field `voided: [{ author, after }]` (at most 50 entries, a format limit): control blocks by that author that are not in the causal past of `after` have no effect. It never reaches blocks written with owner standing |
| Clear spam from many keys | one tombstone at a time | a bulk tombstone `{ authors, before }` (format limit 64 authors) hides every payload of those authors that is not in the causal future of `before`. In practice one block holds about 39 authors, and a policy block about 20 `voided` entries, in 4,096 bytes (measured by the freeze lane with a 32-character site id) |
| Limit what a moderator can do per hour | nothing | `modActionsPerHour` (default 60, chosen): a moderator's bans, unbans and single or bulk tombstones beyond it in a claimed hour have no effect. A moderator tombstoning their own entry is an author tombstone and is not counted |
| Let moderators admit members to an `allow` site | owner only | moderators may add keys to `allow` (never remove the owner's), at most `modAllowPerDay` per moderator per UTC day by claimed `ts` (default 20, chosen); a block that crosses the cap keeps its first additions |
| Keep unvetted authors from filling the ledger | at the cap only vetted entries are taken | `reservedPool` (default 25 percent, chosen; 0 to 50): authors who are not the owner, a moderator or on the `allow` list share at most that percent of `maxChainBytes`. Beyond it they get `E_CAP` and vetted authors still write. The SDK reports `E_LEDGER_FULL` at 80 percent of the cap (chosen, MF-24) |
| Recover from bloat or erase history | delete posts, raise the cap | an owner `checkpoint`: copies that hold the signed snapshot may drop every earlier block, stubs included ([PRIVACY.md](PRIVACY.md#your-rights-and-what-removal-reaches)) |

Moderator actions in a browser are UI-gated: `mod.ban`, a tombstone of someone else's item and every bulk action ask
for a loader card that needs a real click. A moderator key is imported as a non-extractable key. Moderators never act on
a message sent in chat that says "I lost my key": recovery goes through `rotate`, which the person does at the
identity page (R 2.5.2).

The sealed records you ask visitors to sync cost ledger space. Your budget is members times items times 1,877 bytes
(measured by the design review's performance judge for one parent per item): 1,000 members with 4 items each use
about 7.5 MB, close to the 8 MiB default (arithmetic). Raise the cap or lower `maxItems` before you get there.

### Join requests

On a site with `writers: allow`, a visitor asks to join with a sealed `join` item addressed to your moderators' chat
keys. When you run a pin mailbox it holds the request, so a moderator who comes online later sees it. Visitors see four
screens: "Request sent", "No moderator is online. Your request waits for up to 7 days." (chosen), "You're in" and
"Your request was declined". A moderator approving requests is bound by `modAllowPerDay`. Nobody needs a terminal
(R 2.5.2, MF-71).

### Harassment and stalking

The defaults do most of the work (R 2.17.2): message requests from strangers are off, presence is off, direct channels
refuse people who are not contacts, and location and camera details are removed from images and videos by default.

- **If you turn requests on,** the requests inbox holds at most 200 entries (chosen), never previews a message
  automatically, and shows only the size and the key for a file offer. Block and mute are one tap, and a person's blocks
  follow them through their vault.
- **An introduction requirement** (`requests` set so that a stranger needs a sealed note from a mutual contact or an
  `allow`-listed key) is in the design but is not built: the chat code treats it like plain requests, and the landed
  schema does not accept the value yet (see the cautions above). Do not rely on it.
- **A person who wants to shed a history** can start a new identity on your site with one tap at the identity page
  (R 2.17.2). You do not need to do anything.
- **A harassment report** is handled like any report: narrow first (ban the key, tombstone the item), and
  never act on a request made in chat to restore a key or lift a ban for someone who says they lost theirs.

### The file lanes: what to block, what to preserve, whom to call

Public file listings (`mw.files`), private files and private media are separate lanes with separate switches. They
change what a report can mean: the ledger and the swarm can now carry files that other people chose to share. Before you
turn on public uploads (R 2.17.3), write down your illegal-content risk assessment and how you will take illegal content
down and report it: in the UK, if UK people can reach the site, Online Safety Act ss. 9, 10, 20 and 23, within three
months of the service starting and before any significant change; in the EU, if the site has a substantial connection to
it, DSA Arts. 16 to 18; in the US and Canada, the child abuse reporting and takedown duties of "Abuse and legal
operations" above. No lawyer has reviewed this for you. Setting `writers: open` makes the ledger carry whatever strangers
post. `ledger-admin genesis` and `policy` print a warning when they open writing, and `publish` notes it for an open
genesis (code review v0.3). The per-author byte quota MF-54 also asks for is **not built yet** (proposed). Authors who are not vetted (not the owner, a moderator or on the `allow`
list) share one reserved pool, `reservedPool` percent of `maxChainBytes` (25 percent by default: 2 MiB of the default
8 MiB), and the ingress limit counts entries per author (30 per 10 minutes), not bytes. One key writing full-size
entries inside that limit fills the pool in about five hours, and a few keys in minutes; after that every newcomer gets
`E_CAP` while vetted authors still write. Prefer `writers: allow` with join requests, and keep `bits` raised on an
open ledger.

Never open, copy, forward or "check" the material, as for every worst-content case above. Act on identifiers.

| Case | What you can do | What to block | What to preserve, unopened | Whom to call |
|---|---|---|---|---|
| A public listing (a file offered on the site) | a moderator tombstones the listing | in the same step, a `_deny/` entry for the file (below), and a ban of the author's key if the facts call for it | the listing's block hash `h`, the author's key, the report you received, and the ledger export or snapshot that holds them, with its SHA-256. Do not fetch the file | for P0 content, the authorities the section "The worst content" above names, the same day; counsel for anything else |
| A pinned copy (your pin node holds the file) | `tools/pin.mjs --quarantine <infohash>` moves the pinned file to a quarantine folder apart from the pin store, stops seeding it and logs the action | the `_deny/` entry, so the node and visitors never fetch or seed it again | the pin node's profile directory, copied read-only (do not open the files in it), and the quarantine log | as above. In Canada, the Act respecting the mandatory reporting of Internet child pornography by persons who provide an Internet service may apply to a person who provides an Internet service: counsel confirms whether it applies to you |
| A private share (a file or video sent to a member) | nothing can open it: you cannot read it from the ledger or the swarm. Members report with "Report", which sends metadata only | the sender's key (ban), and a `_deny/` entry for the plaintext digest if the same file is also offered publicly | the report as received: the reported key, the envelope or item id, the plaintext digest, the size, the time, the sender's chat-key record and, for a direct message, the authenticated frame bytes the reporter received, plus the reporter's note. Never the file, its key or its name | as above |

A report proves to your moderators only what the reporter's device saw. It never contains the file, the key or the
name, so a moderator can act without handling the material (R 2.17.3, MF-54). A false report cannot take a site down:
the first action on a report is narrow (ban the key, tombstone the item), and withdrawing the whole site is reserved
for the whole site (R 2.17.4, HUB H9).

Pin requests from members go to a moderator queue that shows the name, size, author key and declared hash and nothing
else. Pinning is a moderator action and never automatic. The pin node never opens or renders a file
(R 2.8.6, MF-50; [recipes/hub-pin.md](recipes/hub-pin.md)). It keeps at most 2 GiB of approved files in all by default;
`--max-total <size>` changes that cap (pass it to `--approve` too), and `--mailbox-bytes` and `--mailbox-source-fraction`
size the mailbox (`tools/pin.mjs:89`, `:90`). An `--approve` made while the node runs is started within one status tick
(`tools/pin.mjs:1514`), and the node keeps each pinned item's .torrent in its profile, so after a restart it seeds that
item with nobody else online.

### Takedown with `_deny/`

A tombstone on a listing removes it from honest copies. In the same moderator step the loader writes
`_deny/<base64url SHA-256 of the infohash or of the file's SHA-256>` with `{ by, t, reason, ref? }`, where `reason` is one
of `P0`, `illegal`, `malware`, `spam` and `other`. The key is a hash of the identifier, so the ledger does not become an
index of the content. Every fetch and every seed checks the list first. The moderator interface flags a tombstone
that has no `_deny/` entry.

What it does not catch: near-duplicates and re-encodings of the same material. Catching them needs perceptual matching
on whole files, which only a host that handles the bytes whole can run (for example your web seed or a pin you run
for others); nothing can scan a swarm. Private files and media are outside your reach except through members'
reports (R 2.8.7, MF-52).

The P0 clock of the notice-and-action runbook above (block within one hour of a credible report) applies to this
narrow action, not to withdrawing the site.

### Hubs: safeguards, and the rules for a denylist before any list exists

A hub serves the loader for every personal site and group on its domain, and may run the tracker, the pin mailbox and
the pin node. Hub operators have their own row in "Who is exposed to what" above. The safeguards in the design:

- A shared-origin hub never holds a persistent identity: signed-in people get "this visit only" there.
- A hub with a subdomain per site must be on the Public Suffix List. If it is not, the loader disables persistent
  identity and passkeys there (PTR A8).
- Ledgers with no owner are shown read-only on hubs, since nobody could moderate them (HUB H10).
- Hub-scoped identity ("Use one identity on all of" and the hub's name) is offered only to the person, at sign-up, and is on by
  default only for hubs that run the social template (R 1.5, N-6).
- Your pin and mailbox service is central storage that you pay for and can be compelled to empty
  ([DEPLOY.md](DEPLOY.md#central-storage-the-hub-pin-and-snapshot-service)).

A hub-wide denylist and a hub directory are not built and are held until a lawyer has looked at them; no lawyer is engaged for
0.3.0 (R 1.4, 1.5 N-7; [ROADMAP.md](ROADMAP.md)).
The rules are written now so that the build cannot skip them (R 2.17.5, MF-31):

1. **Public entries in plain form.** Each entry shows the site's name or label, a reason code from a short published
   list, the date, and the reference of the notice that caused it.
2. **An appeal path** with a contact and a time limit for an answer.
3. **Expiry.** Every entry expires unless it is renewed in public.
4. **More than one signing key.** No single key can add or remove an entry.
5. **No automatic propagation.** One hub's list never feeds another's, and nothing applies an entry nobody on the
   hub has seen.
6. **Visitors are told.** A denied site shows "denied by this hub" and, where it is lawful, a way to open it from
   its own host.
7. **The list is checked against the DSA before it is built.** Each entry is a restriction that needs a statement of
   reasons (Art. 17) and terms that say how it works (Art. 14); a hub that is an online platform and not a micro or small
   enterprise also needs an internal complaint route and out-of-court settlement (Arts. 20 and 21). No lawyer reviews it
   for 0.3.0; get a lawyer's advice before you build it if you can.

The hub directory follows the same logic and ships off by default behind a hub flag marked "pending counsel"
(R 1.5, N-7; no lawyer is engaged for 0.3.0); do not turn it on before a lawyer has looked at it.

### Runbooks for v0.3 incidents

**A bad build of the identity origin (yours, or the project's).** The people who unlocked there while it served altered
code may have lost their roots (R 2.16.1).

1. Publish the hash and build id of the bad build, and the first good one.
2. Ship a fixed build and publish its hash; the build id and hash appear on every card.
3. Tell people who unlocked in that window to treat their identity as exposed. "Replace my keys on all sites" moves each
   site to the next key and makes contacts see "key changed", which answers stolen working keys: the next sign-in on each
   site writes the recover rotation, so `allow` membership follows the new key and the old key's later blocks stop counting.
   A label that owns a page keeps its key, because a page cannot move to a new key yet, and a moderator role stays with the
   old key until the owner adds the new one. It cannot by itself
   outrun someone who also holds the same 12 words, because anyone holding the words can sign every rotation the person can.
   For those people the safe course is a new identity (a new root) and telling their contacts out of band.
4. If you host your own identity origin, change the credentials of the host, republish the bundle hash and check the
   passkey situation: a passkey is bound to the identity origin's host name, so a move of host needs a restore from
   the phrase or the backup file.

**A site host is compromised.** The host can take that site's working keys, read its sealed items and act as signed-in
people there; it cannot reach other sites or the root.

1. Take back the host and DNS first, as in the runbooks above.
2. Publish a pointer with `ml=` set to the first fixed loader version; a loader older than that refuses to mount and
   offers the update (R 2.5.3).
3. If keys on the site's origin may have been copied, use the purge mode. The design review names a purge worker mode
   that is separate from the kill switch, so a mistaken deploy cannot wipe keys, and that deletes the site origin's
   working keys only on your explicit request; its file and contract are not specified yet.
4. Tell the people who were signed in to replace that site's key at the identity page. Signing out and in again
   derives the same key, so only a replacement changes it.

**The owner key is stolen or leaked.** In v0.3 you commit in advance to the next owner key in the pointer (`nx=`, a hash
of the next key). Rotate to that committed key: loaders accept the change without a prompt only when its hash matches
the previous record's `nx=`. The old `rot=` v1 path is removed. Loaders show "owner changed N minutes ago", and a
first-time visitor waits before accepting a rotation that does not match (24 hours in the loader lane, chosen there).
The commitment is sticky: an owner changes it only by rotating to the committed key, so a thief holding the current
key cannot re-commit it to their own key. If both the current and the committed next key are stolen, the design does not
help (HUB H3). The steps in "The owner key is stolen" above still apply for a ledger hand-over.

A withdrawal under a committed `nx=` keeps that `nx=` (`publish --withdraw` reads the record it replaces from
`--prev-pointer` or from the earlier output's `pointer.txt`, and refuses to write one that devices holding that record
would ignore). If the current key is gone, sign the withdrawal with the committed next key (DEPLOY.md, "Takedown").

**A lost or leaked release key (the project's, or yours if you sign your own builds).** The release key signs the per-file
hash lists that every `verify` and every door kit trusts (SECURITY.md, "Checking a release").

1. Leaked: add its public key to `RETIRED_RELEASE_KEYS` in `tools/verify-release.mjs` and release that change at once,
   signed with a new key from `tools/keygen.mjs` kept offline on a machine that does not run `gh` or `npm`. A retired key
   fails every `verify`, whatever `--pubkey` says.
2. Put the new key in `PINNED_RELEASE_KEYS`, SECURITY.md, the README and the second places named in SECURITY.md
   ("Checking a release": the tag message, `release-key.txt` with its OpenPGP signature, an archive copy), and say in an
   advisory which releases the old key signed and which key replaces it; sign the advisory's key line with the
   project's OpenPGP key (`SECURITY-KEY.asc`) too. People who cannot tell a rotation from a takeover compare the new key with those
   places and with the copies of the tools they already hold; none of them protects against the owner.
3. Sign the lists of the supported release line again with the new key (`sign --rebuilt`, from the tag) and publish
   the new signatures next to the old ones.
4. Lost (not leaked): steps 2 and 3 only. Until then no new release can be signed; do not publish one unsigned.

**A moderator key is misused (v0.3).** Write a policy without that moderator and list them in `voided` with `after` set to
the last block you trust: their control blocks that are not in that block's causal past then have no effect. Use
`unban` for bans they made and a bulk tombstone for what they flooded, and remember the 24-hour grace before a
moderator's tombstone deletes a value. Their key cannot tombstone items you wrote.

**Stolen working keys on one site.** The person replaces the key for that site at the identity page: a `rotate` by
recovery, which beats any rotation signed with the stolen key because of the recovery commitment (`keyinfo`) that
moderators cannot remove. Contacts see "key changed".

### Privacy operations, v0.3

- **When visitors are asked again.** The cards for chat and files name your own tracker and STUN servers. Changing
  them changes the recipients the cards name, so visitors who turned the feature on are asked again, as for trackers
  above.
- **Requests from visitors.** What removal reaches is in [PRIVACY.md](PRIVACY.md#your-rights-and-what-removal-reaches).
  If you receive a legal notice you can tombstone, ban and withdraw a version. You cannot make other people's copies
  disappear, and you cannot read private lanes from the ledger or the swarm. The code your site serves runs in your
  visitors' browsers and could read them, which is part of what you answer for; say so in your reply.
- **Keys are not a person.** You cannot link a key to a name unless the person tells you. Do not ask visitors for
  their 12 words, for any reason, and never put a form for them on your site.
- **Breaches.** The research reads a leaked key as a breach for you only if you hold the data or the key, so an owner
  who holds no recovery material for visitors has little to report (a reading: no authority has said so). That is a reason not to hold any.
- **Children.** The children's defaults apply to every site, and 0.3.0 has no age method (nothing reads `_mw.cfg.age`).
  Do not turn on chat, uploads or open writing for a site that children use unless you check age yourself, outside
  felinar, and have completed an assessment; for children under 13 in the US, COPPA needs a parent's consent first.

### Recurring tasks, v0.3

| How often | Task |
|---|---|
| Every release | compare the identity origin's build id and bundle hash with the published ones; re-read the rows of [THREAT-MODEL.md](THREAT-MODEL.md) the release touches |
| Weekly | read the moderator queue of pin requests; look at the `_deny/` entries you wrote and at timed bans about to end |
| Monthly | check the ledger meter against your sealed-item budget; rotate TURN credentials if you run a relay (with each release at least) |
| Quarterly | review the recipients your chat and file cards name (a tracker or STUN change asks visitors again) |
| On any change | a new tracker, STUN server, pin service or relay: update the privacy notice first ([PRIVACY.md](PRIVACY.md#additions-to-the-notice-template-v03)) |

## Recurring tasks

| How often | Task |
|---|---|
| Every 30 minutes | `check-site` with a dead-man's switch |
| Daily | read `abuse@` and acknowledge notices; check the pointer's days left |
| Weekly | review open cases; `check-webseed --pieces all`; look at visitors' reports |
| Monthly | re-sign the pointer if it expires within 30 days; back up the case log; check the tracker list against DNS block lists |
| Every release | the kill switch drill and the takedown drill, recorded in [DEMO-RESULTS.md](DEMO-RESULTS.md) |
| Quarterly | review the recipients in your privacy notice (a tracker or STUN change means visitors are asked again); check your contacts |
| Yearly | the transparency report by the end of February; renew `security.txt`'s `Expires`; DMCA agent renewal for hubs; counsel review of your terms |
| On any change | a new tracker, STUN server, host or jurisdiction: update the privacy notice first |
