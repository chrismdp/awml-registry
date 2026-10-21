import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { SiteFrame, SiteNav } from "@/components/SiteFrame";
import { organisationsOf } from "@/server/organisations";
import { pageContext } from "@/server/page";
import "./site.css";

export const metadata: Metadata = {
  title: "AWML Registry",
  description: "Store, version and draw AWML workflow files.",
};

const DOCS = "https://github.com/chrismdp/awml#readme";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { db, viewer } = await pageContext();
  // Inventory goes to the viewer's first organisation, to making one, or to sign-in.
  const [org] = viewer ? await organisationsOf(db, viewer.id) : [];
  const inventory = org ? `/${org.slug}/inventory` : viewer ? "/settings" : "/login";
  const header = (
    <header className="site-header">
      <div className="left">
        <Logo />
        <SiteNav
          links={[
            { href: "/explore", label: "Gallery", match: "^/(explore)?$" },
            { href: inventory, label: "Inventory", match: "/inventory$" },
            { href: DOCS, label: "Docs" },
          ]}
        />
      </div>
      {viewer ? (
        <Link href="/settings" className="account">
          <span>{viewer.username}</span>
          <span className="avatar" aria-label="Your account">
            {viewer.username.slice(0, 1).toUpperCase()}
          </span>
        </Link>
      ) : (
        <Link href="/login" className="button">
          Sign in
        </Link>
      )}
    </header>
  );
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <SiteFrame header={header}>{children}</SiteFrame>
      </body>
    </html>
  );
}
