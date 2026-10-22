// The sign-in and consent pages' part in an AI client signing in to /mcp.
// Better Auth's OAuth provider sends the person to /login, then /consent,
// with the client's authorisation request in the query, signed.

export type Search = Record<string, string | string[] | undefined>;

// The query a page was given, as a query string.
export function queryString(search: Search) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    for (const v of [value ?? []].flat()) q.append(key, v);
  return q.toString();
}

// Where to finish an AI client's authorisation once the person has signed
// in: the same request again, less the provider's signature and the
// prompt to sign in, which is done. Null when the page was not sent one.
export function authorizeAgain(search: Search) {
  if (typeof search.client_id !== "string" || typeof search.sig !== "string") return null;
  const q = new URLSearchParams(queryString(search));
  for (const key of [...q.keys()]) if (key === "sig" || key === "exp" || key.startsWith("ba_")) q.delete(key);
  const prompt = (q.get("prompt") ?? "").split(" ").filter((p) => p && p !== "login");
  if (prompt.length) q.set("prompt", prompt.join(" "));
  else q.delete("prompt");
  return `/api/auth/oauth2/authorize?${q}`;
}
