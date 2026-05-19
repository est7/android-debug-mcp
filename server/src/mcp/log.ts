type LogLevel = "debug" | "info" | "warn" | "error";

const DEBUG_ENV = process.env.DEBUG ?? "";
const DEBUG_PATTERNS = DEBUG_ENV.split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

function matchesDebug(scope: string): boolean {
  if (DEBUG_PATTERNS.length === 0) return false;
  for (const pattern of DEBUG_PATTERNS) {
    if (pattern === "*") return true;
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -1);
      if (scope.startsWith(prefix)) return true;
    }
    if (pattern === scope) return true;
  }
  return false;
}

/**
 * stdio MCP servers cannot write to stdout (it carries the JSON-RPC stream).
 * All structured logging goes to stderr as one-line JSON objects.
 */
function emit(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (level === "debug" && !matchesDebug(scope)) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
  };
  if (fields !== undefined) {
    for (const [k, v] of Object.entries(fields)) {
      if (k in entry) continue;
      entry[k] = v;
    }
  }
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // last-resort: never let logging crash the server
  }
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(extraScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
    child: (extraScope) => createLogger(`${scope}:${extraScope}`),
  };
}

/** Root logger for the server. Sub-modules should create their own via {@link createLogger}. */
export const rootLog: Logger = createLogger("android-debug-mcp");
