#!/bin/zsh
# Re-runs every experiment behind docs/research/w2c-05-testing-qa-production.md and writes results-<date>.txt.
# Needs: Node >= 22 (tested v24.22.0), the project's node_modules (playwright 1.64.1 + chromium + webkit browsers installed),
#        fast-check (npm install --ignore-scripts in this directory). Takes ~10 minutes. Read-only on the project.
set -u
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/node/current/bin:$PATH"
[ -d node_modules/fast-check ] || npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1
OUT="results-$(date +%Y-%m-%d).txt"
{
  echo "# w2c-05 lab results, run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# host: $(uname -a)"; echo "# node: $(node --version)  playwright: $(node -p "require('../../../../node_modules/playwright/package.json').version")"
  for s in wycheproof-run.mjs jcs-run.mjs pbt-parsers.mjs wire-oversize.mjs wire-debug.mjs webseed-chaos.mjs ndc-loopback.mjs chromium-node-peer.mjs \
           cdp-webrtc-throttle.mjs cdp-webrtc-throttle2.mjs cdp-webrtc-throttle3.mjs setoffline-dc.mjs cdp-webrtc-throttle4.mjs cdp-webrtc-throttle5.mjs \
           mem-flags.mjs mem-flags-newheadless.mjs pw-gotchas.mjs idb-pow-bench.mjs engine-probe.mjs webkit-rtc.mjs webkit-rtc2.mjs webkit-inpage.mjs; do
    echo; echo "################ $s"; node "$s" 2>&1 | tail -60
  done
} > "$OUT" 2>&1
echo "wrote $OUT"
