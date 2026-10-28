import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};

type Job = {
  name?: string;
  "runs-on"?: string;
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: Record<string, unknown>; "fail-fast"?: boolean };
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  steps?: Step[];
};

type Workflow = {
  "run-name"?: string;
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

function readWorkflow(file: string): Workflow {
  const text = readFileSync(
    join(__dirname, "../.github/workflows", file),
    "utf8",
  );
  return parse(text) as Workflow;
}

function readJobs(file: string): Record<string, Job> {
  return readWorkflow(file).jobs;
}

function steps(job: Job | undefined): Step[] {
  return job?.steps ?? [];
}

function runs(job: Job | undefined): string {
  return steps(job)
    .map((step) => step.run ?? "")
    .join("\n");
}

function needs(job: Job | undefined): string[] {
  return job?.needs === undefined ? [] : [job.needs].flat();
}

function writes(job: Job | undefined): string[] {
  return Object.entries(job?.permissions ?? {})
    .filter(([, level]) => level === "write")
    .map(([name]) => name);
}

function step(job: Job | undefined, name: string): Step {
  const found = steps(job).find((each) => each.name === name);
  if (!found) throw new Error(`No step named ${name}`);
  return found;
}

// A step by its id, which stays put when the step's name changes.
function stepWithId(job: Job | undefined, id: string): Step {
  const found = steps(job).find((each) => each.id === id);
  if (!found) throw new Error(`No step with id ${id}`);
  return found;
}

// The workflows that start Claude, and how many steps in each do: CI's reviews, one a job, and
// Classify; the build's draft; the fixer's fix; and the rebase's three rounds of resolving real
// conflicts.
const claudeSteps: Record<string, number> = { "ci.yml": 2, "build.yml": 1, "fix.yml": 1, "resolve.yml": 3 };

const workflowFiles = readdirSync(join(__dirname, "../.github/workflows")).filter((file) =>
  file.endsWith(".yml"),
);

// A rehearsal runs one step's script as GitHub runs it, with bash -eo pipefail, in a scratch RUNNER_TEMP,
// with gh replaced by a stub that logs each call, keeps what each call sends with --input -, and
// answers from the case arms a test gives it. Nothing reaches GitHub.
const canRehearse = ["bash", "git", "jq"].every(
  (tool) => spawnSync(tool, ["--version"]).status === 0,
);

const ghStub = (answers: string) => `#!/bin/bash
# Stands in for gh in a rehearsal.
call="$*"
printf '%s\\n' "$call" >> "$GH_CALLS"
query=""
download=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) query="$2"; shift ;;
    -D) download="$2"; shift ;;
    --body-file) sed 's/^/> /' "$2" >> "$GH_CALLS"; shift ;;
    --input) [ "$2" != - ] || jq -c . >> "$GH_INPUTS"; shift ;;
  esac
  shift
done
answer() { if [ -n "$query" ]; then jq -r "$query"; else cat; fi; }
case "$call" in
${answers}
  *) echo "the stub gh has no answer for: $call" >&2; exit 1 ;;
esac
`;

// Stands in for claude in a rehearsal: it logs, as a line of JSON, the home it starts in and whether
// that home is empty, whether it could change INPUT_DIR, and what it was started with, and writes
// nothing else.
const claudeStub = `#!/bin/bash
empty=no
[ -n "$(ls -A "$HOME" 2> /dev/null)" ] || empty=yes
changes=no
if touch "$INPUT_DIR/planted" 2> /dev/null || [ -w "$INPUT_DIR/REVIEW.md" ]; then changes=yes; fi
# A command in the session could rewrite the script that started it, which bash reads as it goes, so
# for each script it's told of, the stub finds where the shell running it has read up to, from
# /proc, and writes a line there, which must never run.
IFS=: read -r -a rewrite <<< "\${REWRITE:-}"
for script in "\${rewrite[@]}"; do
  [ -n "$script" ] || continue
  pid=$PPID
  while [ "$pid" -gt 1 ]; do
    for fd in /proc/$pid/fd/*; do
      if [ "$(readlink "$fd")" = "$script" ]; then
        pos="$(awk '/^pos:/ { print $2 }' "/proc/$pid/fdinfo/\${fd##*/}")"
        truncate -s "$pos" "$script"
        printf '\ntouch "%s"\n' "$PWNED" >> "$script"
        break 2
      fi
    done
    pid="$(awk '{ print $4 }' "/proc/$pid/stat")"
  done
done
args="$(printf '%s\\0' "$@" | jq -Rsc 'split("\\u0000") | .[:-1]')"
jq -nc --arg home "$HOME" --arg empty "$empty" --arg changes "$changes" --argjson args "$args" \\
  '{home: $home, empty: $empty, changes: $changes, args: $args}' >> "$CLAUDE_LOG"
`;

type Session = { home: string; empty: string; changes: string; args: string[] };

// The values a session was given for a flag that takes several, up to the next flag.
function flagValues(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((arg) => arg.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}

// Runs a step that starts Claude, with the stub in claude's place, and gives back each session.
function sessions(script: string, root: string, env: Record<string, string>): { run: Rehearsal; started: Session[] } {
  const bin = join(root, "bin");
  put(join(bin, "claude"), claudeStub);
  chmodSync(join(bin, "claude"), 0o755);
  const pwned = join(root, "pwned");
  const run = rehearse(script, {
    root,
    env: { CLAUDE_LOG: join(root, "claude.log"), PWNED: pwned, ...env, REWRITE: [join(root, "step.sh"), env.REWRITE ?? ""].join(":") },
  });
  // Whatever the session appended to a script that started it never runs.
  expect(existsSync(pwned), "a line the session appended to its script ran").toBe(false);
  const started = readIfThere(join(root, "claude.log"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Session);
  return { run, started };
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// The digest the workflows take of an artifact's folder: each file's sha256 by its path in the
// folder, sorted, as sha256sum lists them, then the sha256 of that list.
function digestOf(dir: string): string {
  const files: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
      const path = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files.push(`./${path}`);
    }
  };
  walk("");
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha256(files.map((file) => `${sha256(readFileSync(join(dir, file)))}  ${file}\n`).join(""));
}

// The line every workflow uses to take that digest.
const digestLine =
  'digest() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) | sha256sum | cut -c 1-64; }';

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) {
    // Some rehearsals leave folders that can't be written to, as the workflows leave them.
    spawnSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-workflows-"));
  scratches.push(dir);
  mkdirSync(join(dir, "runner"));
  return dir;
}

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function readIfThere(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

type Rehearsal = {
  failed: boolean;
  printed: string;
  calls: string;
  inputs: Record<string, unknown>[];
  outputs: Record<string, string>;
};

function rehearse(
  script: string,
  {
    root,
    cwd = root,
    env = {},
    answers = "",
  }: {
    root: string;
    cwd?: string;
    env?: Record<string, string>;
    answers?: string;
  },
): Rehearsal {
  const bin = join(root, "bin");
  put(join(bin, "gh"), ghStub(answers));
  chmodSync(join(bin, "gh"), 0o755);
  put(join(root, "step.sh"), script);
  const ran = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(root, "step.sh")], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      RUNNER_TEMP: join(root, "runner"),
      GITHUB_OUTPUT: join(root, "output"),
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REPOSITORY_OWNER: "owner",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "1000",
      GH_TOKEN: "not-a-token",
      GH_CALLS: join(root, "calls"),
      GH_INPUTS: join(root, "inputs"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_ENV: "test",
      ...env,
    },
  });
  return {
    failed: ran.status !== 0,
    printed: `${ran.stdout}${ran.stderr}`,
    calls: readIfThere(join(root, "calls")),
    inputs: readIfThere(join(root, "inputs"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    outputs: Object.fromEntries(
      readIfThere(join(root, "output"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    ),
  };
}

// A file a rehearsal left under its RUNNER_TEMP.
function left(root: string, path: string): string {
  return readIfThere(join(root, "runner", path));
}

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=A reviewer",
      "-c",
      "user.email=reviewer@example.com",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        NODE_ENV: "test",
      },
    },
  ).trim();
}

function squash(text: string | undefined): string {
  return (text ?? "").split(/\s+/).filter(Boolean).join(" ");
}


const github = join(__dirname, "../.github");

// GitHub's action that clones the repository into a job.
const CLONE = "checkout"; // eslint-disable-line awml/no-billing -- a GitHub action's name, not a payment
const cloneAction = `actions/${CLONE}@`;

// Runs one of the factory's scripts in .github/ as a workflow step would, with gh stubbed.
function script(name: string, args: string[] = []): string {
  return `bash ${join(github, name)} ${args.map((arg) => `'${arg}'`).join(" ")}\n`;
}

// Every job of every workflow, as file, job id and job.
function everyJob(): [string, string, Job][] {
  return workflowFiles.flatMap((file) =>
    Object.entries(readJobs(file)).map(([id, job]) => [file, id, job] as [string, string, Job]),
  );
}

// The workflow commands GitHub would act on in a step's output: every line starting with "::" that
// isn't between a ::stop-commands:: and the token that resumes them.
function commandsIn(printed: string): string[] {
  const commands: string[] = [];
  let stopped: string | undefined;
  for (const line of printed.split("\n")) {
    if (stopped !== undefined) {
      if (line === `::${stopped}::`) stopped = undefined;
      continue;
    }
    const stop = /^::stop-commands::(.+)$/.exec(line);
    if (stop) stopped = stop[1];
    else if (line.startsWith("::")) commands.push(line);
  }
  return commands;
}

// A pull request the factory's app opened from build/issue-7, and a stranger's newer one from the
// same branch, at the same head, which GitHub lists first.
const appPull = (head: string, repository = "owner/repo") => ({
  number: 12,
  user: { login: "awml-factory[bot]", type: "Bot" },
  author_association: "NONE",
  head: { sha: head, ref: "build/issue-7", repo: { full_name: repository } },
  base: { ref: "main" },
});
const strangerPull = (head: string) => ({
  number: 99,
  user: { login: "stranger", type: "User" },
  author_association: "NONE",
  head: { sha: head, ref: "build/issue-7", repo: { full_name: "owner/repo" } },
  base: { ref: "main" },
});

// GitHub's answer to who may write: the repository's own people by their role, anyone else read.
const roles: Record<string, string> = { owner: "admin", lead: "maintain", maintainer: "write", triager: "triage", stranger: "read" };
const permissionStub = Object.entries(roles)
  .map(([login, role]) => `  *"collaborators/${login}/permission"*) answer <<< '${JSON.stringify({ role_name: role })}' ;;`)
  .join("\n");

// A path that would end its line and start a workflow command of its own if printed as it is.
const forgedPath = "a\n::notice title=Verdict::ship\nb";

// A step's script with each round script of resolve.yml it runs written out in its place, so the
// checks of Claude's steps and of git after them read what the step really runs.
function runOf(each: Step): string {
  return (each.run ?? "").replace(/bash "\$RUNNER_TEMP\/main\/(resolve-(?:session|continue)\.sh)"[^\n]*/g, (_, name: string) =>
    readFileSync(join(github, name), "utf8"),
  );
}

// The npm settings every npm run on the host takes in a job that holds the Claude token, so a tree's
// .npmrc, user or global config can't point npm at another registry or a script shell, and no
// package's script runs.
const hostNpm = {
  npm_config_userconfig: "/dev/null",
  npm_config_globalconfig: "/dev/null",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_ignore_scripts: "true",
};

// The files the app never pushes, and whose change on a branch keeps npm from running on it.
const neverPushed = [
  ".github/workflows/ci.yml",
  ".claude/settings.json",
  ".mcp.json",
  "src/CLAUDE.md",
  ".npmrc",
  "src/.npmrc",
  ".yarnrc.yml",
  "node_modules/left-pad/index.js",
  "npm-shrinkwrap.json",
  "yarn.lock",
];

function holdsClaude(job: Job): boolean {
  return steps(job).some((each) => each.env !== undefined && "CLAUDE_CODE_OAUTH_TOKEN" in each.env);
}

describe("the factory's workflows", () => {
  it("are the six of the redesign, with review.yml gone into CI", () => {
    expect(workflowFiles.sort()).toEqual([
      "build.yml",
      "ci.yml",
      "fix.yml",
      "land.yml",
      "notify-awml-io.yml",
      "resolve.yml",
      "retry.yml",
    ]);
  });

  // GitHub turns pull_request_target off by default on public repositories, and a run on it holds
  // main's secrets beside a stranger's branch.
  it("never run on pull_request_target", () => {
    for (const file of workflowFiles) expect(Object.keys(readWorkflow(file).on ?? {}), file).not.toContain("pull_request_target");
  });

  // Each workflow is drawn, and its header points at its drawing.
  it.each([
    ["ci.yml", "ci-a-commit.yaml"],
    ["build.yml", "issue-to-pull-request.yaml"],
    ["land.yml", "land-a-pull-request.yaml"],
    ["fix.yml", "fix-review-findings.yaml"],
    ["retry.yml", "retry-a-build.yaml"],
    ["resolve.yml", "rebase-conflicting-pull-requests.yaml"],
  ])("point %s at its drawing", (file, drawing) => {
    const text = readFileSync(join(github, "workflows", file), "utf8");
    const header = text.slice(0, text.indexOf("\nname:"));
    expect(header).toContain(`.github/drawings/${drawing}`);
    expect(existsSync(join(github, "drawings", drawing))).toBe(true);
    expect(readFileSync(join(github, "drawings", drawing), "utf8")).toContain(`GitHub Actions, ${file}`);
  });

  // Nothing sets a pull request to merge by itself, so nothing set for an older commit carries over.
  it("use no auto-merge anywhere", () => {
    for (const file of workflowFiles) {
      const text = readFileSync(join(github, "workflows", file), "utf8");
      for (const word of ["--auto", "--disable-auto", "auto_merge", "enablePullRequestAutoMerge"])
        expect(text, `${file} uses ${word}`).not.toContain(word);
    }
  });

  // State is derived from GitHub and git, never passed on: no record line in a description, no
  // marker in a comment for a later run to find, and no comment edited to show progress.
  it("leave no record or marker for a later run, and edit no comment", () => {
    const files = [...workflowFiles.map((file) => join(github, "workflows", file)), join(github, "pull-request-body.sh")];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/factory-(build|status|replaced|resolve-status)/);
      expect(text, path).not.toMatch(/-X PATCH "?repos\/[^ ]*\/(issues|pulls)\/comments/);
      expect(text, path).not.toMatch(/gh (issue|pr) comment[^\n]*--edit-last/);
      expect(text, path).not.toMatch(/echo "<!--/);
    }
  });

  // A retry hands the build the issue's number and nothing it trusts. No other workflow takes
  // inputs.
  it("take no dispatch inputs but the build's issue number", () => {
    for (const file of workflowFiles) {
      const dispatch = (readWorkflow(file).on ?? {}).workflow_dispatch as { inputs?: Record<string, unknown> } | null | undefined;
      const inputs = Object.keys(dispatch?.inputs ?? {});
      expect(inputs, file).toEqual(file === "build.yml" ? ["issue"] : []);
    }
  });

  // An expression in a script is pasted in before bash reads it, so event text there would run.
  it("never expand an expression in a script", () => {
    for (const [file, id, job] of everyJob())
      for (const each of steps(job)) expect(runOf(each), `${file} ${id} ${each.name}`).not.toContain("${{");
  });

  // The app's token is for this repository alone, and only a job that runs none of the change's
  // code and no Claude session mints it.
  it("make the app's token for this repository alone, and never beside Claude", () => {
    for (const [file, id, job] of everyJob())
      for (const each of steps(job)) {
        if (!each.uses?.startsWith("actions/create-github-app-token")) continue;
        expect(each.with?.owner, `${file} ${id}`).toBe("${{ github.repository_owner }}");
        expect(each.with?.repositories, `${file} ${id}`).toBe("${{ github.event.repository.name }}");
        expect(holdsClaude(job), `${file} ${id} mints the app's token beside Claude`).toBe(false);
      }
  });

  // Every token a job holds that can write is the least it needs, and a job that holds Claude's
  // token or runs the change's code holds none that writes.
  it("never give a token that can write to a job that runs Claude", () => {
    for (const [file, id, job] of everyJob()) {
      if (!holdsClaude(job)) continue;
      expect(writes(job), `${file} ${id}`).toEqual([]);
    }
  });

  // No job that holds the Claude token runs anything outside Claude's sandbox: the runner has sudo,
  // and its memory holds the job's secrets. Claude Code itself and bubblewrap are installed, and
  // main's own scripts run, but nothing of the change's: no npm ci, no tests, no node.
  it("run nothing of the change's beside the Claude token", () => {
    const found: string[] = [];
    for (const [file, id, job] of everyJob()) {
      if (!holdsClaude(job)) continue;
      found.push(`${file} ${id}`);
      for (const each of steps(job)) {
        const where = `${file} ${id} "${each.name ?? each.uses}"`;
        // The commands a session may run are its own, inside its sandbox.
        const script = (runOf(each))
          .replace("npm install -g @anthropic-ai/claude-code@2.1.312", "")
          .replace(/npm ci --ignore-scripts --no-audit --no-fund/g, "")
          .replace(/"Bash\([^"]*\)"/g, "");
        expect(script, where).not.toMatch(/(^\s*|[;&|(]\s*)(npm|npx|node|tsc|eslint|vitest|make)\b/m);
        if (each.uses)
          expect([cloneAction, "actions/setup-node@", "actions/upload-artifact@", "actions/download-artifact@"].some((action) => each.uses?.startsWith(action)), where).toBe(true);
        if (each.uses?.startsWith("actions/setup-node")) expect(each.with?.["package-manager-cache"], where).toBe(false);
      }
    }
    expect(found.sort()).toEqual(["build.yml draft", "ci.yml classify", "ci.yml review", "fix.yml fix", "resolve.yml draft"]);
  });

  // bash reads a step's script, and any script it runs, as it goes, so a command in the session could
  // rewrite what follows claude and run it outside the sandbox, beside the token. Each step that
  // holds the token, and each script that starts claude, is one group, parsed whole before claude
  // starts, that ends by exiting; and the scripts are denied to the session.
  it("parse every step and script that starts claude whole before it starts, and deny them to the session", () => {
    const steps_: string[] = [];
    for (const [file, id, job] of everyJob())
      for (const each of steps(job)) {
        if (!(each.env && "CLAUDE_CODE_OAUTH_TOKEN" in each.env)) continue;
        steps_.push(`${file} ${id} ${each.id}`);
        const body = (each.run ?? "").trim();
        expect(body.startsWith("{"), `${file} ${each.id}`).toBe(true);
        expect(body.endsWith("}"), `${file} ${each.id}`).toBe(true);
        expect(body.slice(0, -1).trim().split("\n").pop() ?? "", `${file} ${each.id}`).toMatch(/(^|; )exit( "\$status")?;?$/);
        if (/claude-settings\.sh/.test(body)) expect(body, `${file} ${each.id}`).toContain('--deny-write "$0"');
        else expect(body, `${file} ${each.id}`).toMatch(/^\{ STEP_SCRIPT="\$0" bash "\$RUNNER_TEMP\/main\/resolve-session\.sh" [123]; exit; \}$/);
      }
    expect(steps_.length).toBe(7);
    const session = readFileSync(join(github, "resolve-session.sh"), "utf8");
    const body = session.slice(session.indexOf("set -euo pipefail\n") + "set -euo pipefail\n".length).trim();
    expect(body.startsWith("{")).toBe(true);
    expect(body.endsWith("}")).toBe(true);
    expect(body.slice(0, -1).trim().split("\n").pop()?.trim()).toBe("exit 0");
    expect(session).toContain('--deny-write "$0" --deny-write "$STEP_SCRIPT"');
  });

  it("scrub the token from Claude's commands, and hold it only where Claude starts", () => {
    const holders: Record<string, number> = {};
    for (const [file, id, job] of everyJob())
      for (const each of steps(job)) {
        const holds = each.env !== undefined && "CLAUDE_CODE_OAUTH_TOKEN" in each.env;
        const starts = /\bclaude -p\b/.test(runOf(each));
        expect(holds, `${file} ${id} "${each.name}"`).toBe(starts);
        if (!holds) continue;
        holders[file] = (holders[file] ?? 0) + 1;
        expect(each.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
        expect(each.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, `${file} ${id}`).toBe("1");
      }
    expect(holders).toEqual(claudeSteps);
  });

  // Each session runs its commands in Claude Code's own sandbox, which needs bubblewrap and socat.
  // Its settings come from a home of its own, written by main's claude-settings.sh, loaded alone
  // with --setting-sources user, and no MCP server loads. It reads only the workspace and its own
  // input folder, never /proc, and never edits git's own files. Main's prompt is copied out before
  // the session starts.
  it("start every claude -p sandboxed, from settings of its own, reading only the workspace and its inputs", () => {
    const checked: Record<string, number> = {};
    for (const [file, id, job] of everyJob()) {
      const all = steps(job);
      all.forEach((each, index) => {
        const script = runOf(each);
        const count = script.match(/\bclaude -p\b/g)?.length ?? 0;
        if (count === 0) return;
        checked[file] = (checked[file] ?? 0) + 1;
        const where = `${file} ${id}`;
        const before = all.slice(0, index).map((prior) => runOf(prior)).join("\n");
        expect(before, where).toContain("apt-get install -y bubblewrap socat");
        expect(before, where).toContain("bwrap --dev-bind / / --unshare-pid true");
        expect(before + script, where).toContain("claude-settings.sh");
        for (const flag of [/--setting-sources user[\s\\]/g, /--strict-mcp-config\b/g, /HOME="\$[a-z_]+\/home" claude -p/g])
          expect(script.match(flag)?.length ?? 0, `${where} ${flag}`).toBe(count);
        expect(script, where).toContain('"Read(//proc/**)"');
        expect(script, where).toContain('"Edit(./.git/**)"');
        expect(script, where).toContain('"Write(./.git/**)"');
        expect(script, where).not.toMatch(/"(Read|Glob|Grep)"/);
      });
    }
    expect(checked).toEqual(claudeSteps);
  });

  // Git after a session reads a tree Claude wrote, so it runs no hook and no fsmonitor of the tree's.
  it("run git with hooks and fsmonitor off once a session has written the tree", () => {
    for (const [file, id, job] of everyJob()) {
      const all = steps(job);
      const first = all.findIndex((each) => /\bclaude -p\b/.test(runOf(each)));
      if (first < 0) continue;
      for (const each of all.slice(first + 1))
        for (const line of runOf(each).replace(/"Bash\([^"]*\)"/g, "").split("\n")) {
          if (!/(^|[\s;(|&])git\s/.test(line) || /^(#|echo |give_up )/.test(line.trim())) continue;
          const where = `${file} ${id} "${each.name}"`;
          if (/\bsafe_git\b/.test(line)) {
            expect(runOf(each), where).toContain(
              'safe_git() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 command git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= "$@"; }',
            );
            if (/ diff /.test(line)) expect(line, where).toContain("--no-ext-diff --no-textconv");
            continue;
          }
          expect(line, where).toMatch(/git (-C "\$clone" )?-c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -c diff\.external= /);
          if (/ diff /.test(line)) expect(line, where).toContain("--no-ext-diff --no-textconv");
        }
    }
  });

  // Everything a session wrote is scanned for a token by main's scan-tokens.sh before it's
  // uploaded, pushed or posted.
  it("scan what a session wrote before any upload", () => {
    for (const [file, id, job] of everyJob()) {
      const all = steps(job);
      const first = all.findIndex((each) => /\bclaude -p\b/.test(runOf(each)));
      if (first < 0) continue;
      const scanned = all.findIndex((each, at) => at > first && (runOf(each)).includes("scan-tokens.sh"));
      expect(scanned, `${file} ${id} never scans`).toBeGreaterThan(first);
      all.forEach((each, at) => {
        if (each.uses?.startsWith("actions/upload-artifact")) expect(at, `${file} ${id} uploads before it scans`).toBeGreaterThan(scanned);
      });
    }
  });

  // Artifacts stay within a run. Each one a later job reads is checked against the sha256 the job
  // that made it gave as an output, before anything uses it.
  it("check every artifact against its maker's digest", () => {
    for (const [file, id, job] of everyJob()) {
      const all = steps(job);
      all.forEach((each, at) => {
        if (!each.uses?.startsWith("actions/download-artifact")) return;
        expect(each.with?.["run-id"], `${file} ${id} downloads from another run`).toBeUndefined();
        const next = all[at + 1];
        expect(next?.run ?? "", `${file} ${id}: the step after a download checks it`).toContain(digestLine);
        expect(JSON.stringify(next?.env ?? {}), `${file} ${id}`).toMatch(/needs\.[a-z]+\.outputs\.[a-z_]*digest/);
      });
    }
  });

  // Under CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, Claude Code forces --permission-mode default, so every
  // tool a session may use is named in --allowedTools.
  it("never ask for a permission mode the scrub forces back to default", () => {
    for (const [file, id, job] of everyJob()) expect(runs(job), `${file} ${id}`).not.toContain("acceptEdits");
  });

  it("install one exact version of Claude Code everywhere", () => {
    const installs: string[] = [];
    for (const [file, id, job] of everyJob())
      for (const line of runs(job).split("\n"))
        if (line.includes("@anthropic-ai/claude-code")) installs.push(`${file} ${id}: ${line.trim()}`);
    expect(installs.length).toBe(5);
    for (const install of installs)
      expect(install).toMatch(/: \(cd "\$RUNNER_TEMP" && npm_config_userconfig=\/dev\/null npm_config_globalconfig=\/dev\/null npm install -g @anthropic-ai\/claude-code@2\.1\.312\)$/);
  });

  // A session that runs the checks finds the dependencies already installed, with their scripts
  // off, so it runs no package's code outside its sandbox and needs no network.
  it("install the dependencies with their scripts off before a session that runs the checks", () => {
    for (const [file, id] of [["build.yml", "draft"], ["fix.yml", "fix"], ["resolve.yml", "draft"]]) {
      const all = steps(readJobs(file)[id]);
      const install = all.findIndex((each) => (runOf(each)).includes("npm ci --ignore-scripts --no-audit --no-fund"));
      const session = all.findIndex((each) => /\bclaude -p\b/.test(runOf(each)));
      expect(install, `${file} ${id}`).toBeGreaterThan(-1);
      expect(install, `${file} ${id}`).toBeLessThan(session);
      expect(all[install].env, `${file} ${id}`).toMatchObject(hostNpm);
      expect(all[install].env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    }
  });

  // Every npm the host runs beside the Claude token ignores the tree's, user and global config.
  it("run npm on the host only with its config files and scripts off", () => {
    for (const [file, id, job] of everyJob()) {
      if (!holdsClaude(job)) continue;
      for (const each of steps(job)) {
        const commands = runOf(each).replace(/"Bash\([^"]*\)"/g, "");
        if (!/\bnpm ci\b/.test(commands)) continue;
        expect(each.env, `${file} ${id} "${each.name}"`).toMatchObject(hostNpm);
        // A git dependency's prepare script runs even with scripts off, so the lockfile is checked
        // first: every package from npm's registry, with its integrity.
        const checked = commands.indexOf("check-lockfile.sh");
        expect(checked, `${file} ${id} "${each.name}"`).toBeGreaterThan(-1);
        expect(checked, `${file} ${id} "${each.name}"`).toBeLessThan(commands.indexOf("npm ci"));
      }
    }
  });

  // A session's commands can write almost anywhere under the runner's home and temporary folder,
  // so the baseline git's config and the workspace's identity are kept where they can't.
  it("keep the baseline of git's config, and the workspace's identity, where the session can't write", () => {
    for (const file of ["build.yml", "fix.yml"]) {
      const job = Object.values(readJobs(file)).find(holdsClaude);
      const all = steps(job);
      const first = all.findIndex((each) => /\bclaude -p\b/.test(runOf(each)));
      const before = all.slice(0, first).map(runOf).join("\n");
      expect(before, file).toContain('cp .git/config "$RUNNER_TEMP/baseline/git-config"');
      expect(before, file).toContain('stat -c %d:%i "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE/.git" > "$RUNNER_TEMP/baseline/workspace"');
      expect(runOf(all[first]), file).toContain('--deny-write "$RUNNER_TEMP/baseline"');
    }
  });

  // Git after a session must run nothing the session's commands could have set in git's config:
  // the config is copied out before the session and must be byte for byte the same after it.
  it("check git's config is unchanged before any git runs after a session", () => {
    for (const [file, id, job] of everyJob()) {
      // resolve's host git after a session reads bundles into fresh repositories, tested there.
      if (file === "resolve.yml") continue;
      const all = steps(job);
      const first = all.findIndex((each) => /\bclaude -p\b/.test(runOf(each)));
      if (first < 0) continue;
      const before = all.slice(0, first).map((each) => runOf(each)).join("\n");
      const after = all.slice(first + 1);
      if (!after.some((each) => /(^|\s)git\s/m.test(runOf(each)))) continue;
      expect(before, `${file} ${id}`).toMatch(/cp [^\n]*\.git\/config"? "\$RUNNER_TEMP\//);
      const firstGit = after.find((each) => /(^|\s)git\s/m.test(runOf(each)));
      const text = (firstGit ? runOf(firstGit) : "")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      expect(text.indexOf("cmp -s"), `${file} ${id}`).toBeGreaterThan(-1);
      expect(text.indexOf("cmp -s"), `${file} ${id}`).toBeLessThan(text.search(/(^|\s)git\s/m));
      expect(firstGit?.env?.GIT_CONFIG_GLOBAL, `${file} ${id}`).toBe("/dev/null");
      expect(firstGit?.env?.GIT_CONFIG_NOSYSTEM, `${file} ${id}`).toBe("1");
      expect(firstGit ? runOf(firstGit) : "", `${file} ${id}`).toContain(
        'stat -c %d:%i "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE/.git" | cmp -s - "$RUNNER_TEMP/baseline/workspace"',
      );
    }
  });

  // The session's commands run with the scrubbed environment, but no GitHub token is in it to scrub.
  it("keep GitHub's tokens out of every step and job that holds the Claude token", () => {
    for (const [file, id, job] of everyJob()) {
      if (!holdsClaude(job)) continue;
      expect(Object.keys(job.env ?? {}), `${file} ${id}`).not.toContain("GH_TOKEN");
      for (const each of steps(job))
        if (each.env && "CLAUDE_CODE_OAUTH_TOKEN" in each.env)
          for (const name of Object.keys(each.env)) expect(name, `${file} ${id}`).not.toMatch(/^(GH_TOKEN|GITHUB_TOKEN)$/);
    }
  });

  it("pin every action to a commit", () => {
    for (const [file, id, job] of everyJob()) {
      if (file === "notify-awml-io.yml") continue;
      for (const each of steps(job)) if (each.uses) expect(each.uses, `${file} ${id}`).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
    }
  });

  it("say the app must not hold the workflows permission", () => {
    expect(readFileSync(join(github, "workflows/build.yml"), "utf8")).toContain("must NOT have the workflows permission");
  });

  // Under pipefail, grep -q exits at its first match, its producer dies of SIGPIPE, and the pipe
  // fails, so a match reads as none and a guard lets the file through. Every grep that ends a pipe
  // reads all its input.
  it("never end a pipe in a quiet grep", () => {
    const texts: [string, string][] = readdirSync(github)
      .filter((name) => name.endsWith(".sh"))
      .map((name) => [name, readFileSync(join(github, name), "utf8")]);
    for (const [file, id, job] of everyJob()) for (const each of steps(job)) texts.push([`${file} ${id} ${each.name}`, each.run ?? ""]);
    for (const [where, text] of texts) {
      const joined = text.replace(/\|\s*\\?\n\s*/g, "| ");
      expect(joined, where).not.toMatch(/\|\s*grep\s+(-[A-Za-z]+\s+)*-[A-Za-z]*q/);
    }
  });

  it.runIf(canRehearse)("finds a match early in a long pipe, under pipefail", () => {
    const quiet = spawnSync("bash", ["-c", 'set -o pipefail; if seq 1 2000000 | grep -q "^1$"; then echo matched; fi'], { encoding: "utf8" });
    expect(quiet.stdout, "the quiet grep this guards against no longer fails here").toBe("");
    const whole = spawnSync("bash", ["-c", 'set -o pipefail; if seq 1 2000000 | grep "^1$" > /dev/null; then echo matched; fi'], { encoding: "utf8" });
    expect(whole.stdout).toBe("matched\n");
  });

  it("take each artifact's digest the same way everywhere", () => {
    for (const [file, id, job] of everyJob())
      for (const each of steps(job))
        if (/\bdigest\(\)/.test(runOf(each))) expect(each.run, `${file} ${id}`).toContain(digestLine);
  });

  // The change's code runs in a test job, a pictures job or a session's sandbox, none of which
  // saves or restores an npm cache that a later job would trust, except CI's own test job.
  it("save and restore no npm cache in the factory's jobs", () => {
    for (const [file, id, job] of everyJob())
      for (const each of steps(job)) {
        if (!each.uses?.startsWith("actions/setup-node")) continue;
        expect(each.with?.["package-manager-cache"], `${file} ${id}`).toBe(false);
        expect(each.with?.cache, `${file} ${id}`).toBeUndefined();
      }
  });

  // A comment is new, from fixed text with links, or with any text from Claude or a pull request
  // escaped. Comments are posted only with gh issue comment or gh pr comment.
  it("post comments only as new ones", () => {
    for (const [file, id, job] of everyJob()) {
      const text = runs(job);
      expect(text, `${file} ${id}`).not.toMatch(/issues\/comments\/\$/);
      expect(text, `${file} ${id}`).not.toMatch(/gh api[^\n]*-X PATCH[^\n]*comments/);
    }
  });
});

// The paths the app never pushes, and the ones whose change also keeps npm from a branch, each
// written the same way everywhere, so the lists can't drift apart.
// npm reads npm-shrinkwrap.json before package-lock.json when both are at a tree's root, and yarn.lock
// as well, so each is held back like the dependencies themselves.
const claudesPattern = "(^|/)\\.claude(/|$)|(^|/)\\.mcp\\.json$|(^|/)CLAUDE(\\.local)?\\.md$";
const npmPattern =
  "(^|/)\\.npmrc$|(^|/)\\.yarnrc[^/]*$|(^|/)node_modules(/|$)|(^|/)npm-shrinkwrap\\.json$|(^|/)yarn\\.lock$";
const dependencies = "(^|/)package(-lock)?\\.json$";
const neverPushPattern = `^\\.github/|${claudesPattern}|${npmPattern}`;
const heldBackPattern = `${neverPushPattern}|${dependencies}`;

describe("the factory's path patterns", () => {
  it("are one never-push pattern in the build, and one held-back pattern in the fixer and in resolve", () => {
    const found: string[] = [];
    for (const file of ["build.yml", "fix.yml", "resolve.yml"]) {
      const text = readFileSync(join(github, "workflows", file), "utf8");
      for (const [, name, pattern] of text.matchAll(/\b(guarded|deps|claudes)='([^']*)'/g)) {
        found.push(`${file} ${name}`);
        // The fixer offers a fix to the dependencies rather than push it, since the next fix would
        // install them; the build pushes them, having installed main's. The fixer's decide holds
        // back the dependencies and Claude Code's own files, each with its own reason, but not
        // .github/, which no session or install reads from the tree.
        const want =
          name === "deps" ? `${npmPattern}|${dependencies}` : name === "claudes" ? claudesPattern : file === "build.yml" ? neverPushPattern : heldBackPattern;
        expect(pattern, `${file} ${name}`).toBe(want);
      }
    }
    expect(found.sort()).toEqual([
      "build.yml guarded",
      "fix.yml claudes",
      "fix.yml deps",
      "fix.yml guarded",
      "resolve.yml guarded",
      "resolve.yml guarded",
      "resolve.yml guarded",
    ]);
  });
});

describe("claude-settings.sh", () => {
  // The keys and values are Claude Code's own, from its sandboxing documentation: the sandbox on,
  // refusing to start without it, no retry outside it, no command excluded from it, a fresh /proc
  // so a command can't see Claude Code's process, no nested namespaces, and only the hosts the
  // session needs, with every other host refused.
  it.runIf(canRehearse)("writes the session's user settings with the sandbox on and its network held to the named hosts", () => {
    const root = scratch();
    const home = join(root, "home");
    const run = rehearse(
      script("claude-settings.sh", [home, "--write", "/tmp/npm-cache", "--deny-write", "./.git", "--domain", "registry.npmjs.org"]),
      { root, env: { RUNNER_TOOL_CACHE: "/opt/hostedtoolcache", HOME: "/home/runner" } },
    );
    expect(run.failed, run.printed).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    expect(settings).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        excludedCommands: [],
        enableWeakerNestedSandbox: false,
        allowNestedUserNamespaces: false,
        filesystem: {
          allowWrite: ["/tmp/npm-cache"],
          denyWrite: expect.arrayContaining([
            "./.git",
            join(root, "runner/_runner_file_commands"),
            "/opt/hostedtoolcache",
            "/home/runner/actions-runner",
            "/home/runner/runners",
          ]),
        },
        network: { allowedDomains: ["registry.npmjs.org"], strictAllowlist: true },
      },
    });
  });

  it.runIf(canRehearse)("denies writes to every PATH entry and every bin folder in the tool cache", () => {
    const root = scratch();
    const tools = join(root, "toolcache");
    mkdirSync(join(tools, "node/22.0.0/x64/bin"), { recursive: true });
    const home = join(root, "home");
    const run = rehearse(script("claude-settings.sh", [home]), {
      root,
      env: { RUNNER_TOOL_CACHE: tools, PATH: `${join(root, "bin")}:/usr/local/bin::/usr/bin:${process.env.PATH}` },
    });
    expect(run.failed, run.printed).toBe(false);
    const denied = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).sandbox.filesystem.denyWrite;
    for (const want of [tools, join(tools, "node/22.0.0/x64/bin"), "/usr/local/bin", "/usr/bin", join(root, "bin")]) expect(denied).toContain(want);
    expect(denied).not.toContain("");
  });

  // A command that appended to the runner's file commands could set BASH_ENV, GIT_CONFIG_* or PATH
  // for every later step, so wherever they point is denied, as is the event file.
  it.runIf(canRehearse)("denies writes to the folders of the runner's file commands and to the event file", () => {
    const root = scratch();
    const home = join(root, "home");
    const commands = join(root, "files");
    const env = {
      GITHUB_ENV: join(commands, "env/set_env_1"),
      GITHUB_PATH: join(commands, "path/add_path_1"),
      GITHUB_OUTPUT: join(commands, "output/set_output_1"),
      GITHUB_STEP_SUMMARY: join(commands, "summary/step_summary_1"),
      GITHUB_EVENT_PATH: join(root, "workflow/event.json"),
    };
    const run = rehearse(script("claude-settings.sh", [home]), { root, env });
    expect(run.failed, run.printed).toBe(false);
    const denied = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).sandbox.filesystem.denyWrite;
    for (const want of [join(commands, "env"), join(commands, "path"), join(commands, "output"), join(commands, "summary"), env.GITHUB_EVENT_PATH])
      expect(denied).toContain(want);
  });

  it.runIf(canRehearse)("allows no host at all when none is named", () => {
    const root = scratch();
    const home = join(root, "home");
    expect(rehearse(script("claude-settings.sh", [home]), { root, env: { RUNNER_TEMP: "", HOME: "" } }).failed).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    expect(settings.sandbox.network).toEqual({ allowedDomains: [], strictAllowlist: true });
    expect(settings.sandbox.filesystem.allowWrite).toEqual([]);
  });

  it.runIf(canRehearse)("refuses a home that already holds settings", () => {
    const root = scratch();
    const home = join(root, "home");
    put(join(home, ".claude/settings.json"), "{}");
    expect(rehearse(script("claude-settings.sh", [home]), { root }).failed).toBe(true);
  });

  // The dependencies are installed before a session starts, with their scripts off, so no session
  // needs the network at all.
  it("gives no session any host", () => {
    const domains: string[] = [];
    for (const [file, id, job] of everyJob())
      for (const each of steps(job)) {
        const text = runOf(each);
        if (!text.includes('bash "$RUNNER_TEMP/main/claude-settings.sh"')) continue;
        const named = [...text.matchAll(/--domain ([^\s"]+)/g)].map((match) => match[1]);
        domains.push(`${file} ${id}: ${named.join(" ")}`);
      }
    expect(domains.sort()).toEqual([
      "build.yml draft: ",
      "ci.yml classify: ",
      "ci.yml review: ",
      "fix.yml fix: ",
      "resolve.yml draft: ",
      "resolve.yml draft: ",
      "resolve.yml draft: ",
    ]);
  });
});

// npm runs a git dependency's prepare script on the host even with scripts off, so before any host
// npm ci the lockfile must name only packages from npm's registry, each with its integrity.
describe("check-lockfile.sh", () => {
  const check = (lock: unknown) => {
    const root = scratch();
    put(join(root, "tree/package-lock.json"), JSON.stringify(lock));
    return rehearse(script("check-lockfile.sh", [join(root, "tree")]), { root });
  };
  const good = {
    lockfileVersion: 3,
    packages: {
      "": { name: "awml-registry" },
      "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-x" },
      "node_modules/b": { link: true, resolved: "packages/b" },
    },
  };

  it.runIf(canRehearse)("passes a lockfile of npm's registry alone, in-repo links included", () => {
    expect(check(good).failed).toBe(false);
  });

  // A package bundled inside another comes in that package's tarball, so it has no source of its
  // own; only one nested in another's node_modules can be.
  it.runIf(canRehearse)("passes a package bundled inside another, with no source of its own", () => {
    expect(check({ ...good, packages: { ...good.packages, "node_modules/a/node_modules/d": { inBundle: true, version: "1.0.0" } } }).failed).toBe(false);
  });

  it.runIf(canRehearse)("passes the repository's own lockfile", () => {
    const root = scratch();
    put(join(root, "tree/package-lock.json"), readFileSync(join(__dirname, "../package-lock.json"), "utf8"));
    expect(rehearse(script("check-lockfile.sh", [join(root, "tree")]), { root }).failed).toBe(false);
  });

  // npm reads npm-shrinkwrap.json before package-lock.json, yarn.lock beside them, and a hidden
  // lockfile in node_modules, none of which this checks, so a tree holding any is refused.
  it.runIf(canRehearse).each(["npm-shrinkwrap.json", "web/npm-shrinkwrap.json", "yarn.lock", "node_modules/.package-lock.json"])(
    "refuses a tree that holds %s",
    (path) => {
      const root = scratch();
      put(join(root, "tree/package-lock.json"), JSON.stringify(good));
      put(join(root, "tree", path), "{}");
      expect(rehearse(script("check-lockfile.sh", [join(root, "tree")]), { root }).failed).toBe(true);
    },
  );

  it.runIf(canRehearse).each([
    ["a git dependency", { ...good, packages: { ...good.packages, "node_modules/c": { resolved: "git+ssh://git@github.com/x/c.git#abc", integrity: "sha512-x" } } }],
    ["a tarball from another host", { ...good, packages: { ...good.packages, "node_modules/c": { resolved: "https://example.com/c.tgz", integrity: "sha512-x" } } }],
    ["a package without its integrity", { ...good, packages: { ...good.packages, "node_modules/c": { resolved: "https://registry.npmjs.org/c/-/c-1.0.0.tgz" } } }],
    ["a package without a source", { ...good, packages: { ...good.packages, "node_modules/c": { version: "1.0.0" } } }],
    ["an old lockfile", { ...good, lockfileVersion: 1 }],
    ["a git source flagged as bundled", { ...good, packages: { ...good.packages, "node_modules/a/node_modules/c": { inBundle: true, resolved: "git+https://example.com/c.git" } } }],
    ["a git source flagged as a link", { ...good, packages: { ...good.packages, "node_modules/c": { link: true, resolved: "git+https://example.com/c.git" } } }],
    ["a link to an absolute path", { ...good, packages: { ...good.packages, "node_modules/c": { link: true, resolved: "/etc" } } }],
    ["a link out of the tree", { ...good, packages: { ...good.packages, "node_modules/c": { link: true, resolved: "../elsewhere" } } }],
    ["a link with no target", { ...good, packages: { ...good.packages, "node_modules/c": { link: true } } }],
    ["a top-level package flagged as bundled", { ...good, packages: { ...good.packages, "node_modules/c": { inBundle: true } } }],
    ["no packages", { lockfileVersion: 3 }],
  ])("refuses %s", (_, lock) => {
    expect(check(lock).failed).toBe(true);
  });

  it.runIf(canRehearse)("refuses a tree with no lockfile", () => {
    const root = scratch();
    mkdirSync(join(root, "tree"));
    expect(rehearse(script("check-lockfile.sh", [join(root, "tree")]), { root }).failed).toBe(true);
  });
});

describe("scan-tokens.sh", () => {
  const scan = (text: string) => {
    const root = scratch();
    put(join(root, "files/out.txt"), text);
    return rehearse(script("scan-tokens.sh", [join(root, "files")]), { root });
  };

  it.runIf(canRehearse)("refuses anything like the login token", () => {
    expect(scan("a key: sk-ant-oat01-abc\n").failed).toBe(true);
    expect(scan(`${"a1".repeat(45)}\n`).failed).toBe(true);
  });

  it.runIf(canRehearse)("refuses a token found early in a long file", () => {
    expect(scan(`sk-ant-oat01-abc\n${`${"a1".repeat(45)}\n`.repeat(4000)}`).failed).toBe(true);
  });

  it.runIf(canRehearse)("names a file it refuses without letting its name start a workflow command", () => {
    const root = scratch();
    put(join(root, "files", forgedPath), "sk-ant-oat01-abc\n");
    const run = rehearse(script("scan-tokens.sh", [join(root, "files")]), { root });
    expect(run.failed).toBe(true);
    expect(commandsIn(run.printed)).toEqual([]);
  });

  it.runIf(canRehearse)("names the file but never prints what it found", () => {
    const run = scan(`token sk-ant-oat01-${"x".repeat(30)}\n`);
    expect(run.printed).toContain("out.txt");
    expect(run.printed).not.toContain("sk-ant-oat01");
  });

  // A long run counts only if it holds a digit, and packages' integrity hashes and base64 data are
  // left out, as #160 says.
  it.runIf(canRehearse)("passes long words, integrity hashes and base64 data", () => {
    expect(scan(`${"a".repeat(120)}\n`).failed).toBe(false);
    expect(scan(`"integrity": "sha512-${"Ab1".repeat(30)}=="\n`).failed).toBe(false);
    expect(scan(`src="data:image/png;base64,${"Ab1".repeat(40)}"\n`).failed).toBe(false);
    expect(scan("an ordinary change\n").failed).toBe(false);
  });
});

describe("ci.yml", () => {
  const ci = readWorkflow("ci.yml");
  const jobs = ci.jobs;

  // Each commit gets one run: a pull request's run on every push to it, and a push only on main.
  it("runs on every pull request, and on a push to main only", () => {
    expect(ci.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
  });

  // The required checks keep their names: the tests' check is test, and the reviews' are Bug review
  // and Security review.
  // On pull_request GitHub runs the pull request's own ci.yml, so someone with write access could
  // change how their own pull request is reviewed. The header says so, and why it's accepted.
  it("says plainly that a pull request's own ci.yml runs", () => {
    const text = readFileSync(join(github, "workflows/ci.yml"), "utf8");
    const header = squash(text.slice(0, text.indexOf("\nname:")));
    expect(header).toContain("On pull_request, GitHub runs the pull request's own copy of this file");
    expect(header).toContain("the app can't push .github/");
  });

  it("runs the tests, both reviews and Classify as jobs of one run, under their check names", () => {
    expect(Object.keys(jobs).sort()).toEqual(["classify", "report", "review", "test"]);
    expect(jobs.test.name).toBeUndefined();
    expect(jobs.review.name).toBe("${{ matrix.review.name }}");
    const matrix = jobs.review.strategy?.matrix as { review: { name: string }[] };
    expect(matrix.review.map((review) => review.name)).toEqual(["Bug review", "Security review"]);
    expect(jobs.review.strategy?.["fail-fast"]).toBe(false);
    expect(jobs.classify.name).toBe("Classify");
  });

  it("runs the tests with a token that only reads and no secret", () => {
    expect(jobs.test.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(jobs.test)).not.toContain("secrets.");
    expect(runs(jobs.test)).toContain("npm test");
    expect(needs(jobs.test)).toEqual([]);
  });

  // A push to main runs the tests only. A fork's pull request, or one a stranger opened between two
  // branches here, gets the tests only: its author could steer the sessions, which hold the
  // maintainer's login token.
  // GitHub counts a skipped required check as passed, so the reviews run on every pull request and
  // fail, before anything else, on one from a fork or opened by anyone but the repository's own
  // people or the factory's app: its author could steer the sessions, which hold the login token.
  it("runs the reviews on every pull request, failing first on an untrusted one", () => {
    expect(jobs.review.if).toBe("github.event_name == 'pull_request'");
    expect(needs(jobs.review)).toEqual([]);
    const [gate, ...rest] = steps(jobs.review);
    expect(gate.id).toBe("trust");
    expect(gate.uses).toBeUndefined();
    expect(JSON.stringify(gate)).not.toContain("secrets.");
    expect(gate.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      HEAD_REPOSITORY: "${{ github.event.pull_request.head.repo.full_name }}",
      AUTHOR: "${{ github.event.pull_request.user.login }}",
      AUTHOR_TYPE: "${{ github.event.pull_request.user.type }}",
    });
    // The token reaches only the session, which a failed gate stops before it starts.
    for (const each of rest) if (each.env && "CLAUDE_CODE_OAUTH_TOKEN" in each.env) expect(each.id).toBe("session");
    for (const each of steps(jobs.review)) expect(each.if, each.name).toBeUndefined();
  });

  // Trust is by what GitHub says the opener may do to the repository, not how they're associated
  // with it: an organisation's member may have no write access here.
  const trust = (env: Record<string, string>) =>
    rehearse(stepWithId(jobs.review, "trust").run ?? "", {
      root: scratch(),
      env: { HEAD_REPOSITORY: "owner/repo", AUTHOR: "maintainer", AUTHOR_TYPE: "User", ...env },
      answers: permissionStub,
    });

  it.runIf(canRehearse).each([
    ["a writer's pull request from this repository", {}],
    ["an admin's", { AUTHOR: "owner" }],
    ["a maintainer's", { AUTHOR: "lead" }],
    ["the factory's app's", { AUTHOR: "awml-factory[bot]", AUTHOR_TYPE: "Bot" }],
  ])("lets %s through to the review", (_, env) => {
    const run = trust(env);
    expect(run.failed, run.printed).toBe(false);
  });

  it.runIf(canRehearse).each([
    ["a fork's pull request", { HEAD_REPOSITORY: "stranger/repo", AUTHOR: "owner" }],
    ["a reader's pull request from a branch here", { AUTHOR: "stranger" }],
    ["a triager's", { AUTHOR: "triager" }],
    ["a user who only shares the app's name", { AUTHOR: "awml-factory[bot]", AUTHOR_TYPE: "User" }],
    ["a login that isn't one", { AUTHOR: "../x" }],
  ])("fails the review on %s, saying why", (_, env) => {
    const run = trust(env);
    expect(run.failed).toBe(true);
    expect(run.printed).toContain("isn't reviewed here");
  });

  // Classify isn't a required check, so it keeps its own conditions and is simply skipped. Only the
  // app's pull requests on a factory branch are landed, so only those are classified.
  // land reads Classify only once both reviews have passed, so it runs only then.
  it("classifies only the app's pull request on a factory branch, once both reviews have passed", () => {
    expect(needs(jobs.classify)).toEqual(["review"]);
    expect(squash(jobs.classify.if)).toBe(
      squash(`\${{ needs.review.result == 'success' && startsWith(github.head_ref, 'build/issue-') &&
        github.event.pull_request.head.repo.full_name == github.repository &&
        github.event.pull_request.user.login == 'awml-factory[bot]' && github.event.pull_request.user.type == 'Bot' }}`),
    );
  });

  // The reviews read the patch and run none of the change's code. Each job's own check carries its
  // result, so no job needs a token that writes checks.
  it("reviews and classifies with tokens that only read", () => {
    expect(jobs.review.permissions).toEqual({ contents: "read" });
    expect(jobs.classify.permissions).toEqual({ actions: "read", checks: "read", contents: "read" });
  });

  it("checks out main, not the branch, for the reviews and Classify", () => {
    for (const id of ["review", "classify"]) {
      const clone = steps(jobs[id]).find((each) => each.uses?.startsWith(cloneAction));
      expect(clone?.with, id).toEqual({ ref: "main", "fetch-depth": 0, "persist-credentials": false });
    }
  });

  // Main's prompts, AGENTS.md and REVIEW.md, and main's scripts, are copied out before the patch is
  // applied, so a branch can't rewrite what it's held to.
  it("copies main's prompts and scripts out before it brings in the patch", () => {
    for (const id of ["review", "classify"]) {
      const text = runs(jobs[id]);
      const copied = text.indexOf("cp .github/");
      expect(copied, id).toBeGreaterThanOrEqual(0);
      expect(copied, id).toBeLessThan(text.indexOf("bring-patch.sh"));
      expect(text, id).toMatch(/cp [^\n]*AGENTS\.md/);
      expect(text, id).toMatch(/cp [^\n]*REVIEW\.md/);
    }
  });

  // A review session reads the patch and its own folder, may edit only its own findings file, runs
  // nothing, and starts in an empty home of its own whose only file is its sandbox settings.
  it.runIf(canRehearse)("starts each review in a home of its own, editing only its own findings", () => {
    const review = stepWithId(jobs.review, "session");
    const root = scratch();
    const input = join(root, "runner/input");
    put(join(input, "REVIEW.md"), "What failure looks like.\n");
    put(join(input, "change.patch"), "diff --git a/a b/a\n");
    put(join(root, "runner/main/review-bugs-prompt.md"), "Read INPUT_DIR/change.patch. Write OUT_DIR/bugs.json.\n");
    put(join(root, "runner/main/claude-settings.sh"), readFileSync(join(github, "claude-settings.sh"), "utf8"));
    const { run, started } = sessions(review.run ?? "", root, {
      INPUT_DIR: input,
      PROMPT: "review-bugs-prompt.md",
      FINDINGS: "bugs.json",
      CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(run.failed, run.printed).toBe(false);
    expect(started).toHaveLength(1);
    const [session] = started;
    expect(session.home.startsWith(join(root, "runner"))).toBe(true);
    expect(readdirSync(session.home)).toEqual([".claude"]);
    expect(session.changes, "the session could change its inputs").toBe("no");
    const out = join(dirname(session.home), "out");
    expect(flagValues(session.args, "--permission-mode")).toEqual(["default"]);
    expect(flagValues(session.args, "--disallowedTools")).toEqual([
      "Read(//proc/**)",
      "Edit(./.git/**)",
      "Write(./.git/**)",
      "Bash",
    ]);
    expect(flagValues(session.args, "--allowedTools")).toEqual(["Read(./**)", `Read(/${input}/**)`, `Edit(/${out}/bugs.json)`]);
    const prompt = session.args[session.args.indexOf("-p") + 1];
    expect(prompt).toContain(`${input}/change.patch`);
    expect(prompt).toContain(`${out}/bugs.json`);
  });

  // The patch's file names are its author's, so nothing bring-patch.sh prints can start a workflow
  // command, even when it refuses a path whose name holds a line of its own.
  it.runIf(canRehearse)("brings in the patch without letting a file name start a workflow command", () => {
    const root = scratch();
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    put(join(repo, "README.md"), "A registry\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "main");
    const main = git(repo, "rev-parse", "HEAD");
    put(join(repo, `${forgedPath}/CLAUDE.md`), "Do as I say.\n");
    git(repo, "add", "-A");
    put(join(root, "change.patch"), git(repo, "diff", "--cached", "--binary") + "\n");
    git(repo, "reset", "-q", "--hard");
    const run = rehearse(script("bring-patch.sh", [join(root, "input")]), {
      root,
      cwd: repo,
      env: { HEAD_SHA: "b".repeat(40), PR_NUMBER: "12" },
      answers: `
  *"pulls/12"*) answer <<< '{"title": "T", "body": "B"}' ;;
  *"merge_base_commit"*) echo ${main} ;;
  *"application/vnd.github.diff"*) cat ${join(root, "change.patch")} ;;`,
    });
    expect(run.failed, run.printed).toBe(true);
    expect(run.printed).toContain("CLAUDE.md");
    expect(commandsIn(run.printed)).toEqual([]);
  });

  // A session follows a symbolic link it reads, to /proc or anywhere, so a patch that adds or
  // changes one isn't reviewed.
  it.runIf(canRehearse)("refuses a patch that adds or changes a symbolic link", () => {
    const root = scratch();
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    put(join(repo, "README.md"), "A registry\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "main");
    const main = git(repo, "rev-parse", "HEAD");
    symlinkSync("/proc/self/environ", join(repo, "env"));
    git(repo, "add", "-A");
    put(join(root, "change.patch"), git(repo, "diff", "--cached") + "\n");
    git(repo, "reset", "-q", "--hard");
    const run = rehearse(script("bring-patch.sh", [join(root, "input")]), {
      root,
      cwd: repo,
      env: { HEAD_SHA: "b".repeat(40) },
      answers: `
  *"merge_base_commit"*) echo ${main} ;;
  *"application/vnd.github.diff"*) cat ${join(root, "change.patch")} ;;`,
    });
    expect(run.failed).toBe(true);
    expect(run.printed).toContain("symbolic link");
  });

  // A build's push can land before its description is edited, and the event holds the pull request
  // as it was when CI started, so the title and description are read from GitHub as the job runs.
  it.runIf(canRehearse)("reads the pull request's title and description from GitHub, not the event", () => {
    const root = scratch();
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    put(join(repo, "README.md"), "A registry\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "main");
    const main = git(repo, "rev-parse", "HEAD");
    put(join(repo, "README.md"), "Changed\n");
    git(repo, "add", "-A");
    put(join(root, "change.patch"), git(repo, "diff", "--cached") + "\n");
    git(repo, "reset", "-q", "--hard");
    put(join(root, "event.json"), JSON.stringify({ pull_request: { title: "Old title", body: "Old description" } }));
    const run = rehearse(script("bring-patch.sh", [join(root, "input")]), {
      root,
      cwd: repo,
      env: { HEAD_SHA: "b".repeat(40), PR_NUMBER: "12", GITHUB_EVENT_PATH: join(root, "event.json") },
      answers: `
  *"pulls/12"*) answer <<< '{"title": "New title", "body": "New description"}' ;;
  *"merge_base_commit"*) echo ${main} ;;
  *"application/vnd.github.diff"*) cat ${join(root, "change.patch")} ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(readFileSync(join(root, "input/pull-request.md"), "utf8")).toBe("# New title\n\nNew description\n");
    for (const id of ["review", "classify"]) expect(stepWithId(jobs[id], "bring").env?.PR_NUMBER, id).toBe("${{ github.event.pull_request.number }}");
  });

  it.runIf(canRehearse)("starts Classify in a home of its own, editing only its verdict", () => {
    const root = scratch();
    const input = join(root, "runner/input");
    put(join(input, "change.patch"), "diff --git a/a b/a\n");
    put(join(root, "runner/main/classify-prompt.md"), "Read INPUT_DIR/change.patch. Write OUT_DIR/classification.json.\n");
    put(join(root, "runner/main/claude-settings.sh"), readFileSync(join(github, "claude-settings.sh"), "utf8"));
    const { run, started } = sessions(stepWithId(jobs.classify, "session").run ?? "", root, {
      INPUT_DIR: input,
      CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(run.failed, run.printed).toBe(false);
    expect(started).toHaveLength(1);
    const out = join(dirname(started[0].home), "out");
    expect(flagValues(started[0].args, "--allowedTools")).toEqual(["Read(./**)", `Read(/${input}/**)`, `Edit(/${out}/classification.json)`]);
    const denied = JSON.parse(readFileSync(join(started[0].home, ".claude/settings.json"), "utf8")).sandbox.filesystem.denyWrite;
    expect(denied).toContain(join(root, "step.sh"));
  });

  // The job's own check carries the findings, as annotations GitHub keeps on it, and fails on an
  // Important finding. Text the review wrote can't break out of an annotation or start a workflow
  // command, and nothing like a token is posted.
  describe("post-findings.sh", () => {
    const post = (findings: unknown, unread = "0") => {
      const root = scratch();
      put(join(root, "findings.json"), typeof findings === "string" ? findings : JSON.stringify(findings));
      const run = rehearse(script("post-findings.sh", [join(root, "findings.json"), unread]), {
        root,
        env: { GITHUB_STEP_SUMMARY: join(root, "summary.md") },
      });
      return { ...run, summary: readIfThere(join(root, "summary.md")) };
    };
    const finding = (severity: string, title = "A finding", detail = "Why.") => ({ severity, file: "src/a.ts", line: 3, title, detail });

    it.runIf(canRehearse)("passes when it found nothing", () => {
      const run = post([]);
      expect(run.failed, run.printed).toBe(false);
      expect(run.printed).not.toMatch(/^::(error|warning)/m);
      expect(run.summary).toContain("Found nothing");
    });

    it.runIf(canRehearse)("fails on an Important finding, making each finding an annotation of its rank", () => {
      const run = post([finding("Important"), finding("Nit"), finding("Pre-existing")]);
      expect(run.failed).toBe(true);
      expect(run.printed).toContain("::error file=src/a.ts,line=3,title=Important%3A A finding::Why.");
      expect(run.printed).toContain("::warning file=src/a.ts,line=3,title=Nit%3A A finding::Why.");
      expect(run.printed).toContain("::notice file=src/a.ts,line=3,title=Pre-existing%3A A finding::Why.");
    });

    it.runIf(canRehearse)("passes with Nits alone", () => {
      expect(post([finding("Nit")]).failed).toBe(false);
    });

    it.runIf(canRehearse)("counts binary files it couldn't read as a Nit", () => {
      const run = post([], "2");
      expect(run.failed).toBe(false);
      expect(run.printed).toMatch(/^::warning title=Nit%3A The review could not read 2 binary images or fonts::/m);
    });

    it.runIf(canRehearse)("keeps the review's text inside its annotation", () => {
      const run = post([finding("Nit", "a, b: c", "line one\n::error::forged\n%0A")]);
      expect(run.printed).toContain("title=Nit%3A a%2C b%3A c::line one%0A::error::forged%0A%250A");
      expect(run.printed).not.toMatch(/^::error::forged/m);
      expect(run.summary).not.toContain("<script");
    });

    it.runIf(canRehearse)("escapes the summary for people", () => {
      const run = post([finding("Nit", "<script>", "ping @someone")]);
      expect(run.summary).toContain("&lt;script>");
      expect(run.summary).toContain("@​someone");
    });

    it.runIf(canRehearse)("leaves a file name out of the annotation unless it's a plain path", () => {
      const run = post([{ ...finding("Nit"), file: "a,b::c" }]);
      expect(run.printed).toMatch(/^::warning title=Nit%3A A finding::Why\.$/m);
    });

    it.runIf(canRehearse)("posts nothing for a file that isn't a list of findings, or that carries a token", () => {
      for (const bad of ["{}", "[{\"severity\": \"Minor\"}]", "not json", JSON.stringify([finding("Nit", `sk-ant-${"x".repeat(20)}`)])]) {
        const run = post(bad);
        expect(run.failed, bad).toBe(true);
        expect(run.printed, bad).not.toMatch(/^::(warning|notice) /m);
      }
    });
  });

  // A session's log is printed for the record, but nothing in it can start a workflow command and
  // add an annotation to the check.
  it("prints each session's log with workflow commands stopped", () => {
    for (const id of ["review", "classify"]) {
      const text = runs(jobs[id]);
      expect(text, id).toContain('echo "::stop-commands::$stop"');
      expect(text, id).toMatch(/stop="\$\(openssl rand -hex 16\)"/);
    }
  });

  // Classify reads both reviews' findings from their checks in this run, and its check always
  // passes, so its verdict never wakes the fixer.
  it("posts Classify's verdict in a check that always passes", () => {
    const verdict = stepWithId(jobs.classify, "verdict");
    expect(verdict.run).toContain("::notice title=Verdict%3A $verdict::");
    expect(runs(jobs.classify)).toContain('review-findings.sh" findings "$GITHUB_RUN_ID"');
    for (const each of steps(jobs.classify))
      if (each.run && /claude -p/.test(each.run)) expect(each["continue-on-error"], each.name).toBe(true);
  });

  it.runIf(canRehearse)("says ask when Classify left no readable verdict", () => {
    const verdict = stepWithId(jobs.classify, "verdict");
    for (const [file, want] of [
      [JSON.stringify({ verdict: "show", reasons: ["It changes a page."] }), "::notice title=Verdict%3A show::It changes a page."],
      [JSON.stringify({ verdict: "merge", reasons: [] }), "::notice title=Verdict%3A ask::Classify left no readable verdict."],
      ["", "::notice title=Verdict%3A ask::Classify left no readable verdict."],
      [JSON.stringify({ verdict: "ship", reasons: [`sk-ant-${"x".repeat(20)}`] }), "::notice title=Verdict%3A ask::Classify left no readable verdict."],
    ]) {
      const root = scratch();
      const out = join(root, "runner/sessions/classify/out");
      mkdirSync(out, { recursive: true });
      if (file) put(join(out, "classification.json"), file);
      put(join(root, "runner/main/scan-tokens.sh"), readFileSync(join(github, "scan-tokens.sh"), "utf8"));
      const run = rehearse(verdict.run ?? "", { root, env: { GITHUB_STEP_SUMMARY: join(root, "summary.md") } });
      expect(run.failed, run.printed).toBe(false);
      expect(run.printed).toContain(want);
    }
  });

  it("keeps the failing-main report on main's pushes only", () => {
    expect(needs(jobs.report)).toEqual(["test"]);
    expect(jobs.report.if).toBe("failure() && github.ref == 'refs/heads/main'");
  });
});

// Reads the reviews' findings and Classify's verdict from the annotations GitHub keeps on their
// checks in one CI run. fix.yml, land.yml and Classify run main's copy.
describe("review-findings.sh", () => {
  const jobs = JSON.stringify({
    jobs: [
      { name: "test", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/10" },
      { name: "Bug review", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/11" },
      { name: "Security review", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/12" },
      { name: "Classify", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/13" },
    ],
  });
  const note = (level: string, title: string, message = "Why.", path = "src/a.ts", line = 3) => ({
    annotation_level: level,
    title,
    message,
    path,
    start_line: line,
  });
  const answers = (bug: unknown[], security: unknown[], classify: unknown[] = []) => `
  *"actions/runs/77/jobs"*) answer <<< '${jobs}' ;;
  *"check-runs/11/annotations"*) answer <<< '${JSON.stringify(bug)}' ;;
  *"check-runs/12/annotations"*) answer <<< '${JSON.stringify(security)}' ;;
  *"check-runs/13/annotations"*) answer <<< '${JSON.stringify(classify)}' ;;`;
  const read = (mode: string, bug: unknown[], security: unknown[], classify: unknown[] = []) => {
    const root = scratch();
    return rehearse(script("review-findings.sh", [mode, "77"]), { root, answers: answers(bug, security, classify) });
  };

  it.runIf(canRehearse)("gives each review's findings, by rank, from its own annotations", () => {
    const run = read(
      "findings",
      [note("failure", "Important: Wrong"), note("warning", "Nit: Clearer"), note("warning", "Node 20 is deprecated", "x", ".github")],
      [note("notice", "Pre-existing: Old")],
    );
    expect(run.failed, run.printed).toBe(false);
    expect(JSON.parse(run.printed)).toEqual([
      { review: "bug", severity: "Important", file: "src/a.ts", line: 3, title: "Wrong", detail: "Why." },
      { review: "bug", severity: "Nit", file: "src/a.ts", line: 3, title: "Clearer", detail: "Why." },
      { review: "security", severity: "Pre-existing", file: "src/a.ts", line: 3, title: "Old", detail: "Why." },
    ]);
  });

  // GitHub gives an annotation with no file the path .github, which names no file of the change.
  it.runIf(canRehearse)("gives a finding with no file of its own no file, and keeps a real one under .github/", () => {
    const run = read("findings", [note("warning", "Nit: Somewhere", "m", ".github", 1), note("warning", "Nit: There", "m", ".github/x.sh", 2)], []);
    expect(JSON.parse(run.printed).map((finding: { file: string }) => finding.file)).toEqual(["", ".github/x.sh"]);
  });

  // An annotation whose level doesn't match its rank isn't one the post step made.
  it.runIf(canRehearse)("ignores an annotation whose level doesn't match its rank", () => {
    const run = read("findings", [note("notice", "Important: Not really")], []);
    expect(JSON.parse(run.printed)).toEqual([]);
  });

  it.runIf(canRehearse)("counts the Nits", () => {
    const run = read("nits", [note("warning", "Nit: One")], [note("warning", "Nit: Two"), note("failure", "Important: Three")]);
    expect(run.printed.trim()).toBe("2");
  });

  it.runIf(canRehearse)("gives Classify's verdict, or missing", () => {
    expect(read("verdict", [], [], [note("notice", "Verdict: show", "It changes a page.", ".github", 1)]).printed.trim()).toBe("show");
    expect(read("verdict", [], [], []).printed.trim()).toBe("missing");
    expect(read("verdict", [], [], [note("notice", "Verdict: ship"), note("notice", "Verdict: ask")]).printed.trim()).toBe("missing");
    expect(read("verdict", [], [], [note("notice", "Verdict: merge")]).printed.trim()).toBe("missing");
  });
});

describe("build.yml", () => {
  const build = readWorkflow("build.yml");
  const jobs = build.jobs;

  it("starts from the build label, or from retry with only the issue's number", () => {
    expect(build.on).toEqual({
      issues: { types: ["labeled"] },
      workflow_dispatch: { inputs: { issue: { description: expect.any(String), required: true } } },
    });
  });

  // retry.yml counts a try as a build.yml run named for the issue since the label was last added.
  it("names each run for its issue", () => {
    expect(build["run-name"]).toBe(
      "${{ (github.event_name == 'workflow_dispatch' || github.event.label.name == 'build') && format('Build of issue {0}', inputs.issue || github.event.issue.number) || format('A label added to issue {0}', github.event.issue.number) }}",
    );
  });

  // The build runs no checks of its own: CI judges the pull request, and retry wakes when its tests
  // fail. Nothing here starts retry or judges the change.
  it("runs no checks, reviews or retries of its own", () => {
    expect(Object.keys(jobs).sort()).toEqual(["draft", "open", "pictures", "start", "stopped"]);
    const text = readFileSync(join(github, "workflows/build.yml"), "utf8");
    for (const word of ["npm run typecheck", "npm run lint", "gh workflow run", "review-bugs-prompt", "classify-prompt"])
      expect(text, word).not.toContain(word);
    for (const [id, job] of Object.entries(jobs)) expect(runs(job), id).not.toMatch(/^\s*npm (test|run)\b/m);
  });

  const startAnswers = (labels: string[], edited: string | null, labelled = "2026-10-01T10:00:00Z", renamed?: string) => `
  *"api graphql"*) answer <<< '${JSON.stringify({
    data: {
      repository: {
        issue: {
          lastEditedAt: edited,
          labels: { nodes: labels.map((name) => ({ name })) },
          timelineItems: {
            nodes: [
              { __typename: "LabeledEvent", createdAt: "2026-09-01T00:00:00Z", label: { name: "build" } },
              { __typename: "LabeledEvent", createdAt: labelled, label: { name: "build" } },
              ...(renamed ? [{ __typename: "RenamedTitleEvent", createdAt: renamed }] : []),
            ],
          },
        },
      },
    },
  })}' ;;
  *"issue comment"*) ;;`;

  it.runIf(canRehearse)("says on the issue that it has started, in a new comment linking the run", () => {
    const root = scratch();
    const run = rehearse(stepWithId(jobs.start, "start").run ?? "", {
      root,
      env: { ISSUE: "7" },
      answers: startAnswers(["build"], "2026-10-01T09:00:00Z"),
    });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.go).toBe("true");
    expect(run.calls).toContain("issue comment 7 --repo owner/repo --body-file");
    expect(run.calls).toContain("https://github.com/owner/repo/actions/runs/1000");
  });

  // A try drafts from the issue as it reads now, so an issue edited since the label was last added
  // waits for a person to add the label again.
  it.runIf(canRehearse)("stops with a new comment when the issue was edited since the label", () => {
    const root = scratch();
    const run = rehearse(stepWithId(jobs.start, "start").run ?? "", {
      root,
      env: { ISSUE: "7" },
      answers: startAnswers(["build"], "2026-10-02T09:00:00Z"),
    });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.go).toBe("false");
    expect(run.calls).toMatch(/> .*edited since the build label/);
  });

  // A new title doesn't change GraphQL's lastEditedAt, so a rename is read from the timeline.
  it.runIf(canRehearse)("counts a title renamed since the label as an edit", () => {
    const root = scratch();
    const run = rehearse(stepWithId(jobs.start, "start").run ?? "", {
      root,
      env: { ISSUE: "7" },
      answers: startAnswers(["build"], null, "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z"),
    });
    expect(run.outputs.go).toBe("false");
    expect(run.calls).toMatch(/> .*edited since the build label/);
    const before = rehearse(stepWithId(jobs.start, "start").run ?? "", {
      root: scratch(),
      env: { ISSUE: "7" },
      answers: startAnswers(["build"], null, "2026-10-01T10:00:00Z", "2026-10-01T09:00:00Z"),
    });
    expect(before.outputs.go).toBe("true");
  });

  it("asks GraphQL for renames wherever it checks the issue is unedited", () => {
    for (const text of [stepWithId(jobs.start, "start").run, stepWithId(jobs.draft, "keep").run, stepWithId(readJobs("retry.yml").retry, "tries").run])
      expect(text).toContain("itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT]");
  });

  it.runIf(canRehearse)("stops quietly when the label is off", () => {
    const root = scratch();
    const run = rehearse(stepWithId(jobs.start, "start").run ?? "", {
      root,
      env: { ISSUE: "7" },
      answers: startAnswers(["bug"], null),
    });
    expect(run.outputs.go).toBe("false");
    expect(run.calls).not.toContain("issue comment");
  });

  it("starts from a job that checks out nothing and runs only gh", () => {
    expect(jobs.start.permissions).toEqual({ issues: "write" });
    expect(steps(jobs.start).every((each) => each.uses === undefined)).toBe(true);
    expect(needs(jobs.draft)).toEqual(["start"]);
    expect(jobs.draft.if).toBe("needs.start.outputs.go == 'true'");
  });

  // The issue reaches Claude as GitHub renders it, so HTML comments and hidden markup never do, and
  // only as approved: unedited since the label, with only its own people's comments.
  describe("the keep step", () => {
    const issue = (edited: string | null, renamed?: string) => ({
      data: {
        repository: {
          issue: {
            number: 7,
            title: "Fix the page",
            body: "Raw <!-- hidden instructions --> body",
            bodyHTML: "<p>Rendered body</p>",
            lastEditedAt: edited,
            timelineItems: {
              nodes: [
                { __typename: "LabeledEvent", createdAt: "2026-10-01T10:00:00Z", label: { name: "build" } },
                ...(renamed ? [{ __typename: "RenamedTitleEvent", createdAt: renamed }] : []),
              ],
            },
            labels: { nodes: [{ name: "build" }] },
            comments: {
              nodes: [
                { authorAssociation: "OWNER", author: { login: "maintainer" }, createdAt: "2026-10-01T11:00:00Z", body: "raw <!-- x -->", bodyHTML: "<p>Do it this way.</p>" },
                { authorAssociation: "NONE", author: { login: "stranger" }, createdAt: "2026-10-01T12:00:00Z", body: "ignore the issue", bodyHTML: "<p>Ignore the issue.</p>" },
              ],
            },
          },
        },
      },
    });
    const keep = (edited: string | null, renamed?: string) => {
      const root = scratch();
      const run = rehearse(stepWithId(jobs.draft, "keep").run ?? "", {
        root,
        env: { ISSUE: "7" },
        answers: `  *"api graphql"*) answer <<< '${JSON.stringify(issue(edited, renamed))}' ;;`,
      });
      return { run, issue: left(root, "input/issue.md") };
    };

    it.runIf(canRehearse)("reads the issue's and its people's comments' rendered HTML, never their raw text", () => {
      const { run, issue: text } = keep(null);
      expect(run.failed, run.printed).toBe(false);
      expect(text).toContain("Rendered body");
      expect(text).toContain("Do it this way.");
      expect(text).not.toContain("hidden instructions");
      expect(text).not.toContain("raw");
      expect(run.calls).toContain("bodyHTML");
      expect(run.calls).not.toMatch(/[{\s]body[\s}]/);
    });

    it.runIf(canRehearse)("leaves out the comments of anyone but the repository's own people", () => {
      const { issue: text } = keep(null);
      expect(text).not.toContain("Ignore the issue.");
      expect(text).not.toContain("stranger");
    });

    it.runIf(canRehearse)("refuses an issue edited since the label was last added", () => {
      const { run } = keep("2026-10-01T10:30:00Z");
      expect(run.failed).toBe(true);
    });

    it.runIf(canRehearse)("refuses an issue renamed since the label was last added", () => {
      expect(keep(null, "2026-10-01T10:30:00Z").run.failed).toBe(true);
      expect(keep(null, "2026-10-01T09:30:00Z").run.failed).toBe(false);
    });
  });

  // Why the last try failed comes from CI itself: the failed test log of CI's latest pull_request
  // run on the issue's branch, from this repository, and never a fork's run that took the name.
  // An empty log would tell the draft a try failed with nothing to show, so the file is written
  // only when it has something in it.
  it.runIf(canRehearse)("writes no failed log when the failed tests left none", () => {
    const root = scratch();
    const run = rehearse(stepWithId(jobs.draft, "why").run ?? "", {
      root,
      env: { ISSUE: "7" },
      answers: `
  *"actions/workflows/ci.yml/runs"*) answer <<< '${JSON.stringify({ workflow_runs: [{ id: 50, conclusion: "failure", event: "pull_request", head_repository: { full_name: "owner/repo" } }] })}' ;;
  *"actions/runs/50/jobs"*) answer <<< '${JSON.stringify({ jobs: [{ id: 9, name: "test", conclusion: "failure" }] })}' ;;
  *"run view --job 9"*) ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(existsSync(join(root, "runner/input/failed.log"))).toBe(false);
  });

  it.runIf(canRehearse)("brings in the failed tests' log of CI's latest run on the branch", () => {
    const root = scratch();
    const runs_ = {
      workflow_runs: [
        { id: 51, conclusion: "failure", event: "pull_request", head_repository: { full_name: "stranger/repo" } },
        { id: 50, conclusion: "failure", event: "pull_request", head_repository: { full_name: "owner/repo" } },
      ],
    };
    const run = rehearse(stepWithId(jobs.draft, "why").run ?? "", {
      root,
      env: { ISSUE: "7" },
      answers: `
  *"actions/workflows/ci.yml/runs"*) answer <<< '${JSON.stringify(runs_)}' ;;
  *"actions/runs/50/jobs"*) answer <<< '${JSON.stringify({ jobs: [{ id: 9, name: "test", conclusion: "failure" }, { id: 8, name: "Bug review", conclusion: "failure" }] })}' ;;
  *"run view --job 9"*) echo "FAIL test/a.test.ts" ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).toContain("branch=build/issue-7");
    expect(run.calls).not.toContain("--job 8");
    expect(left(root, "input/failed.log")).toContain("FAIL test/a.test.ts");
  });

  // The draft session runs every command, tests included, in its sandbox, which reaches npm's
  // registry and nothing else. It installs the dependencies itself: the job runs none of the
  // change's code beside the token.
  it.runIf(canRehearse)("drafts in a sandboxed session that reads only the workspace and its inputs", () => {
    const draft = stepWithId(jobs.draft, "session");
    const root = scratch();
    const input = join(root, "runner/input");
    put(join(input, "issue.md"), "# #7\n");
    put(join(root, "runner/main/build-prompt.md"), "Read INPUT_DIR/issue.md. Write OUT_DIR/message.md.\n");
    put(join(root, "runner/main/claude-settings.sh"), readFileSync(join(github, "claude-settings.sh"), "utf8"));
    const { run, started } = sessions(draft.run ?? "", root, {
      INPUT_DIR: input,
      CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(run.failed, run.printed).toBe(false);
    expect(started).toHaveLength(1);
    const [session] = started;
    const out = join(dirname(session.home), "out");
    const settings = JSON.parse(readFileSync(join(session.home, ".claude/settings.json"), "utf8"));
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
    expect(settings.sandbox.filesystem.denyWrite).toContain("./.git");
    expect(flagValues(session.args, "--permission-mode")).toEqual(["default"]);
    expect(flagValues(session.args, "--disallowedTools")).toEqual(["Read(//proc/**)", "Edit(./.git/**)", "Write(./.git/**)"]);
    const allowed = flagValues(session.args, "--allowedTools");
    expect(allowed.filter((rule) => rule.startsWith("Read("))).toEqual(["Read(./**)", `Read(/${input}/**)`]);
    expect(allowed).toContain(`Edit(/${out}/**)`);
    for (const rule of allowed) expect(rule).not.toMatch(/^(Read|Edit|Write|Glob|Grep|Bash)$/);
    expect(allowed.filter((rule) => rule.startsWith("Bash(")).every((rule) => /^Bash\((npm (run|test)|npx (vitest|tsc|eslint)|git (status|diff|log)|ls)\b/.test(rule))).toBe(true);
    expect(allowed).not.toContain("Bash(npm ci:*)");
  });

  it("tells the fixer not to change the dependencies", () => {
    const prompt = squash(readFileSync(join(github, "fix-prompt.md"), "utf8"));
    expect(prompt).toContain("Don't edit `package.json` or `package-lock.json`");
  });

  it("tells the draft and the fixer which files the app never pushes", () => {
    for (const name of ["build-prompt.md", "fix-prompt.md"]) {
      const prompt = squash(readFileSync(join(github, name), "utf8"));
      for (const path of ["`.github/`", "`.claude/`", "`.mcp.json`", "`CLAUDE.md`", "`.npmrc`", "`.yarnrc`", "`node_modules/`"])
        expect(prompt, `${name} ${path}`).toContain(path);
    }
  });

  // A session could plant files or a symbolic link in the folder the pack step uploads, so that
  // folder is denied to it, made afresh after it, and checked: every file scanned, no link kept.
  it("makes the uploaded folder afresh after the session, denied to it, with no link in it", () => {
    for (const [file, id, folder] of [["build.yml", "draft", "change"], ["fix.yml", "fix", "fix"]]) {
      const job = readJobs(file)[id];
      expect(stepWithId(job, "session").run, file).toContain(`--deny-write "$RUNNER_TEMP/${folder}"`);
      const patch = stepWithId(job, "patch").run ?? "";
      expect(patch, file).toMatch(new RegExp(`rm -rf "\\$${folder === "change" ? "change" : "fixed"}"\n\s*mkdir "\\$${folder === "change" ? "change" : "fixed"}"`));
      const pack = stepWithId(job, "pack").run ?? "";
      expect(pack, file).toContain(`find "$RUNNER_TEMP/${folder}" ! -type f ! -type d`);
      expect(pack.indexOf("find"), file).toBeLessThan(pack.indexOf("scan-tokens.sh"));
    }
  });

  it.runIf(canRehearse)("refuses a change folder that holds a symbolic link", () => {
    for (const [file, id, folder] of [["build.yml", "draft", "change"], ["fix.yml", "fix", "fix"]]) {
      const root = scratch();
      put(join(root, "runner/main/scan-tokens.sh"), readFileSync(join(github, "scan-tokens.sh"), "utf8"));
      put(join(root, `runner/${folder}/change.patch`), "diff\n");
      symlinkSync("/etc/hostname", join(root, `runner/${folder}/planted`));
      const run = rehearse(stepWithId(readJobs(file)[id], "pack").run ?? "", { root });
      expect(run.failed, `${file}: ${run.printed}`).toBe(true);
      expect(run.outputs.digest, file).toBeUndefined();
    }
  });

  it("keeps the change for 30 days, so an offered draft can be downloaded", () => {
    const upload = steps(jobs.draft).find((each) => each.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.with).toEqual({ name: "change", path: "${{ runner.temp }}/change", "retention-days": 30 });
    expect(jobs.draft.outputs?.digest).toBe("${{ steps.pack.outputs.digest }}");
  });

  it("pictures the change in a job that holds no secret and a token that only reads", () => {
    expect(jobs.pictures.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(jobs.pictures)).not.toContain("secrets.");
    expect(needs(jobs.pictures)).toEqual(["draft"]);
  });

  // The push job runs none of the change's code. A draft touching .github/ or Claude Code's own
  // files is offered in a new comment, never pushed, and the build stops.
  describe("the open job's guard", () => {
    const guard = (path: string, contents = "changed\n", stale = false, others = 0) => {
      const root = scratch();
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q");
      put(join(repo, "README.md"), "A registry\n");
      put(join(repo, ".github/pull-request-body.sh"), "#!/bin/bash\n");
      put(join(repo, ".github/unclose.sh"), "#!/bin/bash\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "main");
      if (contents.startsWith("->")) symlinkSync(contents.slice(2), join(repo, path));
      else put(join(repo, path), contents);
      for (let n = 0; n < others; n++) put(join(repo, `src/generated/a-rather-long-file-name-${n}.ts`), "x\n");
      git(repo, "add", "-A");
      put(join(root, "runner/change/change.patch"), git(repo, "diff", "--cached", "--binary") + "\n");
      git(repo, "reset", "-q", "--hard");
      if (stale) {
        put(join(repo, path), "moved on\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-qm", "main moved");
      }
      const run = rehearse(stepWithId(jobs.open, "guard").run ?? "", {
        root,
        cwd: repo,
        env: { ISSUE: "7" },
        answers: `  *"issue comment"*) ;;`,
      });
      return run;
    };

    // git lists .github/ first, and well over a pipe's buffer of names after it.
    it.runIf(canRehearse)("offers a change to .github/ among thousands of other files", () => {
      const run = guard(".github/workflows/ci.yml", "changed\n", false, 4000);
      expect(run.failed, run.printed).toBe(false);
      expect(run.outputs.result).toBe("offer");
    });

    it.runIf(canRehearse)("pushes a change to the registry's own code", () => {
      const run = guard("src/app/page.tsx");
      expect(run.failed, run.printed).toBe(false);
      expect(run.outputs.result).toBe("push");
      expect(run.calls).not.toContain("issue comment");
    });

    it.runIf(canRehearse).each(neverPushed)(
      "offers a change to %s in a new comment, with the commands to download and apply it",
      (path) => {
        const run = guard(path);
        expect(run.failed, run.printed).toBe(false);
        expect(run.outputs.result).toBe("offer");
        expect(run.calls).toContain("> gh run download 1000 --repo owner/repo -n change -D change");
        expect(run.calls).toContain("> git apply --index change/change.patch");
        expect(run.calls).toContain("30 days");
      },
    );

    // A symbolic link is read wherever it's followed, so the app never pushes one.
    it.runIf(canRehearse)("offers a change that adds a symbolic link", () => {
      const run = guard("env", "->/proc/self/environ");
      expect(run.failed, run.printed).toBe(false);
      expect(run.outputs.result).toBe("offer");
    });

    // The offer names each kind of file the app holds back, and why.
    it.runIf(canRehearse)("names every kind of file it holds back, with the reason for each", () => {
      const run = guard(".github/workflows/ci.yml");
      for (const reason of [
        "the app may not change a workflow",
        "no session loads Claude Code's settings, servers or instructions from a branch",
        "an install of the branch would read them",
        "a symbolic link is read wherever it's followed",
      ])
        expect(run.calls, reason).toContain(reason);
    });

    it.runIf(canRehearse)("prints the paths it offers without letting one start a workflow command", () => {
      const run = guard(`.github/${forgedPath}`);
      expect(run.outputs.result).toBe("offer");
      expect(commandsIn(run.printed)).toEqual([]);
    });

    it.runIf(canRehearse)("says so in a new comment when the change no longer applies to main", () => {
      const run = guard("README.md", "changed\n", true);
      expect(run.outputs.result).toBe("stale");
      expect(run.calls).toMatch(/> .*no longer applies/);
    });
  });

  // The branch is reused, so a new try replaces it, but only from the head the job last read.
  it("pushes the branch with a lease, never a bare force", () => {
    const push = stepWithId(jobs.open, "push").run ?? "";
    expect(push).toContain('push --force-with-lease="refs/heads/$branch:$old" origin "HEAD:refs/heads/$branch"');
    expect(push).not.toMatch(/--force(\s|$)/);
    expect(push).toContain("ls-remote");
  });

  // GitHub closes each issue a merged commit's message or a pull request's description names after
  // a closing keyword, so Claude's text closes none, and only the build's own Closes #n remains.
  it("neutralises closing keywords in Claude's commit message and the pull request's title", () => {
    const commit = stepWithId(jobs.open, "commit").run ?? "";
    expect(commit).toMatch(/unclose\.sh" < "\$RUNNER_TEMP\/change\/message\.md"/);
    expect(stepWithId(jobs.open, "describe").run).toMatch(/head -n 1 "\$RUNNER_TEMP\/change\/message\.md" \| bash "\$RUNNER_TEMP\/unclose\.sh"/);
  });

  // After the session, git runs only on the workspace it started in, and only on a tree with no
  // repository nested inside it, whose own config git would read.
  describe("the patch step", () => {
    const patch = (spoil: (repo: string, root: string) => void) => {
      const root = scratch();
      const repo = join(root, "work");
      mkdirSync(repo);
      git(repo, "init", "-q");
      put(join(repo, "README.md"), "A registry\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "main");
      put(join(root, "runner/baseline/git-config"), readFileSync(join(repo, ".git/config"), "utf8"));
      put(join(root, "runner/baseline/workspace"), execFileSync("stat", ["-c", "%d:%i", repo, join(repo, ".git")], { encoding: "utf8" }));
      put(join(repo, "README.md"), "Changed\n");
      spoil(repo, root);
      return { root, run: rehearse(stepWithId(jobs.draft, "patch").run ?? "", { root, cwd: repo, env: { GITHUB_WORKSPACE: repo } }) };
    };

    it.runIf(canRehearse)("makes the patch from an untouched workspace", () => {
      const { root, run } = patch(() => {});
      expect(run.failed, run.printed).toBe(false);
      expect(left(root, "change/change.patch")).toContain("+Changed");
    });

    it.runIf(canRehearse)("refuses a workspace whose .git was replaced", () => {
      const { run } = patch((repo, root) => {
        execFileSync("mv", [join(repo, ".git"), join(root, "old-git")]);
        execFileSync("cp", ["-r", join(root, "old-git"), join(repo, ".git")]);
      });
      expect(run.failed).toBe(true);
    });

    it.runIf(canRehearse)("refuses a repository nested below the top", () => {
      const { run } = patch((repo) => git(join(repo), "init", "-q", "src/inner"));
      expect(run.failed).toBe(true);
    });

    // A session may write under node_modules, apart from its .bin, so a repository there counts.
    it.runIf(canRehearse)("refuses a repository nested in node_modules", () => {
      const { run } = patch((repo) => git(join(repo), "init", "-q", "node_modules/left-pad"));
      expect(run.failed).toBe(true);
    });
  });

  it.runIf(canRehearse)("unclose.sh puts each closing reference in a code span", () => {
    const root = scratch();
    put(join(root, "message.md"), "Fix it\n\nCloses #9, fixes owner/repo#3 and Resolves: https://github.com/owner/repo/issues/4.\n");
    const run = rehearse(`bash ${join(github, "unclose.sh")} < ${join(root, "message.md")}\n`, { root });
    expect(run.printed).toContain("Closes `#9`, fixes `owner/repo#3` and Resolves: `https://github.com/owner/repo/issues/4.`");
  });

  // Land knows the factory's commits by the app's bot, so the build commits as awml-factory[bot] and
  // refuses an app of any other name.
  it("commits as awml-factory[bot], and refuses an app of another name", () => {
    const commit = stepWithId(jobs.open, "commit").run ?? "";
    expect(commit).toContain('[ "$APP_SLUG" = awml-factory ]');
    expect(commit).toContain('git config user.name "awml-factory[bot]"');
    expect(commit).toContain('git config user.email "$id+awml-factory[bot]@users.noreply.github.com"');
  });

  it("gives the app's token only to the open job's push and pull request steps", () => {
    for (const [id, job] of Object.entries(jobs))
      for (const each of steps(job)) {
        if (!JSON.stringify(each.env ?? {}).includes("steps.app.outputs.token")) continue;
        expect(id).toBe("open");
        expect(["edit", "push", "media", "pull"]).toContain(each.id);
      }
  });

  // GitHub starts CI from the app's pull request. One that is open from the branch is updated by
  // the push, and keeps its number.
  // CI's synchronize run reads the pull request as it is when the push lands, so an open one gets
  // the try's title and description before the push, and a new one is opened after it.
  it("edits an open pull request before the push, and opens one after it", () => {
    const ids = steps(jobs.open).map((each) => each.id);
    expect(ids.indexOf("describe")).toBeLessThan(ids.indexOf("edit"));
    expect(ids.indexOf("edit")).toBeLessThan(ids.indexOf("push"));
    expect(ids.indexOf("push")).toBeLessThan(ids.indexOf("pull"));
  });

  const pullStep = (id: string, open: string) => {
    const root = scratch();
    put(join(root, "runner/title.txt"), "Fix the page\n");
    put(join(root, "runner/pull-request.md"), "Closes #7\n");
    return rehearse(stepWithId(jobs.open, id).run ?? "", {
      root,
      env: { ISSUE: "7", BRANCH: "build/issue-7" },
      answers: `
  *"pulls?head=owner:build/issue-7"*) answer <<< '${open}' ;;
  *"pr create"*) echo "https://github.com/owner/repo/pull/13" ;;
  *"pr edit"*) ;;`,
    });
  };

  it.runIf(canRehearse)("gives an open pull request the try's title and description before the push", () => {
    const run = pullStep("edit", JSON.stringify([strangerPull("a".repeat(40)), appPull("a".repeat(40))]));
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).toContain("pr edit 12 --repo owner/repo --title Fix the page --body-file");
    expect(run.calls).not.toContain("pr create");
    expect(pullStep("edit", "[]").calls).not.toMatch(/pr (edit|create)/);
    // A stranger's pull request from the branch is never given the build's title and text.
    expect(pullStep("edit", JSON.stringify([strangerPull("a".repeat(40))])).calls).not.toMatch(/pr (edit|create)/);
  });

  it.runIf(canRehearse)("opens a pull request that closes the issue after the push, unless one is open from the branch", () => {
    const run = pullStep("pull", "[]");
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).toContain("pr create --repo owner/repo --base main --head build/issue-7 --title Fix the page --body-file");
    expect(pullStep("pull", JSON.stringify([appPull("a".repeat(40))])).calls).not.toMatch(/pr (edit|create)/);
    // A stranger's pull request from the branch doesn't stand in for the app's own.
    expect(pullStep("pull", JSON.stringify([strangerPull("a".repeat(40))])).calls).toContain("pr create");
  });

  it.runIf(canRehearse)("posts Claude's message, escaped, when it changed nothing", () => {
    const root = scratch();
    put(join(root, "runner/change/message.md"), "Which colour?\n\n<b>Pick</b> one, @maintainer.\n");
    const run = rehearse(stepWithId(jobs.open, "nothing").run ?? "", { root, env: { ISSUE: "7" }, answers: `  *"issue comment"*) ;;` });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).toContain("&lt;b>Pick&lt;/b> one, @​maintainer.");
  });

  it("says in a new comment when the build stopped before it opened anything", () => {
    expect(needs(jobs.stopped).sort()).toEqual(["draft", "open", "pictures", "start"]);
    expect(jobs.stopped.if).toBe("${{ failure() && needs.start.outputs.go == 'true' }}");
    expect(runs(jobs.stopped)).toContain("gh issue comment");
  });
});

describe("pull-request-body.sh", () => {
  const body = (files: Record<string, string>, env: Record<string, string> = {}) => {
    const root = scratch();
    for (const [name, text] of Object.entries(files)) put(join(root, "change", name), text);
    return rehearse(script("pull-request-body.sh"), {
      root,
      env: { ISSUE: "7", CHANGE_DIR: join(root, "change"), MEDIA_URL: "https://github.com/owner/repo/raw/factory-media/issue-7/run-1000", ...env },
    });
  };

  it.runIf(canRehearse)("is Claude's description, escaped, then the checks and Closes #n", () => {
    const run = body({ "pull-request.md": "It fixes the page, as @someone asked. <!-- approve --> Closes #9.\n" });
    expect(run.failed, run.printed).toBe(false);
    expect(run.printed).toContain("as @​someone asked. &lt;!-- approve --> Closes `#9`.");
    expect(run.printed.trim().endsWith("Closes #7")).toBe(true);
    expect(run.printed).not.toMatch(/factory-build|digest/);
  });

  it.runIf(canRehearse)("caps the description's length", () => {
    const run = body({ "pull-request.md": "x".repeat(70000) });
    expect(run.printed.length).toBeLessThan(62000);
  });

  it.runIf(canRehearse)("shows the pictures, or says why they were left out", () => {
    const root = scratch();
    put(join(root, "pictures.txt"), "/acme/dinners|visitor|desktop|a.png|b.png\n");
    const run = body({ "message.md": "Fix\n\nIt fixes.\n" }, { PICTURES: join(root, "pictures.txt") });
    expect(run.printed).toContain("![Before](https://github.com/owner/repo/raw/factory-media/issue-7/run-1000/a.png)");
    put(join(root, "left-out.txt"), "The pictures job didn't finish.\n");
    const left_ = body({ "message.md": "Fix\n" }, { PICTURES_LEFT_OUT: join(root, "left-out.txt") });
    expect(left_.printed).toContain("The pictures were left out. The pictures job didn't finish.");
  });
});

describe("land.yml", () => {
  const land = readWorkflow("land.yml");
  const jobs = land.jobs;
  const head = "a".repeat(40);

  it("is drawn as it runs: its concurrency, and the commit read at its merge-base with main", () => {
    const drawing = readFileSync(join(github, "drawings/land-a-pull-request.yaml"), "utf8");
    expect(drawing).toContain("a newer CI result on the branch cancels an older reading, but never a land that has started");
    expect(drawing).toContain("at its merge-base with main");
    expect(drawing).not.toContain("keyed on the pull request and the run");
    expect(drawing).not.toContain("at its parent on main");
  });

  it("wakes when CI's run finishes on a factory branch", () => {
    expect(land.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["build/issue-*"] } });
  });

  // A newer CI result replaces the reading of an older one, but nothing cancels a job that has
  // started to merge.
  it("never cancels a land that has started", () => {
    expect(land.concurrency).toBeUndefined();
    expect(jobs.find.concurrency).toEqual({ group: "land-find-${{ github.event.workflow_run.head_branch }}", "cancel-in-progress": true });
    expect(jobs.land.concurrency).toEqual({ group: "land-merge-${{ github.event.workflow_run.head_branch }}", "cancel-in-progress": false });
  });

  it("reads with a token that only reads, and runs main's code, never the branch's", () => {
    expect(writes(jobs.find)).toEqual([]);
    const clone = steps(jobs.find).find((each) => each.uses?.startsWith(cloneAction));
    expect(clone?.with?.ref).toBe("main");
    expect(clone?.with?.["persist-credentials"]).toBe(false);
    expect(runs(jobs.find)).not.toMatch(/npm (ci|install|test)/);
  });

  const checkRuns = (overrides: Record<string, Partial<{ status: string; conclusion: string; suite: number }>> = {}) => ({
    check_runs: ["test", "Bug review", "Security review", "Classify"].map((name) => ({
      name,
      status: overrides[name]?.status ?? "completed",
      conclusion: overrides[name]?.conclusion ?? "success",
      check_suite: { id: overrides[name]?.suite ?? 300 },
    })),
  });
  const ready = (
    {
      event = "pull_request",
      repository = "owner/repo",
      pullHead = head,
      checks = checkRuns(),
      labeller = { login: "maintainer", type: "User" },
      pullRepository = "owner/repo",
    }: {
      event?: string;
      repository?: string;
      pullHead?: string;
      checks?: unknown;
      labeller?: { login: string; type: string };
      pullRepository?: string;
    } = {},
  ) => {
    const root = scratch();
    return rehearse(stepWithId(jobs.find, "ready").run ?? "", {
      root,
      env: {
        BRANCH: "build/issue-7",
        HEAD_SHA: head,
        HEAD_REPOSITORY: repository,
        CI_EVENT: event,
        CHECK_SUITE: "300",
      },
      answers: `
  *"pulls?head=owner:build/issue-7"*) answer <<< '${JSON.stringify([strangerPull(head), appPull(pullHead, pullRepository)])}' ;;
  *"commits/${head}/check-runs"*) answer <<< '${JSON.stringify(checks)}' ;;
  *"issues/7/events"*) answer <<< '${JSON.stringify([
    { event: "labeled", label: { name: "build" }, actor: { login: "someone-earlier", type: "User" } },
    { event: "labeled", label: { name: "bug" }, actor: { login: "other", type: "User" } },
    { event: "labeled", label: { name: "build" }, actor: labeller },
  ])}' ;;`,
    });
  };

  it.runIf(canRehearse)("goes on once the pull request is open at CI's commit and every check passed", () => {
    const run = ready();
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs).toMatchObject({ go: "true", pr: "12", issue: "7", head_sha: head, labeller: "maintainer" });
  });

  // A Classify that timed out, or whose runner was lost, leaves no verdict, which means ask: land
  // goes on rather than leaving the pull request unjudged.
  it.runIf(canRehearse).each(["failure", "cancelled", "timed_out", "skipped"])("goes on when Classify ended as %s", (conclusion) => {
    const run = ready({ checks: checkRuns({ Classify: { conclusion } }) });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.go).toBe("true");
  });

  // Anyone can open a pull request from the build's branch, so only the app's is landed.
  it.runIf(canRehearse)("lands only the pull request the app opened, never a stranger's from the same branch", () => {
    const run = ready();
    expect(run.outputs.pr).toBe("12");
    expect(stepWithId(jobs.find, "ready").run).toContain('.user.login == "awml-factory[bot]" and .user.type == "Bot"');
  });

  it.runIf(canRehearse)("asks the owner when the app added the label", () => {
    expect(ready({ labeller: { login: "awml-factory[bot]", type: "Bot" } }).outputs.labeller).toBe("owner");
  });

  // A failed check belongs to retry or the fixer, and a head that moved to a newer CI run.
  it.runIf(canRehearse).each([
    ["a push's run", { event: "push" }],
    ["a fork's run", { repository: "stranger/repo" }],
    ["a fork's pull request from a build/issue-N branch", { pullRepository: "stranger/repo" }],
    ["a pull request that moved on", { pullHead: "b".repeat(40) }],
    ["a failed review", { checks: checkRuns({ "Bug review": { conclusion: "failure" } }) }],
    ["a failed test", { checks: checkRuns({ test: { conclusion: "failure" } }) }],
    ["a check still running", { checks: checkRuns({ Classify: { status: "in_progress", conclusion: "" } }) }],
    ["a required check from another run", { checks: checkRuns({ "Security review": { suite: 299 } }) }],
    ["a missing required check", { checks: { check_runs: checkRuns().check_runs.filter((each) => each.name !== "test") } }],
  ])("exits quietly on %s", (_, options) => {
    const run = ready(options);
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.go).toBe("false");
    expect(run.calls).not.toMatch(/comment|merge|edit/);
  });

  // The rule judges the head commit itself, read with git into a worktree at the commit of main
  // the branch starts from, never a patch from an artifact, with Classify's verdict and the Nits
  // read from the checks of CI's run.
  const judge = (classifyConclusion: string, { mainChangesCi = false, branchChangesCi = false } = {}) => {
    const root = scratch();
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q");
    put(join(origin, "README.md"), "A registry\n");
    put(join(origin, ".github/build-rules.yml"), "review_paths: [docs/SPEC.md, .github/]\nmax_changed_lines: 400\n");
    put(join(origin, ".github/review-findings.sh"), readFileSync(join(github, "review-findings.sh"), "utf8"));
    put(join(origin, "scripts/build-rule.ts"), readFileSync(join(__dirname, "../scripts/build-rule.ts"), "utf8"));
    put(join(origin, ".github/workflows/ci.yml"), "name: CI\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "main");
    git(origin, "switch", "-q", "-c", "build/issue-7");
    put(join(origin, "src/page.tsx"), "export default function Page() {}\n");
    if (branchChangesCi) put(join(origin, ".github/workflows/ci.yml"), "name: CI\n# the branch's own reviews\n");
    git(origin, "add", "-A");
    git(origin, "-c", "user.name=awml-factory[bot]", "-c", "user.email=1+awml-factory[bot]@users.noreply.github.com", "commit", "-qm", "Build #7");
    const sha = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    if (mainChangesCi) {
      put(join(origin, ".github/workflows/ci.yml"), "name: CI\n# main's newer reviews\n");
      git(origin, "commit", "-qam", "main changes CI");
    }
    const work = join(root, "work");
    git(root, "clone", "-q", origin, work);
    const jobsList = JSON.stringify({
      jobs: [
        { name: "Bug review", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/11", html_url: "https://github.com/x/11" },
        { name: "Security review", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/12", html_url: "https://github.com/x/12" },
        {
          name: "Classify",
          conclusion: classifyConclusion,
          check_run_url: "https://api.github.com/repos/owner/repo/check-runs/13",
          html_url: "https://github.com/owner/repo/actions/runs/77/job/13",
        },
      ],
    });
    const run = rehearse(stepWithId(jobs.find, "judge").run ?? "", {
      root,
      cwd: work,
      env: { HEAD_SHA: sha, CI_RUN: "77" },
      answers: `
  *"actions/runs/77/jobs"*) answer <<< '${jobsList}' ;;
  *"check-runs/11/annotations"*) answer <<< '${JSON.stringify([{ annotation_level: "warning", title: "Nit: Clearer", message: "m", path: "src/page.tsx", start_line: 1 }])}' ;;
  *"check-runs/12/annotations"*) answer <<< '[]' ;;
  *"check-runs/13/annotations"*) answer <<< '${JSON.stringify([{ annotation_level: "notice", title: "Verdict: ship", message: "Small.", path: ".github", start_line: 1 }])}' ;;`,
    });
    return { run, work };
  };

  it.runIf(canRehearse)("judges the head commit with the rule from main", () => {
    const { run, work } = judge("success");
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.verdict).toBe("show");
    expect(run.outputs.classify_url).toBe("https://github.com/owner/repo/actions/runs/77/job/13");
    expect(run.printed).toContain("The reviews left 1 Nit unfixed.");
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("A registry\n");
    expect(existsSync(join(work, "src/page.tsx")), "the branch's files reached main's working tree").toBe(false);
  });

  // GitHub ran ci.yml from the pull request's merge with main, so only a branch that changed it ran
  // reviews and a Classify of its own, and .github/ is a review path, so the rule asks.
  it.runIf(canRehearse)("asks when the branch changed ci.yml", () => {
    const { run } = judge("success", { branchChangesCi: true });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.verdict).toBe("ask");
    expect(run.printed).toContain("`.github/workflows/ci.yml` is a path that always needs review.");
  });

  it.runIf(canRehearse)("doesn't ask only because main changed ci.yml since the branch began", () => {
    const { run } = judge("success", { mainChangesCi: true });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.verdict).toBe("show");
    expect(run.printed).not.toContain("ci.yml");
    expect(stepWithId(jobs.find, "judge").run).not.toContain("ci.yml");
  });

  it.runIf(canRehearse)("asks when Classify was skipped", () => {
    const { run } = judge("skipped");
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.verdict).toBe("ask");
    expect(run.printed).toContain("Classify gave no verdict.");
  });

  it.runIf(canRehearse)("asks when Classify's job didn't succeed, whatever verdict it left", () => {
    const { run } = judge("timed_out");
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.verdict).toBe("ask");
    expect(run.printed).toContain("Classify gave no verdict.");
  });

  it("passes on only the sha, the outcome, the labeller and the rule's reasons", () => {
    expect(Object.keys(jobs.find.outputs ?? {}).sort()).toEqual(["classify_url", "go", "head_sha", "issue", "labeller", "pr", "reasons", "verdict"]);
  });

  const act = (id: string, verdict: string) => {
    const root = scratch();
    put(join(root, "runner/reasons.txt"), "The reviews left 1 Nit unfixed.\n");
    return rehearse(stepWithId(jobs.land, id).run ?? "", {
      root,
      env: {
        PR_NUMBER: "12",
        ISSUE: "7",
        HEAD_SHA: head,
        VERDICT: verdict,
        LABELLER: "maintainer",
        REASONS: JSON.stringify(["The reviews left 1 Nit unfixed."]),
        CLASSIFY_URL: "https://github.com/owner/repo/actions/runs/77/job/13",
      },
      answers: `
  *"pr merge"*) ;;
  *"pr comment"*) ;;
  *"pr edit"*) ;;`,
    });
  };

  // Ship and show merge, pinned to the commit judged, so GitHub refuses the merge if anyone pushed
  // since. Nothing sets a merge for later.
  it.runIf(canRehearse).each(["ship", "show"])("merges on %s, pinned to the commit judged", (verdict) => {
    const run = act("merge", verdict);
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).toContain(`pr merge 12 --repo owner/repo --squash --match-head-commit ${head}`);
    expect(run.calls).not.toContain("--auto");
  });

  it.runIf(canRehearse)("tells the labeller what to look at in a new comment on show", () => {
    const run = act("tell", "show");
    expect(run.calls).toContain("pr comment 12 --repo owner/repo --body-file");
    expect(run.calls).toContain("@maintainer");
    expect(run.calls).toContain("The reviews left 1 Nit unfixed.");
    expect(run.calls).toContain("https://github.com/owner/repo/actions/runs/77/job/13");
  });

  it.runIf(canRehearse)("requests the labeller's review in a new comment on ask, and doesn't merge", () => {
    const run = act("tell", "ask");
    expect(run.calls).toContain("pr edit 12 --repo owner/repo --add-reviewer maintainer");
    expect(run.calls).toContain("pr comment 12 --repo owner/repo --body-file");
    expect(run.calls).not.toContain("pr merge");
    expect(stepWithId(jobs.land, "merge").if).toBe(
      "steps.head.outputs.current == 'true' && (needs.find.outputs.verdict == 'ship' || needs.find.outputs.verdict == 'show')",
    );
  });

  it.runIf(canRehearse)("says nothing on ship", () => {
    const run = act("tell", "ship");
    expect(run.calls).toBe("");
  });

  it("gives the app's token only to the merge, minted in the land job", () => {
    for (const [id, job] of Object.entries(jobs))
      for (const each of steps(job)) {
        if (each.uses?.startsWith("actions/create-github-app-token")) expect(id).toBe("land");
        if (JSON.stringify(each.env ?? {}).includes("steps.app.outputs.token")) expect(each.id).toBe("merge");
      }
  });

  it.runIf(canRehearse)("leaves a pull request that moved since it was judged", () => {
    const root = scratch();
    const run = rehearse(stepWithId(jobs.land, "head").run ?? "", {
      root,
      env: { PR_NUMBER: "12", HEAD_SHA: head },
      answers: `  *"pulls/12"*) answer <<< '${JSON.stringify({ state: "open", head: { sha: "b".repeat(40) } })}' ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.current).toBe("false");
  });
});

describe("fix.yml", () => {
  const fix = existsSync(join(github, "workflows/fix.yml")) ? readWorkflow("fix.yml") : ({ jobs: {} } as Workflow);
  const jobs = fix.jobs;
  const head = "a".repeat(40);

  it("wakes when CI's run finishes, on any branch, as a person's pull request is fixed the same way", () => {
    expect(fix.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"] } });
    expect(Object.keys(jobs).sort()).toEqual(["decide", "fix", "write"]);
  });

  it("decides and fixes with tokens that only read, and writes from a job that runs none of the change", () => {
    expect(writes(jobs.decide)).toEqual([]);
    expect(writes(jobs.fix)).toEqual([]);
    expect(jobs.write.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(holdsClaude(jobs.write)).toBe(false);
    expect(runs(jobs.write)).not.toMatch(/(^|[\s;&|(])(npm|npx|node)\s/m);
  });

  // The branch's files and its fix commits are read with git, from a clone of main with the branch's
  // head fetched in, never from GitHub's compare, which lists at most 300 files.
  const decide = ({
    event = "pull_request",
    repository = "owner/repo",
    pullHead = undefined as string | undefined,
    test = "success",
    bug = "failure",
    security = "success",
    fixes = 0,
    pullRepository = "owner/repo",
    files = ["src/page.tsx"],
    important = true,
    twoLines = false,
    runPulls = [12],
    actor = { login: "awml-factory[bot]", type: "Bot" },
  }: Partial<{
    runPulls: number[];
    actor: { login: string; type: string };
    event: string;
    repository: string;
    pullHead: string;
    test: string;
    bug: string;
    security: string;
    fixes: number;
    pullRepository: string;
    files: string[];
    important: boolean;
    twoLines: boolean;
  }> = {}) => {
    const root = scratch();
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q");
    put(join(origin, "README.md"), "A registry\n");
    put(join(origin, ".github/review-findings.sh"), readFileSync(join(github, "review-findings.sh"), "utf8"));
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "main");
    git(origin, "switch", "-q", "-c", "build/issue-7");
    for (const path of files) put(join(origin, path), "changed\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "Build #7\n\nCloses #7");
    for (let at = 0; at < fixes; at++) {
      put(join(origin, `fix-${at}.txt`), "fixed\n");
      git(origin, "add", "-A");
      const line = `Factory-Fix: https://github.com/owner/repo/actions/runs/${at}`;
      git(origin, "commit", "-qm", `Fix the review findings\n\n${line}${twoLines ? `\n${line}` : ""}`);
    }
    const sha = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    const work = join(root, "work");
    git(root, "clone", "-q", origin, work);
    const run = rehearse(stepWithId(jobs.decide, "ready").run ?? "", {
      root,
      cwd: work,
      env: { BRANCH: "build/issue-7", HEAD_SHA: sha, HEAD_REPOSITORY: repository, CI_EVENT: event, CI_RUN: "77" },
      answers: `
  *"actions/runs/77/jobs"*) answer <<< '${JSON.stringify({
    jobs: [
      { name: "test", conclusion: test },
      { name: "Bug review", conclusion: bug, check_run_url: "https://api.github.com/repos/owner/repo/check-runs/11" },
      { name: "Security review", conclusion: security, check_run_url: "https://api.github.com/repos/owner/repo/check-runs/12" },
      { name: "Classify", conclusion: "success" },
    ],
  })}' ;;
  *"check-runs/11/annotations"*) answer <<< '${JSON.stringify(important && bug === "failure" ? [{ annotation_level: "failure", title: "Important: Wrong", message: "m", path: "src/a.ts", start_line: 1 }] : [])}' ;;
  *"check-runs/12/annotations"*) answer <<< '${JSON.stringify(important && security === "failure" ? [{ annotation_level: "failure", title: "Important: Hole", message: "m", path: "src/a.ts", start_line: 1 }] : [])}' ;;
  *"actions/runs/77"*) answer <<< '${JSON.stringify({ pull_requests: runPulls.map((number) => ({ number })), triggering_actor: actor })}' ;;
  *"pulls?head=owner:build/issue-7"*) answer <<< '${JSON.stringify([
    strangerPull(pullHead ?? sha),
    { ...appPull(pullHead ?? sha, pullRepository), number: 13, user: { login: "triager", type: "User" }, author_association: "MEMBER" },
    { ...appPull(pullHead ?? sha, pullRepository), user: { login: "maintainer", type: "User" }, author_association: "NONE" },
  ])}' ;;
${permissionStub}`,
    });
    return { ...run, sha };
  };

  it("reads the branch with git, from a clone of main that keeps no credentials", () => {
    const clone = steps(jobs.decide).find((each) => each.uses?.startsWith(cloneAction));
    expect(clone?.with).toEqual({ ref: "main", "fetch-depth": 0, "persist-credentials": false });
    expect(stepWithId(jobs.decide, "ready").run).not.toContain("/compare/");
  });

  // A session would load Claude Code's own files from the tree, so a branch that changes them is
  // held back, for its own reason. .github/ is read by nothing the fixer runs, so it isn't.
  it.runIf(canRehearse).each([".claude/settings.json", ".mcp.json", "src/CLAUDE.md"])("holds back a branch that changes %s, for its own reason", (path) => {
    expect(decide({ files: [path] }).outputs.outcome).toBe("claudefiles");
  });

  it.runIf(canRehearse)("fixes a branch that changes .github/", () => {
    expect(decide({ files: [".github/workflows/ci.yml"] }).outputs.outcome).toBe("fix");
  });

  it.runIf(canRehearse)("reads every changed file with git, so a package.json past the 300th is still held back", () => {
    const files = Array.from({ length: 301 }, (_, n) => `src/file-${n}.ts`);
    expect(decide({ files: [...files, "package.json"] }).outputs.outcome).toBe("npmfiles");
  });

  it.runIf(canRehearse)("fixes when the tests passed, a review failed, and the branch has fewer than two fix commits", () => {
    for (const fixes of [0, 1]) {
      const run = decide({ fixes });
      expect(run.failed, run.printed).toBe(false);
      expect(run.outputs).toMatchObject({ outcome: "fix", pr: "12", head_sha: run.sha, branch: "build/issue-7" });
    }
    expect(decide({ bug: "success", security: "failure" }).outputs.outcome).toBe("fix");
  });

  // Trust is by the opener's permission on the repository: an organisation's member who can only
  // triage it, or a stranger, is passed over, and a writer whose association says nothing isn't.
  it.runIf(canRehearse)("fixes the pull request of someone who may write, never a stranger's or a triager's from the same branch", () => {
    expect(decide().outputs.pr).toBe("12");
    const ready = stepWithId(jobs.decide, "ready").run ?? "";
    expect(ready).toContain('collaborators/$login/permission');
    expect(ready).not.toContain("author_association");
  });

  // A review that failed without an Important finding, having refused the patch or run out of
  // time, leaves nothing to fix: a person must look at its check.
  it.runIf(canRehearse)("gives up, naming the review, when a review failed with no Important finding", () => {
    const run = decide({ important: false });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.outcome).toBe("noimportant");
    expect(run.outputs.failed).toBe("Bug review");
  });

  // A stranger's pull request from the same branch, at the same head, gets a CI run of its own, so
  // the run must be the pull request's own, by GitHub's record of the run.
  // A stranger's pull request from the branch starts a run whose pull_requests still lists the
  // app's, so whoever started the run must be the app or someone who may write.
  it.runIf(canRehearse).each([
    ["the app", { login: "awml-factory[bot]", type: "Bot" }, "fix"],
    ["a writer", { login: "maintainer", type: "User" }, "fix"],
    ["a stranger", { login: "stranger", type: "User" }, "none"],
    ["a user named like the app", { login: "awml-factory[bot]", type: "User" }, "none"],
  ])("acts on a run %s started only if they may write", (_, actor, outcome) => {
    expect(decide({ actor }).outputs.outcome).toBe(outcome);
  });

  it.runIf(canRehearse)("exits quietly on a CI run that isn't the pull request's own", () => {
    const run = decide({ runPulls: [99] });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.outcome).toBe("none");
  });

  it.runIf(canRehearse)("counts a fix commit once, however many fix lines it carries", () => {
    expect(decide({ fixes: 1, twoLines: true }).outputs.outcome).toBe("fix");
  });

  it.runIf(canRehearse)("gives up after two fix commits", () => {
    expect(decide({ fixes: 2 }).outputs.outcome).toBe("giveup");
  });

  // npm would read the branch's .npmrc or a committed node_modules/ beside the Claude token, so a
  // branch that changes them is never installed: a person must fix it.
  it.runIf(canRehearse).each([
    ".npmrc",
    "web/.npmrc",
    ".yarnrc",
    "node_modules/left-pad/index.js",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
  ])(
    "refuses a branch that changes %s",
    (path) => {
      expect(decide({ files: [path] }).outputs.outcome).toBe("npmfiles");
      expect(decide({ files: ["src/page.tsx"] }).outputs.outcome).toBe("fix");
    },
  );

  // The tests own a run where both they and a review failed, so retry acts then. Someone else's
  // push since the review, or a closed pull request, leaves nothing to fix.
  it.runIf(canRehearse).each([
    ["failed tests", { test: "failure" }],
    ["passed reviews", { bug: "success" }],
    ["a push's run", { event: "push" }],
    ["a fork's run", { repository: "stranger/repo" }],
    ["a fork's pull request from a build/issue-N branch", { pullRepository: "stranger/repo" }],
    ["a head that moved", { pullHead: "b".repeat(40) }],
  ])("exits quietly on %s", (_, options) => {
    const run = decide(options);
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.outcome).toBe("none");
    expect(run.calls).not.toContain("comment");
  });

  it.runIf(canRehearse)("fixes in a sandboxed session that reads only the workspace and its inputs", () => {
    const draft = stepWithId(jobs.fix, "session");
    const root = scratch();
    const input = join(root, "runner/input");
    put(join(input, "findings.json"), "[]");
    put(join(root, "runner/main/fix-prompt.md"), "Read INPUT_DIR/findings.json. Write OUT_DIR/message.md.\n");
    put(join(root, "runner/main/claude-settings.sh"), readFileSync(join(github, "claude-settings.sh"), "utf8"));
    const { run, started } = sessions(draft.run ?? "", root, {
      INPUT_DIR: input,
      CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(run.failed, run.printed).toBe(false);
    const [session] = started;
    const settings = JSON.parse(readFileSync(join(session.home, ".claude/settings.json"), "utf8"));
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
    expect(settings.sandbox.filesystem.denyWrite).toContain("./.git");
    expect(flagValues(session.args, "--permission-mode")).toEqual(["default"]);
    expect(flagValues(session.args, "--allowedTools").filter((rule) => rule.startsWith("Read("))).toEqual(["Read(./**)", `Read(/${input}/**)`]);
    const prompt = session.args[session.args.indexOf("-p") + 1];
    expect(prompt).toContain(`${input}/findings.json`);
  });

  it("brings in both reviews' findings from CI's checks, and main's prompt, before it checks out the head", () => {
    const text = runs(jobs.fix);
    expect(text).toContain('review-findings.sh" findings "$CI_RUN"');
    const clones = steps(jobs.fix).filter((each) => each.uses?.startsWith(cloneAction));
    expect(clones.map((each) => each.with?.ref)).toEqual(["main", "${{ needs.decide.outputs.head_sha }}"]);
    for (const each of clones) expect(each.with?.["persist-credentials"]).toBe(false);
    const all = steps(jobs.fix);
    const copied = all.findIndex((each) => (each.run ?? "").includes("fix-prompt.md"));
    expect(copied).toBeGreaterThan(-1);
    expect(copied).toBeLessThan(all.indexOf(clones[1]));
  });

  // Claude's message goes into the fix commit, so it closes no issue.
  it("neutralises closing keywords in the session's message before it's kept", () => {
    expect(stepWithId(jobs.fix, "patch").run).toContain('bash "$RUNNER_TEMP/main/unclose.sh" < "$out" > "$fixed/message.md"');
    expect(runs(jobs.fix)).toMatch(/cp [^\n]*\.github\/unclose\.sh/);
  });

  it("keeps the fix for 30 days, so an offered fix can be downloaded", () => {
    const upload = steps(jobs.fix).find((each) => each.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.with).toEqual({ name: "fix", path: "${{ runner.temp }}/fix", "retention-days": 30 });
  });

  describe("the write job's guard", () => {
    const guard = (env: Record<string, string>, path = "src/page.tsx", pullHead = head, link = "") => {
      const root = scratch();
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q");
      put(join(repo, "README.md"), "A registry\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "head");
      if (link) symlinkSync(link, join(repo, path));
      else put(join(repo, path), "fixed\n");
      git(repo, "add", "-A");
      put(join(root, "runner/fix/fix.patch"), git(repo, "diff", "--cached", "--binary") + "\n");
      git(repo, "reset", "-q", "--hard");
      return rehearse(stepWithId(jobs.write, "guard").run ?? "", {
        root,
        cwd: repo,
        env: { PR_NUMBER: "12", HEAD_SHA: head, CI_RUN: "77", OUTCOME: "fix", FIXED: "success", CHANGED: "true", ...env },
        answers: `
  *"pulls/12"*) answer <<< '${JSON.stringify({ state: "open", head: { sha: pullHead } })}' ;;
  *"pr comment"*) ;;`,
      });
    };

    it.runIf(canRehearse)("pushes a fix to the registry's own code", () => {
      const run = guard({});
      expect(run.failed, run.printed).toBe(false);
      expect(run.outputs.result).toBe("push");
      expect(run.calls).not.toContain("pr comment");
    });

    it.runIf(canRehearse)("exits quietly when someone pushed since the review", () => {
      const run = guard({}, "src/page.tsx", "b".repeat(40));
      expect(run.outputs.result).toBe("quiet");
      expect(run.calls).not.toContain("pr comment");
    });

    it.runIf(canRehearse)("gives up in a new comment after two fix commits, linking the checks", () => {
      const run = guard({ OUTCOME: "giveup" });
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toMatch(/> .*two fix commits/);
      expect(run.calls).toContain("https://github.com/owner/repo/actions/runs/77");
    });

    it.runIf(canRehearse)("says in a new comment that Claude Code's own files keep the fixer from the branch", () => {
      const run = guard({ OUTCOME: "claudefiles" });
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toMatch(/> .*Claude Code's own files/);
      expect(run.calls).not.toMatch(/> .*dependencies/);
    });

    it.runIf(canRehearse)("says in a new comment that npm's files keep the fixer from the branch", () => {
      const run = guard({ OUTCOME: "npmfiles" });
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toMatch(/> .*\.npmrc/);
    });

    it.runIf(canRehearse)("names the failed review in a new comment when it left no Important finding", () => {
      const run = guard({ OUTCOME: "noimportant", FAILED_REVIEWS: "Bug review" });
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toMatch(/> .*Bug review failed with no Important finding/);
    });

    it.runIf(canRehearse)("gives up in a new comment when the session made no fix", () => {
      const run = guard({ CHANGED: "false" });
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toMatch(/> .*made no fix.*need a person/);
    });

    // The fix job can fail after its session, on a changed config, a nested .git or the token scan,
    // so a failed job isn't blamed on the session.
    it.runIf(canRehearse)("says the fix job failed before the fix was kept, not that the session did", () => {
      const run = guard({ FIXED: "failure" });
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toContain("The fix job failed before the fix was kept. The run says why.");
      expect(run.calls).not.toContain("session");
    });

    it.runIf(canRehearse)("offers a fix that adds a symbolic link rather than push it", () => {
      const run = guard({}, "env", head, "/proc/self/environ");
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toContain("a symbolic link is read wherever it's followed");
    });

    it.runIf(canRehearse).each(["package.json", "package-lock.json"])("offers a fix to %s rather than push it", (path) => {
      const run = guard({}, path);
      expect(run.outputs.result).toBe("done");
      expect(run.calls).toContain("> gh run download 1000 --repo owner/repo -n fix -D fix");
    });

    it.runIf(canRehearse)("prints the paths it offers without letting one start a workflow command", () => {
      const run = guard({}, `.github/${forgedPath}`);
      expect(run.outputs.result).toBe("done");
      expect(commandsIn(run.printed)).toEqual([]);
    });

    it.runIf(canRehearse).each(neverPushed)(
      "offers a fix to %s with the commands to download and apply it",
      (path) => {
        const run = guard({}, path);
        expect(run.outputs.result).toBe("done");
        expect(run.calls).toContain("> gh run download 1000 --repo owner/repo -n fix -D fix");
        expect(run.calls).toContain("> git apply --index fix/fix.patch");
        expect(run.calls).toContain("30 days");
      },
    );
  });

  // One commit, carrying the fix line that counts it as a try, pushed only if the branch is still
  // at the reviewed commit.
  it("pushes one commit carrying the fix line, with --force-with-lease at the reviewed commit", () => {
    expect(stepWithId(jobs.write, "commit").run).toContain("Factory-Fix: $run_url");
    expect(stepWithId(jobs.write, "push").run).toContain('push --force-with-lease="refs/heads/$BRANCH:$HEAD_SHA" origin "HEAD:refs/heads/$BRANCH"');
    for (const [id, job] of Object.entries(jobs))
      for (const each of steps(job))
        if (JSON.stringify(each.env ?? {}).includes("steps.app.outputs.token")) expect(`${id} ${each.id}`).toBe("write push");
  });

  it.runIf(canRehearse)("counts fix commits by the line build-rule.ts counts them by", () => {
    const rule = readFileSync(join(__dirname, "../scripts/build-rule.ts"), "utf8");
    expect(rule).toContain("const fixLine = /^Factory-Fix: /m;");
    expect(stepWithId(jobs.decide, "ready").run).toContain('test("(^|\\n)Factory-Fix: ")');
  });
});

describe("retry.yml", () => {
  const retry = readWorkflow("retry.yml");
  const jobs = retry.jobs;
  const head = "a".repeat(40);

  it("wakes when CI's run finishes on a factory branch, and takes no inputs", () => {
    expect(retry.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["build/issue-*"] } });
    expect(retry["run-name"]).toBeUndefined();
  });

  // It reads the branch's commits with git, from a clone of main that keeps no credentials, and runs
  // nothing from the branch.
  it("reads the branch with git from a clone of main, and runs only gh and git", () => {
    expect(Object.keys(jobs)).toEqual(["retry"]);
    const uses = steps(jobs.retry).filter((each) => each.uses);
    expect(uses).toHaveLength(1);
    expect(uses[0].uses?.startsWith(cloneAction)).toBe(true);
    expect(uses[0].with).toEqual({ ref: "main", "fetch-depth": 0, "persist-credentials": false });
    expect(jobs.retry.permissions).toEqual({ actions: "write", contents: "read", issues: "write", "pull-requests": "read" });
  });

  const tries = ({
    event = "pull_request",
    repository = "owner/repo",
    test = "failure",
    bug = "failure",
    pullHead = head,
    labels = ["build"],
    edited = null as string | null,
    renamed = undefined as string | undefined,
    builds = 1,
    pullRepository = "owner/repo",
    earlierFailure = false as boolean | "review",
    runPulls = [12],
    actor = { login: "awml-factory[bot]", type: "Bot" },
    personCommits = false,
    earlierTaken = false,
  } = {}) => {
    const root = scratch();
    // The branch's commits, the factory's, then a person's if asked.
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q");
    put(join(origin, "README.md"), "A registry\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "main");
    git(origin, "switch", "-q", "-c", "build/issue-7");
    put(join(origin, "src/page.tsx"), "page\n");
    git(origin, "add", "-A");
    git(origin, "-c", "user.name=awml-factory[bot]", "-c", "user.email=1+awml-factory[bot]@users.noreply.github.com", "commit", "-qm", "Build #7");
    if (personCommits) {
      put(join(origin, "src/page.tsx"), "a person's page\n");
      git(origin, "commit", "-qam", "A person takes it on", "--date=2026-10-03T00:00:00Z");
    }
    const sha = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    const work = join(root, "work");
    git(root, "clone", "-q", origin, work);
    const at = pullHead === head ? sha : pullHead;
    const runs_ = Array.from({ length: builds }, (_, at) => ({
      display_title: "Build of issue 7",
      event: at === 0 ? "issues" : "workflow_dispatch",
      head_branch: "main",
      created_at: `2026-10-02T0${at}:00:00Z`,
    }));
    const ciRuns = {
      workflow_runs: [
        { id: 77, event: "pull_request", conclusion: "failure", head_repository: { full_name: "owner/repo" } },
        ...(earlierFailure
          ? [{ id: 70, event: "pull_request", conclusion: "failure", head_sha: "7".repeat(40), head_repository: { full_name: "owner/repo" } }]
          : []),
        { id: 69, event: "pull_request", conclusion: "failure", head_repository: { full_name: "stranger/repo" } },
      ],
    };
    runs_.push({ display_title: "Build of issue 8", event: "issues", head_branch: "main", created_at: "2026-10-02T00:00:00Z" });
    runs_.push({ display_title: "A label added to issue 7", event: "issues", head_branch: "main", created_at: "2026-10-02T00:00:00Z" });
    return rehearse(stepWithId(jobs.retry, "tries").run ?? "", {
      root,
      cwd: work,
      env: { BRANCH: "build/issue-7", HEAD_SHA: sha, HEAD_REPOSITORY: repository, CI_EVENT: event, CI_RUN: "77" },
      answers: `
${permissionStub}
  *"actions/runs/77/jobs"*) answer <<< '${JSON.stringify({ jobs: [{ name: "test", conclusion: test }, { name: "Bug review", conclusion: bug }] })}' ;;
  *"actions/runs/77"*) answer <<< '${JSON.stringify({ pull_requests: runPulls.map((number) => ({ number })), triggering_actor: actor })}' ;;
  *"pulls?head=owner:build/issue-7"*) answer <<< '${JSON.stringify([strangerPull(sha), appPull(at, pullRepository)])}' ;;
  *"actions/workflows/ci.yml/runs"*) answer <<< '${JSON.stringify(ciRuns)}' ;;
  *"compare/main...${"7".repeat(40)}"*) answer <<< '${JSON.stringify({
    commits: [
      { parents: [{}], commit: { author: { email: "1+awml-factory[bot]@users.noreply.github.com" }, committer: { email: "1+awml-factory[bot]@users.noreply.github.com" } } },
      ...(earlierTaken ? [{ parents: [{}], commit: { author: { email: "person@example.com" }, committer: { email: "person@example.com" } } }] : []),
    ],
  })}' ;;
  *"actions/runs/70/jobs"*) answer <<< '${JSON.stringify({
    jobs: [
      { name: "test", conclusion: earlierFailure === "review" ? "success" : "failure" },
      { name: "Bug review", conclusion: "failure" },
    ],
  })}' ;;
  *"api graphql"*) answer <<< '${JSON.stringify({
    data: {
      repository: {
        issue: {
          lastEditedAt: edited,
          labels: { nodes: labels.map((name) => ({ name })) },
          timelineItems: {
            nodes: [
              { __typename: "LabeledEvent", createdAt: "2026-10-01T10:00:00Z", label: { name: "build" } },
              ...(renamed ? [{ __typename: "RenamedTitleEvent", createdAt: renamed }] : []),
            ],
          },
        },
      },
    },
  })}' ;;
  *"actions/workflows/build.yml/runs"*) answer <<< '${JSON.stringify({ workflow_runs: runs_ })}' ;;
  *"workflow run"*) ;;
  *"issue comment"*) ;;`,
    });
  };

  // The tests own a run where both they and a review failed.
  it.runIf(canRehearse)("starts the build again with only the issue's number while there are fewer than three builds", () => {
    for (const builds of [1, 2]) {
      const run = tries({ builds });
      expect(run.failed, run.printed).toBe(false);
      expect(run.calls).toContain("workflow run build.yml --repo owner/repo --ref main -f issue=7\n");
      expect(run.calls).not.toContain("issue comment");
    }
    expect(tries({ bug: "success" }).calls).toContain("workflow run build.yml");
  });

  it.runIf(canRehearse)("counts only build.yml runs for the issue since the label was last added", () => {
    const run = tries({ builds: 2 });
    expect(run.calls).toContain("created=>=2026-10-01T10:00:00Z");
    expect(run.printed).toContain("2 builds");
  });

  it.runIf(canRehearse)("says in a new comment that a person must act after three builds", () => {
    const run = tries({ builds: 3 });
    expect(run.calls).not.toContain("workflow run");
    expect(run.calls).toContain("issue comment 7 --repo owner/repo --body-file");
    expect(run.calls).toMatch(/> .*three times/);
    expect(run.calls).toContain("https://github.com/owner/repo/actions/runs/77");
  });

  // A stranger's pull request from the branch starts a run whose pull_requests still lists the
  // app's, so whoever started the run must be the app or someone who may write.
  it.runIf(canRehearse)("exits quietly on a CI run a stranger started", () => {
    const run = tries({ actor: { login: "stranger", type: "User" } });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).not.toMatch(/workflow run|issue comment/);
    expect(tries({ actor: { login: "maintainer", type: "User" } }).calls).toContain("workflow run build.yml");
  });

  // A person's commit on the branch means they've taken it on: the build doesn't redraft over it,
  // and says so once, by the first run whose tests failed since that commit.
  // Told once, by GitHub's record: an earlier run whose tests failed on a head that already held a
  // commit not the factory's said it. An earlier failed run of the factory's own commits didn't, so
  // a person whose commits were written before it, and pushed after, is still told.
  it.runIf(canRehearse)("leaves a branch a person has committed to, and says so once", () => {
    const run = tries({ personCommits: true });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).not.toContain("workflow run");
    expect(run.calls.match(/issue comment 7 /g)).toHaveLength(1);
    expect(run.calls).toMatch(/> .*a person has taken it over/);
    const factoryOnlyBefore = tries({ personCommits: true, earlierFailure: true });
    expect(factoryOnlyBefore.calls.match(/issue comment 7 /g)).toHaveLength(1);
    const told = tries({ personCommits: true, earlierFailure: true, earlierTaken: true });
    expect(told.calls).not.toMatch(/workflow run|issue comment/);
  });

  it("is drawn with its takeover, and says so in its header", () => {
    const drawing = readFileSync(join(github, "drawings/retry-a-build.yaml"), "utf8");
    expect(drawing).toMatch(/- \{ id: takenover, kind: code, op: do, cleans: true, label: "[^"]+"/);
    expect(drawing).toContain('{ from: tries, to: takenover, kind: start, label: "[a commit since main isn\'t the factory\'s]" }');
    expect(drawing).toMatch(/- \{ id: takenovernote, kind: outside, label: "Comment on the issue: Allow"/);
    expect(drawing).toContain("{ from: takenover, to: takenovernote, kind: data }");
    const text = readFileSync(join(github, "workflows/retry.yml"), "utf8");
    expect(squash(text.slice(0, text.indexOf("\nname:")))).toContain("a person has taken it over");
  });

  it.runIf(canRehearse)("exits quietly on a CI run that isn't the app's pull request's own", () => {
    const run = tries({ runPulls: [99] });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).not.toMatch(/workflow run|issue comment/);
  });

  it.runIf(canRehearse)("names the app's pull request in its comments, never a stranger's", () => {
    const run = tries({ builds: 3 });
    expect(run.calls).toContain("#12");
    expect(run.calls).not.toContain("#99");
  });

  // The comment is posted once: only by the first CI run whose tests failed after the third build
  // started, found from GitHub's runs, never from a marker in an earlier comment.
  // After the third build its CI passed the tests and failed a review, the fixer pushed, and the fix
  // broke the tests: that's the first run since the third build whose tests failed, so a person is
  // told, once.
  it.runIf(canRehearse)("tells a person when a fix commit after the third build breaks the tests", () => {
    const run = tries({ builds: 3, earlierFailure: "review" });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).not.toContain("workflow run");
    expect(run.calls.match(/issue comment 7 /g)).toHaveLength(1);
  });

  it.runIf(canRehearse)("says a person must act only once", () => {
    const run = tries({ builds: 3, earlierFailure: true });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).not.toMatch(/workflow run|issue comment/);
    expect(run.calls).toContain("created=>=2026-10-02T02:00:00Z");
  });

  it.runIf(canRehearse)("stops with a new comment when the title was renamed since the label went on", () => {
    const run = tries({ renamed: "2026-10-01T11:00:00Z" });
    expect(run.calls).not.toContain("workflow run");
    expect(run.calls).toMatch(/> .*edited since the build label/);
  });

  it.runIf(canRehearse)("stops with a new comment when the issue was edited since the label went on", () => {
    const run = tries({ edited: "2026-10-01T11:00:00Z" });
    expect(run.calls).not.toContain("workflow run");
    expect(run.calls).toMatch(/> .*edited since the build label/);
  });

  it.runIf(canRehearse).each([
    ["passed tests", { test: "success" }],
    ["a push's run", { event: "push" }],
    ["a fork's run", { repository: "stranger/repo" }],
    ["a fork's pull request from a build/issue-N branch", { pullRepository: "stranger/repo" }],
    ["a head that moved", { pullHead: "b".repeat(40) }],
    ["a label that's off", { labels: ["bug"] }],
  ])("exits quietly on %s", (_, options) => {
    const run = tries(options);
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls).not.toMatch(/workflow run|issue comment/);
  });
});

describe("resolve.yml", () => {
  const resolve = readWorkflow("resolve.yml");
  const jobs = resolve.jobs;

  it("keeps its trigger, a push to main", () => {
    expect(resolve.on).toEqual({ push: { branches: ["main"] } });
  });

  // It pushes and doesn't judge: the check job is gone, and CI runs on the pushed commit. Claude
  // starts only on a real conflict. One comment, when it ends.
  it("finds and rebases, resolves a real conflict, and pushes, with no check job", () => {
    expect(Object.keys(jobs).sort()).toEqual(["draft", "find", "push"]);
    expect(jobs.draft.if).toBe("needs.find.outputs.conflicted == 'true'");
    for (const id of ["find", "push"]) expect(runs(jobs[id]), id).not.toMatch(/(^|[\s;&|(])(npm|npx|node)\s/m);
    expect(writes(jobs.find)).toEqual([]);
    expect(writes(jobs.draft)).toEqual([]);
    expect(jobs.push.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    const comments = Object.entries(jobs).flatMap(([id, job]) =>
      steps(job).filter((each) => /gh (pr|issue) comment/.test(each.run ?? "")).map((each) => `${id} ${each.id}`),
    );
    expect(comments).toEqual(["push tell"]);
  });

  // A pull request from main's own people, or the factory's, on a branch of this repository, that
  // GitHub marks as conflicting. A plain git rebase comes first, hooks and fsmonitor off, and a
  // clean one is bundled for the push job at once, with no Claude session.
  it.runIf(canRehearse)("rebases with git alone first, and leaves only a real conflict to Claude", () => {
    const root = scratch();
    const origin = join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q");
    put(join(origin, "a.txt"), "one\n");
    put(join(origin, "b.txt"), "one\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "base");
    git(origin, "switch", "-q", "-c", "clean");
    put(join(origin, "c.txt"), "new\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "clean change");
    const cleanHead = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    git(origin, "switch", "-q", "-c", "clash");
    put(join(origin, "a.txt"), "branch\n");
    git(origin, "commit", "-qam", "clash change");
    const clashHead = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    git(origin, "switch", "-q", "-c", "workflow");
    put(join(origin, "a.txt"), "workflow\n");
    put(join(origin, ".github/workflows/x.yml"), "on: push\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "workflow change");
    const workflowHead = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    // A branch that changes the dependencies is held back too: npm runs a git dependency's
    // prepare script on the host even with scripts off.
    git(origin, "switch", "-q", "-c", "deps");
    put(join(origin, "a.txt"), "deps\n");
    put(join(origin, "package.json"), '{"dependencies": {"c": "git+ssh://git@example.com/c.git"}}\n');
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "dependency change");
    const depsHead = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    // A branch that changes the dependencies in one commit and puts them back in the next leaves no
    // change in its net diff, but each commit is installed along the way.
    git(origin, "switch", "-q", "-c", "sneaky");
    put(join(origin, "a.txt"), "sneaky\n");
    put(join(origin, "package.json"), '{"dependencies": {"c": "git+ssh://git@example.com/c.git"}}\n');
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "add a dependency");
    git(origin, "rm", "-q", "package.json");
    git(origin, "commit", "-qm", "and take it out");
    const sneakyHead = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    put(join(origin, "a.txt"), "main\n");
    git(origin, "commit", "-qam", "main moves");
    const main = git(origin, "rev-parse", "HEAD");
    const work = join(root, "work");
    git(root, "clone", "-q", origin, work);
    const pull = (number: number, branch: string, sha: string, login = "maintainer", type = "User") =>
      JSON.stringify({ number, base: { ref: "main" }, head: { ref: branch, sha, repo: { full_name: "owner/repo" } }, author_association: "MEMBER", user: { login, type } });
    const run = rehearse(stepWithId(jobs.find, "find").run ?? "", {
      root,
      cwd: work,
      env: { MAIN_SHA: main },
      answers: `
  *"users/awml-factory"*) echo 99 ;;
${permissionStub}
  *"pulls?state=open"*) printf '1\\n2\\n3\\n4\\n5\\n6\\n7\\n8\\n' ;;
  *"pr view 6 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${sneakyHead}"}' ;;
  *"pulls/6"*) answer <<< '${pull(6, "sneaky", sneakyHead)}' ;;
  *"pr view 7 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${clashHead}"}' ;;
  *"pulls/7"*) answer <<< '${pull(7, "build/issue-7", clashHead, "other-app[bot]", "Bot")}' ;;
  *"pr view 8 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${clashHead}"}' ;;
  *"pulls/8"*) answer <<< '${pull(8, "clash", clashHead, "triager")}' ;;
  *"pr view 5 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${depsHead}"}' ;;
  *"pulls/5"*) answer <<< '${pull(5, "deps", depsHead)}' ;;
  *"pr view 4 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${workflowHead}"}' ;;
  *"pulls/4"*) answer <<< '${pull(4, "workflow", workflowHead)}' ;;
  *"pr view 1 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${cleanHead}"}' ;;
  *"pr view 2 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${clashHead}"}' ;;
  *"pr view 3 "*) answer <<< '{"mergeable": "CONFLICTING", "headRefOid": "${clashHead}"}' ;;
  *"pulls/1"*) answer <<< '${pull(1, "clean", cleanHead)}' ;;
  *"pulls/2"*) answer <<< '${pull(2, "clash", clashHead)}' ;;
  *"pulls/3"*) answer <<< '${pull(3, "clash", clashHead, "stranger")}' ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(JSON.parse(run.outputs.pulls)).toEqual([
      { number: 1, branch: "clean", head_sha: cleanHead, clean: true, guarded: false },
      { number: 2, branch: "clash", head_sha: clashHead, clean: false, guarded: false },
      { number: 4, branch: "workflow", head_sha: workflowHead, clean: false, guarded: true },
      { number: 5, branch: "deps", head_sha: depsHead, clean: false, guarded: true },
      { number: 6, branch: "sneaky", head_sha: sneakyHead, clean: false, guarded: true },
    ]);
    // A reader's, a triager's and another app's are never touched, whatever the branch.
    expect(stepWithId(jobs.find, "find").run).not.toContain("author_association");
    expect(run.outputs.conflicted).toBe("true");
    expect(existsSync(join(root, "runner/rebased/1.bundle"))).toBe(true);
    expect(existsSync(join(root, "runner/rebased/2.bundle"))).toBe(false);
    expect(run.outputs.digest).toBe(digestOf(join(root, "runner/rebased")));
  });

  // Each real conflict is worked in a clone of its own, outside the workspace, made and set off
  // rebasing by a token-free step. A session only edits the conflicted files; between sessions a
  // step that holds no Claude token adds them and continues the rebase with git, and a commit that
  // conflicts in turn waits for the next round's session, three rounds in all. So git, which writes
  // scripts/ and package.json when it replays a commit, never runs in a session, whose commands
  // can't. A last token-free step bundles each finished rebase and checks it.
  it("prepares, then alternates three rounds of sessions with token-free git, then checks", () => {
    const ids = steps(jobs.draft).map((each) => each.id).filter(Boolean);
    expect(ids).toEqual(["prepare", "session1", "continue1", "session2", "continue2", "session3", "continue3", "check"]);
    for (const round of [1, 2, 3]) {
      expect(stepWithId(jobs.draft, `session${round}`).run).toBe(`{ STEP_SCRIPT="$0" bash "$RUNNER_TEMP/main/resolve-session.sh" ${round}; exit; }\n`);
      const resume = stepWithId(jobs.draft, `continue${round}`);
      expect(resume.run).toBe(`bash "$RUNNER_TEMP/main/resolve-continue.sh"\n`);
      expect(resume.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(resume.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    }
    for (const id of ["prepare", "check"]) expect(stepWithId(jobs.draft, id).env?.CLAUDE_CODE_OAUTH_TOKEN, id).toBeUndefined();
    expect(jobs.draft.outputs?.digest).toBe("${{ steps.check.outputs.digest }}");
  });

  it("clones each branch outside the workspace, starts its rebase, and keeps its baseline where no session can write", () => {
    const prepare = stepWithId(jobs.draft, "prepare");
    const text = prepare.run ?? "";
    for (const want of [
      'safe_git fetch -q --no-tags origin "$head_sha:refs/heads/factory-rebase-$number"',
      `safe_git clone -q --no-hardlinks --no-${CLONE} "$GITHUB_WORKSPACE" "$root/work"`,
      'safe_git -C "$root/work" config core.hooksPath /dev/null',
      'safe_git -C "$root/work" config core.fsmonitor false',
      'safe_git -C "$root/work" config core.editor true',
      'safe_git -C "$root/work" config user.name "awml-factory[bot]"',
      '(cd "$root/work" && npm ci --ignore-scripts --no-audit --no-fund)',
      'safe_git -C "$root/work" rebase -q "$MAIN_SHA"',
      'bash "$RUNNER_TEMP/main/check-lockfile.sh" "$root/work"',
      'cp "$root/work/.git/config" "$RUNNER_TEMP/baseline/git-config-$number"',
      'stat -c %d:%i "$root/work" "$root/work/.git" > "$RUNNER_TEMP/baseline/clone-$number"',
      'stat -c %d:%i "$GITHUB_WORKSPACE" "$GITHUB_WORKSPACE/.git" > "$RUNNER_TEMP/baseline/workspace"',
      ".github/resolve-session.sh .github/resolve-continue.sh",
    ])
      expect(text).toContain(want);
    expect(prepare.env).toMatchObject(hostNpm);
    expect(text).toContain("select(.clean == false and .guarded == false)");
    // The rebase stops before the install, so the clone installs main's lockfile, which the branch
    // left alone or it would have been held back.
    const rebase = text.indexOf('safe_git -C "$root/work" rebase -q "$MAIN_SHA"');
    expect(rebase).toBeLessThan(text.indexOf('bash "$RUNNER_TEMP/main/check-lockfile.sh" "$root/work"'));
    expect(rebase).toBeLessThan(text.indexOf("npm ci --ignore-scripts"));
    expect(squash(readFileSync(join(github, "resolve-prompt.md"), "utf8"))).toContain("with main's dependencies installed");
  });

  it("runs no git in a session's step, and lets the session run none that writes", () => {
    const session = readFileSync(join(github, "resolve-session.sh"), "utf8");
    const commands = session.replace(/"Bash\([^"]*\)"/g, "").split("\n").filter((line) => !/^\s*(#|echo )/.test(line));
    for (const line of commands) expect(line).not.toMatch(/(^|[\s;(|&])git\s/);
    expect(session).not.toMatch(/"Bash\(git (add|rebase|switch|commit|reset|bundle)/);
    expect(session).toContain('cd "$root/work"');
  });

  // Each session may edit its own clone and write its note, and nothing of another pull request's,
  // its inputs, main's scripts, the check folders, the baseline, the workspace or its clone's .git.
  const sessionRoot = (rebasing: number[], gaveUp: number[] = []) => {
    const root = scratch();
    put(join(root, "runner/pulls.tsv"), `1\t${"a".repeat(40)}\n2\t${"b".repeat(40)}\n3\t${"c".repeat(40)}\n`);
    for (const n of [1, 2, 3]) {
      mkdirSync(join(root, `runner/pr/${n}/work/.git`), { recursive: true });
      mkdirSync(join(root, `runner/pr/${n}/out`), { recursive: true });
      put(join(root, `runner/pr/${n}/in/conflicted-files.txt`), "a.txt\n");
    }
    for (const n of rebasing) mkdirSync(join(root, `runner/pr/${n}/work/.git/rebase-merge`));
    for (const n of gaveUp) put(join(root, `runner/baseline/gave-up-${n}`), "");
    put(join(root, "runner/main/resolve-prompt.md"), readFileSync(join(github, "resolve-prompt.md"), "utf8"));
    put(join(root, "runner/main/claude-settings.sh"), readFileSync(join(github, "claude-settings.sh"), "utf8"));
    return root;
  };

  it.runIf(canRehearse)("starts a session only where a rebase waits on a conflict, each round in a home of its own", () => {
    const root = sessionRoot([1, 3], [3]);
    const workspace = join(root, "workspace");
    const copy = join(root, "resolve-session.sh");
    put(copy, readFileSync(join(github, "resolve-session.sh"), "utf8"));
    const { run, started } = sessions(`{ STEP_SCRIPT="$0" bash ${copy} 2; exit; }\n`, root, {
      REWRITE: copy,
      CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      GITHUB_WORKSPACE: workspace,
      INPUT_DIR: join(root, "runner/pr/1/in"),
    });
    expect(run.failed, run.printed).toBe(false);
    expect(started).toHaveLength(1);
    expect(started[0].home).toBe(join(root, "runner/pr/1/round-2/home"));
    expect(flagValues(started[0].args, "--permission-mode")).toEqual(["default"]);
    const denied = JSON.parse(readFileSync(join(started[0].home, ".claude/settings.json"), "utf8")).sandbox.filesystem.denyWrite;
    expect(denied).toContain("./.git");
    for (const want of ["pr/2", "pr/3", "pr/1/in", "main", "check", "resolved", "baseline", "pulls.tsv"])
      expect(denied).toContain(join(root, "runner", want));
    expect(denied).toContain(workspace);
    expect(denied).not.toContain(join(root, "runner/pr/1"));
    expect(denied).not.toContain(join(root, "runner/pr/1/out"));
  });

  describe("resolve-continue.sh", () => {
    // A branch of two commits, each clashing with main, in a clone rebased until it stops at the
    // first, with its baseline kept.
    const midRebase = () => {
      const root = scratch();
      const clone = join(root, "runner/pr/5/work");
      mkdirSync(clone, { recursive: true });
      git(clone, "init", "-q");
      put(join(clone, "a.txt"), "one\n");
      put(join(clone, "b.txt"), "one\n");
      git(clone, "add", "-A");
      git(clone, "commit", "-qm", "base");
      git(clone, "switch", "-q", "-c", "branch");
      put(join(clone, "a.txt"), "branch\n");
      git(clone, "commit", "-qam", "first");
      put(join(clone, "b.txt"), "branch\n");
      git(clone, "commit", "-qam", "second");
      git(clone, "switch", "-q", "main");
      put(join(clone, "a.txt"), "main\n");
      put(join(clone, "b.txt"), "main\n");
      git(clone, "commit", "-qam", "main moves");
      const main = git(clone, "rev-parse", "HEAD");
      git(clone, "switch", "-q", "branch");
      spawnSync("git", ["-C", clone, "-c", "user.name=A", "-c", "user.email=a@example.com", "rebase", "-q", main], { encoding: "utf8" });
      put(join(root, "runner/pulls.tsv"), `5\t${"a".repeat(40)}\n`);
      put(join(root, "runner/pr/5/in/conflicted-files.txt"), "a.txt\n");
      put(join(root, "runner/baseline/git-config-5"), readFileSync(join(clone, ".git/config"), "utf8"));
      put(join(root, "runner/baseline/clone-5"), execFileSync("stat", ["-c", "%d:%i", clone, join(clone, ".git")], { encoding: "utf8" }));
      return { root, clone };
    };
    const resume = (root: string) =>
      rehearse(script("resolve-continue.sh"), {
        root,
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" },
      });
    const gaveUp = (root: string) => existsSync(join(root, "runner/baseline/gave-up-5"));

    it.runIf(canRehearse)("adds the resolved files and continues, stopping again at the next conflict", () => {
      const { root, clone } = midRebase();
      put(join(clone, "a.txt"), "both\n");
      const run = resume(root);
      expect(run.failed, run.printed).toBe(false);
      expect(existsSync(join(clone, ".git/rebase-merge"))).toBe(true);
      expect(left(root, "pr/5/in/conflicted-files.txt")).toBe("b.txt\n");
      put(join(clone, "b.txt"), "both\n");
      expect(resume(root).failed).toBe(false);
      expect(existsSync(join(clone, ".git/rebase-merge"))).toBe(false);
      expect(gaveUp(root)).toBe(false);
    });

    it.runIf(canRehearse)("gives up on a clone whose conflicts still hold markers", () => {
      const { root } = midRebase();
      expect(resume(root).failed).toBe(false);
      expect(gaveUp(root)).toBe(true);
    });

    it.runIf(canRehearse).each([
      ["whose git config the session changed", (clone: string) =>
        writeFileSync(join(clone, ".git/config"), readFileSync(join(clone, ".git/config"), "utf8") + "[diff]\n\texternal = touch /tmp/owned\n")],
      ["whose .git was replaced", (clone: string, root: string) => {
        execFileSync("mv", [join(clone, ".git"), join(root, "old-git")]);
        execFileSync("cp", ["-r", join(root, "old-git"), join(clone, ".git")]);
      }],
      ["with a repository nested below the top", (clone: string) => git(clone, "init", "-q", "src/inner")],
      ["with a repository nested in node_modules", (clone: string) => git(clone, "init", "-q", "node_modules/left-pad")],
    ])("runs no git in a clone %s", (_, spoil) => {
      const { root, clone } = midRebase();
      put(join(clone, "a.txt"), "both\n");
      spoil(clone, root);
      const run = resume(root);
      expect(run.failed, run.printed).toBe(false);
      expect(gaveUp(root)).toBe(true);
      expect(existsSync(join(clone, ".git/rebase-merge")), "the rebase went on").toBe(true);
    });
  });

  describe("the check step", () => {
    // A workspace whose main moved after a branch, and the session's clone, rebased there.
    const rebased = (resolve: (work: string) => void, spoil: (root: string, ws: string) => void = () => {}) => {
      const root = scratch();
      const ws = join(root, "ws");
      mkdirSync(ws);
      git(ws, "init", "-q");
      put(join(ws, "a.txt"), "one\n");
      git(ws, "add", "-A");
      git(ws, "commit", "-qm", "base");
      git(ws, "switch", "-q", "-c", "branch");
      put(join(ws, "a.txt"), "branch\n");
      git(ws, "commit", "-qam", "branch");
      const head = git(ws, "rev-parse", "HEAD");
      git(ws, "branch", "factory-rebase-5", head);
      git(ws, "switch", "-q", "main");
      put(join(ws, "b.txt"), "main\n");
      git(ws, "add", "-A");
      git(ws, "commit", "-qm", "main moves");
      const main = git(ws, "rev-parse", "HEAD");
      const work = join(root, "runner/pr/5/work");
      git(root, "clone", "-q", ws, work);
      git(work, "switch", "-q", "--detach", main);
      put(join(work, "a.txt"), "branch\n");
      resolve(work);
      git(work, "add", "-A");
      git(work, "commit", "-qm", "branch, rebased");
      put(join(root, "runner/pr/5/out/message.md"), "Kept both sides.\n");
      put(join(root, "runner/baseline/git-config-5"), readFileSync(join(work, ".git/config"), "utf8"));
      put(join(root, "runner/pulls.tsv"), `5\t${head}\n`);
      put(join(root, "runner/baseline/workspace"), execFileSync("stat", ["-c", "%d:%i", ws, join(ws, ".git")], { encoding: "utf8" }));
      put(join(root, "runner/baseline/clone-5"), execFileSync("stat", ["-c", "%d:%i", work, join(work, ".git")], { encoding: "utf8" }));
      put(join(root, "runner/main/scan-tokens.sh"), readFileSync(join(github, "scan-tokens.sh"), "utf8"));
      spoil(root, ws);
      const run = rehearse(stepWithId(jobs.draft, "check").run ?? "", { root, env: { MAIN_SHA: main, GITHUB_WORKSPACE: ws } });
      return { root, run };
    };

    it.runIf(canRehearse)("keeps a rebase that sits on main, with its note, and gives their digest", () => {
      const { root, run } = rebased(() => {});
      expect(run.failed, run.printed).toBe(false);
      expect(existsSync(join(root, "runner/resolved/5.bundle"))).toBe(true);
      expect(left(root, "resolved/5.md")).toBe("Kept both sides.\n");
      expect(run.outputs.digest).toBe(digestOf(join(root, "runner/resolved")));
    });

    it.runIf(canRehearse).each([
      ["conflict markers", (work: string) => put(join(work, "a.txt"), "<<<<<<< HEAD\nbranch\n=======\nmain\n>>>>>>> main\n")],
      ["a token the resolution adds", (work: string) => put(join(work, "c.txt"), `key sk-ant-oat01-${"x".repeat(20)}\n`)],
      ["a change to .github/", (work: string) => put(join(work, ".github/workflows/x.yml"), "on: push\n")],
      ["a change to an .npmrc", (work: string) => put(join(work, ".npmrc"), "registry=https://example.com/\n")],
      ["a change to the dependencies", (work: string) => put(join(work, "package.json"), '{"dependencies": {"c": "git+ssh://x"}}\n')],
      // A session could add a change and revert it in a later commit, leaving none in the net diff.
      [
        "a workflow added and taken out again",
        (work: string) => {
          put(join(work, ".github/workflows/x.yml"), "on: push\n");
          git(work, "add", "-A");
          git(work, "commit", "-qm", "add a workflow");
          git(work, "rm", "-q", ".github/workflows/x.yml");
        },
      ],
    ])("keeps no bundle with %s", (_, resolve) => {
      const { root, run } = rebased(resolve);
      expect(run.failed, run.printed).toBe(false);
      expect(existsSync(join(root, "runner/resolved/5.bundle"))).toBe(false);
    });

    it.runIf(canRehearse)("reads nothing from an out folder reached through a symbolic link", () => {
      const { root, run } = rebased(
        () => {},
        (root) => {
          const out = join(root, "runner/pr/5/out");
          const real = join(root, "elsewhere");
          execFileSync("mv", [out, real]);
          symlinkSync(real, out);
        },
      );
      expect(run.failed, run.printed).toBe(false);
      expect(existsSync(join(root, "runner/resolved/5.bundle"))).toBe(false);
      expect(existsSync(join(root, "runner/resolved/5.md"))).toBe(false);
    });

    it.runIf(canRehearse)("keeps nothing from a clone whose .git was replaced", () => {
      const { root, run } = rebased(
        () => {},
        (root) => {
          const work = join(root, "runner/pr/5/work");
          execFileSync("mv", [join(work, ".git"), join(root, "old-clone-git")]);
          execFileSync("cp", ["-r", join(root, "old-clone-git"), join(work, ".git")]);
        },
      );
      expect(run.failed, run.printed).toBe(false);
      expect(existsSync(join(root, "runner/resolved/5.bundle"))).toBe(false);
    });

    it.runIf(canRehearse).each([
      ["a rebase still waiting on a conflict", (root: string) => mkdirSync(join(root, "runner/pr/5/work/.git/rebase-merge"))],
      ["a rebase given up on", (root: string) => put(join(root, "runner/baseline/gave-up-5"), "")],
      ["a clone whose git config changed", (root: string) =>
        writeFileSync(join(root, "runner/pr/5/work/.git/config"), "[diff]\n\texternal = touch /tmp/owned\n")],
      ["a repository nested in the clone", (root: string) => git(join(root, "runner/pr/5/work"), "init", "-q", "src/inner")],
      ["a repository nested in the clone's node_modules", (root: string) =>
        git(join(root, "runner/pr/5/work"), "init", "-q", "node_modules/left-pad")],
    ])("bundles nothing from %s", (_, spoil) => {
      const { root, run } = rebased(() => {}, spoil);
      expect(run.failed, run.printed).toBe(false);
      expect(existsSync(join(root, "runner/resolved/5.bundle"))).toBe(false);
    });

    it.runIf(canRehearse)("stops when the workspace or its .git was replaced", () => {
      const { run } = rebased(
        () => {},
        (root, ws) => {
          execFileSync("mv", [join(ws, ".git"), join(root, "old-git")]);
          execFileSync("cp", ["-r", join(root, "old-git"), join(ws, ".git")]);
        },
      );
      expect(run.failed).toBe(true);
    });
  });

  // The push job's guards run none of the branch's code and catch a session that pushed something
  // other than a rebase.
  describe("the push job's guard", () => {
    const guard = (change: (repo: string) => void, clean = "true") => {
      const root = scratch();
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q");
      put(join(repo, "a.txt"), "one\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "main");
      const main = git(repo, "rev-parse", "HEAD");
      git(repo, "switch", "-q", "-c", "branch");
      change(repo);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "the branch");
      mkdirSync(join(root, "runner/bundles"), { recursive: true });
      git(repo, "bundle", "create", "-q", join(root, "runner/bundles/12.bundle"), `${main}..HEAD`);
      git(repo, "switch", "-q", "main");
      return rehearse(stepWithId(jobs.push, "guard").run ?? "", {
        root,
        cwd: repo,
        env: { MAIN_SHA: main, PR_NUMBER: "12", CLEAN: clean, GUARDED: "false" },
      });
    };

    it.runIf(canRehearse)("lets a rebase that sits on main through", () => {
      const run = guard((repo) => put(join(repo, "b.txt"), "two\n"));
      expect(run.failed, run.printed).toBe(false);
      expect(run.outputs.result).toBe("push");
    });

    it.runIf(canRehearse).each([
      ["conflict markers", (repo: string) => put(join(repo, "a.txt"), "<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> branch\n"), "conflict markers"],
      ["a workflow", (repo: string) => put(join(repo, ".github/workflows/x.yml"), "on: push\n"), ".github/"],
      ["Claude Code's settings", (repo: string) => put(join(repo, ".claude/settings.json"), "{}"), ".github/"],
    ])("refuses %s", (_, change, reason) => {
      const run = guard(change);
      expect(run.outputs.result).toBe("refused");
      expect(run.outputs.reason).toContain(reason);
    });

    it.runIf(canRehearse)("says a branch whose commits change .github/ wasn't rebased", () => {
      const root = scratch();
      const run = rehearse(stepWithId(jobs.push, "guard").run ?? "", {
        root,
        env: { MAIN_SHA: "a".repeat(40), PR_NUMBER: "12", CLEAN: "false", GUARDED: "true" },
      });
      expect(run.outputs.result).toBe("refused");
      expect(run.outputs.reason).toContain(".github/");
    });

    it.runIf(canRehearse)("refuses when Claude left no rebased branch", () => {
      const root = scratch();
      mkdirSync(join(root, "runner/bundles"), { recursive: true });
      const run = rehearse(stepWithId(jobs.push, "guard").run ?? "", {
        root,
        env: { MAIN_SHA: "a".repeat(40), PR_NUMBER: "12", CLEAN: "false", GUARDED: "false" },
      });
      expect(run.outputs.result).toBe("refused");
    });
  });

  it("pushes only if nobody pushed since the find job saw the branch", () => {
    expect(stepWithId(jobs.push, "push").run).toContain('push --force-with-lease="refs/heads/$BRANCH:$HEAD_SHA" origin');
  });

  // One comment when it ends: fixed text with links to the old and new commits, or why it couldn't
  // push, with Claude's note escaped.
  it.runIf(canRehearse)("posts one comment when it ends, with Claude's note escaped", () => {
    const tell = stepWithId(jobs.push, "tell");
    for (const [pushed, want] of [
      ["success", "Rebased this pull request onto `main`"],
      ["skipped", "couldn't rebase this pull request"],
    ]) {
      const root = scratch();
      put(join(root, "runner/bundles/12.md"), "Kept both <b>sides</b>, as @someone wanted.\n");
      const run = rehearse(tell.run ?? "", {
        root,
        env: {
          PR_NUMBER: "12",
          BRANCH: "clash",
          HEAD_SHA: "a".repeat(40),
          NEW_SHA: "b".repeat(40),
          PUSHED: pushed,
          REASON: "It holds conflict markers.",
          BUNDLES: join(root, "runner/bundles"),
        },
        answers: `  *"pr comment"*) ;;`,
      });
      expect(run.failed, run.printed).toBe(false);
      expect(run.calls).toContain(want);
      expect(run.calls).toContain("Kept both &lt;b>sides&lt;/b>, as @​someone wanted.");
      if (pushed === "success") expect(run.calls).toContain(`git push --force origin ${"a".repeat(40)}:clash`);
    }
  });
});
