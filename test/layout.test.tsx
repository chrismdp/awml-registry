import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { edition } from "@/edition";
import RootLayout from "@/app/layout";

// The page on show, as the browser's address bar has it.
const at = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => at.path,
}));

// The main links, and which one is in bold.
async function nav(path: string) {
  at.path = path;
  const html = renderToStaticMarkup(await RootLayout({ children: <p>page</p> }));
  const main = html.match(/<nav class="site-nav"[^>]*>(.*?)<\/nav>/)![1];
  const links = [...main.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => ({
    label,
    href: attrs.match(/href="([^"]*)"/)?.[1],
    bold: attrs.includes('aria-current="page"'),
  }));
  return {
    hrefs: Object.fromEntries(links.map((l) => [l.label, l.href])),
    bold: links.filter((l) => l.bold).map((l) => l.label),
  };
}

describe("the site's main links", () => {
  it("take Gallery to /gallery, in bold there and on the home page that shows it", async () => {
    expect((await nav("/gallery")).hrefs.Gallery).toBe("/gallery");
    expect((await nav("/gallery")).bold).toEqual(["Gallery"]);
    expect((await nav("/")).bold).toEqual(["Gallery"]);
  });

  it("leave Gallery plain on a home page the edition gives", async () => {
    const original = edition.homePage;
    edition.homePage = () => <p>Hosted home</p>;
    try {
      expect((await nav("/")).bold).toEqual([]);
      expect((await nav("/gallery")).bold).toEqual(["Gallery"]);
    } finally {
      edition.homePage = original;
    }
  });
});
