// Cloudflare Workers: Cloudflare Email Service's `send_email` binding named
// EMAIL, from wrangler.jsonc. No SMTP here.
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { EmailBinding, MailEnv } from "./email";

export async function mailPlatform(): Promise<{ binding?: EmailBinding; env: MailEnv }> {
  const { env } = await getCloudflareContext({ async: true });
  const e = env as unknown as { EMAIL?: EmailBinding; MAIL_FROM?: string };
  return { binding: e.EMAIL, env: { MAIL_FROM: e.MAIL_FROM ?? process.env.MAIL_FROM } };
}
