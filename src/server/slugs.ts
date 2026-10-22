import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { organisation, user } from "@/db/schema";

// Paths at the root of the site that no user or organisation may take.
export const RESERVED_SLUGS = new Set([
  "api", "explore", "gallery", "settings", "login", "logout", "signup", "auth", "new", "admin",
  "pricing", "security", "docs", "about", "blog", "terms", "privacy", "help", "status",
  "_next", "static", "assets", "mcp", "consent",
]);

// Paths under an owner that no workflow may take.
export const RESERVED_WORKFLOW_SLUGS = new Set(["inventory", "settings"]);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function isSlug(value: string) {
  return SLUG.test(value) && !value.includes("--");
}

export function ownerSlugProblem(slug: string): string | null {
  if (!isSlug(slug))
    return "Use 1 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved.`;
  return null;
}

export function workflowSlugProblem(slug: string): string | null {
  if (!isSlug(slug))
    return "A workflow's slug is 1 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.";
  if (RESERVED_WORKFLOW_SLUGS.has(slug)) return `"${slug}" is reserved.`;
  return null;
}

// Users and organisations share one namespace.
export async function ownerSlugTaken(db: Db, slug: string) {
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.username, slug)).limit(1);
  if (u) return true;
  const [o] = await db
    .select({ id: organisation.id })
    .from(organisation)
    .where(eq(organisation.slug, slug))
    .limit(1);
  return Boolean(o);
}

// A free username made from an email address, for a user's first sign-in.
export async function freeUsername(db: Db, email: string) {
  const base =
    email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "user";
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    if (!ownerSlugProblem(candidate) && !(await ownerSlugTaken(db, candidate))) return candidate;
  }
}
