"use server";

import { revalidatePath } from "next/cache";
import { pageContext } from "@/server/page";
import { createToken, revokeToken } from "@/server/tokens";

export type MakeTokenState = { secret?: string; name?: string };

export async function makeToken(_: MakeTokenState, form: FormData): Promise<MakeTokenState> {
  const { db, viewer } = await pageContext();
  if (!viewer) return {};
  const name = String(form.get("name") ?? "").trim() || "token";
  const { secret } = await createToken(db, viewer.id, name);
  revalidatePath("/settings/tokens");
  return { secret, name };
}

export async function revoke(form: FormData) {
  const { db, viewer } = await pageContext();
  if (!viewer) return;
  await revokeToken(db, viewer.id, String(form.get("id")));
  revalidatePath("/settings/tokens");
}
