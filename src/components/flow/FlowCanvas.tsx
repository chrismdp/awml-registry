"use client";

import "@xyflow/react/dist/base.css";
import "./flow.css";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useInternalNode,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type FitViewOptions,
  type InternalNode,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flowOnly, parseMermaid, triggersOutside, type Graph, type Line, type Note, type Part, type PartKind, type Scope } from "./graph";
import { containers, layoutElk, SCOPE_TITLE, type Laid, type Point, type Size } from "./layout";
import type { Body, Physics } from "./physics";

// The experiment of issue #62: a workflow's drawing as a graph laid out in the
// browser, by ELK (layered) or by d3-force (physics), drawn with React Flow so
// a dragged part takes its lines with it. Nothing dragged is kept.

type PartData = { part: Part; notes: Note[] };
type ScopeData = { scope: Scope; notes: Note[]; depth: number; holds: boolean; href?: string; hull?: boolean };
type LineData = { line: Line; route?: { points: Point[]; label?: Point }; sourceAt?: Point; targetAt?: Point; straight?: boolean };
type PartNode = Node<PartData, "part">;
type ScopeNode = Node<ScopeData, "scope">;
type FlowNode = PartNode | ScopeNode;
type FlowEdge = Edge<LineData, "line">;
type Measured = { boxes: Map<string, Size>; labels: Map<string, Size> };
type Mode = "layered" | "physics";

const FIT: FitViewOptions = { padding: { top: "72px", right: "20px", bottom: "64px", left: "20px" }, maxZoom: 1.1 };

const CAPTION: Record<PartKind, string> = {
  trigger: "Trigger",
  context: "Data",
  connection: "Connection",
  surface: "Surface",
  outside: "Outside action",
  ai: "AI",
  code: "Code",
  person: "Person",
  part: "",
};

const STROKE: Record<Line["style"], string> = { solid: "#5d6472", dotted: "#9aa2af", thick: "#3e424b" };

// Opens a part's notes in the modal.
const OpenNote = createContext<(title: string, notes: Note[]) => void>(() => {});

export default function FlowCanvas({ text, hrefs }: { text: string; hrefs?: Record<string, string> }) {
  return (
    <ReactFlowProvider>
      <Canvas text={text} hrefs={hrefs} />
    </ReactFlowProvider>
  );
}

function Canvas({ text, hrefs }: { text: string; hrefs?: Record<string, string> }) {
  const base = useMemo(() => {
    const g = parseMermaid(text);
    return hrefs ? triggersOutside(g) : g;
  }, [text, hrefs]);
  const [mode, setMode] = useState<Mode>("layered");
  const [flow, setFlow] = useState(false);
  const [measured, setMeasured] = useState<Measured>();
  const shown = useMemo(() => (flow ? flowOnly(base) : base), [base, flow]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [note, setNote] = useState<{ title: string; notes: Note[] }>();
  const physics = useRef<Physics>(undefined);
  const dragged = useRef(false);
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  // Each switch, and the first drawing, lays the graph out afresh.
  useEffect(() => {
    if (!measured) return;
    let stopped = false;
    // Once React Flow has the new nodes, which takes it a frame.
    const fit = () => requestAnimationFrame(() => requestAnimationFrame(() => !stopped && fitView(FIT)));
    if (mode === "layered") {
      layoutElk(shown, measured.boxes, measured.labels).then((laid) => {
        if (stopped) return;
        setNodes(elkNodes(shown, laid, hrefs));
        setEdges(linesOf(shown, laid));
        fit();
      });
    } else {
      let first = true;
      let rested = false;
      import("./physics").then(async ({ startPhysics }) => {
        const started = await startPhysics(shown, measured.boxes, (bodies) => {
          if (stopped) return;
          const next = physicsNodes(shown, bodies, hrefs);
          if (first) setNodes(next);
          else {
            const at = new Map(next.map((n) => [n.id, n]));
            setNodes((old) => old.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)!.position, width: at.get(n.id)!.width, height: at.get(n.id)!.height } : n)));
          }
          first = false;
        }, () => {
          // Fitted again once it first comes to rest, but not after each drag.
          if (!stopped && !rested) fitView({ ...FIT, duration: 300 });
          rested = true;
        });
        if (stopped) return started.stop();
        physics.current = started;
        setEdges(linesOf(shown));
        fit();
      });
    }
    return () => {
      stopped = true;
      physics.current?.stop();
      physics.current = undefined;
    };
  }, [shown, mode, measured, hrefs, setNodes, fitView]);

  const centre = (n: Node) => ({ x: n.position.x + (n.width ?? 0) / 2, y: n.position.y + (n.height ?? 0) / 2 });
  const onNodeClick: NodeMouseHandler<FlowNode> = (e, node) => {
    const href = node.type === "scope" ? node.data.href : undefined;
    if (!href || dragged.current || (e.target as Element).closest("a, button")) return;
    if (e.ctrlKey || e.metaKey) window.open(href, "_blank", "noopener");
    else window.location.assign(href);
  };

  return (
    <OpenNote.Provider value={(title, notes) => setNote({ title, notes })}>
      <div className="flow-frame">
        {!measured && <Measure graph={base} hrefs={hrefs} onMeasured={setMeasured} />}
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          nodesConnectable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          panOnScroll={false}
          preventScrolling={false}
          minZoom={0.1}
          maxZoom={2.5}
          nodeDragThreshold={3}
          proOptions={{ hideAttribution: true }}
          onNodeClick={onNodeClick}
          onNodeDragStart={(_, n) => {
            dragged.current = false;
            physics.current?.hold(n.id, centre(n));
          }}
          onNodeDrag={(_, n) => {
            dragged.current = true;
            physics.current?.hold(n.id, centre(n));
          }}
          onNodeDragStop={(_, n) => {
            physics.current?.release(n.id);
            setTimeout(() => (dragged.current = false));
          }}
          aria-label="Workflow drawing. Drag a part to move it, drag the background to pan, pinch or Ctrl+scroll to zoom."
        >
          <Panel position="top-right" className="flow-controls">
            <div className="flow-pills" role="radiogroup" aria-label="Layout">
              {(["layered", "physics"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                  {m === "layered" ? "Layered" : "Physics"}
                </button>
              ))}
            </div>
            <button type="button" className="flow-toggle" aria-pressed={flow} onClick={() => setFlow(!flow)}>
              Flow only
            </button>
          </Panel>
          <Panel position="bottom-right" className="flow-controls">
            <div className="flow-pills flow-zoom">
              <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
                +
              </button>
              <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
                −
              </button>
              <button type="button" aria-label="Fit the whole drawing" title="Fit the whole drawing" onClick={() => fitView({ ...FIT, duration: 200 })}>
                Fit
              </button>
            </div>
          </Panel>
        </ReactFlow>
        <NoteDialog shown={note} onClose={() => setNote(undefined)} />
      </div>
    </OpenNote.Provider>
  );
}

// Each part's notes, and each scope's, by what they belong to.
function notesBy(g: Graph) {
  const by = new Map<string, Note[]>();
  for (const n of g.notes) if (n.on) by.set(n.on, [...(by.get(n.on) ?? []), n]);
  return by;
}

// How deep each scope is: 0 for one in no other.
function depths(g: Graph) {
  const parent = new Map(g.scopes.map((s) => [s.id, s.scope]));
  const depth = new Map<string, number>();
  for (const s of g.scopes) {
    let d = 0;
    for (let p = parent.get(s.id); p; p = parent.get(p)) d++;
    depth.set(s.id, d);
  }
  return depth;
}

function scopeData(g: Graph, s: Scope, hrefs?: Record<string, string>, hull = false): ScopeData {
  return {
    scope: s,
    notes: notesBy(g).get(s.id) ?? [],
    depth: depths(g).get(s.id) ?? 0,
    holds: containers(g).has(s.id),
    ...(hrefs?.[s.id] ? { href: hrefs[s.id] } : {}),
    ...(hull ? { hull } : {}),
  };
}

// The nodes as ELK placed them, each part inside its scope's box.
function elkNodes(g: Graph, laid: Laid, hrefs?: Record<string, string>): FlowNode[] {
  const notes = notesBy(g);
  const place = (id: string) => {
    const b = laid.boxes.get(id)!;
    return { position: { x: b.x, y: b.y }, width: b.width, height: b.height };
  };
  return [
    ...g.scopes.map(
      (s): ScopeNode => ({
        id: s.id,
        type: "scope",
        ...place(s.id),
        ...(s.scope ? { parentId: s.scope, expandParent: true } : {}),
        // A scope round parts is the background they sit on, so dragging or
        // pinching it pans and zooms, on a phone too, rather than moving it.
        ...(containers(g).has(s.id) ? { draggable: false, selectable: false, focusable: false } : {}),
        data: scopeData(g, s, hrefs),
      }),
    ),
    ...g.parts.map(
      (p): PartNode => ({
        id: p.id,
        type: "part",
        ...place(p.id),
        ...(p.scope ? { parentId: p.scope, expandParent: true } : {}),
        data: { part: p, notes: notes.get(p.id) ?? [] },
      }),
    ),
  ];
}

// The nodes where the physics has them, with each scope that holds parts
// drawn as a soft box round wherever they are, behind the lines.
function physicsNodes(g: Graph, bodies: Body[], hrefs?: Record<string, string>): FlowNode[] {
  const notes = notesBy(g);
  const depth = depths(g);
  const parts = new Map(g.parts.map((p) => [p.id, p]));
  const scopes = new Map(g.scopes.map((s) => [s.id, s]));
  // Each scope's box: round the boxes of the parts in it and of the scopes in
  // it, with room above for its title, so nested scopes nest.
  const pad = 20;
  const boxOf = new Map<string, Point & Size>();
  const hull = (id: string): (Point & Size) | undefined => {
    if (boxOf.has(id)) return boxOf.get(id);
    const inside = [
      ...bodies.filter((b) => b.scopes[0] === id).map((b) => ({ x: b.x! - b.width / 2, y: b.y! - b.height / 2, width: b.width, height: b.height })),
      ...g.scopes.filter((s) => s.scope === id).flatMap((s) => hull(s.id) ?? []),
    ];
    if (!inside.length) return undefined;
    const x = Math.min(...inside.map((r) => r.x)) - pad;
    const y = Math.min(...inside.map((r) => r.y)) - SCOPE_TITLE - 4;
    const right = Math.max(...inside.map((r) => r.x + r.width)) + pad;
    const bottom = Math.max(...inside.map((r) => r.y + r.height)) + pad;
    const box = { x, y, width: right - x, height: bottom - y };
    boxOf.set(id, box);
    return box;
  };
  const hulls = g.scopes.flatMap((s): ScopeNode[] => {
    const box = containers(g).has(s.id) ? hull(s.id) : undefined;
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
        zIndex: -10 + (depth.get(s.id) ?? 0),
        data: scopeData(g, s, hrefs, true),
      },
    ];
  });
  const boxes = bodies.map((b): FlowNode => {
    const at = { position: { x: b.x! - b.width / 2, y: b.y! - b.height / 2 }, width: b.width, height: b.height };
    const part = parts.get(b.id);
    return part
      ? { id: b.id, type: "part", ...at, data: { part, notes: notes.get(b.id) ?? [] } }
      : { id: b.id, type: "scope", ...at, data: scopeData(g, scopes.get(b.id)!, hrefs) };
  });
  return [...hulls, ...boxes];
}

function linesOf(g: Graph, laid?: Laid): FlowEdge[] {
  const marker = (l: Line) => ({ type: MarkerType.ArrowClosed, color: STROKE[l.style], width: 18, height: 18 });
  return g.lines.map((l) => ({
    id: l.id,
    source: l.from,
    target: l.to,
    type: "line",
    ...(l.arrowEnd ? { markerEnd: marker(l) } : {}),
    ...(l.arrowStart ? { markerStart: marker(l) } : {}),
    data: laid
      ? { line: l, route: laid.routes.get(l.id), sourceAt: laid.absolute.get(l.from), targetAt: laid.absolute.get(l.to) }
      : { line: l, straight: true },
  }));
}

// Measures each part, each box with no parts, each scope's title and each
// line's label as they will be drawn, in the drawing's font, for the layout.
function Measure({ graph, hrefs, onMeasured }: { graph: Graph; hrefs?: Record<string, string>; onMeasured: (m: Measured) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onMeasured);
  useLayoutEffect(() => {
    done.current = onMeasured;
  });
  useLayoutEffect(() => {
    let live = true;
    // The parts are in Inter, served by the registry; the scopes' and boxes' titles in the site's own font.
    const fonts = ["14px Inter", "12px Inter", '700 14px "Schibsted Grotesk"', '700 16px "Schibsted Grotesk"'];
    Promise.all(fonts.map((f) => document.fonts.load(f)))
      .catch(() => [])
      .then(() => {
        if (!live || !ref.current) return;
        const boxes = new Map<string, Size>();
        const labels = new Map<string, Size>();
        for (const el of ref.current.querySelectorAll<HTMLElement>("[data-measure]")) {
          const [kind, id] = el.dataset.measure!.split(":");
          const r = el.getBoundingClientRect();
          (kind === "line" ? labels : boxes).set(id, { width: Math.ceil(r.width), height: Math.ceil(r.height) });
        }
        done.current({ boxes, labels });
      });
    return () => {
      live = false;
    };
  }, [graph]);
  const holding = containers(graph);
  return (
    <div ref={ref} className="flow-measure" aria-hidden>
      {graph.parts.map((p) => (
        <PartBody key={p.id} part={p} measure />
      ))}
      {graph.scopes.map((s) =>
        holding.has(s.id) ? (
          <div key={s.id} className="flow-scope-title" data-measure={`box:${s.id}`}>
            <ScopeTitle scope={s} />
          </div>
        ) : (
          <BoxBody key={s.id} scope={s} href={hrefs?.[s.id]} measure />
        ),
      )}
      {graph.lines
        .filter((l) => l.label)
        .map((l) => (
          <span key={l.id} className={`flow-line-label ${l.style}`} data-measure={`line:${l.id}`}>
            {l.label}
          </span>
        ))}
    </div>
  );
}

function PartBody({ part, measure }: { part: Part; measure?: boolean }) {
  const caption = [CAPTION[part.kind], part.verb].filter(Boolean).join(" · ");
  return (
    <div className={`flow-part flow-kind-${part.kind}`} {...(measure ? { "data-measure": `box:${part.id}` } : {})}>
      {caption && <span className="flow-caption">{caption}</span>}
      <span className="flow-label">{part.label}</span>
      {part.tier && <span className="flow-tier">{part.tier}</span>}
    </div>
  );
}

// A scope's title: its name, then who it is, as "public: anyone who reads it" gives them.
function ScopeTitle({ scope }: { scope: Scope }) {
  const at = scope.dashed ? scope.label.indexOf(": ") : -1;
  if (at < 0) return <strong>{scope.label}</strong>;
  return (
    <>
      <strong>{scope.label.slice(0, at)}</strong>
      <span>{scope.label.slice(at + 2)}</span>
    </>
  );
}

// A box with no parts in it, such as a workflow's on a system's map.
function BoxBody({ scope, href, measure }: { scope: Scope; href?: string; measure?: boolean }) {
  return (
    <div className="flow-box" {...(measure ? { "data-measure": `box:${scope.id}` } : {})}>
      <span className="flow-caption">{scope.dashed ? "Scope" : "Workflow"}</span>
      {href ? (
        <a className="flow-box-name nodrag" href={href}>
          {scope.label}
          <span className="flow-box-go" aria-hidden>
            {" →"}
          </span>
        </a>
      ) : (
        <span className="flow-box-name">{scope.label}</span>
      )}
    </div>
  );
}

// The outline of each kind of part, drawn at its size: the corners stay the
// same however tall the part is.
function outline(kind: PartKind, w: number, h: number): { d: string; extra?: string } {
  const s = 0.75;
  const W = w - s;
  const H = h - s;
  const rounded = (r: number) =>
    `M ${s + r} ${s} H ${W - r} A ${r} ${r} 0 0 1 ${W} ${s + r} V ${H - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H ${s + r} A ${r} ${r} 0 0 1 ${s} ${H - r} V ${s + r} A ${r} ${r} 0 0 1 ${s + r} ${s} Z`;
  switch (kind) {
    case "trigger":
      return { d: rounded(Math.min(22, (h - 2 * s) / 2)) };
    case "context": {
      const rx = (W - s) / 2;
      const ry = 9;
      return {
        d: `M ${s} ${s + ry} A ${rx} ${ry} 0 0 1 ${W} ${s + ry} V ${H - ry} A ${rx} ${ry} 0 0 1 ${s} ${H - ry} Z`,
        extra: `M ${s} ${s + ry} A ${rx} ${ry} 0 0 0 ${W} ${s + ry}`,
      };
    }
    case "connection": {
      const k = 16;
      return { d: `M ${s + k} ${s} H ${W - k} L ${W} ${h / 2} L ${W - k} ${H} H ${s + k} L ${s} ${h / 2} Z` };
    }
    case "outside": {
      const k = 18;
      const r = 12;
      return {
        d: `M ${s + r} ${s} H ${W - k} L ${W} ${h / 2} L ${W - k} ${H} H ${s + r} A ${r} ${r} 0 0 1 ${s} ${H - r} V ${s + r} A ${r} ${r} 0 0 1 ${s + r} ${s} Z`,
      };
    }
    case "surface":
      return { d: rounded(12), extra: `M ${s} 24 H ${W}` };
    case "part":
      return { d: rounded(8) };
    default:
      return { d: rounded(16) };
  }
}

function PartNodeView({ data, width = 0, height = 0 }: NodeProps<PartNode>) {
  const { d, extra } = outline(data.part.kind, width, height);
  return (
    <div className={`flow-node flow-kind-${data.part.kind}`} style={{ width, height }}>
      <svg className="flow-shape" width={width} height={height} aria-hidden>
        <path d={d} />
        {extra && <path className="flow-shape-line" d={extra} />}
      </svg>
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-handle" />
      <PartBody part={data.part} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-handle" />
      {data.notes.length > 0 && <NoteMark title={data.part.label} notes={data.notes} />}
    </div>
  );
}

function ScopeNodeView({ data, width, height }: NodeProps<ScopeNode>) {
  const { scope, holds, href, hull, depth } = data;
  const kind = scope.dashed ? "dashed" : href ? "workflow" : "place";
  return (
    <div
      className={`flow-scope ${kind} depth-${depth % 2}${holds ? "" : " alone"}${hull ? " hull" : ""}${href ? " linked" : ""}`}
      style={{ width, height }}
      title={href ? `Open ${scope.label}` : undefined}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="flow-handle" />
      {holds ? (
        <div className="flow-scope-title">
          {href ? (
            <a className="nodrag" href={href}>
              {scope.label}
            </a>
          ) : (
            <ScopeTitle scope={scope} />
          )}
        </div>
      ) : (
        <BoxBody scope={scope} href={href} />
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="flow-handle" />
      {data.notes.length > 0 && <NoteMark title={scope.label} notes={data.notes} />}
    </div>
  );
}

function NoteMark({ title, notes }: { title: string; notes: Note[] }) {
  const open = useContext(OpenNote);
  const [tip, setTip] = useState(false);
  return (
    <>
      <button
        type="button"
        className="flow-note-mark nodrag nopan"
        aria-label={`Note on ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          setTip(false);
          open(title, notes);
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && setTip(true)}
        onPointerLeave={() => setTip(false)}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && setTip(true)}
        onBlur={() => setTip(false)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M3 1.5h5.5L11 4v8.5H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M5 6.5h4M5 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        {notes.length > 1 && <span>{notes.length}</span>}
      </button>
      <NodeToolbar isVisible={tip} position={Position.Bottom} align="end" offset={6} className="flow-note-tip">
        {notes.map((n) => (
          <p key={n.id}>{n.text}</p>
        ))}
      </NodeToolbar>
    </>
  );
}

// A note in a small modal, as plain text: Escape, Close or a press outside closes it.
function NoteDialog({ shown, onClose }: { shown?: { title: string; notes: Note[] }; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (shown && !d.open) d.showModal();
    if (!shown && d.open) d.close();
  }, [shown]);
  return (
    <dialog
      ref={ref}
      className="flow-note-dialog"
      aria-label="Note"
      onClose={onClose}
      onClick={(e: MouseEvent<HTMLDialogElement>) => e.target === e.currentTarget && e.currentTarget.close()}
    >
      {shown && (
        <div className="flow-note-box">
          <div className="flow-note-head">
            <h2>Note</h2>
            <button type="button" className="button" onClick={() => ref.current?.close()}>
              Close
            </button>
          </div>
          <p className="flow-note-on">{shown.title}</p>
          {shown.notes.map((n) => (
            <p key={n.id}>{n.text}</p>
          ))}
        </div>
      )}
    </dialog>
  );
}

// A node's box in the drawing's coordinates.
function rectOf(n: InternalNode) {
  const { x, y } = n.internals.positionAbsolute;
  return { x, y, width: n.measured.width ?? n.width ?? 0, height: n.measured.height ?? n.height ?? 0 };
}

// Where a line from the middle of `r` towards `to` leaves its edge, and which side.
function edgePoint(r: Point & Size, to: Point) {
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

// A route with its corners rounded.
function roundedPath(points: Point[], radius = 10) {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, ab / 2, bc / 2);
    if (!ab || !bc) continue;
    const p = { x: b.x - ((b.x - a.x) / ab) * r, y: b.y - ((b.y - a.y) / ab) * r };
    const q = { x: b.x + ((c.x - b.x) / bc) * r, y: b.y + ((c.y - b.y) / bc) * r };
    d += ` L ${p.x} ${p.y} Q ${b.x} ${b.y} ${q.x} ${q.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

// A line: along ELK's route while neither end has moved from where ELK put it
// (or both have moved together, as when their scope is dragged), and
// otherwise from edge to edge, so it follows a dragged part.
function LineView({ id, source, target, data, markerEnd, markerStart }: EdgeProps<FlowEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data) return null;
  const sr = rectOf(s);
  const tr = rectOf(t);
  let path: string | undefined;
  let label: Point | undefined;
  const r = data.route;
  if (r && r.points.length >= 2 && data.sourceAt && data.targetAt) {
    const ds = { x: sr.x - data.sourceAt.x, y: sr.y - data.sourceAt.y };
    const dt = { x: tr.x - data.targetAt.x, y: tr.y - data.targetAt.y };
    if (near(ds, dt)) {
      path = roundedPath(r.points.map((p) => ({ x: p.x + ds.x, y: p.y + ds.y })));
      const mid = r.points[Math.floor(r.points.length / 2)];
      label = r.label ? { x: r.label.x + ds.x, y: r.label.y + ds.y } : { x: mid.x + ds.x, y: mid.y + ds.y };
    }
  }
  if (!path) {
    const a = edgePoint(sr, { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2 });
    const b = edgePoint(tr, { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 });
    if (data.straight) {
      path = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
      label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    } else {
      const [p, lx, ly] = getBezierPath({ sourceX: a.x, sourceY: a.y, sourcePosition: a.side, targetX: b.x, targetY: b.y, targetPosition: b.side });
      path = p;
      label = { x: lx, y: ly };
    }
  }
  const style = data.line.style;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} markerStart={markerStart} className={`flow-line ${style}`} />
      {data.line.label && label && (
        <EdgeLabelRenderer>
          <div className={`flow-line-label ${style}`} style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}>
            {data.line.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { part: PartNodeView, scope: ScopeNodeView };
const EDGE_TYPES = { line: LineView };
