// The MCP server at /mcp, tested the way an AI client uses it: JSON-RPC over
// HTTP, as nobody, with a registry token, or with an OAuth access token got
// through the sign-in and consent pages.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import { listTokens, revokeToken } from "@/server/tokens";
import ConsentPage from "@/app/consent/page";
import { BASE, example, orgWith, person, request } from "./helpers";
import { call, CIMD_CLIENT, connect, MCP, message, post, serveMetadata } from "./mcp-client";
import { renderPage } from "./pages";
import { route } from "./router";

const workflow = example("dinners.yaml");
// The same workflow, at home and away for the summer, placing the parts home
// does in two blocks.
const homeParts = [...workflow.matchAll(/parts: \[([^\]]*)\]/g)].map((m) => m[1]);
const twoPlaces = `${workflow.trimEnd()}
  away:
    label: Away for the summer
    blocks:
      - { id: cloud, label: "A cloud server", parts: [${homeParts[0]}] }
      - { id: services, label: "Everyone's services", parts: [${homeParts.slice(1).join(", ")}] }
`;

const METADATA = `${BASE}/.well-known/oauth-protected-resource/mcp`;

const publish = (bearer: string | undefined, args: Record<string, unknown>) => call("publish", args, bearer);

// Org "acme" with owner Olive and member Mo, holding one private workflow;
// org "beta" with owner Bea, holding a private and a public one; and Nell,
// who belongs to nothing.
async function twoOrgs() {
  const olive = await person("olive");
  const mo = await person("mo");
  const nell = await person("nell");
  const bea = await person("bea");
  await orgWith("acme", olive, [mo]);
  await orgWith("beta", bea);
  expect((await publish(olive.token, { owner: "acme", slug: "payroll", workflow, visibility: "private" })).isError).toBe(
    false,
  );
  expect((await publish(bea.token, { owner: "beta", slug: "secret-plans", workflow, visibility: "private" })).isError).toBe(
    false,
  );
  expect((await publish(bea.token, { owner: "beta", slug: "open-plans", workflow })).isError).toBe(false);
  return { olive, mo, nell, bea };
}

async function audit(action: "push" | "private_view", actorId: string) {
  const db = await getDb();
  return db
    .select({ target: auditEvent.target })
    .from(auditEvent)
    .where(and(eq(auditEvent.action, action), eq(auditEvent.actorId, actorId)));
}

const initialize = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
};

describe("the MCP server at /mcp", () => {
  it("answers initialize and lists its eleven tools to someone signed in", async () => {
    const ana = await person("ana");
    const init = await message(await post("initialize", initialize, ana.token));
    expect(init.result).toMatchObject({ serverInfo: { name: "awml-registry" }, capabilities: { tools: {} } });
    const tools = (await message(await post("tools/list", {}, ana.token))).result as unknown as {
      tools: { name: string }[];
    };
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "add_platform",
      "check",
      "fit_workflow",
      "fork_workflow",
      "get",
      "get_platform",
      "list",
      "publish",
      "search",
      "search_platforms",
      "set_username",
    ]);
  });

  it("checks files with the engine and gives the mistakes `awml check` prints, saving nothing", async () => {
    const ana = await person("ana");
    const printed = example("bad-06.check.txt").trim().split("\n");
    const bad = await call("check", { workflow: example("bad-06.yaml") }, ana.token);
    expect(bad.isError).toBe(false);
    expect(bad.data.mistakes).toEqual(printed.map((line) => line.replace(/^bad-06\.yaml: /, "workflow: ")));

    const good = await call("check", { workflow }, ana.token);
    expect(good.data.mistakes).toEqual([]);
    expect(good.text).toBe("No mistakes.");

    expect((await call("check", {}, ana.token)).isError).toBe(true);
    expect((await call("search", {}, ana.token)).data.workflows).toEqual([]);
  });

  it("publishes a new version and gives back the workflow's page and version number", async () => {
    const ana = await person("ana");
    const first = await publish(ana.token, { owner: ana.username, slug: "dinners", workflow });
    expect(first.isError).toBe(false);
    expect(first.data).toEqual({
      owner: ana.username,
      slug: "dinners",
      number: 1,
      url: `${BASE}/${ana.username}/dinners`,
      rewrites: [],
    });
    expect(first.text).toContain(`${BASE}/${ana.username}/dinners`);
    const second = await publish(ana.token, { owner: ana.username, slug: "dinners", workflow });
    expect(second.data.number).toBe(2);
    const api = await (await request("GET", `/api/v1/${ana.username}/dinners`)).json();
    expect(api.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });

  it("refuses to publish files with mistakes, giving the messages, and saves nothing", async () => {
    const ana = await person("ana");
    const res = await publish(ana.token, { owner: ana.username, slug: "broken", workflow: example("bad-06.yaml") });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("workflow: ");
    expect((await request("GET", `/api/v1/${ana.username}/broken`)).status).toBe(404);
  });

  it("gets the latest version or a given one, with its YAML and summary", async () => {
    const ana = await person("ana");
    await publish(ana.token, { owner: ana.username, slug: "dinners", workflow });
    await publish(ana.token, { owner: ana.username, slug: "dinners", workflow: twoPlaces });
    const latest = await call("get", { owner: ana.username, slug: "dinners" }, ana.token);
    expect(latest.data).toMatchObject({
      owner: ana.username,
      slug: "dinners",
      title: "The family's dinners",
      visibility: "public",
      number: 2,
      versions: [2, 1],
      url: `${BASE}/${ana.username}/dinners`,
      files: { workflow: twoPlaces },
    });
    expect(latest.text).toContain(twoPlaces);
    const first = await call("get", { owner: ana.username, slug: "dinners", version: 1 }, ana.token);
    expect(first.data).toMatchObject({
      number: 1,
      files: { workflow },
      summary: JSON.parse(example("dinners.summary.json")),
      url: `${BASE}/${ana.username}/dinners/v/1`,
    });
    const missing = await call("get", { owner: ana.username, slug: "dinners", version: 9 }, ana.token);
    expect([missing.isError, missing.text]).toEqual([true, "Not found."]);
  });

  it("lists an owner's workflows, and with no owner the caller's own and their organisations'", async () => {
    const { mo } = await twoOrgs();
    await publish(mo.token, { owner: mo.username, slug: "dinners", workflow });
    const acme = await call("list", { owner: "acme" }, mo.token);
    expect(acme.data.workflows.map((w: { slug: string }) => w.slug)).toEqual(["payroll"]);
    expect(acme.data.workflows[0]).toMatchObject({ owner: "acme", visibility: "private", url: `${BASE}/acme/payroll` });
    const mine = await call("list", {}, mo.token);
    expect(mine.data.workflows.map((w: { owner: string; slug: string }) => `${w.owner}/${w.slug}`).sort()).toEqual([
      "acme/payroll",
      `${mo.username}/dinners`,
    ]);
    expect(await call("list", { owner: "nobody-here" }, mo.token)).toMatchObject({ isError: true, text: "Not found." });
  });

  it("searches the public gallery by title", async () => {
    const { bea } = await twoOrgs();
    await publish(bea.token, {
      owner: bea.username,
      slug: "client-email",
      workflow: workflow.replace("title: The family's dinners", "title: Client email"),
    });
    const found = await call("search", { query: "client" }, bea.token);
    expect(found.data.workflows).toEqual([
      expect.objectContaining({
        owner: bea.username,
        slug: "client-email",
        title: "Client email",
        url: `${BASE}/${bea.username}/client-email`,
      }),
    ]);
    const all = await call("search", {}, bea.token);
    expect(all.data.workflows.map((w: { slug: string }) => w.slug).sort()).toEqual(["client-email", "open-plans"]);
  });
});

describe("connecting an AI client", () => {
  it("publishes where the registry's authorisation server is, and that server offers registration, metadata documents and PKCE", async () => {
    const resource = await route(new Request(METADATA));
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ resource: MCP, authorization_servers: [`${BASE}/api/auth`] });

    for (const path of ["/.well-known/oauth-authorization-server/api/auth", "/.well-known/oauth-authorization-server"]) {
      const server = await route(new Request(BASE + path));
      expect(server.status, path).toBe(200);
      expect(await server.json()).toMatchObject({
        issuer: `${BASE}/api/auth`,
        authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
        token_endpoint: `${BASE}/api/auth/oauth2/token`,
        registration_endpoint: `${BASE}/api/auth/oauth2/register`,
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
      });
    }
    for (const path of ["/.well-known/oauth-authorization-server/elsewhere", "/.well-known/oauth-protected-resource/elsewhere"])
      expect((await route(new Request(BASE + path))).status, path).toBe(404);
  });

  it("gives every address from BETTER_AUTH_URL, so a registry on its own address works the same", async () => {
    const own = "https://registry.example.com";
    const original = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = own;
    try {
      const unauthenticated = await route(new Request(`${own}/mcp`, { method: "POST", body: "{}" }));
      expect(unauthenticated.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${own}/.well-known/oauth-protected-resource/mcp"`,
      );
      const resource = await route(new Request(`${own}/.well-known/oauth-protected-resource/mcp`));
      expect(await resource.json()).toMatchObject({ resource: `${own}/mcp`, authorization_servers: [`${own}/api/auth`] });
      const server = await (await route(new Request(`${own}/.well-known/oauth-authorization-server/api/auth`))).json();
      const addresses = Object.entries(server).filter(([k]) => k === "issuer" || k.endsWith("_endpoint") || k === "jwks_uri");
      expect(addresses.length).toBeGreaterThan(4);
      for (const [key, value] of addresses) expect(value, key).toMatch(new RegExp(`^${own}/api/auth`));
      expect(server.client_id_metadata_document_supported).toBe(true);
    } finally {
      process.env.BETTER_AUTH_URL = original;
    }
  });

  it("signs in on the sign-in page, allows the client on the consent page and gets a token that works on /mcp", async () => {
    const ana = await person("ana");
    const { accessToken } = await connect(ana);
    const res = await publish(accessToken, { owner: ana.username, slug: "dinners", workflow });
    expect(res.data).toMatchObject({ owner: ana.username, number: 1 });
  });

  it("a client named by the address of its metadata document signs in, is allowed and gets a token that works on /mcp", async () => {
    const ana = await person("ana");
    const asked = serveMetadata();
    const { accessToken, clientId } = await connect(ana, { clientId: CIMD_CLIENT });
    expect(clientId).toBe(CIMD_CLIENT);
    expect(asked).toContain(CIMD_CLIENT);
    const res = await publish(accessToken, { owner: ana.username, slug: "dinners", workflow });
    expect(res.data).toMatchObject({ owner: ana.username, number: 1 });
  });

  it("the consent page sends someone signed out to sign in first, and refuses a link that was not signed", async () => {
    const ana = await person("ana");
    const query = { client_id: "x", response_type: "code", sig: "forged", exp: "9999999999" };
    const signedOut = await renderPage(ConsentPage, {}, { search: query });
    expect(signedOut.status).toBe(307);
    expect(signedOut.location).toMatch(/^\/login\?/);
    expect((await renderPage(ConsentPage, {}, { as: { cookie: ana.cookie }, search: query })).status).toBe(404);
  });

  it("refuses an OAuth token that was not issued for /mcp", async () => {
    const ana = await person("ana");
    const { accessToken: notForMcp } = await connect(ana, { resource: undefined });
    const res = await post("tools/call", { name: "list", arguments: {} }, notForMcp);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("Positive boundary", () => {
  it("a member publishes to and reads their organisation's private workflow through /mcp, and the audit log records both", async () => {
    const { mo } = await twoOrgs();
    const pushed = await publish(mo.token, { owner: "acme", slug: "payroll", workflow: twoPlaces });
    expect(pushed.isError).toBe(false);
    expect(pushed.data).toMatchObject({ owner: "acme", slug: "payroll", number: 2, url: `${BASE}/acme/payroll` });
    const read = await call("get", { owner: "acme", slug: "payroll" }, mo.token);
    expect(read.data).toMatchObject({ visibility: "private", number: 2, files: { workflow: twoPlaces } });
    expect(await audit("push", mo.id)).toEqual([{ target: "acme/payroll v2" }]);
    expect(await audit("private_view", mo.id)).toEqual([{ target: "acme/payroll v2" }]);
  });

  it("a person publishes a private workflow to their own account through /mcp, and only they read and list it", async () => {
    const { mo, nell } = await twoOrgs();
    const pushed = await publish(nell.token, { owner: nell.username, slug: "diary", workflow, visibility: "private" });
    expect(pushed.isError).toBe(false);
    expect(pushed.data).toMatchObject({ owner: nell.username, slug: "diary", number: 1 });
    expect((await call("get", { owner: nell.username, slug: "diary" }, nell.token)).data.visibility).toBe("private");
    const own = await call("list", {}, nell.token);
    expect(own.data.workflows).toEqual([expect.objectContaining({ owner: nell.username, slug: "diary", visibility: "private" })]);
    expect((await call("get", { owner: nell.username, slug: "diary" }, mo.token)).text).toBe("Not found.");
    expect((await call("list", { owner: nell.username }, mo.token)).data.workflows).toEqual([]);
    expect((await publish(mo.token, { owner: nell.username, slug: "diary", workflow })).text).toBe("Not found.");
    expect(await audit("push", nell.id)).toEqual([]);
  });
});

describe("Negative boundary", () => {
  it("a signed-out caller cannot publish: 401 with WWW-Authenticate pointing at the metadata, and nothing saved", async () => {
    const ana = await person("ana");
    const res = await post("tools/call", { name: "publish", arguments: { owner: ana.username, slug: "dinners", workflow } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}"`);
    const body = await message(res);
    expect(body.error?.message).toMatch(/^Sign in to use the AWML registry/);
    expect((await request("GET", `/api/v1/${ana.username}/dinners`)).status).toBe(404);
  });

  it("a signed-out caller gets the same 401 for every request, so a client starts signing in when it connects", async () => {
    await twoOrgs();
    for (const [method, params] of [
      ["initialize", initialize],
      ["tools/list", {}],
      ["tools/call", { name: "check", arguments: { workflow } }],
      ["tools/call", { name: "search", arguments: {} }],
      ["tools/call", { name: "get", arguments: { owner: "beta", slug: "open-plans" } }],
      ["tools/call", { name: "get", arguments: { owner: "acme", slug: "payroll" } }],
    ] as const) {
      const res = await post(method, params);
      expect(res.status, method).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}"`);
    }
  });

  it("a non-member cannot read or publish a private workflow: it looks not found, as on the website", async () => {
    const { nell, olive } = await twoOrgs();
    const missing = await call("get", { owner: "acme", slug: "nothing-here" }, nell.token);
    const hidden = await call("get", { owner: "acme", slug: "payroll" }, nell.token);
    expect([hidden.isError, hidden.text]).toEqual([missing.isError, missing.text]);
    expect(hidden.text).toBe("Not found.");
    expect((await call("get", { owner: "acme", slug: "payroll", version: 1 }, nell.token)).text).toBe("Not found.");
    expect((await call("list", { owner: "acme" }, nell.token)).data.workflows).toEqual([]);
    const searched = await call("search", { query: "dinners" }, nell.token);
    expect(searched.data.workflows.map((w: { slug: string }) => w.slug)).not.toContain("payroll");
    const pushed = await publish(nell.token, { owner: "acme", slug: "payroll", workflow });
    expect([pushed.isError, pushed.text]).toEqual([true, "Not found."]);
    const versions = await call("get", { owner: "acme", slug: "payroll" }, olive.token);
    expect(versions.data.versions).toEqual([1]);
  });
});

describe("Cross-tenant boundary", () => {
  it("organisation A's token and OAuth session cannot list, get or publish organisation B's private workflows", async () => {
    const { mo, bea } = await twoOrgs();
    const { accessToken: oauth } = await connect(mo);
    for (const bearer of [mo.token, oauth]) {
      expect((await call("list", { owner: "beta" }, bearer)).data.workflows.map((w: { slug: string }) => w.slug)).toEqual([
        "open-plans",
      ]);
      expect((await call("list", {}, bearer)).data.workflows.map((w: { owner: string }) => w.owner)).not.toContain("beta");
      expect((await call("get", { owner: "beta", slug: "secret-plans" }, bearer)).text).toBe("Not found.");
      expect((await publish(bearer, { owner: "beta", slug: "secret-plans", workflow })).text).toBe("Not found.");
      const intoPublic = await publish(bearer, { owner: "beta", slug: "open-plans", workflow });
      expect([intoPublic.isError, intoPublic.text]).toEqual([true, "Only members of beta can push here."]);
      expect((await publish(bearer, { owner: "beta", slug: "brand-new", workflow })).isError).toBe(true);
    }
    expect((await call("get", { owner: "beta", slug: "secret-plans" }, bea.token)).data.versions).toEqual([1]);
    expect((await call("get", { owner: "beta", slug: "open-plans" }, bea.token)).data.versions).toEqual([1]);
    expect(await audit("private_view", mo.id)).toEqual([]);
  });
});

describe("Token and OAuth give the same access", () => {
  it("a person's registry token and their OAuth token answer every tool the same", async () => {
    const { mo } = await twoOrgs();
    const { accessToken: oauth } = await connect(mo);
    const reads: [string, Record<string, unknown>][] = [
      ["list", {}],
      ["list", { owner: "acme" }],
      ["list", { owner: "beta" }],
      ["get", { owner: "acme", slug: "payroll" }],
      ["get", { owner: "beta", slug: "secret-plans" }],
      ["get", { owner: "beta", slug: "open-plans", version: 1 }],
      ["search", { query: "dinners" }],
      ["check", { workflow }],
      ["publish", { owner: "beta", slug: "open-plans", workflow }],
    ];
    for (const [tool, args] of reads) {
      expect(await call(tool, args, oauth), `${tool} ${JSON.stringify(args)}`).toEqual(await call(tool, args, mo.token));
    }
    const byToken = await publish(mo.token, { owner: "acme", slug: "payroll", workflow });
    const byOAuth = await publish(oauth, { owner: "acme", slug: "payroll", workflow });
    expect([byToken.data.number, byOAuth.data.number]).toEqual([2, 3]);
  });
});

// Platforms: AWML's example code worker, and a private machine of each
// organisation's own, which the client email workflow would fit.
const worker = example("platforms/worker.yaml");
const clientEmail = example("client-email.yaml");
const machine = (id: string, label: string) => `awml: "0.6"
platform: { id: ${id}, label: "${label}" }
off_for_up_to: PT0S
steps: code
agents: []
calls: [anthropic]
holds: [notes]
`;
const recipe = "# Install it\n\n1. Copy the workflow's code across.\n2. Put the model key in the secret store.\n";

// twoOrgs, with a private platform for each organisation and a public one of
// beta's.
async function twoOrgsWithPlatforms() {
  const people = await twoOrgs();
  const { olive, bea } = people;
  for (const [who, args] of [
    [olive, { owner: "acme", slug: "back-office", description: machine("back-office", "Acme back office"), recipe, visibility: "private" }],
    [bea, { owner: "beta", slug: "vault", description: machine("beta-vault", "Beta vault server"), recipe, visibility: "private" }],
    [bea, { owner: "beta", slug: "open-box", description: worker }],
  ] as const)
    expect((await call("add_platform", args, who.token)).isError).toBe(false);
  return people;
}

describe("platforms through /mcp", () => {
  it("adds a platform with its recipe and gets it back, the latest version or a given one", async () => {
    const ana = await person("ana");
    const added = await call("add_platform", { owner: ana.username, slug: "box", description: worker, recipe }, ana.token);
    expect(added.isError).toBe(false);
    expect(added.data).toEqual({
      owner: ana.username,
      slug: "box",
      number: 1,
      url: `${BASE}/${ana.username}/platforms/box`,
    });
    expect(added.text).toBe(`Saved version 1 of the platform ${ana.username}/box: ${BASE}/${ana.username}/platforms/box`);
    await call("add_platform", { owner: ana.username, slug: "box", description: machine("box", "A box") }, ana.token);
    const latest = await call("get_platform", { owner: ana.username, slug: "box" }, ana.token);
    expect(latest.data).toMatchObject({
      owner: ana.username,
      slug: "box",
      label: "A box",
      visibility: "public",
      number: 2,
      versions: [2, 1],
      url: `${BASE}/${ana.username}/platforms/box`,
      recipe: null,
    });
    const first = await call("get_platform", { owner: ana.username, slug: "box", version: 1 }, ana.token);
    expect(first.data).toMatchObject({
      number: 1,
      label: "A code worker",
      url: `${BASE}/${ana.username}/platforms/box/v/1`,
      description: worker,
      recipe,
    });
    expect(first.text).toContain(worker);
    expect(first.text).toContain(recipe);
    expect(await call("get_platform", { owner: ana.username, slug: "box", version: 9 }, ana.token)).toMatchObject({
      isError: true,
      text: "Not found.",
    });
  });

  it("refuses a description with mistakes, giving the messages `awml check` gives, and saves nothing", async () => {
    const ana = await person("ana");
    const res = await call("add_platform", { owner: ana.username, slug: "box", description: "awml: \"0.6\"\nplatform: { id: x }\n" }, ana.token);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("description: platform has no label");
    expect((await call("get_platform", { owner: ana.username, slug: "box" }, ana.token)).text).toBe("Not found.");
  });

  it("searches public platforms and the caller's organisations' own by text", async () => {
    const { mo } = await twoOrgsWithPlatforms();
    const all = await call("search_platforms", {}, mo.token);
    expect(all.data.platforms.map((p: { owner: string; slug: string }) => `${p.owner}/${p.slug}`).sort()).toEqual([
      "acme/back-office",
      "beta/open-box",
    ]);
    const found = await call("search_platforms", { query: "back office" }, mo.token);
    expect(found.data.platforms).toEqual([
      expect.objectContaining({ owner: "acme", slug: "back-office", label: "Acme back office", visibility: "private" }),
    ]);
    expect(found.text).toContain("acme/back-office (private): Acme back office");
    expect((await call("search_platforms", { query: "worker" }, mo.token)).data.platforms.map((p: { slug: string }) => p.slug)).toEqual([
      "open-box",
    ]);
  });

  it("fits a workflow against the platforms named, or every platform the caller can see, as the API does", async () => {
    const { mo } = await twoOrgsWithPlatforms();
    await publish(mo.token, { owner: mo.username, slug: "client-email", workflow: clientEmail });
    for (const args of [
      { workflow: `${mo.username}/client-email` },
      { file: clientEmail, platforms: ["beta/open-box", "acme/back-office"] },
      { workflow: `${mo.username}/client-email`, implementation: "office" },
    ]) {
      const fitted = await call("fit_workflow", args, mo.token);
      const api = await request("POST", "/api/v1/fit", { as: { token: mo.token }, json: args });
      expect(fitted.data).toEqual(await api.json());
    }
    const fitted = await call("fit_workflow", { workflow: `${mo.username}/client-email@1`, platforms: ["beta/open-box", "acme/back-office"] }, mo.token);
    expect(fitted.text.split("\n")).toEqual([
      `${mo.username}/client-email v1:`,
      "beta/open-box v1 doesn't fit: engagements is kept at notes/engagements, which the platform doesn't hold; project is kept at notes/projects, which the platform doesn't hold",
      "acme/back-office v1 fits: choose, draft and learn may use anthropic",
    ]);
    const gaps = await call("fit_workflow", { file: workflow, platforms: ["beta/open-box"] }, mo.token);
    expect(gaps.text.split("\n")[0]).toBe("The workflow doesn't say all the fit needs:");
    expect((await call("fit_workflow", { workflow: "acme/nothing-here" }, mo.token)).text).toBe("Not found: acme/nothing-here.");
  });

  it("a member adds and reads their organisation's private platform, and the audit log records both", async () => {
    const { mo } = await twoOrgsWithPlatforms();
    const added = await call("add_platform", { owner: "acme", slug: "back-office", description: machine("back-office", "Acme back office") }, mo.token);
    expect(added.data.number).toBe(2);
    expect((await call("get_platform", { owner: "acme", slug: "back-office" }, mo.token)).data.visibility).toBe("private");
    expect(await audit("push", mo.id)).toEqual([{ target: "platforms/acme/back-office v2" }]);
    expect(await audit("private_view", mo.id)).toEqual([{ target: "platforms/acme/back-office v2" }]);
  });

  it("a non-member cannot find, read, add to or fit against a private platform: it looks not found", async () => {
    const { nell, olive } = await twoOrgsWithPlatforms();
    const hidden = await call("get_platform", { owner: "acme", slug: "back-office" }, nell.token);
    const missing = await call("get_platform", { owner: "acme", slug: "nothing-here" }, nell.token);
    expect([hidden.isError, hidden.text]).toEqual([missing.isError, missing.text]);
    expect((await call("search_platforms", {}, nell.token)).data.platforms.map((p: { slug: string }) => p.slug)).toEqual(["open-box"]);
    expect((await call("add_platform", { owner: "acme", slug: "back-office", description: worker }, nell.token)).text).toBe("Not found.");
    const named = await call("fit_workflow", { file: clientEmail, platforms: ["acme/back-office"] }, nell.token);
    expect([named.isError, named.text]).toEqual([true, "Not found: acme/back-office."]);
    const all = await call("fit_workflow", { file: clientEmail }, nell.token);
    expect(all.data.results.map((r: { platform: string }) => r.platform)).toEqual(["beta/open-box"]);
    expect((await call("get_platform", { owner: "acme", slug: "back-office" }, olive.token)).data.versions).toEqual([1]);
  });

  it("organisation A's token and OAuth session cannot search, get, add to or fit against organisation B's private platforms", async () => {
    const { mo, bea } = await twoOrgsWithPlatforms();
    const { accessToken: oauth } = await connect(mo);
    for (const bearer of [mo.token, oauth]) {
      const searched = await call("search_platforms", { query: "vault" }, bearer);
      expect([searched.data.platforms, searched.text]).toEqual([[], "No platforms."]);
      expect((await call("get_platform", { owner: "beta", slug: "vault" }, bearer)).text).toBe("Not found.");
      expect((await call("add_platform", { owner: "beta", slug: "vault", description: worker }, bearer)).text).toBe("Not found.");
      const intoPublic = await call("add_platform", { owner: "beta", slug: "open-box", description: worker }, bearer);
      expect([intoPublic.isError, intoPublic.text]).toEqual([true, "Only members of beta can push here."]);
      const fitted = await call("fit_workflow", { file: clientEmail }, bearer);
      const said = JSON.stringify(fitted);
      for (const secret of ["beta/vault", "beta-vault", "Beta vault server"]) expect(said).not.toContain(secret);
      expect(fitted.data.results.map((r: { platform: string }) => r.platform).sort()).toEqual(["acme/back-office", "beta/open-box"]);
    }
    expect((await call("get_platform", { owner: "beta", slug: "vault" }, bea.token)).data.versions).toEqual([1]);
    expect((await audit("private_view", mo.id)).map((a) => a.target)).not.toContain("platforms/beta/vault v1");
  });

  it("a person's registry token and their OAuth token answer every platform tool the same", async () => {
    const { mo } = await twoOrgsWithPlatforms();
    const { accessToken: oauth } = await connect(mo);
    const calls: [string, Record<string, unknown>][] = [
      ["search_platforms", {}],
      ["search_platforms", { query: "box" }],
      ["get_platform", { owner: "acme", slug: "back-office" }],
      ["get_platform", { owner: "beta", slug: "vault" }],
      ["get_platform", { owner: "beta", slug: "open-box", version: 1 }],
      ["fit_workflow", { file: clientEmail }],
      ["fit_workflow", { file: clientEmail, platforms: ["beta/vault"] }],
      ["add_platform", { owner: "beta", slug: "open-box", description: worker }],
    ];
    for (const [tool, args] of calls) {
      expect(await call(tool, args, oauth), `${tool} ${JSON.stringify(args)}`).toEqual(await call(tool, args, mo.token));
    }
    const byToken = await call("add_platform", { owner: "acme", slug: "back-office", description: worker }, mo.token);
    const byOAuth = await call("add_platform", { owner: "acme", slug: "back-office", description: worker }, oauth);
    expect([byToken.data.number, byOAuth.data.number]).toEqual([2, 3]);
  });
});

describe("Tokens on /mcp", () => {
  it("a revoked registry token stops working: 401 with WWW-Authenticate", async () => {
    const { mo } = await twoOrgs();
    expect((await call("get", { owner: "acme", slug: "payroll" }, mo.token)).isError).toBe(false);
    const db = await getDb();
    const [t] = await listTokens(db, mo.id);
    await revokeToken(db, mo.id, t.id);
    for (const [name, args] of [
      ["get", { owner: "acme", slug: "payroll" }],
      ["publish", { owner: "acme", slug: "payroll", workflow }],
    ] as const) {
      const res = await post("tools/call", { name, arguments: args }, mo.token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${METADATA}", error="invalid_token", error_description="The token is not valid. Sign in again."`,
      );
    }
  });

  it("a made-up token is refused", async () => {
    for (const bearer of ["awml_made-up", "not.a.jwt", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."]) {
      expect((await post("tools/list", {}, bearer)).status).toBe(401);
    }
  });
});
