import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditEvent, user } from "@/db/schema";

export type AuditAction = (typeof auditEvent.$inferInsert)["action"];

// Rows are only ever added; the database refuses changes and removals.
export async function record(
  db: Db,
  organisationId: string,
  actorId: string,
  action: AuditAction,
  target: string,
) {
  await db.insert(auditEvent).values({ organisationId, actorId, action, target });
}

export async function listAudit(db: Db, organisationId: string) {
  return db
    .select({
      id: auditEvent.id,
      action: auditEvent.action,
      target: auditEvent.target,
      at: auditEvent.at,
      actor: user.username,
    })
    .from(auditEvent)
    .innerJoin(user, eq(user.id, auditEvent.actorId))
    .where(eq(auditEvent.organisationId, organisationId))
    .orderBy(desc(auditEvent.at), desc(auditEvent.id));
}
