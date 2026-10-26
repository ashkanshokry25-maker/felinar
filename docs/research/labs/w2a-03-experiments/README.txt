Experiments behind docs/research/w2a-03-dynamic-feature-replacements.md (run 2026-10-17, macOS 27.0 / Apple M3).
Test code written for this research, not production code. Raw output of the runs: results-2026-10-17.txt.

Toolchain: Node 24 at ~/.local/share/node/current/bin (prepend to PATH); Playwright 1.64.1 from this project's node_modules
(Chromium 156.0.8078.4, WebKit 27.2); ffmpeg from Homebrew only for the media clips; pagefind 1.5.2 installed with
`npm install pagefind@1.5.2 --ignore-scripts` in a scratch directory OUTSIDE this project (not a project dependency).
The scripts make no external network calls (localhost servers only). Note: on this Mac the LuLu firewall blocks /usr/bin/python3 outbound, so downloads for this research used curl.

blocksize.mjs   Block JSON sizes (ARCH v0.1 shape, value inside the hash) + ECDSA P-256 verify throughput using src/chain/canonical.js and src/chain/crypto.js.
                  node blocksize.mjs
blocksize_v02.mjs  Same for the ARCH v0.2 shape (op carries vh, value stored beside the entry) plus ledger-budget arithmetic and the sealed-inbox limit.
                  node blocksize_v02.mjs
rr_table.py     Accuracy of binary randomized response (local differential privacy) vs number of visitors.
                  python3 -I rr_table.py
mkcorpus.py     Builds a 168-page HTML corpus with pydoc from the Python stdlib (for the Pagefind size measurement).
                  python3 -I mkcorpus.py <empty output dir>
                Pagefind sizes were measured with:  node <pagefind>/lib/runner/bin.cjs --site <corpus dir>
                  Corpus A = that pydoc corpus; Corpus B = copies of /usr/share/doc/postfix/html/*.html + /usr/share/doc/cups/help/*.html.
prf-exp/        WebAuthn PRF + "assertion as block signature" inside a Service-Worker-served same-origin iframe
                (CDP virtual authenticator with hasPrf:true).  node prf-exp/run.mjs
pf-exp/         Pagefind search running inside the same kind of SW-served iframe.  node pf-exp/run.mjs <site dir containing pagefind/> octet
mailto-exp/     mailto: / top navigation behaviour under different iframe sandbox flag sets.  node mailto-exp/run.mjs
media-exp/      <video> served by a SW with and without Range support, Chromium vs WebKit.  node media-exp/run.mjs <dir with v.mp4 + v.webm>
                  clips: ffmpeg -f lavfi -i testsrc=duration=6:size=320x240:rate=15 -f lavfi -i sine=frequency=440:duration=6 \
                         -c:v libx264 -pix_fmt yuv420p -g 15 -c:a aac -movflags +faststart -shortest v.mp4   (and libvpx-vp9 + libopus for v.webm)

Limits of these experiments: Chromium virtual authenticator only (no real passkeys, no Firefox/WebKit WebAuthn), headless browsers on one desktop,
no phones, a 96 KB clip, localhost origins. They show feasibility on the stated builds, not cross-browser compatibility.
