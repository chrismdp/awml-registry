import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAWN_LIKE_AWML, drawingOf, drawMermaid } from "@/components/Mermaid";

// What the page's Mermaid was asked to do, in order.
const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("mermaid", () => ({
  default: {
    initialize: (config: unknown) => calls.push(["initialize", config]),
    render: async (id: string, text: string) => {
      calls.push(["render", id, text]);
      return { svg: "<svg></svg>" };
    },
  },
}));

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
    expect(drawingOf(text)).toBeUndefined();
    expect(await drawMermaid("m2", text)).toBe("<svg></svg>");
    expect(drawingOf(text)).toBe("<svg></svg>");
    expect(await drawMermaid("m3", text)).toBe("<svg></svg>");
    expect(calls.filter(([call]) => call === "render")).toEqual([["render", "m2", text]]);
  });
});
