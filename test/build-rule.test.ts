import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluate, loadConfig, readConfig, type Verdict } from "../scripts/build-rule";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "build-rule-"));
  made.push(dir);
  return dir;
}

function git(repo: string, ...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
}

function newRepo() {
  const repo = tempDir();
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  return repo;
}

function stage(repo: string, path: string, contents: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
  git(repo, "add", "--", path);
}

function commit(repo: string) {
  git(repo, "commit", "-qm", "fixture");
}

function numberedLines(prefix: string, count: number) {
  return Array.from({ length: count }, (_, n) => `${prefix} ${String(n).padStart(3, "0")}\n`).join("");
}

function expectVerdict(got: Verdict, review: boolean, reason: string) {
  expect(got.review, got.reasons.join("; ")).toBe(review);
  expect(got.reasons).toContain(reason);
}

const plain = { reviewPaths: [], maxChangedLines: 400 };

describe("the build rules file", () => {
  it("reads the review paths and the line limit", () => {
    const path = join(tempDir(), "rules.yml");
    writeFileSync(path, "# A comment.\nreview_paths: [docs/SPEC.md, .github/]\nmax_changed_lines: 400\n");

    expect(loadConfig(path)).toEqual({ reviewPaths: ["docs/SPEC.md", ".github/"], maxChangedLines: 400 });
  });

  it("refuses a setting it doesn't know, so a typo can't switch a rule off", () => {
    expect(() => readConfig("review_path: [docs/SPEC.md]\n")).toThrow(/review_path/);
  });

  it("refuses an empty review path and a negative limit", () => {
    expect(() => readConfig("review_paths: [docs/SPEC.md, ]\n")).toThrow(/empty path/);
    expect(() => readConfig("max_changed_lines: -1\n")).toThrow(/negative/);
  });

  it("reads the repository's own rules as a YAML parser does", () => {
    const text = readFileSync(join(__dirname, "../.github/build-rules.yml"), "utf8");
    const parsed = parse(text);

    expect(readConfig(text)).toEqual({
      reviewPaths: parsed.review_paths,
      maxChangedLines: parsed.max_changed_lines,
    });
  });
});

describe("judging a staged change", () => {
  it("finds a small change to ordinary code straightforward", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expectVerdict(evaluate(repo, plain), false, "No review rule matched this change.");
  });

  // The pull request quotes the note as Claude wrote it, so the reason only points to it.
  it("sends a change to review when Claude's note asks for it", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");
    const note = join(tempDir(), "review.md");
    writeFileSync(note, "- I chose the slower option.\n- The issue did not settle it.\n");

    expectVerdict(evaluate(repo, plain, note), true, "Claude asked for a review: see Claude's note.");
  });

  it("sends a change to review when Claude's note is empty", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");
    const note = join(tempDir(), "review.md");
    writeFileSync(note, "\n");

    expectVerdict(evaluate(repo, plain, note), true, "Claude asked for the maintainer's review.");
  });

  it("takes a missing note as no note", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expectVerdict(evaluate(repo, plain, join(tempDir(), "review.md")), false, "No review rule matched this change.");
  });

  it.each([
    ["an exact path", "docs/SPEC.md", true],
    ["a path under a directory", ".github/workflows/build.yml", true],
    ["a similar prefix", ".github-old/build.yml", false],
  ])("matches review paths by %s", (_, path, review) => {
    const repo = newRepo();
    stage(repo, path, "changed\n");

    const got = evaluate(repo, { reviewPaths: ["docs/SPEC.md", ".github/"], maxChangedLines: 400 });
    expect(got.review, got.reasons.join("; ")).toBe(review);
    if (review) expect(got.reasons).toContain(`${path} is a path that always needs review.`);
  });

  it.each(["test/thing.test.ts", "test/page.test.tsx", "eslint-rules/rule.test.mjs"])(
    "sends a change that deletes the test file %s to review",
    (path) => {
      const repo = newRepo();
      stage(repo, path, "it('works', () => {});\n");
      commit(repo);
      git(repo, "rm", "-q", "--", path);

      expectVerdict(evaluate(repo, plain), true, `${path} deletes a test file.`);
    },
  );

  it.each([
    ["it", "  it(\"stays\", () => {});\n  it(\"goes\", () => {});\n", "  it(\"stays\", () => {});\n"],
    ["test.each", "test(\"stays\", () => {});\ntest.each([1])(\"goes %i\", () => {});\n", "test(\"stays\", () => {});\n"],
    ["describe", "describe(\"stays\", () => {});\ndescribe(\"goes\", () => {});\n", "describe(\"stays\", () => {});\n"],
    ["a skip", "it(\"runs\", () => {});\n", "it.skip(\"runs\", () => {});\n"],
  ])("sends a change that removes a test with %s to review", (_, before, after) => {
    const repo = newRepo();
    stage(repo, "test/thing.test.ts", before);
    commit(repo);
    stage(repo, "test/thing.test.ts", after);

    expectVerdict(evaluate(repo, plain), true, "test/thing.test.ts removes a test.");
  });

  it("lets a change add a test without review", () => {
    const repo = newRepo();
    stage(repo, "test/thing.test.ts", "it(\"stays\", () => {});\n");
    commit(repo);
    stage(repo, "test/thing.test.ts", "it(\"stays\", () => {});\nit(\"arrives\", () => {});\n");

    expectVerdict(evaluate(repo, plain), false, "No review rule matched this change.");
  });

  it("counts both added and removed lines against the limit", () => {
    const repo = newRepo();
    stage(repo, "large.txt", numberedLines("old", 201));
    commit(repo);
    stage(repo, "large.txt", numberedLines("new", 201));

    expectVerdict(evaluate(repo, plain), true, "The patch changes 402 lines, more than the limit of 400.");
  });
});
