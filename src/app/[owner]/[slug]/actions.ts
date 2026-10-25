"use server";

import { redirect } from "next/navigation";
import { pageContext, workflowPath } from "@/server/page";
import { forkWorkflow } from "@/server/registry";

export type ForkState = { error?: string };

// The Fork form on a workflow's page: forks the version shown, `from` being
// its owner/slug, into the owner chosen, by the same rules as the API, then
// opens the fork's page. Someone signed out is sent to sign in first.
export async function fork(_: ForkState, form: FormData): Promise<ForkState> {
  const { db, viewer } = await pageContext();
  const [owner = "", slug = ""] = String(form.get("from") ?? "").split("/");
  const asked = String(form.get("version") ?? "");
  const version = /^[1-9]\d{0,8}$/.test(asked) ? Number(asked) : undefined;
  if (!viewer) redirect(`/login?${new URLSearchParams({ next: workflowPath(owner, slug, version ?? "latest") })}`);
  const forked = await forkWorkflow(db, viewer, owner, slug, {
    owner: form.get("owner"),
    slug: String(form.get("slug") ?? "").trim() || undefined,
    visibility: form.get("visibility") ?? undefined,
    version,
  });
  if (!forked.ok) return { error: forked.errors[0] };
  redirect(workflowPath(forked.owner, forked.slug, "latest"));
}
