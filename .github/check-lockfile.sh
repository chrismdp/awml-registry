#!/bin/bash
# Refuses a tree whose lockfile could make npm run code on the host. npm ci packs a git dependency
# and runs its prepare script even with scripts off, so before any npm ci beside the Claude token
# the tree's package-lock.json must be version 2 or later, and every package in it must come from
# npm's registry with its integrity; a link to a folder of the tree itself, and a package bundled
# inside another, are the only ones without.
#
#   check-lockfile.sh TREE
set -euo pipefail

lock="$1/package-lock.json"
if [ ! -f "$lock" ] || [ -L "$lock" ]; then
  echo "The tree has no lockfile, so npm won't install it here." >&2
  exit 1
fi
if ! jq -e '
    (.lockfileVersion | type == "number" and . >= 2) and
    (.packages | type == "object") and
    all(.packages | to_entries[] | select(.key != "") | .value;
      .link == true or .inBundle == true or
      ((.resolved | type == "string" and startswith("https://registry.npmjs.org/")) and
       (.integrity | type == "string" and length > 0)))' "$lock" > /dev/null 2>&1; then
  echo "The lockfile names a package from somewhere other than npm's registry, or without its integrity, so npm won't install it here." >&2
  exit 1
fi
