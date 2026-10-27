// What the server does with a drawing it can't lay out (src/server/drawing.ts): one too big
// to lay out in good time, one whose layout fails, and labels whose line breaks the engine
// leaves in its Mermaid text. A page shows each as a message, never a 500, and the answer is
// kept, so the work isn't tried again on the next request.
import ELK from "elkjs/lib/elk.bundled.js";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as graph from "@/components/flow/graph";
import { StaticDrawing } from "@/components/flow/StaticDrawing";
import { textWidth, wrap } from "@/components/flow/text";
import { engine } from "@/engine";
import { LIMITS, layOut, layOutWhole, nesting } from "@/server/drawing";
import { expected, laidOut } from "./drawn";
import { example } from "./helpers";

// Every reading of the engine's text, counted, so a test can tell an answer was kept.
vi.mock("@/components/flow/graph", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/flow/graph")>();
  return { ...real, parseMermaid: vi.fn(real.parseMermaid) };
});
const parsed = vi.mocked(graph.parseMermaid);

afterEach(() => {
  vi.restoreAllMocks();
  parsed.mockClear();
});

// A chain of n steps in one scope, each started by the one before, with a label of `label`
// characters on each: n + 2 parts and scopes, and n lines.
function chain(n: number, label = 8, name = "c") {
  const rows = ["flowchart TB", '  subgraph home["home#58; the family"]', `    ${name}t(["Start"])`];
  for (let i = 0; i < n; i++) rows.push(`    ${name}${i}("<small>⚙️ 🛠️ do</small><br>${String(i).padEnd(label, "x")}")`);
  rows.push("  end", `  ${name}t --> ${name}0`);
  for (let i = 1; i < n; i++) rows.push(`  ${name}${i - 1} --> ${name}${i}`);
  rows.push(`  class ${name}t trig`, `  class ${Array.from({ length: n }, (_, i) => `${name}${i}`).join(",")} code`);
  return rows.join("\n");
}

describe("a drawing too big to lay out", () => {
  it("is laid out up to the limits, and past them isn't, saying so", async () => {
    const layout = vi.spyOn(ELK.prototype, "layout");
    // The scope and the trigger are two of the parts.
    const most = LIMITS.parts - 2;
    expect("undrawn" in (await layOut(chain(most, 8, "a")))).toBe(false);
    expect(layout).toHaveBeenCalled();
    layout.mockClear();
    expect(await layOut(chain(most + 1, 8, "b"))).toEqual({ undrawn: "too big" });
    // Lines past the limit, or label text, are as much too big.
    const lines = `${chain(10, 8, "d")}\n${Array.from({ length: LIMITS.lines }, () => "  d0 --> d1").join("\n")}`;
    expect(await layOut(lines)).toEqual({ undrawn: "too big" });
    expect(await layOut(chain(10, LIMITS.characters / 10 + 1, "e"))).toEqual({ undrawn: "too big" });
    // ELK never saw them.
    expect(layout).not.toHaveBeenCalled();
  });

  it("is laid out with scopes nested 8 deep, and not 9", async () => {
    // Scopes nested one inside the next, with two steps in the innermost.
    const nested = (depth: number, name: string) =>
      [
        "flowchart TB",
        ...Array.from({ length: depth }, (_, d) => `  subgraph ${name}${d}["Level ${d + 1}"]`),
        `    ${name}a("<small>⚙️ 🛠️ do</small><br>Do it")`,
        `    ${name}b("<small>⚙️ 🛠️ do</small><br>Then this")`,
        ...Array.from({ length: depth }, () => "  end"),
        `  ${name}a --> ${name}b`,
        `  class ${name}a,${name}b code`,
      ].join("\n");
    expect(LIMITS.depth).toBe(8);
    expect(nesting(graph.parseMermaid(nested(8, "i")))).toBe(8);
    const layout = vi.spyOn(ELK.prototype, "layout");
    const eight = laidOut(await layOut(nested(8, "i")));
    expect(eight.full.scopes.map((s) => s.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    layout.mockClear();
    expect(await layOut(nested(9, "j"))).toEqual({ undrawn: "too big" });
    expect(layout).not.toHaveBeenCalled();
  });

  it("counts each note as a part, and each part it is on as a line", async () => {
    // A note tied to each of `on` parts of a chain of `n` steps.
    const noted = (n: number, notes: number, on: number, name: string) =>
      [
        chain(n, 8, name),
        ...Array.from({ length: notes }, (_, k) => `  ${name}n${k}@{ shape: notch-rect, label: "Note ${k}" }`),
        ...Array.from({ length: on }, (_, i) => `  ${name}${i} -.- ${name}n0`),
        ...Array.from({ length: notes }, (_, k) => `  class ${name}n${k} gap`),
      ].join("\n");
    // The chain's steps, its trigger and its scope, and a note: the limit of parts.
    const steps = LIMITS.parts - 3;
    expect("undrawn" in (await layOut(noted(steps, 1, 1, "k")))).toBe(false);
    expect(await layOut(noted(steps, 2, 1, "l"))).toEqual({ undrawn: "too big" });
    // A chain of sixty steps has sixty lines, and a note on each step is sixty more: the
    // limit of lines. One more step is one line, and too many.
    expect(LIMITS.lines).toBe(120);
    expect("undrawn" in (await layOut(noted(60, 1, 60, "m")))).toBe(false);
    expect(await layOut(noted(61, 1, 60, "o"))).toEqual({ undrawn: "too big" });
    expect("undrawn" in (await layOut(noted(61, 1, 0, "p")))).toBe(false);
  });

  it("is kept as too big, so its text isn't read again", async () => {
    const big = chain(LIMITS.parts, 8, "f");
    await layOut(big);
    const reads = parsed.mock.calls.length;
    expect(await layOut(big)).toEqual({ undrawn: "too big" });
    expect(parsed.mock.calls.length).toBe(reads);
  });
});

describe("a drawing whose layout fails", () => {
  it("says so rather than throwing, and is kept, so ELK isn't tried again", async () => {
    const layout = vi.spyOn(ELK.prototype, "layout").mockRejectedValue(new Error("org.eclipse.elk.core.UnsupportedGraphException: Referenced shape does not exist"));
    const text = chain(3, 8, "g");
    expect(await layOut(text)).toEqual({ undrawn: "failed" });
    const tries = layout.mock.calls.length;
    expect(await layOut(text)).toEqual({ undrawn: "failed" });
    expect(await layOutWhole(text)).toEqual({ undrawn: "failed" });
    expect(layout.mock.calls.length).toBe(tries);
  });
});

describe("the gallery's drawing, the whole of it alone", () => {
  it("lays out the whole drawing and not Flow only", async () => {
    const layout = vi.spyOn(ELK.prototype, "layout");
    const text = chain(3, 8, "h");
    const whole = laidOut(await layOutWhole(text));
    expect(layout).toHaveBeenCalledTimes(1);
    // The same drawing a page shows, kept for it.
    expect(laidOut(await layOut(text)).full).toEqual(whole);
    expect(layout).toHaveBeenCalledTimes(2);
  });
});

describe("breaking a label into lines", () => {
  it("takes as long as the label is long, however long a word in it", () => {
    // Measuring each piece of a long word afresh took time growing with its square: this word
    // took 90 seconds. Each character is now measured once.
    const word = "w".repeat(200_000);
    const start = performance.now();
    const lines = wrap(word, 14, 100);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(lines.join("")).toBe(word);
    expect(lines.every((l) => textWidth(l, 14) <= 100)).toBe(true);
    // Words are kept whole while they fit, and the line is as full as it may be.
    expect(wrap("one two three four", 14, textWidth("one two", 14))).toEqual(["one two", "three", "four"]);
  });
});

describe("labels with line breaks, drawn by the engine (#62 review)", () => {
  // The engine leaves a line break in a label as it is, inside its quotes: a folded label
  // ("label: >") ends with one, and a label may hold a line that says end, which ends a
  // scope in Mermaid. Each once took its page down.
  for (const name of ["label-folded.yaml", "label-end.yaml"]) {
    it(`draws ${name}, every part with its label and every line`, async () => {
      const file = example(name);
      expect(await engine.check(file)).toEqual([]);
      const { full } = laidOut(await layOut(await engine.draw(file)));
      const want = expected(file);
      expect(Object.fromEntries(full.parts.map((p) => [p.id, [...p.lines, ...(p.tier ? [p.tier] : [])].join(" ")]))).toEqual(want.parts);
      expect(full.lines).toHaveLength(want.lines);
      expect(full.scopes.map((s) => s.id)).toEqual(want.scopes);
    });
  }

  it("puts a comment tied to two parts on both, and one tied to nothing in the drawing's corner", async () => {
    const { full } = laidOut(await layOut(await engine.draw(example("label-folded.yaml"))));
    expect(full.notes).toEqual([
      { id: "c2", text: "Tied to nothing" },
      { id: "c1", on: "step", text: "Tied to two parts" },
      { id: "c1", on: "note", text: "Tied to two parts" },
    ]);
    // A strip above the drawing holds the corner's icon.
    expect(full.box.y).toBeLessThan(0);
    expect(full.notesAt!.y).toBeLessThan(0);
    const svg = renderToStaticMarkup(<StaticDrawing drawing={full} id="t" />);
    const icons = [...svg.matchAll(/<g class="flow-note" transform="translate\(([^)]+)\)" data-note="([^"]+)"><title>([^<]*)<\/title>/g)];
    expect(icons.map((m) => [m[2], m[3]])).toEqual([
      ["c1", "Tied to two parts"],
      ["c1", "Tied to two parts"],
      ["c2", "Tied to nothing"],
    ]);
    expect(icons[2][1]).toBe(`${full.notesAt!.x}, ${full.notesAt!.y}`);
  });
});
