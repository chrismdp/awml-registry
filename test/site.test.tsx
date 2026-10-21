import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { edition } from "@/edition";
import { engine } from "@/engine";
import { createOrganisation } from "@/server/organisations";
import { listTokens } from "@/server/tokens";
import { inventory } from "@/server/registry";
import { getViewer } from "@/server/viewer";
import HomePage from "@/app/page";
import ExplorePage from "@/app/explore/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import TokensPage from "@/app/settings/tokens/page";
import { makeToken } from "@/app/settings/tokens/actions";
import { example, orgWith, person, request, signIn, type Who } from "./helpers";
import { pageRequest, renderPage } from "./pages";

const security = example("dinners-security.yaml");
const platform = example("dinners-platform.yaml");

const withTitle = (title: string) => security.replace("title: The family's dinners", `title: ${title}`);

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
    const all = (await renderPage(ExplorePage, {})).html;
    expect(all.indexOf("Client email")).toBeLessThan(all.indexOf("Weekly dinners"));
    const found = (await renderPage(ExplorePage, {}, { search: { q: "dinner" } })).html;
    expect(found).toContain("Weekly dinners");
    expect(found).not.toContain("Client email");
    expect((await renderPage(ExplorePage, {}, { search: { q: "%" } })).html).toContain("No public workflow");
  });

  it("is the home page unless the edition gives one", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security });
    expect((await renderPage(HomePage, {})).html).toContain("The family&#x27;s dinners");
    const original = edition.homePage;
    edition.homePage = () => <p>Hosted home</p>;
    try {
      expect((await renderPage(HomePage, {})).html).toBe("<p>Hosted home</p>");
    } finally {
      edition.homePage = original;
    }
  });
});

describe("a workflow's page", () => {
  it("draws both views, links each file and gives the command to push the next version", async () => {
    const ana = await person("ana");
    await push(ana.username, "dinners", { token: ana.token }, { security, platform });
    const page = await renderPage(WorkflowPage, { owner: ana.username, slug: "dinners" });
    expect(page.html).toContain("Security view");
    expect(page.html).toContain("Platform view");
    expect(page.html).toContain(`/${ana.username}/dinners/v/1/security.yaml`);
    expect(page.html).toContain(await engine.draw(security).then((m) => m.split("\n")[0]));
    expect(page.html).toContain(`awml push ${ana.username}/dinners security.yaml platform.yaml`);
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

    const page = await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: olive.cookie } });
    expect(page.status).toBe(200);
    expect(page.html).toContain("2 workflows");
    for (const heading of ["AI", "Code", "Person", "Allow", "Ask", "Block", "Publishing lines", "Refused reads", "Red lines", "bring-in"])
      expect(page.html).toContain(`>${heading}<`);
    expect(page.html).toContain("standing rule: dinners to carers");
    expect(page.html).not.toMatch(/gaps/i);
  });
});

describe("names", () => {
  it("gives a user a username from their email on first sign-in, avoiding reserved and taken names", async () => {
    expect((await signIn("ana@example.com")).user.username).toBe("ana");
    expect((await signIn("ana@elsewhere.com")).user.username).toBe("ana-2");
    expect((await signIn("admin@example.com")).user.username).toBe("admin-2");
  });

  it("refuses an organisation slug that is reserved, malformed or taken by a user", async () => {
    const ana = await person("ana");
    const db = await getDb();
    for (const slug of ["explore", "api", "Bad Slug", "ana"]) {
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
    for (const slug of ["inventory", "settings"]) {
      const res = await request("POST", `/api/v1/${ana.username}/${slug}/versions`, {
        as: { token: ana.token },
        json: { security },
      });
      expect(res.status).toBe(422);
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
