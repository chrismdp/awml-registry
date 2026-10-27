// The drawing laid out on the server (src/server/drawing.ts, issue #62): read from the engine's
// Mermaid text, laid out by ELK, kept once worked out, and sent to the page as positions only, so
// the browser never loads ELK.
import fs from "node:fs";
import path from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxText, headHeight, headWidth, LABEL, partText, SCOPE_PAD, SCOPE_TITLE, SCOPE_WHO, type Drawing } from "@/components/flow/drawing";
import { parseMermaid } from "@/components/flow/graph";
import { textWidth, wrap } from "@/components/flow/text";
import { layOut, mapLinks } from "@/server/drawing";
import { laidOut } from "./drawn";
import { example } from "./helpers";

// The drawing laid out, which these tests expect to be.
const lay = async (text: string, opts?: { map?: boolean }) => laidOut(await layOut(text, opts));

afterEach(() => {
  vi.restoreAllMocks();
});

const issue = example("flow/issue-to-pull-request.mmd");
const map = example("flow/factory-map.mmd");
const dinners = example("dinners.mmd");
// A small drawing of its own for each test that counts layouts, so none was laid out before.
const small = (n: string) => `flowchart TB\n  a${n}(["Start ${n}"])\n  b${n}("<small>⚙️ 🛠️ do</small><br>Work ${n}")\n  a${n} --> b${n}\n  class a${n} trig\n  class b${n} code`;

const inside = (r: { x: number; y: number; width: number; height: number }, s: typeof r) =>
  r.x >= s.x && r.y >= s.y && r.x + r.width <= s.x + s.width && r.y + r.height <= s.y + s.height;

// How far a scope's edges are from the box round the parts and scopes in it, rounded.
function padding(d: Drawing, id: string) {
  const s = d.scopes.find((x) => x.id === id)!;
  const held = [...d.parts.filter((p) => p.scope === id), ...d.scopes.filter((x) => x.scope === id)];
  const left = Math.min(...held.map((r) => r.x));
  const top = Math.min(...held.map((r) => r.y));
  const right = Math.max(...held.map((r) => r.x + r.width));
  const bottom = Math.max(...held.map((r) => r.y + r.height));
  return {
    top: Math.round(top - s.y),
    left: Math.round(left - s.x),
    bottom: Math.round(s.y + s.height - bottom),
    right: Math.round(s.x + s.width - right),
  };
}

describe("laying a drawing out on the server", () => {
  it("places every part inside its scope, every scope inside the one it is in, and routes every line", async () => {
    const { full } = await lay(dinners);
    const scopes = new Map(full.scopes.map((s) => [s.id, s]));
    expect(full.parts.map((p) => p.id)).toEqual(parseMermaid(dinners).parts.map((p) => p.id));
    for (const p of full.parts) if (p.scope) expect(inside(p, scopes.get(p.scope)!), p.id).toBe(true);
    for (const s of full.scopes) if (s.scope) expect(inside(s, scopes.get(s.scope)!), s.id).toBe(true);
    for (const p of full.parts) expect(inside(p, full.box), p.id).toBe(true);
    for (const l of full.lines) expect(l.points.length, l.id).toBeGreaterThanOrEqual(2);
    // A labelled line's label sits on its pill, broken into lines.
    const posted = full.lines.find((l) => l.label?.lines.join(" ") === "posted");
    expect(posted?.label).toMatchObject({ lines: ["posted"] });
    // No two parts overlap.
    for (const a of full.parts)
      for (const b of full.parts)
        if (a !== b) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} ${b.id}`).toBe(true);
  });

  it("lays out Flow only (#51) on its own: no contexts and no dotted lines, so it is smaller", async () => {
    const { full, flow } = await lay(issue);
    expect(flow.parts.some((p) => p.kind === "context")).toBe(false);
    expect(flow.lines.some((l) => l.style === "dotted")).toBe(false);
    expect(flow.parts.length).toBeLessThan(full.parts.length);
    expect(flow.box.height).toBeLessThan(full.box.height);
  });

  it("shrinks each scope in Flow only to the smallest box round what is left in it, plus its padding (#67)", async () => {
    const { full, flow } = await lay(dinners);
    for (const s of flow.scopes) {
      const whole = full.scopes.find((f) => f.id === s.id)!;
      expect(s.width, s.id).toBeLessThan(whole.width);
      expect(s.height, s.id).toBeLessThan(whole.height);
      expect(padding(flow, s.id), s.id).toEqual({ top: headHeight(s.who), left: SCOPE_PAD, bottom: SCOPE_PAD, right: SCOPE_PAD });
    }
    // A scope left with a trigger alone is just big enough for it and its heading: no taller
    // for its heading being wide, as ELK made it when given its least width the wrong way round.
    const { flow: one } = await lay(
      `flowchart TB\n  subgraph people["people ops#58; HR team and the hiring managers"]\n    hire(["A new hire"])\n    rec[("The hire record")]\n  end\n  hire -.-> rec\n  class hire trig\n  class rec ctx\n  style people fill:transparent,stroke:#8a93a3,stroke-dasharray:6 4`,
    );
    const people = one.scopes[0];
    const hire = one.parts[0];
    expect(people.height).toBe(headHeight(people.who) + hire.height + SCOPE_PAD);
    expect(people.width).toBe(Math.max(hire.width + 2 * SCOPE_PAD, headWidth(people)));
  });

  it("puts who a scope is for on lines of its own under its name, inside the scope, with the scope's heading growing to fit (#67)", async () => {
    const who = "anyone who reads the repository, the maintainers who review its pull requests, and the bots";
    const { full } = await lay(
      `flowchart TB\n  subgraph pub["public#58; ${who}"]\n    a(["Start"])\n    b("<small>⚙️ 🛠️ do</small><br>Work")\n  end\n  a --> b\n  class a trig\n  class b code\n  style pub fill:transparent,stroke:#8a93a3,stroke-dasharray:6 4`,
    );
    const pub = full.scopes[0];
    expect(pub.name).toBe("public");
    expect(pub.who!.length).toBeGreaterThan(1);
    expect(pub.who!.join(" ")).toBe(who);
    // Never broken narrower than SCOPE_WHO.min, though the parts are narrower, and always
    // inside the scope: the scope is made wide enough.
    expect(Math.max(...pub.who!.map((l) => textWidth(l, SCOPE_WHO.size)))).toBeGreaterThan(SCOPE_WHO.min * 0.75);
    for (const line of pub.who!) expect(textWidth(line, SCOPE_WHO.size)).toBeLessThanOrEqual(SCOPE_WHO.min);
    expect(pub.width).toBeGreaterThanOrEqual(headWidth(pub));
    for (const line of pub.who!) expect(SCOPE_TITLE.left + textWidth(line, SCOPE_WHO.size)).toBeLessThan(pub.width - SCOPE_TITLE.left / 2);
    // The parts start below the heading's last line.
    const top = Math.min(...full.parts.map((p) => p.y));
    expect(top - pub.y).toBe(headHeight(pub.who));
    expect(headHeight(pub.who)).toBeGreaterThan(SCOPE_TITLE.height + pub.who!.length * SCOPE_WHO.line);
    // A scope holding more than SCOPE_WHO.min across breaks them wider, still inside it.
    const { full: wide } = await lay(dinners.replace("carers#58; #43; June#44; Beth", `carers#58; ${who}`));
    const carers = wide.scopes.find((s) => s.id === "carers")!;
    expect(carers.who!.length).toBeLessThan(pub.who!.length);
    expect(Math.max(...carers.who!.map((l) => textWidth(l, SCOPE_WHO.size)))).toBeGreaterThan(SCOPE_WHO.min);
    for (const line of carers.who!) expect(textWidth(line, SCOPE_WHO.size)).toBeLessThanOrEqual(carers.width - 2 * SCOPE_TITLE.left);
  });

  it("keeps each layout once worked out, by the text, the switch and the engine, so the same drawing isn't laid out twice", async () => {
    const layout = vi.spyOn(ELK.prototype, "layout");
    const first = await lay(small("x"));
    // The whole drawing and Flow only: two layouts.
    expect(layout).toHaveBeenCalledTimes(2);
    const again = await lay(small("x"));
    expect(layout).toHaveBeenCalledTimes(2);
    expect(again).toEqual(first);
    // Each caller gets its own copy.
    again.full.parts[0].x = -1;
    expect((await lay(small("x"))).full.parts[0].x).not.toBe(-1);
    // Another text is laid out afresh.
    await lay(small("y"));
    expect(layout).toHaveBeenCalledTimes(4);
  });

  it("keeps only the 200 layouts used last", async () => {
    const layout = vi.spyOn(ELK.prototype, "layout");
    // A hundred drawings, each laid out whole and Flow only: 200 layouts, all kept.
    for (let i = 0; i < 100; i++) await lay(small(`k${i}`));
    expect(layout).toHaveBeenCalledTimes(200);
    // Using the first again keeps it as the newest.
    await lay(small("k0"));
    expect(layout).toHaveBeenCalledTimes(200);
    // One more drawing lets go of the two layouts used longest ago, the second drawing's.
    await lay(small("k100"));
    expect(layout).toHaveBeenCalledTimes(202);
    await lay(small("k1"));
    expect(layout).toHaveBeenCalledTimes(204);
    await lay(small("k0"));
    expect(layout).toHaveBeenCalledTimes(204);
  }, 60_000);

  it("sizes each part's box round its label, broken into lines no wider than the box", () => {
    const part = parseMermaid(issue).parts.find((p) => p.id === "build")!;
    const t = partText(part);
    expect(t.caption).toBe("AI · draft");
    expect(t.lines.length).toBeGreaterThan(1);
    for (const line of t.lines) expect(textWidth(line, LABEL.size)).toBeLessThanOrEqual(t.width - 32);
    expect(t.lines.join(" ")).toBe(part.label);
    // A word longer than a line is broken inside it.
    expect(wrap("a".repeat(80), 14, 100).every((l) => textWidth(l, 14) <= 100)).toBe(true);
    expect(wrap("", 14, 100)).toEqual([""]);
    // A workflow's box on a map is wide enough for its name, broken into lines.
    const box = boxText({ id: "w1", label: "An issue becomes a pull request", dashed: false });
    expect(box.lines).toEqual(["An issue becomes a pull", "request"]);
    for (const line of box.lines) expect(textWidth(line, 16)).toBeLessThan(box.width - 44);
  });
});

describe("a system's map, laid out on the server", () => {
  it("draws each trigger outside its workflow's box, with a line into it", async () => {
    const { full } = await lay(map, { map: true });
    const trigger = full.parts.find((p) => p.id === "w1_comment")!;
    expect(trigger.scope).toBeUndefined();
    expect(full.lines.find((l) => l.from === "w1_comment" && l.to === "w1")).toBeDefined();
    // A workflow's box holds nothing, so it is a box with its name in it.
    expect(full.scopes.map((s) => [s.id, s.holds, s.lines])).toEqual([
      ["w1", false, ["An issue becomes a pull", "request"]],
      ["w2", false, ["A pull request lands once CI", "has run"]],
      ["w3", false, ["A failed build tries again"]],
    ]);
  });

  it("leads each part joined to workflows' boxes to those workflows, and none to a box the viewer may not open", async () => {
    const { full } = await lay(map, { map: true });
    const boxes = {
      w1: { title: "An issue becomes a pull request", address: "chrismdp/issue-to-pull-request", href: "/chrismdp/issue-to-pull-request" },
      w3: { title: "A failed build tries again", address: "chrismdp/retry-a-build", href: "/chrismdp/retry-a-build" },
    };
    const links = mapLinks(full, boxes);
    // The trigger the retry fires starts the build: it leads to both.
    expect(links.find((l) => l.part === "s1")).toEqual({
      part: "s1",
      title: "In An issue becomes a pull request and A failed build tries again",
      to: [
        { label: "chrismdp/issue-to-pull-request", href: "/chrismdp/issue-to-pull-request" },
        { label: "chrismdp/retry-a-build", href: "/chrismdp/retry-a-build" },
      ],
    });
    // w2 isn't given, so nothing leads to it.
    expect(JSON.stringify(links)).not.toContain("land-a-pull-request");
    // The app's push joins only w1 and w2: it leads to w1 alone.
    expect(links.find((l) => l.part === "s9")?.to).toEqual([{ label: "chrismdp/issue-to-pull-request", href: "/chrismdp/issue-to-pull-request" }]);
  });
});

// Every module the browser may load: each "use client" file, and what it imports, but not its
// type-only imports, which leave nothing behind.
function clientModules() {
  const src = path.join(__dirname, "../src");
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const resolve = (from: string, spec: string) => {
    const base = spec.startsWith("@/") ? path.join(src, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const f of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")])
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    return null;
  };
  const roots = files(src).filter((f) => /\.tsx?$/.test(f) && /^\s*["']use client["']/.test(fs.readFileSync(f, "utf8")));
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = fs.readFileSync(file, "utf8");
    const specs = [
      ...code.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm),
      ...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const found = resolve(file, spec);
      if (found) queue.push(found);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return { roots, modules: [...seen].map((f) => path.relative(src, f)), packages: [...packages].sort() };
}

describe("what the browser loads", () => {
  it("never includes ELK, or the server's layout", () => {
    const { roots, modules, packages } = clientModules();
    // The drawing's own client modules are among those walked.
    for (const m of ["components/Drawing.tsx", "components/flow/FlowCanvas.tsx", "components/flow/StaticDrawing.tsx", "components/flow/physics.ts"])
      expect(modules).toContain(m);
    expect(roots.length).toBeGreaterThan(5);
    expect(packages).toContain("@xyflow/react");
    expect(packages).toContain("d3-force");
    expect(packages).not.toContain("elkjs");
    expect(modules).not.toContain("server/drawing.ts");
  });
});
