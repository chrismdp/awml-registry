# What scripts/engine-build.sh and scripts/engine-update.sh share. Sourced, not run.

# Where AWML's source is fetched from: its repository, or AWML_SOURCE, such as a
# local clone, for a machine that can't reach GitHub.
AWML_SOURCE="${AWML_SOURCE:-https://github.com/chrismdp/awml.git}"

# pin ARGS...: scripts/engine-pin.mjs, which reads and writes the pin,
# vendor/awml/version.json, and fetches the pinned Go.
pin() {
  node "$root/scripts/engine-pin.mjs" "$@"
}

# awml_fetch TAG DIR: AWML's source at TAG, fetched into DIR, a new folder.
# Prints the commit TAG names.
awml_fetch() {
  local tag="$1" dir="$2"
  git init -q "$dir"
  git -C "$dir" fetch -q --depth 1 "$AWML_SOURCE" "refs/tags/$tag:refs/tags/$tag"
  git -C "$dir" -c advice.detachedHead=false checkout -q "refs/tags/$tag"
  git -C "$dir" rev-parse HEAD
}

# wrapper_of DIR: AWML's JavaScript wrapper of its WebAssembly, from the source
# in DIR, as vendor/awml/awml.js holds it, with the Go shim beside it.
wrapper_of() {
  sed 's#"../build/wasm_exec.js"#"./wasm_exec.js"#' "$1/wasm/awml.js"
}
