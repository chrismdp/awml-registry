// Sign-in links go out through one small interface. pickSender chooses how:
// Cloudflare's EMAIL binding on a Worker, SMTP on a server, or, with neither
// set up or no MAIL_FROM to send them from, the server's log.
// signInLinksEmailed tells the sign-in page which, so it can say where the
// link went.
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

// What a platform offers for sending: a server SMTP, through createTransport;
// a Worker only Cloudflare's EMAIL binding.
export type MailPlatform = {
  binding?: EmailBinding;
  env: MailEnv;
  createTransport?: (options: SmtpOptions) => MailTransport;
};

// What to set to send sign-in links, naming only what this platform can use.
const howToSetUp = (platform: MailPlatform) =>
  platform.createTransport
    ? "Set MAIL_FROM, and SMTP_URL (or SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS)."
    : "Set MAIL_FROM, and bind Cloudflare Email Service as EMAIL in wrangler.jsonc.";

function logSender(platform: MailPlatform): EmailSender {
  const how = howToSetUp(platform);
  return {
    async sendMagicLink(to, url) {
      console.warn(`[awml] EMAIL IS NOT SET UP: this sign-in link was NOT SENT, only printed here. ${how}`);
      console.log(`[awml] sign-in link for ${to}: ${url}`);
    },
  };
}

// How sign-in links go out: by email when there is MAIL_FROM to send them
// from and a way to send, otherwise to the server's log.
export function senderKind(platform: MailPlatform): "cloudflare" | "smtp" | "console" {
  if (!platform.env.MAIL_FROM) return "console";
  if (platform.binding) return "cloudflare";
  if (smtpOptions(platform.env) && platform.createTransport) return "smtp";
  return "console";
}

export function pickSender(platform: MailPlatform): {
  kind: "cloudflare" | "smtp" | "console";
  sender: EmailSender;
  problem?: string;
} {
  const kind = senderKind(platform);
  const from = platform.env.MAIL_FROM!;
  if (kind === "cloudflare") {
    const binding = platform.binding!;
    return {
      kind,
      sender: {
        async sendMagicLink(to, url) {
          await binding.send({ from: parseFrom(from), to, ...signInEmail(url) });
        },
      },
    };
  }
  if (kind === "smtp") {
    const transport = platform.createTransport!(smtpOptions(platform.env)!);
    return {
      kind,
      sender: {
        async sendMagicLink(to, url) {
          await transport.sendMail({ from, to, ...signInEmail(url) });
        },
      },
    };
  }
  const canSend = platform.binding || (smtpOptions(platform.env) && platform.createTransport);
  const problem =
    canSend && !platform.env.MAIL_FROM
      ? "[awml] MAIL_FROM is not set, so sign-in links are printed to this log, not sent. Set MAIL_FROM to who they come from, such as Registry <login@registry.example.com>."
      : undefined;
  return { kind, sender: logSender(platform), problem };
}

// Whether sign-in links reach people by email, or only the server's log.
export async function signInLinksEmailed() {
  return senderKind(await mailPlatform()) !== "console";
}

let override: EmailSender | undefined;
let chosen: EmailSender | undefined;

// One sender per process or Worker isolate.
export async function getEmailSender(): Promise<EmailSender> {
  if (override) return override;
  if (!chosen) {
    const picked = pickSender(await mailPlatform());
    if (picked.kind === "console")
      console.warn(picked.problem ?? "[awml] EMAIL IS NOT SET UP: sign-in links will be printed to this log, not sent.");
    chosen = picked.sender;
  }
  return chosen;
}

// Tests send through their own fake.
export function setEmailSender(next: EmailSender | undefined) {
  override = next;
}
