import { fractionAt, headHeight, headWidth, pointAlong, SCOPE_PAD, squareRoute, type Drawing, type DrawnLabel, type DrawnScope, type Point, type Rect } from "./drawing";

// How the drawing moves once the page runs (#78). It starts just where the
// server laid it out with ELK, which is spaced for it: the opening only tidies
// what overlaps, each part moving at most OPENING_REACH from where ELK put it,
// and it keeps ELK's places when tidying can't do better. A dragged part
// follows the pointer and nothing else moves unless something overlaps it: a
// part it overlaps, with a small margin, is nudged out of its way by as
// little as will clear it, and so on for what that part then overlaps, a few
// parts deep at most. A label is never pushed off its line: one that is
// overlapped slides along its line to the nearest place clear. A scope is only
// ever drawn round its parts, with its padding and heading: it never moves a
// part and never pushes anything. Nothing moves once a part is dropped.

// A box that moves: a part, or a scope with no parts, by its centre. `scopes`
// are the scopes it is in, the nearest first.
export type Body = { id: string; width: number; height: number; scopes: string[]; x: number; y: number };

export type Physics = {
  // Where each box's centre is now.
  bodies: Body[];
  // Where everything rests once the drawing has opened: each box, and the box
  // of each scope that holds parts.
  rest: { bodies: Body[]; hulls: Map<string, Rect> };
  // Eases the drawing from where the server laid it out to where it rests,
  // over OPENING milliseconds.
  open(): void;
  // Puts a box where the pointer is while it is dragged.
  hold(id: string, at: Point): void;
  // Leaves it where it was dropped.
  drop(id: string): void;
  stop(): void;
};

// The room a nudged part is given round the part that nudged it, and a label
// round anything it slides clear of.
export const MARGIN = { part: 8, label: 6 };
// How many parts deep a nudge goes: the dragged part's, and those of the
// parts it nudged, and so on. A part deeper in the chain is left where it is.
// A part is nudged the shorter way out that leaves it clear of the rest, if
// that is no more than ROOM times the shortest way.
export const CHAIN = 3;
export const ROOM = 2;
// Nothing further than this from the dragged part ever moves, and no more
// than this many passes are made to clear what overlaps.
export const REACH = 140;
export const PASSES = 8;
// How far the opening's tidy may move a part from where ELK put it.
export const OPENING_REACH = 40;
// How long the drawing takes to open, and how it eases in and out of the
// move, so it starts just where the server's SVG was.
export const OPENING = 900;
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const boxOf = (b: Body): Rect => ({ x: b.x - b.width / 2, y: b.y - b.height / 2, width: b.width, height: b.height });
// How far apart two boxes are: the larger of the gaps across and down, or 0.
const gapOf = (a: Rect, b: Rect) => Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width), a.y - (b.y + b.height), b.y - (a.y + a.height));
const overlap = (a: Rect, b: Rect, gap = 0) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

// How far `b` must move to be `gap` clear of `a`: along the shorter way out,
// away from `a`, or undefined when it already is.
function away(a: Rect, b: Rect, gap: number): Point | undefined {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  const ox = (a.width + b.width) / 2 + gap - Math.abs(dx);
  const oy = (a.height + b.height) / 2 + gap - Math.abs(dy);
  if (ox <= 0 || oy <= 0) return undefined;
  return ox < oy ? { x: ox * Math.sign(dx || 1), y: 0 } : { x: 0, y: oy * Math.sign(dy || 1) };
}

// What each scope that holds parts holds directly: its bodies and the scopes in it.
type Held = { bodies: Body[]; scopes: DrawnScope[] };

// The box each scope that holds parts is drawn as: round the boxes of its
// parts and of the scopes in it, SCOPE_PAD clear of them, its heading above
// them, and at least as wide as its heading, as the server's layout makes a
// scope. So a scope inside another is inside it, and it fits its parts
// wherever they are.
function hullsOf(deepestFirst: DrawnScope[], held: Map<string, Held>) {
  const hulls = new Map<string, Rect>();
  for (const s of deepestFirst) {
    const { bodies, scopes } = held.get(s.id)!;
    const boxes = [...bodies.map(boxOf), ...scopes.flatMap((c) => hulls.get(c.id) ?? [])];
    if (!boxes.length) continue;
    let x = Math.min(...boxes.map((r) => r.x)) - SCOPE_PAD;
    let right = Math.max(...boxes.map((r) => r.x + r.width)) + SCOPE_PAD;
    const y = Math.min(...boxes.map((r) => r.y)) - headHeight(s.who);
    const bottom = Math.max(...boxes.map((r) => r.y + r.height)) + SCOPE_PAD;
    const short = headWidth(s) - (right - x);
    if (short > 0) {
      x -= short / 2;
      right += short / 2;
    }
    hulls.set(s.id, { x, y, width: right - x, height: bottom - y });
  }
  return hulls;
}

// Every box where the server laid it out: each part and each scope with
// nothing in it as a body, by its centre, and each scope that holds parts as
// the server's box round them. It is where the drawing starts, so React Flow
// first draws it just as the server's SVG shows it.
export function atServer(g: Drawing): { bodies: Body[]; hulls: Map<string, Rect> } {
  const parentOf = new Map<string, string | undefined>([
    ...g.parts.map((p) => [p.id, p.scope] as const),
    ...g.scopes.map((s) => [s.id, s.scope] as const),
  ]);
  const chain = (id: string) => {
    const out: string[] = [];
    for (let s = parentOf.get(id); s; s = parentOf.get(s)) out.push(s);
    return out;
  };
  return {
    bodies: [...g.parts, ...g.scopes.filter((s) => !s.holds)].map((b) => ({
      id: b.id,
      width: b.width,
      height: b.height,
      scopes: chain(b.id),
      x: b.x + b.width / 2,
      y: b.y + b.height / 2,
    })),
    hulls: new Map(g.scopes.filter((s) => s.holds).map((s) => [s.id, { x: s.x, y: s.y, width: s.width, height: s.height }])),
  };
}

// A line between two bodies, as the page draws it (FlowCanvas.tsx's
// lineRoute): along the server's route while its ends are where the server
// put them, or have moved together, and otherwise square between them. `at`
// is where its label is along it, as a fraction of its length, once the label
// has had to slide; until then it is where the server put it, or halfway.
type Line = { id: string; from: Body; to: Body; label?: DrawnLabel; points: Point[]; ends: [Point, Point]; at?: number };

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
function routeOf(l: Line): { points: Point[]; label: Point } {
  const [s, t] = [boxOf(l.from), boxOf(l.to)];
  const ds = { x: s.x - l.ends[0].x, y: s.y - l.ends[0].y };
  if (l.points.length >= 2 && near(ds, { x: t.x - l.ends[1].x, y: t.y - l.ends[1].y })) {
    const moved = (p: Point) => ({ x: p.x + ds.x, y: p.y + ds.y });
    const points = l.points.map(moved);
    return { points, label: l.label ? moved(l.label) : pointAlong(points, 0.5) };
  }
  return squareRoute(s, t);
}
function labelBox(l: Line): Rect {
  const route = routeOf(l);
  const p = l.at === undefined ? route.label : pointAlong(route.points, l.at);
  return { x: p.x - l.label!.width / 2, y: p.y - l.label!.height / 2, width: l.label!.width, height: l.label!.height };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  width: lerp(a.width, b.width, t),
  height: lerp(a.height, b.height, t),
});

// The browser's next frame, or, where there is none, as under test, a timer.
const frame = (f: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => f()) : setTimeout(f, 16));
const clock = () => (typeof performance === "object" ? performance.now() : Date.now());

// Starts the drawing where the server laid it out. `tick` is told each time
// the boxes move, with the box of each scope that holds parts, how far the
// drawing has opened, eased, from 0 to 1, and where each label that has slid
// is along its line; `settled` once it has opened.
export function startPhysics(
  g: Drawing,
  tick: (bodies: Body[], hulls: Map<string, Rect>, opened: number, along: Map<string, number>) => void,
  settled: () => void,
): Physics {
  const server = atServer(g);
  const { bodies } = server;
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const elk = new Map(bodies.map((b) => [b, { x: b.x, y: b.y }]));

  const holding = g.scopes.filter((s) => s.holds);
  const deepestFirst = [...holding].sort((a, b) => b.depth - a.depth);
  const held = new Map<string, Held>(holding.map((s) => [s.id, { bodies: [], scopes: [] }]));
  for (const b of bodies) if (b.scopes[0]) held.get(b.scopes[0])?.bodies.push(b);
  for (const s of holding) if (s.scope) held.get(s.scope)?.scopes.push(s);
  const hulls = () => hullsOf(deepestFirst, held);

  const lines: Line[] = g.lines.flatMap((l) => {
    const [from, to] = [byId.get(l.from), byId.get(l.to)];
    if (!from || !to || from === to) return [];
    return [{ id: l.id, from, to, label: l.label, points: l.points, ends: [boxOf(from), boxOf(to)] as [Point, Point] }];
  });
  const labelled = lines.filter((l) => l.label);
  const along = () => new Map(labelled.flatMap((l) => (l.at === undefined ? [] : [[l.id, l.at] as const])));

  // Slides each label in `which` that overlaps a part, or a label not in
  // `which`, along its line to the nearest place clear of every part and label,
  // 8 pixels at a time; one with no such place stays where it is.
  const slide = (which: Line[]) => {
    for (const l of which) {
      const box = labelBox(l);
      const others = labelled.filter((o) => o !== l).map(labelBox);
      const parts = bodies.map(boxOf);
      const clear = (r: Rect) => !parts.some((p) => overlap(r, p, MARGIN.label)) && !others.some((o) => overlap(r, o, MARGIN.label));
      if (clear(box)) continue;
      const route = routeOf(l);
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const { t, length } = fractionAt(route.points, centre);
      if (!length) continue;
      for (let d = 8; d <= length; d += 8)
        for (const at of [t - d / length, t + d / length]) {
          if (at < 0 || at > 1) continue;
          const p = pointAlong(route.points, at);
          if (clear({ x: p.x - box.width / 2, y: p.y - box.height / 2, width: box.width, height: box.height })) {
            l.at = at;
            d = Infinity;
            break;
          }
        }
    }
  };

  // How to move `b` out of the way of `m`, `gap` clear of it: across or down,
  // whichever way is away from `m`, the shorter of the two that leaves it
  // clear of every other part, if that is no more than ROOM times the
  // shorter, or else simply the shorter.
  const clearOf = (m: Rect, b: Body, gap: number, skip: (o: Body) => boolean): Point | undefined => {
    const r = boxOf(b);
    if (!overlap(m, r, gap)) return undefined;
    const right = r.x + r.width / 2 >= m.x + m.width / 2;
    const below = r.y + r.height / 2 >= m.y + m.height / 2;
    const ways = [
      { x: right ? m.x + m.width + gap - r.x : m.x - gap - (r.x + r.width), y: 0 },
      { x: 0, y: below ? m.y + m.height + gap - r.y : m.y - gap - (r.y + r.height) },
    ].sort((a, c) => Math.abs(a.x + a.y) - Math.abs(c.x + c.y));
    const free = ways.find(
      (w) =>
        Math.abs(w.x + w.y) <= ROOM * Math.abs(ways[0].x + ways[0].y) &&
        !bodies.some((o) => o !== b && !skip(o) && overlap({ ...r, x: r.x + w.x, y: r.y + w.y }, boxOf(o), gap)),
    );
    return free ?? ways[0];
  };

  // Nudges what `first` overlaps out of its way, by as little as will clear
  // it, away from it; then what each nudged part overlaps, out of its way,
  // CHAIN parts deep at most, again until nothing near overlaps or PASSES
  // passes have gone. A part only ever makes way for one less deep in the
  // chain than it, or as deep and before it. A label on a line of a moved part
  // needs room between its ends: the end deeper in the chain makes way.
  // Nothing further than REACH from `first` moves, and `first` never does.
  const nudge = (first: Body, also: Body[] = []) => {
    const depth = new Map<Body, number>([[first, 0], ...also.map((b) => [b, 1] as const)]);
    const order = new Map(bodies.map((b, i) => [b, i]));
    const local = (b: Body) => gapOf(boxOf(b), boxOf(first)) <= REACH;
    const yields = (b: Body, m: Body, d: number) =>
      b !== first && local(b) && d < CHAIN && !(depth.has(b) && (depth.get(b)! < d || (depth.get(b) === d && order.get(b)! < order.get(m)!)));
    const make = (r: Rect, m: Body, d: number, b: Body, gap: number, times = 1) => {
      if (!yields(b, m, d)) return false;
      const by = clearOf(r, b, gap, (o) => o === m);
      if (!by) return false;
      b.x += by.x * times;
      b.y += by.y * times;
      depth.set(b, Math.min(depth.get(b) ?? Infinity, d + 1));
      return true;
    };
    for (let pass = 0; pass < PASSES; pass++) {
      let changed = false;
      for (const [m, d] of [...depth]) for (const b of bodies) if (b !== m && make(boxOf(m), m, d, b, MARGIN.part)) changed = true;
      for (const l of labelled) {
        const [df, dt] = [depth.get(l.from) ?? Infinity, depth.get(l.to) ?? Infinity];
        if (df === Infinity && dt === Infinity) continue;
        const [m, other] = df <= dt ? [l.from, l.to] : [l.to, l.from];
        const was = l.at;
        l.at = undefined;
        // The label is halfway between the ends, so the end moves twice as far.
        if (make(labelBox(l), m, Math.min(df, dt), other, MARGIN.label, 2)) changed = true;
        else l.at = was;
      }
      if (!changed) break;
    }
    return [...depth.keys()];
  };

  // How many parts, and labels, overlap each other or a part.
  const overlaps = () => {
    const parts = bodies.map(boxOf);
    const labels = labelled.map(labelBox);
    let n = 0;
    for (const [i, a] of parts.entries()) for (const b of parts.slice(i + 1)) if (overlap(a, b)) n++;
    for (const [i, a] of labels.entries()) {
      for (const p of parts) if (overlap(a, p)) n++;
      for (const b of labels.slice(i + 1)) if (overlap(a, b)) n++;
    }
    return n;
  };

  // The opening's tidy: each part that overlaps another, by its margin, is
  // nudged clear of it, the two sharing the move, and each overlapped label
  // slides along its line; no part moves more than OPENING_REACH from where
  // ELK put it. It is kept only if fewer things overlap after it than before.
  const tidy = () => {
    const before = overlaps();
    if (!before) return;
    for (let pass = 0; pass < 20; pass++) {
      let moved = false;
      for (const [i, a] of bodies.entries())
        for (const b of bodies.slice(i + 1)) {
          const by = away(boxOf(a), boxOf(b), MARGIN.part);
          if (!by) continue;
          for (const [body, k] of [
            [a, -0.5],
            [b, 0.5],
          ] as const) {
            const home = elk.get(body)!;
            const x = body.x + by.x * k;
            const y = body.y + by.y * k;
            const d = Math.hypot(x - home.x, y - home.y);
            const keep = d > OPENING_REACH ? OPENING_REACH / d : 1;
            body.x = home.x + (x - home.x) * keep;
            body.y = home.y + (y - home.y) * keep;
          }
          moved = true;
        }
      if (!moved) break;
    }
    slide(labelled);
    if (overlaps() >= before) {
      for (const b of bodies) Object.assign(b, elk.get(b));
      for (const l of labelled) l.at = undefined;
    }
  };

  const start = new Map(bodies.map((b) => [b, { x: b.x, y: b.y }]));
  tidy();
  const end = new Map(bodies.map((b) => [b, { x: b.x, y: b.y }]));
  const rest = { bodies: bodies.map((b) => ({ ...b })), hulls: hulls() };
  for (const b of bodies) Object.assign(b, start.get(b));
  tick(bodies, server.hulls, 0, along());

  // The opening: each body eases from where the server put it to where it
  // rests, and each scope from the server's box to the box round it there.
  let opening = 0;
  let opened = false;
  // Where everything was as the drag began.
  let before: { bodies: Map<Body, Point>; labels: Map<Line, number | undefined> } | undefined;
  const told = () => tick(bodies, hulls(), 1, along());
  return {
    bodies,
    rest,
    open() {
      if (opened) return;
      opened = true;
      const mine = ++opening;
      const began = clock();
      const onwards = () => {
        if (mine !== opening) return;
        const t = Math.min(1, (clock() - began) / OPENING);
        const e = ease(t);
        for (const b of bodies) {
          b.x = lerp(start.get(b)!.x, end.get(b)!.x, e);
          b.y = lerp(start.get(b)!.y, end.get(b)!.y, e);
        }
        if (t < 1) {
          tick(bodies, new Map([...rest.hulls].map(([id, box]) => [id, lerpRect(server.hulls.get(id) ?? box, box, e)])), e, along());
          frame(onwards);
        } else {
          opening++;
          told();
          settled();
        }
      };
      frame(onwards);
    },
    hold(id, at) {
      const b = byId.get(id);
      if (!b) return;
      // A part dragged as the drawing opens stops it opening, where it is.
      opened = true;
      opening++;
      // Each move of the pointer starts again from where everything was as
      // the drag began, so what the part only passed by goes back, and where
      // it is dropped alone decides what made way for it.
      before ??= { bodies: new Map(bodies.map((o) => [o, { x: o.x, y: o.y }])), labels: new Map(labelled.map((l) => [l, l.at])) };
      for (const o of bodies) Object.assign(o, before.bodies.get(o));
      for (const l of labelled) l.at = before.labels.get(l);
      b.x = at.x;
      b.y = at.y;
      let moved = nudge(b);
      const touched = () => labelled.filter((l) => moved.includes(l.from) || moved.includes(l.to) || moved.some((m) => overlap(labelBox(l), boxOf(m), MARGIN.label)));
      slide(touched());
      // A label with nowhere clear on its line takes the space it needs: a
      // part near the dragged one that covers it makes way, or, if the
      // dragged part covers it, its line moves out of the way, ends and all,
      // when both are near.
      for (let round = 0; round < 2; round++) {
        const makeWay: Body[] = [];
        for (const l of touched()) {
          const r = labelBox(l);
          for (const q of bodies) {
            if (!overlap(r, boxOf(q))) continue;
            const ends = [l.from, l.to];
            const near = (o: Body) => o !== b && gapOf(boxOf(o), boxOf(b)) <= REACH;
            if (q !== b && !ends.includes(q) && near(q)) {
              const by = clearOf(r, q, MARGIN.label, () => false);
              if (by) {
                q.x += by.x;
                q.y += by.y;
                makeWay.push(q);
              }
            } else if (q === b && ends.every(near)) {
              const by = clearOf(boxOf(b), { ...l.from, ...r, x: r.x + r.width / 2, y: r.y + r.height / 2 }, MARGIN.label, () => false);
              if (by)
                for (const e of ends) {
                  e.x += by.x;
                  e.y += by.y;
                  makeWay.push(e);
                }
            }
          }
        }
        if (!makeWay.length) break;
        moved = [...new Set([...moved, ...nudge(b, makeWay)])];
        slide(touched());
      }
      told();
    },
    drop() {
      before = undefined;
    },
    stop() {
      opening++;
    },
  };
}
