import { getDb } from "@/db/client";
import { json, notFound, refusal, type Params } from "@/server/http";
import { readVersion } from "@/server/registry";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n">) {
  const { owner, slug, n } = await params;
  const moved = await oldNameRedirect(req, owner, "/api/v1/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const found = await readVersion(await getDb(), asker.viewer, owner, slug, n);
  if (!found) return notFound();
  const { ownerType: _, versions: __, checks: ___, forked: ____, ...body } = found;
  return json(body);
}
