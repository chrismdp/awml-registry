"use client";

import { useEffect, useId, useRef } from "react";

// The font a drawing's own config asks for, such as "Inter, sans-serif".
export function drawingFont(text: string) {
  return /^\s*fontFamily:\s*(.+?)\s*$/m.exec(text)?.[1];
}

// Draws Mermaid text in the browser. The text stays visible until it is drawn.
// Mermaid sizes each box by measuring its label in this browser, so the font
// the drawing asks for is loaded first (Inter, served by the registry itself:
// see site.css); otherwise the boxes would fit a fallback font.
export function Mermaid({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const font = drawingFont(text);
      if (font) await document.fonts.load(`16px ${font}`).catch(() => []);
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const { svg } = await mermaid.render(id, text);
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
