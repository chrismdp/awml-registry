#!/usr/bin/env bash
# Rebuilds vendor/awml from an AWML checkout: the WebAssembly build of the Go
# package, Go's wasm_exec.js, the JS wrapper, and a VERSION file. It also
# rewrites the test fixtures that hold what the native `awml` prints, so the
# tests compare the registry with the CLI. Nothing is written to the checkout.
# Usage: npm run engine:update -- /path/to/awml
set -euo pipefail

src=$(cd "${1:?usage: npm run engine:update -- /path/to/awml}" && pwd)
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/vendor/awml"
fixtures="$root/test/fixtures"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$src" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$tmp/awml.wasm" ./cmd/awml-wasm)
(cd "$src" && go build -o "$tmp/awml" ./cmd/awml)

shim="$(go env GOROOT)/lib/wasm/wasm_exec.js"
test -f "$shim" || shim="$(go env GOROOT)/misc/wasm/wasm_exec.js"

mkdir -p "$out"
cp "$tmp/awml.wasm" "$out/awml.wasm"
cp "$shim" "$out/wasm_exec.js"
sed 's#"../build/wasm_exec.js"#"./wasm_exec.js"#' "$src/wasm/awml.js" > "$out/awml.js"

commit=$(git -C "$src" rev-parse HEAD)
dirty=$(git -C "$src" status --porcelain -- '*.go' go.mod go.sum cmd wasm | grep -q . && echo " (with uncommitted changes)" || true)
{
  echo "awml $commit$dirty"
  echo "built with $(go version | cut -d' ' -f3)"
  echo "from https://github.com/chrismdp/awml"
} > "$out/VERSION"

# What the native CLI says, for the tests to compare against.
cp "$src/examples/dinners-security.yaml" "$src/examples/dinners-platform.yaml" "$src/wasm/testdata/bad.yaml" "$fixtures/"
(cd "$fixtures" && "$tmp/awml" summary --json dinners-security.yaml > dinners-security.summary.json)
(cd "$fixtures" && "$tmp/awml" summary --json dinners-platform.yaml > dinners-platform.summary.json)
(cd "$fixtures" && "$tmp/awml" summary --json dinners-security.yaml dinners-platform.yaml > dinners.summary.json)
(cd "$fixtures" && { "$tmp/awml" check bad.yaml || true; } > bad.check.txt)
(cd "$fixtures" && "$tmp/awml" draw dinners-security.yaml > dinners-security.mmd)

# The fit: a workflow that says what it needs, AWML's example platforms, and
# what `awml fit --json` says of them; and the gaps it finds in a workflow
# that doesn't say.
rm -rf "$fixtures/platforms"
mkdir -p "$fixtures/platforms"
cp "$src/examples/client-email.yaml" "$fixtures/"
cp "$src/examples/platforms/"*.yaml "$fixtures/platforms/"
(cd "$fixtures" && "$tmp/awml" fit --json client-email.yaml platforms/*.yaml > client-email.fit.json)
(cd "$fixtures" && { "$tmp/awml" fit --json dinners-security.yaml platforms/worker.yaml || true; } > dinners.fit.json)

echo "vendor/awml now holds $(head -1 "$out/VERSION")"
