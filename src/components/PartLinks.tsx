"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { PartLink } from "@/server/part-links";
import { placeMenu, type Box } from "./viewport";

// The workflows a part leads to, when there are several (#55), beside its
// box in the drawing's frame, `node`. It is placed once it is drawn and its
// size is known: under the part, above it when only above has room, and
// inside the frame. Esc closes it; the arrow keys move between its links.
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
