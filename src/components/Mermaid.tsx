"use client";

import { useEffect, useId, useRef } from "react";

// Draws Mermaid text in the browser. The text stays visible until it is drawn.
export function Mermaid({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    let cancelled = false;
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      const { svg } = await mermaid.render(id, text);
      if (!cancelled && ref.current) ref.current.innerHTML = svg;
    });
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
