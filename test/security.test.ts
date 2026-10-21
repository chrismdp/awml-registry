import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { auditEvent, token } from "@/db/schema";
import { edition } from "@/edition";
import { hashSecret, revokeToken, listTokens } from "@/server/tokens";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import OwnerPage from "@/app/[owner]/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import OrgSettingsPage from "@/app/[owner]/settings/page";
import ExplorePage from "@/app/explore/page";
import { example, orgWith, person, request, type Who } from "./helpers";
import { renderPage } from "./pages";

const security = example("dinners-security.yaml");

async function push(org: string, slug: string, as: Who, visibility?: "public" | "private") {
  return request("POST", `/api/v1/${org}/${slug}/versions`, {
    as,
    json: { security, ...(visibility ? { visibility } : {}) },
  });
}

// Org "acme" with owner Olive and member Mo, holding one private workflow; and
// Nell, who belongs to nothing.
async function acme() {
  const olive = await person("olive");
  const mo = await person("mo");
  const nell = await person("nell");
  await orgWith("acme", olive, [mo]);
  const pushed = await push("acme", "payroll", { token: olive.token }, "private");
  expect(pushed.status).toBe(201);
  return { olive, mo, nell };
}

async function everyRead(who: Who) {
  return {
    page: (await renderPage(WorkflowPage, { owner: "acme", slug: "payroll" }, { as: who })).status,
    versionPage: (await renderPage(VersionPage, { owner: "acme", slug: "payroll", n: "1" }, { as: who }))
      .status,
    yaml: (await request("GET", "/acme/payroll/v/1/security.yaml", { as: who })).status,
    api: (await request("GET", "/api/v1/acme/payroll", { as: who })).status,
    versionApi: (await request("GET", "/api/v1/acme/payroll/v/1", { as: who })).status,
  };
}

const all = (status: number) => ({ page: status, versionPage: status, yaml: status, api: status, versionApi: status });

describe("Positive boundary", () => {
  it("a member can read and push a private workflow", async () => {
    const { mo } = await acme();
    expect(await everyRead({ cookie: mo.cookie })).toEqual(all(200));
    expect(await everyRead({ token: mo.token })).toMatchObject({ yaml: 200, api: 200, versionApi: 200 });
    const res = await push("acme", "payroll", { token: mo.token });
    expect(res.status).toBe(201);
    expect((await res.json()).number).toBe(2);
  });

  it("a member sees the private workflow on the organisation's page; others do not", async () => {
    const { mo, nell } = await acme();
    const asMo = await renderPage(OwnerPage, { owner: "acme" }, { as: { cookie: mo.cookie } });
    expect(asMo.html).toContain("payroll");
    const asNell = await renderPage(OwnerPage, { owner: "acme" }, { as: { cookie: nell.cookie } });
    expect(asNell.status).toBe(200);
    expect(asNell.html).not.toContain("payroll");
  });
});

describe("Negative boundary", () => {
  it("a non-member gets 404 on a private workflow's page, version page, YAML file and API", async () => {
    const { nell } = await acme();
    expect(await everyRead({ cookie: nell.cookie })).toEqual(all(404));
    expect(await everyRead({ token: nell.token })).toMatchObject({ yaml: 404, api: 404, versionApi: 404 });
  });

  it("a signed-out visitor gets 404 on a private workflow's page, version page, YAML file and API", async () => {
    await acme();
    expect(await everyRead(undefined)).toEqual(all(404));
  });

  it("a private workflow answers exactly as a missing one does", async () => {
    await acme();
    const missing = await request("GET", "/api/v1/acme/nothing-here");
    const hidden = await request("GET", "/api/v1/acme/payroll");
    expect([hidden.status, await hidden.text()]).toEqual([missing.status, await missing.text()]);
  });

  it("a private workflow never appears in the public gallery or its search", async () => {
    await acme();
    for (const search of [{}, { q: "dinners" }] as Record<string, string>[]) {
      const page = await renderPage(ExplorePage, {}, { search });
      expect(page.html).not.toContain("payroll");
    }
  });

  it("a non-member and a signed-out visitor get 404 on the organisation's inventory", async () => {
    const { nell } = await acme();
    expect((await renderPage(InventoryPage, { owner: "acme" }, { as: { cookie: nell.cookie } })).status).toBe(404);
    expect((await renderPage(InventoryPage, { owner: "acme" })).status).toBe(404);
  });
});

describe("Cross-tenant boundary", () => {
  async function twoOrgs() {
    const { olive, mo, nell } = await acme();
    const bea = await person("bea");
    await orgWith("beta", bea);
    await push("beta", "secret-plans", { token: bea.token }, "private");
    await push("beta", "open-plans", { token: bea.token }, "public");
    return { olive, mo, nell, bea };
  }

  it("a token from a member of one organisation cannot read another organisation's private workflows", async () => {
    const { mo } = await twoOrgs();
    expect((await request("GET", "/api/v1/beta/secret-plans", { as: { token: mo.token } })).status).toBe(404);
    expect((await request("GET", "/api/v1/beta/secret-plans/v/1", { as: { token: mo.token } })).status).toBe(404);
    expect(
      (await request("GET", "/beta/secret-plans/v/1/security.yaml", { as: { token: mo.token } })).status,
    ).toBe(404);
  });

  it("a token from a member of one organisation cannot push to another organisation's private workflows", async () => {
    const { mo } = await twoOrgs();
    expect((await push("beta", "secret-plans", { token: mo.token })).status).toBe(404);
  });

  it("a token from a member of one organisation cannot push to another organisation's public workflows", async () => {
    const { mo } = await twoOrgs();
    expect((await push("beta", "open-plans", { token: mo.token })).status).toBe(403);
    expect((await push("beta", "brand-new", { token: mo.token })).status).toBe(403);
    const versions = (await (await request("GET", "/api/v1/beta/open-plans")).json()).versions;
    expect(versions).toHaveLength(1);
  });

  it("an owner of one organisation cannot manage another's members or read its audit log", async () => {
    const { olive, nell } = await twoOrgs();
    const add = await request("POST", "/api/orgs/beta/members", {
      as: { cookie: olive.cookie },
      form: { identifier: nell.username },
    });
    expect(add.status).toBe(404);
    expect(
      (await renderPage(OrgSettingsPage, { owner: "beta" }, { as: { cookie: olive.cookie } })).status,
    ).toBe(404);
  });
});

describe("Roles boundary", () => {
  it("an owner can add and remove members", async () => {
    const { olive, nell } = await acme();
    const add = await request("POST", "/api/orgs/acme/members", {
      as: { cookie: olive.cookie },
      form: { identifier: "nell@example.com" },
    });
    expect(add.status).toBe(303);
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: nell.token } })).status).toBe(200);
    const remove = await request("POST", `/api/orgs/acme/members/${nell.id}/remove`, {
      as: { cookie: olive.cookie },
    });
    expect(remove.status).toBe(303);
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: nell.token } })).status).toBe(404);
  });

  it("an owner can read the audit log of pushes, private views and who joined or left", async () => {
    const { olive, mo } = await acme();
    await request("GET", "/api/v1/acme/payroll", { as: { token: mo.token } });
    await request("POST", `/api/orgs/acme/members/${mo.id}/remove`, { as: { cookie: olive.cookie } });
    const page = await renderPage(OrgSettingsPage, { owner: "acme" }, { as: { cookie: olive.cookie } });
    expect(page.status).toBe(200);
    for (const action of ["push", "private view", "joined", "left"]) expect(page.html).toContain(action);
  });

  it("a member cannot manage members: 403", async () => {
    const { mo, nell, olive } = await acme();
    const add = await request("POST", "/api/orgs/acme/members", {
      as: { cookie: mo.cookie },
      form: { identifier: nell.username },
    });
    expect(add.status).toBe(403);
    const remove = await request("POST", `/api/orgs/acme/members/${olive.id}/remove`, {
      as: { cookie: mo.cookie },
    });
    expect(remove.status).toBe(403);
  });

  it("a member cannot read the audit log: 403", async () => {
    const { mo } = await acme();
    expect((await renderPage(OrgSettingsPage, { owner: "acme" }, { as: { cookie: mo.cookie } })).status).toBe(403);
  });

  it("a member can leave", async () => {
    const { mo } = await acme();
    const leave = await request("POST", `/api/orgs/acme/members/${mo.id}/remove`, { as: { cookie: mo.cookie } });
    expect(leave.status).toBe(303);
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: mo.token } })).status).toBe(404);
  });

  it("the last owner cannot be removed", async () => {
    const { olive } = await acme();
    const res = await request("POST", `/api/orgs/acme/members/${olive.id}/remove`, {
      as: { cookie: olive.cookie },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("error=");
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: olive.token } })).status).toBe(200);
  });

  it("nobody can change or remove an audit event", async () => {
    await acme();
    const db = await getDb();
    await expect(db.update(auditEvent).set({ target: "x" })).rejects.toThrow(/cannot be changed/);
    await expect(db.delete(auditEvent)).rejects.toThrow(/cannot be removed/);
  });
});

describe("Tokens", () => {
  it("a revoked token is refused", async () => {
    const { mo } = await acme();
    const db = await getDb();
    const [t] = await listTokens(db, mo.id);
    await revokeToken(db, mo.id, t.id);
    expect((await push("acme", "payroll", { token: mo.token })).status).toBe(401);
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: mo.token } })).status).toBe(404);
  });

  it("a token's secret is never stored in plain text", async () => {
    const mo = await person("mo");
    const db = await getDb();
    const rows = await db.select().from(token);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(mo.token);
    expect(rows[0].hash).toBe(await hashSecret(mo.token));
  });

  it("a made-up token is refused", async () => {
    const { mo } = await acme();
    const res = await push("acme", "payroll", { token: mo.token.slice(0, -2) + "xx" });
    expect(res.status).toBe(401);
  });
});

describe("The edition hook", () => {
  const original = { ...edition };
  afterEach(() => Object.assign(edition, original));

  it("refuses a private push when canKeepPrivate says no", async () => {
    const { olive } = await acme();
    edition.canKeepPrivate = async () => false;
    expect((await push("acme", "payroll", { token: olive.token })).status).toBe(403);
    expect((await push("acme", "another", { token: olive.token }, "private")).status).toBe(403);
    expect((await push("acme", "open", { token: olive.token }, "public")).status).toBe(201);
  });

  it("refuses pushes when canPush says no, and reads still work", async () => {
    const { olive, mo } = await acme();
    edition.canPush = async () => false;
    expect((await push("acme", "payroll", { token: olive.token })).status).toBe(403);
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: mo.token } })).status).toBe(200);
    expect(
      (await renderPage(WorkflowPage, { owner: "acme", slug: "payroll" }, { as: { cookie: mo.cookie } })).status,
    ).toBe(200);
  });
});
