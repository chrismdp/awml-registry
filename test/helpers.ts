import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/db/client";
import { getAuth } from "@/server/auth";
import { createToken } from "@/server/tokens";
import { createOrganisation, addMember } from "@/server/organisations";
import { route } from "./router";

export const sentEmails: { to: string; url: string }[] = [];

export const example = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

export const BASE = "http://localhost:3000";

export type Who = { cookie?: string; token?: string } | undefined;

// Sends a request through the app's own route handlers, as a browser or the
// CLI would.
export async function request(
  method: string,
  pathname: string,
  opts: { as?: Who; json?: unknown; form?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers();
  if (opts.as?.cookie) headers.set("cookie", opts.as.cookie);
  if (opts.as?.token) headers.set("authorization", `Bearer ${opts.as.token}`);
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(opts.form).toString();
  }
  return route(new Request(BASE + pathname, { method, headers, body }));
}

// Signs in with the magic link the dev sender would log.
export async function signIn(email: string) {
  const auth = await getAuth();
  const send = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  );
  if (!send.ok) throw new Error(`magic link request failed: ${send.status} ${await send.text()}`);
  const link = sentEmails.findLast((e) => e.to === email);
  if (!link) throw new Error("no magic link sent");
  const verify = await auth.handler(new Request(link.url, { headers: { origin: BASE } }));
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) throw new Error("sign-in gave no session");
  return { cookie, user: session.user as typeof session.user & { username: string } };
}

// A signed-in user, with a token for the API.
export async function person(name: string) {
  const { cookie, user } = await signIn(`${name}@example.com`);
  const { secret } = await createToken(await getDb(), user.id, "test");
  return { cookie, token: secret, user, id: user.id, username: user.username };
}

export async function orgWith(
  slug: string,
  owner: { id: string },
  members: { username: string }[] = [],
) {
  const db = await getDb();
  const org = await createOrganisation(db, owner.id, { slug, name: slug });
  if (!org.ok) throw new Error(org.errors[0]);
  for (const m of members) {
    const added = await addMember(db, owner.id, slug, m.username, "member");
    if (!added.ok) throw new Error(added.errors[0]);
  }
  return org.organisation;
}
