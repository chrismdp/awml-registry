import { describe, expect, it } from "vitest";
import {
  actualSize,
  clampZoom,
  fit,
  keepInView,
  MAX_ZOOM,
  MIN_ZOOM,
  move,
  naturalSize,
  pan,
  pinch,
  zoomAt,
  type View,
} from "@/components/viewport";

const frame = { width: 800, height: 600 };

// Where a point of the drawing is in the frame.
const onScreen = (v: View, p: { x: number; y: number }) => ({ x: v.x + p.x * v.k, y: v.y + p.y * v.k });
// Which point of the drawing is under a point of the frame.
const under = (v: View, p: { x: number; y: number }) => ({ x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k });

describe("the drawing's viewport", () => {
  it("fits a large drawing whole and centred", () => {
    const v = fit(frame, { width: 4000, height: 1000 });
    expect(v.k).toBeCloseTo(0.2);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo((600 - 200) / 2);
  });

  it("fits a tall drawing by its height", () => {
    const v = fit(frame, { width: 300, height: 3000 });
    expect(v.k).toBeCloseTo(0.2);
    expect(v.x).toBeCloseTo((800 - 60) / 2);
    expect(v.y).toBeCloseTo(0);
  });

  it("leaves a small drawing at 100%, centred", () => {
    expect(fit(frame, { width: 200, height: 100 })).toEqual({ x: 300, y: 250, k: 1 });
  });

  it("never fits below 10%", () => {
    expect(fit(frame, { width: 80000, height: 100 }).k).toBe(MIN_ZOOM);
  });

  it("zooms around a point, which stays where it is", () => {
    const v = { x: 30, y: -40, k: 0.5 };
    const p = { x: 123, y: 456 };
    const drawn = under(v, p);
    const zoomed = zoomAt(v, 1.25, p);
    expect(zoomed.k).toBeCloseTo(0.625);
    const after = onScreen(zoomed, drawn);
    expect(after.x).toBeCloseTo(p.x);
    expect(after.y).toBeCloseTo(p.y);
    const out = zoomAt(zoomed, 1 / 1.25, p);
    expect(out.x).toBeCloseTo(v.x);
    expect(out.y).toBeCloseTo(v.y);
    expect(out.k).toBeCloseTo(v.k);
  });

  it("keeps the zoom between 10% and 400%", () => {
    expect(MIN_ZOOM).toBe(0.1);
    expect(MAX_ZOOM).toBe(4);
    expect(clampZoom(0.01)).toBe(0.1);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(1.5)).toBe(1.5);
    const top = zoomAt({ x: 0, y: 0, k: 3.9 }, 1.25, { x: 100, y: 100 });
    expect(top.k).toBe(4);
    expect(onScreen(top, under({ x: 0, y: 0, k: 3.9 }, { x: 100, y: 100 })).x).toBeCloseTo(100);
    expect(zoomAt({ x: 0, y: 0, k: 0.11 }, 1 / 1.25, { x: 0, y: 0 }).k).toBe(0.1);
    expect(zoomAt({ x: 0, y: 0, k: 4 }, 1.25, { x: 50, y: 50 })).toEqual({ x: 0, y: 0, k: 4 });
  });

  it("shows the drawing at 100% keeping the frame's centre where it is", () => {
    const v = { x: 100, y: 50, k: 0.25 };
    const centre = under(v, { x: 400, y: 300 });
    const actual = actualSize(v, frame);
    expect(actual.k).toBe(1);
    expect(onScreen(actual, centre).x).toBeCloseTo(400);
    expect(onScreen(actual, centre).y).toBeCloseTo(300);
  });

  it("pans, and moves a fifth of the frame for each arrow", () => {
    const v = { x: 10, y: 20, k: 2 };
    expect(pan(v, 5, -7)).toEqual({ x: 15, y: 13, k: 2 });
    // Moving up shows what is above, so the drawing goes down.
    expect(move(v, frame, "up")).toEqual({ x: 10, y: 140, k: 2 });
    expect(move(v, frame, "down")).toEqual({ x: 10, y: -100, k: 2 });
    expect(move(v, frame, "left")).toEqual({ x: 170, y: 20, k: 2 });
    expect(move(v, frame, "right")).toEqual({ x: -150, y: 20, k: 2 });
  });

  it("keeps part of the drawing in at least a quarter of the frame", () => {
    const drawing = { width: 1000, height: 1000 };
    // Shown at 1000×1000: a quarter of the frame is 200 wide and 150 tall.
    expect(keepInView({ x: 5000, y: 5000, k: 1 }, frame, drawing)).toEqual({ x: 600, y: 450, k: 1 });
    expect(keepInView({ x: -5000, y: -5000, k: 1 }, frame, drawing)).toEqual({ x: -800, y: -850, k: 1 });
    expect(keepInView({ x: -100, y: 30, k: 1 }, frame, drawing)).toEqual({ x: -100, y: 30, k: 1 });
    // A drawing smaller than a quarter of the frame stays whole inside it.
    expect(keepInView({ x: 5000, y: -5000, k: 0.1 }, frame, drawing)).toEqual({ x: 700, y: 0, k: 0.1 });
  });

  it("pinches from one pair of pointers to the next, around their midpoint", () => {
    const v = { x: 0, y: 0, k: 1 };
    const before: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ];
    // The fingers spread to twice as far apart and the pair moves 30 right, 10 down.
    const after: typeof before = [
      { x: 80, y: 110 },
      { x: 280, y: 110 },
    ];
    const pinched = pinch(v, before, after);
    expect(pinched.k).toBeCloseTo(2);
    const mid = onScreen(pinched, under(v, { x: 150, y: 100 }));
    expect(mid.x).toBeCloseTo(180);
    expect(mid.y).toBeCloseTo(110);
    // Two fingers moving together only move the drawing.
    expect(
      pinch(v, before, [
        { x: 110, y: 90 },
        { x: 210, y: 90 },
      ]),
    ).toEqual({ x: 10, y: -10, k: 1 });
    // Fingers on one spot don't divide by nothing.
    expect(pinch(v, [before[0], before[0]], [before[0], before[0]])).toEqual(v);
  });

  it("reads a drawing's natural size from its viewBox", () => {
    expect(naturalSize("0 0 1234.5 678")).toEqual({ width: 1234.5, height: 678 });
    expect(naturalSize("-8 -8 100,50")).toEqual({ width: 100, height: 50 });
    expect(naturalSize(null)).toBeUndefined();
    expect(naturalSize("nonsense")).toBeUndefined();
  });
});
