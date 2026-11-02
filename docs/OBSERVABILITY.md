# Usage reports

> **Status: built on 2026-11-02, unit tested and run end to end on loopback, and then run live the same day: the endpoint on Cloudflare, headless browsers at a lab door and on the demo tier, and one real phone (unreleased).** Written for the code
> that adds usage reports ([CHANGELOG](../CHANGELOG.md), "Unreleased"). The unit tests cover the reporter, the loader's wiring, the hooks of the apps and
> of the identity page, the endpoint's core and front over fakes, and the publish tools, and three scripted Chromium scenarios on loopback read what real pages send.
> The live runs found two defects: the endpoint refused the phone's reports until the reporter sent by `fetch` first, and the identity page's rows carried no `ref` at a door (both fixed in the code, and both fixes seen working from headless browsers on the demo tier the same day; a phone after the fixes has not run).
> What has run, what it showed and what has not is under "What was tested" and "What was tested live" at the end.
> No lawyer has reviewed the privacy sentences ([PRIVACY](PRIVACY.md#usage-reports-unreleased)). Treat usage reports as a first build.

A site owner can turn on **usage reports** for a site, a door or an identity page. With them on, a visitor's browser tells an endpoint that the owner runs
what the loader did on the page: the steps of a load, the controls the visitor used, state changes, errors, timings and the state of its WebRTC links by
candidate type. The owner can watch that live and read it back, so a visit can be understood without asking the visitor, and before there is a
peer-to-peer network to ask. The endpoint is a Cloudflare Worker with one Durable Object on the Workers Free plan
([deploy/obs-worker](../deploy/obs-worker/README.md)), which the owner puts behind a Pages project so that no account name shows in its address.

They are **off unless the owner names the endpoint**, and even then nothing leaves the device until the visitor has said yes on a card that names the
host. The loader still has no analytics and no third-party scripts: the endpoint is the site owner's own, the visitor is told who runs it first, and the
rules below limit what it can receive. This page is for owners, operators and contributors; the exact sentences visitors read and the privacy notice
rows are in [PRIVACY](PRIVACY.md#usage-reports-unreleased), the contracts in [INTERFACES](INTERFACES.md) ("Usage reports") and
[ARCHITECTURE](ARCHITECTURE.md) 15.22, and the flags in [DEPLOY](DEPLOY.md#usage-reports).

## In short

- **Off by default.** A host whose `/_mw/door.json` has no `obs` block gets no reports: the page makes no reporter, keeps no event and sends no request to
  any endpoint. (A shell page reads its own host's `/_mw/door.json` once at the start to find out. That is one request to the host that served the page,
  like any other file of it.)
- **Named before it is sent.** With the block, the first-run card, or the gate, gets one more line that names the endpoint's host. Until the visitor says
  yes, what the page does waits in the page's memory (500 events at most) and nothing is sent.
- **Agreed, and easy to withdraw.** The yes is "Share and load" (or the gate's "Load"). "Load from host only" sends no reports and drops the ones waiting,
  and a switch in Settings, "Send usage reports to {host}", turns them off at any time. A visitor who agreed before the block existed is asked again,
  because the host is part of what the choice covers.
- **Words, counts and timings, never addresses or content.** A report carries names from a fixed catalogue, words from closed lists, counts, times, a
  random session id and a few short identifiers ([the field rules](#the-field-rules)). The loader masks what it sends, and the endpoint masks it again.
  The host that runs the endpoint still sees each visitor's IP address, as any server does; the Worker's code does not read it, store it or log it.
- **Kept 7 days.** One stored row per batch of events, deleted after 7 days by default, at most 50,000 rows ([The endpoint](#the-endpoint)).
- **Free, within limits.** The endpoint is sized for 20,000 batches a day on the Workers Free plan. A busy site can outgrow that, and the reports of the
  rest of the day are then lost ([The Free plan](#the-free-plan)).

## What a visitor sees

Which page reports, and what starts and stops it:

| Page | What lets reports go | What stops them |
|---|---|---|
| A site (a shell page), or a site on a hub, when its host's `door.json` names an endpoint | "Share and load" on the first-run card, or "Load" on the gate. A choice stored on this device counts only when the card named this host. | "Load from host only"; the switch in Settings |
| The bare door page of a door with apps, and the apps on it | "Continue" on the first price card that can start something (the card names the host). Signing in does not count: the loader's sign-in card names no host | the switch in Settings, which lasts for this visit only (an apps page stores nothing) |
| The identity page, when its own build names an endpoint | the first press of any card button | closing the window before pressing one; the page has no switch of its own |

- **The card names the host.** On a site, the first-run card and the gate each get one line, shown only when the site's `door.json` names an endpoint. It says
  that the page also sends usage reports to that host, run by this site's owner; what they hold (the steps taken, the controls pressed, errors and the kinds
  of connections made); that they carry no messages, names, passphrases or IP addresses but that the host can see the visitor's IP address, as any server
  can; that none are sent if the visitor does not share; and that Settings turns them off. The words are in [PRIVACY](PRIVACY.md#what-visitors-are-told).
  A card on the door page and on the identity page says what is sent, to whom and how to stop it, in its own words.
- **At a door, the first yes is a price card.** The bare door page has no first-run card. The first card that can start something (the one that offers to open a code, to knock
  on someone else's, or to create or join a room) carries the line that names the host, and its "Continue" is the yes; "Not now" on it is not a no and sends nothing either. A
  sign-in alone does not start reports, because the loader's own sign-in card names no host and says nothing about them: a visitor who only signs in and leaves has sent nothing,
  and what the page did until then (the sign-in's steps among it) goes out once a price card's "Continue" says yes.
- **Asked again when the host changes.** The host is one of the recipients a stored choice covers ([PRIVACY](PRIVACY.md#recipients-register)), so a visitor
  who agreed before the owner turned reports on, or whose agreed endpoint changed, sees the card again. A site that names no endpoint does not ask again:
  `consent.version` is not raised for this feature.
- **Before the yes, memory only.** What the page does before the visitor chooses is queued in memory, at most 500 events, the oldest dropped first and
  counted. "Load from host only" and the Settings switch drop the queue; closing the card or the gate without a choice ("Not now", Cancel) leaves it waiting, and still
  nothing is sent. Nothing is written to disk. A hub's root page, which only sends a visitor on to a site and has no card, sends nothing.
- **Settings.** A switch, "Send usage reports to {host}", shown only when the site names an endpoint. Off stops reports at once and drops what waited; on lets
  them go again only when the visitor has also agreed on the card. The choice is kept with the other Settings on this device (`reports`, `on` or `off`; on a
  door page it lasts for the visit). The Diagnostics section of Settings has one line with the state and the counts: sent, waiting, dropped.
- **Checking a page.** `window.__mwShell.inspect().obs` is `null` on a page with no usable block, and otherwise
  `{ host, enabled, allowed, queued, sent, dropped, batches, lastOk }` with the endpoint's host name only. `allowed: false` means nothing leaves the page.
  The browser's network panel shows every report: a `POST` of `text/plain` to the endpoint's `/e`, by `fetch` (a beacon only as the fallback).

## What is sent

### The batch

One request carries one batch, a JSON object posted as `text/plain` so that no preflight is needed. An example, made up:

```json
{ "v": 1, "sid": "k3m8h2q9x4vt", "seq": 2, "page": "site", "build": "bbcb82098cda", "loader": "0.3.0", "site": "d680ff36",
  "who": null, "net": null, "ua": { "browser": "firefox", "mobile": false }, "t0": 1793600000,
  "events": [
    { "t": 1234, "n": "gate.shown", "kind": "consent", "host": "obs.example.org" },
    { "t": 2210, "n": "ui.click", "tag": "button", "text": "Share and load", "trusted": true, "type": "click" },
    { "t": 2216, "n": "consent.set", "choice": "accepted", "scope": "origin" },
    { "t": 2890, "n": "ice.local", "id": 1, "type": "srflx", "proto": "udp" }
  ] }
```

| Field | What it holds |
|---|---|
| `v` | the format, 1 |
| `sid` | a random session id the page made: 12 characters from a to z and 2 to 9, new on every page load, kept in memory only |
| `seq` | the batch's number within the session, from 0 |
| `page` | `site`, `door`, `hub` or `idp` |
| `build` | the door's build id (up to 16 hex characters), or empty |
| `loader` | the loader's version, such as `0.3.0`, or empty when what the page holds is not a version (the endpoint takes no other shape in this field) |
| `site` | the first 8 hex characters of the site's infohash, or empty before the pointer resolves, on the bare door page and on the identity page |
| `who` | the short id of the identity signed in on this page, as the page's header shows it (two groups of four, such as `da9u-6qug`), or `null`; a name or any other word is not sent and the endpoint refuses it; never set by the identity page |
| `net` | `{ type, effectiveType }`: the words of `navigator.connection` where the browser has it (Chromium), else `null`. `type` is one of `bluetooth`, `cellular`, `ethernet`, `mixed`, `none`, `other`, `unknown`, `wifi`, `wimax`, and `effectiveType` one of `slow-2g`, `2g`, `3g`, `4g`, `unknown`; any other word goes as `other` or `unknown`, and the endpoint takes no other |
| `ua` | `{ browser, mobile }`: the family (`chromium`, `firefox`, `webkit` or `other`) and whether the browser says it is mobile; the batch never holds the user agent string (the request's own headers do, see "What the endpoint's host sees anyway") |
| `t0` | when the reporter was made, in whole seconds since 1970 |
| `events` | 1 to 50 events, each `{ t, n, ...fields }`: `t` is milliseconds since the reporter was made, `n` the event's name, then at most 12 fields |

The reporter sends a batch at most every 2 seconds, and only while something waits; a page with nothing to say sends nothing. A batch holds at most 50
events and 16,384 bytes, and the rest waits for the next turn. It goes by `fetch` with `keepalive` first (a cors request carries the page's real origin, and its answer says whether the
endpoint stored it), and by `navigator.sendBeacon` only when there is no `fetch` or the browser refuses the request: a beacon is a no-cors POST, and under the
door's `Referrer-Policy: no-referrer` it carries `Origin: null`, which the endpoint refuses (measured on a phone on 2026-11-02: 99 batches reported sent, none stored). A `fetch` that fails is tried again with the same `seq` and the
same body, three tries in all, and then dropped and counted. When the first try had reached the endpoint and only its answer was lost, the retry is a batch the
endpoint already has (the same `sid`, `seq` and text): it answers 204 and keeps one. It remembers the last 8 batches of each session for as long as its object stays in
memory and the UTC day lasts, so after a restart of the object or past midnight a retry can be stored twice, with the same `sid` and `seq`. When the page is hidden or
closes, up to three batches go at once, by `fetch` with `keepalive`. The page never waits for any of it. A batch is also started anew when `who`, `site` or `net` changes, so
an earlier event is never labelled with a later identity or site.

### The field rules

These rules bind every part of the loader that reports; the reporter and the endpoint enforce them twice.

**Allowed:** event names; short identifiers (a control's role, the part of a function key before its first colon, status words, reason codes, the host names
of trackers and of the report endpoint); counts and timings; booleans; the identity's short id, as the header shows it; the 4-character channel of a pair
code; the first 8 hex characters of an infohash; a conversation's or room's local id; a build id; a coarse network type; the label of a button or a link,
cut at 24 characters.

**Not allowed:** IP addresses and ports; a full user agent; names and nicknames; message text, drafts, search text and filter text; passphrases; keys,
boxes and proofs; the last 8 characters of a pair code; the fragment of a URL; the file names of a site; any free text a person typed. A string is cut at
200 characters.

How a page keeps to them:

- **By what it reports.** Each event is raised from one place in the code with fields that are words from closed lists, counts and times. A control is named by
  its role, function key, id or tag, and by the label of a button or link, never by an input's value. A control that shows what a person wrote (a name, a
  message, a preview) is marked `dir="auto"`, or `data-obs="off"` to opt it out, and then gives no label at all.
- **By masking, in the reporter.** Every string passes through `safeField` before it is queued: the text is folded to a plain form (NFKC, invisible
  characters dropped, spaces collapsed) and cut; IPv4 and IPv6 addresses in any written form, with their port, brackets or zone, become `x.x.x.x`; the ports
  and `raddr` of a WebRTC candidate line go, and so do the user fragment, the password and the fingerprint of an SDP; browser-made `.local` names become `x.x.x.x`; the part of
  a URL after `#` is cut (the `#` itself stays); a pair code keeps its first 4 characters; a run of 40 or more hex digits that holds a digit and a letter from a to f (an
  infohash, a ledger id) keeps its first 8. Forms an address hides in are read first: the ideographic full stop, the ratio sign for a colon, a dot or a colon written as `%2e`
  or `%3a`, a combining mark inside the address, and a group written in octal (`0300.0250.0.1`) are addresses. An address written as one integer or in hex
  (`3232235777`, `0xC0A80001`) is not recognised: no code of the loader writes one, and an error code such as `0x80070005` has that shape and is worth keeping. A pair code written
  without hyphens is not cut either (`abcd efgh 2345`): the loader never writes one, and the same separators are ordinary text elsewhere.
- **By masking and checking, at the endpoint.** The Worker masks every string again with rules written separately from the reporter's, so that the two lines of
  defence do not share their gaps, and refuses a batch whose shape or limits are wrong (400, nothing stored). The fields of the envelope that no mask looks at are
  checked against the shapes the reporters really write: a version in `loader`, at most 8 hex characters in `site`, a short id in `who`, the words of
  `navigator.connection` in `net`. It also cuts any run of 32 or more letters, digits, hyphens and underscores that holds a digit to its first 8 characters. It over-masks on
  purpose: a clock time such as 12:30:45 can come back as `x.x.x.x`. The identity page has its own small reporter with the same wire format.
- **What no mask can catch.** A mask recognises addresses, fragments, codes and long ids. It cannot recognise a name inside a sentence. So the two events that carry a
  sentence, `log` (the loader's own log lines, one by one) and `error` (the text of an error), carry only text the loader or the browser wrote, never anything a
  person typed, and a new log line must keep it that way ([Adding an event](#adding-an-event)). A path is no word a mask knows either, so a log line that names a file of
  the site hands the reporter its own text: `A.log(line, { report })` writes the whole line in the log the visitor can read and reports `report`, the line without
  the file ("cached copy incomplete").

### What the endpoint's host sees anyway

The batch has no address in it, and the Worker's code never reads the sender's address, but the request itself arrives from the visitor's address. The host that
runs the endpoint, Cloudflare for the Free-plan setup, sees that address as any server does. Keep its logs off and name the endpoint in your privacy notice
([PRIVACY](PRIVACY.md#usage-reports-unreleased)). The request also carries the headers every browser request carries, the full user agent string among
them. The Worker reads four of them (`Origin`, `Content-Type`, `Content-Length` and `Upgrade`) and keeps none; the host sees them all, as any server does. The
loader sets no cookie and its pages send no referrer, and a report goes to the endpoint's `/e` path only.

### What a report is worth

The reports are what reached the endpoint. A visitor who said no sends none, a browser extension or a network that blocks the request drops them (a `fetch` that fails is tried three times; for a beacon the
page does not learn that), a batch that failed three times is dropped, and the endpoint stops taking batches at its daily cap. Read the numbers as a floor, never as a
count of visits. Anyone who knows the endpoint can also post batches that look real: the list of allowed origins keeps other websites in a browser out, and
that is all it does (a program names any `Origin` it likes, takes any session id and any short id, and so can fill the day's budget and plant events that never
happened). A Cloudflare WAF custom rule on `/e` that blocks a request whose `Origin` is not one of yours, and the one rate limiting rule the Free plan has, run before the
Worker is called ([the Worker's README](../deploy/obs-worker/README.md#privacy) says how; not tried on Cloudflare). The reports are evidence of a page, not of a person.

## The events

The names are fixed, and the fields listed are the most an event may carry. A field without a value is left out. The apps' events have the prefix `apps.` and
the pair socket's `link.`; the loader's own events have none. The identity page's events come last (their `page` is `idp`).

### The loader: boot, run, consent, site, peers and the page

| Event | Fields | Raised when |
|---|---|---|
| `boot.start` | `t0ms`, `dev`, `degraded`, `forced`, `cspKind` | the boot script ran: the time since it started, a dev build or not, degraded mode (and whether it was forced), the kind of content security policy (a word) |
| `boot.features` | `missing`, `polyfilled`, `soft` | which browser features were missing (ids, comma separated), how many were filled in, and which soft limits apply (`webrtc`, `serviceWorker`, `lockdown`) |
| `boot.sw` | `ok`, `error` | the Service Worker probe at boot; `error` is a code word |
| `boot.stage` | `stage` | the stage the boot script reached |
| `run.start` | `mode`, `hasSw`, `webrtc` | the loader's run begins: the page's mode, and whether a Service Worker and WebRTC exist |
| `run.mode` | `mode` | the mode was resolved again after a sign-in round trip came back |
| `sw.register` | `ok`, `controlled`, `degraded`, `reloaded`, `error` | the Service Worker registration finished |
| `sw.outdated` | | the page and its Service Worker disagree on the protocol version |
| `gate.shown` | `kind`, `host` | a consent card or the gate was drawn: `kind` is `consent`, `gate` or `dns`; `host` is the report endpoint's host name |
| `gate.choice` | `choice` | a button on it was pressed: `accepted`, `host-only`, `cancel` or `settings` |
| `consent.set` | `choice`, `scope` | the consent state changed (`accepted`, `host-only` or `pending`); `scope` is `origin` or `site` |
| `pointer.resolved` | `source`, `firstTime`, `keyChanged`, `rotated`, `tried` | the site's pointer was found: where it came from, whether this device saw it for the first time, whether its key changed or rotated, and how many sources were tried |
| `pointer.error` | `code` | the pointer could not be found or verified |
| `pointer.withdrawn` | | the owner withdrew the site |
| `update.check` | `reason`, `result` | a check for a newer version ran, and what it found |
| `tab.role` | `leader` | whether this tab runs the engine for the site |
| `site.cache` | `hit`, `reason` | whether a stored copy was used and, if not, why (a word, never a file name) |
| `site.fetch` | `step`, `ms` | a step of the download (`start`, `torrent`, `rendezvous`, `download`, `persist`, `done`) and the time since it began |
| `site.progress` | `pct`, `peers`, `source` | download progress, at most once every 10 seconds |
| `site.error` | `code` | the download failed |
| `render.done` | `mode`, `ms` | the site was shown (`site`, `door` or `degraded`) after this many milliseconds |
| `tracker.state` | `host`, `state` | a tracker connection changed; the host name only |
| `peers.count` | `count`, `webseeds` | how many peer connections and web seeds the loader holds |
| `peer.wire` | `kind`, `ev`, `web` | a connection to a peer or a web seed opened or closed, for a swarm of this kind |
| `peer.ice` | `kind`, `ice`, `gathering` | the ICE connection and gathering states of a peer connection |
| `ledger.open` | `height` | the site ledger opened |
| `ledger.sync` | `entries`, `inSync`, `peers` | the ledger's sync state, at most every 5 seconds |
| `snapshot` | `result`, `blocks` | the snapshot's fetch finished |
| `connectivity` | `cls`, `answered`, `ms` | the STUN probe's class, how many servers answered and how long it took; never an address |
| `lifecycle` | `ev`, `hiddenS` | the page was hidden or shown, or went offline, with the seconds it was hidden |
| `net.change` | `type`, `effectiveType` | the coarse network type changed |
| `banner` | `id`, `ev` | a banner was shown or hidden |
| `diag.row` | `row`, `ev` | a diagnostics row was set or cleared |
| `error` | `kind`, `m` | an error, an unhandled rejection or a console error or warning (`kind` is `error`, `rejection` or `console`); `m` is the text, masked |
| `api.request` | `method`, `outcome` | a call from the site into the loader's API: the method's name, only when it is one of the API's, and `ok` or the reason; never its parameters or its answer |
| `log` | `m` | each line of the loader's own log ("the log ring, mirrored"), scrubbed before the reporter masks it: a URL keeps its scheme and host name and loses its port, path, query and fragment, an infohash or another long hash keeps its first 8 characters, a key keeps its tag and 4 characters, and a line ends at 300 characters. A line that names a file of the site is reported without the file, and so is a line that prints an error text of the cache, the download or the engine, which can name one (`download failed: E_BAD_TORRENT`, `saveSite failed`, `warning seed-error`); the visitor's own log keeps the whole line |
| `ui.click` | `role`, `fk`, `app`, `view`, `banner`, `dialog`, `row`, `card`, `id`, `tag`, `text`, `trusted`, `type` | a click or a form submit. The control is named by the first of `role`, `fk` (the part before its first colon), `app`, `view`, `banner`, `dialog`, `row`, `card`, `id` that it or an ancestor carries, else by `tag`. Each is looked for on the nearest element that has it, and the order of this list decides, not the distance: a control with an `id` inside a block that has a `data-role` is named by the block's role. `text` is the label of a button or link, cut at 24 characters and never taken from an input, nor from a control that shows what a person wrote (`dir="auto"` on it, around it or inside it, or `data-obs="off"`); a control too large to be searched for such a mark (more than 40 children of a node, 80 nodes below it or 200 ancestors above it) is taken to hold one and gives no label; `trusted` says whether the click was a real one |
| `ui.change` | `control`, `value` | a control changed; `value` only for a checkbox, a radio button or a select, never what was typed in a field |
| `settings.change` | `name`, `value` | a Settings control was used; `value` is its new setting when it is a switch. The contents of an export, an import or a passphrase are never read. Turning usage reports off is never reported |

### Identity on the loader's side

| Event | Fields | Raised when |
|---|---|---|
| `auth.change` | `signedIn` | the visitor signed in or out; `who` on the batches changes with it |
| `signin.start` | `how` | a sign-in began, from the loader's card or from the site's SDK call |
| `signin.result` | `code`, `ms` | it ended: `ok` or an error code, and how long it took |
| `signin.fallback` | `kind` | the sign-in window could not open and the loader fell back (to a card, or to the redirect round trip) |

### WebRTC links (`ice.*`)

The loader wraps `RTCPeerConnection` before the WebTorrent bundle loads. Every event names the connection by a small number, `id`, and carries states and kinds
of candidates only, never an address or a port. The calls' own connections (`src/calls`) are not wrapped.

| Event | Fields | Raised when |
|---|---|---|
| `ice.pc` | `id`, `ev` | a connection was `created` or `closed` |
| `ice.gathering` | `id`, `state` | its gathering state changed |
| `ice.state` | `id`, `state` | its ICE connection state changed |
| `ice.conn` | `id`, `state` | its connection state changed |
| `ice.local` | `id`, `type`, `proto` | a local candidate was found: `type` is `host`, `srflx`, `relay`, `prflx` or `other`, `proto` is `udp`, `tcp` or `other` |
| `ice.remote` | `id`, `sdp`, `types` | the other side's description was set: `sdp` is `offer` or `answer`, `types` lists the candidate kinds in it, in order, such as `host,host,srflx` (`other` for a kind it does not know) |
| `ice.pair` | `id`, `local`, `remote` | once the connection is up: the chosen pair as `type/proto` words, such as `host/udp` |

### The apps on the door page (`apps.*` and `link.*`)

Only on a door with apps and an endpoint. Every field is a word, a count, a boolean, the local id of a conversation or a room, or the 4-character channel of a code;
never a text, a name, a nickname, a key, a box, a proof, a lane or the secret half of a code.

| Event | Fields | Raised when |
|---|---|---|
| `apps.view` | `view`, `id` | a view opened (its name, and the local id of a conversation or a room) |
| `apps.card` | `kind`, `ev`, `why` | a card was shown, continued or cancelled |
| `apps.first-yes` | `via` | the visitor's first yes: `card`, the "Continue" of a price card that can start something (a card that names the host); reports may go from here. The view has a second value, `signin`, for a page that tells it that the sign-in window opened after a card that named the host; the loader's page does not do that, so a sign-in alone is never a first yes and this value does not occur today |
| `apps.signin` | `step`, `code` | `start`, `popup` (only when the page tells the view that the sign-in window opened, which the loader's page does not do today, so a door reports `start` and then `done` or `error`), `done` or `error` (with a code word) |
| `apps.code` | `ev`, `kind`, `why`, `channel` | the visitor's code opened, was replaced, closed or failed to open (`kind` is `pair` or `room`) |
| `apps.knock` | `ev`, `kind`, `channel`, `reason` | a request to someone else's code was `sent`, answered (`ok`) or failed (`error`); `reason` is a word of the service's own (`again`, `silent`) or one of the failure reasons of the project's rendezvous (`unknown-code`, `channel-taken` and so on), else `other`: never the text a rendezvous chose for itself |
| `apps.request` | `ev`, `kind`, `reason` | a request to the visitor's code arrived (`in`), was accepted (`accept`) or rejected (`reject`), expired, was turned away (`turned-away`) or dropped (`dropped`), or the accept failed (`accept-error`) |
| `apps.conv` | `id`, `status`, `reason`, `incoming` | a conversation changed status (`waiting`, `connecting`, `connected`, `rejected`, `left`, `blocked`, `removed`) |
| `apps.room` | `id`, `status`, `reason`, `members` | a room changed status, and how many members it has |
| `apps.wire` | `conv`, `ev`, `kind`, `reason` | the connection of a conversation or room went `up` or `down`, was closed (`kill`) or struck for a bad frame (`strike`) |
| `apps.msg` | `conv`, `status`, `count` | how many messages reached a status (`queued`, `scheduled`, `sent`, `received`, `delivered`, `read`, `failed`) at once; counts only, never text |
| `apps.notice` | `kind`, `why` | the page showed a notice |
| `link.state` | `state`, `prev` | the pair socket changed state |
| `link.open` | `attempt` | it opened, on this try |
| `link.gone` | `why` | it went away |
| `link.backoff` | `attempt`, `ms`, `why` | it will try again after this long |
| `link.sent` | `action` | a frame went out; the action's name, such as `pair-open` |
| `link.timeout` | `action`, `ms` | a request got no answer in time |
| `link.reply` | `action`, `ok`, `reason`, `ms` | a request was answered, and how fast; `reason` is one of the failure reasons of the project's rendezvous or the link's own (`link-down`, `timeout`), else `other` |
| `link.push` | `name` | the rendezvous pushed something (its name) |

### The identity page

Only when the page's own build names an endpoint, and only after the first press of a card button. It never sets `who` or `site`, and it never reports the pointer,
the identity key, the address or the short id of any site, or anything typed.

| Event | Fields | Raised when |
|---|---|---|
| `ready` | | the page is ready, in the sign-in window or its home page |
| `request` | `kind`, `shared`, `want`, `ref` | a sign-in request arrived: `kind` is `popup` or `redirect`, `shared` whether the site shares its origin, `want` what it asks for, as words of a closed list (the asked parts sorted and joined with `+`, among `keys`, `proof`, `record` and `erase`, such as `keys+proof`). `ref` is a field of this event, not a key of the batch: the opener's own session id, sent only on a popup, only when the opener's page has a reporter and its visitor has not said no, and this page said in its ready message that it reports (at a door the sign-in comes before the first yes, so the opener hands the id over while the choice is still open), so one operator who runs both endpoints can join the two timelines; a redirect request carries none |
| `card` | `kind` | a card was shown |
| `action` | `name` | a button on a card was pressed, as a word from a closed list |
| `unlock` | `method` | how the identity was unlocked: `passkey`, `passphrase` or `visit` |
| `result` | `code`, `ms` | the answer given to the site (`ok` or a code), and how long the whole request took, the person's own time on the cards included |
| `error` | `code` | a step failed; an `E_` code, never the person's cancel |

## Turning it on

You need an endpoint, a block that names it, and a paragraph in your privacy notice.

1. **Run the endpoint.** [deploy/obs-worker/README.md](../deploy/obs-worker/README.md) has the steps: one Worker, one Pages project in front of it, a read token,
   and the exact origins allowed to send reports (`ALLOW_ORIGINS`: the site, its door, the identity page). Check it with `curl https://<project>.pages.dev/healthz`,
   which prints `ok`.
2. **Name it when you publish.** One flag, with or without the apps flags:

       node tools/publish.mjs site --name my-site --scope example.com --key owner.jwk --ws https://example.com/ws/ --shell \
         --obs https://<project>.pages.dev

   which sets this block in the shell's `/_mw/door.json`, after the apps block when there is one:

   ```json
   "obs": { "endpoint": "https://<project>.pages.dev" }
   ```

3. **Tell visitors.** Name the endpoint, its operator and what it receives in your privacy notice: [PRIVACY](PRIVACY.md#additions-to-the-notice-template-usage-reports-unreleased)
   has the rows and sentences to add.

What the block is:

- `endpoint` is an exact origin: `https:` (or `http:` for a loopback host while you develop), with no path, no user name or password, no query and no fragment, no
  spaces, and at most 300 characters. Other keys are ignored. A block the loader cannot use (the reasons are `obs-shape`, `obs-endpoint` and
  `obs-endpoint-insecure`) is ignored, and the page sends no reports; `check-site --door` warns about it. An `http:` endpoint on a loopback host is used only by a page that
  is itself on a loopback host: on any other page it is `obs-endpoint-insecure`, so that a door's `door.json` cannot aim the reports of visitors who said yes at a service
  on their own machine (`http://localhost:6379`).
- It lives in `door.json`, a file of the loader's own shell, and never in the site's files, so the infohash does not change when you turn reports on or off.
- It is read fresh at each page load, with the browser's cache skipped, no credentials and no referrer, with a limit of 4 seconds: a failure means no reports.
  The bare door page reads it with its apps block; a site's shell page reads the same address once at the start; the identity page does not read it and takes its
  endpoint from its own build (`node tools/build-idp.mjs --obs https://<project>.pages.dev`, which also lets the page's `connect-src` reach that origin).
  Drop-in pages do not read it and send no reports.
- A door kit takes the block of the first `--door-site`, as it does the apps block. `tools/dev-server.mjs --obs <origin>` serves a block without changing the file.
  `check-site --door` prints `[info] door: usage reports to <host>` and never contacts the endpoint. All of that is in [DEPLOY](DEPLOY.md#usage-reports).
- To turn reports off, publish without `--obs` and deploy the shell again; it takes effect at each visitor's next page load. To stop the endpoint taking them, take the
  origin out of `ALLOW_ORIGINS`.
- The identity page's endpoint is named in its build, by whoever runs that page. A site owner who uses someone else's identity page has no say in whether it reports,
  and the card on that page names its host.

## The endpoint

The endpoint is [deploy/obs-worker](../deploy/obs-worker/README.md): a Pages project (`felinar-obs` in its default setup) that holds the front, and a Worker
(`felinar-obs-do`) with one SQLite-backed Durable Object, `ObsLog`, that stores the batches. The routes, in short (the exact contract is in
[INTERFACES](INTERFACES.md#usage-reports-contract-changes-architecture-1522)):

| Route | What it does |
|---|---|
| `GET /healthz` | `ok`, no token |
| `POST /e` | takes one batch from an origin in `ALLOW_ORIGINS`; an empty list refuses everything. A body over 32,768 bytes is refused (413), a wrong content type (415), a batch that does not fit the format (400 and one word, nothing stored), too many batches (429; once the day's total is reached every batch is 429 `day-all` before it is read). A batch the endpoint already has (the same session, number and text) is answered 204 and stored once |
| `GET /events.json` | the stored batches in time order, filtered by `sid` or `who`; needs the token (24 characters or more) |
| `GET /summary.json` | counts for the last hours: batches, events, sessions, signed-in identities, per page and per event name; needs the token |
| `GET /tail` | a WebSocket that sends one frame per batch as it is stored; needs the token |

The Worker reads four request headers (`Origin`, `Content-Type`, `Content-Length` and `Upgrade`) and never reads `CF-Connecting-IP`, `X-Forwarded-For` or `request.cf`,
and it never logs; a unit test searches its source for those names and lists what it touches. It stores one row per batch, with the time it arrived. **Rows are
kept 7 days** (`RETENTION_DAYS`, 1 to 30) and at most 50,000, whichever limit is reached first (at the endpoint's own 20,000 batches a day the 50,000 rows are reached after
2.5 days, so the oldest rows then live about 2.5 days, not 7); a sweep every 10 minutes deletes the older rows and the oldest above the cap. The allow list is not
authentication: anything that is not a browser can send any `Origin`. A `READ_TOKEN` of fewer than 24 characters is taken for none: the reads and the tail answer 404.

### The Free plan

Cloudflare's Workers Free plan, as the Worker's README states it from Cloudflare's pages: 100,000 requests and 100,000 SQL row writes a day, 5 GB of stored data and
13,000 GB-s of object time (the numbers as the project wrote them down from those pages on 2026-11-02; they were not checked against the pages again, and Cloudflare
changes its plans, so read the pages before you rely on them). The endpoint's cap is **20,000 batches a day**
(`MAX_BATCHES_PER_DAY`, all pages together), which is 40,000 row writes (a put now and a delete 7 days later) and about 1,150 more for the counter row (with the first
batch of a day, with every 20th, and by each sweep: 1 + 1,000 + at most 144 a day), 41,145 in all, or 82,290 if Cloudflare counts the key's index entry as a row of its own:
under the limit either way. That is computed from the code, not measured.

What that means for a site: a page sends a batch every 2 seconds at most, while it has something to send, so one page left open for an hour sends at most 1,800 batches
and a quiet page far fewer, and the cap is reached after about 11 such page-hours in a day (arithmetic from the timer; a headless site visitor sent 9 batches in a 1-minute probe, "What was tested live", and how many batches a visit by a person sends has not been
measured). Past the cap the endpoint answers 429 until midnight UTC and that day's later reports are lost. A script that sends any `Origin` can also use up the day's
100,000 requests, after which Cloudflare stops serving the endpoint, your reads included, until the limit resets. The endpoint has no per-address quota to offer
against that, because it never reads the address. What can run before the Worker is Cloudflare's own: a WAF custom rule on `/e` that blocks a request whose `Origin` is not
one of yours, and the one rate limiting rule a Free plan has, per client address (which Cloudflare sees and the Worker never does); the Worker's README says how, and that
it was not tried on Cloudflare.

## Reading the reports

Everything below needs the read token, a long random value (24 characters or more: the endpoint takes a shorter one for none and answers 404 to everything) that lives in the
Pages project as a secret and in a file only you can read. Anyone who has it can read every stored batch and watch the tail, so give it to tools from a file, never on a
command line.

With `curl`, the token stays out of the process list and the shell history when it goes in on standard input:

```sh
printf 'url = "https://<project>.pages.dev/summary.json?token=%s&hours=24"\n' "$(cat obs-read.token)" | curl -fsS -K -
printf 'url = "https://<project>.pages.dev/events.json?token=%s&limit=50"\n' "$(cat obs-read.token)" | curl -fsS -K -
```

`/events.json` answers `{ next, more, batches }`: pass `next` as `since` to read on while `more` is true. A stored row is
`{ at, sid, page, who, site, build, n, body }`, where `body` is the batch as it arrived, masked a second time; a stored time such as `12:30:45` may read `x.x.x.x`. Filter
with `sid` to follow one visit, or `who` to follow one signed-in identity. `/summary.json` answers `{ hours, from, to, truncated, batches, events, sids, who, pages, names }`,
reading at most the newest 5,000 rows; `truncated` says it stopped there.

The operations repository of the project's owner (`felinar-ops`, separate from this one) has three readers in its `obs/` folder. They take the endpoint's origin (https; http only
for a loopback address) and the token from a file (`--token-file <path>`) or an environment variable (`--token-env <NAME>`), never from the command line, run every line
through a redaction and escape anything a terminal could act on before printing, and exit 2 on a usage error or a token that cannot be read:

| Command | What it does |
|---|---|
| `node obs/events-tail.mjs --origin <obs origin> --token-file <path> [--sid x] [--who y] [--json] [--raw] [--count n]` | opens `/tail` and prints one line per event, `<UTC time> <page>/<sid, 4 characters>/<who or -> <name> k=v k=v`, for batches stored while it is connected (nothing older); `--json` prints the stored rows; `--raw` prints every frame, the greeting too, one per line, still masked and escaped (a frame that is JSON is written again on one line); it reconnects with backoff, exits 0 on Ctrl-C and 1 when the token is refused. A batch that arrives twice (see below) is shown once, except under `--raw` |
| `node obs/events-dump.mjs --origin <obs origin> --token-file <path> [--since key] [--hours N] [--sid x] [--who y] [--max-rows n] [--out file.jsonl]` | pages `/events.json` into JSON lines; `--hours` counts back from this computer's clock, and every run prints the last key it read, to continue from with `--since`; `--out` makes a file only you can read and never writes over one. A retried batch is written once. Keep a dump out of any repository: its rows hold session ids and short ids |
| `node obs/events-summary.mjs --origin <obs origin> --token-file <path> [--hours N] [--top N] [--json]` | prints the summary as a small table: a line of totals, then batches per page and events per name |

Its status check (`scripts/check.sh`) prints one informational line of counts when `OBS_READ_TOKEN` is in its environment, and never fails a run over it. The endpoint keeps
one of a batch that is sent again, but only while its object remembers it (see "What is sent"): a retry that came after a restart of the object, or past midnight UTC, can be stored
twice with the same `sid` and `seq`. `events-tail` and `events-dump` show or write one of each pair (kept in memory for the run, and only within it), `/summary.json` counts both,
and any other tool that counts should keep one of each pair.

## Adding an event

A contributor who adds an event, or a log line, keeps these rules (they are the field rules above, in the order you meet them):

1. **Name and fields.** The name matches `^[a-z][a-z0-9.-]{1,48}$`. At most 12 fields; a field's name is a letter and up to 31 letters, digits or underscores, and `t` and
   `n` are taken (a field of those names is dropped). A value is a string, a finite number, a boolean or `null`; any other value is dropped (the field is left out of the
   event), and `safeField` on its own returns `null` for it.
2. **Words, not text.** A value is a word from a closed list, a code, a count, a time, a local id or a short id. Never a name, a message, a draft, a search, a passphrase, a
   key, an address, a code beyond its 4-character channel, or any text a person typed. If you cannot name the closed list, do not report the field.
3. **Raise it from one place.** Through the page's `rep(A, name, fields)`, the apps' `report` option or the torrent manager's, and nowhere else; a report that throws must
   never change what the code does.
4. **Mind the log.** Every line written to the loader's log is mirrored as a `log` event. A new log line holds no name, message, passphrase, key or address, and no file
   of the site: a path is not a word the masks know. A line that has to name a file passes the text to report as the second argument, `A.log(line, { report: 'cached copy
   incomplete' })`; the visitor's own log keeps the whole line. So does a line that prints the message of an error that comes from the cache, the download or the engine (some
   of those messages name a file: "no data for <path>", "file missing from the torrent: <path>"): it reports its code and not the message. A test
   (`test/unit/obs-adversary.test.mjs`) reads every `A.log(` call of `app.js` and fails for a path without a report text, and for those five lines.
5. **Mind the controls.** A control that shows what a person wrote gets `dir="auto"` (as the apps' names, previews and message bodies do), or `data-obs="off"`, so that
   `ui.click` carries no label for it. Without one of them a button gives its first 24 characters. The search for the mark is bounded (see the `ui.click` row), and a control too
   large for it gives no label.
6. **Test and document it.** Add a case to the wiring tests (`test/unit/loader-app-obs.test.mjs` for the page, `loader-apps-obs.test.mjs` for the apps and
   `idp-obs.test.mjs` for the identity page) that raises the event and checks the batch it makes for forbidden content, and add the event to the tables on this page and
   to [INTERFACES](INTERFACES.md#usage-reports-contract-changes-architecture-1522).

## What it does not do

- **It is not analytics.** There is no third party, no profile, and no identifier of its own that follows a visitor from site to site (`sid` is new on every page load, and
  `who` is the short id of the key the visitor signed in with on that page). It does not count visitors either: see "What a report is worth".
- **It is not free to the page.** The reporter is part of the loader's own files whether or not a site turns reports on. Measured on 2026-11-02 with `node build.mjs`,
  `node tools/build-idp.mjs` and `gzip -9`, against the commit this work was built on: `_mw/loader.js` is 48,367 bytes larger (3.5 percent; 16,223 gzipped, 3.7 percent), `_mw/mw.js` 5,595
  (1,640 gzipped), and on the identity page `idp.js` is 10,628 larger (4,213 gzipped) and `sw.js` 269 (144 gzipped). Loading the reporter only on a page whose `door.json` names an
  endpoint would take that cost off the sites that never turn reports on; it is not built **(proposed)**.
- **It does not report everything.** Drop-in pages, the calls and the Service Worker send no reports. The loader's own buttons for a call are reported as clicks like any
  other control; the call itself is not.
- **It does not make the endpoint safe by itself.** A Worker that anyone can post to is a place anyone can fill. The allow list, the per-session and daily caps and the
  masks limit what a script can do; they do not authenticate it.
- **It cannot take back what it holds.** After a visitor turns reports off, what was already sent stays at the endpoint until the retention ends (7 days by default). The
  endpoint holds no name, so the owner cannot tell whose a batch is unless the visitor was signed in (`who`). An owner who needs everything gone at once can delete the
  object ([the Worker's README](../deploy/obs-worker/README.md) says how, and that it cannot be undone).
- **It has had one day of live runs, no more.** On 2026-11-02 it ran on Cloudflare, at a lab door, on the demo tier and on one phone, and the runs showed two defects, both fixed in the code and both fixes seen working from headless browsers the same day (the way the reporter sends, and the identity page's `ref`); a phone after the fixes has not run; what that covers, and what has not run, is under "What was tested live".

## What was tested

All of it on 2026-11-02. The four items below ran on one computer and nothing beyond loopback (127.0.0.1); the runs on Cloudflare, at two doors and on a phone, which came later that
day, are under "What was tested live". Nobody outside the project has reviewed the code or the privacy sentences. The counts are those of that day's runs.

- **Unit tests**, `node tools/run-unit.mjs`: 3,256 tests, 3,247 pass, none fail, 1 skipped and 8 marked todo (the skip and the todos were there before this change). The files
  that hold usage reports, with their tests: `loader-obs` 95 (the reporter on its own: batches, retries, the masks, `describeTarget`, the peer connection wrapper), `loader-app-obs` 46
  (the page's wiring: the block, the consent gating, the Settings switch, `inspect().obs`, the listeners, the event hooks, the report text of a log line), `loader-apps-obs` 46 (the apps' and the pair
  socket's events, with a scan of every field for message text, names, keys and codes), `idp-obs` 45 (the identity page's client, its build flag and its cards), `deploy-obs-core` 39 and
  `deploy-obs-worker` 34 (the endpoint's core and front over fakes, and a test that feeds them what the two real reporters write), `obs-adversary` 62 (an adversary's attempts on the privacy
  rules, the consent rules and the endpoint's limits, through the reporters, the page and the Worker: what held, the gaps it found and that were closed, and the limits that are by design),
  `tools-apps-block-obs` 7, `tools-publish-obs` 19, `tools-dev-server-obs` 11 and `tools-check-door` 16 (the block, the flags and the check; one test shows that the infohash is the same with and
  without `--obs`), `e2e-obs-collector` 21 (the stand-in for the endpoint that the scenarios below use) and `docs-observability` 11 (the event tables of this page and the words visitors
  read, against the code).
- **End to end**, `node test/e2e/run.mjs --only OBS-1,OBS-2,OBS-3`, Playwright Chromium, loopback only, against a collector that validates with the Worker's own `obs-core.js`:
  OBS-1, a site visitor (the card names the host and nothing leaves before the yes; then the boot, the card, the click, the consent, the pointer, the fetch, the render, the
  trackers, the peers, the ICE states and the log lines arrive in one session, in order, with no address in any body); OBS-2, two door visitors in two browsers who pair and
  write to each other (per session the views, the sign-in, the link, the code, the knock, the request and the states of the conversation, ICE by candidate type only, `who` set to
  each short id, and the order across the two sessions); OBS-3, "Load from host only", the Settings switch before and after the reports began, and a site and a door without the
  block, which send nothing more. 3 passed, 0 failed, 86.0 s. `MW_E2E_OBS_DUMP=<prefix>` makes each scenario write the rows its collector held to `<prefix>-<id>.jsonl`, for reading a run.
- **In real browsers**, opt-in (`MW_BROWSER=1 node --test test/unit/loader-obs-browser.test.mjs test/unit/idp-obs-browser.test.mjs`, or `npm run test:browser` for every browser test),
  Chromium 156.0.8078.4 and WebKit 27.2, loopback only, both passing. `loader-obs-browser` runs the reporter's module: 1,231 generated strings masked alike in the browser and in Node,
  `describeTarget` on a real DOM, `fetch` with `keepalive` on the timer, on pagehide and on `stop()`, a beacon when `fetch` is gone, with no preflight and nothing of the user agent string, a "no" that sends
  nothing, and 22 ICE events from a real two-connection WebRTC session with no address anywhere in them. `idp-obs-browser` builds the identity page with `--obs` and drives a popup
  sign-in, a card closed unpressed, the settings page and a redirect sign-in against a loopback collector: the line above the first buttons, silence before a press, the last
  report before the window closes, and the opener's session id as `ref`.
- **The operator's readers** (`felinar-ops`, `node --test obs/test/*.test.mjs`): 349 tests pass, against loopback servers that speak the endpoint's routes and frames; the tail also ran against the live endpoint on 2026-11-02 ([below](#what-was-tested-live)).

### What was tested live

On 2026-11-02, from 09:46 to 15:19 ET (every time below is ET), usage reports ran on real hosts for the first time: the endpoint on Cloudflare, a lab door and the demo tier, headless Chromium visitors and one real phone. They were runs by hand, by scripts and
by an operator's probe, not a load test, and they make no release gate row pass; [DEMO-RESULTS](DEMO-RESULTS.md#usage-reports-rows-to-add) records them as rows G-OB-1 to G-OB-5. The demo tier ran loader build 6dd2aa98cfe7 (the build the lab door ran from 12:43) from 13:16, d47a23a34bf3 from 14:45 and f9b26a88bc9c from 15:17, test
builds and not signed releases until 0.3.1 is released. The merged build (main 322261e) has these test numbers: unit 3,256 tests, 0 failures; the end-to-end scenarios APPS-1 to APPS-4 and OBS-1 to OBS-3 pass in Chromium, every request on loopback; fuzz for 60 s over
30,000 inputs, 0 violations; the examples' own tests, 186; the reporter's browser tests in Chromium 156 and WebKit 27.2; the adversary suite of 62 probes.

| When | What ran | What it showed |
|---|---|---|
| 09:46 | The endpoint, deployed: the Worker `felinar-obs-do` (version 9bbd3352, a SQLite-backed Durable Object, no `workers.dev` address) behind the Pages project `felinar-obs` at `https://felinar-obs.pages.dev`. `ALLOW_ORIGINS` names the demo site, the demo door, the demo identity page and the lab door, and `READ_TOKEN` is a Pages secret | A smoke from a Mac. `/healthz` answered `ok`. `/summary.json` answered 404 without the token and JSON with it. `POST /e` answered 403 from a foreign origin, 403 with `Origin: null` and 403 with no `Origin`, 400 for a session id of 13 characters and 204 for a valid batch. A stored row had `10.0.0.7` and `[2001:db8::1]:443` masked to `x.x.x.x`. The live tail connected and printed the hello frame. The Pages project was created with `--force`, once: `wrangler` 4.156 hands `pages project create` to Workers, and the plain command fails (later commands ran directly) |
| From 10:20 | The lab door (`felinar-demo-lab.pages.dev`, a Cloudflare Pages project) with reports on: loader build fdd689957ed5 from 10:20, and build 6dd2aa98cfe7 (with the transport fix, below) from 12:43. A headless Chromium visitor at 10:20 | `check-site --door`: 0 failures and `[info] door: usage reports to felinar-obs.pages.dev`. The visitor: sign-in ok in 970 ms, `auth.change` with the short id, Messages, the start card's Continue counted as the first yes, the pair socket open, `pair-open` acknowledged in 807 ms, a code opened. 2 batches and 26 events, with no address, no full code and no name in the raw rows |
| 11:31 | The lab door (build fdd689957ed5) with one real phone, the owner on it (Brave (Chromium), Android 16, Samsung Galaxy Z Flip, home Wi-Fi), and a headless Chromium knocker on a Mac | The knock was sent and acknowledged in 28 ms. The owner accepted 4 s after the knock (the `pair-accepted` push at 11:31:37.8). ICE went from checking to connected in 78 ms, selected pair `host/udp` to `host/udp`. The conversation connected 2 s after the accept, the greeting was delivered 0.8 s after it connected and read 2 s later, two messages from the phone reached the Mac with delivered and read receipts, and an operator line sent through the direct message was delivered |
| 11:33 to 12:43 | The same phone's reports | None stored: see "A lesson from the phone" below |
| 12:51 | Two headless browsers at the lab door (build 6dd2aa98cfe7), the owner side and the knocker, both reporting | The knock was acknowledged in 21 ms. The request came in, the accept card was shown and continued, and `pair-accept` was acknowledged in 45 ms. ICE went from checking to connected in 62 ms on both sides, pair `host/udp` to `host/udp`. The conversation connected on both, and messages showed queued, sent, delivered, read and received counts on both sides. A probe script outside this repository then fell into an echo loop for about 30 s (230 message events) and was stopped; it was not a fault of the loader |
| 13:16 | The demo tier, deployed after the merge (main 322261e). The GitHub Pages tree: the same site (infohash d680ff361bf8e03180ae871e3030bfb9ee99aaf1, unchanged; pointer sequence 1793642022; 398 days left), shell build 6dd2aa98cfe7, `door.json` with the apps block and the obs block. The demo door kit on `felinar-demo-door.pages.dev`. The identity page, rebuilt with `build-idp --obs` (`connect-src 'self' https://felinar-obs.pages.dev`, `data-mw-obs` on the root), on `felinar-demo-id.pages.dev` | `check-site` at the site: 0 failures and 1 warning (the known `max-age` of `mw-sw.js` on GitHub Pages). At the site's own door page and at the demo door: 0 failures and the usage reports info line |
| 13:17 to 13:18 | A read-back of the demo tier by headless browsers: two site visitors (the operator's live probe, `felinar-ops`, 1 minute), a sign-in at the demo door, and the identity page | The probe passed 4 of 4 checks, and peers met in 0.4 s (median). The two visitors reported as page `site`: `run.start` mode shell, `boot.sw` ok, `pointer.resolved` source meta, `gate.shown` kind consent with the host, `site.fetch` steps start, rendezvous, torrent, download (42 to 49 ms), persist, done (64 to 74 ms), `render.done` at 136 and 139 ms, `gate.choice` accepted, `consent.set` accepted, `tracker.state`, `peers.count` rising to 1, `ice.pair` `host/udp` to `host/udp` and `ledger.sync`; 9 batches and 226 events for one, 9 and 209 for the other. The sign-in at the demo door reported as page `door` (2 batches, 26 events, `who` set). The identity page reported as page `idp` (build 6841e6cbcee3): `ready`, `request`, `card`, `action`, `unlock` and `result` (6 events), and its rows carried no `ref`: the door page handed its session id over only after the first yes, and at a door the sign-in comes first. `syncReports` in `src/loader/app.js` now hands the id over while the choice is still open, and a page whose visitor said no hands over nothing; that change came after the build that ran; its live runs are the 14:45 and 15:19 rows below. A scan of all 53 rows of the day (945 events) found 0 IP addresses, 0 full pair codes and 0 names or email addresses |
| 14:45 | The demo tier after PR #12 (main b64528d): shell build d47a23a34bf3, pointer sequence 1793645349, the demo door and the lab door on the same build; a headless sign-in at the demo door | The door reported (2 batches, 26 events, `who` set) and the identity page reported (1 batch, 6 events), and its `request` event still carried no `ref`: on a door page the loader leaves `run()` before the call that hands the id over. Fixed the same hour (`installObs` now calls `syncReports` itself, PR #14) |
| 15:19 | The demo tier after PR #14 (main 7b00212): shell build f9b26a88bc9c, pointer sequence 1793648906, the demo door and the lab door on the same build; a headless sign-in at the demo door | The identity page's `request` event carried `ref` equal to the door session's id, the first time live. The door reported 2 batches and 26 events (`who` set), the identity page 1 batch and 6 events (`ready`, `request`, `card`, `action`, `unlock`, `result`). The batch header has no `ref`: the field sits on the `request` event alone, as the table of the identity page's events says |
| All day | The operator's tools in `felinar-ops` (private): `events-tail`, `events-dump` and `events-summary` (349 tests), and the status line of `scripts/check.sh`, which reads the endpoint when `OBS_READ_TOKEN` is set (the owner sets the secret) | The live tail was used throughout the day |

**A lesson from the phone: a page cannot say what the endpoint stored.** Between 11:33 and 12:43 the phone's Settings showed "Usage reports to felinar-obs.pages.dev: sending. Sent 99, waiting 1, dropped 0", and the endpoint had stored none of those batches. The reporter sent by
`navigator.sendBeacon`, a no-cors POST, and under the door's `Referrer-Policy: no-referrer` that request carries `Origin: null`, which the Worker refuses by design. A beacon has no answer, so the page counted what the browser took and not what the endpoint kept. The fix, in the
merged build: `fetch` with `keepalive` in cors mode first, because a cors request carries the page's real `Origin` and its answer says whether the batch was stored (a 2xx answer, for an origin on the allow list), and the beacon only as the fallback. After it, a headless visitor's
batches arrived over `fetch`; a phone on the demo tier after the fix has not run. After any change to how the reporter sends, compare what Settings says was sent with what `/summary.json` counts.

**A limit found live: the direct link on mobile data.** At 07:08, before the endpoint was deployed, a phone on mobile data (5G) took part in the pairing at the demo door: two knocks were delivered and accepted, but every WebRTC attempt went from ICE checking to disconnected at 15 s and then to
failed. The app offered again four times, every 20 to 35 s, and the remote candidates were `host` and `srflx` only. The pairing itself (the knock and the accept) worked across the public internet; the direct link needs a relay (TURN) for a peer on mobile data, and the apps have none
([ARCHITECTURE](ARCHITECTURE.md) 15.21), so a pair with a peer on mobile data does not connect without one (one phone, one run).

**Not run:** a real phone on the demo tier after the transport fix (the phone ran at the lab door, before it); Safari; Firefox and any engine but Chromium for the end-to-end scenarios (the authors of the reporter and of the identity page say they also tried them by hand in Firefox 157 on
loopback; that was not repeated here); the calls, which send no reports; and many visitors at once, so the day the cap is reached, and how many batches a visit by a person sends (a headless site visitor sent 9 in a 1-minute probe), are not measured. Hibernation of an idle tail and the
Free plan's counting are still untested, and so are the Cloudflare rules on `/e` that [the Worker's README](../deploy/obs-worker/README.md#privacy) describes.
