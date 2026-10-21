import { getDb } from "@/db/client";
import { json, notFound, type Params } from "@/server/http";
import { readVersion } from "@/server/registry";
import { getViewer } from "@/server/viewer";

export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n">) {
  const { owner, slug, n } = await params;
  const found = await readVersion(await getDb(), await getViewer(req.headers), owner, slug, n);
  if (!found) return notFound();
  const { ownerType: _, versions: __, ...body } = found;
  return json(body);
}
