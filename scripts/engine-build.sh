#!/usr/bin/env bash
# Builds the registry's AWML engine from AWML's source (issue #73): the Go
# package compiled to WebAssembly, vendor/awml/awml.wasm, and the Go shim that
# runs it, vendor/awml/wasm_exec.js. Neither is kept in git. The pin,
# vendor/awml/version.json, names AWML's tag and full commit, the Go release to
# build with and the SHA-256 of its archive for each machine, and the SHA-256
# of awml.js and of both files the build writes. The script builds the pinned
# commit, after checking its tag names it, with that Go, and keeps the build
# only when both files have their pinned SHA-256. vendor/awml/build.json,
# beside them, stamps what was built; while the stamp and the files match the
# pin, the script does nothing. A build that doesn't match is deleted before
# building again, so a failed build leaves nothing to load.
#
# Usage: npm run engine:build
#        bash scripts/engine-build.sh --if-possible   (npm install runs this:
#        it says what to run, rather than failing, when it can't build)
#        bash scripts/engine-build.sh --record        (engine:update runs this:
#        it records the SHA-256 of what it builds in the pin)
#
# It needs git, node and tar, and to reach github.com (or AWML_SOURCE) and
# go.dev and proxy.golang.org, over https. The pinned Go is downloaded once and
# kept in a cache, never taken from the PATH, so every machine builds the same
# bytes. AWML_SOURCE_DIR names a folder of AWML's source to build from in place
# of fetching it, which must be at the pinned commit; scripts/engine-update.sh
# passes its own.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/vendor/awml"
# shellcheck source=scripts/engine-lib.sh
source "$root/scripts/engine-lib.sh"

if [ "${1:-}" = "--if-possible" ]; then
  if ! bash "$0"; then
    echo "The AWML engine could not be built (see above), so vendor/awml holds none the registry will load, and it can't check or draw a workflow until it is built. Run: npm run engine:build" >&2
  fi
  exit 0
fi
record=false
if [ "${1:-}" = "--record" ]; then
  record=true
fi

tag=$(pin field tag)
commit=$(pin field commit)
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "vendor/awml/version.json must pin a release tag, such as v0.9.0, and its full commit" >&2
  exit 1
fi
if ! $record; then
  pin check-pin
  if ! pin matches awml.js; then
    echo "vendor/awml/awml.js isn't the one vendor/awml/version.json pins. Run: npm run engine:update -- $tag" >&2
    exit 1
  fi
  if pin built; then
    echo "vendor/awml is built from awml $tag ($commit)"
    exit 0
  fi
fi

# Whatever is there doesn't match the pin, so it goes before anything else, and
# nothing stale is left to load if the build fails.
rm -f "$out/build.json" "$out/awml.wasm" "$out/wasm_exec.js"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
src="${AWML_SOURCE_DIR:-}"
if [ -z "$src" ]; then
  src="$tmp/awml"
  echo "Fetching awml $tag from $AWML_SOURCE"
  awml_fetch "$tag" "$src" > "$tmp/fetched"
  got=$(cat "$tmp/fetched")
else
  got=$(git -C "$src" rev-parse HEAD)
fi
if [ "$got" != "$commit" ]; then
  echo "awml's tag $tag names commit $got, but vendor/awml/version.json pins $commit" >&2
  exit 1
fi
if ! wrapper_of "$src" | cmp -s - "$out/awml.js"; then
  echo "vendor/awml/awml.js isn't awml $tag's wasm/awml.js. Run: npm run engine:update -- $tag" >&2
  exit 1
fi

go=$(pin go)
goversion=$(pin field go.version)
goroot=$(GOTOOLCHAIN=local "$go" env GOROOT)
echo "Building awml $tag ($commit) to WebAssembly with $goversion"
# The WebAssembly names the release it was built from, as a release of awml does.
(cd "$src" && GOTOOLCHAIN=local GOOS=js GOARCH=wasm CGO_ENABLED=0 "$go" build -trimpath -ldflags="-s -w -X main.version=${tag#v}" -o "$tmp/awml.wasm" ./cmd/awml-wasm)
shim="$goroot/lib/wasm/wasm_exec.js"
test -f "$shim" || shim="$goroot/misc/wasm/wasm_exec.js"

# Each file is written whole, then checked against the pin, then stamped.
cp "$shim" "$out/wasm_exec.js.new" && mv "$out/wasm_exec.js.new" "$out/wasm_exec.js"
cp "$tmp/awml.wasm" "$out/awml.wasm.new" && mv "$out/awml.wasm.new" "$out/awml.wasm"
if $record; then
  pin record awml.js awml.wasm wasm_exec.js
elif ! pin matches awml.wasm wasm_exec.js; then
  rm -f "$out/awml.wasm" "$out/wasm_exec.js"
  echo "The build of awml $tag doesn't have the SHA-256 vendor/awml/version.json pins for awml.wasm and wasm_exec.js, so it was deleted" >&2
  exit 1
fi
pin stamp
echo "vendor/awml is built from awml $tag ($commit) with $goversion"
