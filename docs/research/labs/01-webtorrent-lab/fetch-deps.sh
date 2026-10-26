#!/bin/sh
# Populates www/ with the pinned third-party files the experiments need (nothing is vendored in git).
# Verifies every npm tarball against the sha512 integrity published in the npm registry (pinned below).
# Needs: curl, openssl, tar.   Usage: ./fetch-deps.sh
set -eu
cd "$(dirname "$0")"
mkdir -p .deps www/idb6
get () { # name version integrity
  f=".deps/$1-$2.tgz"
  [ -f "$f" ] || curl -fsS --max-time 120 -o "$f" "https://registry.npmjs.org/$1/-/$1-$2.tgz"
  got="sha512-$(openssl dgst -sha512 -binary "$f" | openssl base64 -A)"
  [ "$got" = "$3" ] || { echo "INTEGRITY MISMATCH for $1@$2" >&2; exit 1; }
  echo "ok  $1@$2"
}
get webtorrent 3.0.21 "sha512-PFgLphma0dsUWmbWrZ016Cja+j+3D3DXuhk09A5u9qVAzH1T4Vj1VZd8j+zb8sDwPv7NA7+qgPtDEN4iFd6wdw=="
get idb 6.1.5 "sha512-IJtugpKkiVXQn5Y+LteyBCNk1N8xpGV3wWZk9EVtZWH8DYkjBn0bX1XnGP9RkyZF0sAcywa6unHqSWKe7q4LGw=="
rm -rf .deps/x && mkdir -p .deps/x/wt .deps/x/idb
tar -xzf .deps/webtorrent-3.0.21.tgz -C .deps/x/wt
tar -xzf .deps/idb-6.1.5.tgz -C .deps/x/idb
cp .deps/x/wt/package/dist/webtorrent.min.js .deps/x/wt/package/dist/sw.min.js www/
cp .deps/x/idb/package/build/esm/*.js www/idb6/
echo "sha384-$(openssl dgst -sha384 -binary www/webtorrent.min.js | openssl base64 -A)  www/webtorrent.min.js (expect sha384-IexsdEUdGw4BzhFFI9KtUV6DveUjtM3Qwf/paYQ1I3U0fnEUItBxhSKS0BHQwoV7)"
