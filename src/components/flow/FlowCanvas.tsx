"use client";

import "@xyflow/react/dist/base.css";
import {
  Handle,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
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
import type { Drawing, DrawnLine, DrawnPart, DrawnScope, Note, Point, Rect } from "./drawing";
import { LabelGraphic, LineGraphic, NoteIcon, NOTE_R, PartGraphic, roundedPath, ScopeGraphic } from "./Graphic";
import type { Body, Physics } from "./physics";
import { Press } from "../links";
import { notesBy, wholeNotes } from "./StaticDrawing";

// React Flow drawing what the server laid out, so a dragged part takes its
// lines with it (issue #62). It starts exactly where the server's SVG was
// (Drawing.tsx), each piece drawn by the same markup (Graphic.tsx), and
// tells the page once it shows, for the page to hide the SVG. Physics lays
// the same drawing out again with d3-force. Nothing dragged is kept.

export type Mode = "layered" | "physics";

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
type LineData = { id: string; line: DrawnLine; physics: boolean; from?: Point; to?: Point };
type PartNode = Node<PartData, "part">;
type ScopeNode = Node<ScopeData, "scope">;
type NotesNode = Node<NotesData, "notes">;
type FlowNode = PartNode | ScopeNode | NotesNode;
type FlowEdge = Edge<LineData, "line">;

export type FlowCanvasProps = {
  drawing: Drawing;
  id: string;
  mode: Mode;
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
  const { drawing, mode, onReady, onApi, fitOf } = p;
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

  // The page shows React Flow, and hides its SVG, once every part is drawn.
  useEffect(() => {
    if (!initialised || ready.current || !nodes.length) return;
    ready.current = true;
    requestAnimationFrame(() => onReady());
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

  // The drawing, laid out by the server or by the physics. A new drawing, from
  // the Flow only switch, is fitted to the frame.
  const first = useRef(true);
  useEffect(() => {
    let stopped = false;
    const refit = !first.current;
    first.current = false;
    if (refit) fitted.current = true;
    if (mode === "layered") {
      setNodes(layeredNodes(drawing, shared));
      setEdges(linesOf(drawing, p.id, false));
      if (refit) requestAnimationFrame(() => !stopped && flow.setViewport(fitOf(drawing.box), { duration: 200 }));
    } else {
      let started = false;
      import("./physics").then(async ({ startPhysics }) => {
        const sim = await startPhysics(
          drawing,
          (bodies) => {
            if (stopped) return;
            const next = physicsNodes(drawing, bodies, shared);
            if (!started) setNodes(next);
            else {
              const at = new Map(next.map((n) => [n.id, n]));
              setNodes((old) => old.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)!.position, width: at.get(n.id)!.width, height: at.get(n.id)!.height } : n)));
            }
            started = true;
          },
          () => {},
        );
        if (stopped) return sim.stop();
        physics.current = sim;
        setEdges(linesOf(drawing, p.id, true));
        requestAnimationFrame(() => !stopped && flow.setViewport(fitOf(boundsOf(flow.getNodes())), { duration: 200 }));
      });
    }
    return () => {
      stopped = true;
      physics.current?.stop();
      physics.current = undefined;
    };
    // `shared` changing (a fragment, say) restyles the nodes below, without laying out again.
  }, [drawing, mode, p.id, setNodes, flow, fitOf]);

  // The outlined part, the open menu and the links change only what nodes
  // carry and what they are called.
  useEffect(() => {
    setNodes((old) => old.map((n) => labelled(n, shared)));
  }, [shared, setNodes]);

  const centre = (n: Node) => ({ x: n.position.x + (n.width ?? 0) / 2, y: n.position.y + (n.height ?? 0) / 2 });
  const onNodeClick: NodeMouseHandler<FlowNode> = (e, node) => {
    if (!press.current.followsClick() || (e.target as Element).closest("button, a")) return;
    const follows = node.type === "part" ? shared.links.has(node.id) : Boolean(shared.hrefs[node.id]);
    if (follows) p.onFollow(node.id, e);
  };
  const onAuxClick = (e: MouseEvent) => {
    const id = (e.target as Element).closest(".react-flow__node")?.getAttribute("data-id");
    if (e.button !== 1 || !id || (!shared.links.has(id) && !shared.hrefs[id])) return;
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
        physics.current?.hold(n.id, centre(n));
      }}
      onNodeDrag={(_, n) => {
        press.current.moved();
        physics.current?.hold(n.id, centre(n));
      }}
      onNodeDragStop={(_, n) => {
        physics.current?.release(n.id);
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
  if (n.type === "scope" && !n.data.hull && !n.data.scope.holds)
    return { ...n, ...a11y(n.data.scope.lines.join(" "), undefined, shared.hrefs[n.id], false), data: { ...n.data, ...shared } };
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

// The nodes where the server put them, each part inside its scope's box. A
// scope round parts is the background they sit on, so dragging or pinching
// it pans and zooms, on a phone too, rather than moving it.
export function layeredNodes(d: Drawing, shared: Shared): FlowNode[] {
  const scopes = new Map(d.scopes.map((s) => [s.id, s]));
  const relative = (x: number, y: number, parent?: string) => {
    const s = parent ? scopes.get(parent) : undefined;
    return s ? { x: x - s.x, y: y - s.y } : { x, y };
  };
  return [
    ...[...d.scopes]
      .sort((a, b) => a.depth - b.depth)
      .map(
        (s): ScopeNode => ({
          id: s.id,
          type: "scope",
          position: relative(s.x, s.y, s.scope),
          width: s.width,
          height: s.height,
          ...(s.scope ? { parentId: s.scope, expandParent: true } : {}),
          ...(s.holds ? { draggable: false, selectable: false, focusable: false } : {}),
          data: { ...shared, scope: s },
        }),
      ),
    ...d.parts.map(
      (part): PartNode => ({
        id: part.id,
        type: "part",
        position: relative(part.x, part.y, part.scope),
        width: part.width,
        height: part.height,
        ...(part.scope ? { parentId: part.scope, expandParent: true } : {}),
        data: { ...shared, part },
      }),
    ),
    ...notesNode(d, shared, d.notesAt),
  ].map((n) => labelled(n, shared));
}

// The nodes where the physics has them, with each scope that holds parts
// drawn as a soft box round wherever they are, behind the lines: round the
// boxes of the parts in it and of the scopes in it, with room above for its
// title, so nested scopes nest.
function physicsNodes(d: Drawing, bodies: Body[], shared: Shared): FlowNode[] {
  const parts = new Map(d.parts.map((part) => [part.id, part]));
  const scopes = new Map(d.scopes.map((s) => [s.id, s]));
  const boxOf = new Map<string, Rect>();
  const hull = (id: string): Rect | undefined => {
    if (boxOf.has(id)) return boxOf.get(id);
    const inside = [
      ...bodies.filter((b) => b.scopes[0] === id).map((b) => ({ x: b.x! - b.width / 2, y: b.y! - b.height / 2, width: b.width, height: b.height })),
      ...d.scopes.filter((s) => s.scope === id && s.holds).flatMap((s) => hull(s.id) ?? []),
    ];
    if (!inside.length) return undefined;
    const x = Math.min(...inside.map((r) => r.x)) - 20;
    const y = Math.min(...inside.map((r) => r.y)) - 50;
    const box = { x, y, width: Math.max(...inside.map((r) => r.x + r.width)) + 20 - x, height: Math.max(...inside.map((r) => r.y + r.height)) + 20 - y };
    boxOf.set(id, box);
    return box;
  };
  const hulls = d.scopes.flatMap((s): ScopeNode[] => {
    const box = s.holds ? hull(s.id) : undefined;
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
  const boxes = bodies.map((b): FlowNode => {
    const at = { position: { x: b.x! - b.width / 2, y: b.y! - b.height / 2 }, width: b.width, height: b.height };
    const part = parts.get(b.id);
    if (part) return { id: b.id, type: "part", ...at, data: { ...shared, part } };
    return { id: b.id, type: "scope", ...at, data: { ...shared, scope: scopes.get(b.id)! } };
  });
  // The notes of the whole drawing keep to its top-left corner.
  const corner = bodies.length
    ? { x: Math.min(...bodies.map((b) => b.x! - b.width / 2)), y: Math.min(...bodies.map((b) => b.y! - b.height / 2)) - 80 }
    : undefined;
  return [...hulls, ...boxes, ...notesNode(d, shared, corner)].map((n) => labelled(n, shared));
}

function linesOf(d: Drawing, id: string, physics: boolean): FlowEdge[] {
  const at = new Map([...d.parts, ...d.scopes].map((b) => [b.id, { x: b.x, y: b.y }]));
  return d.lines.map((line) => ({
    id: line.id,
    source: line.from,
    target: line.to,
    type: "line",
    data: { id, line, physics, from: at.get(line.from), to: at.get(line.to) },
  }));
}

// The note marks of a part or a scope: the same icon as the server's SVG, as a
// button a keyboard reaches. Hovering shows the note; a click or a tap opens it.
export function NoteButton({ title, notes, at, onNote }: { title: string; notes: Note[]; at: Point; onNote: Shared["onNote"] }) {
  const [tip, setTip] = useState(false);
  return (
    <>
      <button
        type="button"
        className="flow-note-mark nodrag nopan"
        style={{ left: at.x - NOTE_R, top: at.y - NOTE_R }}
        aria-label={`Note on ${title}`}
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
          <NoteIcon count={notes.length} />
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
  return (
    <div className={`flow-node${data.target === part.id ? " part-target" : ""}${data.links.get(part.id)?.to.length ? " part-linked" : ""}`} style={{ width: part.width, height: part.height }}>
      <svg className="flow-node-svg" width={part.width} height={part.height}>
        {data.links.get(part.id) && <title>{data.links.get(part.id)!.title}</title>}
        <PartGraphic part={part} link={data.links.get(part.id)} />
      </svg>
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-handle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-handle" />
      {notes && <NoteButton title={part.lines.join(" ")} notes={notes} at={{ x: part.width - 3, y: part.height - 3 }} onNote={data.onNote} />}
    </div>
  );
}

function ScopeNodeView({ data, width = 0, height = 0 }: NodeProps<ScopeNode>) {
  const scope = { ...data.scope, width, height };
  const notes = data.notes.get(scope.id);
  return (
    <div className="flow-node" style={{ width, height }}>
      <svg className="flow-node-svg" width={width} height={height}>
        <ScopeGraphic scope={scope} href={data.hrefs[scope.id]} hull={data.hull} />
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

// Where a line from the middle of `r` towards `to` leaves its edge, and which side.
function edgePoint(r: Rect, to: Point) {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (!dx && !dy) return { x: cx, y: cy, side: Position.Bottom };
  const kx = dx ? r.width / 2 / Math.abs(dx) : Infinity;
  const ky = dy ? r.height / 2 / Math.abs(dy) : Infinity;
  const k = Math.min(kx, ky);
  const side = kx < ky ? (dx > 0 ? Position.Right : Position.Left) : dy > 0 ? Position.Bottom : Position.Top;
  return { x: cx + dx * k, y: cy + dy * k, side };
}

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

// A line: along the server's route while neither end has moved from where the
// server put it (or both have moved together, as when their scope does), and
// otherwise from edge to edge, so it follows a dragged part.
function LineView({ source, target, data }: EdgeProps<FlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data) return null;
  const { line } = data;
  const sr = rectOf(s);
  const tr = rectOf(t);
  let d: string | undefined;
  let label: Point | undefined;
  if (!data.physics && line.points.length >= 2 && data.from && data.to) {
    const ds = { x: sr.x - data.from.x, y: sr.y - data.from.y };
    const dt = { x: tr.x - data.to.x, y: tr.y - data.to.y };
    if (near(ds, dt)) {
      d = roundedPath(line.points.map((p) => ({ x: p.x + ds.x, y: p.y + ds.y })));
      if (line.label) label = { x: line.label.x + ds.x, y: line.label.y + ds.y };
    }
  }
  if (!d) {
    const a = edgePoint(sr, { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2 });
    const b = edgePoint(tr, { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 });
    if (data.physics) {
      d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
      label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    } else {
      const [path, lx, ly] = getBezierPath({ sourceX: a.x, sourceY: a.y, sourcePosition: a.side, targetX: b.x, targetY: b.y, targetPosition: b.side });
      d = path;
      label = { x: lx, y: ly };
    }
  }
  return (
    <>
      <LineGraphic id={data.id} line={line} d={d} />
      {line.label && label && <LabelGraphic label={line.label} at={label} style={line.style} />}
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
