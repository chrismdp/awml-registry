import type { PartLink } from "@/server/part-links";

// Following a part linked to other workflows (#55), or a workflow's box on a
// system's map (#61), as a link would be followed.

const PART = /^[A-Za-z][A-Za-z0-9_]*$/;

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
