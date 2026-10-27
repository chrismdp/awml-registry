import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAWN_LIKE_AWML, drawingOf, drawInto, drawMermaid, KEPT_DRAWINGS } from "@/components/Mermaid";

// What the page's Mermaid was asked to do, in order. It can't draw a text
// that starts "not a drawing", and for a text that asks for ids it draws an
// SVG whose elements are named after the id it is given, as Mermaid's are.
const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("mermaid", () => ({
  default: {
    initialize: (config: unknown) => calls.push(["initialize", config]),
    render: async (id: string, text: string) => {
      calls.push(["render", id, text]);
      if (text.startsWith("not a drawing")) throw new Error("No diagram type detected");
      if (text.includes("%% ids")) return { svg: `<svg id="${id}"><marker id="${id}_end"/><path marker-end="url(#${id}_end)"/></svg>` };
      return { svg: "<svg></svg>" };
    },
  },
}));

// A stand-in for the element a drawing goes in: what it holds, and its classes.
function frame() {
  const classes = new Set<string>();
  return {
    innerHTML: "<pre>the text</pre>",
    classes,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
  };
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("drawing a workflow like AWML's own drawings", () => {
  it("installs exactly the Mermaid that AWML's examples/render.sh draws with", () => {
    expect(DRAWN_LIKE_AWML.mermaid).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json("package.json").dependencies.mermaid).toBe(DRAWN_LIKE_AWML.mermaid);
    expect(json("package-lock.json").packages["node_modules/mermaid"].version).toBe(DRAWN_LIKE_AWML.mermaid);
  });

  it("gives Mermaid render.sh's config, with scripts in labels still refused", async () => {
    expect(DRAWN_LIKE_AWML.config).toEqual({ startOnLoad: false, theme: "default", securityLevel: "strict" });
    vi.stubGlobal("document", {
      fonts: { load: async (font: string) => (calls.push(["font", font]), []) },
    });
    const text = "---\nconfig:\n  fontFamily: Inter, sans-serif\n---\nflowchart TB\n  a --> b\n";
    expect(await drawMermaid("m1", text)).toBe("<svg></svg>");
    expect(calls).toEqual([
      ["font", "16px Inter, sans-serif"],
      ["initialize", DRAWN_LIKE_AWML.config],
      ["render", "m1", text],
    ]);
  });

  it("draws each text once, and has a drawing it made before ready at once", async () => {
    vi.stubGlobal("document", { fonts: { load: async () => [] } });
    const text = "flowchart LR\n  tab --> again\n";
    expect(drawingOf(text, "m2")).toBeUndefined();
    expect(await drawMermaid("m2", text)).toBe("<svg></svg>");
    expect(drawingOf(text, "m2")).toBe("<svg></svg>");
    expect(await drawMermaid("m3", text)).toBe("<svg></svg>");
    expect(calls.filter(([call]) => call === "render")).toEqual([["render", "m2", text]]);
    // A frame opened again gets the drawing before anything is awaited, so
    // before the browser paints.
    const again = frame();
    drawInto(again, "m4", text);
    expect(again.innerHTML).toBe("<svg></svg>");
  });

  it("gives two drawings of the same text their own element ids", async () => {
    vi.stubGlobal("document", { fonts: { load: async () => [] } });
    const text = "flowchart LR\n  %% ids\n  a --> b\n";
    const first = await drawMermaid("drawing-r1", text);
    expect(first).toBe('<svg id="drawing-r1"><marker id="drawing-r1_end"/><path marker-end="url(#drawing-r1_end)"/></svg>');
    const second = '<svg id="drawing-r2"><marker id="drawing-r2_end"/><path marker-end="url(#drawing-r2_end)"/></svg>';
    expect(drawingOf(text, "drawing-r2")).toBe(second);
    expect(await drawMermaid("drawing-r2", text)).toBe(second);
    // The first still has its own.
    expect(drawingOf(text, "drawing-r1")).toBe(first);
    expect(calls.filter(([call]) => call === "render")).toHaveLength(1);
  });

  it(`keeps the ${KEPT_DRAWINGS} drawings used most recently`, async () => {
    vi.stubGlobal("document", { fonts: { load: async () => [] } });
    expect(KEPT_DRAWINGS).toBe(50);
    const texts = Array.from({ length: KEPT_DRAWINGS + 1 }, (_, i) => `flowchart LR\n  kept${i} --> b\n`);
    for (const text of texts.slice(0, KEPT_DRAWINGS)) await drawMermaid("m", text);
    // Showing the first again makes it the most recently used.
    expect(drawingOf(texts[0], "m")).toBe("<svg></svg>");
    await drawMermaid("m", texts[KEPT_DRAWINGS]);
    expect(drawingOf(texts[1], "m")).toBeUndefined();
    for (const text of [texts[0], ...texts.slice(2)]) expect(drawingOf(text, "m"), text).toBe("<svg></svg>");
  });

  it("marks the frame when Mermaid can't draw the text, so the text shows again, and keeps nothing", async () => {
    vi.stubGlobal("document", { fonts: { load: async () => [] } });
    const text = "not a drawing\n";
    const failed = frame();
    drawInto(failed, "m5", text);
    await vi.waitFor(() => expect([...failed.classes]).toEqual(["failed"]));
    expect(failed.innerHTML).toBe("<pre>the text</pre>");
    expect(drawingOf(text, "m5")).toBeUndefined();
    // A frame that has gone by the time Mermaid fails is left alone.
    const gone = frame();
    drawInto(gone, "m6", text)();
    await vi.waitFor(() => expect(calls.filter(([, id]) => id === "m6")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gone.classes.size).toBe(0);
  });
});
