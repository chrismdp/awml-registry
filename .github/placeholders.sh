#!/bin/bash
# Under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, Claude Code 2.1.312 makes a placeholder at each path it
# protects that isn't there yet, in the folder a session starts in and in the workspace, for its
# sandbox to mount over: an empty file, an empty folder, or .git/commondir holding ".". They're left
# in the real tree, where host git would read them or a patch would carry them. So before a session
# the host records which of those paths a tree holds, and after it, before any git, takes away each
# that has appeared since, if it's a placeholder, and refuses the tree if one is anything else.
#
#   placeholders.sh record TREE LIST   # lists, in LIST, which of the protected paths TREE holds
#   placeholders.sh clear TREE LIST    # takes away the placeholders that appeared since LIST
#
# LIST lives in the host-only folder, which no session may write.
set -euo pipefail

mode="$1"
tree="$2"
list="$3"
# Claude Code's own list, folders after what they hold, so a folder is empty when it's reached.
protected=(
  .npmrc .yarnrc .yarnrc.yml bunfig.toml package.json .gitmodules package-lock.json yarn.lock pnpm-lock.yaml
  .env .env.local .env.development .env.development.local .env.test .env.test.local .env.production .env.production.local
  .git/config .git/config.lock .git/config.worktree .git/config.worktree.lock .git/commondir .git/info/exclude
  .claude/commands .claude/agents .claude node_modules/.bin node_modules scripts .github
  .git/hooks .git/modules .git/worktrees .git/glab-cli .git/info
)

there() { [ -e "$1" ] || [ -L "$1" ]; }

case "$mode" in
  record)
    for path in "${protected[@]}"; do
      if there "$tree/$path"; then printf '%s\n' "$path"; fi
    done > "$list"
    ;;
  clear)
    for path in "${protected[@]}"; do
      at="$tree/$path"
      there "$at" || continue
      if grep -qxF -- "$path" "$list"; then continue; fi
      if [ -L "$at" ]; then
        echo "The session left a link at $path, where Claude Code would leave only a placeholder." >&2
        exit 1
      elif [ -f "$at" ] && [ ! -s "$at" ]; then
        rm -- "$at"
      elif [ "$path" = .git/commondir ] && [ -f "$at" ] && [ "$(cat -- "$at")" = . ]; then
        rm -- "$at"
      elif [ -d "$at" ] && [ -z "$(find "$at" -mindepth 1 -print -quit)" ]; then
        rmdir -- "$at"
      else
        echo "The session left something at $path, where Claude Code would leave only an empty placeholder." >&2
        exit 1
      fi
    done
    ;;
  *) echo "placeholders.sh doesn't know $mode" >&2; exit 1 ;;
esac
