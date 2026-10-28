#!/bin/bash
# Writes the user settings of one Claude session, in a home of its own, so that every command the
# session runs, tests included, runs in Claude Code's own sandbox (chrismdp/awml#131). Each session
# starts claude with HOME set to that home and --setting-sources user, so these are the only
# settings it loads, and none in the tree can loosen them.
#
#   claude-settings.sh HOME [--write DIR]... [--deny-write PATH]... [--domain HOST]...
#
# Writes are also denied, whatever the flags say, to the places on the runner a command could use to
# reach beyond its job's sandbox: the runner's file-command folder, which sets a step's outputs and
# environment, the tool cache, which later steps run from, and the runner's own folders in the job's
# real home. With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB set, Claude Code 2.1.312 itself denies writes, in
# a list no setting can loosen, to the launch folder's .github, scripts, node_modules/.bin,
# package.json, package-lock.json, .npmrc, .claude and git's hooks and config, and to the runner's
# file-command folder and event file; but it reckons the runner's folders from HOME, which here is
# the session's own, so they're named here from the job's.
#
# The keys are Claude Code's, from its sandboxing documentation: the sandbox on, and Claude Code
# refusing to start without it; no retry of a command outside it, and no command excluded from it;
# a fresh /proc, so a command sees no process outside the sandbox, Claude Code's own included,
# whose environment holds the login token; no user namespaces inside it; writes to the working
# directory, the session's own temporary directory, the added folders and each --write folder, but
# never to a --deny-write path; and the network only to the --domain hosts, every other host refused
# rather than asked about.
set -euo pipefail

home="$1"
shift
writable=()
denied=()
domains=()
while [ $# -gt 0 ]; do
  case "$1" in
    --write) writable+=("$2"); shift 2 ;;
    --deny-write) denied+=("$2"); shift 2 ;;
    --domain) domains+=("$2"); shift 2 ;;
    *) echo "claude-settings.sh doesn't know $1" >&2; exit 1 ;;
  esac
done

if [ -e "$home/.claude/settings.json" ]; then
  echo "The session's home already holds settings, so it isn't a home of its own: $home" >&2
  exit 1
fi
for runner_path in "${RUNNER_TEMP:+$RUNNER_TEMP/_runner_file_commands}" "${RUNNER_TOOL_CACHE:-}" \
  "${HOME:+$HOME/actions-runner}" "${HOME:+$HOME/runners}"; do
  [ -z "$runner_path" ] || denied+=("$runner_path")
done
mkdir -p "$home/.claude"
list() { if [ $# -gt 0 ]; then printf '%s\n' "$@"; fi | jq -Rsc 'split("\n") | map(select(. != ""))'; }
jq -n \
  --argjson write "$(list "${writable[@]}")" \
  --argjson deny "$(list "${denied[@]}")" \
  --argjson domains "$(list "${domains[@]}")" \
  '{
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      allowNestedUserNamespaces: false,
      filesystem: {allowWrite: $write, denyWrite: $deny},
      network: {allowedDomains: $domains, strictAllowlist: true}
    }
  }' > "$home/.claude/settings.json"
