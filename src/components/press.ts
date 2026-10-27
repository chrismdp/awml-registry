// What a press on a workflow's drawing does when it lifts (see PanZoom.tsx).
// A press on a marked part that didn't move follows it, as a link would: to
// its one workflow, in this tab or a new one, or to a menu of several, which
// a second press closes. A press that moved further than a tap, or that a
// second finger joined, dragged or pinched the drawing, and does nothing more.
import type { Point } from "./viewport";

// A pointer that moves further than this before it lifts dragged, not tapped.
export const TAP_SLOP_PX = 8;

// Where a marked part leads (see destination in PartLinks.tsx): one address,
// a menu of several, or nowhere.
export type To = string | "menu" | null;

// How a marked part was asked to be followed: in a new tab or not, and
// whether its menu was open already.
export type Asked = { newTab: boolean; menuOpen: boolean };

// A press from the first pointer down until the last one lifts, and the
// marked part it began on, if any.
export type Press = Asked & { start: Point; dragged: boolean; type: string; to: To };

// What following a part does: open an address, here or in a new tab, open
// its menu, close it, or nothing.
export type Follow = { to: string; newTab: boolean } | "menu" | "close" | null;

// Whether a click or a key asks for a new tab, as on a link: the middle
// button, or Ctrl or ⌘ held.
export const newTab = (e: { button?: number; ctrlKey: boolean; metaKey: boolean }) => e.button === 1 || e.ctrlKey || e.metaKey;

// Whether a key follows a focused part: Enter does for a link, and Enter or
// Space for a button that opens a menu.
export const followsOnKey = (key: string, role: string | null) => key === "Enter" || (key === " " && role === "button");

export function follow(to: To, asked: Asked): Follow {
  if (asked.menuOpen) return "close";
  if (to === null || to === "menu") return to;
  return { to, newTab: asked.newTab };
}

export function pressed(at: Point, type: string, to: To, asked: Asked): Press {
  return { start: at, dragged: false, type, to, ...asked };
}

// Once further than the tap slop from where it began, a press has dragged,
// even if it comes back.
export function moved(p: Press, to: Point): Press {
  return p.dragged || Math.hypot(to.x - p.start.x, to.y - p.start.y) <= TAP_SLOP_PX ? p : { ...p, dragged: true };
}

export function secondPointer(p: Press): Press {
  return { ...p, dragged: true };
}

// What a press does when its last pointer lifts, or is cancelled.
export function lifted(p: Press | undefined, cancelled = false): Follow {
  if (!p || cancelled || p.dragged) return null;
  return follow(p.to, p);
}
