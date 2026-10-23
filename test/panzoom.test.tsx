// The frame on a workflow page that a reader zooms and moves the drawing in,
// like a map. Its maths is in test/viewport.test.ts.
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FRAME_LABEL, onControl, PanZoomControls } from "@/components/PanZoom";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import GalleryPage from "@/app/gallery/page";
import { example, person, request } from "./helpers";
import { renderPage } from "./pages";

const dinners = example("dinners.yaml");
const nowhere = dinners.slice(0, dinners.indexOf("implementations:"));

const LABELS = [
  "Move up",
  "Move left",
  "Move right",
  "Move down",
  "Zoom in",
  "Zoom out",
  "Fit the whole drawing",
  "Actual size",
];

// Each button's aria-label and title, in the order they appear.
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => ({
    label: /aria-label="([^"]*)"/.exec(tag)?.[1],
    title: /title="([^"]*)"/.exec(tag)?.[1],
  }));

const frame = `role="group" aria-label="${FRAME_LABEL}"`;

async function pushed(slug: string, workflow: string) {
  const ana = await person("ana");
  const res = await request("POST", `/api/v1/${ana.username}/${slug}/versions`, { as: { token: ana.token }, json: { workflow } });
  expect(res.status).toBe(201);
  return ana.username;
}

describe("zooming and moving a workflow's drawing", () => {
  it("has an arrow pad and four zoom buttons, each with its label as aria-label and title", () => {
    const html = renderToStaticMarkup(<PanZoomControls onMove={() => {}} onZoom={() => {}} onFit={() => {}} onActual={() => {}} />);
    expect(buttons(html)).toEqual(LABELS.map((label) => ({ label, title: label })));
    expect(html).toContain('type="button"');
    expect(html).toContain(">+<");
    expect(html).toContain(">−<");
    expect(html).toContain(">Fit<");
    expect(html).toContain(">100%<");
  });

  it("keeps the arrow pad in a group the phone layout hides, and lets presses in the gaps through", () => {
    const html = renderToStaticMarkup(<PanZoomControls onMove={() => {}} onZoom={() => {}} onFit={() => {}} onActual={() => {}} />);
    expect(html).toMatch(/<div class="panzoom-pad">(?:<button[^]*?<\/button>){4}<\/div>/);
    const css = fs.readFileSync(path.join(__dirname, "../src/app/site.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 600px\)[^\n]*\.panzoom-pad \{ display: none; \}/);
    // A stand-in for an element: only a button inside the controls matches.
    const at = (inButton: boolean) => ({ closest: (sel: string) => (inButton && sel === ".panzoom-controls button" ? {} : null) }) as unknown as Element;
    expect(onControl(at(true))).toBe(true);
    expect(onControl(at(false))).toBe(false);
  });

  it("puts a workflow page's drawing in a focusable frame, without controls until it is drawn", async () => {
    const owner = await pushed("dinners", dinners);
    const { html } = await renderPage(WorkflowPage, { owner, slug: "dinners" });
    expect(FRAME_LABEL).toBe("Workflow drawing. Drag to move, pinch or Ctrl+scroll to zoom.");
    expect(html).toContain(frame);
    expect(html).toMatch(new RegExp(`<div class="panzoom"[^>]*tabindex="0"`));
    const figure = /<figure[^]*?<\/figure>/.exec(html)![0];
    expect(figure).toContain('<div class="drawing"><pre>');
    expect(buttons(figure)).toEqual([]);
  });

  it("leaves the gallery's thumbnails and the views with nothing drawn as they were", async () => {
    const owner = await pushed("dinners", nowhere);
    const gallery = (await renderPage(GalleryPage, {})).html;
    expect(gallery).toContain('<div class="drawing"><pre>');
    expect(gallery).not.toContain("panzoom");
    expect(gallery).not.toContain(FRAME_LABEL);
    const platform = (await renderPage(WorkflowPlatformPage, { owner, slug: "dinners" })).html;
    expect(platform).toContain("This workflow doesn&#x27;t say where it runs yet.");
    expect(platform).not.toContain(FRAME_LABEL);
  });
});
