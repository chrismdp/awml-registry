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
import { fitWorkflow, type Fit } from "./fit";
import { organisationsOf } from "./organisations";
import { pushPlatformVersion, readPlatformVersion, searchPlatforms } from "./platforms";
import { checkWorkflow, explore, ownerPage, pushVersion, readVersion } from "./registry";
import { userIdForSecret } from "./tokens";
import { savedNotice, setUsername } from "./usernames";
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
const owner = z.string().describe("A username or an organisation's slug, as in <registry>/owner/slug");
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

const platformUrl = (owner: string, slug: string, number?: number) =>
  ownUrl(`/api/v1/platforms/${owner}/${slug}${number === undefined ? "" : `/v/${number}`}`);

// The AI steps that may use the same companies, as `awml fit` says it:
// "choose, draft and learn may use anthropic".
function mayUse(models: Record<string, string[]>) {
  const byCompanies = new Map<string, string[]>();
  for (const [step, companies] of Object.entries(models)) {
    const key = companies.join(" and ");
    byCompanies.set(key, [...(byCompanies.get(key) ?? []), step]);
  }
  const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]);
  return [...byCompanies].map(([companies, steps]) => `${list(steps)} may use ${companies}`).join("; ");
}

function fitText(fit: Fit) {
  if (fit.gaps.length) return ["The workflow doesn't say all the fit needs:", ...fit.gaps].join("\n");
  const lines = fit.workflow ? [`${fit.workflow.owner}/${fit.workflow.slug} v${fit.workflow.number}:`] : [];
  if (!fit.results.length) lines.push("No platforms to fit against.");
  for (const r of fit.results) {
    const where = `${r.platform} v${r.number}`;
    if (r.fits) lines.push(`${where} fits${Object.keys(r.models).length ? `: ${mayUse(r.models)}` : ""}`);
    else lines.push(`${where} doesn't fit: ${r.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

function server(person: Person) {
  const s = new McpServer(
    { name: "awml-registry", version: "1.0.0" },
    {
      instructions:
        "The AWML registry stores and draws AWML workflows, and the platforms they can run on. Use check to find " +
        "mistakes in a workflow's YAML, publish to save a new version of owner/slug, get to read one, list for an " +
        "owner's workflows and search for public ones. Use search_platforms and get_platform to find platforms and " +
        "read their descriptions and install recipes, add_platform to save one, and fit_workflow to find where a " +
        "workflow can run. Use set_username to change the signed-in person's own username. Every call acts as the " +
        "signed-in person.",
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

  const platformSlug = z.string().describe("The platform's slug: lowercase letters, digits and single hyphens");

  s.registerTool(
    "search_platforms",
    {
      title: "Search platforms",
      description:
        "Search the platforms you may see by words in their label or slug, newest first: public platforms, and the private ones of organisations you belong to. With no query, gives them all.",
      inputSchema: z.object({ query: z.string().optional().describe("Words in the label or slug") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const found = await searchPlatforms(await getDb(), person, query ?? "");
      const platforms = found.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() }));
      const text = platforms.length
        ? platforms.map((p) => `${p.owner}/${p.slug} (${p.visibility}): ${p.label}`).join("\n")
        : "No platforms.";
      return answer(text, { platforms });
    },
  );

  s.registerTool(
    "get_platform",
    {
      title: "Read a platform",
      description:
        "Read a platform's description (AWML's platform description, as YAML) and its install recipe (Markdown steps an agent follows to install a workflow there), the latest version or the version given.",
      inputSchema: z.object({
        owner,
        slug: platformSlug,
        version: z.number().int().positive().optional().describe("A version number. Default: the latest."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ owner, slug, version }) => {
      const db = await getDb();
      const p = await readPlatformVersion(db, person, owner, slug, version ?? "latest");
      if (!p) return NOT_FOUND;
      const versions = p.versions.map((x) => x.number);
      const text = [
        `${p.label}: platform ${p.owner}/${p.slug}, version ${p.number} of ${versions[0]}, ${p.visibility}.`,
        `description.yaml:\n${p.description}`,
        p.recipe === null ? "No install recipe." : `recipe.md:\n${p.recipe}`,
      ].join("\n\n");
      return answer(text, {
        owner: p.owner,
        slug: p.slug,
        label: p.label,
        visibility: p.visibility,
        number: p.number,
        versions,
        url: platformUrl(p.owner, p.slug, version === undefined ? undefined : p.number),
        pushedAt: p.pushedAt.toISOString(),
        pushedBy: p.pushedBy,
        description: p.description,
        recipe: p.recipe,
      });
    },
  );

  s.registerTool(
    "add_platform",
    {
      title: "Add a platform",
      description:
        "Save a new version of the platform owner/slug from its description, and its install recipe if it has one. The description is checked first and refused if it has mistakes. A recipe says what to create, where each secret goes, how to schedule the triggers and how to check the workflow runs; it must never hold a secret itself. The owner is your own username or an organisation you belong to. The first version sets whether the platform is public or private, and only an organisation can keep a private one.",
      inputSchema: z.object({
        owner,
        slug: platformSlug,
        description: z.string().describe("The platform description, as YAML: awml, platform, off_for_up_to, steps, agents, calls, holds"),
        recipe: z.string().optional().describe("The install recipe, as Markdown. Never a secret."),
        visibility: z
          .enum(["public", "private"])
          .optional()
          .describe("Only for the first version. Default public. Private needs an organisation."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ owner, slug, description, recipe, visibility }) => {
      const db = await getDb();
      const pushed = await pushPlatformVersion(db, person, owner, slug, { description, recipe, visibility });
      if (!pushed.ok) return refused(pushed.errors);
      const url = platformUrl(pushed.owner, pushed.slug, pushed.number);
      return answer(`Saved version ${pushed.number} of the platform ${pushed.owner}/${pushed.slug}: ${url}`, {
        owner: pushed.owner,
        slug: pushed.slug,
        number: pushed.number,
        url,
      });
    },
  );

  s.registerTool(
    "fit_workflow",
    {
      title: "Find where a workflow can run",
      description:
        "Judge a workflow's security view against platforms with the AWML engine, as `awml fit` does: for each platform, whether the workflow fits, every reason it doesn't, and the companies each AI step may use there. Name the workflow as owner/slug or owner/slug@version, or send its security view as YAML. Name the platforms as owner/slug or owner/slug@version, or leave them out to fit against every platform you may see. When the workflow doesn't say all the fit needs, gives the gaps instead.",
      inputSchema: z.object({
        workflow: z.string().optional().describe("owner/slug or owner/slug@version"),
        security: z.string().optional().describe("The security view, as YAML, in place of a workflow"),
        platforms: z.array(z.string()).optional().describe("Platforms as owner/slug or owner/slug@version. Default: every one you may see."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workflow, security, platforms }) => {
      const fitted = await fitWorkflow(await getDb(), person, { workflow, security, platforms });
      if (!fitted.ok) return refused(fitted.errors);
      return answer(fitText(fitted.fit), fitted.fit);
    },
  );

  s.registerTool(
    "set_username",
    {
      title: "Set your username",
      description:
        "Change your own username, the name in the address of your page and of your workflows and platforms, as in <registry>/username/slug. It follows the rules of an organisation's slug: 1 to 40 lowercase letters, digits and single hyphens, not reserved, and not taken by a person or an organisation. Your workflows and platforms move with you, and links to your old name redirect to the new one until someone else takes it. Gives your new username, the old one and your page.",
      inputSchema: z.object({
        username: z.string().describe("The new username: lowercase letters, digits and single hyphens"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ username }) => {
      const saved = await setUsername(await getDb(), person.id, username);
      if (!saved.ok) return refused(saved.errors);
      return answer(savedNotice(saved), { username: saved.username, previous: saved.previous, url: ownUrl(`/${saved.username}`) });
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
