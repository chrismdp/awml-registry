import type { Refusal } from "./result";

export type Params<T extends string> = { params: Promise<Record<T, string>> };

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const refusal = (r: Refusal) => json({ errors: r.errors }, r.status);

export const notFound = () => json({ errors: ["Not found."] }, 404);

export function siteUrl(req: Request, path: string) {
  return new URL(path, process.env.BETTER_AUTH_URL ?? req.url).toString();
}

// A form post answered with a redirect back to the page, carrying a message.
export function backTo(req: Request, path: string, message?: { error?: string; notice?: string }) {
  const url = new URL(path, siteUrl(req, "/"));
  if (message?.error) url.searchParams.set("error", message.error);
  if (message?.notice) url.searchParams.set("notice", message.notice);
  return Response.redirect(url, 303);
}
