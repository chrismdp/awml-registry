"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { PartLink } from "@/server/part-links";
import type { Drawings, Note, Rect } from "./flow/drawing";
import type { FlowApi, FlowCanvasProps } from "./flow/FlowCanvas";
import { Arrowheads } from "./flow/Graphic";
import { StaticDrawing } from "./flow/StaticDrawing";
import { destination, followOf, followsOnKey, hrefOf, partInHash } from "./links";
import { PartMenu } from "./PartLinks";
import { COMPACT_INSET, fit, INSET, STEP, viewOf, type Box, type Viewport } from "./viewport";

// React Flow, loaded once the page runs, to take over from the server's SVG.
const FlowCanvas = dynamic<FlowCanvasProps>(() => import("./flow/FlowCanvas"), { ssr: false });

export const FRAME_LABEL = "Workflow drawing. Drag a part to move it; drag the background, or use the arrow keys, to move the drawing; pinch, Ctrl+scroll or + and − to zoom.";

// A drawing of a workflow or a system's map, laid out by the server
// (src/server/drawing.ts). The server's SVG shows it first, so it needs no
// scripts; once the page runs, React Flow takes over from just where the SVG
// was, to drag its parts, pan and zoom, and the physics lets it settle from
// there (#78). Its switch: Flow only (#51). A part's notes are behind an icon
// (#60). A part linked to other workflows (#55), and a workflow's box on a
// system's map (#61), opens what it leads to.
//
// A drawing embedded on another site (#75) may start with Flow only on, opens
// every link in a new tab, never in its frame, and is `compact`: smaller
// switches, leaving a small frame more of itself.
export function Drawing({
  drawings,
  links = [],
  hrefs = {},
  label = FRAME_LABEL,
  startFlowOnly = false,
  newTab = false,
  compact = false,
}: {
  drawings: Drawings;
  links?: PartLink[];
  hrefs?: Record<string, string>;
  label?: string;
  startFlowOnly?: boolean;
  newTab?: boolean;
  compact?: boolean;
}) {
  const id = "flow" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const frame = useRef<HTMLDivElement>(null);
  const [flowOnly, setFlowOnly] = useState(startFlowOnly);
  const [start, setStart] = useState<Viewport>();
  const [live, setLive] = useState(false);
  const [note, setNote] = useState<{ title: string; notes: Note[] }>();
  const [menu, setMenu] = useState<{ link: PartLink; node: Box }>();
  const [target, setTarget] = useState<string>();
  const api = useRef<FlowApi>(undefined);
  const drawing = flowOnly ? drawings.flow : drawings.full;

  // Once React Flow has loaded, it starts just where the server's SVG shows
  // the drawing, whichever drawing the switch shows by then.
  const shown = useRef(drawing);
  useEffect(() => {
    shown.current = drawing;
  });
  useEffect(() => {
    let mounted = true;
    import("./flow/FlowCanvas").then(() => {
      const f = frame.current;
      const svg = f?.querySelector("svg.flow-static");
      if (!mounted || !f || !svg) return;
      const at = f.getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      setStart(viewOf({ x: r.left - at.left, y: r.top - at.top, width: r.width, height: r.height }, shown.current.box));
    });
    return () => {
      mounted = false;
    };
  }, []);

  // The part the address's fragment names is outlined.
  useEffect(() => {
    const read = () => setTarget(partInHash(window.location.hash) ?? undefined);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const fitOf = useCallback(
    (box: Rect) =>
      fit({ width: frame.current?.clientWidth ?? 0, height: frame.current?.clientHeight ?? 0 }, box, compact ? COMPACT_INSET : INSET),
    [compact],
  );
  const onReady = useCallback(() => setLive(true), []);
  const onApi = useCallback((a: FlowApi) => (api.current = a), []);
  const onNote = useCallback((title: string, notes: Note[]) => setNote({ title, notes }), []);

  // Follows a linked part or a workflow's box: to its one page, here or in a
  // new tab, or opens or closes the menu of several.
  const onFollow = useCallback(
    (part: string, e: { ctrlKey: boolean; metaKey: boolean; button?: number }) => {
      const link = links.find((l) => l.part === part);
      const to = hrefOf(hrefs, part) ?? (link ? destination(link) : null);
      const f = followOf(to, e, menu?.link.part === part, newTab);
      const node = api.current?.rectOf(part);
      if (f === "close") closeMenu();
      else if (f === "menu" && link && node) setMenu({ link, node });
      else if (f && f !== "menu" && f.newTab) window.open(f.to, "_blank", "noopener");
      else if (f && f !== "menu") window.location.assign(f.to);
    },
    // closeMenu reads only the menu, which is a dependency.
    [hrefs, links, menu, newTab],
  );

  // Closes the menu, giving the focus back to the part it opened from.
  function closeMenu() {
    const part = menu?.link.part;
    setMenu(undefined);
    if (part) frame.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(part)}"]`)?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    const node = el.closest?.(".react-flow__node");
    if (node && followsOnKey(e.key, node.getAttribute("role"))) {
      onFollow(node.getAttribute("data-id") ?? "", e);
      e.preventDefault();
      return;
    }
    if (el.closest?.("button, a, dialog, .part-menu") || e.ctrlKey || e.metaKey || e.altKey) return;
    const a = api.current;
    if (!a) return;
    const step = 60;
    if (e.key === "ArrowUp") a.panBy(0, step);
    else if (e.key === "ArrowDown") a.panBy(0, -step);
    else if (e.key === "ArrowLeft") a.panBy(step, 0);
    else if (e.key === "ArrowRight") a.panBy(-step, 0);
    else if (e.key === "+" || e.key === "=") a.zoomBy(STEP);
    else if (e.key === "-") a.zoomBy(1 / STEP);
    else if (e.key === "0") a.actualSize();
    else if (e.key === "f" || e.key === "F") a.fit();
    else return;
    e.preventDefault();
  }

  // A part Tab reaches is moved into view, as little as it takes, a margin
  // inside the frame. A click or a tap that focuses one leaves the drawing be.
  function onFocus(e: FocusEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement;
    const id = el.closest?.(".react-flow__node")?.getAttribute("data-id");
    const r = id ? api.current?.rectOf(id) : undefined;
    const f = frame.current;
    if (!r || !f || !el.matches(":focus-visible")) return;
    const margin = 16;
    const by = (at: number, size: number, room: number) =>
      at < margin || size > room - 2 * margin ? margin - at : Math.min(0, room - margin - (at + size));
    const dx = by(r.x, r.width, f.clientWidth);
    const dy = by(r.y, r.height, f.clientHeight);
    if (dx || dy) api.current?.panBy(dx, dy);
  }

  // A press anywhere outside the menu closes it, but on the part it opened
  // from, whose click closes it, as a button's would.
  useEffect(() => {
    if (!menu) return;
    const onPress = (e: Event) => {
      const at = e.target as Element | null;
      if (!at?.closest?.(`.part-menu, .react-flow__node[data-id="${CSS.escape(menu.link.part)}"]`)) setMenu(undefined);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [menu]);

  return (
    <div
      ref={frame}
      className={`flow-frame${compact ? " compact" : ""}${live ? " live" : ""}`}
      data-flow={id}
      role="group"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <svg className="flow-defs" width={0} height={0} aria-hidden>
        <Arrowheads id={id} />
      </svg>
      <StaticDrawing drawing={drawing} id={id} links={links} hrefs={hrefs} hidden={live} defs={false} newTab={newTab} />
      {start && (
        <div className="flow-canvas" style={live ? undefined : { visibility: "hidden" }}>
          <FlowCanvas
            drawing={drawing}
            id={id}
            links={links}
            hrefs={hrefs}
            viewport={start}
            target={target}
            menuFor={menu?.link.part}
            onReady={onReady}
            onApi={onApi}
            onNote={onNote}
            onFollow={onFollow}
            fitOf={fitOf}
          />
        </div>
      )}
      <div className="flow-controls flow-switches">
        <button type="button" className="flow-toggle" aria-pressed={flowOnly} onClick={() => setFlowOnly(!flowOnly)}>
          Flow only
        </button>
      </div>
      <div className="flow-controls flow-zoom-controls">
        <div className="flow-pills flow-zoom">
          <Control label="Zoom in" onClick={() => api.current?.zoomBy(STEP)}>
            +
          </Control>
          <Control label="Zoom out" onClick={() => api.current?.zoomBy(1 / STEP)}>
            −
          </Control>
          <Control label="Fit the whole drawing" onClick={() => api.current?.fit()}>
            Fit
          </Control>
        </div>
      </div>
      <NoteDialog shown={note} onClose={() => setNote(undefined)} />
      {menu && <PartMenu link={menu.link} node={menu.node} onClose={closeMenu} newTab={newTab} />}
    </div>
  );
}

function Control({ label, onClick, children }: { label: string; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

// A note in a small modal, as plain text: Escape, Close or a press outside closes it.
export function NoteDialog({ shown, onClose }: { shown?: { title: string; notes: Note[] }; onClose: () => void }) {
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
