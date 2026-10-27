// Prints the go command to build AWML with: the Go release its go.mod names, by its toolchain
// line, or else its go line. A go line of a minor version alone, such as 1.22, names that minor's
// latest release, as actions/setup-go reads it, and as AWML's own CI builds it. A go on the PATH
// that is that release is used; otherwise the release is downloaded from go.dev, checked against
// the SHA-256 go.dev lists for it, and kept in a cache, so it is downloaded once.
// Usage: node scripts/engine-go.mjs /path/to/awml
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/engine-go.mjs /path/to/awml");
const mod = readFileSync(path.join(source, "go.mod"), "utf8");
const named = /^toolchain go(\S+)$/m.exec(mod)?.[1] ?? /^go (\S+)$/m.exec(mod)?.[1];
if (!named || !/^\d+\.\d+(\.\d+)?$/.test(named)) throw new Error(`${source}/go.mod names no Go release this script can read`);

const OS = { linux: "linux", darwin: "darwin" }[process.platform];
const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
if (!OS || !ARCH) throw new Error(`no Go release is known here for ${process.platform}/${process.arch}`);

// The newer of two releases, such as go1.22.12 and go1.22.9.
const parts = (v) => v.replace(/^go/, "").split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
};

// The release the go.mod names, and its archive for this machine, from go.dev's list.
const res = await fetch("https://go.dev/dl/?mode=json&include=all");
if (!res.ok) throw new Error(`go.dev's list of Go releases answered ${res.status}`);
const releases = (await res.json()).filter(
  (r) => r.stable && (r.version === `go${named}` || (named.split(".").length === 2 && r.version.startsWith(`go${named}.`))),
);
if (!releases.length) throw new Error(`go.dev lists no stable Go release for go ${named}`);
const version = releases.map((r) => r.version).reduce(newer);
const file = releases.find((r) => r.version === version).files.find((f) => f.os === OS && f.arch === ARCH && f.kind === "archive");
if (!file) throw new Error(`go.dev has no ${version} archive for ${OS}/${ARCH}`);

// A go on the PATH that is that release.
try {
  const local = execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" } }).trim();
  if (local === version) {
    console.log("go");
    process.exit(0);
  }
} catch {
  // No go on the PATH.
}

const home = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "awml-registry", "go", version);
const go = path.join(home, "go", "bin", "go");
if (!existsSync(go)) {
  console.error(`Downloading ${file.filename} from go.dev, the Go AWML's go.mod names`);
  const got = await fetch(`https://go.dev/dl/${file.filename}`);
  if (!got.ok) throw new Error(`go.dev answered ${got.status} for ${file.filename}`);
  const bytes = Buffer.from(await got.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== file.sha256) throw new Error(`${file.filename} has SHA-256 ${sha256}, but go.dev lists ${file.sha256}`);
  // Unpacked beside where it is kept, then moved there whole, so a half-unpacked Go is never used.
  mkdirSync(path.dirname(home), { recursive: true });
  const work = mkdtempSync(path.join(path.dirname(home), ".unpacking-"));
  try {
    writeFileSync(path.join(work, file.filename), bytes);
    mkdirSync(path.join(work, "out"));
    execFileSync("tar", ["-xzf", path.join(work, file.filename), "-C", path.join(work, "out")]);
    rmSync(home, { recursive: true, force: true });
    renameSync(path.join(work, "out"), home);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
console.log(go);
