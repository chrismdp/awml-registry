import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { auditEvent, token } from "@/db/schema";
import { edition } from "@/edition";
import { hashSecret, revokeToken, listTokens } from "@/server/tokens";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import WorkflowSecurityPage from "@/app/[owner]/[slug]/security/page";
import WorkflowPlatformPage from "@/app/[owner]/[slug]/platform/page";
import WorkflowYamlPage from "@/app/[owner]/[slug]/yaml/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import VersionSecurityPage from "@/app/[owner]/[slug]/v/[n]/security/page";
import VersionPlatformPage from "@/app/[owner]/[slug]/v/[n]/platform/page";
import VersionYamlPage from "@/app/[owner]/[slug]/v/[n]/yaml/page";
import WorkflowChecksPage from "@/app/[owner]/[slug]/checks/page";
import VersionChecksPage from "@/app/[owner]/[slug]/v/[n]/checks/page";
import OwnerPage from "@/app/[owner]/page";
import InventoryPage from "@/app/[owner]/inventory/page";
import OrgSettingsPage from "@/app/[owner]/settings/page";
import GalleryPage from "@/app/gallery/page";
import { example, orgWith, person, request, withEdition, type Who } from "./helpers";
import { renderPage, type Page } from "./pages";

const workflow = example("dinners.yaml");

// Pushes both files, so every view of the workflow has something to show.
async function push(org: string, slug: string, as: Who, visibility?: "public" | "private") {
  return request("POST", `/api/v1/${org}/${slug}/versions`, {
    as,
    json: { workflow, ...(visibility ? { visibility } : {}) },
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

// A workflow's pages: the latest version and version 1, each at its own
// address and at each view's.
const latestPages: Record<string, Page<{ owner: string; slug: string }>> = {
  page: WorkflowPage,
  securityView: WorkflowSecurityPage,
  platformView: WorkflowPlatformPage,
  yamlView: WorkflowYamlPage,
  checksView: WorkflowChecksPage,
};
const versionPages: Record<string, Page<{ owner: string; slug: string; n: string }>> = {
  versionPage: VersionPage,
  versionSecurityView: VersionSecurityPage,
  versionPlatformView: VersionPlatformPage,
  versionYamlView: VersionYamlPage,
  versionChecksView: VersionChecksPage,
};

async function everyRead(who: Who, owner = "acme", slug = "payroll") {
  const reads: Record<string, number> = {};
  for (const [name, page] of Object.entries(latestPages))
    reads[name] = (await renderPage(page, { owner, slug }, { as: who })).status;
  for (const [name, page] of Object.entries(versionPages))
    reads[name] = (await renderPage(page, { owner, slug, n: "1" }, { as: who })).status;
  reads.yaml = (await request("GET", `/${owner}/${slug}/v/1/workflow.yaml`, { as: who })).status;
  reads.api = (await request("GET", `/api/v1/${owner}/${slug}`, { as: who })).status;
  reads.versionApi = (await request("GET", `/api/v1/${owner}/${slug}/v/1`, { as: who })).status;
  return reads;
}

const all = (status: number) =>
  Object.fromEntries(
    [...Object.keys(latestPages), ...Object.keys(versionPages), "yaml", "api", "versionApi"].map((read) => [read, status]),
  );

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
  it("a non-member gets 404 on a private workflow's page, each of its views, version page, YAML file and API", async () => {
    const { nell } = await acme();
    expect(await everyRead({ cookie: nell.cookie })).toEqual(all(404));
    expect(await everyRead({ token: nell.token })).toMatchObject({ yaml: 404, api: 404, versionApi: 404 });
  });

  it("a signed-out visitor gets 404 on a private workflow's page, each of its views, version page, YAML file and API", async () => {
    await acme();
    expect(await everyRead(undefined)).toEqual(all(404));
  });

  it("an old ?view= address of a private workflow sends a non-member on exactly as a missing workflow's does, to a 404", async () => {
    const { nell } = await acme();
    for (const who of [{ cookie: nell.cookie }, undefined]) {
      for (const view of ["security", "platform", "yaml"]) {
        for (const slug of ["payroll", "nothing-here"]) {
          const search = { view };
          expect(await renderPage(WorkflowPage, { owner: "acme", slug }, { as: who, search })).toEqual({
            status: 308,
            html: "",
            location: `/acme/${slug}/${view}`,
          });
          expect(await renderPage(VersionPage, { owner: "acme", slug, n: "1" }, { as: who, search })).toEqual({
            status: 308,
            html: "",
            location: `/acme/${slug}/v/1/${view}`,
          });
        }
      }
    }
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
      const page = await renderPage(GalleryPage, {}, { search });
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

  it("a member of one organisation gets 404 on another organisation's private workflow's pages and each of their views, which its own members see", async () => {
    const { mo, bea } = await twoOrgs();
    expect(await everyRead({ cookie: mo.cookie }, "beta", "secret-plans")).toEqual(all(404));
    expect(await everyRead({ cookie: bea.cookie }, "beta", "secret-plans")).toEqual(all(200));
  });

  it("a token from a member of one organisation cannot read another organisation's private workflows", async () => {
    const { mo } = await twoOrgs();
    expect((await request("GET", "/api/v1/beta/secret-plans", { as: { token: mo.token } })).status).toBe(404);
    expect((await request("GET", "/api/v1/beta/secret-plans/v/1", { as: { token: mo.token } })).status).toBe(404);
    expect(
      (await request("GET", "/beta/secret-plans/v/1/workflow.yaml", { as: { token: mo.token } })).status,
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

  it("the audit log says whoever made the organisation joined it", async () => {
    const olive = await person("olive");
    await orgWith("acme", olive);
    const page = await renderPage(OrgSettingsPage, { owner: "acme" }, { as: { cookie: olive.cookie } });
    expect(page.html).toContain("<td>olive</td><td>joined</td><td>acme</td>");
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
    await revoke(mo);
    expect((await push("acme", "payroll", { token: mo.token })).status).toBe(401);
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: mo.token } })).status).toBe(401);
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

async function revoke(who: { id: string }) {
  const db = await getDb();
  for (const t of await listTokens(db, who.id)) await revokeToken(db, who.id, t.id);
}

// Every way to read a workflow that takes a token, as status and body.
async function tokenReads(owner: string, slug: string, token: string) {
  const as = { token };
  const read = async (path: string) => {
    const res = await request("GET", path, { as });
    return { status: res.status, body: await res.text() };
  };
  return {
    api: await read(`/api/v1/${owner}/${slug}`),
    versionApi: await read(`/api/v1/${owner}/${slug}/v/1`),
    yaml: await read(`/${owner}/${slug}/v/1/workflow.yaml`),
  };
}

// A CLI whose token was revoked, or mistyped, sends it on every request. It
// gets a 401 telling it to log in again, never an answer as nobody, which
// would make a private workflow look missing and hide the real problem.
describe("A token that is not valid", () => {
  it("positive: a valid token still reads its own organisation's private workflow", async () => {
    const { mo } = await acme();
    const reads = await tokenReads("acme", "payroll", mo.token);
    expect([reads.api.status, reads.versionApi.status, reads.yaml.status]).toEqual([200, 200, 200]);
    expect(reads.yaml.body).toBe(workflow);
  });

  it("negative: a revoked token gets 401 on every read and on a push, saying to log in again", async () => {
    const { mo } = await acme();
    await revoke(mo);
    const reads = await tokenReads("acme", "payroll", mo.token);
    const pushed = await push("acme", "payroll", { token: mo.token });
    const answers = [reads.api, reads.versionApi, reads.yaml, { status: pushed.status, body: await pushed.text() }];
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.body).toMatch(/token is not valid/);
      expect(answer.body).toMatch(/log in again/i);
    }
  });

  it("negative: a revoked token gets 401 from the organisation routes too, and changes nothing", async () => {
    const { olive, nell } = await acme();
    await revoke(olive);
    const as = { token: olive.token };
    const answers = [
      await request("POST", "/api/orgs", { as, form: { slug: "olive-co", name: "Olive Co" } }),
      await request("POST", "/api/orgs/acme/members", { as, form: { identifier: nell.username } }),
      await request("POST", `/api/orgs/acme/members/${olive.id}/remove`, { as }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(await res.text()).toMatch(/token is not valid/);
    }
    expect((await request("GET", "/api/v1/acme/payroll", { as: { token: nell.token } })).status).toBe(404);
  });

  it("negative: a made-up token gets the same 401 for a private, a public and a missing workflow, so it learns nothing", async () => {
    const { olive } = await acme();
    await push("acme", "handbook", { token: olive.token }, "public");
    const madeUp = olive.token.slice(0, -2) + "xx";
    const hidden = await tokenReads("acme", "payroll", madeUp);
    expect(hidden.api.status).toBe(401);
    expect(await tokenReads("acme", "handbook", madeUp)).toEqual(hidden);
    expect(await tokenReads("acme", "nothing-here", madeUp)).toEqual(hidden);
    expect(await tokenReads("nobody-here", "payroll", madeUp)).toEqual(hidden);
  });

  it("cross-tenant: another organisation's valid token still gets 404 for a private workflow, not 401", async () => {
    const { mo } = await acme();
    const bea = await person("bea");
    await orgWith("beta", bea);
    await push("beta", "secret-plans", { token: bea.token }, "private");
    const reads = await tokenReads("beta", "secret-plans", mo.token);
    expect([reads.api.status, reads.versionApi.status, reads.yaml.status]).toEqual([404, 404, 404]);
  });

  it("anonymous: with no Authorization header, public workflows still read and private ones are 404", async () => {
    const { olive } = await acme();
    await push("acme", "handbook", { token: olive.token }, "public");
    const read = async (path: string) => (await request("GET", path)).status;
    expect(await read("/api/v1/acme/handbook")).toBe(200);
    expect(await read("/api/v1/acme/handbook/v/1")).toBe(200);
    expect(await read("/acme/handbook/v/1/workflow.yaml")).toBe(200);
    expect(await read("/api/v1/acme/payroll")).toBe(404);
    expect(await read("/acme/payroll/v/1/workflow.yaml")).toBe(404);
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

// Private platforms follow the private workflow rules. Org "acme" keeps a
// private platform, its back office, and org "beta" keeps one of its own,
// which every workflow here would fit, so a fit that used it would show it.
const backOffice = `awml: "0.4"
platform: { id: back-office, label: "Acme's back office" }
off_for_up_to: PT0S
steps: code
agents: []
calls: [anthropic]
holds: [notes]
`;
const betaVault = backOffice.replace("back-office", "beta-vault").replace("Acme's back office", "Beta's vault server");
const recipe = "# Install on the back office\n\n1. Copy the workflow's code to /srv/workflows.\n";
const clientEmail = example("client-email.yaml");

async function pushPlatform(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  return request("POST", `/api/v1/platforms/${owner}/${slug}/versions`, { as, json: body });
}

// Acme's back office, private, with Olive as owner and Mo as member; Beta's
// vault, private, and a public platform of Beta's; and Nell, who belongs to
// nothing.
async function platforms() {
  const olive = await person("olive");
  const mo = await person("mo");
  const nell = await person("nell");
  const bea = await person("bea");
  await orgWith("acme", olive, [mo]);
  await orgWith("beta", bea);
  const pushes = [
    await pushPlatform("acme", "back-office", { token: olive.token }, { description: backOffice, recipe, visibility: "private" }),
    await pushPlatform("beta", "vault", { token: bea.token }, { description: betaVault, recipe, visibility: "private" }),
    await pushPlatform("beta", "open-box", { token: bea.token }, { description: example("platforms/worker.yaml") }),
  ];
  for (const res of pushes) expect(res.status).toBe(201);
  return { olive, mo, nell, bea };
}

// Every way to read a platform, as statuses.
async function platformReads(owner: string, slug: string, as: Who) {
  const status = async (path: string) => (await request("GET", path, { as })).status;
  return {
    api: await status(`/api/v1/platforms/${owner}/${slug}`),
    versionApi: await status(`/api/v1/platforms/${owner}/${slug}/v/1`),
    description: await status(`/platforms/${owner}/${slug}/v/1/description.yaml`),
    recipe: await status(`/platforms/${owner}/${slug}/v/1/recipe.md`),
  };
}

const allPlatformReads = (status: number) => ({ api: status, versionApi: status, description: status, recipe: status });

async function auditRows(action: "push" | "private_view") {
  const db = await getDb();
  const rows = await db.select().from(auditEvent);
  return rows.filter((r) => r.action === action && r.target.startsWith("platforms/")).map((r) => r.target);
}

describe("Private platforms", () => {
  describe("Positive boundary", () => {
    it("a member can read and push a private platform, and the audit log records the pushes and the views", async () => {
      const { mo } = await platforms();
      for (const as of [{ token: mo.token }, { cookie: mo.cookie }])
        expect(await platformReads("acme", "back-office", as)).toEqual(allPlatformReads(200));
      const pushed = await pushPlatform("acme", "back-office", { token: mo.token }, { description: backOffice });
      expect([pushed.status, (await pushed.json()).number]).toEqual([201, 2]);
      expect(await auditRows("push")).toEqual([
        "platforms/acme/back-office v1",
        "platforms/beta/vault v1",
        "platforms/beta/open-box v1",
        "platforms/acme/back-office v2",
      ]);
      expect(await auditRows("private_view")).toContain("platforms/acme/back-office v1");
    });

    it("a member's fit uses their organisation's private platforms, and records the view", async () => {
      const { mo } = await platforms();
      const res = await request("POST", "/api/v1/fit", { as: { token: mo.token }, json: { file: clientEmail } });
      const { results } = await res.json();
      expect(results.map((r: { platform: string }) => r.platform).sort()).toEqual(["acme/back-office", "beta/open-box"]);
      expect(results.find((r: { platform: string }) => r.platform === "acme/back-office")).toMatchObject({ fits: true });
      expect(await auditRows("private_view")).toEqual(["platforms/acme/back-office v1"]);
    });
  });

  describe("Negative boundary", () => {
    it("a non-member and a signed-out visitor get 404 on a private platform's API, versions and files", async () => {
      const { nell } = await platforms();
      for (const as of [{ token: nell.token }, { cookie: nell.cookie }, undefined])
        expect(await platformReads("acme", "back-office", as)).toEqual(allPlatformReads(404));
      expect(await auditRows("private_view")).toEqual([]);
    });

    it("a private platform answers exactly as a missing one does", async () => {
      const { nell } = await platforms();
      for (const as of [{ token: nell.token }, undefined]) {
        for (const [hidden, missing] of [
          ["/api/v1/platforms/acme/back-office", "/api/v1/platforms/acme/nothing-here"],
          ["/platforms/acme/back-office/v/1/description.yaml", "/platforms/acme/nothing-here/v/1/description.yaml"],
        ]) {
          const a = await request("GET", hidden, { as });
          const b = await request("GET", missing, { as });
          expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
        }
      }
    });

    it("a non-member cannot push to a private platform: 404, and nothing is saved", async () => {
      const { nell, olive } = await platforms();
      const res = await pushPlatform("acme", "back-office", { token: nell.token }, { description: backOffice });
      expect(res.status).toBe(404);
      const read = await (await request("GET", "/api/v1/platforms/acme/back-office", { as: { token: olive.token } })).json();
      expect(read.versions).toHaveLength(1);
    });
  });

  describe("Cross-tenant boundary", () => {
    it("a token from a member of one organisation can neither read nor push another organisation's private platforms", async () => {
      const { mo } = await platforms();
      expect(await platformReads("beta", "vault", { token: mo.token })).toEqual(allPlatformReads(404));
      expect((await pushPlatform("beta", "vault", { token: mo.token }, { description: backOffice })).status).toBe(404);
    });

    it("a token from a member of one organisation cannot push to another organisation's public platforms", async () => {
      const { mo } = await platforms();
      expect((await pushPlatform("beta", "open-box", { token: mo.token }, { description: backOffice })).status).toBe(403);
      expect((await pushPlatform("beta", "brand-new", { token: mo.token }, { description: backOffice })).status).toBe(403);
      const read = await (await request("GET", "/api/v1/platforms/beta/open-box")).json();
      expect(read.versions).toHaveLength(1);
    });

    it("fit never uses or reveals another organisation's private platform, in its results or its reasons", async () => {
      const { mo, nell } = await platforms();
      const ana = await person("ana");
      const workflow = await request("POST", `/api/v1/${ana.username}/client-email/versions`, {
        as: { token: ana.token },
        json: { workflow: clientEmail },
      });
      expect(workflow.status).toBe(201);
      for (const [who, seen] of [
        [mo, ["acme/back-office", "beta/open-box"]],
        [nell, ["beta/open-box"]],
      ] as const) {
        for (const body of [{ file: clientEmail }, { workflow: `${ana.username}/client-email` }]) {
          const res = await request("POST", "/api/v1/fit", { as: { token: who.token }, json: body });
          const text = await res.text();
          expect(res.status).toBe(200);
          const results = JSON.parse(text).results as { platform: string }[];
          expect(results.map((r) => r.platform).sort()).toEqual(seen);
          for (const secret of ["beta/vault", "beta-vault", "Beta's vault server"]) expect(text).not.toContain(secret);
        }
      }
      const named = await request("POST", "/api/v1/fit", {
        as: { token: mo.token },
        json: { file: clientEmail, platforms: ["beta/vault"] },
      });
      const missing = await request("POST", "/api/v1/fit", {
        as: { token: mo.token },
        json: { file: clientEmail, platforms: ["beta/nothing-here"] },
      });
      expect(named.status).toBe(404);
      expect((await named.text()).replace("vault", "nothing-here")).toBe(await missing.text());
      expect(await auditRows("private_view")).toEqual(["platforms/acme/back-office v1", "platforms/acme/back-office v1"]);
    });
  });

  describe("An implementation's fit", () => {
    // The client email with its Mac mini block placed on a description id:
    // Acme's private back office, or Beta's private vault.
    const placedOn = (id: string) =>
      clientEmail.replace(
        '{ id: cowork, label: "Claude Cowork, Mac mini", parts',
        `{ id: cowork, label: "Claude Cowork, Mac mini", platform: ${id}, parts`,
      );

    it("judges a block against the organisation's private platform for a member, and records the view", async () => {
      const { mo } = await platforms();
      const res = await request("POST", "/api/v1/fit", {
        as: { token: mo.token },
        json: { file: placedOn("back-office"), implementation: "office" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).results[0]).toMatchObject({ block: "cowork", platform: "acme/back-office", judged: true });
      expect(await auditRows("private_view")).toEqual(["platforms/acme/back-office v1"]);
    });

    it("never judges a block against another organisation's private platform, nor reveals it", async () => {
      const { mo, nell } = await platforms();
      for (const [who, id] of [
        [mo, "beta-vault"],
        [nell, "back-office"],
      ] as const) {
        const res = await request("POST", "/api/v1/fit", {
          as: { token: who.token },
          json: { file: placedOn(id), implementation: "office" },
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.results).toEqual([]);
        expect(body.gaps).toEqual([`group "cowork" names platform "${id}", but its description wasn't given`]);
        for (const secret of ["beta/vault", "acme/back-office", "Beta's vault server", "Acme's back office"])
          expect(JSON.stringify(body)).not.toContain(secret);
      }
      expect(await auditRows("private_view")).toEqual([]);
    });
  });

  describe("Roles boundary", () => {
    it("an owner and a member both push and read the organisation's private platforms; a member who leaves cannot", async () => {
      const { olive, mo } = await platforms();
      for (const who of [olive, mo]) {
        expect(await platformReads("acme", "back-office", { token: who.token })).toEqual(allPlatformReads(200));
        expect((await pushPlatform("acme", "back-office", { token: who.token }, { description: backOffice })).status).toBe(201);
      }
      await request("POST", `/api/orgs/acme/members/${mo.id}/remove`, { as: { cookie: mo.cookie } });
      expect(await platformReads("acme", "back-office", { token: mo.token })).toEqual(allPlatformReads(404));
      expect((await pushPlatform("acme", "back-office", { token: mo.token }, { description: backOffice })).status).toBe(404);
    });

    it("the edition decides whether an organisation may push and keep private platforms, as for workflows", async () => {
      const { olive } = await platforms();
      await withEdition({ canKeepPrivate: async () => false }, async () => {
        const res = await pushPlatform("acme", "another", { token: olive.token }, {
          description: backOffice,
          visibility: "private",
        });
        expect([res.status, (await res.json()).errors]).toEqual([403, ["acme cannot keep private platforms."]]);
      });
      await withEdition({ canPush: async () => false }, async () => {
        expect((await pushPlatform("acme", "back-office", { token: olive.token }, { description: backOffice })).status).toBe(403);
        expect((await platformReads("acme", "back-office", { token: olive.token })).api).toBe(200);
      });
    });
  });

  describe("A token that is not valid", () => {
    it("gets the same 401 for a private, a public and a missing platform, on a push and on a fit", async () => {
      const { mo } = await platforms();
      await revoke(mo);
      const answer = async (method: string, path: string, json?: unknown) => {
        const res = await request(method, path, { as: { token: mo.token }, json });
        return { status: res.status, body: await res.text() };
      };
      const hidden = await answer("GET", "/api/v1/platforms/acme/back-office");
      expect(hidden.status).toBe(401);
      expect(hidden.body).toMatch(/token is not valid/);
      for (const other of [
        await answer("GET", "/api/v1/platforms/beta/open-box"),
        await answer("GET", "/api/v1/platforms/acme/nothing-here"),
        await answer("GET", "/api/v1/platforms/acme/back-office/v/1"),
        await answer("POST", "/api/v1/platforms/acme/back-office/versions", { description: backOffice }),
        await answer("POST", "/api/v1/fit", { file: clientEmail }),
      ])
        expect(other).toEqual(hidden);
      const file = await answer("GET", "/platforms/acme/back-office/v/1/description.yaml");
      expect(file.status).toBe(401);
      expect(file.body).toMatch(/token is not valid/);
    });
  });
});

// A user's own private workflows. Ana keeps "diary" private on her own
// account; Olive owns organisation "acme", with Ana and Mo as members; Nell
// belongs to nothing.
describe("A user's own private workflows", () => {
  async function anaDiary() {
    const ana = await person("ana");
    const olive = await person("olive");
    const mo = await person("mo");
    const nell = await person("nell");
    await orgWith("acme", olive, [ana, mo]);
    const pushed = await push(ana.username, "diary", { token: ana.token }, "private");
    expect(pushed.status).toBe(201);
    return { ana, olive, mo, nell };
  }

  const limitMessage = (username: string, limit: number, has: number) =>
    `${username} can keep ${limit} private workflows and has ${has}. An organisation has no such limit: push it to one of yours, or make it public.`;

  describe("Positive boundary", () => {
    it("the owner reads, pushes and sees every view of their private workflow, and it is listed on their page", async () => {
      const { ana } = await anaDiary();
      expect(await everyRead({ cookie: ana.cookie }, ana.username, "diary")).toEqual(all(200));
      expect(await everyRead({ token: ana.token }, ana.username, "diary")).toMatchObject({
        yaml: 200,
        api: 200,
        versionApi: 200,
      });
      const read = await (await request("GET", `/api/v1/${ana.username}/diary`, { as: { token: ana.token } })).json();
      expect(read.visibility).toBe("private");
      const res = await push(ana.username, "diary", { token: ana.token });
      expect([res.status, (await res.json()).number]).toEqual([201, 2]);
      const own = await renderPage(OwnerPage, { owner: ana.username }, { as: { cookie: ana.cookie } });
      expect(own.html).toContain("diary");
    });

    it("records nothing in any audit log", async () => {
      const { ana } = await anaDiary();
      await request("GET", `/api/v1/${ana.username}/diary`, { as: { token: ana.token } });
      await push(ana.username, "diary", { token: ana.token });
      const db = await getDb();
      const rows = await db.select().from(auditEvent);
      expect(rows.filter((r) => r.target.includes("diary"))).toEqual([]);
    });

    it("the owner fits it against public platforms and their organisations' private ones", async () => {
      const { ana, olive } = await anaDiary();
      const bea = await person("bea");
      await orgWith("beta", bea);
      for (const [owner, slug, as, body] of [
        ["acme", "back-office", olive, { description: backOffice, visibility: "private" }],
        ["beta", "vault", bea, { description: betaVault, visibility: "private" }],
        ["beta", "open-box", bea, { description: example("platforms/worker.yaml") }],
      ] as const)
        expect((await pushPlatform(owner, slug, { token: as.token }, body)).status).toBe(201);
      const letters = await request("POST", `/api/v1/${ana.username}/letters/versions`, {
        as: { token: ana.token },
        json: { workflow: clientEmail, visibility: "private" },
      });
      expect(letters.status).toBe(201);
      const res = await request("POST", "/api/v1/fit", {
        as: { token: ana.token },
        json: { workflow: `${ana.username}/letters` },
      });
      expect(res.status).toBe(200);
      const results = (await res.json()).results as { platform: string }[];
      expect(results.map((r) => r.platform).sort()).toEqual(["acme/back-office", "beta/open-box"]);
    });
  });

  describe("Negative boundary", () => {
    it("another user and a signed-out visitor get 404 on its pages, views, files, versions and API", async () => {
      const { ana, nell } = await anaDiary();
      expect(await everyRead({ cookie: nell.cookie }, ana.username, "diary")).toEqual(all(404));
      expect(await everyRead({ token: nell.token }, ana.username, "diary")).toMatchObject({
        yaml: 404,
        api: 404,
        versionApi: 404,
      });
      expect(await everyRead(undefined, ana.username, "diary")).toEqual(all(404));
    });

    it("answers exactly as a missing workflow does, and is never listed to anyone else", async () => {
      const { ana, nell } = await anaDiary();
      for (const as of [{ token: nell.token }, undefined]) {
        for (const [hidden, missing] of [
          [`/api/v1/${ana.username}/diary`, `/api/v1/${ana.username}/nothing-here`],
          [`/api/v1/${ana.username}/diary/v/1`, `/api/v1/${ana.username}/nothing-here/v/1`],
          [`/${ana.username}/diary/v/1/workflow.yaml`, `/${ana.username}/nothing-here/v/1/workflow.yaml`],
        ]) {
          const a = await request("GET", hidden, { as });
          const b = await request("GET", missing, { as });
          expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
        }
      }
      for (const as of [{ cookie: nell.cookie }, undefined]) {
        const page = await renderPage(OwnerPage, { owner: ana.username }, { as });
        expect(page.status).toBe(200);
        expect(page.html).not.toContain("diary");
      }
      for (const search of [{}, { q: "dinners" }] as Record<string, string>[])
        expect((await renderPage(GalleryPage, {}, { search })).html).not.toContain("diary");
    });

    it("an old ?view= address sends anyone else on exactly as a missing workflow's does", async () => {
      const { ana, nell } = await anaDiary();
      for (const who of [{ cookie: nell.cookie }, undefined])
        for (const slug of ["diary", "nothing-here"])
          expect(
            await renderPage(WorkflowPage, { owner: ana.username, slug }, { as: who, search: { view: "yaml" } }),
          ).toEqual({ status: 308, html: "", location: `/${ana.username}/${slug}/yaml` });
    });
  });

  describe("Cross-tenant boundary", () => {
    it("another user's token can neither read nor push it", async () => {
      const { ana, nell } = await anaDiary();
      const reads = await tokenReads(ana.username, "diary", nell.token);
      expect([reads.api.status, reads.versionApi.status, reads.yaml.status]).toEqual([404, 404, 404]);
      expect((await push(ana.username, "diary", { token: nell.token })).status).toBe(404);
      expect((await push(ana.username, "diary", { cookie: nell.cookie })).status).toBe(404);
    });

    it("the owner and a member of an organisation its owner belongs to can neither read nor push it", async () => {
      const { ana, olive, mo } = await anaDiary();
      for (const who of [olive, mo]) {
        expect(await everyRead({ cookie: who.cookie }, ana.username, "diary")).toEqual(all(404));
        const reads = await tokenReads(ana.username, "diary", who.token);
        expect([reads.api.status, reads.versionApi.status, reads.yaml.status]).toEqual([404, 404, 404]);
        expect((await push(ana.username, "diary", { token: who.token })).status).toBe(404);
      }
      const read = await (await request("GET", `/api/v1/${ana.username}/diary`, { as: { token: ana.token } })).json();
      expect(read.versions).toHaveLength(1);
    });

    it("nobody can keep a private workflow on another user's account", async () => {
      const { ana, nell } = await anaDiary();
      expect((await push(nell.username, "notes", { token: ana.token }, "private")).status).toBe(403);
      expect((await request("GET", `/api/v1/${nell.username}/notes`, { as: { token: nell.token } })).status).toBe(404);
    });
  });

  describe("Roles boundary", () => {
    it("a role in an organisation gives nothing on a user's own account; the user alone reads and pushes", async () => {
      const { ana, olive } = await anaDiary();
      expect(await everyRead({ cookie: olive.cookie }, ana.username, "diary")).toEqual(all(404));
      expect((await push(ana.username, "diary", { token: olive.token })).status).toBe(404);
      expect((await push(ana.username, "diary", { token: ana.token })).status).toBe(201);
    });

    it("private platforms still belong to organisations only", async () => {
      const { ana } = await anaDiary();
      const res = await pushPlatform(ana.username, "box", { token: ana.token }, {
        description: backOffice,
        visibility: "private",
      });
      expect([res.status, (await res.json()).errors]).toEqual([
        422,
        ["Private platforms belong to organisations. Push it to one of yours."],
      ]);
    });
  });

  describe("A token that is not valid", () => {
    it("gets the same 401 for a user's private, public and missing workflow, on reads and a push", async () => {
      const { ana } = await anaDiary();
      await push(ana.username, "open", { token: ana.token }, "public");
      const madeUp = ana.token.slice(0, -2) + "xx";
      const hidden = await tokenReads(ana.username, "diary", madeUp);
      expect(hidden.api.status).toBe(401);
      expect(hidden.api.body).toMatch(/token is not valid/);
      expect(await tokenReads(ana.username, "open", madeUp)).toEqual(hidden);
      expect(await tokenReads(ana.username, "nothing-here", madeUp)).toEqual(hidden);
      await revoke(ana);
      expect(await tokenReads(ana.username, "diary", ana.token)).toEqual(hidden);
      const pushed = await push(ana.username, "diary", { token: ana.token });
      expect([pushed.status, await pushed.text()]).toEqual([401, hidden.api.body]);
    });
  });

  describe("The edition's limit", () => {
    it("the default edition sets no limit", async () => {
      const ana = await person("ana");
      expect(await edition.privateWorkflowLimit({ id: ana.id, username: ana.username })).toBeNull();
    });

    it("allows the push that reaches the limit and refuses the one over it, saying the limit and the count", async () => {
      const { ana } = await anaDiary();
      const asked: string[] = [];
      const limit = async (user: { username: string }) => {
        asked.push(user.username);
        return 2;
      };
      await withEdition({ privateWorkflowLimit: limit }, async () => {
        expect((await push(ana.username, "letters", { token: ana.token }, "private")).status).toBe(201);
        const over = await push(ana.username, "accounts", { token: ana.token }, "private");
        expect([over.status, (await over.json()).errors]).toEqual([403, [limitMessage(ana.username, 2, 2)]]);
        expect((await request("GET", `/api/v1/${ana.username}/accounts`, { as: { token: ana.token } })).status).toBe(404);
        // New versions of the private ones, public workflows and an
        // organisation's private ones are not limited.
        expect((await push(ana.username, "diary", { token: ana.token })).status).toBe(201);
        expect((await push(ana.username, "open", { token: ana.token })).status).toBe(201);
        expect((await push("acme", "payroll", { token: ana.token }, "private")).status).toBe(201);
      });
      expect(asked).toContain(ana.username);
    });

    it("a limit of 0 refuses every private workflow on a user's account", async () => {
      const ana = await person("ana");
      await withEdition({ privateWorkflowLimit: async () => 0 }, async () => {
        const res = await push(ana.username, "diary", { token: ana.token }, "private");
        expect([res.status, (await res.json()).errors]).toEqual([403, [limitMessage(ana.username, 0, 0)]]);
      });
    });
  });
});
