// Forking a public workflow into an owner of one's own: through the API, the
// form on the workflow's page and the MCP tool fork_workflow, which all call
// forkWorkflow (src/server/registry.ts). The access boundaries are those of a
// push, with the original read as any reader may read it.
import { describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent, workflow as workflowTable } from "@/db/schema";
import { revokeToken, listTokens } from "@/server/tokens";
import WorkflowPage from "@/app/[owner]/[slug]/page";
import VersionPage from "@/app/[owner]/[slug]/v/[n]/page";
import { fork } from "@/app/[owner]/[slug]/actions";
import { BASE, example, orgWith, person, request, storeVersion, withEdition, type Who } from "./helpers";
import { call } from "./mcp-client";
import { pageRequest, renderPage } from "./pages";

// Beta's dinners: first its design alone, then with where it runs.
const second = example("dinners.yaml");
const first = second.slice(0, second.indexOf("implementations:"));

async function push(owner: string, slug: string, as: Who, file: string, visibility?: "public" | "private") {
  const res = await request("POST", `/api/v1/${owner}/${slug}/versions`, {
    as,
    json: { workflow: file, ...(visibility ? { visibility } : {}) },
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

const forkApi = (owner: string, slug: string, as: Who, json: Record<string, unknown>) =>
  request("POST", `/api/v1/${owner}/${slug}/fork`, { as, json });

// Bea keeps beta/dinners, public, at two versions, and beta/payroll, private.
// Ana owns acme, with Mo as a member; Nell belongs to nothing.
async function world() {
  const bea = await person("bea");
  const ana = await person("ana");
  const mo = await person("mo");
  const nell = await person("nell");
  await orgWith("beta", bea);
  await orgWith("acme", ana, [mo]);
  await push("beta", "dinners", { token: bea.token }, first);
  await push("beta", "dinners", { token: bea.token }, second);
  await push("beta", "payroll", { token: bea.token }, second, "private");
  return { bea, ana, mo, nell };
}

async function body(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe("forking through the API", () => {
  it("forks the latest version to the person themselves, public by default, keeping the original's slug", async () => {
    const { ana } = await world();
    const res = await body(await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana" }));
    expect(res).toEqual({
      status: 201,
      body: { owner: "ana", slug: "dinners", number: 1, url: `${BASE}/ana/dinners/v/1` },
    });
    const read = await (await request("GET", "/api/v1/ana/dinners")).json();
    expect(read).toMatchObject({ visibility: "public", forkedFrom: { owner: "beta", slug: "dinners", number: 2 } });
    expect(read.versions).toHaveLength(1);
  });

  it("copies the version asked for byte for byte, and starts the fork at its own version 1", async () => {
    const { ana } = await world();
    const res = await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana", slug: "my-dinners", version: 1 });
    expect(res.status).toBe(201);
    const v = await (await request("GET", "/api/v1/ana/my-dinners/v/1")).json();
    expect(v.files.workflow).toBe(first);
    expect(v.forkedFrom).toEqual({ owner: "beta", slug: "dinners", number: 1 });
    expect((await request("GET", "/api/v1/ana/my-dinners/v/2")).status).toBe(404);
  });

  it("forks privately to the person and to their organisation", async () => {
    const { ana } = await world();
    for (const owner of ["ana", "acme"]) {
      const res = await forkApi("beta", "dinners", { token: ana.token }, { owner, visibility: "private" });
      expect(res.status).toBe(201);
      expect((await request("GET", `/api/v1/${owner}/dinners`)).status).toBe(404);
      const own = await (await request("GET", `/api/v1/${owner}/dinners`, { as: { token: ana.token } })).json();
      expect(own.visibility).toBe("private");
    }
  });

  it("lets an organisation's owner and member both fork into it, and records each as a push", async () => {
    const { ana, mo } = await world();
    expect((await forkApi("beta", "dinners", { token: ana.token }, { owner: "acme", slug: "a" })).status).toBe(201);
    expect((await forkApi("beta", "dinners", { token: mo.token }, { owner: "acme", slug: "b" })).status).toBe(201);
    const db = await getDb();
    const pushes = await db.select({ target: auditEvent.target }).from(auditEvent).where(eq(auditEvent.action, "push"));
    expect(pushes.map((p) => p.target)).toEqual(expect.arrayContaining(["acme/a v1", "acme/b v1"]));
  });

  it("lets an owner fork its own public workflow into an organisation, and back", async () => {
    const { ana } = await world();
    await push("ana", "lunches", { token: ana.token }, second);
    expect((await forkApi("ana", "lunches", { token: ana.token }, { owner: "acme" })).status).toBe(201);
    expect((await forkApi("acme", "lunches", { token: ana.token }, { owner: "ana", slug: "lunches-again" })).status).toBe(
      201,
    );
  });

  it("answers a taken slug with a 409", async () => {
    const { ana } = await world();
    await push("ana", "dinners", { token: ana.token }, second, "private");
    const res = await body(await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana" }));
    expect(res.status).toBe(409);
    expect(res.body.errors[0]).toContain("ana/dinners");
  });

  it("applies the edition's limit on a person's private workflows", async () => {
    const { ana } = await world();
    await withEdition({ privateWorkflowLimit: async () => 1 }, async () => {
      expect((await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana", visibility: "private" })).status).toBe(
        201,
      );
      const over = await body(
        await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana", slug: "again", visibility: "private" }),
      );
      expect(over.status).toBe(403);
      expect(over.body.errors[0]).toContain("ana can keep 1 private workflows and has 1.");
    });
  });

  it("refuses a version stored before 0.4, which has no workflow file to copy", async () => {
    const { ana, bea } = await world();
    await storeVersion("beta", "old", bea, { security: example("legacy/dinners-security.yaml") });
    const res = await body(await forkApi("beta", "old", { token: ana.token }, { owner: "ana" }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toContain("Version 1 was stored before the registry took AWML 0.4 files");
  });

  it("refuses a version that isn't there with the 404 a missing workflow gives", async () => {
    const { ana } = await world();
    const res = await body(await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana", version: 9 }));
    expect(res).toEqual({ status: 404, body: { errors: ["Not found."] } });
  });
});

describe("who may fork", () => {
  it("gives a signed-out caller a 401", async () => {
    await world();
    const res = await forkApi("beta", "dinners", undefined, { owner: "ana" });
    expect(res.status).toBe(401);
  });

  it("gives a stranger forking a private workflow the same 404 as a missing one", async () => {
    const { ana } = await world();
    const hidden = await body(await forkApi("beta", "payroll", { token: ana.token }, { owner: "ana" }));
    const missing = await body(await forkApi("beta", "nothing-here", { token: ana.token }, { owner: "ana" }));
    expect(hidden).toEqual({ status: 404, body: { errors: ["Not found."] } });
    expect(missing).toEqual(hidden);
  });

  it("forks only public workflows, even for a member who can see a private one", async () => {
    const { bea } = await world();
    const res = await body(await forkApi("beta", "payroll", { token: bea.token }, { owner: "bea" }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toContain("Only public workflows can be forked");
  });

  it("forks into nobody else: not another person, nor an organisation the caller doesn't belong to", async () => {
    const { ana, nell } = await world();
    for (const owner of ["ana", "acme", "beta"]) {
      const res = await forkApi("beta", "dinners", { token: nell.token }, { owner });
      expect(res.status).toBe(403);
    }
    // A private workflow at the slug asked for, in an owner the caller cannot push to, is not given away.
    await push("acme", "secret", { token: ana.token }, second, "private");
    const res = await body(await forkApi("beta", "dinners", { token: nell.token }, { owner: "acme", slug: "secret" }));
    const free = await body(await forkApi("beta", "dinners", { token: nell.token }, { owner: "acme", slug: "free" }));
    expect(res.status).toBe(403);
    expect(res.body.errors).toEqual(free.body.errors);
  });

  it("gives a revoked or made-up token the same 401 for a public, a private and a missing workflow", async () => {
    const { ana } = await world();
    const db = await getDb();
    const [made] = await listTokens(db, ana.id);
    await revokeToken(db, ana.id, made.id);
    for (const token of [ana.token, "awml_made_up"]) {
      const answers = [];
      for (const slug of ["dinners", "payroll", "nothing-here"])
        answers.push(await body(await forkApi("beta", slug, { token }, { owner: "ana" })));
      expect(answers.map((a) => a.status)).toEqual([401, 401, 401]);
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    }
  });
});

describe("what a fork's page and the original's page say", () => {
  it("heads the fork with where it came from, linked to that version", async () => {
    const { ana } = await world();
    await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana", version: 1 });
    const page = await renderPage(WorkflowPage, { owner: "ana", slug: "dinners" });
    expect(page.html).toContain('Forked from <a href="/beta/dinners/v/1">beta/dinners</a>, version 1');
  });

  it("lists the original's forks the viewer may see, newest first, and never a private one they may not", async () => {
    const { ana, bea, nell } = await world();
    await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana", slug: "open-one" });
    await forkApi("beta", "dinners", { token: ana.token }, { owner: "acme", slug: "hidden-one", visibility: "private" });
    await forkApi("beta", "dinners", { token: nell.token }, { owner: "nell", slug: "open-two", version: 1 });
    for (const who of [undefined, { cookie: bea.cookie }, { cookie: nell.cookie }]) {
      const page = await renderPage(WorkflowPage, { owner: "beta", slug: "dinners" }, { as: who });
      expect(page.html).toContain("Forks <span");
      expect(page.html).toMatch(/Forks <span[^>]*>2<\/span>/);
      expect(page.html.indexOf("nell/open-two")).toBeLessThan(page.html.indexOf("ana/open-one"));
      expect(page.html).not.toContain("hidden-one");
    }
    // Ana may see acme's private fork, so it is listed and counted to her.
    const asAna = await renderPage(VersionPage, { owner: "beta", slug: "dinners", n: "1" }, { as: { cookie: ana.cookie } });
    expect(asAna.html).toMatch(/Forks <span[^>]*>3<\/span>/);
    expect(asAna.html).toContain("acme/hidden-one");
  });

  it("names nothing once the original is private, or gone, to anyone who may not see it", async () => {
    const { ana, bea } = await world();
    await forkApi("beta", "dinners", { token: ana.token }, { owner: "ana" });
    const db = await getDb();
    await db.update(workflowTable).set({ visibility: "private" }).where(eq(workflowTable.slug, "dinners"));
    // ana/dinners is also private now; ana sees her own fork.
    const asAna = await renderPage(WorkflowPage, { owner: "ana", slug: "dinners" }, { as: { cookie: ana.cookie } });
    expect(asAna.html).toContain("Forked from another workflow");
    expect(asAna.html).not.toContain("beta/dinners");
    const api = await (await request("GET", "/api/v1/ana/dinners", { as: { token: ana.token } })).json();
    expect(api.forkedFrom).toBeNull();
    // Bea, who may see the original, still reads its name.
    await db.update(workflowTable).set({ visibility: "public" }).where(eq(workflowTable.ownerUserId, ana.id));
    const asBea = await renderPage(WorkflowPage, { owner: "ana", slug: "dinners" }, { as: { cookie: bea.cookie } });
    expect(asBea.html).toContain("Forked from <a href=\"/beta/dinners/v/2\">beta/dinners</a>, version 2");

    await db
      .delete(workflowTable)
      .where(and(eq(workflowTable.slug, "dinners"), isNotNull(workflowTable.ownerOrganisationId)));
    const gone = await renderPage(WorkflowPage, { owner: "ana", slug: "dinners" });
    expect(gone.html).toContain("Forked from another workflow");
  });

  it("offers a signed-in viewer a Fork form with their own owners, and a visitor a way to sign in first", async () => {
    const { ana, nell } = await world();
    const asAna = await renderPage(VersionPage, { owner: "beta", slug: "dinners", n: "1" }, { as: { cookie: ana.cookie } });
    expect(asAna.html).toContain(">Fork<");
    expect(asAna.html).toContain('<option value="ana"');
    expect(asAna.html).toContain('<option value="acme"');
    expect(asAna.html).not.toContain('<option value="beta"');
    expect(asAna.html).toContain('name="version" value="1"');
    expect(asAna.html).toContain('name="slug" value="dinners"');
    const asNell = await renderPage(WorkflowPage, { owner: "beta", slug: "dinners" }, { as: { cookie: nell.cookie } });
    expect(asNell.html).toContain('name="version" value="2"');
    const visitor = await renderPage(WorkflowPage, { owner: "beta", slug: "dinners" });
    expect(visitor.html).toContain('href="/login?next=%2Fbeta%2Fdinners"');
    expect(visitor.html).not.toContain("<form");
  });

  it("offers no Fork on a private workflow", async () => {
    const { bea } = await world();
    const page = await renderPage(WorkflowPage, { owner: "beta", slug: "payroll" }, { as: { cookie: bea.cookie } });
    expect(page.status).toBe(200);
    expect(page.html).not.toContain(">Fork<");
  });
});

describe("the Fork form", () => {
  async function submit(who: Who, fields: Record<string, string>) {
    pageRequest.headers = new Headers();
    if (who?.cookie) pageRequest.headers.set("cookie", who.cookie);
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    try {
      return { state: await fork({}, form) };
    } catch (e) {
      const digest = (e as { digest?: string }).digest ?? "";
      if (digest.startsWith("NEXT_REDIRECT;")) return { location: digest.split(";")[2] };
      throw e;
    }
  }

  it("makes the fork and opens its page", async () => {
    const { ana } = await world();
    const done = await submit(
      { cookie: ana.cookie },
      { from: "beta/dinners", version: "1", owner: "acme", slug: "family", visibility: "private" },
    );
    expect(done).toEqual({ location: "/acme/family" });
    const read = await (await request("GET", "/api/v1/acme/family", { as: { token: ana.token } })).json();
    expect(read).toMatchObject({ visibility: "private", forkedFrom: { owner: "beta", slug: "dinners", number: 1 } });
  });

  it("says why it refused, and sends someone signed out to sign in", async () => {
    const { ana } = await world();
    await push("ana", "dinners", { token: ana.token }, second);
    const taken = await submit({ cookie: ana.cookie }, { from: "beta/dinners", version: "2", owner: "ana", slug: "dinners" });
    expect(taken.state?.error).toContain("ana/dinners");
    const nobody = await submit(undefined, { from: "beta/dinners", version: "2", owner: "ana", slug: "x" });
    expect(nobody).toEqual({ location: "/login?next=%2Fbeta%2Fdinners%2Fv%2F2" });
  });
});

describe("fork_workflow on /mcp", () => {
  it("forks a public workflow as the person, and refuses a private one as not found", async () => {
    const { ana } = await world();
    const done = await call("fork_workflow", { owner: "beta", slug: "dinners", to_owner: "acme" }, ana.token);
    expect(done.isError).toBe(false);
    expect(done.data).toEqual({ owner: "acme", slug: "dinners", number: 1, url: `${BASE}/acme/dinners` });
    const hidden = await call("fork_workflow", { owner: "beta", slug: "payroll", to_owner: "ana" }, ana.token);
    const missing = await call("fork_workflow", { owner: "beta", slug: "nothing-here", to_owner: "ana" }, ana.token);
    expect(hidden).toMatchObject({ isError: true, text: "Not found." });
    expect(missing).toEqual(hidden);
    const elsewhere = await call("fork_workflow", { owner: "beta", slug: "dinners", to_owner: "beta" }, ana.token);
    expect(elsewhere.isError).toBe(true);
  });
});
