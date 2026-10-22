import { getDb } from "@/db/client";
import { backTo, json, refusal, type Params } from "@/server/http";
import { removeMember } from "@/server/organisations";
import { requestViewer } from "@/server/viewer";

// Removes a member, or lets a member leave.
export async function POST(req: Request, { params }: Params<"org" | "userId">) {
  const { org, userId } = await params;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const { viewer } = asker;
  const removed = await removeMember(await getDb(), viewer?.id, org, userId);
  if (!removed.ok && removed.status !== 422) return json({ errors: removed.errors }, removed.status);
  if (removed.ok && userId === viewer?.id) return backTo(req, "/settings", { notice: `You left ${org}.` });
  return backTo(req, `/${org}/settings`, removed.ok ? { notice: "Removed." } : { error: removed.errors[0] });
}
