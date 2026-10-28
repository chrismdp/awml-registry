#!/bin/bash
# Writes the description of a build's pull request, in Markdown, to standard output. The build's
# open job runs main's copy when it pushes. Nothing reads the description back: it carries no record
# line and no digests (chrismdp/awml#160).
#
# It's Claude's description, escaped, so that it can't hide the rest or mention anyone, and its
# length capped; then the pictures of the pages the change alters; then what judges it; and last
# the issue it closes.
#
# It reads, from the environment:
# - ISSUE, a number;
# - CHANGE_DIR, the draft's files: pull-request.md, or else message.md;
# - PICTURES, a file of page|as|width|before|after rows, which the open job checked,
#   PICTURES_LEFT_OUT, a file saying why the pictures were left out, and MEDIA_URL, where the
#   pictures are.
# The files may be missing.
#
# Needs jq.
set -euo pipefail

case "$ISSUE" in ''|*[!0-9]*) echo "The issue must be a number: $ISSUE" >&2; exit 1 ;; esac

# Claude's text is escaped, so it can't hide the rest or mention anyone, capped, and closes no issue:
# the build's own Closes #n is the last line, which this script writes.
here="$(dirname "$0")"
unclose() {
  jq -jRs '.[0:60000] | gsub("<"; "&lt;") | gsub("@(?=[A-Za-z0-9])"; "@\u200b")' | bash "$here/unclose.sh"
}
if [ -s "$CHANGE_DIR/pull-request.md" ]; then
  unclose < "$CHANGE_DIR/pull-request.md"
elif [ -f "$CHANGE_DIR/message.md" ]; then
  tail -n +2 "$CHANGE_DIR/message.md" | sed '/./,$!d' | unclose
fi


# A picture the pictures job couldn't take is "", and is shown as such. Each page gets a heading,
# then its desktop and phone pictures.
cell() {
  if [ -n "$2" ]; then
    printf '![%s](%s/%s)' "$1" "$MEDIA_URL" "$2"
  else
    printf "Couldn't be pictured"
  fi
}
if [ -n "${PICTURES:-}" ] && [ -s "$PICTURES" ]; then
  echo
  echo "## Pictures"
  echo
  # shellcheck disable=SC2016 # The backticks are Markdown.
  echo 'Before is main and after is this change, each filled with the data from `scripts/seed-pictures.ts`.'
  shown=""
  while IFS='|' read -r page as width before after; do
    [ -n "$page" ] || continue
    if [ "$width" = desktop ] || [ "$page|$as" != "$shown" ]; then
      case "$as" in owner) who="signed in as ana" ;; *) who="signed out" ;; esac
      case "$before|$after" in *.gif*) who="$who, as someone uses it" ;; esac
      # shellcheck disable=SC2016 # The backticks are Markdown.
      printf '\n### `%s`, %s\n' "$page" "$who"
      shown="$page|$as"
    fi
    case "$width" in
      desktop) printf '\nDesktop, 1280 pixels wide:\n\n' ;;
      *) printf '\nPhone, 390 pixels wide:\n\n' ;;
    esac
    echo "| Before | After |"
    echo "| --- | --- |"
    printf '| %s | %s |\n' "$(cell Before "$before")" "$(cell After "$after")"
  done < "$PICTURES"
elif [ -n "${PICTURES_LEFT_OUT:-}" ] && [ -s "$PICTURES_LEFT_OUT" ]; then
  echo
  echo "## Pictures"
  echo
  printf 'The pictures were left out. %s\n' "$(cat "$PICTURES_LEFT_OUT")"
fi

echo
echo "## Checks"
echo
echo "CI runs the tests, the Bug review and the Security review on this pull request's head commit, and Classify sorts it as ship, show or ask. Once they pass, land.yml merges it, merges it and says what to look at, or asks for a review."
echo
printf 'Closes #%s\n' "$ISSUE"
