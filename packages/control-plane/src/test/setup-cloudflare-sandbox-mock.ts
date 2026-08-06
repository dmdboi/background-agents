/**
 * Global stub for `@cloudflare/sandbox` in the Node-environment unit-test
 * pool. The real package's `@cloudflare/containers` dependency imports the
 * "cloudflare:workers" builtin, which only exists in the actual workerd
 * runtime — loading it under plain Node throws at import time. Since
 * `provider-factory.ts` now imports `cloudflare-provider.ts` unconditionally,
 * every unit test transitively pulls this in even when it has nothing to do
 * with the sandbox provider, so the stub is applied globally rather than
 * per-file. Tests that actually exercise Cloudflare-provider behavior
 * (`cloudflare-provider.test.ts`) layer a more detailed `vi.mock` on top.
 */
import { vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(() => {
    throw new Error(
      "@cloudflare/sandbox is stubbed in Node-environment unit tests; " +
        "this test needs its own vi.mock('@cloudflare/sandbox', ...) if it " +
        "exercises sandbox-provider behavior."
    );
  }),
}));
