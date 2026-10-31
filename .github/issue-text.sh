#!/bin/bash
# The build and fixer share this rule for approved issue text. Read GitHub's rendered HTML,
# keeping writers' comments and app comments approved by the last build label.
# Usage: issue-text.sh ISSUE FILE [WHY]. WHY says why the label doesn't approve the issue.
set -euo pipefail

number="$1"
file="$2"
why_file="${3:-/dev/null}"
case "$number" in ''|*[!0-9]*) echo "The issue must be a number: $number" >&2; exit 1 ;; esac

may_write() {
  [[ "$1" =~ ^[A-Za-z0-9-]{1,39}$ ]] || return 1
  local role="" permission=""
  IFS=$'\t' read -r role permission < <(gh api "repos/$GITHUB_REPOSITORY/collaborators/$1/permission" --jq '[.role_name // "", .permission // ""] | @tsv' || true) || true
  case "$role" in admin|maintain|write) return 0 ;; esac
  case "$permission" in admin|maintain|write) return 0 ;; esac
  return 1
}

owner="${GITHUB_REPOSITORY%%/*}"
name="${GITHUB_REPOSITORY#*/}"
issue="$(gh api graphql -F owner="$owner" -f name="$name" -F number="$number" -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number title bodyHTML lastEditedAt labels(first: 100) { nodes { name } }
        author { login __typename }
      }
    }
  }' --jq .data.repository.issue)"
remarks="$(mktemp)"
trap 'rm -f "$remarks"' EXIT
# Comments are paginated; a decision can be after the first hundred.
gh api graphql --paginate -F owner="$owner" -f name="$name" -F number="$number" -f query='
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        comments(first: 100, after: $endCursor) {
          nodes { author { login __typename } createdAt lastEditedAt url bodyHTML }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }' --jq '.data.repository.issue.comments.nodes[]' | jq -s . > "$remarks"
# REST events include every rename, which lastEditedAt doesn't count.
events="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$number/events?per_page=100" --jq \
  '.[] | select((.event == "labeled" and .label.name == "build") or .event == "renamed")' | jq -s .)"
labelled="$(jq -r '[.[] | select(.event == "labeled")] | last | .created_at // ""' <<< "$events")"
labeller="$(jq -r '[.[] | select(.event == "labeled")] | last | .actor.login // ""' <<< "$events")"
labeller_type="$(jq -r '[.[] | select(.event == "labeled")] | last | .actor.type // ""' <<< "$events")"
renamed="$(jq -r '[.[] | select(.event == "renamed") | .created_at] | max // ""' <<< "$events")"
edited="$(jq -r '.lastEditedAt // ""' <<< "$issue")"
if [[ "$renamed" > "$edited" ]]; then edited="$renamed"; fi
why=""
if [ -z "$labelled" ]; then
  why="The issue has never had the build label."
elif ! { [ "$labeller" = "awml-factory[bot]" ] && [ "$labeller_type" = Bot ]; } && ! may_write "$labeller"; then
  why="The build label was last added by someone without write access, so it doesn't approve the issue."
elif [ -n "$edited" ] && ! [[ "$edited" < "$labelled" ]]; then
  why="The issue was edited or renamed after the build label was last added, so it isn't drafted from."
fi
printf '%s' "$why" > "$why_file"
author="$(jq -r 'select(.author.__typename == "User") | .author.login // ""' <<< "$issue")"
approved=false
if [ -z "$why" ] || may_write "$author"; then approved=true; fi
writers=()
while IFS= read -r login; do
  if may_write "$login"; then writers+=("$login"); fi
done < <(jq -r '[.[] | select(.author.__typename == "User") | .author.login // empty] | unique[]' "$remarks")
{
  if [ "$approved" = true ]; then
    jq -r '"# #\(.number): \(.title)\n\nLabels: \([.labels.nodes[].name] | join(", "))\n\n\(.bodyHTML // "")\n"' <<< "$issue"
  else
    printf '# #%s\n\nThe issue'"'"'s title and text are left out because no writer wrote or approved them as they read now. Only the comments below count.\n\n' "$number"
  fi
  # GraphQL can name the app with or without REST's [bot]; its type must still be Bot.
  jq -r --arg labelled "$labelled" --argjson writers "$(jq -nc '$ARGS.positional' --args "${writers[@]}")" \
    '.[] | select((.author.__typename == "User" and (.author.login | IN($writers[])))
      or (.author.__typename == "Bot" and (.author.login | IN("awml-factory", "awml-factory[bot]"))
        and $labelled != "" and .createdAt < $labelled and (.lastEditedAt // "") < $labelled))
    | "## Comment by \(.author.login), \(.createdAt), \(.url)\n\n\(.bodyHTML)\n"' "$remarks"
} > "$file"
