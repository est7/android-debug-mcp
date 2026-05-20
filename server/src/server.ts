import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rootLog } from "./mcp/log.ts";
import { registerAppControl } from "./mcp/tools/app_control.ts";
import { registerClearAppData } from "./mcp/tools/clear_app_data.ts";
import { registerGetAppState } from "./mcp/tools/get_app_state.ts";
import { registerListDevices } from "./mcp/tools/list_devices.ts";
import { registerMarkEvent } from "./mcp/tools/mark_event.ts";
import { registerStartSession } from "./mcp/tools/start_session.ts";
import { registerStopSession } from "./mcp/tools/stop_session.ts";
import { SessionManager } from "./session/manager.ts";
import { VERSION } from "./version.ts";

const server = new McpServer({
  name: "android-debug-mcp",
  version: VERSION,
});

// One process-wide session registry, shared by every session-scoped tool.
const sessionManager = new SessionManager();

registerListDevices(server);
registerStartSession(server, sessionManager);
registerStopSession(server, sessionManager);
registerMarkEvent(server, sessionManager);
registerAppControl(server, sessionManager);
registerClearAppData(server, sessionManager);
registerGetAppState(server, sessionManager);

const transport = new StdioServerTransport();
await server.connect(transport);
rootLog.info("server ready", { version: VERSION, transport: "stdio", tools: 7 });
