# Release gate results

> [!WARNING]
> **Mostly not yet run.** No row below has been tested on a phone, in Safari or Edge, or on a real host. The desktop parts
> of G11, G12, G13, G14, G19 and G-CH-8 ran on 2026-10-22 and 2026-10-23 in a Brave browser on a Mac, over loopback
> only, and each row records what that run covered and what is still not run. Until every row passes,
> felinar is not called production-ready ([ARCHITECTURE.md](ARCHITECTURE.md), section 12; design review item 25
> in [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md)). Passing this gate is what 1.0 means
> ([ROADMAP.md](ROADMAP.md)).

The automated suites run on one development machine, in Playwright Chromium, WebKit and (since 2026-10-22) Firefox, over loopback
([INTEGRATION-STATUS.md](INTEGRATION-STATUS.md)). This gate covers what they can't: real phones, Firefox, Safari,
Brave and Edge, real networks, a real domain, and the drills. Results from anyone are welcome: open a pull request
that fills in a row, or an issue labelled `release-gate` ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## Results

| Row | What | Device and browser | Result | Date | Versions | Measured | Issue |
|---|---|---|---|---|---|---|---|
| G1 | A real domain with a `_magnet` TXT record | any desktop browser | not yet run | | | | |
| G2 | Load, share, post, background, offline | iPhone, iOS 18.x, Safari | not yet run | | | | |
| G3 | The same on an older iOS | iPhone, iOS 16 or 17, Safari | not yet run | | | | |
| G4 | Load and post on mobile data | Android phone on LTE, Chrome | not yet run | | | | |
| G5 | Load, share, post, offline | Android phone, Samsung Internet | not yet run | | | | |
| G6 | First visit, share, post, worker restarts | desktop Firefox, normal window | not yet run | 2026-10-22 (harness only) | Firefox 157.0 (Playwright build firefox-1555); headless, Playwright, loopback only | Harness only, not this row: F7 (W7 in Firefox) cold start from the web seed with consent pending rendered in 719 ms with the Service Worker in control. Steps 2 to 4 (post seen by another browser, idle worker restarts, offline reload) were not exercised in Firefox ([deviations/firefox.md](deviations/firefox.md)) | |
| G7 | First visit in private browsing | desktop Firefox, private window | not yet run | 2026-10-22 (harness only) | Firefox 157.0 (Playwright build firefox-1555); headless, Playwright, loopback only | Not exercised. The harness opens new Playwright browser contexts, and a new context is not Firefox's private-browsing mode, so the harness says nothing about a private window ([deviations/firefox.md](deviations/firefox.md)) | |
| G8 | Blocking extensions | desktop Brave, Shields aggressive | not yet run | | | | |
| G9 | Sleeping tabs | desktop Edge | not yet run | | | | |
| G10 | Connect rate, both directions | phone on LTE and laptop on home Wi-Fi | not yet run | | | | |
| G11 | Cold start from the web seed, nobody online | desktop and phone | partial | 2026-10-22 | Brave (Chromium), macOS, loopback, loader 0.3.0 build bf9857a88b6f | Desktop part, loopback, not broadband: the demo with `--seeder none`, no pin node and no other visitor; Brave's first visit rendered from the web seed (`source: "webseed"`, 0 peers, "0 B from peers, 103.5 KB from the web seed"); loader start to seeding 0.15 s, first contentful paint 0.12 s after navigation start (performance API). Broadband and phone: not yet run | |
| G12 | Update flow | any | pass | 2026-10-22 | Brave (Chromium), macOS, loopback, loader 0.3.0 build bf9857a88b6f | Desktop, loopback: deploy started 16:36:37 ET (new heading, higher seq, same key and ledger); "Update available: reload" by 16:36:52, within 4 s of the focus (a dispatched focus and visibilitychange event, not a window switch) and about 15 s after the deploy started, bounded by when focus was given; after the reload the new version rendered and `mw-sites` held one version (sites 1, files 16, pointers 1) | |
| G13 | Key-change prompt and silent rotation | any | pass | 2026-10-23 | Brave (Chromium), macOS, loopback, loader 0.3.0 build bf9857a88b6f | Scope 127.0.0.1, a fresh scope: the prompt showed both fingerprints (remembered 51f6b736, new 778ea4db); "Keep the remembered key" kept version 1 with "You kept the remembered publisher key, so the new pointer was not used."; with a third key (3f338331, `rot=` signed by K2) the prompt came again and "Confirm new key" mounted that version within 6 s, with the banner "pointer and ledger owner differ"; a version signed with `--prev-key` (the remembered key) showed no prompt, only "Update available: reload", and mounted on reload. Observations: (a) a returning visitor sees the prompt only on the reload after a focus-time shell check, never on the first reload after the change, because the worker serves the precached shell; (b) a refusal is kept per key with no expiry (`keyRefused` preference), so step 4 as written (reload and confirm the same key) cannot be run, and a visitor who kept the old key needs "Forget this site" to accept that key later | |
| G14 | Kill switch drill (time to recovery) | Chromium, Firefox, Safari, iOS Safari, Android Chrome | partial | 2026-10-22 | Brave (Chromium), macOS, loopback, loader 0.3.0 build bf9857a88b6f | Chromium (Brave), loopback, no CDN to purge: kill deployed 16:37:45.3 ET; after 1 navigation, about 5 s, 0 Service Worker registrations, no controller, the plain page rendered; restore deployed 16:38:15.0 ET; after 1 navigation, about 5 s, 1 registration, controlled, the loader mounted from its saved copy (`source: "cache"`: the kill switch left IndexedDB alone). Chromium part: pass. Firefox, Safari, iOS Safari and Android Chrome: not yet run | |
| G15 | The drop-in fixture on a real host | desktop Chromium, Firefox, Safari, one phone | not yet run | | | | |
| G16 | 7-day persistence | iOS Safari, and a Home Screen app | not yet run | | | | |
| G17 | Phone viewport (no viewport meta, a fixed width, `device-width`) | iOS Safari, Android Chrome | not yet run | | | | checked in Chromium phone emulation only (E2E `VIEWPORT`) |
| G18 | Input focus does not zoom the page | iOS Safari | not yet run | | | | |
| G19 | Takedown drill (time from notice to effect) | any desktop browser, the drop-in fixture | partial | 2026-10-22 | Brave (Chromium), macOS, loopback, loader 0.3.0 build bf9857a88b6f | Shell part, pass: T0 none (a drill, no notice sent); T1 16:39:28.9 ET (withdrawal live, `--scope localhost`); T2 16:39:51 ET: the card "This content is no longer available here." with the reason and the contact, `withdrawn` set, `mw-sites` sites 0 and files 0 (pointers 1, the withdrawal record); T2 minus T1 about 22 s, 17 s of it waiting for focus. Restore (higher seq): the first navigation still showed the card while the restarted dev server was not answering; the next loaded the republished version. T3 (drop-in): not yet run, no drop-in fixture in this stack | |
| G20 | Posting fee at 16 bits on phones | a mid-range Android phone, an iPhone | not yet run | | | | |
| G21 | Drop-in second page view served from the copy | Safari on macOS and iOS | not yet run | | | | |
| G22 | Posting identity survives reloads on iOS | iPhone, Safari and a Home Screen app | not yet run | | | | |

G1 to G18 are the gate as ARCHITECTURE section 12 lists it, plus the two phone checks from code review round 1.
G19 to G22 are the drills and open items that also wait for real devices (ARCHITECTURE section 14,
[OPERATIONS.md](OPERATIONS.md), [ROADMAP.md](ROADMAP.md)).

The v0.3 rows (G-ID, G-SI, G-CH, G-MD, G-SC and G-SO) are in their own table near the end of this page. The v0.3 C2 rows (G-PS, G-ZS and G-CL, proposed) follow them.

## How to record a result

- **Result:** `pass`, `fail` or `partial` (say what failed in the issue), or leave `not yet run`.
- **Date:** the day you ran it, `YYYY-MM-DD`.
- **Versions:** the loader version (Settings shows "Loader 0.3.0"), the browser and its version, the operating
  system, the device model, and the network (Wi-Fi, LTE, carrier).
- **Measured:** the numbers the row asks for, with units.
- **Issue:** a link for every failure, labelled `release-gate` (and `needs-device` while it waits for one).

Evidence to attach to the issue or the pull request: the text of Settings, Diagnostics (a shell page; a drop-in
page has no such list, so copy its console warnings instead); the JSON of
`window.__mwShell.inspect()` (shell) or `window.__mwDropin.inspect()` (drop-in), read in the browser console or
over remote debugging (Safari's Web Inspector for iOS, `chrome://inspect` for Android); screenshots or a screen
recording.

**Timing.** Unless a row says otherwise, record the screen at 60 frames a second and count from the frame where
you submit the URL (or tap) to the first frame that shows the result. Give seconds with one decimal and say how
you measured.

## Setup for every row

You need a domain you control, HTTPS hosting as [DEPLOY.md](DEPLOY.md) describes, and a key used only for the gate.

```sh
npx felinar keygen --out ~/keys/gate.jwk
npx felinar build
# shell-mode staging site: the example guestbook with open writing
npx felinar publish examples/peer-guestbook --name peer-guestbook --scope gate.example.com --key ~/keys/gate.jwk \
  --policy open --bits 16 --ws https://gate.example.com/ws/ --tr wss://rtc.example.com \
  --tr wss://tracker.webtorrent.dev --tr wss://tracker.openwebtorrent.com \
  --cs https://gate.example.com/ws/genesis.json --ct mailto:abuse@example.com --shell --out gate-shell
# drop-in staging site: the fixture of an existing site
npx felinar publish examples/existing-site-dropin --name dropin-fixture --scope dropin.example.com \
  --key ~/keys/gate.jwk --tr wss://rtc.example.com --tr wss://tracker.webtorrent.dev \
  --ct mailto:abuse@example.com --dropin --out gate-dropin
```

Deploy both in the order of [DEPLOY.md](DEPLOY.md#deploy-order), allow both `summary.json` files on your tracker,
and check them from outside:

```sh
npx felinar check-site https://gate.example.com/
npx felinar check-site https://dropin.example.com/
```

Before each row, start from a clean state: clear the site's data in the browser (or use the fresh profile or
private window the row asks for). Rows that need another visitor online use a desktop browser that has opened the
site and chosen "Share and load", or a pin node:

```sh
npx felinar pin https://gate.example.com/ --headless
```

"The site" in a row means the shell site, `https://gate.example.com/`, unless the row names the drop-in fixture.

## Procedures

### G1. A real domain with a `_magnet` TXT record

1. Publish the record from `gate-shell/dns.txt` at your DNS provider ([DEPLOY.md](DEPLOY.md#the-dns-txt-record)).
2. Check it at an authoritative server, then over DNS-over-HTTPS:
   `dig +short TXT _magnet.gate.example.com @<name server>` and
   `curl -sS -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=_magnet.gate.example.com&type=TXT'`.
3. In a fresh desktop profile, open `https://gate.example.com/`, check that the first-run card names the
   DNS-over-HTTPS service ("If you choose to share, your browser also asks a DNS-over-HTTPS service ..."), and choose
   "Share and load". Keep the tab open.
4. Edit a file of the example site, publish again into `gate-shell`, upload the web seed files, and update **only**
   the TXT record (leave the deployed shell as it is). Note the time.
5. Wait, focusing the tab now and then. Note when "Update available: reload" appears, reload, and check that the new
   version renders.
6. Optional, a site found only through DNS: deploy the loader without a page tag (`dist/`) on a second hostname
   with its own record. A first visit shows the blocking card with the two sentences about DNS-over-HTTPS; after "Share
   and load" the status bar's badge reads "Pointer: DNS via Cloudflare, signed".

**Pass when** `check-site` reports a valid DNS pointer, the update arrives through DNS alone, and (optionally) the
DNS-only site loads after the card. **Record:** the resolver named in the badge, the minutes from the record change
to the banner, DNSSEC shown or not.

### G2. iPhone, iOS 18.x, Safari

1. Clear Safari's history and website data (Settings, Safari). Start a screen recording.
2. Open `https://gate.example.com/`. Note the time until the guestbook heading shows, and the source label.
3. Check that the first-run card appears before anything connects. Tap "Share and load". The status line should
   read "Sharing only while this page is open and on screen." or "On this phone: downloading only. Tap to share.";
   turn on "Share on this network" in Settings.
4. Post an entry. Note the time from tapping the button to the entry showing (the status line counts the posting
   fee's tries). A desktop visitor that is online should show the entry within 10 seconds.
5. Switch to another app for 2 minutes, come back, and note how long until the peer count is above 0 again
   (design review item 19 asks for 10 seconds).
6. Turn on Airplane Mode and reload: the site should render from the device ("From this device").
7. Turn on Lockdown Mode, exempting nothing, and open the site again. Note what you see: limited mode ("Limited
   mode: this browser has no offline engine"), "Host only, not sharing", or "Turn off Lockdown Mode for this
   website".

**Pass when** steps 2 to 6 work and step 7 degrades with a message instead of breaking. **Record:** time to visible,
time to post, seconds to peers after returning, the Lockdown Mode outcome.

### G3. iOS 16 or 17, Safari

Run G2. Also check that a fresh visit with no other visitor online shows the guestbook's existing entries: on iOS
before 16.4 the ledger snapshot is inflated by the loader's own gzip code, because the browser has no
`DecompressionStream` (code review round 1, F20). **Record** as for G2.

### G4. Android on LTE, Chrome

1. Turn Wi-Fi off and mobile data on. Clear the site's data.
2. Open the site. The status should read "On mobile data: downloading only. Tap to share."; over
   `chrome://inspect`, `__mwShell.inspect()` should show `policyClass: "mobileMetered"` and `uploads: false`.
3. Post an entry and check that a desktop visitor receives it.
4. Lock the screen for 1 minute, unlock, and note the seconds until the peer count is above 0.
5. Reload in airplane mode: the site renders from the device.

**Pass when** the site loads, nothing is uploaded until the visitor allows it, posts sync both ways and the client
recovers after the lock. **Record:** time to visible, the connectivity class, seconds to peers after unlocking.

### G5. Android, Samsung Internet

Run G4's steps 1 to 5 in Samsung Internet, on Wi-Fi and on mobile data. **Record** as for G4, with the Samsung
Internet version (its user agent also names a Chrome version; record the Samsung one).

### G6. Desktop Firefox, normal window

1. Start Firefox with a fresh profile and open the site. Note the time to visible and whether the page reloads
   once by itself (shell mode reloads once if the Service Worker doesn't control the first visit).
2. Choose "Share and load", post an entry, and check that another browser receives it.
3. Leave the tab idle for 2 minutes (Firefox stops an idle Service Worker after about 60 seconds), then follow a
   link inside the site. Repeat five times. Every navigation should be answered; a "Still loading" page must
   never appear for a site that is already stored.
4. Go offline (disconnect the network) and reload: the site renders from the device.

**Pass when** all four steps work. **Record:** the Firefox version, the first-visit reload (yes or no), time to
visible.

### G7. Desktop Firefox, private window

1. Open a private window (Firefox 140 and later give private windows a Service Worker) and open the site.
2. Check that it renders in full mode, not limited mode, that the card appears, and that "First time on this
   device: the publisher key of this site is remembered from now on." is shown.
3. Close every private window, open a new one, and open the site again: nothing should be remembered.

**Pass when** the site works in full mode and nothing survives the private session. **Record:** what was
remembered, if anything.

### G8. Desktop Brave, Shields aggressive

1. In Brave's Shields settings choose "Aggressive" for trackers and ads and "Strict" for fingerprinting. Clear the
   site's data.
2. Open the site and choose "Share and load". Note whether the trackers connect (Settings, Diagnostics: "Connection
   servers unreachable"), whether peers connect, and whether the site loads from the web seed.
3. Post an entry and check whether another browser receives it.

**Pass when** the site loads (from the web seed if nothing else) and the diagnostics name what Shields blocked.
**Record:** which of trackers, peers, web seed and posting worked.

### G9. Desktop Edge, sleeping tabs

1. In Edge, turn on sleeping tabs with the shortest delay offered. Open the site and choose "Share and load".
2. Switch to another tab until the site's tab goes to sleep. Meanwhile, post an entry from another browser.
3. Return to the tab. Note the seconds until peers are back and the new entry shows.

**Pass when** the tab wakes into a working page and catches up with the ledger. **Record:** the delay setting,
seconds to peers, seconds to the new entry.

### G10. Connect rate between a phone on LTE and a laptop on home Wi-Fi

1. The laptop is on home Wi-Fi; the phone is on mobile data with "Share on this network" turned on for the site.
   Stop the pin node and other visitors, so the two can only meet each other.
2. Direction A: the laptop opens the site and shares; then the phone opens it (site data cleared). Count a success
   when the phone shows at least one peer within 20 seconds.
3. Direction B: the phone first, then the laptop.
4. Run 20 attempts in each direction, and read the connectivity class on each side from Settings, Diagnostics.

**Pass when** there is a recorded rate for both directions; there is no threshold yet. The research plans for 10%
to 30% of peer pairs needing a relay, which the site's swarms do not use in 0.3.0 (only a call can, through a relay the owner sets up) ([PRODUCTION-DIGEST](research/PRODUCTION-DIGEST.md),
verdict 4). **Record:** successes and attempts in each direction, both connectivity classes, the router and the
carrier.

### G11. Cold start from the web seed, nobody online

1. Stop the pin node and close every other visitor; `check-site` should report 0 seeders.
2. In a fresh desktop profile on broadband, open the site and time it to the guestbook heading. Read the source:
   "From the host", or `source: "webseed"` in `__mwShell.inspect()`.
3. Repeat on a phone on LTE.

**Pass when** the site renders from the web seed with nobody else online. **Record:** the seconds on each device
(the E2E run measured 162 ms over loopback, which says nothing about real networks).

### G12. Update flow

1. Visitor A opens the site and keeps the tab open.
2. Edit a file, publish again into `gate-shell`, and deploy in order (web seed, then the shell, then purge).
3. Focus A's tab. Note the time until "Update available: reload" appears.
4. Reload: the new version renders. In the browser's developer tools, the `mw-sites` database should hold one
   version of the site, not two.

**Pass when** the banner appears without a manual reload and the old version is gone after the reload.
**Record:** the seconds from the deploy to the banner.

### G13. Key-change prompt and silent rotation

Use a separate scope, for example `keytest.example.com`, because this row changes the owner key.

1. Publish and deploy version 1 with key K1, and open it in browser B.
2. Publish version 2 with a new key K2 and no `--prev-key` (`publish` warns that this starts a new, empty ledger)
   and deploy.
3. Focus the tab (or wait a minute), then reload B: "publisher key changed" must appear with both fingerprints. Choose "Keep the remembered key": version
   1 stays and the page says "You kept the remembered publisher key, so the new pointer was not used."
4. Choose "Forget this site" in Settings, reload, and choose "Confirm new key": version 2 renders. A kept key stays
   refused until "Forget this site".
5. Publish version 3 with key K3 and `--prev-key` K2, deploy, and reload B: version 3 renders with no prompt.

**Pass when** steps 3 to 5 behave as described. **Record:** screenshots of the prompt.

Steps 3 and 4 were changed after the run of 2026-10-23 (review round finding GATE-2): the prompt appears on the first
reload after a focus-time shell check, not on the first reload after the change (the worker serves the precached
shell), and "Keep the remembered key" is stored per key with no expiry, so the loader does not ask about K2 again. That
run confirmed with a third key instead (version 3 with K3, then reload); either way, step 5 uses the next key with
`--prev-key` set to the key you confirmed.

### G14. Kill switch drill

Follow [RUNBOOK.md section 11](RUNBOOK.md#11-kill-switch) on the staging host, in each browser in the row, each of
which has visited the site before:

1. Deploy the plain site with `mw-sw-kill.js` as `/mw-sw.js` and purge the CDN. Note the time.
2. In each browser, navigate to the site once and keep timing until the plain page renders and no Service Worker is
   registered for the origin (`chrome://serviceworker-internals`, `about:serviceworkers` in Firefox, the Develop
   menu in Safari).
3. Deploy the normal `/mw-sw.js` and the shell again, and check that the loader comes back.

**Pass when** every browser recovers. **Record:** seconds and navigations to recovery per browser (Chromium in the
E2E run: about 2.7 seconds over 2 navigations).

### G15. The drop-in fixture on a real host

Deploy `gate-dropin/site/` in order and run every check of `examples/existing-site-dropin/EXPECTED.md` against
`https://dropin.example.com/` in desktop Chromium, Firefox and Safari, and on one phone. **Pass when** every check
passes everywhere. **Record:** the checks that failed, per browser.

### G16. 7-day persistence on iOS

1. On an iPhone, in Safari (not private browsing), open the site, share and post an entry. Note your identity's
   short id (Settings, "Your identity on this site").
2. Add the site to the Home Screen and open it from there: it starts empty. Export your identity in Safari and
   import it in the Home Screen app (Settings, "Export identity" and "Import identity").
3. For 8 days, use Safari as usual on other sites but don't open this one, in Safari or from the Home Screen.
4. Open the site in Safari, then from the Home Screen. Check whether each still has the site's copy (it renders in
   Airplane Mode) and the same identity short id.

**Pass when** the outcome is recorded and matches the documented behaviour: Safari may have deleted its copy and
identity, and the Home Screen app keeps its own. **Record:** what survived in each place.

### G17. Phone viewport

1. Publish a small test site with three pages: one without a viewport meta tag, one with
   `<meta name="viewport" content="width=1024">`, and one with
   `<meta name="viewport" content="width=device-width, initial-scale=1">`.
2. Open each page on the phone through the loader and again served as a plain static site. Over remote debugging,
   read `document.documentElement.clientWidth` inside the site's frame.

**Pass when** each page lays out at the same width as on the plain host (980, 1024 and the device's width in the
E2E run). **Record:** the three widths through the loader and on the plain host.

### G18. Input focus does not zoom the page

On an iPhone, open the site, open Settings and tap the passphrase field under "Export identity". **Pass when** the
page doesn't zoom in. **Record:** a screenshot.

### G19. Takedown drill

1. Send a test notice to the contact in your pointer. Note the time (T0).
2. Publish a withdrawal for both staging sites (`npx felinar publish --withdraw ...`) and deploy it everywhere
   each pointer lives ([DEPLOY.md](DEPLOY.md#takedown)). Note the time it is live (T1).
3. A desktop visitor who has the shell site open focuses the tab. Note when "This content is no longer available
   here." appears (T2) and check that `__mwShell.inspect().withdrawn` is set and no version is left in `mw-sites`.
4. A drop-in visitor loads another page of the fixture. Note when the console line about the withdrawal appears
   (T3).
5. Restore the site by publishing a normal version, with a higher `seq`.

**Pass when** T2 minus T0 is under 60 minutes (the target for the worst notices; 2 business days for copyright-class
notices, as in [OPERATIONS.md](OPERATIONS.md#the-notice-and-action-runbook): the DMCA says "expeditiously" and sets no
number of hours). A hub also sends the test notice of step 1 to its registered DMCA agent's address, because only a
notice sent to the designated agent counts under 17 U.S.C. 512(c)(3). **Record:** T0 to T3.

### G20. Posting fee at 16 bits on phones

On a mid-range Android phone (Chrome) and an iPhone (Safari), post 5 entries on the guestbook and time each from the
tap to the entry showing. The status line shows "Posting: working out the spam fee for this post (N tries so
far)" meanwhile. **Pass when** the times are recorded; the 16-bit default stands or falls on them ([ROADMAP.md](ROADMAP.md)).
**Record:** median and maximum seconds, the device models.

### G21. Drop-in second page view on Safari

On Safari for macOS and on iOS, open a page of the drop-in fixture, wait for the copy to complete (a few seconds
at idle, on Wi-Fi), then open a second page. In Web Inspector's Network tab, the second page's stylesheet and
scripts should come from the Service Worker. **Pass when** they do; the worker falls back to mapping the page by
its URL where Safari gives no `resultingClientId` (ARCHITECTURE 3.4.2), so either path passes. **Record:**
screenshots of the Network tab.

### G22. The posting identity survives reloads on iOS

On an iPhone, in Safari and in a Home Screen app: open the site, post an entry, reload, post again, close Safari
completely, open it and post a third time. **Pass when** the identity's short id (Settings) is the same throughout
and every post succeeds. The loader stores the key as a JSON Web Key when the browser can't store the key object
itself (ARCHITECTURE 6.1). **Record:** the short id at each step.

## v0.3: rows to add

> **Status: v0.3, built and reviewed.** These are the real-device rows that the v0.3 design review adds
> ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md), 4.3, with the scale rows from the scale judge's section 4).
> Every one is **not yet run**, except the Chromium part of G-CH-8, measured in a Brave browser on loopback on 2026-10-22. The
> features they test are built and pass on loopback only. A row never passes from emulation or from the automated harness,
> and an agent may not reach a public network ([DEV-NETWORK.md](DEV-NETWORK.md)). Owner steps for the rows
> are in [PUBLISH-CHECKLIST.md](PUBLISH-CHECKLIST.md), section 16. For a release that includes v0.3, these rows belong to
> the gate above (R 2.19). Since 2026-10-22 the automated harness runs Firefox 157.0 (Playwright build firefox-1555) on loopback
> ([deviations/firefox.md](deviations/firefox.md)); a Firefox cell records those harness facts, and it still never says
> "pass" from the harness.

How to record a result is the same as above ("How to record a result"). The review gives no pass thresholds for these
rows, and none is invented here: record the numbers and the outcomes listed in the second table, and a row passes when
the claim it tests is confirmed or the document that states the claim is corrected. Where the review chose a target
number (for example 5 s for G-SC-1, "chosen"), record against it.

| Row | What | Device and browser | Result | Date | Versions | Measured | Issue |
|---|---|---|---|---|---|---|---|
| G-ID-1 | Sign in through the identity page, close, reopen after 1 hour and after 8 days, with and without Home Screen; escrow rescue after Safari deletes the identity page's data | iPhone, iOS 18.x Safari and a Home Screen app | not yet run | | | | |
| G-ID-2 | Passkey PRF round trip at the identity page | Android Chrome with Google Password Manager | not yet run | | | | |
| G-ID-3 | Two-device PRF equality | iCloud Keychain, Google Password Manager, Windows Hello, 1Password | not yet run | | | | |
| G-ID-3b | `largeBlob` support and sync | iCloud Keychain, Google Password Manager, Windows Hello, 1Password | not yet run | | | | |
| G-ID-4 | Full flow, in a normal window and a private window | desktop Firefox | not yet run | 2026-10-22 (harness only) | Firefox 157.0 (Playwright build firefox-1555); headless, Playwright, loopback only | Harness only, in a normal context: F:E-SI-1W signed in through the real identity origin; F:E-ID-5, F:E-ID-6, F:E-ID-7 and F:E-ID-10 passed. The passphrase sign-in with "Stay signed in" and the sign-out (F:E-ID-2, F:E-ID-2B) did not run (a harness timeout, [deviations/firefox.md](deviations/firefox.md)); no restore; no private window (a new context is not private browsing) | |
| G-ID-5 | Device link by QR, phone to laptop; decoder bundle size; camera-denied path | phone and laptop | not yet run | | | | |
| G-ID-6 | Argon2id time; PBKDF2 time | low-end Android; iOS 15.4 | not yet run | | | | |
| G-ID-7 | Popup and opener behaviour, redirect fallback | iOS Safari, Android Chrome, two in-app browsers | not yet run | | | | |
| G-ID-8 | Sign-in at the floor with every fallback | Safari and iOS 15.4, Chromium 110, Firefox 115 | not yet run | | | | |
| G-ID-9 | Comprehension test with 5 to 8 people of the sign-in, recovery-kit, restore, link and same-identity cards (P0) | any | not yet run | | | | |
| G-SI-1 | Server sign-in against a verifier on a real host | any desktop browser | not yet run | | | | |
| G-CH-1 | Direct-message delivery rate over 50 attempts, connect failures counted | phone on LTE and laptop on home Wi-Fi | not yet run | | | | |
| G-CH-2 | An open conversation after 10 s, 60 s and 5 min in the background | iPhone | not yet run | | | | |
| G-CH-3 | How often two members are online together on a hosted site, over a week | a staging site | not yet run | | | | |
| G-CH-4 | A 25 MiB file from Android to iPhone with the per-upload card | Android, iPhone | not yet run | | | | |
| G-CH-5 | TURN relay only, both directions | any | not yet run | | | | |
| G-CH-6 | Stamp time at 10 and 20 bits | low-end Android, iPhone, desktop | not yet run | | | | |
| G-CH-7 | Presence: radio-active time and battery over 30 minutes | Android, iPhone | not yet run | | | | |
| G-CH-8 | WebRTC candidates exposed (mDNS host candidates, IPv6) | Chromium, WebKit, Firefox | partial | 2026-10-22 | Brave (Chromium), macOS, loopback, loader 0.3.0 build bf9857a88b6f | Chromium part, the owner's Brave profile: an in-page `RTCPeerConnection` with no ICE servers and a data channel, 8 s: gathering "complete", 0 candidates in the events and in the SDP (no host, no mDNS `.local`, no IPv6). Nothing is exposed, and no peer connection can form in that profile, so sharing cannot work there. Whether the loader tells the visitor so is unverified (run with G8). WebKit and Firefox parts: not yet run | |
| G-MD-1 | A 20 MB MP4: time to first frame, five seeks and their latency | desktop Chrome, Firefox, Safari | not yet run | Firefox: 2026-10-22 (harness only) | Firefox: Firefox 157.0 (Playwright build firefox-1555); headless, Playwright, loopback only | Firefox only, harness, not this row: the 20 MiB reference MP4 over loopback (F-MD), first frame 40 ms, three seeks (to 8.5 s, 3 s and 6 s) in 25, 92 and 96 ms, answered 206 by the worker route. Five seeks and a real network were not exercised ([deviations/firefox.md](deviations/firefox.md)) | |
| G-MD-2 | The worker media route with streamed `206`: playback and seeking | iPhone, iOS 18.x Safari | not yet run | | | | |
| G-MD-3 | The same in a Home Screen app | iPhone | not yet run | | | | |
| G-MD-4 | Seek latency from a phone seeder at 128 KiB/s and from a desktop seeder | phone, desktop | not yet run | | | | |
| G-MD-5 | IndexedDB chunk store memory and time at 25 MiB on a phone and 100 MiB on a desktop | mid-range Android, iPhone, desktop | not yet run | | | | |
| G-MD-6 | `CryptoKey` structured clone into the worker | Safari and iOS 15.4, Chromium 110, Firefox 115 | not yet run | | | | |
| G-MD-7 | iPhone HEVC video on other devices: `canPlayType` and the "Download instead" path | Android Chrome, desktop Chrome and Firefox | not yet run | | | | |
| G-MD-8 | Metadata removal on real photos and videos (iPhone HEIC and MOV, Android JPEG and MP4), checked with a desktop metadata tool | iPhone, Android | not yet run | | | | |
| G-SC-1 | First-open sync for 250 follows (the follow cap; renamed from 200) | low-end Android and an iPhone, on LTE and Wi-Fi | not yet run | | | | |
| G-SC-2 | Swarms and peer connections per tab | a browser per class | not yet run | | | | |
| G-SC-3 | Battery of a live feed | Android and iPhone | not yet run | | | | |
| G-SC-4 | Durability without pins | a staging hub with real members, 14 days | not yet run | | | | |
| G-SC-5 | Tracker load per hub | the `deploy/` tracker with replayed tabs | not yet run | | | | |
| G-SC-6 | Directory size and squatting cost | a phone | not yet run | | | | |
| G-SC-7 | Holder opt-in and offline delivery | a staging site, a week | not yet run | | | | |
| G-SC-8 | Proof-of-work fees on phones | low-end Android and an iPhone | not yet run | | | | |
| G-SC-9 | Reducer and IndexedDB at 200 ledgers | phones | not yet run | | | | |
| G-SC-10 | A popular wall at the cap | desktop and phone | not yet run | | | | |
| G-SC-11 | A hub's monthly bill | a staging hub with 1,000 members, a month | not yet run | | | | |
| G-SO-3 | Re-encoded image sizes from real phone photos | iPhone, Android | not yet run | | | | |
| G-SO-4 | Screen reader pass over the social example | VoiceOver on iOS, TalkBack on Android, NVDA on desktop | not yet run | 2026-10-22 (harness only) | axe-core 4.14.0, Playwright Chromium 156.0.8078.4, headless, loopback only | Harness only, not this row: E-SO-12 ran axe-core (wcag2a, wcag2aa, best-practice) on 28 social screens with 0 violations, and a keyboard-only post and follow passed ([deviations/a11y.md](deviations/a11y.md)); no screen reader was used | |
| G-SO-5 | The social example inside the shell in landscape (`viewport-fit=cover` copied to the top page): the toasts, their "Open the page" link and the skip link clear the sensor housing (v0.3 code review) | iPhone with a notch or Dynamic Island, Safari; an Android phone with a cutout, Chrome | not yet run | | | | |

G-ID-3 and G-ID-3b are two rows (the review lists them together). The scale rows are the ones of the scale judge's
section 4; the review renames G-SC-1 to the cap of 250 follows. Row G-SC-9 and G-SC-1 confirm or lower that cap
(R 3.2.3). R 2.8.8 names a row "G-FI-5" for the chunk store that R 4.3 does not list; it is read here as G-MD-5.

### What to record in each v0.3 row

| Row | What to record |
|---|---|
| G-ID-1 | whether the person is still signed in or gets back in with one tap at each point; whether the escrow copy rescued the identity after deletion |
| G-ID-2 | whether `create()` returned a PRF output; whether a later `get()` unwrapped the root |
| G-ID-3 | whether the PRF output is equal on two devices of one provider |
| G-ID-3b | whether `largeBlob` is supported and syncs between devices |
| G-ID-4 | each step of sign-in, post, sign out, restore; what the private window kept |
| G-ID-5 | whether the 6-digit code matched, the bytes of the QR decoder bundle (gzip), what the camera-denied path showed |
| G-ID-6 | seconds for each, with the device model |
| G-ID-7 | whether the popup opened, whether the opener kept its link, whether the redirect round trip signed in |
| G-ID-8 | which fallback each floor browser used and whether sign-in completed |
| G-ID-9 | for each card, how many people said correctly what it does; the wording changes that follow |
| G-SI-1 | whether sign-in, replay refusal and expiry worked against a Node server on a real host |
| G-CH-1 | delivered, handed over, failed to connect, out of 50 |
| G-CH-2 | whether the conversation kept working at each interval |
| G-CH-3 | how often two members were online together, over the week |
| G-CH-4 | whether it arrived, how long, what the card said |
| G-CH-5 | whether a relayed channel worked each way |
| G-CH-6 | seconds to mint at each setting, per device |
| G-CH-7 | battery drop and radio-active time |
| G-CH-8 | the candidate types each browser exposed |
| G-MD-1 | seconds to first frame and per seek |
| G-MD-2 | whether playback and seeking worked through the worker |
| G-MD-3 | as G-MD-2 |
| G-MD-4 | seconds per seek from each seeder |
| G-MD-5 | peak memory and seconds at each size |
| G-MD-6 | whether the clone worked or the raw-bytes path was used |
| G-MD-7 | the `canPlayType` answer and what the page showed |
| G-MD-8 | which metadata fields survived in each file type |
| G-SC-1 | time to the first merged screen (target 5 s on a mid-range phone on LTE from hub snapshots, chosen), time to full sync, peak memory and CPU |
| G-SC-2 | the ceiling and the error when the swarm count and wires per swarm are raised until failure |
| G-SC-3 | battery drop and radio-active time over 30 minutes: live follow, then pull and disconnect, then host-only |
| G-SC-4 | the share of ledger and media fetches that succeed without a pin, by content age, against the model in the scale judge's 2.4 |
| G-SC-5 | CPU, memory per peer entry and egress with and without the count-aware policy |
| G-SC-6 | bytes and time to resolve a name from a sharded static index; time per registration at 16 bits |
| G-SC-7 | the opt-in rate and the delivery success rate (extends G-CH-3) |
| G-SC-8 | time at 16 and 20 bits (extends G-CH-6) |
| G-SC-9 | time and memory of the reducer over 200,000 blocks across 200 databases; the reducer at 50,000 blocks is unmeasured |
| G-SC-10 | behaviour at 8 MiB and 64 MiB with 100,000 synthetic reactions, and the download time for a new follower |
| G-SC-11 | the actual shell, tracker, pin and egress costs against the model of 2.7 |
| G-SO-3 | bytes before and after re-encoding |
| G-SO-4 | what each screen reader could and could not do |
| G-SO-5 | whether each engine passed the page's safe-area insets into the loader's frame, and a screenshot of a toast and of the focused skip link in landscape |

## v0.3 C2: rows to add

> **Status: v0.3 C2, built and reviewed; none of these rows has run.** The C2 code was integrated on 2026-10-20 and passed its loopback
> tests only. These are the real-device rows that phase C2 adds for smart phone seeding (S1 D8), the
> zero-setup ladder (S2 Rc6) and peer-to-peer calls (SZ 3.5), from
> [research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ"). Every one is **not yet run**. No agent
> runs a row, and an agent may not reach a public network ([DEV-NETWORK.md](DEV-NETWORK.md)). For a release that includes C2 these rows belong to
> the gate above. **Rows G-PS-1 to G-PS-4 and G-CL-2 run on one iPhone and one Android phone before any card or document says what phones do in
> the background**, and nothing is quoted before its row has run; failures are published too.

Phone rows need HTTPS: the demo's `--tls` tier with the mkcert root on the phone ([DEPLOY.md](DEPLOY.md), "HTTPS and phone demos"), and a peer on
the LAN that logs when each wire closes (S1 D8 calls it a Node pin-light; `tools/seed.mjs` seeds a published site from Node when the optional
`node-datachannel` is installed). Rows G-ZS1 to G-ZS4 need a rented server or a free host account that the owner provides. How to record a
result is the same as above. The design gives no pass thresholds for these rows and none is invented here: record the numbers listed in the
second table, and a row passes when the claim it tests is confirmed or the document that states the claim is corrected. Where the design chose a
target (5 MiB reaches "Kept by the site" in under 60 s median on Wi-Fi, chosen, for G-PS-8), record against it.

| Row | What | Device and browser | Result | Date | Versions | Measured | Issue |
|---|---|---|---|---|---|---|---|
| G-PS-1 | iOS Safari tab: seconds from lock to the last wire close (5, 10, 20 and 60 s) | iPhone, iOS 26 and 27 | not yet run | | | | |
| G-PS-2 | The same in a Home Screen app | iPhone | not yet run | | | | |
| G-PS-3 | Android Chrome tab, screen off, unplugged and plugged (1 to 60 minutes) | two Android phones, one Samsung | not yet run | | | | |
| G-PS-4 | The same in an installed web app | Android | not yet run | | | | |
| G-PS-5 | Dock mode for 2 hours: Wake Lock held, wires alive, battery, temperature, bytes | iPhone (tab and Home Screen app), Android | not yet run | | | | |
| G-PS-6 | 30 minutes on Wi-Fi and on LTE at 0 wires and at 8 idle wires, at 128 and 512 KiB/s (Battery Historian; the iOS energy log) | iPhone, Android | not yet run | | | | |
| G-PS-7 | Data per hour of idle wires on LTE | iPhone, Android | not yet run | | | | |
| G-PS-8 | Hand-off of 5 and 25 MiB, Wi-Fi and LTE, 50 attempts, with and without super-seeding, the page hidden at +10 s | iPhone, Android | not yet run | | | | |
| G-PS-9 | Label accuracy against synthetic swarms with known holders and liars, 8 wires | a phone, Node peers | not yet run | | | | |
| G-PS-10 | Echo lane for 14 days on a staging site: copies over time, bytes per added copy | a staging site | not yet run | | | | |
| G-PS-11 | Candidate pair types on a LAN, a hotspot, a VPN and an IPv6-only network | Safari, Chrome, Firefox | not yet run | | | | |
| G-PS-12 | Pin node (`tools/pin.mjs`) for 14 days: uptime, recovery after sleep and wake, CPU, RAM | a Mac or a Windows laptop | not yet run | | | | |
| G-PS-13 | Pieces still kept after 8 days, Safari tab against Home Screen app (extends G16) | iPhone | not yet run | | | | |
| G-PS-14 | Comprehension of each availability label by 5 to 8 people (as G-ID-9) | any | not yet run | | | | |
| G-ZS1 | A real server with a nip.io name: `ship` on the Caddy staging authority, then production, and one renewal | a rented server | not yet run | | | | |
| G-ZS2 | iOS Safari and Android Chrome load the site of G-ZS1 | iPhone, Android phone | not yet run | | | | |
| G-ZS3 | A returning visitor opens the site with DNS failing | any desktop browser, one phone | not yet run | | | | |
| G-ZS4 | GitHub Pages end to end with `check-site` | any desktop browser | not yet run | | | | |
| G-CL-1 | 1:1 audio, a phone on LTE to a laptop on Wi-Fi, 50 attempts: connect rate without a relay, time to connect | phone on LTE and laptop on home Wi-Fi | not yet run | | | | |
| G-CL-2 | iPhone Safari tab and Home Screen app: audio and video after 5 s, 30 s and 2 minutes hidden, on lock, during a phone call, and recovery | iPhone, iOS 26 and 27 | not yet run | | | | |
| G-CL-3 | Android tab and installed app, screen off, plugged and unplugged | Android phones | not yet run | | | | |
| G-CL-4 | Desktop mesh, 4 with video and 6 audio only: CPU, uplink, loss, jitter | desktops | not yet run | | | | |
| G-CL-5 | The same with two phones: battery, temperature | two phones | not yet run | | | | |
| G-CL-6 | Screen share from desktops and from iOS 27 Safari | desktops, iPhone on iOS 27 | not yet run | | | | |
| G-CL-7 | The share of pairs that need the relay, and relayed bytes a minute | with an owner relay | not yet run | | | | |
| G-CL-8 | 1 Mbit/s at 5% loss, and a Wi-Fi to LTE handover: time to recover audio | phone and laptop | not yet run | | | | |
| G-CL-9 | Comprehension of the call cards by 5 to 8 people | any | not yet run | | | | |

Doors ([research/v03/S4-doors.md](research/v03/S4-doors.md), ARCHITECTURE 15.15; the doors lane's rows, none run):

| Row | What to try | What to record |
|---|---|---|
| G-DR-1 | iOS: add a door page to the Home Screen, open it once online, then open it in airplane mode | whether the cached door page and a stored copy render; storage after 7 days without use |
| G-DR-2 | Android Chrome: install the door app (WebAPK), open it offline; tap an https light link to the door | whether it opens in the app; whether the SVG icon minted a WebAPK |
| G-DR-3 | Desktop Chrome or Edge: install the door app, click a `web+felinar:` link | the permission dialog's text; that the gate shows before anything loads |
| G-DR-4 | A phone: open a door page from `file:` and as a `data:` URL | whether anything runs (S4 F9 measured desktop engines only) |

### What to record in each C2 row

| Row | What to record |
|---|---|
| G-PS-1 | seconds from lock to the last wire close at each interval, per iOS version |
| G-PS-2 | as G-PS-1, in the Home Screen app |
| G-PS-3 | whether the wires stayed open and for how long, plugged and unplugged, over 1 to 60 minutes |
| G-PS-4 | as G-PS-3, in the installed web app |
| G-PS-5 | whether the Wake Lock held for 2 hours, whether the wires stayed alive, battery drop, temperature, bytes sent |
| G-PS-6 | battery drop and radio-active time over the 30 minutes, for each setting |
| G-PS-7 | megabytes an hour of idle wires on LTE |
| G-PS-8 | seconds to "Kept by the site" for 5 and 25 MiB, the success rate over 50 attempts, bytes uploaded before the first complete copy, with and without super-seeding |
| G-PS-9 | the label shown against the truth for each synthetic swarm, and whether a liar ever made a label read "Kept by the site" |
| G-PS-10 | complete copies over time, and bytes uploaded per added copy |
| G-PS-11 | the candidate pair types each browser reported on each network |
| G-PS-12 | uptime, seconds to recover after sleep, CPU and RAM |
| G-PS-13 | the share of pieces still kept after 8 days, tab against Home Screen app |
| G-PS-14 | for each label, how many people said correctly what it means, and the wording changes that follow |
| G-ZS1 | whether `ship` finished; the certificate authority at each step; whether the staging certificate, the production certificate and one renewal succeeded; minutes from `ship` to a clean `check-site` |
| G-ZS2 | whether the site loaded on each phone, and the first thing the browser showed (any warning) |
| G-ZS3 | whether the returning visitor's page loaded from its saved copy with DNS failing, and what it showed |
| G-ZS4 | each step of QUICKSTART A3 and A4 on the host, and the output of `check-site` |
| G-CL-1 | connected without a relay, connected with one, failed, out of 50; seconds to connect (median and worst) |
| G-CL-2 | for each interval, whether audio and video continued, what the card said, and how the call recovered |
| G-CL-3 | whether the call survived with the screen off, plugged and unplugged, and for how long |
| G-CL-4 | CPU, uplink, loss and jitter for each participant count |
| G-CL-5 | battery drop and temperature over the call |
| G-CL-6 | whether screen share worked, and what the browser asked for |
| G-CL-7 | the share of pairs that needed the relay, and relayed bytes a minute |
| G-CL-8 | seconds to recover audio after each impairment |
| G-CL-9 | for each call card, how many people said correctly what it does and who sees their IP address, and the wording changes that follow |
