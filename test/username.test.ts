// Setting your own username: on the Settings page, through PATCH /api/v1/me
// and through the set_username tool on /mcp. Workflows and platforms belong
// to the account, not the name, so they follow the person to their new name,
// and their old address redirects to the new one until someone else takes it.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent, platform, user, workflow } from "@/db/schema";
import { createOrganisation } from "@/server/organisations";
import { listTokens, revokeToken } from "@/server/tokens";
import SettingsPage from "@/app/settings/page";
import { saveUsername } from "@/app/settings/actions";
import OwnerPage from "@/app/[owner]/page";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowSecurityPage from "@/app/[owner]/[slug]/security/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import VersionSecurityPage from "@/app/[owner]/[slug]/v/[n]/security/page";
import VersionPlatformPage from "@/app/[owner]/[slug]/v/[n]/platform/page";
import ImplementationPage from "@/app/[owner]/[slug]/platform/[implementation]/page";
import VersionImplementationPage from "@/app/[owner]/[slug]/v/[n]/platform/[implementation]/page";
import VersionYamlPage from "@/app/[owner]/[slug]/v/[n]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import VersionChecksPage from "@/app/[owner]/[slug]/v/[n]/checks/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import OrgSettingsPage from "@/app/[owner]/settings/page";
import GalleryPage from "@/app/gallery/page";
import { BASE, example, orgWith, person, request, signIn, type Who } from "./helpers";
import { call, connect, post } from "./mcp-client";
import { pageRequest, renderPage, type Page } from "./pages";
import { route } from "./router";

const dinners = example("dinners.yaml");
const worker = example("platforms/worker.yaml");

const RULE = "Use 1 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.";
const renamed = (from: string, to: string) =>
  `Your username is now ${to}. Links to /${from} will redirect to /${to} until someone else takes the name ${from}.`;

type Someone = Awaited<ReturnType<typeof person>>;

const nameOf = async (id: string) => {
  const [u] = await (await getDb()).select({ username: user.username }).from(user).where(eq(user.id, id));
  return u.username;
};

const renameEvents = async () =>
  (await getDb()).select().from(auditEvent).where(eq(auditEvent.action, "member_renamed"));

// The page's text, with tags and the spaces between them taken out.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const patchMe = (as: Who, body: unknown) => request("PATCH", "/api/v1/me", { as, json: body });

// Save pressed on the Settings page's username form, as someone or as nobody
// signed in, with any other fields given; gives where the page sends them.
async function saveOnSettings(who: { cookie: string } | undefined, username: string, extra: Record<string, string> = {}) {
  pageRequest.headers = new Headers(who ? { cookie: who.cookie } : {});
  const form = new FormData();
  form.set("username", username);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  try {
    await saveUsername(form);
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT;")) return new URL(digest.split(";")[2], BASE);
    throw e;
  }
  throw new Error("Save sent the page nowhere");
}

async function publish(who: Someone, owner: string, slug: string, visibility?: "private") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, {
    as: { token: who.token },
    json: { workflow: dinners, ...(visibility ? { visibility } : {}) },
  });
  expect(res.status).toBe(201);
}

async function addPlatform(who: Someone, owner: string, slug: string) {
  const res = await request("POST", `/api/v1/platforms/${owner}/${slug}/versions`, {
    as: { token: who.token },
    json: { description: worker },
  });
  expect(res.status).toBe(201);
}

describe("the username field on Settings", () => {
  it("shows the current username with Save, and says the old address will redirect", async () => {
    const ana = await person("ana");
    const page = await renderPage(SettingsPage, {}, { as: ana });
    const section = page.html.split("<h2>Your username</h2>")[1].split("<h2>")[0];
    expect(section).toContain('name="username"');
    expect(section).toContain('value="ana"');
    expect(section).toContain(">Save</button>");
    expect(section).toContain('Your workflows and platforms live at <a href="/ana">localhost:3000/ana</a>.');
    expect(text(section)).toContain("Change it and they move with you. Old links redirect until someone else takes the name.");
  });
});

describe("Positive boundary", () => {
  it("a person changes their own username on Settings, and their workflows and platforms show under the new name", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "dinners");
    await addPlatform(ana, "ana", "worker");

    const next = await saveOnSettings(ana, "ana-cooks");
    expect(next.pathname).toBe("/settings");
    expect(next.searchParams.get("notice")).toBe(renamed("ana", "ana-cooks"));
    expect(await nameOf(ana.id)).toBe("ana-cooks");
    const settings = await renderPage(SettingsPage, {}, { as: ana, search: Object.fromEntries(next.searchParams) });
    expect(settings.html).toContain('value="ana-cooks"');
    expect(text(settings.html)).toContain(renamed("ana", "ana-cooks"));

    expect((await renderPage(OwnerPage, { owner: "ana-cooks" })).html).toContain('href="/ana-cooks/dinners"');
    expect((await renderPage(WorkflowPage, { owner: "ana-cooks", slug: "dinners" })).status).toBe(200);
    expect((await renderPage(GalleryPage, {})).html).toContain('href="/ana-cooks/dinners"');
    expect(await (await request("GET", "/api/v1/ana-cooks/dinners")).json()).toMatchObject({
      owner: "ana-cooks",
      slug: "dinners",
    });
    expect(await (await request("GET", "/api/v1/platforms/ana-cooks/worker")).json()).toMatchObject({
      owner: "ana-cooks",
      slug: "worker",
    });
    // The next push under the new name is version 2 of the same workflow.
    const again = await request("POST", "/api/v1/ana-cooks/dinners/versions", {
      as: { token: ana.token },
      json: { workflow: dinners },
    });
    expect(await again.json()).toMatchObject({ owner: "ana-cooks", number: 2 });
  });

  it("PATCH /api/v1/me changes the caller's own username, with a registry token or a browser session, and answers with the new name", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "dinners");
    const byToken = await patchMe({ token: ana.token }, { username: "ana-cooks" });
    expect([byToken.status, await byToken.json()]).toEqual([
      200,
      { username: "ana-cooks", previous: "ana", url: `${BASE}/ana-cooks` },
    ]);
    const bySession = await patchMe({ cookie: ana.cookie }, { username: " Ana-Bakes " });
    expect([bySession.status, await bySession.json()]).toEqual([
      200,
      { username: "ana-bakes", previous: "ana-cooks", url: `${BASE}/ana-bakes` },
    ]);
    expect(await (await request("GET", "/api/v1/ana-bakes/dinners")).json()).toMatchObject({ owner: "ana-bakes" });
  });

  it("set_username on /mcp changes the signed-in person's own username, with a registry token or an OAuth token", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "dinners");
    const byToken = await call("set_username", { username: "ana-cooks" }, ana.token);
    expect(byToken).toEqual({
      text: renamed("ana", "ana-cooks"),
      data: { username: "ana-cooks", previous: "ana", url: `${BASE}/ana-cooks` },
      isError: false,
    });
    const app = await connect(ana);
    const byOAuth = await call("set_username", { username: "ana-bakes" }, app.accessToken);
    expect(byOAuth.data).toEqual({ username: "ana-bakes", previous: "ana-cooks", url: `${BASE}/ana-bakes` });
    const listed = await call("list", {}, ana.token);
    expect(listed.data.workflows.map((w: { owner: string; slug: string }) => `${w.owner}/${w.slug}`)).toEqual([
      "ana-bakes/dinners",
    ]);
  });

  it("records the rename in the audit log of each organisation the person belongs to, and of no other", async () => {
    const olive = await person("olive");
    const bea = await person("bea");
    const acme = await orgWith("acme", olive);
    const beta = await orgWith("beta", bea, [olive]);
    await orgWith("gamma", bea);
    expect((await patchMe({ token: olive.token }, { username: "olive-new" })).status).toBe(200);

    const row = "<td>olive-new</td><td>renamed</td><td>olive to olive-new</td>";
    expect((await renderPage(OrgSettingsPage, { owner: "acme" }, { as: olive })).html).toContain(row);
    expect((await renderPage(OrgSettingsPage, { owner: "beta" }, { as: bea })).html).toContain(row);
    expect((await renderPage(OrgSettingsPage, { owner: "gamma" }, { as: bea })).html).not.toContain("renamed");
    expect((await renameEvents()).map((e) => e.organisationId).sort()).toEqual([acme.id, beta.id].sort());
  });

  it("saving the username a person already has changes nothing and records nothing", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    const same = await patchMe({ token: olive.token }, { username: "olive" });
    expect(await same.json()).toEqual({ username: "olive", previous: "olive", url: `${BASE}/olive` });
    expect((await saveOnSettings(olive, "olive")).searchParams.get("notice")).toBe("Your username is already olive.");
    expect(await renameEvents()).toEqual([]);
  });
});

describe("Negative boundary", () => {
  it("refuses a taken, reserved or badly formed name with a clear message, on Settings, the API and /mcp, and changes nothing", async () => {
    const ana = await person("ana");
    await person("bea");
    await orgWith("acme", ana);
    const refused: [string, string][] = [
      ["bea", '"bea" is taken.'],
      ["Bea", '"bea" is taken.'],
      ["acme", '"acme" is taken.'],
      ["settings", '"settings" is reserved.'],
      ["mcp", '"mcp" is reserved.'],
      ["ana cooks", RULE],
      ["ana--cooks", RULE],
      ["-ana", RULE],
      ["ana_cooks", RULE],
      ["a".repeat(41), RULE],
      ["", RULE],
    ];
    for (const [name, message] of refused) {
      const api = await patchMe({ token: ana.token }, { username: name });
      expect([api.status, await api.json()], name).toEqual([422, { errors: [message] }]);
      expect((await saveOnSettings(ana, name)).searchParams.get("error"), name).toBe(message);
      const mcp = await call("set_username", { username: name }, ana.token);
      expect([mcp.isError, mcp.text], name).toEqual([true, message]);
    }
    for (const body of [{}, { username: 7 }, { name: "ana-cooks" }]) {
      const res = await patchMe({ token: ana.token }, body);
      expect([res.status, await res.json()]).toEqual([422, { errors: ['Send the new username as "username".'] }]);
    }
    expect(await nameOf(ana.id)).toBe("ana");
    expect(await renameEvents()).toEqual([]);
  });

  it("nobody can change another person's username: each way in acts only as the caller", async () => {
    const olive = await person("olive");
    const mo = await person("mo");
    const naming = { id: olive.id, userId: olive.id, user: "olive" };

    const api = await patchMe({ token: mo.token }, { username: "mo-api", ...naming });
    expect((await api.json()).username).toBe("mo-api");
    const mcp = await call("set_username", { username: "mo-mcp", ...naming }, mo.token);
    expect(mcp.data).toMatchObject({ username: "mo-mcp", previous: "mo-api" });
    await saveOnSettings(mo, "mo-settings", naming);
    expect(await nameOf(mo.id)).toBe("mo-settings");

    // Better Auth's own update-user endpoint cannot set a username either.
    const viaAuth = await route(
      new Request(`${BASE}/api/auth/update-user`, {
        method: "POST",
        headers: { cookie: olive.cookie, origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ username: "olive-hacked" }),
      }),
    );
    expect([viaAuth.status, (await viaAuth.json()).code]).toEqual([400, "FIELD_NOT_ALLOWED"]);

    // Signed out: a 401 from the API, and Settings sends them to sign in.
    const anonymous = await patchMe(undefined, { username: "olive-new" });
    expect([anonymous.status, await anonymous.json()]).toEqual([
      401,
      { errors: ["Sign in, or send a token as Authorization: Bearer <token>."] },
    ]);
    const signedOut = await saveOnSettings(undefined, "olive-new");
    expect(signedOut.pathname + signedOut.search).toBe("/login?next=/settings");

    expect(await nameOf(olive.id)).toBe("olive");
  });

  it("a revoked or made-up token gets 401 from the API and /mcp, and changes nothing", async () => {
    const ana = await person("ana");
    const db = await getDb();
    for (const t of await listTokens(db, ana.id)) await revokeToken(db, ana.id, t.id);
    for (const token of [ana.token, "awml_madeup"]) {
      const res = await patchMe({ token }, { username: "ana-new" });
      expect(res.status, token).toBe(401);
      expect((await res.json()).errors[0]).toMatch(/^The token is not valid: it was revoked, or it is mistyped\./);
      const mcp = await post("tools/call", { name: "set_username", arguments: { username: "ana-new" } }, token);
      expect(mcp.status, token).toBe(401);
    }
    expect(await nameOf(ana.id)).toBe("ana");
  });
});

describe("Cross-tenant boundary", () => {
  it("renaming moves only the person's own pages: another person's and an organisation's stay where they were", async () => {
    const olive = await person("olive");
    const bea = await person("bea");
    const nell = await person("nell");
    await orgWith("acme", olive, [bea]);
    await publish(olive, "olive", "dinners");
    await publish(bea, "bea", "dinners");
    await publish(olive, "acme", "open");
    await publish(olive, "acme", "payroll", "private");

    expect((await patchMe({ token: olive.token }, { username: "olive-new" })).status).toBe(200);

    expect(await (await request("GET", "/api/v1/bea/dinners")).json()).toMatchObject({ owner: "bea" });
    const beaPage = (await renderPage(OwnerPage, { owner: "bea" })).html;
    expect(beaPage).toContain('href="/bea/dinners"');
    expect(beaPage).not.toContain("olive");
    expect(await (await request("GET", "/api/v1/acme/open")).json()).toMatchObject({ owner: "acme" });
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: bea.token } })).status).toBe(200);
    for (const who of [{ token: nell.token }, undefined])
      expect((await request("GET", "/api/v1/acme/payroll", { as: who })).status).toBe(404);
    // Olive is still a member of acme under her new name.
    const pushed = await request("POST", "/api/v1/acme/payroll/versions", { as: { token: olive.token }, json: { workflow: dinners } });
    expect(pushed.status).toBe(201);
    const payroll = await (await request("GET", "/api/v1/acme/payroll", { as: { token: bea.token } })).json();
    expect(payroll.versions.map((v: { pushedBy: string }) => v.pushedBy)).toEqual(["olive-new", "olive-new"]);
  });

  it("an old name taken by an organisation never redirects: its private workflow is the same 404 to the name's former holder and to a stranger", async () => {
    const olive = await person("olive");
    const nell = await person("nell");
    const bea = await person("bea");
    await patchMe({ token: olive.token }, { username: "olive-new" });
    const db = await getDb();
    expect((await createOrganisation(db, bea.id, { slug: "olive", name: "Olive Ltd" })).ok).toBe(true);
    await publish(bea, "olive", "plans", "private");

    for (const who of [olive, nell]) {
      for (const path of ["/api/v1/olive/plans", "/api/v1/olive/plans/v/1", "/olive/plans/v/1/workflow.yaml"])
        expect((await request("GET", path, { as: { token: who.token } })).status, path).toBe(404);
      expect((await renderPage(WorkflowPage, { owner: "olive", slug: "plans" }, { as: who })).status).toBe(404);
      expect((await renderPage(OwnerPage, { owner: "olive" }, { as: who })).html).not.toContain("plans");
    }
    expect((await request("GET", "/api/v1/olive/plans", { as: { token: bea.token } })).status).toBe(200);
  });

  it("a redirect sends everyone to the same address under the new name, where the usual check decides: a private workflow there is still 404 to a stranger", async () => {
    const ana = await person("ana");
    const nell = await person("nell");
    await publish(ana, "ana", "diary");
    // A person's private workflow, which the push rules never make: here only
    // to show that the redirect leaves the check to the page it sends to.
    const db = await getDb();
    await db.update(workflow).set({ visibility: "private" }).where(eq(workflow.slug, "diary"));
    await patchMe({ token: ana.token }, { username: "ana-new" });

    // The redirect is the same whether the workflow is there or not.
    for (const slug of ["diary", "nothing-here"]) {
      const old = await request("GET", `/api/v1/ana/${slug}`, { as: { token: nell.token } });
      expect([old.status, old.headers.get("location")]).toEqual([308, `${BASE}/api/v1/ana-new/${slug}`]);
      expect(await renderPage(WorkflowPage, { owner: "ana", slug }, { as: nell })).toMatchObject({
        status: 308,
        location: `/ana-new/${slug}`,
      });
      expect(await renderPage(WorkflowYamlPage, { owner: "ana", slug }, { as: nell })).toMatchObject({
        status: 308,
        location: `/ana-new/${slug}/yaml`,
      });
      expect(await renderPage(VersionSecurityPage, { owner: "ana", slug, n: "1" }, { as: nell })).toMatchObject({
        status: 308,
        location: `/ana-new/${slug}/v/1/security`,
      });
    }
    for (const who of [{ token: nell.token }, undefined]) {
      expect((await request("GET", "/api/v1/ana-new/diary", { as: who })).status).toBe(404);
      expect((await request("GET", "/ana-new/diary/v/1/workflow.yaml", { as: who })).status).toBe(404);
    }
    expect((await renderPage(WorkflowPage, { owner: "ana-new", slug: "diary" }, { as: nell })).status).toBe(404);
    expect((await renderPage(WorkflowYamlPage, { owner: "ana-new", slug: "diary" }, { as: nell })).status).toBe(404);
    expect((await renderPage(VersionSecurityPage, { owner: "ana-new", slug: "diary", n: "1" }, { as: nell })).status).toBe(404);
    expect((await request("GET", "/api/v1/ana-new/diary", { as: { token: ana.token } })).status).toBe(200);
  });
});

describe("the old address", () => {
  it("redirects for good (308) to the same address under the new name: pages and each of their views, files and the API, keeping the query", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "dinners");
    await addPlatform(ana, "ana", "worker");
    await patchMe({ token: ana.token }, { username: "ana-cooks" });

    expect(await renderPage(OwnerPage, { owner: "ana" })).toMatchObject({ status: 308, location: "/ana-cooks" });
    expect(await renderPage(WorkflowPage, { owner: "ana", slug: "dinners" })).toMatchObject({
      status: 308,
      location: "/ana-cooks/dinners",
    });
    expect(await renderPage(VersionPage, { owner: "ana", slug: "dinners", n: "1" })).toMatchObject({
      status: 308,
      location: "/ana-cooks/dinners/v/1",
    });
    // Each view's own address, even one the workflow has no file for: the
    // address it sends to makes that check.
    const views: Record<string, [Page<{ owner: string; slug: string }>, Page<{ owner: string; slug: string; n: string }>]> = {
      security: [WorkflowSecurityPage, VersionSecurityPage],
      platform: [WorkflowPlatformPage, VersionPlatformPage],
      yaml: [WorkflowYamlPage, VersionYamlPage],
      checks: [WorkflowChecksPage, VersionChecksPage],
    };
    for (const [view, [latest, older]] of Object.entries(views)) {
      expect(await renderPage(latest, { owner: "ana", slug: "dinners" })).toMatchObject({
        status: 308,
        location: `/ana-cooks/dinners/${view}`,
      });
      expect(await renderPage(older, { owner: "ana", slug: "dinners", n: "1" })).toMatchObject({
        status: 308,
        location: `/ana-cooks/dinners/v/1/${view}`,
      });
    }
    // Each implementation's address, kept as it is.
    expect(await renderPage(ImplementationPage, { owner: "ana", slug: "dinners", implementation: "home" })).toMatchObject({
      status: 308,
      location: "/ana-cooks/dinners/platform/home",
    });
    expect(
      await renderPage(VersionImplementationPage, { owner: "ana", slug: "dinners", n: "1", implementation: "home" }),
    ).toMatchObject({ status: 308, location: "/ana-cooks/dinners/v/1/platform/home" });
    // An old ?view= address goes to its view's own address first, then on from there.
    expect(await renderPage(WorkflowPage, { owner: "ana", slug: "dinners" }, { search: { view: "platform" } })).toMatchObject({
      status: 308,
      location: "/ana/dinners/platform",
    });
    expect(await renderPage(InventoryPage, { owner: "ana" })).toMatchObject({ status: 308, location: "/ana-cooks/inventory" });
    expect(await renderPage(OrgSettingsPage, { owner: "ana" })).toMatchObject({ status: 308, location: "/ana-cooks/settings" });
    for (const path of [
      "/ana/dinners/v/1/security.yaml",
      "/api/v1/ana/dinners",
      "/api/v1/ana/dinners/v/1?view=security",
      "/api/v1/platforms/ana/worker",
      "/api/v1/platforms/ana/worker/v/1",
      "/platforms/ana/worker/v/1/description.yaml",
    ]) {
      const res = await request("GET", path);
      expect([res.status, res.headers.get("location")], path).toEqual([308, BASE + path.replace("/ana/", "/ana-cooks/")]);
    }
    // A push to the old name keeps its method through a 308, so it lands under the new name.
    for (const path of ["/api/v1/ana/dinners/versions", "/api/v1/platforms/ana/worker/versions"]) {
      const res = await request("POST", path, { as: { token: ana.token }, json: { workflow: dinners } });
      expect([res.status, res.headers.get("location")], path).toEqual([308, BASE + path.replace("/ana/", "/ana-cooks/")]);
    }
  });

  it("after two renames both old names lead to the current one, and a person who takes back an old name has their page there again", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "dinners");
    await patchMe({ token: ana.token }, { username: "ana-cooks" });
    await patchMe({ token: ana.token }, { username: "ana-bakes" });
    for (const old of ["ana", "ana-cooks"])
      expect((await request("GET", `/api/v1/${old}/dinners`)).headers.get("location")).toBe(`${BASE}/api/v1/ana-bakes/dinners`);

    await patchMe({ token: ana.token }, { username: "ana" });
    expect((await request("GET", "/api/v1/ana/dinners")).status).toBe(200);
    for (const old of ["ana-cooks", "ana-bakes"])
      expect((await request("GET", `/api/v1/${old}/dinners`)).headers.get("location")).toBe(`${BASE}/api/v1/ana/dinners`);
  });

  it("stops redirecting once someone else takes the old name, a person or an organisation, and their page wins", async () => {
    const ana = await person("ana");
    const bea = await person("bea");
    await publish(ana, "ana", "dinners");
    await patchMe({ token: ana.token }, { username: "ana-cooks" });
    expect((await request("GET", "/api/v1/ana/dinners")).status).toBe(308);

    // Bea takes "ana": the address is hers now, and Ana's workflow is not there.
    expect((await patchMe({ token: bea.token }, { username: "ana" })).status).toBe(200);
    expect((await request("GET", "/api/v1/ana/dinners")).status).toBe(404);
    const beaPage = await renderPage(OwnerPage, { owner: "ana" });
    expect(beaPage.status).toBe(200);
    expect(beaPage.html).not.toContain("dinners");
    // When Bea moves on, "ana" leads to Bea, the last person to give it up.
    await patchMe({ token: bea.token }, { username: "bea" });
    expect((await request("GET", "/api/v1/ana/x")).headers.get("location")).toBe(`${BASE}/api/v1/bea/x`);

    // Someone signing up takes a free old name the same way.
    expect((await signIn("ana@elsewhere.com")).user.username).toBe("ana");
    expect((await request("GET", "/api/v1/ana/x")).status).toBe(404);

    // And so does an organisation.
    await patchMe({ token: ana.token }, { username: "ana-bakes" });
    expect((await request("GET", "/api/v1/ana-cooks/dinners")).status).toBe(308);
    expect((await createOrganisation(await getDb(), bea.id, { slug: "ana-cooks", name: "Cooks" })).ok).toBe(true);
    expect((await request("GET", "/api/v1/ana-cooks/dinners")).status).toBe(404);
    expect(await renderPage(OwnerPage, { owner: "ana-cooks" })).toMatchObject({ status: 200 });
  });
});

// The tools on /mcp follow an old name as the API does: a tool that takes an
// owner, a workflow (owner/slug) or a platform reaches the person's current
// name, and answers with the address there. Where the name leads, the usual
// access check decides, as on the website.
describe("old names on /mcp", () => {
  // A person's private workflow and platform, which the push rules never
  // make: here only to show that following an old name leaves the check to
  // the current name.
  async function makePrivate(slug: string) {
    const db = await getDb();
    await db.update(workflow).set({ visibility: "private" }).where(eq(workflow.slug, slug));
    await db.update(platform).set({ visibility: "private" }).where(eq(platform.slug, slug));
  }

  it("every tool that takes an owner follows an old name to the current one, and answers with the current address", async () => {
    const ana = await person("ana");
    const nell = await person("nell");
    await publish(ana, "ana", "dinners");
    await addPlatform(ana, "ana", "worker");
    await patchMe({ token: ana.token }, { username: "ana-cooks" });

    for (const who of [ana, nell]) {
      const got = await call("get", { owner: "ana", slug: "dinners" }, who.token);
      expect(got.data).toMatchObject({ owner: "ana-cooks", slug: "dinners", url: `${BASE}/ana-cooks/dinners` });
      expect(got.text).toContain(`ana-cooks/dinners, version 1 of 1, public. ${BASE}/ana-cooks/dinners`);
      expect((await call("get", { owner: "ana", slug: "dinners", version: 1 }, who.token)).data).toMatchObject({
        owner: "ana-cooks",
        url: `${BASE}/ana-cooks/dinners/v/1`,
      });
      const listed = await call("list", { owner: "ana" }, who.token);
      expect(listed.data.workflows.map((w: { owner: string; url: string }) => [w.owner, w.url])).toEqual([
        ["ana-cooks", `${BASE}/ana-cooks/dinners`],
      ]);
      const platformRead = await call("get_platform", { owner: "ana", slug: "worker" }, who.token);
      expect(platformRead.data).toMatchObject({
        owner: "ana-cooks",
        slug: "worker",
        url: `${BASE}/api/v1/platforms/ana-cooks/worker`,
      });
      expect(platformRead.text).toContain("platform ana-cooks/worker, version 1 of 1");
      const fitted = await call("fit_workflow", { workflow: "ana/dinners", platforms: ["ana/worker@1"] }, who.token);
      expect(fitted.data.workflow).toEqual({ owner: "ana-cooks", slug: "dinners", number: 1 });
      expect(fitted).toEqual(
        await call("fit_workflow", { workflow: "ana-cooks/dinners", platforms: ["ana-cooks/worker@1"] }, who.token),
      );
      expect(await call("fit_workflow", { workflow: "ana/dinners@1" }, who.token)).toEqual(
        await call("fit_workflow", { workflow: "ana-cooks/dinners@1" }, who.token),
      );
    }

    // Writes to the old name go to the current owner.
    const published = await call("publish", { owner: "ana", slug: "dinners", workflow: dinners }, ana.token);
    expect(published.data).toEqual({ owner: "ana-cooks", slug: "dinners", number: 2, url: `${BASE}/ana-cooks/dinners` });
    const added = await call("add_platform", { owner: "ana", slug: "worker", description: worker }, ana.token);
    expect(added.data).toEqual({
      owner: "ana-cooks",
      slug: "worker",
      number: 2,
      url: `${BASE}/api/v1/platforms/ana-cooks/worker/v/2`,
    });
    // Someone else's write to the old name is refused as at the current name.
    for (const [tool, args] of [
      ["publish", { slug: "dinners", workflow: dinners }],
      ["add_platform", { slug: "worker", description: worker }],
    ] as const) {
      const old = await call(tool, { owner: "ana", ...args }, nell.token);
      expect(old.isError, tool).toBe(true);
      expect(old, tool).toEqual(await call(tool, { owner: "ana-cooks", ...args }, nell.token));
    }

    // After a second rename, both old names lead to the current one.
    await patchMe({ token: ana.token }, { username: "ana-bakes" });
    for (const old of ["ana", "ana-cooks"])
      expect((await call("get", { owner: old, slug: "dinners" }, nell.token)).data.owner, old).toBe("ana-bakes");
  });

  it("an old name someone else has taken belongs to them: the tools reach their workflows, not the person who gave it up", async () => {
    const ana = await person("ana");
    const bea = await person("bea");
    await publish(ana, "ana", "dinners");
    await patchMe({ token: ana.token }, { username: "ana-cooks" });
    expect((await patchMe({ token: bea.token }, { username: "ana" })).status).toBe(200);

    expect((await call("get", { owner: "ana", slug: "dinners" }, ana.token)).text).toBe("Not found.");
    expect((await call("list", { owner: "ana" }, ana.token)).data.workflows).toEqual([]);
    expect((await call("fit_workflow", { workflow: "ana/dinners" }, ana.token)).text).toBe("Not found: ana/dinners.");
    const intoBeas = await call("publish", { owner: "ana", slug: "dinners", workflow: dinners }, ana.token);
    expect(intoBeas.isError).toBe(true);
    const beas = await call("publish", { owner: "ana", slug: "dinners", workflow: dinners }, bea.token);
    expect(beas.data).toMatchObject({ owner: "ana", number: 1 });
    expect((await call("get", { owner: "ana-cooks", slug: "dinners" }, ana.token)).data.versions).toEqual([1]);
  });

  it("Positive boundary: the person reads and fits their own private workflow and platform through their old name", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "diary");
    await addPlatform(ana, "ana", "diary");
    await makePrivate("diary");
    await patchMe({ token: ana.token }, { username: "ana-new" });

    expect((await call("get", { owner: "ana", slug: "diary" }, ana.token)).data).toMatchObject({
      owner: "ana-new",
      visibility: "private",
    });
    expect((await call("list", { owner: "ana" }, ana.token)).data.workflows.map((w: { slug: string }) => w.slug)).toEqual([
      "diary",
    ]);
    expect((await call("get_platform", { owner: "ana", slug: "diary" }, ana.token)).data).toMatchObject({
      owner: "ana-new",
      visibility: "private",
    });
    const fitted = await call("fit_workflow", { workflow: "ana/diary", platforms: ["ana/diary"] }, ana.token);
    expect(fitted.isError).toBe(false);
    expect(fitted.data.workflow).toEqual({ owner: "ana-new", slug: "diary", number: 1 });
  });

  it("Negative boundary: a stranger gets the same not found through an old name as for a missing workflow or platform", async () => {
    const ana = await person("ana");
    const nell = await person("nell");
    await publish(ana, "ana", "diary");
    await addPlatform(ana, "ana", "diary");
    await makePrivate("diary");
    await patchMe({ token: ana.token }, { username: "ana-new" });

    for (const owner of ["ana", "ana-new"]) {
      const hidden = await call("get", { owner, slug: "diary" }, nell.token);
      const missing = await call("get", { owner, slug: "nothing-here" }, nell.token);
      expect([hidden.isError, hidden.text], owner).toEqual([missing.isError, missing.text]);
      expect(hidden.text).toBe("Not found.");
      expect((await call("get", { owner, slug: "diary", version: 1 }, nell.token)).text).toBe("Not found.");
      expect((await call("list", { owner }, nell.token)).data.workflows).toEqual([]);
      const platformHidden = await call("get_platform", { owner, slug: "diary" }, nell.token);
      const platformMissing = await call("get_platform", { owner, slug: "nothing-here" }, nell.token);
      expect([platformHidden.isError, platformHidden.text]).toEqual([platformMissing.isError, platformMissing.text]);
      expect((await call("fit_workflow", { workflow: `${owner}/diary` }, nell.token)).text).toBe("Not found: ana-new/diary.");
      expect((await call("fit_workflow", { workflow: `${owner}/nothing-here` }, nell.token)).text).toBe(
        "Not found: ana-new/nothing-here.",
      );
      const named = await call("fit_workflow", { file: dinners, platforms: [`${owner}/diary`] }, nell.token);
      expect([named.isError, named.text]).toEqual([true, "Not found: ana-new/diary."]);
      const all = await call("fit_workflow", { file: dinners }, nell.token);
      expect(JSON.stringify(all)).not.toContain("diary");
      for (const [tool, args] of [
        ["publish", { slug: "diary", workflow: dinners }],
        ["add_platform", { slug: "diary", description: worker }],
      ] as const)
        expect((await call(tool, { owner, ...args }, nell.token)).isError, `${tool} ${owner}`).toBe(true);
    }
    expect((await call("get", { owner: "ana-new", slug: "diary" }, ana.token)).data.versions).toEqual([1]);
    expect((await call("get_platform", { owner: "ana-new", slug: "diary" }, ana.token)).data.versions).toEqual([1]);
  });

  it("Cross-tenant boundary: an old name an organisation took leads to it, and its private workflows and platforms are not found to the name's former holder", async () => {
    const olive = await person("olive");
    const mo = await person("mo");
    const bea = await person("bea");
    await orgWith("acme", olive, [mo]);
    await publish(olive, "olive", "dinners");
    await patchMe({ token: olive.token }, { username: "olive-new" });
    const db = await getDb();
    expect((await createOrganisation(db, bea.id, { slug: "olive", name: "Olive Ltd" })).ok).toBe(true);
    expect(
      (await call("publish", { owner: "olive", slug: "plans", workflow: dinners, visibility: "private" }, bea.token)).isError,
    ).toBe(false);
    expect(
      (await call("add_platform", { owner: "olive", slug: "vault", description: worker, visibility: "private" }, bea.token))
        .isError,
    ).toBe(false);

    const { accessToken: oauth } = await connect(olive);
    for (const bearer of [olive.token, oauth, mo.token]) {
      expect((await call("get", { owner: "olive", slug: "plans" }, bearer)).text).toBe("Not found.");
      expect((await call("get", { owner: "olive", slug: "dinners" }, bearer)).text).toBe("Not found.");
      expect((await call("list", { owner: "olive" }, bearer)).data.workflows).toEqual([]);
      expect((await call("get_platform", { owner: "olive", slug: "vault" }, bearer)).text).toBe("Not found.");
      expect((await call("fit_workflow", { workflow: "olive/plans" }, bearer)).text).toBe("Not found: olive/plans.");
      const named = await call("fit_workflow", { file: dinners, platforms: ["olive/vault"] }, bearer);
      expect([named.isError, named.text]).toEqual([true, "Not found: olive/vault."]);
      expect((await call("publish", { owner: "olive", slug: "plans", workflow: dinners }, bearer)).text).toBe("Not found.");
      expect((await call("add_platform", { owner: "olive", slug: "vault", description: worker }, bearer)).text).toBe(
        "Not found.",
      );
    }
    // Olive's own workflow is under her current name, as ever.
    expect((await call("get", { owner: "olive-new", slug: "dinners" }, olive.token)).data.versions).toEqual([1]);
    expect((await call("get", { owner: "olive", slug: "plans" }, bea.token)).data.versions).toEqual([1]);
    expect((await call("get_platform", { owner: "olive", slug: "vault" }, bea.token)).data.versions).toEqual([1]);
  });

  it("Roles boundary: the owner and a member of an organisation that took an old name both read and push its private workflows there; the name's former holder cannot", async () => {
    const olive = await person("olive");
    const bea = await person("bea");
    const mo = await person("mo");
    await patchMe({ token: olive.token }, { username: "olive-new" });
    await orgWith("olive", bea, [mo]);
    expect(
      (await call("publish", { owner: "olive", slug: "plans", workflow: dinners, visibility: "private" }, bea.token)).isError,
    ).toBe(false);

    for (const [who, number] of [
      [bea, 2],
      [mo, 3],
    ] as const) {
      expect((await call("get", { owner: "olive", slug: "plans" }, who.token)).data.owner).toBe("olive");
      expect((await call("publish", { owner: "olive", slug: "plans", workflow: dinners }, who.token)).data.number).toBe(number);
    }
    expect((await call("get", { owner: "olive", slug: "plans" }, olive.token)).text).toBe("Not found.");
  });

  it("Invalid token: a revoked or made-up token gets the same 401 for an old name, a current name and a missing one", async () => {
    const ana = await person("ana");
    await publish(ana, "ana", "dinners");
    await addPlatform(ana, "ana", "worker");
    await patchMe({ token: ana.token }, { username: "ana-new" });
    const db = await getDb();
    for (const t of await listTokens(db, ana.id)) await revokeToken(db, ana.id, t.id);

    for (const token of [ana.token, "awml_madeup"]) {
      const answers = new Set<string>();
      for (const owner of ["ana", "ana-new", "nobody-here"])
        for (const [name, args] of [
          ["get", { owner, slug: "dinners" }],
          ["list", { owner }],
          ["get_platform", { owner, slug: "worker" }],
          ["fit_workflow", { workflow: `${owner}/dinners`, platforms: [`${owner}/worker`] }],
          ["publish", { owner, slug: "dinners", workflow: dinners }],
          ["add_platform", { owner, slug: "worker", description: worker }],
        ] as const) {
          const res = await post("tools/call", { name, arguments: args }, token);
          answers.add(JSON.stringify([res.status, res.headers.get("www-authenticate"), await res.text()]));
        }
      expect(answers.size, token).toBe(1);
      expect(JSON.parse([...answers][0])[0]).toBe(401);
    }
    expect((await request("GET", "/api/v1/ana-new/dinners")).status).toBe(200);
  });
});
