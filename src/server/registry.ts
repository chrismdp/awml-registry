import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { parse } from "yaml";
import type { Db } from "@/db/client";
import { user, version, workflow } from "@/db/schema";
import { edition } from "@/edition";
import { engine, type Files } from "@/engine";
import { record } from "./audit";
import { measures, total } from "./summary";
import { findOwner, isOwnerOrMember, type Owner } from "./owners";
import { refuse, type Result } from "./result";
import { workflowSlugProblem } from "./slugs";
import type { Viewer } from "./viewer";

export const VIEWS = ["security", "platform"] as const;
export type View = (typeof VIEWS)[number];
export type Visibility = "public" | "private";

type Workflow = typeof workflow.$inferSelect;

export type PushBody = { security?: unknown; platform?: unknown; visibility?: unknown };

function ownerColumn(owner: Owner) {
  return owner.type === "user"
    ? eq(workflow.ownerUserId, owner.id)
    : eq(workflow.ownerOrganisationId, owner.id);
}

async function findWorkflow(db: Db, owner: Owner, slug: string) {
  const [w] = await db
    .select()
    .from(workflow)
    .where(and(ownerColumn(owner), eq(workflow.slug, slug)))
    .limit(1);
  return w ?? null;
}

// A workflow the viewer may read, or null: a private workflow is the same as
// one that does not exist to anyone outside its organisation.
async function readable(db: Db, viewer: Viewer, ownerSlug: string, slug: string) {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return null;
  const w = await findWorkflow(db, owner, slug);
  if (!w) return null;
  if (w.visibility === "private" && !(await isOwnerOrMember(db, owner, viewer?.id))) return null;
  return { owner, workflow: w };
}

// The files sent in a push, each a string of YAML, at least one of them.
function filesFrom(body: PushBody): Result<{ files: Files }> {
  const files: Files = {};
  for (const view of VIEWS) {
    const text = body[view];
    if (text === undefined || text === null) continue;
    if (typeof text !== "string") return refuse(422, `${view}: send the file as a string of YAML.`);
    files[view] = text;
  }
  if (!files.security && !files.platform)
    return refuse(422, "Send at least one file: security, platform or both.");
  return { ok: true, files };
}

// The mistakes `awml check` finds in each file, each with its view in front,
// and the title the files give.
async function checkFiles(files: Files) {
  const errors: string[] = [];
  const check: Partial<Record<View, string[]>> = {};
  let title: string | undefined;
  for (const view of VIEWS) {
    const text = files[view];
    if (text === undefined) continue;
    const found = await engine.check(text);
    check[view] = found;
    errors.push(...found.map((e) => `${view}: ${e}`));
    if (found.length) continue;
    const doc = parse(text) as { view?: string; title?: string };
    if (doc.view !== view)
      errors.push(`${view}: this file says view: ${doc.view}, so send it as the ${doc.view} file.`);
    title ??= doc.title;
  }
  return { errors, check, title };
}

// The mistakes in a workflow's files, the same a push is refused for. It needs
// no account and saves nothing.
export async function checkWorkflow(body: PushBody): Promise<Result<{ mistakes: string[] }>> {
  const read = filesFrom(body);
  if (!read.ok) return read;
  return { ok: true, mistakes: (await checkFiles(read.files)).errors };
}

async function notePrivateView(db: Db, viewer: Viewer, owner: Owner, w: Workflow, target: string) {
  if (w.visibility === "private" && owner.type === "organisation" && viewer)
    await record(db, owner.id, viewer.id, "private_view", target);
}

export async function pushVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  body: PushBody,
): Promise<Result<{ owner: string; slug: string; number: number }>> {
  if (!viewer) return refuse(401, "Sign in, or send a token as Authorization: Bearer <token>.");
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return refuse(404, "Not found.");
  const existing = await findWorkflow(db, owner, slug);
  const allowed = await isOwnerOrMember(db, owner, viewer.id);
  if (!allowed) {
    if (existing?.visibility === "private") return refuse(404, "Not found.");
    return refuse(403, `Only ${owner.type === "user" ? owner.slug : `members of ${owner.slug}`} can push here.`);
  }

  const slugProblem = workflowSlugProblem(slug);
  if (slugProblem) return refuse(422, slugProblem);

  const read = filesFrom(body);
  if (!read.ok) return read;
  const { files } = read;

  const requested = body.visibility;
  if (requested !== undefined && requested !== "public" && requested !== "private")
    return refuse(422, 'visibility is "public" or "private".');
  if (existing && requested && requested !== existing.visibility)
    return refuse(
      422,
      `This workflow is ${existing.visibility}. Its first push set that, and a later push cannot change it.`,
    );
  const visibility: Visibility = existing?.visibility ?? (requested as Visibility | undefined) ?? "public";

  if (owner.type === "user" && visibility === "private")
    return refuse(422, "Private workflows belong to organisations. Push it to one of yours.");
  if (owner.type === "organisation") {
    if (!(await edition.canPush(owner)))
      return refuse(403, `${owner.slug} cannot push new versions at the moment. Reading still works.`);
    if (visibility === "private" && !(await edition.canKeepPrivate(owner)))
      return refuse(403, `${owner.slug} cannot keep private workflows.`);
  }

  const { errors, check, title } = await checkFiles(files);
  if (errors.length) return refuse(422, ...errors);

  const summary = await engine.summarise(files);
  let w = existing;
  if (!w) {
    [w] = await db
      .insert(workflow)
      .values({
        ownerUserId: owner.type === "user" ? owner.id : null,
        ownerOrganisationId: owner.type === "organisation" ? owner.id : null,
        slug,
        title: title!,
        visibility,
      })
      .onConflictDoNothing()
      .returning();
    w ??= (await findWorkflow(db, owner, slug))!;
  }

  // Two pushes at once can pick the same number; the unique index refuses
  // the second, which tries the next number.
  let number = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ latest }] = await db
      .select({ latest: max(version.number) })
      .from(version)
      .where(eq(version.workflowId, w.id));
    number = (latest ?? 0) + 1;
    const inserted = await db
      .insert(version)
      .values({
        workflowId: w.id,
        number,
        pushedBy: viewer.id,
        security: files.security ?? null,
        platform: files.platform ?? null,
        check,
        summary,
      })
      .onConflictDoNothing()
      .returning({ id: version.id });
    if (inserted.length) break;
    if (attempt === 4) throw new Error("could not number the version");
  }
  await db.update(workflow).set({ title: title!, updatedAt: new Date() }).where(eq(workflow.id, w.id));
  if (owner.type === "organisation") await record(db, owner.id, viewer.id, "push", `${owner.slug}/${slug} v${number}`);
  return { ok: true, owner: owner.slug, slug, number };
}

async function versionList(db: Db, workflowId: string) {
  return db
    .select({ number: version.number, pushedAt: version.pushedAt, pushedBy: user.username })
    .from(version)
    .innerJoin(user, eq(user.id, version.pushedBy))
    .where(eq(version.workflowId, workflowId))
    .orderBy(desc(version.number));
}

export async function readWorkflow(db: Db, viewer: Viewer, ownerSlug: string, slug: string) {
  const found = await readable(db, viewer, ownerSlug, slug);
  if (!found) return null;
  const { owner, workflow: w } = found;
  await notePrivateView(db, viewer, owner, w, `${owner.slug}/${w.slug}`);
  return {
    owner: owner.slug,
    ownerType: owner.type,
    slug: w.slug,
    title: w.title,
    visibility: w.visibility,
    createdAt: w.createdAt,
    versions: await versionList(db, w.id),
  };
}

export async function readVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  n: string | number | "latest",
) {
  const found = await readable(db, viewer, ownerSlug, slug);
  if (!found) return null;
  const { owner, workflow: w } = found;
  let where;
  if (n === "latest") where = eq(version.workflowId, w.id);
  else {
    const number = typeof n === "number" ? n : /^[1-9]\d{0,8}$/.test(n) ? Number(n) : NaN;
    if (!Number.isInteger(number)) return null;
    where = and(eq(version.workflowId, w.id), eq(version.number, number));
  }
  const [v] = await db
    .select({
      number: version.number,
      pushedAt: version.pushedAt,
      pushedBy: user.username,
      security: version.security,
      platform: version.platform,
      check: version.check,
      summary: version.summary,
    })
    .from(version)
    .innerJoin(user, eq(user.id, version.pushedBy))
    .where(where)
    .orderBy(desc(version.number))
    .limit(1);
  if (!v) return null;
  await notePrivateView(db, viewer, owner, w, `${owner.slug}/${w.slug} v${v.number}`);
  const files: Files = {};
  if (v.security !== null) files.security = v.security;
  if (v.platform !== null) files.platform = v.platform;
  return {
    owner: owner.slug,
    ownerType: owner.type,
    slug: w.slug,
    title: w.title,
    visibility: w.visibility,
    number: v.number,
    pushedAt: v.pushedAt,
    pushedBy: v.pushedBy,
    files,
    check: v.check,
    summary: v.summary,
    versions: await versionList(db, w.id),
  };
}

const ownerSlugSql = sql<string>`coalesce(
  (select username from user where user.id = ${workflow.ownerUserId}),
  (select slug from organisation where organisation.id = ${workflow.ownerOrganisationId})
)`;

const isLatest = sql`${version.number} = (select max(v2.number) from version v2 where v2.workflow_id = ${version.workflowId})`;

// The public gallery, newest first, searched by title, with each workflow's
// latest summary and the file its card draws: the security view, or the
// platform view when there is no security file.
export async function explore(db: Db, query = "", limit = 50) {
  const q = query.trim();
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db
    .select({
      owner: ownerSlugSql,
      slug: workflow.slug,
      title: workflow.title,
      updatedAt: workflow.updatedAt,
      summary: version.summary,
      drawn: sql<string>`coalesce(${version.security}, ${version.platform})`,
    })
    .from(workflow)
    .innerJoin(version, and(eq(version.workflowId, workflow.id), isLatest))
    .where(
      and(
        eq(workflow.visibility, "public"),
        q ? sql`${workflow.title} like ${`%${escaped}%`} escape '\\'` : undefined,
      ),
    )
    .orderBy(desc(workflow.updatedAt))
    .limit(limit);
}

// An owner's workflows: the public ones to everyone, the private ones to members too.
export async function ownerPage(db: Db, viewer: Viewer, ownerSlug: string) {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return null;
  const member = await isOwnerOrMember(db, owner, viewer?.id);
  const workflows = await db
    .select({ slug: workflow.slug, title: workflow.title, visibility: workflow.visibility, updatedAt: workflow.updatedAt })
    .from(workflow)
    .where(and(ownerColumn(owner), member ? undefined : eq(workflow.visibility, "public")))
    .orderBy(desc(workflow.updatedAt));
  return { owner, member, workflows };
}

// Every workflow of an organisation with its latest summary, and the totals across them.
export async function inventory(db: Db, viewer: Viewer, orgSlug: string) {
  const owner = await findOwner(db, orgSlug);
  if (!owner || owner.type !== "organisation") return null;
  if (!(await isOwnerOrMember(db, owner, viewer?.id))) return null;
  const workflows = await db
    .select({ id: workflow.id, slug: workflow.slug, title: workflow.title, visibility: workflow.visibility })
    .from(workflow)
    .where(eq(workflow.ownerOrganisationId, owner.id))
    .orderBy(workflow.slug);
  const ids = workflows.map((w) => w.id);
  const latest = ids.length
    ? await db
        .select({
          workflowId: version.workflowId,
          number: version.number,
          summary: version.summary,
          hasSecurity: sql<number>`${version.security} is not null`,
          hasPlatform: sql<number>`${version.platform} is not null`,
        })
        .from(version)
        .where(and(inArray(version.workflowId, ids), isLatest))
    : [];
  const byWorkflow = new Map(latest.map((l) => [l.workflowId, l]));
  const rows = workflows.map((w) => {
    const l = byWorkflow.get(w.id);
    return {
      slug: w.slug,
      title: w.title,
      visibility: w.visibility,
      latest: l?.number ?? null,
      summary: l?.summary ?? null,
      hasSecurity: Boolean(l?.hasSecurity),
      hasPlatform: Boolean(l?.hasPlatform),
    };
  });
  const summaries = rows.flatMap((r) => (r.summary ? [r.summary] : []));
  return { organisation: owner, rows, totals: total(summaries), measures: measures(summaries) };
}

