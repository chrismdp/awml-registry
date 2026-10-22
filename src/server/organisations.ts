import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { membership, organisation, user } from "@/db/schema";
import { record } from "./audit";
import { findOwner, roleIn, type Role } from "./owners";
import { refuse, type Result } from "./result";
import { ownerSlugProblem, ownerSlugTaken } from "./slugs";

export type Organisation = typeof organisation.$inferSelect;

export async function createOrganisation(
  db: Db,
  actorId: string,
  input: { slug: string; name: string },
): Promise<Result<{ organisation: Organisation }>> {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim() || slug;
  const problem = ownerSlugProblem(slug);
  if (problem) return refuse(422, problem);
  if (await ownerSlugTaken(db, slug)) return refuse(422, `"${slug}" is taken.`);
  const [org] = await db.insert(organisation).values({ slug, name }).returning();
  await db.insert(membership).values({ organisationId: org.id, userId: actorId, role: "owner" });
  // Whoever makes the organisation joins it: "olive joined acme".
  await record(db, org.id, actorId, "member_joined", org.slug);
  return { ok: true, organisation: org };
}

async function usernameOf(db: Db, userId: string) {
  const [u] = await db.select({ username: user.username }).from(user).where(eq(user.id, userId));
  return u?.username ?? userId;
}

// The organisation, if the actor may manage it. A non-member gets 404, so
// the answer is the same as for an organisation that does not exist; a
// member who is not an owner gets 403.
export async function organisationToManage(
  db: Db,
  actorId: string | undefined,
  orgSlug: string,
): Promise<Result<{ organisation: { id: string; slug: string; name: string } }>> {
  const owner = await findOwner(db, orgSlug);
  if (!owner || owner.type !== "organisation") return refuse(404, "Not found.");
  const role = await roleIn(db, owner.id, actorId);
  if (!role) return refuse(404, "Not found.");
  if (role !== "owner") return refuse(403, "Only an organisation's owners can manage it.");
  return { ok: true, organisation: { id: owner.id, slug: owner.slug, name: owner.name } };
}

export async function addMember(
  db: Db,
  actorId: string | undefined,
  orgSlug: string,
  identifier: string,
  role: Role,
): Promise<Result<{}>> {
  const org = await organisationToManage(db, actorId, orgSlug);
  if (!org.ok) return org;
  const who = identifier.trim().toLowerCase();
  const [found] = await db
    .select({ id: user.id, username: user.username })
    .from(user)
    .where(who.includes("@") ? eq(user.email, who) : eq(user.username, who))
    .limit(1);
  if (!found)
    return refuse(
      422,
      `Nobody with the email or username "${identifier.trim()}" has signed in yet. Ask them to sign in once, then add them.`,
    );
  if (await roleIn(db, org.organisation.id, found.id))
    return refuse(422, `${found.username} is already a member.`);
  await db
    .insert(membership)
    .values({ organisationId: org.organisation.id, userId: found.id, role: role === "owner" ? "owner" : "member" });
  await record(db, org.organisation.id, actorId!, "member_joined", found.username ?? found.id);
  return { ok: true };
}

// An owner may remove anyone but the last owner; a member may remove only themselves.
export async function removeMember(
  db: Db,
  actorId: string | undefined,
  orgSlug: string,
  userId: string,
): Promise<Result<{}>> {
  const owner = await findOwner(db, orgSlug);
  if (!owner || owner.type !== "organisation") return refuse(404, "Not found.");
  const actorRole = await roleIn(db, owner.id, actorId);
  if (!actorRole) return refuse(404, "Not found.");
  if (actorRole !== "owner" && userId !== actorId)
    return refuse(403, "Only an organisation's owners can manage it.");
  const targetRole = await roleIn(db, owner.id, userId);
  if (!targetRole) return refuse(404, "Not found.");
  if (targetRole === "owner") {
    const owners = await db
      .select({ id: membership.id })
      .from(membership)
      .where(and(eq(membership.organisationId, owner.id), eq(membership.role, "owner")));
    if (owners.length === 1) return refuse(422, "An organisation needs at least one owner.");
  }
  await db
    .delete(membership)
    .where(and(eq(membership.organisationId, owner.id), eq(membership.userId, userId)));
  await record(db, owner.id, actorId!, "member_left", await usernameOf(db, userId));
  return { ok: true };
}

export async function listMembers(db: Db, organisationId: string) {
  return db
    .select({ userId: user.id, username: user.username, name: user.name, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organisationId, organisationId))
    .orderBy(asc(user.username));
}

export async function organisationsOf(db: Db, userId: string) {
  return db
    .select({ slug: organisation.slug, name: organisation.name, role: membership.role })
    .from(membership)
    .innerJoin(organisation, eq(organisation.id, membership.organisationId))
    .where(eq(membership.userId, userId))
    .orderBy(asc(organisation.slug));
}
