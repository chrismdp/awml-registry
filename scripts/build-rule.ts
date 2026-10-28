// The build rule: how far a factory pull request, whose CI has passed, may land by itself. Classify's
// verdict, ship, show or ask, starts it off, and the rule can only move that towards ask: its own
// tests of the change (paths, test helpers, size, binaries, symbolic links, gitlinks, removed tests), a commit since main
// that isn't the factory's, or Classify saying ask or nothing mean ask; a fix commit on the branch,
// or Nits the reviews left unfixed, mean at least show. It prints the verdict, then one reason a
// line. land.yml runs main's copy of it, with main's settings, on the head commit CI judged, staged
// at the commit of main the branch starts from, so a change can't alter how it's judged.
//
// It needs nothing but Node and git, so the job that runs it installs nothing:
//   node --experimental-strip-types scripts/build-rule.ts --repo . --rules .github/build-rules.yml \
//     --classified ship --nits 0 --base <sha> --head <sha> --factory awml-factory[bot]
// This is the registry's copy of AWML's internal/buildrule, with the registry's own test files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// reviewPaths are paths, or folders ending in /, that always need review; reviewNonTests are folders
// whose files other than tests always need review, such as a test's helpers and fixtures; and
// reviewAnywhere are names, a file's or a folder's ending in /, that need review wherever they sit
// in the tree, such as the files npm reads beside any package.
export type Config = { reviewPaths: string[]; reviewNonTests: string[]; reviewAnywhere: string[]; maxChangedLines: number };
export type Verdict = { verdict: "ship" | "show" | "ask"; reasons: string[] };
// What land read from GitHub and git: Classify's verdict, or "missing" when its check has none; how
// many Nits the reviews' checks carry; and the branch's commits since main, from base to head, with
// the login of the factory's app, whose bot makes the factory's commits.
export type Judged = {
  classified?: string;
  nits?: number;
  base?: string;
  head?: string;
  factory?: string;
};

const verdicts = ["ship", "show", "ask"] as const;
// The line each fix commit's message carries, which survives a rebase. fix.yml writes it, and counts
// the fix commits on a branch by it, as the rule does.
const fixLine = /^Factory-Fix: /m;

export function countFixCommits(messages: string[]): number {
  return messages.filter((message) => fixLine.test(message)).length;
}

const testFile = /\.test\.(ts|tsx|mjs)$/;
// A removed line that declared a test or a group of them, including one that was only changed to
// skip it.
const removedTest = /^-\s*(it|test|describe)\b[\w.]*\s*\(/m;
const gitAttributes = /(^|\/)\.gitattributes$/;
// The binary files the rule lets through unread, as CI's reviews do, each only if it starts as its
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
// A symbolic link's mode in git, and a gitlink's, which points at another repository's commit.
const symbolicLink = "120000";
const gitlink = "160000";
// The largest image or font the rule lets through unread.
const largestBinary = 1024 * 1024;

export function loadConfig(path: string): Config {
  return readConfig(readFileSync(path, "utf8"));
}

// The rules file is YAML, but only the simple form it is written in: each setting on a line, a list
// either inline in brackets or one "- item" a line, and comments on lines of their own. Anything
// else is refused, so a setting can never be quietly misread.
export function readConfig(text: string): Config {
  const config: Config = { reviewPaths: [], reviewNonTests: [], reviewAnywhere: [], maxChangedLines: 0 };
  let list: string[] | undefined;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trimEnd();
    const where = `build rules line ${index + 1}`;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const item = line.match(/^\s+-(.*)$/);
    if (item) {
      if (!list) throw new Error(`${where}: a list item belongs under review_paths, review_non_tests or review_anywhere`);
      list.push(item[1].trim());
      continue;
    }
    list = undefined;

    const setting = line.match(/^([a-z_]+):(.*)$/);
    if (!setting) throw new Error(`${where}: can't read "${line}"`);
    const [, key, rest] = setting;
    const value = rest.trim();
    if (key === "review_paths" || key === "review_non_tests" || key === "review_anywhere") {
      const field = key === "review_paths" ? "reviewPaths" : key === "review_non_tests" ? "reviewNonTests" : "reviewAnywhere";
      if (value === "") {
        list = config[field] = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        const inside = value.slice(1, -1).trim();
        config[field] = inside === "" ? [] : inside.split(",").map((path) => path.trim());
      } else {
        throw new Error(`${where}: ${key} must be a list`);
      }
    } else if (key === "max_changed_lines") {
      if (!/^-?\d+$/.test(value)) throw new Error(`${where}: max_changed_lines must be a whole number`);
      config.maxChangedLines = Number(value);
    } else {
      throw new Error(`${where}: there is no setting called ${key}`);
    }
  }

  if (config.maxChangedLines < 0) throw new Error("max_changed_lines must not be negative");
  for (const [key, paths] of [
    ["review_paths", config.reviewPaths],
    ["review_non_tests", config.reviewNonTests],
    ["review_anywhere", config.reviewAnywhere],
  ] as const) {
    for (const path of paths) {
      if (path === "") throw new Error(`${key} must not contain an empty path`);
      if (/^["'#]|\s#/.test(path)) throw new Error(`${key} can't read ${path}; write each path bare`);
    }
  }
  for (const folder of config.reviewNonTests) {
    if (!folder.endsWith("/")) throw new Error(`review_non_tests must name a folder, ending in /: ${folder}`);
  }
  for (const name of config.reviewAnywhere) {
    if (name.replace(/\/$/, "").includes("/")) throw new Error(`review_anywhere must name a file or a folder, not a path: ${name}`);
  }
  return config;
}

export function evaluate(repo: string, config: Config, judged: Judged = {}): Verdict {
  // The reasons that mean ask, and those that mean at least show.
  const reasons: string[] = [];
  const shows: string[] = [];

  if (judged.classified !== undefined) {
    if (judged.classified === "missing") {
      reasons.push("Classify gave no verdict.");
    } else if (judged.classified === "ask") {
      reasons.push("Classify said ask.");
    } else if (judged.classified === "show") {
      shows.push("Classify said show.");
    } else if (!(verdicts as readonly string[]).includes(judged.classified)) {
      throw new Error(`Classify gave an unknown verdict ${JSON.stringify(judged.classified)}`);
    }
  }

  const nits = judged.nits ?? 0;
  if (!Number.isInteger(nits) || nits < 0) throw new Error(`the count of Nits must be a whole number: ${nits}`);
  if (nits === 1) shows.push("The reviews left 1 Nit unfixed.");
  else if (nits > 1) shows.push(`The reviews left ${nits} Nits unfixed.`);

  if (judged.base !== undefined || judged.head !== undefined) {
    const { foreign, merges, fixes } = readCommits(repo, judged);
    if (merges > 0) reasons.push("The branch since main holds a merge, which the factory never makes.");
    if (foreign === 1) reasons.push("1 commit since main isn't the factory's.");
    else if (foreign > 1) reasons.push(`${foreign} commits since main aren't the factory's.`);
    if (fixes === 1) shows.push("The branch carries 1 fix commit.");
    else if (fixes > 1) shows.push(`The branch carries ${fixes} fix commits.`);
  }

  const paths = nulFields(git(repo, "diff", "--cached", "--name-only", "--no-renames", "-z", "--"));
  for (const path of paths) {
    const protectedPath = config.reviewPaths.some(
      (rule) => path === rule || (rule.endsWith("/") && path.startsWith(rule)),
    );
    const parts = path.split("/");
    const anywhere = config.reviewAnywhere.some((name) =>
      name.endsWith("/") ? parts.slice(0, -1).includes(name.slice(0, -1)) : parts[parts.length - 1] === name,
    );
    if (protectedPath) reasons.push(`${shown(path)} is a path that always needs review.`);
    else if (anywhere) reasons.push(`${shown(path)} is a name npm reads wherever it sits, so it always needs review.`);
    else if (config.reviewNonTests.some((folder) => path.startsWith(folder)) && !testFile.test(path)) {
      reasons.push(`${shown(path)} is a test's helper or fixture, so it always needs review.`);
    }
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
    if (mode === gitlink) reasons.push(`${shown(path)} is another repository's commit, so it always needs review.`);
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
    } else if (modes.get(path) !== "000000" && size(repo, path) > largestBinary) {
      reasons.push(`${shown(path)} is over 1 MiB, so it always needs review.`);
    }
  }
  if (changedLines > config.maxChangedLines) {
    reasons.push(`The patch changes ${changedLines} lines, more than the limit of ${config.maxChangedLines}.`);
  }

  if (reasons.length > 0) return { verdict: "ask", reasons };
  if (shows.length > 0) return { verdict: "show", reasons: shows };
  return { verdict: "ship", reasons: ["No review rule matched this change."] };
}

// The branch's commits from base to head. The base must be under the head. A commit is the
// factory's when both its author and its committer are the app's bot, as the build and the fixer
// commit. Only people with write access can push to a branch here, and they are trusted, so the
// rule takes the emails as given, though such a person could forge them. The factory never merges, so a commit with two parents is counted apart.
function readCommits(repo: string, judged: Judged) {
  const { base, head, factory } = judged;
  if (!base || !head || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error("the branch's base and head must both be commit ids");
  }
  if (!factory || !/^[a-z0-9-]+\[bot\]$/.test(factory)) throw new Error("the factory's bot must be an app's login");
  run(repo, ["merge-base", "--is-ancestor", base, head]);
  const email = new RegExp(`^[0-9]+\\+${factory.replace(/[[\]]/g, "\\$&")}@users\\.noreply\\.github\\.com$`);
  let foreign = 0;
  let merges = 0;
  const messages: string[] = [];
  const records = nulFields(run(repo, ["log", "-z", "--format=%P%x1f%ae%x1f%ce%x1f%B", `${base}..${head}`]));
  for (const record of records) {
    const [parents, author, committer, message] = record.split("\x1f");
    if (parents.trim().split(" ").length > 1) merges++;
    else if (!email.test(author) || !email.test(committer)) foreign++;
    messages.push(message ?? "");
  }
  return { foreign, merges, fixes: countFixCommits(messages) };
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

// The size in bytes of a path as the change stages it.
function size(repo: string, path: string): number {
  return Number(run(repo, ["cat-file", "-s", `:0:${path}`]).trim());
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
      classified: { type: "string", default: "missing" },
      nits: { type: "string", default: "0" },
      base: { type: "string" },
      head: { type: "string" },
      factory: { type: "string" },
    },
  });
  if (!/^[0-9]+$/.test(values.nits)) throw new Error(`the count of Nits must be a whole number: ${values.nits}`);
  const verdict = evaluate(values.repo, loadConfig(values.rules), {
    classified: values.classified,
    nits: Number(values.nits),
    base: values.base,
    head: values.head,
    factory: values.factory,
  });
  console.log(verdict.verdict);
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
