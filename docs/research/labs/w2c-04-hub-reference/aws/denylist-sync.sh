#!/usr/bin/env bash
# Apply a denylist file to the CloudFront KeyValueStore read by edge.js.
#   ./denylist-sync.sh <kvs-arn> <denylist.tsv> [--dry-run]
# denylist.tsv: one "<label><TAB><reason>" per line; '#' starts a comment. label = 32 lower-case base32 chars (ARCHITECTURE.md v0.2 section 3.2).
# Takes effect at the edge in seconds to minutes (KVS propagation is not instant: monitor with the status ping).
# Env: MW_CURRENT_JSON=<file>  use this JSON ({"Items":[{"Key":..,"Value":..}]}) instead of calling AWS (for --dry-run tests).
set -euo pipefail
kvs=${1:?kvs arn}; tsv=${2:?denylist.tsv}; dry=${3:-}
re='^[a-z2-7]{32}$'

desired=$(awk -F'\t' '!/^[[:space:]]*(#|$)/ {print $1 "\t" $2}' "$tsv" \
  | jq -R -s --arg re "$re" '
      split("\n") | map(select(length>0) | split("\t")) |
      map(if (.[0] | test($re)) then {key: .[0], value: (.[1] // "listed")} else error("bad label: " + .[0]) end) |
      from_entries')

if [ -n "${MW_CURRENT_JSON:-}" ]; then current_json=$(cat "$MW_CURRENT_JSON")
else current_json=$(aws cloudfront-keyvaluestore list-keys --kvs-arn "$kvs" --output json); fi
current=$(jq '(.Items // []) | map({key: .Key, value: .Value}) | from_entries' <<<"$current_json")

puts=$(jq -n --argjson d "$desired" --argjson c "$current" \
  '$d | to_entries | map(select($c[.key] != .value)) | map({Key: .key, Value: .value})')
dels=$(jq -n --argjson d "$desired" --argjson c "$current" \
  '$c | keys | map(select($d[.] == null)) | map({Key: .})')
echo "puts: $(jq length <<<"$puts"), deletes: $(jq length <<<"$dels")"
[ "$dry" = "--dry-run" ] && { jq -n --argjson p "$puts" --argjson d "$dels" '{puts:$p, deletes:$d}'; exit 0; }

# update-keys is all-or-nothing per call and needs the CURRENT ETag; do <=50 changes per call (service limit).
apply() { # apply <puts-json> <deletes-json>
  etag=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$kvs" --query ETag --output text)
  args=(--kvs-arn "$kvs" --if-match "$etag")
  [ "$(jq length <<<"$1")" -gt 0 ] && args+=(--puts "$1")
  [ "$(jq length <<<"$2")" -gt 0 ] && args+=(--deletes "$2")
  aws cloudfront-keyvaluestore update-keys "${args[@]}" >/dev/null
}
n=$(jq length <<<"$puts"); for ((i=0; i<n; i+=50)); do apply "$(jq -c ".[$i:$((i+50))]" <<<"$puts")" '[]'; done
n=$(jq length <<<"$dels"); for ((i=0; i<n; i+=50)); do apply '[]' "$(jq -c ".[$i:$((i+50))]" <<<"$dels")"; done
echo "synced"
