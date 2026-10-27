import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  steps?: Step[];
};

type Workflow = { on?: Record<string, unknown>; jobs: Record<string, Job> };

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

// The workflows every check of Claude's steps must find a Claude step in.
const claudeWorkflows = ["build.yml", "resolve.yml", "review.yml"];

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
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) query="$2"; shift ;;
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

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
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
  };
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
  const jobs = readJobs("build.yml");

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
    for (const name of ["draft", "check"]) {
      expect(writes(jobs[name]), `${name} should only read`).toEqual([]);
    }
  });

  // The jobs that end a build edit the same status comment, to say how it ended.
  it("edits its status when it ends", () => {
    for (const name of ["open", "retry"]) {
      expect(
        runs(jobs[name]),
        `${name} doesn't edit the status comment`,
      ).toContain("<!-- factory-status -->");
      expect(
        jobs[name].permissions?.issues,
        `${name} can't write to issues`,
      ).toBe("write");
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
  // environment holds the login token, and runs nothing but git's reads. A bare Read, Glob or Grep
  // would approve a read anywhere.
  it("starts both reviews side by side, reading only the tree and their folder", () => {
    const sessions = steps(jobs().review).filter((each) =>
      /\bclaude -p\b/.test(each.run ?? ""),
    );
    expect(sessions).toHaveLength(1);
    const [reviews] = sessions;
    const script = reviews.run ?? "";
    for (const want of [
      "review-bugs-prompt.md &",
      "review-security-prompt.md &",
      "wait",
      `"Read(./**)"`,
      `"Read(/$REVIEW_DIR/**)"`,
      `--disallowedTools "Read(//proc/**)"`,
    ])
      expect(script).toContain(want);
    for (const bare of [`"Read"`, `"Glob"`, `"Grep"`]) expect(script).not.toContain(bare);
    expect(script.match(/"Bash\([^"]*\)"/g)).toEqual([
      `"Bash(git diff:*)"`,
      `"Bash(git log:*)"`,
      `"Bash(git show:*)"`,
      `"Bash(git status:*)"`,
    ]);
    expect(reviews.env?.REVIEW_DIR).toBe("${{ runner.temp }}/review");
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
  // tells the reviewers which binary files changed, rather than failing and posting no checks.
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
    const told = readIfThere(join(root, "runner/review/pull-request.md"));
    for (const path of ["logo.png", "fonts/Registry.ttf", "vendor/awml/old.png"])
      expect(told, `the reviewers aren't told that ${path} changed`).toContain(`\n- ${path}\n`);
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
      for (const [script, dir] of [
        [keep, "review"],
        [post, "findings"],
      ]) {
        const root = scratch();
        put(join(root, "runner", dir, "bugs.json"), `[${finding}]`);
        put(join(root, "runner", dir, "security.json"), "[]");
        const run = rehearse(script, {
          root,
          env: { HEAD_SHA: "ab".repeat(20), UNREAD: "0" },
          answers: posted,
        });
        expect(run.failed, `the ${dir} step let through ${finding}`).toBe(true);
        expect(run.inputs).toEqual([]);
        expect(run.printed).not.toContain(token);
        expect(run.printed).not.toContain(body);
      }
    }
    const root = scratch();
    put(
      join(root, "runner/review/bugs.json"),
      `[{"severity": "Nit", "file": "a.ts", "line": 1, "title": "A name", "detail": "A detail."}]`,
    );
    put(join(root, "runner/review/security.json"), "[]");
    const clean = rehearse(keep, { root });
    expect(clean.failed, clean.printed).toBe(false);
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
    for (const file of claudeWorkflows)
      expect(holders[file] ?? 0, `no step in ${file} runs Claude Code with its token`).toBeGreaterThan(0);
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
    for (const file of claudeWorkflows)
      expect(checked[file] ?? 0, `no step in ${file} holds the Claude token`).toBeGreaterThan(0);
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
          checked[file] = (checked[file] ?? 0) + sessions;
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
    for (const file of claudeWorkflows)
      expect(checked[file] ?? 0, `no step in ${file} runs claude -p`).toBeGreaterThan(0);
  });
});
