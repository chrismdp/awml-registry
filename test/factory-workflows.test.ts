import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: Record<string, unknown> };
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

// The workflows the checks of Claude's steps must find Claude steps in, and how many steps each
// starts Claude in: the build's draft, its two reviews side by side and its classifier; the
// rebase's draft; and the pull request reviews, side by side.
const claudeSteps: Record<string, number> = { "build.yml": 3, "resolve.yml": 1, "review.yml": 1 };

const workflowFiles = readdirSync(join(__dirname, "../.github/workflows")).filter((file) =>
  file.endsWith(".yml"),
);

// A rehearsal runs one step's script as GitHub runs it, with bash -e, in a scratch RUNNER_TEMP,
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
// that home is empty, whether it could change REVIEW_DIR, and what it was started with, and writes
// nothing else.
const claudeStub = `#!/bin/bash
empty=no
[ -n "$(ls -A "$HOME" 2> /dev/null)" ] || empty=yes
changes=no
if touch "$REVIEW_DIR/planted" 2> /dev/null || [ -w "$REVIEW_DIR/REVIEW.md" ]; then changes=yes; fi
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
  const run = rehearse(script, { root, env: { CLAUDE_LOG: join(root, "claude.log"), ...env } });
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
  const ran = spawnSync("bash", ["-e", join(root, "step.sh")], {
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

describe("build.yml", () => {
  const workflow = readWorkflow("build.yml");
  const jobs = workflow.jobs;

  // A build says on the issue that it has started before Claude drafts, from a job that may write
  // to issues but checks out and runs nothing. If it can't comment, the build goes on.
  it("posts its status before it drafts", () => {
    const start = jobs.start;
    expect(start, "build.yml has no start job").toBeDefined();
    expect(writes(start)).toEqual(["issues"]);
    expect(
      steps(start)
        .map((each) => each.uses)
        .filter(Boolean),
    ).toEqual([]);
    expect(runs(start)).toContain("<!-- factory-status -->");
    expect(
      steps(start).every((each) => each["continue-on-error"] === true),
    ).toBe(true);
    expect(needs(jobs.draft)).toEqual(["start"]);
    expect(jobs.draft.if).toContain("!cancelled()");
    for (const name of ["draft", "check", "review", "pictures"]) {
      expect(writes(jobs[name]), `${name} should only read`).toEqual([]);
    }
  });

  // The open job edits the status comment to link the pull request, retry.yml edits it when the
  // build fails, and land.yml once CI has run on the pull request.
  it("edits its status when it ends", () => {
    for (const [file, name] of [
      ["build.yml", "open"],
      ["retry.yml", "retry"],
      ["land.yml", "land"],
    ]) {
      const job = readJobs(file)[name];
      expect(runs(job), `${file}'s ${name} doesn't edit the status comment`).toContain(
        "<!-- factory-status -->",
      );
      expect(job.permissions?.issues, `${file}'s ${name} can't write to issues`).toBe("write");
    }
  });

  // GitHub names each build and retry run for its issue and try, from its own inputs, so a run that
  // reads another can check that the run is the one it means before it trusts its artifacts.
  it("names each run for its issue and try, and checks a run before trusting its records", () => {
    for (const file of ["build.yml", "retry.yml"]) {
      const name = readWorkflow(file)["run-name"] ?? "";
      expect(name, `${file}'s run-name`).toContain("issue");
      expect(name, `${file}'s run-name`).toContain("try");
    }
    for (const name of ["start", "draft"]) {
      expect(runs(jobs[name]), `${name} doesn't check the previous run`).toContain("display_title");
      expect(runs(jobs[name]), `${name} doesn't check the previous run is retry.yml's`).toContain(
        "retry.yml",
      );
    }
    expect(runs(readJobs("retry.yml").retry)).toContain("display_title");
    const find = runs(readJobs("land.yml").find);
    for (const want of ["display_title", "head_branch", ".bot"]) expect(find).toContain(want);
  });

  // A retry run says why the last try failed. The status says so only if the run is retry.yml's
  // from main for this issue's last try.
  it.runIf(canRehearse)("says on the issue why the last try failed, from the retry run that started it", () => {
    const status = step(jobs.start, "Post or edit the status comment").run ?? "";
    const answers = (run: string) => `
  "api repos/owner/repo/actions/workflows/retry.yml"*) answer <<< '{"id": 11}' ;;
  "api repos/owner/repo/actions/runs/555") answer <<< '${run}' ;;
  "run download 555 "*) mkdir -p "$download"; printf 'The tests did not pass.\\nMore.\\n' > "$download/reason.txt" ;;
  "api --paginate repos/owner/repo/issues/120/comments"*) answer <<< '[{"id": 9, "user": {"login": "github-actions[bot]"}, "body": "<!-- factory-status -->\\nBuilding"}]' ;;
  "api -X PATCH repos/owner/repo/issues/comments/9"*) : ;;`;
    const env = { ISSUE: "120", ATTEMPT: "2", PREVIOUS_RUN: "555" };

    const root = scratch();
    const checked = rehearse(status, {
      root,
      env,
      answers: answers(
        `{"workflow_id": 11, "head_branch": "main", "display_title": "Retry of issue 120, try 1"}`,
      ),
    });
    expect(checked.failed, checked.printed).toBe(false);
    expect(String(checked.inputs[0]?.body)).toContain("(try 2 of 3)");
    expect(String(checked.inputs[0]?.body)).toContain(
      "The last try failed because: The tests did not pass.",
    );

    for (const run of [
      `{"workflow_id": 33, "head_branch": "main", "display_title": "Retry of issue 120, try 1"}`,
      `{"workflow_id": 11, "head_branch": "a-branch", "display_title": "Retry of issue 120, try 1"}`,
      `{"workflow_id": 11, "head_branch": "main", "display_title": "Retry of issue 121, try 1"}`,
    ]) {
      const forged = rehearse(status, { root: scratch(), env, answers: answers(run) });
      expect(forged.calls, `the status trusts ${run}`).not.toContain("run download");
      expect(String(forged.inputs[0]?.body)).toContain(
        "The last try failed because: The reason was not recorded.",
      );
    }
  });

  const labelledIssue = `{"action": "labeled", "label": {"name": "build"},
  "issue": {"number": 120, "title": "Labelled title", "body": "Labelled body"}}`;

  // The issue as it reads now: its author edited it after the label went on.
  const issueAnswers = `
  "api repos/owner/repo/issues/120"*) answer <<< '{"number": 120, "title": "Edited title", "body": "Edited body", "labels": [{"name": "build"}, {"name": "drawing"}]}' ;;
  "api --paginate repos/owner/repo/issues/120/comments"*) answer <<< '[
    {"author_association": "OWNER", "user": {"login": "the-owner"}, "created_at": "2026-10-27T10:00:00Z", "body": "The owner says this"},
    {"author_association": "NONE", "user": {"login": "a-stranger"}, "created_at": "2026-10-27T11:00:00Z", "body": "A stranger says that"}]' ;;`;

  // The label approves the issue as it reads then. The first try drafts from the title and body in
  // the label's event, keeps them as the build's record, and reads the labels and the comments of
  // the repository's own people as they are now. A build started by hand approves the issue as it
  // reads when it starts.
  it.runIf(canRehearse)("drafts the first try from the issue as it was when the label went on", () => {
    const bring = stepWithId(jobs.draft, "bring").run ?? "";
    const root = scratch();
    const event = join(root, "event.json");
    put(event, labelledIssue);
    const run = rehearse(bring, {
      root,
      env: {
        ISSUE: "120",
        ATTEMPT: "1",
        PREVIOUS_RUN: "",
        GITHUB_EVENT_NAME: "issues",
        GITHUB_EVENT_PATH: event,
      },
      answers: issueAnswers,
    });
    expect(run.failed, run.printed).toBe(false);
    const issue = left(root, "build/issue.md");
    for (const want of ["# #120: Labelled title", "Labelled body", "Labels: build, drawing", "The owner says this"])
      expect(issue).toContain(want);
    for (const unwanted of ["Edited", "A stranger says that"]) expect(issue).not.toContain(unwanted);
    expect(JSON.parse(left(root, "asked/asked.json"))).toEqual({
      issue: 120,
      title: "Labelled title",
      body: "Labelled body",
    });
    // The record's digest is the draft job's output, which no other job can change, and each retry
    // is given it.
    expect(run.outputs.asked).toBe(sha256(left(root, "asked/asked.json")));
    expect(workflow.jobs.draft.outputs?.asked).toBe("${{ steps.bring.outputs.asked }}");

    const byHand = scratch();
    const dispatched = join(byHand, "event.json");
    put(dispatched, `{"inputs": {"issue": "120"}}`);
    const started = rehearse(bring, {
      root: byHand,
      env: {
        ISSUE: "120",
        ATTEMPT: "1",
        PREVIOUS_RUN: "",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: dispatched,
      },
      answers: issueAnswers,
    });
    expect(started.failed, started.printed).toBe(false);
    expect(left(byHand, "build/issue.md")).toContain("Edited body");

    // The record of the issue as labelled is kept before Claude drafts.
    const all = steps(jobs.draft);
    const upload = all.findIndex(
      (each) => each.uses?.startsWith("actions/upload-artifact") && each.with?.name === "asked",
    );
    const claude = all.findIndex((each) => each.env !== undefined && "CLAUDE_CODE_OAUTH_TOKEN" in each.env);
    expect(upload).toBeGreaterThan(-1);
    expect(all[upload].with?.path).toBe("${{ runner.temp }}/asked");
    expect(upload, "the issue as labelled is kept after Claude drafts").toBeLessThan(claude);
  });

  // A retry drafts from the text the label approved, which it reads from the first try's record,
  // never from the issue as it reads now. The retry run that started it, and the first try's run,
  // are each checked before their records are trusted, and the record must have the digest the
  // first try's draft job gave, which each try passes on, since any job in the first try's run
  // could have replaced it.
  it.runIf(canRehearse)("drafts a retry from the text the label approved", () => {
    const bring = stepWithId(jobs.draft, "bring").run ?? "";
    const runsAnswers = (first: string) => `
  "api repos/owner/repo/actions/workflows/retry.yml"*) answer <<< '{"id": 11}' ;;
  "api repos/owner/repo/actions/workflows/build.yml"*) answer <<< '{"id": 22}' ;;
  "api repos/owner/repo/actions/runs/555") answer <<< '{"workflow_id": 11, "head_branch": "main", "event": "workflow_dispatch", "display_title": "Retry of issue 120, try 1", "created_at": "2026-10-27T12:00:00Z"}' ;;
  "api repos/owner/repo/actions/runs/300") answer <<< '${first}' ;;
  "run list "*) answer <<< '[
    {"databaseId": 302, "displayTitle": "Build of issue 120, try 2"},
    {"databaseId": 301, "displayTitle": "Build of issue 121, try 1"},
    {"databaseId": 300, "displayTitle": "Build of issue 120, try 1"},
    {"databaseId": 290, "displayTitle": "Build of issue 120, try 1"}]' ;;
  "run download 300 "*) mkdir -p "$download"; echo '{"issue": 120, "title": "Labelled title", "body": "Labelled body"}' > "$download/asked.json" ;;`;
    const labelled = '{"issue": 120, "title": "Labelled title", "body": "Labelled body"}\n';
    const firstTry = `{"workflow_id": 22, "head_branch": "main", "event": "issues", "display_title": "Build of issue 120, try 1"}`;
    const retrying = (first: string, asked = sha256(labelled)) => {
      const root = scratch();
      const event = join(root, "event.json");
      put(event, `{"inputs": {"issue": "120"}}`);
      const run = rehearse(bring, {
        root,
        env: {
          ISSUE: "120",
          ATTEMPT: "2",
          PREVIOUS_RUN: "555",
          ASKED: asked,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_EVENT_PATH: event,
        },
        answers: issueAnswers + runsAnswers(first),
      });
      return { root, run };
    };

    const { root, run } = retrying(firstTry);
    expect(run.failed, run.printed).toBe(false);
    const issue = left(root, "build/issue.md");
    for (const want of ["# #120: Labelled title", "Labelled body", "The owner says this"])
      expect(issue).toContain(want);
    expect(issue, "a retry drafts from the issue as it reads now").not.toContain("Edited");
    expect(run.calls, "the first try isn't looked for before the retry run").toContain(
      "2026-10-27T12:00:00Z",
    );
    expect(left(root, "asked/asked.json"), "the retry keeps the record as it was").toBe(labelled);
    expect(run.outputs.asked).toBe(sha256(labelled));

    for (const [name, asked] of [
      ["another digest", sha256("{}")],
      ["no digest", ""],
      ["a digest that isn't one", "main"],
    ]) {
      const swapped = retrying(firstTry, asked);
      expect(swapped.run.failed, `a retry trusts the first try's record with ${name}`).toBe(true);
      expect(left(swapped.root, "build/issue.md"), `a retry drafts from a record with ${name}`).toBe("");
    }

    for (const [name, first] of [
      ["from a branch", `{"workflow_id": 22, "head_branch": "a-branch", "event": "issues", "display_title": "Build of issue 120, try 1"}`],
      ["of another workflow", `{"workflow_id": 33, "head_branch": "main", "event": "issues", "display_title": "Build of issue 120, try 1"}`],
      ["started by a comment", `{"workflow_id": 22, "head_branch": "main", "event": "issue_comment", "display_title": "Build of issue 120, try 1"}`],
    ]) {
      const forged = retrying(first).run;
      expect(forged.failed, `a retry trusts a first try ${name}`).toBe(true);
      expect(forged.calls, `a retry reads the record of a first try ${name}`).not.toContain(
        "run download",
      );
    }
  });

  // The retry run that started this try wrote why the last one failed: the failing check's
  // output, CI's failed log or what the reviews found. Claude reads it only from retry.yml's run
  // from main for this issue's last try.
  it.runIf(canRehearse)("tells Claude why the last try failed, from the retry run that started it", () => {
    const why = stepWithId(jobs.draft, "why").run ?? "";
    const answers = (run: string) => `
  "api repos/owner/repo/actions/workflows/retry.yml"*) answer <<< '{"id": 11}' ;;
  "api repos/owner/repo/actions/runs/555") answer <<< '${run}' ;;
  "run download 555 "*) mkdir -p "$download"; printf 'The reviews found 1 Important finding.\\n\\nA private workflow leaks.\\n' > "$download/failed.md" ;;`;
    const env = { ISSUE: "120", ATTEMPT: "2", PREVIOUS_RUN: "555" };

    const root = scratch();
    put(join(root, "runner/build/issue.md"), "# #120: Labelled title\n");
    const run = rehearse(why, {
      root,
      env,
      answers: answers(`{"workflow_id": 11, "head_branch": "main", "display_title": "Retry of issue 120, try 1"}`),
    });
    expect(run.failed, run.printed).toBe(false);
    const issue = left(root, "build/issue.md");
    expect(issue).toContain("## The last try failed (attempt 1 of 3)");
    expect(issue).toContain("A private workflow leaks.");

    const other = scratch();
    put(join(other, "runner/build/issue.md"), "# #120: Labelled title\n");
    const forged = rehearse(why, {
      root: other,
      env,
      answers: answers(`{"workflow_id": 11, "head_branch": "main", "display_title": "Retry of issue 121, try 1"}`),
    });
    expect(forged.failed, forged.printed).toBe(false);
    expect(forged.calls).not.toContain("run download");
    expect(left(other, "build/issue.md")).toContain("Why the last try failed was not recorded.");
  });

  // The draft keeps its patch, message, description and pages in a folder of their own, refuses
  // any that carry what looks like the login token, since the artifact is public, and gives the
  // folder's digest as the job's output, which no other job can change. Packages' integrity hashes,
  // as package-lock.json names them, are long enough to look like a token, so they're left out of
  // the check.
  it.runIf(canRehearse)("keeps the draft's change, checked for the login token, with its digest", () => {
    const pack = stepWithId(jobs.draft, "pack").run ?? "";
    const packing = (files: Record<string, string>) => {
      const root = scratch();
      for (const [file, text] of Object.entries(files)) put(join(root, "runner/build", file), text);
      put(join(root, "runner/build/issue.md"), "# #120: The issue\n");
      return { root, run: rehearse(pack, { root }) };
    };
    const integrity = `sha512-${"A".repeat(86)}==`;

    const kept = packing({
      "change.patch": `diff --git a/package-lock.json b/package-lock.json\n+      "integrity": "${integrity}"\n`,
      "message.md": "Add a line\n",
      "pull-request.md": "Adds a line.\n",
      "pictures.json": '[{"path": "/acme/dinners"}]\n',
    });
    expect(kept.run.failed, kept.run.printed).toBe(false);
    expect(readdirSync(join(kept.root, "runner/change")).sort()).toEqual([
      "change.patch",
      "message.md",
      "pictures.json",
      "pull-request.md",
    ]);
    expect(kept.run.outputs.digest).toBe(digestOf(join(kept.root, "runner/change")));
    expect(workflow.jobs.draft.outputs?.digest).toBe("${{ steps.pack.outputs.digest }}");
    const upload = steps(jobs.draft).find(
      (each) => each.uses?.startsWith("actions/upload-artifact") && each.with?.name === "change",
    );
    expect(upload?.with?.path).toBe("${{ runner.temp }}/change");

    const token = `sk-ant-oat01-${"Ab3_".repeat(20)}`;
    for (const [file, text] of [
      ["change.patch", `+const leak = "${token}";\n`],
      ["message.md", `Add a line\n\n${"Zq9-".repeat(25)}\n`],
      ["pull-request.md", `It is ${token}.\n`],
    ]) {
      const carried = packing({ "change.patch": "diff --git a/a b/a\n", "message.md": "Add\n", [file]: text });
      expect(carried.run.failed, `the draft kept a ${file} that carries the token`).toBe(true);
      expect(carried.run.printed).not.toContain("Ab3_Ab3_");
      expect(carried.run.outputs.digest).toBeUndefined();
    }
  });

  // The drafting session no longer asks for review itself: the reviews and the build rule decide.
  // It asks on the issue rather than guess a choice a reader would see (chrismdp/awml#127), fixes
  // what the reviews found, and makes a page show a change no seeded page shows, so a reviewer sees
  // it pictured (chrismdp/awml#141).
  it("tells Claude to ask rather than guess, to fix what the reviews found, and to picture its change", () => {
    const prompt = readFileSync(join(__dirname, "../.github/build-prompt.md"), "utf8");
    for (const want of [
      "REVIEW.md",
      "fix each Important finding",
      "always fine to escalate",
      "which you'd recommend",
      "scripts/seed-pictures.ts",
      "pictures.json",
      "not only read the test",
    ])
      expect(prompt).toContain(want);
    expect(prompt, "Claude still asks for review itself").not.toContain("review.md");
    const pack = stepWithId(jobs.draft, "pack").run ?? "";
    expect(pack).toContain("pictures.json");
    expect(pack).not.toContain("review.md");
  });

  // The bug and security reviews start together, each its own claude run, in a job that only
  // reads, once the checks pass and the pictures job has ended however it ended, and the classifier
  // runs after their findings are weighed. The prompts and REVIEW.md come from main, kept before
  // the patch is applied.
  it("reviews the checked change side by side, then classifies it", () => {
    const review = jobs.review;
    expect(needs(review)).toEqual(["draft", "check", "pictures"]);
    expect(review.if).toBe("${{ !cancelled() && needs.check.result == 'success' }}");
    const all = steps(review);
    const together = all.findIndex(
      (each) =>
        /review-bugs-prompt\.md .*&\n/.test(each.run ?? "") &&
        /review-security-prompt\.md .*&\n/.test(each.run ?? ""),
    );
    const classify = all.findIndex(
      (each) => /\bclaude -p\b/.test(each.run ?? "") && (each.run ?? "").includes("classify-prompt.md"),
    );
    expect(together, "no one step starts both reviews").toBeGreaterThan(-1);
    expect(all[together].run).toContain("wait");
    expect(classify, "the classifier doesn't run after the reviews").toBeGreaterThan(together);
    const apply = stepWithId(review, "apply").run ?? "";
    const applied = apply.indexOf("git apply --index");
    for (const kept of [
      "cp .github/review-bugs-prompt.md .github/review-security-prompt.md .github/classify-prompt.md",
      "cp REVIEW.md",
    ]) {
      expect(apply).toContain(kept);
      expect(apply.indexOf(kept), `${kept} after the patch is applied`).toBeLessThan(applied);
    }
    expect(
      steps(review)
        .filter((each) => each.uses?.startsWith(`actions/${CLONE}`))
        .map((each) => each.with?.ref),
    ).toEqual(["${{ github.sha }}"]);
  });

  // A patch that adds or changes Claude Code's own settings, servers or instructions, anywhere in the
  // tree, is refused before any review session starts. The review's record says why, without the
  // patch's paths, which reach the issue through retry-a-build, and the record is kept even though
  // the job fails, so retry-a-build can read why. Any other patch is applied, staged.
  it.runIf(canRehearse)("refuses a patch to Claude Code's own files before the build's reviews start", () => {
    const apply = stepWithId(jobs.review, "apply").run ?? "";
    expect(
      steps(jobs.review).some(
        (each) =>
          each.uses?.startsWith("actions/upload-artifact") &&
          each.with?.name === "review" &&
          each.if === "${{ always() }}",
      ),
      "the review job doesn't keep its record when it fails",
    ).toBe(true);
    for (const path of [
      "",
      ".claude/settings.json",
      ".mcp.json",
      "CLAUDE.md",
      "docs/CLAUDE.local.md",
      "src/app/.claude/agents/helper.md",
      "docs/CLAUDE.md",
    ]) {
      const root = scratch();
      const repo = join(root, "repo");
      for (const [file, text] of Object.entries({
        ".github/review-bugs-prompt.md": "Review for bugs.\n",
        ".github/review-security-prompt.md": "Review for security.\n",
        ".github/classify-prompt.md": "Sort by risk.\n",
        "REVIEW.md": "What failure looks like.\n",
        "README.md": "A registry\n",
      }))
        put(join(repo, file), text);
      git(repo, "init", "-q");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "The registry's main");
      put(join(repo, "README.md"), "A registry\nOf workflows\n");
      if (path) put(join(repo, path), `{"env": {"ANTHROPIC_BASE_URL": "https://example.com"}}\n`);
      git(repo, "add", "-A");
      put(join(root, "runner/change/change.patch"), `${git(repo, "diff", "--cached", "--binary")}\n`);
      put(join(root, "runner/change/message.md"), "Add a line\n");
      git(repo, "reset", "-q", "--hard");
      put(join(root, "runner/record/result.txt"), "The reviews did not finish.\n");
      put(join(root, "runner/review/.kept"), "");
      const drafted = digestOf(join(root, "runner/change"));
      const run = rehearse(apply, { root, cwd: repo, env: { ATTEMPT: "1", CHANGE_DIGEST: drafted } });
      if (!path) {
        expect(run.failed, run.printed).toBe(false);
        expect(git(repo, "diff", "--cached", "--name-only")).toBe("README.md");
        expect(left(root, "review/REVIEW.md")).toBe("What failure looks like.\n");
        expect(left(root, "review/message.md")).toBe("Add a line\n");
        expect(left(root, "classify-prompt.md")).toBe("Sort by risk.\n");

        // A change another job put in place of the draft's isn't reviewed.
        git(repo, "reset", "-q", "--hard");
        put(join(root, "runner/change/message.md"), "Add a line, and something else\n");
        const swapped = rehearse(apply, { root, cwd: repo, env: { ATTEMPT: "1", CHANGE_DIGEST: drafted } });
        expect(swapped.failed, "a change that isn't the draft's was reviewed").toBe(true);
        expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
        expect(left(root, "record/result.txt")).toContain("isn't the one the draft made");
        continue;
      }
      expect(run.failed, `a patch to ${path} reached the reviews`).toBe(true);
      expect(run.printed, `the refusal doesn't name ${path} in the log`).toContain(path);
      const reason = left(root, "record/result.txt");
      expect(reason).toContain("Claude Code's own");
      if (path.includes("/")) expect(reason, "the record names the patch's path").not.toContain(path);
    }
  });

  // Each review's file must be a list of findings, each ranked. They're kept together, each saying
  // which review found it. An Important finding before the third try sends the change to retry.yml;
  // otherwise the classifier runs and the pull request opens. The findings reach the issue and the
  // pull request, so any that carry what looks like the login token are refused, as review.yml
  // refuses them. The findings go to the classifier among its inputs, which it can't change.
  it.runIf(canRehearse)("weighs the reviews' findings", () => {
    const weigh = stepWithId(jobs.review, "weigh").run ?? "";
    const weighing = (attempt: string, bugs: string, security = "[]") => {
      const root = scratch();
      put(join(root, "runner/sessions/bugs/out/bugs.json"), bugs);
      put(join(root, "runner/sessions/security/out/security.json"), security);
      put(join(root, "runner/record/result.txt"), "The reviews did not finish.\n");
      put(join(root, "runner/review/REVIEW.md"), "What failure looks like.\n");
      chmodSync(join(root, "runner/review"), 0o555);
      return { root, run: rehearse(weigh, { root, env: { ATTEMPT: attempt } }) };
    };
    const important = `[{"severity": "Important", "file": "src/server/viewer.ts", "line": 4, "title": "A private workflow leaks", "detail": "A stranger sees its title."}]`;

    const sent = weighing("1", important);
    expect(sent.run.failed, sent.run.printed).toBe(false);
    expect(sent.run.outputs.opens).toBe("false");
    expect(left(sent.root, "record/result.txt")).toBe("The reviews found 1 Important finding.\n");
    expect(JSON.parse(left(sent.root, "record/findings.json"))).toEqual([
      {
        review: "bug",
        severity: "Important",
        file: "src/server/viewer.ts",
        line: 4,
        title: "A private workflow leaks",
        detail: "A stranger sees its title.",
      },
    ]);

    const last = weighing("3", important);
    expect(last.run.failed, last.run.printed).toBe(false);
    expect(last.run.outputs.opens, "the third try doesn't open with its finding").toBe("true");
    expect(left(last.root, "review/findings.json"), "the classifier can't read the findings").toContain(
      "A private workflow leaks",
    );
    for (const path of ["review", "review/findings.json"])
      expect(statSync(join(last.root, "runner", path)).mode & 0o222, `${path} can be changed`).toBe(0);

    const minor = weighing(
      "1",
      `[{"severity": "Nit", "file": "a.ts", "line": 1, "title": "A name", "detail": "A detail."}]`,
      `[{"severity": "Pre-existing", "file": "b.ts", "line": 0, "title": "Old", "detail": "It was there."}]`,
    );
    expect(minor.run.outputs.opens).toBe("true");
    expect(
      (JSON.parse(left(minor.root, "record/findings.json")) as { review: string }[]).map(
        (each) => each.review,
      ),
    ).toEqual(["bug", "security"]);

    const broken = weighing("1", "[]", `{"not": "a list"}`);
    expect(broken.run.failed).toBe(true);
    expect(left(broken.root, "record/result.txt")).toContain(
      "The security review left no readable record of its findings.",
    );

    const token = `sk-ant-oat01-${"Ab3_".repeat(20)}`;
    for (const finding of [
      `{"severity": "Nit", "file": "a.ts", "line": 1, "title": "A name", "detail": "It is ${token}."}`,
      `{"severity": "Nit", "file": "a.ts", "line": 1, "title": "${"Zq9-".repeat(25)}", "detail": "A detail."}`,
    ]) {
      const carried = weighing("3", `[${finding}]`);
      expect(carried.run.failed, `the findings kept ${finding}`).toBe(true);
      expect(carried.run.printed).not.toContain(token);
      expect(left(carried.root, "record/findings.json")).not.toContain("Ab3_Ab3_");
      expect(left(carried.root, "record/findings.json")).not.toContain("Zq9-Zq9-");
      expect(left(carried.root, "record/result.txt")).toContain("login token");
    }
  });

  // The classifier must leave a verdict with between one and five reasons, which the record keeps.
  // Its reasons reach the pull request, so any that carry what looks like the login token are
  // refused.
  it.runIf(canRehearse)("reads the classifier's verdict", () => {
    const verdict = stepWithId(jobs.review, "verdict").run ?? "";
    const reading = (classification: string) => {
      const root = scratch();
      put(join(root, "runner/sessions/classify/out/classification.json"), classification);
      put(join(root, "runner/record/result.txt"), "The classifier did not finish.\n");
      return { root, run: rehearse(verdict, { root }) };
    };
    const read = reading(
      `{"needs_review": true, "reasons": ["One", "Two", "Three", "Four", "Five", "Six"], "extra": 1}`,
    );
    expect(read.run.failed, read.run.printed).toBe(false);
    expect(left(read.root, "record/result.txt")).toBe("pass\n");
    expect(JSON.parse(left(read.root, "record/classification.json"))).toEqual({
      needs_review: true,
      reasons: ["One", "Two", "Three", "Four", "Five"],
    });
    for (const unread of [
      `{"needs_review": "yes", "reasons": ["One"]}`,
      `{"needs_review": false, "reasons": []}`,
      `{"needs_review": false}`,
      `{"needs_review": false, "reasons": ["It holds sk-ant-oat01-${"Ab3_".repeat(20)}"]}`,
    ]) {
      const wrong = reading(unread);
      expect(wrong.run.failed, `the classifier's ${unread} was read`).toBe(true);
      expect(left(wrong.root, "record/result.txt")).not.toBe("pass\n");
      expect(left(wrong.root, "record/classification.json")).toBe("");
    }
  });

  // Any job's runtime token can replace the artifacts of its run, so a job that runs the change's
  // code must have ended before a job that makes or reads a trusted record starts. The pages are
  // pictured once the checks pass, and the reviews start once the pictures job has ended.
  it("lets no job that runs the change's code live alongside a trusted record", () => {
    expect(needs(jobs.pictures)).toEqual(["draft", "check"]);
    expect(jobs.pictures.if).toContain("needs.check.result == 'success'");
    expect(needs(jobs.open)).toEqual(["draft", "check", "review", "pictures"]);
    for (const want of [
      "needs.check.result == 'success'",
      "needs.review.result == 'success'",
      "needs.review.outputs.opens == 'true'",
    ])
      expect(jobs.open.if).toContain(want);
    expect(jobs.open.if, "open runs even when the run was cancelled").toMatch(/^\$\{\{ !cancelled\(\) && /);
    expect(jobs.open.if).not.toContain("always()");

    const after = (name: string): Set<string> => {
      const all = new Set<string>();
      for (const each of needs(jobs[name])) {
        all.add(each);
        for (const earlier of after(each)) all.add(earlier);
      }
      return all;
    };
    const runsTheChange = Object.keys(jobs).filter((name) =>
      steps(jobs[name]).some((each) =>
        /\bclaude -p\b|\bnpm (ci|install|run|test)\b|\bnpx\b|picture-pages\.sh/.test(each.run ?? ""),
      ),
    );
    expect(runsTheChange.sort()).toEqual(["check", "draft", "pictures", "review"]);
    for (const trusted of ["review", "open"])
      for (const untrusted of ["draft", "check", "pictures"])
        expect(after(trusted).has(untrusted), `${trusted} can run alongside ${untrusted}`).toBe(true);
  });

  // The review job gives its record's digest as its output, taken once the record is written.
  it.runIf(canRehearse)("gives the review record's digest as the job's output", () => {
    const all = steps(jobs.review);
    const at = all.findIndex((each) => each.id === "digest");
    const upload = all.findIndex(
      (each) => each.uses?.startsWith("actions/upload-artifact") && each.with?.name === "review",
    );
    expect(at, "the digest is taken after the record is uploaded").toBeLessThan(upload);
    expect(at).toBeGreaterThan(all.findIndex((each) => each.id === "verdict"));
    expect(jobs.review.outputs?.digest).toBe("${{ steps.digest.outputs.digest }}");
    const root = scratch();
    put(join(root, "runner/record/result.txt"), "pass\n");
    put(join(root, "runner/record/findings.json"), "[]\n");
    put(join(root, "runner/record/classification.json"), '{"needs_review": false, "reasons": ["Small."]}\n');
    const run = rehearse(all[at].run ?? "", { root });
    expect(run.failed, run.printed).toBe(false);
    expect(run.outputs.digest).toBe(digestOf(join(root, "runner/record")));
  });

  // Every job takes an artifact's digest the same way.
  it("takes each artifact's digest the same way everywhere", () => {
    const takers: string[] = [];
    for (const file of ["build.yml", "land.yml"])
      for (const [name, job] of Object.entries(readJobs(file)))
        for (const each of steps(job))
          if ((each.run ?? "").includes("digest() {")) {
            takers.push(`${file} ${name} ${each.id}`);
            expect(each.run, `${file}'s ${name} step "${each.name}"`).toContain(digestLine);
          }
    expect(takers.sort()).toEqual([
      "build.yml draft pack",
      "build.yml open record",
      "build.yml open verify",
      "build.yml review apply",
      "build.yml review digest",
      "land.yml find find",
      "land.yml find judge",
    ]);
  });

  // The open job uses the change and the review record only if each is what the draft job and the
  // review job gave as their digests, so nothing that ran the change's code could have put another
  // in its place.
  it.runIf(canRehearse)("opens only the change the draft made and the reviews read", () => {
    const all = steps(jobs.open);
    const verify = all.findIndex((each) => each.id === "verify");
    const downloads = all
      .map((each, index) => ({ each, index }))
      .filter(({ each }) => each.uses?.startsWith("actions/download-artifact") && each.with?.name !== "pictures");
    for (const { index } of downloads) expect(index).toBeLessThan(verify);
    // The pictures come from a job that ran the change's code, so they're checked on their own.
    for (const after of all.slice(verify + 1))
      if (after.with?.name !== "pictures") expect(after.uses ?? "").not.toMatch(/download-artifact/);
    expect(verify, "open reads the check's result before it checks the digests").toBeLessThan(
      all.findIndex((each) => each.name === "Read the check result"),
    );
    expect(all[verify].env).toEqual({
      CHANGE_DIGEST: "${{ needs.draft.outputs.digest }}",
      REVIEW_DIGEST: "${{ needs.review.outputs.digest }}",
    });
    const verifying = (swap: (root: string) => void) => {
      const root = scratch();
      put(join(root, "runner/change/change.patch"), "diff --git a/a b/a\n");
      put(join(root, "runner/change/message.md"), "Add a line\n");
      put(join(root, "runner/review/findings.json"), "[]\n");
      put(join(root, "runner/review/classification.json"), '{"needs_review": false, "reasons": ["Small."]}\n');
      const env = {
        CHANGE_DIGEST: digestOf(join(root, "runner/change")),
        REVIEW_DIGEST: digestOf(join(root, "runner/review")),
      };
      swap(root);
      return rehearse(all[verify].run ?? "", { root, env });
    };
    const kept = verifying(() => {});
    expect(kept.failed, kept.printed).toBe(false);
    for (const [name, swap] of [
      ["another patch", (root: string) => put(join(root, "runner/change/change.patch"), "diff --git a/b b/b\n")],
      ["an added file", (root: string) => put(join(root, "runner/change/pictures.json"), "[]\n")],
      ["findings left out", (root: string) => put(join(root, "runner/review/findings.json"), "[]")],
      ["no verdict", (root: string) => rmSync(join(root, "runner/review/classification.json"))],
    ] as const) {
      const swapped = verifying(swap);
      expect(swapped.failed, `open used ${name}`).toBe(true);
    }
  });

  // The open job pushes onto main as it is when it pushes, not the main the build started from, so
  // a workflow that changed on main meanwhile isn't pushed back as part of the change
  // (chrismdp/awml#115).
  it("opens the pull request on main as it is now", () => {
    expect(
      steps(jobs.open)
        .filter((each) => each.uses?.startsWith(`actions/${CLONE}`))
        .map((each) => each.with?.ref),
    ).toEqual(["main"]);
  });

  // Once Claude's patch is applied in the open job, the workspace holds the change's code, and later
  // steps hold the app's token. So no step after the patch runs anything from the workspace: a
  // script it needs is copied from main before the patch.
  it("runs nothing from the change once it's applied", () => {
    const all = steps(jobs.open);
    const applied = all.findIndex((each) => each.id === "commit");
    expect(applied, "open has no step that applies the change").toBeGreaterThan(-1);
    expect(all[applied].run).toContain("cp .github/pull-request-body.sh");
    expect(
      (all[applied].run ?? "").indexOf("cp .github/pull-request-body.sh"),
      "main's description script is copied after the patch",
    ).toBeLessThan((all[applied].run ?? "").indexOf("git apply"));
    for (const each of all.slice(applied + 1)) {
      const where = `open's step "${each.name ?? each.uses}"`;
      if (each.uses) expect(each.uses, where).toMatch(/^actions\//);
      for (const from of [".github/", "scripts/", "npm ", "npx ", "node ", "bash ", "source "])
        expect(each.run ?? "", `${where} runs ${from} from the workspace`).not.toContain(from);
    }
    expect(
      all.map((each) => each.uses ?? "").filter((uses) => uses.startsWith("actions/setup-")),
      "open sets up a toolchain, which it has no need of",
    ).toEqual([]);
  });

  // If the patch no longer applies to main as it is now, the job says so in its own record and
  // stops without failing, and the retry job sends the build to retry.yml.
  it.runIf(canRehearse)("applies the change to main as it is now, or says it no longer applies", () => {
    const commit = stepWithId(jobs.open, "commit").run ?? "";
    const opening = (file: string, main: string) => {
      const root = scratch();
      const repo = join(root, "repo");
      put(join(repo, ".github/pull-request-body.sh"), "#!/bin/bash\necho main's description\n");
      put(join(repo, "README.md"), "A registry\n");
      git(repo, "init", "-q");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "The registry's main");
      put(join(repo, "README.md"), "A registry\nOf workflows\n");
      put(join(root, "runner/change/change.patch"), `${git(repo, "diff", "--binary")}\n`);
      git(repo, CLONE, "-q", "--", "README.md");
      put(join(repo, file), main);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "Main moves on");
      return { root, repo, run: rehearse(commit, { root, cwd: repo, env: { ISSUE: "125" } }) };
    };

    const applies = opening("NOTES.md", "Notes\n");
    expect(applies.run.failed, applies.run.printed).toBe(false);
    expect(applies.run.outputs).toEqual({ applies: "true", branch: "build/issue-125" });
    expect(git(applies.repo, "diff", "--cached", "--name-only")).toBe("README.md");
    expect(left(applies.root, "pull-request-body.sh")).toContain("main's description");

    const moved = opening("README.md", "A different registry\n");
    expect(moved.run.failed, moved.run.printed).toBe(false);
    expect(moved.run.outputs.applies).toBe("false");
    expect(left(moved.root, "open/result.txt")).toBe(
      "The change no longer applies to main as it is now.\n",
    );
    expect(left(moved.root, "open/output.txt")).not.toBe("");
    expect(
      steps(jobs.open).some(
        (each) =>
          each.uses?.startsWith("actions/upload-artifact") &&
          each.with?.name === "open" &&
          each.if === "steps.commit.outputs.applies == 'false'",
      ),
      "the open job doesn't keep its record when the change no longer applies",
    ).toBe(true);
  });

  // land.yml reads what it needs from the build's record: the commit it pushes, the commit of main
  // it applied the patch to, the commit of main the checks ran on, the try, who to ask, the app's
  // bot, the digest of the issue as labelled, which a retry needs, and the pictures. The record's own
  // digest goes into the description, which only the app and the repository's people can edit.
  it.runIf(canRehearse)("keeps the build's record for land-a-pull-request", () => {
    const record = stepWithId(jobs.open, "record").run ?? "";
    const root = scratch();
    const repo = join(root, "repo");
    put(join(repo, "README.md"), "A registry\n");
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "The registry's main");
    const base = git(repo, "rev-parse", "HEAD");
    put(join(repo, "README.md"), "A registry\nOf workflows\n");
    git(repo, "commit", "-q", "-am", "Add a line");
    const commit = git(repo, "rev-parse", "HEAD");
    put(join(root, "runner/pictures.txt"), "/acme/dinners|visitor|desktop|a.png|b.png\n");
    put(join(root, "runner/pictures-left-out.txt"), "");
    put(join(root, "runner/change/message.md"), "Add a line\n\nWhy.\n");
    const checked = "ef".repeat(20);
    const asked = "aa".repeat(32);
    const recording = (env: Record<string, string>) =>
      rehearse(record, {
        root,
        cwd: repo,
        env: {
          APP_SLUG: "awml-factory",
          ISSUE: "125",
          ATTEMPT: "2",
          REQUESTED_BY: "the-owner",
          GITHUB_SHA: checked,
          ASKED_DIGEST: asked,
          ...env,
        },
      });
    const run = recording({});
    expect(run.failed, run.printed).toBe(false);
    expect(JSON.parse(left(root, "pull-request/build.json"))).toEqual({
      issue: 125,
      attempt: 2,
      requested_by: "the-owner",
      commit,
      base,
      checked,
      asked,
      bot: "awml-factory[bot]",
    });
    expect(left(root, "pull-request/pictures.txt")).toBe("/acme/dinners|visitor|desktop|a.png|b.png\n");
    expect(left(root, "pull-request/title.txt")).toBe("Add a line\n");
    expect(run.outputs.digest).toBe(digestOf(join(root, "runner/pull-request")));
    expect(stepWithId(jobs.open, "record").env?.ASKED_DIGEST).toBe("${{ needs.draft.outputs.asked }}");
    expect(recording({ ASKED_DIGEST: "" }).failed, "the record kept no digest of the issue").toBe(true);
  });

  // A new try's commit hasn't been judged, so a merge an earlier try set on the branch's open pull
  // request is turned off before the push, and again after it, in case land.yml set one for the
  // earlier commit while this one was being pushed.
  it.runIf(canRehearse)("turns off a merge an earlier try set, before and after it pushes", () => {
    const push = stepWithId(jobs.open, "push").run ?? "";
    const root = scratch();
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    git(root, "init", "-q", "--bare", origin);
    put(join(repo, "README.md"), "A registry\n");
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "Build #125");
    git(repo, "remote", "add", "origin", origin);
    const run = rehearse(push, {
      root,
      cwd: repo,
      env: { BRANCH: "build/issue-125", ORIGIN: origin, ORDER: join(root, "order") },
      answers: `
  "api repos/owner/repo/pulls?head=owner:build/issue-125&base=main&state=open"*) answer <<< '[{"number": 131, "auto_merge": {"merge_method": "squash"}}]' ;;
  "pr merge 131 --repo owner/repo --disable-auto")
    if git --git-dir="$ORIGIN" rev-parse -q --verify refs/heads/build/issue-125 > /dev/null; then
      echo after >> "$ORDER"
    else
      echo before >> "$ORDER"
    fi ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(git(origin, "rev-parse", "refs/heads/build/issue-125")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(readIfThere(join(root, "order")), "the merge isn't turned off both before and after the push").toBe(
      "before\nafter\n",
    );
  });

  // A closed pull request is never updated. gh pr view finds a branch's closed or merged pull
  // request when it has no open one, so the build asks GitHub for the branch's open pull requests,
  // updates the one it finds, and otherwise opens a new one (chrismdp/awml#125).
  it.runIf(canRehearse)("never updates a closed pull request", () => {
    const pull = stepWithId(jobs.open, "pull").run ?? "";
    expect(
      readFileSync(join(__dirname, "../.github/workflows/build.yml"), "utf8"),
      "build.yml asks gh pr view for the branch's pull request, which may be closed",
    ).not.toContain('gh pr view "$BRANCH"');
    const answers = (open: string) => `
  "pr view build/issue-125"*) echo '{"number": 119, "state": "MERGED"}' ;;
  "api repos/owner/repo/pulls?"*"state=open"*) answer <<< '${open}' ;;
  "pr create "*) echo "https://github.com/owner/repo/pull/140" ;;
  "pr edit "*) : ;;`;
    const opening = (open: string) => {
      const root = scratch();
      put(join(root, "runner/pull-request/title.txt"), "Close the pull request a rebuild replaces\n");
      put(join(root, "runner/pull-request.md"), "The description\n");
      return rehearse(pull, { root, env: { BRANCH: "build/issue-125" }, answers: answers(open) });
    };

    const closed = opening("[]");
    expect(closed.failed, closed.printed).toBe(false);
    expect(closed.calls).not.toContain("pr edit");
    expect(closed.calls).toContain("pr create");
    expect(closed.outputs).toEqual({ number: "140", opened: "true" });

    const open = opening(`[{"number": 131, "state": "open"}]`);
    expect(open.failed, open.printed).toBe(false);
    expect(open.calls).not.toContain("pr create");
    expect(open.calls).toContain("pr edit 131 ");
    expect(open.outputs).toEqual({ number: "131", opened: "false" });
  });

  // Once the build opens a new pull request, a separate step closes every earlier one the app opened
  // for the issue that didn't merge, with a comment naming the new one, which it says once. It never
  // touches a pull request someone else opened, or one that merged.
  it.runIf(canRehearse)("closes only its own earlier pull requests for the issue", () => {
    const all = steps(jobs.open);
    const retireAt = all.findIndex((each) => each.id === "retire");
    const retire = all[retireAt];
    expect(retireAt).toBeGreaterThan(all.findIndex((each) => each.id === "pull"));
    expect(squash(retire.if).replace(/ /g, "")).toBe("steps.pull.outputs.opened=='true'");
    expect(retire.env?.GH_TOKEN).toBe("${{ steps.app.outputs.token }}");
    const run = rehearse(retire.run ?? "", {
      root: scratch(),
      env: { APP_SLUG: "awml-factory", BRANCH: "build/issue-125", ISSUE: "125", PR_NUMBER: "140" },
      answers: `
  "api --paginate repos/owner/repo/pulls?"*"state=all"*) answer <<< '[
    {"number": 140, "state": "open", "merged_at": null, "user": {"login": "awml-factory[bot]"}},
    {"number": 131, "state": "closed", "merged_at": null, "user": {"login": "awml-factory[bot]"}},
    {"number": 127, "state": "closed", "merged_at": null, "user": {"login": "a-maintainer"}},
    {"number": 126, "state": "open", "merged_at": null, "user": {"login": "awml-factory[bot]"}},
    {"number": 122, "state": "closed", "merged_at": "2026-10-01T00:00:00Z", "user": {"login": "awml-factory[bot]"}},
    {"number": 119, "state": "closed", "merged_at": null, "user": {"login": "awml-factory[bot]"}},
    {"number": 118, "state": "closed", "merged_at": null, "user": {"login": "another-app[bot]"}}]' ;;
  "api --paginate repos/owner/repo/issues/119/comments"*) answer <<< '[{"user": {"login": "awml-factory[bot]"}, "body": "<!-- factory-replaced -->\\nReplaced by #131."}]' ;;
  "api --paginate repos/owner/repo/issues/"*"/comments"*) answer <<< '[{"user": {"login": "a-maintainer"}, "body": "<!-- factory-replaced --> said by a person"}]' ;;
  "pr comment "*|"pr close "*) : ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    for (const want of ["pr comment 131 ", "pr comment 126 ", "pr close 126 "]) expect(run.calls).toContain(want);
    for (const number of ["140", "127", "122", "119", "118"]) {
      expect(run.calls).not.toContain(`pr comment ${number} `);
      expect(run.calls).not.toContain(`pr close ${number} `);
    }
    expect(run.calls, "the build closed #131 again").not.toContain("pr close 131 ");
    expect(run.calls, "the comment doesn't name the new pull request").toContain("#140");
  });

  // The app's token goes only to the steps that push the branch and the pictures, open or update
  // the pull request, and close the build's earlier ones.
  it("gives the app's token only to the steps that push, open and close", () => {
    expect(
      steps(jobs.open)
        .filter((each) => each.env?.GH_TOKEN === "${{ steps.app.outputs.token }}")
        .map((each) => each.id),
    ).toEqual(["push", "media", "pull", "retire"]);
    for (const [name, job] of Object.entries(jobs))
      if (name !== "open")
        expect(JSON.stringify(job), `${name} holds the app's token`).not.toMatch(/FACTORY_APP|steps\.app\./);
  });

  // A failed try, from the build or from CI, only starts retry.yml, and only retry.yml starts the
  // build again or says on the issue that it failed.
  it("leaves trying again to retry.yml", () => {
    const retry = jobs.retry;
    expect(runs(retry)).toContain("gh workflow run retry.yml");
    expect(runs(readJobs("land.yml").land)).toContain("gh workflow run retry.yml");
    for (const file of ["build.yml", "land.yml"]) {
      const text = readFileSync(join(__dirname, "../.github/workflows", file), "utf8");
      for (const only of ["gh workflow run build.yml", "The build failed three times"])
        expect(text, `${file} has "${only}", which belongs to retry.yml alone`).not.toContain(only);
    }
    const again = runs(readJobs("retry.yml").retry);
    for (const want of ["gh workflow run build.yml", "The build failed three times"]) expect(again).toContain(want);
    const dispatch = readWorkflow("retry.yml").on?.workflow_dispatch as { inputs?: Record<string, unknown> };
    expect(Object.keys(dispatch?.inputs ?? {})).toEqual(["issue", "attempt", "requested_by", "run", "asked"]);
    const build = readWorkflow("build.yml").on?.workflow_dispatch as { inputs?: Record<string, unknown> };
    expect(Object.keys(build?.inputs ?? {})).toEqual(["issue", "attempt", "previous_run", "requested_by", "asked"]);
  });

  // The open job ran, so this try reached the end, unless its patch no longer applied. If it failed
  // after that, it said so itself. Otherwise this run goes to retry.yml, which reads why from it,
  // with the digest of the issue as labelled, which the next try checks.
  it.runIf(canRehearse)("starts retry-a-build when the try didn't open its pull request", () => {
    const retry = stepWithId(jobs.retry, "retry");
    expect(retry.env?.ASKED_DIGEST).toBe("${{ needs.draft.outputs.asked }}");
    const asked = "aa".repeat(32);
    const env = { ISSUE: "125", ATTEMPT: "2", REQUESTED_BY: "the-owner", ASKED_DIGEST: asked };
    const answers = `  "workflow run retry.yml "*) : ;;`;
    for (const [open, applies, starts] of [
      ["skipped", "", true],
      ["success", "false", true],
      ["success", "true", false],
      ["failure", "", false],
    ] as const) {
      const run = rehearse(retry.run ?? "", { root: scratch(), env: { ...env, OPEN: open, APPLIES: applies }, answers });
      expect(run.failed, run.printed).toBe(false);
      if (starts)
        expect(run.calls.trim()).toBe(
          `workflow run retry.yml --repo owner/repo --ref main -f issue=125 -f attempt=2 -f requested_by=the-owner -f run=1000 -f asked=${asked}`,
        );
      else expect(run.calls, `open ${open}, applies ${applies}`).toBe("");
    }
  });
});

describe("resolve.yml", () => {
  const jobs = readJobs("resolve.yml");
  const marker = "<!-- factory-resolve-status -->";

  // As soon as the run knows which pull requests clash with main, each one gets a new comment saying
  // so, from a job that may write to pull requests but checks out and runs nothing.
  it("posts a status comment on each pull request it redoes", () => {
    const start = jobs.start;
    expect(start, "resolve.yml has no start job").toBeDefined();
    expect(needs(start)).toEqual(["find"]);
    expect(String(start.strategy?.matrix?.pull)).toContain(
      "needs.find.outputs.pulls",
    );
    expect(writes(start)).toEqual(["pull-requests"]);
    expect(
      steps(start)
        .map((each) => each.uses)
        .filter(Boolean),
    ).toEqual([]);
    expect(
      steps(start).every((each) => each["continue-on-error"] === true),
    ).toBe(true);
    const script = runs(start);
    expect(script).toContain(marker);
    expect(script).not.toContain("<!-- factory-status -->");
    expect(script).toContain("actions/runs/$GITHUB_RUN_ID");
    expect(script).toContain("gh pr comment");
    expect(
      script,
      "start should post a new comment, never edit an old one",
    ).not.toContain("PATCH");
  });

  // Posting the status must never stop the rebase.
  it("doesn't wait for the status comment", () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(needs(job), `${name} waits for start`).not.toContain("start");
    }
  });

  // When the push job ends, it edits this run's status comment to say how it went, and still posts
  // the comments that notify, since GitHub sends no notification for an edit.
  it("edits this run's status comment when it ends", () => {
    const push = jobs.push;
    expect(push.permissions?.["pull-requests"]).toBe("write");
    const edit = step(push, "Edit the status comment");
    expect(edit["continue-on-error"]).toBe(true);
    expect(edit.if).toContain("!cancelled()");
    expect(edit.run).toContain(marker);
    expect(edit.run).toContain("PATCH");
    expect(
      edit.run,
      "the edit must find this run's comment, not an older one",
    ).toContain("actions/runs/$GITHUB_RUN_ID");
    const names = steps(push).map((each) => each.name);
    expect(names.indexOf("Edit the status comment")).toBeGreaterThan(
      names.indexOf("Comment when resolution failed"),
    );
    expect(step(push, "Comment on the pull request").run).toContain(
      "gh pr comment",
    );
    expect(step(push, "Comment when resolution failed").run).toContain(
      "gh pr comment",
    );
  });
});

// GitHub's action that clones a repository, git's command that moves the tree to a commit and gh's
// that brings in a pull request all share this name, which the lint rule against payment words
// takes for one. The directive is on the same line because it names that rule.
const CLONE = "checkout"; // eslint-disable-line awml/no-billing -- a command's name, not a payment

describe("review.yml", () => {
  // Read in each test, so that a missing review.yml fails these tests and no others.
  const jobs = () => readJobs("review.yml");
  const head = "${{ github.event.pull_request.head.sha }}";
  const posted = `  "api -X POST repos/owner/repo/check-runs"*) echo '{}' ;;`;

  // GitHub runs main's copy of the workflow on pull_request_target, so a branch can't rewrite how
  // it's reviewed, as it could on pull_request. The job that posts the checks waits for the
  // reviews.
  it("reviews each pull request into main, from main's copy of the workflow", () => {
    const { on } = readWorkflow("review.yml");
    expect(Object.keys(on ?? {})).toEqual(["pull_request_target"]);
    expect(on?.pull_request_target).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened"],
    });
    expect(needs(jobs().post)).toEqual(["review"]);
  });

  // The sessions hold the maintainer's login token and read the pull request's description. Anyone
  // who can read the repository can open a pull request between two of its branches, so the branch
  // being this repository's isn't enough: the opener must be the owner, a member, a collaborator or
  // the factory's app, whose bot GitHub counts only as a contributor.
  it("reviews only a branch of this repository opened by its own people or the factory's app", () => {
    expect(squash(jobs().review.if)).toBe(
      squash(`github.event.pull_request.head.repo.full_name == github.repository &&
        (contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.pull_request.author_association) ||
        github.event.pull_request.user.login == 'awml-factory[bot]')`),
    );
  });

  // On pull_request_target the jobs hold main's secrets and tokens, so nothing from the head is
  // checked out, fetched or run: its change arrives only as the diff GitHub's compare API gives for
  // the event's head commit, applied to a commit of main, and the checks go on that same commit.
  it("never checks out, fetches or runs the pull request's head", () => {
    for (const [name, job] of Object.entries(jobs())) {
      for (const each of steps(job)) {
        const where = `review.yml's ${name} step "${each.name ?? each.uses}"`;
        if (each.uses?.startsWith(`actions/${CLONE}`)) {
          expect(each.with?.ref, where).toBe("main");
          expect(each.with?.repository, where).toBeUndefined();
        }
        for (const value of Object.values(each.with ?? {}))
          expect(String(value), where).not.toContain("pull_request.head");
        for (const line of (each.run ?? "").split("\n")) {
          for (const from of ["git fetch", "git pull", "refs/pull/", `gh pr ${CLONE}`])
            expect(line, where).not.toContain(from);
          if (line.includes(CLONE)) expect(line, where).not.toContain("HEAD_SHA");
        }
        // Event and pull request text reaches a script only through env:, quoted.
        expect(each.run ?? "", `${where} expands an expression in its script`).not.toContain("${{");
      }
    }
    const bring = stepWithId(jobs().review, "bring");
    expect(bring.env?.HEAD_SHA).toBe(head);
    expect(bring.run).toContain("compare/");
    expect(
      bring.run,
      "the patch's starting point must be checked to be a commit of main",
    ).toContain("merge-base --is-ancestor");
    expect(stepWithId(jobs().post, "post").env?.HEAD_SHA).toBe(head);
  });

  // The reviews run with a token that only reads, from main's prompts and REVIEW.md, kept before
  // the patch is applied. The checks are posted by a job whose token may only write checks, and
  // which checks out and runs nothing.
  it("reviews with a token that only reads, and posts with one that may only write checks", () => {
    const { review, post } = jobs();
    expect(review.permissions).toEqual({ contents: "read" });
    expect(
      steps(review)
        .filter((each) => each.uses?.startsWith(`actions/${CLONE}`))
        .map((each) => each.with?.ref),
    ).toEqual(["main"]);
    const bring = stepWithId(review, "bring").run ?? "";
    const applied = bring.indexOf("git apply --index");
    expect(applied).toBeGreaterThan(-1);
    for (const kept of [
      "cp .github/review-bugs-prompt.md .github/review-security-prompt.md",
      "cp REVIEW.md",
    ]) {
      expect(bring).toContain(kept);
      expect(bring.indexOf(kept), `${kept} after the patch is applied`).toBeLessThan(applied);
    }
    expect(post.permissions).toEqual({ checks: "write" });
    expect(
      steps(post)
        .map((each) => each.uses)
        .filter(Boolean),
    ).toEqual(["actions/download-artifact@v4"]);
  });

  // Each review is its own claude run, started together, so neither sees the other's session. A
  // session reads only the working tree and its own folder, never /proc, where Claude Code's own
  // environment holds the login token, runs nothing, and writes only its own findings. A bare Read,
  // Glob or Grep would approve a read anywhere.
  it("starts both reviews side by side, reading only the tree and their folder", () => {
    const sessions = steps(jobs().review).filter((each) =>
      /\bclaude -p\b/.test(each.run ?? ""),
    );
    expect(sessions).toHaveLength(1);
    const [reviews] = sessions;
    const script = reviews.run ?? "";
    for (const want of [
      /review-bugs-prompt\.md bugs\.json &\n/,
      /review-security-prompt\.md security\.json &\n/,
      /\bwait\b/,
    ])
      expect(script).toMatch(want);
    expect(reviews.env?.REVIEW_DIR).toBe("${{ runner.temp }}/review");
    // The keep step reads each review's findings from its session's own folder.
    expect(stepWithId(jobs().review, "keep").run).toContain('"$RUNNER_TEMP/sessions/$review/out/$review.json"');
  });

  // A patch that adds or changes Claude Code's own settings, servers or instructions, anywhere in
  // the tree, is refused before any review session starts, and nothing is posted. Any other patch
  // is applied, staged, to the commit of main it was made against, with main's REVIEW.md and the
  // pull request's title and description beside it.
  it.runIf(canRehearse)(
    "refuses a patch to Claude Code's own files before any review starts",
    () => {
      const bring = stepWithId(jobs().review, "bring").run ?? "";
      const answers = `
  *"vnd.github.diff"*) cat "$PATCH" ;;
  "api repos/owner/repo/compare/"*) jq -n --arg sha "$BASE" '{merge_base_commit: {sha: $sha}}' | answer ;;`;
      for (const path of [
        "",
        ".claude/settings.json",
        ".mcp.json",
        "CLAUDE.md",
        "docs/CLAUDE.local.md",
        "src/app/.claude/agents/helper.md",
        "docs/CLAUDE.md",
      ]) {
        const root = scratch();
        const repo = join(root, "repo");
        for (const [file, text] of Object.entries({
          ".github/review-bugs-prompt.md": "Review for bugs.\n",
          ".github/review-security-prompt.md": "Review for security.\n",
          "REVIEW.md": "What failure looks like.\n",
          "README.md": "A registry\n",
        }))
          put(join(repo, file), text);
        git(repo, "init", "-q");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "The registry's main");
        const base = git(repo, "rev-parse", "HEAD");
        put(join(repo, "README.md"), "A registry\nOf workflows\n");
        if (path)
          put(join(repo, path), `{"env": {"ANTHROPIC_BASE_URL": "https://example.com"}}\n`);
        git(repo, "add", "-A");
        put(join(root, "change.patch"), `${git(repo, "diff", "--cached")}\n`);
        git(repo, "reset", "-q", "--hard");
        const event = join(root, "event.json");
        put(event, `{"pull_request": {"title": "Add a line", "body": "A second line."}}`);
        const run = rehearse(bring, {
          root,
          cwd: repo,
          env: {
            HEAD_SHA: "cd".repeat(20),
            BASE: base,
            PATCH: join(root, "change.patch"),
            GITHUB_EVENT_PATH: event,
          },
          answers,
        });
        if (!path) {
          expect(run.failed, run.printed).toBe(false);
          expect(git(repo, "diff", "--cached", "--name-only")).toBe("README.md");
          expect(readIfThere(join(root, "runner/review/REVIEW.md"))).toBe(
            "What failure looks like.\n",
          );
          expect(readIfThere(join(root, "runner/review/pull-request.md"))).toBe(
            "# Add a line\n\nA second line.\n",
          );
          continue;
        }
        expect(run.failed, `a patch to ${path} reached the reviews`).toBe(true);
        expect(run.printed, `the refusal doesn't name ${path}`).toContain(path);
      }
    },
  );

  // GitHub's diff names a binary file without its contents, so the review applies the rest and
  // tells the reviewers which binary files changed, rather than failing and posting no checks. The
  // list goes in a file of the workflow's own, apart from the pull request's description, which the
  // author writes and could fill with a list of their own.
  it.runIf(canRehearse)("applies a patch with binary files, and lists them for the reviewers", () => {
    const bring = stepWithId(jobs().review, "bring").run ?? "";
    const answers = `
  *"vnd.github.diff"*) cat "$PATCH" ;;
  "api repos/owner/repo/compare/"*) jq -n --arg sha "$BASE" '{merge_base_commit: {sha: $sha}}' | answer ;;`;
    const root = scratch();
    const repo = join(root, "repo");
    for (const [file, text] of Object.entries({
      ".github/review-bugs-prompt.md": "Review for bugs.\n",
      ".github/review-security-prompt.md": "Review for security.\n",
      "REVIEW.md": "What failure looks like.\n",
      "README.md": "A registry\n",
      "logo.png": "\x89PNG\x00old",
      "vendor/awml/old.png": "\x89PNG\x00gone",
    }))
      put(join(repo, file), text);
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "The registry's main");
    const base = git(repo, "rev-parse", "HEAD");
    put(join(repo, "README.md"), "A registry\nOf workflows\n");
    put(join(repo, "logo.png"), "\x89PNG\x00new");
    put(join(repo, "fonts/Registry.ttf"), "\x00\x01font");
    rmSync(join(repo, "vendor/awml/old.png"));
    git(repo, "add", "-A");
    // GitHub's diff, like git's without --binary, says only that a binary file differs.
    const diff = git(repo, "diff", "--cached");
    expect(diff).toContain("Binary files a/vendor/awml/old.png and /dev/null differ");
    put(join(root, "change.patch"), `${diff}\n`);
    git(repo, "reset", "-q", "--hard");
    const event = join(root, "event.json");
    put(event, `{"pull_request": {"title": "Add a line", "body": "A second line."}}`);
    const run = rehearse(bring, {
      root,
      cwd: repo,
      env: {
        HEAD_SHA: "cd".repeat(20),
        BASE: base,
        PATCH: join(root, "change.patch"),
        GITHUB_EVENT_PATH: event,
      },
      answers,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("README.md");
    expect(readIfThere(join(root, "output"))).toContain("unread=3\n");
    const told = readIfThere(join(root, "runner/review/binary-files.md"));
    for (const path of ["logo.png", "fonts/Registry.ttf", "vendor/awml/old.png"])
      expect(told, `the reviewers aren't told that ${path} changed`).toContain(`\n- ${path}\n`);
    expect(readIfThere(join(root, "runner/review/pull-request.md"))).toBe("# Add a line\n\nA second line.\n");
    for (const prompt of ["review-bugs-prompt.md", "review-security-prompt.md"]) {
      const text = readFileSync(join(__dirname, "../.github", prompt), "utf8");
      expect(text, `${prompt} doesn't point at the workflow's list`).toContain("REVIEW_DIR/binary-files.md");
      expect(text, `${prompt} still points at a list in the description`).not.toContain(
        "end of\nREVIEW_DIR/pull-request.md",
      );
    }
  });

  // The count of binary files the reviews couldn't read reaches the post job as the bring step's
  // output, never as a file the sessions could write.
  it("passes the unread count to the post job as the bring step's output", () => {
    const text = readFileSync(join(__dirname, "../.github/workflows/review.yml"), "utf8");
    expect(text).not.toContain("unread.txt");
    expect(text).toContain("unread: ${{ steps.bring.outputs.unread }}");
    expect(text).toContain("UNREAD: ${{ needs.review.outputs.unread }}");
  });

  // A file is binary to git if it holds one NUL byte, so a script or workflow made binary would
  // reach the reviewers as a name only. Only images and fonts outside .github/, with plain names,
  // go through unread; any other binary file, WebAssembly included, stops the review.
  it.runIf(canRehearse)("stops at a binary file it can't read, or whose name is odd", () => {
    const bring = stepWithId(jobs().review, "bring").run ?? "";
    const answers = `
  *"vnd.github.diff"*) cat "$PATCH" ;;
  "api repos/owner/repo/compare/"*) jq -n --arg sha "$BASE" '{merge_base_commit: {sha: $sha}}' | answer ;;`;
    for (const [path, said] of [
      ["examples/render.sh", "examples/render.sh"],
      [".github/logo.png", ".github/logo.png"],
      ["wasm/awml.wasm", "wasm/awml.wasm"],
      ["images/café.png", "letters, digits"],
      ["images/a\n## Note.png", "letters, digits"],
    ]) {
      const root = scratch();
      const repo = join(root, "repo");
      for (const [file, text] of Object.entries({
        ".github/review-bugs-prompt.md": "Review for bugs.\n",
        ".github/review-security-prompt.md": "Review for security.\n",
        "REVIEW.md": "What failure looks like.\n",
        "README.md": "A registry\n",
      }))
        put(join(repo, file), text);
      git(repo, "init", "-q");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "The registry's main");
      const base = git(repo, "rev-parse", "HEAD");
      put(join(repo, path), "\x89PNG\x00pixels");
      git(repo, "add", "-A");
      put(join(root, "change.patch"), `${git(repo, "diff", "--cached")}\n`);
      git(repo, "reset", "-q", "--hard");
      const event = join(root, "event.json");
      put(event, `{"pull_request": {"title": "Add a file", "body": "A binary file."}}`);
      const run = rehearse(bring, {
        root,
        cwd: repo,
        env: {
          HEAD_SHA: "cd".repeat(20),
          BASE: base,
          PATCH: join(root, "change.patch"),
          GITHUB_EVENT_PATH: event,
        },
        answers,
      });
      expect(run.failed, `a binary ${path} went through to the reviews unread:\n${run.printed}`).toBe(true);
      expect(run.printed, `the refusal of ${path} says nothing of it`).toContain(said);
      expect(run.printed).not.toContain("## Note");
    }
  });

  // Each review is posted as a check on the pull request's head commit: Bug review and Security
  // review. One that finds nothing and read every file passes, one with an Important finding fails,
  // and one with only Nits or Pre-existing faults, or that couldn't read binary files, is neutral,
  // with its findings ranked Important, Nit, Pre-existing, and nothing in them can hide the rest. A
  // file that isn't a list of findings posts nothing.
  it.runIf(canRehearse)("posts a Bug review and a Security review check on the head commit", () => {
    const post = stepWithId(jobs().post, "post").run ?? "";
    const sha = "ab".repeat(20);
    const posting = (bugs: string, security: string, unread = "0") => {
      const root = scratch();
      put(join(root, "runner/findings/bugs.json"), bugs);
      put(join(root, "runner/findings/security.json"), security);
      return rehearse(post, { root, env: { HEAD_SHA: sha, UNREAD: unread }, answers: posted });
    };

    const clean = posting("[]", "[]");
    expect(clean.failed, clean.printed).toBe(false);
    expect(
      clean.inputs.map(({ name, head_sha, status, conclusion }) => ({
        name,
        head_sha,
        status,
        conclusion,
      })),
    ).toEqual([
      { name: "Bug review", head_sha: sha, status: "completed", conclusion: "success" },
      { name: "Security review", head_sha: sha, status: "completed", conclusion: "success" },
    ]);

    const important = posting(
      `[
        {"severity": "Nit", "file": "src/server/a.ts", "line": 7, "title": "A clearer name", "detail": "Say what it holds."},
        {"severity": "Pre-existing", "file": "src/server/b.ts", "line": 0, "title": "An old fault", "detail": "It was there before."},
        {"severity": "Important", "file": "src/server/c.ts", "line": 42, "title": "A private workflow leaks", "detail": "A stranger sees its title. <!-- hide the rest"}
      ]`,
      "[]",
    );
    expect(important.failed, important.printed).toBe(false);
    expect(important.inputs.map((check) => [check.name, check.conclusion])).toEqual([
      ["Bug review", "failure"],
      ["Security review", "success"],
    ]);
    const output = important.inputs[0].output as { title?: string; summary?: string };
    expect(output.title).toBeTruthy();
    const summary = output.summary ?? "";
    const ranked = ["A private workflow leaks", "A clearer name", "An old fault"].map((title) =>
      summary.indexOf(title),
    );
    expect(ranked.every((at) => at >= 0), summary).toBe(true);
    expect(ranked, "the findings aren't ranked Important, Nit, Pre-existing").toEqual(
      [...ranked].sort((a, b) => a - b),
    );
    expect(summary).toContain("A stranger sees its title.");
    expect(summary).toContain("src/server/c.ts:42");
    expect(summary, "a finding can hide the rest of the summary").not.toContain("<!--");

    const minor = posting(
      `[{"severity": "Nit", "file": "src/server/a.ts", "line": 7, "title": "A clearer name", "detail": "Say what it holds."}]`,
      `[{"severity": "Pre-existing", "file": "src/server/b.ts", "line": 0, "title": "An old fault", "detail": "It was there before."}]`,
    );
    expect(minor.failed, minor.printed).toBe(false);
    expect(minor.inputs.map((check) => [check.name, check.conclusion])).toEqual([
      ["Bug review", "neutral"],
      ["Security review", "neutral"],
    ]);

    const unread = posting("[]", "[]", "2");
    expect(unread.failed, unread.printed).toBe(false);
    for (const check of unread.inputs) {
      const { summary = "", title = "" } = check.output as { title?: string; summary?: string };
      expect(check.conclusion, "a review that couldn't read 2 binary files passed").toBe("neutral");
      expect(title).toContain("2 binary files unread");
      expect(summary).toContain("2 binary images or fonts");
    }
    const failing = posting(
      `[{"severity": "Important", "file": "a.ts", "line": 1, "title": "A break", "detail": "It breaks."}]`,
      "[]",
      "2",
    );
    expect(failing.inputs[0].conclusion, "unread files hid an Important finding").toBe("failure");

    for (const count of ["", "two", "-1", "2; echo", "12345", "1.5"]) {
      const refused = posting("[]", "[]", count);
      expect(refused.failed, `a count of "${count}" was accepted`).toBe(true);
      expect(refused.inputs).toEqual([]);
    }

    const broken = posting("[]", `{"not": "a list"}`);
    expect(broken.failed, "a findings file that isn't a list passed").toBe(true);
    expect(broken.inputs).toEqual([]);
  });

  // A finding's title is cut to 200 characters and its detail to 2,000, and its file, like the rest
  // of its text, can't hide what follows it.
  it.runIf(canRehearse)("cuts each finding to size", () => {
    const post = stepWithId(jobs().post, "post").run ?? "";
    const title = "crust ".repeat(50);
    const detail = "crumb ".repeat(500);
    const root = scratch();
    put(
      join(root, "runner/findings/bugs.json"),
      `[{"severity": "Important", "file": "page<!--.tsx", "line": 3, "title": "${title}", "detail": "${detail}"}]`,
    );
    put(join(root, "runner/findings/security.json"), "[]");
    const run = rehearse(post, {
      root,
      env: { HEAD_SHA: "ab".repeat(20), UNREAD: "0" },
      answers: posted,
    });
    expect(run.failed, run.printed).toBe(false);
    const summary = (run.inputs[0].output as { summary?: string }).summary ?? "";
    expect(summary).toContain(title.slice(0, 200));
    expect(summary).not.toContain(title.slice(0, 201));
    expect(summary).toContain(detail.slice(0, 2000));
    expect(summary).not.toContain(detail.slice(0, 2001));
    expect(summary).not.toContain("<!--");
    expect(summary).toContain("page&lt;!--.tsx:3");
  });

  // Anyone who can read the repository can download the review job's artifact, so findings that
  // carry anything like the login token are refused before the upload, and again by the post job,
  // which posts nothing then and doesn't print them.
  it.runIf(canRehearse)("keeps and posts no finding that looks like the login token", () => {
    const review = jobs().review;
    const keepAt = steps(review).findIndex((each) => each.id === "keep");
    const uploadAt = steps(review).findIndex((each) =>
      each.uses?.startsWith("actions/upload-artifact"),
    );
    expect(keepAt).toBeGreaterThan(-1);
    expect(uploadAt, "the findings are kept before they're checked for the token").toBeGreaterThan(
      keepAt,
    );
    const keep = stepWithId(review, "keep").run ?? "";
    const post = stepWithId(jobs().post, "post").run ?? "";
    const token = `sk-ant-oat01-${"Ab3_".repeat(20)}`;
    const body = "Zq9-".repeat(25);
    for (const finding of [
      `{"severity": "Nit", "file": "a.ts", "line": 1, "title": "A name", "detail": "It is ${token}."}`,
      `{"severity": "Nit", "file": "a.ts", "line": 1, "title": "${body}", "detail": "A detail."}`,
      `{"severity": "Nit", "file": "SK-ANT-OAT01-x.ts", "line": 1, "title": "A name", "detail": "A detail."}`,
    ]) {
      for (const [script, bugs, security] of [
        [keep, "sessions/bugs/out/bugs.json", "sessions/security/out/security.json"],
        [post, "findings/bugs.json", "findings/security.json"],
      ]) {
        const root = scratch();
        put(join(root, "runner", bugs), `[${finding}]`);
        put(join(root, "runner", security), "[]");
        const run = rehearse(script, {
          root,
          env: { HEAD_SHA: "ab".repeat(20), UNREAD: "0" },
          answers: posted,
        });
        expect(run.failed, `the ${bugs} step let through ${finding}`).toBe(true);
        expect(run.inputs).toEqual([]);
        expect(run.printed).not.toContain(token);
        expect(run.printed).not.toContain(body);
        expect(left(root, "findings/bugs.json") === "" || script === post).toBe(true);
      }
    }
    const root = scratch();
    put(
      join(root, "runner/sessions/bugs/out/bugs.json"),
      `[{"severity": "Nit", "file": "a.ts", "line": 1, "title": "A name", "detail": "A detail."}]`,
    );
    put(join(root, "runner/sessions/security/out/security.json"), "[]");
    const clean = rehearse(keep, { root });
    expect(clean.failed, clean.printed).toBe(false);
    // What the keep step passed is what's uploaded for the post job.
    expect(left(root, "findings/bugs.json")).toContain("A name");
    expect(left(root, "findings/security.json")).toBe("[]");
    const upload = steps(review).find((each) => each.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.with).toEqual({ name: "findings", path: "${{ runner.temp }}/findings" });
  });
});

describe("every workflow step that holds the Claude token", () => {
  it("scrubs the token from the commands Claude starts", () => {
    const dir = join(__dirname, "../.github/workflows");
    const files = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
    const holders: Record<string, number> = {};
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      const jobs =
        (
          parse(text) as {
            jobs?: Record<
              string,
              { steps?: { name?: string; env?: Record<string, unknown> }[] }
            >;
          }
        ).jobs ?? {};
      for (const [name, job] of Object.entries(jobs)) {
        for (const each of job.steps ?? []) {
          if (
            each.env === undefined ||
            !("CLAUDE_CODE_OAUTH_TOKEN" in each.env)
          )
            continue;
          holders[file] = (holders[file] ?? 0) + 1;
          expect(
            each.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
            `${file}'s ${name} step "${each.name}" gives Claude its token without scrubbing it from Claude's commands`,
          ).toBe("1");
        }
      }
    }
    expect(holders, "the steps that give Claude its token").toEqual(claudeSteps);
  });

  // The token goes only to a step that starts Claude, and every step that starts Claude has it.
  it("holds the token only where Claude runs", () => {
    for (const file of workflowFiles)
      for (const [name, job] of Object.entries(readJobs(file)))
        for (const each of steps(job)) {
          const holds = each.env !== undefined && "CLAUDE_CODE_OAUTH_TOKEN" in each.env;
          const starts = /\bclaude -p\b/.test(each.run ?? "");
          expect(holds, `${file}'s ${name} step "${each.name}"`).toBe(starts);
          if (holds) expect(each.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
        }
  });
});

describe("Claude steps in every workflow", () => {
  const files = readdirSync(join(__dirname, "../.github/workflows")).filter(
    (file) => file.endsWith(".yml"),
  );

  it("installs bubblewrap and checks it works before any step holding the Claude token", () => {
    const checked: Record<string, number> = {};
    for (const file of files) {
      for (const [name, job] of Object.entries(readJobs(file))) {
        const all = steps(job);
        all.forEach((each, index) => {
          if (!each.env || !("CLAUDE_CODE_OAUTH_TOKEN" in each.env)) return;
          checked[file] = (checked[file] ?? 0) + 1;
          const before = all
            .slice(0, index)
            .map((prior) => prior.run ?? "")
            .join("\n");
          const where = `${file} ${name}`;
          expect(before, where).toContain("apt-get install -y bubblewrap socat");
          expect(before, where).toContain(
            "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
          );
          expect(before, where).toContain(
            "bwrap --dev-bind / / --unshare-pid true",
          );
        });
      }
    }
    expect(checked, "the steps that hold the Claude token").toEqual(claudeSteps);
  });

  // Each claude -p in a step loads only the user's settings and no MCP servers, so a step that
  // starts two sessions can't leave the flags off one.
  it("runs every claude -p with only user settings and only the strict MCP config", () => {
    const checked: Record<string, number> = {};
    for (const file of files) {
      for (const [name, job] of Object.entries(readJobs(file))) {
        for (const each of steps(job)) {
          const script = each.run ?? "";
          const sessions = script.match(/\bclaude -p\b/g)?.length ?? 0;
          if (sessions === 0) continue;
          checked[file] = (checked[file] ?? 0) + 1;
          expect(
            script.match(/--setting-sources user[\s\\]/g)?.length ?? 0,
            `${file} ${name}: sessions that load only the user's settings`,
          ).toBe(sessions);
          expect(
            script.match(/--strict-mcp-config\b/g)?.length ?? 0,
            `${file} ${name}: sessions that ignore the tree's MCP servers`,
          ).toBe(sessions);
        }
      }
    }
    expect(checked, "the steps that run claude -p").toEqual(claudeSteps);
  });

  // The review and classify sessions read only the working tree and their own folder, never /proc,
  // where Claude Code's own environment holds the login token. A bare Read, Glob or Grep rule would
  // approve a read anywhere. They run nothing, not even git, whose --output writes wherever it's
  // told, and they write nothing but their own findings.
  it("lets the reviewers and the classifier read only the tree and their own folder", () => {
    const found: string[] = [];
    for (const file of workflowFiles)
      for (const [name, job] of Object.entries(readJobs(file)))
        for (const each of steps(job)) {
          const script = each.run ?? "";
          if (!/\bclaude -p\b/.test(script) || each.env?.REVIEW_DIR === undefined) continue;
          const where = `${file}'s ${name} step "${each.name}"`;
          found.push(`${file} ${name} ${each.id}`);
          for (const want of [
            `"Read(./**)"`,
            `"Read(/$REVIEW_DIR/**)"`,
            `--disallowedTools "Read(//proc/**)" "Bash"`,
            "--permission-mode default",
            'chmod -R a-w "$REVIEW_DIR"',
          ])
            expect(script, where).toContain(want);
          for (const bare of [`"Read"`, `"Glob"`, `"Grep"`, `"Write"`, `"Edit"`, `"Bash(`, "acceptEdits"])
            expect(script, `${where} allows ${bare}`).not.toContain(bare);
        }
    expect(found.sort(), "the build's reviews, its classifier and the pull request reviews").toEqual([
      "build.yml review classify",
      "build.yml review reviews",
      "review.yml review undefined",
    ]);
  });

  // Each session starts in a home of its own, empty, so it loads no settings another session could
  // have written, and has a folder of its own, where the one file it may write is. The inputs it
  // shares with the other sessions can't be changed. So one session that text in the patch steers
  // can't change another's findings, its settings in ~/.claude, or what the others read.
  it.runIf(canRehearse)("starts each review session in a home and a folder of its own, with inputs it can't change", () => {
    const steps_: [string, Step, Record<string, string>][] = [
      ["build.yml's reviews", stepWithId(readJobs("build.yml").review, "reviews"), { bugs: "bugs.json", security: "security.json" }],
      ["build.yml's classifier", stepWithId(readJobs("build.yml").review, "classify"), { classify: "classification.json" }],
      [
        "review.yml's reviews",
        steps(readJobs("review.yml").review).find((each) => /\bclaude -p\b/.test(each.run ?? "")) ?? {},
        { bugs: "bugs.json", security: "security.json" },
      ],
    ];
    for (const [where, each, files] of steps_) {
      const root = scratch();
      const review = join(root, "runner/review");
      put(join(review, "REVIEW.md"), "What failure looks like.\n");
      put(join(review, "change.patch"), "diff --git a/a b/a\n");
      for (const [prompt, file] of [
        ["review-bugs-prompt.md", "bugs.json"],
        ["review-security-prompt.md", "security.json"],
        ["classify-prompt.md", "classification.json"],
      ])
        put(join(root, "runner", prompt), `Read REVIEW_DIR/change.patch. Write OUT_DIR/${file}, and nothing else.\n`);
      const { run, started } = sessions(each.run ?? "", root, {
        REVIEW_DIR: review,
        CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      });
      expect(run.failed, `${where}: ${run.printed}`).toBe(false);
      expect(started.length, `${where} starts a session for each of ${Object.keys(files).join(", ")}`).toBe(
        Object.keys(files).length,
      );
      const homes = started.map((session) => session.home);
      expect(new Set(homes).size, `${where} shares a home between sessions`).toBe(homes.length);
      const outs: string[] = [];
      for (const session of started) {
        const { args } = session;
        expect(session.home, `${where} starts a session in the runner's home`).not.toBe(root);
        expect(session.home.startsWith(join(root, "runner")), where).toBe(true);
        expect(session.empty, `${where} starts a session in a home that isn't empty`).toBe("yes");
        expect(session.changes, `${where} lets a session change its inputs`).toBe("no");
        expect(flagValues(args, "--permission-mode")).toEqual(["default"]);
        expect(flagValues(args, "--disallowedTools")).toEqual(["Read(//proc/**)", "Bash"]);
        const allowed = flagValues(args, "--allowedTools");
        expect(allowed.filter((rule) => rule.startsWith("Read("))).toEqual(["Read(./**)", `Read(/${review}/**)`]);
        const writes = allowed.filter((rule) => !rule.startsWith("Read("));
        const [, out, file] = /^Write\(\/(.+)\/([a-z]+\.json)\)$/.exec(writes[0] ?? "") ?? [];
        expect(writes, `${where} lets a session write more than its own findings`).toEqual([
          `Write(/${out}/${file})`,
          `Edit(/${out}/${file})`,
        ]);
        expect(Object.values(files)).toContain(file);
        for (const home of homes)
          expect(out.startsWith(home), `${where} lets a session write in a home, where ~/.claude is`).toBe(false);
        for (const rule of allowed) expect(rule, where).not.toContain(".claude");
        outs.push(out);
        const dirs = args.flatMap((arg, at) => (arg === "--add-dir" ? [args[at + 1]] : []));
        expect(dirs).toEqual([review, out]);
        const prompt = args[args.indexOf("-p") + 1];
        expect(prompt).toContain(`${review}/change.patch`);
        expect(prompt).toContain(`${out}/${file}`);
      }
      expect(new Set(outs).size, `${where} shares a folder between sessions`).toBe(outs.length);
    }
  });
});

// The description of a build's pull request, which the open job writes before CI has run and
// land.yml writes again with the build rule's verdict. Both run main's copy.
describe("pull-request-body.sh", () => {
  const script = join(__dirname, "../.github/pull-request-body.sh");
  const checked = "ef".repeat(20);
  const digests = { CHANGE_DIGEST: "11".repeat(32), REVIEW_DIGEST: "22".repeat(32), RECORD_DIGEST: "33".repeat(32) };
  const marker = `<!-- factory-build run=1234 change=${"11".repeat(32)} review=${"22".repeat(32)} record=${"33".repeat(32)} -->`;

  function describing({
    findings = "[]",
    classification,
    verdict,
    pictures,
    leftOut,
    env = {},
  }: {
    findings?: string;
    classification?: string;
    verdict?: string;
    pictures?: string;
    leftOut?: string;
    env?: Record<string, string>;
  }) {
    const root = scratch();
    put(join(root, "runner/change/message.md"), "Add a line\n\nWhy it's added.\n");
    put(join(root, "runner/change/pull-request.md"), "Adds a line to the page.\n\n## What changed\n\n- A line\n");
    put(join(root, "runner/review/findings.json"), findings);
    if (classification) put(join(root, "runner/review/classification.json"), classification);
    if (verdict) put(join(root, "runner/verdict.txt"), verdict);
    put(join(root, "runner/pictures.txt"), pictures ?? "");
    put(join(root, "runner/pictures-left-out.txt"), leftOut ?? "");
    const run = rehearse(`"${script}" > "$RUNNER_TEMP/pull-request.md"`, {
      root,
      env: {
        BUILD_RUN: "1234",
        ISSUE: "125",
        CHECKED: checked,
        CHANGE_DIR: join(root, "runner/change"),
        REVIEW_DIR: join(root, "runner/review"),
        PICTURES: join(root, "runner/pictures.txt"),
        PICTURES_LEFT_OUT: join(root, "runner/pictures-left-out.txt"),
        MEDIA_URL: "https://github.com/owner/repo/raw/factory-media/issue-125/attempt-1",
        ...digests,
        ...(verdict ? { VERDICT: join(root, "runner/verdict.txt") } : {}),
        ...env,
      },
    });
    return { run, body: left(root, "pull-request.md") };
  }

  // The first line names the build's run and the digests of the change, the review record and the
  // build's record, so land.yml can find the records and check that no job replaced them.
  it.runIf(canRehearse)("names the build's run and its records' digests first, so land.yml can check them", () => {
    const { run, body } = describing({});
    expect(run.failed, run.printed).toBe(false);
    expect(body.split("\n")[0]).toBe(marker);
    expect(body).toContain(
      "Waits for CI. Once CI passes, the build rule decides whether this merges by itself or waits for your review.",
    );
    expect(body).toContain("Adds a line to the page.");
    expect(body).toContain(`applied this change to main at ${checked}`);
    expect(body.trimEnd().split("\n").at(-1)).toBe("Closes #125");
  });

  it.runIf(canRehearse)("says why the change needs review, and what the reviews and classifier found", () => {
    const { run, body } = describing({
      findings: `[
        {"review": "bug", "severity": "Nit", "file": "src/a.ts", "line": 7, "title": "A clearer name", "detail": "Say what it holds."},
        {"review": "security", "severity": "Important", "file": "src/b.ts", "line": 0, "title": "A leak", "detail": "A stranger sees it. <!-- hide the rest\\n## Approved"},
        {"review": "bug", "severity": "Pre-existing", "file": "src/c.ts", "line": 3, "title": "An old fault", "detail": "It was there."}
      ]`,
      classification: `{"needs_review": true, "reasons": ["It changes who may see a workflow."]}`,
      verdict: "review\nThe reviews left 2 findings open.\nThe classifier asked for a review.\n",
    });
    expect(run.failed, run.printed).toBe(false);
    for (const want of [
      "## Needs your review because",
      "- The reviews left 2 findings open.",
      "## Why the classifier asked for review",
      "- It changes who may see a workflow.",
      "## Findings still open",
      "- **Nit**, from the bug review, in `src/a.ts:7`: A clearer name Say what it holds.",
      "- **Important**, from the security review, in `src/b.ts`: A leak A stranger sees it.",
      "## Findings in code the change didn't write",
      "- **Pre-existing**, from the bug review, in `src/c.ts:3`: An old fault It was there.",
    ])
      expect(body).toContain(want);
    expect(body.indexOf("## Findings still open")).toBeLessThan(body.indexOf("Adds a line to the page."));
    expect(body.indexOf("Adds a line to the page.")).toBeLessThan(
      body.indexOf("## Findings in code the change didn't write"),
    );
    expect(body.split("<!--"), "a finding can hide the rest of the description").toHaveLength(2);
    expect(body).not.toContain("\n## Approved");
  });

  // The rule's reasons name the change's paths, and the reviews' and classifier's text is theirs,
  // so none of it can hide the rest of the description or mention anyone.
  it.runIf(canRehearse)("keeps the reasons and findings from hiding text or mentioning anyone", () => {
    const { run, body } = describing({
      findings: `[{"review": "bug", "severity": "Nit", "file": "src/a.ts", "line": 7, "title": "Ask @the-owner", "detail": "Or @acme/team."}]`,
      classification: `{"needs_review": true, "reasons": ["@the-owner should look <!-- here"]}`,
      verdict: "review\n`docs/<!--.md` is a path that always needs review.\nAsk @the-owner.\n",
    });
    expect(run.failed, run.printed).toBe(false);
    expect(body.split("<!--"), "a reason can hide the rest of the description").toHaveLength(2);
    expect(body).toContain("- `docs/&lt;!--.md` is a path that always needs review.");
    expect(body).not.toMatch(/@(the-owner|acme)/);
    expect(body).toContain("@\u200bthe-owner");
  });

  it.runIf(canRehearse)("says when a change merges by itself", () => {
    const { run, body } = describing({ verdict: "straightforward\nNo review rule matched this change.\n" });
    expect(run.failed, run.printed).toBe(false);
    expect(body).toContain(
      "Set to merge by itself, because the build rule found it straightforward: No review rule matched this change.",
    );
    expect(body).not.toContain("## Needs your review because");
  });

  it.runIf(canRehearse)("shows the pages before and after, at each width", () => {
    const media = "https://github.com/owner/repo/raw/factory-media/issue-125/attempt-1";
    const { run, body } = describing({
      pictures: [
        "/acme/dinners|visitor|desktop|before/0-desktop.png|after/0-desktop.png",
        "/acme/dinners|visitor|phone|before/0-phone.png|",
        "/settings|owner|desktop|before/1-desktop.gif|after/1-desktop.gif",
        "",
      ].join("\n"),
    });
    expect(run.failed, run.printed).toBe(false);
    for (const want of [
      "## Pictures",
      "`scripts/seed-pictures.ts`",
      "### `/acme/dinners`, signed out",
      "Desktop, 1280 pixels wide:",
      `| ![Before](${media}/before/0-desktop.png) | ![After](${media}/after/0-desktop.png) |`,
      "Phone, 390 pixels wide:",
      `| ![Before](${media}/before/0-phone.png) | Couldn't be pictured |`,
      "### `/settings`, signed in as ana, as someone uses it",
    ])
      expect(body).toContain(want);
    expect(body.split("### `/acme/dinners`")).toHaveLength(2);

    const leftOut = describing({ leftOut: "The pictures job didn't finish, so no page was pictured.\n" });
    expect(leftOut.body).toContain(
      "The pictures were left out. The pictures job didn't finish, so no page was pictured.",
    );
  });

  it.runIf(canRehearse)("refuses findings, a verdict or a commit it can't read", () => {
    expect(describing({ findings: `{"not": "a list"}` }).run.failed).toBe(true);
    expect(
      describing({ findings: `[{"review": "bug", "severity": "Minor", "file": "a", "line": 1, "title": "t", "detail": "d"}]` })
        .run.failed,
    ).toBe(true);
    expect(describing({ classification: `{"needs_review": "yes", "reasons": []}` }).run.failed).toBe(true);
    expect(describing({ verdict: "merge\nWhy not.\n" }).run.failed).toBe(true);
    for (const name of ["CHANGE_DIGEST", "REVIEW_DIGEST", "RECORD_DIGEST"])
      expect(describing({ env: { [name]: "main" } }).run.failed, `the description took ${name}=main`).toBe(true);
  });
});

describe("land.yml", () => {
  // Read in each test, so that a missing land.yml fails these tests and no others.
  const workflow = () => readWorkflow("land.yml");
  const jobs = () => workflow().jobs;

  // GitHub starts it from main's copy when CI finishes on a build's branch, whatever the branch
  // holds, and no job checks out the branch or runs anything from it. The find job only reads.
  it("lands a build's pull request once CI has run, running only main's code", () => {
    expect(workflow().on?.workflow_run).toEqual({
      workflows: ["CI"],
      types: ["completed"],
      branches: ["build/issue-*"],
    });
    expect(writes(jobs().find)).toEqual([]);
    for (const [name, job] of Object.entries(jobs()))
      for (const each of steps(job))
        if (each.uses?.startsWith(`actions/${CLONE}`))
          expect(each.with?.ref, `land.yml's ${name} checks out the branch`).toBe("${{ github.sha }}");
    expect(steps(jobs().land).filter((each) => each.uses?.startsWith(`actions/${CLONE}`))).toEqual([]);
  });

  // CI runs on the branch's push and on its pull request, and only the push's run lands it. A
  // newer push's CI replaces an older one's land, but the pull request's run never cancels it. Each
  // pull request lands on its own, so a third build's land can't cancel a second's that waits.
  it("lets a newer push's CI replace the land of an older one, and nothing else", () => {
    const group = workflow().concurrency?.group ?? "";
    expect(group).toContain("github.event.workflow_run.event");
    expect(group).toContain("github.event.workflow_run.head_branch");
    expect(workflow().concurrency?.["cancel-in-progress"]).toBe(true);
    expect(jobs().land.concurrency).toEqual({
      group: "build-auto-merge-${{ needs.find.outputs.pr }}",
      "cancel-in-progress": false,
    });
  });

  const head = "ab".repeat(20);
  const base = "cd".repeat(20);
  const checked = "ef".repeat(20);
  const asked = "aa".repeat(32);
  const changeDigest = "11".repeat(32);
  const reviewDigest = "22".repeat(32);
  const markerFor = (record: string) =>
    `<!-- factory-build run=1234 change=${changeDigest} review=${reviewDigest} record=${record} -->`;
  const buildRun = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      workflow_id: 22,
      head_branch: "main",
      event: "issues",
      display_title: "Build of issue 125, try 2",
      ...overrides,
    });
  const buildRecord = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      issue: 125,
      attempt: 2,
      requested_by: "the-owner",
      commit: head,
      base,
      checked,
      asked,
      bot: "awml-factory[bot]",
      ...overrides,
    });
  function finding({
    env = {},
    pull = {},
    run = buildRun(),
    record = buildRecord(),
    named,
  }: {
    env?: Record<string, string>;
    pull?: Record<string, unknown>;
    run?: string;
    record?: string;
    named?: (digest: string) => string;
  }) {
    const root = scratch();
    put(join(root, "record/build.json"), record);
    put(join(root, "record/pictures.txt"), "/acme/dinners|visitor|desktop|a.png|b.png\n");
    put(join(root, "record/title.txt"), "Add a line\n");
    const digest = digestOf(join(root, "record"));
    const pulls = JSON.stringify([
      {
        number: 140,
        base: { ref: "main" },
        head: { ref: "build/issue-125", sha: head, repo: { full_name: "owner/repo" } },
        user: { login: "awml-factory[bot]", type: "Bot" },
        body: `${(named ?? markerFor)(digest)}\nWaits for CI.`,
        ...pull,
      },
    ]);
    return rehearse(stepWithId(jobs().find, "find").run ?? "", {
      root,
      env: {
        BRANCH: "build/issue-125",
        HEAD_SHA: head,
        HEAD_REPOSITORY: "owner/repo",
        CI_EVENT: "push",
        CONCLUSION: "success",
        RECORD: join(root, "record"),
        ...env,
      },
      answers: `
  "api repos/owner/repo/pulls?head=owner:build/issue-125&state=open") answer <<< '${pulls}' ;;
  "api repos/owner/repo/actions/workflows/build.yml"*) answer <<< '{"id": 22}' ;;
  "api repos/owner/repo/actions/runs/1234") answer <<< '${run}' ;;
  "run download 1234 --repo owner/repo -n pull-request "*) mkdir -p "$download"; cp -r "$RECORD/." "$download/" ;;`,
    });
  }

  // It finds the open pull request the app opened from the branch, whose head is the commit CI ran
  // on, and the build that opened it, named in the first line of its description with the digests
  // of its records. The run it names must be this repository's build from main of that issue and
  // try, and its record must be the one the description names, naming the app that opened the pull
  // request and the commit CI ran on.
  it.runIf(canRehearse)("finds the build that opened the pull request, from its records", () => {
    const passed = finding({});
    expect(passed.failed, passed.printed).toBe(false);
    expect(passed.outputs).toEqual({
      ci: "passed",
      issue: "125",
      attempt: "2",
      requested_by: "the-owner",
      base,
      checked,
      asked,
      pr: "140",
      head_sha: head,
      build_run: "1234",
      change: changeDigest,
      review: reviewDigest,
      record: passed.outputs.record,
    });
    expect(passed.outputs.record).toMatch(/^[0-9a-f]{64}$/);
    expect(finding({ env: { CONCLUSION: "failure" } }).outputs.ci).toBe("failed");
  });

  it.runIf(canRehearse)("leaves CI's result alone unless it's a build's own", () => {
    for (const [name, found] of [
      ["CI on a pull request", { env: { CI_EVENT: "pull_request" } }],
      ["CI on a fork", { env: { HEAD_REPOSITORY: "someone/repo" } }],
      ["a branch that isn't a build's", { env: { BRANCH: "build/issue-12a" } }],
      ["a commit that isn't one", { env: { HEAD_SHA: "main" } }],
      ["a cancelled CI", { env: { CONCLUSION: "cancelled" } }],
      ["a pull request a person opened", { pull: { user: { login: "the-owner", type: "User" } } }],
      ["a pull request that has moved on", { pull: { head: { ref: "build/issue-125", sha: base, repo: { full_name: "owner/repo" } } } }],
      ["a description that names no build", { pull: { body: "Waits for CI." } }],
      ["a description whose build line isn't first", { named: (digest: string) => `Waits.\n${markerFor(digest)}` }],
      ["a description that names no digests", { named: () => "<!-- factory-build run=1234 -->" }],
      ["a record that isn't the one named", { named: () => markerFor("44".repeat(32)) }],
      ["a run of another workflow", { run: buildRun({ workflow_id: 33 }) }],
      ["a run from a branch", { run: buildRun({ head_branch: "build/issue-125" }) }],
      ["a run started by a comment", { run: buildRun({ event: "issue_comment" }) }],
      ["the build of another try", { run: buildRun({ display_title: "Build of issue 125, try 1" }) }],
      ["the record of another issue", { record: buildRecord({ issue: 126 }) }],
      ["a record that names another bot", { record: buildRecord({ bot: "another-app[bot]" }) }],
      ["a record of another commit", { record: buildRecord({ commit: base }) }],
      ["a record whose checks name no commit", { record: buildRecord({ checked: "main" }) }],
      ["a record with no digest of the issue", { record: buildRecord({ asked: "" }) }],
      ["a record of an odd reviewer", { record: buildRecord({ requested_by: "a b" }) }],
    ] as const) {
      const leaving = finding(found);
      expect(leaving.failed, `${name}: ${leaving.printed}`).toBe(false);
      expect(leaving.outputs, name).toEqual({ ci: "none" });
    }
  });

  // The rule and its settings come from main as it is now. It judges the commit the build pushed,
  // which CI ran on, not the patch in an artifact: the commit is fetched but never checked out, must
  // sit directly on the commit of main the build pushed it onto, which must be on main, and its
  // tree is read into an index beside that commit, leaving the files on disk as main's. The
  // change and the review record must be the ones the description names, and the rule needs the
  // classifier's verdict.
  it.runIf(canRehearse)("judges the pushed commit by main's rule, against the main it was pushed onto", () => {
    const judge = stepWithId(jobs().find, "judge");
    expect(judge.env?.HEAD_SHA).toBe("${{ steps.find.outputs.head_sha }}");
    const judging = ({
      findings = "[]",
      classification = `{"needs_review": false, "reasons": ["It is small."]}`,
      path = "src/app/page.tsx",
      extra = "",
      offMain = false,
      between = false,
      swap,
    }: {
      findings?: string;
      classification?: string | null;
      path?: string;
      extra?: string;
      offMain?: boolean;
      between?: boolean;
      swap?: (root: string) => void;
    }) => {
      const root = scratch();
      const origin = join(root, "origin");
      put(join(origin, "scripts/build-rule.ts"), readFileSync(join(__dirname, "../scripts/build-rule.ts"), "utf8"));
      put(join(origin, ".github/build-rules.yml"), readFileSync(join(__dirname, "../.github/build-rules.yml"), "utf8"));
      put(join(origin, "src/app/page.tsx"), "export default function Page() {}\n");
      git(origin, "init", "-q");
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "The registry's main");
      let pushedOnto = git(origin, "rev-parse", "HEAD");
      if (offMain) {
        git(origin, CLONE, "-q", "-b", "elsewhere");
        put(join(origin, "README.md"), "Elsewhere\n");
        git(origin, "add", "-A");
        git(origin, "commit", "-q", "-m", "Not on main");
        pushedOnto = git(origin, "rev-parse", "HEAD");
      }
      git(origin, CLONE, "-q", "-b", "build/issue-125");
      if (between) {
        put(join(origin, "NOTES.md"), "In between\n");
        git(origin, "add", "-A");
        git(origin, "commit", "-q", "-m", "In between");
      }
      put(join(origin, path), "export default function Page() { return null; }\n");
      if (extra) put(join(origin, ".gitattributes"), extra);
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "Build #125");
      const pushed = git(origin, "rev-parse", "HEAD");
      git(origin, CLONE, "-q", "main");
      put(join(origin, "README.md"), "Main moves on\n");
      git(origin, "add", "-A");
      git(origin, "commit", "-q", "-m", "Main moves on");
      const repo = join(root, "repo");
      git(root, "clone", "-q", "--single-branch", "--branch", "main", origin, repo);

      put(join(root, "records/change/message.md"), "Add a line\n");
      put(join(root, "records/change/pull-request.md"), "Adds a line.\n");
      put(join(root, "records/review/findings.json"), findings);
      if (classification !== null) put(join(root, "records/review/classification.json"), classification);
      const env = {
        BASE: pushedOnto,
        HEAD_SHA: pushed,
        BUILD_RUN: "1234",
        CHANGE_DIGEST: digestOf(join(root, "records/change")),
        REVIEW_DIGEST: digestOf(join(root, "records/review")),
        RECORDS: join(root, "records"),
      };
      swap?.(root);
      const run = rehearse(judge.run ?? "", {
        root,
        cwd: repo,
        env,
        answers: `
  "run download 1234 --repo owner/repo -n change "*) mkdir -p "$download"; cp -r "$RECORDS/change/." "$download/" ;;
  "run download 1234 --repo owner/repo -n review "*) mkdir -p "$download"; cp -r "$RECORDS/review/." "$download/" ;;`,
      });
      return { root, repo, pushed, run, verdict: left(root, "verdict.txt") };
    };

    const plain = judging({});
    expect(plain.run.failed, plain.run.printed).toBe(false);
    expect(plain.run.outputs.verdict).toBe("straightforward");
    expect(readFileSync(join(plain.root, "runner/judged/src/app/page.tsx"), "utf8"), "the pushed files were written out").toBe(
      "export default function Page() {}\n",
    );
    expect(git(plain.repo, "rev-parse", "HEAD"), "main's working tree moved").toBe(git(plain.repo, "rev-parse", "main"));
    expect(git(plain.repo, "cat-file", "-t", plain.pushed)).toBe("commit");

    const askedFor = judging({ classification: `{"needs_review": true, "reasons": ["It is risky."]}` });
    expect(askedFor.run.outputs.verdict).toBe("review");
    expect(askedFor.verdict).toContain("The classifier asked for a review.");

    const found = judging({
      findings: `[{"review": "bug", "severity": "Nit", "file": "a.ts", "line": 1, "title": "t", "detail": "d"}]`,
    });
    expect(found.run.outputs.verdict).toBe("review");
    expect(found.verdict).toContain("The reviews left 1 finding open.");

    expect(judging({ path: ".github/workflows/build.yml" }).run.outputs.verdict).toBe("review");
    const attributes = judging({ extra: "* -diff\n" });
    expect(attributes.run.outputs.verdict).toBe("review");
    expect(attributes.verdict).toContain("`.gitattributes` sets how git reads files, so it always needs review.");

    for (const [name, refused] of [
      ["a build pushed onto a commit that isn't on main", { offMain: true }],
      ["a pushed commit that isn't one commit on top of main", { between: true }],
      ["a review with no verdict from the classifier", { classification: null }],
      ["a change that isn't the one named", { swap: (root: string) => put(join(root, "records/change/message.md"), "Else\n") }],
      ["findings that aren't the ones named", { swap: (root: string) => put(join(root, "records/review/findings.json"), "[] ") }],
    ] as const) {
      const judged = judging(refused);
      expect(judged.run.failed, `${name} was judged`).toBe(true);
      expect(judged.run.outputs.verdict, name).toBeUndefined();
    }
    // Without the classifier's verdict, the rule isn't applied at all.
    const unclassified = judging({ classification: null });
    expect(unclassified.run.printed).toContain("left no verdict from the classifier");
    expect(unclassified.verdict).toBe("");
  });

  // The pictures' rows come from an artifact, so they're checked again before main's script writes
  // them into the description.
  it.runIf(canRehearse)("writes the description with the verdict, from main's script", () => {
    const describe = stepWithId(jobs().find, "describe");
    expect(describe.run).toContain(".github/pull-request-body.sh");
    const describingWith = (pictures: string) => {
      const root = scratch();
      const repo = join(root, "repo");
      put(
        join(repo, ".github/pull-request-body.sh"),
        readFileSync(join(__dirname, "../.github/pull-request-body.sh"), "utf8"),
      );
      chmodSync(join(repo, ".github/pull-request-body.sh"), 0o755);
      put(join(root, "runner/change/message.md"), "Add a line\n");
      put(join(root, "runner/review/findings.json"), "[]");
      put(join(root, "runner/verdict.txt"), "straightforward\nNo review rule matched this change.\n");
      put(join(root, "runner/pull-request/pictures.txt"), pictures);
      put(join(root, "runner/pull-request/pictures-left-out.txt"), "");
      const run = rehearse(describe.run ?? "", {
        root,
        cwd: repo,
        env: {
          ATTEMPT: "2",
          BUILD_RUN: "1234",
          CHECKED: checked,
          ISSUE: "125",
          CHANGE_DIR: join(root, "runner/change"),
          REVIEW_DIR: join(root, "runner/review"),
          PICTURES: join(root, "runner/pull-request/pictures.txt"),
          PICTURES_LEFT_OUT: join(root, "runner/pull-request/pictures-left-out.txt"),
          VERDICT: join(root, "runner/verdict.txt"),
          CHANGE_DIGEST: changeDigest,
          REVIEW_DIGEST: reviewDigest,
          RECORD_DIGEST: "33".repeat(32),
        },
      });
      return { root, run };
    };
    expect(describe.env).toMatchObject({
      CHANGE_DIGEST: "${{ steps.find.outputs.change }}",
      REVIEW_DIGEST: "${{ steps.find.outputs.review }}",
      RECORD_DIGEST: "${{ steps.find.outputs.record }}",
    });

    const good = describingWith("/acme/dinners|visitor|desktop|before/0.png|after/0.png\n/settings|owner|phone||after/1.gif\n");
    expect(good.run.failed, good.run.printed).toBe(false);
    const body = left(good.root, "judged-record/pull-request.md");
    expect(body.split("\n")[0], "the description no longer names the records' digests").toBe(markerFor("33".repeat(32)));
    expect(body).toContain("Set to merge by itself");
    expect(body).toContain("issue-125/attempt-2/after/1.gif");
    const merge = left(good.root, "judged-record/merge.md");
    expect(merge).toContain("- No review rule matched this change.");
    expect(merge).toContain("Revert");

    for (const row of [
      "/acme/dinners|visitor|desktop|../before.png|after.png",
      "/acme/dinners|stranger|desktop|before.png|after.png",
      "/acme/dinners|visitor|tablet|before.png|after.png",
      "acme/dinners|visitor|desktop|before.png|after.png",
      "/acme/`dinners`|visitor|desktop|before.png|after.png",
      "/acme/dinners|visitor|desktop|before.png",
    ]) {
      const bad = describingWith(`${row}\n`);
      expect(bad.run.failed, `the row ${row} was written`).toBe(true);
      expect(left(bad.root, "judged-record/pull-request.md")).toBe("");
    }
  });

  // If CI failed, the land job starts retry-a-build with CI's run, whose failed log retry.yml reads,
  // and the digest of the issue as labelled, from the build's record.
  it.runIf(canRehearse)("starts retry-a-build when CI fails", () => {
    const retry = stepWithId(jobs().land, "retry");
    expect(retry.if).toBe("env.CI == 'failed'");
    expect(jobs().land.env?.ASKED).toBe("${{ needs.find.outputs.asked }}");
    const run = rehearse(retry.run ?? "", {
      root: scratch(),
      env: { ISSUE: "125", ATTEMPT: "2", REQUESTED_BY: "the-owner", CI_RUN: "777", ASKED: asked },
      answers: `  "workflow run retry.yml "*) : ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    expect(run.calls.trim()).toBe(
      `workflow run retry.yml --repo owner/repo --ref main -f issue=125 -f attempt=2 -f requested_by=the-owner -f run=777 -f asked=${asked}`,
    );
  });

  // CI passed on the commit it ran on, so the land job checks the pull request is still open at that
  // commit before it edits the description, asks for review or sets the merge, and if it has moved
  // on, leaves it to the newer CI result.
  it.runIf(canRehearse)("acts only while the pull request is still at the commit CI ran on", () => {
    const check = stepWithId(jobs().land, "head");
    const all = steps(jobs().land);
    expect(all.indexOf(check)).toBeLessThan(all.findIndex((each) => each.id === "describe"));
    for (const id of ["app", "describe", "reviewer", "merge"])
      expect(stepWithId(jobs().land, id).if, `${id} acts on a pull request that moved on`).toContain(
        "steps.head.outputs.current == 'true'",
      );
    expect(stepWithId(jobs().land, "status").if).toContain("steps.head.outputs.current != 'false'");
    const checking = (pull: string) =>
      rehearse(check.run ?? "", {
        root: scratch(),
        env: { PR_NUMBER: "140", HEAD_SHA: head },
        answers: `  "api repos/owner/repo/pulls/140") answer <<< '${pull}' ;;`,
      });
    const current = checking(JSON.stringify({ state: "open", head: { sha: head } }));
    expect(current.failed, current.printed).toBe(false);
    expect(current.outputs.current).toBe("true");
    for (const pull of [{ state: "open", head: { sha: base } }, { state: "closed", head: { sha: head } }]) {
      const moved = checking(JSON.stringify(pull));
      expect(moved.failed, moved.printed).toBe(false);
      expect(moved.outputs.current, JSON.stringify(pull)).toBe("false");
    }
  });

  // CI has already passed, so GitHub may refuse to set a merge that could happen now. Then it merges
  // now instead. Either way it's only the commit that CI and the rule saw.
  it.runIf(canRehearse)("sets a straightforward change to merge, only at the commit CI and the rule saw", () => {
    const merge = stepWithId(jobs().land, "merge");
    expect(merge.if).toContain("env.VERDICT == 'straightforward'");
    const root = scratch();
    put(join(root, "runner/judged/merge.md"), "Merges by itself.\n");
    const run = rehearse(merge.run ?? "", {
      root,
      env: { PR_NUMBER: "140", HEAD_SHA: head },
      answers: `
  "pr merge 140 "*"--auto"*) exit 1 ;;
  "pr merge 140 "*) : ;;`,
    });
    expect(run.failed, run.printed).toBe(false);
    const merges = run.calls.split("\n").filter((line) => line.startsWith("pr merge"));
    expect(merges).toHaveLength(2);
    for (const each of merges) expect(each).toContain(`--match-head-commit ${head}`);
    const review = stepWithId(jobs().land, "reviewer");
    expect(review.if).toContain("env.VERDICT == 'review'");
    expect(review.env?.GH_TOKEN).toBe("${{ github.token }}");
  });

  // The app's token goes only to the steps that write the verdict into the description and set the
  // merge. Review requests, comments and the retry use the Actions token.
  it("gives the app's token only to the steps that edit the description and set the merge", () => {
    expect(
      steps(jobs().land)
        .filter((each) => each.env?.GH_TOKEN === "${{ steps.app.outputs.token }}")
        .map((each) => each.id),
    ).toEqual(["describe", "merge"]);
    expect(JSON.stringify(jobs().find)).not.toMatch(/FACTORY_APP|steps\.app\./);
  });

  // Once CI has passed, the status comment says whether the change merges by itself or waits for a
  // review. If the rule couldn't be applied, it says so in a new comment too.
  it.runIf(canRehearse)("edits the build's status once CI has passed", () => {
    const status = stepWithId(jobs().land, "status").run ?? "";
    const answers = `
  "api --paginate repos/owner/repo/issues/125/comments"*) answer <<< '[{"id": 9, "user": {"login": "github-actions[bot]"}, "body": "<!-- factory-status -->\\nOpened"}]' ;;
  "api -X PATCH repos/owner/repo/issues/comments/9"*) : ;;
  "issue comment 125 "*) : ;;`;
    const env = { ISSUE: "125", PR_NUMBER: "140" };
    const merging = rehearse(status, {
      root: scratch(),
      env: { ...env, JOB_STATUS: "success", JUDGED: "success", VERDICT: "straightforward" },
      answers,
    });
    expect(merging.failed, merging.printed).toBe(false);
    expect(String(merging.inputs[0]?.body)).toContain("which merges by itself");
    expect(merging.calls).not.toContain("issue comment");

    const unjudged = rehearse(status, {
      root: scratch(),
      env: { ...env, JOB_STATUS: "success", JUDGED: "failure", VERDICT: "" },
      answers,
    });
    expect(unjudged.failed, unjudged.printed).toBe(false);
    expect(String(unjudged.inputs[0]?.body)).toContain("The build failed");
    expect(unjudged.calls).toContain("issue comment 125 ");
  });
});

describe("retry.yml", () => {
  // Read in each test, so that a missing retry.yml fails these tests and no others.
  const workflow = () => readWorkflow("retry.yml");
  const retry = () => workflow().jobs.retry;

  // build.yml and land.yml start it by dispatch with the Actions token. It checks out nothing and
  // runs only gh, so it runs nothing from the change.
  it("runs only gh, and keeps why the try failed for the next one", () => {
    expect(Object.keys(workflow().on ?? {})).toEqual(["workflow_dispatch"]);
    expect(steps(retry()).map((each) => each.uses).filter(Boolean)).toEqual(["actions/upload-artifact@v4"]);
    expect(steps(retry()).find((each) => each.uses)?.with).toEqual({
      name: "failed",
      path: "${{ runner.temp }}/failed",
    });
  });

  const failedRun = "777";
  function bringing({
    run,
    artifacts = {},
    env = {},
  }: {
    run: string;
    artifacts?: Record<string, Record<string, string>>;
    env?: Record<string, string>;
  }) {
    const root = scratch();
    let downloads = "";
    for (const [name, files] of Object.entries(artifacts)) {
      for (const [file, text] of Object.entries(files)) put(join(root, "artifacts", name, file), text);
      downloads += `
  "run download ${failedRun} --repo owner/repo -n ${name} "*) mkdir -p "$download"; cp -r "$ARTIFACTS/${name}/." "$download/" ;;`;
    }
    const ran = rehearse(stepWithId(retry(), "bring").run ?? "", {
      root,
      env: {
        ISSUE: "125",
        ATTEMPT: "2",
        REQUESTED_BY: "the-owner",
        FAILED_RUN: failedRun,
        ARTIFACTS: join(root, "artifacts"),
        ...env,
      },
      answers: `
  "api repos/owner/repo/actions/runs/${failedRun}") answer <<< '${run}' ;;
  "api repos/owner/repo/actions/workflows/build.yml"*) answer <<< '{"id": 22}' ;;
  "api repos/owner/repo/actions/workflows/ci.yml"*) answer <<< '{"id": 44}' ;;
  "run view ${failedRun} "*) printf 'test\\tnpm test\\tFAIL test/page.test.tsx\\n' ;;${downloads}`,
    });
    return {
      run: ran,
      reason: left(root, "failed/reason.txt"),
      failed: left(root, "failed/failed.md"),
      message: left(root, "failed/message.md"),
    };
  }
  const build = `{"workflow_id": 22, "head_branch": "main", "event": "issues", "display_title": "Build of issue 125, try 2"}`;
  const patch = { "change.patch": "diff --git a/a b/a\n" };

  // The CI run must be CI's on a push to the issue's branch in this repository, as land.yml passes on.
  it.runIf(canRehearse)("brings in why CI failed on the build's pull request", () => {
    const ciRun = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        workflow_id: 44,
        head_branch: "build/issue-125",
        event: "push",
        head_repository: { full_name: "owner/repo" },
        ...overrides,
      });
    const ci = bringing({ run: ciRun() });
    expect(ci.run.failed, ci.run.printed).toBe(false);
    expect(ci.run.outputs.outcome).toBe("retry");
    expect(ci.reason).toBe("CI failed on the pull request.\n");
    expect(ci.failed).toContain("The end of the failing output:");
    expect(ci.failed).toContain("FAIL test/page.test.tsx");

    for (const [name, run] of [
      ["CI on another issue's branch", ciRun({ head_branch: "build/issue-126" })],
      ["CI on a pull request", ciRun({ event: "pull_request" })],
      ["CI from a fork", ciRun({ head_repository: { full_name: "someone/repo" } })],
    ]) {
      const elsewhere = bringing({ run });
      expect(elsewhere.run.failed, `${name} was read`).toBe(true);
      expect(elsewhere.run.calls, name).not.toContain("run view");
    }
  });

  // What a try's records say reaches the issue and the next draft, so the first line of a result,
  // the findings and Claude's message can't hide the rest of a comment, take over the build's status
  // comment, or mention anyone. The failing output stays as it was, inside its fence, but without
  // the status comment's mark.
  it.runIf(canRehearse)("keeps a try's records from hiding text, taking the status or mentioning anyone", () => {
    const marked = "<!-- factory-status -->";
    const checked = bringing({
      run: build,
      artifacts: {
        change: patch,
        result: {
          "result.txt": `The tests did not pass. ${marked} @the-owner <b>now</b>\n`,
          "output.txt": `FAIL ${marked} @the-owner\n`,
        },
      },
    });
    expect(checked.run.failed, checked.run.printed).toBe(false);
    expect(checked.reason).toBe("The tests did not pass.  @\u200bthe-owner &lt;b>now&lt;/b>\n");
    expect(checked.failed).not.toContain(marked);
    expect(checked.failed).toContain("FAIL  @the-owner");

    const reviewed = bringing({
      run: build,
      artifacts: {
        change: patch,
        result: { "result.txt": "pass\n" },
        review: {
          "result.txt": "The reviews found 1 Important finding.\n",
          "findings.json": `[{"review": "bug", "severity": "Important", "file": "a.ts", "line": 1, "title": "Ask @acme/team ${marked}", "detail": "<!-- hidden\\nline"}]`,
        },
      },
    });
    expect(reviewed.failed).not.toContain(marked);
    expect(reviewed.failed).not.toContain("<!--");
    expect(reviewed.failed).toContain("@\u200bacme/team");

    const asked = bringing({
      run: build,
      artifacts: { change: { "change.patch": "", "message.md": `Split it or cut it?\n\n- Split, @the-owner ${marked}\n` } },
    });
    expect(asked.message).toBe("Split it or cut it?\n\n- Split, @\u200bthe-owner \n");
  });

  it.runIf(canRehearse)("brings in why a build failed, from its own records", () => {
    const draft = bringing({ run: build });
    expect(draft.run.failed, draft.run.printed).toBe(false);
    expect(draft.reason).toBe("The draft failed or ran out of time.\n");

    const nothing = bringing({
      run: build,
      artifacts: { change: { "change.patch": "", "message.md": "Which example should go?\n" } },
    });
    expect(nothing.run.outputs.outcome).toBe("nothing");
    expect(nothing.reason).toBe("Claude changed nothing.\n");
    expect(nothing.message).toBe("Which example should go?\n");

    const check = bringing({
      run: build,
      artifacts: {
        change: patch,
        result: { "result.txt": "The tests did not pass.\n", "output.txt": "FAIL test/page.test.tsx\n" },
      },
    });
    expect(check.run.outputs.outcome).toBe("retry");
    expect(check.reason).toBe("The tests did not pass.\n");
    expect(check.failed).toContain("FAIL test/page.test.tsx");

    const reviews = bringing({
      run: build,
      artifacts: {
        change: patch,
        result: { "result.txt": "pass\n" },
        review: {
          "result.txt": "The reviews found 1 Important finding.\n",
          "findings.json": `[{"review": "security", "severity": "Important", "file": "src/server/viewer.ts", "line": 4, "title": "A private workflow leaks", "detail": "A stranger sees its title."}]`,
        },
      },
    });
    expect(reviews.reason).toBe("The reviews found 1 Important finding.\n");
    expect(reviews.failed).toContain("What the reviews found:");
    expect(reviews.failed).toContain(
      "- Important, from the security review, in src/server/viewer.ts:4: A private workflow leaks",
    );

    const moved = bringing({
      run: build,
      artifacts: {
        change: patch,
        result: { "result.txt": "pass\n" },
        review: { "result.txt": "pass\n", "findings.json": "[]" },
        open: { "result.txt": "The change no longer applies to main as it is now.\n", "output.txt": "error: patch failed\n" },
      },
    });
    expect(moved.reason).toBe("The change no longer applies to main as it is now.\n");
    expect(moved.failed).toContain("error: patch failed");
  });

  it.runIf(canRehearse)("reads only this issue's build or CI, and only a login as who asked", () => {
    for (const [name, brought] of [
      ["the build of another try", { run: build.replace("try 2", "try 1") }],
      ["the build from a branch", { run: build.replace('"main"', '"a-branch"') }],
      ["another workflow's run", { run: `{"workflow_id": 55, "head_branch": "main"}` }],
      ["an odd login", { run: build, env: { REQUESTED_BY: "a b" } }],
      ["an attempt past three", { run: build, env: { ATTEMPT: "4" } }],
      ["a digest of the issue that isn't one", { run: build, env: { ASKED: "main" } }],
    ] as const) {
      const wrong = bringing(brought);
      expect(wrong.run.failed, `retry.yml read ${name}`).toBe(true);
      expect(wrong.run.calls, name).not.toContain("run download");
    }
  });

  // Fewer than three tries: start the build again, which reads why from this run. Three, or a draft
  // that changed nothing: comment on the issue with why, and edit the status comment.
  it.runIf(canRehearse)("starts the build again, or says on the issue why it stopped", () => {
    const again = stepWithId(retry(), "again").run ?? "";
    const answers = `
  "workflow run build.yml "*) : ;;
  "issue comment 125 "*) : ;;
  "api --paginate repos/owner/repo/issues/125/comments"*) answer <<< '[{"id": 9, "user": {"login": "github-actions[bot]"}, "body": "<!-- factory-status -->\\nBuilding"}]' ;;
  "api -X PATCH repos/owner/repo/issues/comments/9"*) : ;;`;
    const deciding = (attempt: string, outcome: string) => {
      const root = scratch();
      put(join(root, "runner/failed/reason.txt"), "The tests did not pass.\n");
      put(join(root, "runner/failed/failed.md"), "The tests did not pass.\n\nThe end of the failing output:\n\nFAIL\n");
      put(join(root, "runner/failed/message.md"), "Should the dinners example be split or cut?\n");
      return rehearse(again, {
        root,
        env: { ISSUE: "125", ATTEMPT: attempt, REQUESTED_BY: "the-owner", OUTCOME: outcome, ASKED: "aa".repeat(32) },
        answers,
      });
    };

    const retrying = deciding("1", "retry");
    expect(retrying.failed, retrying.printed).toBe(false);
    expect(retrying.calls.trim()).toBe(
      `workflow run build.yml --repo owner/repo --ref main -f issue=125 -f attempt=2 -f previous_run=1000 -f requested_by=the-owner -f asked=${"aa".repeat(32)}`,
    );

    const stopped = deciding("3", "retry");
    expect(stopped.failed, stopped.printed).toBe(false);
    expect(stopped.calls).not.toContain("workflow run");
    expect(stopped.calls).toContain("The build failed three times, so it has stopped.");
    expect(stopped.calls).toContain("The last try failed because: The tests did not pass.");
    expect(String(stopped.inputs[0]?.body)).toContain("<!-- factory-status -->");

    const asked = deciding("1", "nothing");
    expect(asked.failed, asked.printed).toBe(false);
    expect(asked.calls).not.toContain("workflow run");
    expect(asked.calls).toContain("Should the dinners example be split or cut?");
    expect(String(asked.inputs[0]?.body)).toContain("The build changed nothing");
  });
});

// Security properties every factory workflow keeps.
describe("the factory's security", () => {
  // Each job holds exactly the permissions it needs.
  const permissions: Record<string, Record<string, Record<string, string>>> = {
    "build.yml": {
      start: { actions: "read", issues: "write" },
      draft: { actions: "read", contents: "read", issues: "read" },
      check: { contents: "read" },
      review: { contents: "read" },
      pictures: { contents: "read" },
      open: { contents: "read", issues: "write" },
      retry: { actions: "write" },
    },
    "land.yml": {
      find: { actions: "read", contents: "read", "pull-requests": "read" },
      land: { actions: "write", issues: "write", "pull-requests": "write" },
    },
    "retry.yml": { retry: { actions: "write", issues: "write" } },
  };
  it.each(Object.keys(permissions))("gives each job in %s only the permissions it needs", (file) => {
    const jobs = readJobs(file);
    expect(Object.keys(jobs).sort()).toEqual(Object.keys(permissions[file]).sort());
    for (const [name, want] of Object.entries(permissions[file]))
      expect(jobs[name].permissions, `${file}'s ${name}`).toEqual(want);
  });

  // A job that runs Claude, or installs, builds or tests the change, holds no token that can write:
  // no write permission and no token of the app's.
  it("never gives a token that can write to a job that runs Claude or the change's code", () => {
    let found = 0;
    for (const file of workflowFiles) {
      for (const [name, job] of Object.entries(readJobs(file))) {
        const runsTheChange = steps(job).some(
          (each) =>
            (each.env !== undefined && "CLAUDE_CODE_OAUTH_TOKEN" in each.env) ||
            /\bclaude -p\b|\bnpm (ci|install|run|test)\b|\bnpx\b|picture-pages\.sh/.test(each.run ?? ""),
        );
        if (!runsTheChange) continue;
        found++;
        expect(writes(job), `${file}'s ${name}`).toEqual([]);
        expect(JSON.stringify(job), `${file}'s ${name} holds the app's token`).not.toMatch(
          /create-github-app-token|FACTORY_APP|steps\.app\./,
        );
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  // The app's token is made for this repository alone.
  it("makes the app's token for this repository alone", () => {
    let made = 0;
    for (const file of workflowFiles)
      for (const [name, job] of Object.entries(readJobs(file)))
        for (const each of steps(job)) {
          if (!each.uses?.startsWith("actions/create-github-app-token")) continue;
          made++;
          expect(each.with?.owner, `${file}'s ${name}`).toBe("${{ github.repository_owner }}");
          expect(each.with?.repositories, `${file}'s ${name}`).toBe("${{ github.event.repository.name }}");
        }
    expect(made).toBeGreaterThan(0);
  });

  // GitHub runs a pull_request_target or workflow_run workflow from main's copy, with main's
  // secrets, so none checks out or runs the branch it's about. Only land.yml's judge fetches
  // anything: the commit CI ran on, into git's store, whose tree it reads into an index without
  // writing a file of it.
  it("never checks out the branch in a workflow that holds main's secrets", () => {
    let privileged = 0;
    for (const file of workflowFiles) {
      const { on, jobs } = readWorkflow(file);
      if (!("pull_request_target" in (on ?? {})) && !("workflow_run" in (on ?? {}))) continue;
      privileged++;
      for (const [name, job] of Object.entries(jobs))
        for (const each of steps(job)) {
          const where = `${file}'s ${name} step "${each.name ?? each.uses}"`;
          if (each.uses?.startsWith(`actions/${CLONE}`)) {
            expect(["main", "${{ github.sha }}"], where).toContain(each.with?.ref);
            expect(each.with?.repository, where).toBeUndefined();
          }
          for (const value of Object.values(each.with ?? {}))
            expect(String(value), where).not.toMatch(/pull_request\.head|workflow_run\.head/);
          for (const line of (each.run ?? "").split("\n")) {
            for (const from of ["git pull", "refs/pull/", `gh pr ${CLONE}`, "read-tree -u", "read-tree --reset", "reset --hard"])
              expect(line, where).not.toContain(from);
            if (new RegExp(`\\b(${CLONE}|switch|worktree add)\\b`).test(line)) expect(line, where).not.toContain("HEAD_SHA");
          }
          const fetches = (each.run ?? "").split("\n").filter((line) => /\bfetch\b/.test(line));
          if (file === "land.yml" && each.id === "judge") {
            expect(fetches).toHaveLength(1);
            expect(fetches[0]).toMatch(/fetch --no-tags origin "\$HEAD_SHA"$/);
            expect(each.run).toContain('read-tree "$HEAD_SHA"');
          } else expect(fetches, `${where} fetches`).toEqual([]);
        }
    }
    expect(privileged).toBe(2);
  });

  // Event, issue, log, Claude and artifact text reaches a script only through env:, quoted, so it
  // can't run as code.
  it("never expands an expression in a script", () => {
    for (const file of workflowFiles)
      for (const [name, job] of Object.entries(readJobs(file)))
        for (const each of steps(job))
          expect(each.run ?? "", `${file}'s ${name} step "${each.name}"`).not.toContain("${{");
  });

  // A job that runs another branch's code from main's workflow would save npm's cache where every
  // later run on main restores it, so none of the factory's jobs saves or restores it: setup-node
  // is given no cache, and none from the package manager named in package.json either.
  it("saves and restores no npm cache in the factory's jobs", () => {
    let set = 0;
    for (const file of ["build.yml", "land.yml", "resolve.yml", "review.yml"])
      for (const [name, job] of Object.entries(readJobs(file)))
        for (const each of steps(job))
          if (each.uses?.startsWith("actions/setup-node")) {
            set++;
            expect(each.with?.cache, `${file}'s ${name} uses npm's cache`).toBeUndefined();
            expect(each.with?.["package-manager-cache"], `${file}'s ${name} may use npm's cache`).toBe(false);
          }
    expect(set).toBeGreaterThan(0);
  });
});
