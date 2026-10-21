// Node (`next dev`, the Docker container): SMTP through nodemailer when the
// environment sets it up. The Cloudflare build swaps this module for
// mail-platform.cloudflare.ts (see next.config.ts).
import nodemailer from "nodemailer";
import type { EmailBinding, MailEnv, MailTransport, SmtpOptions } from "./email";

export async function mailPlatform(): Promise<{
  binding?: EmailBinding;
  env: MailEnv;
  createTransport?: (options: SmtpOptions) => MailTransport;
}> {
  return {
    env: process.env as MailEnv,
    createTransport: (options) => nodemailer.createTransport(options),
  };
}
