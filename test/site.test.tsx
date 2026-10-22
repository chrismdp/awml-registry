import fs from "node:fs";
import path from "node:path";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LoginForm } from "@/components/LoginForm";
import { drawingFont } from "@/components/Mermaid";
import { getDb } from "@/db/client";
import { engine } from "@/engine";
import { createOrganisation } from "@/server/organisations";
import { listTokens } from "@/server/tokens";
import { inventory } from "@/server/registry";
import { getViewer } from "@/server/viewer";
import HomePage from "@/app/page";
import GalleryPage from "@/app/gallery/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import TokensPage from "@/app/settings/tokens/page";
import LoginPage from "@/app/login/page";
import { makeToken } from "@/app/settings/tokens/actions";
import { example, orgWith, person, request, signIn, withEdition, type Who } from "./helpers";
import { pageRequest, renderPage } from "./pages";

const security = example("dinners-security.yaml");
const platform = example("dinners-platform.yaml");

const withTitle = (title: string) => security.replace("title: The family's dinners", `title: ${title}`);

// A workflow with no AI, nobody deciding and no platform file.
const binDay = `awml: "0.2"
title: Bin day
view: security
groups:
  - { id: home, label: "home: Sam" }
parts:
  - { id: wed, kind: trigger, label: "Wednesday 18:00" }
  - { id: remind, kind: code, op: do, label: "Post the bin reminder", in: home }
  - { id: chat, kind: surface, label: "House chat", in: home }
lines:
  - { from: wed, to: remind, kind: start }
  - { from: remind, to: chat, kind: data }
`;

// The page's text, with tags and the spaces between them taken out.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function push(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, { as, json: body });
  expect(res.status).toBe(201);
}

describe("the public gallery", () => {
  it("lists public workflows newest first and searches them by title", async () => {
    const ana = await person("ana");
    await push(ana.username, "older", { token: ana.token }, { security: withTitle("Weekly dinners") });
    await new Promise((r) => setTimeout(r, 5));
    await push(ana.username, "newer", { token: ana.token }, { security: withTitle("Client email") });
    const all = (await renderPage(GalleryPage, {})).html;
    expect(all.indexOf("Client email")).toBeLessThan(all.indexOf("Weekly dinners"));
    const found = (await renderPage(GalleryPage, {}, { search: { q: "dinner" } })).html;
    expect(found).toContain("Weekly dinners");
    expect(found).not.toContain("Client email");
    expect((await renderPage(GalleryPage, {}, { search: { q: "%" } })).html).toContain("No public workflow");
  });

  it("shows each workflow as a card with its drawing, who decides its steps and its address", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security, platform });
    const page = await renderPage(GalleryPage, {});
    const shown = text(page.html);
    expect(shown).toContain("Public workflows");
    expect(shown).toContain("Workflows people have drawn and shared. Borrow one and make it yours.");
    expect(shown).toContain("The family's dinners AI 1 Code 3 Person 0 ana / dinners");
    expect(page.html).toContain(await engine.draw(security).then((m) => m.split("\n")[0]));
    expect(page.html).toContain('placeholder="Search by title"');
    expect(page.html).toContain('action="/gallery"');
  });

  it("is the home page unless the edition gives one", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security });
    await withEdition({ homePage: undefined }, async () => {
      expect((await renderPage(HomePage, {})).html).toContain("The family&#x27;s dinners");
    });
    await withEdition({ homePage: () => <p>Hosted home</p> }, async () => {
      expect((await renderPage(HomePage, {})).html).toBe("<p>Hosted home</p>");
    });
  });

  it("moved from /explore, which sends old links and searches to /gallery for good", async () => {
    const searched = await request("GET", "/explore?q=family+dinners");
    expect(searched.status).toBe(308);
    expect(searched.headers.get("location")).toBe("/gallery?q=family+dinners");
    expect((await request("GET", "/explore")).headers.get("location")).toBe("/gallery");
  });
});

describe("a workflow's page", () => {
  it("draws one view at a time behind a tab for each, and downloads the file on show", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security, platform });
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" });
    const shown = text(page.html);
    expect(shown).toContain("ana / dinners The family's dinners No mistakes Public · Version 1 of 1");
    expect(shown).toContain("Who may see each part Where each part runs");
    expect(page.html).toContain(await engine.draw(security).then((m) => m.split("\n")[0]));
    expect(page.html).toContain(`href="/${ana.username}/dinners/v/1/security.yaml"`);
    expect(page.html).toContain(`href="?view=platform"`);

    const other = await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" }, { search: { view: "platform" } });
    expect(other.html).toContain(await engine.draw(platform).then((m) => m.split("\n")[1]));
    expect(other.html).toContain(`href="/${ana.username}/dinners/v/1/platform.yaml"`);
  });

  it("says who decides, what reaches outside, what leaves its scope and everything in it", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security, platform });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(shown).toContain("Who decides 1 AI 3 code No step is decided by a person.");
    expect(shown).toContain("Outside actions Allow 1 Ask 1 Block 0");
    expect(shown).toContain("Leaves its scope standing rule: dinners to carers");
    expect(shown).toContain("Everything in it Triggers 3 Reviews 1 Notes 3 Connectors 3 Surfaces 3 Scopes 3");
  });

  it("says how to change it with your own AI or from your machine, and that the version before stays", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security, platform });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(shown).toContain(
      "Change it Every change is checked, then saved as version 2. Version 1 stays as it is. " +
        "Ask your own AI Connect Claude or ChatGPT to the registry and tell it what to change. " +
        "It runs on your account, not ours. http://localhost:3000/mcp " +
        `Push from your machine awml push ${ana.username}/dinners security.yaml platform.yaml`,
    );
    expect(shown).not.toContain("Edit the YAML here");
  });

  it("names the person steps when people decide some of the steps", async () => {
    const ana = await person("ana");
    const withPerson = security.replace("kind: ai, label: \"Plan", "kind: person, label: \"Plan");
    await push(ana.username, "dinners", { token: ana.token }, { security: withPerson });
    const shown = text((await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" })).html);
    expect(shown).toContain("Who decides 3 code 1 person 1 step is decided by a person.");
    expect(shown).toContain("Who may see each part");
    expect(shown).not.toContain("Where each part runs");
  });
});

describe("a workflow's YAML tab", () => {
  const tricky = binDay.replace("title: Bin day", "title: Bin <day> & co");

  it("is a third tab that shows the security file then the platform file as escaped text, with a download for each", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security: withTitle("Dinners <b>&</b>"), platform });
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" }, { search: { view: "yaml" } });
    expect(page.status).toBe(200);
    expect(text(page.html)).toContain("Who may see each part Where each part runs YAML");
    expect(page.html).toContain(`href="?view=yaml"`);
    expect(page.html).not.toContain("<figure");
    expect(page.html).not.toContain("flowchart");
    expect(page.html).toContain("title: Dinners &lt;b&gt;&amp;&lt;/b&gt;");
    expect(page.html).not.toContain("<b>&</b>");
    expect(page.html).toContain(platform.split("\n")[1].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;"));
    const shown = text(page.html);
    expect(shown.indexOf("security.yaml")).toBeGreaterThan(-1);
    expect(shown.indexOf("security.yaml")).toBeLessThan(shown.indexOf("platform.yaml"));
    expect(page.html).toContain(`href="/${ana.username}/dinners/v/1/security.yaml"`);
    expect(page.html).toContain(`href="/${ana.username}/dinners/v/1/platform.yaml"`);
    expect(page.html).toContain("Download YAML");
    expect(shown).toContain("Who decides");
  });

  it("shows only the security file when there is no platform file", async () => {
    const ana = await person("ana");
    await push(ana.username, "bins", { token: ana.token }, { security: tricky });
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "bins" }, { search: { view: "yaml" } });
    const shown = text(page.html);
    expect(shown).toContain("security.yaml");
    expect(shown).toContain("title: Bin <day> & co");
    expect(shown).not.toContain("platform.yaml");
  });

  it("works on an older version", async () => {
    const ana = await person("ana");
    await push(ana.username, "bins", { token: ana.token }, { security: binDay });
    await push(ana.username, "bins", { token: ana.token }, { security: tricky });
    const page = await renderPage(VersionPage, { owner: ana.username, slug: "bins", n: "1" }, { search: { view: "yaml" } });
    expect(page.status).toBe(200);
    expect(text(page.html)).toContain("title: Bin day");
    expect(text(page.html)).not.toContain("title: Bin <day>");
    expect(page.html).toContain(`href="/${ana.username}/bins/v/1/security.yaml"`);
  });

  it("is not found for someone outside a private workflow's organisation, and shown to a member", async () => {
    const ana = await person("ana");
    const bo = await person("bo");
    await orgWith("cares", ana);
    await push("cares", "secret", { token: ana.token }, { security: binDay, visibility: "private" });
    const params = { owner: "cares", slug: "secret" };
    const search = { view: "yaml" };
    expect((await renderPage(WorkflowPage, params, { search })).status).toBe(404);
    expect((await renderPage(WorkflowPage, params, { as: bo, search })).status).toBe(404);
    expect((await renderPage(VersionPage, { ...params, n: "1" }, { as: bo, search })).status).toBe(404);
    const member = await renderPage(WorkflowPage, params, { as: ana, search });
    expect(member.status).toBe(200);
    expect(text(member.html)).toContain("title: Bin day");
  });
});

describe("an organisation's inventory", () => {
  it("shows every workflow's latest summary and totals across them, listing publishing line labels", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    await push("acme", "dinners", { token: olive.token }, { security });
    await push("acme", "dinners", { token: olive.token }, { security, platform });
    await push("acme", "payroll", { token: olive.token }, { security, visibility: "private" });
    const both = JSON.parse(example("dinners.summary.json"));
    const one = JSON.parse(example("dinners-security.summary.json"));

    const inv = (await inventory(await getDb(), (await getViewer(new Headers({ cookie: olive.cookie }))), "acme"))!;
    expect(inv.rows.map((r) => [r.slug, r.latest])).toEqual([["dinners", 2], ["payroll", 1]]);
    expect(inv.rows[0].summary).toEqual(both);
    expect(inv.totals.steps.code).toBe(both.steps.code + one.steps.code);
    expect(inv.totals.outsideActions.ask).toBe(both.outsideActions.ask + one.outsideActions.ask);
    expect(inv.totals.operations.do).toBe(both.operations.do + one.operations.do);
    expect(inv.totals.platforms).toBe(both.platforms + one.platforms);
    expect(inv.totals.publishingLines.count).toBe(both.publishingLines.count + one.publishingLines.count);
    expect(inv.totals.publishingLines.labels).toEqual(["standing rule: dinners to carers"]);

  });

  it("counts where AI and people are across the workflows, and lists each one's AI steps, people, scopes and platforms", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    await push("acme", "dinners", { token: olive.token }, { security, platform, visibility: "private" });
    await push("acme", "bin-day", { token: olive.token }, { security: binDay });

    const page = await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: olive.cookie } });
    expect(page.status).toBe(200);
    const shown = text(page.html);
    expect(shown).toContain("Workflows Inventory Platforms Members Audit log");
    expect(shown).toContain("acme's AI workflows");
    expect(shown).toContain("Where AI is, where people are, what it can see and where it runs.");
    expect(shown).toContain("1 of 2 use AI somewhere");
    expect(shown).toContain("1 of 2 have no person in them at all");
    expect(shown).toContain("4 scopes touched, 1 line leaves one");
    expect(shown).toContain("1 of 2 don't say where they run yet");
    expect(shown).toContain("Workflow AI People Scopes it touches Runs on");
    expect(shown).toContain(
      "Bin day Public None Code only Nobody home No platform view yet",
    );
    expect(shown).toContain(
      "The family's dinners Private · 1 line leaves a scope 1 of 4 steps Plan next week's dinners 1 review Owen's yes to the exact basket carers family household Server: claude-sonnet-4-5 The family messaging app The supermarket The calendar The kitchen screen",
    );
  });

  it("says so when an organisation has no workflows yet", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    const shown = text((await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: olive.cookie } })).html);
    expect(shown).toContain("acme has no workflows yet. Push the first one with awml push acme/<name> security.yaml");
    expect(shown).not.toContain("use AI somewhere");
  });
});

describe("the sign-in page", () => {
  it("offers only the providers that are set up, and always the email link", async () => {
    const shown = text((await renderPage(LoginPage, {})).html);
    expect(shown).toContain("Sign in New here? This makes your account too.");
    expect(shown).toContain("Email me a link");
    expect(shown).toContain("The link works once, for 15 minutes. No passwords.");
    expect(shown).not.toContain("Continue with GitHub");
    expect(shown).not.toContain("or by email");

    process.env.GITHUB_CLIENT_ID = "id";
    try {
      const withGitHub = text((await renderPage(LoginPage, {})).html);
      expect(withGitHub).toContain("Continue with GitHub");
      expect(withGitHub).not.toContain("Continue with Google");
      expect(withGitHub).toContain("or by email");
    } finally {
      delete process.env.GITHUB_CLIENT_ID;
    }
  });

  it("tells the form what to say once the link is sent: that it went to the server log, unless email is set up", async () => {
    const sentNotice = async () => {
      pageRequest.headers = new Headers();
      const page = await LoginPage({ searchParams: Promise.resolve({}) });
      return propsOf(page, LoginForm)?.sent;
    };
    const withoutEmail = await sentNotice();
    expect(withoutEmail).toMatch(/printed to the server's log/);
    expect(withoutEmail).not.toMatch(/check your email/i);

    process.env.MAIL_FROM = "Registry <login@registry.example.com>";
    process.env.SMTP_URL = "smtp://mail.example.com";
    try {
      expect(await sentNotice()).toMatch(/check your email/i);
    } finally {
      delete process.env.MAIL_FROM;
      delete process.env.SMTP_URL;
    }
  });
});

// The props of the first element of a type in a server component's tree.
function propsOf<P>(node: ReactNode, type: (props: P) => ReactNode): P | undefined {
  if (Array.isArray(node)) return node.map((n) => propsOf(n, type)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === type) return node.props as P;
  return propsOf(node.props.children, type);
}

describe("names", () => {
  it("gives a user a username from their email on first sign-in, avoiding reserved and taken names", async () => {
    expect((await signIn("ana@example.com")).user.username).toBe("ana");
    expect((await signIn("ana@elsewhere.com")).user.username).toBe("ana-2");
    expect((await signIn("admin@example.com")).user.username).toBe("admin-2");
    expect((await signIn("mcp@example.com")).user.username).toBe("mcp-2");
    expect((await signIn("consent@example.com")).user.username).toBe("consent-2");
    expect((await signIn("gallery@example.com")).user.username).toBe("gallery-2");
  });

  it("refuses an organisation slug that is reserved, malformed or taken by a user", async () => {
    const ana = await person("ana");
    const db = await getDb();
    for (const slug of ["gallery", "explore", "api", "Bad Slug", "ana"]) {
      const made = await createOrganisation(db, ana.id, { slug, name: "x" });
      expect(made.ok, slug).toBe(false);
    }
    const res = await request("POST", "/api/orgs", { as: { cookie: ana.cookie }, form: { slug: "acme", name: "Acme" } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/acme/settings");
    const again = await request("POST", "/api/orgs", { as: { cookie: ana.cookie }, form: { slug: "acme", name: "Acme" } });
    expect(again.headers.get("location")).toContain("error=");
  });

  it("refuses a workflow slug the organisation's own pages use", async () => {
    const ana = await person("ana");
    for (const slug of ["inventory", "settings", "platforms"]) {
      const res = await request("POST", `/api/v1/${ana.username}/${slug}/versions`, {
        as: { token: ana.token },
        json: { security },
      });
      expect(res.status).toBe(422);
      expect((await res.json()).errors).toEqual([`"${slug}" is reserved.`]);
    }
  });
});

describe("the tokens page", () => {
  it("shows a new token's secret once, then lists it by name only", async () => {
    const ana = await signIn("ana@example.com");
    pageRequest.headers = new Headers({ cookie: ana.cookie });
    const form = new FormData();
    form.set("name", "laptop");
    const made = await makeToken({}, form);
    expect(made.secret).toMatch(/^awml_/);
    const tokens = await listTokens(await getDb(), ana.user.id);
    expect(tokens.map((t) => t.name)).toEqual(["laptop"]);
    const page = await renderPage(TokensPage, {}, { as: { cookie: ana.cookie } });
    expect(page.html).toContain("laptop");
    expect(page.html).not.toContain(made.secret);
    const res = await request("GET", "/api/v1/ana/anything", { as: { token: made.secret } });
    expect(res.status).toBe(404);
  });

  it("sends a signed-out visitor to sign in", async () => {
    expect(await renderPage(TokensPage, {})).toMatchObject({ status: 307, location: "/login?next=/settings/tokens" });
  });
});

describe("the engine", () => {
  it("gives the verdict, summary and drawing the native awml gives", async () => {
    expect(await engine.check(security)).toEqual([]);
    expect(await engine.check(example("bad.yaml"))).toEqual(
      example("bad.check.txt").trim().split("\n").map((l) => l.replace(/^bad\.yaml: /, "")),
    );
    expect(await engine.check("- just a list\n")).not.toEqual([]);
    expect(await engine.summarise({ security, platform })).toEqual(JSON.parse(example("dinners.summary.json")));
    expect(await engine.draw(security)).toBe(example("dinners-security.mmd").replace(/\n$/, ""));
  });
});

describe("drawing a workflow", () => {
  it("asks for Inter, which the registry serves itself under the SIL Open Font License", async () => {
    expect(drawingFont(await engine.draw(security))).toBe("Inter, sans-serif");
    const css = fs.readFileSync(path.join("src", "app", "site.css"), "utf8");
    const face = /@font-face\s*{([^}]*)}/.exec(css)?.[1] ?? "";
    expect(face).toMatch(/font-family:\s*"Inter"/);
    const src = /src:\s*url\("([^"]+)"\)\s*format\("woff2"\)/.exec(face)?.[1];
    expect(src).toBeDefined();
    const file = path.join("src", "app", src!);
    expect(fs.readFileSync(file).subarray(0, 4).toString()).toBe("wOF2");
    expect(fs.readFileSync(path.join(path.dirname(file), "LICENSE.txt"), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });
});

describe("the terms and privacy policy", () => {
  it("are linked from the sign-in page only when the edition gives them", async () => {
    await withEdition({ legalLinks: undefined }, async () => {
      const plain = await renderPage(LoginPage, {});
      expect(plain.html).not.toContain('href="/terms"');
      expect(text(plain.html)).not.toContain("By signing in you agree");
      expect(text(plain.html)).toContain("We never send your workflows to a model.");
    });
    await withEdition({ legalLinks: { terms: "/legal/terms", privacy: "/legal/privacy" } }, async () => {
      const linked = await renderPage(LoginPage, {});
      expect(linked.html).toContain('href="/legal/terms"');
      expect(linked.html).toContain('href="/legal/privacy"');
      expect(text(linked.html)).toContain("By signing in you agree to the terms and privacy policy");
      expect(text(linked.html)).toContain("We never send your workflows to a model.");
    });
  });
});
