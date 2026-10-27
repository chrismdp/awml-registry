// A workflow's drawing as a graph the browser lays out itself (issue #62),
// read from the Mermaid text the engine already gives the registry. The
// engine writes that text in a regular shape: a subgraph for each scope, a
// node for each part with a class for its kind, a line for each flow (solid)
// and each use of data (dotted), and a note as a notched node joined to its
// part by a plain dotted line. This reads that shape back, and nothing more:
// it is not a Mermaid parser.

export type PartKind = "trigger" | "context" | "connection" | "surface" | "outside" | "ai" | "code" | "person" | "part";

export type Part = {
  id: string;
  kind: PartKind;
  label: string;
  // A step's kind of work, such as "draft" or "sort", when its caption gives one.
  verb?: string;
  // An outside action's tier, such as "Allow" or "Ask".
  tier?: string;
  // The scope or box it is drawn in.
  scope?: string;
};

// A scope (dashed, who may see), a place a platform view puts parts (filled),
// or a workflow's box on a system's map.
export type Scope = { id: string; label: string; dashed: boolean; scope?: string };

export type LineStyle = "solid" | "dotted" | "thick";

export type Line = {
  id: string;
  from: string;
  to: string;
  style: LineStyle;
  label?: string;
  arrowStart: boolean;
  arrowEnd: boolean;
};

// A note, and the part (or scope) it belongs to.
export type Note = { id: string; text: string; on?: string };

export type Graph = { parts: Part[]; scopes: Scope[]; lines: Line[]; notes: Note[] };

const KINDS: Record<string, PartKind | "note"> = {
  trig: "trigger",
  ctx: "context",
  con: "connection",
  surf: "surface",
  out: "outside",
  ai: "ai",
  code: "code",
  person: "person",
  gap: "note",
};

// Mermaid's escapes, such as #39; for ' and #quot; for ".
const NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " " };
function unescape(text: string) {
  return text.replace(/#(\d+|[a-z]+);/g, (whole, code: string) =>
    /^\d+$/.test(code) ? String.fromCodePoint(Number(code)) : (NAMED[code] ?? whole),
  );
}

// A label as plain text: a line break as a space, any other tag left out.
function plain(html: string) {
  return unescape(html.replace(/<br\s*\/?>/g, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

// A node's text, from any of the shapes the engine draws: (["…"]), {{"…"}},
// ("…"), >"…"], [("…")], ["…"], or @{ shape: …, label: "…" }.
function nodeText(rest: string): { text: string; shape?: string } | undefined {
  const at = /^@\{\s*shape:\s*([\w-]+),\s*label:\s*"(.*)"\s*\}$/.exec(rest);
  if (at) return { text: at[2], shape: at[1] };
  const quoted = /^[[({>]+"(.*)"[\])}]+$/.exec(rest);
  return quoted ? { text: quoted[1] } : undefined;
}

// A line: a, then <?, then -- or -.- or == with more of the same, then >?,
// an optional |"label"|, then b.
const LINE = /^(\w+)\s+(<)?(-{2,}|-\.+-|={2,})(>)?(?:\|"(.*)"\|)?\s+(\w+)$/;

export function parseMermaid(text: string): Graph {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const nodes = new Map<string, { id: string; raw: string; shape?: string; scope?: string }>();
  const scopes: Scope[] = [];
  const kinds = new Map<string, string>();
  const lines: (Line & { index: number })[] = [];
  const stack: string[] = [];
  let index = 0;
  for (const raw of body.split("\n")) {
    const row = raw.trim();
    if (!row || row.startsWith("%%") || /^(flowchart|graph|direction|classDef)\b/.test(row)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^subgraph\s+(\w+)\s*\["(.*)"\]$/.exec(row))) {
      scopes.push({ id: m[1], label: plain(m[2]), dashed: false, ...(stack.length ? { scope: stack.at(-1) } : {}) });
      stack.push(m[1]);
    } else if (row === "end") stack.pop();
    else if ((m = /^class\s+([\w,]+)\s+(\w+)$/.exec(row))) for (const id of m[1].split(",")) kinds.set(id, m[2]);
    else if ((m = /^style\s+(\w+)\s+(.*)$/.exec(row))) {
      const scope = scopes.find((s) => s.id === m![1]);
      if (scope) scope.dashed = m[2].includes("stroke-dasharray");
    } else if ((m = /^linkStyle\s+([\d,]+)\s+(.*)$/.exec(row))) {
      if (!m[2].includes("marker-end:none")) continue;
      for (const i of m[1].split(",").map(Number)) {
        const l = lines.find((l) => l.index === i);
        if (l) l.arrowEnd = false;
      }
    } else if ((m = LINE.exec(row))) {
      const [, from, start, stroke, end, label, to] = m;
      lines.push({
        id: `line-${index}`,
        index: index++,
        from,
        to,
        style: stroke.startsWith("=") ? "thick" : stroke.includes(".") ? "dotted" : "solid",
        ...(label !== undefined ? { label: plain(label) } : {}),
        arrowStart: Boolean(start),
        arrowEnd: Boolean(end),
      });
    } else if ((m = /^(\w+)(.*)$/.exec(row))) {
      const t = nodeText(m[2]);
      if (t) nodes.set(m[1], { id: m[1], raw: t.text, shape: t.shape, ...(stack.length ? { scope: stack.at(-1) } : {}) });
    }
  }

  const isNote = (id: string) => kinds.get(id) === "gap" || nodes.get(id)?.shape === "notch-rect";
  const notes: Note[] = [];
  for (const n of nodes.values()) {
    if (!isNote(n.id)) continue;
    // A note is joined to its part by a dotted line with no arrows.
    const joined = lines.find((l) => (l.to === n.id || l.from === n.id) && !l.arrowStart && !l.arrowEnd);
    const on = joined ? (joined.to === n.id ? joined.from : joined.to) : n.scope;
    notes.push({ id: n.id, ...(on ? { on } : {}), text: plain(n.raw) });
  }
  const parts: Part[] = [...nodes.values()].filter((n) => !isNote(n.id)).map((n) => partOf(n, kinds.get(n.id)));
  return {
    parts,
    scopes,
    lines: lines.filter((l) => !isNote(l.from) && !isNote(l.to)).map(({ index: _, ...l }) => l),
    notes,
  };
}

function partOf(n: { id: string; raw: string; shape?: string; scope?: string }, cls: string | undefined): Part {
  const kind = (cls && KINDS[cls] !== "note" ? KINDS[cls] : undefined) ?? (n.shape === "win-pane" ? "surface" : "part");
  const part: Part = { id: n.id, kind: kind as PartKind, label: "" };
  // A step's caption: who decides it, as an emoji, and its kind of work.
  const caption = /^<small[^>]*>(.*?)<\/small><br>(.*)$/.exec(n.raw);
  if (caption) {
    const verb = /([a-z][a-z-]*)\s*$/.exec(unescape(caption[1]))?.[1];
    if (verb) part.verb = verb;
    part.label = plain(caption[2]);
  } else part.label = plain(n.raw);
  // An outside action ends with its tier: "Fill the basket: Allow under £180".
  const tier = kind === "outside" ? /^(.*): ((?:Allow|Ask|Block)\b.*)$/.exec(part.label) : null;
  if (tier) {
    part.label = tier[1];
    part.tier = tier[2];
  }
  if (n.scope) part.scope = n.scope;
  return part;
}

const STEPS: PartKind[] = ["ai", "code", "person"];

// Flow only (#51): the drawing without its contexts and dotted lines, so only
// the workflow's own lines show. A part no line is left to goes too, unless it
// is a step; scopes all stay. The notes of the parts that go, go with them.
export function flowOnly(g: Graph): Graph {
  const kept = g.parts.filter((p) => p.kind !== "context");
  const keptIds = new Set(kept.map((p) => p.id).concat(g.scopes.map((s) => s.id)));
  const lines = g.lines.filter((l) => l.style !== "dotted" && keptIds.has(l.from) && keptIds.has(l.to));
  const joined = new Set(lines.flatMap((l) => [l.from, l.to]));
  const parts = kept.filter((p) => STEPS.includes(p.kind) || p.kind === "trigger" || joined.has(p.id));
  const ids = new Set(parts.map((p) => p.id).concat(g.scopes.map((s) => s.id)));
  return {
    parts,
    scopes: g.scopes,
    lines: lines.filter((l) => ids.has(l.from) && ids.has(l.to)),
    notes: g.notes.filter((n) => n.on && ids.has(n.on)),
  };
}

// On a system's map, each trigger drawn inside its workflow's box is drawn
// outside it instead, with a line into the box (#61). The engine will do this
// itself (chrismdp/awml#122); until then the registry does.
export function triggersOutside(g: Graph): Graph {
  const boxes = new Set(g.scopes.filter((s) => !s.dashed).map((s) => s.id));
  const moving = g.parts.filter((p) => p.kind === "trigger" && p.scope && boxes.has(p.scope));
  if (moving.length === 0) return g;
  return {
    ...g,
    parts: g.parts.map((p) => (moving.includes(p) ? { ...p, scope: undefined } : p)),
    lines: [
      ...g.lines,
      ...moving.map((p) => ({ id: `into-${p.id}`, from: p.id, to: p.scope!, style: "solid" as const, arrowStart: false, arrowEnd: true })),
    ],
  };
}
