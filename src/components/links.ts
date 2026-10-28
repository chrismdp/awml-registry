import type { PartLink } from "@/server/part-links";

// Following a part linked to other workflows (#55), or a workflow's box on a
// system's map (#61), as a link would be followed.

const PART = /^[A-Za-z][A-Za-z0-9_]*$/;

// Where a part or a box leads, by its id, when it leads anywhere. Only the
// object's own keys count, so an id such as constructor or toString, which
// every object inherits, leads nowhere.
export const hrefOf = (hrefs: Record<string, string>, id: string): string | undefined =>
  Object.hasOwn(hrefs, id) ? hrefs[id] : undefined;

// Where following a linked part goes: straight to its one workflow, a menu
// of several, or nowhere.
export function destination(link: PartLink): string | "menu" | null {
  if (link.to.length === 0) return null;
  return link.to.length === 1 ? link.to[0].href : "menu";
}

// The part an address's fragment names, as /owner/slug#token does.
export function partInHash(hash: string): string | null {
  let part: string;
  try {
    part = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  return PART.test(part) ? part : null;
}

// A link's attributes that open it in a new tab, as every link in a drawing
// embedded on another site does (#75).
export const NEW_TAB = { target: "_blank", rel: "noopener" } as const;

// Whether a click or a key asks for a new tab, as on a link: the middle
// button, or Ctrl or ⌘ held.
export const newTab = (e: { button?: number; ctrlKey: boolean; metaKey: boolean }) => e.button === 1 || e.ctrlKey || e.metaKey;

// Whether a key follows a focused part: Enter does for a link, and Enter or
// Space for a button that opens a menu.
export const followsOnKey = (key: string, role: string | null) => key === "Enter" || (key === " " && role === "button");

// What following a part does, as a link would: open where it leads, here or
// in a new tab, open the menu of several, close the menu already open, or
// nothing for a part that leads nowhere. A drawing embedded on another site
// (#75) opens `always` in a new tab, never in its frame.
export type Follow = { to: string; newTab: boolean } | "menu" | "close" | null;

export function followOf(
  to: string | "menu" | null,
  e: { button?: number; ctrlKey: boolean; metaKey: boolean },
  menuOpen: boolean,
  always = false,
): Follow {
  if (menuOpen) return "close";
  if (to === null || to === "menu") return to;
  return { to, newTab: always || newTab(e) };
}

// A press on a part or a box: one that dragged it moves it and follows
// nothing, so the click that ends it is let go; one that didn't follows it.
export class Press {
  private dragged = false;
  // The part has moved under the pointer.
  moved() {
    this.dragged = true;
  }
  // Whether the click that ends the press follows the part. It ends the press.
  followsClick() {
    const follows = !this.dragged;
    this.dragged = false;
    return follows;
  }
  // A drag that ended without a click on the part, so the next press starts afresh.
  reset() {
    this.dragged = false;
  }
}

// How far, in pixels, a press on a part moves before it drags the part, as React Flow is told
// (FlowCanvas's nodeDragThreshold), and so how far a finger moves before a touch is a drag, a pan
// or a pinch, not a tap.
export const DRAG = 3;

// A tap, on a touch screen or with a pen, which have no hover (decided 2026-10-28): a tap on a
// part lights it as hovering does, and a second tap on it follows it as a click does, if it
// leads anywhere. A tap on another part lights that one, and a tap on the background or a line
// puts the light out. A box that leads somewhere is taken the same way, a scope lighting nothing.
// `tapped` is what the last tap lit, `on` the part or box pressed, if any, and `follows` whether
// a click on it follows a link. A mouse's click follows at once, as before, and leaves what a tap
// lit as it was.
export function tapOf(tapped: string | undefined, on: string | undefined, follows: boolean, touch: boolean): { lit?: string; follow: boolean } {
  if (!touch) return { lit: tapped, follow: follows };
  if (on === undefined) return { lit: undefined, follow: false };
  return { lit: on, follow: follows && tapped === on };
}

// A pointer's event, as the drawing's frame sees it.
type PointerAt = { pointerType: string; isPrimary: boolean; clientX: number; clientY: number };

// What a press on the drawing was, from its pointer's events, for the click that ends it: by a
// touch or a pen, or not; and whether it was a tap, one finger lifted no further than DRAG from
// where it went down. A finger that moves further drags a part or pans, and a second finger
// pinches, so neither is a tap.
export class Gesture {
  private press?: { touch: boolean; tap: boolean; x: number; y: number };
  down(e: PointerAt) {
    if (e.isPrimary) this.press = { touch: e.pointerType === "touch" || e.pointerType === "pen", tap: true, x: e.clientX, y: e.clientY };
    else if (this.press) this.press.tap = false;
  }
  move(e: PointerAt) {
    const p = this.press;
    if (p && e.isPrimary && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG) p.tap = false;
  }
  // The browser took the press over, to scroll the page, say.
  cancel() {
    if (this.press) this.press.tap = false;
  }
  // What the press a click ends was, forgetting it. A click no pointer pressed, as a screen
  // reader's may be, is taken as a mouse's.
  ended(): { touch: boolean; tap: boolean } {
    const p = this.press;
    this.press = undefined;
    return p ? { touch: p.touch, tap: p.tap } : { touch: false, tap: true };
  }
}
