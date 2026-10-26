w1-07 VERIFY lab: can an edge (web server / CDN) take down an already-installed Service Worker?
(research aid for docs/research/w1-07-prior-art-VERIFY.md, claim 8; test code written for this research, not production code)

What it does (run.mjs, 115 lines, no dependencies beyond the repo's own Playwright):
  1. starts a local HTTP "edge" on 127.0.0.1:<random port> whose /sw.js behaviour is switchable
  2. installs a Service Worker that answers /hello locally, reloads so the page is controlled
  3. A  checks the edge sees ZERO requests for /hello while the SW answers it
  4. B  reloads once: does a navigation inside the 24 h window trigger a new /sw.js fetch? (expected: no)
  5. C  edge answers 404, then 410, then 500 for /sw.js; calls registration.update(); does the SW survive?
  6. D  edge serves a NEW 200 script (v2) with "Cache-Control: public, max-age=31536000, immutable"; update() -> is v2 live?
  7. E  edge serves a 200 self-unregistering "kill" script; update(); reload -> is the registration gone, does /hello hit the network?
  8. F  brand-new visitor while the edge answers 410 for /sw.js -> does registration fail?

Run (Node >= 22, repo deps installed, Playwright browsers cached):
  node run.mjs chromium     # or: webkit | firefox
Results on 2026-10-17 (UTC evening), macOS, headless, fresh in-memory browser contexts:
  results-chromium.json  Playwright Chromium 156.0.8078.4
  results-webkit.json    Playwright WebKit 27.2
  results-firefox-LAUNCH-FAILED.txt  Firefox (Nightly build firefox-1555) would not start in this sandbox
                                     ("Could not find profile folder"); Firefox is NOT tested.

Limits: localhost http (secure context), explicit registration.update() instead of waiting for the 24 h soft-update window
(the 24 h rule itself is from the SW spec "stale" definition + the SW-gateway team's table in ipfs/service-worker-gateway#840,
not from this run); engines are Playwright builds, not Chrome/Safari stable.
