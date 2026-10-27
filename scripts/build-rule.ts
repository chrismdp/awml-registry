// The build rule: whether a change the build workflow drafted is straightforward enough to merge by
// itself, or needs the maintainer's review. It reads the change staged in a repository, the
// settings in .github/build-rules.yml, the build's reviews' findings and the classifier's verdict,
// and prints "review" or "straightforward", then one reason a line. land.yml runs main's copy of
// it, with main's settings, once CI has passed, so a change can't alter how it's judged.
//
// It needs nothing but Node and git, so the job that runs it installs nothing:
//   node --experimental-strip-types scripts/build-rule.ts --repo . --rules .github/build-rules.yml \
//     --findings findings.json --classification classification.json
// This is the registry's copy of AWML's internal/buildrule, with the registry's own test files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type Config = { reviewPaths: string[]; maxChangedLines: number };
export type Verdict = { review: boolean; reasons: string[] };
// The reviews' record and the classifier's verdict, as files the build's review job wrote. Either
// may be left out: the classifier doesn't run when the reviews leave an Important finding open.
export type Records = { findings?: string; classification?: string };

const testFile = /\.test\.(ts|tsx|mjs)$/;
// A removed line that declared a test or a group of them, including one that was only changed to
// skip it.
const removedTest = /^-\s*(it|test|describe)\b[\w.]*\s*\(/m;
const gitAttributes = /(^|\/)\.gitattributes$/;
// The binary files the rule lets through unread, as review.yml does, each only if it starts as its
// kind does. The PNG and GIF signatures are the ones the build's open job checks its pictures by.
const ascii = (text: string) => Buffer.from(text, "latin1");
const startsWith = (head: Buffer, ...signatures: Buffer[]) =>
  signatures.some((signature) => head.subarray(0, signature.length).equals(signature));
const imagesAndFonts: [RegExp, (head: Buffer) => boolean][] = [
  [/\.png$/i, (head) => startsWith(head, Buffer.from("89504e470d0a1a0a", "hex"))],
  [/\.gif$/i, (head) => startsWith(head, ascii("GIF87a"), ascii("GIF89a"))],
  [/\.jpe?g$/i, (head) => startsWith(head, Buffer.from("ffd8ff", "hex"))],
  [/\.webp$/i, (head) => startsWith(head, ascii("RIFF")) && head.subarray(8, 12).equals(ascii("WEBP"))],
  [/\.ico$/i, (head) => startsWith(head, Buffer.from("00000100", "hex"))],
  [/\.ttf$/i, (head) => startsWith(head, Buffer.from("00010000", "hex"), ascii("true"))],
  [/\.otf$/i, (head) => startsWith(head, ascii("OTTO"))],
  [/\.woff$/i, (head) => startsWith(head, ascii("wOFF"))],
  [/\.woff2$/i, (head) => startsWith(head, ascii("wOF2"))],
];
// A symbolic link's mode in git.
const symbolicLink = "120000";

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

export function evaluate(repo: string, config: Config, records: Records = {}): Verdict {
  const reasons: string[] = [];

  if (records.findings !== undefined) {
    const open = openFindings(records.findings);
    if (open === 1) reasons.push("The reviews left 1 finding open.");
    else if (open > 1) reasons.push(`The reviews left ${open} findings open.`);
  }

  if (records.classification !== undefined && classifierAsked(records.classification)) {
    reasons.push("The classifier asked for a review.");
  }

  const paths = nulFields(git(repo, "diff", "--cached", "--name-only", "--no-renames", "-z", "--"));
  for (const path of paths) {
    const protectedPath = config.reviewPaths.some(
      (rule) => path === rule || (rule.endsWith("/") && path.startsWith(rule)),
    );
    if (protectedPath) reasons.push(`${shown(path)} is a path that always needs review.`);
  }

  // The rule reads no attributes from the change, but a .gitattributes would change how git reads
  // files once it's merged, so a change to one always needs review.
  for (const path of paths) {
    if (gitAttributes.test(path)) reasons.push(`${shown(path)} sets how git reads files, so it always needs review.`);
  }

  const deleted = nulFields(
    git(repo, "diff", "--cached", "--diff-filter=D", "--name-only", "--no-renames", "-z", "--"),
  );
  for (const path of deleted) {
    if (testFile.test(path)) reasons.push(`${shown(path)} deletes a test file.`);
  }

  for (const path of paths) {
    if (!testFile.test(path) || deleted.includes(path)) continue;
    const diff = git(repo, "diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--", path);
    if (removedTest.test(diff)) reasons.push(`${shown(path)} removes a test.`);
  }

  // A symbolic link's target is read wherever the link is followed, so a new or changed one always
  // needs review.
  const modes = newModes(repo);
  for (const [path, mode] of modes) {
    if (mode === symbolicLink) reasons.push(`${shown(path)} is a symbolic link, so it always needs review.`);
  }

  // A file git finds binary by its content can't be counted or read, so it needs review, unless it's
  // an image or a font that starts as its kind does. A deleted one leaves nothing to read.
  const { changedLines, binaries } = countChangedLines(repo);
  for (const path of binaries) {
    const kind = imagesAndFonts.find(([name]) => name.test(path));
    if (!kind) {
      reasons.push(`${shown(path)} is binary, so the rule can't count or read it.`);
    } else if (modes.get(path) !== "000000" && !kind[1](head(repo, path))) {
      reasons.push(`${shown(path)} is binary, and doesn't start as its name says, so the rule can't read it.`);
    }
  }
  if (changedLines > config.maxChangedLines) {
    reasons.push(`The patch changes ${changedLines} lines, more than the limit of ${config.maxChangedLines}.`);
  }

  if (reasons.length === 0) return { review: false, reasons: ["No review rule matched this change."] };
  return { review: true, reasons };
}

// Counts the findings about the change itself. A pre-existing one is about code the change didn't
// write, so it's shown but leaves the change straightforward.
function openFindings(path: string): number {
  const findings = readRecord(path, "the reviews' findings");
  if (!Array.isArray(findings)) throw new Error("the reviews' findings aren't a list");
  let open = 0;
  for (const finding of findings) {
    const severity = (finding as { severity?: unknown } | null)?.severity;
    if (severity === "Important" || severity === "Nit") open++;
    else if (severity !== "Pre-existing") throw new Error(`a finding has an unknown severity ${JSON.stringify(severity)}`);
  }
  return open;
}

// Whether the classifier asked for a review. It can only add a review, so its answer of no changes
// nothing.
function classifierAsked(path: string): boolean {
  const verdict = readRecord(path, "the classifier's verdict") as { needs_review?: unknown } | null;
  if (typeof verdict?.needs_review !== "boolean") throw new Error("the classifier's verdict has no needs_review");
  return verdict.needs_review;
}

function readRecord(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`read ${what}: ${(error as Error).message}`);
  }
}

// numstat counts a binary file's lines as "-", so those files are named instead.
function countChangedLines(repo: string): { changedLines: number; binaries: string[] } {
  let changedLines = 0;
  const binaries: string[] = [];
  for (const record of nulFields(git(repo, "diff", "--cached", "--numstat", "--no-renames", "-z", "--"))) {
    const fields = record.split("\t");
    if (fields.length < 3) throw new Error(`unexpected numstat record ${JSON.stringify(record)}`);
    const counts = fields.slice(0, 2);
    if (counts.includes("-")) {
      binaries.push(fields.slice(2).join("\t"));
      continue;
    }
    for (const value of counts) {
      if (!/^\d+$/.test(value)) throw new Error(`unexpected numstat count ${JSON.stringify(value)}`);
      changedLines += Number(value);
    }
  }
  return { changedLines, binaries };
}

// The mode each changed path has once the change is applied, "000000" for one it deletes, from
// git's raw records: ":<old mode> <new mode> <old id> <new id> <status>", then the path.
function newModes(repo: string): Map<string, string> {
  const modes = new Map<string, string>();
  const fields = nulFields(git(repo, "diff", "--cached", "--raw", "--no-renames", "-z", "--"));
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const mode = fields[at].split(" ")[1];
    if (!/^\d{6}$/.test(mode ?? "")) throw new Error(`unexpected raw record ${JSON.stringify(fields[at])}`);
    modes.set(fields[at + 1], mode);
  }
  return modes;
}

// The first bytes of a path as the change stages it.
function head(repo: string, path: string): Buffer {
  try {
    return execFileSync("git", ["-C", repo, "cat-file", "blob", `:0:${path}`], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    }).subarray(0, 16);
  } catch (error) {
    throw new Error(`read ${path}: ${(error as Error).message}`);
  }
}

// A path as a reason shows it: in a code span, with anything that could end the span or the line
// escaped, since the reasons reach the pull request's description.
function shown(path: string): string {
  return `\`${JSON.stringify(path).slice(1, -1).replaceAll("`", "\\u0060")}\``;
}

function nulFields(output: string): string[] {
  const trimmed = output.endsWith("\0") ? output.slice(0, -1) : output;
  return trimmed === "" ? [] : trimmed.split("\0");
}

// Each git command reads its attributes from an empty tree, never from the change, whose own
// .gitattributes could call any file binary and so hide its lines and its removed tests.
const emptyTrees = new Map<string, string>();
function git(repo: string, ...args: string[]): string {
  let empty = emptyTrees.get(repo);
  if (empty === undefined) {
    empty = run(repo, ["hash-object", "-t", "tree", "/dev/null"]).trim();
    emptyTrees.set(repo, empty);
  }
  return run(repo, [`--attr-source=${empty}`, ...args]);
}

function run(repo: string, args: string[]): string {
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
      findings: { type: "string" },
      classification: { type: "string" },
    },
  });
  const verdict = evaluate(values.repo, loadConfig(values.rules), {
    findings: values.findings,
    classification: values.classification,
  });
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
