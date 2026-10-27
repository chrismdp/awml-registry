import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteFrame } from "@/components/SiteFrame";
import { SiteHeader } from "@/components/SiteHeader";
import "./site.css";

export const metadata: Metadata = {
  title: "AWML Registry",
  description: "Store, version and draw AWML workflow files.",
};

// Every page, its header from the chrome slot (src/app/@chrome): the site's
// header, or nothing for an embed (#75). The layout reads no session or
// cookie itself, so an embed reads none. An address no route answers has no
// slot, and its 404 gets the header here.
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
        <SiteFrame header={chrome === undefined ? <SiteHeader /> : chrome}>{children}</SiteFrame>
      </body>
    </html>
  );
}
