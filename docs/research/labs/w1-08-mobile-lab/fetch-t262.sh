#!/bin/sh
# Downloads the tc39/test262 Uint8Array base64/hex tests (70 files) and the harness files they need into ./t262/.
# Source: https://github.com/tc39/test262 (BSD-licensed); fetched over raw.githubusercontent.com, not via git.
set -eu
cd "$(dirname "$0")"
R=https://raw.githubusercontent.com/tc39/test262/main
mkdir -p t262/tests t262/harness
while read -r f; do
  mkdir -p "t262/tests/$(dirname "$f")"
  curl -fsS -m 30 -o "t262/tests/$f" "$R/test/built-ins/Uint8Array/$f" &
done < t262-files.txt
wait
for h in assert.js sta.js propertyHelper.js compareArray.js detachArrayBuffer.js testTypedArray.js wellKnownIntrinsicObjects.js isConstructor.js nativeFunctionMatcher.js deepEqual.js; do
  curl -fsS -m 30 -o "t262/harness/$h" "$R/harness/$h" &
done
wait
echo "tests: $(find t262/tests -name '*.js' | wc -l | tr -d ' ') files, harness: $(ls t262/harness | wc -l | tr -d ' ') files"
