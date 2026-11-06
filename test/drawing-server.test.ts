// The drawing laid out on the server (src/server/drawing.ts, issue #62): read from the engine's
// graph (issue #69), laid out by ELK, kept once worked out, and sent to the page as positions
// only, so the browser never loads ELK.
import fs from "node:fs";
import path from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxText, headHeight, headWidth, LABEL, partText, SCOPE_PAD, SCOPE_TITLE, SCOPE_WHO, type Drawing } from "@/components/flow/drawing";
import { graphOf, type Graph } from "@/components/flow/graph";
import { textWidth, wrap } from "@/components/flow/text";
import { getDb } from "@/db/client";
import { drawingsOf, layOut, layOutGraph, mapLinks } from "@/server/drawing";
import { laidOut } from "./drawn";
import { example, statements } from "./helpers";

// The drawing laid out, which these tests expect to be.
const lay = async (json: string) => laidOut(await layOut(json));

afterEach(() => {
  vi.restoreAllMocks();
});

const issue = example("flow/issue-to-pull-request.graph.json");
const map = example("flow/factory-map.graph.json");
const dinners = example("dinners.graph.json");
// A small drawing of its own for each test that counts layouts, so none was laid out before.
const small = (n: string) =>
  JSON.stringify({
    view: "security",
    groups: [],
    parts: [
      { id: `a${n}`, kind: "trigger", label: `Start ${n}` },
      { id: `b${n}`, kind: "code", label: `Work ${n}`, decider: "code", op: "do" },
    ],
    lines: [{ from: `a${n}`, to: `b${n}`, kind: "start", points: "to" }],
    comments: [],
    places: [],
  });

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
    expect(full.parts.map((p) => p.id)).toEqual(graphOf(dinners).parts.map((p) => p.id));
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
      JSON.stringify({
        view: "security",
        groups: [{ id: "people", label: "people ops: HR team and the hiring managers" }],
        parts: [
          { id: "hire", kind: "trigger", label: "A new hire", in: "people" },
          { id: "rec", kind: "context", label: "The hire record", in: "people" },
        ],
        lines: [{ from: "hire", to: "rec", kind: "data", points: "to" }],
        comments: [],
        places: [],
      }),
    );
    const people = one.scopes[0];
    const hire = one.parts[0];
    expect(people.height).toBe(headHeight(people.who) + hire.height + SCOPE_PAD);
    expect(people.width).toBe(Math.max(hire.width + 2 * SCOPE_PAD, headWidth(people)));
  });

  it("puts who a scope is for on lines of its own under its name, inside the scope, with the scope's heading growing to fit (#67)", async () => {
    const who = "anyone who reads the repository, the maintainers who review its pull requests, and the bots";
    const { full } = await lay(
      JSON.stringify({
        view: "security",
        groups: [{ id: "pub", label: `public: ${who}` }],
        parts: [
          { id: "a", kind: "trigger", label: "Start", in: "pub" },
          { id: "b", kind: "code", label: "Work", in: "pub", decider: "code", op: "do" },
        ],
        lines: [{ from: "a", to: "b", kind: "start", points: "to" }],
        comments: [],
        places: [],
      }),
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
    // The family's dinners as AWML 0.4 wrote them, whose carers scope holds more across, converted.
    const { full: wide } = await lay(example("older/dinners-04.graph.json").replace('"carers: + June, Beth"', JSON.stringify(`carers: ${who}`)));
    const carers = wide.scopes.find((s) => s.id === "carers")!;
    expect(carers.who!.length).toBeLessThan(pub.who!.length);
    expect(Math.max(...carers.who!.map((l) => textWidth(l, SCOPE_WHO.size)))).toBeGreaterThan(SCOPE_WHO.min);
    for (const line of carers.who!) expect(textWidth(line, SCOPE_WHO.size)).toBeLessThanOrEqual(carers.width - 2 * SCOPE_TITLE.left);
  });

  it("keeps each graph's drawings once worked out, so the same graph isn't laid out twice", async () => {
    const db = await getDb();
    const stored = async (json: string) => laidOut(await drawingsOf(db, json));
    const layout = vi.spyOn(ELK.prototype, "layout");
    const first = await stored(small("x"));
    // The whole drawing and Flow only: two layouts.
    expect(layout).toHaveBeenCalledTimes(2);
    const again = await stored(small("x"));
    expect(layout).toHaveBeenCalledTimes(2);
    expect(again).toEqual(first);
    // Each caller gets its own copy.
    again.full.parts[0].x = -1;
    expect((await stored(small("x"))).full.parts[0].x).not.toBe(-1);
    // Another graph is laid out afresh.
    await stored(small("y"));
    expect(layout).toHaveBeenCalledTimes(4);
  });

  it("keeps the 200 layouts used last in front of the database, and reads the others from it", async () => {
    const db = await getDb();
    const layout = vi.spyOn(ELK.prototype, "layout");
    const reads = () => statements.filter((s) => /^select .* from "drawing"/.test(s)).length;
    // A hundred graphs, each laid out whole and Flow only, and stored: 200 layouts, all kept.
    for (let i = 0; i < 100; i++) await drawingsOf(db, small(`k${i}`));
    expect(layout).toHaveBeenCalledTimes(200);
    expect(reads()).toBe(100);
    // Using the first again reads nothing, and keeps it as the newest.
    await drawingsOf(db, small("k0"));
    expect(reads()).toBe(100);
    // One more graph lets go of the two layouts used longest ago, the second graph's, which
    // is read from the database again, and isn't laid out.
    await drawingsOf(db, small("k100"));
    expect(reads()).toBe(101);
    await drawingsOf(db, small("k1"));
    expect(reads()).toBe(102);
    await drawingsOf(db, small("k0"));
    expect(reads()).toBe(102);
    expect(layout).toHaveBeenCalledTimes(202);
  }, 60_000);

  it("sizes each part's box round its label, broken into lines no wider than the box", () => {
    const part = graphOf(issue).parts.find((p) => p.id === "build")!;
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

// A workflow's graph as the engine gives it, for the triggers' tests (#127).
type Built = { groups?: { id: string; label: string; in?: string }[]; parts: object[]; lines: [string, string][] };
const built = ({ groups = [], parts, lines }: Built) =>
  JSON.stringify({
    view: "security",
    groups,
    parts,
    lines: lines.map(([from, to]) => ({ from, to, kind: "start", points: "to" })),
    comments: [],
    places: [],
  });
const trigger = (id: string, scope?: string) => ({ id, kind: "trigger", label: `When ${id}`, ...(scope ? { in: scope } : {}) });
const step = (id: string, scope?: string, description?: string) => ({
  id,
  kind: "code",
  label: `Do ${id}`,
  decider: "code",
  op: "do",
  ...(scope ? { in: scope } : {}),
  ...(description ? { description } : {}),
});
// Three triggers, none in a scope: ELK, left to itself, puts t2 a layer down, beside the step
// t3 starts, and t3 to the left of t1; in file order, t2's lines cross t1's or t3's.
const three = (description?: string) =>
  built({
    parts: [trigger("t1"), step("a", undefined, description), step("b"), step("c"), trigger("t2"), trigger("t3")],
    lines: [["t1", "a"], ["a", "b"], ["b", "c"], ["t2", "c"], ["t3", "a"], ["t2", "b"]],
  });
const named = (d: Drawing) => ({
  part: (id: string) => d.parts.find((p) => p.id === id)!,
  scope: (id: string) => d.scopes.find((s) => s.id === id)!,
});
// Every node ELK was asked to lay out, from the root down.
const nodes = (n: ElkNode): ElkNode[] => (n.children ?? []).flatMap((c) => [c, ...nodes(c)]);
// The graph ELK was given for each layout a spy on it saw.
const asked = (layout: { mock: { calls: unknown[][] } }) => layout.mock.calls.map(([root]) => root as ElkNode);
const FIRST = "elk.layered.layering.layerConstraint";

describe("a workflow's triggers, laid out along the top (#127)", () => {
  it("puts each trigger above every other part in its scope, where ELK put one lower", async () => {
    const { full, flow } = await lay(three());
    for (const d of [full, flow]) {
      const triggers = d.parts.filter((p) => p.kind === "trigger");
      expect(triggers.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
      const others = d.parts.filter((p) => p.kind !== "trigger");
      for (const t of triggers) for (const o of others) expect(t.y + t.height, `${t.id} above ${o.id}`).toBeLessThan(o.y);
    }
  });

  it("puts the triggers outside every scope at the same top, left to right in file order, though it adds a crossing", async () => {
    const { full, flow } = await lay(three());
    for (const d of [full, flow]) {
      const { part } = named(d);
      const [t1, t2, t3] = ["t1", "t2", "t3"].map(part);
      expect(new Set([t1.y, t2.y, t3.y]).size).toBe(1);
      expect(t1.x + t1.width).toBeLessThan(t2.x);
      expect(t2.x + t2.width).toBeLessThan(t3.x);
    }
  });

  it("puts the triggers inside a scope at the same top of it, left to right in file order, though it adds a crossing", async () => {
    const inScope = (p: object) => ({ ...p, in: "team" });
    const { full, flow } = await lay(
      built({
        groups: [{ id: "team", label: "team: the people who do it" }],
        parts: [trigger("t1"), step("a"), step("b"), step("c"), trigger("t2"), trigger("t3")].map(inScope),
        lines: [["t1", "a"], ["a", "b"], ["b", "c"], ["t2", "c"], ["t3", "a"], ["t2", "b"]],
      }),
    );
    for (const d of [full, flow]) {
      const { part, scope } = named(d);
      const [t1, t2, t3] = ["t1", "t2", "t3"].map(part);
      expect(new Set([t1.y, t2.y, t3.y, scope("team").y + headHeight(scope("team").who)]).size).toBe(1);
      expect(t1.x + t1.width).toBeLessThan(t2.x);
      expect(t2.x + t2.width).toBeLessThan(t3.x);
    }
    // As the triggers of a workflow on awml.io are, both in its one scope.
    const { full: issued } = await lay(issue);
    const [comment, dispatch] = ["comment", "dispatch"].map(named(issued).part);
    expect(comment.y).toBe(dispatch.y);
    expect(comment.x + comment.width).toBeLessThan(dispatch.x);
  });

  it("puts a trigger inside a scope at the top of that scope, and the scope level with the triggers outside every scope, in file order", async () => {
    const { full } = await lay(
      built({
        groups: [{ id: "team", label: "team: the people who do it" }],
        parts: [trigger("t0"), step("x"), trigger("st", "team"), step("sy", "team"), trigger("t9")],
        lines: [["t0", "x"], ["x", "sy"], ["st", "sy"], ["t9", "x"]],
      }),
    );
    const { part, scope } = named(full);
    const team = scope("team");
    expect(part("st").y - team.y).toBe(headHeight(team.who));
    expect(part("sy").y).toBeGreaterThan(part("st").y + part("st").height);
    expect(team.y).toBe(part("t0").y);
    expect(part("t9").y).toBe(part("t0").y);
    // The scope among the triggers outside it, by its first trigger in the file.
    expect(part("t0").x + part("t0").width).toBeLessThan(team.x);
    expect(team.x + team.width).toBeLessThan(part("t9").x);
  });

  it("puts a scope holding a trigger at the top of the scope it is in, and that scope at the top too", async () => {
    const { full } = await lay(
      built({
        groups: [
          { id: "outer", label: "outer: everyone" },
          { id: "inner", label: "inner: the few", in: "outer" },
        ],
        parts: [trigger("t0"), step("c"), step("b", "outer"), trigger("it", "inner"), step("a", "inner")],
        lines: [["t0", "c"], ["it", "a"], ["a", "b"], ["b", "c"]],
      }),
    );
    const { part, scope } = named(full);
    const [outer, inner] = [scope("outer"), scope("inner")];
    expect(outer.y).toBe(part("t0").y);
    expect(inner.y - outer.y).toBe(headHeight(outer.who));
    expect(part("it").y - inner.y).toBe(headHeight(inner.who));
    expect(part("b").y).toBeGreaterThan(inner.y + inner.height);
  });

  it("puts the triggers the same way in the layouts with descriptions open (#114)", async () => {
    const drawn = await lay(three("A step that takes a long description, so its part is opened taller and wider than it was"));
    expect(drawn.open).toBeDefined();
    for (const d of [drawn.open!.full, drawn.open!.flow]) {
      const { part } = named(d);
      const [t1, t2, t3] = ["t1", "t2", "t3"].map(part);
      expect(new Set([t1.y, t2.y, t3.y]).size).toBe(1);
      expect(t1.x + t1.width).toBeLessThan(t2.x);
      expect(t2.x + t2.width).toBeLessThan(t3.x);
      for (const o of d.parts.filter((p) => p.kind !== "trigger")) expect(t1.y + t1.height).toBeLessThan(o.y);
    }
  });

  it("asks ELK to keep the triggers first for every layout of a workflow, and never for a system's map", async () => {
    const layout = vi.spyOn(ELK.prototype, "layout");
    await layOut(three("Described, so all four layouts are made"));
    expect(layout).toHaveBeenCalledTimes(4);
    for (const root of asked(layout)) {
      const constrained = nodes(root).filter((n) => n.layoutOptions?.[FIRST] === "FIRST").map((n) => n.id);
      expect(constrained).toEqual(["t1", "t2", "t3"]);
    }
    layout.mockClear();
    await layOut(map);
    expect(layout).toHaveBeenCalled();
    for (const root of asked(layout)) expect(nodes(root).some((n) => n.layoutOptions?.[FIRST])).toBe(false);
  });

  it("still draws when ELK refuses the triggers' places, laid out again without them, and logs why", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const layout = vi.spyOn(ELK.prototype, "layout");
    // A trigger outside the scope starts a step in it, and the scope holds a trigger, so ELK
    // can't have both the trigger and the scope in the first layer.
    const json = built({
      groups: [{ id: "team", label: "team: the people who do it" }],
      parts: [trigger("t0"), trigger("st", "team"), step("sy", "team")],
      lines: [["t0", "sy"], ["st", "sy"]],
    });
    const { full, flow } = await lay(json);
    expect(full.parts.map((p) => p.id)).toEqual(["t0", "st", "sy"]);
    expect(flow.parts.map((p) => p.id)).toEqual(["t0", "st", "sy"]);
    // Each of the two drawings was tried with the triggers first, then without.
    expect(layout).toHaveBeenCalledTimes(4);
    const calls = asked(layout).map((root) => nodes(root).some((n) => n.layoutOptions?.[FIRST]));
    expect(calls.filter(Boolean)).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[awml\] ELK could not lay a drawing out with its triggers along the top, so it is laid out again without them: /));
  });

  it("lays out a graph whose scopes are each inside the other without walking up them for ever", async () => {
    const looped: Graph = {
      parts: [{ id: "t", kind: "trigger", label: "When", scope: "a" }],
      scopes: [
        { id: "a", label: "a", dashed: true, scope: "b" },
        { id: "b", label: "b", dashed: true, scope: "a" },
      ],
      lines: [],
      notes: [],
    };
    await expect(layOutGraph(looped)).resolves.toBeDefined();
  });
});

describe("a system's map, laid out on the server", () => {
  it("draws each trigger outside its workflow's box, with a line into it, as the engine gives it", async () => {
    const { full } = await lay(map);
    const trigger = full.parts.find((p) => p.id === "w1_comment")!;
    expect(trigger.scope).toBeUndefined();
    expect(full.lines.find((l) => l.from === "w1_comment" && l.to === "w1")).toBeDefined();
    // Each box holds the outside actions that start other workflows, and names its workflow.
    expect(full.scopes.map((s) => [s.id, s.holds, s.name, s.workflow])).toEqual([
      ["w1", true, "An issue becomes a pull request", "chrismdp/issue-to-pull-request"],
      ["w2", true, "A pull request lands once CI has run", "chrismdp/land-a-pull-request"],
      ["w3", true, "A failed build tries again", "chrismdp/retry-a-build"],
    ]);
    expect(full.parts.find((p) => p.id === "w1_tryfailed")?.scope).toBe("w1");
  });

  it("draws a box that holds nothing as a box with its name in it", async () => {
    const bakery = example("bakery-map.graph.json");
    const { full } = await lay(bakery);
    expect(full.scopes.map((s) => [s.id, s.holds, s.lines])).toEqual([
      ["w1", true, []],
      ["w2", false, ["The bakery's supplier order"]],
    ]);
  });

  it("leads each part joined to workflows' boxes to those workflows, and none to a box the viewer may not open", async () => {
    const { full } = await lay(map);
    const boxes = {
      w1: { title: "An issue becomes a pull request", address: "chrismdp/issue-to-pull-request", href: "/chrismdp/issue-to-pull-request" },
      w3: { title: "A failed build tries again", address: "chrismdp/retry-a-build", href: "/chrismdp/retry-a-build" },
    };
    const links = mapLinks(full, boxes);
    // The Actions token the build and the retry both read: it leads to both.
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
    // The GitHub App joins only w1 and w2: it leads to w1 alone.
    expect(links.find((l) => l.part === "s2")?.to).toEqual([{ label: "chrismdp/issue-to-pull-request", href: "/chrismdp/issue-to-pull-request" }]);
    // The trigger a failed try starts leads into the retry's box.
    expect(links.find((l) => l.part === "w3_tryfailed")).toMatchObject({ title: "In A failed build tries again" });
    // The outside action that starts a retry leads to the retry, by the trigger it starts.
    expect(links.find((l) => l.part === "w1_tryfailed")).toEqual({
      part: "w1_tryfailed",
      title: "Starts A failed build tries again",
      to: [{ label: "chrismdp/retry-a-build", href: "/chrismdp/retry-a-build" }],
    });
    // The one that starts the landing starts a workflow not given, so it leads nowhere.
    expect(links.find((l) => l.part === "w1_pushed")).toBeUndefined();
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
    // The drawing moves by overlap alone (#78), with no force layout.
    expect(packages).not.toContain("d3-force");
    expect(packages).not.toContain("elkjs");
    expect(modules).not.toContain("server/drawing.ts");
  });
});
