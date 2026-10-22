#!/usr/bin/env bash
# Makes the latest version of each workflow and platform AWML 0.4, through a
# registry's public API, for a registry that now takes only 0.4 files. Run it
# once, after deploying the registry that refuses older files.
#
# A workflow whose latest version is a 0.3 or 0.2 pair is joined into one file
# with `awml convert` and pushed as a new version. `awml convert` refuses a
# pair whose views differ in their parts or lines; such a workflow is listed,
# or with --keep-design its security view is pushed as the design alone, and
# its platform view stays in the version before. One that has only a
# security view is pushed as the design alone, its `awml:` set to "0.4", its
# `view:` line dropped and its `groups:` named `scopes:`, as `awml convert`
# writes a design. One that has only a platform view has no design to convert,
# and is listed for a person to deal with. A platform's description has its
# `awml:` set to "0.4" and is pushed with its install recipe. Every file is
# checked with `awml check` before it is pushed, and nothing already 0.4 is
# touched, so running it twice pushes nothing new.
#
# It finds the workflows and platforms through the registry's MCP tools: the
# workflows of the owners named, or with none named, the token's person's own
# and their organisations'; and the platforms of the owners named, or every
# platform the person may see. A push only works for an owner the person may
# push to, and each that doesn't is listed.
#
# Usage: AWML_TOKEN=awml_... scripts/convert-to-04.sh [--dry-run] [--keep-design] [--registry URL] [--awml PATH] [OWNER...]
#   --dry-run   convert and check, but push nothing
#   --keep-design  push the design alone when awml convert refuses a pair
#   --registry  the registry, by default $AWML_REGISTRY_URL or https://awml.io
#   --awml      the awml command to convert and check with, built from the same
#               AWML the registry runs (vendor/awml/VERSION); by default awml
set -euo pipefail

dry_run=false
keep_design=false
registry=${AWML_REGISTRY_URL:-https://awml.io}
awml=awml
owners=()
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry_run=true ;;
    --keep-design) keep_design=true ;;
    --registry) registry=${2:?--registry needs a URL}; shift ;;
    --awml) awml=${2:?--awml needs a path}; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "convert-to-04: unknown option $1" >&2; exit 2 ;;
    *) owners+=("$1") ;;
  esac
  shift
done
: "${AWML_TOKEN:?set AWML_TOKEN to a registry token from $registry/settings/tokens}"
registry=${registry%/}
command -v jq >/dev/null || { echo "convert-to-04: needs jq" >&2; exit 2; }
"$awml" convert --help >/dev/null 2>&1 || { echo "convert-to-04: $awml has no convert; build awml 0.4" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pushed=0 skipped=0 failed=0

# One MCP tool's structured answer.
tool() {
  local response
  response=$(curl -sS --fail-with-body -X POST "$registry/mcp" \
    -H "authorization: Bearer $AWML_TOKEN" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -H "mcp-protocol-version: 2025-06-18" \
    -d "$(jq -n --arg name "$1" --argjson args "$2" '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $name, arguments: $args}}')")
  # Sent as JSON, or as server-sent events whose last data line is the answer.
  if [ "${response:0:1}" != "{" ]; then response=$(printf '%s\n' "$response" | sed -n 's/^data: *//p' | tail -1); fi
  if [ "$(jq -r '.result.isError // false' <<<"$response")" = true ] || [ "$(jq -r 'has("error")' <<<"$response")" = true ]; then
    echo "convert-to-04: $1: $(jq -r '.error.message // (.result.content | map(.text) | join(" "))' <<<"$response")" >&2
    return 1
  fi
  jq '.result.structuredContent' <<<"$response"
}

api() {
  curl -sS --fail-with-body -H "authorization: Bearer $AWML_TOKEN" "$registry/api/v1/$1"
}

# Pushes a JSON body to an API path, or in a dry run says it would.
push() {
  local name=$1 path=$2 body=$3 response
  if $dry_run; then
    echo "$name: would push a new version"
    pushed=$((pushed + 1))
    return
  fi
  if response=$(curl -sS --fail-with-body -X POST "$registry/api/v1/$path" \
    -H "authorization: Bearer $AWML_TOKEN" -H "content-type: application/json" -d "$body"); then
    echo "$name: pushed version $(jq -r .number <<<"$response")"
    pushed=$((pushed + 1))
  else
    echo "$name: not pushed: $(jq -r '.errors // [.] | join(" ")' <<<"$response" 2>/dev/null || echo "$response")"
    failed=$((failed + 1))
  fi
}

skip() {
  echo "$1: $2"
  skipped=$((skipped + 1))
}

# A legacy security view as a 0.4 design, as `awml convert` writes one.
design() {
  sed -E -e 's/^awml: *"?0\.[23]"? *$/awml: "0.4"/' -e '/^view: *security *$/d' -e 's/^groups:/scopes:/' "$1"
}

# Whether the version just read has the file named.
has() {
  [ "$(jq -r --arg f "$1" '.files[$f] != null' <<<"$version")" = true ]
}

# The workflows, as owner/slug.
if [ ${#owners[@]} -eq 0 ]; then
  workflows=$(tool list '{}' | jq -r '.workflows[] | "\(.owner)/\(.slug)"')
else
  workflows=$(for owner in "${owners[@]}"; do tool list "$(jq -n --arg owner "$owner" '{owner: $owner}')" | jq -r '.workflows[] | "\(.owner)/\(.slug)"'; done)
fi

for name in $workflows; do
  latest=$(api "$name" | jq -r '[.versions[].number] | max')
  version=$(api "$name/v/$latest")
  files="$work/${name//\//-}"
  mkdir -p "$files"
  if has workflow; then
    skip "$name v$latest" "already AWML 0.4"
    continue
  fi
  jq -r '.files.security // empty' <<<"$version" > "$files/security.yaml"
  jq -r '.files.platform // empty' <<<"$version" > "$files/platform.yaml"
  if has security && has platform && "$awml" convert "$files/security.yaml" "$files/platform.yaml" > "$files/workflow.yaml" 2> "$files/convert.txt"; then
    how="joined its pair with awml convert"
  elif has security && has platform && ! $keep_design; then
    skip "$name v$latest" "awml convert refused the pair: $(head -1 "$files/convert.txt"), and $(($(wc -l < "$files/convert.txt") - 1)) more"
    continue
  elif has security; then
    design "$files/security.yaml" > "$files/workflow.yaml"
    how="made its security view the design"
    if has platform; then how="$how, since awml convert refused the pair: $(head -1 "$files/convert.txt")"; fi
  else
    skip "$name v$latest" "has only a platform view, so there is no design to convert"
    continue
  fi
  if ! "$awml" check "$files/workflow.yaml" > "$files/check.txt" 2>&1; then
    skip "$name v$latest" "the converted file has mistakes: $(grep -v ': ok$' "$files/check.txt" | tr '\n' ' ')"
    continue
  fi
  echo "$name v$latest: $how"
  push "$name" "$name/versions" "$(jq -n --rawfile workflow "$files/workflow.yaml" '{workflow: $workflow}')"
done

# The platforms, as owner/slug.
platforms=$(tool search_platforms '{}' | jq -r '.platforms[] | "\(.owner)/\(.slug)"')
for name in $platforms; do
  if [ ${#owners[@]} -gt 0 ] && ! printf '%s\n' "${owners[@]}" | grep -qx "${name%%/*}"; then continue; fi
  latest=$(api "platforms/$name")
  number=$(jq -r .number <<<"$latest")
  file="$work/platform-${name//\//-}.yaml"
  jq -r .description <<<"$latest" > "$file"
  if grep -qE '^awml: *"?0\.4"? *$' "$file"; then
    skip "platform $name v$number" "already AWML 0.4"
    continue
  fi
  sed -i.old -E 's/^awml: *"?0\.[23]"? *$/awml: "0.4"/' "$file"
  if ! "$awml" check "$file" > "$file.check" 2>&1; then
    skip "platform $name v$number" "the description has mistakes: $(tr '\n' ' ' < "$file.check")"
    continue
  fi
  echo "platform $name v$number: marked AWML 0.4"
  push "platform $name" "platforms/$name/versions" \
    "$(jq -n --rawfile description "$file" --argjson recipe "$(jq .recipe <<<"$latest")" '{description: $description, recipe: $recipe}')"
done

echo "$($dry_run && echo "Would push" || echo "Pushed") $pushed, skipped $skipped, failed $failed."
[ "$failed" -eq 0 ]
