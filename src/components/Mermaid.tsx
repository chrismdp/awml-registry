"use client";

import { useEffect, useId, useRef } from "react";

// AWML draws its own examples with examples/render.sh: @mermaid-js/mermaid-cli
// 11.4.1, which draws with mermaid 11.17.2 (the newest its "^11.0.2" allows) and
// calls mermaid.initialize({ startOnLoad: false, theme: "default" }). The registry
// installs that same mermaid (package.json pins it) and passes that same config, so
// a workflow page draws like AWML's own SVGs. Mermaid 12 lays flowcharts out with
// ELK by default, whose square-cornered lines kink and detour; 11 lays them out
// with dagre. securityLevel "strict" is Mermaid 11's default, written out so it
// stays strict whatever Mermaid's default becomes.
export const DRAWN_LIKE_AWML = {
  mermaid: "11.17.2",
  config: { startOnLoad: false, theme: "default", securityLevel: "strict" },
} as const;

// The font a drawing's own config asks for, such as "Inter, sans-serif".
export function drawingFont(text: string) {
  return /^\s*fontFamily:\s*(.+?)\s*$/m.exec(text)?.[1];
}

// Mermaid sizes each box by measuring its label in this browser, so the font the
// drawing asks for is loaded first (Inter, served by the registry itself: see
// site.css); otherwise the boxes would fit a fallback font.
export async function drawMermaid(id: string, text: string) {
  const font = drawingFont(text);
  if (font) await document.fonts.load(`16px ${font}`).catch(() => []);
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ ...DRAWN_LIKE_AWML.config });
  const { svg } = await mermaid.render(id, text);
  return svg;
}

// Draws Mermaid text in the browser. The text stays visible until it is drawn.
export function Mermaid({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const svg = await drawMermaid(id, text);
      if (!cancelled && ref.current) ref.current.innerHTML = svg;
    })();
    return () => {
      cancelled = true;
    };
  }, [id, text]);
  return (
    <div ref={ref} className="drawing">
      <pre>{text}</pre>
    </div>
  );
}
