import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { membership, organisation, user } from "@/db/schema";
import type { Visibility } from "./push";

export type Role = "owner" | "member";

export type Owner =
  | { type: "user"; id: string; slug: string; name: string }
  | { type: "organisation"; id: string; slug: string; name: string };

export async function findOwner(db: Db, slug: string): Promise<Owner | null> {
  const [u] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.username, slug))
    .limit(1);
  if (u) return { type: "user", id: u.id, slug, name: u.name };
  const [o] = await db
    .select({ id: organisation.id, name: organisation.name })
    .from(organisation)
    .where(eq(organisation.slug, slug))
    .limit(1);
  return o ? { type: "organisation", id: o.id, slug, name: o.name } : null;
}

export async function roleIn(db: Db, organisationId: string, userId: string | undefined) {
  if (!userId) return null;
  const [m] = await db
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.organisationId, organisationId), eq(membership.userId, userId)))
    .limit(1);
  return (m?.role ?? null) as Role | null;
}

// Whether the viewer may push to, and read the private workflows of, an owner.
export async function isOwnerOrMember(db: Db, owner: Owner, userId: string | undefined) {
  if (!userId) return false;
  if (owner.type === "user") return owner.id === userId;
  return (await roleIn(db, owner.id, userId)) !== null;
}

// Whether an owner may see a workflow of another: a public one, its own, and
// for a person, a private one of an organisation they belong to. What a
// workflow's refs may name and what a system may hold both go by it.
export async function ownerMaySee(db: Db, owner: Owner, of: Owner, visibility: Visibility) {
  if (visibility === "public" || (owner.type === of.type && owner.id === of.id)) return true;
  return owner.type === "user" && isOwnerOrMember(db, of, owner.id);
}
