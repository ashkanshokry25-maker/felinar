# Usage reports on Cloudflare Workers and Pages, with no server of your own to run

When a site owner turns on usage reports, the loader, the apps and the identity page send a visitor's browser events (what the page
did, which control was used, state changes, errors, timings, WebRTC states by candidate type) to an endpoint the owner runs, after
the visitor has agreed on a card that names its host. This folder is that endpoint: a Cloudflare Worker with one SQLite-backed Durable
Object that keeps one row per batch of events, hands the rows back to the operator and pushes each new batch to a live tail, behind a
Cloudflare Pages project so that its address shows no account name. Within the limits below it fits the Workers Free plan, and it needs
no server of your own to run and no domain. What a visitor sees, what is sent and the operator tools that read this endpoint (a live tail, a dump, a
summary) are described in [docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md); this file is about running the endpoint.

The Worker never reads a sender's address and never logs, it masks every string again with the rules of the page that sent it, only the
origins you name can send reports, and rows are kept for 7 days ([Privacy](#privacy)).

| File | What it does |
|---|---|
| `worker.js` | the front (the default export: `/healthz`, the origin and size checks, the token gate) and the Durable Object `ObsLog`, which stores the batches, serves the reads, accepts the tail sockets with the Hibernation API and sweeps old rows and old sockets from an alarm |
| `obs-core.js` | no platform code: the rules for a batch (`validateBatch`), the masks (`maskString`), the limits, the rate limiter, the key of a row, and the log (ingest, events, summary, sweep) over a small storage interface; the unit tests and the end to end collector run this same file over an in-memory store |
| `wrangler.jsonc` | the Worker `felinar-obs-do`: no public address, the object binding, the SQLite-backed class (what the Free plan allows), the vars below |
| `pages/wrangler.toml` | the Pages project `felinar-obs`: its output folder, `ALLOW_ORIGINS`, and the binding to the class `ObsLog` of the Worker above |
| `pages/public/_worker.js` | the front for the Pages project: a copy of the front of `worker.js` that imports nothing (a Pages project cannot define a Durable Object class, so it reaches the one of the Worker through the binding) |

## What you need

- A Cloudflare account (the Free plan is enough).
- An API token for it, limited to that account, with Workers Scripts: Edit, Cloudflare Pages: Edit and Account Settings: Read. Give it
  an expiry. The token and the account id go into the environment as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, never into a
  file you commit.
- Node and `wrangler` 4, run from a copy of this folder outside the repository: `wrangler` writes files next to the config it runs
  with, and it rewrote `package.json` when it was run inside a clone.
- The exact origins of the pages that will send reports: the site, its door if it has one, the identity page, as scheme, host and port
  if it is not the default one (`https://example.com`).

## Start it

```sh
cp -R deploy/obs-worker ../obs && cd ../obs
npm init -y > /dev/null && npm install --no-save wrangler@4
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...

# 1. the object: a Worker with no public address
npx wrangler deploy

# 2. the front: a Pages project that reaches the object through a binding.
#    Put your origins in pages/wrangler.toml first: ALLOW_ORIGINS = "https://example.com, https://door.example.org"
cd pages
npx wrangler pages project create felinar-obs --production-branch main

# 3. the token that opens the reads, made into a file only you can read and given to the project from that file
(umask 077; openssl rand -hex 24 > ../obs-read.token)
npx wrangler pages secret put READ_TOKEN --project-name felinar-obs < ../obs-read.token

# 4. deploy the front
npx wrangler pages deploy public --project-name felinar-obs --branch main
```

On `wrangler` 4.156 step 2 failed as written, because `wrangler pages project create` is now handed to Workers: the project was created once with `--force` added, and only then (the commands after it ran directly).

The address is `https://felinar-obs.pages.dev` (the project name is the first label; Cloudflare adds a suffix when the name is taken).
Check it, then give it to the site:

```sh
curl https://felinar-obs.pages.dev/healthz          # prints: ok
```

`publish --obs https://felinar-obs.pages.dev` writes it into the site's `/_mw/door.json` (`dev-server` takes the same flag, and
`publish --door-kit --door-site` copies the block of the first site into a door kit; [docs/DEPLOY.md](../../docs/DEPLOY.md), "Usage reports"). The names `felinar-obs-do` (the
Worker) and `felinar-obs` (the project) are set in the two config files and can be changed; the binding in `pages/wrangler.toml` names the
Worker by `script_name`, so change that line with it.

To change the origins, edit `ALLOW_ORIGINS` in `pages/wrangler.toml` and run step 4 again. To change the token, run step 3 and step 4
again. `RETENTION_DAYS` and `MAX_BATCHES_PER_DAY` are vars of the Worker (`wrangler.jsonc`) and are read by the object: edit them and
run `npx wrangler deploy` again.

Without a Pages project, the Worker also runs alone: turn `workers_dev` on in the copy, set `ALLOW_ORIGINS` and `READ_TOKEN` in its
`vars` (or set the token with `npx wrangler secret put READ_TOKEN` and take its line out of the copy, never both: a var of the same
name would replace the secret), and deploy. Its address is then `felinar-obs-do.<your subdomain>.workers.dev`, which shows your
account's subdomain; that is what the Pages front is for.

| Var | Where | Meaning |
|---|---|---|
| `ALLOW_ORIGINS` | the front: `pages/wrangler.toml` | the exact origins whose pages may send reports, comma, space or line separated; no wildcard; empty refuses every report |
| `READ_TOKEN` | the front: a secret of the Pages project | a long random value that opens `/events.json`, `/summary.json` and `/tail`; empty or unset keeps them closed, and so does one of fewer than 24 characters, which is taken for none (step 3 makes one of 48) |
| `RETENTION_DAYS` | the object: `wrangler.jsonc` | rows older than this are deleted by the sweep; 7; held between 1 and 30 |
| `MAX_BATCHES_PER_DAY` | the object: `wrangler.jsonc` | the most batches stored in a UTC day, all pages together; 20000; held between 1 and 200000 |

## The routes

| Route | What it does |
|---|---|
| `GET /healthz` | 200 `ok`, no token |
| `POST /e` | takes one batch. The `Origin` header must be one of `ALLOW_ORIGINS`, else 403 (an empty list refuses everything). The body is at most 32768 bytes, else 413. The `Content-Type` is `text/plain` or `application/json`, else 415. Once `MAX_BATCHES_PER_DAY` batches are stored in the UTC day, every batch is 429 `day-all` with `Retry-After` before it is read. A bad batch is 400 with one word, and nothing is stored. More than 60 batches a minute or 1000 a day from one session is 429 with `Retry-After` too. A batch the object already has (the same session, number and text: what a retry after a lost answer sends) is answered 204 and not stored again. Else the batch is stored and the answer is 204. Every answer to an allowed origin carries `Access-Control-Allow-Origin` with that origin and `Vary: Origin` |
| `OPTIONS /e` | the preflight, 204 for an allowed origin (`max-age` 600), 403 for any other |
| `GET /events.json?token=&since=&sid=&who=&limit=` | 404 unless `READ_TOKEN` is set (24 characters or more) and is the `token`. Answers `{ next, more, batches }`: the stored rows in key order after `since` (a key, not included), filtered by `sid` and `who` when given, 200 of them by default and 1000 at most. `next` is the last key read, to pass as the next `since`; `more` is true when a limit stopped the read, so the next call may find more. A request reads at most 5000 rows, matching or not. A bad `since`, `sid` or `who` is 400 with the word. Any page may read it (`Access-Control-Allow-Origin: *`): the token is the gate |
| `GET /summary.json?token=&hours=` | the same gate. Answers `{ hours, from, to, truncated, batches, events, sids, who, pages, names }` for the last `hours` (24 by default, 168 at most): the counts of batches and events, of distinct sessions (`sids`) and signed-in identities (`who`), per page and per event name (the 500 names it meets first, the rest together as `*other`). It reads the newest 5000 rows at most; `truncated` says it stopped there and `from` is then the time of the oldest row it counted |
| `GET /tail?token=` with `Upgrade: websocket` | the same gate. A WebSocket that gets `{"type":"hello","batches":<batches today>}` and then one text frame per stored batch, the stored row as JSON. What the client sends, a ping included, is ignored. 16 sockets at most (a 17th is 429); the sweep closes a socket 12 hours after it opened (code 1001), and the operator tool reconnects. A GET without the upgrade is 426 |
| anything else | 404 |

A stored row is keyed `b:` + 15 digits of milliseconds + `:` + 4 digits (a counter for batches of the same millisecond), so the keys sort
in time order: `{ at, sid, page, who, site, build, n, body }`, with `body` the validated batch and `n` its number of events. The batch is the one
of [docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md): `{ v: 1, sid, seq, page, build, loader, site, who, net, ua, t0, events }`. It is refused with
`version`, `sid` (12 characters of `a-z2-9`), `seq` (a whole number up to 1e9), `page` (`site`, `door`, `hub` or `idp`), `build`, `site` (hex, up to
8 characters or empty), `loader` (a version such as `0.3.0` or `0.3.1-rc.1`, up to 16 characters, or empty), `who` (null, or a short id: two groups of 4 from the 32
characters the identity page draws from, `a-z` without `l` and `o`, and `2-9`, joined by a hyphen), `net` (null, or `type` and `effectiveType` words of
`navigator.connection`: `bluetooth`, `cellular`, `ethernet`, `mixed`, `none`, `other`, `unknown`, `wifi`, `wimax`, and `slow-2g`, `2g`, `3g`, `4g`, `unknown`),
`ua` (`browser` one of `chromium`, `firefox`, `webkit`, `other`; `mobile` a boolean), `t0` (seconds),
`events` (1 to 100), `event`, `time` (`t`, a whole number from 0), `name` (`n` as `a.b-c`: lower case, digits, dots and hyphens, 2 to 49 characters),
`keys` (more than 12 fields beside `t` and `n`), `key` (a field name that is not a letter followed by up to 31 letters, digits or underscores), `value` (a field
that is not a string, a finite number, a boolean or null), `empty` or `json`. A key that the format does not name is left out of the row.

## The limits and the Free plan

| What | Limit | When it is reached |
|---|---|---|
| a body | 32768 bytes | 413 |
| events in a batch, and fields in an event | 100 and 12 | 400 `events`, `keys` |
| a string value | 200 characters, after the masks | cut |
| batches from one session | 60 in a sliding minute, 1000 in a UTC day | 429 `sid-minute`, `sid-day` |
| batches from all sessions | `MAX_BATCHES_PER_DAY` (20,000) in a UTC day | 429 `day-all` until midnight UTC |
| how long a row is kept | `RETENTION_DAYS` (7 days) | the sweep (every 10 minutes) deletes it |
| rows kept | 50,000 | the sweep deletes the oldest first |
| a read of `/events.json` | 1000 rows returned, 5000 rows read | `more` |
| a read of `/summary.json` | 168 hours, 5000 rows | `truncated` |

Cloudflare's Free plan, as the project wrote it down from Cloudflare's pages on 2026-11-02 ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)): 100,000 requests a day and 100,000 SQL row writes a day, 5 GB of
stored data, 13,000 GB-s of object duration a day. The numbers were not checked against those pages again, and Cloudflare changes its plans: read them before you rely on
them. What follows is computed from the code, not measured.

- A stored batch is one request to the Pages front and one to the object, one row put and, 7 days later, one row deleted. At the cap of
  20,000 batches a day that is 20,000 requests to each and 40,000 row writes, and the counter row adds one write with the first batch of a
  day, one with every 20th (1,000 at the cap) and one for each sweep (every 10 minutes while there is anything to look after: at most 144 a day):
  41,145 row writes in all, or 82,290 if Cloudflare counts the key's index entry as a row of its own, under 100,000 either way.
- A batch holds at most 32768 bytes. The 50,000 rows the sweep allows are at most about 1.7 GB (50,000 times 32,768 bytes of body, and the few
  fields of a row besides), or about 0.8 GB with the reporters' own batches of at most 16,384 bytes, under the 5 GB either way; a batch of a few
  events is a few kilobytes. At the cap of 20,000 batches a day the 50,000 rows are reached after 2.5 days, so the oldest rows then live about 2.5
  days and not 7.
- The object sleeps between requests and frames (hibernation), so its duration should stay small. A tail socket counts as one request when
  it connects and 20 messages from it count as one; the frames the object sends it are outgoing messages, which are not counted. Reads
  (`/events.json`, `/summary.json`) read up to 5000 rows each.
- The cap is on batches, not on visits. A reporter sends a batch every 2 seconds at most, while it has something queued, with at most 50
  events in it (and a few batches at once when the page is hidden); how many batches a visit sends was measured only for a headless visitor (9 batches in a 1-minute probe of a site, 2026-11-02; [docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md), "What was tested live"), not for a visit by a person. A reporter
  tries a batch that fails three times at most.
- Beyond the cap the endpoint answers 429 until midnight UTC, without reading the batch, and the reports of that day are lost. A script can send any
  `Origin` header, so the allow list does not stop it: it can use up the day's 100,000 requests, after which Cloudflare stops serving requests to
  this endpoint, your reads included, until the limit resets (what happens at the limit is on Cloudflare's limits page). The endpoint never reads the
  sender's address, so it has no per-address quota to offer against that.

## Privacy

- **The Worker never reads `CF-Connecting-IP`, `X-Forwarded-For` or `request.cf`, and never logs.** It reads four request headers
  (`Origin`, `Content-Type`, `Content-Length`, `Upgrade`), calls no `console` function and keeps nothing about a request but its batch. The
  unit test (`test/unit/deploy-obs-worker.test.mjs`) searches the source for those names outside comments and runs a spy over every route to
  list the headers and the request properties it touches. The front hands the object a new request that holds the text of the batch and
  no header of the sender's (only a `Content-Type` of its own); the one request passed on as it came is the operator's tail upgrade.
- **What a row holds** is the batch and the time it arrived: a random session id the page made, the page kind, the build and loader
  versions, the first 8 characters of the site's infohash, the identity's short id when someone is signed in (pseudonymous, as the header shows
  it), the browser family and `mobile`, a coarse network type, and the events with their fields. No address, port, full user agent, name, message, key,
  passphrase, code beyond its 4-character channel, URL fragment or free text typed by a person is allowed in (the field rules of
  [docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md)), and the Worker
  checks that again: a string is folded to NFKC, cut to 200 characters, and an IPv4 or IPv6 literal (with its port, brackets and zone) becomes `x.x.x.x`,
  everything after a `#` of a URL goes, a pair code keeps its first 4 characters, and a run of 32 or more letters, digits, hyphens and underscores with a
  digit in it (an infohash, a ledger id, a key) keeps its first 8. The masks over-mask on purpose: a clock time such as 12:30:45 is taken for an address.
- **What Cloudflare itself sees** is what it sees for any host: the address of every request at its edge. It is the operator of the Worker's host.
  Keep Workers Logs, Logpush and real-time logs off for the Worker and the project (`wrangler.jsonc` turns observability off for the Worker),
  do not turn on Web Analytics for the project, and name the endpoint and Cloudflare in your privacy notice
  ([PRIVACY.md](../../docs/PRIVACY.md)).
- **The origin allow list** keeps a page you did not name, in a browser, from sending reports to your endpoint. It is not authentication:
  anything that is not a browser can send any `Origin`, any session id and any short id, so a program can fill the day's budget and plant
  events that never happened. A report is evidence of a page, never of a person. `ALLOW_ORIGINS` has no wildcard, and a hub's sites each need an entry of their own.
- **Keeping programs out is Cloudflare's to do, before the Worker runs.** Two rules of a Cloudflare zone, a domain of yours on Cloudflare, do it: a WAF
  custom rule on the path `/e` that blocks a request whose `Origin` header is not one of your origins, and the one rate limiting rule a Free plan has,
  counted per client address (which Cloudflare sees and this Worker never does). They are rules of a zone, and the address of this setup,
  `<name>.pages.dev`, is not a zone of yours as far as we know, so they apply when the front is served on a domain of your own. Not tried on Cloudflare.
- **The token** is compared in constant time over its whole length and travels in the URL, like the `STATS_TOKEN` of the rendezvous: keep it out of
  shared screens and shell history, and give it to the tools from a file. Anyone who has it can read every stored batch and watch the tail.
  Replacing it takes effect with the next deployment of the front. A `READ_TOKEN` of fewer than 24 characters is taken for none (a short one
  opens nothing), so the reads and the tail answer 404 until a longer one is set.
- **Retention**: 7 days (`RETENTION_DAYS`), at most 50,000 rows, deleted by the sweep every 10 minutes. To remove everything at once, deploy a
  migration that deletes the class (`{ "tag": "v2", "deleted_classes": ["ObsLog"] }` in `wrangler.jsonc`, and drop the binding): Cloudflare then
  deletes the object and its storage. That cannot be undone, and it has not been run for this endpoint.
- **A visitor's consent** is the page's business, not the endpoint's: nothing is sent before the visitor's yes on a card that names this host,
  "Load from host only" sends nothing, and a Settings switch turns reports off at any time ([docs/PRIVACY.md](../../docs/PRIVACY.md)). The endpoint cannot
  tell whether a sender asked.

## What it doesn't do

- No per-address quota (it never reads the address), no origin wildcard, no key per site.
- De-duplication is partial: a batch the page sent again after a lost answer (the same session, number and text) is answered 204 and stored once, while the
  object remembers it, which is the last 8 batches of each session until the object is rebuilt or the UTC day ends. A retry that comes after that is stored
  twice, with the same `sid` and `seq`, which is how a reader tells; the operator tools of the project show or write it once.
- The windows of the per-session caps live in memory and start again when the object is rebuilt. The count of the day is saved with the
  first batch of a UTC day, with every 20th and by the sweep, so a rebuilt object can forget up to 19 batches of it, and the number of rows it
  believes it holds can be a few off until the store is empty again.
- A filter on `sid` or `who` reads rows in order, not through an index: a read stops after 5000 rows and says `more`.

## What was tested

On 2026-11-02, unit tests, all passing: `test/unit/deploy-obs-core.test.mjs` (39 tests: the masks, the rules of a batch, the keys, the limiter, the
log over an in-memory store, and the masks held against the reporters' own `safeField`) and `test/unit/deploy-obs-worker.test.mjs` (34 tests: the front and
the object through a fake platform, with the batches the two reporters really write; the origin rules, the token gate, 413, 415, 400, 429, the rows, the
tail frames, the alarm sweep, a spy over the headers it reads, and a scan of the source for the names it must never touch). The cost of reading one body (`parseBatchText`, over a
body of at most 32,768 bytes) was timed in Node on one laptop, not on Cloudflare: 32 KB of text made of "#1" took 10.4 ms before the fix of the fragment rule and 1.5 ms after it (ordinary
text of that size, 0.6 ms), and the slowest of 710 shapes of text tried since took 2.2 ms.

**Live, on Cloudflare, 2026-11-02 (times ET).** Deployed at 09:46: the Worker `felinar-obs-do`, version 9bbd3352 (a SQLite-backed Durable Object, no `workers.dev` address), behind the Pages project `felinar-obs` at `https://felinar-obs.pages.dev`, with `ALLOW_ORIGINS` naming the demo site, the demo door, the demo identity page and the lab door, and `READ_TOKEN` set as a Pages secret. The Pages project was created with `--force`, once: `wrangler` 4.156 hands `wrangler pages project create` to Workers and the plain command fails (the commands after it ran directly). A smoke from a Mac: `/healthz` answered `ok`; `/summary.json` answered 404 without the token and JSON with it; `POST /e` answered 403 from a foreign origin, 403 with `Origin: null` and 403 with no `Origin`, 400 for a session id of 13 characters and 204 for a valid batch; a stored row had `10.0.0.7` and `[2001:db8::1]:443` masked to `x.x.x.x`; the live tail connected and printed the hello frame. Later that day headless browsers sent reports to it from a lab door and from the demo tier, and one phone from the lab door; a scan of all 53 stored rows of the day (945 events) found no IP address, no full pair code and no name or email address. The phone's reports were refused, because a beacon carries `Origin: null` under the door's `Referrer-Policy: no-referrer`; the loader now sends by `fetch` first ([docs/OBSERVABILITY.md](../../docs/OBSERVABILITY.md), "What was tested live"). Not tested, in the unit tests or live: `wrangler dev`, hibernation on the real platform, the Free plan's counting of rows and requests (the arithmetic above is from the code), the CPU time of a request there, the daily cap, the 7-day sweep, the Cloudflare rules of [Privacy](#privacy), and load.
