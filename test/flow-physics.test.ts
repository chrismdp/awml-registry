// Physics (src/components/flow/physics.ts, #67, #78), the only way a drawing is laid out once the
// page runs: the same drawing laid out by d3-force, starting just where the server put it and
// easing from there to rest. Nothing overlaps: no two parts, no part and a scope it isn't in, no
// two scopes side by side, and no line's label and a part or another label; a scope inside another
// stays inside it; and so it stays while a part is dragged. A drag disturbs only what is near the
// part dragged, and a part dropped stays where it was dropped, stretched out if it was, the rest
// settling round it.
import { describe, expect, it } from "vitest";
import type { Drawing, Point, Rect } from "@/components/flow/drawing";
import { headHeight, headWidth } from "@/components/flow/drawing";
import { lineRoute } from "@/components/flow/FlowCanvas";
import { startPhysics, type Body } from "@/components/flow/physics";
import { layOut } from "@/server/drawing";
import { laidOut } from "./drawn";
import { example } from "./helpers";

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (r: Rect, s: Rect) => r.x >= s.x && r.y >= s.y && r.x + r.width <= s.x + s.width && r.y + r.height <= s.y + s.height;
// How far apart two boxes are: the larger of the gaps across and down.
const apart = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
const boxOf = (b: Body): Rect => ({ x: b.x! - b.width / 2, y: b.y! - b.height / 2, width: b.width, height: b.height });

// Each line's label where the page draws it with the boxes where they are (FlowCanvas.tsx's
// LineView): on the server's route while its ends are where the server put them, and on its
// square route once they have moved.
function labelsOf(d: Drawing, bodies: Body[]) {
  const byId = new Map(bodies.map((b) => [b.id, boxOf(b)]));
  const server = new Map<string, Point>([...d.parts, ...d.scopes].map((b) => [b.id, { x: b.x, y: b.y }]));
  return d.lines.flatMap((l) => {
    if (!l.label || l.from === l.to || !byId.has(l.from) || !byId.has(l.to)) return [];
    const { label: at } = lineRoute(l, byId.get(l.from)!, byId.get(l.to)!, server.get(l.from), server.get(l.to), [...byId.values()]);
    return [{ line: l, text: l.label.lines.join(" "), box: { x: at.x - l.label.width / 2, y: at.y - l.label.height / 2, width: l.label.width, height: l.label.height } }];
  });
}

// What overlaps in the physics' drawing, as "a overlaps b"; none when nothing does.
function overlaps(d: Drawing, bodies: Body[], hulls: Map<string, Rect>) {
  const found: string[] = [];
  const boxes = bodies.map((b) => [b, boxOf(b)] as const);
  for (const [i, [a, ra]] of boxes.entries())
    for (const [b, rb] of boxes.slice(i + 1)) if (overlap(ra, rb)) found.push(`${a.id} overlaps ${b.id}`);
  for (const [b, r] of boxes)
    for (const [id, hull] of hulls) {
      if (b.scopes.includes(id) && !inside(r, hull)) found.push(`${b.id} is outside its scope ${id}`);
      if (!b.scopes.includes(id) && overlap(r, hull)) found.push(`${b.id} overlaps ${id}`);
    }
  const scopes = d.scopes.filter((s) => hulls.has(s.id));
  for (const [i, a] of scopes.entries())
    for (const b of scopes.slice(i + 1)) {
      if (a.scope === b.scope && overlap(hulls.get(a.id)!, hulls.get(b.id)!)) found.push(`${a.id} overlaps ${b.id}`);
      if (a.scope === b.scope && apart(hulls.get(a.id)!, hulls.get(b.id)!) < 40) found.push(`${a.id} is close to ${b.id}`);
    }
  for (const s of scopes) if (s.scope && !inside(hulls.get(s.id)!, hulls.get(s.scope)!)) found.push(`${s.id} is outside ${s.scope}`);
  // No line's label, where the page draws it, is under a part, its own ends among them, or another label.
  const labels = labelsOf(d, bodies);
  for (const [i, l] of labels.entries()) {
    for (const [b, r] of boxes) if (overlap(r, l.box)) found.push(`"${l.text}" is under ${b.id}`);
    for (const m of labels.slice(i + 1)) if (overlap(l.box, m.box)) found.push(`"${l.text}" overlaps "${m.text}"`);
  }
  return found;
}

// The physics of a drawing: its state each time it moves, and when it comes to rest.
function physicsOf(d: Drawing) {
  const states: { bodies: Body[]; hulls: Map<string, Rect>; opened: number }[] = [];
  let rest: () => void = () => {};
  const sim = startPhysics(
    d,
    (bodies, hulls, opened) => states.push({ bodies: bodies.map((b) => ({ ...b })), hulls: new Map(hulls), opened }),
    () => rest(),
  );
  const resting = () => new Promise<void>((r) => (rest = r));
  return { sim, states, now: () => states.at(-1)!, resting };
}

// Whether each body moved one way only, across and down, over some states: no jitter.
function steady(states: { bodies: Body[] }[]) {
  const back: string[] = [];
  for (const [k, b] of states[0].bodies.entries())
    for (const c of ["x", "y"] as const) {
      const moves = states.slice(1).map((s, i) => s.bodies[k][c]! - states[i].bodies[k][c]!);
      if (moves.some((m) => m > 0.01) && moves.some((m) => m < -0.01)) back.push(`${b.id}.${c}`);
    }
  return back;
}

const dinners = example("dinners.mmd");
const issue = example("flow/issue-to-pull-request.mmd");
const examples = [
  ["the dinners example, its scopes nested three deep", dinners],
  ["issue-to-pull-request", issue],
] as const;

describe("Physics", () => {
  for (const [name, text] of examples)
    for (const flowOnly of [false, true])
      it(`opens just where the server laid out ${name}${flowOnly ? ", Flow only" : ""}, eases from there without a jitter, and overlaps nothing once it settles, not even a label`, async () => {
        const both = laidOut(await layOut(text));
        const d = flowOnly ? both.flow : both.full;
        const { sim, states, now, resting } = physicsOf(d);
        try {
          // First, every part and scope just where the server's SVG shows it.
          const [first] = states;
          expect(first.opened).toBe(0);
          const server = new Map([...d.parts, ...d.scopes.filter((s) => !s.holds)].map((r) => [r.id, r]));
          expect(first.bodies.map((b) => b.id).sort()).toEqual([...server.keys()].sort());
          for (const b of first.bodies) near(boxOf(b), server.get(b.id)!);
          expect([...first.hulls.keys()]).toEqual(d.scopes.filter((s) => s.holds).map((s) => s.id));
          for (const s of d.scopes.filter((s) => s.holds)) near(first.hulls.get(s.id)!, s);
          expect(overlaps(d, first.bodies, first.hulls)).toEqual([]);
          // Nothing moves until the drawing opens.
          await new Promise((r) => setTimeout(r, 50));
          expect(states).toHaveLength(1);
          const settled = resting();
          sim.open();
          await settled;
          expect(now().opened).toBe(1);
          expect(now().hulls.size).toBe(d.scopes.filter((s) => s.holds).length);
          // Eased: each part moved one way only, and how far it has opened only grew.
          expect(steady(states)).toEqual([]);
          expect(states.map((s) => s.opened)).toEqual([...states.map((s) => s.opened)].sort((a, b) => a - b));
          expect(overlaps(d, now().bodies, now().hulls)).toEqual([]);
        } finally {
          sim.stop();
        }
      }, 20_000);

  it("draws each scope round its parts, its heading above them, at least as wide as its heading", async () => {
    const { flow } = laidOut(await layOut(dinners));
    const { sim, now, resting } = physicsOf(flow);
    const settled = resting();
    sim.open();
    await settled;
    sim.stop();
    const { bodies, hulls } = now();
    for (const s of flow.scopes) {
      const hull = hulls.get(s.id)!;
      const held = bodies.filter((b) => b.scopes.includes(s.id)).map(boxOf);
      expect(Math.min(...held.map((r) => r.y)) - hull.y, s.id).toBeGreaterThanOrEqual(headHeight(s.who));
      expect(hull.width, s.id).toBeGreaterThanOrEqual(headWidth(s) - 0.001);
    }
    // Flow only gathers each scope's parts, so it is no bigger round them than the server's.
    for (const s of flow.scopes) expect(hulls.get(s.id)!.width * hulls.get(s.id)!.height, s.id).toBeLessThan(1.6 * s.width * s.height);
  }, 20_000);

  it("overlaps nothing while a part is dragged across another scope, the scopes moving out of its way", async () => {
    const { full } = laidOut(await layOut(dinners));
    const { sim, now, resting } = physicsOf(full);
    try {
      let settled = resting();
      sim.open();
      await settled;
      // The plan, in family, dragged up to where the household scope is.
      const household = now().hulls.get("household")!;
      const to = { x: household.x + household.width / 2, y: household.y + household.height / 2 };
      sim.hold("plan", to);
      await new Promise((r) => setTimeout(r, 800));
      const plan = now().bodies.find((b) => b.id === "plan")!;
      expect(plan.x).toBeCloseTo(to.x);
      expect(overlaps(full, now().bodies, now().hulls).filter((o) => !o.startsWith('"'))).toEqual([]);
      settled = resting();
      sim.drop("plan");
      await settled;
      expect(overlaps(full, now().bodies, now().hulls)).toEqual([]);
    } finally {
      sim.stop();
    }
  }, 20_000);

  // Drags a part from where it rests by (dx, dy), a step at a time as a pointer moves it, and
  // drops it: each body before the drag, when it is dropped, and once the rest have settled.
  async function dragged(text: string, part: string, dx: number, dy: number) {
    const { full } = laidOut(await layOut(text));
    const p = physicsOf(full);
    let settled = p.resting();
    p.sim.open();
    await settled;
    const before = p.now().bodies;
    const start = before.find((b) => b.id === part)!;
    const to = { x: start.x! + dx, y: start.y! + dy };
    for (let i = 1; i <= 10; i++) {
      p.sim.hold(part, { x: start.x! + (dx * i) / 10, y: start.y! + (dy * i) / 10 });
      await new Promise((r) => setTimeout(r, 30));
    }
    const atDrop = p.now().bodies;
    const dropped = p.states.length;
    settled = p.resting();
    p.sim.drop(part);
    await settled;
    return { ...p, full, before, atDrop, dropped, to };
  }
  const at = (bodies: Body[], id: string) => bodies.find((b) => b.id === id)!;
  const between = (a: Body, b: Body) => Math.hypot(b.x! - a.x!, b.y! - a.y!);

  for (const [name, text, part] of [
    ["the dinners example", dinners, "plan"],
    ["issue-to-pull-request", issue, "gate"],
  ] as const)
    it(`keeps a part dropped on ${name} where it was dropped, the rest settling round it without a jitter`, async () => {
      const { sim, states, now, full, dropped, to } = await dragged(text, part, 260, 140);
      try {
        expect(at(now().bodies, part)).toMatchObject({ x: to.x, y: to.y });
        expect(overlaps(full, now().bodies, now().hulls)).toEqual([]);
        // The rest moved round it one way only, and it never moved.
        expect(steady(states.slice(dropped))).toEqual([]);
        for (const s of states.slice(dropped)) expect({ x: at(s.bodies, part).x, y: at(s.bodies, part).y }).toEqual(to);
        // And it stays there: nothing moves once it has settled.
        const settledAt = states.length;
        await new Promise((r) => setTimeout(r, 300));
        expect(states).toHaveLength(settledAt);
      } finally {
        sim.stop();
      }
    }, 20_000);

  for (const [name, text, part, dx, dy] of [
    ["the dinners example", dinners, "plan", 600, 200],
    ["issue-to-pull-request", issue, "gate", -700, 0],
  ] as const)
    it(`keeps a part stretched out from its neighbours on ${name} stretched out once it is dropped`, async () => {
      const { sim, now, full, atDrop } = await dragged(text, part, dx, dy);
      try {
        const neighbours = full.lines.filter((l) => l.from !== l.to && (l.from === part || l.to === part)).map((l) => (l.from === part ? l.to : l.from));
        expect(neighbours.length).toBeGreaterThan(0);
        for (const n of neighbours)
          expect(between(at(now().bodies, part), at(now().bodies, n)), n).toBeGreaterThanOrEqual(0.9 * between(at(atDrop, part), at(atDrop, n)));
      } finally {
        sim.stop();
      }
    }, 20_000);

  it("barely moves a part more than 300 pixels from the one dragged, while it is dragged and once it is dropped", async () => {
    const { sim, now, before, atDrop, to } = await dragged(issue, "gate", 300, 100);
    try {
      const gate = at(before, "gate");
      // How far a body is from the part dragged, where it was and where it went.
      const gap = (b: Body) => {
        const r = boxOf(b);
        return Math.min(
          ...[gate, { ...gate, ...to }].map((g) => {
            const f = boxOf(g);
            return Math.max(r.x - (f.x + f.width), f.x - (r.x + r.width), r.y - (f.y + f.height), f.y - (r.y + r.height));
          }),
        );
      };
      const far = before.filter((b) => b.id !== "gate" && gap(b) > 300);
      expect(far.length).toBeGreaterThan(10);
      for (const bodies of [atDrop, now().bodies])
        for (const b of far) expect(between(b, at(bodies, b.id)), b.id).toBeLessThan(3);
    } finally {
      sim.stop();
    }
  }, 20_000);
});

// That a box is where another is, and as big.
function near(a: Rect, b: Rect) {
  for (const k of ["x", "y", "width", "height"] as const) expect(a[k], k).toBeCloseTo(b[k], 6);
}
