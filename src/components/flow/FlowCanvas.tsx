"use client";

import "@xyflow/react/dist/base.css";
import {
  EdgeLabelRenderer,
  Handle,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { PartLink } from "@/server/part-links";
import { pointAlong, squareRoute, type Drawing, type DrawnLine, type DrawnPart, type DrawnScope, type Note, type Point, type Rect } from "./drawing";
import { LabelGraphic, LineGraphic, NoteIcon, NOTE_R, PartGraphic, roundedPath, ScopeGraphic } from "./Graphic";
import { startPhysics, type Body, type Physics } from "./physics";
import { hrefOf, Press } from "../links";
import { notesBy, wholeNotes } from "./StaticDrawing";

// React Flow drawing what the server laid out, so a dragged part takes its
// lines with it (issue #62). It starts exactly where the server's SVG was
// (Drawing.tsx), each piece drawn by the same markup (Graphic.tsx), and
// tells the page once it shows, for the page to hide the SVG. The physics
// (physics.ts) then tidies the drawing from there, and nudges what a dragged
// part overlaps out of its way (#78). Nothing dragged is kept.

// What the page's controls and keyboard ask of the drawing.
export type FlowApi = {
  zoomBy(factor: number): void;
  panBy(dx: number, dy: number): void;
  fit(): void;
  actualSize(): void;
  // A part's or box's box in the frame, for a menu beside it.
  rectOf(id: string): Rect | undefined;
};

type Shared = {
  id: string;
  links: Map<string, PartLink>;
  hrefs: Record<string, string>;
  notes: Map<string, Note[]>;
  target?: string;
  // The part whose menu is open.
  menuFor?: string;
  onNote: (title: string, notes: Note[]) => void;
};
type PartData = Shared & { part: DrawnPart };
type ScopeData = Shared & { scope: DrawnScope; hull?: boolean };
type NotesData = Shared & { whole: Note[] };
// `along`: where its label has slid to along it, as a fraction of its length.
type LineData = { id: string; line: DrawnLine; from?: Point; to?: Point; along?: number };
type PartNode = Node<PartData, "part">;
type ScopeNode = Node<ScopeData, "scope">;
type NotesNode = Node<NotesData, "notes">;
type FlowNode = PartNode | ScopeNode | NotesNode;
type FlowEdge = Edge<LineData, "line">;

export type FlowCanvasProps = {
  drawing: Drawing;
  id: string;
  links: PartLink[];
  hrefs: Record<string, string>;
  // Where the server's SVG shows the drawing, for React Flow to start from.
  viewport: Viewport;
  // The part the address's fragment names, outlined.
  target?: string;
  // The part whose menu is open.
  menuFor?: string;
  onReady: () => void;
  onApi: (api: FlowApi) => void;
  onNote: (title: string, notes: Note[]) => void;
  // A press on a linked part, or a box on a system's map, that didn't drag.
  onFollow: (id: string, e: { ctrlKey: boolean; metaKey: boolean; button?: number }) => void;
  fitOf: (box: Rect) => Viewport;
};

export default function FlowCanvas(p: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...p} />
    </ReactFlowProvider>
  );
}

function Canvas(p: FlowCanvasProps) {
  const { drawing, onReady, onApi, fitOf } = p;
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const physics = useRef<Physics>(undefined);
  const press = useRef(new Press());
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const initialised = useNodesInitialized();
  const ready = useRef(false);
  const shared = useMemo(
    () => ({
      id: p.id,
      links: new Map(p.links.map((l) => [l.part, l])),
      hrefs: p.hrefs,
      notes: notesBy(drawing.notes),
      target: p.target,
      menuFor: p.menuFor,
      onNote: p.onNote,
    }),
    [p.id, p.links, p.hrefs, drawing.notes, p.target, p.menuFor, p.onNote],
  );
  const latest = useRef(shared);
  const follow = useRef(p.onFollow);
  useEffect(() => {
    latest.current = shared;
    follow.current = p.onFollow;
  });

  // The page shows React Flow, and hides its SVG, once every part is drawn,
  // and the drawing then settles from there.
  useEffect(() => {
    if (!initialised || ready.current || !nodes.length) return;
    ready.current = true;
    requestAnimationFrame(() => {
      onReady();
      physics.current?.open();
    });
  }, [initialised, nodes.length, onReady]);

  // Whether the reader has left the drawing fitted, so a resize fits it again.
  const fitted = useRef(true);
  const frameOf = useCallback(() => document.querySelector<HTMLElement>(`[data-flow="${p.id}"]`), [p.id]);
  useEffect(() => {
    onApi({
      zoomBy: (factor) => {
        fitted.current = false;
        const v = flow.getViewport();
        const frame = frameOf();
        const cx = (frame?.clientWidth ?? 0) / 2;
        const cy = (frame?.clientHeight ?? 0) / 2;
        const zoom = Math.min(2.5, Math.max(0.1, v.zoom * factor));
        flow.setViewport({ zoom, x: cx - ((cx - v.x) * zoom) / v.zoom, y: cy - ((cy - v.y) * zoom) / v.zoom }, { duration: 120 });
      },
      panBy: (dx, dy) => {
        fitted.current = false;
        const v = flow.getViewport();
        flow.setViewport({ ...v, x: v.x + dx, y: v.y + dy });
      },
      fit: () => {
        fitted.current = true;
        flow.setViewport(fitOf(boundsOf(flow.getNodes())), { duration: 200 });
      },
      actualSize: () => {
        fitted.current = false;
        const v = flow.getViewport();
        flow.setViewport({ ...v, zoom: 1 }, { duration: 120 });
      },
      rectOf: (id) => {
        const n = flow.getInternalNode(id);
        if (!n) return undefined;
        const v = flow.getViewport();
        const { x, y } = n.internals.positionAbsolute;
        return { x: x * v.zoom + v.x, y: y * v.zoom + v.y, width: (n.width ?? 0) * v.zoom, height: (n.height ?? 0) * v.zoom };
      },
    });
  }, [flow, onApi, fitOf, frameOf]);

  // A drawing left fitted is fitted again when its frame changes size, as the
  // server's SVG is.
  useEffect(() => {
    const frame = frameOf();
    if (!frame) return;
    const resized = new ResizeObserver(() => fitted.current && flow.setViewport(fitOf(boundsOf(flow.getNodes()))));
    resized.observe(frame);
    return () => resized.disconnect();
  }, [flow, fitOf, frameOf]);

  // The drawing, starting where the server laid it out, which the physics then
  // moves. As it settles, a drawing left fitted is fitted to where it comes to
  // rest, the view easing there with it, unless the reader drags a part or
  // moves the view first. A new drawing, from the Flow only switch, starts
  // where the server laid it out, and is fitted to the frame as it settles.
  const first = useRef(true);
  const opening = useRef<{ from: Viewport; to: Viewport } | "done">(undefined);
  useEffect(() => {
    let stopped = false;
    let drawn = false;
    opening.current = undefined;
    if (!first.current) fitted.current = true;
    first.current = false;
    const sim = startPhysics(
      drawing,
      (bodies, hulls, opened, along) => {
        if (stopped) return;
        const next = nodesOf(drawing, bodies, hulls, latest.current);
        if (!drawn) {
          drawn = true;
          setNodes(next);
        } else {
          const at = new Map(next.map((n) => [n.id, n]));
          setNodes((old) =>
            old.map((n) => {
              const m = at.get(n.id);
              return m ? { ...n, position: m.position, width: m.width, height: m.height } : n;
            }),
          );
        }
        // Each label where it has slid to along its line.
        setEdges((old) => {
          if (old.every((e) => e.data?.along === along.get(e.id))) return old;
          return old.map((e) => (e.data?.along === along.get(e.id) ? e : { ...e, data: { ...e.data!, along: along.get(e.id) } }));
        });
        const was = opening.current;
        if (opened === 0 || was === "done") return;
        if (fitted.current) {
          const view = was ?? { from: flow.getViewport(), to: fitOf(boundsOf(nodesOf(drawing, sim.rest.bodies, sim.rest.hulls, latest.current))) };
          opening.current = view;
          flow.setViewport({
            x: view.from.x + (view.to.x - view.from.x) * opened,
            y: view.from.y + (view.to.y - view.from.y) * opened,
            zoom: view.from.zoom + (view.to.zoom - view.from.zoom) * opened,
          });
        }
        if (opened >= 1) opening.current = "done";
      },
      () => {},
    );
    physics.current = sim;
    setEdges(linesOf(drawing, p.id));
    if (ready.current) sim.open();
    return () => {
      stopped = true;
      sim.stop();
      physics.current = undefined;
    };
    // `shared` changing (a fragment, say) restyles the nodes below, without laying out again.
  }, [drawing, p.id, setNodes, flow, fitOf]);

  // The outlined part, the open menu and the links change only what nodes
  // carry and what they are called.
  useEffect(() => {
    setNodes((old) => old.map((n) => labelled(n, shared)));
  }, [shared, setNodes]);

  const centre = (n: Node) => ({ x: n.position.x + (n.width ?? 0) / 2, y: n.position.y + (n.height ?? 0) / 2 });
  // React Flow gives every node this handler, so it is the same one each render, and a
  // render that changes no node redraws none.
  const onNodeClick = useCallback<NodeMouseHandler<FlowNode>>((e, node) => {
    const { links, hrefs } = latest.current;
    if (!press.current.followsClick() || (e.target as Element).closest("button, a")) return;
    const follows = node.type === "part" ? links.has(node.id) : Boolean(hrefOf(hrefs, node.id));
    if (follows) follow.current(node.id, e);
  }, []);
  const onAuxClick = (e: MouseEvent) => {
    const id = (e.target as Element).closest(".react-flow__node")?.getAttribute("data-id");
    if (e.button !== 1 || !id || (!shared.links.has(id) && !hrefOf(shared.hrefs, id))) return;
    e.preventDefault();
    p.onFollow(id, e);
  };

  return (
    <ReactFlow<FlowNode, FlowEdge>
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      defaultViewport={p.viewport}
      nodesConnectable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      disableKeyboardA11y
      zoomOnScroll={false}
      panOnScroll={false}
      preventScrolling={false}
      zoomOnDoubleClick
      minZoom={0.1}
      maxZoom={2.5}
      nodeDragThreshold={3}
      proOptions={{ hideAttribution: true }}
      onNodeClick={onNodeClick}
      onAuxClick={onAuxClick}
      onMoveStart={(e) => {
        // Only the reader's own pan or zoom has an event.
        if (e) fitted.current = false;
      }}
      onNodeDragStart={(_, n) => {
        press.current.reset();
        opening.current = "done";
        physics.current?.hold(n.id, centre(n));
      }}
      onNodeDrag={(_, n) => {
        press.current.moved();
        physics.current?.hold(n.id, centre(n));
      }}
      onNodeDragStop={(_, n) => {
        physics.current?.drop(n.id);
        setTimeout(() => press.current.reset());
      }}
    />
  );
}

// The box round some nodes, in the drawing's coordinates, with the margin the
// server's layout leaves round a drawing, so Fit fits it as it first showed.
const MARGIN = 12;
function boundsOf(nodes: Node[]): Rect {
  if (!nodes.length) return { x: 0, y: 0, width: 1, height: 1 };
  const abs = new Map(nodes.map((n) => [n.id, n]));
  const at = (n: Node): Point => {
    const parent = n.parentId ? abs.get(n.parentId) : undefined;
    const base = parent ? at(parent) : { x: 0, y: 0 };
    return { x: base.x + n.position.x, y: base.y + n.position.y };
  };
  const rects = nodes.map((n) => ({ ...at(n), width: n.width ?? 0, height: n.height ?? 0 }));
  const x = Math.min(...rects.map((r) => r.x)) - MARGIN;
  const y = Math.min(...rects.map((r) => r.y)) - MARGIN;
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) + MARGIN - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) + MARGIN - y,
  };
}

// What a node is called, for someone who can't see it, and whether it leads
// anywhere: a workflow's box on a map is a link to its page; a linked part
// (#55) a link to its one workflow, or a button for the menu of several,
// saying whether it is open; a part that leads nowhere is still named by
// where it would lead.
function a11y(label: string, link: PartLink | undefined, href: string | undefined, menuOpen: boolean): Pick<Node, "focusable" | "ariaRole" | "ariaLabel" | "domAttributes"> {
  if (href) return { focusable: true, ariaRole: "link", ariaLabel: `Open ${label}` };
  if (!link) return { focusable: false };
  const named = [label, ...link.title.split("\n")].join(". ");
  if (link.to.length === 0) return { focusable: false, ariaRole: "group", ariaLabel: named };
  const several = link.to.length > 1;
  return {
    focusable: true,
    ariaRole: several ? "button" : "link",
    ariaLabel: named,
    ...(several ? { domAttributes: { "aria-haspopup": "menu", "aria-expanded": menuOpen } } : {}),
  };
}

// A node with what it carries and what it is called brought up to date.
export function labelled(n: FlowNode, shared: Shared): FlowNode {
  if (n.type === "part") {
    const label = n.data.part.lines.join(" ");
    return { ...n, ...a11y(label, shared.links.get(n.id), undefined, shared.menuFor === n.id), data: { ...n.data, ...shared } };
  }
  // A workflow's box on a map is a link to its page, whether or not it holds the outside actions
  // that start other workflows, round which it is drawn as the soft box of a scope.
  const href = hrefOf(shared.hrefs, n.id);
  if (n.type === "scope" && (href || (!n.data.hull && !n.data.scope.holds)))
    return { ...n, ...a11y(n.data.scope.lines.join(" ") || n.data.scope.name, undefined, href, false), data: { ...n.data, ...shared } };
  return { ...n, data: { ...n.data, ...shared } } as FlowNode;
}

// The icon for the notes of the whole drawing, where the server put it.
function notesNode(d: Drawing, shared: Shared, at: Point | undefined): NotesNode[] {
  const whole = wholeNotes(d.notes);
  if (!at || !whole.length) return [];
  return [
    {
      id: "notes-of-the-drawing",
      type: "notes",
      position: { x: at.x - NOTE_R, y: at.y - NOTE_R },
      width: 2 * NOTE_R,
      height: 2 * NOTE_R,
      draggable: false,
      selectable: false,
      focusable: false,
      data: { ...shared, whole },
    },
  ];
}

// The nodes where the physics has them, with each scope that holds parts
// drawn behind the lines as the soft box the physics keeps round wherever
// they are (physics.ts), nested scopes inside. Such a scope is the
// background its parts sit on, so dragging or pinching it pans and zooms, on
// a phone too, rather than moving it. Before the physics has moved anything,
// they are where the server's SVG has them (atServer).
export function nodesOf(d: Drawing, bodies: Body[], boxes: Map<string, Rect>, shared: Shared): FlowNode[] {
  const parts = new Map(d.parts.map((part) => [part.id, part]));
  const scopes = new Map(d.scopes.map((s) => [s.id, s]));
  const hulls = d.scopes.flatMap((s): ScopeNode[] => {
    const box = boxes.get(s.id);
    if (!box) return [];
    return [
      {
        id: s.id,
        type: "scope",
        position: { x: box.x, y: box.y },
        width: box.width,
        height: box.height,
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -10 + s.depth,
        data: { ...shared, scope: { ...s, ...box }, hull: true },
      },
    ];
  });
  const moved = bodies.map((b): FlowNode => {
    const at = { position: { x: b.x! - b.width / 2, y: b.y! - b.height / 2 }, width: b.width, height: b.height };
    const part = parts.get(b.id);
    if (part) return { id: b.id, type: "part", ...at, data: { ...shared, part } };
    return { id: b.id, type: "scope", ...at, data: { ...shared, scope: scopes.get(b.id)! } };
  });
  // The notes of the whole drawing keep to its top-left corner, where the
  // server put them, as it moves.
  const topLeft = (rects: { x: number; y: number }[]) => ({ x: Math.min(...rects.map((r) => r.x)), y: Math.min(...rects.map((r) => r.y)) });
  const was = topLeft([...d.parts, ...d.scopes]);
  const is = topLeft([...boxes.values(), ...moved.map((n) => n.position)]);
  const corner = d.notesAt && (Number.isFinite(is.x - was.x) ? { x: d.notesAt.x + is.x - was.x, y: d.notesAt.y + is.y - was.y } : d.notesAt);
  return [...hulls, ...moved, ...notesNode(d, shared, corner)].map((n) => labelled(n, shared));
}

function linesOf(d: Drawing, id: string): FlowEdge[] {
  const at = new Map([...d.parts, ...d.scopes].map((b) => [b.id, { x: b.x, y: b.y }]));
  return d.lines.map((line) => ({
    id: line.id,
    source: line.from,
    target: line.to,
    type: "line",
    data: { id, line, from: at.get(line.from), to: at.get(line.to) },
  }));
}

// The note marks of a part or a scope: the same icon as the server's SVG, as a
// button a keyboard reaches, a warning mark when one of its notes is a gap.
// Hovering shows the note; a click or a tap opens it.
export function NoteButton({ title, notes, at, onNote }: { title: string; notes: Note[]; at: Point; onNote: Shared["onNote"] }) {
  const [tip, setTip] = useState(false);
  const gap = notes.some((n) => n.gap);
  return (
    <>
      <button
        type="button"
        className="flow-note-mark nodrag nopan"
        style={{ left: at.x - NOTE_R, top: at.y - NOTE_R }}
        aria-label={`${gap ? "Gap in the design" : "Note"} on ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          setTip(false);
          onNote(title, notes);
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && setTip(true)}
        onPointerLeave={() => setTip(false)}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && setTip(true)}
        onBlur={() => setTip(false)}
      >
        <svg width={2 * NOTE_R + 16} height={2 * NOTE_R} viewBox={`${-NOTE_R} ${-NOTE_R} ${2 * NOTE_R + 16} ${2 * NOTE_R}`} aria-hidden>
          <NoteIcon count={notes.length} gap={gap} />
        </svg>
      </button>
      <NodeToolbar isVisible={tip} position={Position.Bottom} align="end" offset={6}>
        <NoteTip notes={notes} />
      </NodeToolbar>
    </>
  );
}

// A part's notes as its icon's tooltip, as text.
export function NoteTip({ notes }: { notes: Note[] }) {
  return (
    <div className="flow-note-tip" role="tooltip">
      {notes.map((n) => (
        <p key={n.id}>{n.text}</p>
      ))}
    </div>
  );
}

function PartNodeView({ data }: NodeProps<PartNode>) {
  const { part } = data;
  const notes = data.notes.get(part.id);
  const label = part.lines.join(" ");
  return (
    <div className={`flow-node${data.target === part.id ? " part-target" : ""}${data.links.get(part.id)?.to.length ? " part-linked" : ""}`} style={{ width: part.width, height: part.height }}>
      <svg className="flow-node-svg" width={part.width} height={part.height}>
        {data.links.get(part.id) && <title>{data.links.get(part.id)!.title}</title>}
        <PartGraphic part={part} link={data.links.get(part.id)} />
      </svg>
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-handle" />
      {notes && <NoteButton title={label} notes={notes} at={{ x: part.width - 3, y: part.height - 3 }} onNote={data.onNote} />}
    </div>
  );
}

function ScopeNodeView({ data, width = 0, height = 0 }: NodeProps<ScopeNode>) {
  const scope = { ...data.scope, width, height };
  const notes = data.notes.get(scope.id);
  return (
    <div className="flow-node" style={{ width, height }}>
      <svg className="flow-node-svg" width={width} height={height}>
        <ScopeGraphic scope={scope} href={hrefOf(data.hrefs, scope.id)} hull={data.hull} />
      </svg>
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-handle" />
      {notes && !data.hull && <NoteButton title={scope.name} notes={notes} at={{ x: width - 3, y: height - 3 }} onNote={data.onNote} />}
    </div>
  );
}

// A node's box in the drawing's coordinates.
function rectOf(n: InternalNode) {
  const { x, y } = n.internals.positionAbsolute;
  return { x, y, width: n.measured.width ?? n.width ?? 0, height: n.measured.height ?? n.height ?? 0 };
}

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

// How a line runs between the boxes of its ends, `s` and `t`: along the
// server's route while neither end has moved from where the server put it,
// `from` and `to` (or both have moved together), and otherwise square, as the
// server's routes are (#67): out of the side of one that faces the other,
// across halfway between them, and into the other, its label halfway along.
// A label the physics has slid along its line is `along` of the way along it.
// So the drawing first shows each line as the server's SVG does, and a line
// stays square as the physics moves its ends.
export function lineRoute(
  line: DrawnLine,
  s: Rect,
  t: Rect,
  from?: Point,
  to?: Point,
  along?: number,
): { points: Point[]; label: Point; server: boolean } {
  const placed = (route: { points: Point[]; label: Point }) => (along === undefined ? route.label : pointAlong(route.points, along));
  if (line.points.length >= 2 && from && to) {
    const ds = { x: s.x - from.x, y: s.y - from.y };
    if (near(ds, { x: t.x - to.x, y: t.y - to.y })) {
      const moved = (p: Point) => ({ x: p.x + ds.x, y: p.y + ds.y });
      const points = line.points.map(moved);
      return { points, label: placed({ points, label: line.label ? moved(line.label) : pointAlong(points, 0.5) }), server: true };
    }
  }
  const route = squareRoute(s, t);
  return { points: route.points, label: placed(route), server: false };
}

// A line, routed by lineRoute, so it follows a dragged part. Each label is
// drawn above every line, as the server's SVG draws them, so no other line
// crosses over it (#78).
function LineView({ source, target, data }: EdgeProps<FlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data) return null;
  const { line } = data;
  const route = lineRoute(line, rectOf(s), rectOf(t), data.from, data.to, data.along);
  return (
    <>
      <LineGraphic id={data.id} line={line} d={roundedPath(route.points)} />
      {line.label && (
        <EdgeLabelRenderer>
          <svg className="flow-node-svg flow-label-svg" width={1} height={1} aria-hidden>
            <LabelGraphic label={line.label} at={route.label} style={line.style} />
          </svg>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// The icon of the notes of the whole drawing.
function NotesNodeView({ data }: NodeProps<NotesNode>) {
  return (
    <div className="flow-node" style={{ width: 2 * NOTE_R, height: 2 * NOTE_R }}>
      <NoteButton title="The whole drawing" notes={data.whole} at={{ x: NOTE_R, y: NOTE_R }} onNote={data.onNote} />
    </div>
  );
}

export const NODE_TYPES = { part: PartNodeView, scope: ScopeNodeView, notes: NotesNodeView };
const EDGE_TYPES = { line: LineView };
