#!/bin/bash
# usage: probe_gw.sh <base-url>   (path gateway) ; prints one summary line
base="$1"
CID=bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m
url="$base/ipfs/$CID"
get=$(curl -sS -m 12 -o /tmp/gw_body_$$ -D - -H "Origin: https://example.org" -H "Range: bytes=0-9" -w "\nCURLCODE:%{http_code} T:%{time_total}\n" "$url" 2>&1 | tr -d '\r')
code=$(echo "$get" | grep -o 'CURLCODE:[0-9]*' | cut -d: -f2)
tt=$(echo "$get" | grep -o 'T:[0-9.]*' | cut -d: -f2)
acao=$(echo "$get" | grep -i '^access-control-allow-origin' | head -1 | cut -d: -f2- | xargs)
ar=$(echo "$get" | grep -i '^accept-ranges' | head -1 | cut -d: -f2- | xargs)
cr=$(echo "$get" | grep -i '^content-range' | head -1 | cut -d: -f2- | xargs)
loc=$(echo "$get" | grep -i '^location' | head -1 | cut -d: -f2- | xargs)
sunset=$(echo "$get" | grep -i '^sunset' | head -1 | cut -d: -f2- | xargs)
bodylen=$(wc -c < /tmp/gw_body_$$ 2>/dev/null | xargs)
rm -f /tmp/gw_body_$$
opt=$(curl -sS -m 12 -o /dev/null -D - -X OPTIONS -H "Origin: https://example.org" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: cache-control,range" "$url" 2>&1 | tr -d '\r')
ocode=$(echo "$opt" | head -1)
acah=$(echo "$opt" | grep -i '^access-control-allow-headers' | cut -d: -f2- | xargs | tr '\n' ' ')
echo "$base | GET=$code t=${tt}s body=${bodylen}B ACAO=$acao AR=$ar CR=$cr LOC=$loc SUNSET=$sunset | OPTIONS: $ocode ACAH=[$acah]"
