import type { KeyboardEvent } from "react";
import type { Referrer } from "@/server/registry";
import type { ShownRef } from "@/server/refs";

// A part of the drawing linked to other workflows: by its own ref, or by the
// refs of workflows that refer to it. `title` is its tooltip, and `to` each
// workflow the viewer may follow it to; none for a ref to a workflow they
// can't see, or one not pushed yet.
export type PartLink = { part: string; title: string; to: { label: string; href: string }[] };

const PART = /^[A-Za-z][A-Za-z0-9_]*$/;
const SVG = "http://www.w3.org/2000/svg";

// "a", "a and b", "a, b and c".
const listed = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// Each part a workflow's drawing marks, from its refs as the viewer may know
// them and the referrers the viewer may see, so it names nothing they can't.
export function partLinks(refs: ShownRef[], referredBy: Referrer[]): PartLink[] {
  const links = new Map<string, { lines: string[]; to: PartLink["to"]; usedBy: string[] }>();
  const at = (part: string) => {
    if (!links.has(part)) links.set(part, { lines: [], to: [], usedBy: [] });
    return links.get(part)!;
  };
  for (const r of refs) {
    const link = at(r.part);
    if (r.state === "hidden") link.lines.push("Linked to a workflow you can't see");
    else if (r.state === "missing") link.lines.push(`Linked to ${r.owner}/${r.slug}#${r.id}, not pushed yet`);
    else {
      link.lines.push(`Linked to ${r.owner}/${r.slug}#${r.id}`);
      link.to.push({ label: `${r.owner}/${r.slug}`, href: `/${r.owner}/${r.slug}#${encodeURIComponent(r.id)}` });
    }
  }
  for (const r of referredBy)
    for (const part of r.parts) {
      const link = at(part);
      link.usedBy.push(`${r.owner}/${r.slug}`);
      link.to.push({ label: `${r.owner}/${r.slug}`, href: `/${r.owner}/${r.slug}` });
    }
  return [...links].map(([part, l]) => ({
    part,
    title: [...l.lines, ...(l.usedBy.length ? [`Used by ${listed(l.usedBy)}`] : [])].join("\n"),
    to: l.to,
  }));
}

// Where following a marked part goes: straight to its one workflow, a menu
// of several, or nowhere.
export function destination(link: PartLink): string | "menu" | null {
  if (link.to.length === 0) return null;
  return link.to.length === 1 ? link.to[0].href : "menu";
}

// The part an address's fragment names, as /owner/slug#token does.
export function partInHash(hash: string): string | null {
  let part: string;
  try {
    part = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return null;
  }
  return PART.test(part) ? part : null;
}

// A part's node in a drawing Mermaid has drawn, which it gives the id
// `{drawing}-flowchart-{part}-{n}`. A part's id has no hyphen, so it is
// read exactly.
export function findPart(root: ParentNode, part: string): Element | null {
  if (!PART.test(part)) return null;
  const id = new RegExp(`(?:^|-)flowchart-${part}-\\d+$`);
  return [...root.querySelectorAll("g.node")].find((g) => id.test(g.id)) ?? null;
}

// Marks a drawn part's node: its tooltip, a small link mark at its top-right
// corner and, when it leads somewhere, a link or a button for a menu that a
// keyboard can reach.
export function markPart(node: SVGGElement, link: PartLink) {
  const doc = node.ownerDocument;
  const title = doc.createElementNS(SVG, "title");
  title.textContent = link.title;
  node.insertBefore(title, node.firstChild);
  node.classList.add("part-linked");
  if (link.to.length === 0) node.classList.add("part-link-off");
  else {
    node.setAttribute("data-part-link", link.part);
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", link.to.length === 1 ? "link" : "button");
    if (link.to.length > 1) node.setAttribute("aria-haspopup", "menu");
    node.setAttribute("aria-label", link.title);
  }
  const box = node.getBBox();
  const mark = doc.createElementNS(SVG, "g");
  mark.classList.add("part-link-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("transform", `translate(${box.x + box.width}, ${box.y})`);
  const circle = doc.createElementNS(SVG, "circle");
  circle.setAttribute("r", "9");
  mark.appendChild(circle);
  // Two links of a chain, across the circle.
  for (const x of ["-6", "-1"]) {
    const ring = doc.createElementNS(SVG, "rect");
    for (const [name, value] of [["x", x], ["y", "-2.5"], ["width", "7"], ["height", "5"], ["rx", "2.5"], ["transform", "rotate(-45)"]])
      ring.setAttribute(name, value);
    mark.appendChild(ring);
  }
  node.appendChild(mark);
}

// Outlines the part an address's fragment names, once it is drawn, and no other.
export function outlinePart(root: ParentNode, hash: string): Element | null {
  for (const g of root.querySelectorAll(".part-target")) g.classList.remove("part-target");
  const part = partInHash(hash);
  const node = part ? findPart(root, part) : null;
  node?.classList.add("part-target");
  return node;
}

// The menu's first link takes the focus when the menu opens.
const focusOnOpen = (a: HTMLAnchorElement | null) => {
  a?.focus();
};

// The workflows a part leads to, when there are several, at a point in the
// drawing's frame. Esc closes it; the arrow keys move between its links.
export function PartMenu({ link, at, onClose }: { link: PartLink; at: { x: number; y: number }; onClose: () => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a")];
      const i = items.indexOf(document.activeElement as HTMLAnchorElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else return;
    e.preventDefault();
  }
  return (
    <div
      className="part-menu"
      style={{ left: at.x, top: at.y }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {link.title.split("\n").map((line) => (
        <p key={line}>{line}</p>
      ))}
      <div role="menu" aria-label={link.title}>
        {link.to.map((t, i) => (
          <a key={t.href} role="menuitem" href={t.href} ref={i === 0 ? focusOnOpen : undefined}>
            {t.label}
          </a>
        ))}
      </div>
    </div>
  );
}
