// The Settings and API tokens pages, built to docs/storyboard/Settings.dc.html
// and docs/storyboard/Tokens.dc.html: a side menu, then a card for each part.
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getDb } from "@/db/client";
import { account, token } from "@/db/schema";
import SettingsPage from "@/app/settings/page";
import TokensPage from "@/app/settings/tokens/page";
import { NewToken } from "@/components/MakeTokenForm";
import { addMember } from "@/server/organisations";
import { createToken, revokeToken, listTokens } from "@/server/tokens";
import { orgWith, person, signIn } from "./helpers";
import { connect } from "./mcp-client";
import { renderPage } from "./pages";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

type Someone = { cookie: string };

afterEach(() => {
  vi.useRealTimers();
});

// Thursday 22 October 2026, 4:43pm in London (BST).
function itIsOct22() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T15:43:00Z"));
}

// A table sits in a white box that scrolls sideways inside its card, so on a
// phone the page itself never does.
function scrollsInItsCard(html: string) {
  expect(html).toMatch(/<div class="settings-table"><table>/);
  const css = fs.readFileSync(path.join("src", "app", "site.css"), "utf8");
  const box = /^\.settings-table\s*{([^}]*)}/m.exec(css)?.[1] ?? "";
  expect(box).toMatch(/overflow-x:\s*auto/);
}

// The pattern attribute on the input with this name, as the browser gets it.
const patternOf = (html: string, name: string) =>
  new RegExp(`<input [^>]*name="${name}"[^>]*>`).exec(html)?.[0].match(/pattern="([^"]*)"/)?.[1];

const settings = async (who: Someone, search: Record<string, string> = {}) =>
  (await renderPage(SettingsPage, {}, { as: who, search })).html;
const tokens = async (who: Someone) => (await renderPage(TokensPage, {}, { as: who })).html;

// The card a heading starts, up to the next card.
const card = (html: string, heading: string) => {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  expect(start).toBeGreaterThan(-1);
  const section = html.lastIndexOf("<section", start);
  return html.slice(section, html.indexOf("</section>", start));
};

// The side menu: each link's words and address, and which one is the page on show.
function sideMenu(html: string) {
  const nav = /<nav[^>]*aria-label="Settings"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
  return [...nav.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => ({
    label,
    href: /href="([^"]*)"/.exec(attrs)?.[1],
    current: attrs.includes('aria-current="page"'),
  }));
}

// A person who signed in with Google or GitHub has an account row for it.
async function signedInWith(userId: string, providerId: string, updatedAt = new Date()) {
  const db = await getDb();
  await db.insert(account).values({ id: `${providerId}-${userId}`, accountId: "1", providerId, userId, updatedAt });
}

describe("the side menu", () => {
  it("lists Account, Connected apps, API tokens and Organisations, with Account filled on Settings", async () => {
    const ana = await person("ana");
    expect(sideMenu(await settings(ana))).toEqual([
      { label: "Account", href: "/settings#account", current: true },
      { label: "Connected apps", href: "/settings#apps", current: false },
      { label: "API tokens", href: "/settings/tokens", current: false },
      { label: "Organisations", href: "/settings#orgs", current: false },
    ]);
  });

  it("fills API tokens on the tokens page", async () => {
    const ana = await person("ana");
    expect(sideMenu(await tokens(ana))).toEqual([
      { label: "Account", href: "/settings#account", current: false },
      { label: "Connected apps", href: "/settings#apps", current: false },
      { label: "API tokens", href: "/settings/tokens", current: true },
      { label: "Organisations", href: "/settings#orgs", current: false },
    ]);
  });

  it("gives each part of Settings the address the menu links to", async () => {
    const html = await settings(await person("ana"));
    for (const id of ["account", "apps", "orgs"]) expect(html).toContain(`id="${id}"`);
  });
});

describe("Settings", () => {
  it("says who is signed in, and with what, under the heading", async () => {
    const ana = await person("ana");
    expect(text(await settings(ana))).toContain("Settings Signed in as ana@example.com with an email link.");
    await signedInWith(ana.id, "github");
    expect(text(await settings(ana))).toContain("Signed in as ana@example.com with GitHub.");
  });

  it("names the provider the account last signed in with", async () => {
    const bea = await person("bea");
    await signedInWith(bea.id, "github", new Date(Date.now() - 60_000));
    await signedInWith(bea.id, "google");
    const words = text(await settings(bea));
    expect(words).toContain("Signed in as bea@example.com with Google.");
    expect(words).toContain("Signed in with Google. Signing out here does not disconnect your AI apps.");
  });

  it("has a Your username card: the address prefix in the field, Save, the hint, then Sign out", async () => {
    const ana = await person("ana");
    const html = card(await settings(ana), "Your username");
    expect(html).toContain('id="account"');
    expect(html).toContain(
      'Your workflows and platforms live at <a href="/ana">localhost:3000/ana</a>. Change it and they move with you. ' +
        "Old links redirect until someone else takes the name.",
    );
    expect(html).toMatch(/<label[^>]*>Username<span[^>]*><span[^>]*>localhost:3000\/<\/span><input [^>]*name="username"/);
    expect(html).toContain('value="ana"');
    expect(html).toContain(">Save</button>");
    expect(text(html)).toContain("Lower-case letters, digits and hyphens.");
    expect(text(html)).toContain("Signed in with an email link. Signing out here does not disconnect your AI apps.");
    expect(html).toMatch(/<form (?=[^>]*method="post")[^>]*action="\/logout"[^>]*><button [^>]*>Sign out<\/button><\/form>/);
  });

  it("has a Connected apps card: what it is, None yet, and how to connect another", async () => {
    const ana = await person("ana");
    const html = card(await settings(ana), "Connected apps");
    expect(html).toContain('id="apps"');
    expect(text(html)).toBe(
      "Connected apps AI apps you have let use your account through localhost:3000/mcp. " +
        "Disconnect one and its access stops within an hour. None yet. " +
        "To connect another, add http://localhost:3000/mcp as a connector in your AI app.",
    );
  });

  it("has an API tokens card that says how many the person has and links to Manage tokens", async () => {
    const ana = await person("ana");
    let html = card(await settings(ana), "API tokens");
    expect(text(html)).toBe("API tokens For the awml command line and scripts. You have 1. Manage tokens");
    expect(html).toMatch(/<a [^>]*href="\/settings\/tokens"[^>]*>Manage tokens<\/a>/);

    const db = await getDb();
    await createToken(db, ana.id, "laptop");
    html = card(await settings(ana), "API tokens");
    expect(text(html)).toContain("You have 2.");

    for (const t of await listTokens(db, ana.id)) await revokeToken(db, ana.id, t.id);
    expect(text(card(await settings(ana), "API tokens"))).toContain("You have none.");
  });

  it("has an Organisations card: each with its address and role, then Make an organisation", async () => {
    const ana = await person("ana");
    const bea = await person("bea");
    await orgWith("acme", ana);
    await orgWith("beans", bea);
    await addMember(await getDb(), bea.id, "beans", "ana", "member");
    const html = card(await settings(ana), "Organisations");
    expect(html).toContain('id="orgs"');
    expect(text(html)).toBe(
      "Organisations An organisation keeps its workflows and platforms together, and private to its members. " +
        "acme localhost:3000/acme Owner beans localhost:3000/beans Member " +
        "Make an organisation Name Address localhost:3000/ Make it",
    );
    expect(html).toContain('href="/acme"');
    expect(html).toContain('href="/beans"');
    expect(html).toMatch(/<form (?=[^>]*method="post")[^>]*action="\/api\/orgs"/);
    expect(html).toMatch(/<input [^>]*name="name"/);
    expect(html).toMatch(/Address<span[^>]*><span[^>]*>localhost:3000\/<\/span><input [^>]*name="slug"/);
  });

  // An unescaped "-" in a class is an error where the browser compiles a
  // pattern with the v flag, as Chrome does, and then it checks nothing.
  it("gives the username and organisation address fields a pattern the browser can compile", async () => {
    const html = await settings(await person("ana"));
    for (const name of ["username", "slug"]) {
      const pattern = patternOf(html, name);
      expect(pattern).toBe("[a-z0-9\\-]+");
      const field = new RegExp(`^(?:${pattern})$`, "v");
      expect(field.test("ana-2")).toBe(true);
      expect(field.test("Ana")).toBe(false);
    }
  });

  it("has no pattern attribute anywhere in src that the browser cannot compile", () => {
    const files = fs.readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"));
    const patterns = files.flatMap((f) =>
      [...fs.readFileSync(path.join("src", f), "utf8").matchAll(/\bpattern="([^"]*)"/g)].map(([, p]) => p),
    );
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(() => new RegExp(`^(?:${p})$`, "v"), p).not.toThrow();
  });

  it("says when each connected app was allowed and last used in UK time, as the Versions lists do", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Wednesday 21 October 2026, 9:12am in London (BST).
    vi.setSystemTime(new Date("2026-10-21T08:12:00Z"));
    const ana = await person("ana");
    await connect(ana);
    itIsOct22();
    const rows = text(card(await settings(ana), "Connected apps"));
    expect(rows).toContain("Test AI Yesterday 9:12am Yesterday 9:12am Disconnect");
    expect(rows).not.toContain("UTC");
  });

  it("puts the connected apps table in a box that scrolls inside its card", async () => {
    const ana = await person("ana");
    await connect(ana);
    scrollsInItsCard(card(await settings(ana), "Connected apps"));
  });

  it("says when the person is in no organisation", async () => {
    const ana = await person("ana");
    expect(text(card(await settings(ana), "Organisations"))).toContain("You are not in any organisation.");
  });

  it("shows a notice as a status banner and an error as an alert", async () => {
    const ana = await person("ana");
    expect(await settings(ana, { notice: "Saved." })).toContain('<p role="status">Saved.</p>');
    expect(await settings(ana, { error: "No good." })).toContain('<p role="alert">No good.</p>');
  });

  it("sends a signed-out visitor to sign in", async () => {
    expect(await renderPage(SettingsPage, {})).toMatchObject({ status: 307, location: "/login?next=/settings" });
  });
});

describe("API tokens", () => {
  it("has the crumb, the heading and the intro line", async () => {
    const html = await tokens(await person("ana"));
    expect(html).toMatch(/<p class="crumb"><a href="\/settings">settings<\/a> \/ tokens<\/p>/);
    expect(text(html)).toContain(
      "settings / tokens API tokens A token lets the awml command line, or any script, push and pull as you.",
    );
  });

  it("has a Make a token card, with the field labelled What it's for", async () => {
    const html = card(await tokens(await person("ana")), "Make a token");
    expect(text(html)).toBe("Make a token What it's for Make token");
    expect(html).toMatch(/<input [^>]*name="name"/);
  });

  it("lists the person's tokens with Revoke, and says what revoking does", async () => {
    const ana = await person("ana");
    const html = card(await tokens(ana), "Your tokens");
    expect(text(html)).toMatch(/^Your tokens Name Made Last used Actions test Today \d{1,2}:\d{2}[ap]m Never Revoke /);
    expect(text(html)).toContain("Revoke a token and anything using it stops working straight away.");
    expect(html.match(/>Revoke</g)).toHaveLength(1);
  });

  it("says when each token was made and last used in UK time, as the Versions lists do", async () => {
    itIsOct22();
    const ana = await person("ana");
    const db = await getDb();
    await createToken(db, ana.id, "laptop");
    // Sunday 18 October 2026, 9:12am in London (BST).
    await db.update(token).set({ lastUsedAt: new Date("2026-10-18T08:12:00Z") }).where(eq(token.name, "laptop"));
    const rows = text(card(await tokens(ana), "Your tokens"));
    expect(rows).toContain("test Today 4:43pm Never Revoke");
    expect(rows).toContain("laptop Today 4:43pm 18 Oct 2026, 9:12am Revoke");
    expect(rows).not.toContain("UTC");
  });

  it("puts the tokens table in a box that scrolls inside its card", async () => {
    scrollsInItsCard(card(await tokens(await person("ana")), "Your tokens"));
  });

  it("says None yet when the person has no tokens", async () => {
    const { cookie } = await signIn("cy@example.com");
    expect(text(card(await tokens({ cookie }), "Your tokens"))).toContain("None yet.");
  });

  it("shows a new token once, in the dark card, with Copy and what to do next", () => {
    const html = renderToStaticMarkup(<NewToken name="Work laptop" secret="awml_secret123" />);
    expect(html).toMatch(/^<section class="settings-card dark"/);
    expect(text(html)).toBe(
      'Your new token, "Work laptop" Copy it now. We keep only a fingerprint, so this page can\'t show it again. ' +
        "awml_secret123 Copy Then run awml login and paste it.",
    );
    expect(html).toMatch(/<code id="new-token">awml_secret123<\/code>/);
    expect(html).toContain('aria-controls="new-token"');
  });

  it("sends a signed-out visitor to sign in", async () => {
    expect(await renderPage(TokensPage, {})).toMatchObject({ status: 307, location: "/login?next=/settings/tokens" });
  });
});
