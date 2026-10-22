import { getDb } from "@/db/client";
import { json, notFound, refusal, type Params } from "@/server/http";
import { readPlatformVersion } from "@/server/platforms";
import { requestViewer } from "@/server/viewer";

// The platform's latest version, with its description and recipe, and the
// list of its versions.
export async function GET(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const found = await readPlatformVersion(await getDb(), asker.viewer, owner, slug, "latest");
  return found ? json(found) : notFound();
}
