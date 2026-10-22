import type { Refusal } from "./result";

export type Params<T extends string> = { params: Promise<Record<T, string>> };

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const refusal = (r: Refusal) => json({ errors: r.errors }, r.status);

export const notFound = () => json({ errors: ["Not found."] }, 404);

// A request's JSON body, which must be an object, or the 422 that says so.
export async function jsonObject(req: Request): Promise<{ body: Record<string, unknown> } | { refused: Response }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { refused: json({ errors: ["Send a JSON body."] }, 422) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { refused: json({ errors: ["Send a JSON object."] }, 422) };
  return { body: body as Record<string, unknown> };
}

export function siteUrl(req: Request, path: string) {
  return new URL(path, process.env.BETTER_AUTH_URL ?? req.url).toString();
}

// An address on this registry when there is no request to go by.
export const ownUrl = (path: string) =>
  new URL(path, process.env.BETTER_AUTH_URL ?? "http://localhost:3000").toString();

// An address on this registry as a person reads it, without the scheme:
// "awml.io/acme".
export const ownAddress = (path: string) => {
  const url = new URL(path, ownUrl("/"));
  return url.host + url.pathname;
};

// The MCP server: the resource an AI client's OAuth token is for.
export const mcpUrl = () => ownUrl("/mcp");

// A form post answered with a redirect back to the page, carrying a message.
export function backTo(req: Request, path: string, message?: { error?: string; notice?: string }) {
  const url = new URL(path, siteUrl(req, "/"));
  if (message?.error) url.searchParams.set("error", message.error);
  if (message?.notice) url.searchParams.set("notice", message.notice);
  return Response.redirect(url, 303);
}
