import { afterEach, describe, expect, it, vi } from "vitest";
import { pickSender, smtpOptions, type EmailBinding, type MailTransport } from "@/server/email";

const url = "https://awml.io/api/auth/magic-link/verify?token=abc&callbackURL=%2Fsettings";

function fakeBinding() {
  const sent: unknown[] = [];
  const binding: EmailBinding = {
    async send(message) {
      sent.push(message);
      return { messageId: "m1" };
    },
  };
  return { binding, sent };
}

function fakeSmtp() {
  const made: unknown[] = [];
  const sent: unknown[] = [];
  const createTransport = (options: unknown): MailTransport => {
    made.push(options);
    return {
      async sendMail(message) {
        sent.push(message);
      },
    };
  };
  return { createTransport, made, sent };
}

afterEach(() => vi.restoreAllMocks());

describe("choosing how sign-in links are sent", () => {
  it("uses Cloudflare's EMAIL binding when it is there, even with SMTP set", () => {
    const { binding } = fakeBinding();
    const smtp = fakeSmtp();
    const chosen = pickSender({ binding, env: { SMTP_URL: "smtp://x" }, createTransport: smtp.createTransport });
    expect(chosen.kind).toBe("cloudflare");
    expect(smtp.made).toEqual([]);
  });

  it("uses SMTP when SMTP_URL is set", () => {
    const smtp = fakeSmtp();
    const chosen = pickSender({ env: { SMTP_URL: "smtps://u:p@mail.example.com" }, createTransport: smtp.createTransport });
    expect(chosen.kind).toBe("smtp");
    expect(smtp.made).toEqual(["smtps://u:p@mail.example.com"]);
  });

  it("uses SMTP when SMTP_HOST is set, with its port, user and password", () => {
    const smtp = fakeSmtp();
    const chosen = pickSender({
      env: { SMTP_HOST: "mail.example.com", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p" },
      createTransport: smtp.createTransport,
    });
    expect(chosen.kind).toBe("smtp");
    expect(smtp.made).toEqual([
      { host: "mail.example.com", port: 465, secure: true, auth: { user: "u", pass: "p" } },
    ]);
  });

  it("prints links to the log, and says so loudly, when nothing is set up", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chosen = pickSender({ env: {} });
    expect(chosen.kind).toBe("console");
    await chosen.sender.sendMagicLink("ana@example.com", url);
    expect(warn.mock.calls.join(" ")).toMatch(/NOT SENT/);
    expect(log.mock.calls.join(" ")).toContain(url);
  });
});

describe("SMTP settings", () => {
  it("defaults the port to 587 with STARTTLS and leaves out auth without a user", () => {
    expect(smtpOptions({ SMTP_HOST: "mail.example.com" })).toEqual({ host: "mail.example.com", port: 587, secure: false });
  });

  it("is nothing when neither SMTP_URL nor SMTP_HOST is set", () => {
    expect(smtpOptions({ SMTP_USER: "u" })).toBeNull();
  });
});

describe("the sign-in email", () => {
  it("goes through the Cloudflare binding from MAIL_FROM, as text and HTML", async () => {
    const { binding, sent } = fakeBinding();
    const { sender } = pickSender({ binding, env: { MAIL_FROM: "Registry <hello@example.com>" } });
    await sender.sendMagicLink("ana@example.com", url);
    expect(sent).toHaveLength(1);
    const message = sent[0] as Record<string, unknown>;
    expect(message.from).toEqual({ email: "hello@example.com", name: "Registry" });
    expect(message.to).toBe("ana@example.com");
    expect(message.subject).toBe("Sign in to the AWML Registry");
    expect(message.text).toContain(url);
    expect(message.html).toContain(url.replace(/&/g, "&amp;"));
    expect(message.html).not.toContain("&callbackURL");
  });

  it("comes from AWML <login@awml.io> unless MAIL_FROM says otherwise", async () => {
    const { binding, sent } = fakeBinding();
    await pickSender({ binding, env: {} }).sender.sendMagicLink("ana@example.com", url);
    expect((sent[0] as { from: unknown }).from).toEqual({ email: "login@awml.io", name: "AWML" });
  });

  it("goes through SMTP from MAIL_FROM, as text and HTML", async () => {
    const smtp = fakeSmtp();
    const { sender } = pickSender({
      env: { SMTP_URL: "smtp://mail.example.com", MAIL_FROM: "Registry <hello@example.com>" },
      createTransport: smtp.createTransport,
    });
    await sender.sendMagicLink("ana@example.com", url);
    expect(smtp.sent).toEqual([
      {
        from: "Registry <hello@example.com>",
        to: "ana@example.com",
        subject: "Sign in to the AWML Registry",
        text: expect.stringContaining(url),
        html: expect.stringContaining(url.replace(/&/g, "&amp;")),
      },
    ]);
  });
});
