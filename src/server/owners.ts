import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { membership, organisation, user } from "@/db/schema";

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
