// The rules every push follows, whatever it pushes: who may push to an owner,
// and the visibility the push gives.
import type { Db } from "@/db/client";
import { edition } from "@/edition";
import { isOwnerOrMember, type Owner } from "./owners";
import { refuse, type Result } from "./result";
import type { Viewer } from "./viewer";

export type Visibility = "public" | "private";

// What is pushed: a workflow, a platform or a system, named in the refusals.
export type Kind = "workflow" | "platform" | "system";

export const SIGN_IN_TO_PUSH = "Sign in, or send a token as Authorization: Bearer <token>.";

// Only the user, or an organisation's members, may push to its items. Anyone
// else pushing to a private item gets the 404 a missing one gives.
export async function mayPushTo(
  db: Db,
  viewer: NonNullable<Viewer>,
  owner: Owner,
  existing: { visibility: Visibility } | null,
): Promise<Result<{}>> {
  if (await isOwnerOrMember(db, owner, viewer.id)) return { ok: true };
  if (existing?.visibility === "private") return refuse(404, "Not found.");
  return refuse(403, `Only ${owner.type === "user" ? owner.slug : `members of ${owner.slug}`} can push here.`);
}

// The first push sets an item's visibility, public unless it asks otherwise,
// and a later push cannot change it. An organisation keeps private items of
// every kind, a user private workflows, up to the edition's limit (see
// pushVersion), and private systems, with no limit. The edition may stop an organisation pushing, or keeping
// private items.
export async function pushedVisibility(
  owner: Owner,
  existing: { visibility: Visibility } | null,
  requested: unknown,
  kind: Kind,
): Promise<Result<{ visibility: Visibility }>> {
  if (requested !== undefined && requested !== "public" && requested !== "private")
    return refuse(422, 'visibility is "public" or "private".');
  if (existing && requested && requested !== existing.visibility)
    return refuse(
      422,
      `This ${kind} is ${existing.visibility}. Its first push set that, and a later push cannot change it.`,
    );
  const visibility: Visibility = existing?.visibility ?? (requested as Visibility | undefined) ?? "public";

  if (owner.type === "user" && visibility === "private" && kind === "platform")
    return refuse(422, `Private ${kind}s belong to organisations. Push it to one of yours.`);
  if (owner.type === "organisation") {
    if (!(await edition.canPush(owner)))
      return refuse(403, `${owner.slug} cannot push new versions at the moment. Reading still works.`);
    if (visibility === "private" && !(await edition.canKeepPrivate(owner)))
      return refuse(403, `${owner.slug} cannot keep private ${kind}s.`);
  }
  return { ok: true, visibility };
}
