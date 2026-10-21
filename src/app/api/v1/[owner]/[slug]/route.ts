import { getDb } from "@/db/client";
import { json, notFound, type Params } from "@/server/http";
import { readWorkflow } from "@/server/registry";
import { getViewer } from "@/server/viewer";

export async function GET(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  const found = await readWorkflow(await getDb(), await getViewer(req.headers), owner, slug);
  if (!found) return notFound();
  const { ownerType: _, ...body } = found;
  return json(body);
}
