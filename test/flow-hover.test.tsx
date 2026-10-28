// A part the pointer is over, or the keyboard is on, once React Flow draws the drawing
// (src/components/flow/FlowCanvas.tsx): what is connected to it stays as it is, and everything
// else is knocked back. Connected is the part itself, every line with it at either end and
// those lines' labels, the part at each line's other end, and the notes tied to it. A scope
// stays as it is. What is connected to each part is worked out once for a drawing
// (`connections`, in src/components/flow/drawing.ts).
import fs from "node:fs";
import path from "node:path";
import { Position, ReactFlow } from "@xyflow/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { connections, type Connected } from "@/components/flow/drawing";
import { EDGE_TYPES, linesOf, litLines, litNodes, NODE_TYPES, nodesOf } from "@/components/flow/FlowCanvas";
import { atServer } from "@/components/flow/physics";
import { notesBy } from "@/components/flow/StaticDrawing";
import { layOut } from "@/server/drawing";
import { laidOut } from "./drawn";
import { example } from "./helpers";

// A browser draws each line's label in React Flow's layer above every line, which a server
// has no page to put in; here each label is drawn where its line is.
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const css = fs.readFileSync(path.join(__dirname, "../src/components/flow/flow.css"), "utf8");

// A week's dinners: a trigger and a shopping list into the plan, in the kitchen's scope; the
// plan and a person's check of it, a line with an arrow at each end; and a step no line
// reaches. One note is tied to the plan, one to both the check and the lone step, and one to
// nothing, so it is the whole drawing's.
const dinners = JSON.stringify({
  view: "security",
  groups: [{ id: "kitchen", label: "kitchen: Ana and June" }],
  parts: [
    { id: "start", kind: "trigger", label: "A new week" },
    { id: "plan", kind: "ai", label: "Plan the week's dinners", decider: "ai", in: "kitchen" },
    { id: "list", kind: "context", label: "Shopping list" },
    { id: "check", kind: "person", label: "Check the plan", decider: "person", in: "kitchen" },
    { id: "tidy", kind: "code", label: "Tidy the cupboard", decider: "code" },
  ],
  lines: [
    { from: "start", to: "plan", kind: "flow", points: "to", label: "the week" },
    { from: "list", to: "plan", kind: "data", points: "to" },
    { from: "plan", to: "check", kind: "flow", points: "both", label: "back and forth" },
  ],
  comments: [
    { id: "kept", label: "Kept by Ana", gap: false, ties: ["plan"] },
    { id: "sunday", label: "Both on a Sunday", gap: false, ties: ["check", "tidy"] },
    { id: "whole", label: "The whole week", gap: false, ties: [] },
  ],
  places: [],
});

// What is connected to a part, as sorted lists.
const listed = (c: Connected | undefined) => c && { parts: [...c.parts].sort(), lines: [...c.lines].sort(), notes: [...c.notes].sort() };

describe("what is connected to a part", () => {
  it("is the part, every line with it at either end, the part at each line's other end, and the notes tied to it", async () => {
    const { full } = laidOut(await layOut(dinners));
    const near = connections(full);
    expect(listed(near.get("plan"))).toEqual({ parts: ["check", "list", "plan", "start"], lines: ["line-0", "line-1", "line-2"], notes: ["kept"] });
    expect(listed(near.get("start"))).toEqual({ parts: ["plan", "start"], lines: ["line-0"], notes: [] });
    // A line with an arrow at each end connects its two parts whichever is lit.
    expect(listed(near.get("check"))).toEqual({ parts: ["check", "plan"], lines: ["line-2"], notes: ["sunday"] });
    // A part no line reaches has only itself, and the notes tied to it, one of them tied to another part too.
    expect(listed(near.get("tidy"))).toEqual({ parts: ["tidy"], lines: [], notes: ["sunday"] });
  });

  it("is nothing for a scope, which stays as it is", async () => {
    const { full } = laidOut(await layOut(dinners));
    expect(connections(full).has("kitchen")).toBe(false);
  });

  it("on a system's map, takes in a workflow's box that holds nothing as a part, and not one drawn round what it holds", async () => {
    // w1 holds the outside action that starts w2, so it is drawn as a scope; w2 holds nothing.
    const { full } = laidOut(await layOut(example("bakery-map.graph.json")));
    const near = connections(full);
    expect(listed(near.get("w2"))).toEqual({ parts: ["s1", "w2", "w2_low"], lines: ["line-1", "line-3"], notes: [] });
    expect(near.has("w1")).toBe(false);
    // The stock, read and written by w1 and read by w2.
    expect(listed(near.get("s1"))).toEqual({ parts: ["s1", "w1", "w2"], lines: ["line-2", "line-3"], notes: [] });
  });
});

// The drawing as React Flow draws it while the part `lit` is lit, or none is: its frame, and
// each node and line, as it renders them. A node's lines are drawn on the server only when it
// says where they join it.
async function drawn(source: string, lit?: string) {
  const { full } = laidOut(await layOut(source));
  const { bodies, hulls } = atServer(full);
  const near = lit ? connections(full).get(lit) : undefined;
  const shared = { id: "t", links: new Map(), hrefs: {}, notes: notesBy(full.notes), onNote: () => {} };
  const handles = [
    { type: "source" as const, position: Position.Bottom, x: 0, y: 0 },
    { type: "target" as const, position: Position.Top, x: 0, y: 0 },
  ];
  const nodes = litNodes(nodesOf(full, bodies, hulls, shared), near).map((n) => ({ ...n, handles }));
  const edges = litLines(linesOf(full, "t"), near);
  return renderToStaticMarkup(
    <ReactFlow className={near ? "flow-lit" : undefined} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} width={800} height={600} />,
  );
}

// The classes of the drawing's frame, of a node, and of a line and its label, by id.
const classes = (tag: string | undefined) => (/class="([^"]*)"/.exec(tag ?? "")?.[1] ?? "").split(" ");
const frameClasses = (html: string) => classes(/<div data-testid="rf__wrapper"[^>]*>/.exec(html)?.[0]);
const nodeClasses = (html: string, id: string) => classes(new RegExp(`<div class="[^"]*"[^>]*data-id="${id}"`).exec(html)?.[0]);
const line = (html: string, id: string) => {
  const at = html.indexOf(`data-testid="rf__edge-${id}"`);
  const next = html.indexOf('data-testid="rf__edge-', at + 1);
  const piece = html.slice(at, next < 0 ? undefined : next);
  return { path: classes(/<g class="flow-edge[^"]*"/.exec(piece)?.[0]), label: classes(/<svg class="flow-node-svg flow-label-svg[^"]*"/.exec(piece)?.[0]) };
};

// The stylesheet's rules, each with its selectors and what it sets, its comments left out. A
// selector list is split at each comma outside brackets, so `:is(a, b:not(c))` stays whole.
const split = (list: string) => {
  const out = [""];
  let depth = 0;
  for (const c of list) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (c === "," && depth === 0) out.push("");
    else out[out.length - 1] += c;
  }
  return out.map((s) => s.trim());
};
const rules = [...css.replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: split(selectors),
  body: body.trim(),
}));

describe("a part the pointer is over, once React Flow draws it", () => {
  it("marks the drawing lit, and each part, line, label and note connected to it, so the rest is knocked back", async () => {
    const html = await drawn(dinners, "check");
    expect(frameClasses(html)).toContain("flow-lit");
    // The part, and the part at the other end of its line.
    expect(nodeClasses(html, "check")).toContain("lit");
    expect(nodeClasses(html, "plan")).toContain("lit");
    // Parts no line of it reaches.
    for (const id of ["start", "list", "tidy"]) expect(nodeClasses(html, id), id).not.toContain("lit");
    // A note tied to it is lit on every part it is on, though the part it is also on isn't.
    expect(nodeClasses(html, "tidy")).toContain("lit-note");
    expect(nodeClasses(html, "start")).not.toContain("lit-note");
    // Its own note is lit with it; the plan's, tied only to the plan, is knocked back, though the plan is lit.
    expect(nodeClasses(html, "check")).toContain("lit-note");
    expect(nodeClasses(html, "plan")).not.toContain("lit-note");
    // The whole drawing's notes are drawn, and tied to no part.
    expect(html).toContain('data-id="notes-of-the-drawing"');
    expect(nodeClasses(html, "notes-of-the-drawing")).not.toContain("lit");
    expect(nodeClasses(html, "notes-of-the-drawing")).not.toContain("lit-note");
    // Its line and that line's label are lit; the others, and their labels, are not.
    expect(line(html, "line-2")).toEqual({ path: ["flow-edge", "lit"], label: ["flow-node-svg", "flow-label-svg", "lit"] });
    expect(line(html, "line-0")).toEqual({ path: ["flow-edge"], label: ["flow-node-svg", "flow-label-svg"] });
    expect(line(html, "line-1").path).toEqual(["flow-edge"]);
  });

  it("lights every line with it at either end", async () => {
    const html = await drawn(dinners, "plan");
    for (const id of ["line-0", "line-1", "line-2"]) expect(line(html, id).path, id).toEqual(["flow-edge", "lit"]);
    for (const id of ["plan", "start", "list", "check"]) expect(nodeClasses(html, id), id).toContain("lit");
    // Its note is lit; the check's, tied to the check and the lone step, is not, though the check is lit.
    expect(nodeClasses(html, "plan")).toContain("lit-note");
    expect(nodeClasses(html, "check")).not.toContain("lit-note");
    expect(nodeClasses(html, "tidy")).not.toContain("lit");
    expect(nodeClasses(html, "tidy")).not.toContain("lit-note");
  });

  it("leaves everything as it is while no part is lit", async () => {
    const html = await drawn(dinners);
    expect(html).not.toContain("flow-lit");
    expect(html).not.toMatch(/class="[^"]*\blit(-note)?\b/);
    expect(line(html, "line-2")).toEqual({ path: ["flow-edge"], label: ["flow-node-svg", "flow-label-svg"] });
  });

  it("is knocked back, in the stylesheet, only while a part is lit: parts, notes, lines and labels, never a scope", () => {
    const knocked = rules.filter((r) => r.selectors.some((s) => s.includes(".flow-lit")));
    expect(knocked.map((r) => r.selectors)).toEqual([
      [
        ".react-flow.flow-lit .react-flow__node:not(.lit) :is(.flow-part, .flow-scope:not(.hull))",
        ".react-flow.flow-lit .react-flow__node:not(.lit-note) .flow-note-mark",
        ".react-flow.flow-lit :is(.flow-edge, .flow-label-svg):not(.lit)",
      ],
    ]);
    // Knocked back keeps its colours: only its opacity changes, so an untrusted line stays orange, green or red (#83).
    expect(knocked[0].body).toMatch(/^opacity: 0\.\d+;$/);
    // It eases there and back, unless the reader asks for less motion.
    const eased = ":is(.flow-part, .flow-scope, .flow-note-mark, .flow-edge, .flow-label-svg)";
    expect(rules).toContainEqual({ selectors: [`.flow-canvas ${eased}`], body: "transition: opacity 0.15s ease-out;" });
    expect(css).toContain(`@media (prefers-reduced-motion: reduce) { .flow-canvas ${eased} { transition: none; } }`);
  });
});
