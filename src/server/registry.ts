import { and, count, desc, eq, inArray, max, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { insertRows } from "@/db/rows";
import { membership, user, version, workflow, workflowRef } from "@/db/schema";
import { edition } from "@/edition";
import { engine, type Files } from "@/engine";
import { record } from "./audit";
import { measures, total } from "./summary";
import { findOwner, isOwnerOrMember, type Owner } from "./owners";
import { mayPushTo, pushedVisibility, SIGN_IN_TO_PUSH } from "./push";
import { asRead } from "./as-read";
import { awmlOf, isOlderAwml, partKinds, readYaml, WORKFLOW_IS_TOO_OLD } from "./awml-file";
import { namedAtPush, refPath, rewriteRefs, type Rewrite } from "./refs";
import { refuse, type Result } from "./result";
import { workflowSlugProblem } from "./slugs";
import { ownerSystems, systemsOf } from "./systems";
import type { Viewer } from "./viewer";

export const VIEWS = ["security", "platform"] as const;
export type View = (typeof VIEWS)[number];

// A version's files by the names their downloads use: one workflow, or the
// security and platform files of a version stored before 0.4.
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

// The one file a push sends: an AWML 0.7 workflow, as `workflow`, or alone
// as `security`, as awml push 0.4.0 sent it. Anything marked as an older
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
  if (sent.some(isOlderAwml)) return refuse(400, WORKFLOW_IS_TOO_OLD);
  if (sent.length === 0) return refuse(422, "Send the workflow's AWML 0.7 file as workflow.");
  if (sent.length > 1)
    return refuse(422, "Send one file, as workflow: an AWML 0.7 workflow holds its design and its implementations.");
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

// A warning AWML gave the file pushed, by the id of the check that gave it,
// such as warn.several-workflows. A warning never refuses a push.
export type PushWarning = { check: string; message: string };

// A version saved, each path ref its push rewrote as owner/slug#id, and the
// warnings its checks gave.
type Pushed = Result<{ owner: string; slug: string; number: number; rewrites: Rewrite[]; warnings: PushWarning[] }>;

export async function pushVersion(
  db: Db,
  viewer: Viewer,
  ownerSlug: string,
  slug: string,
  body: PushBody,
): Promise<Pushed> {
  if (!viewer) return refuse(401, SIGN_IN_TO_PUSH);
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return refuse(404, "Not found.");
  return saveVersion(db, viewer, owner, slug, body);
}

// A push, or with `forkedFrom`, the first version of a fork, which must make
// a new workflow: a slug already taken in the owner is a 409, asked only of
// someone who may push there, so a fork tells nobody about a private
// workflow they could not push to.
async function saveVersion(
  db: Db,
  viewer: NonNullable<Viewer>,
  owner: Owner,
  slug: string,
  body: PushBody,
  forkedFrom?: string,
): Promise<Pushed> {
  const allowed = await mayPushTo(db, viewer, owner);
  if (!allowed.ok) return allowed;
  const existing = await findWorkflow(db, owner, slug);
  const taken = () => refuse(409, `${owner.slug}/${slug} is taken. Fork it under another slug.`);
  if (forkedFrom && existing) return taken();

  const slugProblem = workflowSlugProblem(slug);
  if (slugProblem) return refuse(422, slugProblem);

  const read = fileFrom(body);
  if (!read.ok) return read;
  const rewritten = rewriteRefs(read.file, owner.slug);
  if (!rewritten.ok) return rewritten;
  const { file, rewrites, refs } = rewritten;

  const pushed = await pushedVisibility(owner, existing, body.visibility, "workflow");
  if (!pushed.ok) return pushed;
  const { visibility } = pushed;
  if (!existing && visibility === "private" && owner.type === "user") {
    const room = await roomForPrivate(db, owner);
    if (!room.ok) return room;
  }

  const { errors, check, title } = await checkFile(file);
  if (errors.length) return refuse(422, ...errors);
  if (refs.length) {
    const named = await namedAtPush(db, owner, slug, visibility, refs);
    if (!named.ok) return named;
    const listed = await engine.checksWith({ file: refPath(owner.slug, slug), source: file }, named.given);
    const mistakes = listed.filter((c) => c.result === "fail").flatMap((c) => c.mistakes);
    if (mistakes.length) return refuse(422, ...mistakes.map((m) => `workflow: ${m}`));
  }

  const summary = await engine.summarise({ workflow: file });
  const checks = { awml: engine.version, checks: await engine.checks(file) };
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
        forkedFrom: forkedFrom ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!w && forkedFrom) return taken();
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
        checks,
        summary,
      })
      .onConflictDoNothing()
      .returning({ id: version.id });
    if (inserted.length) {
      // A version is never left without its refs: if they can't all be
      // written, the version goes too, and the refs written with it.
      try {
        await insertRows(
          db,
          workflowRef,
          refs.map((r) => ({ versionId: inserted[0].id, part: r.part, targetOwner: r.owner, targetSlug: r.slug, targetPart: r.id })),
        );
      } catch (e) {
        await db.delete(version).where(eq(version.id, inserted[0].id));
        throw e;
      }
      break;
    }
    if (attempt === 4) throw new Error("could not number the version");
  }
  await db.update(workflow).set({ title: title!, updatedAt: new Date() }).where(eq(workflow.id, w.id));
  if (owner.type === "organisation") await record(db, owner.id, viewer.id, "push", `${owner.slug}/${slug} v${number}`);
  const warnings = checks.checks.flatMap((c) => (c.result === "warn" ? c.mistakes.map((message) => ({ check: c.id, message })) : []));
  return { ok: true, owner: owner.slug, slug, number, rewrites, warnings };
}

export type ForkBody = { owner?: unknown; slug?: unknown; visibility?: unknown; version?: unknown };

// Copies one version of a public workflow, the latest unless `version` names
// another, into an owner the caller may push to, as the first version of a
// new workflow there, which records the version it came from. The file is
// the source's, unchanged, or for a version stored in an older AWML, the
// file converted, since a push takes only the current one. It goes through a
// push's rules: its checks, the visibility it asks for and the edition's
// limits. Anyone who may not read the original gets the 404 a missing one
// gives.
export async function forkWorkflow(db: Db, viewer: Viewer, ownerSlug: string, slug: string, body: ForkBody): Promise<Pushed> {
  if (!viewer) return refuse(401, SIGN_IN_TO_PUSH);
  const found = await readable(db, viewer, ownerSlug, slug);
  if (!found) return refuse(404, "Not found.");
  const { workflow: original } = found;
  if (original.visibility !== "public")
    return refuse(422, "Only public workflows can be forked. Copy a private one by hand and push it.");
  const asked = body.version ?? undefined;
  if (asked !== undefined && !(typeof asked === "number" && Number.isInteger(asked) && asked > 0))
    return refuse(422, "version: a version number, such as 2.");
  const [source] = await db
    .select({ id: version.id, number: version.number, workflow: version.workflow })
    .from(version)
    .where(and(eq(version.workflowId, original.id), asked === undefined ? undefined : eq(version.number, asked)))
    .orderBy(desc(version.number))
    .limit(1);
  if (!source) return refuse(404, "Not found.");
  if (source.workflow === null)
    return refuse(
      422,
      `Version ${source.number} was stored before the registry took AWML 0.4 files, so it can't be forked. Fork a later version, or convert it with awml convert and push it.`,
    );
  const file = await asRead({ workflow: source.workflow }, "workflow");
  if ("error" in file) return refuse(422, ...file.error.map((e) => `workflow: ${e}`));

  if (typeof body.owner !== "string" || !body.owner)
    return refuse(422, "owner: the username or organisation to fork into.");
  const into = body.slug ?? original.slug;
  if (typeof into !== "string") return refuse(422, "slug: the fork's slug, as a string.");
  const owner = await findOwner(db, body.owner);
  if (!owner) return refuse(404, "Not found.");
  return saveVersion(db, viewer, owner, into, { workflow: file.file, visibility: body.visibility }, source.id);
}

export type Origin = { owner: string; slug: string; number: number };

// Where a fork came from, as the viewer may know it: the original's owner,
// slug and version when they may read it, or null when it is private to them
// or gone. `forked` says whether it is a fork at all.
async function originOf(db: Db, viewer: Viewer, forkedFrom: string | null) {
  if (!forkedFrom) return { forked: false, forkedFrom: null };
  const [o] = await db
    .select({ owner: ownerSlugSql, slug: workflow.slug, number: version.number, visibility: workflow.visibility })
    .from(version)
    .innerJoin(workflow, eq(workflow.id, version.workflowId))
    .where(eq(version.id, forkedFrom))
    .limit(1);
  const owner = o?.visibility === "private" ? await findOwner(db, o.owner) : null;
  const seen = o && (o.visibility === "public" || (owner && (await isOwnerOrMember(db, owner, viewer?.id))));
  return { forked: true, forkedFrom: seen ? { owner: o.owner, slug: o.slug, number: o.number } : null };
}

// The workflows the viewer may see, as a condition on the workflow table:
// the public ones, and the private ones of the viewer and their organisations.
// Their organisations are asked for in the same statement, however many.
function seenBy(db: Db, viewer: Viewer) {
  return or(
    eq(workflow.visibility, "public"),
    viewer ? eq(workflow.ownerUserId, viewer.id) : undefined,
    viewer
      ? inArray(
          workflow.ownerOrganisationId,
          db.select({ id: membership.organisationId }).from(membership).where(eq(membership.userId, viewer.id)),
        )
      : undefined,
  );
}

// The workflows whose latest version refers to a part of this one, that the
// viewer may see, each with the parts of this one it names, by owner and
// slug. A referrer the viewer may not see is neither listed nor counted.
// Null for a workflow the viewer may not read.
export async function referrersOf(db: Db, viewer: Viewer, ownerSlug: string, slug: string) {
  const found = await readable(db, viewer, ownerSlug, slug);
  if (!found) return null;
  return referrers(db, viewer, found.owner, found.workflow);
}

// A workflow whose latest version refers to this one, and the parts of this
// one it names; `starts` are those of them it names from an outside action,
// so starts this workflow from (AWML 0.7). The API's answers leave `starts` out.
export type Referrer = {
  owner: string;
  slug: string;
  title: string;
  visibility: "public" | "private";
  parts: string[];
  starts?: string[];
};

async function referrers(db: Db, viewer: Viewer, owner: Owner, w: Workflow): Promise<Referrer[]> {
  const rows = await db
    .select({
      id: workflow.id,
      owner: ownerSlugSql,
      slug: workflow.slug,
      title: workflow.title,
      visibility: workflow.visibility,
      part: workflowRef.targetPart,
      from: workflowRef.part,
      file: version.workflow,
    })
    .from(workflowRef)
    .innerJoin(version, and(eq(version.id, workflowRef.versionId), isLatest))
    .innerJoin(workflow, eq(workflow.id, version.workflowId))
    .where(
      and(
        eq(workflowRef.targetOwner, owner.slug),
        eq(workflowRef.targetSlug, w.slug),
        ne(workflow.id, w.id),
        seenBy(db, viewer),
      ),
    );
  // The kind of each referring part, read from its workflow's file as stored,
  // once for each workflow: a ref a stored 0.6 file made from a trigger is no
  // outside action, so starts nothing.
  const kinds = new Map<string, Map<string, string>>();
  const kindOf = (id: string, file: string | null, part: string) => {
    if (!kinds.has(id)) kinds.set(id, file ? partKinds(file) : new Map());
    return kinds.get(id)!.get(part);
  };
  const byWorkflow = new Map<string, Required<Referrer>>();
  for (const { id, part, from, file, ...r } of rows) {
    const listed = byWorkflow.get(id) ?? { ...r, parts: [], starts: [] };
    if (!listed.parts.includes(part)) listed.parts.push(part);
    if (kindOf(id, file, from) === "outside" && !listed.starts.includes(part)) listed.starts.push(part);
    byWorkflow.set(id, listed);
  }
  return [...byWorkflow.values()]
    .map((r) => ({ ...r, parts: r.parts.sort(), starts: r.starts.sort() }))
    .sort((a, b) => `${a.owner}/${a.slug}`.localeCompare(`${b.owner}/${b.slug}`));
}

// A workflow's forks that the viewer may see, of any of its versions: the
// public ones, and the private ones of the viewer and their organisations.
// How many there are, and the newest `limit` of them. Null for a workflow
// the viewer may not read.
export async function forksOf(db: Db, viewer: Viewer, ownerSlug: string, slug: string, limit = 20) {
  const found = await readable(db, viewer, ownerSlug, slug);
  if (!found) return null;
  const where = and(eq(version.workflowId, found.workflow.id), seenBy(db, viewer));
  const [[{ total }], forks] = await Promise.all([
    db
      .select({ total: count() })
      .from(workflow)
      .innerJoin(version, eq(version.id, workflow.forkedFrom))
      .where(where),
    db
      .select({ owner: ownerSlugSql, slug: workflow.slug, title: workflow.title, visibility: workflow.visibility, number: version.number })
      .from(workflow)
      .innerJoin(version, eq(version.id, workflow.forkedFrom))
      .where(where)
      .orderBy(desc(workflow.createdAt), desc(sql`${workflow}.rowid`))
      .limit(limit),
  ]);
  return { total, forks };
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
    ...(await originOf(db, viewer, w.forkedFrom)),
    versions: await versionList(db, w.id),
    referredBy: (await referrers(db, viewer, owner, w)).map(({ starts: _, ...r }) => r),
    systems: await systemsOf(db, viewer, w.id),
  };
}

// The systems a workflow is in that the viewer may see (see systemsOf). Null
// for a workflow the viewer may not read.
export async function systemsWith(db: Db, viewer: Viewer, ownerSlug: string, slug: string) {
  const found = await readable(db, viewer, ownerSlug, slug);
  return found ? systemsOf(db, viewer, found.workflow.id) : null;
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
  // The version, the list of versions and where it was forked from are read
  // at once, as none depends on another.
  const [[v], origin, versions] = await Promise.all([
    db
      .select({
        number: version.number,
        pushedAt: version.pushedAt,
        pushedBy: user.username,
        workflow: version.workflow,
        security: version.security,
        platform: version.platform,
        check: version.check,
        checks: version.checks,
        summary: version.summary,
      })
      .from(version)
      .innerJoin(user, eq(user.id, version.pushedBy))
      .where(where)
      .orderBy(desc(version.number))
      .limit(1),
    originOf(db, viewer, w.forkedFrom),
    versionList(db, w.id),
  ]);
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
    checks: v.checks,
    summary: v.summary,
    ...origin,
    versions,
  };
}

const ownerSlugSql = sql<string>`coalesce(
  (select username from user where user.id = ${workflow.ownerUserId}),
  (select slug from organisation where organisation.id = ${workflow.ownerOrganisationId})
)`;

const isLatest = sql`${version.number} = (select max(v2.number) from version v2 where v2.workflow_id = ${version.workflowId})`;

// The public gallery, newest first, searched by title, with each workflow's
// latest summary and the file its card draws: the workflow, whose security
// view is drawn, or for a version stored before 0.4, the security view, or
// the platform view when there is no security file.
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

// An owner's workflows: the public ones to everyone, the private ones to
// members too.
export async function ownerWorkflows(db: Db, viewer: Viewer, ownerSlug: string) {
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

// An owner's page: their workflows and their systems, each as ownerWorkflows
// gives the workflows.
export async function ownerPage(db: Db, viewer: Viewer, ownerSlug: string) {
  const found = await ownerWorkflows(db, viewer, ownerSlug);
  return found && { ...found, systems: await ownerSystems(db, found.owner, found.member) };
}

// Every workflow of an organisation with its latest summary, and the totals across them.
export async function inventory(db: Db, viewer: Viewer, orgSlug: string) {
  const owner = await findOwner(db, orgSlug);
  if (!owner || owner.type !== "organisation") return null;
  if (!(await isOwnerOrMember(db, owner, viewer?.id))) return null;
  const workflows = await db
    .select({
      slug: workflow.slug,
      title: workflow.title,
      visibility: workflow.visibility,
      number: version.number,
      summary: version.summary,
      hasSecurity: sql<number>`${version.workflow} is not null or ${version.security} is not null`,
      hasPlatform: sql<number>`${version.platform} is not null`,
    })
    .from(workflow)
    .leftJoin(version, and(eq(version.workflowId, workflow.id), isLatest))
    .where(eq(workflow.ownerOrganisationId, owner.id))
    .orderBy(workflow.slug);
  const rows = workflows.map((w) => ({
    slug: w.slug,
    title: w.title,
    visibility: w.visibility,
    latest: w.number,
    summary: w.summary,
    hasSecurity: Boolean(w.hasSecurity),
    // A workflow says where it runs in its implementations, whose
    // blocks its summary counts as platforms.
    hasPlatform: Boolean(w.hasPlatform) || (w.summary?.platforms ?? 0) > 0,
  }));
  const summaries = rows.flatMap((r) => (r.summary ? [r.summary] : []));
  return { organisation: owner, rows, totals: total(summaries), measures: measures(summaries) };
}

