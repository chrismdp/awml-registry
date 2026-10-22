// RFC 8414 authorisation server metadata. The issuer is /api/auth, so clients
// look for it at /.well-known/oauth-authorization-server/api/auth; clients of
// the 2025-03-26 MCP spec look at the root. Both get Better Auth's metadata.
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/server/auth";

export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  if (path.length && path.join("/") !== "api/auth") return new Response(null, { status: 404 });
  return oauthProviderAuthServerMetadata(await getAuth())(req);
}
