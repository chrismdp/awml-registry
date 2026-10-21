import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { getViewer } from "./viewer";

// The signed-in user for a page, and the database.
export async function pageContext() {
  const [db, viewer] = await Promise.all([getDb(), headers().then(getViewer)]);
  return { db, viewer };
}

export const dateTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
