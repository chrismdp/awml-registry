// The maths of the frame a drawing is shown in (see Drawing.tsx). A view puts
// the drawing's origin at (x, y) in the frame and scales it by `zoom`, as
// React Flow's viewport does.

export type Viewport = { x: number; y: number; zoom: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
// A box in the frame, such as where a part of the drawing is shown.
export type Box = { x: number; y: number; width: number; height: number };

// What + and − zoom by.
export const STEP = 1.25;
// The furthest a drawing is scaled up to fit its frame.
export const MAX_ZOOM = 1.1;
// The room a fitted drawing leaves at the frame's edges: above it for the
// switches, below it for the zoom buttons. flow.css gives the server's SVG
// the same room, so the two fit a drawing alike.
export const INSET = { top: 72, right: 20, bottom: 64, left: 20 };

// The whole drawing, centred in the room the frame leaves it, at the largest
// size that fits, never above MAX_ZOOM.
export function fit(frame: Size, drawing: Box): Viewport {
  const room = { width: frame.width - INSET.left - INSET.right, height: frame.height - INSET.top - INSET.bottom };
  const zoom = Math.max(0.01, Math.min(room.width / drawing.width, room.height / drawing.height, MAX_ZOOM));
  return {
    zoom,
    x: INSET.left + (room.width - drawing.width * zoom) / 2 - drawing.x * zoom,
    y: INSET.top + (room.height - drawing.height * zoom) / 2 - drawing.y * zoom,
  };
}

// The view that shows a drawing just where an SVG of it is shown, `svg` being
// where the SVG's box is in the frame: its viewBox is fitted inside that box,
// centred, as preserveAspectRatio="xMidYMid meet" does.
export function viewOf(svg: Box, drawing: Box): Viewport {
  const zoom = Math.min(svg.width / drawing.width, svg.height / drawing.height);
  return {
    zoom,
    x: svg.x + (svg.width - drawing.width * zoom) / 2 - drawing.x * zoom,
    y: svg.y + (svg.height - drawing.height * zoom) / 2 - drawing.y * zoom,
  };
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
