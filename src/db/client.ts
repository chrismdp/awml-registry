import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { openDb } from "@/db/driver";
import type * as schema from "./schema";

// Both drivers, better-sqlite3 and D1, give this shape; every query is awaited.
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

let current: Db | undefined;

export async function getDb(): Promise<Db> {
  return current ?? openDb();
}

// Tests point the app at their own database.
export function setDb(db: Db | undefined) {
  current = db;
}
