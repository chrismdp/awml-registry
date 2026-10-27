#!/bin/bash
# Writes the description of a build's pull request, in Markdown, to standard output. The build
# workflow's open job writes it when it opens the pull request, before CI has run, and land.yml
# writes it again with the build rule's verdict once CI has passed. Each runs main's copy.
#
# It opens with a hidden line naming the build's run, so land.yml can find the build's records.
# Then why the change needs review, as bullets: the rule's reasons, the classifier's reasons and
# the findings still open. Then Claude's description as written, the findings about code the change
# didn't write, the pictures of the pages it alters, the checks, and the issue it closes.
#
# It reads, from the environment:
# - BUILD_RUN and ISSUE, numbers, and CHECKED, the commit of main the build's checks ran on;
# - CHANGE_DIR, the draft's files: message.md and pull-request.md;
# - REVIEW_DIR, the review job's files: findings.json, and classification.json if the classifier ran;
# - PICTURES, a file of page|as|width|before|after rows, which the open job checked,
#   PICTURES_LEFT_OUT, a file saying why the pictures were left out, and MEDIA_URL, where the
#   pictures are;
# - VERDICT, the build rule's output, a verdict line then its reasons, once CI has passed.
# The files may be missing, except the findings.
#
# Needs jq.
set -euo pipefail

case "$BUILD_RUN" in ''|*[!0-9]*) echo "The build's run must be a number: $BUILD_RUN" >&2; exit 1 ;; esac
case "$ISSUE" in ''|*[!0-9]*) echo "The issue must be a number: $ISSUE" >&2; exit 1 ;; esac
if ! [[ "$CHECKED" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The commit the checks ran on must be a commit id: $CHECKED" >&2
  exit 1
fi

findings="$REVIEW_DIR/findings.json"
classification="$REVIEW_DIR/classification.json"
jq -e 'type == "array" and all(.[];
    type == "object" and
    (.severity | IN("Important", "Nit", "Pre-existing")) and
    (.review | IN("bug", "security")) and
    (.file | type == "string") and (.line | type == "number") and
    (.title | type == "string") and (.detail | type == "string"))' "$findings" > /dev/null || {
  echo "The reviews' findings aren't a list of findings." >&2
  exit 1
}
if [ -f "$classification" ]; then
  jq -e '(.needs_review | type == "boolean") and (.reasons | type == "array" and all(.[]; type == "string"))' \
    "$classification" > /dev/null || {
    echo "The classifier's verdict isn't a verdict with its reasons." >&2
    exit 1
  }
fi

# Text the reviews and the classifier wrote goes into one bullet each, with nothing in it that can
# hide the rest of the description.
clean='def clean: gsub("[\r\n]+"; " ") | gsub("<"; "&lt;") | .[0:1000];'
bullets() {
  jq -r "$clean"' .[] | "- **\(.severity)**, from the \(.review) review, in `\(.file | gsub("`"; "") | clean)\(if .line > 0 then ":\(.line | floor)" else "" end)`: \(.title | clean) \(.detail | clean)"'
}

verdict=""
if [ -n "${VERDICT:-}" ] && [ -s "$VERDICT" ]; then
  verdict="$(head -n 1 "$VERDICT")"
  case "$verdict" in
    review|straightforward) ;;
    *) echo "The build rule gave an unknown verdict: $verdict" >&2; exit 1 ;;
  esac
fi
asked=false
[ -f "$classification" ] && asked="$(jq -r '.needs_review' "$classification")"
open="$(jq -c '[.[] | select(.severity != "Pre-existing")]' "$findings")"
earlier="$(jq -c '[.[] | select(.severity == "Pre-existing")]' "$findings")"

printf '<!-- factory-build run=%s -->\n' "$BUILD_RUN"
case "$verdict" in
  review)
    echo "## Needs your review because"
    echo
    tail -n +2 "$VERDICT" | while IFS= read -r line; do
      [ -n "$line" ] && printf -- '- %s\n' "$line"
    done
    ;;
  straightforward)
    printf 'Set to merge by itself, because the build rule found it straightforward: %s\n' \
      "$(tail -n +2 "$VERDICT" | grep -v '^$' | paste -sd ' ')"
    ;;
  *)
    echo "Waits for CI. Once CI passes, the build rule decides whether this merges by itself or waits for your review."
    ;;
esac
if [ "$asked" = true ]; then
  echo
  echo "## Why the classifier asked for review"
  echo
  jq -r "$clean"' .reasons[] | "- \(clean)"' "$classification"
fi
if [ "$open" != '[]' ]; then
  echo
  echo "## Findings still open"
  echo
  bullets <<< "$open"
fi

echo
if [ -s "$CHANGE_DIR/pull-request.md" ]; then
  cat "$CHANGE_DIR/pull-request.md"
else
  tail -n +2 "$CHANGE_DIR/message.md" 2> /dev/null | sed '/./,$!d'
fi

if [ "$earlier" != '[]' ]; then
  echo
  echo "## Findings in code the change didn't write"
  echo
  bullets <<< "$earlier"
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
# shellcheck disable=SC2016 # The backticks are Markdown.
printf -- '- The check job applied this change to main at %s and ran `npm ci`, `npm run typecheck`, `npm run lint` and `npm test`. All passed.\n' "$CHECKED"
# shellcheck disable=SC2016 # The backticks are Markdown.
echo '- Two fresh Claude sessions then reviewed it, one for bugs and one for security, against `REVIEW.md`, and a third sorted it by risk.'
echo "- CI runs the checks again on this pull request, and main's rule holds the merge until they pass."
echo
printf 'Closes #%s\n' "$ISSUE"
