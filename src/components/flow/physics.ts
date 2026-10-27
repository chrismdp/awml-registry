import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { Drawing, Point } from "./drawing";

// A box the physics moves: a part, or a scope with no parts, by its centre.
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

const GAP = 36;
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

// A force-directed layout of the same graph (d3-force): lines are springs, the
// parts push each other apart and never overlap, each scope pulls its parts
// together and pushes others out, and a gentle pull down the page by layer
// keeps the flow reading top to bottom. Scopes are soft groupings, drawn
// around wherever their parts settle. `tick` is told each time the parts move,
// and `settled` each time they come to rest.
export async function startPhysics(g: Drawing, tick: (bodies: Body[]) => void, settled: () => void): Promise<Physics> {
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
  const sizes = new Map([...g.parts, ...g.scopes.filter((s) => !s.holds)].map((b) => [b.id, { width: b.width, height: b.height }]));
  const ids = [...sizes.keys()];
  const rank = ranks(g, ids);
  const bodies: Body[] = ids.map((id, i) => {
    const size = sizes.get(id)!;
    const r = rank.get(id) ?? 0;
    return { id, ...size, scopes: chain(id), rank: r, x: ((i % 5) - 2) * 220 + (r % 2) * 60, y: r * LAYER };
  });
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const springs: Spring[] = g.lines
    .filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to)
    .map((l) => ({ source: l.from, target: l.to, strength: l.style === "dotted" ? 0.25 : 0.7 }));

  // Boxes never overlap: each pair that would, where their speed takes them,
  // is pushed apart along the shorter way out. A box held by the pointer
  // stays put, and the other takes the whole push.
  const collide = () => {
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.x! + b.vx! - (a.x! + a.vx!);
        const dy = b.y! + b.vy! - (a.y! + a.vy!);
        const ox = (a.width + b.width) / 2 + GAP - Math.abs(dx);
        const oy = (a.height + b.height) / 2 + GAP - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const share = a.fx != null ? 0 : b.fx != null ? 1 : 0.5;
        if (ox < oy) {
          const push = (ox / KEPT) * Math.sign(dx || 1);
          a.vx! -= push * share;
          b.vx! += push * (1 - share);
        } else {
          const push = (oy / KEPT) * Math.sign(dy || 1);
          a.vy! -= push * share;
          b.vy! += push * (1 - share);
        }
      }
  };

  // Each scope draws its parts towards their middle, and pushes out any part
  // not in it that has wandered inside its box.
  const scopes = (alpha: number) => {
    for (const s of g.scopes) {
      if (!s.holds) continue;
      const inside = bodies.filter((b) => b.scopes.includes(s.id));
      if (!inside.length) continue;
      const cx = inside.reduce((t, b) => t + b.x!, 0) / inside.length;
      const cy = inside.reduce((t, b) => t + b.y!, 0) / inside.length;
      // A scope round nearly everything has nothing to gather.
      const k = 0.06 * (1 - inside.length / bodies.length) * alpha;
      for (const b of inside) {
        b.vx! += (cx - b.x!) * k;
        b.vy! += (cy - b.y!) * k;
      }
      const box = boundsOf(inside, 24);
      for (const b of bodies) {
        if (b.scopes.includes(s.id)) continue;
        const left = b.x! + b.width / 2 - box.x;
        const right = box.x + box.width - (b.x! - b.width / 2);
        const top = b.y! + b.height / 2 - box.y;
        const bottom = box.y + box.height - (b.y! - b.height / 2);
        if (left <= 0 || right <= 0 || top <= 0 || bottom <= 0) continue;
        const least = Math.min(left, right, top, bottom);
        const k = 0.3 * alpha;
        if (least === left) b.vx! -= left * k;
        else if (least === right) b.vx! += right * k;
        else if (least === top) b.vy! -= top * k;
        else b.vy! += bottom * k;
      }
    }
  };

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
    .force("apart", d3.forceManyBody<Body>().strength(-2200).distanceMax(1400))
    .force("down", d3.forceY<Body>((b) => b.rank * LAYER).strength(0.1))
    .force("middle", d3.forceX<Body>(0).strength(0.004))
    .force("scopes", scopes)
    .force("collide", () => {
      for (let i = 0; i < 3; i++) collide();
    })
    .alphaDecay(0.03)
    .stop();
  // Most of the settling happens before the first drawing, so it opens
  // nearly still; the rest is seen.
  sim.tick(300);
  tick(bodies);
  sim
    .on("tick", () => tick(bodies))
    .on("end", settled)
    .alpha(0.05)
    .restart();

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

// The box round some bodies, with room to spare on each side.
function boundsOf(bodies: Body[], pad: number) {
  const x = Math.min(...bodies.map((b) => b.x! - b.width / 2)) - pad;
  const y = Math.min(...bodies.map((b) => b.y! - b.height / 2)) - pad;
  const right = Math.max(...bodies.map((b) => b.x! + b.width / 2)) + pad;
  const bottom = Math.max(...bodies.map((b) => b.y! + b.height / 2)) + pad;
  return { x, y, width: right - x, height: bottom - y };
}
