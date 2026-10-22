import { afterEach, describe, expect, it, vi } from "vitest";
import { pickSender, smtpOptions, type EmailBinding, type MailTransport } from "@/server/email";

const url = "https://registry.example.com/api/auth/magic-link/verify?token=abc&callbackURL=%2Fsettings";
const MAIL_FROM = "Registry <login@registry.example.com>";

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
    const chosen = pickSender({ binding, env: { MAIL_FROM, SMTP_URL: "smtp://x" }, createTransport: smtp.createTransport });
    expect(chosen.kind).toBe("cloudflare");
    expect(smtp.made).toEqual([]);
  });

  it("uses SMTP when SMTP_URL is set", () => {
    const smtp = fakeSmtp();
    const chosen = pickSender({ env: { MAIL_FROM, SMTP_URL: "smtps://u:p@mail.example.com" }, createTransport: smtp.createTransport });
    expect(chosen.kind).toBe("smtp");
    expect(smtp.made).toEqual(["smtps://u:p@mail.example.com"]);
  });

  it("uses SMTP when SMTP_HOST is set, with its port, user and password", () => {
    const smtp = fakeSmtp();
    const chosen = pickSender({
      env: { MAIL_FROM, SMTP_HOST: "mail.example.com", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p" },
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

  it("on a server, as in Docker, says to set MAIL_FROM and SMTP and names nothing of Cloudflare's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chosen = pickSender({ env: {}, createTransport: fakeSmtp().createTransport });
    await chosen.sender.sendMagicLink("ana@example.com", url);
    const said = warn.mock.calls.join(" ");
    expect(said).toContain("MAIL_FROM");
    expect(said).toContain("SMTP_URL");
    expect(said).not.toMatch(/Cloudflare|binding/);
  });

  it("on a Worker, says to set MAIL_FROM and bind Cloudflare Email Service and names nothing of SMTP", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chosen = pickSender({ env: {} });
    await chosen.sender.sendMagicLink("ana@example.com", url);
    const said = warn.mock.calls.join(" ");
    expect(said).toContain("MAIL_FROM");
    expect(said).toContain("EMAIL");
    expect(said).not.toMatch(/SMTP/);
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

  it("is not sent without MAIL_FROM: the link goes to the log, which says MAIL_FROM is missing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { binding, sent } = fakeBinding();
    const smtp = fakeSmtp();
    for (const config of [
      { binding, env: {} },
      { env: { SMTP_URL: "smtp://mail.example.com" }, createTransport: smtp.createTransport },
    ]) {
      const chosen = pickSender(config);
      expect(chosen.kind).toBe("console");
      expect(chosen.problem).toContain("MAIL_FROM is not set");
      await chosen.sender.sendMagicLink("ana@example.com", url);
    }
    expect(sent).toEqual([]);
    expect(smtp.sent).toEqual([]);
    expect(log.mock.calls.join(" ")).toContain(url);
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
