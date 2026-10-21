import { getDb } from "@/db/client";
import { backTo, json, type Params } from "@/server/http";
import { addMember } from "@/server/organisations";
import { getViewer } from "@/server/viewer";

// The form on /{org}/settings that adds a member by email or username.
export async function POST(req: Request, { params }: Params<"org">) {
  const { org } = await params;
  const viewer = await getViewer(req.headers);
  const form = await req.formData();
  const added = await addMember(
    await getDb(),
    viewer?.id,
    org,
    String(form.get("identifier") ?? ""),
    form.get("role") === "owner" ? "owner" : "member",
  );
  if (!added.ok && added.status !== 422) return json({ errors: added.errors }, added.status);
  return backTo(req, `/${org}/settings`, added.ok ? { notice: "Added." } : { error: added.errors[0] });
}
