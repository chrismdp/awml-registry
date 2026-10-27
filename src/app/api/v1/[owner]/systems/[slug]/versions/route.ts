import { getDb } from "@/db/client";
import { json, jsonObject, refusal, siteUrl, type Params } from "@/server/http";
import { pushSystemVersion } from "@/server/systems";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

export async function POST(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  const moved = await oldNameRedirect(req, owner, "/api/v1/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const read = await jsonObject(req);
  if ("refused" in read) return read.refused;
  const db = await getDb();
  const pushed = await pushSystemVersion(db, asker.viewer, owner, slug, read.body);
  if (!pushed.ok) return refusal(pushed);
  return json(
    {
      owner: pushed.owner,
      slug: pushed.slug,
      number: pushed.number,
      url: siteUrl(req, `/${pushed.owner}/systems/${pushed.slug}/v/${pushed.number}`),
    },
    201,
  );
}
