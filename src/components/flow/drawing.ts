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
  // The thick outline of a part untrusted text comes from (#83): orange, or
  // red when its text reaches an outside action that nothing stops.
  outline?: "untrusted" | "unstopped";
  // The dashed outline of a code step a model carries out (AWML 0.10.1).
  agentRun?: true;
};

export type DrawnScope = Rect & {
  id: string;
  // Its name, and who it is for, as "public: anyone who reads it" gives them:
  // who it is for broken into lines, drawn under its name.
  name: string;
  who?: string[];
  dashed: boolean;
  fill?: string;
  stroke?: string;
  // A dashed scope's label colour, with its stroke.
  color?: string;
  scope?: string;
  // On a system's map, the workflow a box is, as owner/slug.
  workflow?: string;
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
// Who a scope is for, on lines of its own under its name, smaller. They are
// never broken narrower than `min`, so a narrow scope is made wider rather
// than squeezing them to a word a line.
export const SCOPE_WHO = { size: 12, line: 16, gap: 2, min: 200 };
export const BOX_NAME = { size: 16, line: 21 };
// How far a scope's edge sits from what it holds, and from the bottom of its
// heading.
export const SCOPE_PAD = 20;
const HEAD_GAP = 6;

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
  const caption = [CAPTIONS[p.kind], p.verb, p.untrusted ? "untrusted" : ""].filter(Boolean).join(" · ");
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

// A scope's heading: its name, and who it is for broken into lines no wider
// than `room`, the least room what it holds will leave, or SCOPE_WHO.min if
// that is less.
export function scopeHeading(s: Scope, room: number): { name: string; who?: string[] } {
  const { name, who } = scopeTitle(s);
  return who ? { name, who: wrap(who, SCOPE_WHO.size, Math.max(SCOPE_WHO.min, room)) } : { name };
}

// How far below a scope's top what it holds starts: its name, the lines of
// who it is for, and a gap.
export const headHeight = (who?: string[]) =>
  SCOPE_TITLE.height + (who?.length ? SCOPE_WHO.gap + who.length * SCOPE_WHO.line : 0) + HEAD_GAP;

// How wide a scope is at least: as wide as its heading, with the room at its sides.
export const headWidth = ({ name, who }: { name: string; who?: string[] }) =>
  Math.ceil(Math.max(textWidth(name, SCOPE_TITLE.size) * BOLD, widest(who ?? [], SCOPE_WHO.size)) + SLACK + 2 * SCOPE_TITLE.left);

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

// What is connected to a part: the part itself, every line with it at either
// end, the part at each line's other end, and the notes tied to it.
export type Connected = { parts: Set<string>; lines: Set<string>; notes: Set<string> };

// What is connected to each part, and to each box that holds nothing, such as
// a workflow's box on a system's map, which is drawn as a part is. A scope
// drawn round what it holds has none. Each line and note is looked at once,
// so it takes no longer than the drawing is big.
export function connections(d: Pick<Drawing, "parts" | "scopes" | "lines" | "notes">): Map<string, Connected> {
  const of = new Map<string, Connected>();
  for (const { id } of [...d.parts, ...d.scopes.filter((s) => !s.holds)]) of.set(id, { parts: new Set([id]), lines: new Set(), notes: new Set() });
  for (const line of d.lines) {
    for (const [end, other] of [
      [line.from, line.to],
      [line.to, line.from],
    ]) {
      const c = of.get(end);
      c?.lines.add(line.id);
      c?.parts.add(other);
    }
  }
  for (const note of d.notes) if (note.on) of.get(note.on)?.notes.add(note.id);
  return of;
}

// How a line runs, end to end, and where its label sits on it; `server`
// when it is the server's own route.
export type Route = { points: Point[]; label: Point; server: boolean };

// The four sides of a box. A point on a side is measured from its start, its
// left or top corner, along it; a top or bottom side is level, and a line
// leaves it plumb.
type Side = "top" | "bottom" | "left" | "right";
const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const plumbSide = (side: Side) => side === "top" || side === "bottom";
const sideStart = (r: Rect, side: Side) => (plumbSide(side) ? r.x : r.y);
const sideLength = (r: Rect, side: Side) => (plumbSide(side) ? r.width : r.height);
const sideAt = (r: Rect, side: Side) => ({ top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width })[side];
const pointOn = (r: Rect, side: Side, offset: number): Point => (plumbSide(side) ? { x: r.x + offset, y: sideAt(r, side) } : { x: sideAt(r, side), y: r.y + offset });

// The side of `s` that faces `t`, as the server's routes leave a box (#67):
// one above the other, the bottom of the upper and the top of the lower,
// unless there is less than TURN between them that way and at least that
// side by side; then side to side, so a line never runs along the edge of a
// box it joins (#78).
const TURN = 24;
function facing(s: Rect, t: Rect): Side {
  const above = Math.max(t.y - (s.y + s.height), s.y - (t.y + t.height));
  const beside = Math.max(t.x - (s.x + s.width), s.x - (t.x + t.width));
  if (above >= 0 && (above >= TURN || beside < TURN)) return t.y >= s.y ? "bottom" : "top";
  return t.x >= s.x ? "right" : "left";
}

// The side of `r` that `p` is on, and how far along it, or undefined when it
// is on none.
function sideOf(r: Rect, p: Point | undefined): { side: Side; offset: number } | undefined {
  if (!p) return undefined;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const within = (v: number, a: number, l: number) => v >= a - 0.5 && v <= a + l + 0.5;
  for (const side of ["bottom", "top", "right", "left"] as const) {
    const [u, v] = plumbSide(side) ? [p.y, p.x] : [p.x, p.y];
    if (near(u, sideAt(r, side)) && within(v, sideStart(r, side), sideLength(r, side))) return { side, offset: v - sideStart(r, side) };
  }
  return undefined;
}

// The server's edge spacing (elk.layered.spacing.edgeEdgeBetweenLayers in
// src/server/drawing.ts): how far apart lines in the same gap run.
const LANE = 14;
// How far from a side's corners a line that shares a stretch with the box
// it goes to runs straight into it.
const CORNER = 12;

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

// How every line runs with its ends' boxes where they are now, `boxes`, as
// the server's ELK layout runs them, `served` being where the server put
// each box (#116). A line whose ends haven't moved, or have moved together,
// keeps the server's route exactly. Any other is routed square between the
// sides of its ends that face each other (facing): each end where the
// server's route attached it, as far along that box's side, while that side
// still faces the other end; the other ends on a side spread evenly along it,
// between the ones kept, in the order of where their other ends lie, so they
// don't cross; and lines whose middle stretch runs in the same gap LANE apart,
// side by side. A line's label is halfway along its middle stretch. Each line
// is looked at a few times, and each pair that may share a gap once.
export function lineRoutes(lines: DrawnLine[], boxes: Map<string, Rect>, served: Map<string, Rect>): Map<string, Route> {
  const routes = new Map<string, Route>();
  // One end of a line on a side of a box: how far along the side, once
  // known, the box at its other end, and where that lies along the side.
  type End = { line: number; box: Rect; side: Side; offset?: number; far: Rect; other: number };
  const routed: { line: number; ends: [End, End] }[] = [];
  // The ends on each side of each box.
  const sides = new Map<string, End[]>();
  const end = (line: number, id: string, box: Rect, side: Side, other: Rect, offset?: number) => {
    const e: End = { line, box, side, offset, far: other, other: plumbSide(side) ? other.x + other.width / 2 : other.y + other.height / 2 };
    const key = `${side} ${id}`;
    if (!sides.has(key)) sides.set(key, []);
    sides.get(key)!.push(e);
    return e;
  };
  for (const [i, line] of lines.entries()) {
    const [s, t] = [boxes.get(line.from), boxes.get(line.to)];
    if (!s || !t) continue;
    const [was, wasT] = [served.get(line.from), served.get(line.to)];
    const ds = was && { x: s.x - was.x, y: s.y - was.y };
    if (line.points.length >= 2 && wasT && ds && near(ds, { x: t.x - wasT.x, y: t.y - wasT.y })) {
      const moved = (p: Point) => ({ x: p.x + ds.x, y: p.y + ds.y });
      const points = line.points.map(moved);
      routes.set(line.id, { points, label: line.label ? moved(line.label) : pointAlong(points, 0.5), server: true });
      // Its ends stay where they are, for the lines spread along their sides to keep clear of.
      for (const [id, box, p, other] of [
        [line.from, s, points[0], t],
        [line.to, t, points.at(-1)!, s],
      ] as const) {
        const on = sideOf(box, p);
        if (on) end(i, id, box, on.side, other, on.offset);
      }
      continue;
    }
    if (line.from === line.to) continue;
    const side = facing(s, t);
    // Where the server attached an end, as far along the side, if it is the side that faces now.
    const port = (at: Rect | undefined, p: Point | undefined, want: Side, box: Rect) => {
      const on = at && sideOf(at, p);
      return on?.side === want ? Math.max(0, Math.min(sideLength(box, want), on.offset)) : undefined;
    };
    routed.push({
      line: i,
      ends: [
        end(i, line.from, s, side, t, port(was, line.points[0], side, s)),
        end(i, line.to, t, OPPOSITE[side], s, port(wasT, line.points.at(-1), OPPOSITE[side], t)),
      ],
    });
  }

  // On each side, the ends with no place yet spread evenly between those
  // with one, in the order of where their other ends lie, then of the lines.
  for (const all of sides.values()) {
    if (all.every((e) => e.offset !== undefined)) continue;
    let run: End[] = [];
    let lo = 0;
    const place = (hi: number) => {
      const [only] = run;
      // A line alone on its stretch of a side, to a box it shares a stretch
      // with, runs straight into it, as the server's do.
      const straight = run.length === 1 ? straightAt(only) : undefined;
      if (straight !== undefined && straight >= lo + LANE / 2 && straight <= hi - LANE / 2) only.offset = straight;
      else for (const [k, e] of run.entries()) e.offset = lo + ((hi - lo) * (k + 1)) / (run.length + 1);
      run = [];
    };
    for (const e of [...all].sort((a, b) => a.other - b.other || a.line - b.line)) {
      if (e.offset === undefined) {
        run.push(e);
        continue;
      }
      if (run.length) place(e.offset);
      lo = e.offset;
    }
    if (run.length) place(sideLength(all[0].box, all[0].side));
  }

  // Each re-routed line from its port on one end to its port on the other,
  // `u` the way between them and `v` across it, its middle stretch at `mid`.
  type Shape = { line: number; plumb: boolean; u0: number; u1: number; v0: number; v1: number; mid: number };
  const shapes = routed.map(({ line, ends }): Shape => {
    const [a, b] = ends.map((e) => pointOn(e.box, e.side, e.offset!));
    const plumb = plumbSide(ends[0].side);
    const [u0, u1, v0, v1] = plumb ? [a.y, b.y, a.x, b.x] : [a.x, b.x, a.y, b.y];
    return { line, plumb, u0, u1, v0, v1, mid: (u0 + u1) / 2 };
  });
  // The lines that jog, in groups whose middle stretches run in the same gap,
  // their spans both ways overlapping.
  const jogs = shapes.filter((r) => Math.abs(r.v0 - r.v1) >= 0.5);
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(Math.max(a0, a1), Math.max(b0, b1)) > Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const shares = (p: Shape, q: Shape) => p.plumb === q.plumb && overlaps(p.u0, p.u1, q.u0, q.u1) && overlaps(p.v0, p.v1, q.v0, q.v1);
  const group = jogs.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < jogs.length; i++) for (let j = i + 1; j < jogs.length; j++) if (shares(jogs[i], jogs[j])) group[root(j)] = root(i);
  const groups = new Map<number, Shape[]>();
  for (const [i, r] of jogs.entries()) {
    if (!groups.has(root(i))) groups.set(root(i), []);
    groups.get(root(i))!.push(r);
  }
  for (const lanes of groups.values()) {
    if (lanes.length < 2) continue;
    // The gap they all run in, with a lane each across it, LANE apart, or
    // closer if it is too narrow. From its near side, the first lane is the
    // line that starts furthest the way it turns, so none crosses another.
    const lo = Math.max(...lanes.map((r) => Math.min(r.u0, r.u1)));
    const hi = Math.min(...lanes.map((r) => Math.max(r.u0, r.u1)));
    const centre = hi > lo ? (lo + hi) / 2 : lanes.reduce((a, r) => a + r.mid, 0) / lanes.length;
    const step = hi > lo ? Math.min(LANE, (hi - lo) / lanes.length) : LANE;
    const turn = (r: Shape) => {
      const [from, to] = r.u0 <= r.u1 ? [r.v0, r.v1] : [r.v1, r.v0];
      return Math.sign(to - from) * from;
    };
    const sorted = [...lanes].sort((p, q) => turn(q) - turn(p) || p.line - q.line);
    for (const [k, r] of sorted.entries()) r.mid = centre + (k - (sorted.length - 1) / 2) * step;
  }

  for (const r of shapes) {
    const at = (u: number, v: number): Point => (r.plumb ? { x: v, y: u } : { x: u, y: v });
    const points = Math.abs(r.v0 - r.v1) < 0.5 ? [at(r.u0, r.v0), at(r.u1, r.v0)] : [at(r.u0, r.v0), at(r.mid, r.v0), at(r.mid, r.v1), at(r.u1, r.v1)];
    routes.set(lines[r.line].id, { points, label: at(r.mid, (r.v0 + r.v1) / 2), server: false });
  }
  return routes;
}

// Where along its side a line's end runs straight into the box at its other
// end, when the two share a stretch CORNER clear of their corners: halfway
// between their middles, within it.
function straightAt(e: { box: Rect; side: Side; far: Rect }) {
  const other = e.far;
  const start = (r: Rect) => sideStart(r, e.side);
  const length = (r: Rect) => sideLength(r, e.side);
  const shared = [Math.max(start(e.box), start(other)) + CORNER, Math.min(start(e.box) + length(e.box), start(other) + length(other)) - CORNER];
  if (shared[0] > shared[1]) return undefined;
  const v = Math.min(shared[1], Math.max(shared[0], (start(e.box) + length(e.box) / 2 + start(other) + length(other) / 2) / 2));
  return v - start(e.box);
}

// How long each stretch of a line through `points` is.
const stretches = (points: Point[]) => points.slice(1).map((q, i) => Math.hypot(q.x - points[i].x, q.y - points[i].y));

// The point a fraction `t` of the way along a line through `points`.
export function pointAlong(points: Point[], t: number): Point {
  const lengths = stretches(points);
  let d = Math.max(0, Math.min(1, t)) * lengths.reduce((a, b) => a + b, 0);
  for (const [i, l] of lengths.entries()) {
    if (d <= l || i === lengths.length - 1) {
      const k = l ? Math.min(1, d / l) : 0;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * k, y: points[i].y + (points[i + 1].y - points[i].y) * k };
    }
    d -= l;
  }
  return points[0];
}

// How far along a line through `points` the place nearest `p` is, as a
// fraction of its length, and how long it is.
export function fractionAt(points: Point[], p: Point): { t: number; length: number } {
  const lengths = stretches(points);
  const length = lengths.reduce((a, b) => a + b, 0);
  let best = { d: 0, gap: Infinity };
  let before = 0;
  for (const [i, l] of lengths.entries()) {
    const [a, b] = [points[i], points[i + 1]];
    const k = l ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l))) : 0;
    const gap = Math.hypot(a.x + (b.x - a.x) * k - p.x, a.y + (b.y - a.y) * k - p.y);
    if (gap < best.gap) best = { d: before + k * l, gap };
    before += l;
  }
  return { t: length ? best.d / length : 0.5, length };
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
