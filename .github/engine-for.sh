#!/bin/bash
# Builds the AWML engine a session needs, which npm ci --ignore-scripts doesn't, into one tree, from
# that tree's own pin, vendor/awml/version.json, and awml.js, which can differ from main's when main
# moved since the branch was cut: the engine loads only if it matches the pin beside it. The build
# is main's copy of the build script, kept in the host-only folder's engine/scripts, never the tree's
# own, and runs outside the sandbox before any session: a go build of the pinned commit runs no
# code here, and the WebAssembly runs only inside the sandbox. The source is AWML's own repository,
# whatever the environment says, and the build keeps only files with the SHA-256 the pin names.
# The branch's tree could carry links where it reads and writes, so vendor and vendor/awml must be
# plain folders inside the tree, and no file it reads or writes there a link.
#
#   engine-for.sh TREE DIR   # DIR, in the host-only folder, holds the build; its files go to TREE
#
# Needs what main's build script needs.
set -euo pipefail

tree="$1"
dir="$2"
awml="https://github.com/chrismdp/awml.git"
for folder in vendor vendor/awml; do
  if [ ! -d "$tree/$folder" ] || [ -L "$tree/$folder" ]; then
    echo "$folder isn't a plain folder, so no engine is built there." >&2
    exit 1
  fi
done
case "$(realpath -m -- "$tree/vendor/awml")/" in
  "$(realpath -e -- "$tree")"/*) ;;
  *) echo "vendor/awml isn't inside the tree, so no engine is built there." >&2; exit 1 ;;
esac
for file in awml.wasm wasm_exec.js build.json; do
  if [ -L "$tree/vendor/awml/$file" ]; then
    echo "vendor/awml/$file is a link, so no engine is built there." >&2
    exit 1
  fi
done
for file in version.json awml.js; do
  if [ ! -f "$tree/vendor/awml/$file" ] || [ -L "$tree/vendor/awml/$file" ]; then
    echo "vendor/awml/$file isn't a plain file, so no engine is built from it." >&2
    exit 1
  fi
done
rm -rf -- "$dir"
mkdir -p -- "$dir/scripts" "$dir/vendor/awml"
cp -- "$HOST_DIR/engine/scripts/engine-build.sh" "$HOST_DIR/engine/scripts/engine-lib.sh" "$HOST_DIR/engine/scripts/engine-pin.mjs" "$dir/scripts/"
cp -- "$tree/vendor/awml/version.json" "$tree/vendor/awml/awml.js" "$dir/vendor/awml/"
env -u AWML_SOURCE_DIR AWML_SOURCE="$awml" bash "$dir/scripts/engine-build.sh"
cp -- "$dir/vendor/awml/awml.wasm" "$dir/vendor/awml/wasm_exec.js" "$dir/vendor/awml/build.json" "$tree/vendor/awml/"
