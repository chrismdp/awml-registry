// A person's own username: changing it, and the names they gave up, which
// redirect to the name they go by now. Workflows and platforms are stored
// against the account, not the name, so they move with the person.
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { membership, previousName, user } from "@/db/schema";
import { record } from "./audit";
import { siteUrl } from "./http";
import { refuse, type Result } from "./result";
import { ownerSlugProblem, ownerSlugTaken } from "./slugs";

// What a saved username did, as Settings and /mcp say it.
export const savedNotice = ({ username, previous }: { username: string; previous: string }) =>
  username === previous
    ? `Your username is already ${username}.`
    : `Your username is now ${username}. Links to /${previous} will redirect to /${username} until someone else takes the name ${previous}.`;

// Gives the person `userId` the username asked for, by the rules an
// organisation's slug follows, and keeps the name they gave up so its address
// redirects. Each organisation they belong to records the rename.
export async function setUsername(
  db: Db,
  userId: string,
  asked: unknown,
): Promise<Result<{ username: string; previous: string }>> {
  if (typeof asked !== "string") return refuse(422, 'Send the new username as "username".');
  const username = asked.trim().toLowerCase();
  const problem = ownerSlugProblem(username);
  if (problem) return refuse(422, problem);
  const [me] = await db.select({ username: user.username }).from(user).where(eq(user.id, userId)).limit(1);
  if (!me?.username) return refuse(404, "Not found.");
  const previous = me.username;
  if (username === previous) return { ok: true, username, previous };
  if (await ownerSlugTaken(db, username)) return refuse(422, `"${username}" is taken.`);

  await db.update(user).set({ username, updatedAt: new Date() }).where(eq(user.id, userId));
  await db
    .insert(previousName)
    .values({ name: previous, userId })
    .onConflictDoUpdate({ target: previousName.name, set: { userId, givenUpAt: new Date() } });
  const memberships = await db
    .select({ organisationId: membership.organisationId })
    .from(membership)
    .where(eq(membership.userId, userId));
  for (const m of memberships) await record(db, m.organisationId, userId, "member_renamed", `${previous} to ${username}`);
  return { ok: true, username, previous };
}

// The name a person goes by now, when `name` is one they gave up and no
// person or organisation holds it now; otherwise null.
export async function renamedTo(db: Db, name: string): Promise<string | null> {
  const [row] = await db
    .select({ username: user.username })
    .from(previousName)
    .innerJoin(user, eq(user.id, previousName.userId))
    .where(eq(previousName.name, name))
    .limit(1);
  if (!row?.username || (await ownerSlugTaken(db, name))) return null;
  return row.username;
}

// For a route under an owner, such as /api/v1/{owner}/...: when the owner in
// the path is a name its person gave up, a 308 to the same address, query
// kept, under the name they go by now. `prefix` is the path before the owner.
// The redirect says nothing about what is there: the address it sends to
// makes its own check.
export async function oldNameRedirect(req: Request, owner: string, prefix: string): Promise<Response | null> {
  const now = await renamedTo(await getDb(), owner);
  if (!now) return null;
  const url = new URL(req.url);
  const segments = url.pathname.split("/");
  segments[prefix.split("/").length - 1] = now;
  return Response.redirect(new URL(segments.join("/") + url.search, siteUrl(req, "/")), 308);
}
