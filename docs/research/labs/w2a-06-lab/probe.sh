#!/bin/zsh
# probe.sh URL : print Range/CORS/compression behaviour of a static host for one file.
url="$1"
hdr='^(HTTP/|server:|content-type:|content-encoding:|content-range:|content-length:|accept-ranges:|access-control-|cache-control:|vary:|via:|x-served-by:|cf-cache-status:|x-cache:|age:|etag:|x-amz-|x-vercel-cache:|x-nf-request-id:|x-github-request-id:|fly-request-id:|x-firebase)'
echo "=== $url"
echo "--- A: plain GET, no Range, Accept-Encoding: gzip, br  (what a browser navigation would see)"
curl -s --max-time 25 -D - -o /dev/null -H 'Accept-Encoding: gzip, br' "$url" | grep -i -E "$hdr" | tr -d '\r'
echo "--- B: Range: bytes=0-99 + Accept-Encoding: gzip, br + Origin (browser fetch() from another origin)"
curl -s --max-time 25 -D - -o /dev/null -H 'Range: bytes=0-99' -H 'Accept-Encoding: gzip, br' -H 'Origin: https://example.org' "$url" | grep -i -E "$hdr" | tr -d '\r'
echo "--- C: Range: bytes=0-99 + Accept-Encoding: identity"
curl -s --max-time 25 -D - -o /dev/null -H 'Range: bytes=0-99' -H 'Accept-Encoding: identity' "$url" | grep -i -E "$hdr" | tr -d '\r'
echo "--- D: OPTIONS preflight (Origin, Access-Control-Request-Method: GET, Access-Control-Request-Headers: range)"
curl -s --max-time 25 -D - -o /dev/null -X OPTIONS -H 'Origin: https://example.org' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: range' "$url" | grep -i -E "$hdr" | tr -d '\r'
echo
