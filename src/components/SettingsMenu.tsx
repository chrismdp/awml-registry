import Link from "next/link";

// The side menu of a person's settings, the page or part on show filled.
export function SettingsMenu({ current }: { current: "account" | "tokens" }) {
  const links = [
    { href: "/settings#account", label: "Account", page: "account" },
    { href: "/settings#apps", label: "Connected apps" },
    { href: "/settings/tokens", label: "API tokens", page: "tokens" },
    { href: "/settings#orgs", label: "Organisations" },
  ];
  return (
    <nav className="settings-menu" aria-label="Settings">
      {links.map((l) => (
        <Link key={l.label} href={l.href} aria-current={l.page === current ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
