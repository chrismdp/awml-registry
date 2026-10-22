"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { disconnectApp } from "@/server/connected-apps";
import { pageContext } from "@/server/page";
import { savedNotice, setUsername } from "@/server/usernames";

// Only ever the signed-in person's own consent and tokens for the app.
export async function disconnect(form: FormData) {
  const { db, viewer } = await pageContext();
  if (!viewer) return;
  await disconnectApp(db, viewer.id, String(form.get("clientId")));
  revalidatePath("/settings");
}

// Only ever the signed-in person's own username. Back to Settings with what
// happened, the whole site redrawn, since the header shows the name.
export async function saveUsername(form: FormData) {
  const { db, viewer } = await pageContext();
  if (!viewer) redirect("/login?next=/settings");
  const saved = await setUsername(db, viewer.id, form.get("username"));
  const message: Record<string, string> = saved.ok ? { notice: savedNotice(saved) } : { error: saved.errors[0] };
  revalidatePath("/", "layout");
  redirect(`/settings?${new URLSearchParams(message)}`);
}
