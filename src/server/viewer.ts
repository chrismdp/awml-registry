import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { account, user } from "@/db/schema";
import { getAuth } from "./auth";
import { ownUrl } from "./http";
import { refuse, type Result } from "./result";
import { userIdForSecret } from "./tokens";

export type Viewer = { id: string; username: string; name: string; email: string } | null;

const invalidTokenMessage = () =>
  `The token is not valid: it was revoked, or it is mistyped. Log in again with a new token from ${ownUrl("/settings/tokens")}.`;

// Who is asking a route: the user of a bearer token, or of a browser session,
// or nobody. A bearer token that is not a live token is refused with a 401
// rather than taken as nobody, so a CLI holding a revoked token is told to
// log in again, whatever it asked for and whether or not that exists.
export async function requestViewer(headers: Headers): Promise<Result<{ viewer: Viewer }>> {
  const db = await getDb();
  const authorization = headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const userId = await userIdForSecret(db, authorization.slice(7).trim());
    const viewer = userId ? await viewerFor(db, userId) : null;
    return viewer ? { ok: true, viewer } : refuse(401, invalidTokenMessage());
  }
  const session = await (await getAuth()).api.getSession({ headers });
  return { ok: true, viewer: session ? await viewerFor(db, session.user.id) : null };
}

// Who is looking at a page: as requestViewer, with a token that is not valid
// taken as nobody.
export async function getViewer(headers: Headers): Promise<Viewer> {
  const asked = await requestViewer(headers);
  return asked.ok ? asked.viewer : null;
}

const PROVIDERS: Record<string, string> = { google: "Google", github: "GitHub" };

// What a person signs in with, for Settings: the Google or GitHub account
// they last signed in with, or an email link when they have neither. Better
// Auth records no provider on a session, and touches the account each time it
// signs in, so the most recently touched one is the latest.
export async function signedInWith(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({ providerId: account.providerId })
    .from(account)
    .where(and(eq(account.userId, userId), inArray(account.providerId, Object.keys(PROVIDERS))))
    .orderBy(desc(account.updatedAt))
    .limit(1);
  return rows[0] ? PROVIDERS[rows[0].providerId] : "an email link";
}

// The viewer a user id stands for, or null when there is no such user.
export async function viewerFor(db: Db, userId: string): Promise<Viewer> {
  const [row] = await db
    .select({ id: user.id, username: user.username, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.username ? { ...row, username: row.username } : null;
}
