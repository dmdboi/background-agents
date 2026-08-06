import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { createSandboxProviderFromEnv } from "./provider-factory";
import { CloudflareSandboxProvider } from "./providers/cloudflare-provider";

function createEnv(overrides: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    MEDIA_BUCKET: {} as R2Bucket,
    TOKEN_ENCRYPTION_KEY: "test-token-key",
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

describe("createSandboxProviderFromEnv", () => {
  it("constructs a CloudflareSandboxProvider when the SANDBOX binding and secret are present", () => {
    const env = createEnv({
      SANDBOX: {} as Env["SANDBOX"],
      CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET: "test-secret-key",
    });

    const provider = createSandboxProviderFromEnv(env);

    expect(provider).toBeInstanceOf(CloudflareSandboxProvider);
    expect(provider.name).toBe("cloudflare");
  });

  it("throws when the SANDBOX Durable Object binding is missing", () => {
    const env = createEnv({
      CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET: "test-secret-key",
    });

    expect(() => createSandboxProviderFromEnv(env)).toThrow(
      "SANDBOX Durable Object binding is required"
    );
  });

  it("throws when the code-server password secret is missing", () => {
    const env = createEnv({
      SANDBOX: {} as Env["SANDBOX"],
    });

    expect(() => createSandboxProviderFromEnv(env)).toThrow(
      "CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET is required"
    );
  });
});
