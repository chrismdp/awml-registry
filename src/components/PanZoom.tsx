"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { PartLink } from "@/server/part-links";
import { Mermaid } from "./Mermaid";
import { destination, findPart, markPart, outlinePart, PartMenu } from "./PartLinks";
import { follow, followsOnKey, lifted, moved, newTab, pressed, secondPointer, type Follow, type Press } from "./press";
import {
  actualSize,
  fit,
  keepInView,
  move,
  naturalSize,
  pan,
  pinch,
  reveal,
  STEP,
  zoomAt,
  type Box,
  type Direction,
  type Point,
  type Size,
  type View,
} from "./viewport";

export const FRAME_LABEL = "Workflow drawing. Drag to move, pinch or Ctrl+scroll to zoom.";

// A second tap this soon after the first, and this near it, is a double-tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

const KEYS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

// A marked part of the drawing, and where it leads.
type Marked = { node: Element; link: PartLink };
const NOT_ASKED = { newTab: false, menuOpen: false };

// Whether a press landed on one of the controls' buttons. The gaps between them
// belong to the frame, so a finger there still drags or pinches.
export const onControl = (target: EventTarget | null) => (target as Element | null)?.closest?.(".panzoom-controls button") != null;

const sizeOf = (el: HTMLElement | null): Size => ({ width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 });

// A workflow's drawing in a frame the reader zooms and moves like a map: by
// dragging, pinching, double-clicking or tapping, Ctrl or ⌘ with the wheel, the
// keyboard, or the controls in its corner. Until Mermaid has drawn it, the frame
// keeps its size with no controls, and holds the text only without scripts.
// Each part in `links` is marked once drawn, and a click, a tap or Enter on one
// follows it, or opens a menu of where it leads, as a link would (see
// press.ts); a part Tab reaches is moved into view. The part the address's
// fragment names is outlined.
export function PanZoom({ text, links = [] }: { text: string; links?: PartLink[] }) {
  const frame = useRef<HTMLDivElement>(null);
  const drawing = useRef<Size>(undefined);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  // Whether the reader is still at Fit, so a resize fits again.
  const fitted = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  // The press under way, and the marked part it began on.
  const press = useRef<{ p: Press; marked?: Marked }>(undefined);
  const lastTap = useRef<{ at: number; p: Point }>(undefined);
  const lastType = useRef("");
  const [shown, setShown] = useState<View>(view.current);
  const [drawn, setDrawn] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const drawnIn = useRef<HTMLDivElement>(undefined);
  const linksNow = useRef(links);
  // The menu a part with several places to go opens, the part it opened from,
  // and that part's box in the frame.
  const [menu, setMenu] = useState<{ link: PartLink; from: Element; node: Box }>();
  useEffect(() => {
    linksNow.current = links;
  });

  const show = useCallback((next: View, isFit = false) => {
    if (!drawing.current) return;
    fitted.current = isFit;
    view.current = keepInView(next, sizeOf(frame.current), drawing.current);
    setShown(view.current);
    setMenu(undefined);
  }, []);
  const toFit = useCallback(() => {
    if (drawing.current) show(fit(sizeOf(frame.current), drawing.current), true);
  }, [show]);
  const centre = () => {
    const { width, height } = sizeOf(frame.current);
    return { x: width / 2, y: height / 2 };
  };
  const zoom = (factor: number, at: Point = centre()) => show(zoomAt(view.current, factor, at));
  const step = (direction: Direction) => show(move(view.current, sizeOf(frame.current), direction));
  const actual = () => show(actualSize(view.current, sizeOf(frame.current)));
  const pointIn = (e: { clientX: number; clientY: number }): Point => {
    const box = frame.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const boxIn = (el: Element): Box => {
    const box = frame.current!.getBoundingClientRect();
    const at = el.getBoundingClientRect();
    return { x: at.left - box.left, y: at.top - box.top, width: at.width, height: at.height };
  };
  // The marked part an event is on, when it leads anywhere, and its link.
  const markedAt = (target: EventTarget | null): Marked | undefined => {
    const node = (target as Element | null)?.closest?.("[data-part-link]");
    const link = node && linksNow.current.find((l) => l.part === node.getAttribute("data-part-link"));
    return node && link ? { node, link } : undefined;
  };
  const onControls = (e: { target: EventTarget }) => onControl(e.target);

  // Shows the SVG at the size Mermaid drew it, so 100% means that size, then fits it.
  const onDrawn = useCallback(
    (el: HTMLDivElement) => {
      const svg = el.querySelector("svg");
      const size = naturalSize(svg?.getAttribute("viewBox") ?? null);
      if (!svg || !size) return;
      svg.style.removeProperty("max-width");
      svg.setAttribute("width", String(size.width));
      svg.setAttribute("height", String(size.height));
      svg.style.width = `${size.width}px`;
      svg.style.height = `${size.height}px`;
      drawing.current = size;
      drawnIn.current = el;
      for (const link of linksNow.current) {
        const node = findPart(el, link.part);
        if (node) markPart(node as SVGGElement, link);
      }
      outlinePart(el, window.location.hash);
      setDrawn(true);
      toFit();
    },
    [toFit],
  );

  useEffect(() => {
    const el = frame.current;
    if (!drawn || !el) return;
    // Only Ctrl or ⌘ with the wheel zooms, which is also how browsers send a
    // trackpad pinch; a plain wheel scrolls the page. React's wheel listener
    // is passive, so this one is added by hand to stop the browser zooming.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      show(zoomAt(view.current, Math.exp(-Math.max(-50, Math.min(50, delta)) * 0.005), pointIn(e)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const resized = new ResizeObserver(() => (fitted.current ? toFit() : show(view.current)));
    resized.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      resized.disconnect();
    };
  }, [drawn, show, toFit]);

  // A link to another part of this same page outlines that part instead.
  useEffect(() => {
    if (!drawn) return;
    const onHash = () => drawnIn.current && outlinePart(drawnIn.current, window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [drawn]);

  // A press anywhere outside the menu closes it.
  useEffect(() => {
    if (!menu) return;
    const onPress = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.(".part-menu")) setMenu(undefined);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [menu]);

  // A part's menu says whether it is open.
  useEffect(() => {
    if (!menu) return;
    const from = menu.from;
    from.setAttribute("aria-expanded", "true");
    return () => from.setAttribute("aria-expanded", "false");
  }, [menu]);

  // How a marked part is asked to be followed, by a click or a key: in a new
  // tab or not, and whether its menu is open already.
  const asked = (marked: Marked, e: { button?: number; ctrlKey: boolean; metaKey: boolean }) => ({
    newTab: newTab(e),
    menuOpen: menu?.from === marked.node,
  });

  // Follows a marked part: to its one workflow, here or in a new tab, or
  // opens or closes the menu of several by it.
  function act({ node, link }: Marked, f: Follow) {
    if (f === "close") closeMenu();
    else if (f === "menu") setMenu({ link, from: node, node: boxIn(node) });
    else if (f?.newTab) window.open(f.to, "_blank", "noopener");
    else if (f) window.location.assign(f.to);
  }

  function closeMenu() {
    (menu?.from as HTMLElement | SVGElement | undefined)?.focus();
    setMenu(undefined);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    lastType.current = e.pointerType;
    if (!drawn || onControls(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointIn(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      const marked = markedAt(e.target);
      const to = marked ? destination(marked.link) : null;
      press.current = { p: pressed(p, e.pointerType, to, marked ? asked(marked, e) : NOT_ASKED), marked };
    } else if (press.current) press.current.p = secondPointer(press.current.p);
    setGrabbing(true);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const was = pointers.current.get(e.pointerId);
    if (!was) return;
    const p = pointIn(e);
    if (pointers.current.size === 2) {
      const before = [...pointers.current.values()] as [Point, Point];
      pointers.current.set(e.pointerId, p);
      show(pinch(view.current, before, [...pointers.current.values()] as [Point, Point]));
      return;
    }
    pointers.current.set(e.pointerId, p);
    if (press.current) press.current.p = moved(press.current.p, p);
    show(pan(view.current, p.x - was.x, p.y - was.y));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) return;
    setGrabbing(false);
    const ended = press.current;
    press.current = undefined;
    const cancelled = e.type !== "pointerup";
    // A press on a marked part that didn't drag follows it.
    const followed = lifted(ended?.p, cancelled);
    if (ended?.marked && followed) {
      act(ended.marked, followed);
      return;
    }
    // Touch has no dblclick to rely on, so a double-tap is found here.
    if (cancelled || ended?.p.type !== "touch" || ended.p.dragged) return;
    const p = pointIn(e);
    const last = lastTap.current;
    if (last && e.timeStamp - last.at < DOUBLE_TAP_MS && Math.hypot(p.x - last.p.x, p.y - last.p.y) < DOUBLE_TAP_PX) {
      lastTap.current = undefined;
      zoom(STEP, p);
    } else lastTap.current = { at: e.timeStamp, p };
  }

  // A double-tap may also send a dblclick, which it has already zoomed for.
  function onDoubleClick(e: MouseEvent<HTMLDivElement>) {
    if (!drawn || onControls(e) || lastType.current === "touch") return;
    zoom(STEP, pointIn(e));
  }

  // The middle button opens a marked part's workflow in a new tab, as on a
  // link, and doesn't start the browser scrolling.
  function onAuxClick(e: MouseEvent<HTMLDivElement>) {
    const marked = drawn && e.button === 1 ? markedAt(e.target) : undefined;
    if (!marked) return;
    e.preventDefault();
    act(marked, follow(destination(marked.link), asked(marked, e)));
  }
  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (e.button === 1 && markedAt(e.target)) e.preventDefault();
  }

  // A marked part Tab reaches is moved into view, as little as it takes. A
  // click or a tap that focuses one leaves the drawing where it is, so the
  // part doesn't jump from under the pointer, and its menu, which a tap
  // focuses the part after opening, doesn't close.
  function onFocus(e: FocusEvent<HTMLDivElement>) {
    const marked = drawn ? markedAt(e.target) : undefined;
    if (!marked?.node.matches(":focus-visible")) return;
    const next = reveal(view.current, sizeOf(frame.current), boxIn(marked.node));
    if (next.x !== view.current.x || next.y !== view.current.y) show(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!drawn) return;
    const marked = markedAt(e.target);
    if (marked && followsOnKey(e.key, marked.node.getAttribute("role"))) {
      act(marked, follow(destination(marked.link), asked(marked, e)));
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (KEYS[e.key]) step(KEYS[e.key]);
    else if (e.key === "+" || e.key === "=") zoom(STEP);
    else if (e.key === "-") zoom(1 / STEP);
    else if (e.key === "0") actual();
    else if (e.key === "f" || e.key === "F") toFit();
    else return;
    e.preventDefault();
  }

  return (
    <div
      ref={frame}
      className={`panzoom${drawn ? " drawn" : ""}${grabbing ? " grabbing" : ""}`}
      role="group"
      aria-label={FRAME_LABEL}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onAuxClick={onAuxClick}
      onMouseDown={onMouseDown}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <div
        className="panzoom-drawing"
        style={drawn ? { transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.k})` } : undefined}
      >
        <Mermaid text={text} onDrawn={onDrawn} />
      </div>
      {drawn && <PanZoomControls onMove={step} onZoom={zoom} onFit={toFit} onActual={actual} />}
      {menu && <PartMenu link={menu.link} node={menu.node} onClose={closeMenu} />}
    </div>
  );
}

// The arrow pad, then + − Fit 100%, in the frame's bottom-right corner.
export function PanZoomControls(p: {
  onMove: (direction: Direction) => void;
  onZoom: (factor: number) => void;
  onFit: () => void;
  onActual: () => void;
}) {
  return (
    <div className="panzoom-controls">
      <div className="panzoom-pad">
        <Control label="Move up" className="up" onClick={() => p.onMove("up")}>
          ↑
        </Control>
        <Control label="Move left" className="left" onClick={() => p.onMove("left")}>
          ←
        </Control>
        <Control label="Move right" className="right" onClick={() => p.onMove("right")}>
          →
        </Control>
        <Control label="Move down" className="down" onClick={() => p.onMove("down")}>
          ↓
        </Control>
      </div>
      <div className="panzoom-zoom">
        <Control label="Zoom in" onClick={() => p.onZoom(STEP)}>
          +
        </Control>
        <Control label="Zoom out" onClick={() => p.onZoom(1 / STEP)}>
          −
        </Control>
        <Control label="Fit the whole drawing" onClick={p.onFit}>
          Fit
        </Control>
        <Control label="Actual size" onClick={p.onActual}>
          100%
        </Control>
      </div>
    </div>
  );
}

function Control({ label, className, onClick, children }: { label: string; className?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`button outline${className ? ` ${className}` : ""}`} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
