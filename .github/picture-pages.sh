#!/bin/bash
# Pictures the pages a change alters, on main and on the change, at desktop width and at phone
# width. The build workflow's pictures job runs main's copy of it in a checkout of main with
# main's dependencies installed and nothing applied. It is the only part of the build that runs
# the registry itself, and it holds no token that can write.
#
#   picture-pages.sh <pictures.json> <change.patch> <out>
#
# pictures.json is the list Claude writes of the pages its change alters, at most 20, each
#   {"path": "/acme/dinners", "as": "visitor"}
# where "as" is "visitor", someone signed out, or "owner", ana signed in, and is "visitor" if left
# out. A page that moves when someone uses it also lists "moves", at most 10, each one of
#   {"scroll": "<selector>"}, {"click": "<selector>"}, {"press": "<key>", "on": "<selector>"},
#   {"drag": "<selector>", "by": [x, y]} or {"wait": <milliseconds, up to 5000>}
# and is recorded as a GIF of those moves, where a page without moves is a still PNG.
#
# For each side, main first and then main with the change applied, it builds the registry with
# `next build`, serves it as the Dockerfile does with a new SQLite database and no email set up,
# fills it with that side's scripts/seed-pictures.ts, and pictures each page. Both sides get the
# same data unless the change alters the seed, which the build rules send to review. The times a
# page shows differ by the minutes between the two runs.
#
# It writes into the directory it's given:
# - pictures/, a before and an after picture of each page at each width;
# - pictures/manifest.json, a list of {page, as, width, before, after}, with paths relative to
#   pictures/, and "" for a picture that couldn't be taken.
#
# Needs Node, npm, jq, curl, openssl and a Chrome, at $CHROME or /usr/bin/google-chrome.
set -euo pipefail
pages="$1"
patch="$2"
out="$3"
here="$(cd "$(dirname "$0")" && pwd)"

if ! jq -e '
  type == "array" and length <= 20 and all(.[];
    type == "object" and (keys - ["path", "as", "moves"] | length == 0) and
    (.path | type == "string" and test("^/[A-Za-z0-9._~/?=&%-]*$")) and
    ((.as // "visitor") | . == "visitor" or . == "owner") and
    ((.moves // []) | type == "array" and length <= 10 and all(.[];
      type == "object" and (
        (keys == ["scroll"] and (.scroll | type == "string")) or
        (keys == ["click"] and (.click | type == "string")) or
        ((keys == ["press"] or keys == ["on", "press"]) and (.press | type == "string") and
          ((.on // "") | type == "string")) or
        (keys == ["by", "drag"] and (.drag | type == "string") and
          (.by | type == "array" and length == 2 and all(.[]; type == "number"))) or
        (keys == ["wait"] and (.wait | type == "number" and . >= 0 and . <= 5000))))))
' "$pages" > /dev/null; then
  echo "pictures.json isn't a list of pages in the form .github/picture-pages.sh describes."
  exit 1
fi

tmp="$(mktemp -d)"
server=""
stop_server() {
  if [ -n "$server" ]; then
    kill "$server" 2> /dev/null || true
    wait "$server" 2> /dev/null || true
    server=""
  fi
}
trap 'stop_server; rm -rf "$tmp"' EXIT

# The browser driver and the GIF encoder, kept out of the registry's own dependencies.
mkdir -p "$tmp/driver"
cp "$here/picture-pages.mjs" "$tmp/driver/"
npm install --prefix "$tmp/driver" --no-save --no-audit --no-fund \
  playwright-core@1.63.0 gifenc@1.0.3 pngjs@7.0.0 > "$tmp/driver.log" 2>&1 \
  || { cat "$tmp/driver.log"; exit 1; }

port=3100
base="http://127.0.0.1:$port"
secret="$(openssl rand -hex 32)"
mkdir -p "$out/pictures"

picture() {
  local side="$1"
  echo "Building $side."
  if ! env -u MAIL_FROM DATABASE_PATH="$tmp/$side-build.db" BETTER_AUTH_URL="$base" \
    BETTER_AUTH_SECRET="$secret" npx next build > "$tmp/$side-build.log" 2>&1; then
    tail -n 80 "$tmp/$side-build.log"
    echo "The registry didn't build on $side."
    return 1
  fi
  rm -rf .next/standalone/.next/static
  cp -r .next/static .next/standalone/.next/static

  if curl -fsS -o /dev/null "$base/" 2> /dev/null; then
    echo "Something else already answers at $base."
    return 1
  fi
  # Without MAIL_FROM, the registry prints each sign-in link to its log, where the seed reads it.
  (cd .next/standalone && exec env -u MAIL_FROM -u SMTP_URL -u SMTP_HOST PORT="$port" \
    HOSTNAME=127.0.0.1 DATABASE_PATH="$tmp/$side.db" BETTER_AUTH_URL="$base" \
    BETTER_AUTH_SECRET="$secret" node server.js) > "$tmp/$side-server.log" 2>&1 &
  server=$!
  for _ in $(seq 60); do
    curl -fsS -o /dev/null "$base/" 2> /dev/null && break
    sleep 1
  done
  if ! curl -fsS -o /dev/null "$base/"; then
    cat "$tmp/$side-server.log"
    echo "The registry didn't start on $side."
    return 1
  fi

  echo "Seeding $side."
  if ! node --experimental-strip-types --no-warnings scripts/seed-pictures.ts --base "$base" \
    --log "$tmp/$side-server.log" > "$tmp/$side-cookie.txt"; then
    cat "$tmp/$side-server.log"
    echo "Seeding the registry didn't work on $side."
    return 1
  fi

  echo "Picturing $side."
  node "$tmp/driver/picture-pages.mjs" --base "$base" --cookie "$tmp/$side-cookie.txt" \
    --pages "$pages" --side "$side" --out "$out/pictures"
  stop_server
}

picture before
git apply --index "$patch"
if ! git diff --cached --quiet HEAD -- package.json package-lock.json; then
  npm ci
fi
picture after

jq -n --slurpfile pages "$pages" \
  --slurpfile before "$out/pictures/before.json" --slurpfile after "$out/pictures/after.json" '
  def file($side; $i; $w): [$side[] | select(.index == $i and .width == $w) | .file][0] // "";
  [$pages[0] | to_entries[] | .key as $i | .value as $page | ("desktop", "phone") as $w
    | {page: $page.path, as: ($page.as // "visitor"), width: $w,
       before: file($before[0]; $i; $w), after: file($after[0]; $i; $w)}]
' > "$out/pictures/manifest.json"
rm "$out/pictures/before.json" "$out/pictures/after.json"
cat "$out/pictures/manifest.json"
