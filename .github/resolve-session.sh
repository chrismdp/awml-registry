#!/bin/bash
# One round of resolve.yml's sessions: a fresh Claude session for each clone whose rebase stopped at
# a conflict and that no round has given up on. The session only edits the conflicted files and
# writes its note. It runs no git: resolve-continue.sh, in the next step, which holds no Claude
# token, adds what it resolved and continues the rebase, and a commit that conflicts in turn waits
# for the next round.
#
#   resolve-session.sh ROUND
#
# Each session runs its commands in its sandbox, which reaches no network, sees none of Claude
# Code's own process and can't write git's files. It loads only the settings claude-settings.sh
# writes in a home of its own for this round, and no MCP servers, and reads only its clone and its
# inputs, never /proc. Under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, Claude Code forces
# --permission-mode default, so every tool it may use is named. Its log is printed with workflow
# commands stopped.
set -euo pipefail

round="$1"
case "$round" in ''|*[!0-9]*) echo "The round must be a number: $round"; exit 1 ;; esac
while read -r number _; do
  case "$number" in ''|*[!0-9]*) continue ;; esac
  clone="$RUNNER_TEMP/clone-$number"
  [ -d "$clone/.git/rebase-merge" ] || [ -d "$clone/.git/rebase-apply" ] || continue
  [ ! -e "$RUNNER_TEMP/gave-up-$number" ] || continue
  input="$RUNNER_TEMP/input-$number"
  session="$RUNNER_TEMP/sessions/resolve-$number"
  round_dir="$session/round-$round"
  mkdir -p "$session/out" "$round_dir"
  chmod -R a-w "$input"
  bash "$RUNNER_TEMP/main/claude-settings.sh" "$round_dir/home" --deny-write ./.git
  prompt="$(sed -e "s|INPUT_DIR|$input|g" -e "s|OUT_DIR|$session/out|g" "$RUNNER_TEMP/main/resolve-prompt.md")"
  (
    cd "$clone"
    HOME="$round_dir/home" claude -p "$prompt" --model opus --max-turns 200 --permission-mode default \
      --setting-sources user --strict-mcp-config --add-dir "$input" --add-dir "$session/out" \
      --disallowedTools "Read(//proc/**)" "Edit(./.git/**)" "Write(./.git/**)" \
      --allowedTools "Read(./**)" "Read(/$input/**)" "Edit(./**)" "Write(./**)" \
        "Edit(/$session/out/**)" "Write(/$session/out/**)" \
        "Bash(npm run:*)" "Bash(npm test:*)" \
        "Bash(npx vitest:*)" "Bash(npx tsc:*)" "Bash(npx eslint:*)" \
        "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(ls:*)" \
      > "$round_dir/log" 2>&1
  ) || echo "The session for #$number ended in failure."
  stop="$(openssl rand -hex 16)"
  echo "::stop-commands::$stop"
  cat "$round_dir/log"
  echo "::$stop::"
done < "$RUNNER_TEMP/conflicted.txt"
