import { POST as pushWorkflow } from "@/app/api/v1/[owner]/[slug]/versions/route";
import { getDb } from "@/db/client";
import { json, notFound, refusal, type Params } from "@/server/http";
import { readPlatformVersion } from "@/server/platforms";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

// The platform at the address `awml pull owner/platforms/slug` asks for: the
// same answer as /api/v1/platforms/{owner}/{slug}. `platforms` is a reserved
// workflow slug, so no workflow is hidden by it.
export async function GET(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  const moved = await oldNameRedirect(req, owner, "/api/v1/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const found = await readPlatformVersion(await getDb(), asker.viewer, owner, slug, "latest");
  return found ? json(found) : notFound();
}

// This address shadows /api/v1/{owner}/platforms/versions, a push to a
// workflow named "platforms": hand that on, so it is refused as before, for
// its reserved slug.
export async function POST(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  if (slug !== "versions") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  return pushWorkflow(req, { params: Promise.resolve({ owner, slug: "platforms" }) });
}
