// The registry's drawing of a workflow or a system's map (issue #62): the
// graph read back from the engine's Mermaid text, laid out here on the
// server with ELK, and sent to the page with every position worked out, so
// the browser never loads ELK. The page draws it as plain SVG, which needs no
// scripts, and React Flow takes it over to drag, pan and zoom.
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { engine } from "@/engine";
import { memoise } from "@/engine/memo";
import {
  boxText,
  containers,
  depths,
  lineLabel,
  partText,
  SCOPE_PAD,
  SCOPE_TITLE,
  scopeTitle,
  titleWidth,
  type Drawing,
  type Drawings,
  type DrawnLine,
  type DrawnPart,
  type DrawnScope,
  type Point,
} from "@/components/flow/drawing";
import { flowOnly, parseMermaid, triggersOutside, type Graph } from "@/components/flow/graph";
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

// Lays a graph out: every part's and scope's box, every line's route and its
// label's, in the drawing's own coordinates.
export async function layOutGraph(g: Graph): Promise<Drawing> {
  const holding = containers(g);
  const depth = depths(g);
  const parts = new Map(g.parts.map((p) => [p.id, { part: p, ...partText(p) }]));
  const boxes = new Map(g.scopes.filter((s) => !holding.has(s.id)).map((s) => [s.id, boxText(s)]));
  const labels = new Map(g.lines.flatMap((l) => (l.label ? [[l.id, lineLabel(l.label)] as const] : [])));

  const childrenOf = (scope: string | undefined): ElkNode[] => [
    ...g.scopes
      .filter((s) => s.scope === scope)
      .map((s): ElkNode => {
        const box = boxes.get(s.id);
        if (box) return { id: s.id, width: box.width, height: box.height };
        return {
          id: s.id,
          children: childrenOf(s.id),
          layoutOptions: {
            "elk.padding": `[top=${SCOPE_TITLE.height + 6},left=${SCOPE_PAD},bottom=${SCOPE_PAD},right=${SCOPE_PAD}]`,
            "elk.nodeSize.constraints": "MINIMUM_SIZE",
            "elk.nodeSize.minimum": `(${Math.ceil(titleWidth(s) + 2 * SCOPE_TITLE.left)}, 0)`,
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
    ...scopeTitle(s),
    dashed: s.dashed,
    ...(s.fill && s.stroke ? { fill: s.fill, stroke: s.stroke } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
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
  return {
    box: { x: 0, y: 0, width: Math.ceil(out.width ?? 0), height: Math.ceil(out.height ?? 0) },
    parts: drawnParts,
    scopes: drawnScopes,
    lines: drawnLines,
    notes: g.notes,
  };
}

// On a system's map, each part joined to workflows' boxes, such as a trigger
// one workflow fires and another starts on, or data they share, leads to
// those workflows, as a part with a ref does (#55, #61). `boxes` are the
// boxes the viewer may open, by their id in the drawing.
export function mapLinks(d: Drawing, boxes: Record<string, { title: string; address: string; href: string }>): PartLink[] {
  return d.parts.flatMap((p) => {
    const joined = [
      ...new Set(d.lines.flatMap((l) => (l.from === p.id ? [l.to] : l.to === p.id ? [l.from] : [])).filter((id) => boxes[id])),
    ];
    if (!joined.length) return [];
    const titles = joined.map((id) => boxes[id].title);
    return [
      {
        part: p.id,
        title: `In ${titles.length < 2 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`}`,
        to: joined.map((id) => ({ label: boxes[id].address, href: boxes[id].href })),
      },
    ];
  });
}

// One drawing of the engine's text, the whole of it or Flow only, kept by the
// SHA-256 of the text, the switch, whether it is a system's map, and the
// engine that drew the text (see memo.ts), for the 200 drawings used last.
const drawingOf = memoise(async (text: string, flow: boolean, map: boolean, _engine: string) => {
  const parsed = parseMermaid(text);
  const graph = map ? triggersOutside(parsed) : parsed;
  return layOutGraph(flow ? flowOnly(graph) : graph);
});

// Both drawings a page may show of the engine's text: the whole drawing, and
// Flow only. Both are laid out here, so the switch needs nothing more from
// the server. A system's map draws each trigger outside its workflow's box.
export async function layOut(text: string, opts: { map?: boolean } = {}): Promise<Drawings> {
  const version = JSON.stringify(engine.version);
  const [full, flow] = await Promise.all([
    drawingOf(text, false, Boolean(opts.map), version),
    drawingOf(text, true, Boolean(opts.map), version),
  ]);
  return { full, flow };
}
