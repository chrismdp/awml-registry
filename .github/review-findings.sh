#!/bin/bash
# Reads one CI run's review findings and Classify's verdict back from GitHub: the annotations
# post-findings.sh and Classify left on their jobs' own checks. fix.yml, land.yml and Classify run
# main's copy. Only an annotation whose title starts with its rank and whose level is that rank's is
# one of theirs; GitHub's own, such as a notice that an action is out of date, are left out.
#
#   review-findings.sh findings RUN   # a JSON list of {review, severity, file, line, title, detail}
#   review-findings.sh nits RUN       # how many Nits the two reviews left
#   review-findings.sh verdict RUN    # ship, show or ask, or missing unless there is exactly one
#
# Needs gh, with GH_TOKEN able to read the run's jobs and checks, and jq.
set -euo pipefail

mode="$1"
run="$2"
case "$run" in ''|*[!0-9]*) echo "The run must be a number: $run" >&2; exit 1 ;; esac

jobs="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs" --paginate \
  --jq '.jobs[] | "\(.name)\t\(.check_run_url)"')"
annotations() {
  local url
  url="$(awk -F '\t' -v name="$1" '$1 == name { print $2 }' <<< "$jobs" | tail -n 1)"
  if [ -z "$url" ]; then echo '[]'; return; fi
  gh api --paginate "repos/$GITHUB_REPOSITORY/check-runs/${url##*/}/annotations" | jq -s 'add // []'
}

case "$mode" in
  findings|nits)
    {
      annotations "Bug review" | jq -c '{review: "bug", found: .}'
      annotations "Security review" | jq -c '{review: "security", found: .}'
    } | jq -s '
      [.[] | .review as $review | .found[]
        | (.title // "") as $title
        | {Important: "failure", Nit: "warning", "Pre-existing": "notice"} as $levels
        | ($title | capture("^(?<severity>Important|Nit|Pre-existing): (?<title>.*)$"; "s")) as $ranked
        | select($levels[$ranked.severity] == .annotation_level)
        | {review: $review, severity: $ranked.severity, file: (if .path == ".github" then "" else (.path // "") end),
           line: (.start_line // 0), title: $ranked.title, detail: (.message // "")}]
      | if $mode == "nits" then [.[] | select(.severity == "Nit")] | length else . end' --arg mode "$mode"
    ;;
  verdict)
    annotations "Classify" | jq -r '
      [.[] | select(.annotation_level == "notice") | (.title // "") | capture("^Verdict: (?<v>ship|show|ask)$") | .v]
      | if length == 1 then .[0] else "missing" end'
    ;;
  *) echo "review-findings.sh doesn't know $mode" >&2; exit 1 ;;
esac
