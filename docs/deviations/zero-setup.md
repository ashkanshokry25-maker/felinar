# Deviations and notes: zero-setup (v0.3 C2)

Lane: the zero-setup ladder: `ship`, the name check, the one-box template, the nip.io rule in the loader, rung defaults in `publish`,
the LAN tracker proxy, `--calls` in the tools, and the user-facing text (docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md, "SZ", 3.2
and 3.4, 3.1.6 for the pin settings, 3.5 "ICE and relay"; docs/research/v03/S2-zero-setup-hosting.md, "S2": F1 to F18, Rc1 to Rc10, strings
Z1 to Z9). The brief was read from `.orchestration/args/c2/zero-setup.md` (the computed task text carried `BRIEF: undefined`). Written
2026-10-20, 16:48 ET.

## Files

| File | State |
|---|---|
| `src/loader/doh.js` | `shouldSkipDoh` is also true for `nip.io`, `sslip.io` and every name under them; new exports `isWildcardDnsName`, `WILDCARD_DNS_SUFFIXES`. `nip.io.example.com` and `anip.io` are looked up as before |
| `tools/name-check.mjs` | New: `ipName`, `isIPv4Text`, `nameCheck`, `chooseName`, `describeNameCheck` (string Z4), `isBlockPageAddress`, `NAME_SERVICES`, `BLOCK_PAGE_ADDRESSES` |
| `tools/ship.mjs` | New: `ship(options, deps)`, `planShip`, `commandsFor`, `publishArgs`, `urlsFor`, `assembleOneBox`, `findKeyLeaks`, `parseSshTarget`, `unusableAddress`, `parseEnv`, `envState`, `mergeEnv`, strings `Z1`, `Z2`, `Z3`, `Z5`, `Z6`, `SHIP_DEFAULT_EXP_DAYS = 399` (owner decision SZ-3) |
| `tools/publish.mjs` | `--calls`; for a scope tied to an address `--chain` defaults to `--name` and the 450-byte warning becomes the line of S2 Rc3; new exports `addressBoundScope`, `featuresFromCfg` |
| `tools/ledger-admin.mjs` | `cfg --calls off|contacts`, `--clear calls`; `calls` needs chat on |
| `tools/dev-server.mjs` | `--tracker-proxy <port>`; the result has `trackerProxy` |
| `tools/demo.mjs` | the LAN tier (`--tls`) puts the tracker on the page's origin at `/tracker` through the proxy and prints string Z8 and the USB route |
| `tools/check-site.mjs` | a name `shouldSkipDoh` skips: "not possible for this name (page tag only)", the expiry date, no DoH request |
| `bin/magnet-web.mjs` | `ship` -> `tools/ship.mjs` |
| `deploy/one-box/Caddyfile`, `docker-compose.yml`, `README.md` | New: S2 rung 2a; the Caddyfile body is S2's validated text character for character |
| `.github/workflows/ci.yml` | New job `one-box` |
| `docs/DEPLOY.md`, `docs/QUICKSTART.md`, `docs/FAQ.md` | "Zero-setup: a server without a domain", "Start without a domain", "Starting without a domain (v0.3)"; HTTPS and phone demos, Pin node, TURN and the tracker-and-STUN section updated; costs rows |
| tests | `tools-ship`, `name-check`, `deploy-one-box`, `tools-c2-zero-setup` (new); `loader-common-doh`, `cli-bin`, `tools-v03-ledger`, `tools-check`, `tools-demo` (extended or updated where behaviour changed) |

## Tests

    export PATH=$HOME/.local/share/node/current/bin:$PATH
    node --test test/unit/tools-ship.test.mjs test/unit/name-check.test.mjs test/unit/deploy-one-box.test.mjs \
      test/unit/tools-c2-zero-setup.test.mjs test/unit/loader-common-doh.test.mjs test/unit/cli-bin.test.mjs \
      test/unit/tools-v03-publish.test.mjs test/unit/tools-v03-ledger.test.mjs test/unit/tools-dev-server.test.mjs \
      test/unit/tools-check.test.mjs test/unit/tools-demo.test.mjs          # 219 pass, 0 fail, 0 skipped, about 6 s

No test contacts a non-local address, resolves a public name, starts a browser or starts Docker. `ship` is tested with canned `exec`, DNS,
TLS-probe and `check-site` answers; `publish` and `keygen` run for real in temporary directories; one test runs this computer's `rsync` on
local folders (skipped when `rsync` is missing); one resolves `localhost` through the system resolver. `node tools/lint-floor.mjs` is clean over
all of `src/`. The e2e suite, `dist/` and the full unit suites were not run (the integrator's). As a read-only regression check, 300 tests of
other lanes that import the changed modules (`tools-publish*`, `tools-ledger`, `tools-v03-init`, `tools-lib`, `loader-app-*`, `common-pointer`,
`integration-v03*`, `dropin-fixture`, ...) also pass; `formats-vectors` fails only because the calls lane added `test/vectors/calls.json` and the
integrator has not listed it yet.

By hand, once, not a repeatable test: the LAN tier of `demo --tls` with the real headless Chromium seeder (local-only launch flags, a
self-signed certificate for 127.0.0.1, a scratch `dist`): the browser reached `wss://localhost:<port>/tracker` through the dev server's proxy
and the loopback tracker reported 1 torrent and 1 peer.

Mutation checks done by hand (the files were restored): changing one word of the Caddyfile, the `:ro` of the site mount and one word of
string Z5 each turned `deploy-one-box` red. The `calls` rows of `tools-v03-ledger` were also run in a scratch copy whose
`src/chain/state.js` lists `calls` (24 of 24 pass), because in this tree that file does not (request 1).

## Deviations, with reasons

1. **`nameCheck` has a fifth reason, `'error'`, and `resolve6` is optional.** The brief and INTERFACES list `'ok' | 'blocked' | 'other' |
   'nxdomain'`. A timeout or a SERVFAIL is none of them: calling it `nxdomain` would tell the owner the name does not exist. The four values
   keep their meaning (c-ares `ENOTFOUND` and `ENODATA` are `nxdomain`). `chooseName` (the sslip.io fallback) and `describeNameCheck` (Z4 and
   its siblings) live in `name-check.mjs` so `ship` stays thin and the fallback is tested with canned answers. For `blocked`, Z4 is verbatim,
   and its "Try <other name>" clause is dropped when there is no other service left to try. For `other`, `nxdomain` and `error` the text says what
   was seen and claims no cause: only the block page is known to come from the service.
2. **`ship(options, deps)`: the injectable steps go in the second argument or among the options, and there are six flags beyond the brief.**
   INTERFACES shows `ship({ ip, to, ct, ..., exec, ssh, rsync, resolve, now })`; both forms work, `resolve` means `resolve4`, and `now` may be a
   function or the milliseconds. Extra flags: `--out` (the work directory, default `dist-ship/<name>`), `--dist` (the built loader), `--exp`
   (SZ-3 is not signed, so the default needs an override that does not need a code change), `--policy` and `--bits` (so the repository's own
   guestbook can be shipped open; passed to `publish`), and `--new-ledger` (item 5). The CLI of INTERFACES and ARCHITECTURE 10 lists none of
   them (request 3).
3. **`ship` looks at the server before it makes or publishes anything, and sends in the deploy order.** The brief lists the steps in the order
   name, key, publish, copy, `.env`, start, check. Checking the clone, `rsync`, Compose 2.17 and `.env` first means a server that cannot be used
   leaves no key, work directory or publication behind (tested), and it is what makes the update and the ledger guard possible. The send follows
   docs/DEPLOY.md "Deploy order": the web seed, then the allow list, then the loader with the new pointer. The web seed is **not** pruned
   (`rsync` without `--delete`): DEPLOY.md says to keep the previous version's files for 7 days, and `--delete` on `ws/` would remove them at
   once. The loader (`--delete --exclude=/ws/`) and the allow list are replaced. `mkdir -p` runs first because `rsync` makes only the last
   directory of a path.
4. **The real `rsync` found a bug before release: `--chmod=D755,F644` is refused by the `rsync` of macOS** ("openrsync: protocol version 29",
   "--chmod=D755,F644: invalid argument"). `ship` makes the deploy tree 755 and 644 itself (`assembleOneBox`) and sends with `-p`. The test that
   runs this computer's `rsync` on local folders is the one that caught it; the unit tests with canned answers could not.
5. **Update, continue and replace are decided from the server's `.env`.** A second run must not put a working site on an untrusted staging
   certificate. `.env` with the same `LW_SITE` and the production directory is an update (no staging, no restart, the snapshot at `ws/genesis.json`
   kept, `.env` untouched); the same name on the staging directory continues an earlier `--staging-only` or interrupted run; another name
   replaces the site (said aloud; one box serves one site; its web seed files stay). Other lines of `.env` (`PIN_MONTH_CAP`, comments) are kept.
   **The ledger guard:** an update, or a continuation, without `<out>/publish/genesis.json` stops before anything is made, because `publish`
   would mint a new first block, which is a new ledger for every visitor and every post. `--new-ledger` says it is meant.
6. **The certificate is detected with a TLS connection, not by reading Caddy's log.** `probeCertificate` opens one connection to the server's
   address with the site name as SNI: the staging issuer contains "STAGING", and a production certificate must be trusted by this computer
   (`socket.authorized`), which is what a browser needs. It is injectable. Attempts: 36 at 5 s (`certAttempts`, `certDelayMs`). A staging
   failure prints Z5 as written; a production failure after a good staging run says the server is reachable and points at the duplicate
   limit (S2 F5) and the logs, because Z5 would blame the ports wrongly. Compose is addressed with `-f <box>/docker-compose.yml` (not
   `--project-directory` alone), so the file is found from whatever directory the ssh session starts in.
7. **The name is looked up with `getaddrinfo`, not c-ares** (`systemResolve4`, the default `resolve4`): the operating system's resolver is what a
   browser here would reach (a local DNS proxy, a VPN's split DNS), and the block page is a global answer, so any resolver sees it.
   **The owner key defaults to `~/.config/magnet-web/<name>.jwk`** (folder mode 700 when `ship` makes it, file mode 600). The brief says "makes or
   reuses the owner key locally" without a place. Before anything is sent `ship` searches the deploy tree for the key's private scalar and stops if
   it finds it (tested with a `publish` that plants it); the key's path may not be inside the site folder or the work directory.
8. **`publish`: "IP literal" means an IP address other than a loopback address.** Many tests and the e2e harness publish with `--scope 127.0.0.1`
   and no `--chain`; giving those a ledger label would change their ledger ids for no gain, so loopback and `localhost` keep the older defaults.
   A site that was published before at a public IP literal without `--chain` gets a different ledger id now; no such site can exist from the
   rung-2 flow, and public IP certificates date from 2026-01-15. The one-line replacement of the 450-byte warning is printed for every
   address-bound scope, not only above 450 bytes: the expiry date is the thing to see. A site name over 64 characters has no default label and
   stops with a usage error that says to pass `--chain` or a shorter `--name`.
9. **`check-site` says "not possible for this name (page tag only)" for every name `shouldSkipDoh` skips**, localhost and IP addresses included,
   and adds why and the expiry date; the earlier phrase "is not a public DNS name" stays inside the message for those. The printed step is
   `dns pointer` in lower case as before.
10. **`ledger-admin cfg --calls`**: `contacts` needs chat on (`--chat members` or `open`, in the same run or already set), and `--chat off` is
    refused while calls are on. Writing `calls` also needs the reader's schema to list it (request 1); until then `mergeCfg` throws and says so
    ("the reader schema in src/chain/state.js does not list calls yet") instead of writing a setting that readers would hide.
11. **`dev-server --tracker-proxy`** passes only an upgrade for exactly `/tracker` (a query string is allowed), rewrites its target to `/`, and
    pipes bytes both ways; any other upgrade gets 404, a tracker that is down gets 502, `close()` ends the proxied sockets, and a plain GET of
    `/tracker` is served like any other path (the one-box Caddyfile also proxies only upgrades). The upstream is always `127.0.0.1`.
12. **`demo --tls`** keeps the desktop tier as it was and changes only the LAN tier: the tracker listens on `127.0.0.1` without TLS and the pointer's
    `tr=` is `wss://<lan-ip>:<port>/tracker`. The USB route printed in that tier names the desktop tier's default ports (8080 and 8000).
13. **The Caddyfile is S2's text without change; the compose file is `deploy/tracker/docker-compose.yml` with the three documented changes and a
    fourth.** The fourth is the project name (`magnet-web-one-box`), so the two stacks do not collide on one machine. No access log is written (the
    comment of S2 stays and says where to add the masked one). The `pin` service takes its settings as `- NAME` pass-through entries, so an unset
    `PIN_MONTH_CAP` is not passed as an empty string. `deploy-one-box.test.mjs` compares the Caddyfile with the research text and the tracker service
    with the one in `deploy/tracker`, so neither can drift alone.
14. **CI: the `one-box` job pins Caddy by tag (`caddy:2.11.7`), not by digest.** The digest needs a registry lookup and DEV-NETWORK.md keeps this
    lane off the network. The job prints the digest it pulled to the step summary; copying `@sha256:...` into the `CADDY_IMAGE` line finishes
    the pin (the test accepts either form). It validates the Caddyfile and runs `docker compose config` with and without the pin profile; it does not
    start the stack.
15. **`ship` prints S2's Z1, Z2, Z3, Z5 and Z6 and Z4 (name check); Z8 is printed by `demo --tls`; Z7 and Z9 are in the docs only**, because the
    tools never start a tunnel and `ship` does not target a free host. Z3 names the service in use (sslip.io is the same service under its second
    name, S2 F1).

## Requests to other lanes and the integrator

1. **`src/chain/state.js` (chain lane files, owned by the C2 integrator now): add `calls: ['off', 'contacts']` to `CFG`** (and to the
   schema list in R 2.10.2). Nothing else in the tree can write `_mw.cfg.calls` until then; `tools-v03-ledger.test.mjs` takes the writing branch
   by itself once the schema lists it. The calls lane reads `_mw.cfg.calls` (SZ 3.5) and the owner sets it with
   `node tools/ledger-admin.mjs cfg --chat members --calls contacts`.
2. `tools/init.mjs` (tools lane): a "calls" question beside chat, files and media, using `CFG_ENUMS.calls`.
3. `docs/INTERFACES.md` and `docs/ARCHITECTURE.md` (docs-strings): the `ship` CLI also takes `--out`, `--dist`, `--exp`, `--policy`, `--bits` and
   `--new-ledger`; `ship(options, deps)` takes the injectable steps in either place; `nameCheck` may return `reason: 'error'`; new exports
   `chooseName`, `describeNameCheck`, `addressBoundScope`, `featuresFromCfg`, `isWildcardDnsName`; the dev server result has `trackerProxy`.
4. Integrator, tests: add `docs/research/v03` to the `docs-links` search list (every top document cites the design by bare name; run with the
   list extended, the file passes); add `deploy/one-box/README.md` to the lists of `repo-layout` that check README flags and links (the file
   passes both checks when added); E-ZS-1 (no DoH query for a nip.io name) needs a page whose hostname is a nip.io name, which the local-only
   browser cannot resolve, so it needs the loader's `deps` or a `--host-resolver-rules` mapping to loopback for that one name. The unit
   proof is in `tools-check` (no DoH request from `check-site`) and `loader-common-doh` (the rule).
5. Integrator, `.gitignore`: add `dist-ship/` (the default work directory of `ship`: the site tree, the ledger's first block, `.env`; never a key).
   Until then a user who runs `ship` inside a clone sees it as untracked, and `repo-layout` lists a tracked `dist-ship` as an unknown top-level entry.
6. Integrator, `package.json`: a script `"ship": "node tools/ship.mjs"` beside `demo` and `publish:site` (the `files` list already packs `bin/` and
   `tools/`; `ship` needs nothing from `deploy/` on the local side, only a built loader: `--dist` or `npm run build`).
7. Integrator, CI: copy the Caddy digest the `one-box` job prints into `CADDY_IMAGE`. `.github/dependabot.yml` does not cover the images of
   `deploy/one-box/docker-compose.yml` (`caddy:2.11`; the tracker's `node:24-bookworm-slim` is inline).
8. Integrator, release gate: G-ZS1 to G-ZS4 in DEMO-RESULTS.md are the first real run. What is not verified: any certificate from Let's Encrypt, any
   real server, ssh with a password prompt for each step, a phone or browser on a nip.io name (S2 Q1, Q2), the pin container reaching its own public
   name (Q10), and a rented server whose `rsync` is older than 3.0.

## Housekeeping

During the work a test of mine called `ship` without a temporary home and current directory and wrote `dist-ship/my-site/` into the repository root
(the auto checkpoint of 16:46 ET holds it) and a throwaway test key into `~/.config/magnet-web/`. Both were deleted at once; the key was made by the
test and used for nothing. Every `ship` call in `tools-ship.test.mjs` now goes through a wrapper that refuses to run without a temporary home
and current directory. The checkpoint history is squashed before publishing (RESUME.md), which removes the files from it.
