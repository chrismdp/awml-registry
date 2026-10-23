// The build rule: whether a change the build workflow drafted is straightforward enough to merge by
// itself, or needs the maintainer's review. It reads the change staged in a repository and the
// settings in .github/build-rules.yml, and prints "review" or "straightforward", then one reason a
// line. The build workflow runs main's copy of it, with main's settings, before the change is
// applied, so a change can't alter how it's judged.
//
// It needs nothing but Node and git, so the job that runs it installs nothing:
//   node --experimental-strip-types scripts/build-rule.ts --repo . --rules .github/build-rules.yml \
//     --review review.md
// This is the registry's copy of AWML's internal/buildrule, with the registry's own test files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type Config = { reviewPaths: string[]; maxChangedLines: number };
export type Verdict = { review: boolean; reasons: string[] };

const testFile = /\.test\.(ts|tsx|mjs)$/;
// A removed line that declared a test or a group of them, including one that was only changed to
// skip it.
const removedTest = /^-\s*(it|test|describe)\b[\w.]*\s*\(/m;

export function loadConfig(path: string): Config {
  return readConfig(readFileSync(path, "utf8"));
}

// The rules file is YAML, but only the simple form it is written in: each setting on a line, a list
// either inline in brackets or one "- item" a line, and comments on lines of their own. Anything
// else is refused, so a setting can never be quietly misread.
export function readConfig(text: string): Config {
  const config: Config = { reviewPaths: [], maxChangedLines: 0 };
  let list: string[] | undefined;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trimEnd();
    const where = `build rules line ${index + 1}`;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const item = line.match(/^\s+-(.*)$/);
    if (item) {
      if (!list) throw new Error(`${where}: a list item belongs under review_paths`);
      list.push(item[1].trim());
      continue;
    }
    list = undefined;

    const setting = line.match(/^([a-z_]+):(.*)$/);
    if (!setting) throw new Error(`${where}: can't read "${line}"`);
    const [, key, rest] = setting;
    const value = rest.trim();
    if (key === "review_paths") {
      if (value === "") {
        list = config.reviewPaths = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        const inside = value.slice(1, -1).trim();
        config.reviewPaths = inside === "" ? [] : inside.split(",").map((path) => path.trim());
      } else {
        throw new Error(`${where}: review_paths must be a list`);
      }
    } else if (key === "max_changed_lines") {
      if (!/^-?\d+$/.test(value)) throw new Error(`${where}: max_changed_lines must be a whole number`);
      config.maxChangedLines = Number(value);
    } else {
      throw new Error(`${where}: there is no setting called ${key}`);
    }
  }

  if (config.maxChangedLines < 0) throw new Error("max_changed_lines must not be negative");
  for (const path of config.reviewPaths) {
    if (path === "") throw new Error("review_paths must not contain an empty path");
    if (/^["'#]|\s#/.test(path)) throw new Error(`review_paths can't read ${path}; write each path bare`);
  }
  return config;
}

export function evaluate(repo: string, config: Config, reviewPath = ""): Verdict {
  const reasons: string[] = [];

  if (reviewPath !== "") {
    const note = readNote(reviewPath);
    // The pull request quotes a note in full, so the reason only points to it.
    if (note !== undefined) {
      reasons.push(
        note.trim() === "" ? "Claude asked for the maintainer's review." : "Claude asked for a review: see Claude's note.",
      );
    }
  }

  const paths = nulFields(git(repo, "diff", "--cached", "--name-only", "--no-renames", "-z", "--"));
  for (const path of paths) {
    const protectedPath = config.reviewPaths.some(
      (rule) => path === rule || (rule.endsWith("/") && path.startsWith(rule)),
    );
    if (protectedPath) reasons.push(`${path} is a path that always needs review.`);
  }

  const deleted = nulFields(
    git(repo, "diff", "--cached", "--diff-filter=D", "--name-only", "--no-renames", "-z", "--"),
  );
  for (const path of deleted) {
    if (testFile.test(path)) reasons.push(`${path} deletes a test file.`);
  }

  for (const path of paths) {
    if (!testFile.test(path) || deleted.includes(path)) continue;
    const diff = git(repo, "diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--", path);
    if (removedTest.test(diff)) reasons.push(`${path} removes a test.`);
  }

  const changedLines = countChangedLines(repo);
  if (changedLines > config.maxChangedLines) {
    reasons.push(`The patch changes ${changedLines} lines, more than the limit of ${config.maxChangedLines}.`);
  }

  if (reasons.length === 0) return { review: false, reasons: ["No review rule matched this change."] };
  return { review: true, reasons };
}

function readNote(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`read Claude's review note: ${(error as Error).message}`);
  }
}

function countChangedLines(repo: string): number {
  let total = 0;
  for (const record of nulFields(git(repo, "diff", "--cached", "--numstat", "--no-renames", "-z", "--"))) {
    const fields = record.split("\t");
    if (fields.length < 3) throw new Error(`unexpected numstat record ${JSON.stringify(record)}`);
    for (const value of fields.slice(0, 2)) {
      if (value === "-") continue;
      if (!/^\d+$/.test(value)) throw new Error(`unexpected numstat count ${JSON.stringify(value)}`);
      total += Number(value);
    }
  }
  return total;
}

function nulFields(output: string): string[] {
  const trimmed = output.endsWith("\0") ? output.slice(0, -1) : output;
  return trimmed === "" ? [] : trimmed.split("\0");
}

function git(repo: string, ...args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")}: ${stderr || (error as Error).message}`);
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: "." },
      rules: { type: "string", default: ".github/build-rules.yml" },
      review: { type: "string", default: "" },
    },
  });
  const verdict = evaluate(values.repo, loadConfig(values.rules), values.review);
  console.log(verdict.review ? "review" : "straightforward");
  for (const reason of verdict.reasons) console.log(reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
