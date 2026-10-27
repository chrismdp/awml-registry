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

  // The reviews' findings and the classifier's verdict are files the build's review job wrote. A
  // finding about code the change didn't write is shown, but leaves the change straightforward.
  it.each([
    ["an Important finding", `[{"severity": "Important"}]`, true, "The reviews left 1 finding open."],
    ["a Nit and an Important finding", `[{"severity": "Nit"}, {"severity": "Important"}]`, true, "The reviews left 2 findings open."],
    ["only a pre-existing finding", `[{"severity": "Pre-existing"}]`, false, "No review rule matched this change."],
    ["no findings", "[]", false, "No review rule matched this change."],
  ])("weighs %s", (_, findings, review, reason) => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");
    const path = join(tempDir(), "findings.json");
    writeFileSync(path, findings);

    expectVerdict(evaluate(repo, plain, { findings: path }), review, reason);
  });

  it("sends a change to review when the classifier asks", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");
    const path = join(tempDir(), "classification.json");
    writeFileSync(path, `{"needs_review": true, "reasons": ["It changes who may see a private workflow."]}`);

    expectVerdict(evaluate(repo, plain, { classification: path }), true, "The classifier asked for a review.");
  });

  // The classifier can add a review, never skip one.
  it("keeps a review the rules require when the classifier finds the change low risk", () => {
    const repo = newRepo();
    stage(repo, "docs/SPEC.md", "changed\n");
    const path = join(tempDir(), "classification.json");
    writeFileSync(path, `{"needs_review": false, "reasons": ["It is a small fix."]}`);

    expectVerdict(
      evaluate(repo, { reviewPaths: ["docs/SPEC.md"], maxChangedLines: 400 }, { classification: path }),
      true,
      "`docs/SPEC.md` is a path that always needs review.",
    );
  });

  it("adds nothing when the classifier finds the change low risk", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");
    const path = join(tempDir(), "classification.json");
    writeFileSync(path, `{"needs_review": false, "reasons": ["It is a small fix."]}`);

    expectVerdict(evaluate(repo, plain, { classification: path }), false, "No review rule matched this change.");
  });

  it.each([
    ["an unknown severity", { findings: `[{"severity": "Minor"}]` }],
    ["findings that aren't a list", { findings: `{"severity": "Nit"}` }],
    ["a finding that isn't an object", { findings: `["Nit"]` }],
    ["findings that aren't JSON", { findings: "Nit" }],
    ["a missing findings file", { findings: undefined }],
    ["a verdict without needs_review", { classification: `{"reasons": []}` }],
    ["a needs_review that isn't true or false", { classification: `{"needs_review": "yes"}` }],
    ["a missing classification file", { classification: undefined }],
  ])("refuses %s", (_, files: { findings?: string; classification?: string }) => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");
    const dir = tempDir();
    const records: { findings?: string; classification?: string } = {};
    for (const name of ["findings", "classification"] as const) {
      if (!(name in files)) continue;
      records[name] = join(dir, `${name}.json`);
      const text = files[name];
      if (text !== undefined) writeFileSync(records[name], text);
    }

    expect(() => evaluate(repo, plain, records)).toThrow();
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
    if (review) expect(got.reasons).toContain(`\`${path}\` is a path that always needs review.`);
  });

  it.each(["test/thing.test.ts", "test/page.test.tsx", "eslint-rules/rule.test.mjs"])(
    "sends a change that deletes the test file %s to review",
    (path) => {
      const repo = newRepo();
      stage(repo, path, "it('works', () => {});\n");
      commit(repo);
      git(repo, "rm", "-q", "--", path);

      expectVerdict(evaluate(repo, plain), true, `\`${path}\` deletes a test file.`);
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

    expectVerdict(evaluate(repo, plain), true, "`test/thing.test.ts` removes a test.");
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

  // A change's own .gitattributes can tell git a file is binary, which would hide its lines from the
  // count and its removed tests from the rule. So the rule reads no attributes from the change, and
  // a change to any .gitattributes always needs review.
  it.each([".gitattributes", "src/.gitattributes"])("sends a change to %s to review", (path) => {
    const repo = newRepo();
    stage(repo, path, "*.ts text\n");

    expectVerdict(evaluate(repo, plain), true, `\`${path}\` sets how git reads files, so it always needs review.`);
  });

  it("counts the lines of files the change's attributes call binary", () => {
    const repo = newRepo();
    stage(repo, "large.txt", numberedLines("old", 201));
    commit(repo);
    stage(repo, "large.txt", numberedLines("new", 201));
    stage(repo, ".gitattributes", "* -diff\n");

    const got = evaluate(repo, plain);
    expect(got.review).toBe(true);
    expect(got.reasons).toContain("The patch changes 403 lines, more than the limit of 400.");
  });

  it("finds a removed test that the change's attributes call binary", () => {
    const repo = newRepo();
    stage(repo, "test/thing.test.ts", 'it("stays", () => {});\nit("goes", () => {});\n');
    commit(repo);
    stage(repo, "test/thing.test.ts", 'it("stays", () => {});\n');
    stage(repo, ".gitattributes", "*.ts binary\n");

    expectVerdict(evaluate(repo, plain), true, "`test/thing.test.ts` removes a test.");
  });

  // A file git still finds binary, by a NUL byte in it, can't be counted or read, so it needs review,
  // unless it's an image or a font.
  it("sends a change to a binary file other than an image or a font to review", () => {
    const repo = newRepo();
    stage(repo, "src/server/hidden.ts", "export const a = 1;\u0000\n");
    stage(repo, "public/logo.png", "\u0089PNG\u0000pixels");
    stage(repo, "src/fonts/Inter.woff2", "wOF2\u0000glyphs");

    const got = evaluate(repo, plain);
    expect(got.review).toBe(true);
    expect(got.reasons).toEqual(["`src/server/hidden.ts` is binary, so the rule can't count or read it."]);
  });

  it("lets an image or a font through without review", () => {
    const repo = newRepo();
    stage(repo, "public/logo.png", "\u0089PNG\u0000pixels");

    expectVerdict(evaluate(repo, plain), false, "No review rule matched this change.");
  });

  // A path's name reaches the pull request's description, so it's shown in a code span with nothing
  // in it that could end the span or the line.
  it("shows a path so its name can't break out of its reason", () => {
    const repo = newRepo();
    stage(repo, "docs/a`b\n## Approved <!--.md", "changed\n");

    const got = evaluate(repo, { reviewPaths: ["docs/"], maxChangedLines: 400 });
    expect(got.reasons).toEqual(["`docs/a\\u0060b\\n## Approved <!--.md` is a path that always needs review."]);
    for (const reason of got.reasons) expect(reason).not.toContain("\n");
  });
});
