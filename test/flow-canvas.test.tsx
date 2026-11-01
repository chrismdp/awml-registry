// The drawing's nodes once React Flow has taken over from the server's SVG
// (src/components/flow/FlowCanvas.tsx), as React Flow renders them: a linked part (#55) is a
// focusable link or a menu button named by where it leads, with its tooltip, a part it may not
// follow is still named, the part the address names is outlined, and a workflow's box on a
// system's map (#61) is a link to its page.
import { ReactFlow } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { headHeight, squareRoute, type Point, type Rect } from "@/components/flow/drawing";
import { lineRoute, NODE_TYPES, nodesOf } from "@/components/flow/FlowCanvas";
import { roundedPath } from "@/components/flow/Graphic";
import { atServer } from "@/components/flow/physics";
import { StaticDrawing } from "@/components/flow/StaticDrawing";
import { readGraph } from "@/components/flow/graph";
import { hrefOf } from "@/components/links";
import { layOut, mapLinks } from "@/server/drawing";
import type { PartLink } from "@/server/part-links";
import { laidOut } from "./drawn";
import { example } from "./helpers";

const text = JSON.stringify({
  view: "security",
  groups: [],
  parts: [
    { id: "list", kind: "context", label: "Shopping list" },
    { id: "plan", kind: "ai", label: "Plan the week's dinners", decider: "ai" },
  ],
  lines: [{ from: "list", to: "plan", kind: "data", points: "to" }],
  comments: [{ id: "n", label: "Kept by Ana", gap: false, ties: [] }],
  places: [],
});

// The nodes React Flow draws for a drawing, as it renders them, where the server put them.
async function rendered(
  source: string,
  { links = [], hrefs = {}, target, menuFor }: { links?: PartLink[]; hrefs?: Record<string, string>; target?: string; menuFor?: string },
) {
  const { full } = laidOut(await layOut(source));
  const { bodies, hulls } = atServer(full);
  const nodes = nodesOf(full, bodies, hulls, { id: "t", links: new Map(links.map((l) => [l.part, l])), hrefs, notes: new Map(), target, menuFor, onNote: () => {} });
  return renderToStaticMarkup(<ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} width={800} height={600} />);
}

// A node's opening tag, and all it holds up to the next node.
const node = (html: string, id: string) => {
  const at = html.indexOf(`data-id="${id}"`);
  if (at < 0) return { tag: "", inside: "" };
  const start = html.lastIndexOf("<div", at);
  const end = html.indexOf('<div class="react-flow__node ', at);
  return { tag: html.slice(start, html.indexOf(">", at) + 1), inside: html.slice(start, end < 0 ? undefined : end) };
};

const one: PartLink = { part: "list", title: "Linked to acme/shopping#list", to: [{ label: "acme/shopping", href: "/acme/shopping#list" }] };
const several: PartLink = {
  part: "list",
  title: "Used by a/b and c/d",
  to: [
    { label: "a/b", href: "/a/b" },
    { label: "c/d", href: "/c/d" },
  ],
};

describe("a linked part, once React Flow draws it", () => {
  it("is a focusable link named by the part and where it leads, with its tooltip", async () => {
    const list = node(await rendered(text, { links: [one] }), "list");
    expect(list.tag).toContain('tabindex="0"');
    expect(list.tag).toContain('role="link"');
    expect(list.tag).toContain('aria-label="Shopping list. Linked to acme/shopping#list"');
    expect(list.inside).toContain("<title>Linked to acme/shopping#list</title>");
    expect(list.inside).toContain('class="part-link-mark"');
  });

  it("is a button with several places to go, saying whether its menu is open", async () => {
    const shut = node(await rendered(text, { links: [several] }), "list");
    expect(shut.tag).toContain('tabindex="0"');
    expect(shut.tag).toContain('role="button"');
    expect(shut.tag).toContain('aria-haspopup="menu"');
    expect(shut.tag).toContain('aria-expanded="false"');
    expect(shut.tag).toContain('aria-label="Shopping list. Used by a/b and c/d"');
    expect(shut.inside).toContain("<title>Used by a/b and c/d</title>");
    const open = node(await rendered(text, { links: [several], menuFor: "list" }), "list");
    expect(open.tag).toContain('aria-expanded="true"');
  });

  it("is named, with its tooltip, though it leads nowhere the viewer may go, and takes no focus", async () => {
    const list = node(await rendered(text, { links: [{ part: "list", title: "Linked to a workflow you can't see", to: [] }] }), "list");
    expect(list.tag).not.toContain("tabindex");
    expect(list.tag).toContain("aria-label=\"Shopping list. Linked to a workflow you can&#x27;t see\"");
    expect(list.inside).toContain("<title>Linked to a workflow you can&#x27;t see</title>");
    expect(list.inside).toContain('class="part-link-mark off"');
  });

  it("is outlined when the address names it, and no other part is", async () => {
    const html = await rendered(text, { links: [one], target: "plan" });
    expect(node(html, "plan").inside).toContain('class="flow-node part-target"');
    expect(node(html, "list").inside).not.toContain("part-target");
  });

  it("is left alone, unfocusable and unnamed, when nothing links it", async () => {
    const plan = node(await rendered(text, {}), "plan");
    expect(plan.tag).not.toContain("tabindex");
    expect(plan.tag).not.toContain("aria-label");
    expect(plan.inside).not.toContain("<title>");
  });
});

describe("a workflow's box on a system's map, once React Flow draws it", () => {
  it("is a focusable link to the workflow's page, named by it, though it holds the outside actions that start others", async () => {
    const html = await rendered(example("flow/factory-map.graph.json"), { hrefs: { w1: "/chrismdp/issue-to-pull-request" } });
    const w1 = node(html, "w1");
    expect(w1.tag).toContain('tabindex="0"');
    expect(w1.tag).toContain('role="link"');
    expect(w1.tag).toContain('aria-label="Open An issue becomes a pull request"');
    // A box the viewer may not open is no link.
    expect(node(html, "w2").tag).not.toContain('role="link"');
  });
});

describe("a scope's heading (#67)", () => {
  it("is its name, with who it is for on lines of their own under it, the same in the server's SVG and in React Flow", async () => {
    const { full } = laidOut(await layOut(example("dinners.graph.json")));
    const carers = full.scopes.find((s) => s.id === "carers")!;
    expect(carers).toMatchObject({ name: "carers", who: ["+ June, Beth"] });
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    const html = await rendered(example("dinners.graph.json"), {});
    for (const drawn of [/<g [^>]*data-scope="carers"[^]*?<\/g>/.exec(svg)![0], node(html, "carers").inside]) {
      const name = /<text class="flow-scope-name" x="20" y="([\d.]+)"[^>]*>carers<\/text>/.exec(drawn);
      const who = /<text class="flow-scope-who" font-size="12"[^>]*><tspan x="20" y="([\d.]+)">\+ June, Beth<\/tspan><\/text>/.exec(drawn);
      expect(name, drawn).not.toBeNull();
      expect(who, drawn).not.toBeNull();
      // Below the name, and above where the scope's parts start.
      expect(Number(who![1])).toBeGreaterThan(Number(name![1]) + 12);
      expect(Number(who![1])).toBeLessThan(headHeight(carers.who) - 6);
    }
  });
});

describe("a line, once a part is dragged (#67)", () => {
  // Each pair of points one after the other is level or plumb.
  const square = (points: Point[]) => points.slice(1).every((q, i) => q.x === points[i].x || q.y === points[i].y);
  const onEdge = (p: Point, r: Rect) =>
    ((p.x === r.x || p.x === r.x + r.width) && p.y >= r.y && p.y <= r.y + r.height) ||
    ((p.y === r.y || p.y === r.y + r.height) && p.x >= r.x && p.x <= r.x + r.width);

  it("keeps the server's route while its ends haven't moved, or have moved together, and goes square once one has", async () => {
    const { full } = laidOut(await layOut(example("flow/issue-to-pull-request.graph.json")));
    const at = new Map<string, Rect>([...full.parts, ...full.scopes].map((b) => [b.id, b]));
    const line = full.lines.find((l) => l.label && l.points.length > 3)!;
    const s = at.get(line.from)!;
    const t = at.get(line.to)!;
    const still = lineRoute(line, s, t, s, t);
    expect(still).toEqual({ points: line.points, label: { x: line.label!.x, y: line.label!.y }, server: true });
    const by = (r: Rect, dx: number, dy: number) => ({ ...r, x: r.x + dx, y: r.y + dy });
    const together = lineRoute(line, by(s, 40, 30), by(t, 40, 30), s, t);
    expect(together.server).toBe(true);
    expect(together.points[0]).toEqual({ x: line.points[0].x + 40, y: line.points[0].y + 30 });

    // Dragged across and up: square, out of the dragged part's side or bottom and into the other.
    for (const [dx, dy] of [
      [260, -40],
      [-300, 20],
      [500, s.y < t.y ? t.y - s.y : 0],
      [0, 0.4 * (t.y - s.y)],
    ]) {
      const dragged = by(s, dx, dy);
      const route = lineRoute(line, dragged, t, s, t);
      expect(route.server, `${dx}, ${dy}`).toBe(false);
      expect(square(route.points), JSON.stringify(route.points)).toBe(true);
      expect(onEdge(route.points[0], dragged)).toBe(true);
      expect(onEdge(route.points.at(-1)!, t)).toBe(true);
      // Its label sits on the line.
      expect(
        route.points.slice(1).some((q, i) => {
          const p = route.points[i];
          const within = (v: number, a: number, b: number) => v >= Math.min(a, b) - 0.01 && v <= Math.max(a, b) + 0.01;
          return within(route.label.x, p.x, q.x) && within(route.label.y, p.y, q.y);
        }),
      ).toBe(true);
      // Drawn with the server's rounded corners, every stretch between them level or plumb.
      expect(roundedPath(route.points)).toMatch(/^M [-\d.]+ [-\d.]+( L [-\d.]+ [-\d.]+ Q [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+)* L [-\d.]+ [-\d.]+$/);
    }
    // Between two boxes with too little room above and below for a line to turn, but room
    // beside, side to side, so it never runs along a box's edge (#78); with room above, top to bottom.
    const a = { x: 0, y: 0, width: 100, height: 50 };
    const close = squareRoute(a, { x: 140, y: 54, width: 100, height: 50 }).points;
    expect([close[0].x, close.at(-1)!.x]).toEqual([100, 140]);
    const roomy = squareRoute(a, { x: 140, y: 80, width: 100, height: 50 }).points;
    expect([roomy[0].y, roomy.at(-1)!.y]).toEqual([50, 80]);
    // Into the top of a part below it, so its arrowhead points down into it, as the server's do.
    const below = lineRoute(line, by(s, 200, 0), t, s, t);
    if (t.y > s.y + s.height) {
      expect(below.points.at(-1)!.y).toBe(t.y);
      expect(below.points.at(-2)!.x).toBe(below.points.at(-1)!.x);
    }
  });
});

describe("the notes of the whole drawing, once React Flow draws it", () => {
  it("have one icon of their own, a button that opens them", async () => {
    const html = await rendered(text, {});
    const notes = node(html, "notes-of-the-drawing");
    expect(notes.inside).toContain('class="flow-note-mark nodrag nopan"');
    expect(notes.inside).toContain('aria-label="Note on The whole drawing"');
    // It is no part of its own, for a reader to tab to apart from its button.
    expect(notes.tag).not.toContain("tabindex");
  });
});

// Ids index the links and pages a drawing's parts and boxes lead to. An id every object inherits,
// such as constructor or toString, must lead nowhere it wasn't given, on the server's SVG, in
// React Flow and on a system's map.
describe("parts and boxes whose ids every object inherits", () => {
  // Three workflows' boxes, each started by a trigger, every id one an object inherits.
  const ids = ["constructor", "toString", "__proto__"];
  const triggers = ["valueOf", "hasOwnProperty", "isPrototypeOf"];
  const graph = JSON.stringify({
    view: "map",
    groups: ids.map((id) => ({ id, label: `Box ${id}` })),
    parts: triggers.map((id) => ({ id, kind: "trigger", label: `Start ${id}` })),
    lines: ids.map((id, i) => ({ from: triggers[i], to: id, kind: "start", points: "to" })),
    comments: [],
    places: [],
  });

  it("are read as parts and boxes of their own", () => {
    const g = readGraph(JSON.parse(graph));
    expect(g.scopes.map((sc) => sc.id)).toEqual(ids);
    expect(g.lines).toHaveLength(3);
    expect(readGraph({ view: "security", groups: [], parts: [{ id: "a", kind: "constructor", label: "A" }], lines: [], comments: [], places: [] }).parts[0].kind).toBe("part");
  });

  it("lead nowhere they weren't given, on the server's SVG, in React Flow and on a map", async () => {
    for (const id of [...ids, "valueOf", "hasOwnProperty"]) expect(hrefOf({}, id), id).toBeUndefined();
    expect(hrefOf({ constructor: "/a/b" }, "constructor")).toBe("/a/b");
    const { full } = laidOut(await layOut(graph));
    expect(renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />)).not.toContain("<a ");
    const html = await rendered(graph, {});
    expect(html).not.toContain('role="link"');
    expect(mapLinks(full, {})).toEqual([]);
    // Given one, it leads there, and only there.
    const given = await rendered(graph, { hrefs: { toString: "/acme/to-string" } });
    expect(node(given, "toString").tag).toContain('role="link"');
    expect(node(given, "constructor").tag).not.toContain('role="link"');
    const box = { title: "To string", address: "acme/to-string", href: "/acme/to-string" };
    expect(mapLinks(full, { toString: box }).map((l) => l.part)).toEqual(["hasOwnProperty"]);
  });
});
