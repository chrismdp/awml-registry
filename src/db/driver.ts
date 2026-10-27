// Self-hosted and local development: a SQLite file, migrated on first use.
// The Cloudflare build swaps this module for driver.cloudflare.ts (see next.config.ts).
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Logger } from "drizzle-orm/logger";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import type { Db } from "./client";

let db: Db | undefined;

export async function openDb(): Promise<Db> {
  if (!db) {
    const file = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "registry.db");
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    db = openSqlite(file);
  }
  return db;
}

// `logger` is told of every statement before it runs, and may refuse it by
// throwing; the tests use it to hold every statement to D1's limits.
export function openSqlite(file: string, logger?: Logger): Db {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema, logger });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db as unknown as Db;
}
