#!/bin/bash
# Refuses a tree whose lockfile could make npm run code on the host. npm ci packs a git dependency
# and runs its prepare script even with scripts off, so before any npm ci beside the Claude token
# the tree's package-lock.json must be the only lockfile npm reads, version 2 or later, and its flags are trusted no further than
# this, since the branch wrote them: every package with a source must come from npm's registry with
# its integrity, except a link, whose source must be a folder inside the tree; and a package with
# no source must be one bundled inside another, nested in that one's node_modules.
#
#   check-lockfile.sh TREE
set -euo pipefail

# npm reads npm-shrinkwrap.json before package-lock.json, yarn.lock beside them, and a hidden
# lockfile in node_modules; none is checked here, so a tree that holds any is refused.
if [ -e "$1/node_modules" ] || [ -n "$(find "$1" -path "$1/.git" -prune -o \( -name npm-shrinkwrap.json -o -name yarn.lock \) -print -quit)" ]; then
  echo "The tree holds an npm-shrinkwrap.json, a yarn.lock or node_modules, which npm would read, so npm won't install it here." >&2
  exit 1
fi
lock="$1/package-lock.json"
if [ ! -f "$lock" ] || [ -L "$lock" ]; then
  echo "The tree has no lockfile, so npm won't install it here." >&2
  exit 1
fi
if ! jq -e '
    def inside: type == "string" and length > 0 and (startswith("/") | not) and (test(":") | not) and
      (test("(^|/)\\.\\.(/|$)") | not);
    (.lockfileVersion | type == "number" and . >= 2) and
    (.packages | type == "object") and
    all(.packages | to_entries[] | select(.key != "");
      if .value | has("resolved") then
        if .value.link == true then .value.resolved | inside
        else (.value.resolved | type == "string" and startswith("https://registry.npmjs.org/")) and
          (.value.integrity | type == "string" and length > 0) end
      else
        .value.inBundle == true and (.key | test("^node_modules/.+/node_modules/"))
      end)' "$lock" > /dev/null 2>&1; then
  echo "The lockfile names a package from somewhere other than npm's registry, or without its integrity, so npm won't install it here." >&2
  exit 1
fi
