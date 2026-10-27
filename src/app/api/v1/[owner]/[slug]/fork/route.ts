import { getDb } from "@/db/client";
import { json, jsonObject, refusal, siteUrl, type Params } from "@/server/http";
import { forkWorkflow } from "@/server/registry";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

// Fork a public workflow into an owner the caller may push to. Answers as a
// push does, with the fork's first version.
export async function POST(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  const moved = await oldNameRedirect(req, owner, "/api/v1/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const read = await jsonObject(req);
  if ("refused" in read) return read.refused;
  const forked = await forkWorkflow(await getDb(), asker.viewer, owner, slug, read.body);
  if (!forked.ok) return refusal(forked);
  return json(
    {
      owner: forked.owner,
      slug: forked.slug,
      number: forked.number,
      url: siteUrl(req, `/${forked.owner}/${forked.slug}/v/${forked.number}`),
    },
    201,
  );
}
