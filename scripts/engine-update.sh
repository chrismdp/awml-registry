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
# The same, for the registry to name: the release it was built from, or the
# nearest one and how far past it, and the commit.
printf '{ "tag": "%s", "commit": "%s" }\n' "$(git -C "$src" describe --tags --always "$commit")$dirty" "$commit" > "$out/version.json"

# What the native CLI says, for the tests to compare against: a 0.5 workflow,
# drawn as its design and as its home implementation; AWML's own file with
# mistakes, the registry's 0.4 one, fixtures/bad-04.yaml, and its 0.4 file
# with a warning, fixtures/warning-04.yaml.
cp "$src/examples/dinners.yaml" "$src/wasm/testdata/bad.yaml" "$fixtures/"
(cd "$fixtures" && "$tmp/awml" summary --json dinners.yaml > dinners.summary.json)
(cd "$fixtures" && { "$tmp/awml" check bad.yaml || true; } > bad.check.txt)
(cd "$fixtures" && { "$tmp/awml" check bad-04.yaml || true; } > bad-04.check.txt)
(cd "$fixtures" && "$tmp/awml" check warning-04.yaml > warning-04.check.txt)
(cd "$fixtures" && "$tmp/awml" draw dinners.yaml > dinners.mmd)
(cd "$fixtures" && "$tmp/awml" draw --implementation home dinners.yaml > dinners-home.mmd)

# The same workflow marked 0.4, which the registry still takes, and what the
# native CLI draws and checks of it. It uses nothing 0.5 added.
sed 's/^awml: "0\.5"$/awml: "0.4"/' "$fixtures/dinners.yaml" > "$fixtures/dinners-04.yaml"
grep -q '^awml: "0.4"$' "$fixtures/dinners-04.yaml"
(cd "$fixtures" && "$tmp/awml" check dinners-04.yaml > dinners-04.check.txt)
(cd "$fixtures" && "$tmp/awml" draw dinners-04.yaml > dinners-04.mmd)

# Versions stored before the registry took only 0.4 files: a 0.2 pair and a
# 0.3 security view, kept in fixtures/legacy, and what this AWML says of them.
legacy="$fixtures/legacy"
(cd "$legacy" && "$tmp/awml" summary --json dinners-security.yaml > dinners-security.summary.json)
(cd "$legacy" && "$tmp/awml" summary --json dinners-platform.yaml > dinners-platform.summary.json)
(cd "$legacy" && "$tmp/awml" summary --json dinners-security.yaml dinners-platform.yaml > dinners.summary.json)
(cd "$legacy" && "$tmp/awml" draw dinners-security.yaml > dinners-security.mmd)
(cd "$legacy" && "$tmp/awml" draw dinners-platform.yaml > dinners-platform.mmd)

# The fit: a workflow that says what it needs, AWML's example platforms
# marked 0.4, which the registry takes as it takes 0.5, and what
# `awml fit --json` says of them, for the design and for its office
# implementation; and the gaps it finds in a workflow that doesn't say.
rm -rf "$fixtures/platforms"
mkdir -p "$fixtures/platforms"
cp "$src/examples/client-email.yaml" "$fixtures/"
for description in "$src/examples/platforms/"*.yaml; do
  sed 's/^awml: "0\.3"$/awml: "0.4"/' "$description" > "$fixtures/platforms/$(basename "$description")"
done
(cd "$fixtures" && "$tmp/awml" fit --json client-email.yaml platforms/*.yaml > client-email.fit.json)
(cd "$fixtures" && "$tmp/awml" fit --json --implementation office client-email.yaml platforms/*.yaml > client-email-office.fit.json)
(cd "$fixtures" && { "$tmp/awml" fit --json dinners.yaml platforms/worker.yaml || true; } > dinners.fit.json)

echo "vendor/awml now holds $(head -1 "$out/VERSION")"
