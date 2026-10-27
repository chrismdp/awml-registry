// The AWML engine is built from AWML's source, never kept in git (issue #73): vendor/awml/version.json
// pins the release and commit, and `npm run engine:build` builds the WebAssembly from that commit
// into vendor/awml/, beside a stamp of what it built. A pull request's reviewers read text, so an
// engine update changes only the pin, the wrapper and the fixtures.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENGINE_MISSING, loadAwmlModule } from "@/engine/module";

const vendored = (file: string) => path.join("vendor", "awml", file);
const pinned = JSON.parse(fs.readFileSync(vendored("version.json"), "utf8")) as { tag: string; commit: string };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the engine's WebAssembly", () => {
  it("is in no file git keeps, and git ignores what the build writes", () => {
    const kept = execFileSync("git", ["ls-files", "vendor/awml"], { encoding: "utf8" }).trim().split("\n");
    expect(kept.filter((f) => f.endsWith(".wasm"))).toEqual([]);
    expect(kept).not.toContain("vendor/awml/wasm_exec.js");
    expect(kept).toEqual(expect.arrayContaining(["vendor/awml/version.json", "vendor/awml/awml.js", "vendor/awml/awml.d.ts"]));
    const ignored = execFileSync("git", ["check-ignore", vendored("awml.wasm"), vendored("wasm_exec.js"), vendored("build.json")], { encoding: "utf8" });
    expect(ignored.trim().split("\n")).toHaveLength(3);
  });

  it("is pinned to a release by its full commit", () => {
    expect(pinned.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pinned.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is loaded from the file the build wrote, which the stamp says is the pinned commit's", async () => {
    const stamp = JSON.parse(fs.readFileSync(vendored("build.json"), "utf8"));
    expect(stamp).toMatchObject(pinned);
    expect(stamp.go).toMatch(/^go\d+\.\d+/);
    const bytes = fs.readFileSync(vendored("awml.wasm"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(stamp.sha256);
    const read = vi.spyOn(fs.promises, "readFile");
    const module = await loadAwmlModule();
    expect(read).toHaveBeenCalledWith(path.join(process.cwd(), vendored("awml.wasm")));
    expect(WebAssembly.Module.exports(module).length).toBeGreaterThan(0);
  });

  it("says which command builds it when it isn't built", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), "no-engine-")));
    await expect(loadAwmlModule()).rejects.toThrow(ENGINE_MISSING);
    expect(ENGINE_MISSING).toContain("npm run engine:build");
  });

  it("is built only when the build doesn't match the pin, so building again does nothing", () => {
    const said = execFileSync("bash", ["scripts/engine-build.sh"], { encoding: "utf8" });
    expect(said.trim()).toBe(`vendor/awml is built from awml ${pinned.tag} (${pinned.commit})`);
  });
});
