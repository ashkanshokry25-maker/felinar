#!/bin/bash
# usage: probe_blossom.sh <server-base-url>  -- GET Range bytes=0-9 of the BUD-01 example blob + CORS preflight with cache-control,range
s="$1"; H=b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553
r=$(curl -sS -m 12 -o /dev/null -D - -H "Origin: https://example.org" -H "Range: bytes=0-9" -w "\nCODE:%{http_code} T:%{time_total} SZ:%{size_download}\n" "$s/$H" 2>&1 | tr -d '\r')
code=$(echo "$r" | grep -o 'CODE:[0-9]*' | cut -d: -f2); tt=$(echo "$r" | grep -o ' T:[0-9.]*' | cut -d: -f2); sz=$(echo "$r" | grep -o 'SZ:[0-9]*' | cut -d: -f2)
acao=$(echo "$r" | grep -i '^access-control-allow-origin' | head -1 | cut -d: -f2- | xargs); cr=$(echo "$r" | grep -i '^content-range' | cut -d: -f2- | xargs); loc=$(echo "$r" | grep -i '^location' | cut -d: -f2- | xargs)
o=$(curl -sS -m 12 -o /dev/null -D - -X OPTIONS -H "Origin: https://example.org" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: cache-control,range" "$s/$H" 2>&1 | tr -d '\r')
oc=$(echo "$o" | head -1); acah=$(echo "$o" | grep -i '^access-control-allow-headers' | cut -d: -f2- | xargs | tr '\n' ' ')
echo "$s | GET=$code t=${tt}s sz=$sz ACAO=$acao CR=$cr LOC=$loc | OPT: $oc ACAH=[$acah]"
