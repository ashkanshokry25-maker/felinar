w2c-03 VERIFY lab (2026-10-17). Independent re-runs and extra probes for docs/research/w2c-03-identity-ux-VERIFY.md.
Machine: Apple M3 (8 cores), macOS 27, Node 24.22.0 (~/.local/share/node/current/bin), Playwright 1.64.1 from ../../../../../node_modules,
Chromium 156.0.8078.4 (Playwright chromium-1248), WebKit 27.2 (Playwright webkit-2370). Firefox (firefox-1555) still fails to launch here
("Could not find profile folder", tried with the scratchpad TMPDIR, an existing TMPDIR and the default /tmp), so Firefox is UNTESTED.
Run from this directory:
  export PATH=$HOME/.local/share/node/current/bin:$PATH
  node e1.mjs chromium|webkit      # same-origin / opaque sandbox iframe vs a non-extractable IndexedDB key, plus Service Worker control
  node e2.mjs <engine> new|persistent write|read [profileDir]   # is Playwright's default context persistent? do CryptoKeys survive a restart? persist()
  node e3.mjs                      # PRF in Chromium's virtual CTAP2 authenticator (create/get/second/evalByCredential, eval at create)
  node e3c.mjs                     # virtual authenticator holds at most 3 resident credentials (4th create -> NotAllowedError)
  node e3d.mjs                     # delete credential, re-register same RP + user handle -> different PRF output
  node e3e.mjs                     # authenticator UV off -> PRF refused even with userVerification:'discouraged' (e3b.mjs is the longer, partly broken variant)
  node e4.mjs chromium|webkit      # hostile same-origin code posts the non-extractable CryptoKey to another origin
  node e5.mjs chromium|webkit      # which modern WebCrypto algorithms (ML-KEM, ML-DSA, ChaCha20-Poly1305, X-Wing, Argon2, scrypt, SHA3) exist
  cd kdf && npm install --ignore-scripts && node bench.mjs && node browser-bench.mjs chromium   # hash-wasm 4.12.0 vs @noble/hashes 2.4.0 (run from inside kdf/)
Caveats: Playwright launches Chromium with --disable-features=ThirdPartyStoragePartitioning, so e4 under Chromium shows UNPARTITIONED third-party storage;
Playwright's default browser.newContext() is incognito-like (e2 proves it loses IndexedDB/localStorage on relaunch); the virtual authenticator is software.
Timings vary by machine load (kdf results in results/ are from the quiet re-run; a loaded first run gave WASM 27-33 ms and noble 147-169 ms at 19 MiB t=2).
Nothing here touches src/ or any user data.
