// The engine's pin, vendor/awml/version.json, and the Go that builds it (issue #73). The pin holds
// AWML's tag and full commit, the Go release to build with and the SHA-256 of its archive for each
// machine, and the SHA-256 of awml.js and of the two files the build writes, awml.wasm and
// wasm_exec.js. Nothing here trusts a list fetched in the same run: Go is checked against the
// pinned SHA-256, and what the build writes against the pinned hashes.
//
//   node scripts/engine-pin.mjs check-pin              fails unless the pin is well formed
//   node scripts/engine-pin.mjs field tag              prints a field of the pin
//   node scripts/engine-pin.mjs matches FILE...        exits 0 when each vendor/awml FILE has its pinned SHA-256
//   node scripts/engine-pin.mjs built                  exits 0 when vendor/awml holds the pinned build, stamped
//   node scripts/engine-pin.mjs stamp                  writes the stamp, vendor/awml/build.json
//   node scripts/engine-pin.mjs go                     prints the pinned Go's go command, downloading it once
//   node scripts/engine-pin.mjs pin TAG COMMIT SOURCE  writes a new pin, its Go from SOURCE's go.mod (engine:update)
//   node scripts/engine-pin.mjs record FILE...         records each vendor/awml FILE's SHA-256 (engine:update)
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendored = path.join(root, "vendor", "awml");
const pinFile = path.join(vendored, "version.json");
const MACHINES = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"];
const OUTPUTS = ["awml.js", "awml.wasm", "wasm_exec.js"];
const SHA256 = /^[0-9a-f]{64}$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const readPin = () => JSON.parse(readFileSync(pinFile, "utf8"));
const writePin = (pin) => writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// What is wrong with a pin, or nothing; with `outputs` false, leaving out the hashes of the files
// the build writes, which engine:update records only once it has built them.
function problems(pin, outputs = true) {
  const found = [];
  if (!/^v\d+\.\d+\.\d+$/.test(pin.tag ?? "")) found.push(`tag "${pin.tag}" isn't a release such as v0.10.0`);
  if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) found.push(`commit "${pin.commit}" isn't a full commit`);
  if (!/^go\d+\.\d+\.\d+$/.test(pin.go?.version ?? "")) found.push(`go.version "${pin.go?.version}" isn't a Go release such as go1.22.12`);
  for (const m of MACHINES) if (!SHA256.test(pin.go?.sha256?.[m] ?? "")) found.push(`go.sha256 has no SHA-256 for ${m}`);
  if (outputs) for (const f of OUTPUTS) if (!SHA256.test(pin.sha256?.[f] ?? "")) found.push(`sha256 has no SHA-256 for ${f}`);
  return found;
}

// Whether each vendor/awml file has the SHA-256 the pin gives it.
function matches(pin, files) {
  return files.every((f) => {
    const file = path.join(vendored, f);
    return Object.hasOwn(pin.sha256 ?? {}, f) && existsSync(file) && sha256(readFileSync(file)) === pin.sha256[f];
  });
}

// The stamp beside a build, saying what it was built from.
const stampFile = path.join(vendored, "build.json");
const stampOf = (pin) => ({ tag: pin.tag, commit: pin.commit, go: pin.go.version });

// This machine, as go.dev names its archives.
function machine() {
  const os = { linux: "linux", darwin: "darwin" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!os || !arch) fail(`No Go is pinned for ${process.platform}/${process.arch}.`);
  return `${os}-${arch}`;
}

// A file from an https address, refusing anything else, redirects included.
async function fetchHttps(url) {
  if (!url.startsWith("https://")) fail(`Refusing to fetch ${url}: only https is used.`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.url.startsWith("https://")) fail(`Refusing ${url}: it led to ${res.url}, which isn't https.`);
  if (!res.ok) fail(`${url} answered ${res.status}.`);
  return res;
}

// The pinned Go's go command. Never a go on the PATH, whose output might differ: the pinned
// release, downloaded once over https into a cache, checked against its pinned SHA-256, unpacked
// under a name no other run uses, then renamed into place. Two runs at once can't spoil each
// other: whichever renames second finds the other's in place and uses it.
async function pinnedGo() {
  const pin = readPin();
  const wrong = problems(pin, false);
  if (wrong.length) fail(`vendor/awml/version.json: ${wrong.join("; ")}`);
  const { version } = pin.go;
  const m = machine();
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "awml-registry", "go");
  const home = path.join(cache, `${version}.${m}`);
  const go = path.join(home, "go", "bin", "go");
  if (existsSync(go)) return go;
  const file = `${version}.${m}.tar.gz`;
  console.error(`Downloading ${file} from go.dev, the Go vendor/awml/version.json pins`);
  const bytes = Buffer.from(await (await fetchHttps(`https://go.dev/dl/${file}`)).arrayBuffer());
  const got = sha256(bytes);
  if (got !== pin.go.sha256[m]) fail(`${file} has SHA-256 ${got}, but vendor/awml/version.json pins ${pin.go.sha256[m]}.`);
  mkdirSync(cache, { recursive: true });
  const work = path.join(cache, `.unpacking-${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(work);
  try {
    writeFileSync(path.join(work, file), bytes);
    mkdirSync(path.join(work, "out"));
    execFileSync("tar", ["-xzf", path.join(work, file), "-C", path.join(work, "out")]);
    try {
      renameSync(path.join(work, "out"), home);
    } catch (e) {
      // Another run put its own in place first; it is the same checked release.
      if (!existsSync(go)) throw e;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return go;
}

// The Go release a source's go.mod names: its toolchain line, or else its go line, where a minor
// version alone, such as 1.22, names that minor's latest release, as actions/setup-go reads it and
// as AWML's own CI builds it. Only engine:update asks go.dev's list, and what it finds goes into
// the pin, for a person to review.
async function goFor(source) {
  const mod = readFileSync(path.join(source, "go.mod"), "utf8");
  const named = /^toolchain go(\S+)$/m.exec(mod)?.[1] ?? /^go (\S+)$/m.exec(mod)?.[1];
  if (!named || !/^\d+\.\d+(\.\d+)?$/.test(named)) fail(`${source}/go.mod names no Go release this script can read.`);
  const releases = (await (await fetchHttps("https://go.dev/dl/?mode=json&include=all")).json()).filter(
    (r) => r.stable && (r.version === `go${named}` || (named.split(".").length === 2 && r.version.startsWith(`go${named}.`))),
  );
  if (!releases.length) fail(`go.dev lists no stable Go release for go ${named}.`);
  const parts = (v) => v.replace(/^go/, "").split(".").map(Number);
  const newer = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
    return a;
  };
  const version = releases.map((r) => r.version).reduce(newer);
  const files = releases.find((r) => r.version === version).files;
  const sums = {};
  for (const m of MACHINES) {
    const [os, arch] = m.split("-");
    const f = files.find((x) => x.os === os && x.arch === arch && x.kind === "archive");
    if (!f) fail(`go.dev has no ${version} archive for ${m}.`);
    sums[m] = f.sha256;
  }
  return { version, sha256: sums };
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "check-pin": {
    const wrong = problems(readPin());
    if (wrong.length) fail(`vendor/awml/version.json: ${wrong.join("; ")}. Run: npm run engine:update -- <tag>`);
    break;
  }
  case "field": {
    const value = args[0].split(".").reduce((o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined), readPin());
    process.stdout.write(value === undefined ? "" : String(value));
    break;
  }
  case "matches":
    if (!matches(readPin(), args)) process.exit(1);
    break;
  case "built": {
    // The build in vendor/awml is the pinned one: its stamp names the pin, and both files it
    // wrote have their pinned SHA-256.
    const pin = readPin();
    let stamp = null;
    try {
      stamp = JSON.parse(readFileSync(stampFile, "utf8"));
    } catch {
      process.exit(1);
    }
    if (JSON.stringify(stamp) !== JSON.stringify(stampOf(pin)) || !matches(pin, ["awml.wasm", "wasm_exec.js"])) process.exit(1);
    break;
  }
  case "stamp":
    writeFileSync(stampFile, `${JSON.stringify(stampOf(readPin()))}\n`);
    break;
  case "go":
    console.log(await pinnedGo());
    break;
  case "pin": {
    const [tag, commit, source] = args;
    writePin({ tag, commit, go: await goFor(source), sha256: {} });
    break;
  }
  case "record": {
    const pin = readPin();
    pin.sha256 = { ...pin.sha256 };
    for (const f of args) pin.sha256[f] = sha256(readFileSync(path.join(vendored, f)));
    pin.sha256 = Object.fromEntries(Object.entries(pin.sha256).sort(([a], [b]) => a.localeCompare(b)));
    writePin(pin);
    break;
  }
  default:
    fail("usage: node scripts/engine-pin.mjs check-pin | field NAME | matches FILE... | built | stamp | go | pin TAG COMMIT SOURCE | record FILE...");
}
