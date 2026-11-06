// How a line runs once a part is dragged (src/components/flow/drawing.ts's lineRoutes, #116), as
// the server's ELK layout runs its lines: each end where the server attached it while that side
// still faces the other end, the ends on one side spread along it in the order of where their
// other ends lie, and lines in the same gap 14 pixels apart, as ELK's edge spacing has them.
import { describe, expect, it } from "vitest";
import { lineRoutes, type DrawnLine, type Point, type Rect } from "@/components/flow/drawing";

const line = (id: string, from: string, to: string, points: Point[] = []): DrawnLine => ({ id, from, to, style: "solid", arrowStart: false, arrowEnd: true, points });
const by = (r: Rect, dx: number, dy: number): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });
const boxes = (o: Record<string, Rect>) => new Map(Object.entries(o));

// Each stretch of a route, from one corner to the next.
const stretches = (points: Point[]) => points.slice(1).map((q, i) => [points[i], q] as const);
const level = ([a, b]: readonly [Point, Point]) => a.y === b.y;
// Whether two level or plumb stretches share more than a point: run along each other.
function alongside(a: readonly [Point, Point], b: readonly [Point, Point]) {
  const lo = (u: number, v: number) => Math.min(u, v);
  const hi = (u: number, v: number) => Math.max(u, v);
  if (level(a) && level(b) && a[0].y === b[0].y) return Math.min(hi(a[0].x, a[1].x), hi(b[0].x, b[1].x)) > Math.max(lo(a[0].x, a[1].x), lo(b[0].x, b[1].x));
  if (!level(a) && !level(b) && a[0].x === b[0].x) return Math.min(hi(a[0].y, a[1].y), hi(b[0].y, b[1].y)) > Math.max(lo(a[0].y, a[1].y), lo(b[0].y, b[1].y));
  return false;
}
// Whether a level stretch and a plumb one cross, other than where both end.
function crossing(a: readonly [Point, Point], b: readonly [Point, Point]) {
  const [h, v] = level(a) ? [a, b] : [b, a];
  if (level(v) || !level(h)) return false;
  const x = v[0].x;
  const y = h[0].y;
  const inside = (w: number, p: number, q: number) => w > Math.min(p, q) && w < Math.max(p, q);
  return inside(x, h[0].x, h[1].x) && inside(y, v[0].y, v[1].y);
}
const square = (points: Point[]) => stretches(points).every(([a, b]) => a.x === b.x || a.y === b.y);
const onSide = (p: Point, r: Rect, side: "top" | "bottom") => p.y === (side === "top" ? r.y : r.y + r.height) && p.x >= r.x && p.x <= r.x + r.width;

describe("a line whose ends have moved apart (#116)", () => {
  const a = { x: 0, y: 0, width: 200, height: 60 };
  const b = { x: 0, y: 200, width: 200, height: 60 };

  it("keeps the server's route exactly while its ends haven't moved, or have moved together", () => {
    const l = line("l", "a", "b", [
      { x: 60, y: 60 },
      { x: 60, y: 130 },
      { x: 90, y: 130 },
      { x: 90, y: 200 },
    ]);
    const label = { ...l, label: { x: 75, y: 130, width: 40, height: 22, lines: ["x"] } };
    const served = boxes({ a, b });
    expect(lineRoutes([label], served, served).get("l")).toEqual({ points: label.points, label: { x: 75, y: 130 }, server: true });
    const together = lineRoutes([label], boxes({ a: by(a, 40, 30), b: by(b, 40, 30) }), served).get("l")!;
    expect(together.server).toBe(true);
    expect(together.points[0]).toEqual({ x: 100, y: 90 });
    expect(together.label).toEqual({ x: 115, y: 160 });
  });

  it("gives two lines between the same pair of facing sides points of their own, and runs them apart", () => {
    // Laid out side by side, then one is dragged below the other: no side the server used faces now.
    const served = boxes({ a, b: { x: 400, y: 0, width: 200, height: 60 } });
    const fromRight = (y: number) => [
      { x: 200, y },
      { x: 400, y },
    ];
    const lines = [line("one", "a", "b", fromRight(20)), line("two", "a", "b", fromRight(40))];
    const now = boxes({ a, b: by(b, 150, 0) });
    const routes = lineRoutes(lines, now, served);
    const [one, two] = ["one", "two"].map((id) => routes.get(id)!);
    for (const r of [one, two]) {
      expect(r.server).toBe(false);
      expect(square(r.points), JSON.stringify(r.points)).toBe(true);
      expect(onSide(r.points[0], now.get("a")!, "bottom")).toBe(true);
      expect(onSide(r.points.at(-1)!, now.get("b")!, "top")).toBe(true);
    }
    expect(one.points[0]).not.toEqual(two.points[0]);
    expect(one.points.at(-1)).not.toEqual(two.points.at(-1));
    for (const s of stretches(one.points)) for (const t of stretches(two.points)) expect(alongside(s, t), JSON.stringify([s, t])).toBe(false);
    for (const s of stretches(one.points)) for (const t of stretches(two.points)) expect(crossing(s, t), JSON.stringify([s, t])).toBe(false);
    // Their middle stretches run side by side, the server's edge spacing apart.
    expect(Math.abs(one.points[1].y - two.points[1].y)).toBe(14);
  });

  it("keeps the server's ports on a dragged box while its sides still face the other end", () => {
    const l = line("l", "a", "b", [
      { x: 50, y: 60 },
      { x: 50, y: 130 },
      { x: 30, y: 130 },
      { x: 30, y: 200 },
    ]);
    const served = boxes({ a, b });
    // The lower part dragged right and down, and then the upper part dragged left and up.
    for (const now of [boxes({ a, b: by(b, 80, 40) }), boxes({ a: by(a, -30, -20), b })]) {
      const r = lineRoutes([l], now, served).get("l")!;
      const [s, t] = [now.get("a")!, now.get("b")!];
      expect(r.server).toBe(false);
      expect(r.points[0]).toEqual({ x: s.x + 50, y: s.y + s.height });
      expect(r.points.at(-1)).toEqual({ x: t.x + 30, y: t.y });
      expect(square(r.points)).toBe(true);
    }
  });

  it("spreads three lines out of one side along it in the order of where their other ends lie, so they don't cross", () => {
    const top = { x: 200, y: 0, width: 240, height: 60 };
    const below = (x: number) => ({ x, y: 200, width: 140, height: 60 });
    // Laid out in a row, so every line left a side that no longer faces once they are dragged below.
    const served = boxes({ top, left: { x: -300, y: 0, width: 140, height: 60 }, middle: { x: 500, y: 0, width: 140, height: 60 }, right: { x: 700, y: 0, width: 140, height: 60 } });
    const side = (x: number) => [
      { x: x < 200 ? 200 : 440, y: 30 },
      { x: x < 200 ? x + 140 : x, y: 30 },
    ];
    // Given in another order than they lie, which mustn't decide theirs.
    const lines = [line("m", "top", "middle", side(500)), line("r", "top", "right", side(700)), line("l", "top", "left", side(-300))];
    const now = boxes({ top, left: below(0), middle: below(250), right: below(520) });
    const routes = lineRoutes(lines, now, served);
    const starts = ["l", "m", "r"].map((id) => routes.get(id)!.points[0]);
    for (const p of starts) expect(onSide(p, top, "bottom")).toBe(true);
    expect(starts[0].x).toBeLessThan(starts[1].x);
    expect(starts[1].x).toBeLessThan(starts[2].x);
    // Evenly spaced along the side.
    expect(starts[1].x - starts[0].x).toBeCloseTo(starts[2].x - starts[1].x, 6);
    const all = ["l", "m", "r"].map((id) => routes.get(id)!.points);
    for (const [i, p] of all.entries())
      for (const q of all.slice(i + 1))
        for (const s of stretches(p)) for (const t of stretches(q)) expect(crossing(s, t) || alongside(s, t), JSON.stringify([s, t])).toBe(false);
  });

  it("runs each line's middle stretch between its own ends, when a line shares a gap with two that share none", () => {
    // `a` goes down into `x`, `c` out of the bottom of `x`, and `b` beside them both, its gap
    // overlapping each of theirs: `a` and `c` mustn't be put in one gap with it and run through `x`.
    const now = boxes({
      p: { x: 0, y: 0, width: 100, height: 60 },
      x: { x: 300, y: 200, width: 100, height: 60 },
      y: { x: 0, y: 400, width: 100, height: 60 },
      q: { x: 150, y: 40, width: 100, height: 60 },
      r: { x: 500, y: 300, width: 100, height: 60 },
    });
    const routes = lineRoutes([line("a", "p", "x"), line("b", "q", "r"), line("c", "x", "y")], now, new Map());
    for (const id of ["a", "b", "c"]) {
      const { points } = routes.get(id)!;
      expect(points).toHaveLength(4);
      const [lo, hi] = [Math.min(points[0].y, points[3].y), Math.max(points[0].y, points[3].y)];
      expect(points[1].y, `${id}: ${JSON.stringify(points)}`).toBeGreaterThan(lo);
      expect(points[1].y, `${id}: ${JSON.stringify(points)}`).toBeLessThan(hi);
    }
  });

  it("runs a re-routed line's middle stretch apart from that of a line that kept the server's route in the same gap", () => {
    // `k` is unmoved, its middle stretch halfway down the gap; `m`'s lower end is dragged right, so
    // its middle stretch, halfway down the same gap, would lie on `k`'s.
    const [a, c, b, d] = [
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 150, y: 0, width: 100, height: 60 },
      { x: 0, y: 200, width: 100, height: 60 },
      { x: 300, y: 200, width: 100, height: 60 },
    ];
    const k = line("k", "c", "d", [
      { x: 200, y: 60 },
      { x: 200, y: 130 },
      { x: 350, y: 130 },
      { x: 350, y: 200 },
    ]);
    const m = line("m", "a", "b", [
      { x: 50, y: 60 },
      { x: 50, y: 200 },
    ]);
    const routes = lineRoutes([k, m], boxes({ a, c, b: by(b, 180, 0), d }), boxes({ a, c, b, d }));
    const [kept, moved] = [routes.get("k")!, routes.get("m")!];
    expect(kept.points).toEqual(k.points);
    expect(moved.server).toBe(false);
    expect(moved.points).toHaveLength(4);
    for (const s of stretches(kept.points)) for (const t of stretches(moved.points)) expect(alongside(s, t), JSON.stringify([s, t])).toBe(false);
    expect(Math.abs(moved.points[1].y - 130)).toBeGreaterThanOrEqual(14);
    expect(moved.points[1].y).toBeGreaterThan(60);
    expect(moved.points[1].y).toBeLessThan(200);
  });

  it("runs a line alone on its side straight from where its other end was spread along a busy side", () => {
    // Two lines out of the bottom of `s`, spread along it; the one into `t` is alone on `t`'s top.
    const s = { x: 0, y: 0, width: 300, height: 60 };
    const t = { x: 0, y: 200, width: 160, height: 60 };
    const u = { x: 220, y: 200, width: 100, height: 60 };
    const routes = lineRoutes([line("st", "s", "t"), line("su", "s", "u")], boxes({ s, t, u }), new Map());
    const st = routes.get("st")!.points;
    expect(st, JSON.stringify(st)).toHaveLength(2);
    expect(st[0]).toEqual({ x: 100, y: 60 });
    expect(st[1]).toEqual({ x: 100, y: 200 });
  });

  it("joins boxes with too little room above and below for a line to turn, but room beside, side to side (#78)", () => {
    const routes = (t: Rect) => lineRoutes([line("l", "a", "t")], boxes({ a: { x: 0, y: 0, width: 100, height: 50 }, t }), new Map()).get("l")!.points;
    const close = routes({ x: 140, y: 54, width: 100, height: 50 });
    expect([close[0].x, close.at(-1)!.x]).toEqual([100, 140]);
    const roomy = routes({ x: 140, y: 80, width: 100, height: 50 });
    expect([roomy[0].y, roomy.at(-1)!.y]).toEqual([50, 80]);
  });
});

describe("a line whose part is moved a little (#126)", () => {
  const a = { x: 0, y: 0, width: 200, height: 60 };
  const b = { x: 0, y: 200, width: 200, height: 60 };
  const served = boxes({ a, b });
  // Out of the bottom of `a`, a jog halfway down, and into the top of `b`.
  const server = [
    { x: 60, y: 60 },
    { x: 60, y: 130 },
    { x: 150, y: 130 },
    { x: 150, y: 200 },
  ];
  const l = line("l", "a", "b", server);

  it("keeps every bend but the first when its part moves sideways, the first moving with it", () => {
    const r = lineRoutes([l], boxes({ a: by(a, 10, 0), b }), served).get("l")!;
    expect(r.points).toEqual([{ x: 70, y: 60 }, { x: 70, y: 130 }, server[2], server[3]]);
    expect(r.server).toBe(true);
  });

  it("shortens the first stretch when its part moves down, and keeps every bend", () => {
    const r = lineRoutes([l], boxes({ a: by(a, 0, 10), b }), served).get("l")!;
    expect(r.points).toEqual([{ x: 60, y: 70 }, server[1], server[2], server[3]]);
  });

  it("moves the bend at each end with its own part when both have moved apart", () => {
    const r = lineRoutes([l], boxes({ a: by(a, 10, 0), b: by(b, -10, 5) }), served).get("l")!;
    expect(r.points).toEqual([
      { x: 70, y: 60 },
      { x: 70, y: 130 },
      { x: 140, y: 130 },
      { x: 140, y: 205 },
    ]);
  });

  it("keeps its label where the server put it, unless the stretch it is on moves, and then moves it with that", () => {
    const label = { x: 105, y: 130, width: 40, height: 22, lines: ["x"] };
    const moved = boxes({ a: by(a, 10, 0), b });
    expect(lineRoutes([{ ...l, label }], moved, served).get("l")!.label).toEqual({ x: 105, y: 130 });
    expect(lineRoutes([{ ...l, label: { ...label, x: 60, y: 95 } }], moved, served).get("l")!.label).toEqual({ x: 70, y: 95 });
  });

  it("is routed again, as before, once its first stretch would reverse", () => {
    const r = lineRoutes([l], boxes({ a: by(a, 0, 80), b }), served).get("l")!;
    expect(r.server).toBe(false);
    expect(r.points).toEqual([
      { x: 60, y: 140 },
      { x: 60, y: 170 },
      { x: 150, y: 170 },
      { x: 150, y: 200 },
    ]);
  });

  it("is routed again once a stretch would be shorter than a corner", () => {
    expect(lineRoutes([l], boxes({ a: by(a, 0, 62), b }), served).get("l")!.server).toBe(false);
  });

  it("is routed again once a stretch would cross another part", () => {
    const c = { x: 20, y: 90, width: 30, height: 20 };
    expect(lineRoutes([l], boxes({ a: by(a, -10, 0), b, c }), boxes({ a, b, c })).get("l")!.server).toBe(true);
    expect(lineRoutes([l], boxes({ a: by(a, -20, 0), b, c }), boxes({ a, b, c })).get("l")!.server).toBe(false);
  });

  it("stays routed again once it has been, until its part is back where the server put it", () => {
    const again = new Set<string>();
    const at = (dx: number, dy: number) => lineRoutes([l], boxes({ a: by(a, dx, dy), b }), served, again).get("l")!;
    expect(at(10, 0).server).toBe(true);
    expect(at(0, 80).server).toBe(false);
    expect(at(10, 0).server).toBe(false);
    expect(at(0, 0)).toEqual({ points: server, label: { x: 105, y: 130 }, server: true });
    expect(at(10, 0).server).toBe(true);
  });

  it("runs a re-routed line apart from one that keeps the server's bends in the same gap", () => {
    const [p, c, q, d] = [
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 150, y: 0, width: 100, height: 60 },
      { x: 0, y: 200, width: 100, height: 60 },
      { x: 300, y: 200, width: 100, height: 60 },
    ];
    const k = line("k", "c", "d", [
      { x: 200, y: 60 },
      { x: 200, y: 130 },
      { x: 350, y: 130 },
      { x: 350, y: 200 },
    ]);
    const m = line("m", "p", "q", [
      { x: 50, y: 60 },
      { x: 50, y: 200 },
    ]);
    const routes = lineRoutes([k, m], boxes({ p, c: by(c, 10, 0), q: by(q, 180, 0), d }), boxes({ p, c, q, d }));
    const [kept, moved] = [routes.get("k")!, routes.get("m")!];
    expect(kept.points).toEqual([{ x: 210, y: 60 }, { x: 210, y: 130 }, k.points[2], k.points[3]]);
    expect(moved.server).toBe(false);
    expect(Math.abs(moved.points[1].y - 130)).toBeGreaterThanOrEqual(14);
  });
});
