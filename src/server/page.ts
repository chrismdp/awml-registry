import { headers } from "next/headers";
import { permanentRedirect } from "next/navigation";
import { getDb, type Db } from "@/db/client";
import { renamedTo } from "./usernames";
import { getViewer } from "./viewer";

// The signed-in user for a page, and the database.
export async function pageContext() {
  const [db, viewer] = await Promise.all([getDb(), headers().then(getViewer)]);
  return { db, viewer };
}

export const dateTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

// For a page under an owner that found nothing: when the owner is a name its
// person gave up, sends the visitor for good (308) to the same page, `rest`
// after the owner, under the name they go by now. The page there makes its
// own check, so a private workflow stays a 404 to anyone outside.
export async function followOldName(db: Db, owner: string, rest = "", search: Record<string, string | undefined> = {}) {
  const now = await renamedTo(db, owner);
  if (!now) return;
  const query = new URLSearchParams(
    Object.entries(search).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  permanentRedirect(`/${now}${rest}${query ? `?${query}` : ""}`);
}
