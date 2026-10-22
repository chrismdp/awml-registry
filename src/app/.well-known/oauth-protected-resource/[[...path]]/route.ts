// RFC 9728 protected resource metadata for /mcp, at the root and at
// /mcp's own path. Better Auth's MCP plugin writes it; any other path is a 404.
import { getAuth } from "@/server/auth";

export async function GET(req: Request) {
  return (await getAuth()).handler(req);
}
