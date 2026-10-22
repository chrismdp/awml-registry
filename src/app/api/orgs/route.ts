import { getDb } from "@/db/client";
import { backTo, refusal } from "@/server/http";
import { createOrganisation } from "@/server/organisations";
import { requestViewer } from "@/server/viewer";

// The form on /settings that makes an organisation.
export async function POST(req: Request) {
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return refusal(asker);
  const { viewer } = asker;
  if (!viewer) return backTo(req, "/login");
  const form = await req.formData();
  const made = await createOrganisation(await getDb(), viewer.id, {
    slug: String(form.get("slug") ?? ""),
    name: String(form.get("name") ?? ""),
  });
  if (!made.ok) return backTo(req, "/settings", { error: made.errors[0] });
  return backTo(req, `/${made.organisation.slug}/settings`);
}
