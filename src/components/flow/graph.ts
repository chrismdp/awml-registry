// A workflow's drawing as a graph the server lays out (issue #62), read from
// the engine's own model of what it draws: `graph`, which gives the parts,
// the boxes, the lines and the comments as data, with nothing laid out (AWML
// 0.7.1, issue #69). Every text field the engine gives is exactly as the file
// wrote it, unescaped, line breaks included, so it reaches the page only as
// React text or an attribute React escapes: never as HTML, and never in SVG
// built from strings.

export type PartKind = "trigger" | "context" | "connection" | "surface" | "outside" | "ai" | "code" | "person" | "part";

export type Part = {
  id: string;
  kind: PartKind;
  label: string;
  // A step's kind of work, such as "draft" or "sort", or "review" for a review.
  verb?: string;
  // An outside action's tier, such as "Allow" or "Ask under £50".
  tier?: string;
  // The scope or box it is drawn in.
  scope?: string;
  // Marked untrusted in the file: its text may not be what it seems.
  untrusted?: boolean;
};

// A scope (dashed, who may see), a place a platform view puts parts (filled,
// in the colours the engine gives each place), or a workflow's box on a
// system's map, which names the workflow as owner/slug.
export type Scope = {
  id: string;
  label: string;
  dashed: boolean;
  scope?: string;
  fill?: string;
  stroke?: string;
  workflow?: string;
};

export type LineStyle = "solid" | "dotted" | "thick";

export type Line = {
  id: string;
  from: string;
  to: string;
  style: LineStyle;
  label?: string;
  arrowStart: boolean;
  arrowEnd: boolean;
  // A line that breaks a rule, which the engine draws red.
  broken?: boolean;
  // A read the design refuses, which ends in a cross.
  refused?: boolean;
};

// A note, and the part (or scope) it belongs to: a note tied to several
// parts is given once for each, and one tied to none belongs to its scope,
// or, in none, to the whole drawing. A gap, a comment saying what is
// "Missing from the design", is a finding: tied to nothing, it belongs to the
// whole drawing.
export type Note = { id: string; text: string; on?: string; gap?: true };

export type Graph = { parts: Part[]; scopes: Scope[]; lines: Line[]; notes: Note[] };

// The engine's graph, as `awml graph` and the WebAssembly's graphJSON give
// it (AWML's spec, "awml graph"). A field a part, group or line doesn't have
// is left out.
export type EngineGraph = {
  view: string;
  groups: { id: string; label: string; in?: string; file?: string; published?: string }[];
  parts: {
    id: string;
    kind: string;
    label: string;
    in?: string;
    decider?: string;
    op?: string;
    tier?: string;
    untrusted?: boolean;
  }[];
  lines: {
    from: string;
    to: string;
    kind: string;
    label?: string;
    points: string;
    publishes?: boolean;
    widens?: string[];
    breaks?: string[];
  }[];
  comments: { id: string; label: string; in?: string; gap: boolean; ties: string[] }[];
  places: { id: string; fill: string; stroke: string }[];
};

const KINDS: Record<string, PartKind> = {
  trigger: "trigger",
  context: "context",
  connector: "connection",
  surface: "surface",
  outside: "outside",
  ai: "ai",
  code: "code",
  person: "person",
  review: "person",
  approval: "person",
};

// What a review or a standing approval does, said where a step says its kind of work.
const VERBS: Record<string, string> = { review: "review", approval: "standing approval" };

// The parts a line is dotted into or out of, since what they hold sits beside
// the path the work takes, as the engine draws it.
const BESIDE = new Set(["context", "connector", "surface"]);

// A label as one line: each run of whitespace, line breaks included, one
// space, as the engine's own drawing folds it.
const folded = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();

// A colour, when it is one: only a hex colour is taken, so nothing but a
// colour reaches the page's styles.
const colour = (value: unknown) => (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value.toLowerCase() : undefined);

// The workflow a map's box is, as owner/slug: the name a ref gives it, or the
// path the registry gave it at, which ends owner/slug.yaml.
function workflowOf(group: EngineGraph["groups"][number]) {
  if (group.published) return group.published;
  const m = /(?:^|\/)([^/]+)\/([^/]+)\.yaml$/.exec(group.file ?? "");
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// The registry's graph of the engine's: its parts with their kinds, a step's
// kind of work and an outside action's tier; its scopes with their nesting,
// a platform view's colours and a map's workflows; the lines drawn, each with
// its style and which ends have arrows; and the comments as notes on what
// they are tied to. A tie and a hidden line aren't drawn, and nor is a line
// one of whose ends isn't.
export function readGraph(g: EngineGraph): Graph {
  const groups = new Set(g.groups.map((s) => s.id));
  const places = new Map(g.places.map((p) => [p.id, p]));
  const dashed = g.view === "security" || g.view === "untrusted";
  const scopes: Scope[] = g.groups.map((s) => {
    const place = places.get(s.id);
    const fill = colour(place?.fill);
    const stroke = colour(place?.stroke);
    const workflow = g.view === "map" ? workflowOf(s) : undefined;
    return {
      id: s.id,
      label: folded(s.label),
      dashed,
      ...(s.in && groups.has(s.in) ? { scope: s.in } : {}),
      ...(fill && stroke ? { fill, stroke } : {}),
      ...(workflow ? { workflow } : {}),
    };
  });
  const kinds = new Map(g.parts.map((p) => [p.id, p.kind]));
  const parts: Part[] = g.parts.map((p) => {
    const part: Part = { id: p.id, kind: KINDS[p.kind] ?? "part", label: folded(p.label) };
    const verb = p.kind === "ai" || p.kind === "code" || p.kind === "person" ? p.op : VERBS[p.kind];
    if (verb) part.verb = folded(verb);
    // An outside action's label ends with its tier, after its last colon:
    // "Fill the basket: Allow under £180".
    if (p.tier) {
      const colon = part.label.lastIndexOf(":");
      part.tier = colon < 0 ? folded(p.tier) : part.label.slice(colon + 1).trim();
      if (colon >= 0) part.label = part.label.slice(0, colon).trim();
    }
    if (p.in && groups.has(p.in)) part.scope = p.in;
    if (p.untrusted) part.untrusted = true;
    return part;
  });
  const ends = new Set([...kinds.keys(), ...groups]);
  const lines: Line[] = [];
  for (const l of g.lines) {
    if (l.kind === "tie" || l.kind === "hidden" || !ends.has(l.from) || !ends.has(l.to)) continue;
    const said = [folded(l.label), ...(l.widens ?? []).map(folded)].filter(Boolean).join(" · ");
    const label = [said, ...(l.breaks ?? []).map(folded)].filter(Boolean).join(" · ");
    const style: LineStyle = l.publishes
      ? "thick"
      : BESIDE.has(kinds.get(l.from) ?? "") || BESIDE.has(kinds.get(l.to) ?? "")
        ? "dotted"
        : "solid";
    const refused = l.kind === "refused";
    lines.push({
      id: `line-${lines.length}`,
      from: l.from,
      to: l.to,
      style,
      ...(label ? { label } : {}),
      arrowStart: l.points === "both",
      arrowEnd: !refused && (l.points === "to" || l.points === "both"),
      ...(l.breaks?.length ? { broken: true } : {}),
      ...(refused ? { refused: true } : {}),
    });
  }
  const notes: Note[] = [];
  for (const c of g.comments) {
    const text = folded(c.label);
    const gap = c.gap ? { gap: true as const } : {};
    const tied = [...new Set(c.ties)].filter((id) => ends.has(id));
    for (const on of tied) notes.push({ id: c.id, text, on, ...gap });
    if (tied.length) continue;
    // A gap tied to nothing is a finding about the whole drawing.
    if (!c.gap && c.in && groups.has(c.in)) notes.push({ id: c.id, text, on: c.in });
    else notes.push({ id: c.id, text, ...gap });
  }
  return { parts, scopes, lines, notes };
}

// The engine's graph JSON as the registry's graph.
export const graphOf = (json: string) => readGraph(JSON.parse(json) as EngineGraph);

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
    notes: g.notes.filter((n) => !n.on || ids.has(n.on)),
  };
}
