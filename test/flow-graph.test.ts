import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { flowOnly, graphOf, readGraph, type EngineGraph, type Graph } from "@/components/flow/graph";
import { engine } from "@/engine";

// The graph AWML 0.8.0's native `awml graph` prints, as the registry gets it from the engine
// (npm run engine:update writes them): the security view of the registry's own factory,
// chrismdp/issue-to-pull-request, the map of the factory system it is in, the dinners example's
// security view and its home implementation, and the bakery's map, where one workflow starts
// another with an outside action. What each test expects is read from the YAML the graph is of.
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const issueFile = fixture("flow/chrismdp/issue-to-pull-request.yaml");
const issue = graphOf(fixture("flow/issue-to-pull-request.graph.json"));
const map = graphOf(fixture("flow/factory-map.graph.json"));
const dinnersFile = fixture("dinners.yaml");
const dinners = graphOf(fixture("dinners.graph.json"));
const bakery = graphOf(fixture("bakery-map.graph.json"));

type Doc = {
  scopes?: { id: string; label: string; in?: string }[];
  parts: { id: string; kind: string; label: string; op?: string; in?: string }[];
  lines: { from: string; to: string; kind: string; label?: string }[];
};
const doc = (file: string) => parse(file) as Doc;

const part = (g: Graph, id: string) => g.parts.find((p) => p.id === id);
const line = (g: Graph, from: string, to: string) => g.lines.find((l) => l.from === from && l.to === to);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// The registry's name for each of AWML's kinds of part.
const KIND: Record<string, string> = { connector: "connection", review: "person", approval: "person" };

describe("reading a drawing's graph from the engine", () => {
  it("reads every part but a comment, with its kind, its label and the scope it is in", () => {
    const parts = doc(issueFile).parts.filter((p) => p.kind !== "comment");
    expect(issue.parts.map((p) => p.id)).toEqual(parts.map((p) => p.id));
    for (const p of parts) {
      const read = part(issue, p.id)!;
      expect(read.kind, p.id).toBe(KIND[p.kind] ?? p.kind);
      // A trigger given no scope is drawn beside the part its first line leads to.
      const first = doc(issueFile).lines.find((l) => l.from === p.id);
      const beside = parts.find((q) => q.id === first?.to)?.in;
      expect(read.scope, p.id).toBe(p.in ?? (p.kind === "trigger" ? beside : undefined));
      expect(read.tier ? `${read.label}: ${read.tier}` : read.label, p.id).toBe(squash(p.label));
    }
    expect(part(issue, "comment")?.scope).toBe("public");
  });

  it("reads a step's kind of work, and an outside action's tier apart from its label", () => {
    for (const p of doc(issueFile).parts.filter((p) => ["ai", "code", "person"].includes(p.kind)))
      expect(part(issue, p.id)?.verb, p.id).toBe(p.op);
    expect(part(issue, "status")).toMatchObject({ kind: "outside", label: "Post or edit the build's status comment", tier: "Allow" });
    // A tier with words after it keeps them.
    const g = readGraph({
      view: "security",
      groups: [],
      parts: [{ id: "basket", kind: "outside", label: "Fill the basket: Allow under £180", tier: "Allow" }],
      lines: [],
      comments: [],
      places: [],
    });
    expect(g.parts[0]).toEqual({ id: "basket", kind: "outside", label: "Fill the basket", tier: "Allow under £180" });
  });

  it("reads scopes with their nesting, dashed in a security view", () => {
    expect(dinners.scopes).toEqual(
      (doc(dinnersFile).scopes ?? []).map((s) => ({ id: s.id, label: s.label, dashed: true, ...(s.in ? { scope: s.in } : {}) })),
    );
  });

  it("draws every line but a tie, each solid, dotted into or out of what holds information, or thick where it publishes", () => {
    const lines = doc(issueFile).lines.filter((l) => l.kind !== "tie" && l.kind !== "hidden");
    expect(issue.lines.map((l) => [l.from, l.to])).toEqual(lines.map((l) => [l.from, l.to]));
    const kinds = new Map(doc(issueFile).parts.map((p) => [p.id, p.kind]));
    for (const l of lines) {
      const beside = ["context", "connector", "surface"].some((k) => kinds.get(l.from) === k || kinds.get(l.to) === k);
      expect(line(issue, l.from, l.to), `${l.from} ${l.to}`).toMatchObject({
        style: beside ? "dotted" : "solid",
        arrowStart: false,
        arrowEnd: true,
        ...(l.label ? { label: squash(l.label) } : {}),
      });
    }
    // The standing rule publishes: thick, its label followed by what it widens.
    expect(line(dinners, "mealplan", "screen")).toMatchObject({
      style: "thick",
      label: "standing rule: dinners to carers · adds June and Beth",
      arrowEnd: true,
    });
  });

  it("puts each comment on the parts it is tied to, and marks a gap, which says what is missing from the design", () => {
    const comments = doc(issueFile).parts.filter((p) => p.kind === "comment");
    const ties = doc(issueFile).lines.filter((l) => l.kind === "tie");
    expect(issue.notes).toHaveLength(ties.length);
    for (const c of comments) {
      const on = ties.flatMap((t) => (t.from === c.id ? [t.to] : t.to === c.id ? [t.from] : []));
      expect(issue.notes.filter((n) => n.id === c.id), c.id).toEqual(on.map((p) => ({ id: c.id, on: p, text: squash(c.label) })));
    }
    // No note is a part, and no line leads to one.
    const notes = new Set(issue.notes.map((n) => n.id));
    expect(issue.parts.filter((p) => notes.has(p.id))).toEqual([]);
    expect(issue.lines.filter((l) => notes.has(l.from) || notes.has(l.to))).toEqual([]);
    expect(dinners.notes).toEqual([
      { id: "screen_gap", on: "screen", text: "Missing from the design: no scheduled task keeps the screen current", gap: true },
    ]);
  });

  it("reads the colours the engine gives each place a platform view puts parts", () => {
    const home = graphOf(fixture("dinners-home.graph.json"));
    expect(home.scopes.find((s) => s.id === "server")).toEqual({ id: "server", label: "Server: claude-sonnet-4-5", dashed: false, fill: "#e3ebfa", stroke: "#b9c8e8" });
    expect(home.scopes.every((s) => s.fill && s.stroke && !s.dashed)).toBe(true);
    // A security view's scopes are dashed, and keep no colours.
    expect(dinners.scopes.every((s) => s.fill === undefined)).toBe(true);
  });

  it("takes only a colour for a place, draws a line that breaks a rule red, a refused read with a cross, and no hidden line", () => {
    // A line that breaks a rule is red, its label followed by the rule's words. From AWML 0.8 the
    // registry draws one, for untrusted text that reaches an outside action that nothing stops
    // (see "untrusted text" below).
    const g = readGraph({
      view: "platform",
      groups: [{ id: "p", label: "P" }],
      parts: [
        { id: "a", kind: "code", label: "A", in: "p", decider: "code", op: "do" },
        { id: "b", kind: "context", label: "B", in: "p" },
        { id: "c", kind: "surface", label: "C", in: "p" },
      ],
      lines: [
        { from: "a", to: "b", kind: "data", points: "to", label: "the list", publishes: true, widens: ["adds June"], breaks: ["a do step must not publish"] },
        { from: "b", to: "a", kind: "refused", points: "to" },
        { from: "a", to: "c", kind: "hidden", points: "none" },
      ],
      comments: [],
      places: [{ id: "p", fill: "url(javascript:x)", stroke: "#123456" }],
    });
    expect(g.scopes).toEqual([{ id: "p", label: "P", dashed: false }]);
    expect(g.lines).toEqual([
      { id: "line-0", from: "a", to: "b", style: "thick", label: "the list · adds June · a do step must not publish", arrowStart: false, arrowEnd: true, broken: true },
      { id: "line-1", from: "b", to: "a", style: "dotted", arrowStart: false, arrowEnd: false, refused: true },
    ]);
  });

  it("reads a system's map: a box per workflow, named by its owner/slug, each trigger outside its box", () => {
    expect(map.scopes.map((s) => [s.id, s.label, s.dashed, s.workflow])).toEqual([
      ["w1", "An issue becomes a pull request", false, "chrismdp/issue-to-pull-request"],
      ["w2", "A pull request lands once CI has run", false, "chrismdp/land-a-pull-request"],
      ["w3", "A failed build tries again", false, "chrismdp/retry-a-build"],
    ]);
    expect(part(map, "w1_comment")).toMatchObject({ kind: "trigger" });
    expect(part(map, "w1_comment")?.scope).toBeUndefined();
    expect(line(map, "w1_comment", "w1")).toMatchObject({ style: "solid", arrowEnd: true });
    // A line between a workflow and a part it shares points each way it leads.
    expect(line(map, "w1", "s1")).toMatchObject({ style: "dotted", arrowStart: true, arrowEnd: true });
    expect(line(map, "w2", "s1")).toMatchObject({ style: "dotted", arrowStart: false, arrowEnd: true });
  });

  it("draws an outside action that starts another workflow in its own box, with a line to the trigger it starts", () => {
    expect(part(bakery, "w1_start")).toEqual({ id: "w1_start", kind: "outside", label: "Start the supplier order", tier: "Allow", scope: "w1" });
    expect(part(bakery, "w2_low")).toEqual({ id: "w2_low", kind: "trigger", label: "Flour, butter or sugar runs low" });
    expect(line(bakery, "w1_start", "w2_low")).toMatchObject({ style: "solid", arrowEnd: true });
    expect(line(bakery, "w2_low", "w2")).toMatchObject({ style: "solid", arrowEnd: true });
    // The engine is given each file at a path ending owner/slug.yaml: here the file's own name.
    expect(bakery.scopes.map((s) => s.workflow)).toEqual([undefined, undefined]);
    // On the factory's map, each try that fails starts a retry.
    expect(line(map, "w1_tryfailed", "w3_tryfailed")).toMatchObject({ style: "solid", arrowEnd: true });
    expect(line(map, "w2_tryfailed", "w3_tryfailed")).toMatchObject({ style: "solid", arrowEnd: true });
  });
});

describe("Flow only", () => {
  it("leaves out contexts and every dotted line, and the parts no line is left to", () => {
    const flow = flowOnly(issue);
    expect(flow.lines.every((l) => l.style !== "dotted")).toBe(true);
    expect(flow.parts.filter((p) => p.kind === "context")).toEqual([]);
    // Connections are reached only by dotted lines, so none is left.
    expect(flow.parts.filter((p) => p.kind === "connection")).toEqual([]);
    // Every step stays, and every trigger and outside action with a line.
    const steps = doc(issueFile).parts.filter((p) => ["ai", "code", "person"].includes(p.kind));
    expect(flow.parts.filter((p) => ["ai", "code", "person"].includes(p.kind))).toHaveLength(steps.length);
    expect(part(flow, "pr")).toBeDefined();
    expect(part(flow, "comment")).toBeDefined();
    expect(flow.lines).toHaveLength(issue.lines.filter((l) => l.style !== "dotted").length);
  });

  it("keeps the notes of the parts it keeps", () => {
    // The GitHub App's note goes with it; the kitchen screen's gap goes with the screen.
    expect(flowOnly(issue).notes.map((n) => n.on).sort()).toEqual(["bring", "build", "comment", "gate", "open", "review", "started"]);
    expect(flowOnly(dinners).notes).toEqual([]);
  });

  it("drops a thick line when a part it joins goes, and keeps every scope", () => {
    // The standing rule joins a surface and a context, so both go, and it with them.
    expect(flowOnly(dinners).lines.find((l) => l.style === "thick")).toBeUndefined();
    expect(flowOnly(dinners).scopes).toEqual(dinners.scopes);
  });
});

describe("text as the file wrote it", () => {
  // The engine's graph gives every label exactly as the file wrote it, unescaped, line breaks
  // included: the registry folds each run of whitespace into one space, and escapes nothing
  // itself, since the page shows text only as text (test/drawing-frame.test.tsx).
  it("folds line breaks in labels, a line that says end in one ending nothing", async () => {
    const g = graphOf(await engine.graph(fixture("label-end.yaml")));
    expect(g.scopes).toEqual([{ id: "home", label: "home: the end family", dashed: true }]);
    expect(g.parts).toEqual([
      { id: "tick", kind: "trigger", label: "Every end morning", scope: "home" },
      { id: "step", kind: "code", verb: "do", label: 'Do it "quoted"', scope: "home" },
    ]);
  });

  it("puts a comment tied to two parts on both, and one tied to nothing on the whole drawing", async () => {
    const g = graphOf(await engine.graph(fixture("label-folded.yaml")));
    expect(g.notes).toEqual([
      { id: "c1", on: "step", text: "Tied to two parts" },
      { id: "c1", on: "note", text: "Tied to two parts" },
      { id: "c2", text: "Tied to nothing" },
    ]);
    expect(g.lines.map((l) => [l.from, l.to, l.label])).toEqual([
      ["tick", "step", "first second"],
      ["step", "note", undefined],
    ]);
    // Flow only keeps the notes of the whole drawing.
    expect(flowOnly(g).notes.filter((n) => !n.on)).toEqual([{ id: "c2", text: "Tied to nothing" }]);
  });

  it("puts a gap tied to nothing on the whole drawing, marked as a gap, even in a scope", () => {
    const g = readGraph({
      view: "security",
      groups: [{ id: "home", label: "home: the family" }],
      parts: [{ id: "a", kind: "code", label: "A", in: "home", decider: "code", op: "do" }],
      lines: [],
      comments: [
        { id: "gap", label: "Missing from the design: who checks it", in: "home", gap: true, ties: [] },
        { id: "aside", label: "An aside", in: "home", gap: false, ties: [] },
      ],
      places: [],
    });
    expect(g.notes).toEqual([
      { id: "gap", text: "Missing from the design: who checks it", gap: true },
      { id: "aside", text: "An aside", on: "home" },
    ]);
  });

  it("reads a graph of many notes, each tied to parts, in time growing with its size", () => {
    const n = 20_000;
    const g: EngineGraph = {
      view: "security",
      groups: [],
      parts: [
        { id: "a", kind: "code", label: "A" },
        { id: "b", kind: "code", label: "B" },
      ],
      lines: [{ from: "a", to: "b", kind: "start", points: "to" }],
      comments: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, label: `Note\n${i}`, gap: false, ties: ["a", "b"] })),
      places: [],
    };
    const start = performance.now();
    const many = readGraph(g);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(many.notes).toHaveLength(2 * n);
    expect(many.notes.slice(0, 2)).toEqual([
      { id: "c0", on: "a", text: "Note 0" },
      { id: "c0", on: "b", text: "Note 0" },
    ]);
    expect(many.lines).toEqual([{ id: "line-0", from: "a", to: "b", style: "solid", arrowStart: false, arrowEnd: true }]);
  });

  it("leaves out a line or a tie one of whose ends isn't drawn", () => {
    const g = readGraph({
      view: "security",
      groups: [],
      parts: [{ id: "a", kind: "code", label: "A" }],
      lines: [{ from: "a", to: "ghost", kind: "start", points: "to" }],
      comments: [{ id: "c", label: "On a ghost", gap: false, ties: ["ghost"] }],
      places: [],
    });
    expect(g.lines).toEqual([]);
    expect(g.notes).toEqual([{ id: "c", text: "On a ghost" }]);
  });
});

// AWML 0.8 draws untrusted text in the main view (chrismdp/awml#151, registry issue #83): `graph`
// marks a part marked untrusted, and unstopped when its text reaches an outside action that
// nothing stops and nobody accepted; and says of each line whether it carries the text, is the
// line out of what stopped it, or is on its way, unstopped, to an outside action. What each test
// expects is read from the YAML the graph is of.
describe("untrusted text (#83)", () => {
  // A cake order: a cleaning step stops the form's text on one way, and Ana's yes on the other.
  const stopped = graphOf(fixture("untrusted-text.graph.json"));
  // Thank-yous to reviews, under Ana's standing approval, which accepts the risk.
  const accepted = graphOf(fixture("untrusted-risk-accepted.graph.json"));
  // Enquiries stored in 0.7: the form's text is labelled in the inbox with nothing to stop it,
  // and a reply to it goes out only on Ana's yes. Its graph is of the file converted to 0.8.
  const enquiries = graphOf(fixture("older/enquiries-07.graph.json"));
  const looks = (g: Graph) => g.lines.map((l) => [l.from, l.to, l.untrusted ?? "", Boolean(l.broken)]);
  const marked = (file: string) =>
    (parse(fixture(file)) as { parts: { id: string; untrusted?: boolean }[] }).parts.filter((p) => p.untrusted).map((p) => p.id);

  it("marks the part the text comes from, and only it", () => {
    expect(marked("untrusted-text.yaml")).toEqual(["form"]);
    expect(stopped.parts.filter((p) => p.untrusted || p.unstopped)).toEqual([
      { id: "form", kind: "trigger", label: "An order on the website's form", scope: "bakery", untrusted: true },
    ]);
    expect(marked("untrusted-risk-accepted.yaml")).toEqual(["reviews"]);
    expect(accepted.parts.filter((p) => p.untrusted || p.unstopped).map((p) => p.id)).toEqual(["reviews"]);
  });

  it("carries the text up to what stops it, then leaves the line out of the stop, then nothing", () => {
    expect(looks(stopped)).toEqual([
      ["form", "keep", "carries", false],
      // The cleaning step keeps only the cake, the quantity and the date.
      ["keep", "book", "stopped", false],
      ["book", "rota", "", false],
      ["form", "draft", "carries", false],
      ["draft", "ask", "carries", false],
      ["ask", "approve", "carries", false],
      // Ana's yes to the exact reply.
      ["approve", "send", "stopped", false],
    ]);
  });

  it("keeps carrying the text through a standing approval that accepts the risk", () => {
    expect(looks(accepted)).toEqual([
      ["evening", "draft", "", false],
      ["reviews", "draft", "carries", false],
      ["draft", "post", "carries", false],
      ["post", "approval", "carries", false],
      ["approval", "reply", "carries", false],
      ["approval", "list", "carries", false],
    ]);
  });

  it("marks the source and the whole way to an outside action nothing stops, upstream of a branch too, and the rule it breaks", () => {
    expect(marked("older/enquiries-07.yaml")).toEqual(["form"]);
    expect(enquiries.parts.find((p) => p.id === "form")).toMatchObject({ untrusted: true, unstopped: true });
    expect(enquiries.parts.filter((p) => p.unstopped).map((p) => p.id)).toEqual(["form"]);
    expect(looks(enquiries)).toEqual([
      // The form's text branches after sorting: red wins on the way to the branch.
      ["form", "sort", "unstopped", false],
      ["sort", "file", "unstopped", false],
      ["file", "label", "unstopped", true],
      ["sort", "draft", "carries", false],
      ["draft", "ask", "carries", false],
      ["ask", "approve", "carries", false],
      ["approve", "send", "stopped", false],
    ]);
    expect(line(enquiries, "file", "label")?.label).toBe(
      'untrusted text from part "form" reaches outside action "label" with nothing to stop it or accept the risk',
    );
  });

  it("takes only the three ways the engine draws a line, and nothing for a part but true", () => {
    const g = readGraph({
      view: "security",
      groups: [],
      parts: [
        { id: "a", kind: "trigger", label: "A", untrusted: "yes" as unknown as boolean, unstopped: 1 as unknown as boolean },
        { id: "b", kind: "code", label: "B" },
      ],
      lines: [
        { from: "a", to: "b", kind: "start", points: "to", untrusted: "tainted" },
        { from: "b", to: "a", kind: "data", points: "to", untrusted: "constructor" },
      ],
      comments: [],
      places: [],
    });
    expect(g.parts).toEqual([
      { id: "a", kind: "trigger", label: "A" },
      { id: "b", kind: "code", label: "B" },
    ]);
    expect(g.lines.map((l) => l.untrusted)).toEqual([undefined, undefined]);
  });
});

// Registry issue #83: no violet or purple anywhere in a drawing. The engine gives a platform
// view's places colours from a palette with a lavender in it, which the registry draws grey.
describe("a place's colours", () => {
  it("are never violet: a violet place is drawn in a grey as light as it", () => {
    const home = graphOf(fixture("dinners-home.graph.json"));
    const wall = JSON.parse(fixture("dinners-home.graph.json")).places.find((p: { id: string }) => p.id === "wall");
    expect(wall).toEqual({ id: "wall", fill: "#efe6fa", stroke: "#d3c2ea" });
    expect(home.scopes.find((s) => s.id === "wall")).toMatchObject({ fill: "#f0f0f0", stroke: "#d6d6d6" });
    // The others keep the engine's colours.
    expect(home.scopes.find((s) => s.id === "app")).toMatchObject({ fill: "#fbe9df", stroke: "#ecc7b2" });
  });
});
