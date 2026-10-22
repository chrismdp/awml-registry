// The MCP server, over streamable HTTP. See src/server/mcp.ts.
import { handleMcp } from "@/server/mcp";

const handle = (req: Request) => handleMcp(req);

export { handle as GET, handle as POST, handle as DELETE };
