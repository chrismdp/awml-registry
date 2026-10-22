// Renders an app page the way a request would, as someone, and reports the
// status a browser would see.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { Who } from "./helpers";

export const pageRequest = { headers: new Headers() };

type Page<P> = (props: {
  params: Promise<P>;
  searchParams: Promise<Record<string, string | string[]>>;
}) => Promise<ReactElement> | ReactElement;

export async function renderPage<P>(
  page: Page<P>,
  params: P,
  opts: { as?: Who; search?: Record<string, string | string[]> } = {},
): Promise<{ status: number; html: string; location?: string }> {
  pageRequest.headers = new Headers();
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
    if (digest.startsWith("NEXT_REDIRECT;"))
      return { status: 307, html: "", location: digest.split(";")[2] };
    throw e;
  }
}
