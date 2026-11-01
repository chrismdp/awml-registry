// Platforms: where a workflow can run, each described in AWML's platform
// description format, with an install recipe when it has one. A platform is
// owned, versioned and kept private exactly as a workflow is.
import { and, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import { parse } from "yaml";
import type { Db } from "@/db/client";
import { membership, platform, platformVersion, user } from "@/db/schema";
import { engine } from "@/engine";
import { record } from "./audit";
import { descriptionAsRead } from "./as-read";
import {
  awmlOf,
  blockPlatforms,
  descriptionId,
  isOlderAwml,
  PLATFORM_IS_TOO_OLD,
  platformAddress,
  readYaml,
  REGISTERED_PLATFORM,
  withDescriptionId,
} from "./awml-file";
import { findOwner, isOwnerOrMember, type Owner } from "./owners";
import { mayPushTo, pushedVisibility, SIGN_IN_TO_PUSH } from "./push";
import { refuse, type Result } from "./result";
import { platformSlugProblem } from "./slugs";
import type { Viewer } from "./viewer";

type Platform = typeof platform.$inferSelect;

export type PlatformPushBody = { description?: unknown; recipe?: unknown; visibility?: unknown };

// The files a platform version holds, by the names its downloads use.
export const PLATFORM_FILES = {
  "description.yaml": { field: "description", type: "application/yaml; charset=utf-8" },
  "recipe.md": { field: "recipe", type: "text/markdown; charset=utf-8" },
} as const;

// Where a platform lives in the audit log: its path on the site.
export const platformTarget = (owner: string, slug: string, number: number) => `platforms/${owner}/${slug} v${number}`;

function ownerColumn(owner: Owner) {
  return owner.type === "user"
    ? eq(platform.ownerUserId, owner.id)
    : eq(platform.ownerOrganisationId, owner.id);
}

async function findPlatform(db: Db, owner: Owner, slug: string) {
  const [p] = await db
    .select()
    .from(platform)
    .where(and(ownerColumn(owner), eq(platform.slug, slug)))
    .limit(1);
  return p ?? null;
}

// The mistakes in a platform description pushed to an address, each as
// "description: ...", and its label. `awml check` finds most; a workflow sent
// as a description is refused here, and so is a description whose id is the
// address of another platform, owner/platforms/slug, which it may have only
// when that is its own.
async function checkDescription(text: string, address: string) {
  const found = await engine.check(text);
  if (found.length) return { errors: found.map((e) => `description: ${e}`) };
  if (readYaml(text)?.platform === undefined)
    return { errors: ["description: this is a workflow, not a platform description. Push it as a workflow."] };
  const id = descriptionId(text);
  if (REGISTERED_PLATFORM.test(id) && id !== address)
    return { errors: [`description: the platform id "${id}" must be ${address}, where it is pushed, or a bare id.`] };
  return { errors: [], label: labelOf(text) };
}

export async function pushPlatformVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  body: PlatformPushBody,
): Promise<Result<{ owner: string; slug: string; number: number }>> {
  if (!viewer) return refuse(401, SIGN_IN_TO_PUSH);
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return refuse(404, "Not found.");
  const allowed = await mayPushTo(db, viewer, owner);
  if (!allowed.ok) return allowed;
  const existing = await findPlatform(db, owner, slug);

  const slugProblem = platformSlugProblem(slug);
  if (slugProblem) return refuse(422, slugProblem);

  const { description, recipe } = body;
  if (typeof description !== "string") return refuse(422, "Send the platform's description as YAML.");
  if (recipe !== undefined && recipe !== null && typeof recipe !== "string")
    return refuse(422, "Send the recipe as Markdown text.");

  if (isOlderAwml(description)) return refuse(400, PLATFORM_IS_TOO_OLD);

  const pushed = await pushedVisibility(owner, existing, body.visibility, "platform");
  if (!pushed.ok) return pushed;
  const { visibility } = pushed;

  const checked = await checkDescription(description, platformAddress(owner.slug, slug));
  if (checked.errors.length) return refuse(422, ...checked.errors);
  const label = checked.label!;

  let p = existing;
  if (!p) {
    [p] = await db
      .insert(platform)
      .values({
        ownerUserId: owner.type === "user" ? owner.id : null,
        ownerOrganisationId: owner.type === "organisation" ? owner.id : null,
        slug,
        label,
        visibility,
      })
      .onConflictDoNothing()
      .returning();
    p ??= (await findPlatform(db, owner, slug))!;
  }

  // Two pushes at once can pick the same number; the unique index refuses
  // the second, which tries the next number.
  let number = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ latest }] = await db
      .select({ latest: max(platformVersion.number) })
      .from(platformVersion)
      .where(eq(platformVersion.platformId, p.id));
    number = (latest ?? 0) + 1;
    const inserted = await db
      .insert(platformVersion)
      .values({ platformId: p.id, number, pushedBy: viewer.id, description, recipe: recipe ?? null })
      .onConflictDoNothing()
      .returning({ id: platformVersion.id });
    if (inserted.length) break;
    if (attempt === 4) throw new Error("could not number the version");
  }
  await db.update(platform).set({ label, updatedAt: new Date() }).where(eq(platform.id, p.id));
  if (owner.type === "organisation") await record(db, owner.id, viewer.id, "push", platformTarget(owner.slug, slug, number));
  return { ok: true, owner: owner.slug, slug, number };
}

// A platform's versions, newest first: who pushed each and when, and the
// AWML its description says it is.
async function versionList(db: Db, platformId: string) {
  const rows = await db
    .select({
      number: platformVersion.number,
      pushedAt: platformVersion.pushedAt,
      pushedBy: user.username,
      description: platformVersion.description,
    })
    .from(platformVersion)
    .innerJoin(user, eq(user.id, platformVersion.pushedBy))
    .where(eq(platformVersion.platformId, platformId))
    .orderBy(desc(platformVersion.number));
  return rows.map(({ description, ...v }) => ({ ...v, awml: awmlOf(description) }));
}

// A platform version the viewer may read, or null: a private platform is the
// same as one that does not exist to anyone outside its organisation. This
// records nothing; a caller that shows the platform records the view.
export async function findReadablePlatformVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  n: string | number | "latest",
) {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return null;
  const p = await findPlatform(db, owner, slug);
  if (!p) return null;
  if (p.visibility === "private" && !(await isOwnerOrMember(db, owner, viewer?.id))) return null;
  let where;
  if (n === "latest") where = eq(platformVersion.platformId, p.id);
  else {
    const number = typeof n === "number" ? n : /^[1-9]\d{0,8}$/.test(n) ? Number(n) : NaN;
    if (!Number.isInteger(number)) return null;
    where = and(eq(platformVersion.platformId, p.id), eq(platformVersion.number, number));
  }
  const [v] = await db
    .select({
      number: platformVersion.number,
      pushedAt: platformVersion.pushedAt,
      pushedBy: user.username,
      description: platformVersion.description,
      recipe: platformVersion.recipe,
    })
    .from(platformVersion)
    .innerJoin(user, eq(user.id, platformVersion.pushedBy))
    .where(where)
    .orderBy(desc(platformVersion.number))
    .limit(1);
  if (!v) return null;
  return { owner, platform: p, version: { ...v, label: labelOf(v.description) } };
}

// The descriptions a platform view is drawn with (AWML 0.10.1), so that it
// marks each code step a model carries out: the latest version of each
// registered platform, owner/platforms/slug, that the implementation's blocks
// name and the viewer may read, as the engine reads it, under the address its
// blocks name it by. A platform the viewer may not read is left out, as one
// that doesn't exist is, so the drawing is the one a missing platform gives.
export async function drawnDescriptions(db: Db, viewer: Viewer, file: string, implementation: string): Promise<string[]> {
  const addresses = [...new Set(blockPlatforms(file, implementation).values())].filter((id) => REGISTERED_PLATFORM.test(id)).sort();
  const found = await Promise.all(
    addresses.map(async (address) => {
      const [, owner, slug] = REGISTERED_PLATFORM.exec(address)!;
      const read = await findReadablePlatformVersion(db, viewer, owner, slug, "latest");
      return read ? [withDescriptionId(await descriptionAsRead(read.version.description), address)] : [];
    }),
  );
  return found.flat();
}

// The label a description gives, which the platform's own label follows as
// each version is pushed.
const labelOf = (description: string) =>
  String((parse(description) as { platform: { label: string } }).platform.label);

// Records that the viewer saw a private platform's version: its description
// or recipe, or a fit judged against it.
export async function notePrivatePlatformView(
  db: Db,
  viewer: Viewer,
  owner: { type: Owner["type"]; id: string; slug: string },
  p: Pick<Platform, "slug" | "visibility">,
  number: number,
) {
  if (p.visibility === "private" && owner.type === "organisation" && viewer)
    await record(db, owner.id, viewer.id, "private_view", platformTarget(owner.slug, p.slug, number));
}

// A platform version with its description and recipe, the latest or a given
// one, and the list of its versions.
export async function readPlatformVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  n: string | number | "latest",
) {
  const found = await findReadablePlatformVersion(db, viewer, ownerSlug, slug, n);
  if (!found) return null;
  const { owner, platform: p, version: v } = found;
  await notePrivatePlatformView(db, viewer, owner, p, v.number);
  return {
    owner: owner.slug,
    slug: p.slug,
    label: v.label,
    visibility: p.visibility,
    createdAt: p.createdAt,
    number: v.number,
    pushedAt: v.pushedAt,
    pushedBy: v.pushedBy,
    description: v.description,
    recipe: v.recipe,
    versions: await versionList(db, p.id),
  };
}

const ownerSlugSql = sql<string>`coalesce(
  (select username from user where user.id = ${platform.ownerUserId}),
  (select slug from organisation where organisation.id = ${platform.ownerOrganisationId})
)`;

const isLatest = sql`${platformVersion.number} = (select max(v2.number) from platform_version v2 where v2.platform_id = ${platformVersion.platformId})`;

const hasRecipe = sql<number>`${platformVersion.recipe} is not null`;

// Every platform the viewer may see, newest first, with its latest version:
// the public ones, and the private ones of the organisations they belong to.
// With a query, only those whose label or slug has it.
export async function visiblePlatforms(db: Db, viewer: Viewer, query = "") {
  const q = query.trim();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const theirs = viewer
    ? inArray(
        platform.ownerOrganisationId,
        db.select({ id: membership.organisationId }).from(membership).where(eq(membership.userId, viewer.id)),
      )
    : undefined;
  return db
    .select({
      owner: ownerSlugSql,
      ownerType: sql<Owner["type"]>`case when ${platform.ownerUserId} is null then 'organisation' else 'user' end`,
      ownerId: sql<string>`coalesce(${platform.ownerUserId}, ${platform.ownerOrganisationId})`,
      slug: platform.slug,
      label: platform.label,
      visibility: platform.visibility,
      updatedAt: platform.updatedAt,
      number: platformVersion.number,
      description: platformVersion.description,
      hasRecipe,
    })
    .from(platform)
    .innerJoin(platformVersion, and(eq(platformVersion.platformId, platform.id), isLatest))
    .where(
      and(
        theirs ? or(eq(platform.visibility, "public"), theirs) : eq(platform.visibility, "public"),
        q ? sql`(${platform.label} like ${like} escape '\\' or ${platform.slug} like ${like} escape '\\')` : undefined,
      ),
    )
    .orderBy(desc(platform.updatedAt));
}

// The platforms the viewer may see whose label or slug has the query: public
// ones, and their organisations' own.
export async function searchPlatforms(db: Db, viewer: Viewer, query = "") {
  const rows = await visiblePlatforms(db, viewer, query);
  return rows.map(({ owner, slug, label, visibility, updatedAt }) => ({ owner, slug, label, visibility, updatedAt }));
}

// An owner's platforms with their latest version, by slug: the public ones to
// everyone, the private ones to members too, as an owner's page lists its
// workflows. The list records nothing; opening a private platform's file does.
export async function ownerPlatforms(db: Db, viewer: Viewer, ownerSlug: string) {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return null;
  const member = await isOwnerOrMember(db, owner, viewer?.id);
  const rows = await db
    .select({
      slug: platform.slug,
      label: platform.label,
      visibility: platform.visibility,
      number: platformVersion.number,
      hasRecipe,
    })
    .from(platform)
    .innerJoin(platformVersion, and(eq(platformVersion.platformId, platform.id), isLatest))
    .where(and(ownerColumn(owner), member ? undefined : eq(platform.visibility, "public")))
    .orderBy(platform.slug);
  return { owner, member, platforms: rows.map((p) => ({ ...p, owner: owner.slug, hasRecipe: Boolean(p.hasRecipe) })) };
}
