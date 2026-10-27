// References between workflows, as AWML has them from 0.6: a part's `ref` names a
// part of another workflow, which the referring workflow keeps its own copy
// of, so it still checks alone. A ref is owner/slug#id for a published
// workflow, or a path to a file alongside, such as shopping.yaml#list, which
// a push rewrites to the owner pushed to and the file's stem. Refs follow the
// latest version of what they name. The engine never fetches from the
// registry, so the registry gives it each workflow a ref names, at a path
// ending owner/slug.yaml, and only one the reader may see.
import { and, desc, eq } from "drizzle-orm";
import { isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import type { Db } from "@/db/client";
import { version, workflow } from "@/db/schema";
import type { Named } from "@/engine";
import { asRead } from "./as-read";
import { findOwner, isOwnerOrMember, ownerMaySee, type Owner } from "./owners";
import type { Visibility } from "./push";
import { refuse, type Result } from "./result";
import { isSlug, workflowSlugProblem } from "./slugs";
import type { Viewer } from "./viewer";

const NAME = "[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?";
const ID = "[A-Za-z][A-Za-z0-9_]*";
const ADDRESS = new RegExp(`^(${NAME})/(${NAME})#(${ID})$`);
const ALONGSIDE = new RegExp(`^([^/\\\\]+)\\.yaml#(${ID})$`);

// A ref as a stored file holds it: the part that refers, and the workflow
// and part it names.
export type Ref = { part: string; owner: string; slug: string; id: string };
export type Rewrite = { part: string; from: string; to: string };

// Each part's ref that is text, with the YAML node holding it.
function refNodes(text: string) {
  const doc = parseDocument(text);
  if (doc.errors.length) return [];
  const parts = doc.get("parts", true);
  if (!isSeq(parts)) return [];
  return parts.items.flatMap((item) => {
    if (!isMap(item)) return [];
    const node = item.get("ref", true);
    if (!isScalar(node) || typeof node.value !== "string") return [];
    return [{ part: String(item.get("id")), ref: node.value, node: node as Scalar<string> }];
  });
}

function asRef(part: string, ref: string): Ref | null {
  const m = ADDRESS.exec(ref);
  return m ? { part, owner: m[1], slug: m[2], id: m[3] } : null;
}

// The refs of a file a push stored, each owner/slug#id.
export function refsOf(text: string): Ref[] {
  return refNodes(text).flatMap(({ part, ref }) => asRef(part, ref) ?? []);
}

// A scalar written again in the style it was written in.
function written(node: Scalar, value: string) {
  if (node.type === "PLAIN") return value;
  if (node.type === "QUOTE_SINGLE") return `'${value}'`;
  return JSON.stringify(value);
}

// The file a push stores: each path ref, shopping.yaml#list, rewritten as
// owner/shopping#list, the owner being the one pushed to and the slug the
// file's name without .yaml. Only the ref's own text changes. A path that
// leaves the folder, or isn't a .yaml name whose stem can be a workflow's
// slug, is refused. A file that isn't YAML is left to check.
export function rewriteRefs(text: string, owner: string): Result<{ file: string; rewrites: Rewrite[]; refs: Ref[] }> {
  const rewrites: Rewrite[] = [];
  const refs: Ref[] = [];
  const edits: { from: number; to: number; text: string }[] = [];
  for (const { part, ref, node } of refNodes(text)) {
    const named = asRef(part, ref);
    if (named) {
      refs.push(named);
      continue;
    }
    const alongside = ALONGSIDE.exec(ref);
    const stem = alongside?.[1];
    if (!alongside || !stem || !isSlug(stem) || workflowSlugProblem(stem))
      return refuse(
        422,
        `workflow: part "${part}": ref "${ref}" must be owner/slug#id, or the name of a file alongside, such as shopping.yaml#list, whose name without .yaml is the slug it is published under.`,
      );
    const to = `${owner}/${stem}#${alongside[2]}`;
    rewrites.push({ part, from: ref, to });
    refs.push({ part, owner, slug: stem, id: alongside[2] });
    const [from, end] = node.range!;
    edits.push({ from, to: end, text: written(node, to) });
  }
  let file = text;
  for (const e of edits.sort((a, b) => b.from - a.from)) file = file.slice(0, e.from) + e.text + file.slice(e.to);
  return { ok: true, file, rewrites, refs };
}

// The path the engine is given a workflow at, so an owner/slug#id ref finds it.
export const refPath = (owner: string, slug: string) => `${owner}/${slug}.yaml`;

async function findNamed(db: Db, ownerSlug: string, slug: string) {
  const owner = await findOwner(db, ownerSlug);
  if (!owner) return { owner: null, workflow: null };
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
  return { owner, workflow: w ?? null };
}

// A workflow's latest file as the engine reads it, at the path its refs use.
async function latestFile(db: Db, workflowId: string, path: string): Promise<Named | null> {
  const [v] = await db
    .select({ workflow: version.workflow })
    .from(version)
    .where(eq(version.workflowId, workflowId))
    .orderBy(desc(version.number))
    .limit(1);
  if (!v?.workflow) return null;
  const read = await asRead({ workflow: v.workflow }, "workflow");
  return "file" in read ? { file: path, source: read.file } : null;
}

// Each workflow the refs name, once, leaving out the referring one itself.
function named(refs: Ref[], owner: string, slug: string) {
  const seen = new Map<string, { owner: string; slug: string; refs: Ref[] }>();
  for (const r of refs) {
    if (r.owner === owner && r.slug === slug) continue;
    const key = `${r.owner}/${r.slug}`;
    if (!seen.has(key)) seen.set(key, { owner: r.owner, slug: r.slug, refs: [] });
    seen.get(key)!.refs.push(r);
  }
  return [...seen.values()];
}

// What a push's refs name, judged by what the owner pushed to may see: the
// public workflows, its own, and for a person, their organisations'. A
// public workflow may refer only to public ones; a ref to anything else is
// refused, naming the ref, the same whether what it names is private or
// missing. A private workflow may refer to anything, so a set of files can be
// pushed in any order; a ref to a workflow the owner may not see is taken as
// if it were not there, and not checked against. The answer is the latest
// file of each workflow the owner may see, for the engine to check against.
export async function namedAtPush(
  db: Db,
  owner: Owner,
  slug: string,
  visibility: Visibility,
  refs: Ref[],
): Promise<Result<{ given: Named[] }>> {
  const given: Named[] = [];
  const errors: string[] = [];
  for (const target of named(refs, owner.slug, slug)) {
    const found = await findNamed(db, target.owner, target.slug);
    if (visibility === "public") {
      if (found.workflow?.visibility !== "public") {
        for (const r of target.refs)
          errors.push(
            `workflow: part "${r.part}" refers to ${r.owner}/${r.slug}#${r.id}, but a public workflow may refer only to public ones, and ${r.owner}/${r.slug} is not one.`,
          );
        continue;
      }
    } else if (!found.workflow || !(await ownerMaySee(db, owner, found.owner!, found.workflow.visibility))) continue;
    const file = await latestFile(db, found.workflow.id, refPath(target.owner, target.slug));
    if (file) given.push(file);
  }
  return errors.length ? refuse(422, ...errors) : { ok: true, given };
}

// A ref as a viewer may know what it names: a workflow they may see, one not
// pushed yet in an owner whose every workflow they may see, or, for anything
// else, a workflow they can't see, without its name.
export type ShownRef =
  | { part: string; state: "found" | "missing"; owner: string; slug: string; id: string }
  | { part: string; state: "hidden" };

// A workflow's refs as the viewer may know them, and the latest file of each
// workflow they name that the viewer may see, for the engine to check
// against. A private workflow named and a missing one look the same to
// anyone who may not see into its owner.
export async function refsAsSeen(db: Db, viewer: Viewer, ownerSlug: string, slug: string, file: string) {
  // Each workflow named is looked up at once, and the answers kept in the
  // order the refs give them.
  const seen = await Promise.all(
    named(refsOf(file), ownerSlug, slug).map(async (target) => {
      const found = await findNamed(db, target.owner, target.slug);
      const insider = found.owner ? await isOwnerOrMember(db, found.owner, viewer?.id) : false;
      let state: ShownRef["state"] = "hidden";
      let latest: Named | null = null;
      if (found.workflow && (found.workflow.visibility === "public" || insider)) {
        state = "found";
        latest = await latestFile(db, found.workflow.id, refPath(target.owner, target.slug));
      } else if (!found.workflow && insider) state = "missing";
      const shown = target.refs.map(
        (r): ShownRef => (state === "hidden" ? { part: r.part, state } : { part: r.part, state, owner: r.owner, slug: r.slug, id: r.id }),
      );
      return { shown, latest };
    }),
  );
  return { shown: seen.flatMap((s) => s.shown), given: seen.flatMap((s) => (s.latest ? [s.latest] : [])) };
}
