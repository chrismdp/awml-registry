import { getDb } from "@/db/client";
import { json, notFound, refusal, type Params } from "@/server/http";
import { readWorkflow } from "@/server/registry";
import { requestViewer } from "@/server/viewer";

export async function GET(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const found = await readWorkflow(await getDb(), asker.viewer, owner, slug);
  if (!found) return notFound();
  const { ownerType: _, ...body } = found;
  return json(body);
}
