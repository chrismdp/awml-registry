#!/usr/bin/env bash
# Builds the registry's AWML engine from AWML's source (issue #73): the Go
# package compiled to WebAssembly, vendor/awml/awml.wasm, and the Go shim that
# runs it, vendor/awml/wasm_exec.js. Neither is kept in git. It builds the
# commit vendor/awml/version.json pins, after checking that its tag names that
# commit, with the Go release AWML's go.mod names (scripts/engine-go.mjs).
# vendor/awml/build.json, beside them, records what was built; while it
# matches the pin and the files, the script does nothing.
#
# Usage: npm run engine:build
#        bash scripts/engine-build.sh --if-possible   (npm install runs this:
#        it says what to run, rather than failing, when it can't build)
#
# It needs git, node and tar, and to reach github.com (or AWML_SOURCE), go.dev
# and proxy.golang.org; a go on the PATH that is the release go.mod names is
# used, and otherwise that release is downloaded once and kept in a cache.
# AWML_SOURCE_DIR names a folder of AWML's source to build from in place of
# fetching it, which must be at the pinned commit; scripts/engine-update.sh
# passes its own.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/vendor/awml"
# shellcheck source=scripts/engine-lib.sh
source "$root/scripts/engine-lib.sh"

if [ "${1:-}" = "--if-possible" ]; then
  if ! bash "$0"; then
    echo "The AWML engine isn't built, so the registry can't check or draw a workflow yet. Run: npm run engine:build" >&2
  fi
  exit 0
fi

tag=$(pin_field tag)
commit=$(pin_field commit)
if [ -z "$tag" ] || [ -z "$commit" ]; then
  echo "vendor/awml/version.json must pin AWML's tag and commit" >&2
  exit 1
fi

stamp="$out/build.json"
if [ -f "$stamp" ] && [ -f "$out/awml.wasm" ] && [ -f "$out/wasm_exec.js" ] &&
  node -e '
    const [stamp, tag, commit, sha256] = process.argv.slice(1);
    const built = require(stamp);
    process.exit(built.tag === tag && built.commit === commit && built.sha256 === sha256 ? 0 : 1);
  ' "$stamp" "$tag" "$commit" "$(sha256_of "$out/awml.wasm")"; then
  echo "vendor/awml is built from awml $tag ($commit)"
  exit 0
fi

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

go=$(node "$root/scripts/engine-go.mjs" "$src")
goversion=$(GOTOOLCHAIN=local "$go" env GOVERSION)
goroot=$(GOTOOLCHAIN=local "$go" env GOROOT)
echo "Building awml $tag ($commit) to WebAssembly with $goversion"
(cd "$src" && GOTOOLCHAIN=local GOOS=js GOARCH=wasm CGO_ENABLED=0 "$go" build -trimpath -ldflags="-s -w -X main.version=${tag#v}" -o "$tmp/awml.wasm" ./cmd/awml-wasm)
shim="$goroot/lib/wasm/wasm_exec.js"
test -f "$shim" || shim="$goroot/misc/wasm/wasm_exec.js"

# Each file is written whole, then the stamp that says they match the pin. The
# WebAssembly names the release it was built from, as a release of awml does.
rm -f "$stamp"
cp "$shim" "$out/wasm_exec.js.new" && mv "$out/wasm_exec.js.new" "$out/wasm_exec.js"
cp "$tmp/awml.wasm" "$out/awml.wasm.new" && mv "$out/awml.wasm.new" "$out/awml.wasm"
printf '{ "tag": "%s", "commit": "%s", "go": "%s", "sha256": "%s" }\n' \
  "$tag" "$commit" "$goversion" "$(sha256_of "$out/awml.wasm")" > "$stamp"
echo "vendor/awml is built from awml $tag ($commit) with $goversion"
