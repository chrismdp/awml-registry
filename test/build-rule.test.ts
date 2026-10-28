import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { evaluate, fixLine, loadConfig, readConfig, type Verdict } from "../scripts/build-rule";

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

function stage(repo: string, path: string, contents: string | Buffer) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
  git(repo, "add", "--", path);
}

// The first bytes of each kind of image and font the rule lets through, then a NUL byte, which
// makes git find the file binary.
const signatures: Record<string, Buffer> = {
  png: Buffer.from("89504e470d0a1a0a00", "hex"),
  gif: Buffer.from("GIF89a\u0000", "latin1"),
  jpg: Buffer.from("ffd8ffe000", "hex"),
  webp: Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"),
  ico: Buffer.from("0000010001", "hex"),
  ttf: Buffer.from("0001000000", "hex"),
  otf: Buffer.from("OTTO\u0000", "latin1"),
  woff: Buffer.from("wOFF\u0000", "latin1"),
  woff2: Buffer.from("wOF2\u0000", "latin1"),
};

function commit(repo: string) {
  git(repo, "commit", "-qm", "fixture");
}

function numberedLines(prefix: string, count: number) {
  return Array.from({ length: count }, (_, n) => `${prefix} ${String(n).padStart(3, "0")}\n`).join("");
}

function expectVerdict(got: Verdict, verdict: Verdict["verdict"], reason: string) {
  expect(got.verdict, got.reasons.join("; ")).toBe(verdict);
  expect(got.reasons).toContain(reason);
}

const plain = { reviewPaths: [], reviewNonTests: [], reviewAnywhere: [], maxChangedLines: 400 };

describe("the build rules file", () => {
  it("reads the review paths and the line limit", () => {
    const path = join(tempDir(), "rules.yml");
    writeFileSync(path, "# A comment.\nreview_paths: [docs/SPEC.md, .github/]\nmax_changed_lines: 400\n");

    expect(loadConfig(path)).toEqual({ reviewPaths: ["docs/SPEC.md", ".github/"], reviewNonTests: [], reviewAnywhere: [], maxChangedLines: 400 });
  });

  it("reads the folders whose files other than tests need review", () => {
    expect(readConfig("review_non_tests: [test/]\n").reviewNonTests).toEqual(["test/"]);
    expect(() => readConfig("review_non_tests: [test]\n")).toThrow(/folder/);
    expect(() => readConfig("review_non_tests: [test/, ]\n")).toThrow(/review_non_tests/);
    expect(() => readConfig("review_non_tests: ['test/']\n")).toThrow(/review_non_tests/);
  });

  it("refuses a setting it doesn't know, so a typo can't switch a rule off", () => {
    expect(() => readConfig("review_path: [docs/SPEC.md]\n")).toThrow(/review_path/);
  });

  it("refuses an empty review path and a negative limit", () => {
    expect(() => readConfig("review_paths: [docs/SPEC.md, ]\n")).toThrow(/empty path/);
    expect(() => readConfig("max_changed_lines: -1\n")).toThrow(/negative/);
  });

  // npm's own settings and a committed node_modules/ steer npm wherever it runs, so a change to them
  // always needs review.
  it("asks about a change to npm's settings or a committed node_modules/", () => {
    const rules = loadConfig(join(__dirname, "../.github/build-rules.yml"));
    for (const path of [".npmrc", ".yarnrc", ".yarnrc.yml", "node_modules/", "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"])
      expect(rules.reviewAnywhere).toContain(path);
    expect(rules.reviewNonTests).toEqual(["test/"]);
  });

  it("reads the repository's own rules as a YAML parser does", () => {
    const text = readFileSync(join(__dirname, "../.github/build-rules.yml"), "utf8");
    const parsed = parse(text);

    expect(readConfig(text)).toEqual({
      reviewPaths: parsed.review_paths,
      reviewNonTests: parsed.review_non_tests,
      reviewAnywhere: parsed.review_anywhere,
      maxChangedLines: parsed.max_changed_lines,
    });
  });
});

describe("judging a staged change", () => {
  // npm reads its settings, lockfiles and node_modules/ wherever a package sits, so those names are
  // asked about anywhere in the tree, a file by its name and a folder by any part of a path.
  it.each([
    ["web/.npmrc", "ask"],
    ["packages/x/package.json", "ask"],
    ["sub/node_modules/a/index.js", "ask"],
    ["yarn.lock", "ask"],
    ["src/package.json.ts", "ship"],
    ["src/my-node_modules/a.js", "ship"],
  ] as const)("gives %s the verdict %s, wherever npm reads it", (path, verdict) => {
    const repo = newRepo();
    stage(repo, path, "changed\n");

    const got = evaluate(repo, { ...plain, reviewAnywhere: ["package.json", "yarn.lock", ".npmrc", "node_modules/"] });
    expect(got.verdict, got.reasons.join("; ")).toBe(verdict);
    if (verdict === "ask") expect(got.reasons).toContain(`\`${path}\` is a name npm reads wherever it sits, so it always needs review.`);
  });

  it("reads the names asked about anywhere", () => {
    expect(readConfig("review_anywhere: [package.json, node_modules/]\n").reviewAnywhere).toEqual(["package.json", "node_modules/"]);
    expect(() => readConfig("review_anywhere: [src/package.json]\n")).toThrow(/review_anywhere/);
  });

  // A gitlink points at another repository's commit, which the rule can't read.
  it("asks about a submodule's commit", () => {
    const repo = newRepo();
    stage(repo, "README.md", "A registry\n");
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/engine`);

    expectVerdict(evaluate(repo, plain), "ask", "`vendor/engine` is another repository's commit, so it always needs review.");
  });

  // An image or a font the rule lets through unread is still asked about when it's large.
  it("asks about an image or a font over 1 MiB", () => {
    const repo = newRepo();
    stage(repo, "public/big.png", Buffer.concat([signatures.png, Buffer.alloc(1024 * 1024)]));

    expectVerdict(evaluate(repo, plain), "ask", "`public/big.png` is over 1 MiB, so it always needs review.");
  });

  it("lets an image of 1 MiB or less through", () => {
    const repo = newRepo();
    stage(repo, "public/small.png", Buffer.concat([signatures.png, Buffer.alloc(1024 * 1024 - signatures.png.length)]));

    expectVerdict(evaluate(repo, plain), "ship", "No review rule matched this change.");
  });

  // A file under a folder of tests that isn't a test itself, such as a helper or a fixture, can
  // weaken every test that uses it, so it always needs review.
  it.each([
    ["a helper", "test/helpers.ts", "ask"],
    ["a fixture", "test/fixtures/flow/a.mmd", "ask"],
    ["a test", "test/thing.test.ts", "ship"],
    ["a file elsewhere", "src/helpers.ts", "ship"],
  ] as const)("gives %s, %s, the verdict %s under the test folder", (_, path, verdict) => {
    const repo = newRepo();
    stage(repo, path, "changed\n");

    const got = evaluate(repo, { ...plain, reviewNonTests: ["test/"] });
    expect(got.verdict, got.reasons.join("; ")).toBe(verdict);
    if (verdict === "ask") expect(got.reasons).toContain(`\`${path}\` is a test's helper or fixture, so it always needs review.`);
  });

  it("finds a small change to ordinary code straightforward", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expectVerdict(evaluate(repo, plain), "ship", "No review rule matched this change.");
  });

  // Classify's verdict starts the rule off, and the rule can only move it towards ask.
  it.each([
    ["ship", "ship", "No review rule matched this change."],
    ["show", "show", "Classify said show."],
    ["ask", "ask", "Classify said ask."],
  ] as const)("starts from Classify saying %s", (classified, verdict, reason) => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expectVerdict(evaluate(repo, plain, { classified }), verdict, reason);
  });

  it("asks when Classify gave no verdict", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expectVerdict(evaluate(repo, plain, { classified: "missing" }), "ask", "Classify gave no verdict.");
  });

  it("keeps an ask the rules require when Classify says ship", () => {
    const repo = newRepo();
    stage(repo, "docs/SPEC.md", "changed\n");

    expectVerdict(
      evaluate(repo, { reviewPaths: ["docs/SPEC.md"], reviewNonTests: [], reviewAnywhere: [], maxChangedLines: 400 }, { classified: "ship" }),
      "ask",
      "`docs/SPEC.md` is a path that always needs review.",
    );
  });

  it("shows a change the reviews left Nits on", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expectVerdict(evaluate(repo, plain, { classified: "ship", nits: 2 }), "show", "The reviews left 2 Nits unfixed.");
    expectVerdict(evaluate(repo, plain, { classified: "ship", nits: 1 }), "show", "The reviews left 1 Nit unfixed.");
  });

  it("never moves an ask back to show", () => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expect(evaluate(repo, plain, { classified: "ask", nits: 3 }).verdict).toBe("ask");
  });

  it.each([
    ["an unknown verdict", { classified: "merge" }],
    ["a negative count of Nits", { nits: -1 }],
  ])("refuses %s", (_, judged) => {
    const repo = newRepo();
    stage(repo, "src/app/page.tsx", "export default function Page() {}\n");

    expect(() => evaluate(repo, plain, judged as never)).toThrow();
  });

  it.each([
    ["an exact path", "docs/SPEC.md", true],
    ["a path under a directory", ".github/workflows/build.yml", true],
    ["a similar prefix", ".github-old/build.yml", false],
  ])("matches review paths by %s", (_, path, review) => {
    const repo = newRepo();
    stage(repo, path, "changed\n");

    const got = evaluate(repo, { reviewPaths: ["docs/SPEC.md", ".github/"], reviewNonTests: [], reviewAnywhere: [], maxChangedLines: 400 });
    expect(got.verdict, got.reasons.join("; ")).toBe(review ? "ask" : "ship");
    if (review) expect(got.reasons).toContain(`\`${path}\` is a path that always needs review.`);
  });

  it.each(["test/thing.test.ts", "test/page.test.tsx", "eslint-rules/rule.test.mjs"])(
    "sends a change that deletes the test file %s to review",
    (path) => {
      const repo = newRepo();
      stage(repo, path, "it('works', () => {});\n");
      commit(repo);
      git(repo, "rm", "-q", "--", path);

      expectVerdict(evaluate(repo, plain), "ask", `\`${path}\` deletes a test file.`);
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

    expectVerdict(evaluate(repo, plain), "ask", "`test/thing.test.ts` removes a test.");
  });

  it("lets a change add a test without review", () => {
    const repo = newRepo();
    stage(repo, "test/thing.test.ts", "it(\"stays\", () => {});\n");
    commit(repo);
    stage(repo, "test/thing.test.ts", "it(\"stays\", () => {});\nit(\"arrives\", () => {});\n");

    expectVerdict(evaluate(repo, plain), "ship", "No review rule matched this change.");
  });

  it("counts both added and removed lines against the limit", () => {
    const repo = newRepo();
    stage(repo, "large.txt", numberedLines("old", 201));
    commit(repo);
    stage(repo, "large.txt", numberedLines("new", 201));

    expectVerdict(evaluate(repo, plain), "ask", "The patch changes 402 lines, more than the limit of 400.");
  });

  // A change's own .gitattributes can tell git a file is binary, which would hide its lines from the
  // count and its removed tests from the rule. So the rule reads no attributes from the change, and
  // a change to any .gitattributes always needs review.
  it.each([".gitattributes", "src/.gitattributes"])("sends a change to %s to review", (path) => {
    const repo = newRepo();
    stage(repo, path, "*.ts text\n");

    expectVerdict(evaluate(repo, plain), "ask", `\`${path}\` sets how git reads files, so it always needs review.`);
  });

  it("counts the lines of files the change's attributes call binary", () => {
    const repo = newRepo();
    stage(repo, "large.txt", numberedLines("old", 201));
    commit(repo);
    stage(repo, "large.txt", numberedLines("new", 201));
    stage(repo, ".gitattributes", "* -diff\n");

    const got = evaluate(repo, plain);
    expect(got.verdict).toBe("ask");
    expect(got.reasons).toContain("The patch changes 403 lines, more than the limit of 400.");
  });

  it("finds a removed test that the change's attributes call binary", () => {
    const repo = newRepo();
    stage(repo, "test/thing.test.ts", 'it("stays", () => {});\nit("goes", () => {});\n');
    commit(repo);
    stage(repo, "test/thing.test.ts", 'it("stays", () => {});\n');
    stage(repo, ".gitattributes", "*.ts binary\n");

    expectVerdict(evaluate(repo, plain), "ask", "`test/thing.test.ts` removes a test.");
  });

  // A file git still finds binary, by a NUL byte in it, can't be counted or read, so it needs review,
  // unless it's an image or a font.
  it("sends a change to a binary file other than an image or a font to review", () => {
    const repo = newRepo();
    stage(repo, "src/server/hidden.ts", "export const a = 1;\u0000\n");
    stage(repo, "public/logo.png", Buffer.concat([signatures.png, Buffer.from("pixels")]));
    stage(repo, "src/fonts/Inter.woff2", Buffer.concat([signatures.woff2, Buffer.from("glyphs")]));

    const got = evaluate(repo, plain);
    expect(got.verdict).toBe("ask");
    expect(got.reasons).toEqual(["`src/server/hidden.ts` is binary, so the rule can't count or read it."]);
  });

  it.each(Object.keys(signatures))("lets a .%s file through without review when it starts as one does", (kind) => {
    const repo = newRepo();
    stage(repo, `public/thing.${kind}`, Buffer.concat([signatures[kind], Buffer.from("contents")]));

    expectVerdict(evaluate(repo, plain), "ship", "No review rule matched this change.");
  });

  // Any binary file can be named as an image or a font, so one that doesn't start as its name says
  // can't be read either.
  it.each([
    ["a script named as a picture", "public/logo.png", Buffer.from("#!/bin/sh\u0000echo hi\n", "latin1")],
    ["a picture of another kind", "public/photo.jpg", Buffer.concat([signatures.png, Buffer.from("pixels")])],
    ["a font of another kind", "src/fonts/Inter.ttf", Buffer.concat([signatures.woff2, Buffer.from("glyphs")])],
  ])("sends %s to review", (_, path, contents) => {
    const repo = newRepo();
    stage(repo, path, contents);

    expectVerdict(
      evaluate(repo, plain),
      "ask",
      `\`${path}\` is binary, and doesn't start as its name says, so the rule can't read it.`,
    );
  });

  it("lets a change delete an image without review", () => {
    const repo = newRepo();
    stage(repo, "public/logo.png", Buffer.from("not really a picture\u0000", "latin1"));
    commit(repo);
    git(repo, "rm", "-q", "--", "public/logo.png");

    expectVerdict(evaluate(repo, plain), "ship", "No review rule matched this change.");
  });

  // A symbolic link's target is read wherever the link is followed, so a new or changed one always
  // needs review.
  it.each([
    ["adds", null],
    ["changes", "../README.md"],
  ])("sends a change that %s a symbolic link to review", (_, before) => {
    const repo = newRepo();
    stage(repo, "README.md", "A registry\n");
    if (before) {
      symlinkSync(before, join(repo, "docs-link"));
      git(repo, "add", "--", "docs-link");
      commit(repo);
      rmSync(join(repo, "docs-link"));
    }
    symlinkSync("/proc/self/environ", join(repo, "docs-link"));
    git(repo, "add", "--", "docs-link");

    expectVerdict(evaluate(repo, plain), "ask", "`docs-link` is a symbolic link, so it always needs review.");
  });

  // A path's name reaches the pull request's description, so it's shown in a code span with nothing
  // in it that could end the span or the line.
  it("shows a path so its name can't break out of its reason", () => {
    const repo = newRepo();
    stage(repo, "docs/a`b\n## Approved <!--.md", "changed\n");

    const got = evaluate(repo, { reviewPaths: ["docs/"], reviewNonTests: [], reviewAnywhere: [], maxChangedLines: 400 });
    expect(got.reasons).toEqual(["`docs/a\\u0060b\\n## Approved <!--.md` is a path that always needs review."]);
    for (const reason of got.reasons) expect(reason).not.toContain("\n");
  });
});

// Land reads the branch's commits since main from git: the factory's own carry the app's bot as
// author and committer, and a fix commit carries the fix line in its message.
describe("judging the branch's commits since main", () => {
  const bot = ["-c", "user.name=awml-factory[bot]", "-c", "user.email=12345+awml-factory[bot]@users.noreply.github.com"];

  function branch() {
    const repo = newRepo();
    stage(repo, "README.md", "A registry\n");
    commit(repo);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return { repo, base };
  }

  function commitAs(repo: string, who: string[], path: string, message: string) {
    stage(repo, path, `${message}\n`);
    execFileSync("git", ["-C", repo, ...who, "commit", "-qm", message], { stdio: "pipe" });
  }

  function judge(repo: string, base: string, nits = 0) {
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // The rule reads the change as land stages it: the head's tree in the index, at the base.
    git(repo, "reset", "-q", "--soft", base);
    return evaluate(repo, plain, { classified: "ship", nits, base, head });
  }

  it("ships a branch of the factory's commits alone", () => {
    const { repo, base } = branch();
    commitAs(repo, bot, "src/app/page.tsx", "Build #7");

    expectVerdict(judge(repo, base), "ship", "No review rule matched this change.");
  });

  it("asks when a commit since main isn't the factory's", () => {
    const { repo, base } = branch();
    commitAs(repo, bot, "src/app/page.tsx", "Build #7");
    commitAs(repo, [], "src/app/other.tsx", "A person's commit");

    expectVerdict(judge(repo, base), "ask", "1 commit since main isn't the factory's.");
  });

  it("asks when only the author is the factory's", () => {
    const { repo, base } = branch();
    stage(repo, "src/app/page.tsx", "page\n");
    execFileSync(
      "git",
      ["-C", repo, "commit", "-qm", "Build #7", "--author", "awml-factory[bot] <12345+awml-factory[bot]@users.noreply.github.com>"],
      { stdio: "pipe" },
    );

    expectVerdict(judge(repo, base), "ask", "1 commit since main isn't the factory's.");
  });

  it("asks when the branch merges another", () => {
    const { repo, base } = branch();
    commitAs(repo, bot, "src/app/page.tsx", "Build #7");
    git(repo, "branch", "side", base);
    git(repo, "switch", "-q", "side");
    commitAs(repo, bot, "src/app/side.tsx", "Side");
    git(repo, "switch", "-q", "-");
    execFileSync("git", ["-C", repo, ...bot, "merge", "-q", "--no-edit", "side"], { stdio: "pipe" });

    expectVerdict(judge(repo, base), "ask", "The branch since main holds a merge, which the factory never makes.");
  });

  it("shows a branch that carries a fix commit", () => {
    const { repo, base } = branch();
    commitAs(repo, bot, "src/app/page.tsx", "Build #7");
    commitAs(repo, bot, "src/app/page2.tsx", "Fix the review findings\n\nFactory-Fix: https://github.com/owner/repo/actions/runs/9");

    expectVerdict(judge(repo, base), "show", "The branch carries 1 fix commit.");
  });

  // A try is a commit, so one that carries the line twice counts once, and the line counts only at
  // the start of a line of the message.
  it("counts the commits whose message carries the fix line at the start of a line", () => {
    const { repo, base } = branch();
    commitAs(repo, bot, "src/app/page.tsx", "Build #7");
    commitAs(repo, bot, "src/app/a.tsx", "Fix\n\nFactory-Fix: https://x/runs/1");
    commitAs(repo, bot, "src/app/b.tsx", "Factory-Fix: in the subject");
    commitAs(repo, bot, "src/app/c.tsx", "Fix\n\nsee Factory-Fix: elsewhere");
    commitAs(repo, bot, "src/app/d.tsx", "Fix\n\nFactory-Fix: https://x/runs/2\nFactory-Fix: https://x/runs/3");

    expectVerdict(judge(repo, base), "show", "The branch carries 3 fix commits.");
  });

  // fix.yml counts its tries by the same line, so the two can't drift apart.
  it("matches fix.yml's count of fix commits", () => {
    const fix = readFileSync(join(__dirname, "../.github/workflows/fix.yml"), "utf8");
    expect(fixLine.flags).toBe("");
    expect(fix).toContain(`map(select(test("${fixLine.source}")))`);
  });

  it("refuses a head the base isn't under", () => {
    const { repo, base } = branch();
    commitAs(repo, bot, "src/app/page.tsx", "Build #7");
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    git(repo, "switch", "-q", "-c", "side", base);
    commitAs(repo, bot, "src/app/side.tsx", "Side");
    const side = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    expect(() => evaluate(repo, plain, { classified: "ship", base: side, head })).toThrow();
  });
});

