"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// The links that move between a workflow page's tabs, and between the
// implementations its platform view draws.
export const TAB_LINKS = '.tabs a[role="tab"], nav.implementations a';

type Click = Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented"> & {
  target: { closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null } | null;
};

// The address a click goes to by client navigation: a plain left click on a
// tab's link to an address on this site. Anything else, such as a Ctrl-click
// to open a new tab, is left to the browser.
export function clientHref(e: Click) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return undefined;
  const href = e.target?.closest?.(TAB_LINKS)?.getAttribute("href");
  return href?.startsWith("/") && !href.startsWith("//") ? href : undefined;
}

// Makes the tabs' plain links client navigations, as Next's Link would, so a
// tab switch fetches only the new tab and keeps Mermaid, and the drawings it
// has made, loaded. A tab is fetched when the pointer or focus comes to it,
// so it is usually there by the click. The links stay plain links in the
// page, which work without scripts; this renders nothing, and listens only
// once the page has started.
export function TabNavigation() {
  const [started, setStarted] = useState(false);
  useEffect(() => setStarted(true), []);
  return started ? <Navigator /> : null;
}

function Navigator() {
  const router = useRouter();
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const href = clientHref(e as Click);
      if (!href) return;
      e.preventDefault();
      router.push(href, { scroll: false });
    };
    const onIntent = (e: Event) => {
      const href = (e.target as Element | null)?.closest?.(TAB_LINKS)?.getAttribute("href");
      if (href?.startsWith("/") && !href.startsWith("//")) router.prefetch(href);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("pointerover", onIntent);
    document.addEventListener("focusin", onIntent);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerover", onIntent);
      document.removeEventListener("focusin", onIntent);
    };
  }, [router]);
  return null;
}
