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

// The drawings this page has made, by their text, so a tab opened again shows
// its drawing at once, without Mermaid drawing it again: the most recently
// used KEPT_DRAWINGS of them, each with the id Mermaid drew it with.
export const KEPT_DRAWINGS = 50;
const drawings = new Map<string, { id: string; svg: string }>();

// Keeps the drawing of `text` as the one used most recently, letting go of
// the one used longest ago once there are more than KEPT_DRAWINGS.
function keep(text: string, id: string, svg: string) {
  drawings.delete(text);
  drawings.set(text, { id, svg });
  if (drawings.size > KEPT_DRAWINGS) drawings.delete(drawings.keys().next().value!);
}

// The drawing of `text` already made in this page, if it is kept. Mermaid
// names a drawing's elements after the id it draws it with, so the drawing
// comes back with the ids of `id`, the frame it goes in: two drawings of one
// text on a page then don't share element ids.
export function drawingOf(text: string, id: string) {
  const made = drawings.get(text);
  if (!made) return undefined;
  keep(text, made.id, made.svg);
  return made.id === id ? made.svg : made.svg.replaceAll(made.id, id);
}

// Mermaid sizes each box by measuring its label in this browser, so the font the
// drawing asks for is loaded first (Inter, served by the registry itself: see
// site.css); otherwise the boxes would fit a fallback font. Mermaid itself
// loads meanwhile.
export async function drawMermaid(id: string, text: string) {
  const made = drawingOf(text, id);
  if (made !== undefined) return made;
  const font = drawingFont(text);
  const loading = import("mermaid");
  if (font) await document.fonts.load(`16px ${font}`).catch(() => []);
  const { default: mermaid } = await loading;
  mermaid.initialize({ ...DRAWN_LIKE_AWML.config });
  const { svg } = await mermaid.render(id, text);
  keep(text, id, svg);
  return svg;
}

// The element a drawing goes in: the text is in it until the drawing replaces
// it, and its class "failed" says Mermaid couldn't draw it.
type Frame = { innerHTML: string; classList: { add(name: string): void; remove(name: string): void } };

// Draws `text` into `frame`, and tells `onDrawn` when the drawing has replaced
// the text. A drawing this page made before goes in at once. When Mermaid
// can't draw the text, the frame is marked failed, so site.css shows the text
// again rather than an empty frame. Gives back what stops it, for a frame
// that has gone.
export function drawInto<F extends Frame>(frame: F, id: string, text: string, onDrawn?: (frame: F) => void) {
  let stopped = false;
  frame.classList.remove("failed");
  const show = (svg: string) => {
    if (stopped) return;
    frame.innerHTML = svg;
    onDrawn?.(frame);
  };
  const made = drawingOf(text, id);
  if (made !== undefined) show(made);
  else
    drawMermaid(id, text).then(show, () => {
      if (!stopped) frame.classList.add("failed");
    });
  return () => {
    stopped = true;
  };
}

// Draws Mermaid text in the browser. The text is in the page for a browser
// that runs no scripts; site.css hides it in a workflow's frame while it is
// drawn, and shows it again if Mermaid can't draw it. A drawing this page has
// made before is shown before the browser paints. `onDrawn` is told when the
// drawing has replaced the text.
export function Mermaid({ text, onDrawn }: { text: string; onDrawn?: (drawing: HTMLDivElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drawn = useRef(onDrawn);
  // A name no label would hold, since a drawing kept for another frame has
  // every use of its frame's id swapped for this one.
  const id = "drawing-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    drawn.current = onDrawn;
  });
  useLayoutEffect(() => drawInto(ref.current!, id, text, (frame) => drawn.current?.(frame)), [id, text]);
  return (
    <div ref={ref} className="drawing">
      <pre>{text}</pre>
    </div>
  );
}
