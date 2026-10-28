#!/bin/bash
# Continues each rebase a round of resolve-session.sh left, in a step of resolve.yml that holds no
# Claude token. Git reads a clone a session wrote, so it runs there only if the clone and its .git
# are the ones the session started in, by device and inode, its git config is byte for byte as it
# was, both as kept in the host-only folder's baseline, which no session may write, and no
# repository is nested below its top; and only with no hook, fsmonitor, external diff or editor of
# the tree's, and no global or system config. A clone that fails any of these, or whose conflicted files still hold conflict
# markers, is given up on, and no round starts a session there again. Otherwise the resolved files
# are added and the rebase continues; if the next commit conflicts, its conflicted files are listed
# for the next round's session.
#
#   resolve-continue.sh
set -euo pipefail

safe_git() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 command git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= "$@"; }
baseline="$HOST_DIR/baseline"
while IFS=$'\t' read -r number _; do
  case "$number" in ''|*[!0-9]*) continue ;; esac
  root="$RUNNER_TEMP/pr/$number"
  work="$root/work"
  [ -d "$work/.git/rebase-merge" ] || [ -d "$work/.git/rebase-apply" ] || continue
  [ ! -e "$baseline/gave-up-$number" ] || continue
  give_up() { echo "$1"; : > "$baseline/gave-up-$number"; }
  if ! stat -c %d:%i "$work" "$work/.git" | cmp -s - "$baseline/clone-$number"; then
    give_up "The clone of #$number or its .git isn't the one its session started in, so no git runs there."
    continue
  fi
  # Claude Code leaves an empty placeholder at each path it protects that wasn't there; each goes,
  # and anything else at one is refused.
  if ! bash "$HOST_DIR/main/placeholders.sh" clear "$work" "$baseline/protected-$number"; then
    give_up "The session on #$number left something other than a placeholder at a path Claude Code protects, so no git runs there."
    continue
  fi
  if ! cmp -s "$work/.git/config" "$baseline/git-config-$number"; then
    give_up "The session on #$number changed its clone's git config, so no git runs there."
    continue
  fi
  # The rebase's state must be as it was before the session, and no other started: git's continue
  # follows it outside the sandbox, exec lines and all.
  if ! bash "$HOST_DIR/main/rebase-state.sh" check "$work" "$HOST_DIR/rebase-state-$number"; then
    give_up "The session on #$number changed its clone's rebase state, so no git runs there."
    continue
  fi
  # Replace refs are ignored, by GIT_NO_REPLACE_OBJECTS in safe_git, and a grafts file, which would
  # change the commits git reads, is refused.
  if [ -e "$work/.git/info/grafts" ] || [ -L "$work/.git/info/grafts" ]; then
    give_up "The session on #$number left a grafts file in its clone's .git, so no git runs there."
    continue
  fi
  # node_modules counts too: a session may write there, apart from its .bin.
  if [ -n "$(find "$work" -mindepth 2 -name .git -print -quit)" ]; then
    give_up "The session on #$number left a repository nested in its clone, so no git runs there."
    continue
  fi
  # A session only edits files: the commits, refs, HEAD and index must be as git left them, so the
  # commits the app pushes are git's own.
  if ! bash "$HOST_DIR/main/git-state.sh" "$work" | cmp -s - "$baseline/git-state-$number"; then
    give_up "The session on #$number changed its clone's commits, refs, HEAD or index, so no git runs there."
    continue
  fi
  marked=false
  while IFS= read -r path; do
    # A link is left alone: the host reads nothing through one, and the check step refuses it.
    if [ -f "$work/$path" ] && [ ! -L "$work/$path" ] && grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$work/$path"; then marked=true; fi
  done < "$HOST_DIR/conflicted-$number.txt"
  if [ "$marked" = true ]; then
    give_up "The session on #$number left conflict markers, so its rebase stops here."
    continue
  fi
  safe_git -C "$work" add -A
  if GIT_EDITOR=true safe_git -C "$work" -c core.editor=true rebase --continue > /dev/null 2>&1; then
    echo "#$number's rebase went on to its end, or to its next conflict."
  fi
  # What git has now written, for the next round's checks: its commits, refs, HEAD and index, and
  # which protected paths the replayed commits put in the tree, which are the branch's, not
  # placeholders.
  bash "$HOST_DIR/main/git-state.sh" "$work" > "$baseline/git-state-$number"
  bash "$HOST_DIR/main/placeholders.sh" record "$work" "$baseline/protected-$number"
  if [ -d "$work/.git/rebase-merge" ] || [ -d "$work/.git/rebase-apply" ]; then
    safe_git -C "$work" diff --name-only --no-ext-diff --no-textconv --diff-filter=U > "$HOST_DIR/conflicted-$number.txt"
    if [ ! -s "$HOST_DIR/conflicted-$number.txt" ]; then
      give_up "#$number's rebase stopped without a conflict, so it stops here."
    fi
  fi
done < "$HOST_DIR/pulls.tsv"
