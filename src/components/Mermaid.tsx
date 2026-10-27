"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";

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

// Each drawing this page has made, by its text, so a tab opened again shows
// its drawing at once, without Mermaid drawing it again.
const drawings = new Map<string, string>();

// The drawing of `text` already made in this page, if there is one.
export const drawingOf = (text: string) => drawings.get(text);

// Mermaid sizes each box by measuring its label in this browser, so the font the
// drawing asks for is loaded first (Inter, served by the registry itself: see
// site.css); otherwise the boxes would fit a fallback font. Mermaid itself
// loads meanwhile.
export async function drawMermaid(id: string, text: string) {
  const made = drawings.get(text);
  if (made !== undefined) return made;
  const font = drawingFont(text);
  const loading = import("mermaid");
  if (font) await document.fonts.load(`16px ${font}`).catch(() => []);
  const { default: mermaid } = await loading;
  mermaid.initialize({ ...DRAWN_LIKE_AWML.config });
  const { svg } = await mermaid.render(id, text);
  drawings.set(text, svg);
  return svg;
}

// Draws Mermaid text in the browser. The text is in the page for a browser
// that runs no scripts; site.css hides it in a workflow's frame while it is
// drawn. A drawing this page has made before is shown before the browser
// paints. `onDrawn` is told when the drawing has replaced the text.
export function Mermaid({ text, onDrawn }: { text: string; onDrawn?: (drawing: HTMLDivElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drawn = useRef(onDrawn);
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    drawn.current = onDrawn;
  });
  useLayoutEffect(() => {
    let cancelled = false;
    const show = (svg: string) => {
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = svg;
      drawn.current?.(ref.current);
    };
    const made = drawingOf(text);
    if (made !== undefined) show(made);
    else drawMermaid(id, text).then(show);
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
