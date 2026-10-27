// The maths of the frame a drawing is shown in (src/components/viewport.ts):
// fitting a drawing, starting React Flow just where the server's SVG shows
// it, and placing a part's menu.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fit, INSET, MAX_ZOOM, placeMenu, viewOf } from "@/components/viewport";

const frame = { width: 800, height: 600 };
const room = { width: frame.width - INSET.left - INSET.right, height: frame.height - INSET.top - INSET.bottom };

describe("the drawing's viewport", () => {
  it("fits a wide drawing by its width, centred in the room the controls leave", () => {
    const v = fit(frame, { x: 0, y: 0, width: 4000, height: 1000 });
    expect(v.zoom).toBeCloseTo(room.width / 4000);
    expect(v.x).toBeCloseTo(INSET.left);
    expect(v.y).toBeCloseTo(INSET.top + (room.height - 1000 * v.zoom) / 2);
  });

  it("fits a tall drawing by its height", () => {
    const v = fit(frame, { x: 0, y: 0, width: 300, height: 3000 });
    expect(v.zoom).toBeCloseTo(room.height / 3000);
    expect(v.y).toBeCloseTo(INSET.top);
  });

  it("scales a small drawing up no further than MAX_ZOOM, centred", () => {
    const v = fit(frame, { x: 0, y: 0, width: 200, height: 100 });
    expect(v.zoom).toBe(MAX_ZOOM);
    expect(v.x).toBeCloseTo(INSET.left + (room.width - 200 * MAX_ZOOM) / 2);
  });

  it("allows for a drawing whose box doesn't start at the origin", () => {
    const at0 = fit(frame, { x: 0, y: 0, width: 4000, height: 1000 });
    const moved = fit(frame, { x: 100, y: 50, width: 4000, height: 1000 });
    expect(moved.x).toBeCloseTo(at0.x - 100 * at0.zoom);
    expect(moved.y).toBeCloseTo(at0.y - 50 * at0.zoom);
  });

  it("starts where an SVG of the drawing shows it, fitted inside the SVG's box and centred", () => {
    const drawing = { x: 0, y: 0, width: 1000, height: 500 };
    // An SVG box twice as tall as the drawing's shape: fitted by width, centred down it.
    const v = viewOf({ x: 20, y: 72, width: 500, height: 500 }, drawing);
    expect(v).toEqual({ zoom: 0.5, x: 20, y: 72 + (500 - 250) / 2 });
  });

  it("gives the server's SVG the same room as the fit, so the two fit a drawing alike", () => {
    const css = fs.readFileSync(path.join(__dirname, "../src/components/flow/flow.css"), "utf8");
    const { top, right, bottom, left } = INSET;
    expect(css).toContain(`.flow-frame .flow-static { position: absolute; inset: ${top}px ${right}px ${bottom}px ${left}px;`);
    expect(css).toContain(`width: calc(100% - ${left + right}px); height: calc(100% - ${top + bottom}px); margin: auto;`);
  });

  it("puts a part's menu under it, or above it when there's no room below, inside the frame", () => {
    const menu = { width: 220, height: 120 };
    // Under the part, at its left edge.
    expect(placeMenu({ x: 100, y: 100, width: 150, height: 50 }, menu, frame)).toEqual({ x: 100, y: 156 });
    // No room below: above it.
    expect(placeMenu({ x: 100, y: 450, width: 150, height: 50 }, menu, frame)).toEqual({ x: 100, y: 324 });
    // Near the right edge: in from it.
    expect(placeMenu({ x: 700, y: 100, width: 150, height: 50 }, menu, frame)).toEqual({ x: 572, y: 156 });
    // Partly off the left: in from it.
    expect(placeMenu({ x: -60, y: 100, width: 150, height: 50 }, menu, frame)).toEqual({ x: 8, y: 156 });
    // A tall menu with room neither below nor above: as low as fits.
    expect(placeMenu({ x: 100, y: 250, width: 150, height: 50 }, { width: 220, height: 400 }, frame)).toEqual({ x: 100, y: 192 });
    // Taller than the frame: at its top.
    expect(placeMenu({ x: 100, y: 250, width: 150, height: 50 }, { width: 220, height: 900 }, frame)).toEqual({ x: 100, y: 8 });
  });
});
