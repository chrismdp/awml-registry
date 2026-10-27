import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  "continue-on-error"?: boolean;
};

type Job = {
  needs?: string | string[];
  if?: string;
  strategy?: { matrix?: Record<string, unknown> };
  permissions?: Record<string, string>;
  steps?: Step[];
};

function readJobs(file: string): Record<string, Job> {
  const text = readFileSync(
    join(__dirname, "../.github/workflows", file),
    "utf8",
  );
  return (parse(text) as { jobs: Record<string, Job> }).jobs;
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

describe("every workflow step that holds the Claude token", () => {
  it("scrubs the token from the commands Claude starts", () => {
    const dir = join(__dirname, "../.github/workflows");
    const files = readdirSync(dir).filter((file) => /\.ya?ml$/.test(file));
    let holders = 0;
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
          holders++;
          expect(
            each.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
            `${file}'s ${name} step "${each.name}" gives Claude its token without scrubbing it from Claude's commands`,
          ).toBe("1");
        }
      }
    }
    expect(holders).toBeGreaterThan(0);
  });
});
