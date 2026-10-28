#!/bin/bash
# Prints what a resolve session may not change in its clone's .git: HEAD, as the branch it names
# or detached, and its commit; every ref and its commit; ORIG_HEAD; the state files git's continue
# would read, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD and AUTO_MERGE, and whether a sequencer is
# under way; and what the index holds. A
# session only edits files, and host git adds them and continues the rebase, so the commits the
# app pushes are git's own. The token-free steps keep this once git has written the clone, and the
# continue compares it before git runs there again. The index is compared by what it holds, not
# its bytes, since git status, which a session may run, refreshes its record of the files.
#
#   git-state.sh WORK
#
# Run only once the clone's git config is known to be as it was, as every safe_git is.
set -euo pipefail

work="$1"
git() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 command git -C "$work" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= "$@"; }

echo "HEAD $(git symbolic-ref -q HEAD || echo detached) $(git rev-parse -q --verify HEAD || echo none)"
echo "ORIG_HEAD $(git rev-parse -q --verify ORIG_HEAD || echo none)"
# Each by its bytes, never read through a link.
for name in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD AUTO_MERGE; do
  file="$work/.git/$name"
  if [ -L "$file" ]; then echo "$name link"
  elif [ -f "$file" ]; then echo "$name $(sha256sum < "$file" | cut -c 1-64)"
  elif [ -e "$file" ]; then echo "$name other"
  else echo "$name none"; fi
done
if [ -e "$work/.git/sequencer" ] || [ -L "$work/.git/sequencer" ]; then echo "sequencer under way"; else echo "sequencer none"; fi
git for-each-ref --format='ref %(refname) %(objectname)'
echo "index $(git ls-files --stage -z | sha256sum | cut -c 1-64)"
