"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Mermaid } from "./Mermaid";
import {
  actualSize,
  fit,
  keepInView,
  move,
  naturalSize,
  pan,
  pinch,
  STEP,
  zoomAt,
  type Direction,
  type Point,
  type Size,
  type View,
} from "./viewport";

export const FRAME_LABEL = "Workflow drawing. Drag to move, pinch or Ctrl+scroll to zoom.";

// A second tap this soon after the first, and this near it, is a double-tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
// A pointer that moves further than this before it lifts dragged, not tapped.
const TAP_SLOP_PX = 8;

const KEYS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

// Whether a press landed on one of the controls' buttons. The gaps between them
// belong to the frame, so a finger there still drags or pinches.
export const onControl = (target: EventTarget | null) => (target as Element | null)?.closest?.(".panzoom-controls button") != null;

const sizeOf = (el: HTMLElement | null): Size => ({ width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 });

// A workflow's drawing in a frame the reader zooms and moves like a map: by
// dragging, pinching, double-clicking or tapping, Ctrl or ⌘ with the wheel, the
// keyboard, or the controls in its corner. Until Mermaid has drawn it, the frame
// holds the text with no controls.
export function PanZoom({ text }: { text: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const drawing = useRef<Size>(undefined);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  // Whether the reader is still at Fit, so a resize fits again.
  const fitted = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  const press = useRef<{ start: Point; dragged: boolean; type: string }>(undefined);
  const lastTap = useRef<{ at: number; p: Point }>(undefined);
  const lastType = useRef("");
  const [shown, setShown] = useState<View>(view.current);
  const [drawn, setDrawn] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  const show = useCallback((next: View, isFit = false) => {
    if (!drawing.current) return;
    fitted.current = isFit;
    view.current = keepInView(next, sizeOf(frame.current), drawing.current);
    setShown(view.current);
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

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    lastType.current = e.pointerType;
    if (!drawn || onControls(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointIn(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) press.current = { start: p, dragged: false, type: e.pointerType };
    else if (press.current) press.current.dragged = true;
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
    if (press.current && Math.hypot(p.x - press.current.start.x, p.y - press.current.start.y) > TAP_SLOP_PX)
      press.current.dragged = true;
    show(pan(view.current, p.x - was.x, p.y - was.y));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) return;
    setGrabbing(false);
    const pressed = press.current;
    press.current = undefined;
    // Touch has no dblclick to rely on, so a double-tap is found here.
    if (e.type !== "pointerup" || pressed?.type !== "touch" || pressed.dragged) return;
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

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!drawn || e.ctrlKey || e.metaKey || e.altKey) return;
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
      onKeyDown={onKeyDown}
    >
      <div
        className="panzoom-drawing"
        style={drawn ? { transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.k})` } : undefined}
      >
        <Mermaid text={text} onDrawn={onDrawn} />
      </div>
      {drawn && <PanZoomControls onMove={step} onZoom={zoom} onFit={toFit} onActual={actual} />}
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
