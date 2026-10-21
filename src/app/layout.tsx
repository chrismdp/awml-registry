import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { pageContext } from "@/server/page";
import "./site.css";

export const metadata: Metadata = {
  title: "AWML Registry",
  description: "Store, version and draw AWML workflow files.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { viewer } = await pageContext();
  return (
    <html lang="en">
      <body>
        <header className="site">
          <nav>
            <Link href="/">AWML Registry</Link> · <Link href="/explore">Explore</Link>
            <span className="end">
              {viewer ? (
                <>
                  <Link href={`/${viewer.username}`}>{viewer.username}</Link> ·{" "}
                  <Link href="/settings">Settings</Link> ·{" "}
                  <form method="post" action="/logout" className="inline">
                    <button type="submit">Sign out</button>
                  </form>
                </>
              ) : (
                <Link href="/login">Sign in</Link>
              )}
            </span>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
