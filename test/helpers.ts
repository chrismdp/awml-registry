import fs from "node:fs";
import path from "node:path";
import { and, eq, max } from "drizzle-orm";
import { parse } from "yaml";
import { getDb } from "@/db/client";
import { platform, platformVersion, version, workflow, type CheckList, type CheckResult } from "@/db/schema";
import { engine, type Summary } from "@/engine";
import { edition, type Edition } from "@/edition";
import { getAuth } from "@/server/auth";
import { createToken } from "@/server/tokens";
import { createOrganisation, addMember } from "@/server/organisations";
import { findOwner } from "@/server/owners";
import { route } from "./router";

export const sentEmails: { to: string; url: string }[] = [];

// Every statement sent to the database in this test, as SQL, in order.
export const statements: string[] = [];

export const example = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

export const BASE = "http://localhost:3000";

// Runs `test` with the edition changed as given, then puts it back. A test
// that depends on the edition says which one it means, so the suite passes
// whichever edition src/edition.ts is, the hosted one included.
export async function withEdition(change: Partial<Edition>, test: () => Promise<void>) {
  const before = { ...edition };
  Object.assign(edition, change);
  try {
    await test();
  } finally {
    Object.assign(edition, before);
  }
}

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

// A version as an older registry stored it, written straight to the database,
// since a push now takes only AWML 0.9: an older workflow file, or from before
// the registry took only 0.4 files, a security file, a platform file or both.
// Its summary and any list of checks are what the AWML of the day worked out
// at push, so the test gives them; with none, the summary is this AWML's of
// the file converted, and a version stored before 0.4 has no list. Makes the
// workflow on its first version.
export async function storeVersion(
  ownerSlug: string,
  slug: string,
  by: { id: string },
  files: { workflow?: string; security?: string; platform?: string },
  opts: { summary?: Summary; checks?: CheckList; visibility?: "public" | "private" } = {},
) {
  const db = await getDb();
  const owner = await findOwner(db, ownerSlug);
  if (!owner) throw new Error(`no owner ${ownerSlug}`);
  const ownerColumn =
    owner.type === "user" ? eq(workflow.ownerUserId, owner.id) : eq(workflow.ownerOrganisationId, owner.id);
  const sources = [files.workflow, files.security, files.platform].filter((f): f is string => f !== undefined);
  const title = String((parse(sources[0]) as { title: string }).title);
  let [w] = await db.select().from(workflow).where(and(ownerColumn, eq(workflow.slug, slug)));
  w ??= (
    await db
      .insert(workflow)
      .values({
        ownerUserId: owner.type === "user" ? owner.id : null,
        ownerOrganisationId: owner.type === "organisation" ? owner.id : null,
        slug,
        title,
        visibility: opts.visibility ?? "public",
      })
      .returning()
  )[0];
  const [{ latest }] = await db.select({ latest: max(version.number) }).from(version).where(eq(version.workflowId, w.id));
  const check: CheckResult = {};
  for (const name of ["workflow", "security", "platform"] as const) if (files[name] !== undefined) check[name] = [];
  const converted = await engine.convert([files.workflow ?? files.security ?? sources[0]]);
  if (!opts.summary && !("file" in converted)) throw new Error(`give a summary: ${converted.error}`);
  await db.insert(version).values({
    workflowId: w.id,
    number: (latest ?? 0) + 1,
    pushedBy: by.id,
    workflow: files.workflow ?? null,
    security: files.security ?? null,
    platform: files.platform ?? null,
    check,
    checks: opts.checks ?? null,
    summary: opts.summary ?? (await engine.summarise({ workflow: (converted as { file: string }).file })),
  });
  await db.update(workflow).set({ title, updatedAt: new Date() }).where(eq(workflow.id, w.id));
}

// A platform version as an older registry stored it, its description marked
// as an AWML the registry no longer takes. Makes the platform on its first
// version.
export async function storePlatformVersion(
  ownerSlug: string,
  slug: string,
  by: { id: string },
  description: string,
  visibility: "public" | "private" = "public",
) {
  const db = await getDb();
  const owner = await findOwner(db, ownerSlug);
  if (!owner) throw new Error(`no owner ${ownerSlug}`);
  const ownerColumn =
    owner.type === "user" ? eq(platform.ownerUserId, owner.id) : eq(platform.ownerOrganisationId, owner.id);
  const label = String((parse(description) as { platform: { label: string } }).platform.label);
  let [p] = await db.select().from(platform).where(and(ownerColumn, eq(platform.slug, slug)));
  p ??= (
    await db
      .insert(platform)
      .values({
        ownerUserId: owner.type === "user" ? owner.id : null,
        ownerOrganisationId: owner.type === "organisation" ? owner.id : null,
        slug,
        label,
        visibility,
      })
      .returning()
  )[0];
  const [{ latest }] = await db
    .select({ latest: max(platformVersion.number) })
    .from(platformVersion)
    .where(eq(platformVersion.platformId, p.id));
  await db.insert(platformVersion).values({ platformId: p.id, number: (latest ?? 0) + 1, pushedBy: by.id, description, recipe: null });
  await db.update(platform).set({ label, updatedAt: new Date() }).where(eq(platform.id, p.id));
}
