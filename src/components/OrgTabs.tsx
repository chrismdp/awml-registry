import Link from "next/link";

// An organisation's own pages, as tabs for its members, with the page on show marked.
export function OrgTabs({
  organisation,
  current,
}: {
  organisation: { slug: string; name: string };
  current: "inventory" | "platforms";
}) {
  const tabs = [
    { href: `/${organisation.slug}`, label: "Workflows" },
    { href: `/${organisation.slug}/inventory`, label: "Inventory", page: "inventory" },
    { href: `/${organisation.slug}/platforms`, label: "Platforms", page: "platforms" },
    { href: `/${organisation.slug}/settings#members`, label: "Members" },
    { href: `/${organisation.slug}/settings#audit`, label: "Audit log" },
  ];
  return (
    <nav className="org-tabs" aria-label={organisation.name}>
      {tabs.map((t) => (
        <Link key={t.label} href={t.href} aria-current={t.page === current ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
