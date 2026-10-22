"use server";

import { revalidatePath } from "next/cache";
import { disconnectApp } from "@/server/connected-apps";
import { pageContext } from "@/server/page";

// Only ever the signed-in person's own consent and tokens for the app.
export async function disconnect(form: FormData) {
  const { db, viewer } = await pageContext();
  if (!viewer) return;
  await disconnectApp(db, viewer.id, String(form.get("clientId")));
  revalidatePath("/settings");
}
