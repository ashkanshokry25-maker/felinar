#!/bin/bash
base="$1"; TX=nBOEA5n1P9qCVyJL2QD7DWMzCzpMUikE8Ee2-Ev8IqQ
url="$base/$TX"
r=$(curl -sS -m 15 -o /dev/null -D - -H "Origin: https://example.org" -H "Range: bytes=0-9" -w "\nCODE:%{http_code} T:%{time_total} SZ:%{size_download}\n" "$url" 2>&1 | tr -d '\r')
code=$(echo "$r" | grep -o 'CODE:[0-9]*' | cut -d: -f2); tt=$(echo "$r" | grep -o ' T:[0-9.]*' | cut -d: -f2); sz=$(echo "$r" | grep -o 'SZ:[0-9]*' | cut -d: -f2)
first=$(echo "$r" | head -1)
acao=$(echo "$r" | grep -i '^access-control-allow-origin' | head -1 | cut -d: -f2- | xargs); cr=$(echo "$r" | grep -i '^content-range' | cut -d: -f2- | xargs); ar=$(echo "$r" | grep -i '^accept-ranges' | cut -d: -f2- | xargs)
loc=$(echo "$r" | grep -i '^location' | cut -d: -f2- | xargs); dig=$(echo "$r" | grep -i -E '^x-ar-io-(digest|verified|trusted)' | tr '\n' ' ')
o=$(curl -sS -m 15 -o /dev/null -D - -X OPTIONS -H "Origin: https://example.org" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: cache-control,range" "$url" 2>&1 | tr -d '\r')
oc=$(echo "$o" | head -1); acah=$(echo "$o" | grep -i '^access-control-allow-headers' | cut -d: -f2- | xargs | tr '\n' ' ')
echo "$base | GET=$code t=${tt}s sz=$sz ACAO=$acao AR=$ar CR=$cr LOC=$loc $dig | OPT: $oc ACAH=[$acah]"
