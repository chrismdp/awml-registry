import type { ShownRef } from "./refs";
import type { Referrer } from "./registry";

// A part of the drawing linked to other workflows: by its own ref, or by the
// refs of workflows that refer to it. `title` is its tooltip, and `to` each
// workflow the viewer may follow it to; none for a ref to a workflow they
// can't see, or one not pushed yet. The drawing marks it (see
// src/components/PartLinks.tsx).
export type PartLink = { part: string; title: string; to: { label: string; href: string }[] };

// "a", "a and b", "a, b and c".
const listed = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// Each part a workflow's drawing marks, from its refs as the viewer may know
// them and the referrers the viewer may see, so it names nothing they can't.
// `kinds` are the kinds of the workflow's parts: an outside action whose ref
// names another workflow's trigger starts that workflow (AWML 0.7). A trigger
// another workflow refers to from an outside action, which a referrer's
// `starts` names, is started by it; any other referrer uses it.
export function partLinks(refs: ShownRef[], referredBy: Referrer[], kinds: Map<string, string> = new Map()): PartLink[] {
  const links = new Map<string, { lines: string[]; to: PartLink["to"]; usedBy: string[]; startedBy: string[] }>();
  const at = (part: string) => {
    if (!links.has(part)) links.set(part, { lines: [], to: [], usedBy: [], startedBy: [] });
    return links.get(part)!;
  };
  for (const r of refs) {
    const link = at(r.part);
    const linked = kinds.get(r.part) === "outside" ? "Starts" : "Linked to";
    if (r.state === "hidden") link.lines.push(`${linked} a workflow you can't see`);
    else if (r.state === "missing") link.lines.push(`${linked} ${r.owner}/${r.slug}#${r.id}, not pushed yet`);
    else {
      link.lines.push(`${linked} ${r.owner}/${r.slug}#${r.id}`);
      link.to.push({ label: `${r.owner}/${r.slug}`, href: `/${r.owner}/${r.slug}#${encodeURIComponent(r.id)}` });
    }
  }
  for (const r of referredBy)
    for (const part of r.parts) {
      const link = at(part);
      const starts = r.starts?.includes(part) && kinds.get(part) === "trigger";
      (starts ? link.startedBy : link.usedBy).push(`${r.owner}/${r.slug}`);
      link.to.push({ label: `${r.owner}/${r.slug}`, href: `/${r.owner}/${r.slug}` });
    }
  return [...links].map(([part, l]) => ({
    part,
    title: [
      ...l.lines,
      ...(l.startedBy.length ? [`Started by ${listed(l.startedBy)}`] : []),
      ...(l.usedBy.length ? [`Used by ${listed(l.usedBy)}`] : []),
    ].join("\n"),
    to: l.to,
  }));
}
