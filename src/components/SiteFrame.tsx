"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// The site's header and page width on every page but sign-in, which has a
// layout of its own.
export function SiteFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  if (usePathname() === "/login") return <>{children}</>;
  return (
    <div className="wrap">
      {header}
      <main>{children}</main>
    </div>
  );
}

// The main links, the one for the page on show in bold. `match` is a pattern
// for the paths a link stands for.
export function SiteNav({ links }: { links: { href: string; label: string; match?: string }[] }) {
  const path = usePathname();
  return (
    <nav className="site-nav" aria-label="Main">
      {links.map((l) => (
        <Link key={l.label} href={l.href} aria-current={l.match && new RegExp(l.match).test(path) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
