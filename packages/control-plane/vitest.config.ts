import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // @cloudflare/containers (a transitive dep of @cloudflare/sandbox,
    // imported at module scope by cloudflare-provider.ts) only runs inside
    // the real workerd runtime — it imports the "cloudflare:workers" builtin
    // module, which doesn't exist under plain Node. Every unit test now
    // transitively pulls in provider-factory.ts, so this global mock keeps
    // Node-environment unit tests from ever touching the real package.
    // Sandbox-provider-specific tests (cloudflare-provider.test.ts) layer
    // their own more detailed per-file vi.mock("@cloudflare/sandbox", ...)
    // on top of this. Real Sandbox SDK behavior is exercised in the workerd
    // integration test pool, not here.
    setupFiles: ["./src/test/setup-cloudflare-sandbox-mock.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/index.ts", "src/test/**"],
    },
  },
});
