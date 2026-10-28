#!/bin/bash
# Continues each rebase a round of resolve-session.sh left, in a step of resolve.yml that holds no
# Claude token. Git reads a clone a session wrote, so it runs only if the clone's git config is byte
# for byte as it was before any session, with no hook, fsmonitor, external diff or editor of the
# tree's, and the step reads no global or system config. A clone whose conflicted files still hold
# conflict markers, or whose config changed, is given up on, and no round starts a session there
# again. Otherwise the resolved files are added and the rebase continues; if the next commit
# conflicts, its conflicted files are listed for the next round's session.
#
#   resolve-continue.sh
set -euo pipefail

while read -r number _; do
  case "$number" in ''|*[!0-9]*) continue ;; esac
  clone="$RUNNER_TEMP/clone-$number"
  input="$RUNNER_TEMP/input-$number"
  [ -d "$clone/.git/rebase-merge" ] || [ -d "$clone/.git/rebase-apply" ] || continue
  [ ! -e "$RUNNER_TEMP/gave-up-$number" ] || continue
  if ! cmp -s "$clone/.git/config" "$RUNNER_TEMP/git-config-$number"; then
    echo "The session for #$number changed its clone's git config, so no git runs there."
    : > "$RUNNER_TEMP/gave-up-$number"
    continue
  fi
  marked=false
  while IFS= read -r path; do
    if [ -f "$clone/$path" ] && grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$clone/$path"; then marked=true; fi
  done < "$input/conflicted-files.txt"
  if [ "$marked" = true ]; then
    echo "The session for #$number left conflict markers, so its rebase stops here."
    : > "$RUNNER_TEMP/gave-up-$number"
    continue
  fi
  git -C "$clone" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= add -A
  if GIT_EDITOR=true git -C "$clone" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= -c core.editor=true rebase --continue > /dev/null 2>&1; then
    echo "#$number's rebase went on to its end, or to its next conflict."
  fi
  if [ -d "$clone/.git/rebase-merge" ] || [ -d "$clone/.git/rebase-apply" ]; then
    chmod u+w "$input" "$input/conflicted-files.txt"
    git -C "$clone" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= diff --name-only --no-ext-diff --no-textconv --diff-filter=U > "$input/conflicted-files.txt"
    if [ ! -s "$input/conflicted-files.txt" ]; then
      echo "#$number's rebase stopped without a conflict, so it stops here."
      : > "$RUNNER_TEMP/gave-up-$number"
    fi
  fi
done < "$RUNNER_TEMP/conflicted.txt"
