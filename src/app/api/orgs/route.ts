import { getDb } from "@/db/client";
import { backTo } from "@/server/http";
import { createOrganisation } from "@/server/organisations";
import { getViewer } from "@/server/viewer";

// The form on /settings that makes an organisation.
export async function POST(req: Request) {
  const viewer = await getViewer(req.headers);
  if (!viewer) return backTo(req, "/login");
  const form = await req.formData();
  const made = await createOrganisation(await getDb(), viewer.id, {
    slug: String(form.get("slug") ?? ""),
    name: String(form.get("name") ?? ""),
  });
  if (!made.ok) return backTo(req, "/settings", { error: made.errors[0] });
  return backTo(req, `/${made.organisation.slug}/settings`);
}
