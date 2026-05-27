import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "android-debug-tools/**",
      "android-mcp-server/**",
      "Android-MCP/**",
    ],
    setupFiles: ["server/tests/setup.ts"],
    passWithNoTests: true,
  },
});
