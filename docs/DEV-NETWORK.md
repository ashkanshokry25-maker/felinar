# Developer-machine network policy

Everything this repository runs locally (unit tests, Playwright end-to-end tests, the demo seeder,
research probes) must stay on `127.0.0.1`. Two reasons: tests must be deterministic without the
internet, and on a machine with an outbound firewall (LuLu, Little Snitch) every remote connection from
a test browser raises an alert per process and per destination. On 2026-10-17 research probes that
drove Playwright Chromium and WebKit at public trackers, DoH endpoints and a deliberately unreachable
address (`192.0.2.1`) produced dozens of LuLu prompts in a few minutes.

Rules
- Every Playwright Chromium launch uses `chromiumArgs()` from `test/e2e/browser-args.mjs`. The
  `--host-resolver-rules` switch makes every hostname other than localhost unresolvable, so no remote
  socket is opened; Chrome for Testing's own Google calls are suppressed by the other switches.
  Names under `.localhost` are excluded from the block as well (v0.3: the social example's subdomain hub
  runs as `<label>.localhost:<port>` in `test/e2e/hub-stack.mjs`). Chromium answers every `*.localhost`
  name with the loopback addresses itself, without asking a DNS server (RFC 6761 section 6.3), and the
  e2e network-policy guard (`isLocalUrl` in `test/e2e/lib.mjs`) counts them as local. WebKit never loads
  them: its rule stays `http://127.0.0.1` only.
- WebKit and Firefox have no resolver switch, so they get a proxy instead (`localOnlyProxy()` in
  `test/e2e/browser-args.mjs`, used by `launchWebkit` and `launchFirefox` in `test/e2e/lib.mjs`). Every request
  whose host is not `127.0.0.1`, `localhost` or a `*.localhost` name goes to `http://127.0.0.1:9`, a closed
  loopback port, and fails there. With an HTTP proxy the browser hands the host name to the proxy and does not
  resolve it, so no DNS query and no remote socket leave the machine. WebKit's tests still use
  `http://127.0.0.1:<port>` URLs only; the proxy is the second guard.
- Firefox also gets `firefoxUserPrefs()` from the same file, set from the first moment of the process: the same
  proxy as a preference with no direct fallback, and every background service that could connect switched off
  (captive-portal and connectivity checks, remote settings, add-on updates and the blocklist, safe browsing,
  telemetry and data reporting, Normandy and studies, search suggestions, Web Push, OCSP, DNS over HTTPS in mode 5,
  DNS and link prefetch, speculative connections, HTTP/3). Two prefs make loopback calls work:
  `media.peerconnection.ice.loopback` (127.0.0.1 host candidates) and `media.navigator.streams.fake` (generated
  camera and microphone streams). Each Firefox launch gets a throwaway home folder, removed when it closes.
- How this was checked (2026-10-22, Playwright Firefox 157.0, [deviations/firefox.md](deviations/firefox.md)): with
  `MW_LOCAL_PROXY` pointing the proxy at a local recorder, Firefox sat idle on a loopback page for 30 seconds and
  sent nothing; a deliberate request to `http://control.invalid/` reached the recorder and nothing else; a socket
  sampler (`lsof` on the Firefox processes, twice a second) saw only loopback endpoints through the full
  `npm run test:e2e:firefox` run.
- Remote probes (public trackers, DoH resolvers, web seeds) run in Node (`fetch`, `ws`), never in a
  browser, and only from the explicit tools: `tools/check-site.mjs`, `tools/check-webseed.mjs`,
  `tools/pin.mjs`. They print what they will contact before connecting.
- Unreachability tests use a listener on `127.0.0.1` that refuses or hangs, never a reserved
  internet address.

Firewall rules a developer may want (LuLu: on the alert, Details & Options, scope = process)
- `~/Library/Caches/ms-playwright/chromium-*/…/Google Chrome for Testing` (and its Helper): Block.
  Local tests are unaffected because loopback is not filtered.
- `~/Library/Caches/ms-playwright/webkit-*/com.apple.WebKit.Networking.xpc/…`: Block. This is
  Playwright's copy; Safari's own process lives under `/System/Library/Frameworks/WebKit.framework`
  and must not be touched.
- `~/Library/Caches/ms-playwright/firefox-*/firefox/Nightly.app` (Playwright's Firefox build, named Nightly):
  Block. Loopback is not filtered, so the Firefox tests are unaffected.
- `~/.local/share/node/current/bin/node`: Allow only when running `check-site`, `check-webseed`,
  `pin` or `npm install`; otherwise a block rule is safe for this repository.
