#!/bin/bash
# Updates one tree using main's engine scripts in the host-only folder, before any session.
# ENGINE_TAG comes through the environment, never through shell interpolation of issue text.
# Only a published release of AWML's own repository is used, whatever AWML_SOURCE says.
# The native awml runs on the host to rewrite fixtures: release code from the maintainer's own
# repository, which the existing engine build already trusts to compile. No tree script runs.
#
#   ENGINE_TAG=vX.Y.Z engine-update-for.sh TREE DIR
# DIR, in the host-only folder, holds main's scripts and a plain copy of the tree's fixtures.
set -euo pipefail

tree="$1"
dir="$2"
tag="${ENGINE_TAG:-}"
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "The engine update needs one release tag of the form vX.Y.Z." >&2
  exit 1
fi

# Check before copying or writing, as engine-for.sh does. Fixtures are read and rewritten too,
# so every entry in them must be a plain file or folder, including their parents in the tree.
for folder in vendor vendor/awml test test/fixtures; do
  if [ ! -d "$tree/$folder" ] || [ -L "$tree/$folder" ]; then
    echo "$folder isn't a plain folder, so no engine is updated there." >&2
    exit 1
  fi
  case "$(realpath -e -- "$tree/$folder")/" in
    "$(realpath -e -- "$tree")"/*) ;;
    *) echo "$folder isn't inside the tree, so no engine is updated there." >&2; exit 1 ;;
  esac
done
for file in version.json awml.js awml.wasm wasm_exec.js build.json; do
  if [ -L "$tree/vendor/awml/$file" ]; then
    echo "vendor/awml/$file is a link, so no engine is updated there." >&2
    exit 1
  fi
done
for file in version.json awml.js; do
  if [ ! -f "$tree/vendor/awml/$file" ]; then
    echo "vendor/awml/$file isn't a plain file, so no engine is updated there." >&2
    exit 1
  fi
done
if [ -n "$(find "$tree/test/fixtures" ! -type f ! -type d -print -quit)" ]; then
  echo "test/fixtures holds something other than plain files and folders, so no engine is updated there." >&2
  exit 1
fi

if ! gh api "repos/chrismdp/awml/releases/tags/$tag" |
  jq -e --arg tag "$tag" '.tag_name == $tag and .draft == false' > /dev/null; then
  echo "$tag isn't a published release of chrismdp/awml, so no engine is updated." >&2
  exit 1
fi

rm -rf -- "$dir"
mkdir -p -- "$dir/scripts" "$dir/vendor/awml" "$dir/test"
cp -- "$HOST_DIR/engine/scripts/engine-update.sh" "$HOST_DIR/engine/scripts/engine-build.sh" \
  "$HOST_DIR/engine/scripts/engine-lib.sh" "$HOST_DIR/engine/scripts/engine-pin.mjs" "$dir/scripts/"
cp -R -- "$tree/test/fixtures" "$dir/test/"
env -u AWML_SOURCE_DIR AWML_SOURCE=https://github.com/chrismdp/awml.git bash "$dir/scripts/engine-update.sh" "$tag"
cp -- "$dir/vendor/awml/"{version.json,awml.js,awml.wasm,wasm_exec.js,build.json} "$tree/vendor/awml/"
rm -rf -- "$tree/test/fixtures"
cp -R -- "$dir/test/fixtures" "$tree/test/"
