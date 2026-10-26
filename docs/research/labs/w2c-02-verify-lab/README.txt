w2c-02 VERIFY lab - scripts and raw results behind ../../w2c-02-chain-production-features-VERIFY.md (2026-10-17)

Machine: MacBook Air, Apple M3 (4P+4E), 24 GB, macOS 27.0, Node 24.22.0.
Browsers: Playwright 1.64.1 headless Chromium 156.0.8078.4 and WebKit 27.2 (Playwright build, NOT Safari).
Firefox does not launch under Playwright on this machine ("Could not find profile folder"), so it is unmeasured.
The machine was shared with other agent workloads (load average about 6 on 8 cores) while these ran: treat absolute
timings as indicative; trust same-run comparisons more.

SAFETY (same rule as ../w2c-02-lab/RUN.txt): third-party packages are installed OUTSIDE the repo with scripts disabled,
and nothing is run from inside the package directory:
  export PATH=$HOME/.local/share/node/current/bin:$PATH
  DL=$(mktemp -d) && cd "$DL" && npm init -y >/dev/null
  npm install --ignore-scripts --no-audit --no-fund yjs@13.6.33 y-indexeddb@9.0.12 lib0@0.2.119 @sqlite.org/sqlite-wasm@3.53.4-build2

1) scripts/gen-blocks.mjs  <outDir> <N> <few|many> <post|tiny|ctl>
   Generates ARCHITECTURE v0.2 section 6.1 blocks (ECDSA P-256, RFC 8785 canonical JSON) using the project's own
   src/chain/canonical.js. 'few' = 200 authors, 'many' = one key per block. Blocks are NOT mined (bits is declared 16, the
   nonce is random), so PoW is not enforced by the benchmark. Prints block-size statistics.

2) scripts/verify-pipeline/   (claim 5: verification cost of 13,574 blocks)
   node server.mjs <port> <this dir> <repo>/src/chain <dataDir> &
   node run.mjs "http://127.0.0.1:<port>/?file=blocks-few-post-13574.json&reps=3" chromium|webkit
   Measures signature-only and full per-block validation (canonicalize, SHA-256 of e, ECDSA verify, value hash) on the main
   thread (sequential and concurrent) and in 1, 2 and 4 module workers (ARCH default pool is 2).

3) scripts/idb-persist/   (claims 5 and 8: ephemeral vs persistent profile, fresh-process cold read, durability)
   node server.mjs <port> idb.html &   node run.mjs chromium|webkit <port> [default|relaxed|strict]
   Same synthetic 618 B record and indexes as ../w2c-02-lab/bench/index.html.

4) scripts/idb-blocks/   (claim 5: real nested v0.2 blocks, keyPath h, no secondary indexes)
   node run.mjs <this dir> <dataDir> blocks-few-post-13574.json     (also blocks-few-post-50000.json)

5) scripts/y-indexeddb-tx/   (claim 1 source: is the trim one transaction?)
   esbuild entry.mjs --bundle --format=iife --platform=browser --outfile=bundle.js   (with NODE_PATH at the npm install above)
   node run.mjs <this dir>

6) scripts/yjs-gc-test.mjs <absolute path to yjs/dist/yjs.mjs>   (claim 1: does default Yjs GC drop deleted content?)

The original ../w2c-02-lab/bench/index.html was also re-run unmodified 3 times per engine (results/orig-bench-replicate-*).
The 9.6 MB block datasets are not stored (regenerate with gen-blocks.mjs).
