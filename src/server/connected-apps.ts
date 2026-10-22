// The AI apps a person has allowed to use their account through /mcp, from
// Better Auth's OAuth tables, and cutting one off. Every query is the
// person's own: their consents and their tokens, never another person's for
// the same app.
import { and, desc, eq, max } from "drizzle-orm";
import type { Db } from "@/db/client";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@/db/schema";

export type ConnectedApp = { clientId: string; name: string | null; allowedAt: Date | null; lastUsedAt: Date | null };

// Each app the person allowed, newest first. It was last used when it last
// got an access token, which it renews once its hour is up: the newest
// refresh token it holds for this person.
export async function listConnectedApps(db: Db, userId: string): Promise<ConnectedApp[]> {
  const apps = await db
    .select({ clientId: oauthConsent.clientId, name: oauthClient.name, allowedAt: oauthConsent.createdAt })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.createdAt));
  const renewals = await db
    .select({ clientId: oauthRefreshToken.clientId, at: max(oauthRefreshToken.createdAt) })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, userId))
    .groupBy(oauthRefreshToken.clientId);
  const lastUsed = new Map(renewals.map((r) => [r.clientId, r.at]));
  return apps.map((a) => ({ ...a, lastUsedAt: lastUsed.get(a.clientId) ?? a.allowedAt }));
}

// The app loses the person's consent and every token it holds for them, so
// it cannot renew its access. An access token it already holds, a JWT /mcp
// checks without asking the database, lasts out its hour.
export async function disconnectApp(db: Db, userId: string, clientId: string) {
  for (const table of [oauthRefreshToken, oauthAccessToken, oauthConsent])
    await db.delete(table).where(and(eq(table.userId, userId), eq(table.clientId, clientId)));
}
