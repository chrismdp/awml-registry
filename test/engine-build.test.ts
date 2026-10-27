// The AWML engine is built from AWML's source, never kept in git (issue #73). vendor/awml/version.json
// pins the release and commit, the Go release to build with and its archives' SHA-256, and the
// SHA-256 of awml.js and of both files the build writes; `npm run engine:build` builds the
// WebAssembly from that commit into vendor/awml/, beside a stamp of what it built, and keeps it
// only when it has the pinned SHA-256. A pull request's reviewers read text, so an engine update
// changes only the pin, the wrapper and the fixtures.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENGINE_MISSING, ENGINE_STALE, loadAwmlModule } from "@/engine/module";

const vendored = (file: string) => path.join("vendor", "awml", file);
const pin = JSON.parse(fs.readFileSync(vendored("version.json"), "utf8"));
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
});

// A folder holding vendor/awml as given, for the loader to read in place of the repository's.
function elsewhere(files: Record<string, string | Buffer>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-"));
  fs.mkdirSync(path.join(dir, "vendor", "awml"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, "vendor", "awml", name), body);
  vi.spyOn(process, "cwd").mockReturnValue(dir);
}

describe("the engine's WebAssembly", () => {
  it("is in no file git keeps, and git ignores what the build writes", () => {
    const kept = execFileSync("git", ["ls-files", "vendor/awml"], { encoding: "utf8" }).trim().split("\n");
    expect(kept.filter((f) => f.endsWith(".wasm"))).toEqual([]);
    expect(kept).not.toContain("vendor/awml/wasm_exec.js");
    expect(kept).toEqual(expect.arrayContaining(["vendor/awml/version.json", "vendor/awml/awml.js", "vendor/awml/awml.d.ts"]));
    const ignored = execFileSync("git", ["check-ignore", vendored("awml.wasm"), vendored("wasm_exec.js"), vendored("build.json")], { encoding: "utf8" });
    expect(ignored.trim().split("\n")).toHaveLength(3);
  });

  it("is pinned to a release by its full commit, with the Go to build it and the SHA-256 of what it builds", () => {
    expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.go.version).toMatch(/^go\d+\.\d+\.\d+$/);
    expect(Object.keys(pin.go.sha256).sort()).toEqual(["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"]);
    expect(Object.keys(pin.sha256).sort()).toEqual(["awml.js", "awml.wasm", "wasm_exec.js"]);
    for (const hash of [...Object.values(pin.go.sha256), ...Object.values(pin.sha256)]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the pinned build: each file has its pinned SHA-256, and the stamp names the pin", () => {
    for (const file of ["awml.js", "awml.wasm", "wasm_exec.js"]) expect(sha256(vendored(file)), file).toBe(pin.sha256[file]);
    expect(JSON.parse(fs.readFileSync(vendored("build.json"), "utf8"))).toEqual({ tag: pin.tag, commit: pin.commit, go: pin.go.version });
  });

  it("is loaded from the file the build wrote", async () => {
    const read = vi.spyOn(fs.promises, "readFile");
    const module = await loadAwmlModule();
    expect(read).toHaveBeenCalledWith(path.join(process.cwd(), vendored("awml.wasm")));
    expect(WebAssembly.Module.exports(module).length).toBeGreaterThan(0);
  });

  it("says which command builds it when it isn't built", async () => {
    elsewhere({});
    await expect(loadAwmlModule()).rejects.toThrow(ENGINE_MISSING);
    expect(ENGINE_MISSING).toContain("npm run engine:build");
  });

  it("isn't loaded when it isn't the pinned build: another commit's stamp, no stamp, or other bytes", async () => {
    const wasm = fs.readFileSync(vendored("awml.wasm"));
    const version = fs.readFileSync(vendored("version.json"), "utf8");
    const stamp = fs.readFileSync(vendored("build.json"), "utf8");
    for (const files of [
      { "awml.wasm": wasm, "version.json": version, "build.json": stamp.replace(pin.commit, "0".repeat(40)) } as Record<string, string | Buffer>,
      { "awml.wasm": wasm, "version.json": version },
      { "awml.wasm": Buffer.concat([wasm, Buffer.from([0])]), "version.json": version, "build.json": stamp },
    ]) {
      elsewhere(files);
      await expect(loadAwmlModule()).rejects.toThrow(ENGINE_STALE);
      vi.restoreAllMocks();
    }
    expect(ENGINE_STALE).toContain("npm run engine:build");
  });

  it("is built only when the build doesn't match the pin, so building again does nothing", () => {
    const said = execFileSync("bash", ["scripts/engine-build.sh"], { encoding: "utf8" });
    expect(said.trim()).toBe(`vendor/awml is built from awml ${pin.tag} (${pin.commit})`);
  });
});
