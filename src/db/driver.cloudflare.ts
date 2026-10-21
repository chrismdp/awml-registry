// Hosted on Cloudflare Workers: the D1 binding named DB, migrated with
// `wrangler d1 migrations apply`.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import type { Db } from "./client";

export async function openDb(): Promise<Db> {
  const { env } = await getCloudflareContext({ async: true });
  return drizzle((env as unknown as { DB: AnyD1Database }).DB, { schema }) as unknown as Db;
}
