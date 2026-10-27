import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { headHeight, headWidth, SCOPE_PAD, squareRoute, type Drawing, type DrawnScope, type Point, type Rect } from "./drawing";

// A box the physics moves: a part, or a scope with no parts, by its centre.
// `scopes` are the scopes it is in, the nearest first. A part the reader has
// dropped is `pinned` where they left it.
export type Body = SimulationNodeDatum & { id: string; width: number; height: number; scopes: string[]; rank: number; pinned?: boolean };
type Spring = SimulationLinkDatum<Body> & { strength: number };

export type Physics = {
  // Where each box's centre is now.
  bodies: Body[];
  // Where everything comes to rest once the drawing has opened: each box,
  // and the box of each scope that holds parts.
  rest: { bodies: Body[]; hulls: Map<string, Rect> };
  // Lets the drawing settle, from where the server laid it out to where it
  // rests, over OPENING milliseconds.
  open(): void;
  // Holds a box where the pointer is while it is dragged, so its neighbours follow.
  hold(id: string, at: Point): void;
  // Pins it where it was dropped, for the rest to settle round it.
  drop(id: string): void;
  // Lets a pinned box go, to settle with the rest.
  release(id: string): void;
  stop(): void;
};

// The room kept between two parts side by side, between a scope and
// anything beside it, scopes or parts, and round a line's label.
const GAP = 36;
const SCOPE_GAP = 64;
const LABEL_GAP = 8;
// The room kept either side of a line.
const LINE_GAP = 8;
// While a part is dragged, the boxes in its way give: each push moves a box
// only so much of the way out, and a line or a label moves one at most STEP
// a tick, as a line swings across a part as its ends move. So they move on
// smoothly, never at a jump or back and forth, and settle clear of each
// other once the part is dropped.
const GIVE = 0.5;
const STEP = 4;
const LAYER = 190;
// Parts are heavy: each tick a box keeps only this much of its speed (d3-force's
// 1 - velocityDecay), so it moves little and comes to rest without bouncing.
const KEPT = 0.4;
// How hot the physics runs (d3-force's alpha), which every force but the
// collisions is scaled by: as the drawing opens, while a part is dragged,
// and at least as it settles once a part is dropped or let go. And how fast
// it cools.
const HEAT = { open: 0.5, drag: 0.1, release: 0.05 };
const COOLING = 0.04;
// How long the drawing takes to open, and to settle once a part is dropped or
// let go, in milliseconds, and how it eases in and out of the move, so it
// starts just where it was, the server's SVG or the dropped part's drawing.
export const OPENING = 900;
const SETTLING = 600;
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// The layers the solid lines make, top to bottom: each part one below the
// lowest part with a solid line into it, cycles cut short. A part reached only
// by dotted lines sits beside what it is joined to.
function ranks(g: Drawing, ids: string[]) {
  const rank = new Map(ids.map((id) => [id, 0]));
  const solid = g.lines.filter((l) => l.style !== "dotted" && rank.has(l.from) && rank.has(l.to));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const l of solid) {
      const next = rank.get(l.from)! + 1;
      if (next > rank.get(l.to)! && next <= ids.length) {
        rank.set(l.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const joined = new Set(solid.flatMap((l) => [l.from, l.to]));
  for (const id of ids) {
    if (joined.has(id)) continue;
    const near = g.lines.filter((l) => l.from === id || l.to === id).map((l) => (l.from === id ? l.to : l.from));
    const known = near.filter((n) => joined.has(n)).map((n) => rank.get(n)!);
    if (known.length) rank.set(id, known.reduce((a, b) => a + b, 0) / known.length);
  }
  return rank;
}

// A line's label as the physics sees it: a box of its size, on the line
// between its ends, where the page draws it. `home` is the deepest scope both
// ends are in, or "" for the drawing.
type Label = { from: Body; to: Body; width: number; height: number; home: string };

// What the drawing, and each scope that holds parts, holds directly: its
// bodies, the scopes in it and the labels of the lines within it. The
// drawing itself is "".
type Held = { bodies: Body[]; scopes: DrawnScope[]; labels: Label[] };

const boxAt = (b: Body, at: Point): Rect => ({ x: at.x - b.width / 2, y: at.y - b.height / 2, width: b.width, height: b.height });
const now = (b: Body): Point => ({ x: b.x!, y: b.y! });

// Where a label is with its ends where `at` puts them: halfway along the
// square route between them, as the page draws it (squareRoute, labelAt).
function labelBox(l: Label, at: (b: Body) => Point): Rect {
  const p = squareRoute(boxAt(l.from, at(l.from)), boxAt(l.to, at(l.to))).label;
  return { x: p.x - l.width / 2, y: p.y - l.height / 2, width: l.width, height: l.height };
}

// The box each scope that holds parts is drawn as, with each body where `at`
// puts it: round the boxes of its parts, of the scopes in it and of the labels
// within it, SCOPE_PAD clear of them, its heading above them, and at least as
// wide as its heading, as the server's layout makes a scope. So a scope
// inside another is inside it.
function hullsOf(deepestFirst: DrawnScope[], held: Map<string, Held>, at: (b: Body) => Point) {
  const hulls = new Map<string, Rect>();
  for (const s of deepestFirst) {
    const { bodies, scopes, labels } = held.get(s.id)!;
    const boxes = [...bodies.map((b) => boxAt(b, at(b))), ...scopes.flatMap((c) => hulls.get(c.id) ?? []), ...labels.map((l) => labelBox(l, at))];
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
// the server's box round them. It is where the physics starts, so React Flow
// first draws the drawing just as the server's SVG shows it.
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
  const boxes = [...g.parts, ...g.scopes.filter((s) => !s.holds)];
  const rank = ranks(
    g,
    boxes.map((b) => b.id),
  );
  return {
    bodies: boxes.map((b) => ({
      id: b.id,
      width: b.width,
      height: b.height,
      scopes: chain(b.id),
      rank: rank.get(b.id) ?? 0,
      x: b.x + b.width / 2,
      y: b.y + b.height / 2,
    })),
    hulls: new Map(g.scopes.filter((s) => s.holds).map((s) => [s.id, { x: s.x, y: s.y, width: s.width, height: s.height }])),
  };
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

// A force-directed layout of the same graph (d3-force), starting from where the
// server laid it out: lines are springs, the parts push each other apart, each
// scope pulls its parts together, and a gentle pull down the page by layer
// keeps the flow reading top to bottom. Nothing overlaps (#67, #78): two
// parts, a part and a scope it isn't in, two scopes side by side, and each
// line's label and anything else are kept apart, a scope moving with
// everything in it. Scopes are drawn round wherever their parts and labels
// settle, nested scopes inside.
//
// It is worked out to rest at once, from the server's layout, and the drawing
// then eases there once `open` is called (#78), so it starts just where the
// server's SVG shows it and settles without a jump or a jitter. `tick` is
// told each time the boxes move, with the box of each scope that holds parts
// and how far the drawing has opened, eased, from 0 to 1; `settled` each time
// they come to rest. A part dropped stays where it was dropped.
export function startPhysics(
  g: Drawing,
  tick: (bodies: Body[], hulls: Map<string, Rect>, opened: number) => void,
  settled: () => void,
): Physics {
  const server = atServer(g);
  const { bodies } = server;
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const springs: Spring[] = g.lines
    .filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to)
    .map((l) => ({ source: l.from, target: l.to, strength: l.style === "dotted" ? 0.25 : 0.7 }));

  const holding = g.scopes.filter((s) => s.holds);
  const deepestFirst = [...holding].sort((a, b) => b.depth - a.depth);
  const held = new Map<string, Held>(["", ...holding.map((s) => s.id)].map((id) => [id, { bodies: [], scopes: [], labels: [] }]));
  for (const b of bodies) held.get(b.scopes[0] ?? "")?.bodies.push(b);
  for (const s of holding) held.get(s.scope ?? "")?.scopes.push(s);
  // Every body in each scope, however deep.
  const within = new Map(holding.map((s) => [s.id, new Set(bodies.filter((b) => b.scopes.includes(s.id)))]));
  const outermostFirst = ["", ...[...holding].sort((a, b) => a.depth - b.depth).map((s) => s.id)];

  // Each line between two bodies, and the label of each that has one.
  const joined = g.lines.flatMap((l) =>
    l.from !== l.to && byId.has(l.from) && byId.has(l.to) ? [{ from: byId.get(l.from)!, to: byId.get(l.to)!, label: l.label }] : [],
  );
  const labels: Label[] = joined.flatMap(({ from, to, label }) =>
    label ? [{ from, to, width: label.width, height: label.height, home: from.scopes.find((s) => to.scopes.includes(s)) ?? "" }] : [],
  );
  for (const l of labels) held.get(l.home)?.labels.push(l);

  // Where a body will be once this tick's speed has moved it.
  const next = (b: Body): Point => (b.fx != null ? { x: b.fx, y: b.fy! } : { x: b.x! + b.vx! * KEPT, y: b.y! + b.vy! * KEPT });

  // Moves a body by so much now, unless something holds it. The move is made
  // to where it is, not to its speed, so it undoes an overlap without leaving
  // the body moving on past it.
  let dragging = false;
  const move = (b: Body, dx: number, dy: number) => {
    if (b.fx != null) return;
    const k = dragging ? GIVE : 1;
    b.x! += dx * k;
    b.y! += dy * k;
  };
  // A label moves by moving the ends of its line: both alike, or, with one
  // held, the other twice as far, the label being halfway between them.
  const moveLabel = (l: Label, dx: number, dy: number) => {
    const free = [l.from, l.to].filter((b) => b.fx == null);
    for (const b of free) move(b, (dx * 2) / free.length, (dy * 2) / free.length);
  };
  const labelHeld = (l: Label) => l.from.fx != null && l.to.fx != null;

  // How far two boxes, `gap` apart at least, must move apart, along the
  // shorter way out, or undefined when they are far enough apart.
  const push = (a: Rect, b: Rect, gap: number) => {
    const dx = b.x + b.width / 2 - (a.x + a.width / 2);
    const dy = b.y + b.height / 2 - (a.y + a.height / 2);
    const ox = (a.width + b.width) / 2 + gap - Math.abs(dx);
    const oy = (a.height + b.height) / 2 + gap - Math.abs(dy);
    if (ox <= 0 || oy <= 0) return undefined;
    return ox < oy ? { x: ox * Math.sign(dx || 1), y: 0 } : { x: 0, y: oy * Math.sign(dy || 1) };
  };
  // A push no further than STEP while a part is dragged.
  const step = (by: Point | undefined) =>
    by && (dragging ? { x: Math.max(-STEP, Math.min(STEP, by.x)), y: Math.max(-STEP, Math.min(STEP, by.y)) } : by);

  // Each line runs square between its ends, its label halfway along
  // (squareRoute). So every part but its ends is moved off the line and out
  // from under its label, to the side it is already on, and no two labels
  // overlap, each moving its line.
  const clear = (box: Rect, from: Body, to: Body, gap: number) => {
    for (const b of bodies) {
      if (b === from || b === to || b.fx != null) continue;
      const by = step(push(box, boxAt(b, next(b)), gap));
      if (by) move(b, by.x, by.y);
    }
  };
  const clearLines = () => {
    for (const { from, to, label } of joined) {
      const route = squareRoute(boxAt(from, next(from)), boxAt(to, next(to)));
      for (const [i, q] of route.points.slice(1).entries()) {
        const p = route.points[i];
        const x = Math.min(p.x, q.x);
        const y = Math.min(p.y, q.y);
        clear({ x, y, width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y) }, from, to, LINE_GAP);
      }
      if (!label) continue;
      const at = route.label;
      clear({ x: at.x - label.width / 2, y: at.y - label.height / 2, width: label.width, height: label.height }, from, to, LABEL_GAP);
    }
    for (const [i, a] of labels.entries())
      for (const b of labels.slice(i + 1)) {
        if (a.from === b.from ? a.to === b.to : a.from === b.to && a.to === b.from) continue;
        const by = step(push(labelBox(a, next), labelBox(b, next), LABEL_GAP));
        if (!by) continue;
        const share = labelHeld(a) ? 0 : labelHeld(b) ? 1 : 0.5;
        moveLabel(a, -by.x * share, -by.y * share);
        moveLabel(b, by.x * (1 - share), by.y * (1 - share));
      }
  };

  // Nothing overlaps: within the drawing and within each scope, each pair of
  // what it holds directly, parts, the scopes in it and the labels within it,
  // that would overlap where their speed takes them is pushed apart along the
  // shorter way out. A scope moves as one, everything in it alike, so what is
  // inside it stays as it was. The lighter of the two takes more of the push;
  // whatever holds a box the reader holds or has pinned stays put, and the
  // other takes all of it.
  type Piece = { box: Rect; bodies: Body[]; kind: "part" | "scope" | "label"; held: boolean; label?: Label };
  const shift = (p: Piece, dx: number, dy: number) => {
    if (p.label) moveLabel(p.label, dx, dy);
    else for (const b of p.bodies) move(b, dx, dy);
    p.box = { ...p.box, x: p.box.x + dx, y: p.box.y + dy };
  };
  // A label takes space (#78): anything else is pushed off it, as it would be
  // off a part, and it moves only when that is held. Its own line's ends, or a
  // scope one is in, its line runs into, so it can't move off them: the room
  // between them is too short for it, so the far end is moved off, twice as
  // far as the label must go, or else what holds the near one.
  const offLabel = (l: Piece, other: Piece) => {
    const label = l.label!;
    const by = step(push(l.box, other.box, LABEL_GAP));
    if (!by) return;
    const near = other.bodies.includes(label.from) ? label.from : other.bodies.includes(label.to) ? label.to : undefined;
    const far = near === label.from ? label.to : label.from;
    if (near && far.fx == null) {
      move(far, -2 * by.x, -2 * by.y);
      l.box = { ...l.box, x: l.box.x - by.x, y: l.box.y - by.y };
    } else if (near && !other.held) {
      shift(other, 2 * by.x, 2 * by.y);
      l.box = { ...l.box, x: l.box.x + by.x, y: l.box.y + by.y };
    } else if (!near && !other.held) shift(other, by.x, by.y);
    else if (!near && !l.held) shift(l, -by.x, -by.y);
  };
  const collide = (lines: boolean) => {
    if (lines) clearLines();
    for (const id of outermostFirst) {
      const h = held.get(id)!;
      // Where the scopes in it are now, after the pushes on what holds them.
      const hulls = h.scopes.length ? hullsOf(deepestFirst, held, next) : undefined;
      const pieces: Piece[] = [
        ...h.bodies.map((b): Piece => ({ box: boxAt(b, next(b)), bodies: [b], kind: "part", held: b.fx != null })),
        ...h.scopes.flatMap((s): Piece[] => {
          const box = hulls?.get(s.id);
          const inside = [...within.get(s.id)!];
          return box ? [{ box, bodies: inside, kind: "scope", held: inside.some((b) => b.fx != null) }] : [];
        }),
        ...h.labels.map((l): Piece => ({ box: labelBox(l, next), bodies: [l.from, l.to], kind: "label", held: labelHeld(l), label: l })),
      ];
      for (let i = 0; i < pieces.length; i++)
        for (let j = i + 1; j < pieces.length; j++) {
          const a = pieces[i];
          const b = pieces[j];
          // Two labels are kept apart in clearLines, wherever they are.
          if (a.label && b.label) continue;
          if (a.label || b.label) {
            offLabel(a.label ? a : b, a.label ? b : a);
            continue;
          }
          const by = push(a.box, b.box, a.kind === "scope" || b.kind === "scope" ? SCOPE_GAP : GAP);
          if (!by) continue;
          const share = a.held ? 0 : b.held ? 1 : b.bodies.length / (a.bodies.length + b.bodies.length);
          shift(a, -by.x * share, -by.y * share);
          shift(b, by.x * (1 - share), by.y * (1 - share));
        }
    }
  };

  // Each scope draws its parts towards their middle. A scope round nearly
  // everything has nothing to gather.
  const gather = (alpha: number) => {
    for (const s of holding) {
      const inside = [...within.get(s.id)!];
      if (!inside.length) continue;
      const cx = inside.reduce((t, b) => t + b.x!, 0) / inside.length;
      const cy = inside.reduce((t, b) => t + b.y!, 0) / inside.length;
      const k = 0.12 * (1 - inside.length / bodies.length) * alpha;
      for (const b of inside) {
        b.vx! += (cx - b.x!) * k;
        b.vy! += (cy - b.y!) * k;
      }
    }
  };

  const middle = g.box.x + g.box.width / 2;
  const top = Math.min(...bodies.map((b) => b.y!));
  const sim = forceSimulation(bodies)
    .force(
      "springs",
      forceLink<Body, Spring>(springs)
        .id((b) => b.id)
        .distance((s) => {
          const a = s.source as Body;
          const b = s.target as Body;
          return 90 + (a.height + b.height) / 2;
        })
        .strength((s) => s.strength),
    )
    .force("apart", forceManyBody<Body>().strength(-500).distanceMax(450))
    .force("down", forceY<Body>((b) => top + b.rank * LAYER).strength(0.1))
    .force("middle", forceX<Body>(middle).strength(0.004))
    .force("scopes", gather)
    .force("collide", () => {
      for (let i = 0; i < 4; i++) collide(i === 0);
    })
    .velocityDecay(1 - KEPT)
    .alphaDecay(COOLING)
    .stop();

  // Where everything comes to rest from where it is now, worked out at once,
  // at so much heat; each body is left where it is, still.
  const restFrom = (heat: number) => {
    const from = new Map(bodies.map((b) => [b, now(b)]));
    sim.stop().alphaTarget(0).alpha(heat);
    sim.tick(Math.ceil(Math.log(sim.alphaMin() / heat) / Math.log(1 - COOLING)));
    const to = new Map(bodies.map((b) => [b, now(b)]));
    for (const b of bodies) Object.assign(b, from.get(b), { vx: 0, vy: 0 });
    sim.alpha(0);
    return { from, to };
  };
  const at = (m: Map<Body, Point>) => (b: Body) => m.get(b)!;

  // Eases each body from `from` to `to`, and each scope's box from
  // `fromHulls` to the box round its parts there, over `ms`, then tells it
  // has settled. The opening tells how far it has gone; anything later, done.
  let gliding = 0;
  const glide = (from: Map<Body, Point>, to: Map<Body, Point>, fromHulls: Map<string, Rect>, ms: number, opening: boolean) => {
    const toHulls = hullsOf(deepestFirst, held, at(to));
    const mine = ++gliding;
    const began = clock();
    const onwards = () => {
      if (mine !== gliding) return;
      const t = Math.min(1, (clock() - began) / ms);
      const e = ease(t);
      for (const b of bodies) {
        b.x = lerp(from.get(b)!.x, to.get(b)!.x, e);
        b.y = lerp(from.get(b)!.y, to.get(b)!.y, e);
      }
      if (t < 1) {
        tick(bodies, new Map([...toHulls].map(([id, box]) => [id, lerpRect(fromHulls.get(id) ?? box, box, e)])), opening ? e : 1);
        frame(onwards);
      } else {
        gliding++;
        told();
        settled();
      }
    };
    frame(onwards);
  };
  // Settles from where everything is now, the part dropped or let go pinned
  // or not: worked out at once and eased there, so it moves without a jitter.
  const settle = (heat: number) => {
    const fromHulls = hullsOf(deepestFirst, held, now);
    const { from, to } = restFrom(heat);
    glide(from, to, fromHulls, SETTLING, false);
  };

  // Where it all comes to rest from the server's layout, worked out before
  // anything is drawn, which the drawing eases to once it opens. It starts
  // where the server had it.
  const opening = restFrom(HEAT.open);
  const rest = { bodies: bodies.map((b) => ({ ...b, ...opening.to.get(b) })), hulls: hullsOf(deepestFirst, held, at(opening.to)) };
  let opened = false;

  const told = () => tick(bodies, hullsOf(deepestFirst, held, now), 1);
  sim.on("tick", told);
  tick(bodies, server.hulls, 0);

  return {
    bodies,
    rest,
    open() {
      if (opened) return;
      opened = true;
      glide(opening.from, opening.to, server.hulls, OPENING, true);
    },
    hold(id, at) {
      const b = byId.get(id);
      if (!b) return;
      // A part dragged as the drawing settles stops it settling, where it is.
      opened = true;
      gliding++;
      dragging = true;
      b.fx = at.x;
      b.fy = at.y;
      sim.alphaTarget(HEAT.drag).restart();
    },
    drop(id) {
      const b = byId.get(id);
      if (!b) return;
      b.pinned = true;
      dragging = false;
      settle(Math.max(sim.alpha(), HEAT.release));
    },
    release(id) {
      const b = byId.get(id);
      if (!b) return;
      b.fx = null;
      b.fy = null;
      b.pinned = false;
      gliding++;
      settle(HEAT.release);
    },
    stop() {
      gliding++;
      sim.stop();
    },
  };
}
