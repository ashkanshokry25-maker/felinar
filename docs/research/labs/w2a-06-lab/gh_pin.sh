#!/bin/zsh
# usage: gh_pin.sh owner/repo[@tag] ... -> "owner/repo tag date commit" (dereferences annotated tags; unauthenticated GitHub API via Apple curl)
api() { curl -s --max-time 20 -H 'Accept: application/vnd.github+json' -H 'User-Agent: w2a06-research' "https://api.github.com/$1"; }
for spec in "$@"; do
  r="${spec%%@*}"; tag=""; [[ "$spec" == *@* ]] && tag="${spec#*@}"
  if [ -z "$tag" ]; then rel=$(api "repos/$r/releases/latest"); tag=$(print -r -- "$rel" | jq -r '.tag_name // empty'); pub=$(print -r -- "$rel" | jq -r '.published_at // empty'); else rel=$(api "repos/$r/releases/tags/$tag"); pub=$(print -r -- "$rel" | jq -r '.published_at // empty'); fi
  if [ -z "$tag" ]; then print -r -- "$r NO-RELEASE $(print -r -- "$rel" | jq -r '.message // "?"' | head -c 90)"; continue; fi
  ref=$(api "repos/$r/git/ref/tags/$tag"); typ=$(print -r -- "$ref" | jq -r '.object.type // empty'); sha=$(print -r -- "$ref" | jq -r '.object.sha // empty')
  if [ "$typ" = "tag" ]; then sha=$(api "repos/$r/git/tags/$sha" | jq -r '.object.sha // empty'); fi
  printf '%s %s %s %s\n' "$r" "$tag" "${pub:0:10}" "$sha"
done
