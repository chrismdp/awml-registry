#!/bin/bash
# Refuses a Claude session's output folder before the host reads anything in it. A session's
# commands can write there, so a file could be a link to /proc/self/environ or to a file of the
# host's, which the host's cat, copy or upload would then read. The folder passes only if its real
# path is the path it was given, under the root it should be in, with no symbolic link on the way,
# and everything in it is a regular file or folder.
#
#   check-out.sh OUT ROOT
set -euo pipefail

out="$1"
root="$2"
if [ ! -d "$out" ] || [ -L "$out" ]; then
  echo "The session's output folder isn't a folder." >&2
  exit 1
fi
real="$(realpath -e -- "$out")"
lexical="$(realpath -m -s -- "$out")"
real_root="$(realpath -e -- "$root")"
if [ "$real" != "$lexical" ]; then
  echo "The session's output folder is reached through a symbolic link." >&2
  exit 1
fi
case "$real/" in
  "$real_root"/*) ;;
  *) echo "The session's output folder isn't under its root." >&2; exit 1 ;;
esac
if [ -n "$(find "$out" ! -type f ! -type d -print -quit)" ]; then
  echo "The session's output folder holds something other than plain files and folders." >&2
  exit 1
fi
