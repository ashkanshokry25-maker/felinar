#!/bin/zsh
# usage: fetch.sh <url> <outname>   -> saves into verify/dl/<outname>, appends to verify/dl/MANIFEST.tsv
S=/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/verify
url="$1"; name="$2"
code=$(curl -sSL -m 90 -A 'Mozilla/5.0 (verification fetch)' -o "$S/dl/$name" -w '%{http_code}' "$url" 2>"$S/dl/$name.err")
size=$(stat -f%z "$S/dl/$name" 2>/dev/null || echo 0)
sha=$(shasum -a 256 "$S/dl/$name" 2>/dev/null | cut -c1-16)
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$code" "$size" "$sha" "$name" "$url" >> "$S/dl/MANIFEST.tsv"
echo "$code $size $name"
