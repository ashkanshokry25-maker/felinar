#!/bin/sh
# Runs one experiment page in headless Brave/Chromium and prints its JSON report.
# Prereqs: ./fetch-deps.sh, then in other shells:
#   deno run --allow-net=127.0.0.1 --allow-read=. --allow-write=./out server.ts 18080 18081
#   deno run --allow-net=127.0.0.1 --allow-env --allow-read --allow-sys tracker.ts     # only for e4 e5 e7 e10 e11 e12
# Usage: ./run-page.sh e4 [extra browser flags]       (BROWSER=/path/to/chromium-like to override)
# Pages that open a popup (e1b e2a e7) need --disable-popup-blocking.
set -eu
cd "$(dirname "$0")"
name="$1"; shift || true
BROWSER="${BROWSER:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"
prof="$(mktemp -d)"; mkdir -p out; rm -f "out/report-$name.json"
"$BROWSER" --headless=new --user-data-dir="$prof" --no-first-run --no-default-browser-check \
  --disable-background-networking --disable-component-update --disable-sync --use-mock-keychain --password-store=basic \
  --disable-features=WebRtcHideLocalIpsWithMdns --force-webrtc-ip-handling-policy=default "$@" \
  "http://127.0.0.1:18080/$name.html" >/dev/null 2>&1 &
pid=$!
i=0; while [ $i -lt 120 ] && [ ! -s "out/report-$name.json" ]; do sleep 1; i=$((i+1)); done
kill $pid 2>/dev/null || true; sleep 1; rm -rf "$prof"
cat "out/report-$name.json"
