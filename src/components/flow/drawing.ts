import type { Graph, Line, Note, Part, PartKind, Scope } from "./graph";
import { textWidth, widest, wrap } from "./text";

export type { Note };

// A drawing as the server lays it out (src/server/drawing.ts) and the page
// draws it: every part, scope and line with where it goes, in the drawing's
// own coordinates, and every label already broken into lines. It holds only
// what the engine's drawing says, never anything about who is looking, so one
// layout serves everyone who may see the drawing.

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };

export type DrawnPart = Rect & {
  id: string;
  kind: PartKind;
  // Its kind and verb, such as "Code · sort", or "" for none.
  caption: string;
  lines: string[];
  tier?: string;
  scope?: string;
};

export type DrawnScope = Rect & {
  id: string;
  // Its name, and who it is for, as "public: anyone who reads it" gives them.
  name: string;
  who?: string;
  dashed: boolean;
  fill?: string;
  stroke?: string;
  scope?: string;
  // Whether it holds parts or scopes; one that doesn't, such as a workflow's
  // box on a system's map, is a box of its own, its name in `lines`.
  holds: boolean;
  lines: string[];
  depth: number;
};

export type DrawnLabel = Rect & { lines: string[] };

export type DrawnLine = Omit<Line, "label"> & {
  // Where it runs, end to end, with each corner.
  points: Point[];
  // Its label, centred at x, y.
  label?: DrawnLabel;
};

export type Drawing = {
  // The box round everything drawn.
  box: Rect;
  parts: DrawnPart[];
  scopes: DrawnScope[];
  lines: DrawnLine[];
  notes: Note[];
  // Where the icon of the notes of the whole drawing goes, when it has any.
  notesAt?: Point;
};

// Both layouts a page may show: the whole drawing, and Flow only (#51).
export type Drawings = { full: Drawing; flow: Drawing };

// Why the server didn't lay a drawing out: it is beyond the limits it lays
// out (src/server/drawing.ts), or its layout failed.
export type Undrawn = { undrawn: "too big" | "failed" };

// What a page says in place of a drawing it wasn't given, of a workflow or a map.
export const undrawnText = (u: Undrawn, what: "workflow" | "map") =>
  u.undrawn === "too big" ? `This ${what} is too big to draw here.` : `This ${what} can't be drawn here.`;

// The sizes text is drawn at, and the height of each of its lines.
export const LABEL = { size: 14, line: 19 };
export const CAPTION = { size: 12, line: 15, gap: 3 };
export const TIER = { size: 12, height: 20, gap: 4, padding: 8 };
export const LINE_LABEL = { size: 12, line: 16, padX: 9, padY: 3, max: 180 };
export const SCOPE_TITLE = { size: 14, line: 18, top: 14, left: 20, height: 46 };
export const BOX_NAME = { size: 16, line: 21 };
// How far a scope's edge sits from what it holds.
export const SCOPE_PAD = 20;

const TEXT_MAX = 204;
const MIN_WIDTH = 132;
// The name in a title is bold, which Inter draws a little wider.
const BOLD = 1.06;
// Room for a browser drawing the text a pixel wider than measured.
const SLACK = 2;

// The space inside each kind of part round its text: top, right, bottom, left.
export const PADDING: Record<PartKind, [number, number, number, number]> = {
  trigger: [11, 22, 11, 22],
  context: [24, 18, 14, 18],
  connection: [11, 28, 11, 28],
  surface: [34, 16, 12, 16],
  outside: [11, 32, 12, 16],
  ai: [11, 16, 12, 16],
  code: [11, 16, 12, 16],
  person: [11, 16, 12, 16],
  part: [11, 16, 12, 16],
};

const CAPTIONS: Record<PartKind, string> = {
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

// A part's text, broken into lines, and the size of its box round them.
export function partText(p: Part) {
  const caption = [CAPTIONS[p.kind], p.verb].filter(Boolean).join(" · ");
  const lines = wrap(p.label, LABEL.size, TEXT_MAX);
  const [top, right, bottom, left] = PADDING[p.kind];
  const tierWidth = p.tier ? textWidth(p.tier, TIER.size) + 2 * TIER.padding : 0;
  const inner = Math.max(textWidth(caption, CAPTION.size), widest(lines, LABEL.size), tierWidth) + SLACK;
  const height =
    top +
    (caption ? CAPTION.line + CAPTION.gap : 0) +
    lines.length * LABEL.line +
    (p.tier ? TIER.gap + TIER.height : 0) +
    bottom;
  return { caption, lines, width: Math.ceil(Math.max(MIN_WIDTH, inner + left + right)), height };
}

// A scope's name and who it is for, from its label.
export function scopeTitle(s: Scope) {
  const at = s.dashed ? s.label.indexOf(": ") : -1;
  return at < 0 ? { name: s.label } : { name: s.label.slice(0, at), who: s.label.slice(at + 2) };
}

// How wide a scope's title is, which its box is at least as wide as.
export function titleWidth(s: Scope) {
  const { name, who } = scopeTitle(s);
  return textWidth(name, SCOPE_TITLE.size) * BOLD + (who ? 8 + textWidth(who, SCOPE_TITLE.size) : 0) + SLACK;
}

// A box with nothing in it: "Workflow" or "Scope" small above its name.
export const BOX = { padX: 22, padY: 18, max: 216, min: 200 };
export function boxText(s: Scope) {
  const lines = wrap(s.label, BOX_NAME.size, BOX.max);
  const inner = Math.max(widest(lines, BOX_NAME.size) * BOLD + 24, textWidth("Workflow", CAPTION.size)) + SLACK;
  return {
    lines,
    width: Math.ceil(Math.max(BOX.min, inner + 2 * BOX.padX)),
    height: 2 * BOX.padY + CAPTION.line + CAPTION.gap + lines.length * BOX_NAME.line,
  };
}

// A line's label, broken into lines, and the size of the pill round it.
export function lineLabel(text: string) {
  const lines = wrap(text, LINE_LABEL.size, LINE_LABEL.max);
  return {
    lines,
    width: Math.ceil(widest(lines, LINE_LABEL.size) + 2 * LINE_LABEL.padX + SLACK),
    height: lines.length * LINE_LABEL.line + 2 * LINE_LABEL.padY,
  };
}

// The scopes with parts or other scopes in them, drawn round what they hold;
// a scope with nothing in it, such as a workflow's box on a system's map, is
// drawn as a box of its own size.
export function containers(g: Graph) {
  const holding = new Set<string>();
  for (const p of g.parts) if (p.scope) holding.add(p.scope);
  for (const s of g.scopes) if (s.scope) holding.add(s.scope);
  return holding;
}

// How deep each scope is: 0 for one in no other. Each scope's depth is
// worked out once, from its parent's, so a deep nesting takes no longer than
// it has scopes.
export function depths(g: Graph) {
  const parent = new Map(g.scopes.map((s) => [s.id, s.scope]));
  const depth = new Map<string, number>();
  for (const s of g.scopes) {
    // Up to the first scope whose depth is known, or past the top, then down.
    const up: string[] = [];
    let at: string | undefined = s.id;
    while (at !== undefined && !depth.has(at) && up.length <= g.scopes.length) {
      up.push(at);
      at = parent.get(at);
    }
    let d = at === undefined ? -1 : (depth.get(at) ?? -1);
    for (const id of up.reverse()) depth.set(id, ++d);
  }
  return depth;
}

// The outline of each kind of part, drawn at its size: the corners stay the
// same however tall the part is. `extra` is a second line some shapes have:
// a data store's lid, a surface's title bar.
export function outline(kind: PartKind, w: number, h: number): { d: string; extra?: string } {
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
