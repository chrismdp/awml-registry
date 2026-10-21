import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { user } from "@/db/schema";
import { getAuth } from "./auth";
import { userIdForSecret } from "./tokens";

export type Viewer = { id: string; username: string; name: string; email: string } | null;

// Who is asking: the user of a bearer token, or of a browser session.
export async function getViewer(headers: Headers): Promise<Viewer> {
  const db = await getDb();
  const authorization = headers.get("authorization");
  let userId: string | null = null;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    userId = await userIdForSecret(db, authorization.slice(7).trim());
  } else {
    const session = await (await getAuth()).api.getSession({ headers });
    userId = session?.user.id ?? null;
  }
  if (!userId) return null;
  const [row] = await db
    .select({ id: user.id, username: user.username, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.username ? { ...row, username: row.username } : null;
}
