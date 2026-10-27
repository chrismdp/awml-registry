import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { headHeight, headWidth, SCOPE_PAD, squareRoute, type Drawing, type DrawnScope, type Point, type Rect } from "./drawing";

// A box the physics moves: a part, or a scope with no parts, by its centre.
// `scopes` are the scopes it is in, the nearest first.
export type Body = SimulationNodeDatum & { id: string; width: number; height: number; scopes: string[]; rank: number };
type Spring = SimulationLinkDatum<Body> & { strength: number };

export type Physics = {
  // Where each box's centre is now.
  bodies: Body[];
  // Holds a box where the pointer is while it is dragged, so its neighbours follow.
  hold(id: string, at: Point): void;
  // Lets it go, to settle with the rest.
  release(id: string): void;
  stop(): void;
};

// The room kept between two parts side by side, and between a scope and
// anything beside it, scopes or parts.
const GAP = 36;
const SCOPE_GAP = 64;
// The room kept round a line's label, and either side of a line.
const LABEL_GAP = 8;
const LINE_GAP = 8;
const LAYER = 190;
// How much of its speed a box keeps each tick (d3-force's 1 - velocityDecay),
// which is taken off after the forces, so a push to undo an overlap allows for it.
const KEPT = 0.6;

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

// What the drawing, and each scope that holds parts, holds directly: its
// bodies and the scopes in it. The drawing itself is "".
type Held = { bodies: Body[]; scopes: DrawnScope[] };

// The box each scope that holds parts is drawn as, with each body where `at`
// puts it: round the boxes of its parts and of the scopes in it, SCOPE_PAD
// clear of them, its heading above them, and at least as wide as its heading,
// as the server's layout makes a scope. So a scope inside another is inside it.
function hullsOf(deepestFirst: DrawnScope[], held: Map<string, Held>, at: (b: Body) => Point) {
  const hulls = new Map<string, Rect>();
  for (const s of deepestFirst) {
    const { bodies, scopes } = held.get(s.id)!;
    const boxes = [...bodies.map((b) => boxAt(b, at(b))), ...scopes.flatMap((c) => hulls.get(c.id) ?? [])];
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

const boxAt = (b: Body, at: Point): Rect => ({ x: at.x - b.width / 2, y: at.y - b.height / 2, width: b.width, height: b.height });
const now = (b: Body): Point => ({ x: b.x!, y: b.y! });

// A force-directed layout of the same graph (d3-force), starting from where the
// server laid it out: lines are springs, the parts push each other apart, each
// scope pulls its parts together, and a gentle pull down the page by layer
// keeps the flow reading top to bottom. Nothing overlaps (#67): two parts, a
// part and a scope it isn't in, and two scopes side by side are each kept
// apart, a scope moving with everything in it. Scopes are drawn round wherever
// their parts settle, nested scopes inside. `tick` is told each time the parts
// move, with the box of each scope that holds parts, and `settled` each time
// they come to rest.
export async function startPhysics(
  g: Drawing,
  tick: (bodies: Body[], hulls: Map<string, Rect>) => void,
  settled: () => void,
): Promise<Physics> {
  const d3 = await import("d3-force");
  const parentOf = new Map<string, string | undefined>([
    ...g.parts.map((p) => [p.id, p.scope] as const),
    ...g.scopes.map((s) => [s.id, s.scope] as const),
  ]);
  const chain = (id: string) => {
    const out: string[] = [];
    for (let s = parentOf.get(id); s; s = parentOf.get(s)) out.push(s);
    return out;
  };
  // Each body starts where the server put it, the drawing centred across the page.
  const boxes = [...g.parts, ...g.scopes.filter((s) => !s.holds)];
  const ids = boxes.map((b) => b.id);
  const rank = ranks(g, ids);
  const middle = g.box.x + g.box.width / 2;
  const bodies: Body[] = boxes.map((b) => ({
    id: b.id,
    width: b.width,
    height: b.height,
    scopes: chain(b.id),
    rank: rank.get(b.id) ?? 0,
    x: b.x + b.width / 2 - middle,
    y: b.y + b.height / 2,
  }));
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const springs: Spring[] = g.lines
    .filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to)
    .map((l) => ({ source: l.from, target: l.to, strength: l.style === "dotted" ? 0.25 : 0.7 }));

  const holding = g.scopes.filter((s) => s.holds);
  const deepestFirst = [...holding].sort((a, b) => b.depth - a.depth);
  const held = new Map<string, Held>(["", ...holding.map((s) => s.id)].map((id) => [id, { bodies: [], scopes: [] }]));
  for (const b of bodies) held.get(b.scopes[0] ?? "")?.bodies.push(b);
  for (const s of holding) held.get(s.scope ?? "")?.scopes.push(s);
  // Every body in each scope, however deep.
  const within = new Map(holding.map((s) => [s.id, bodies.filter((b) => b.scopes.includes(s.id))]));
  const outermostFirst = ["", ...[...holding].sort((a, b) => a.depth - b.depth).map((s) => s.id)];

  // Where a body will be once this tick's speed has moved it.
  const next = (b: Body): Point => (b.fx != null ? { x: b.fx, y: b.fy! } : { x: b.x! + b.vx! * KEPT, y: b.y! + b.vy! * KEPT });

  // Nothing overlaps: within the drawing and within each scope, each pair of
  // what it holds directly, parts and the scopes in it, that would overlap
  // where their speed takes them is pushed apart along the shorter way out. A
  // scope moves as one, everything in it alike, so what is inside it stays
  // as it was. The lighter of the two takes more of the push; whatever holds
  // the box the pointer has stays put, and the other takes all of it.
  type Piece = { box: Rect; bodies: Body[]; scope: boolean; held: boolean };
  const shift = (p: Piece, dx: number, dy: number) => {
    for (const b of p.bodies)
      if (b.fx == null) {
        b.vx! += dx / KEPT;
        b.vy! += dy / KEPT;
      }
    p.box = { ...p.box, x: p.box.x + dx, y: p.box.y + dy };
  };
  // Each line runs square between its ends, its label halfway along
  // (squareRoute). So the ends of a labelled line are kept far enough apart
  // for its label to sit between them, and every other part is moved off the
  // line and out from under its label, to the side it is already on.
  const joined = g.lines.flatMap((l) =>
    l.from !== l.to && byId.has(l.from) && byId.has(l.to) ? [{ from: byId.get(l.from)!, to: byId.get(l.to)!, label: l.label }] : [],
  );
  const nudge = (b: Body, dx: number, dy: number) => {
    if (b.fx != null) return;
    b.vx! += dx / KEPT;
    b.vy! += dy / KEPT;
  };
  const clear = (box: Rect, from: Body, to: Body) => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const b of bodies) {
      if (b === from || b === to) continue;
      const r = boxAt(b, next(b));
      const ox = Math.min(r.x + r.width, box.x + box.width) - Math.max(r.x, box.x);
      const oy = Math.min(r.y + r.height, box.y + box.height) - Math.max(r.y, box.y);
      if (ox <= 0 || oy <= 0) continue;
      if (ox < oy) nudge(b, ox * Math.sign(r.x + r.width / 2 - cx || 1), 0);
      else nudge(b, 0, oy * Math.sign(r.y + r.height / 2 - cy || 1));
    }
  };
  const clearLines = () => {
    for (const { from, to, label } of joined) {
      const s = boxAt(from, next(from));
      const t = boxAt(to, next(to));
      const route = squareRoute(s, t);
      for (const [i, q] of route.points.slice(1).entries()) {
        const p = route.points[i];
        const x = Math.min(p.x, q.x) - LINE_GAP;
        const y = Math.min(p.y, q.y) - LINE_GAP;
        clear({ x, y, width: Math.abs(q.x - p.x) + 2 * LINE_GAP, height: Math.abs(q.y - p.y) + 2 * LINE_GAP }, from, to);
      }
      if (!label) continue;
      const plumb = t.y >= s.y + s.height || t.y + t.height <= s.y;
      // Room between the ends, along the way the line runs between them.
      const [lo, hi] = plumb ? (s.y < t.y ? [s, t] : [t, s]) : s.x < t.x ? [s, t] : [t, s];
      const room = plumb ? hi.y - (lo.y + lo.height) : hi.x - (lo.x + lo.width);
      const short = (plumb ? label.height : label.width) + 2 * LABEL_GAP - room;
      if (short > 0) {
        const [first, second] = lo === s ? [from, to] : [to, from];
        const share = first.fx != null ? 0 : second.fx != null ? 1 : 0.5;
        nudge(first, plumb ? 0 : -short * share, plumb ? -short * share : 0);
        nudge(second, plumb ? 0 : short * (1 - share), plumb ? short * (1 - share) : 0);
      }
      const at = route.label;
      clear({ x: at.x - label.width / 2 - LABEL_GAP, y: at.y - label.height / 2 - LABEL_GAP, width: label.width + 2 * LABEL_GAP, height: label.height + 2 * LABEL_GAP }, from, to);
    }
  };

  const collide = (lines: boolean) => {
    if (lines) clearLines();
    for (const id of outermostFirst) {
      const h = held.get(id)!;
      // Where the scopes in it are now, after the pushes on what holds them.
      const hulls = h.scopes.length ? hullsOf(deepestFirst, held, next) : undefined;
      const pieces: Piece[] = [
        ...h.bodies.map((b) => ({ box: boxAt(b, next(b)), bodies: [b], scope: false, held: b.fx != null })),
        ...h.scopes.flatMap((s) => {
          const box = hulls?.get(s.id);
          const inside = within.get(s.id)!;
          return box ? [{ box, bodies: inside, scope: true, held: inside.some((b) => b.fx != null) }] : [];
        }),
      ];
      for (let i = 0; i < pieces.length; i++)
        for (let j = i + 1; j < pieces.length; j++) {
          const a = pieces[i];
          const b = pieces[j];
          const gap = a.scope || b.scope ? SCOPE_GAP : GAP;
          const dx = b.box.x + b.box.width / 2 - (a.box.x + a.box.width / 2);
          const dy = b.box.y + b.box.height / 2 - (a.box.y + a.box.height / 2);
          const ox = (a.box.width + b.box.width) / 2 + gap - Math.abs(dx);
          const oy = (a.box.height + b.box.height) / 2 + gap - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          const share = a.held ? 0 : b.held ? 1 : b.bodies.length / (a.bodies.length + b.bodies.length);
          if (ox < oy) {
            const push = ox * Math.sign(dx || 1);
            shift(a, -push * share, 0);
            shift(b, push * (1 - share), 0);
          } else {
            const push = oy * Math.sign(dy || 1);
            shift(a, 0, -push * share);
            shift(b, 0, push * (1 - share));
          }
        }
    }
  };

  // Each scope draws its parts towards their middle. A scope round nearly
  // everything has nothing to gather.
  const gather = (alpha: number) => {
    for (const s of holding) {
      const inside = within.get(s.id)!;
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

  const told = () => tick(bodies, hullsOf(deepestFirst, held, now));
  const sim: Simulation<Body, Spring> = d3
    .forceSimulation(bodies)
    .force(
      "springs",
      d3
        .forceLink<Body, Spring>(springs)
        .id((b) => b.id)
        .distance((s) => {
          const a = s.source as Body;
          const b = s.target as Body;
          return 90 + (a.height + b.height) / 2;
        })
        .strength((s) => s.strength),
    )
    .force("apart", d3.forceManyBody<Body>().strength(-500).distanceMax(450))
    .force("down", d3.forceY<Body>((b) => b.rank * LAYER).strength(0.1))
    .force("middle", d3.forceX<Body>(0).strength(0.004))
    .force("scopes", gather)
    .force("collide", () => {
      for (let i = 0; i < 4; i++) collide(i === 0);
    })
    .alphaDecay(0.03)
    .stop();
  // Most of the settling happens before the first drawing, so it opens
  // nearly still; the rest is seen.
  sim.tick(300);
  told();
  sim.on("tick", told).on("end", settled).alpha(0.05).restart();

  return {
    bodies,
    hold(id, at) {
      const b = byId.get(id);
      if (!b) return;
      b.fx = at.x;
      b.fy = at.y;
      sim.alphaTarget(0.25).restart();
    },
    release(id) {
      const b = byId.get(id);
      if (!b) return;
      b.fx = null;
      b.fy = null;
      sim.alphaTarget(0);
    },
    stop() {
      sim.stop();
    },
  };
}
