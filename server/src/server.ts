import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rootLog } from "./mcp/log.ts";
import { registerListDevices } from "./mcp/tools/list_devices.ts";
import { VERSION } from "./version.ts";

const server = new McpServer({
  name: "android-debug-mcp",
  version: VERSION,
});

registerListDevices(server);

const transport = new StdioServerTransport();
await server.connect(transport);
rootLog.info("server ready", { version: VERSION, transport: "stdio" });
