// A part's description (AWML 0.11, issue #114): a drawing shows each part's label, a part with
// a description opens it under its label on a click on its chevron, or anywhere on it when it
// leads nowhere, and the Descriptions switch opens them all, in a layout the server makes with
// every description open. The server's SVG, a gallery card and an embed show labels only.
import { ReactFlow } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Drawing } from "@/components/Drawing";
import { EmbeddedDrawing } from "@/components/Embed";
import { DESCRIPTION, LABEL, lineRoutes, PADDING, partText, type Rect } from "@/components/flow/drawing";
import { flipsOf, NODE_TYPES, nodesOf } from "@/components/flow/FlowCanvas";
import { flowOnly, graphOf, readGraph, type EngineGraph } from "@/components/flow/graph";
import { atServer, MARGIN, startPhysics, type Body } from "@/components/flow/physics";
import { StaticDrawing } from "@/components/flow/StaticDrawing";
import { textWidth } from "@/components/flow/text";
import { clickOf } from "@/components/links";
import { engine } from "@/engine";
import { LIMITS, layOut, tooBig } from "@/server/drawing";
import { workflowEmbed } from "@/server/embed";
import { laidOut } from "./drawn";
import { parse } from "yaml";
import { example, person, request, type Who } from "./helpers";
import { call } from "./mcp-client";

async function push(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: body });
  return { status: res.status, body: await res.json() };
}

const file = example("descriptions.yaml");
const plan = "Choose meals from the favourites. June agreed this rule; no one parses these words.";
const said = { thu: "Start when the carers have time to plan.", plan, mealplan: "Keep the agreed meals for the week." };

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const boxOf = (b: Body): Rect => ({ x: b.x - b.width / 2, y: b.y - b.height / 2, width: b.width, height: b.height });
const shared = (open: string[] = [], descriptions = true) => ({
  id: "t",
  links: new Map(),
  hrefs: {},
  notes: new Map(),
  onNote: () => {},
  open: new Set(open),
  ...(descriptions ? { onOpen: () => {} } : {}),
});

describe("reading a part's description", () => {
  it("gives each part the description the engine's graph gives it, folded as a label is, and nothing else", async () => {
    const g = graphOf(await engine.graph(file));
    expect(Object.fromEntries(g.parts.filter((p) => p.description).map((p) => [p.id, p.description]))).toEqual(said);
    const read = readGraph({
      view: "security",
      groups: [],
      parts: [
        { id: "a", kind: "code", label: "A", description: "  One\n\nand  two " },
        { id: "b", kind: "code", label: "B", description: "" },
        { id: "c", kind: "code", label: "C", description: 7 as unknown as string },
      ],
      lines: [],
      comments: [],
      places: [],
    } as EngineGraph);
    expect(read.parts.map((p) => p.description)).toEqual(["One and two", undefined, undefined]);
    expect(flowOnly(g).parts.find((p) => p.id === "plan")?.description).toBe(plan);
  });
});

describe("laying a drawing out with its descriptions open", () => {
  it("lays out the whole drawing and Flow only a second time, each part with a description open", async () => {
    const d = laidOut(await layOut(await engine.graph(file)));
    expect(d.open).toBeDefined();
    const { full, flow } = d.open!;
    expect(full.opened).toBe(true);
    expect(flow.opened).toBe(true);
    expect(d.full.opened).toBeUndefined();
    for (const [shut, open] of [
      [d.full, full],
      [d.flow, flow],
    ]) {
      for (const p of shut.parts) {
        const o = open.parts.find((q) => q.id === p.id)!;
        if (!Object.hasOwn(said, p.id)) {
          expect(p.description).toBeUndefined();
          expect([o.width, o.height]).toEqual([p.width, p.height]);
          continue;
        }
        // The closed layout draws the part closed, the open one open, and each says both sizes.
        expect(p.description!.lines.join(" ")).toBe(said[p.id as keyof typeof said]);
        expect(p.description).toEqual(o.description);
        expect({ width: p.width, height: p.height }).toEqual(p.description!.closed);
        expect({ width: o.width, height: o.height }).toEqual(p.description!.opened);
        expect(o.height).toBe(p.height + DESCRIPTION.gap + p.description!.lines.length * DESCRIPTION.line);
        const [, right, , left] = PADDING[p.kind];
        for (const line of p.description!.lines) expect(textWidth(line, DESCRIPTION.size)).toBeLessThanOrEqual(o.width - left - right);
      }
      // Nothing overlaps as the server lays the open drawing out.
      for (const [i, a] of open.parts.entries()) for (const b of open.parts.slice(i + 1)) expect(overlap(a, b), `${a.id} and ${b.id}`).toBe(false);
    }
  });

  it("makes room by the label of a part with a description for its chevron", () => {
    const part = { id: "a", kind: "code" as const, label: "Plan next week's dinners" };
    const [, right, , left] = PADDING.code;
    const bare = partText(part);
    const described = partText({ ...part, description: "Choose the meals." });
    expect(bare.description).toBeUndefined();
    expect(described.width - left - right).toBeGreaterThanOrEqual(textWidth("Plan next week's dinners", LABEL.size) + DESCRIPTION.chevron);
  });

  it("lays out no second drawing for a graph with no description", async () => {
    const d = laidOut(await layOut(await engine.graph(example("dinners.yaml"))));
    expect(d.open).toBeUndefined();
  });

  it("counts a description's characters towards the limits", () => {
    const g = (description: string) =>
      readGraph({
        view: "security",
        groups: [],
        parts: [{ id: "a", kind: "code", label: "A", description }],
        lines: [],
        comments: [],
        places: [],
      } as EngineGraph);
    expect(tooBig(g("x".repeat(LIMITS.characters - 1)))).toBe(false);
    expect(tooBig(g("x".repeat(LIMITS.characters)))).toBe(true);
  });
});

describe("what shows labels only", () => {
  it("is the server's SVG of either layout, and so a gallery card", async () => {
    const d = laidOut(await layOut(await engine.graph(file)));
    for (const drawing of [d.full, d.flow, d.open!.full, d.open!.flow]) {
      const svg = renderToStaticMarkup(<StaticDrawing drawing={drawing} id="t" />);
      expect(svg).toContain("Plan next week&#x27;s dinners");
      for (const text of Object.values(said)) expect(svg).not.toContain(text.slice(0, 20));
      expect(svg).not.toContain('class="flow-description');
    }
  });

  it("is an embed, which has no Descriptions switch", async () => {
    const ana = await person("ana");
    expect((await push(ana.username, "described", { token: ana.token }, { workflow: file })).status).toBe(201);
    const props = (await workflowEmbed(ana.username, "described", "latest", { view: "security", flow: false }))!;
    expect(props.drawing).not.toBeNull();
    expect(props.drawing!.open).toBeUndefined();
    const html = renderToStaticMarkup(<EmbeddedDrawing {...props} />);
    expect(html).not.toContain("Descriptions");
    expect(html).toContain("Flow only");
  });
});

describe("the Descriptions switch", () => {
  it("sits beside Flow only, off, when a part has a description, and not otherwise", async () => {
    const d = laidOut(await layOut(await engine.graph(file)));
    const html = renderToStaticMarkup(<Drawing drawings={d} />);
    const switches = /<div class="flow-controls flow-switches">([^]*?)<\/div>/.exec(html)![1];
    expect([...switches.matchAll(/<button[^>]*aria-pressed="(\w+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]])).toEqual([
      ["Descriptions", "false"],
      ["Flow only", "false"],
    ]);
    const none = renderToStaticMarkup(<Drawing drawings={laidOut(await layOut(await engine.graph(example("dinners.yaml"))))} />);
    expect(none).not.toContain("Descriptions");
  });
});

describe("a part's description in React Flow", () => {
  async function rendered(open: string[], descriptions = true, source = file) {
    const { full } = laidOut(await layOut(await engine.graph(source)));
    const { bodies, hulls } = atServer(full);
    const nodes = nodesOf(full, bodies, hulls, shared(open, descriptions));
    return renderToStaticMarkup(<ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} width={800} height={600} />);
  }
  const node = (html: string, id: string) => {
    const at = html.indexOf(`data-id="${id}"`);
    const end = html.indexOf('<div class="react-flow__node ', at);
    return html.slice(html.lastIndexOf("<div", at), end < 0 ? undefined : end);
  };

  it("gives each part with a description a chevron by its label, closed, and opens it under the label", async () => {
    const closed = await rendered([]);
    expect(node(closed, "plan")).toContain('aria-label="Description of Plan next week&#x27;s dinners"');
    expect(node(closed, "plan")).toContain('aria-expanded="false"');
    expect(node(closed, "plan")).not.toContain('class="flow-description"');
    expect(node(closed, "favourites")).not.toContain("Description of");
    const open = await rendered(["plan"]);
    expect(node(open, "plan")).toContain('aria-expanded="true"');
    expect(node(open, "plan")).toContain('class="flow-description"');
    expect(node(open, "plan")).toContain("Choose meals from the");
    expect(node(open, "thu")).toContain('aria-expanded="false"');
  });

  it("draws a description as text, never as markup", async () => {
    const hostile = JSON.stringify({
      view: "security",
      groups: [],
      parts: [{ id: "a", kind: "code", label: "A", description: '<img src=x onerror="alert(1)"> <script>alert(2)</script>' }],
      lines: [],
      comments: [],
      places: [],
    });
    const { full } = laidOut(await layOut(hostile));
    const { bodies, hulls } = atServer(full);
    const html = renderToStaticMarkup(<ReactFlow nodes={nodesOf(full, bodies, hulls, shared(["a"]))} edges={[]} nodeTypes={NODE_TYPES} width={800} height={600} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("has no chevron where descriptions are off, as in an embed", async () => {
    expect(await rendered([], false)).not.toContain("Description of");
  });
});

// What a click on a part chooses to do, from what the canvas gives it: its link, its
// description and whether descriptions open here. The canvas's own wiring, a tap doing it only
// on the second tap and a click on the chevron or a note's button left to the button, needs a
// browser, so it isn't tested here.
describe("a click on a part", () => {
  const to = [{ label: "acme/plan", href: "/acme/plan" }];
  it("follows a part's link, opens a part's description when it leads nowhere, and otherwise does nothing", () => {
    expect(clickOf({ to }, plan, true)).toBe("follow");
    expect(clickOf({ to }, undefined, true)).toBe("follow");
    expect(clickOf(undefined, plan, true)).toBe("open");
    expect(clickOf(undefined, undefined, true)).toBeNull();
  });

  it("takes a link to no page as leading nowhere", () => {
    expect(clickOf({ to: [] }, plan, true)).toBe("open");
    expect(clickOf({ to: [] }, undefined, true)).toBeNull();
  });

  it("opens nothing where descriptions don't open, as in an embed", () => {
    expect(clickOf(undefined, plan, false)).toBeNull();
    expect(clickOf({ to }, plan, false)).toBe("follow");
  });
});

describe("opening one part", () => {
  async function physicsOf() {
    const { full } = laidOut(await layOut(await engine.graph(file)));
    let state: { bodies: Body[]; hulls: Map<string, Rect> } = { bodies: [], hulls: new Map() };
    const sim = startPhysics(
      full,
      (bodies, hulls) => (state = { bodies: bodies.map((b) => ({ ...b })), hulls }),
      () => {},
    );
    return { full, sim, state: () => state };
  }

  it("grows it where it is, its top and its middle kept, and nudges what it overlaps out of its way", async () => {
    const { full, sim, state } = await physicsOf();
    const was = state().bodies.find((b) => b.id === "plan")!;
    const part = full.parts.find((p) => p.id === "plan")!;
    sim.resize("plan", part.description!.opened);
    const is = state().bodies.find((b) => b.id === "plan")!;
    expect([is.width, is.height]).toEqual([part.description!.opened.width, part.description!.opened.height]);
    expect(is.x).toBe(was.x);
    expect(is.y - is.height / 2).toBe(was.y - was.height / 2);
    const boxes = state().bodies.map(boxOf);
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    // Its scopes grow round it.
    for (const id of is.scopes) {
      const h = state().hulls.get(id)!;
      expect(h.y + h.height).toBeGreaterThanOrEqual(is.y + is.height / 2 + MARGIN.part);
    }
    sim.resize("plan", part.description!.closed);
    const back = state().bodies.find((b) => b.id === "plan")!;
    expect([back.width, back.height, back.x, back.y]).toEqual([was.width, was.height, was.x, was.y]);
    sim.stop();
  });

  it("routes its lines square once it has grown, so no line starts inside it", () => {
    const line = { id: "l", from: "a", to: "b", style: "solid" as const, arrowStart: false, arrowEnd: true, points: [{ x: 100, y: 60 }, { x: 100, y: 140 }] };
    const s = { x: 40, y: 0, width: 120, height: 60 };
    const t = { x: 40, y: 140, width: 120, height: 60 };
    const served = new Map([["a", s], ["b", t]]);
    expect(lineRoutes([line], served, served).get("l")!.server).toBe(true);
    const grown = { ...s, height: 100 };
    const route = lineRoutes([line], new Map([["a", grown], ["b", t]]), served).get("l")!;
    expect(route.server).toBe(false);
    expect(route.points[0].y).toBe(100);
  });
});

describe("the descriptions the reader has opened", () => {
  it("are the drawing's own: a switch to another layout and back shows it as the server laid it out", async () => {
    const d = laidOut(await layOut(await engine.graph(file)));
    const opened = flipsOf({ of: d.full, ids: new Set() }, d.full, "plan");
    expect([...flipsOf(opened, d.full).ids]).toEqual(["plan"]);
    const away = flipsOf(opened, d.flow);
    expect([...away.ids]).toEqual([]);
    expect([...flipsOf(away, d.full).ids]).toEqual([]);
    expect([...flipsOf(flipsOf(opened, d.full, "plan"), d.full).ids]).toEqual([]);
  });
});

describe("a part's description in the API's JSON and from MCP get", () => {
  it("is each part's own field, in the file as it was pushed", async () => {
    const ana = await person("ana");
    expect((await push(ana.username, "described", { token: ana.token }, { workflow: file })).status).toBe(201);
    const fromApi = await (await request("GET", `/api/v1/${ana.username}/described/v/1`)).json();
    const fromMcp = await call("get", { owner: ana.username, slug: "described" }, ana.token);
    for (const yaml of [fromApi.files.workflow, fromMcp.data.files.workflow]) {
      const parts = (parse(yaml) as { parts: { id: string; description?: string }[] }).parts;
      expect(Object.fromEntries(parts.filter((p) => p.description).map((p) => [p.id, p.description]))).toEqual(said);
    }
  });
});
