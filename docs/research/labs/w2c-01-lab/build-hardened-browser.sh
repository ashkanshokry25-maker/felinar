#!/bin/bash
# Builds the browser bundle of hardened-conn.mjs used by webseed-matrix-hardened.mjs (output: $OUT/hardened.browser.js).
# usage: OUT=/some/empty/dir ./build-hardened-browser.sh
set -e
OUT=${OUT:?set OUT to an empty working directory}
NM=$HOME/Documents/Projects/magnet-web/node_modules
LAB="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT" && cd "$OUT"
[ -d node_modules/events ] || { echo '{"name":"b","private":true,"version":"0.0.0"}' > package.json; npm install events@3.3.0 --ignore-scripts --no-audit --no-fund --loglevel=error; }
sed -e "s#'$NM/bitfield/dist/index.js'#'bitfield'#" -e "s#'$NM/lt_donthave/index.js'#'lt_donthave'#" -e "s#'$NM/bittorrent-protocol/index.js'#'bittorrent-protocol'#" -e "s#'$NM/uint8-util/dist/src/node.js'#'uint8-util'#" "$LAB/hardened-conn.mjs" > conn.js
echo "export { HardenedWebConn } from './conn.js'" > entry.js
NODE_PATH=$NM $NM/.bin/esbuild entry.js --bundle --minify --format=esm --platform=browser --target=es2020 --alias:events="$OUT/node_modules/events/events.js" --outfile=hardened.browser.js --log-level=error
ls -l hardened.browser.js
