# w2b-04 VERIFY - skeptical fact-check of "Observability without a backend: diagnostics, canaries, opt-in telemetry"

> **Status: complete (2026-10-17).** Written in appended chunks so an interruption cannot lose work. Every number below was produced or re-read on 2026-10-17; raw outputs are in `docs/research/labs/w2b-04-verify-probes/results/`, the scripts that made them are in `docs/research/labs/w2b-04-verify-probes/` (Node >= 22, Playwright 1.64.1 from the repo's `node_modules`).

- **Checked document:** `docs/research/w2b-04-observability-no-backend.md` (findings F4, F6, F13, F20, F31-F36, F40, F44 and the Summary). Eight design-critical claims.
- **Role:** adversarial. For each claim I (a) re-opened the primary source and compared the exact wording, (b) wrote a counter-experiment or reproduction wherever the claim was testable locally, (c) looked for later changes in the repo and upstream.
- **Verdict scale:** *confirmed* (true as stated), *nuanced* (true in substance, but a stated detail, number or inference needs correcting), *refuted*, *unverifiable*. Nothing came out *refuted* as a whole; five claims need corrections.
- **Dates:** today is 2026-10-17. Sources are 2024-2026 unless marked `(OLD)`.

## Limits of this check (read first)

1. **No fresh web searches.** The shared WebSearch budget ("limit: 200 WebSearch calls per turn, shared by every agent in it") was already exhausted; both of my attempts were refused. I did not route around it (no search engine, proxy or archive via curl). Everything below is a *direct fetch of a named primary page or API* or a *local run*. Where a search would have been the natural step it is marked "not searched".
2. **GitHub REST API quota** (60 unauthenticated calls per hour per IP, shared with other agents) ran out and `gh` is not logged in. For the schedule-delay sample I used the public Actions web pages, which embed run timestamps as JSON.
3. **Firefox was not tested.** Playwright's Firefox (build 1555) does not start on this macOS 27 host (`Could not find profile folder`), the same failure the original run recorded as E12. Engines tested: Chromium `156.0.8078.4` and WebKit `27.2` (Playwright 1.64.1).
4. **No physical phone.** Mobile figures are extrapolations and are labelled so.
5. **The repo is changing under me.** Other agents edited `src/loader/*` and `docs/` while I worked (for example `app.js` was rewritten at 18:06). I therefore cite doc sections and function names for the repo, and line numbers only for `node_modules` (immutable).

## Scoreboard

| # | Claim (short) | Verdict | The correction in one line |
|---|---|---|---|
| 1 | WebSocket failure reasons are hidden from page scripts | **confirmed** | Spec quote is trimmed (seven situations, and "...in preparation for an attack"); the reason *is* readable by a Playwright/CDP harness in the same engine; locally decided failures (CSP, bad URL) are visible; timing is only a weak heuristic. |
| 2 | Wrappers must be installed before `import()` of webtorrent | **nuanced** | Facts reproduce exactly. But "must" holds only for wrappers that *replace* `window.WebSocket`/`RTCPeerConnection`: prototype hooks installed *after* the import saw 1 WS and 11 PCs. The bundle also captures `self.fetch` at init (third boundary). |
| 3 | GitHub Actions schedule semantics | **nuanced** | Every documented rule is quoted correctly. "Odd minutes" is not in the docs and is not supported by data (delays of 3-238 min at `:00`, `:17` and `:20` alike); the notification recipient rule is more complex; "only reliable alarm" is too strong; grace must be >= 60 min. |
| 4 | Web Vitals libraries cannot see inside the iframe | **confirmed** | Verbatim in README, CrUX and web.dev, and reproduced in Chromium 156. Add: sub-frames *can* report to the parent; cross-origin frames cannot be measured from outside. |
| 5 | Visitor telemetry must not be carried on the site chain | **nuanced** | Conclusion stands (stronger now), but the constants are from superseded ARCH v0.1: default bits are now **16**, the cap is **8 MiB** (not 50,000 blocks), default `writers` is **'owner'**; the "1.2 ms" mint cost is understated about 10x for the real block preimage. |
| 6 | DAP/Prio is not a finished standard | **confirmed** | All facts verified live. Add: the VDAF layer is also unfinished (rev 22, IRSG review); Janus and divviup-ts are maintained; the second aggregator may be a partner. |
| 7 | EDPB Guidelines 2/2023 paras 53 and 55; opt-in default | **nuanced** | Quotes and numbering exact. The EDPB itself says consent is *not* systematically required (paras 40, 56); CNIL exempts narrow anonymous performance measurement; the Commission's Digital Omnibus would add such an exemption (still in committee). |
| 8 | Telemetry endpoint only from loader build config | **nuanced** | Conclusion sound; rationale needs fixing: pointers already carry `tr`/`ws`/`xs`/`cs` endpoints; ARCH section 4 says unknown keys are "kept (and signed)", not "ignored"; "0 sendBeacon" is true but not a proof of "no egress". |

---

## Claim 1 - WebSocket failure reasons are hidden from page scripts

**Claim.** UAs must not convey failure information that distinguishes unresolvable host, refused connection, TLS failure or non-WebSocket server (close code 1006, generic error Event). In-page diagnostics can show which tracker failed and when, never why; only external probes (Node/CI/pin node) can.

**Verdict: confirmed.** The normative rule, the 1006/generic-Event behaviour and the design consequence are right in Chromium 156 and WebKit 27.2. Four refinements are worth writing into F6.

### What holds (primary sources, re-read 2026-10-17)

- WHATWG WebSockets Standard, *Living Standard, Last Updated 15 March 2026* (https://websockets.spec.whatwg.org/, saved copy parsed, 291 KB): "User agents must not convey any failure information to scripts in a way that would allow a script to distinguish the following situations: A server whose host name could not be resolved. A server to which packets could not successfully be routed. A server that refused the connection on the specified port. A server that failed to correctly perform a TLS handshake (e.g., the server certificate can't be verified). A server that did not complete the opening handshake (e.g. because it was not a WebSocket server). A WebSocket server that sent a correct opening handshake, but that specified options that caused the client to drop the connection (e.g. the server specified a subprotocol that the client did not offer). A WebSocket server that abruptly closed the connection after successfully completing the opening handshake. In all of these cases, the WebSocket connection close code would be 1006, as required by WebSocket Protocol. Allowing a script to distinguish these cases would allow a script to probe the user's local network in preparation for an attack. In particular, this means the code 1015 is not used by the user agent (unless the server erroneously uses it in its close frame, of course)."
- MDN `WebSocket: error event` (last modified May 2, 2025): "Event type: A generic `Event`." MDN `CloseEvent.code`: 1006 "Abnormal Closure ... Indicates that a connection was closed abnormally (that is, with no close frame being sent) when a status code is expected."
- **Measured** (`labs/w2b-04-verify-probes/ws-failure-matrix.mjs`, results in `results/claim1-ws-failure-matrix-*.txt`): eleven network-level failure classes against local servers I built. In **both** engines every one of them reached the script as one `error` event of class `Event` (own keys: `isTrusted` only, no `message`) followed by `close(code=1006, reason="", wasClean=false)`:

| Failure class (local test server) | Chromium 156: time to `error` (two runs) | WebKit 27.2: time to `error` (two runs) |
|---|---|---|
| TCP connection refused | 1.5 / 2.8 ms | 105 / 90 ms |
| DNS name not resolved (`.invalid`) | 105 / 105 ms | 134 / 127 ms |
| Non-WebSocket server (HTTP 200 to the upgrade) | 1.8 / 2.1 ms | 108 / 46 ms |
| HTTP 403 on upgrade | 1.7 / 3.5 ms | 119 / 42 ms |
| HTTP 500 on upgrade | 1.6 / 2.4 ms | 37 / 121 ms |
| HTTP 302 on upgrade | 2.0 / 2.2 ms | 109 / 93 ms |
| Bad `Sec-WebSocket-Accept` | 1.7 / 4.3 ms | 77 / 72 ms |
| Un-offered subprotocol in the 101 | 1.9 / 4.7 ms | 93 / 28 ms |
| `wss://` to a self-signed certificate | 14.9 / 27.2 ms | 118 / 129 ms |
| `wss://` to a plain-HTTP port (TLS protocol error) | 17.9 / 20.2 ms | 38 / 125 ms |
| Port on the browser's restricted list (6000) | 0.3 / 1.1 ms (error + close 1006) | 1 / 0 ms (error, **no** close, `readyState 3`) |

Only the DevTools console (`net::ERR_CONNECTION_REFUSED`, `net::ERR_NAME_NOT_RESOLVED`, `Unexpected response code: 403`, `net::ERR_CERT_AUTHORITY_INVALID`, `net::ERR_UNSAFE_PORT`, ...) knew the real cause; the page could not read it.

### Refinements (what to add to F6)

1. **The quote in F6 stops early and lists four of seven cases.** The sentence continues "...in preparation for an attack", and the list has seven situations (adds "packets could not be routed", "server dropped the client over options", "server abruptly closed after a good handshake"). The 1015 sentence is also normative. Not a substantive error.
2. **"Never why" is true for transport causes only.** What the script *can* see: (a) server-sent close frames: `close(4001, "app-reason")` and `close(1000, "bye")` arrived intact; (b) application-level tracker errors once the socket opens (the PoC already captured `failure reason` messages); (c) constructor exceptions decided locally: `SyntaxError` for a URL fragment (both engines), `SecurityError` for a mixed-content `ws://` from an `https://` page (Chromium); (d) CSP: Chromium fired `securitypolicyviolation` on the document (`violatedDirective: connect-src`, `blockedURI` set) plus an `error` with **no** `close`; WebKit instead threw `SecurityError` from the constructor. Engines disagree on these local cases, so a diagnosis engine must not depend on their fine detail.
3. **Timing is a heuristic, not a reason.** On loopback, Chromium separates DNS failure (105 ms) and TLS failures (15-27 ms) from the HTTP-level failures (< 5 ms); WebKit separates nothing (28-134 ms, no class pattern, and the order flips between runs). Real-network behaviour was not measured. Label any timing-based guess "hint".
4. **`WebSocketStream` is not an escape hatch** (Chromium 156): every network class made `opened` reject with `WebSocketError` carrying `closeCode: null` and message "WebSocket closed before handshake complete."; only post-handshake drops show `1006`.
5. **"Only external probes (Node/CI/pin node) can" is too narrow.** A harness that drives the *same engine* can read the reason: Playwright 1.64.1 `page.on('websocket')` + `ws.on('socketerror')` returned, in Chromium, `net::ERR_CONNECTION_REFUSED`, `net::ERR_NAME_NOT_RESOLVED`, `Error during WebSocket handshake: Unexpected response code: 403` (and `...: 200`); `page.on('console')` carries the same text. WebKit returns less specific strings ("The network connection was lost." for a refused port, "A server with the specified hostname could not be found.", "Forbidden: 403"). The page script saw only `error:Event close:1006` in the same runs (`results/claim1-playwright-harness-reasons.txt`). So the Playwright canary (R5) can record the engine-side reason next to `window.__mwDiag`, which a Node probe cannot (it tests a different TLS/DNS stack).

**Suggested edit to F6, last sentence:** "...cannot say DNS vs TLS vs 403 vs CORS *from page script*. A harness driving the same engine (Playwright `socketerror`, CDP console) can; so can Node probes, with a different network stack."

**Residual uncertainty.** Firefox and iOS Safari untested; no real-internet timing; WebSocketStream only in Chromium.

---

## Claim 2 - Boundary wrappers must be installed before `import('/webtorrent.min.js')`

**Claim.** The webtorrent 3.0.21 bundle captures `window.RTCPeerConnection` at module evaluation and `@thaunknown/simple-websocket` captures `WebSocket` at module init, so boundary wrappers must be installed before the import. Reproduced in Chromium 156: wrappers installed before saw 1 WS and 11 PCs with tracker announce payloads; installed after saw 0 and 0 while the transfer still completed.

**Verdict: nuanced.** Every fact reproduces. The conclusion "must be installed before" is true only for one wrapper style, and the bundle has a third captured global.

### What holds

- **Source.** `node_modules/webtorrent/dist/webtorrent.min.js` (222,929 bytes, sha256 `db4dca98cd135c732eeffdede3cf5f8febd0585a0eba4dc4d1effa1b901f4c3d`), top level, offset 109,500: `Ne="undefined"!=typeof window?window:self,Me=Ne.RTCPeerConnection||Ne.mozRTCPeerConnection||Ne.webkitRTCPeerConnection`. It comes from `webrtc-polyfill@1.2.2/browser.js` (`export const RTCPeerConnection = scope.RTCPeerConnection || ...`), imported by `@thaunknown/simple-peer@10.1.2/lite.js:3`, which constructs `new RTCPeerConnection(this.config)` at `lite.js:121`. `@thaunknown/simple-websocket@9.1.5/index.js:12`: `const _WebSocket = typeof ws !== 'function' ? WebSocket : ws` (bundle: `ft="function"!=typeof dt?WebSocket:dt`; `package.json` maps `ws` to `false` for browsers).
- **Re-run** of `labs/w2b-04-probes/boundary-wrappers-poc/run.mjs both` (Chromium `156.0.8078.4`): wrappers BEFORE the import: `done: true`, `wsCount: 1`, `pcCount: 11` (2 reached `connected`), tracker payloads `complete/incomplete/interval: 120`. AFTER: `wsCount: 0`, `pcCount: 0`, `done: true`, 1 `webrtc` wire. Identical to the claim (`results/claim2-poc-rerun.txt`).
- **Versions are current** (npm registry, fetched today): `webtorrent` 3.0.21 (published 2026-07-27T21:32:33Z, still `latest`), `@thaunknown/simple-websocket` 9.1.5 and `simple-peer` 10.1.2 (both 2026-07-25), `webrtc-polyfill` 1.2.2 (2026-06-08). Nothing newer to retest.

### Corrections

1. **"Must" is only true for constructor-replacing wrappers.** I wrote a counter-test (`proto-hooks-after.mjs`, same webtorrent transfer, Chromium 156): hooks on the *prototypes* (`WebSocket.prototype.send`; `RTCPeerConnection.prototype.createDataChannel/createOffer/setLocalDescription/setRemoteDescription/createAnswer/addIceCandidate`, each attaching `addEventListener` listeners the first time an instance is seen) installed **after** `await import('/webtorrent.min.js')`:

| Mode | WebSockets seen | PeerConnections seen | PCs connected | Tracker payloads |
|---|---|---|---|---|
| subclass wrappers installed after import (`ctor-after`) | 0 | 0 | 0 | none |
| prototype hooks installed after import (`proto-after`) | **1** | **11** | 2 | yes (6 in / 5 out announces) |
| prototype hooks installed before import (`proto-before`) | 1 | 11 | 2 | yes |

   The captured constructor and the patched prototype share the same native class, so late prototype hooks still fire. What late hooks lose is fidelity: an instance is first seen at its first hooked call (the WebSocket was already `readyState 1`, so `open` timing is missed; the PC's `new` and first `checking` states are missed) and constructor arguments are not seen (URL is still `ws.url`; PC config via `getConfiguration()`). **Recommendation:** keep the constructor wrappers in `boot.js` (best timing), add the prototype hooks as a fallback, and add a self-test ("saw >= 1 WebSocket after the first announce, else flag *instrumentation blind*") because the failure is silent.
2. **A third boundary is captured at init: `fetch`.** Same bundle, offset 102,099: `const Se=self.fetch||(()=>{throw new Error("global fetch is not available!")})`. `Se(...)` carries the web-seed range requests (`httpRequest`, offset 172,147), the `xs=` torrent download and URL-to-torrent parsing. A `window.fetch` wrapper installed after the import never sees web-seed traffic; Resource Timing (`PerformanceObserver` type `resource`) or the Service Worker does. The bundle's two literal `fetch(` calls (`.../cancel/`, `.../keepalive/`, offsets 210,972 and 211,564) are the same-origin streaming-server paths.
3. **Path.** The PoC imports `/webtorrent.min.js`; the shipped asset path is `/_mw/webtorrent.min.js` (`src/loader/config.js` `assets.webtorrent`). Wording only. `boot.js` is the classic script that runs first and imports the loader last, so it is the right place for the hooks (its header lists "(7) loader import" as the final step).

**Residual uncertainty.** Safari/WebKit and Firefox not run for this PoC (WebRTC loopback needs the Chromium mDNS flag; the original run recorded the same limitation). Whether `webtorrent` 3.x on Node uses a different path is irrelevant here.

---

## Claim 3 - GitHub Actions `schedule` semantics

**Claim.** 5-minute minimum, default branch only, delays especially at the start of every hour, queued jobs may be dropped under load, scheduled workflows in public repos auto-disable after 60 days without repository activity, notifications go only to the user who last modified the cron syntax. Therefore a missing success ping (dead-man's-switch) is the only reliable alarm and cron minutes should be odd (e.g. 7,37).

**Verdict: nuanced.** All six documented rules are quoted correctly. The two *inferences* ("only reliable alarm", "minutes should be odd") are not what the docs say and are not supported by the data I collected.

### What holds (verbatim, https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows, fetched 2026-10-17)

- "The shortest interval you can run scheduled workflows is once every 5 minutes."
- "Scheduled workflows run on the latest commit on the default branch." / "Scheduled workflows will only run on the default branch." / "This event will only trigger a workflow run if the workflow file exists on the default branch."
- "The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped. To decrease the chance of delay, schedule your workflow to run at a different time of the hour."
- "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." Same warning on https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows ("To prevent unnecessary workflow runs, scheduled workflows may be disabled automatically. When a public repository is forked, scheduled workflows are disabled by default."). The docs do not define "repository activity"; whether the workflow's own commits count is **unverified** (not searched).
- "Notifications for scheduled workflows are sent to the user who last modified the cron syntax in the workflow file."
- New since the research doc's wording: "By default, scheduled workflows run in UTC. You can optionally specify a timezone using an IANA timezone string" (a `timezone:` key next to `cron:`), with a DST rule ("a 2:30 AM schedule advances to 3:00 AM").

### Corrections

1. **Who is notified is more nuanced.** The notifications page (https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs) says: "Notifications for scheduled workflows are sent to the user who initially created the workflow. If a different user updates the cron syntax, in the schedule event in the workflow file, subsequent notifications will be sent to that user instead. If a scheduled workflow is disabled and then re-enabled, notifications will be sent to the user who re-enabled the workflow rather than the user who last modified the cron syntax." The events page adds that a user who changes the repository's default branch "becomes actor for those scheduled workflows". Net: always **one** person (the "actor"), who can change by cron edit, re-enable or default-branch change. "Only one person" stands; "last modified the cron syntax" is incomplete. A notification also needs that person's Actions notifications switched on, and exists only for a run that exists: nothing is sent for a dropped run or a disabled schedule.
2. **Another silent-stop mode the doc did not list.** "Scheduled workflows will not run if the last actor associated with the scheduled workflow has been deprovisioned by the Enterprise Managed User identity provider (IdP)." (same page). It strengthens the dead-man's-switch.
3. **"Odd minutes" is not in the docs and my data does not support it.** The docs say "a different time of the hour". Fetched 2026-10-17 from the public Actions pages (`gh-sched-delay.py`, results in `results/claim3-gh-schedule-delay.txt`), delay of the run's `createdAt` after its nominal cron slot:

| Workflow (public) | cron (as published) | n runs | min | median | p90 | max |
|---|---|---|---|---|---|---|
| home-assistant/core `lock.yml` | `0 * * * *` | 150 | 3.1 min | 5.2 min | 14.9 min | 35.3 min |
| home-assistant/core `stale.yml` | `0 * * * *` | 150 | 9.3 min | 15.1 min | 32.2 min | 48.9 min |
| microsoft/vscode `css-order-scan.yml` | `17 5 * * *` | 75 | 6.2 min | 9.7 min | 31.6 min | 159.3 min |
| github/docs `index-general-search.yml` | `20 16 * * 1-5` | 75 | 8.7 min | 15.8 min | 41.7 min | 237.8 min |

   Reading it: every minute tested (`:00`, `:17`, `:20`) started minutes to hours late; the two `:00` jobs with the *same* cron differ by 3x (5.2 vs 15.1 min median), so the minute is not the dominant factor; the off-peak minutes were not earlier. **No slot was missing** in 450 observed slots (150 and 150 consecutive hourly slots, 75 of 75 days, 75 of 75 weekdays; checked in the script), so "may be dropped" is documented but was not observed. Caveats: four workflows in three organisations, uncontrolled, a single week for the hourly ones, `createdAt` as shown by the page. It shows magnitudes only. Choosing a non-round minute such as `7,37` is harmless and matches the docs' advice; calling it "odd" is not the criterion.
4. **"Only reliable alarm" is too strong, "grace" is missing.** For the failure "the scheduler silently stopped" (dropped, disabled after 60 days, actor deprovisioned, nobody notified) an absent success ping is the right and sufficient alarm. But an independent active monitor on a *different* scheduler (for example a Cloudflare Cron Trigger, 5 free per account per F37, or a hosted uptime check) is also reliable, and two independent detectors beat one. And the ping needs a grace period sized to the observed lateness: with a 30-minute cadence, a grace under about 60 minutes will page on ordinary GitHub lateness (hourly jobs up to 49 min late); a daily job was up to 159-238 min late. Use grace >= 60 min for the 30-minute probe, and plan for the 60-day auto-disable (any repository activity inside the window resets it; the docs do not say what counts, and whether the workflow's own commits count is unverified).

**Suggested edit to F20 / Summary 5:** replace "use odd minutes (for example `7,37 * * * *`)" with "avoid `:00` and other round minutes as GitHub advises (`7,37` is fine), but design for runs 5-60 min late with rare multi-hour outliers (sample below); set the Healthchecks grace to >= 60 min". Replace "last modified the cron syntax" with "the workflow's current actor (creator, last cron editor, re-enabler or default-branch changer)".

**Residual uncertainty.** Not searched: any 2026 changelog entry that changes these semantics; the definition of "repository activity". The delay sample is small.

---

## Claim 4 - Web Vitals libraries cannot see the site inside the iframe

**Claim.** `web-vitals` (npm 6.2.3, 2026-10-05, ~3K brotli) states its APIs have "no visibility into `<iframe>` content (not even same-origin iframes)", while CrUX folds iframe content into the top-level page. In-page RUM must therefore use User Timing milestones (time-to-site-visible, offload ratio); `web-vitals` only inside the site frame via an opt-in SDK relay.

**Verdict: confirmed.** Verbatim in all three sources and reproduced in Chromium 156.

### What holds

- **README** (https://raw.githubusercontent.com/GoogleChrome/web-vitals/main/README.md, fetched 2026-10-17, lines 1275-1280): "The primary limitation of these APIs is they have no visibility into `<iframe>` content (not even same-origin iframes), which means pages that make use of iframes will likely see a difference between the data measured by this library and the data available in the Chrome User Experience Report (which does include iframe content)." / "For same-origin iframes, it's possible to use the `web-vitals` library to measure metrics, but it's tricky because it requires the developer to add the library to every frame and `postMessage()` the results to the parent frame for aggregation." / "Given the lack of iframe support, the `onCLS()` function technically measures DCLS (Document Cumulative Layout Shift) rather than CLS, if the page includes iframes."
- **Size and version.** README line 32: "tiny (~3K, brotli'd)"; line 89: the attribution build is "by about 1.5K, brotli'd" larger. npm registry: `latest` = `6.2.3`, published `2026-10-05T10:03:40.537Z`; `6.0.0` was `2026-07-21T17:17:45Z`.
- **CrUX** (https://developer.chrome.com/docs/crux/methodology): "Pages in CrUX are measured based on the top-level page. Pages included as iframes are not reported on separately in CrUX, but do contribute to the metrics of the top-level page. ... if frame.html has poor CLS then the CLS will be included when measuring the CLS for page.html."
- **web.dev** LCP (https://web.dev/articles/lcp): "The API does not consider elements within iframes but the metric does as they are part of the user experience of the page." CLS and INP articles say the same for `layout-shift` and `event` entries.
- **Reproduction** (`iframe-vitals.mjs`, `results/claim4-iframe-vitals.txt`): a small-text shell page with a 700 x 600 px iframe holding a large hero block and a button that does 150 ms of work and then inserts content above the hero. Observers (`largest-contentful-paint`, `layout-shift`, `event`) in the top frame and inside the frame. Chromium 156.0.8078.4, same-origin **and** cross-origin (`localhost` vs `127.0.0.1`) iframe: the **top frame's** LCP was only the shell paragraph (`P#shellp`, 2,384 px^2) while the frame's own observer saw `DIV#hero` (51,060 px^2); top-frame `layout-shift` entries: **0**, the frame's own: 0.1641; top-frame Event Timing saw only events dispatched to top-document nodes (`pointerover`, `pointerenter` x4, `mouseover`, 168 ms) and **none** of the frame's `pointerdown`/`mousedown`/`pointerup`/`mouseup`/`click`. WebKit 27.2: top-frame LCP shell only; no `layout-shift` entries anywhere; Event Timing reported the frame's `mousedown`/`pointerdown`/`pointerup`/`mouseup`/`click` (152 ms) to the frame's own observer and nothing to the top frame; the cross-origin frame's own LCP observer reported nothing in this run (not investigated).

### Additions (not corrections)

1. web.dev says the other half too: "Sub-frames can use the API to report their largest-contentful-paint entries to the parent frame for aggregation", and "In some cases (such as cross-origin iframes) it's not possible to measure LCP in JavaScript." For magnet-web the site frame can host the SDK, so the planned opt-in `mw.vitals` relay is the web.dev-endorsed route; a site that does not include the SDK stays unmeasured by the shell.
2. The README's statement that `onCLS()` degrades to DCLS applies to the **shell** too, so a shell-only CLS number must not be reported as the page's CLS.
3. WebKit gave no `layout-shift` entries at all in this run, consistent with the README's "`onCLS` Chromium only"; the relay will have a Safari coverage gap for CLS regardless of iframes.

**Residual uncertainty.** Firefox untested. The conclusion "must use User Timing" is a design choice, not a platform necessity (Resource Timing and the Service Worker are alternatives for byte/offload metrics).

---

## Claim 5 - Visitor telemetry must not be carried on the site chain

**Claim.** 14-bit Hashcash costs ~1.2 ms to mint on a desktop M3 (~36 ms on a phone), the per-author rate limit is evaded with fresh keys, every node stores every block (50,000-block load cap), reports would be public forever, and LDP protocols are poisonable by fake users (Cao, Jia, Gong, USENIX Security 2021). The safe chain use is an owner-signed `_health` aggregate filtered by `author == owner`.

**Verdict: nuanced.** The conclusion (no visitor telemetry on the chain) stands and is *stronger* under the current design. But the claim's constants come from the superseded ARCH v0.1, and the mint cost is understated about 10x for the block hash the architecture actually specifies.

### What holds

- **LDP poisoning.** arXiv 1911.02046, "Data Poisoning Attacks to Local Differential Privacy Protocols" by Xiaoyu Cao, Jinyuan Jia, Neil Zhenqiang Gong (v1 2019-11-05, v2 2020-12-09). Abstract: "an attacker can inject fake users into an LDP protocol and the fake users send carefully crafted data to the data collector such that the LDP protocol estimates high frequencies for arbitrary attacker-chosen items or identifies them as heavy hitters"; it covers "frequency estimation and heavy hitter identification"; the three countermeasures "can effectively defend against our attacks in some scenarios but have limited effectiveness in others". Venue confirmed: 30th USENIX Security Symposium (USENIX Security 21), pp. 947-964, August 2021 (https://www.usenix.org/conference/usenixsecurity21/presentation/cao-xiaoyu). `(OLD)` but still the standard reference.
- **Fresh keys are free** (`ecdsa-cost.mjs`, Node 24 WebCrypto, Apple M3, N = 300): ECDSA P-256 keygen 0.031-0.034 ms, raw export 0.009 ms, sign 0.029-0.040 ms, verify 0.058 ms; a throw-away identity plus one signature is about **0.07-0.08 ms**. So a per-author throttle (ARCH 6.1: "per author, local ... never part of validity") bounds nothing against someone who mints keys.
- **Every node relays and stores** (ARCH 6.6: "first acceptance of a block -> ANN to all other peers (every node relays)"; 6.7: "Startup loads all blocks"). **Public:** a tombstone drops `v` but keeps `{e, h, s}` (author key, minute-rounded timestamp, op header), and only honest nodes honour it.

### Corrections

1. **The constants are the superseded v0.1 ones.** `docs/review/ARCHITECTURE-v0.1.md` (the snapshot) has `Policy = { bits: 14, writers: 'open'|'owner'|'allow', ... rate: { n: 30, perMs: 600000 } }` and "Default 14 bits (~16k SHA-256, sub-second on phones)"; `review/requirements-fidelity.md` M5 cites "cap 50 000 blocks". `docs/review/DESIGN-REVIEW.md` item 4 replaced them: "`DEFAULT_POLICY = {writers:'owner', bits:16, maxValueBytes:2048, maxChainBytes:8 MiB, ...}` (owner may raise the cap to 64 MiB), `LIMITS.maxBlockBytes = 4096`", "Amend: ARCH 6.1, 6.2, 6.6 (replaces the 50,000-block cap)", "Past `maxChainBytes` only owner, moderator and allow-listed blocks are ingested", "Rename the per-author 'rate limit' to 'ingress throttle'", "Delete 'sub-second on phones'". The current `docs/ARCHITECTURE.md` 6.1 and `docs/INTERFACES.md` lines 80-81 say 16 bits / 8,388,608 bytes. F32, Summary 6 and this claim still say 14 bits and 50,000 blocks.
   - **Consequence A (default writers).** With `writers: 'owner'` a visitor's telemetry block fails the control-state check at ingest ("Rejected blocks are neither stored nor relayed", ARCH 6.3). Telemetry on the chain is therefore *impossible by default*; the fresh-key flood argument applies only to ledgers that opt into `writers: 'open'` (as the guestbook example does: `--policy open --bits 16`) or that allow-list the key.
   - **Consequence B (cap).** A flood is bounded in bytes (8 MiB default, 64 MiB ceiling), not in blocks. `w2c-02-chain-production-features.md` derives about 13.6k blocks at 8 MiB (618 B per block). Once full, only owner, moderator and allow-listed blocks are ingested, so telemetry would also *lock ordinary visitors out of the guestbook*. That is a better argument than the old block count.
2. **The mint cost is understated about 10x.** The "1.2 ms" is 16,384 / 1.3x10^7 H/s, where 13.0-13.2 MH/s is `06-browser-chain-vs-crdt.md` F10's "4-5 Workers, custom JS", measured on **43-byte, single-block** messages. The architecture's PoW is `leadingZeroBits(sha256(canonical(e))) >= bits` over the whole block header; a realistic telemetry header is **394 bytes (1 parent, 7 SHA-256 compressions)** to **528 bytes (3 parents, 9)**. My own miner (fixed-width nonce, pre-padded buffer, digests cross-checked against `node:crypto`; `miner-core.js`) reaches about 3.5 M compressions/s per Worker, matching F10's single-block figure, so the arithmetic is consistent and only the preimage length differs. Measured on this M3 (MacBook Air, 8 cores; `pow-bench-*.mjs`, `results/claim5-pow-bench-*.txt`), Chromium 156 / WebKit 27.2, header 394 B and 528 B:

| Quantity | Chromium 156 | WebKit 27.2 |
|---|---|---|
| pure-JS rate, 1 Worker | 0.50 / 0.37 MH/s | 0.29 / 0.25 MH/s |
| pure-JS rate, 5 Workers (aggregate) | 1.69 / 1.34 MH/s | 1.36 / 0.95 MH/s |
| `crypto.subtle.digest` await-loop, 1 Worker | 0.58 / 0.52 MH/s | 0.068 / 0.085 MH/s |
| **14-bit** expected mint (= 2^14 / rate): 5 Workers | **9.7 / 12.2 ms** | 12.0 / 17.3 ms |
| 14-bit, 1 Worker (measured mean of 150 mints) | 32 / 50 ms (median 22 / 28) | 58 / 60 ms (median 38 / 44) |
| 14-bit, WebCrypto loop (implied) | 28 / 31 ms | 241 / 193 ms |
| **16-bit** (the current default): 5 Workers | **38.8 / 48.8 ms** | 48 / 69 ms |
| 16-bit, 1 Worker (measured mean of 60 mints) | 174 / 283 ms (p95 531 / 883) | 201 / 234 ms (p95 585 / 782) |
| 16-bit, WebCrypto loop (implied) | 113 / 125 ms | 964 / 771 ms |

   A native attacker is faster still (`pow-bench-node.mjs`, one M3 core, `node:crypto`, 394 B header): 15.6 ms per 14-bit block, 56.8 ms per 16-bit block (mean; p95 51 / 206 ms). Filling the 8 MiB default cap (about 13.6k blocks) at 16 bits therefore costs about 13 minutes on one core or about 2 minutes on eight; a GPU (F10: about 2.2x10^10 H/s on short inputs, so perhaps 7-9x less on a 394-528 B header; inference, not measured) would need well under a second. So **"Hashcash does not limit a flood" is confirmed**, with 40-100 ms rather than 1 ms as the honest-visitor price. Using an unoptimised implementation (a WebCrypto loop on WebKit) the same 16-bit block costs 0.8-1.0 s on a desktop; faster WASM could cut the pure-JS figures several-fold (not measured).
3. **Phone figure: unmeasured.** The "36 ms" needs 0.46 MH/s, an extrapolation of single-block rates. The only third-party phone data in F10 are 4x10^4-1.2x10^5 H/s for naive WebCrypto loops, which would be roughly 0.14-0.41 s for a 14-bit block and 0.55-1.6 s for a 16-bit block (arithmetic on those rates, not a measurement). Treat both as unknown until DESIGN-REVIEW item 4's "PoW median and p95 on a mid-range Android" exists.
4. **`_health` is better expressed as a reserved key, and the owner key need not be online.** ARCH 6.5: "`_`-prefixed keys are owner/moderator-only", enforced by the reducer, and 6.2: moderators "may `tombstone`, `ban` and write `_`-prefixed keys". So `put('_health', ...)` (last-writer-wins, one live block) needs no reader-side `author == owner` filter, and a dedicated **moderator** key on the pin node avoids keeping the owner key online (6.2: "The owner's private key never enters a browser"). The text says "keys"; whether list names starting with `_` get the same rule is **not stated** (unverified). F44's "a real visitor holding the owner identity" conflicts with 6.2 as written.

**Suggested edits:** F32 and Summary 6: "default 16 bits (ARCH v0.2; was 14 in v0.1)", "cap 8 MiB `maxChainBytes` (replaced the 50,000-block cap)", "default `writers: 'owner'` rejects visitor blocks outright; open ledgers are the only exposure", "5-Worker mint of a real 394-528 B header: about 10-12 ms at 14 bits, 39-49 ms at 16 bits on an M3 in Chromium 156 (not 1.2 ms)". F44: use a reserved `_health` key written by a pin-node moderator key.

**Residual uncertainty.** Phones; WASM/SIMD miners; whether the `_` rule covers list names; the 13.6k-blocks figure is another agent's derivation (618 B per block).

---

## Claim 6 - DAP/Prio is not a finished standard; do not architect v1 around it

**Claim.** draft-ietf-ppm-dap-19 (2026-07-06) is an Active Internet-Draft at "WG Consensus: Waiting for Write-Up" with a revised I-D needed after WGLC; Divvi Up deployments need a second non-colluding aggregator; Cloudflare's Rust DAP implementation daphne (draft-09) was archived read-only on 2026-06-03.

**Verdict: confirmed.** All three facts check out live today. Additions below do not change the conclusion.

### What holds (fetched 2026-10-17)

- **Draft status** (https://datatracker.ietf.org/doc/draft-ietf-ppm-dap/ and the datatracker JSON API `/api/v1/doc/document/draft-ietf-ppm-dap/`): title "draft-ietf-ppm-dap-19", "Active Internet-Draft (ppm WG)", last updated **2026-07-06** (API: rev `19`, `2026-07-06T18:59:04Z`, expires `2027-01-07`, 122 pages), "Intended RFC status: (None)"; WG state **"WG Consensus: Waiting for Write-Up"** with tags "Awaiting Expert Review/Resolution of Issues Raised, Waiting for Referenced Document, **Revised I-D Needed - Issue raised by WGLC**"; IESG state "I-D Exists", Responsible AD "(None)"; the associated WG milestone "Dec 2023 - Submit PPM protocol to IESG for publication" is almost three years overdue; versions 00-19 only. Not an RFC.
- **daphne** (https://github.com/cloudflare/daphne): banner "This repository was archived by the owner on **Jun 3, 2026**. It is now read-only."; API `archived: true`. README: "Daphne currently implements: draft-ietf-ppm-dap-09; Prio3: draft-irtf-cfrg-vdaf-08; Taskprov extension: draft-wang-ppm-dap-taskprov-06". Its last code commit was 2025-04-08 ("Bump tokio from 1.39.3 to 1.44.2"), last push 2026-04-24 (a Semgrep CI workflow): it was ten DAP drafts behind (09 vs 19) before it was archived.
- **Two aggregators** (OLD, 2023-10-12, https://divviup.org/blog/divvi-up-in-firefox/): "In the DAP system, metrics are split into two unintelligible parts. One goes to a Divvi Up aggregator and the other goes to an aggregator run by Mozilla." Current docs (https://docs.divviup.org/how-it-works): "Each aggregator is operated by different organizations. Often, Divvi Up will act as the leader, while another organization operates as a helper. Crucially, these organizations are non-colluding." Home page step 03: "Two non-colluding servers".

### Additions

1. **The cryptographic layer is unfinished too.** `draft-irtf-cfrg-vdaf` is at rev **22** (2026-08-15), IRTF-stream state "Awaiting IRSG Reviews", not an RFC (167 pages). So "Prio" (as Prio3 inside a VDAF) is not a published standard either.
2. **"No maintained implementation" is only true for a Worker-hosted aggregator.** ISRG's Janus (https://github.com/divviup/janus, MPL-2.0, "Experimental implementation of the Distributed Aggregation Protocol (DAP) specification", pushed 2026-10-17) and the TypeScript client `divviup-ts` (https://github.com/divviup/divviup-ts, pushed 2026-10-14) are active. Janus is a Rust service, not a Worker.
3. **The second aggregator can be a partner's.** Divvi Up speaks of "the aggregators provided by Divvi Up and its partners". A subscriber need not run one, but must find a non-colluding partner; a single-owner static site has none, so deferring remains right.

**Residual uncertainty.** Not searched: PPM working-group minutes or mailing-list traffic after 2026-07-06 (a rev 20 may be in preparation); the original's "second WGLC" snippet is a secondary source and was not re-checked.

---

## Claim 7 - EDPB Guidelines 2/2023 (paras 53 and 55); opt-in consent as the default

**Claim.** EDPB Guidelines 2/2023 v2.0 (adopted 2024-10-07) para 53: client-side code that sends locally produced information back to a server constitutes "gaining of access to information already stored" under Art. 5(3) ePrivacy, and para 55 puts IP addresses originating from the user's terminal equipment in scope; opt-in consent is the defensible default for any beacon (not legal advice).

**Verdict: nuanced.** The citations are exact. The conclusion "opt-in consent ... for any beacon" is a conservative reading that the EDPB itself explicitly declines to make, and there is a live consent-free path for narrow measurement in at least one member state.

### What holds

- **The document** (https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf, 15 pages, text extracted with `pdftotext`): "Guidelines 2/2023 on Technical Scope of Art. 5(3) of ePrivacy Directive, Version 2.0, Adopted on 7 October 2024"; history: v1.0 14 November 2023 (public consultation), v2.0 7 October 2024. EDPB page (https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en): "Guideline, 16 October 2024, Final version".
- **Para 53** (section 3.2 "Local processing"), verbatim: "If at any point and for example in the client-side code, the processed information is made available to a third-party, for example sent back over the network to a server, such an operation (instructed by the entity producing the client-side code distributed on the user terminal equipment) would constitute a 'gaining of access to information already stored'. The fact that this information is being produced locally does not preclude the application of Article 5(3) ePD."
- **Para 55** (section 3.3 "Tracking based on IP only"), verbatim: "However, gaining access to IP addresses would only trigger the application of Article 5(3) ePD in cases where this information originates from the terminal equipment of a subscriber or user. While it is not systematically the case (for example when CGNAT is activated), the static outbound IPv4 originating from a user's router would fall within that case, as well as IPV6 addresses since they are partly defined by the host. Unless the entity can ensure that the IP address does not originate from the terminal equipment of a user or subscriber, it has to take all the steps pursuant to the Article 5(3) ePD."

### Corrections

1. **The EDPB does not say consent is the default.** Para 40: the guidelines "do not analyse the application of the exemptions to the obligation to collect consent". Para 56: "the applicability of this article does not systematically mean that consent needs to be collected. The EDPB thus reminds that in each case it would have to be assessed if a consent is needed or whether an exemption under Article 5(3) ePD could apply." So "opt-in is the defensible default" is the researcher's *conservative* choice, fine as engineering policy, but not an EDPB position. Para 55's context is IP-only tracking (para 54) and carries the CGNAT carve-out.
2. **A consent-free path exists in at least one member state.** CNIL (page dated 4 July 2025, https://www.cnil.fr/fr/cookies-et-autres-traceurs/regles/cookies-solutions-pour-les-outils-de-mesure-daudience): trackers can be "exemptés de consentement conformément à l'article 82 de la loi Informatique et Libertés" if they are "utilisés pour une finalité strictement limitée à la seule mesure de l'audience du site ou de l'application (mesure des performances, détection de problèmes de navigation, optimisation des performances techniques ou de son ergonomie, estimation de la puissance des serveurs nécessaires, analyse des contenus consultés), pour le compte exclusif de l'éditeur" and "servir à produire des données statistiques anonymes uniquement", without cross-site tracking; CNIL recommends informing users, a tracker lifetime of about thirteen months and retention of at most twenty-five months. Narrow, anonymous, publisher-only performance diagnostics have exactly the shape of Plan W's `/_t`. ePrivacy is a directive implemented nationally; other member states were **not checked**.
3. **Pending law (a proposal, not in force).** The Commission's Digital Omnibus, COM(2025) 837 final (19.11.2025; procedure 2025/0360(COD); https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:52025PC0837), proposes a GDPR Article 88a: consent by default for personal data on terminal equipment, but lawful without consent when necessary for "(c) creating aggregated information about the usage of an online service to measure the audience of such a service, where it is carried out by the controller of that online service solely for its own use; (d) maintaining or restoring the security of a service ...". European Parliament Legislative Observatory (fetched 2026-10-17): "Stage reached in procedure: Awaiting committee decision", committee draft report PE786.818 (22/06/2026), amendments tabled 27/07/2026. Do not design around it; note it would apply to **personal data** only.
4. **Scope is wider than the beacon (relevant to the whole loader).** Paras 33-34: JavaScript or an SDK that instructs the terminal to send data triggers Art. 5(3) even when the instructing entity and the recipient differ. Para 42 lists "routing identifiers such as the MAC or IP address ..., but also session identifiers (SSRC, Websocket identifier)". Paras 24-25 treat ad-hoc peer networks, "as little as two peers", as electronic communications networks within scope (Briar is the footnote example). The loader's tracker WebSockets and WebRTC peer connections are therefore themselves inside the "gaining of access" analysis; the exemption question stays open and is the abuse/legal wave's to answer. The existing consent notice/gate before the first announce (ARCH 5.7, section 8) is the right place.

**Suggested edit to F36's last sentence:** "Consequence: for a beacon, opt-in consent is the conservative engineering default; the guidelines expressly leave exemptions (strictly necessary for a service the user requested; national rules such as CNIL's anonymous-audience-measurement exemption) to case-by-case assessment (paras 40, 56)."

**Residual uncertainty.** National implementations other than France; whether P2P diagnostics (as opposed to audience statistics) fit CNIL's exemption (the page names "detection of navigation problems" and "technical performance" but is written for audience measurement); Omnibus amendments after the 2026-07-27 tabling.

---

## Claim 8 - The telemetry endpoint must come only from loader build/deploy config

**Claim.** A telemetry endpoint must never be supplied by a pointer record, `<meta>` tag, URL fragment or SDK message: pointer content is publisher-controlled (and in hub mode belongs to unrelated sites), so a `tel=` field would make every pointer a tracking-pixel vector. The endpoint must come only from the loader build/deploy config, with absence meaning no code path (build-time dead-code elimination, CI assertion; `webtorrent.min.js` currently has 0 `sendBeacon` occurrences).

**Verdict: nuanced.** The rule is sound and the Element precedent is accurate. The *rationale* ("every pointer a tracking-pixel vector") is not new information about pointers, one cited detail is misquoted, and the proposed CI assertion is too weak to prove "no code path".

### What holds

- **Element Web** (https://raw.githubusercontent.com/element-hq/element-web/develop/docs/config.md, fetched 2026-10-17): `bug_report_endpoint_url` "When not present in the config, the app will disable all rageshake functionality ... You may also set the value to `"local"` if you wish to only store logs locally"; Analytics: "When these configuration options [`posthog.api_host`, `posthog.project_api_key`] are not present, analytics are deemed impossible and the user won't be asked to opt in to the system." `apps/web/src/PosthogAnalytics.ts` (same repo): "If Posthog isn't configured in `config.json`, events are not sent" and `respect_dnt: true`.
- **Bundle:** `node_modules/webtorrent/dist/webtorrent.min.js` (222,929 B, sha256 `db4dca98...f4c3d`): `sendBeacon` **0**, `XMLHttpRequest` 0, `EventSource` 0, `new Image` 0. Current `src/` (grep, 18:13): no `sendBeacon`, `new WebSocket`, `XMLHttpRequest`, `EventSource`, `new Image`; `docs/ARCHITECTURE.md` line 636 states "no analytics, no third-party scripts".
- **Repo references exist as cited:** ARCH 3 (hub modes), ARCH 4 (pointer grammar), `docs/review/security.md` M6 ("functionally a third-party analytics beacon on every page view").

### Corrections

1. **Pointers already name publisher-chosen endpoints that every visitor's browser contacts.** ARCH 4 grammar: `xs=<https URL of the .torrent>; ws=<web seed base URL>; tr=<wss URL>; ... cs=<https URL of a ledger snapshot>`, "Repeatable keys: `tr`, `ws`, `xs`." The loader fetches them: `probeWebseed` issues `GET` with `Range: bytes=0-0` to the `ws=` URL, `_fetchTorrent` fetches `xs=` (both in `src/loader/torrent.js`), and `config.js` notes "a signed pointer's tr= list is used exactly". So IP, timing and infohash already reach publisher-chosen hosts **by design**; "a `tel=` field would make every pointer a tracking-pixel vector" overstates what `tel=` would add. The rule survives on better grounds: (i) a telemetry beacon adds an application-layer *payload* that the gate does not describe; (ii) accountability: EDPB para 34 (claim 7) puts the entity that distributes the instructing code in scope even when the recipient is someone else, so in hub mode the loader operator would answer for a recipient chosen by an unrelated publisher; (iii) the existing gate/notice lists trackers and the publisher fingerprint, not a hidden extra endpoint.
2. **F40 misquotes ARCH 4.** F40 says "section 4 says unknown pointer keys are ignored". ARCH 4 says: "Unknown keys are kept (and signed)." (they enter the signing input). An old loader would carry and not act on `tel=`, so the compatibility point holds, but the wording should be "kept, signed and not acted on".
3. **"0 `sendBeacon`" is true but cannot prove "no code path".** The bundle opens WebSockets and WebRTC, and calls web seeds and `xs=` through its init-captured `fetch` (claim 2, correction 2). Any of those can carry a payload. CSP `connect-src` covers `fetch()`, `fetchLater()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon()` and `<a ping>` (MDN, fetched 2026-10-17); that list does not include image loads (`img-src`), navigations or WebRTC (whether a newer CSP directive covers WebRTC was not checked). Make the **egress allow-list test** (R12) the primary assertion: drive the built loader in Playwright with telemetry unset and fail on any request/WebSocket/RTC destination outside {loader origin, pointer-listed trackers, web seed, `xs`, DoH, STUN}; keep "0 `sendBeacon`/`navigator.sendBeacon`/`new Image`/`XMLHttpRequest` in the loader build" as a cheap second check; and keep `connect-src` narrow in the shell CSP.
4. Element supports "absence = no UI and no code path" only because config is deployer-controlled; the same holds if `config.js` is replaced at deploy time as proposed. Note `config.js` is a frozen module bundled into the loader, so "build-time dead-code elimination" needs a build constant (for example esbuild `--define`), not a runtime object check; no such constant exists in `src/` today.

**Suggested edit to F40:** "Pointers already carry `tr`, `ws`, `xs` and `cs` URLs, so the exposure of IP and timing to publisher-chosen hosts exists by design and is shown at the gate. A telemetry endpoint must still never come from a pointer, `<meta>`, fragment or SDK message, because it would add a payload the gate does not describe and make the loader operator the party that instructs the device (EDPB para 34) toward a recipient it did not choose."

**Residual uncertainty.** The `pointer.js` implementation was not in the tree during this run (INTERFACES lists it), so the grammar was checked in the spec, not in code.

---

## Cross-cutting findings (not asked for, but they change decisions)

1. **The research doc quotes a superseded chain design.** F32, Summary 6 and the checked claim use ARCH v0.1 constants (14 bits, 50,000 blocks, default open writers). Anything else in w2b-04 that leans on those numbers (R18, R19, Plan W comparisons) should be re-read against ARCH v0.2 / DESIGN-REVIEW item 4. Check also `w2c-05-testing-qa-production.md` line 28, which still says "the default 14-bit hashcash".
2. **Three init-time captures, not two.** `RTCPeerConnection`, `WebSocket` and `fetch` are all captured when `webtorrent.min.js` is evaluated (claim 2). Any instrumentation plan that lists only the first two will be blind to web-seed and `xs=` traffic.
3. **A real browser can see what the page cannot.** The Playwright canary (R5) can read the WebSocket failure reason in the engine under test (claim 1), so R3's Node probe and R5's browser canary are complementary, not redundant.
4. **EDPB scope covers the P2P core, not only the beacon.** Paras 24-25, 33-34 and 42 (claim 7) put tracker WebSockets and WebRTC peer connections inside the Art. 5(3) analysis; the consent-before-first-announce design (ARCH 5.7, section 8) is therefore load-bearing, and the exemption analysis belongs to the abuse/legal wave.
5. **A stale defect.** F5/R7 say `CONFIG.trackers` "still lists `wss://tracker.btorrent.xyz` ... and `wss://tracker.files.fm:7073/announce`". `src/loader/config.js` (17:45) now lists `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.novage.com.ua` and `open.ftorrent.com` with the comment "Live public WebSocket trackers on 2026-10-14". R7's first half is already done in the tree.

## Consolidated edits proposed for `w2b-04-observability-no-backend.md`

| Where | Edit |
|---|---|
| F6, Summary 1 | Add: reason readable by a same-engine harness (Playwright `socketerror`, console); locally decided failures visible; timing = hint only; `WebSocketStream` no better. Complete the quote ("...in preparation for an attack"; seven situations). |
| F4, Summary 2 | Say "constructor-replacing wrappers must precede the import; prototype hooks work after it with lower timing fidelity"; add `self.fetch` as a third init-time capture; add the "instrumentation blind" self-test. |
| F20, Summary 5 | Drop "odd minutes"; say "avoid `:00`/round minutes, expect 5-60 min lateness (sample: median 5-16 min, max 35-238 min, no missed slot in 450)"; Healthchecks grace >= 60 min; recipient = the workflow's actor (creator, last cron editor, re-enabler, default-branch changer); add the EMU deprovisioning stop. |
| F32, Summary 6 | Replace 14 bits / 50,000 blocks with ARCH v0.2 (16 bits, 8 MiB `maxChainBytes`, default `writers: 'owner'` rejects visitor blocks); replace "1.2 ms" with measured 10-12 ms (5 Workers, 14 bits) / 39-49 ms (16 bits) on an M3 in Chromium 156; mark phone numbers unmeasured. |
| F44, R18 | Use a reserved `_health` key and a pin-node *moderator* key (ARCH 6.2, 6.5); remove "visitor holding the owner identity". |
| F34 | Optional: VDAF draft rev 22 at IRSG review; Janus and `divviup-ts` maintained; helper may be a partner. |
| F36, Summary 12 | Replace "opt-in consent is therefore the safe default" with the conservative-default wording plus paras 40/56, CNIL, and the Omnibus status. |
| F40, Summary 8 | Replace the "every pointer a tracking-pixel vector" rationale; fix "unknown keys are ignored" to "kept (and signed)"; make the egress allow-list test the primary assertion. |
| F5, R7 | Mark the tracker-list defect as fixed in `config.js` (2026-10-17). |

## Not verified, not searched, or not testable here

- **Fresh web searches** (budget exhausted): any 2026 GitHub changelog entry on `schedule`; WHATWG/Chrome issues proposing richer WebSocket error details; PPM WG activity after 2026-07-06; other EU member states' Art. 5(3) practice; Omnibus amendments after 2026-07-27.
- **Engines/devices:** Firefox (cannot start here), iOS Safari, any real phone; real-internet WebSocket failure timing.
- **GitHub semantics:** what counts as "repository activity" for the 60-day rule (undocumented); whether a workflow's own commits count.
- **Repo internals:** `pointer.js` is not in the tree yet (grammar checked in ARCH 4 only); whether list names starting with `_` are owner/moderator-only (ARCH 6.5 says "keys"); whether a newer CSP directive covers WebRTC.
- **Derived, not measured:** phone mint times, GPU cost for a 394-528 B header, the 13.6k-block figure (taken from `w2c-02`).

## Sources (all fetched or run on 2026-10-17 unless noted)

- WHATWG WebSockets Standard (Living Standard, last updated 15 March 2026): https://websockets.spec.whatwg.org/
- MDN WebSocket `error` event (modified 2 May 2025): https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/error_event ; MDN `CloseEvent.code`: https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code ; MDN CSP `connect-src`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src
- npm registry: https://registry.npmjs.org/webtorrent , https://registry.npmjs.org/web-vitals , https://registry.npmjs.org/webrtc-polyfill , https://registry.npmjs.org/@thaunknown%2Fsimple-websocket , https://registry.npmjs.org/@thaunknown%2Fsimple-peer
- GitHub Actions docs: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows ; https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows ; https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs
- Public Actions pages used for the delay sample: https://github.com/home-assistant/core/actions/workflows/lock.yml , .../stale.yml ; https://github.com/microsoft/vscode/actions/workflows/css-order-scan.yml ; https://github.com/github/docs/actions/workflows/index-general-search.yml (each with `?query=event%3Aschedule`)
- web-vitals README: https://raw.githubusercontent.com/GoogleChrome/web-vitals/main/README.md ; CrUX methodology: https://developer.chrome.com/docs/crux/methodology ; web.dev: https://web.dev/articles/lcp , https://web.dev/articles/cls , https://web.dev/articles/inp
- arXiv: https://arxiv.org/abs/1911.02046 ; USENIX Security 21: https://www.usenix.org/conference/usenixsecurity21/presentation/cao-xiaoyu
- IETF datatracker: https://datatracker.ietf.org/doc/draft-ietf-ppm-dap/ , https://datatracker.ietf.org/api/v1/doc/document/draft-ietf-ppm-dap/ , https://datatracker.ietf.org/api/v1/doc/document/draft-irtf-cfrg-vdaf/
- daphne: https://github.com/cloudflare/daphne (+ README, commits API); Janus: https://github.com/divviup/janus ; divviup-ts: https://github.com/divviup/divviup-ts ; Divvi Up: https://divviup.org/blog/divvi-up-in-firefox/ (2023-10-12, OLD), https://divviup.org/ , https://docs.divviup.org/how-it-works
- EDPB: https://www.edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf ; https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en
- CNIL: https://www.cnil.fr/fr/cookies-et-autres-traceurs/regles/cookies-solutions-pour-les-outils-de-mesure-daudience (4 July 2025)
- Digital Omnibus: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:52025PC0837 ; https://oeil.secure.europarl.europa.eu/oeil/en/procedure-file?reference=2025/0360(COD)
- Element Web: https://raw.githubusercontent.com/element-hq/element-web/develop/docs/config.md ; https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/src/PosthogAnalytics.ts
- Repo: `docs/ARCHITECTURE.md` (sections 3, 4, 6, 13), `docs/INTERFACES.md` (lines 80-81), `docs/review/ARCHITECTURE-v0.1.md`, `docs/review/DESIGN-REVIEW.md` (item 4), `docs/review/requirements-fidelity.md` (M5), `docs/review/security.md` (M6), `docs/research/06-browser-chain-vs-crdt.md` (F10, F36), `docs/research/w2c-02-chain-production-features.md`, `node_modules/webtorrent/dist/webtorrent.min.js`, `node_modules/@thaunknown/simple-websocket/index.js`, `node_modules/@thaunknown/simple-peer/lite.js`, `node_modules/webrtc-polyfill/browser.js`

## Companion files (`docs/research/labs/w2b-04-verify-probes/`)

| File | Used for | Result file in `results/` |
|---|---|---|
| `ws-failure-matrix.mjs` | claim 1: 16 failure classes, `WebSocketStream`, Chromium and WebKit | `claim1-ws-failure-matrix-chromium.txt`, `...-webkit.txt` |
| `pw-ws-reason.mjs` | claim 1: what a Playwright harness can read | `claim1-playwright-harness-reasons.txt` |
| `proto-hooks-after.mjs` | claim 2: constructor wrappers vs prototype hooks, after/before import | `claim2-prototype-hooks.txt`; the original PoC re-run is `claim2-poc-rerun.txt` |
| `gh-sched-delay.py` | claim 3: real schedule-run lateness and coverage | `claim3-gh-schedule-delay.txt` |
| `iframe-vitals.mjs` | claim 4: top-frame observers vs iframe content | `claim4-iframe-vitals.txt` |
| `miner-core.js`, `pow-bench-node.mjs`, `pow-bench-browser.mjs`, `ecdsa-cost.mjs` | claim 5: mint cost, fresh-key cost | `claim5-pow-bench-node.txt`, `claim5-pow-bench-browser.txt`, `claim5-ecdsa-cost.txt` |

Run any `.mjs` with Node >= 22 from the repo (for example `~/.local/share/node/current/bin/node docs/research/labs/w2b-04-verify-probes/proto-hooks-after.mjs`); `ws-failure-matrix.mjs` needs `openssl` on PATH for its throw-away certificate. Timings are single-machine (MacBook Air, Apple M3, 8 cores, macOS 27.0) and vary run to run; the verdicts do not depend on a single millisecond value.
