// The frame a workflow's drawing, or a system's map, is shown in (src/components/Drawing.tsx):
// the server's SVG first, which a browser with no scripts sees whole, then React Flow, which
// drags, pans and zooms it. Its maths is in test/viewport.test.ts. A part's notes are behind an
// icon (#60), and the switches and zoom buttons sit in the frame's corners.
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FRAME_LABEL, NoteDialog } from "@/components/Drawing";
import { ReactFlowProvider } from "@xyflow/react";
import { NoteButton, NoteTip } from "@/components/flow/FlowCanvas";
import { StaticDrawing } from "@/components/flow/StaticDrawing";
import { layOut } from "@/server/drawing";
import { laidOut } from "./drawn";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import GalleryPage from "@/app/gallery/page";
import { example, person, request } from "./helpers";
import { renderPage } from "./pages";

const dinners = example("dinners.yaml");
const nowhere = dinners.slice(0, dinners.indexOf("implementations:"));
const issue = example("flow/issue-to-pull-request.mmd");
const css = fs.readFileSync(path.join(__dirname, "../src/components/flow/flow.css"), "utf8");

// Each button's aria-label and title, in the order they appear.
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([^<]*)/g)].map(([tag, text]) => ({
    text,
    label: /aria-label="([^"]*)"/.exec(tag)?.[1],
    title: /title="([^"]*)"/.exec(tag)?.[1],
    role: /role="([^"]*)"/.exec(tag)?.[1],
    checked: /aria-checked="([^"]*)"/.exec(tag)?.[1] ?? /aria-pressed="([^"]*)"/.exec(tag)?.[1],
  }));

async function pushed(slug: string, workflow: string) {
  const ana = await person("ana");
  const res = await request("POST", `/api/v1/${ana.username}/${slug}/versions`, { as: { token: ana.token }, json: { workflow } });
  expect(res.status).toBe(201);
  return ana.username;
}

describe("a workflow's drawing", () => {
  it("is a focusable, labelled frame holding the server's SVG, which needs no script to show", async () => {
    const owner = await pushed("dinners", dinners);
    const { html } = await renderPage(WorkflowPage, { owner, slug: "dinners" });
    expect(FRAME_LABEL).toBe(
      "Workflow drawing. Drag a part to move it; drag the background, or use the arrow keys, to move the drawing; pinch, Ctrl+scroll or + and − to zoom.",
    );
    expect(html).toMatch(new RegExp(`<div class="flow-frame" data-flow="[^"]+" role="group" aria-label="${FRAME_LABEL.replace(/[.+]/g, "\\$&")}" tabindex="0">`));
    const svg = /<svg class="flow-static" viewBox="0 0 \d+ \d+" preserveAspectRatio="xMidYMid meet"[^]*?<\/svg>/.exec(html)?.[0];
    expect(svg).toBeDefined();
    // Every part, its label as text, and every line, with its arrowhead.
    const words = svg!.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
    for (const label of ["Plan next week's dinners", "Fill the basket from the plan and the list", "Owen's yes to the exact basket"])
      expect(words).toContain(label);
    expect(svg!.match(/<path class="flow-line /g)).toHaveLength(19);
    expect(svg).toMatch(/marker-end="url\(#flow[^)]+-arrow-solid\)"/);
    // No Mermaid text, and no script needed: React Flow takes over later, in the browser.
    expect(html).not.toContain("flowchart");
    expect(html).not.toContain("react-flow");
  });

  it("has Layered and Physics, Flow only, and the zoom buttons in its corners, which a browser without scripts doesn't show", async () => {
    const owner = await pushed("dinners", dinners);
    const { html } = await renderPage(WorkflowPage, { owner, slug: "dinners" });
    const figure = /<figure[^]*?<\/figure>/.exec(html)![0];
    expect(buttons(figure)).toEqual([
      { text: "Layered", role: "radio", checked: "true", label: undefined, title: undefined },
      { text: "Physics", role: "radio", checked: "false", label: undefined, title: undefined },
      { text: "Flow only", role: undefined, checked: "false", label: undefined, title: undefined },
      { text: "+", label: "Zoom in", title: "Zoom in", role: undefined, checked: undefined },
      { text: "−", label: "Zoom out", title: "Zoom out", role: undefined, checked: undefined },
      { text: "Fit", label: "Fit the whole drawing", title: "Fit the whole drawing", role: undefined, checked: undefined },
    ]);
    expect(figure).toContain('<div class="flow-pills" role="radiogroup" aria-label="Layout">');
    expect(css).toContain("@media (scripting: none) { .flow-controls { display: none; } }");
  });

  it("draws the gallery's thumbnails as the server's SVG alone, and a view with nothing drawn without a frame", async () => {
    const owner = await pushed("dinners", nowhere);
    const gallery = (await renderPage(GalleryPage, {})).html;
    expect(gallery).toContain('<svg class="flow-static"');
    expect(gallery).not.toContain("flow-frame");
    expect(gallery).not.toContain(FRAME_LABEL);
    const platform = (await renderPage(WorkflowPlatformPage, { owner, slug: "dinners" })).html;
    expect(platform).toContain("This workflow doesn&#x27;t say where it runs yet.");
    expect(platform).not.toContain("flow-frame");
  });
});

describe("a part's notes (#60)", () => {
  it("are never drawn: each part with notes has one icon, its notes' text only in its tooltip", async () => {
    const { full } = laidOut(await layOut(issue));
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    const marked = [...svg.matchAll(/<g class="flow-note" transform="[^"]+" data-note="([^"]+)"><title>([^<]*)<\/title>/g)];
    // Eight notes, on eight parts, one icon each.
    expect(marked.map((m) => m[1]).sort()).toEqual(["fresh", "label", "layout", "onecomment", "seen", "starts", "strangers", "verdict"]);
    expect(svg).toContain(
      "<title>Anyone can comment, but the bring-in step passes on only the comments of the owner, members and collaborators, so strangers&#x27; text never reaches the draft step. AWML can&#x27;t mark this yet (awml #5)</title>",
    );
    // No note is drawn as a part, or as text of its own.
    expect(svg).not.toMatch(/<tspan[^>]*>Anyone can comment/);
    expect(full.parts.map((p) => p.id)).not.toContain("strangers");
  });

  it("show as text, never as HTML, in the tooltip, the button and the modal", async () => {
    const text = `---\nconfig: {}\n---\nflowchart TB\n  a("<small>⚙️ 🛠️ do</small><br>Do it")\n  n@{ shape: notch-rect, label: "#60;script#62;alert(1)#60;/script#62; and #60;b#62;bold#60;/b#62;" }\n  a -.- n\n  class a code\n  class n gap`;
    const { full } = laidOut(await layOut(text));
    expect(full.notes).toEqual([{ id: "n", on: "a", text: "<script>alert(1)</script> and <b>bold</b>" }]);
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    expect(svg).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;bold&lt;/b&gt;</title>");
    expect(svg).not.toContain("<script>");
    // Once React Flow has taken over: a button a keyboard reaches, with a label, and its note
    // as a tooltip on hover or focus.
    const button = renderToStaticMarkup(
      <ReactFlowProvider>
        <NoteButton title="Do it" notes={full.notes} at={{ x: 10, y: 10 }} onNote={() => {}} />
      </ReactFlowProvider>,
    );
    expect(button).toMatch(/^<button type="button" class="flow-note-mark nodrag nopan" style="[^"]*" aria-label="Note on Do it">/);
    expect(renderToStaticMarkup(<NoteTip notes={full.notes} />)).toBe(
      '<div class="flow-note-tip" role="tooltip"><p>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;bold&lt;/b&gt;</p></div>',
    );
    const modal = renderToStaticMarkup(<NoteDialog shown={{ title: "Do it", notes: full.notes }} onClose={() => {}} />);
    // A native dialog, which Escape closes.
    expect(modal).toMatch(/^<dialog class="flow-note-dialog" aria-label="Note">/);
    expect(modal).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;bold&lt;/b&gt;</p>");
  });
});
