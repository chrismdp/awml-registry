// The maths of the frame a workflow's drawing is zoomed and moved in (see
// PanZoom.tsx). A view puts the drawing's top-left corner at (x, y) in the frame
// and scales it by k, as `transform: translate(x, y) scale(k)` with
// `transform-origin: 0 0` does.

export type View = { x: number; y: number; k: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
// A box in the frame, such as where a part of the drawing is shown.
export type Box = { x: number; y: number; width: number; height: number };
export type Direction = "up" | "down" | "left" | "right";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
// What + and −, a double-click and a double-tap zoom by.
export const STEP = 1.25;

export function clampZoom(k: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

// The whole drawing, centred, at the largest size that fits, never above 100%.
export function fit(frame: Size, drawing: Size): View {
  const k = clampZoom(Math.min(1, frame.width / drawing.width, frame.height / drawing.height));
  return { x: (frame.width - drawing.width * k) / 2, y: (frame.height - drawing.height * k) / 2, k };
}

// Zoom to k, keeping the part of the drawing under a point of the frame there.
export function zoomTo(v: View, k: number, at: Point): View {
  const to = clampZoom(k);
  return { x: at.x - ((at.x - v.x) * to) / v.k, y: at.y - ((at.y - v.y) * to) / v.k, k: to };
}

export function zoomAt(v: View, factor: number, at: Point): View {
  return zoomTo(v, v.k * factor, at);
}

// The drawing at its natural size, keeping the frame's centre where it is.
export function actualSize(v: View, frame: Size): View {
  return zoomTo(v, 1, { x: frame.width / 2, y: frame.height / 2 });
}

export function pan(v: View, dx: number, dy: number): View {
  return { x: v.x + dx, y: v.y + dy, k: v.k };
}

// An arrow moves the view a fifth of the frame that way, so the drawing goes
// the other way.
export function move(v: View, frame: Size, direction: Direction): View {
  const dx = frame.width / 5;
  const dy = frame.height / 5;
  switch (direction) {
    case "up":
      return pan(v, 0, dy);
    case "down":
      return pan(v, 0, -dy);
    case "left":
      return pan(v, dx, 0);
    case "right":
      return pan(v, -dx, 0);
  }
}

// At least a quarter of the frame, across and down, holds part of the drawing;
// a drawing shown smaller than that stays whole inside the frame.
export function keepInView(v: View, frame: Size, drawing: Size): View {
  const along = (at: number, shown: number, room: number) => {
    const overlap = Math.min(room / 4, shown);
    return Math.min(room - overlap, Math.max(overlap - shown, at));
  };
  return {
    x: along(v.x, drawing.width * v.k, frame.width),
    y: along(v.y, drawing.height * v.k, frame.height),
    k: v.k,
  };
}

// The view moved as little as it takes to show a box whole, a margin inside
// the frame's edges, or from its top-left corner when it is bigger than that.
export function reveal(v: View, frame: Size, box: Box, margin = 16): View {
  const by = (at: number, size: number, room: number) => {
    if (at < margin || size > room - 2 * margin) return margin - at;
    return Math.min(0, room - margin - (at + size));
  };
  return pan(v, by(box.x, box.width, frame.width), by(box.y, box.height, frame.height));
}

// Where a menu opened from a box in the frame goes: under it, or above it
// when only above has room for it, and inside the frame, a margin from its
// edges, as far as it fits.
export function placeMenu(from: Box, menu: Size, frame: Size, gap = 6, margin = 8): Point {
  const inside = (at: number, size: number, room: number) => Math.max(margin, Math.min(at, room - margin - size));
  const below = from.y + from.height + gap;
  const above = from.y - gap - menu.height;
  const roomBelow = below + menu.height <= frame.height - margin;
  return {
    x: inside(from.x, menu.width, frame.width),
    y: inside(roomBelow || above < margin ? below : above, menu.height, frame.height),
  };
}

// Two pointers moved from one pair of places to the next: the drawing zooms by
// how much further apart they are, and the point under their midpoint follows it.
export function pinch(v: View, before: [Point, Point], after: [Point, Point]): View {
  const mid = ([a, b]: [Point, Point]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const apart = ([a, b]: [Point, Point]) => Math.hypot(a.x - b.x, a.y - b.y);
  const from = mid(before);
  const to = mid(after);
  const d = apart(before);
  const k = d === 0 ? v.k : clampZoom((v.k * apart(after)) / d);
  return { x: to.x - ((from.x - v.x) * k) / v.k, y: to.y - ((from.y - v.y) * k) / v.k, k };
}

// The size Mermaid drew a drawing at, from its SVG's viewBox.
export function naturalSize(viewBox: string | null): Size | undefined {
  const n = (viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x)) || n[2] <= 0 || n[3] <= 0) return undefined;
  return { width: n[2], height: n[3] };
}
