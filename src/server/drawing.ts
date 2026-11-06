// The registry's drawing of a workflow or a system's map (issue #62): the
// engine's graph of what it draws (issue #69), laid out here on the server
// with ELK, once for each graph and stored (issue #131), and sent to the
// page with every position worked out, so the browser never loads ELK. The
// page draws it as plain SVG, which needs no scripts, and React Flow takes it
// over to drag, pan and zoom.
import { and, eq, ne, sql } from "drizzle-orm";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { after } from "next/server";
import type { Db } from "@/db/client";
import { drawing } from "@/db/schema";
import { engine } from "@/engine";
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
// The room between what ELK lays out, which each scope is given too: ELK
// reads it from the node that holds what it spaces, so the drawing's own
// spacing never reached inside a scope (#78).
const SPACING = {
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.layered.spacing.edgeNodeBetweenLayers": "28",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.spacing.nodeNode": "40",
  "elk.spacing.edgeNode": "24",
  "elk.spacing.edgeEdge": "14",
  "elk.spacing.edgeLabel": "6",
  "elk.spacing.componentComponent": "56",
};
const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.json.edgeCoords": "ROOT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  ...SPACING,
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
// label's, in the drawing's own coordinates. `opened`, each part with a
// description is laid out with it open (#114).
export async function layOutGraph(g: Graph, opened = false): Promise<Drawing> {
  const holding = containers(g);
  const depth = depths(g);
  const parts = new Map(
    g.parts.map((p) => {
      const t = partText(p);
      return [p.id, { ...t, ...(opened && t.description ? t.description.opened : {}) }];
    }),
  );
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
            ...SPACING,
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
      ...(p.unstopped ? { outline: "unstopped" as const } : p.untrusted ? { outline: "untrusted" as const } : {}),
      ...(p.agentRun ? { agentRun: true as const } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...at.get(p.id)!,
    };
  });
  const drawnScopes: DrawnScope[] = g.scopes.map((s) => ({
    id: s.id,
    ...headingOf(s),
    dashed: s.dashed,
    ...(s.fill && s.stroke ? { fill: s.fill, stroke: s.stroke } : {}),
    ...(s.color && s.stroke ? { stroke: s.stroke, color: s.color } : {}),
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
    ...(opened ? { opened: true as const } : {}),
  };
}

// The height of the strip above a drawing for the notes of the whole drawing.
const NOTES_STRIP = 36;

// The most a drawing may hold for the server to lay it out. ELK holds the
// Worker while it works, and takes longer the more it lays out: most of all
// for lines that cross many layers, and for scopes nested deep. A drawing
// beyond these isn't laid out at all. Raised from 80 parts and 120 lines on
// 2026-11-05 (issue #117), so the largest graph on awml.io, the
// operating-model system's map, draws: 82 parts and 22 workflows' boxes, 104
// against the limit of parts, and 167 lines, laid out in 0.65 s. Measured on
// Node on 2026-11-05, one layout at these limits, 150 parts and scopes and
// 250 lines, most of them crossing many layers, took about 1 s with no
// nesting and up to 2.5 s with scopes nested 8 deep. A page lays out the
// whole drawing and Flow only one after the other, and they are the same size
// when Flow only leaves nothing out, so at these limits a page's first view
// takes about 5 s at worst, on a graph made to be slow; its layouts are kept
// after that. A drawing with a part's description is laid out twice more,
// with every description open (#114): measured in Node on 2026-11-05, each
// open layout took as long as a closed one, so its page's first view takes
// about twice as long. Real graphs cost far less, as the map does. From
// 2026-11-06 (issue #131) a push lays its drawings out once it has answered,
// and stores them, so a page lays out only a graph none is stored for, and
// the gallery never lays out. A note isn't laid out,
// but each counts as a part, and each part or scope it is on as a line. The
// limits also bound what the kept and stored layouts hold. `depth` is how
// deep scopes nest: 1 when none is inside another.
export const LIMITS = { parts: 150, lines: 250, characters: 20_000, depth: 8 };

// Whether a graph is beyond LIMITS: its parts, scopes and notes, its lines
// and the notes' ties, the characters of every label and description in it,
// and how deep its scopes nest.
export function tooBig(g: Graph) {
  const notes = new Set(g.notes.map((n) => n.id)).size;
  const ties = g.notes.filter((n) => n.on).length;
  const characters =
    [...g.parts, ...g.scopes, ...g.notes].reduce((n, x) => n + ("label" in x ? x.label : x.text).length, 0) +
    g.parts.reduce((n, p) => n + (p.tier?.length ?? 0) + (p.description?.length ?? 0), 0) +
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

// One drawing of the engine's graph, the whole of it or Flow only, with its
// descriptions closed or open. A drawing too big to lay out, or one whose
// layout fails, says so.
async function drawingOf(graph: Graph, flow: boolean, opened: boolean): Promise<Drawing | Undrawn> {
  try {
    return await layOutGraph(flow ? flowOnly(graph) : graph, opened);
  } catch (e) {
    console.error(`[awml] a drawing could not be laid out: ${(e as Error).message}`);
    return { undrawn: "failed" };
  }
}

// Every drawing a page may show of the engine's graph, given as its JSON: the
// whole drawing, and Flow only, and when a part has a description, both
// again with every description open (#114). All are laid out here, so the
// switches need nothing more from the server. Never throws: a drawing that
// can't be laid out says why. It lays out every time: a page reads its
// drawings with `drawingsOf`, which lays them out only when none are stored.
export async function layOut(json: string): Promise<Drawings | Undrawn> {
  let graph: Graph;
  try {
    graph = graphOf(json);
  } catch (e) {
    console.error(`[awml] a drawing could not be laid out: ${(e as Error).message}`);
    return { undrawn: "failed" };
  }
  if (tooBig(graph)) return { undrawn: "too big" };
  const [full, flow] = await Promise.all([drawingOf(graph, false, false), drawingOf(graph, true, false)]);
  if ("undrawn" in full) return full;
  if ("undrawn" in flow) return flow;
  if (!full.parts.some((p) => p.description)) return { full, flow };
  const [fullOpen, flowOpen] = await Promise.all([drawingOf(graph, false, true), drawingOf(graph, true, true)]);
  if ("undrawn" in fullOpen) return fullOpen;
  if ("undrawn" in flowOpen) return flowOpen;
  return { full, flow, open: { full: fullOpen, flow: flowOpen } };
}

// The layout a stored drawing was made by: the pinned engine's tag, and a
// number bumped by hand whenever the layout code here, or ELK's options,
// change. A drawing stored under any other is stale, and laid out again
// (issue #131).
export const LAYOUT_VERSION = `${engine.version.tag}+layout.1`;

// The SHA-256 of a graph's JSON, which a drawing is stored and kept by.
async function keyOf(json: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The drawings this server or Worker used last, by their graph's key, in
// front of the database, so a hot one doesn't read it for every view: the
// 200 layouts used last, a graph's whole drawing, Flow only and each open
// one counting as one, as many as were kept before they were stored. Each
// caller gets its own copy. LIMITS bounds what each holds.
const kept = new Map<string, Drawings | Undrawn>();
let keptLayouts = 0;
const layoutsIn = (d: Drawings | Undrawn) => ("undrawn" in d ? 1 : d.open ? 4 : 2);
function keep(key: string, drawn: Drawings | Undrawn) {
  const was = kept.get(key);
  if (was) {
    kept.delete(key);
    keptLayouts -= layoutsIn(was);
  }
  kept.set(key, drawn);
  keptLayouts += layoutsIn(drawn);
  for (const [oldest, d] of kept) {
    if (keptLayouts <= 200) break;
    kept.delete(oldest);
    keptLayouts -= layoutsIn(d);
  }
  return structuredClone(drawn);
}

// The drawings stored for a graph under this layout, kept or read from the
// database, or null when none are, or when the database can't be read,
// which the server logs, so the page lays them out as if none were stored.
async function stored(db: Db, key: string): Promise<Drawings | Undrawn | null> {
  const here = kept.get(key);
  if (here) return keep(key, here);
  try {
    const [row] = await db
      .select({ drawn: drawing.drawn })
      .from(drawing)
      .where(and(eq(drawing.graph, key), eq(drawing.layout, LAYOUT_VERSION)));
    return row ? keep(key, row.drawn) : null;
  } catch (e) {
    console.error(`[awml] a stored drawing could not be read: ${(e as Error).message}`);
    return null;
  }
}

// Every drawing a page may show of a graph: the stored ones, or when none
// are stored under this layout, laid out now and stored, replacing any
// stored under another. Two views at once may both lay out; the second write
// replaces the first. A drawing too big to lay out, or whose layout fails,
// is stored as that, so it isn't tried again. Never throws for the layout:
// one that can't be stored is still shown, and the server logs why.
export async function drawingsOf(db: Db, json: string): Promise<Drawings | Undrawn> {
  const key = await keyOf(json);
  const found = await stored(db, key);
  if (found) return found;
  const drawn = await layOut(json);
  try {
    await db
      .insert(drawing)
      .values({ graph: key, layout: LAYOUT_VERSION, drawn })
      .onConflictDoUpdate({ target: [drawing.graph, drawing.layout], set: { drawn } });
    await db.delete(drawing).where(and(eq(drawing.graph, key), ne(drawing.layout, LAYOUT_VERSION)));
  } catch (e) {
    console.error(`[awml] a drawing could not be stored: ${(e as Error).message}`);
  }
  return keep(key, drawn);
}

// The whole drawing stored for a graph, as the gallery's cards show it,
// which never lay one out, or null when none is stored under this layout, or
// the database can't be read. Only the whole drawing is read, and nothing is
// kept, so up to 50 cards neither parse every layout of their graphs nor push
// the pages' drawings out of `kept`.
export async function storedDrawing(db: Db, json: string): Promise<Drawing | Undrawn | null> {
  const key = await keyOf(json);
  const here = kept.get(key);
  if (here) return structuredClone("undrawn" in here ? here : here.full);
  try {
    const [row] = await db
      .select({
        full: sql<string | null>`json_extract(${drawing.drawn}, '$.full')`,
        undrawn: sql<Undrawn["undrawn"] | null>`json_extract(${drawing.drawn}, '$.undrawn')`,
      })
      .from(drawing)
      .where(and(eq(drawing.graph, key), eq(drawing.layout, LAYOUT_VERSION)));
    if (!row) return null;
    return row.undrawn ? { undrawn: row.undrawn } : (JSON.parse(row.full!) as Drawing);
  } catch (e) {
    console.error(`[awml] a stored drawing could not be read: ${(e as Error).message}`);
    return null;
  }
}

// Lays out and stores the drawings of the graphs `graphs` gives, one at a
// time, once the request has answered (Next's `after`, a Worker's
// waitUntil), so a push, or the gallery, never waits for ELK. What goes
// wrong is logged, never thrown: a push is never refused for its drawing.
export function layOutLater(db: Db, graphs: () => Promise<string[]>) {
  after(async () => {
    try {
      for (const json of await graphs()) await drawingsOf(db, json);
    } catch (e) {
      console.error(`[awml] a drawing could not be laid out after the request: ${(e as Error).message}`);
    }
  });
}
