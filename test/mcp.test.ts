// The MCP server at /mcp, tested the way an AI client uses it: JSON-RPC over
// HTTP, as nobody, with a registry token, or with an OAuth access token got
// through the sign-in and consent pages.
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditEvent } from "@/db/schema";
import { listTokens, revokeToken } from "@/server/tokens";
import LoginPage from "@/app/login/page";
import ConsentPage from "@/app/consent/page";
import { BASE, example, orgWith, person, request } from "./helpers";
import { renderPage } from "./pages";
import { route } from "./router";

const security = example("dinners-security.yaml");
const platform = example("dinners-platform.yaml");

const MCP = `${BASE}/mcp`;
const METADATA = `${BASE}/.well-known/oauth-protected-resource/mcp`;

type Message = {
  result?: { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } & Record<
    string,
    unknown
  >;
  error?: { code: number; message: string };
};

// One JSON-RPC request to /mcp, as an MCP client sends it over streamable HTTP.
async function post(method: string, params: unknown, bearer?: string) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return route(
    new Request(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
  );
}

// The JSON-RPC message in a response, sent as JSON or as a server-sent event.
async function message(res: Response): Promise<Message> {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.at(-1)!);
}

// A tool's answer: its text, its structured content, and whether it refused.
type Answer = { text: string; data: any; isError: boolean };

async function call(tool: string, args: Record<string, unknown>, bearer?: string): Promise<Answer> {
  const res = await post("tools/call", { name: tool, arguments: args }, bearer);
  expect(res.status, `${tool} answered ${res.status}`).toBe(200);
  const { result, error } = await message(res);
  if (error || !result) throw new Error(error?.message ?? "no result");
  return {
    text: result.content.map((c) => c.text).join("\n"),
    data: result.structuredContent,
    isError: Boolean(result.isError),
  };
}

const publish = (bearer: string | undefined, args: Record<string, unknown>) => call("publish", args, bearer);

// A page's search params as Next.js gives them: a repeated key as a list.
function searchOf(url: URL) {
  const search: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const had = search[key];
    search[key] = had === undefined ? value : [had, value].flat();
  }
  return search;
}

// Someone connecting an AI client the way Claude.ai or Claude Code does: the
// client registers itself, sends them to sign in and allow it, and swaps the
// code it gets back for an access token for /mcp.
async function connect(who: { cookie: string }, opts: { resource?: string } = { resource: MCP }) {
  const callback = "http://localhost:33418/callback";
  const registered = await request("POST", "/api/auth/oauth2/register", {
    json: {
      client_name: "Test AI",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(registered.status).toBe(201);
  const { client_id } = await registered.json();

  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: callback,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid offline_access",
    state: "s1",
    ...(opts.resource ? { resource: opts.resource } : {}),
  });

  // Signed out, authorising sends them to the sign-in page.
  const toSignIn = await request("GET", `/api/auth/oauth2/authorize?${query}`);
  expect(toSignIn.status).toBe(302);
  const signInAt = new URL(toSignIn.headers.get("location")!, BASE);
  expect(signInAt.pathname).toBe("/login");

  // Once signed in, the sign-in page sends them back to finish authorising.
  const back = await renderPage(LoginPage, {}, { as: who, search: searchOf(signInAt) });
  expect(back.status).toBe(307);
  const toConsent = await request("GET", back.location!, { as: who });
  expect(toConsent.status).toBe(302);
  const consentAt = new URL(toConsent.headers.get("location")!, BASE);
  expect(consentAt.pathname).toBe("/consent");

  // The consent page names the client, and Allow posts this.
  const page = await renderPage(ConsentPage, {}, { as: who, search: searchOf(consentAt) });
  expect(page.status).toBe(200);
  expect(page.html).toContain("Test AI");
  const allowed = await route(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consentAt.search.slice(1) }),
    }),
  );
  expect(allowed.status).toBe(200);
  const code = new URL((await allowed.json()).url).searchParams.get("code")!;

  const token = await request("POST", "/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
      client_id,
      code_verifier: verifier,
      ...(opts.resource ? { resource: opts.resource } : {}),
    },
  });
  expect(token.status).toBe(200);
  return (await token.json()).access_token as string;
}

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
  expect((await publish(olive.token, { owner: "acme", slug: "payroll", security, visibility: "private" })).isError).toBe(
    false,
  );
  expect((await publish(bea.token, { owner: "beta", slug: "secret-plans", security, visibility: "private" })).isError).toBe(
    false,
  );
  expect((await publish(bea.token, { owner: "beta", slug: "open-plans", security })).isError).toBe(false);
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
  it("answers initialize and lists its five tools to someone signed in", async () => {
    const ana = await person("ana");
    const init = await message(await post("initialize", initialize, ana.token));
    expect(init.result).toMatchObject({ serverInfo: { name: "awml-registry" }, capabilities: { tools: {} } });
    const tools = (await message(await post("tools/list", {}, ana.token))).result as unknown as {
      tools: { name: string }[];
    };
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["check", "get", "list", "publish", "search"]);
  });

  it("checks files with the engine and gives the mistakes `awml check` prints, saving nothing", async () => {
    const ana = await person("ana");
    const printed = example("bad.check.txt").trim().split("\n");
    const bad = await call("check", { security: example("bad.yaml") }, ana.token);
    expect(bad.isError).toBe(false);
    expect(bad.data.mistakes).toEqual(printed.map((line) => line.replace(/^bad\.yaml: /, "security: ")));

    const good = await call("check", { security, platform }, ana.token);
    expect(good.data.mistakes).toEqual([]);
    expect(good.text).toBe("No mistakes.");

    expect((await call("check", { platform: security }, ana.token)).data.mistakes[0]).toMatch(/^platform: /);
    expect((await call("check", {}, ana.token)).isError).toBe(true);
    expect((await call("search", {}, ana.token)).data.workflows).toEqual([]);
  });

  it("publishes a new version and gives back the workflow's page and version number", async () => {
    const ana = await person("ana");
    const first = await publish(ana.token, { owner: ana.username, slug: "dinners", security, platform });
    expect(first.isError).toBe(false);
    expect(first.data).toEqual({ owner: ana.username, slug: "dinners", number: 1, url: `${BASE}/${ana.username}/dinners` });
    expect(first.text).toContain(`${BASE}/${ana.username}/dinners`);
    const second = await publish(ana.token, { owner: ana.username, slug: "dinners", security });
    expect(second.data.number).toBe(2);
    const api = await (await request("GET", `/api/v1/${ana.username}/dinners`)).json();
    expect(api.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });

  it("refuses to publish files with mistakes, giving the messages, and saves nothing", async () => {
    const ana = await person("ana");
    const res = await publish(ana.token, { owner: ana.username, slug: "broken", security: example("bad.yaml") });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("security: ");
    expect((await request("GET", `/api/v1/${ana.username}/broken`)).status).toBe(404);
  });

  it("gets the latest version or a given one, with its YAML and summary", async () => {
    const ana = await person("ana");
    await publish(ana.token, { owner: ana.username, slug: "dinners", security });
    await publish(ana.token, { owner: ana.username, slug: "dinners", security, platform });
    const latest = await call("get", { owner: ana.username, slug: "dinners" }, ana.token);
    expect(latest.data).toMatchObject({
      owner: ana.username,
      slug: "dinners",
      title: "The family's dinners",
      visibility: "public",
      number: 2,
      versions: [2, 1],
      url: `${BASE}/${ana.username}/dinners`,
      files: { security, platform },
      summary: JSON.parse(example("dinners.summary.json")),
    });
    expect(latest.text).toContain(security);
    const first = await call("get", { owner: ana.username, slug: "dinners", version: 1 }, ana.token);
    expect(first.data).toMatchObject({ number: 1, files: { security }, url: `${BASE}/${ana.username}/dinners/v/1` });
    expect(first.data.files.platform).toBeUndefined();
    const missing = await call("get", { owner: ana.username, slug: "dinners", version: 9 }, ana.token);
    expect([missing.isError, missing.text]).toEqual([true, "Not found."]);
  });

  it("lists an owner's workflows, and with no owner the caller's own and their organisations'", async () => {
    const { mo } = await twoOrgs();
    await publish(mo.token, { owner: mo.username, slug: "dinners", security });
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
      security: security.replace("title: The family's dinners", "title: Client email"),
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
  it("publishes where the registry's authorisation server is, and that server offers registration and PKCE", async () => {
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
    } finally {
      process.env.BETTER_AUTH_URL = original;
    }
  });

  it("signs in on the sign-in page, allows the client on the consent page and gets a token that works on /mcp", async () => {
    const ana = await person("ana");
    const accessToken = await connect(ana);
    const res = await publish(accessToken, { owner: ana.username, slug: "dinners", security });
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
    const notForMcp = await connect(ana, {});
    const res = await post("tools/call", { name: "list", arguments: {} }, notForMcp);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("Positive boundary", () => {
  it("a member publishes to and reads their organisation's private workflow through /mcp, and the audit log records both", async () => {
    const { mo } = await twoOrgs();
    const pushed = await publish(mo.token, { owner: "acme", slug: "payroll", security, platform });
    expect(pushed.isError).toBe(false);
    expect(pushed.data).toMatchObject({ owner: "acme", slug: "payroll", number: 2, url: `${BASE}/acme/payroll` });
    const read = await call("get", { owner: "acme", slug: "payroll" }, mo.token);
    expect(read.data).toMatchObject({ visibility: "private", number: 2, files: { security, platform } });
    expect(await audit("push", mo.id)).toEqual([{ target: "acme/payroll v2" }]);
    expect(await audit("private_view", mo.id)).toEqual([{ target: "acme/payroll v2" }]);
  });
});

describe("Negative boundary", () => {
  it("a signed-out caller cannot publish: 401 with WWW-Authenticate pointing at the metadata, and nothing saved", async () => {
    const ana = await person("ana");
    const res = await post("tools/call", { name: "publish", arguments: { owner: ana.username, slug: "dinners", security } });
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
      ["tools/call", { name: "check", arguments: { security } }],
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
    const pushed = await publish(nell.token, { owner: "acme", slug: "payroll", security });
    expect([pushed.isError, pushed.text]).toEqual([true, "Not found."]);
    const versions = await call("get", { owner: "acme", slug: "payroll" }, olive.token);
    expect(versions.data.versions).toEqual([1]);
  });
});

describe("Cross-tenant boundary", () => {
  it("organisation A's token and OAuth session cannot list, get or publish organisation B's private workflows", async () => {
    const { mo, bea } = await twoOrgs();
    const oauth = await connect(mo);
    for (const bearer of [mo.token, oauth]) {
      expect((await call("list", { owner: "beta" }, bearer)).data.workflows.map((w: { slug: string }) => w.slug)).toEqual([
        "open-plans",
      ]);
      expect((await call("list", {}, bearer)).data.workflows.map((w: { owner: string }) => w.owner)).not.toContain("beta");
      expect((await call("get", { owner: "beta", slug: "secret-plans" }, bearer)).text).toBe("Not found.");
      expect((await publish(bearer, { owner: "beta", slug: "secret-plans", security })).text).toBe("Not found.");
      const intoPublic = await publish(bearer, { owner: "beta", slug: "open-plans", security });
      expect([intoPublic.isError, intoPublic.text]).toEqual([true, "Only members of beta can push here."]);
      expect((await publish(bearer, { owner: "beta", slug: "brand-new", security })).isError).toBe(true);
    }
    expect((await call("get", { owner: "beta", slug: "secret-plans" }, bea.token)).data.versions).toEqual([1]);
    expect((await call("get", { owner: "beta", slug: "open-plans" }, bea.token)).data.versions).toEqual([1]);
    expect(await audit("private_view", mo.id)).toEqual([]);
  });
});

describe("Token and OAuth give the same access", () => {
  it("a person's registry token and their OAuth token answer every tool the same", async () => {
    const { mo } = await twoOrgs();
    const oauth = await connect(mo);
    const reads: [string, Record<string, unknown>][] = [
      ["list", {}],
      ["list", { owner: "acme" }],
      ["list", { owner: "beta" }],
      ["get", { owner: "acme", slug: "payroll" }],
      ["get", { owner: "beta", slug: "secret-plans" }],
      ["get", { owner: "beta", slug: "open-plans", version: 1 }],
      ["search", { query: "dinners" }],
      ["check", { security }],
      ["publish", { owner: "beta", slug: "open-plans", security }],
    ];
    for (const [tool, args] of reads) {
      expect(await call(tool, args, oauth), `${tool} ${JSON.stringify(args)}`).toEqual(await call(tool, args, mo.token));
    }
    const byToken = await publish(mo.token, { owner: "acme", slug: "payroll", security });
    const byOAuth = await publish(oauth, { owner: "acme", slug: "payroll", security });
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
      ["publish", { owner: "acme", slug: "payroll", security }],
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
