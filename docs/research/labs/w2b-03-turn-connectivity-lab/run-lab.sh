#!/bin/sh
# Reproduces the loopback experiments quoted in docs/research/w2b-03-turn-connectivity.md (2026-10-17).
# Loopback only: fake STUN/TURN servers on 127.0.0.1:34780-34791 and a static server on 127.0.0.1:18090. No external network.
# Needs: Node >= 22 on PATH, the project's node_modules (playwright 1.64.1 browsers installed), python3.
# NOTE: this overwrites ./results/*.json, the reference runs quoted in the research document; copy the directory first to keep them.
# Takes ~12 minutes (dead-TURN scenarios wait 40-60 s each; WebKit never completes gathering, so its waits run to their limits).
set -eu
cd "$(dirname "$0")"
ROOT=../../../..
NODE_PATH="$ROOT/node_modules" "$ROOT/node_modules/.bin/esbuild" sp-entry.js --bundle --format=iife --platform=browser \
  --alias:events=./events-shim.js --outfile=sp-bundle.js --log-level=warning   # bundles @thaunknown/simple-peer/lite.js 10.1.2
python3 -I fake_ice.py "$PWD/fake-log.jsonl" &  FAKE=$!
python3 -I -m http.server 18090 --bind 127.0.0.1 --directory "$PWD" >/dev/null 2>&1 &  HTTP=$!
trap 'kill $FAKE $HTTP 2>/dev/null || true' EXIT
sleep 1
# 1) ICE gathering / simple-peer offer timing / per-PC TURN request counts / loopback datachannel throughput
ENGINES=chromium,webkit WHAT=ice,peer,alloc,thr OUT=results/res-full.json FAKE_LOG="$PWD/fake-log.jsonl" node run_exp.mjs
# 2) dead-TURN gather timing (waits ~40 s): ONLY selects scenario labels, MAXMS is the per-scenario wait
ENGINES=chromium WHAT=ice ONLY="turn udp BLACKHOLE" MAXMS=100000 OUT=results/res-long-turn_udp_BLACKHOLE.json FAKE_LOG="$PWD/fake-log.jsonl" node run_exp.mjs
# 3) default (mDNS on) host candidates, and the UDP-disabled policy used by hardened browsers
NOFLAG=1 ENGINES=chromium WHAT=ice ONLY="stun A+B" MAXMS=5000 OUT=results/res-mdns.json FAKE_LOG="$PWD/fake-log.jsonl" node run_exp.mjs
EXTRA_ARGS="--force-webrtc-ip-handling-policy=disable_non_proxied_udp" ENGINES=chromium WHAT=ice ONLY="stun A|turn udp OK|turn tcp OK|turn udp+tcp OK|no-servers" MAXMS=6000 OUT=results/res-noudp.json FAKE_LOG="$PWD/fake-log.jsonl" node run_exp.mjs
# 4) reference connectivity probe (connectivity-probe.js) against the same fakes, 4 browser configurations
node run_probe.mjs
python3 -I costmodel.py
