#!/bin/bash
# Brings in a pull request's patch against main as data, for a session that reads it and runs none
# of it: CI's Bug review, Security review and Classify. It runs in a checkout of main, from main's
# copy, holding a token that only reads. The patch is GitHub's diff of the head commit against the
# commit of main the branch started from, so it applies there, and `git diff --cached` then shows the
# change, all but binary images and fonts, which GitHub's diff names without their contents. Those
# are listed in binary-files.md, a file of this script's own, so text in the patch or the
# description can't forge the list, and their count goes to the step's unread output. A patch that
# touches Claude Code's own settings, servers or instructions, .claude/, .mcp.json or a CLAUDE.md, is
# refused before any session starts, as is any other binary file, WebAssembly included, since it
# runs.
#
#   HEAD_SHA=<the head commit> bring-patch.sh DIR
#
# It writes DIR/change.patch, DIR/pull-request.md, from GitHub, when PR_NUMBER names a pull request, and
# DIR/binary-files.md when there are binary files.
set -euo pipefail

# The patch's file names are its author's, so nothing this prints can start a workflow command.
stop="$(openssl rand -hex 16)"
echo "::stop-commands::$stop"
trap 'echo "::$stop::"' EXIT

if ! [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The head commit isn't a commit id: $HEAD_SHA"
  exit 1
fi
review="$1"
mkdir -p "$review"
main="$(git rev-parse HEAD)"
compare="repos/$GITHUB_REPOSITORY/compare/$main...$HEAD_SHA"
base="$(gh api "$compare" --jq .merge_base_commit.sha)"
if ! [[ "$base" =~ ^[0-9a-f]{40}$ ]] || ! git merge-base --is-ancestor "$base" "$main"; then
  echo "The pull request doesn't start from a commit of main: $base"
  exit 1
fi
gh api "$compare" -H "Accept: application/vnd.github.diff" > "$review/change.patch"
# A session reading the change would follow a symbolic link wherever it points, /proc included, so a
# patch that adds or changes one isn't reviewed.
if grep -qE '^(new file mode|new mode) 120000$|^index [0-9a-f]+\.\.[0-9a-f]+ 120000$' "$review/change.patch"; then
  echo "The patch adds or changes a symbolic link, which a review session would follow, so it isn't reviewed."
  exit 1
fi
# The title and description are read from GitHub as the job runs, never from the event, which holds
# the pull request as it was when CI started: a build's push can land before its description is.
if [ -n "${PR_NUMBER:-}" ]; then
  case "$PR_NUMBER" in *[!0-9]*) echo "The pull request's number isn't a number: $PR_NUMBER"; exit 1 ;; esac
  gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq '"# \(.title)\n\n\(.body // "")"' > "$review/pull-request.md"
fi
git -c core.hooksPath=/dev/null switch -q --detach "$base"
# Every path the patch touches: git's numstat gives each file's name, the new one for a
# rename or copy, and the old names come from the patch's own rename and copy lines.
# numstat marks a binary file with "-", and so does the section it sits in.
git apply --numstat -z "$review/change.patch" > "$review/numstat"
paths=()
binaries=()
while IFS= read -r -d '' record; do
  added="${record%%$'\t'*}"
  path="${record#*$'\t'}"
  path="${path#*$'\t'}"
  paths+=("$path")
  [ "$added" = "-" ] && binaries+=("$path")
done < "$review/numstat"
# Each binary file once, by its new name, before a renamed one's old name is added.
changed="${#binaries[@]}"
while IFS=$'\t' read -r kind old; do
  if [[ "$old" == \"* ]]; then
    echo "The patch renames or copies a file whose name git quotes, which the review can't check: $old"
    exit 1
  fi
  paths+=("$old")
  [ "$kind" = binary ] && binaries+=("$old")
done < <(awk 'function flush() { for (i = 1; i <= n; i++) print (binary ? "binary" : "text") "\t" olds[i]; n = 0; binary = 0 }
  /^diff --git / { flush() }
  /^(rename|copy) from / { olds[++n] = substr($0, index($0, " from ") + 6) }
  /^Binary files .* differ$/ || /^GIT binary patch$/ { binary = 1 }
  END { flush() }' "$review/change.patch")
claudes='(^|/)\.claude(/|$)|(^|/)\.mcp\.json$|(^|/)CLAUDE(\.local)?\.md$'
refuse() {
  echo "The patch changes Claude Code's own settings, servers or instructions, which a review session would load, so it isn't reviewed:"
  grep -zE "$claudes" | jq -Rs 'split("\u0000") | map(select(. != ""))'
  exit 1
}
if [ "${#paths[@]}" -gt 0 ] && printf '%s\0' "${paths[@]}" | grep -zqE "$claudes"; then
  printf '%s\0' "${paths[@]}" | refuse
fi
# GitHub's diff names a binary file without its contents, so git can't apply it, and the
# reviews can't read it. A file is binary to git if it holds one NUL byte, so only images
# and fonts outside .github/ are let through unread; any other binary file, WebAssembly
# included, since it runs, stops the review. Leave out each binary file's section, apply
# the rest, and tell the reviewers which binary files changed. Then check that every other
# file is staged, and refuse Claude's own files among what was staged too.
readable='\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?)$'
for binary in "${binaries[@]}"; do
  if ! [[ "$binary" =~ ^[A-Za-z0-9._/@+-]+$ ]]; then
    echo "The patch changes a binary file whose name holds more than letters, digits and ./@+-_, which the reviews would be told as is."
    exit 1
  fi
  if [[ "$binary" == .github/* ]] || ! [[ "$binary" =~ $readable ]]; then
    echo "The patch changes $binary, which GitHub's diff shows only as binary, so the reviews couldn't read it."
    exit 1
  fi
done
awk 'function flush() { if (section != "" && !binary) printf "%s", section; section = ""; binary = 0 }
  /^diff --git / { flush() }
  { section = section $0 "\n" }
  /^Binary files .* differ$/ || /^GIT binary patch$/ { binary = 1 }
  END { flush() }' "$review/change.patch" > "$review/text.patch"
if [ -s "$review/text.patch" ]; then
  git apply --index "$review/text.patch"
fi
if git diff --cached --name-only --no-renames -z | grep -zqE "$claudes"; then
  git diff --cached --name-only --no-renames -z | refuse
fi
staged="$(git diff --cached --name-only --no-renames -z | tr '\0' '\n')"
for path in "${paths[@]}"; do
  for binary in "${binaries[@]}"; do
    [ "$path" = "$binary" ] && continue 2
  done
  if ! grep -qxF -- "$path" <<< "$staged"; then
    echo "The patch touches $path, but it wasn't applied, so the reviews wouldn't see it."
    exit 1
  fi
done
# The count goes to the post job as this step's output, out of the sessions' reach. The list
# goes in a file of the workflow's own, apart from the description the author wrote, which
# could carry a list of its own.
echo "unread=$changed" >> "${GITHUB_OUTPUT:-/dev/null}"
if [ "${#binaries[@]}" -gt 0 ]; then
  {
    printf '## Binary files, changed but not shown in the patch\n\n'
    printf -- '- %s\n' "${binaries[@]}"
  } > "$review/binary-files.md"
fi
