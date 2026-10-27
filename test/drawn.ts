// What a page draws, read from the SVG the server sends (src/components/flow/StaticDrawing.tsx),
// and what the engine's Mermaid text says it should draw, the same way: each scope and each part
// by id, with the scope it is in, so the security view and a platform view of one file, or two
// implementations, tell apart.
import { parseMermaid } from "@/components/flow/graph";

const placed = (id: string, scope?: string) => (scope ? `${id}@${scope}` : id);

// The scopes and parts of a page's drawing, or null when it draws nothing.
export function drawing(html: string) {
  const svg = /<svg class="flow-static"[^]*?<\/svg>/.exec(html)?.[0];
  if (!svg) return null;
  const read = (attr: string) =>
    [...svg.matchAll(new RegExp(`<g [^>]*\\b${attr}="([^"]+)"(?: data-in="([^"]+)")?`, "g"))].map((m) => placed(m[1], m[2])).sort();
  return { scopes: read("data-scope"), parts: read("data-part") };
}

// The scopes and parts the engine's Mermaid text has, notes left out, as a page draws them.
export function drawnFrom(mermaid: string) {
  const g = parseMermaid(mermaid);
  return {
    scopes: g.scopes.map((s) => placed(s.id, s.scope)).sort(),
    parts: g.parts.map((p) => placed(p.id, p.scope)).sort(),
  };
}
