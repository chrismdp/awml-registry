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

# What the native CLI says, for the tests to compare against: a 0.6 workflow,
# drawn as its design and as its home implementation; AWML's own file with
# mistakes, the registry's, fixtures/bad-06.yaml, and its file with a
# warning, fixtures/warning-06.yaml.
cp "$src/examples/dinners.yaml" "$src/wasm/testdata/bad.yaml" "$fixtures/"
(cd "$fixtures" && "$tmp/awml" summary --json dinners.yaml > dinners.summary.json)
(cd "$fixtures" && { "$tmp/awml" check bad.yaml || true; } > bad.check.txt)
(cd "$fixtures" && { "$tmp/awml" check bad-06.yaml || true; } > bad-06.check.txt)
(cd "$fixtures" && "$tmp/awml" check warning-06.yaml > warning-06.check.txt)
(cd "$fixtures" && "$tmp/awml" draw dinners.yaml > dinners.mmd)
(cd "$fixtures" && "$tmp/awml" draw --implementation home dinners.yaml > dinners-home.mmd)

# Versions stored in an AWML the registry no longer takes, kept in
# fixtures/older as they were pushed: a 0.4 workflow, a 0.5 one and a 0.5
# platform description. The registry converts each when it reads it, so this
# is what the native CLI says of each file once `awml convert` has upgraded it.
older="$fixtures/older"
mkdir -p "$tmp/older"
for file in dinners-04 client-email-05 scripts-mac-mini-05; do
  "$tmp/awml" convert "$older/$file.yaml" > "$tmp/older/$file.yaml"
done
(cd "$tmp/older" && "$tmp/awml" check --json dinners-04.yaml > "$older/dinners-04.checks-now.json")
(cd "$tmp/older" && "$tmp/awml" draw dinners-04.yaml > "$older/dinners-04.mmd")
(cd "$tmp/older" && "$tmp/awml" draw --implementation home dinners-04.yaml > "$older/dinners-04-home.mmd")
(cd "$tmp/older" && { "$tmp/awml" fit --json dinners-04.yaml scripts-mac-mini-05.yaml || true; } > "$older/dinners-04.fit.json")
(cd "$tmp/older" && "$tmp/awml" check --json client-email-05.yaml > "$older/client-email-05.checks-now.json")
(cd "$tmp/older" && "$tmp/awml" draw client-email-05.yaml > "$older/client-email-05.mmd")
(cd "$tmp/older" && "$tmp/awml" draw --implementation office client-email-05.yaml > "$older/client-email-05-office.mmd")
(cd "$tmp/older" && "$tmp/awml" fit --json client-email-05.yaml scripts-mac-mini-05.yaml > "$older/client-email-05.fit.json")
(cd "$tmp/older" && "$tmp/awml" fit --json --implementation office client-email-05.yaml scripts-mac-mini-05.yaml > "$older/client-email-05-office.fit.json")

# Versions stored before the registry took only 0.4 files, kept in
# fixtures/legacy with the summaries worked out when they were stored: two 0.2
# pairs and a 0.3 security view. A security view converts on its own, and a
# platform view only joined with its security view. The dinners pair's views
# differ, so its platform view does not convert; bin day's do, so its
# platform view is drawn from the one implementation they join into.
legacy="$fixtures/legacy"
mkdir -p "$tmp/legacy"
"$tmp/awml" convert "$legacy/dinners-security.yaml" > "$tmp/legacy/dinners-security.yaml"
(cd "$tmp/legacy" && "$tmp/awml" draw dinners-security.yaml > "$legacy/dinners-security.mmd")
"$tmp/awml" convert "$legacy/bin-day-security.yaml" "$legacy/bin-day-platform.yaml" > "$tmp/legacy/bin-day.yaml"
(cd "$tmp/legacy" && "$tmp/awml" draw --implementation default bin-day.yaml > "$legacy/bin-day-platform.mmd")

# The fit: a workflow that says what it needs, AWML's example platforms, and
# what `awml fit --json` says of them, for the design and for its office
# implementation; and the gaps it finds in a workflow that doesn't say.
rm -rf "$fixtures/platforms"
mkdir -p "$fixtures/platforms"
cp "$src/examples/client-email.yaml" "$fixtures/"
cp "$src/examples/platforms/"*.yaml "$fixtures/platforms/"
(cd "$fixtures" && "$tmp/awml" fit --json client-email.yaml platforms/*.yaml > client-email.fit.json)
(cd "$fixtures" && "$tmp/awml" fit --json --implementation office client-email.yaml platforms/*.yaml > client-email-office.fit.json)
(cd "$fixtures" && { "$tmp/awml" fit --json dinners.yaml platforms/worker.yaml || true; } > dinners.fit.json)

echo "vendor/awml now holds $(head -1 "$out/VERSION")"
