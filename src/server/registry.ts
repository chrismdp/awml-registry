import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { user, version, workflow } from "@/db/schema";
import { edition } from "@/edition";
import { engine, type Files } from "@/engine";
import { record } from "./audit";
import { measures, total } from "./summary";
import { findOwner, isOwnerOrMember, type Owner } from "./owners";
import { mayPushTo, pushedVisibility, SIGN_IN_TO_PUSH } from "./push";
import { awmlOf, isOlderAwml, readYaml, WORKFLOW_IS_NOT_04 } from "./awml-file";
import { refuse, type Result } from "./result";
import { workflowSlugProblem } from "./slugs";
import type { Viewer } from "./viewer";

export const VIEWS = ["security", "platform"] as const;
export type View = (typeof VIEWS)[number];

// A version's files by the names their downloads use: one 0.4 workflow, or
// the security and platform files of a version stored before.
export const FILES = ["workflow", ...VIEWS] as const;
export type FileName = (typeof FILES)[number];

type Workflow = typeof workflow.$inferSelect;

export type PushBody = { workflow?: unknown; security?: unknown; platform?: unknown; visibility?: unknown };

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

// The one file a push sends: an AWML 0.4 workflow, as `workflow`, or alone
// as `security`, as awml push 0.4.0 sends it. Anything marked as an older
// AWML is refused with a 400 that says how to convert it, whichever field it
// came in.
function fileFrom(body: PushBody): Result<{ file: string }> {
  const sent: string[] = [];
  for (const field of ["workflow", "security", "platform"] as const) {
    const text = body[field];
    if (text === undefined || text === null) continue;
    if (typeof text !== "string") return refuse(422, `${field}: send the file as a string of YAML.`);
    sent.push(text);
  }
  if (sent.some(isOlderAwml)) return refuse(400, WORKFLOW_IS_NOT_04);
  if (sent.length === 0) return refuse(422, "Send the workflow's AWML 0.4 file as workflow.");
  if (sent.length > 1)
    return refuse(422, "Send one file, as workflow: an AWML 0.4 workflow holds its design and its implementations.");
  return { ok: true, file: sent[0] };
}

// The mistakes `awml check` finds in the file, each with "workflow: " in
// front, and the title it gives.
async function checkFile(file: string) {
  const found = await engine.check(file);
  const errors = found.map((e) => `workflow: ${e}`);
  const doc = found.length ? null : readYaml(file);
  if (doc?.platform !== undefined && doc?.parts === undefined)
    errors.push("workflow: this is a platform description, not a workflow. Push it as a platform.");
  return { errors, check: { workflow: found }, title: doc?.title === undefined ? undefined : String(doc.title) };
}

// The mistakes in a workflow's file, the same a push is refused for. It needs
// no account and saves nothing.
export async function checkWorkflow(body: PushBody): Promise<Result<{ mistakes: string[] }>> {
  const read = fileFrom(body);
  if (!read.ok) return read;
  return { ok: true, mistakes: (await checkFile(read.file)).errors };
}

async function notePrivateView(db: Db, viewer: Viewer, owner: Owner, w: Workflow, target: string) {
  if (w.visibility === "private" && owner.type === "organisation" && viewer)
    await record(db, owner.id, viewer.id, "private_view", target);
}

// Whether a user may make one more private workflow on their own account,
// under the limit the edition sets them. An organisation has none.
async function roomForPrivate(db: Db, owner: Owner & { type: "user" }): Promise<Result<{}>> {
  const limit = await edition.privateWorkflowLimit({ id: owner.id, username: owner.slug });
  if (limit === null) return { ok: true };
  const [{ has }] = await db
    .select({ has: count() })
    .from(workflow)
    .where(and(eq(workflow.ownerUserId, owner.id), eq(workflow.visibility, "private")));
  if (has < limit) return { ok: true };
  return refuse(
    403,
    `${owner.slug} can keep ${limit} private workflows and has ${has}. An organisation has no such limit: push it to one of yours, or make it public.`,
  );
}

export async function pushVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  body: PushBody,
): Promise<Result<{ owner: string; slug: string; number: number }>> {
  if (!viewer) return refuse(401, SIGN_IN_TO_PUSH);
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return refuse(404, "Not found.");
  const existing = await findWorkflow(db, owner, slug);
  const allowed = await mayPushTo(db, viewer, owner, existing);
  if (!allowed.ok) return allowed;

  const slugProblem = workflowSlugProblem(slug);
  if (slugProblem) return refuse(422, slugProblem);

  const read = fileFrom(body);
  if (!read.ok) return read;
  const { file } = read;

  const pushed = await pushedVisibility(owner, existing, body.visibility, "workflow");
  if (!pushed.ok) return pushed;
  const { visibility } = pushed;
  if (!existing && visibility === "private" && owner.type === "user") {
    const room = await roomForPrivate(db, owner);
    if (!room.ok) return room;
  }

  const { errors, check, title } = await checkFile(file);
  if (errors.length) return refuse(422, ...errors);

  const summary = await engine.summarise({ workflow: file });
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
        workflow: file,
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

// A workflow's versions, newest first: who pushed each and when, and the
// AWML its file says it is, or for a version stored before, its security or
// platform file.
async function versionList(db: Db, workflowId: string) {
  const rows = await db
    .select({
      number: version.number,
      pushedAt: version.pushedAt,
      pushedBy: user.username,
      file: sql<string | null>`coalesce(${version.workflow}, ${version.security}, ${version.platform})`,
    })
    .from(version)
    .innerJoin(user, eq(user.id, version.pushedBy))
    .where(eq(version.workflowId, workflowId))
    .orderBy(desc(version.number));
  return rows.map(({ file, ...v }) => ({ ...v, awml: awmlOf(file) }));
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
      workflow: version.workflow,
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
  if (v.workflow !== null) files.workflow = v.workflow;
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
// latest summary and the file its card draws: the 0.4 workflow, whose
// security view is drawn, or for a version stored before, the security view,
// or the platform view when there is no security file.
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
      drawn: sql<string>`coalesce(${version.workflow}, ${version.security}, ${version.platform})`,
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
          hasSecurity: sql<number>`${version.workflow} is not null or ${version.security} is not null`,
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
      // A 0.4 workflow says where it runs in its implementations, whose
      // blocks its summary counts as platforms.
      hasPlatform: Boolean(l?.hasPlatform) || (l?.summary.platforms ?? 0) > 0,
    };
  });
  const summaries = rows.flatMap((r) => (r.summary ? [r.summary] : []));
  return { organisation: owner, rows, totals: total(summaries), measures: measures(summaries) };
}

