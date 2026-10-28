import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFrame } from "@/components/SiteFrame";
import "./site.css";

export const metadata: Metadata = {
  title: "AWML Registry",
  description: "Store, version and draw AWML workflow files.",
};

// Every page, its header from the chrome slot (src/app/@chrome): the site's
// header, or nothing for an embed (#75). The layout never reads the session
// or a cookie itself, so an embed reads none. Next also renders this layout
// with no slot at all, as a hidden 404 for a slot that matches nothing, and
// that copy shows no header either; an address no route answers gets the
// header from src/app/global-not-found.tsx.
export default function RootLayout({ children, chrome }: { children: ReactNode; chrome?: ReactNode }) {
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
        <SiteFrame header={chrome ?? null}>{children}</SiteFrame>
      </body>
    </html>
  );
}
