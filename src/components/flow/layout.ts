import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { Graph } from "./graph";

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

// Where the layout put each box, relative to the scope it is in, and how big
// it made each scope; where each line runs, and its label's centre, in the
// drawing's own coordinates; and where each box was, in those coordinates,
// so a line knows when an end has been dragged away from its route.
export type Laid = {
  boxes: Map<string, Point & Size>;
  absolute: Map<string, Point>;
  routes: Map<string, { points: Point[]; label?: Point }>;
};

// The title a scope's box keeps clear above its parts.
export const SCOPE_TITLE = 44;
const SCOPE_PAD = 20;

// The scopes with parts or other scopes in them, drawn round what they hold;
// a scope with nothing in it, such as a workflow's box on a system's map, is
// drawn as a box of its own size.
export function containers(g: Graph) {
  const holding = new Set<string>();
  for (const p of g.parts) if (p.scope) holding.add(p.scope);
  for (const s of g.scopes) if (s.scope) holding.add(s.scope);
  return holding;
}

// Lays the graph out with ELK's layered algorithm, top to bottom, with each
// scope a box around its parts (hierarchical, so lines cross scopes). Solid
// lines, the workflow's own flow, decide the layers before dotted ones.
// `sizes` gives each part's size, and each empty scope's, as drawn; `labels`
// each line label's.
export async function layoutElk(g: Graph, sizes: Map<string, Size>, labels: Map<string, Size>): Promise<Laid> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const holding = containers(g);
  const childrenOf = (scope: string | undefined): ElkNode[] => [
    ...g.scopes
      .filter((s) => s.scope === scope)
      .map((s): ElkNode => {
        const size = sizes.get(s.id) ?? { width: 200, height: 60 };
        return holding.has(s.id)
          ? {
              id: s.id,
              children: childrenOf(s.id),
              layoutOptions: {
                "elk.padding": `[top=${SCOPE_TITLE + 8},left=${SCOPE_PAD},bottom=${SCOPE_PAD},right=${SCOPE_PAD}]`,
                "elk.nodeSize.constraints": "MINIMUM_SIZE",
                "elk.nodeSize.minimum": `(${size.width + 2 * SCOPE_PAD}, 0)`,
              },
            }
          : { id: s.id, ...size };
      }),
    ...g.parts.filter((p) => p.scope === scope).map((p): ElkNode => ({ id: p.id, ...(sizes.get(p.id) ?? { width: 160, height: 48 }) })),
  ];
  const edges: ElkExtendedEdge[] = g.lines.map((l) => ({
    id: l.id,
    sources: [l.from],
    targets: [l.to],
    labels: l.label ? [{ id: `${l.id}-label`, text: l.label, ...(labels.get(l.id) ?? { width: 80, height: 20 }) }] : [],
    layoutOptions:
      l.style === "dotted"
        ? { "elk.layered.priority.direction": "0", "elk.layered.priority.straightness": "1" }
        : { "elk.layered.priority.direction": "10", "elk.layered.priority.straightness": "10" },
  }));
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
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
    },
    children: childrenOf(undefined),
    edges,
  };
  const out = await elk.layout(root);

  const boxes = new Map<string, Point & Size>();
  const absolute = new Map<string, Point>();
  const walk = (n: ElkNode, at: Point) => {
    for (const c of n.children ?? []) {
      const box = { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 };
      boxes.set(c.id, box);
      const abs = { x: at.x + box.x, y: at.y + box.y };
      absolute.set(c.id, abs);
      walk(c, abs);
    }
  };
  walk(out, { x: 0, y: 0 });

  const routes = new Map<string, { points: Point[]; label?: Point }>();
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const points = (e.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
    const label = e.labels?.[0];
    routes.set(e.id, {
      points,
      ...(label?.x !== undefined ? { label: { x: label.x + (label.width ?? 0) / 2, y: (label.y ?? 0) + (label.height ?? 0) / 2 } } : {}),
    });
  }
  return { boxes, absolute, routes };
}
