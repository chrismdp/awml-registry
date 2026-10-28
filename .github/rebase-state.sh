#!/bin/bash
# Keeps a clone's rebase state, .git/rebase-merge or .git/rebase-apply, as it was before a resolve
# session, and checks it after, before git continues the rebase outside the sandbox. The session may
# not write the state folder there, but it could start the other kind, which git prefers, or the
# state could otherwise change: either is a rebase the session wrote, exec lines and all.
#
#   rebase-state.sh snapshot WORK KEPT   # keeps WORK's rebase state in KEPT, in the host-only folder
#   rebase-state.sh check WORK KEPT      # fails unless WORK's rebase state is exactly what KEPT holds
set -euo pipefail

mode="$1"
work="$2"
kept="$3"
git_dir="$work/.git"
there() { [ -e "$1" ] || [ -L "$1" ]; }
plain() { [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" ! -type f ! -type d -print -quit)" ]; }

case "$mode" in
  snapshot)
    rm -rf -- "$kept"
    mkdir -p -- "$kept"
    for kind in rebase-merge rebase-apply; do
      there "$git_dir/$kind" || continue
      if ! plain "$git_dir/$kind"; then
        echo "The rebase's state, $kind, isn't plain files and folders." >&2
        exit 1
      fi
      cp -R -- "$git_dir/$kind" "$kept/$kind"
    done
    if [ -z "$(find "$kept" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      echo "There's no rebase under way to keep." >&2
      exit 1
    fi
    ;;
  check)
    [ -d "$kept" ] || { echo "No rebase state was kept before the session." >&2; exit 1; }
    for kind in rebase-merge rebase-apply; do
      if there "$kept/$kind"; then
        if ! plain "$git_dir/$kind"; then
          echo "The rebase's state, $kind, isn't plain files and folders after the session." >&2
          exit 1
        fi
        if ! diff -r -- "$kept/$kind" "$git_dir/$kind" > /dev/null; then
          echo "The rebase's state, $kind, changed during the session." >&2
          exit 1
        fi
      elif there "$git_dir/$kind"; then
        echo "The session started a rebase state of its own, $kind." >&2
        exit 1
      fi
    done
    ;;
  *) echo "rebase-state.sh doesn't know $mode" >&2; exit 1 ;;
esac
