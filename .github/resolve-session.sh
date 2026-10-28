#!/bin/bash
# One round of resolve.yml's sessions: a fresh Claude session for each pull request whose rebase, in
# its clone under $RUNNER_TEMP/pr, stopped at a conflict and that no round has given up on. The
# session only edits the conflicted files and writes its note. It runs no git that writes, and this
# script runs none at all: resolve-continue.sh, in the next step, which holds no Claude token, adds
# what it resolved and continues the rebase, and a commit that conflicts in turn waits for the next
# round.
#
#   STEP_SCRIPT="$0" resolve-session.sh ROUND
#
# Each session runs its commands in its sandbox, which reaches no network, sees none of Claude
# Code's own process, and can't write its clone's .git, its inputs, another pull request's folder,
# the host-only folder or the workspace. It loads only the settings claude-settings.sh writes in a
# new home of its own for this round, and no MCP servers, and reads only
# its clone and its own folders, never /proc. Under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, Claude Code
# forces --permission-mode default, so every tool it may use is named. Its log, kept in the host-only
# folder, is printed with workflow commands stopped.
set -euo pipefail

{
  # One group, which bash reads whole before any session starts, so nothing a session's command
  # writes to this script, or to the step's that runs it, which are both denied to it, can run after.
  round="$1"
  case "$round" in ''|*[!0-9]*) echo "The round must be a number: $round"; exit 1 ;; esac
  while IFS=$'\t' read -r number _; do
    case "$number" in ''|*[!0-9]*) continue ;; esac
    root="$RUNNER_TEMP/pr/$number"
    [ -d "$root/work/.git/rebase-merge" ] || [ -d "$root/work/.git/rebase-apply" ] || continue
    [ ! -e "$HOST_DIR/baseline/gave-up-$number" ] || continue
    denied=(--deny-write ./.git --deny-write "$root/in" --deny-write "$0" --deny-write "$STEP_SCRIPT")
    for other in "$RUNNER_TEMP"/pr/*; do
      if [ "$other" != "$root" ]; then denied+=(--deny-write "$other"); fi
    done
    denied+=(--deny-write "$GITHUB_WORKSPACE")
    # An earlier round's session could have renamed a folder above this one and built a fake in its
    # place, so the host writes nothing there: the home is a new folder of mktemp's under /tmp,
    # which no command can rename, and the files that conflict now, kept in the host-only folder,
    # go in the prompt. The log goes to the host-only folder too, so no session can turn it into a
    # link for the host's cat to follow.
    home="$(mktemp -d "${TMPDIR:-/tmp}/resolve-home.XXXXXXXX")"
    log="$HOST_DIR/logs/resolve-$number-round-$round.log"
    mkdir -p "$HOST_DIR/logs"
    bash "$HOST_DIR/main/claude-settings.sh" "$home" "${denied[@]}"
    prompt="$(sed -e "s|INPUT_DIR|$root/in|g" -e "s|OUT_DIR|$root/out|g" "$HOST_DIR/main/resolve-prompt.md")"
    prompt+=$'\n\nThe files that conflict now, one a line:\n\n'"$(cat "$HOST_DIR/conflicted-$number.txt")"
    (
      cd "$root/work"
      HOME="$home" claude -p "$prompt" --model opus --max-turns 200 --permission-mode default \
        --setting-sources user --strict-mcp-config --add-dir "$root/in" --add-dir "$root/out" \
        --disallowedTools "Read(//proc/**)" "Edit(./.git/**)" "Write(./.git/**)" \
        --allowedTools "Read(./**)" "Read(/$root/in/**)" "Read(/$root/out/**)" "Edit(./**)" "Write(./**)" \
          "Edit(/$root/out/**)" "Write(/$root/out/**)" \
          "Bash(npm run:*)" "Bash(npm test:*)" \
          "Bash(npx vitest:*)" "Bash(npx tsc:*)" "Bash(npx eslint:*)" \
          "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(ls:*)" \
        > "$log" 2>&1
    ) || echo "The session on #$number ended with an error."
    stop="$(openssl rand -hex 16)"
    echo "::stop-commands::$stop"
    cat "$log"
    echo "::$stop::"
  done < "$HOST_DIR/pulls.tsv"
  exit 0
}
