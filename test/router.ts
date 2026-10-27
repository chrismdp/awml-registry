// Maps a request to the app's route handler, the way Next.js does, so tests
// talk HTTP: a Request in, a Response out.
import * as auth from "@/app/api/auth/[...all]/route";
import * as workflowApi from "@/app/api/v1/[owner]/[slug]/route";
import * as versionsApi from "@/app/api/v1/[owner]/[slug]/versions/route";
import * as versionApi from "@/app/api/v1/[owner]/[slug]/v/[n]/route";
import * as forkApi from "@/app/api/v1/[owner]/[slug]/fork/route";
import * as yamlFile from "@/app/[owner]/[slug]/v/[n]/[file]/route";
import * as platformApi from "@/app/api/v1/platforms/[owner]/[slug]/route";
import * as platformVersionsApi from "@/app/api/v1/platforms/[owner]/[slug]/versions/route";
import * as platformVersionApi from "@/app/api/v1/platforms/[owner]/[slug]/v/[n]/route";
import * as pullPlatformApi from "@/app/api/v1/[owner]/platforms/[slug]/route";
import * as pullPlatformVersionApi from "@/app/api/v1/[owner]/platforms/[slug]/v/[n]/route";
import * as platformFile from "@/app/[owner]/platforms/[slug]/v/[n]/[file]/route";
import * as oldPlatformFile from "@/app/platforms/[owner]/[slug]/v/[n]/[file]/route";
import * as fitApi from "@/app/api/v1/fit/route";
import * as meApi from "@/app/api/v1/me/route";
import * as orgs from "@/app/api/orgs/route";
import * as members from "@/app/api/orgs/[org]/members/route";
import * as removeMember from "@/app/api/orgs/[org]/members/[userId]/remove/route";
import * as mcp from "@/app/mcp/route";
import * as explore from "@/app/explore/route";
import * as protectedResource from "@/app/.well-known/oauth-protected-resource/[[...path]]/route";
import * as authorisationServer from "@/app/.well-known/oauth-authorization-server/[[...path]]/route";

// An optional catch-all segment, [[...path]], comes as a list of segments.
type Handler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
type Module = Partial<Record<"GET" | "POST" | "PATCH", Handler>>;

const routes: [RegExp, Module][] = [
  [/^\/api\/auth\/(?<all>.+)$/, auth as Module],
  // A path's fixed segments come before its placeholders, as in Next.js.
  [/^\/api\/v1\/fit$/, fitApi as Module],
  [/^\/api\/v1\/me$/, meApi as Module],
  [/^\/api\/v1\/platforms\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/versions$/, platformVersionsApi as Module],
  [/^\/api\/v1\/platforms\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/v\/(?<n>[^/]+)$/, platformVersionApi as Module],
  [/^\/api\/v1\/platforms\/(?<owner>[^/]+)\/(?<slug>[^/]+)$/, platformApi as Module],
  [/^\/api\/v1\/(?<owner>[^/]+)\/platforms\/(?<slug>[^/]+)\/v\/(?<n>[^/]+)$/, pullPlatformVersionApi as Module],
  [/^\/api\/v1\/(?<owner>[^/]+)\/platforms\/(?<slug>[^/]+)$/, pullPlatformApi as Module],
  [/^\/platforms\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/v\/(?<n>[^/]+)\/(?<file>[^/]+)$/, oldPlatformFile as Module],
  [/^\/(?<owner>[^/]+)\/platforms\/(?<slug>[^/]+)\/v\/(?<n>[^/]+)\/(?<file>[^/]+)$/, platformFile as Module],
  [/^\/api\/v1\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/versions$/, versionsApi as Module],
  [/^\/api\/v1\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/fork$/, forkApi as Module],
  [/^\/api\/v1\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/v\/(?<n>[^/]+)$/, versionApi as Module],
  [/^\/api\/v1\/(?<owner>[^/]+)\/(?<slug>[^/]+)$/, workflowApi as Module],
  [/^\/api\/orgs$/, orgs as Module],
  [/^\/api\/orgs\/(?<org>[^/]+)\/members$/, members as Module],
  [/^\/api\/orgs\/(?<org>[^/]+)\/members\/(?<userId>[^/]+)\/remove$/, removeMember as Module],
  [/^\/mcp$/, mcp as Module],
  [/^\/explore$/, explore as Module],
  [/^\/\.well-known\/oauth-protected-resource(?:\/(?<path>.+))?$/, protectedResource as Module],
  [/^\/\.well-known\/oauth-authorization-server(?:\/(?<path>.+))?$/, authorisationServer as Module],
  [/^\/(?<owner>[^/]+)\/(?<slug>[^/]+)\/v\/(?<n>[^/]+)\/(?<file>[^/]+)$/, yamlFile as Module],
];

export async function route(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  for (const [pattern, mod] of routes) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const handler = mod[req.method as "GET" | "POST" | "PATCH"];
    if (!handler) return new Response(null, { status: 405 });
    const params = Object.fromEntries(
      Object.entries(match.groups ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, k === "path" ? v.split("/").map(decodeURIComponent) : decodeURIComponent(v)]),
    );
    return handler(req, { params: Promise.resolve(params) });
  }
  return new Response(null, { status: 404 });
}
