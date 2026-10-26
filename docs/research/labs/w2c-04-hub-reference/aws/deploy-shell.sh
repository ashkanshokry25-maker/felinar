#!/usr/bin/env bash
# Publish the built loader shell (ARCHITECTURE.md v0.2 section 10 output layout).
# Usage: ./deploy-shell.sh <dist-dir> <bucket> <distribution-id>
# Rules encoded here (each one is a production lesson, see w2c-04-hub-gateway-operations.md):
#   * Order matters: loader assets first, entry documents and the service worker last, so no client sees HTML that names a missing asset.
#   * /mw-sw.js, /index.html, /404.html are revalidated on every load (a stale SW script delays updates and takedowns).
#   * /mw-sw.js MUST be served with a JavaScript MIME type or the browser refuses to register it.
#   * "Purge the CDN on every deploy" (ARCHITECTURE.md section 7.1): one wildcard invalidation (/*) counts as one path.
set -euo pipefail
dist=${1:?dist dir}; bucket=${2:?bucket}; dist_id=${3:?distribution id}

aws s3 sync "$dist/_mw" "s3://$bucket/_mw" --cache-control "public,max-age=300" --delete

put() { # put <file> <content-type> <cache-control>
  [ -f "$dist/$1" ] || return 0
  aws s3 cp "$dist/$1" "s3://$bucket/$1" --content-type "$2" --cache-control "$3"
}
put build.json     "application/json"                "public,max-age=300"
put mw-sw-kill.js  "text/javascript; charset=utf-8"  "no-cache"
put 404.html       "text/html; charset=utf-8"        "no-cache"
put index.html     "text/html; charset=utf-8"        "no-cache"
put mw-sw.js       "text/javascript; charset=utf-8"  "no-cache"

aws cloudfront create-invalidation --distribution-id "$dist_id" --paths '/*' >/dev/null
echo "deployed to s3://$bucket and invalidated /*"
