import { getTableColumns } from "drizzle-orm";
import type { SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./client";

// Cloudflare D1 binds at most 100 values in one statement. better-sqlite3,
// which the tests and a self-hosted registry run on, binds far more, so a
// statement that runs there can fail on Cloudflare. Every statement holds to
// D1's limit, and the tests refuse any that doesn't (see test/setup.ts).
export const BOUND_VALUES_LIMIT = 100;

// Inserts rows into a table in as few statements as D1 takes. Each row binds
// at most one value for each of the table's columns.
export async function insertRows<T extends SQLiteTable>(db: Db, table: T, rows: SQLiteInsertValue<T>[]) {
  const size = Math.max(1, Math.floor(BOUND_VALUES_LIMIT / Object.keys(getTableColumns(table)).length));
  for (let at = 0; at < rows.length; at += size) await db.insert(table).values(rows.slice(at, at + size));
}
