import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { token } from "@/db/schema";

const PREFIX = "awml_";

export async function hashSecret(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The secret is returned once, here, and only its hash is kept.
export async function createToken(db: Db, userId: string, name: string) {
  const secret = newSecret();
  const [row] = await db
    .insert(token)
    .values({ userId, name: name.trim() || "token", hash: await hashSecret(secret) })
    .returning({ id: token.id });
  return { id: row.id, secret };
}

export async function listTokens(db: Db, userId: string) {
  return db
    .select({ id: token.id, name: token.name, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt })
    .from(token)
    .where(eq(token.userId, userId))
    .orderBy(desc(token.createdAt));
}

export async function revokeToken(db: Db, userId: string, id: string) {
  await db.delete(token).where(and(eq(token.id, id), eq(token.userId, userId)));
}

// The user a token acts as, or null.
export async function userIdForSecret(db: Db, secret: string) {
  if (!secret.startsWith(PREFIX)) return null;
  const [row] = await db
    .select({ id: token.id, userId: token.userId })
    .from(token)
    .where(eq(token.hash, await hashSecret(secret)))
    .limit(1);
  if (!row) return null;
  await db.update(token).set({ lastUsedAt: new Date() }).where(eq(token.id, row.id));
  return row.userId;
}
