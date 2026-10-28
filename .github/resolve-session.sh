#!/bin/bash
# One round of resolve.yml's sessions: a fresh Claude session for each pull request whose rebase, in
# its clone under $RUNNER_TEMP/pr, stopped at a conflict and that no round has given up on. The
# session only edits the conflicted files and writes its note. It runs no git that writes, and this
# script runs none at all: resolve-continue.sh, in the next step, which holds no Claude token, adds
# what it resolved and continues the rebase, and a commit that conflicts in turn waits for the next
# round.
#
#   resolve-session.sh ROUND
#
# Each session runs its commands in its sandbox, which reaches no network, sees none of Claude
# Code's own process, and can't write its clone's .git, its inputs, another pull request's folder,
# main's scripts, the check folders, the baseline or the workspace. It loads only the settings
# claude-settings.sh writes in a home of its own for this round, and no MCP servers, and reads only
# its clone and its own folders, never /proc. Under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, Claude Code
# forces --permission-mode default, so every tool it may use is named. Its log is printed with
# workflow commands stopped.
set -euo pipefail

round="$1"
case "$round" in ''|*[!0-9]*) echo "The round must be a number: $round"; exit 1 ;; esac
while IFS=$'\t' read -r number _; do
  case "$number" in ''|*[!0-9]*) continue ;; esac
  root="$RUNNER_TEMP/pr/$number"
  [ -d "$root/work/.git/rebase-merge" ] || [ -d "$root/work/.git/rebase-apply" ] || continue
  [ ! -e "$RUNNER_TEMP/baseline/gave-up-$number" ] || continue
  denied=(--deny-write ./.git --deny-write "$root/in")
  for other in "$RUNNER_TEMP"/pr/*; do
    if [ "$other" != "$root" ]; then denied+=(--deny-write "$other"); fi
  done
  for shared in main check resolved baseline pulls.tsv; do denied+=(--deny-write "$RUNNER_TEMP/$shared"); done
  denied+=(--deny-write "$GITHUB_WORKSPACE")
  round_dir="$root/round-$round"
  mkdir -p "$round_dir"
  bash "$RUNNER_TEMP/main/claude-settings.sh" "$round_dir/home" "${denied[@]}"
  prompt="$(sed -e "s|INPUT_DIR|$root/in|g" -e "s|OUT_DIR|$root/out|g" "$RUNNER_TEMP/main/resolve-prompt.md")"
  (
    cd "$root/work"
    HOME="$round_dir/home" claude -p "$prompt" --model opus --max-turns 200 --permission-mode default \
      --setting-sources user --strict-mcp-config --add-dir "$root/in" --add-dir "$root/out" \
      --disallowedTools "Read(//proc/**)" "Edit(./.git/**)" "Write(./.git/**)" \
      --allowedTools "Read(./**)" "Read(/$root/in/**)" "Read(/$root/out/**)" "Edit(./**)" "Write(./**)" \
        "Edit(/$root/out/**)" "Write(/$root/out/**)" \
        "Bash(npm run:*)" "Bash(npm test:*)" \
        "Bash(npx vitest:*)" "Bash(npx tsc:*)" "Bash(npx eslint:*)" \
        "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(ls:*)" \
      > "$round_dir/log" 2>&1
  ) || echo "The session on #$number ended with an error."
  stop="$(openssl rand -hex 16)"
  echo "::stop-commands::$stop"
  cat "$round_dir/log"
  echo "::$stop::"
done < "$RUNNER_TEMP/pulls.tsv"
