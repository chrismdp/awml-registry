// How the drawing moves once the page runs (src/components/flow/physics.ts, #67, #78). It opens
// just where the server's ELK layout put it and only tidies what overlaps, no part moving more
// than 40 pixels and the drawing growing less than 10%. A dragged part follows the pointer and
// nothing else moves unless something overlaps it: what it overlaps is nudged out of its way, a
// few parts deep, and nothing far from it moves at all. A label is never pushed off its line. A
// scope is only drawn round its parts. Nothing moves once a part is dropped, and nothing overlaps.
import { describe, expect, it } from "vitest";
import type { Drawing, Point, Rect } from "@/components/flow/drawing";
import { headHeight, headWidth } from "@/components/flow/drawing";
import { lineRoute } from "@/components/flow/FlowCanvas";
import { MARGIN, OPENING_REACH, startPhysics, type Body } from "@/components/flow/physics";
import { layOut } from "@/server/drawing";
import { laidOut } from "./drawn";
import { example } from "./helpers";

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (r: Rect, s: Rect) => r.x >= s.x && r.y >= s.y && r.x + r.width <= s.x + s.width && r.y + r.height <= s.y + s.height;
// How far apart two boxes are: the larger of the gaps across and down, or 0.
const gap = (a: Rect, b: Rect) => Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
const boxOf = (b: { x: number; y: number; width: number; height: number }): Rect => ({ x: b.x - b.width / 2, y: b.y - b.height / 2, width: b.width, height: b.height });
const between = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const bound = (rs: Rect[]) => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y };
};

type State = { bodies: Body[]; hulls: Map<string, Rect>; opened: number; along: Map<string, number> };

// Each line's label where the page draws it with the boxes where they are (FlowCanvas.tsx's
// LineView): on the server's route while its ends are where the server put them, on its square
// route once they have moved, and where the physics slid it along it, if it did.
function labelsOf(d: Drawing, s: State) {
  const byId = new Map(s.bodies.map((b) => [b.id, boxOf(b)]));
  const server = new Map<string, Point>([...d.parts, ...d.scopes].map((b) => [b.id, { x: b.x, y: b.y }]));
  return d.lines.flatMap((l) => {
    if (!l.label || l.from === l.to || !byId.has(l.from) || !byId.has(l.to)) return [];
    const { label: at } = lineRoute(l, byId.get(l.from)!, byId.get(l.to)!, server.get(l.from), server.get(l.to), s.along.get(l.id));
    return [{ line: l, text: l.label.lines.join(" "), box: { x: at.x - l.label.width / 2, y: at.y - l.label.height / 2, width: l.label.width, height: l.label.height } }];
  });
}

// What overlaps in the drawing, as "a overlaps b"; none when nothing does: no two parts, no line's
// label and a part, its own ends among them, or another label. Each part is inside its scopes,
// and each scope inside the one it is in. Scopes may overlap each other: they are only drawn
// round their parts.
function overlaps(d: Drawing, s: State) {
  const found: string[] = [];
  const boxes = s.bodies.map((b) => [b, boxOf(b)] as const);
  for (const [i, [a, ra]] of boxes.entries())
    for (const [b, rb] of boxes.slice(i + 1)) if (overlap(ra, rb)) found.push(`${a.id} overlaps ${b.id}`);
  for (const [b, r] of boxes) for (const id of b.scopes) if (!inside(r, s.hulls.get(id)!)) found.push(`${b.id} is outside its scope ${id}`);
  for (const sc of d.scopes) if (sc.scope && s.hulls.has(sc.id) && !inside(s.hulls.get(sc.id)!, s.hulls.get(sc.scope)!)) found.push(`${sc.id} is outside ${sc.scope}`);
  const labels = labelsOf(d, s);
  for (const [i, l] of labels.entries()) {
    for (const [b, r] of boxes) if (overlap(r, l.box)) found.push(`"${l.text}" is under ${b.id}`);
    for (const m of labels.slice(i + 1)) if (overlap(l.box, m.box)) found.push(`"${l.text}" overlaps "${m.text}"`);
  }
  return found;
}

// The physics of a drawing: its state each time it moves, and when it has opened.
function physicsOf(d: Drawing) {
  const states: State[] = [];
  let rest: () => void = () => {};
  const sim = startPhysics(
    d,
    (bodies, hulls, opened, along) => states.push({ bodies: bodies.map((b) => ({ ...b })), hulls: new Map(hulls), opened, along: new Map(along) }),
    () => rest(),
  );
  const resting = () => new Promise<void>((r) => (rest = r));
  return { sim, states, now: () => states.at(-1)!, resting };
}

// The physics of a drawing that has opened, without waiting for it to ease there.
function opened(d: Drawing) {
  const p = physicsOf(d);
  for (const b of p.sim.bodies) Object.assign(b, p.sim.rest.bodies.find((r) => r.id === b.id));
  return p;
}

// Drags a part by (dx, dy) a step at a time, as a pointer moves it, and drops it. The boxes it
// passed through on the way.
function drag(sim: ReturnType<typeof physicsOf>["sim"], part: string, dx: number, dy: number, steps = 10) {
  const b = sim.bodies.find((o) => o.id === part)!;
  const from = { x: b.x, y: b.y };
  const path: Rect[] = [];
  for (let i = 1; i <= steps; i++) {
    const at = { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps };
    sim.hold(part, at);
    path.push(boxOf({ ...b, ...at }));
  }
  sim.drop(part);
  return path;
}

const at = (bodies: Body[], id: string) => bodies.find((b) => b.id === id)!;
// The family's dinners as AWML 0.4 wrote them, whose scopes nest three deep, converted.
const dinners = example("older/dinners-04.graph.json");
const issue = example("flow/issue-to-pull-request.graph.json");
const map = example("flow/factory-map.graph.json");
// The engine's graph says itself whether it is a map.
const drawings = [
  ["issue-to-pull-request", issue],
  ["the dinners example, its scopes nested three deep", dinners],
  ["the factory map", map],
] as const;

describe("the opening", () => {
  for (const [name, text] of drawings)
    for (const flowOnly of [false, true])
      it(`starts just where the server laid out ${name}${flowOnly ? ", Flow only" : ""}, and tidies it within ${OPENING_REACH} pixels of there, growing less than 10%, overlapping nothing`, async () => {
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
          // Nothing moves until the drawing opens.
          await new Promise((r) => setTimeout(r, 50));
          expect(states).toHaveLength(1);
          const settled = resting();
          sim.open();
          await settled;
          expect(now().opened).toBe(1);
          for (const b of now().bodies) expect(between(b, boxCentre(server.get(b.id)!)), b.id).toBeLessThanOrEqual(OPENING_REACH + 0.001);
          const before = bound([...first.bodies.map(boxOf), ...first.hulls.values()]);
          const after = bound([...now().bodies.map(boxOf), ...now().hulls.values()]);
          expect(after.width).toBeLessThan(1.1 * before.width);
          expect(after.height).toBeLessThan(1.1 * before.height);
          expect(overlaps(d, now())).toEqual([]);
        } finally {
          sim.stop();
        }
      }, 20_000);

  it("draws each scope round its parts, its heading above them, at least as wide as its heading", async () => {
    const { flow } = laidOut(await layOut(dinners));
    const { sim, now } = opened(flow);
    sim.hold("plan", { x: at(sim.bodies, "plan").x + 200, y: at(sim.bodies, "plan").y + 60 });
    sim.drop("plan");
    const { bodies, hulls } = now();
    for (const s of flow.scopes) {
      const hull = hulls.get(s.id)!;
      const held = bodies.filter((b) => b.scopes.includes(s.id)).map(boxOf);
      expect(Math.min(...held.map((r) => r.y)) - hull.y, s.id).toBeGreaterThanOrEqual(headHeight(s.who));
      expect(hull.width, s.id).toBeGreaterThanOrEqual(headWidth(s) - 0.001);
    }
  });
});

describe("a drag", () => {
  for (const [name, text] of drawings)
    it(`moves nothing else on ${name} when a part is dragged across empty space`, async () => {
      const { full } = laidOut(await layOut(text));
      const { sim, now } = opened(full);
      // The part furthest right, dragged further right, where nothing is.
      const before = sim.bodies.map((b) => ({ ...b }));
      const part = [...before].sort((a, b) => b.x + b.width / 2 - (a.x + a.width / 2))[0];
      drag(sim, part.id, 300, 100);
      for (const b of before) if (b.id !== part.id) expect({ x: at(now().bodies, b.id).x, y: at(now().bodies, b.id).y }, b.id).toEqual({ x: b.x, y: b.y });
      expect(at(now().bodies, part.id)).toMatchObject({ x: part.x + 300, y: part.y + 100 });
    });

  it("moves only the part it is dropped onto, by about the overlap, and what that part then overlaps", async () => {
    const { full } = laidOut(await layOut(dinners));
    const { sim, now } = opened(full);
    const before = sim.bodies.map((b) => ({ ...b }));
    // Filling the basket, dropped so that it overlaps Owen's yes below it by 20 pixels.
    const [basket, yes] = [at(before, "basket"), at(before, "approve")];
    const to = { x: yes.x, y: yes.y - (basket.height + yes.height) / 2 + 20 };
    sim.hold("basket", to);
    sim.drop("basket");
    const moved = before.filter((b) => b.id !== "basket" && between(b, at(now().bodies, b.id)) > 0.5).map((b) => b.id);
    expect(moved[0]).toBe("approve");
    // It moved just out of the way: the overlap and the margin, or at most twice that to go a way that is clear.
    const by = between(yes, at(now().bodies, "approve"));
    expect(by).toBeGreaterThanOrEqual(20 + MARGIN.part - 0.5);
    expect(by).toBeLessThanOrEqual(2 * (20 + MARGIN.part) + 0.5);
    // Anything else that moved was in the way of a part that did.
    for (const id of moved.slice(1)) {
      const was = boxOf(at(before, id));
      const pushers = [boxOf({ ...basket, ...to }), ...moved.filter((m) => m !== id).map((m) => boxOf(at(now().bodies, m)))];
      expect(
        pushers.some((p) => gap(p, was) < MARGIN.part + 0.5),
        id,
      ).toBe(true);
    }
    expect(overlaps(full, now())).toEqual([]);
  });

  for (const [name, text] of drawings)
    it(`on ${name}, dragging each part by (300, 100) and by (-200, 150) moves nothing far from where it is dropped, leaves nothing overlapping, and nothing moves once it is dropped`, async () => {
      const { full } = laidOut(await layOut(text));
      for (const part of full.parts.map((p) => p.id).concat(full.scopes.filter((s) => !s.holds).map((s) => s.id)))
        for (const [dx, dy] of [
          [300, 100],
          [-200, 150],
        ]) {
          const { sim, now, states } = opened(full);
          const before = sim.bodies.map((b) => ({ ...b }));
          const path = drag(sim, part, dx, dy);
          const dropped = now();
          // Nothing more than 150 pixels from the dropped part's box moved.
          for (const b of before)
            if (b.id !== part && gap(boxOf(b), path.at(-1)!) > 150 && gap(boxOf(at(dropped.bodies, b.id)), path.at(-1)!) > 150)
              expect(between(b, at(dropped.bodies, b.id)), `${part} ${dx},${dy} moved ${b.id}`).toBeLessThan(1);
          expect(overlaps(full, dropped), `${part} ${dx},${dy}`).toEqual([]);
          // It is where it was dropped, and nothing moves after.
          expect(boxOf(at(dropped.bodies, part))).toEqual(path.at(-1));
          const count = states.length;
          await new Promise((r) => setTimeout(r, 20));
          expect(states).toHaveLength(count);
          sim.stop();
        }
    }, 20_000);
});

// That a box is where another is, and as big.
function near(a: Rect, b: Rect) {
  for (const k of ["x", "y", "width", "height"] as const) expect(a[k], k).toBeCloseTo(b[k], 6);
}
const boxCentre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
