import "./embed.css";
import type { ReactNode } from "react";
import type { EmbedProps } from "@/server/embed";
import { Drawing } from "./Drawing";
import { NEW_TAB } from "./links";
import { count } from "./words";

// A public workflow's drawing or a system's map, embedded on another site
// (#75), or shown inline by awml.io's home page: the drawing alone, filling
// whatever holds it, with pan, zoom, Fit and Flow only, in a compact frame,
// and a link to the item's page in its bottom right corner. Every link in it
// opens a new tab, never the frame. Its props come from workflowEmbed or
// systemEmbed (src/server/embed.ts).
export function EmbeddedDrawing(p: EmbedProps) {
  return (
    <div className="embed">
      {p.drawing ? (
        <Drawing drawings={p.drawing} links={p.links} hrefs={p.hrefs} startFlowOnly={p.flow} newTab compact />
      ) : (
        <p className="embed-message">
          {p.message}
          {p.mistakes?.map((m, i) => (
            <span key={i} className="embed-mistake">
              {m}
            </span>
          ))}
        </p>
      )}
      <div className="embed-corner">
        {p.hidden > 0 && <p className="embed-hidden">{count(p.hidden, "private workflow", "private workflows")} left out</p>}
        <a className="embed-link" href={p.href} {...NEW_TAB}>
          <span className="embed-title">{p.title}</span> · {p.host}
        </a>
      </div>
    </div>
  );
}

// An embed page (#75), whose drawing fills the browser's window, or the
// frame another site gives it.
export function EmbedLayout({ children }: { children: ReactNode }) {
  return <div className="embed-page">{children}</div>;
}
