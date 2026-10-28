#!/bin/bash
# Makes one review's findings its job's own check on the commit, in ci.yml: each finding an
# annotation GitHub keeps on the check, an Important one as an error, a Nit as a warning and a
# Pre-existing one as a notice, each titled with its rank, which review-findings.sh reads back for
# the fixer, Classify and land. It fails, and so fails the check, on an Important finding. Binary
# images or fonts the review couldn't read count as a Nit, so a person looks at them.
#
#   post-findings.sh FINDINGS.json UNREAD
#
# The review's text can't break out of its annotation or start a workflow command of its own, and a
# file of findings that carries anything like a token posts nothing. The job's summary lists the
# findings for people, with < escaped and mentions broken. GitHub keeps at most ten annotations of
# each level a step, so the summary says when there are more.
set -euo pipefail

findings="$1"
unread="$2"
here="$(dirname "$0")"
if ! [[ "$unread" =~ ^[0-9]{1,4}$ ]]; then
  echo "The count of binary files the review couldn't read isn't a number: $unread" >&2
  exit 1
fi
if ! jq -e 'type == "array" and length <= 50 and all(.[];
    type == "object" and
    (.severity | IN("Important", "Nit", "Pre-existing")) and
    (.file | type == "string") and (.line | type == "number" and . >= 0) and
    (.title | type == "string") and (.detail | type == "string"))' "$findings" > /dev/null 2>&1; then
  echo "The review left no readable record of its findings." >&2
  exit 1
fi
if ! bash "$here/scan-tokens.sh" "$findings"; then
  echo "The review's findings carry what looks like a login token, so none is posted." >&2
  exit 1
fi

# A workflow command's data escapes %, CR and LF, and a property escapes : and , too.
jq -r --argjson unread "$unread" '
  def data: gsub("%"; "%25") | gsub("\r"; "%0D") | gsub("\n"; "%0A");
  def prop: data | gsub(":"; "%3A") | gsub(","; "%2C");
  def level: {"Important": "error", "Nit": "warning", "Pre-existing": "notice"}[.];
  def where: (if .file | test("^[A-Za-z0-9._/@+-]{1,200}$") then "file=\(.file)," + (if .line >= 1 then "line=\(.line | floor)," else "" end) else "" end);
  (group_by(.severity) | map(.[0:10]) | add // [] | .[]
    | "::\(.severity | level) \(where)title=\("\(.severity): \(.title | .[0:200])" | prop)::\(.detail | .[0:2000] | data)"),
  (if $unread > 0 then "::warning title=\("Nit: The review could not read \($unread) binary images or fonts" | prop)::A person should look at them." else empty end)
' "$findings"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  jq -r --argjson unread "$unread" '
    def clean: gsub("[\r\n]+"; " ") | gsub("<"; "&lt;") | gsub("@(?=[A-Za-z0-9])"; "@​");
    def place: (.file | gsub("`"; "") | clean) + (if .line > 0 then ":\(.line | floor)" else "" end);
    if length == 0 and $unread == 0 then "Found nothing that survived a second look."
    else
      ([["Important", "Nit", "Pre-existing"][] as $rank | [.[] | select(.severity == $rank)] | select(length > 0)
        | "## \(.[0].severity)\n\n" + ([.[] | "- In `\(place)`: **\(.title | .[0:200] | clean)** \(.detail | .[0:2000] | clean)"] | join("\n"))]
        + (if $unread > 0 then ["## Unread\n\nThe pull request changes \($unread) binary images or fonts, which the review could not read."] else [] end)
        + (if ([group_by(.severity)[] | length] | max // 0) > 10 then ["Only the first ten findings of each rank are on the check."] else [] end))
      | join("\n\n")
    end' "$findings" >> "$GITHUB_STEP_SUMMARY"
fi

if jq -e 'any(.[]; .severity == "Important")' "$findings" > /dev/null; then
  echo "The review found something Important." >&2
  exit 1
fi
