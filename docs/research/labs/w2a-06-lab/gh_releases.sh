#!/bin/zsh
# latest release tag, date and DEREFERENCED commit sha per action repo (unauthenticated GitHub API via Apple curl)
api() { curl -s --max-time 15 -H 'Accept: application/vnd.github+json' -H 'User-Agent: w2a06-research' "https://api.github.com/$1"; }
for r in "$@"; do
  rel=$(api "repos/$r/releases/latest")
  tag=$(print -r -- "$rel" | jq -r '.tag_name // empty'); pub=$(print -r -- "$rel" | jq -r '.published_at // empty')
  if [ -z "$tag" ]; then print -r -- "$r  NO-LATEST-RELEASE ($(print -r -- "$rel" | jq -r '.message // "?"' | head -c 80))"; continue; fi
  ref=$(api "repos/$r/git/ref/tags/$tag"); typ=$(print -r -- "$ref" | jq -r '.object.type'); sha=$(print -r -- "$ref" | jq -r '.object.sha')
  if [ "$typ" = "tag" ]; then sha=$(api "repos/$r/git/tags/$sha" | jq -r '.object.sha'); fi
  printf '%-45s %-10s %s  %s\n' "$r" "$tag" "${pub:0:10}" "$sha"
done
