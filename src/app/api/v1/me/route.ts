import { getDb } from "@/db/client";
import { json, jsonObject, refusal, siteUrl } from "@/server/http";
import { SIGN_IN_TO_PUSH } from "@/server/push";
import { refuse } from "@/server/result";
import { setUsername } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

// Changes the caller's own username: `{"username": "..."}`. It names no
// person, so it can only ever change the caller's.
export async function PATCH(req: Request) {
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  if (!asker.viewer) return refusal(refuse(401, SIGN_IN_TO_PUSH));
  const read = await jsonObject(req);
  if ("refused" in read) return read.refused;
  const saved = await setUsername(await getDb(), asker.viewer.id, read.body.username);
  if (!saved.ok) return refusal(saved);
  return json({ username: saved.username, previous: saved.previous, url: siteUrl(req, `/${saved.username}`) });
}
