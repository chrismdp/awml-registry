// Physics (src/components/flow/physics.ts, #67): the same drawing laid out by d3-force, starting
// from where the server put it. Nothing overlaps: no two parts, no part and a scope it isn't in,
// and no two scopes side by side; a scope inside another stays inside it; and so it stays while a
// part is dragged.
import { describe, expect, it } from "vitest";
import type { Drawing, Rect } from "@/components/flow/drawing";
import { headHeight, headWidth, labelAt, squareRoute } from "@/components/flow/drawing";
import { startPhysics, type Body } from "@/components/flow/physics";
import { layOut } from "@/server/drawing";
import { laidOut } from "./drawn";
import { example } from "./helpers";

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (r: Rect, s: Rect) => r.x >= s.x && r.y >= s.y && r.x + r.width <= s.x + s.width && r.y + r.height <= s.y + s.height;
// How far apart two boxes are: the larger of the gaps across and down.
const apart = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
const boxOf = (b: Body): Rect => ({ x: b.x! - b.width / 2, y: b.y! - b.height / 2, width: b.width, height: b.height });

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
  // No line's label, on its square route where the page puts it, is under a part.
  const byId = new Map(boxes.map(([b, r]) => [b.id, r]));
  for (const l of d.lines) {
    if (!l.label || l.from === l.to || !byId.has(l.from) || !byId.has(l.to)) continue;
    const at = labelAt(squareRoute(byId.get(l.from)!, byId.get(l.to)!).points, l.label, [...byId.values()]);
    const label = { x: at.x - l.label.width / 2, y: at.y - l.label.height / 2, width: l.label.width, height: l.label.height };
    for (const [b, r] of boxes) if (b.id !== l.from && b.id !== l.to && overlap(r, label)) found.push(`${l.label.lines.join(" ")} is under ${b.id}`);
  }
  return found;
}

// The physics of a drawing, its state each time it moves, and when it comes to rest.
async function physicsOf(d: Drawing) {
  let last: { bodies: Body[]; hulls: Map<string, Rect> } | undefined;
  let rest: () => void = () => {};
  const resting = () => new Promise<void>((r) => (rest = r));
  const sim = await startPhysics(
    d,
    (bodies, hulls) => (last = { bodies, hulls }),
    () => rest(),
  );
  return { sim, now: () => last!, resting };
}

const dinners = example("dinners.mmd");
const issue = example("flow/issue-to-pull-request.mmd");

describe("Physics", () => {
  for (const [name, text] of [
    ["the dinners example, its scopes nested three deep", dinners],
    ["issue-to-pull-request", issue],
  ] as const)
    for (const flowOnly of [false, true])
      it(`overlaps nothing on ${name}${flowOnly ? ", Flow only" : ""}, as it opens and once it settles`, async () => {
        const both = laidOut(await layOut(text));
        const d = flowOnly ? both.flow : both.full;
        const { sim, now, resting } = await physicsOf(d);
        try {
          const first = now();
          expect(first.hulls.size).toBe(d.scopes.filter((s) => s.holds).length);
          expect(overlaps(d, first.bodies, first.hulls)).toEqual([]);
          await resting();
          expect(overlaps(d, now().bodies, now().hulls)).toEqual([]);
        } finally {
          sim.stop();
        }
      }, 20_000);

  it("draws each scope round its parts, its heading above them, at least as wide as its heading", async () => {
    const { flow } = laidOut(await layOut(dinners));
    const { sim, now } = await physicsOf(flow);
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
  });

  it("overlaps nothing while a part is dragged across another scope, the scopes moving out of its way", async () => {
    const { full } = laidOut(await layOut(dinners));
    const { sim, now } = await physicsOf(full);
    try {
      // The plan, in family, dragged up to where the household scope is.
      const household = now().hulls.get("household")!;
      sim.hold("plan", { x: household.x + household.width / 2, y: household.y + household.height / 2 });
      await new Promise((r) => setTimeout(r, 800));
      const { bodies, hulls } = now();
      const plan = bodies.find((b) => b.id === "plan")!;
      expect(plan.x).toBeCloseTo(household.x + household.width / 2);
      expect(overlaps(full, bodies, hulls)).toEqual([]);
      sim.release("plan");
    } finally {
      sim.stop();
    }
  }, 20_000);
});
