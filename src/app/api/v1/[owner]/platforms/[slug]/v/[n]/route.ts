import { getDb } from "@/db/client";
import { json, notFound, refusal, type Params } from "@/server/http";
import { readPlatformVersion } from "@/server/platforms";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

// One platform version at the address `awml pull owner/platforms/slug` asks
// for: the same answer as /api/v1/platforms/{owner}/{slug}/v/{n}.
export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n">) {
  const { owner, slug, n } = await params;
  const moved = await oldNameRedirect(req, owner, "/api/v1/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const found = await readPlatformVersion(await getDb(), asker.viewer, owner, slug, n);
  if (!found) return notFound();
  const { versions: _, ...body } = found;
  return json(body);
}
