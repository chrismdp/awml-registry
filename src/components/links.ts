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

// Whether a click or a key asks for a new tab, as on a link: the middle
// button, or Ctrl or ⌘ held.
export const newTab = (e: { button?: number; ctrlKey: boolean; metaKey: boolean }) => e.button === 1 || e.ctrlKey || e.metaKey;

// Whether a key follows a focused part: Enter does for a link, and Enter or
// Space for a button that opens a menu.
export const followsOnKey = (key: string, role: string | null) => key === "Enter" || (key === " " && role === "button");

// What following a part does, as a link would: open where it leads, here or
// in a new tab, open the menu of several, close the menu already open, or
// nothing for a part that leads nowhere.
export type Follow = { to: string; newTab: boolean } | "menu" | "close" | null;

export function followOf(to: string | "menu" | null, e: { button?: number; ctrlKey: boolean; metaKey: boolean }, menuOpen: boolean): Follow {
  if (menuOpen) return "close";
  if (to === null || to === "menu") return to;
  return { to, newTab: newTab(e) };
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
