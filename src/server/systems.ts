// Systems: several workflows given to the engine together, stored as a thing
// of their own at /{owner}/systems/{slug}. A system is owned, versioned and
// kept private exactly as a platform is. Each version holds a title, a
// Markdown description and its members, which follow their latest version, so
// a version records only which workflows are in it. What a system may hold is
// judged by what its owner may see, as a workflow's refs are: a public
// workflow of any owner, the owner's own, and for a person, the private ones
// of their organisations. So an organisation's system holds only its own
// workflows and public ones. The pusher must see each member too. A viewer
// sees only the members they may see, and of the others only how many there
// are.
import { and, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { insertRows } from "@/db/rows";
import { membership, system, systemMember, systemVersion, user, version, workflow } from "@/db/schema";
import type { Files } from "@/engine";
import { record } from "./audit";
import { awmlOf } from "./awml-file";
import { findOwner, isOwnerOrMember, ownerMaySee, type Owner } from "./owners";
import { mayPushTo, pushedVisibility, SIGN_IN_TO_PUSH, type Visibility } from "./push";
import { refuse, type Result } from "./result";
import { systemSlugProblem } from "./slugs";
import type { Viewer } from "./viewer";

export type SystemPushBody = { title?: unknown; description?: unknown; members?: unknown; visibility?: unknown };

// Where a system lives in the audit log: its path on the site.
export const systemTarget = (owner: string, slug: string, number: number) => `${owner}/systems/${slug} v${number}`;

function ownerColumn(owner: Owner) {
  return owner.type === "user" ? eq(system.ownerUserId, owner.id) : eq(system.ownerOrganisationId, owner.id);
}

async function findSystem(db: Db, owner: Owner, slug: string) {
  const [s] = await db
    .select()
    .from(system)
    .where(and(ownerColumn(owner), eq(system.slug, slug)))
    .limit(1);
  return s ?? null;
}

const MEMBER = /^([^/\s]+)\/([^/\s]+)$/;

type Held = { id: string; owner: Owner; slug: string };

// A workflow a system of the holder may have as a member, by its owner and
// slug, or null: one the holder may see and the pusher may see too. A private
// workflow outside either is the same as one that doesn't exist.
async function heldWorkflow(db: Db, viewer: Viewer, holder: Owner, ownerSlug: string, slug: string): Promise<Held | null> {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return null;
  const [w] = await db
    .select({ id: workflow.id, visibility: workflow.visibility })
    .from(workflow)
    .where(
      and(
        owner.type === "user" ? eq(workflow.ownerUserId, owner.id) : eq(workflow.ownerOrganisationId, owner.id),
        eq(workflow.slug, slug),
      ),
    )
    .limit(1);
  if (!w) return null;
  // A backstop that never decides alone: only the holder or its members push,
  // and each of them may see every workflow the next check lets the holder hold.
  if (w.visibility === "private" && !(await isOwnerOrMember(db, owner, viewer?.id))) return null;
  if (!(await ownerMaySee(db, holder, owner, w.visibility))) return null;
  return { id: w.id, owner, slug };
}

// The refusal of a member, the same whether the system's owner may not hold
// it, the pusher may not see it or it doesn't exist.
const notHeld = (m: string, holder: Owner) =>
  holder.type === "organisation"
    ? `members: ${m} is not a workflow ${holder.slug}'s systems may hold: a public one, or one of ${holder.slug}'s own.`
    : `members: ${m} is not a workflow ${holder.slug}'s systems may hold: a public one, one of ${holder.slug}'s own, or one of an organisation ${holder.slug} belongs to.`;

// The members a push names, once each, each a workflow the system's owner may
// hold and the pusher may see. Any other is refused as a missing one is, so a
// push tells nobody whether a private workflow is there.
async function membersOf(
  db: Db,
  viewer: Viewer,
  holder: Owner,
  members: unknown,
): Promise<Result<{ found: Held[] }>> {
  if (!Array.isArray(members) || members.length === 0)
    return refuse(422, "members: name at least one workflow, as owner/slug.");
  const errors: string[] = [];
  const named = new Set<string>();
  const found: Held[] = [];
  for (const m of members) {
    const match = typeof m === "string" ? MEMBER.exec(m) : null;
    if (!match) {
      errors.push(`members: ${JSON.stringify(m)} is not owner/slug.`);
      continue;
    }
    if (named.has(m)) {
      errors.push(`members: ${m} is named twice.`);
      continue;
    }
    named.add(m);
    const w = await heldWorkflow(db, viewer, holder, match[1], match[2]);
    if (!w) errors.push(notHeld(m, holder));
    else found.push(w);
  }
  return errors.length ? refuse(422, ...errors) : { ok: true, found };
}

// Saves a new version of a system, by the rules a workflow's push follows:
// only the user, or an organisation's members, may push to its systems.
export async function pushSystemVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  body: SystemPushBody,
): Promise<Result<{ owner: string; slug: string; number: number }>> {
  if (!viewer) return refuse(401, SIGN_IN_TO_PUSH);
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return refuse(404, "Not found.");
  const allowed = await mayPushTo(db, viewer, owner);
  if (!allowed.ok) return allowed;
  const existing = await findSystem(db, owner, slug);

  const slugProblem = systemSlugProblem(slug);
  if (slugProblem) return refuse(422, slugProblem);

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return refuse(422, "title: give the system a title.");
  const { description } = body;
  if (description !== undefined && description !== null && typeof description !== "string")
    return refuse(422, "description: send it as Markdown text.");

  const pushed = await pushedVisibility(owner, existing, body.visibility, "system");
  if (!pushed.ok) return pushed;
  const { visibility } = pushed;

  const members = await membersOf(db, viewer, owner, body.members);
  if (!members.ok) return members;

  let s = existing;
  if (!s) {
    [s] = await db
      .insert(system)
      .values({
        ownerUserId: owner.type === "user" ? owner.id : null,
        ownerOrganisationId: owner.type === "organisation" ? owner.id : null,
        slug,
        title,
        visibility,
      })
      .onConflictDoNothing()
      .returning();
    s ??= (await findSystem(db, owner, slug))!;
  }

  // Two pushes at once can pick the same number; the unique index refuses
  // the second, which tries the next number.
  let number = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ latest }] = await db
      .select({ latest: max(systemVersion.number) })
      .from(systemVersion)
      .where(eq(systemVersion.systemId, s.id));
    number = (latest ?? 0) + 1;
    const inserted = await db
      .insert(systemVersion)
      .values({ systemId: s.id, number, pushedBy: viewer.id, title, description: description ?? "" })
      .onConflictDoNothing()
      .returning({ id: systemVersion.id });
    if (inserted.length) {
      // A version is never left without its members: if they can't all be
      // written, the version goes too, and the members written with it.
      try {
        await insertRows(
          db,
          systemMember,
          members.found.map((m, position) => ({
            versionId: inserted[0].id,
            position,
            workflowId: m.id,
            owner: m.owner.slug,
            slug: m.slug,
            ownerUserId: m.owner.type === "user" ? m.owner.id : null,
            ownerOrganisationId: m.owner.type === "organisation" ? m.owner.id : null,
          })),
        );
      } catch (e) {
        await db.delete(systemVersion).where(eq(systemVersion.id, inserted[0].id));
        throw e;
      }
      break;
    }
    if (attempt === 4) throw new Error("could not number the version");
  }
  await db.update(system).set({ title, updatedAt: new Date() }).where(eq(system.id, s.id));
  if (owner.type === "organisation") await record(db, owner.id, viewer.id, "push", systemTarget(owner.slug, slug, number));
  return { ok: true, owner: owner.slug, slug, number };
}

// A system's versions, newest first: who pushed each and when. A system
// version is no AWML file, so it names no AWML.
async function versionList(db: Db, systemId: string) {
  const rows = await db
    .select({ number: systemVersion.number, pushedAt: systemVersion.pushedAt, pushedBy: user.username })
    .from(systemVersion)
    .innerJoin(user, eq(user.id, systemVersion.pushedBy))
    .where(eq(systemVersion.systemId, systemId))
    .orderBy(desc(systemVersion.number));
  return rows.map((v) => ({ ...v, awml: null }));
}

// A member as the viewer may know it: a workflow they may see, with its
// latest version's files; or one deleted, to the account that owned it when
// it was pushed, or its members. Every other member is only counted.
export type SeenMember =
  | {
      state: "found";
      owner: string;
      slug: string;
      title: string;
      visibility: Visibility;
      number: number;
      files: Files;
      awml: string | null;
    }
  | { state: "missing"; owner: string; slug: string };

const workflowOwnerSql = sql<string>`coalesce(
  (select username from user where user.id = ${workflow.ownerUserId}),
  (select slug from organisation where organisation.id = ${workflow.ownerOrganisationId})
)`;

// An owner by its account, user or organisation, as a row holds it.
const ownerOf = (row: { ownerUserId: string | null; ownerOrganisationId: string | null }, slug: string): Owner =>
  row.ownerUserId
    ? { type: "user", id: row.ownerUserId, slug, name: "" }
    : { type: "organisation", id: row.ownerOrganisationId!, slug, name: "" };

// Each member of a system's version the viewer may see, in the order pushed,
// and how many they may not. A member made private since it was added is
// hidden as any private member is.
async function membersAsSeen(db: Db, viewer: Viewer, versionId: string) {
  const rows = await db
    .select({
      owner: systemMember.owner,
      slug: systemMember.slug,
      ownerUserId: systemMember.ownerUserId,
      ownerOrganisationId: systemMember.ownerOrganisationId,
      // The workflow as it is now; its id is null when it has been deleted.
      workflow: {
        id: workflow.id,
        owner: workflowOwnerSql,
        ownerUserId: workflow.ownerUserId,
        ownerOrganisationId: workflow.ownerOrganisationId,
        slug: workflow.slug,
        title: workflow.title,
        visibility: workflow.visibility,
      },
    })
    .from(systemMember)
    .leftJoin(workflow, eq(workflow.id, systemMember.workflowId))
    .where(eq(systemMember.versionId, versionId))
    .orderBy(systemMember.position);
  const shown: SeenMember[] = [];
  let hidden = 0;
  for (const r of rows) {
    const w = r.workflow;
    if (!w?.id) {
      if (await isOwnerOrMember(db, ownerOf(r, r.owner), viewer?.id)) shown.push({ state: "missing", owner: r.owner, slug: r.slug });
      else hidden++;
      continue;
    }
    const owner = ownerOf(w, w.owner);
    if (w.visibility === "private" && !(await isOwnerOrMember(db, owner, viewer?.id))) {
      hidden++;
      continue;
    }
    const [latest] = await db
      .select({ number: version.number, workflow: version.workflow, security: version.security, platform: version.platform })
      .from(version)
      .where(eq(version.workflowId, w.id))
      .orderBy(desc(version.number))
      .limit(1);
    const number = latest?.number ?? 0;
    const files: Files = {};
    if (latest?.workflow != null) files.workflow = latest.workflow;
    if (latest?.security != null) files.security = latest.security;
    if (latest?.platform != null) files.platform = latest.platform;
    // Recorded as opening the workflow at that version is.
    if (w.visibility === "private" && owner.type === "organisation" && viewer)
      await record(db, owner.id, viewer.id, "private_view", `${w.owner}/${w.slug} v${number}`);
    shown.push({
      state: "found",
      owner: w.owner,
      slug: w.slug,
      title: w.title,
      visibility: w.visibility,
      number,
      files,
      awml: awmlOf(files.workflow ?? files.security ?? files.platform ?? null),
    });
  }
  return { members: shown, hidden };
}

// A system version the viewer may read, the latest or a given one, with its
// members as the viewer may see them and the list of its versions; or null:
// a private system is the same as one that doesn't exist to anyone outside
// it. Seeing a private system, or a private member of an organisation, is
// recorded in its audit log.
export async function readSystemVersion(db: Db, viewer: Viewer, ownerSlug: string, slug: string, n: string | number | "latest") {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return null;
  const s = await findSystem(db, owner, slug);
  if (!s) return null;
  if (s.visibility === "private" && !(await isOwnerOrMember(db, owner, viewer?.id))) return null;
  let where;
  if (n === "latest") where = eq(systemVersion.systemId, s.id);
  else {
    const number = typeof n === "number" ? n : /^[1-9]\d{0,8}$/.test(n) ? Number(n) : NaN;
    if (!Number.isInteger(number)) return null;
    where = and(eq(systemVersion.systemId, s.id), eq(systemVersion.number, number));
  }
  const [v] = await db
    .select({
      id: systemVersion.id,
      number: systemVersion.number,
      pushedAt: systemVersion.pushedAt,
      pushedBy: user.username,
      title: systemVersion.title,
      description: systemVersion.description,
    })
    .from(systemVersion)
    .innerJoin(user, eq(user.id, systemVersion.pushedBy))
    .where(where)
    .orderBy(desc(systemVersion.number))
    .limit(1);
  if (!v) return null;
  if (s.visibility === "private" && owner.type === "organisation" && viewer)
    await record(db, owner.id, viewer.id, "private_view", systemTarget(owner.slug, s.slug, v.number));
  return {
    owner,
    slug: s.slug,
    visibility: s.visibility,
    number: v.number,
    pushedAt: v.pushedAt,
    pushedBy: v.pushedBy,
    title: v.title,
    description: v.description,
    ...(await membersAsSeen(db, viewer, v.id)),
    versions: await versionList(db, s.id),
  };
}

const systemOwnerSql = sql<string>`coalesce(
  (select username from user where user.id = ${system.ownerUserId}),
  (select slug from organisation where organisation.id = ${system.ownerOrganisationId})
)`;

const isLatest = sql`${systemVersion.number} = (select max(v2.number) from system_version v2 where v2.system_id = ${systemVersion.systemId})`;

// The systems the viewer may see, as a condition on the system table: the
// public ones, and the private ones of the viewer and their organisations.
// Their organisations are asked for in the same statement, however many.
function seenBy(db: Db, viewer: Viewer) {
  return or(
    eq(system.visibility, "public"),
    viewer ? eq(system.ownerUserId, viewer.id) : undefined,
    viewer
      ? inArray(
          system.ownerOrganisationId,
          db.select({ id: membership.organisationId }).from(membership).where(eq(membership.userId, viewer.id)),
        )
      : undefined,
  );
}

export type ListedSystem = { owner: string; slug: string; title: string; visibility: Visibility };

// The systems whose latest version has the workflow as a member, that the
// viewer may see, by owner and slug. A private system is never listed or
// counted to anyone outside it.
export async function systemsOf(db: Db, viewer: Viewer, workflowId: string): Promise<ListedSystem[]> {
  const rows = await db
    .selectDistinct({ owner: systemOwnerSql, slug: system.slug, title: system.title, visibility: system.visibility })
    .from(systemMember)
    .innerJoin(systemVersion, and(eq(systemVersion.id, systemMember.versionId), isLatest))
    .innerJoin(system, eq(system.id, systemVersion.systemId))
    .where(and(eq(systemMember.workflowId, workflowId), seenBy(db, viewer)));
  return rows.sort((a, b) => `${a.owner}/${a.slug}`.localeCompare(`${b.owner}/${b.slug}`));
}

// An owner's systems by slug: the public ones to everyone, the private ones
// to its members, or to the user, too.
export async function ownerSystems(db: Db, owner: Owner, member: boolean) {
  return db
    .select({ slug: system.slug, title: system.title, visibility: system.visibility, updatedAt: system.updatedAt })
    .from(system)
    .where(and(ownerColumn(owner), member ? undefined : eq(system.visibility, "public")))
    .orderBy(system.slug);
}

// The public systems, newest first, searched by title as the gallery's
// workflows are.
export async function publicSystems(db: Db, query = "", limit = 50) {
  const q = query.trim();
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db
    .select({ owner: systemOwnerSql, slug: system.slug, title: system.title, updatedAt: system.updatedAt })
    .from(system)
    .where(and(eq(system.visibility, "public"), q ? sql`${system.title} like ${`%${escaped}%`} escape '\\'` : undefined))
    .orderBy(desc(system.updatedAt))
    .limit(limit);
}
