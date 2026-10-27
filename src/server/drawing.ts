// The registry's drawing of a workflow or a system's map (issue #62): the
// engine's graph of what it draws (issue #69), laid out here on the server
// with ELK, and sent to the page with every position worked out, so the
// browser never loads ELK. The page draws it as plain SVG, which needs no
// scripts, and React Flow takes it over to drag, pan and zoom.
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { engine } from "@/engine";
import { memoise } from "@/engine/memo";
import {
  boxText,
  containers,
  depths,
  headHeight,
  headWidth,
  lineLabel,
  partText,
  SCOPE_PAD,
  scopeHeading,
  type Drawing,
  type Drawings,
  type Undrawn,
  type DrawnLine,
  type DrawnPart,
  type DrawnScope,
  type Point,
} from "@/components/flow/drawing";
import { flowOnly, graphOf, type Graph } from "@/components/flow/graph";
import type { PartLink } from "@/server/part-links";

// ELK, made on first use. Its bundled worker takes itself to be inside a web
// worker wherever there is a `self` and no `document`, as in a Cloudflare
// Worker, and then gives ELK nothing to lay out with; a `document` for just
// the moment ELK is made keeps it in this process, as it is under Node.
let made: InstanceType<typeof ELK> | undefined;
function elkHere() {
  if (made) return made;
  const g = globalThis as { document?: unknown };
  if (g.document !== undefined) return (made = new ELK());
  g.document = {};
  try {
    return (made = new ELK());
  } finally {
    delete g.document;
  }
}

// ELK's layered algorithm, top to bottom, each scope a box round what it
// holds, with lines crossing scopes laid out together (hierarchical). Solid
// lines, the workflow's own flow, decide the layers before dotted ones.
const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.json.edgeCoords": "ROOT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.layered.spacing.edgeNodeBetweenLayers": "28",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "14",
  "elk.spacing.edgeLabel": "6",
  "elk.spacing.componentComponent": "56",
  "elk.edgeLabels.placement": "CENTER",
  "elk.layered.edgeLabels.sideSelection": "SMART_DOWN",
};

// Each scope's heading, its name and who it is for (#67), with who it is for
// broken into lines that fit the least room what the scope holds leaves:
// the width of the widest part, box or scope in it, however ELK lays them
// out. Each scope's is worked out once, from the deepest up.
function headings(g: Graph, holding: Set<string>, widthOf: (id: string) => number) {
  const depth = depths(g);
  const room = new Map<string, number>();
  const fits = (scope: string | undefined, width: number) => {
    if (scope !== undefined) room.set(scope, Math.max(room.get(scope) ?? 0, width));
  };
  for (const p of g.parts) fits(p.scope, widthOf(p.id));
  for (const s of g.scopes) if (!holding.has(s.id)) fits(s.scope, widthOf(s.id));
  const heading = new Map<string, ReturnType<typeof scopeHeading>>();
  for (const s of g.scopes.filter((s) => holding.has(s.id)).sort((a, b) => depth.get(b.id)! - depth.get(a.id)!)) {
    const h = scopeHeading(s, room.get(s.id) ?? 0);
    heading.set(s.id, h);
    fits(s.scope, Math.max((room.get(s.id) ?? 0) + 2 * SCOPE_PAD, headWidth(h)));
  }
  return (s: Graph["scopes"][number]) => heading.get(s.id) ?? scopeHeading(s, 0);
}

// Lays a graph out: every part's and scope's box, every line's route and its
// label's, in the drawing's own coordinates.
export async function layOutGraph(g: Graph): Promise<Drawing> {
  const holding = containers(g);
  const depth = depths(g);
  const parts = new Map(g.parts.map((p) => [p.id, { part: p, ...partText(p) }]));
  const boxes = new Map(g.scopes.filter((s) => !holding.has(s.id)).map((s) => [s.id, boxText(s)]));
  const labels = new Map(g.lines.flatMap((l) => (l.label ? [[l.id, lineLabel(l.label)] as const] : [])));
  const headingOf = headings(g, holding, (id) => parts.get(id)?.width ?? boxes.get(id)?.width ?? 0);

  const childrenOf = (scope: string | undefined): ElkNode[] => [
    ...g.scopes
      .filter((s) => s.scope === scope)
      .map((s): ElkNode => {
        const box = boxes.get(s.id);
        if (box) return { id: s.id, width: box.width, height: box.height };
        const heading = headingOf(s);
        return {
          id: s.id,
          children: childrenOf(s.id),
          layoutOptions: {
            "elk.padding": `[top=${headHeight(heading.who)},left=${SCOPE_PAD},bottom=${SCOPE_PAD},right=${SCOPE_PAD}]`,
            // At least as wide as its heading. Laying the scopes out nested
            // together (INCLUDE_CHILDREN), top to bottom, ELK reads a scope's
            // least size as (height, width), the other way round: given
            // (width, 0), it made a scope as tall as its heading was wide,
            // however little it held, and no wider (#67).
            "elk.nodeSize.constraints": "MINIMUM_SIZE",
            "elk.nodeSize.minimum": `(0, ${headWidth(heading)})`,
          },
        };
      }),
    ...g.parts
      .filter((p) => p.scope === scope)
      .map((p): ElkNode => ({ id: p.id, width: parts.get(p.id)!.width, height: parts.get(p.id)!.height })),
  ];
  const edges: ElkExtendedEdge[] = g.lines.map((l) => {
    const label = labels.get(l.id);
    return {
      id: l.id,
      sources: [l.from],
      targets: [l.to],
      labels: label ? [{ id: `${l.id}-label`, text: l.label, width: label.width, height: label.height }] : [],
      layoutOptions:
        l.style === "dotted"
          ? { "elk.layered.priority.direction": "0", "elk.layered.priority.straightness": "1" }
          : { "elk.layered.priority.direction": "10", "elk.layered.priority.straightness": "10" },
    };
  });
  const root: ElkNode = { id: "root", layoutOptions: OPTIONS, children: childrenOf(undefined), edges };
  const out = await elkHere().layout(root);

  // Every box, in the drawing's coordinates rather than its scope's.
  const at = new Map<string, Point & { width: number; height: number }>();
  const walk = (n: ElkNode, x: number, y: number) => {
    for (const c of n.children ?? []) {
      const box = { x: x + (c.x ?? 0), y: y + (c.y ?? 0), width: c.width ?? 0, height: c.height ?? 0 };
      at.set(c.id, box);
      walk(c, box.x, box.y);
    }
  };
  walk(out, 0, 0);

  const drawnParts: DrawnPart[] = g.parts.map((p) => {
    const t = parts.get(p.id)!;
    return {
      id: p.id,
      kind: p.kind,
      caption: t.caption,
      lines: t.lines,
      ...(p.tier ? { tier: p.tier } : {}),
      ...(p.scope ? { scope: p.scope } : {}),
      ...at.get(p.id)!,
    };
  });
  const drawnScopes: DrawnScope[] = g.scopes.map((s) => ({
    id: s.id,
    ...headingOf(s),
    dashed: s.dashed,
    ...(s.fill && s.stroke ? { fill: s.fill, stroke: s.stroke } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.workflow ? { workflow: s.workflow } : {}),
    holds: holding.has(s.id),
    lines: boxes.get(s.id)?.lines ?? [],
    depth: depth.get(s.id) ?? 0,
    ...at.get(s.id)!,
  }));
  const routes = new Map(((out.edges ?? []) as ElkExtendedEdge[]).map((e) => [e.id, e]));
  const drawnLines: DrawnLine[] = g.lines.map(({ label: text, ...l }) => {
    const e = routes.get(l.id);
    const points = (e?.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
    const placed = e?.labels?.[0];
    const label = labels.get(l.id);
    return {
      ...l,
      points,
      ...(text && label && placed
        ? {
            label: {
              lines: label.lines,
              width: label.width,
              height: label.height,
              x: (placed.x ?? 0) + label.width / 2,
              y: (placed.y ?? 0) + label.height / 2,
            },
          }
        : {}),
    };
  });
  // Notes tied to nothing belong to the whole drawing: their icon sits in a
  // strip above it, made for them.
  const strip = g.notes.some((n) => !n.on) ? NOTES_STRIP : 0;
  return {
    box: { x: 0, y: strip ? -strip : 0, width: Math.ceil(out.width ?? 0), height: Math.ceil(out.height ?? 0) + strip },
    parts: drawnParts,
    scopes: drawnScopes,
    lines: drawnLines,
    notes: g.notes,
    ...(strip ? { notesAt: { x: 24, y: -strip / 2 + 4 } } : {}),
  };
}

// The height of the strip above a drawing for the notes of the whole drawing.
const NOTES_STRIP = 36;

// The most a drawing may hold for the server to lay it out. ELK holds the
// Worker while it works, and takes longer the more it lays out: most of all
// for lines that cross many layers, and for scopes nested deep. A drawing
// beyond these isn't laid out at all. Measured in workerd on 2026-10-27, one
// layout of 120 lines, each as long as it can be, took 350 ms with no nesting
// and up to 410 ms with scopes nested 8 deep; the review measured 560 ms at 8
// deep, 1.3 s at 16 and 6.5 s at 50. A page lays out the whole drawing and
// Flow only one after the other, and they are the same size when Flow only
// leaves nothing out, so at these limits a page's first view takes about a
// second at worst; its layouts are kept after that. The largest workflow on
// awml.io holds 53 parts and 73 lines, nested 2 deep. A note isn't laid out,
// but each counts as a part, and each part or scope it is on as a line. The
// limits also bound what the kept layouts hold. `depth` is how deep scopes
// nest: 1 when none is inside another.
export const LIMITS = { parts: 80, lines: 120, characters: 20_000, depth: 8 };

// Whether a graph is beyond LIMITS: its parts, scopes and notes, its lines
// and the notes' ties, the characters of every label in it, and how deep its
// scopes nest.
export function tooBig(g: Graph) {
  const notes = new Set(g.notes.map((n) => n.id)).size;
  const ties = g.notes.filter((n) => n.on).length;
  const characters =
    [...g.parts, ...g.scopes, ...g.notes].reduce((n, x) => n + ("label" in x ? x.label : x.text).length, 0) +
    g.parts.reduce((n, p) => n + (p.tier?.length ?? 0), 0) +
    g.lines.reduce((n, l) => n + (l.label?.length ?? 0), 0);
  return (
    g.parts.length + g.scopes.length + notes > LIMITS.parts ||
    g.lines.length + ties > LIMITS.lines ||
    characters > LIMITS.characters ||
    nesting(g) > LIMITS.depth
  );
}

// How deep a graph's scopes nest: 1 when none is inside another, and 0 when
// it has none.
export function nesting(g: Graph) {
  let deepest = -1;
  for (const d of depths(g).values()) deepest = Math.max(deepest, d);
  return deepest + 1;
}

// "a", "a and b", "a, b and c".
const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// On a system's map, each part joined to workflows' boxes, such as a trigger
// that starts a workflow, or data they share, leads to those workflows, as a
// part with a ref does (#55, #61); and an outside action that starts another
// workflow, by the line to its trigger, leads to the workflow that starts.
// `boxes` are the boxes the viewer may open, by their id in the drawing.
export function mapLinks(d: Drawing, given: Record<string, { title: string; address: string; href: string }>): PartLink[] {
  // Each box by its id, so an id every object inherits, such as constructor, is no box.
  const box = new Map(Object.entries(given));
  const ends = (id: string) => d.lines.flatMap((l) => (l.from === id ? [l.to] : l.to === id ? [l.from] : []));
  const kinds = new Map(d.parts.map((p) => [p.id, p.kind]));
  return d.parts.flatMap((p) => {
    const joined = [...new Set(ends(p.id).filter((id) => box.has(id)))];
    const starts =
      p.kind === "outside"
        ? [
            ...new Set(
              d.lines
                .filter((l) => l.from === p.id && kinds.get(l.to) === "trigger")
                .flatMap((l) => ends(l.to))
                .filter((id) => box.has(id) && !joined.includes(id)),
            ),
          ]
        : [];
    if (!joined.length && !starts.length) return [];
    const title = [
      ...(joined.length ? [`In ${listed(joined.map((id) => box.get(id)!.title))}`] : []),
      ...(starts.length ? [`Starts ${listed(starts.map((id) => box.get(id)!.title))}`] : []),
    ].join("\n");
    return [{ part: p.id, title, to: [...joined, ...starts].map((id) => ({ label: box.get(id)!.address, href: box.get(id)!.href })) }];
  });
}

// One drawing of the engine's graph, the whole of it or Flow only, kept by
// the SHA-256 of the graph's JSON, the switch, and the engine that gave the
// graph (see memo.ts), for the 200 drawings used last. A drawing too big to
// lay out, or one whose layout fails, is kept as that, so it isn't tried
// again; LIMITS also bounds what the 200 hold.
const drawingOf = memoise(async (json: string, flow: boolean, _engine: string): Promise<Drawing | Undrawn> => {
  try {
    const graph = graphOf(json);
    if (tooBig(graph)) return { undrawn: "too big" };
    return await layOutGraph(flow ? flowOnly(graph) : graph);
  } catch (e) {
    console.error(`[awml] a drawing could not be laid out: ${(e as Error).message}`);
    return { undrawn: "failed" };
  }
});

// Both drawings a page may show of the engine's graph, given as its JSON: the
// whole drawing, and Flow only. Both are laid out here, so the switch needs
// nothing more from the server. Never throws: a drawing that can't be laid
// out says why.
export async function layOut(json: string): Promise<Drawings | Undrawn> {
  const version = JSON.stringify(engine.version);
  const [full, flow] = await Promise.all([drawingOf(json, false, version), drawingOf(json, true, version)]);
  if ("undrawn" in full) return full;
  if ("undrawn" in flow) return flow;
  return { full, flow };
}

// The whole drawing alone, as the gallery's cards show it.
export function layOutWhole(json: string): Promise<Drawing | Undrawn> {
  return drawingOf(json, false, JSON.stringify(engine.version));
}
