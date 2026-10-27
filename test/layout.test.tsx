import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RootLayout from "@/app/layout";
import Chrome from "@/app/@chrome/default";
import WorkflowEmbedChrome from "@/app/@chrome/[owner]/[slug]/embed/page";
import VersionEmbedChrome from "@/app/@chrome/[owner]/[slug]/v/[n]/embed/page";
import SystemEmbedChrome from "@/app/@chrome/[owner]/systems/[slug]/embed/page";
import { SiteHeader } from "@/components/SiteHeader";
import { withEdition } from "./helpers";
import { pageRequest, sealed } from "./pages";

// The page on show, as the browser's address bar has it.
const at = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => at.path,
}));

// The main links, and which one is in bold.
async function nav(path: string) {
  at.path = path;
  pageRequest.headers = new Headers();
  const html = renderToStaticMarkup(await SiteHeader());
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
    await withEdition({ homePage: undefined }, async () => {
      expect((await nav("/gallery")).hrefs.Gallery).toBe("/gallery");
      expect((await nav("/gallery")).bold).toEqual(["Gallery"]);
      expect((await nav("/")).bold).toEqual(["Gallery"]);
    });
  });

  it("leave Gallery plain on a home page the edition gives", async () => {
    await withEdition({ homePage: () => <p>Hosted home</p> }, async () => {
      expect((await nav("/")).bold).toEqual([]);
      expect((await nav("/gallery")).bold).toEqual(["Gallery"]);
    });
  });
});

// Whether an element tree holds an element of a component.
function holds(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((n) => holds(n, type));
  if (!isValidElement(node)) return false;
  const { children, header } = node.props as { children?: ReactNode; header?: ReactNode };
  return node.type === type || holds(children, type) || holds(header, type);
}

describe("the site's header", () => {
  it("comes from the layout's chrome slot, which is the header on every page but an embed's (#75)", () => {
    expect(Chrome).toBe(SiteHeader);
    // An embed page's slot is empty, so the embed is shown with no header, footer or navigation.
    for (const page of [WorkflowEmbedChrome, VersionEmbedChrome, SystemEmbedChrome]) expect(page()).toBeNull();
  });

  it("is never read by the root layout itself, which reads no session or cookie, so an embed reads none", () => {
    pageRequest.headers = sealed;
    at.path = "/acme/dinners/embed";
    const html = renderToStaticMarkup(RootLayout({ children: <p>an embed</p>, chrome: WorkflowEmbedChrome() }));
    expect(html).toContain("<p>an embed</p>");
    expect(html).not.toMatch(/site-header|site-nav|Sign in/);
  });

  it("is still shown on an address no route answers, whose 404 has no chrome slot", () => {
    expect(holds(RootLayout({ children: <p>Not found</p> }), SiteHeader)).toBe(true);
    expect(holds(RootLayout({ children: <p>an embed</p>, chrome: null }), SiteHeader)).toBe(false);
  });
});
