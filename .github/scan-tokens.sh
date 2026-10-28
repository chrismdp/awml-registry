#!/bin/bash
# Refuses anything a Claude session wrote that looks like a login token, before it's uploaded,
# pushed or posted (chrismdp/awml#160): an sk-ant- key anywhere, or a run of 80 or more letters,
# digits, - and _ that holds a digit. Packages' integrity hashes, as package-lock.json names them,
# and base64 data, as a page or a drawing embeds it, are left out of the runs. It names each file it
# refuses, never what it found there, since the log is public.
#
#   scan-tokens.sh PATH...
set -euo pipefail

found=0
while IFS= read -r -d '' file; do
  if sed -E -e 's#sha(1|256|384|512)-[A-Za-z0-9+/]+=*##g' -e 's#base64,[A-Za-z0-9+/]+=*##g' "$file" |
    grep -aoiE 'sk-ant-|[A-Za-z0-9_-]{80,}' | grep -qiE 'sk-ant-|[0-9]'; then
    echo "$file carries what looks like a login token." >&2
    found=1
  fi
done < <(find "$@" -type f -print0)
exit "$found"
