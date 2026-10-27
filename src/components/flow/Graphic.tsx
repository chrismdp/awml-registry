import type { PartLink } from "@/server/part-links";
import {
  BOX,
  BOX_NAME,
  CAPTION,
  LABEL,
  LINE_LABEL,
  outline,
  PADDING,
  SCOPE_TITLE,
  SCOPE_WHO,
  TIER,
  type DrawnLabel,
  type DrawnLine,
  type DrawnPart,
  type DrawnScope,
  type Point,
} from "./drawing";
import { baseline, textWidth } from "./text";

// The pieces of a drawing as SVG, each at its own origin: the same markup
// whether the server draws the whole drawing as one SVG (StaticDrawing.tsx)
// or React Flow draws each piece in its own box (FlowCanvas.tsx), so the one
// takes over from the other without a pixel moving. Every label is drawn line
// by line as the server broke it, so no browser breaks it differently.

// A part: its outline, its kind and verb small above its label, an outside
// action's tier, and the mark of a part linked to other workflows (#55).
export function PartGraphic({ part, link }: { part: DrawnPart; link?: PartLink }) {
  const { d, extra } = outline(part.kind, part.width, part.height);
  const [top, , , left] = PADDING[part.kind];
  let y = top;
  const caption = part.caption ? (
    <text className="flow-caption" x={left} y={y + baseline(CAPTION.size, CAPTION.line)} fontSize={CAPTION.size}>
      {part.caption}
    </text>
  ) : null;
  if (part.caption) y += CAPTION.line + CAPTION.gap;
  const labelTop = y;
  y += part.lines.length * LABEL.line;
  const tierTop = y + TIER.gap;
  return (
    <g className={`flow-part flow-kind-${part.kind}`}>
      <path className="flow-shape" d={d} />
      {extra && <path className="flow-shape-line" d={extra} />}
      {caption}
      <text className="flow-label" fontSize={LABEL.size}>
        {part.lines.map((line, i) => (
          <tspan key={i} x={left} y={labelTop + i * LABEL.line + baseline(LABEL.size, LABEL.line)}>
            {line}
          </tspan>
        ))}
      </text>
      {part.tier && (
        <g className="flow-tier">
          <rect x={left} y={tierTop} width={textWidth(part.tier, TIER.size) + 2 * TIER.padding} height={TIER.height} rx={TIER.height / 2} />
          <text x={left + TIER.padding} y={tierTop + baseline(TIER.size, TIER.height)} fontSize={TIER.size}>
            {part.tier}
          </text>
        </g>
      )}
      {link && <LinkMark x={part.width - 10} y={10} off={link.to.length === 0} />}
    </g>
  );
}

// The small chain mark in a linked part's top-right corner.
function LinkMark({ x, y, off }: Point & { off: boolean }) {
  return (
    <g className={`part-link-mark${off ? " off" : ""}`} transform={`translate(${x}, ${y})`} aria-hidden="true">
      <circle r={9} />
      {[-6, -1].map((rx) => (
        <rect key={rx} x={rx} y={-2.5} width={7} height={5} rx={2.5} transform="rotate(-45)" />
      ))}
    </g>
  );
}

// A scope: a soft card holding its parts, its name and who it is for in its
// top corner. One that holds nothing, such as a workflow's box on a system's
// map, has its name inside it, with an arrow when it opens a page.
export function ScopeGraphic({ scope, href, hull }: { scope: DrawnScope; href?: string; hull?: boolean }) {
  const kind = scope.dashed ? "dashed" : scope.fill && !href ? "place" : "box";
  const style = kind === "place" ? { fill: scope.fill, stroke: scope.stroke } : undefined;
  const r = scope.holds ? 22 : 18;
  const whoTop = SCOPE_TITLE.top + SCOPE_TITLE.line + SCOPE_WHO.gap;
  const title = scope.holds ? (
    <>
      <text className="flow-scope-name" x={SCOPE_TITLE.left} y={SCOPE_TITLE.top + baseline(SCOPE_TITLE.size, SCOPE_TITLE.line)} fontSize={SCOPE_TITLE.size}>
        {scope.name}
      </text>
      {scope.who && (
        <text className="flow-scope-who" fontSize={SCOPE_WHO.size}>
          {scope.who.map((line, i) => (
            <tspan key={i} x={SCOPE_TITLE.left} y={whoTop + i * SCOPE_WHO.line + baseline(SCOPE_WHO.size, SCOPE_WHO.line)}>
              {line}
            </tspan>
          ))}
        </text>
      )}
    </>
  ) : (
    <>
      <text className="flow-caption" x={BOX.padX} y={BOX.padY + baseline(CAPTION.size, CAPTION.line)} fontSize={CAPTION.size}>
        {scope.dashed ? "Scope" : "Workflow"}
      </text>
      <text className="flow-box-name" fontSize={BOX_NAME.size}>
        {scope.lines.map((line, i) => (
          <tspan key={i} x={BOX.padX} y={BOX.padY + CAPTION.line + CAPTION.gap + i * BOX_NAME.line + baseline(BOX_NAME.size, BOX_NAME.line)}>
            {line}
            {href && i === scope.lines.length - 1 && <tspan className="flow-box-go">{" →"}</tspan>}
          </tspan>
        ))}
      </text>
    </>
  );
  return (
    <g className={`flow-scope ${kind} depth-${scope.depth % 2}${hull ? " hull" : ""}${href ? " linked" : ""}`}>
      <rect className="flow-scope-card" x={0.75} y={0.75} width={Math.max(0, scope.width - 1.5)} height={Math.max(0, scope.height - 1.5)} rx={r} style={style} />
      {title}
    </g>
  );
}

// A line along its points, its corners rounded.
export function roundedPath(points: Point[], radius = 10) {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    if (!ab || !bc) continue;
    const r = Math.min(radius, ab / 2, bc / 2);
    const p = { x: b.x - ((b.x - a.x) / ab) * r, y: b.y - ((b.y - a.y) / ab) * r };
    const q = { x: b.x + ((c.x - b.x) / bc) * r, y: b.y + ((c.y - b.y) / bc) * r };
    d += ` L ${p.x} ${p.y} Q ${b.x} ${b.y} ${q.x} ${q.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

// The arrowheads a drawing's lines use, by `id` so two drawings on a page keep their own.
const ARROWS = ["solid", "dotted", "thick", "broken"] as const;
export const arrowOf = (id: string, line: Pick<DrawnLine, "style" | "broken">) => `${id}-arrow-${line.broken ? "broken" : line.style}`;
export function Arrowheads({ id }: { id: string }) {
  return (
    <defs>
      {ARROWS.map((kind) => (
        <marker
          key={kind}
          id={`${id}-arrow-${kind}`}
          className={`flow-arrow ${kind}`}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={kind === "thick" || kind === "broken" ? 9 : 11}
          markerHeight={kind === "thick" || kind === "broken" ? 9 : 11}
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      ))}
    </defs>
  );
}

// A line: solid for the workflow's own flow, dotted for data, thick for a
// standing rule, red for one that breaks a rule.
export function LineGraphic({ id, line, d }: { id: string; line: DrawnLine; d: string }) {
  const arrow = `url(#${arrowOf(id, line)})`;
  return (
    <path
      className={`flow-line ${line.style}${line.broken ? " broken" : ""}`}
      d={d}
      markerEnd={line.arrowEnd ? arrow : undefined}
      markerStart={line.arrowStart ? arrow : undefined}
    />
  );
}

// A line's label: a pill centred on its line.
export function LabelGraphic({ label, at, style }: { label: DrawnLabel; at: Point; style: string }) {
  const top = at.y - label.height / 2;
  return (
    <g className={`flow-line-label ${style}`}>
      <rect x={at.x - label.width / 2} y={top} width={label.width} height={label.height} rx={Math.min(label.height / 2, 11)} />
      <text textAnchor="middle" fontSize={LINE_LABEL.size}>
        {label.lines.map((line, i) => (
          <tspan key={i} x={at.x} y={top + LINE_LABEL.padY + i * LINE_LABEL.line + baseline(LINE_LABEL.size, LINE_LABEL.line)}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

// A part's note mark (#60): a small round note icon, centred at its bottom right.
export const NOTE_R = 12;
export function NoteIcon({ count }: { count: number }) {
  return (
    <g className="flow-note-icon">
      <circle r={NOTE_R} />
      <g transform="translate(-7, -7)">
        <path d="M3 1.5h5.5L11 4v8.5H3z" fill="none" />
        <path d="M5 6.5h4M5 9h4" />
      </g>
      {count > 1 && (
        <text x={NOTE_R + 2} y={4} fontSize={11}>
          {count}
        </text>
      )}
    </g>
  );
}
