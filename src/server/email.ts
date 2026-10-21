// Sign-in links go out through one small interface. pickSender chooses how:
// Cloudflare's EMAIL binding on the hosted Worker, SMTP for a self-hosted
// registry, or, with neither set up, the server's log.
import { mailPlatform } from "@/server/mail-platform";

export interface EmailSender {
  sendMagicLink(to: string, url: string): Promise<void>;
}

// The parts of Cloudflare Email Service's `send_email` binding used here.
export type EmailBinding = {
  send(message: {
    from: string | { email: string; name?: string };
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId: string }>;
};

// The parts of a nodemailer transport used here.
export type MailTransport = {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
};

export type MailEnv = Partial<
  Record<"MAIL_FROM" | "SMTP_URL" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASS", string>
>;

export type SmtpOptions =
  | string
  | { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } };

const DEFAULT_FROM = "AWML <login@awml.io>";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function signInEmail(url: string) {
  const href = escapeHtml(url);
  return {
    subject: "Sign in to the AWML Registry",
    text: `Open this link to sign in to the AWML Registry:\n\n${url}\n\nIt works once, for 15 minutes. If you did not ask to sign in, ignore this email.\n`,
    html: `<p>Open this link to sign in to the AWML Registry:</p>\n<p><a href="${href}">Sign in</a></p>\n<p>Or paste this into your browser: ${href}</p>\n<p>It works once, for 15 minutes. If you did not ask to sign in, ignore this email.</p>\n`,
  };
}

// "Name <address>" as Cloudflare's { email, name }.
function parseFrom(from: string) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { email: m[2], name: m[1] || undefined } : { email: from.trim() };
}

export function smtpOptions(env: MailEnv): SmtpOptions | null {
  if (env.SMTP_URL) return env.SMTP_URL;
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } } : {}),
  };
}

export const consoleSender: EmailSender = {
  async sendMagicLink(to, url) {
    console.warn(
      "[awml] EMAIL IS NOT SET UP: this sign-in link was NOT SENT, only printed here. " +
        "Set SMTP_URL (or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) and MAIL_FROM, or bind EMAIL on Cloudflare.",
    );
    console.log(`[awml] sign-in link for ${to}: ${url}`);
  },
};

export function pickSender(config: {
  binding?: EmailBinding;
  env: MailEnv;
  createTransport?: (options: SmtpOptions) => MailTransport;
}): { kind: "cloudflare" | "smtp" | "console"; sender: EmailSender } {
  const from = config.env.MAIL_FROM || DEFAULT_FROM;
  if (config.binding) {
    const binding = config.binding;
    return {
      kind: "cloudflare",
      sender: {
        async sendMagicLink(to, url) {
          await binding.send({ from: parseFrom(from), to, ...signInEmail(url) });
        },
      },
    };
  }
  const options = smtpOptions(config.env);
  if (options && config.createTransport) {
    const transport = config.createTransport(options);
    return {
      kind: "smtp",
      sender: {
        async sendMagicLink(to, url) {
          await transport.sendMail({ from, to, ...signInEmail(url) });
        },
      },
    };
  }
  return { kind: "console", sender: consoleSender };
}

let override: EmailSender | undefined;
let chosen: EmailSender | undefined;

// One sender per process or Worker isolate.
export async function getEmailSender(): Promise<EmailSender> {
  if (override) return override;
  if (!chosen) {
    const picked = pickSender(await mailPlatform());
    if (picked.kind === "console")
      console.warn("[awml] EMAIL IS NOT SET UP: sign-in links will be printed to this log, not sent.");
    chosen = picked.sender;
  }
  return chosen;
}

// Tests send through their own fake.
export function setEmailSender(next: EmailSender | undefined) {
  override = next;
}
