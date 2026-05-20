import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ANDROID_DEBUG_TOOL_NAMES,
  type AndroidDebugToolName,
  DESCRIPTION_REQUIRED_MARKERS,
  TOOL_NAME_PREFIX,
} from "./constants.ts";
import { ToolDomainError } from "./toolError.ts";

/**
 * All four annotation hints are mandatory (§ G-6 + § G-8). `openWorldHint` is
 * always true for this server because every tool touches a real device or FS,
 * but we still require it to be explicit at the call site.
 */
export interface DebugToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface DebugToolConfig<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  /** Short human-readable name shown to client UIs. */
  readonly title: string;
  /**
   * Long description. MUST contain the four marker substrings declared in
   * {@link DESCRIPTION_REQUIRED_MARKERS}; otherwise registration throws.
   */
  readonly description: string;
  /** Zod object schema; MUST be built with `.strict()` so unknown keys are rejected. */
  readonly inputSchema: I;
  /** Zod schema for `structuredContent`. Handler return is parsed through this. */
  readonly outputSchema: O;
  /** Four-hint annotation matrix (see § G-8). */
  readonly annotations: DebugToolAnnotations;
}

export interface DebugToolResult<O extends z.ZodTypeAny> {
  /** Structured payload; will be validated via outputSchema.parse() before send. */
  readonly structuredContent: z.input<O>;
  /**
   * Optional human-readable content blocks. If omitted, a single text block
   * containing JSON-stringified structuredContent is synthesized for clients
   * that ignore structuredContent.
   */
  readonly content?: ReadonlyArray<{ type: "text"; text: string }>;
}

export type DebugToolHandler<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = (
  input: z.output<I>,
) => Promise<DebugToolResult<O>> | DebugToolResult<O>;

export class ToolRegistrationError extends Error {
  constructor(toolName: string, reason: string) {
    super(`registerDebugTool(${toolName}): ${reason}`);
    this.name = "ToolRegistrationError";
  }
}

/**
 * Compile-time + boot-time contract for every MCP tool exposed by this server.
 *
 * Why this exists (§ G-6): manually calling `server.registerTool(...)` for 17
 * tools makes it easy to forget annotations, description structure, or strict
 * input schemas. This helper fails fast at boot when any of those are missing,
 * so the cost of getting it wrong is "server doesn't start" rather than "agent
 * sees a tool with subtly broken contract at runtime".
 */
/** Shape returned to the SDK by {@link wrapToolHandler}. */
export interface WrappedToolResult {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/**
 * Wrap a {@link DebugToolHandler} with the v1 result/error transport. Extracted
 * from {@link registerDebugTool} so the transport (which is not just
 * registration glue) is independently unit-testable.
 *
 *   - success → `outputSchema.parse(structuredContent)` then `{content,
 *     structuredContent}`.
 *   - `ToolDomainError` → `{content:[text], isError:true}` with NO
 *     `structuredContent` (open decision #13: a domain failure is a normal
 *     tool result the agent branches on; the error payload would not satisfy
 *     the declared success outputSchema).
 *   - any other throw → re-thrown as a genuine bug → JSON-RPC protocol error.
 */
export function wrapToolHandler<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  config: DebugToolConfig<I, O>,
  handler: DebugToolHandler<I, O>,
): (input: z.output<I>) => Promise<WrappedToolResult> {
  return async (input: z.output<I>): Promise<WrappedToolResult> => {
    try {
      const result = await handler(input);
      const parsedStructured = config.outputSchema.parse(result.structuredContent) as Record<
        string,
        unknown
      >;
      const content = result.content
        ? [...result.content]
        : [{ type: "text" as const, text: JSON.stringify(parsedStructured) }];
      return { content, structuredContent: parsedStructured };
    } catch (err) {
      if (err instanceof ToolDomainError) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(err.toPayload()) }],
          isError: true,
        };
      }
      throw err;
    }
  };
}

export function registerDebugTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  server: McpServer,
  name: string,
  config: DebugToolConfig<I, O>,
  handler: DebugToolHandler<I, O>,
): void {
  assertValidName(name);
  assertDescriptionShape(name, config.description);
  assertStrictInputObject(name, config.inputSchema);
  assertObjectOutputSchema(name, config.outputSchema);
  assertAnnotationsComplete(name, config.annotations);

  const wrappedHandler = wrapToolHandler(config, handler);

  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      annotations: { ...config.annotations },
    },
    wrappedHandler as Parameters<typeof server.registerTool>[2],
  );
}

function assertValidName(name: string): void {
  if (!name.startsWith(TOOL_NAME_PREFIX)) {
    throw new ToolRegistrationError(
      name,
      `tool name must start with "${TOOL_NAME_PREFIX}" (§ G-1).`,
    );
  }
  if (!(ANDROID_DEBUG_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new ToolRegistrationError(
      name,
      "tool name is not in the v1 inventory ANDROID_DEBUG_TOOL_NAMES (§ G-Final). Add it there explicitly before registering.",
    );
  }
}

function assertDescriptionShape(name: string, description: string): void {
  const missing = DESCRIPTION_REQUIRED_MARKERS.filter((m) => !description.includes(m));
  if (missing.length > 0) {
    throw new ToolRegistrationError(
      name,
      `description is missing required marker(s): ${missing.join(", ")} (§ G-6).`,
    );
  }
}

function assertStrictInputObject(name: string, schema: z.ZodTypeAny): void {
  if (!(schema instanceof z.ZodObject)) {
    throw new ToolRegistrationError(
      name,
      "inputSchema must be a ZodObject built with .strict() (§ G-4).",
    );
  }
  // Zod 3 stores the unknown-key policy on the internal `_def.unknownKeys`
  // field. There is no stable public API for reading it, and a probe-style
  // `safeParse({__probe:1})` cannot distinguish "rejected unknown key" from
  // "rejected because required field missing" for schemas with required props.
  // Revisit if we ever upgrade to Zod 4, which exposes `def.catchall` instead.
  const def = (schema as z.ZodObject<z.ZodRawShape>)._def as { unknownKeys?: string };
  if (def.unknownKeys !== "strict") {
    throw new ToolRegistrationError(
      name,
      "inputSchema must call .strict() to reject unknown keys (§ G-4).",
    );
  }
}

function assertObjectOutputSchema(name: string, schema: z.ZodTypeAny): void {
  // MCP `structuredContent` is contractually a JSON object; the SDK builds the
  // tool's outputSchema by JSON-Schema-ifying this. Allowing a top-level
  // `z.array(...)` / `z.string()` would emit a malformed outputSchema that
  // clients reject (or worse, silently downgrade to the legacy text channel).
  if (!(schema instanceof z.ZodObject)) {
    throw new ToolRegistrationError(
      name,
      "outputSchema must be a ZodObject (MCP structuredContent is an object contract).",
    );
  }
}

function assertAnnotationsComplete(name: string, annotations: DebugToolAnnotations): void {
  const required: Array<keyof DebugToolAnnotations> = [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ];
  for (const key of required) {
    if (typeof annotations[key] !== "boolean") {
      throw new ToolRegistrationError(
        name,
        `annotations.${key} must be an explicit boolean (§ G-8).`,
      );
    }
  }
}

/** Re-exported for test-side assertions. */
export type { AndroidDebugToolName };
