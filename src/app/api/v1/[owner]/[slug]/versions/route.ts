import { getDb } from "@/db/client";
import { json, refusal, siteUrl, type Params } from "@/server/http";
import { pushVersion, type PushBody } from "@/server/registry";
import { getViewer } from "@/server/viewer";

export async function POST(req: Request, { params }: Params<"owner" | "slug">) {
  const { owner, slug } = await params;
  let body: PushBody;
  try {
    body = await req.json();
  } catch {
    return json({ errors: ["Send a JSON body."] }, 422);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ errors: ["Send a JSON object."] }, 422);
  const db = await getDb();
  const pushed = await pushVersion(db, await getViewer(req.headers), owner, slug, body);
  if (!pushed.ok) return refusal(pushed);
  return json(
    {
      owner: pushed.owner,
      slug: pushed.slug,
      number: pushed.number,
      url: siteUrl(req, `/${pushed.owner}/${pushed.slug}/v/${pushed.number}`),
    },
    201,
  );
}
