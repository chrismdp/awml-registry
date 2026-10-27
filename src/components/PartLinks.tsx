import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { PartLink } from "@/server/part-links";
import { placeMenu, type Box } from "./viewport";

// Marking the parts of a drawing that are linked to other workflows (see
// partLinks in src/server/part-links.ts), finding each part's node in the
// SVG Mermaid drew, and the menu of a part that leads to several.

const PART = /^[A-Za-z][A-Za-z0-9_]*$/;
const SVG = "http://www.w3.org/2000/svg";
// The mark's circle, and half its 2px stroke, which it is inset by to stay
// inside its node's box, so a node at the drawing's edge doesn't lose it.
const MARK_R = 9;
const MARK_INSET = MARK_R + 1;

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

// A drawn node's own label, as it reads: Mermaid's HTML label line by line,
// or the text of an SVG one.
function labelOf(node: Element) {
  const label = node.querySelector(".nodeLabel") as HTMLElement | null;
  return ((label ? label.innerText : node.textContent) ?? "").replace(/\s+/g, " ").trim();
}

// Marks a drawn part's node: its tooltip, a small link mark in its top-right
// corner and, when it leads somewhere, a link or a button for a menu that a
// keyboard can reach, named by its own label and then where it leads.
export function markPart(node: SVGGElement, link: PartLink) {
  const doc = node.ownerDocument;
  const spoken = [labelOf(node), ...link.title.split("\n")].filter(Boolean).join(". ");
  const title = doc.createElementNS(SVG, "title");
  title.textContent = link.title;
  node.insertBefore(title, node.firstChild);
  node.classList.add("part-linked");
  if (link.to.length === 0) node.classList.add("part-link-off");
  else {
    node.setAttribute("data-part-link", link.part);
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", link.to.length === 1 ? "link" : "button");
    if (link.to.length > 1) {
      node.setAttribute("aria-haspopup", "menu");
      node.setAttribute("aria-expanded", "false");
    }
    node.setAttribute("aria-label", spoken);
  }
  const box = node.getBBox();
  const mark = doc.createElementNS(SVG, "g");
  mark.classList.add("part-link-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("transform", `translate(${box.x + box.width - MARK_INSET}, ${box.y + MARK_INSET})`);
  const circle = doc.createElementNS(SVG, "circle");
  circle.setAttribute("r", String(MARK_R));
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

// The workflows a part leads to, when there are several, beside its node,
// whose box in the drawing's frame is `node`. It is placed once it is drawn
// and its size is known: under the node, above it when only above has room,
// and inside the frame. Esc closes it; the arrow keys move between its links.
export function PartMenu({ link, node, onClose }: { link: PartLink; node: Box; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = menu.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    const at = placeMenu(
      node,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: frame.clientWidth, height: frame.clientHeight },
    );
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    // The first link takes the focus once the menu is where it will stay.
    el.querySelector("a")?.focus();
  }, [node]);
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
      ref={menu}
      className="part-menu"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {link.title.split("\n").map((line) => (
        <p key={line}>{line}</p>
      ))}
      <div role="menu" aria-label={link.title}>
        {link.to.map((t) => (
          <a key={t.href} role="menuitem" href={t.href}>
            {t.label}
          </a>
        ))}
      </div>
    </div>
  );
}
