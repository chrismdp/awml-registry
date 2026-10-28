#!/bin/bash
# Puts each issue a closing keyword names in a code span, where GitHub reads no reference, so that
# text Claude wrote closes no issue when it merges, in a commit's message or a pull request's
# description. The build adds its own Closes #n after it. Reads standard input, writes standard
# output. Needs jq.
set -euo pipefail

jq -jRs 'gsub("(?<keyword>\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?\\s+)(?<ref>(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+|https?://[^\\s`<>()]+)";
  "\(.keyword)`\(.ref)`"; "i")'
