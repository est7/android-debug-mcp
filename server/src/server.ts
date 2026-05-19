import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./version.ts";

const server = new McpServer({
  name: "android-debug-mcp",
  version: VERSION,
});

const transport = new StdioServerTransport();
await server.connect(transport);
