// What a page draws, read from the SVG the server sends (src/components/flow/StaticDrawing.tsx),
// and what an AWML 0.6 file says it should draw, read from the YAML itself, never from the
// engine's Mermaid text, so a mistake in reading that text can't hide on both sides of a test:
// each scope by id with the scope it is in, each part by id with its label, and how many lines.
import { parse } from "yaml";
import type { Undrawn } from "@/components/flow/drawing";
import { engine } from "@/engine";

const placed = (id: string, scope?: string) => (scope ? `${id}@${scope}` : id);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const byId = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

// The scopes, parts and lines of a page's drawing, or null when it draws nothing.
export function drawing(html: string) {
  const svg = /<svg class="flow-static"[^]*?<\/svg>/.exec(html)?.[0];
  if (!svg) return null;
  const scopes = [...svg.matchAll(/<g [^>]*\bdata-scope="([^"]+)"(?: data-in="([^"]+)")?/g)].map((m) => placed(m[1], m[2])).sort();
  const parts: Record<string, string> = {};
  // Each part's piece of the SVG runs to the next part's; its label is drawn line by line, and
  // an outside action's tier in a pill below it.
  for (const piece of svg.split(/(?=<g [^>]*\bdata-part=")/).slice(1)) {
    const id = /data-part="([^"]+)"/.exec(piece)![1];
    const label = /<text class="flow-label"[^>]*>([^]*?)<\/text>/.exec(piece)?.[1] ?? "";
    const words = [...label.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => unescape(m[1])).join(" ");
    const tier = /<g class="flow-tier">[^]*?<text[^>]*>([^<]*)<\/text>/.exec(piece)?.[1];
    parts[id] = tier ? `${words}: ${unescape(tier)}` : words;
  }
  return { scopes, parts: byId(parts), lines: svg.match(/<path class="flow-line /g)?.length ?? 0 };
}

type Doc = {
  scopes?: { id: string; in?: string }[];
  parts: { id: string; kind: string; label: string }[];
  lines: { kind: string }[];
  implementations?: Record<string, { blocks: { id: string; in?: string }[] }>;
};

// What a 0.6 file draws: its design's scopes, or the blocks of the implementation named; every
// part but a comment, which is a note on what it is tied to; and every line but a tie.
export function expected(file: string, implementation?: string) {
  const doc = parse(file) as Doc;
  const scopes = implementation ? doc.implementations![implementation].blocks : (doc.scopes ?? []);
  return {
    scopes: scopes.map((s) => placed(s.id, s.in)).sort(),
    parts: byId(Object.fromEntries(doc.parts.filter((p) => p.kind !== "comment").map((p) => [p.id, squash(p.label)]))),
    lines: doc.lines.filter((l) => l.kind !== "tie").length,
  };
}

// The same for an older file, or a pair of views, converted to 0.6 as the registry reads it.
export async function expectedOf(files: string[], implementation?: string) {
  const read = await engine.convert(files);
  if ("error" in read) throw new Error(read.error);
  return expected(read.file, implementation);
}

// A drawing the server laid out, or the test fails saying why it didn't.
export function laidOut<T extends object>(d: T | Undrawn | null | undefined): T {
  if (!d) throw new Error("nothing was drawn");
  if ("undrawn" in d) throw new Error(`the drawing wasn't laid out: ${d.undrawn}`);
  return d;
}
