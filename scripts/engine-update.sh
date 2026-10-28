#!/usr/bin/env bash
# Moves the registry to another AWML release (issue #73). It pins, in
# vendor/awml/version.json, the release's tag and commit, the Go release its
# go.mod names with the SHA-256 go.dev lists for each machine's archive, and,
# once it has built them, the SHA-256 of awml.js and of the two files the build
# writes. It takes the release's JavaScript wrapper of the WebAssembly as
# vendor/awml/awml.js, builds the engine with scripts/engine-build.sh, and
# rewrites the test fixtures that hold what the native `awml` prints, so the
# tests compare the registry with the CLI. A person reviews the new pin in the
# pull request; every other run checks against it. The WebAssembly itself is
# never kept in git: every machine builds it from the pin.
# Usage: npm run engine:update -- <tag>, such as v0.7.1
# AWML_SOURCE names another place to fetch AWML from, such as a local clone.
set -euo pipefail

tag="${1:?usage: npm run engine:update -- <tag>, such as v0.7.1}"
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: npm run engine:update -- <tag>, such as v0.7.1" >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/vendor/awml"
fixtures="$root/test/fixtures"
# shellcheck source=scripts/engine-lib.sh
source "$root/scripts/engine-lib.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

src="$tmp/source"
awml_fetch "$tag" "$src" > "$tmp/fetched"
commit=$(cat "$tmp/fetched")
mkdir -p "$out"
pin pin "$tag" "$commit" "$src"
wrapper_of "$src" > "$out/awml.js"
AWML_SOURCE_DIR="$src" bash "$root/scripts/engine-build.sh" --record

# The native CLI, from the same source and with the same Go.
go=$(pin go)
(cd "$src" && GOTOOLCHAIN=local "$go" build -trimpath -ldflags="-X main.version=${tag#v}" -o "$tmp/awml" ./cmd/awml)

# What the native CLI says, for the tests to compare against: a 0.7 workflow,
# its graph as its design and as its home implementation; AWML's own file with
# mistakes, the registry's, fixtures/bad-07.yaml, its file with a warning,
# fixtures/warning-07.yaml, and every check of its file with the four
# warnings AWML 0.7 added, fixtures/loose-ends.yaml. Then the bakery's two
# workflows, one of which starts the other with an outside action, and the
# graph of their map.
cp "$src/examples/dinners.yaml" "$src/examples/bakery-stock.yaml" "$src/examples/bakery-order.yaml" "$src/wasm/testdata/bad.yaml" "$fixtures/"
(cd "$fixtures" && "$tmp/awml" summary --json dinners.yaml > dinners.summary.json)
(cd "$fixtures" && { "$tmp/awml" check bad.yaml || true; } > bad.check.txt)
(cd "$fixtures" && { "$tmp/awml" check bad-07.yaml || true; } > bad-07.check.txt)
(cd "$fixtures" && "$tmp/awml" check warning-07.yaml > warning-07.check.txt)
(cd "$fixtures" && "$tmp/awml" check --json loose-ends.yaml > loose-ends.checks.json)
(cd "$fixtures" && "$tmp/awml" graph dinners.yaml > dinners.graph.json)
(cd "$fixtures" && "$tmp/awml" graph --implementation home dinners.yaml > dinners-home.graph.json)
(cd "$fixtures" && "$tmp/awml" graph bakery-stock.yaml bakery-order.yaml > bakery-map.graph.json)

# The registry's own factory, kept in fixtures/flow/chrismdp: an issue becomes
# a pull request, which lands once CI has run, and a failed build tries again,
# each at the path the registry gives it, so the refs between them are
# followed. The graph of the first, and of the map of the three.
(cd "$fixtures/flow" && "$tmp/awml" graph chrismdp/issue-to-pull-request.yaml > issue-to-pull-request.graph.json)
(cd "$fixtures/flow" && "$tmp/awml" graph chrismdp/issue-to-pull-request.yaml chrismdp/land-a-pull-request.yaml chrismdp/retry-a-build.yaml > factory-map.graph.json)

# Versions stored in an AWML the registry no longer takes, kept in
# fixtures/older as they were pushed: a 0.4 workflow, a 0.5 one, a 0.5
# platform description, and a 0.6 workflow whose do step leads into another
# workflow's trigger, which 0.7 makes an outside action. The registry converts
# each when it reads it, so this is what the native CLI says of each file once
# `awml convert` has upgraded it. Converting the 0.6 one notes what to do by
# hand, so convert exits 1 and still writes the whole file; its notes are kept.
older="$fixtures/older"
mkdir -p "$tmp/older"
for file in dinners-04 client-email-05 scripts-mac-mini-05; do
  "$tmp/awml" convert "$older/$file.yaml" > "$tmp/older/$file.yaml"
done
{ "$tmp/awml" convert "$older/bakery-stock-06.yaml" 2> "$older/bakery-stock-06.convert.txt" || true; } > "$tmp/older/bakery-stock-06.yaml"
(cd "$tmp/older" && "$tmp/awml" check --json bakery-stock-06.yaml > "$older/bakery-stock-06.checks-now.json")
(cd "$tmp/older" && "$tmp/awml" graph bakery-stock-06.yaml > "$older/bakery-stock-06.graph.json")
(cd "$tmp/older" && "$tmp/awml" check --json dinners-04.yaml > "$older/dinners-04.checks-now.json")
(cd "$tmp/older" && "$tmp/awml" graph dinners-04.yaml > "$older/dinners-04.graph.json")
(cd "$tmp/older" && "$tmp/awml" graph --implementation home dinners-04.yaml > "$older/dinners-04-home.graph.json")
(cd "$tmp/older" && { "$tmp/awml" fit --json dinners-04.yaml scripts-mac-mini-05.yaml || true; } > "$older/dinners-04.fit.json")
(cd "$tmp/older" && "$tmp/awml" check --json client-email-05.yaml > "$older/client-email-05.checks-now.json")
(cd "$tmp/older" && "$tmp/awml" graph client-email-05.yaml > "$older/client-email-05.graph.json")
(cd "$tmp/older" && "$tmp/awml" graph --implementation office client-email-05.yaml > "$older/client-email-05-office.graph.json")
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
(cd "$tmp/legacy" && "$tmp/awml" graph dinners-security.yaml > "$legacy/dinners-security.graph.json")
"$tmp/awml" convert "$legacy/bin-day-security.yaml" "$legacy/bin-day-platform.yaml" > "$tmp/legacy/bin-day.yaml"
(cd "$tmp/legacy" && "$tmp/awml" graph --implementation default bin-day.yaml > "$legacy/bin-day-platform.graph.json")

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

echo "vendor/awml now pins awml $tag ($commit)"
