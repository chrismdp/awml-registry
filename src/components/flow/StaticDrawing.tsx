import "./flow.css";
import type { PartLink } from "@/server/part-links";
import { destination, hrefOf, NEW_TAB } from "../links";
import type { Drawing, Note } from "./drawing";
import { Arrowheads, LabelGraphic, LineGraphic, NoteIcon, PartGraphic, roundedPath, ScopeGraphic } from "./Graphic";
import { MAX_ZOOM } from "../viewport";

// A drawing as one SVG, scaled to fit whatever holds it, as the server sends
// it: a browser with no scripts sees it whole, a link on a part or a box
// works, and a note shows on hover. It is also the gallery's thumbnail. On a
// page that runs scripts, React Flow takes over from it (Drawing.tsx). Its
// links open in a new tab when `newTab`, as in a drawing embedded on another
// site (#75).
export function StaticDrawing({
  drawing,
  id,
  links = [],
  hrefs = {},
  label,
  hidden = false,
  defs = true,
  newTab = false,
}: {
  drawing: Drawing;
  // A name no other drawing on the page has, for its arrowheads.
  id: string;
  links?: PartLink[];
  hrefs?: Record<string, string>;
  label?: string;
  hidden?: boolean;
  // Whether it holds its own arrowheads. A page's drawing keeps them in an SVG
  // of their own, which React Flow's lines use too: an arrowhead takes its
  // visibility from where it is defined, so it can't be in an SVG React Flow hides.
  defs?: boolean;
  newTab?: boolean;
}) {
  const { box } = drawing;
  const target = newTab ? NEW_TAB : {};
  const notes = notesBy(drawing.notes);
  const linked = new Map(links.map((l) => [l.part, l]));
  const scopes = [...drawing.scopes].sort((a, b) => a.depth - b.depth);
  return (
    <svg
      className="flow-static"
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ maxWidth: box.width * MAX_ZOOM, maxHeight: box.height * MAX_ZOOM, ...(hidden ? { visibility: "hidden" } : {}) }}
      aria-label={label}
      aria-hidden={hidden || undefined}
    >
      {defs && <Arrowheads id={id} />}
      {scopes.map((s) => {
        const href = hrefOf(hrefs, s.id);
        const graphic = <ScopeGraphic scope={s} href={href} />;
        return (
          <g key={s.id} transform={`translate(${s.x}, ${s.y})`} data-scope={s.id} data-in={s.scope}>
            {href ? (
              <a href={href} aria-label={`Open ${s.lines.join(" ") || s.name}`} {...target}>
                {graphic}
              </a>
            ) : (
              graphic
            )}
            {notes.get(s.id) && <Notes notes={notes.get(s.id)!} at={{ x: s.width - 3, y: s.height - 3 }} />}
          </g>
        );
      })}
      {drawing.lines.map((l) => (
        <LineGraphic key={l.id} id={id} line={l} d={roundedPath(l.points)} />
      ))}
      {drawing.lines.map((l) => l.label && <LabelGraphic key={l.id} label={l.label} at={l.label} style={l.style} />)}
      {drawing.parts.map((p) => {
        const link = linked.get(p.id);
        const to = link ? destination(link) : null;
        const graphic = <PartGraphic part={p} link={link} />;
        return (
          <g key={p.id} transform={`translate(${p.x}, ${p.y})`} data-part={p.id} data-in={p.scope}>
            {link && <title>{link.title}</title>}
            {to && to !== "menu" ? (
              <a href={to} aria-label={`${p.lines.join(" ")}. ${link!.title.split("\n").join(". ")}`} {...target}>
                {graphic}
              </a>
            ) : (
              graphic
            )}
            {notes.get(p.id) && <Notes notes={notes.get(p.id)!} at={{ x: p.width - 3, y: p.height - 3 }} />}
          </g>
        );
      })}
      {drawing.notesAt && <Notes notes={wholeNotes(drawing.notes)} at={drawing.notesAt} />}
    </svg>
  );
}

// A part's notes behind its icon, read as a tooltip; a warning mark when one is a gap.
function Notes({ notes, at }: { notes: Note[]; at: { x: number; y: number } }) {
  const gap = notes.some((n) => n.gap);
  return (
    <g className="flow-note" transform={`translate(${at.x}, ${at.y})`} data-note={notes.map((n) => n.id).join(" ")} data-gap={gap || undefined}>
      <title>{notes.map((n) => n.text).join("\n\n")}</title>
      <NoteIcon count={notes.length} gap={gap} />
    </g>
  );
}

// Each part's notes, and each scope's, by what they belong to.
// The notes of the whole drawing, tied to nothing in it, which share one icon.
export const wholeNotes = (notes: Note[]) => notes.filter((n) => !n.on);

export function notesBy(notes: Note[]) {
  const by = new Map<string, Note[]>();
  for (const n of notes) if (n.on) by.set(n.on, [...(by.get(n.on) ?? []), n]);
  return by;
}
