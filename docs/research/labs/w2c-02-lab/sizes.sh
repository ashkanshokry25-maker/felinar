#!/bin/zsh
# Reproduces the bundle sizes quoted in w2c-02-chain-production-features.md (G18, G25).
# usage: DL=/abs/path/to/dir-with-node_modules ESB=/abs/path/to/esbuild OUT=/abs/out ./sizes.sh
# DL must be OUTSIDE the repo: mkdir DL && cd DL && npm init -y && npm install --ignore-scripts --no-audit --no-fund \
#   age-encryption@0.3.1 @noble/ciphers@2.4.0 @noble/curves@2.4.0 @noble/hashes@2.4.0 libsodium-wrappers@0.8.4 \
#   hpke-js@1.8.0 @sqlite.org/sqlite-wasm@3.53.4-build2 idb@8.0.4 dexie@4.4.6
set -e
DL=${DL:?set DL}; ESB=${ESB:-esbuild}; OUT=${OUT:-./out}; HERE=${0:A:h}
mkdir -p "$OUT"
sz() { raw=$(wc -c < "$1"); gz=$(gzip -9 -c "$1" | wc -c); br=$(brotli -q 11 -c "$1" | wc -c); echo "$2 raw=$raw gzip9=$gz brotli11=$br"; }
for f in age noble-xchacha noble-box noble-ed25519 sodium hpke idb dexie argon2 sha256only; do
  NODE_PATH="$DL/node_modules" "$ESB" "$HERE/entries/$f.mjs" --bundle --minify --format=esm --platform=browser --target=es2022 --outfile="$OUT/$f.min.js" --log-level=error
  sz "$OUT/$f.min.js" "$f"
done
S="$DL/node_modules/@sqlite.org/sqlite-wasm/dist"
sz "$S/sqlite3.wasm" "sqlite3.wasm(as shipped)"
sz "$S/index.mjs" "sqlite index.mjs(unminified)"
"$ESB" "$S/index.mjs" --minify --format=esm --platform=browser --target=es2022 --outfile="$OUT/sqlite-index.min.mjs" --log-level=error
sz "$OUT/sqlite-index.min.mjs" "sqlite index.mjs(minified)"
