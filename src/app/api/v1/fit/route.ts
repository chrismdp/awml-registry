import { getDb } from "@/db/client";
import { fitWorkflow } from "@/server/fit";
import { json, jsonObject, refusal } from "@/server/http";
import { requestViewer } from "@/server/viewer";

// Where a workflow can run, against the platforms named or every platform the
// caller may see.
export async function POST(req: Request) {
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const read = await jsonObject(req);
  if ("refused" in read) return read.refused;
  const fitted = await fitWorkflow(await getDb(), asker.viewer, read.body);
  return fitted.ok ? json(fitted.fit) : refusal(fitted);
}
