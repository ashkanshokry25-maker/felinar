#!/bin/sh
# Downloads the lists used in docs/research/w2b-01-tracker-resilience.md section "Ad-blocker and DNS-blocklist exposure".
# usage: sh fetch-lists.sh <empty-output-dir>      (then: node check.mjs <dir>/browser/*.txt ; python3 -I dnscheck.py <dir>/dns)
set -eu
OUT="${1:?output dir}"; mkdir -p "$OUT/browser" "$OUT/dns"
dl() { curl -fsSL --max-time 240 -A 'magnet-web filter-list check' -o "$1" "$2" || echo "FAILED $2" >&2; }
U=https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters
for n in filters filters-2020 filters-2021 filters-2022 filters-2023 filters-2024 filters-2025 filters-2026 filters-general badware resource-abuse unbreak quick-fixes privacy; do dl "$OUT/browser/ubo-$n.txt" "$U/$n.txt"; done
dl "$OUT/browser/easylist.txt" https://easylist.to/easylist/easylist.txt
dl "$OUT/browser/easyprivacy.txt" https://easylist.to/easylist/easyprivacy.txt
B=https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists
for n in brave-specific brave-social brave-ios-specific brave-firstparty brave-firstparty-regional; do dl "$OUT/browser/$n.txt" "$B/$n.txt"; done
dl "$OUT/browser/adguard-base.txt" https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt
dl "$OUT/browser/adguard-tracking.txt" https://filters.adtidy.org/extension/ublock/filters/3.txt
H=https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/adblock
for n in light multi pro pro.plus ultimate tif anti.piracy; do dl "$OUT/dns/hagezi-$n.txt" "$H/$n.txt"; done
dl "$OUT/dns/oisd-small.txt" https://small.oisd.nl/
dl "$OUT/dns/oisd-big.txt" https://big.oisd.nl/
dl "$OUT/dns/stevenblack-hosts.txt" https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts
dl "$OUT/dns/adguard-dns.txt" https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt
for n in torrent piracy tracking ads abuse; do dl "$OUT/dns/blp-$n.txt" "https://blocklistproject.github.io/Lists/$n.txt"; done
