// The MCP server at /mcp: a person's own AI checks, reads and publishes
// workflows as them. Every tool goes through the same functions in
// src/server as the website and the API, so it sees exactly what the person
// may see, and the audit log records the same events.
import { createMcpHandler, McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import { errors as jose, type JSONWebKeySet } from "jose";
import * as z from "zod";
import { getDb } from "@/db/client";
import { getAuth } from "./auth";
import { mcpUrl, ownUrl } from "./http";
import { organisationsOf } from "./organisations";
import { checkWorkflow, explore, ownerPage, pushVersion, readVersion } from "./registry";
import { userIdForSecret } from "./tokens";
import { viewerFor, type Viewer } from "./viewer";

type Person = NonNullable<Viewer>;

export const resourceMetadataUrl = () => ownUrl("/.well-known/oauth-protected-resource/mcp");

// A 401 that tells an MCP client where to start signing in (RFC 9728).
function challenge(message: string, error?: { code: string; description: string }) {
  const params = [`resource_metadata="${resourceMetadataUrl()}"`];
  if (error) params.push(`error="${error.code}"`, `error_description="${error.description}"`);
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status: 401, headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` } },
  );
}

const SIGN_IN = `Sign in to use the AWML registry: connect with OAuth, or send a registry token from ${ownUrl("/settings/tokens")} as Authorization: Bearer <token>.`;

// The user an OAuth access token acts as: a JWT this registry signed for /mcp,
// sender-bound when the client used DPoP. Null when it is not one.
async function oauthUserId(req: Request, authorization: { scheme: "Bearer" | "DPoP"; token: string }) {
  const auth = await getAuth();
  const { baseURL, internalAdapter } = await auth.$context;
  try {
    const payload = await verifyJwsAccessToken(authorization.token, {
      jwksFetch: async () => (await auth.api.getJwks()) as JSONWebKeySet,
      jwksCacheKey: auth,
      verifyOptions: { issuer: baseURL, audience: mcpUrl(), typ: "at+jwt", requiredClaims: ["sub", "azp"] },
    });
    await enforceDpopBinding({
      payload,
      authorization,
      proofJwt: req.headers.get("dpop"),
      method: req.method,
      url: req.url,
      replayStore: createDpopReplayStore(internalAdapter),
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch (error) {
    // A token that is not a JWT at all makes jose throw a TypeError.
    if (error instanceof jose.JOSEError || error instanceof TypeError || isDpopBindingError(error)) return null;
    throw error;
  }
}

// Who is calling: the user of a registry token or of an OAuth access token.
// Anything else is answered with a 401, so a client that connects without a
// token learns at once where to sign in.
async function caller(req: Request): Promise<{ person: Person; authInfo: AuthInfo } | Response> {
  const authorization = parseAccessTokenAuthorization(req.headers.get("authorization"));
  if (!authorization?.token) return challenge(SIGN_IN);
  const invalid = () =>
    challenge(SIGN_IN, { code: "invalid_token", description: "The token is not valid. Sign in again." });
  if (authorization.scheme === "Unknown") return invalid();
  const db = await getDb();
  const userId =
    authorization.scheme === "Bearer" && authorization.token.startsWith("awml_")
      ? await userIdForSecret(db, authorization.token)
      : await oauthUserId(req, authorization as { scheme: "Bearer" | "DPoP"; token: string });
  const person = userId ? await viewerFor(db, userId) : null;
  if (!person) return invalid();
  return { person, authInfo: { token: authorization.token, clientId: "awml", scopes: [], extra: { person } } };
}

const answer = (text: string, data?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(data ? { structuredContent: data } : {}),
});
const refused = (errors: string[]): CallToolResult => ({ content: [{ type: "text", text: errors.join("\n") }], isError: true });
const NOT_FOUND = refused(["Not found."]);

const page = (owner: string, slug: string) => ownUrl(`/${owner}/${slug}`);

const yamlFile = (view: string) =>
  z.string().optional().describe(`The ${view} file (view: ${view}), as YAML text. Send this file, the other or both.`);
const owner = z.string().describe("A username or an organisation's slug, as in awml.io/owner/slug");
const slug = z.string().describe("The workflow's slug: lowercase letters, digits and single hyphens");

type Listed = { owner: string; slug: string; title: string; visibility?: string; updatedAt: Date };
const listing = (rows: Listed[]) => {
  const workflows = rows.map((w) => ({ ...w, updatedAt: w.updatedAt.toISOString(), url: page(w.owner, w.slug) }));
  const text = workflows.length
    ? workflows
        .map((w) => `${w.owner}/${w.slug}${w.visibility ? ` (${w.visibility})` : ""}: ${w.title}. ${w.url}`)
        .join("\n")
    : "No workflows.";
  return answer(text, { workflows });
};

function server(person: Person) {
  const s = new McpServer(
    { name: "awml-registry", version: "1.0.0" },
    {
      instructions:
        "The AWML registry stores and draws AWML workflows. Use check to find mistakes in a workflow's YAML, " +
        "publish to save a new version of owner/slug, get to read one, list for an owner's workflows and " +
        "search for public ones. Every call acts as the signed-in person.",
    },
  );

  s.registerTool(
    "check",
    {
      title: "Check a workflow",
      description:
        "Check an AWML workflow's security file, platform file or both with the registry's AWML engine, the same check `awml check` runs. Gives the mistakes, or none. Saves nothing.",
      inputSchema: z.object({ security: yamlFile("security"), platform: yamlFile("platform") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ security, platform }) => {
      const checked = await checkWorkflow({ security, platform });
      if (!checked.ok) return refused(checked.errors);
      const { mistakes } = checked;
      const text = mistakes.length
        ? `${mistakes.length} ${mistakes.length === 1 ? "mistake" : "mistakes"}:\n${mistakes.join("\n")}`
        : "No mistakes.";
      return answer(text, { mistakes });
    },
  );

  s.registerTool(
    "publish",
    {
      title: "Publish a workflow",
      description:
        "Save a new version of the workflow owner/slug from its security file, platform file or both. The files are checked first and refused if they have mistakes. The owner is your own username or an organisation you belong to. The first version sets whether the workflow is public or private, and only an organisation can keep a private one. Gives the workflow's page and the new version number.",
      inputSchema: z.object({
        owner,
        slug,
        security: yamlFile("security"),
        platform: yamlFile("platform"),
        visibility: z
          .enum(["public", "private"])
          .optional()
          .describe("Only for the first version. Default public. Private needs an organisation."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ owner, slug, security, platform, visibility }) => {
      const db = await getDb();
      const pushed = await pushVersion(db, person, owner, slug, { security, platform, visibility });
      if (!pushed.ok) return refused(pushed.errors);
      const url = page(pushed.owner, pushed.slug);
      return answer(`Saved version ${pushed.number} of ${pushed.owner}/${pushed.slug}: ${url}`, {
        owner: pushed.owner,
        slug: pushed.slug,
        number: pushed.number,
        url,
      });
    },
  );

  s.registerTool(
    "get",
    {
      title: "Read a workflow",
      description:
        "Read a workflow's YAML files, its check result and its summary: the latest version, or the version given.",
      inputSchema: z.object({
        owner,
        slug,
        version: z.number().int().positive().optional().describe("A version number. Default: the latest."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ owner, slug, version }) => {
      const db = await getDb();
      const v = await readVersion(db, person, owner, slug, version ?? "latest");
      if (!v) return NOT_FOUND;
      const url = version === undefined ? page(v.owner, v.slug) : ownUrl(`/${v.owner}/${v.slug}/v/${v.number}`);
      const versions = v.versions.map((x) => x.number);
      const files = Object.entries(v.files).map(([view, yaml]) => `${view}.yaml:\n${yaml}`);
      const text = [
        `${v.title}: ${v.owner}/${v.slug}, version ${v.number} of ${versions[0]}, ${v.visibility}. ${url}`,
        ...files,
        `Summary: ${JSON.stringify(v.summary)}`,
      ].join("\n\n");
      return answer(text, {
        owner: v.owner,
        slug: v.slug,
        title: v.title,
        visibility: v.visibility,
        number: v.number,
        versions,
        url,
        pushedAt: v.pushedAt.toISOString(),
        pushedBy: v.pushedBy,
        files: v.files,
        check: v.check,
        summary: v.summary,
      });
    },
  );

  s.registerTool(
    "list",
    {
      title: "List workflows",
      description:
        "List an owner's workflows that you may see: public ones, and private ones of organisations you belong to. With no owner, lists your own workflows and your organisations'.",
      inputSchema: z.object({ owner: owner.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ owner }) => {
      const db = await getDb();
      const owners = owner
        ? [owner]
        : [person.username, ...(await organisationsOf(db, person.id)).map((o) => o.slug)];
      const rows: Listed[] = [];
      for (const o of owners) {
        const found = await ownerPage(db, person, o);
        if (!found) return NOT_FOUND;
        rows.push(...found.workflows.map((w) => ({ owner: found.owner.slug, ...w })));
      }
      return listing(rows);
    },
  );

  s.registerTool(
    "search",
    {
      title: "Search public workflows",
      description: "Search the public gallery by title, newest first. With no query, gives the newest public workflows.",
      inputSchema: z.object({ query: z.string().optional().describe("Words in the title") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const found = await explore(await getDb(), query ?? "");
      return listing(found.map(({ owner, slug, title, updatedAt }) => ({ owner, slug, title, updatedAt })));
    },
  );

  return s;
}

const handler = createMcpHandler(({ authInfo }) => server(authInfo?.extra?.person as Person));

export async function handleMcp(req: Request): Promise<Response> {
  const who = await caller(req);
  if (who instanceof Response) return who;
  return handler.fetch(req, { authInfo: who.authInfo });
}
