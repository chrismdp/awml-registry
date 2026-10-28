// The frame a workflow's drawing, or a system's map, is shown in (src/components/Drawing.tsx):
// the server's SVG first, which a browser with no scripts sees whole, then React Flow, which
// drags, pans and zooms it. Its maths is in test/viewport.test.ts. A part's notes are behind an
// icon (#60), and the Flow only switch and zoom buttons sit in the frame's corners.
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FRAME_LABEL, NoteDialog } from "@/components/Drawing";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { NoteButton, NoteTip, NODE_TYPES, nodesOf } from "@/components/flow/FlowCanvas";
import { atServer } from "@/components/flow/physics";
import type { Drawing } from "@/components/flow/drawing";
import { notesBy } from "@/components/flow/StaticDrawing";
import { graphOf } from "@/components/flow/graph";
import { engine } from "@/engine";
import { StaticDrawing } from "@/components/flow/StaticDrawing";
import { layOut } from "@/server/drawing";
import { expected, laidOut } from "./drawn";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import GalleryPage from "@/app/gallery/page";
import { example, person, request } from "./helpers";
import { renderPage } from "./pages";

const dinners = example("dinners.yaml");
const nowhere = dinners.slice(0, dinners.indexOf("implementations:"));
const issue = example("flow/issue-to-pull-request.graph.json");
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
    for (const label of Object.values(expected(dinners).parts)) expect(words).toContain(label);
    expect(svg!.match(/<path class="flow-line /g)).toHaveLength(expected(dinners).lines);
    expect(svg).toMatch(/marker-end="url\(#flow[^)]+-arrow-solid\)"/);
    // No Mermaid text, and no script needed: React Flow takes over later, in the browser.
    expect(html).not.toContain("flowchart");
    expect(html).not.toContain("react-flow");
  });

  it("has Flow only and the zoom buttons in its corners, which a browser without scripts doesn't show, and no choice of layout (#78)", async () => {
    const owner = await pushed("dinners", dinners);
    const { html } = await renderPage(WorkflowPage, { owner, slug: "dinners" });
    const figure = /<figure[^]*?<\/figure>/.exec(html)![0];
    expect(buttons(figure)).toEqual([
      { text: "Flow only", role: undefined, checked: "false", label: undefined, title: undefined },
      { text: "+", label: "Zoom in", title: "Zoom in", role: undefined, checked: undefined },
      { text: "−", label: "Zoom out", title: "Zoom out", role: undefined, checked: undefined },
      { text: "Fit", label: "Fit the whole drawing", title: "Fit the whole drawing", role: undefined, checked: undefined },
    ]);
    expect(figure).not.toContain("radiogroup");
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
    const graph = JSON.stringify({
      view: "security",
      groups: [],
      parts: [{ id: "a", kind: "code", label: "Do it", decider: "code", op: "do" }],
      lines: [{ from: "n", to: "a", kind: "tie", points: "none" }],
      comments: [{ id: "n", label: "<script>alert(1)</script> and <b>bold</b>", gap: false, ties: ["a"] }],
      places: [],
    });
    const { full } = laidOut(await layOut(graph));
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

// React Flow's nodes for a drawing, where the server's SVG has them, with each note's icon.
function serverNodes(d: Drawing) {
  const { bodies, hulls } = atServer(d);
  return nodesOf(d, bodies, hulls, { id: "t", links: new Map(), hrefs: {}, notes: notesBy(d.notes), onNote: () => {} });
}

// The engine's graph gives every label exactly as the file wrote it, unescaped, line breaks
// included (#69). test/fixtures/hostile.yaml writes markup, a javascript: address and line
// breaks into every kind of label: none may reach a page as anything but text.
describe("text from the engine's graph, which it gives unescaped (#69)", () => {
  const hostile = example("hostile.yaml");

  // What in some markup would run or load something: a tag that may, an on… attribute, or an
  // address that runs script. Text React escapes holds no "<", and an attribute's value no '"',
  // so every tag and attribute found here is markup, not text.
  function unsafe(markup: string) {
    const found: string[] = [];
    for (const [, name, attributes] of markup.matchAll(/<([a-zA-Z][\w:-]*)([^>]*)>/g)) {
      if (/^(script|img|iframe|object|embed|style|b)$/i.test(name)) found.push(`<${name}>`);
      for (const [, attribute, value] of attributes.matchAll(/\s([^\s=]+)="([^"]*)"/g)) {
        if (/^on/i.test(attribute)) found.push(`${name} ${attribute}`);
        if (/href$/i.test(attribute) && /^\s*javascript:/i.test(value)) found.push(`${name} ${attribute}=${value}`);
      }
    }
    return found;
  }

  // What React Flow draws for a drawing, as it renders it, with each note's icon.
  const flowOf = (d: Drawing) =>
    renderToStaticMarkup(
      <ReactFlow
        nodes={serverNodes(d)}
        edges={[]}
        nodeTypes={NODE_TYPES}
        width={800}
        height={600}
      />,
    );

  it("is looked for as tags and attributes that run or load something", () => {
    expect(unsafe('<p title="&lt;img onerror=x&gt;">&lt;script&gt;</p>')).toEqual([]);
    expect(unsafe('<p>x</p><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">')).toEqual([
      "<img>",
      "img onerror",
      "a href=javascript:alert(1)",
    ]);
  });

  it("reaches the server's SVG and React Flow only as text, each label on lines of its own", async () => {
    expect(await engine.check(hostile)).toEqual([]);
    const graph = await engine.graph(hostile);
    // The engine's graph holds the markup as written.
    expect(JSON.parse(graph).parts[0].label).toBe("<script>alert('trigger')</script>");
    const { full } = laidOut(await layOut(graph));
    // Line breaks are folded, so no label's line holds one.
    for (const lines of [...full.parts.map((p) => p.lines), ...full.lines.map((l) => l.label?.lines ?? [])])
      for (const line of lines) expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(graphOf(graph).parts.map((p) => [p.id, p.label, p.tier])).toEqual([
      ["tick", "<script>alert('trigger')</script>", undefined],
      ["step", "javascript:alert('step') </text><script>alert('break')</script>", undefined],
      ["out", "<img src=x onerror=alert('action')>", "Allow <b>now</b>"],
    ]);
    for (const markup of [renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />), flowOf(full)]) {
      expect(unsafe(markup)).toEqual([]);
      // Each label is broken into lines as it fits, so only pieces of one line are looked for.
      expect(markup).toContain("&lt;script&gt;alert(&#x27;trigger&#x27;)");
      expect(markup).toContain("onerror=alert(&#x27;action&#x27;)&gt;");
      expect(markup).toContain("&lt;/text&gt;&lt;script&gt;alert(&#x27;break&#x27;)");
      expect(markup).toContain("Allow &lt;b&gt;now&lt;/b&gt;");
    }
    // The scope's name and the line's label are drawn on the server's SVG, the note in its tooltip.
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    expect(svg).toContain("&lt;img src=x onerror=alert(&#x27;scope&#x27;)&gt;");
    expect(svg).toContain("&lt;svg onload=alert(&#x27;line&#x27;)&gt; next");
    expect(svg).toContain("<title>Missing from the design: &lt;script&gt;alert(&#x27;gap&#x27;)&lt;/script&gt; and &lt;a href=&quot;javascript:alert(&#x27;link&#x27;)&quot;&gt;this&lt;/a&gt;</title>");
    // React Flow's tooltip and the modal show the note as text too.
    const notes = full.notes;
    for (const markup of [renderToStaticMarkup(<NoteTip notes={notes} />), renderToStaticMarkup(<NoteDialog shown={{ title: "Step", notes }} onClose={() => {}} />)]) {
      expect(unsafe(markup)).toEqual([]);
      expect(markup).toContain("&lt;script&gt;alert(&#x27;gap&#x27;)&lt;/script&gt;");
    }
  });

  it("reaches a workflow's page only as text, its title included", async () => {
    const owner = await pushed("hostile", hostile);
    const { html } = await renderPage(WorkflowPage, { owner, slug: "hostile" });
    expect(unsafe(html)).toEqual([]);
    expect(html).toContain("<h1>Hostile &lt;script&gt;alert(&#x27;title&#x27;)&lt;/script&gt;</h1>");
    expect(html).toContain("&lt;script&gt;alert(&#x27;trigger&#x27;)");
  });
});

// A comment whose label starts "Missing from the design" marks a gap, which the engine's graph
// gives as gap (#69). A gap is a finding: its part's mark is a warning, not only a note icon,
// with the same tooltip and the same modal.
describe("a gap in the design (#69)", () => {
  it("marks the part it is tied to with a warning, in the server's SVG and once React Flow draws it", async () => {
    const { full } = laidOut(await layOut(example("dinners.graph.json")));
    expect(full.notes).toEqual([{ id: "screen_gap", on: "screen", text: "Missing from the design: no scheduled task keeps the screen current", gap: true }]);
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    const mark = /<g class="flow-note" transform="[^"]+" data-note="screen_gap" data-gap="true"><title>([^<]*)<\/title><g class="flow-note-icon gap">/.exec(svg);
    expect(mark?.[1]).toBe("Missing from the design: no scheduled task keeps the screen current");
    const button = renderToStaticMarkup(
      <ReactFlowProvider>
        <NoteButton title="Kitchen screen" notes={full.notes} at={{ x: 10, y: 10 }} onNote={() => {}} />
      </ReactFlowProvider>,
    );
    expect(button).toContain('aria-label="Gap in the design on Kitchen screen"');
    expect(button).toContain('<g class="flow-note-icon gap">');
    // The same modal a note opens.
    expect(renderToStaticMarkup(<NoteDialog shown={{ title: "Kitchen screen", notes: full.notes }} onClose={() => {}} />)).toContain(
      "<p>Missing from the design: no scheduled task keeps the screen current</p>",
    );
    // A note that is no gap keeps its note icon.
    const plain = renderToStaticMarkup(<StaticDrawing drawing={laidOut(await layOut(issue)).full} id="t" />);
    expect(plain).toContain('<g class="flow-note-icon">');
    expect(plain).not.toContain("flow-note-icon gap");
  });

  it("puts a gap tied to nothing on the drawing's own icon, marked as a gap", async () => {
    const graph = JSON.stringify({
      view: "security",
      groups: [{ id: "home", label: "home: the family" }],
      parts: [{ id: "a", kind: "code", label: "Do it", in: "home", decider: "code", op: "do" }],
      lines: [],
      comments: [{ id: "g", label: "Missing from the design: who checks it", in: "home", gap: true, ties: [] }],
      places: [],
    });
    const { full } = laidOut(await layOut(graph));
    expect(full.notes).toEqual([{ id: "g", text: "Missing from the design: who checks it", gap: true }]);
    expect(full.notesAt).toBeDefined();
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    expect(svg).toContain(`<g class="flow-note" transform="translate(${full.notesAt!.x}, ${full.notesAt!.y})" data-note="g" data-gap="true">`);
    const nodes = serverNodes(full);
    const flow = renderToStaticMarkup(<ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} width={800} height={600} />);
    expect(flow).toContain('aria-label="Gap in the design on The whole drawing"');
  });
});
