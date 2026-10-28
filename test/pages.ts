// Renders an app page the way a request would, as someone, and reports the
// status a browser would see.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { Who } from "./helpers";

export const pageRequest = { headers: new Headers() };

export type Page<P> = (props: {
  params: Promise<P>;
  searchParams: Promise<Record<string, string | string[]>>;
}) => Promise<ReactElement> | ReactElement;

// A request whose headers throw when read, for a page that must read no
// session or cookie: rendering it proves it reads none.
export const sealed = new Proxy(new Headers(), {
  get() {
    throw new Error("The page read the request's headers, which hold its session and cookies.");
  },
}) as Headers;

export async function renderPage<P>(
  page: Page<P>,
  params: P,
  opts: { as?: Who; search?: Record<string, string | string[]>; headers?: Headers } = {},
): Promise<{ status: number; html: string; location?: string }> {
  pageRequest.headers = opts.headers ?? new Headers();
  if (opts.as?.cookie) pageRequest.headers.set("cookie", opts.as.cookie);
  try {
    const element = await page({
      params: Promise.resolve(params),
      searchParams: Promise.resolve(opts.search ?? {}),
    });
    return { status: 200, html: renderToStaticMarkup(element) };
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;"))
      return { status: Number(digest.split(";")[1]), html: "" };
    // "NEXT_REDIRECT;replace;/somewhere;308;": a redirect for now (307) or for good (308).
    if (digest.startsWith("NEXT_REDIRECT;"))
      return { status: Number(digest.split(";")[3]), html: "", location: digest.split(";")[2] };
    throw e;
  }
}
