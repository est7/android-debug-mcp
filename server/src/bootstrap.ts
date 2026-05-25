import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rootLog } from "./mcp/log.ts";
import { registerAppControl } from "./mcp/tools/app_control.ts";
import { registerCapture } from "./mcp/tools/capture.ts";
import { registerClearAppData } from "./mcp/tools/clear_app_data.ts";
import { registerCollectBundle } from "./mcp/tools/collect_bundle.ts";
import { registerExtractCrashContext } from "./mcp/tools/extract_crash_context.ts";
import { registerGetAppState } from "./mcp/tools/get_app_state.ts";
import { registerGetRunSummary } from "./mcp/tools/get_run_summary.ts";
import { registerInputText } from "./mcp/tools/input_text.ts";
import { registerListDevices } from "./mcp/tools/list_devices.ts";
import { registerListElements } from "./mcp/tools/list_elements.ts";
import { registerListRuns } from "./mcp/tools/list_runs.ts";
import { registerMapUiNodeToSource } from "./mcp/tools/map_ui_node_to_source.ts";
import { registerMarkEvent } from "./mcp/tools/mark_event.ts";
import { registerSearchLogs } from "./mcp/tools/search_logs.ts";
import { registerSendKey } from "./mcp/tools/send_key.ts";
import { registerStartSession } from "./mcp/tools/start_session.ts";
import { registerStopSession } from "./mcp/tools/stop_session.ts";
import { registerSwipe } from "./mcp/tools/swipe.ts";
import { registerTap } from "./mcp/tools/tap.ts";
import { registerTapNode } from "./mcp/tools/tap_node.ts";
import { recoverOrphans } from "./recovery/scan.ts";
import { HealthMonitor } from "./session/health.ts";
import { SessionManager } from "./session/manager.ts";
import { resolveRunRoot } from "./store/paths.ts";
import { VERSION } from "./version.ts";

/** The registered tool inventory size — kept in sync with `ANDROID_DEBUG_TOOL_NAMES`. */
const TOOL_COUNT = 20;

/**
 * Build the server, register every tool, recover orphaned runs, and connect
 * the stdio transport.
 *
 * Orphan recovery (§ C-5) runs strictly BEFORE `connect()` — once the transport
 * is live a client could call `start_session`, and a tuple still being
 * recovered must not be raced. Recovery is best-effort: a scan failure is
 * logged and the server still serves (the orphans are retried next boot).
 */
export async function bootstrap(): Promise<void> {
  const server = new McpServer({ name: "android-debug-mcp", version: VERSION });
  const manager = new SessionManager();
  registerAllTools(server, manager);

  const { runRoot } = resolveRunRoot();
  try {
    const report = await recoverOrphans(runRoot);
    if (report.orphans > 0) {
      rootLog.info("orphan recovery", {
        scanned: report.scanned,
        orphans: report.orphans,
        outcomes: report.outcomes.map((o) => `${o.runId}:${o.kind}`),
      });
    }
  } catch (err) {
    rootLog.error("orphan recovery scan failed; serving anyway", { error: String(err) });
  }

  // Device-connectivity poll: flips a session to `degraded` when its device
  // drops. Runs for the server's lifetime; the timer is unref'd so it never
  // keeps the process alive on its own.
  new HealthMonitor(manager).start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  rootLog.info("server ready", { version: VERSION, transport: "stdio", tools: TOOL_COUNT });
}

/** Register the full tool inventory through the contract-enforcing helper. */
export function registerAllTools(server: McpServer, manager: SessionManager): void {
  registerListDevices(server);
  registerStartSession(server, manager);
  registerStopSession(server, manager);
  registerMarkEvent(server, manager);
  registerAppControl(server, manager);
  registerClearAppData(server, manager);
  registerGetAppState(server, manager);
  registerTap(server, manager);
  registerTapNode(server, manager);
  registerMapUiNodeToSource(server, manager);
  registerListElements(server, manager);
  registerInputText(server, manager);
  registerSendKey(server, manager);
  registerSwipe(server, manager);
  registerCapture(server, manager);
  registerSearchLogs(server, manager);
  registerExtractCrashContext(server, manager);
  registerGetRunSummary(server, manager);
  registerListRuns(server, manager);
  registerCollectBundle(server, manager);
}
