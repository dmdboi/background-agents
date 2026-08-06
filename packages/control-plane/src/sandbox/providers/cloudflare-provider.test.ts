/**
 * Unit tests for CloudflareSandboxProvider.
 *
 * Mocks `@cloudflare/sandbox`'s `getSandbox()` to return a fake Sandbox stub,
 * since the SDK addresses sandboxes via a Durable Object binding rather than
 * a REST client. Covers env-var assembly, create/restore/backup/destroy, the
 * image-build trigger's callback-env ordering, and error classification.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { getSandbox } from "@cloudflare/sandbox";
import { CloudflareSandboxProvider, type CloudflareProviderConfig } from "./cloudflare-provider";
import { SandboxProviderError } from "../provider";
import type { CreateSandboxConfig, RestoreConfig, SnapshotConfig, StopConfig } from "../provider";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

// ==================== Mock Factories ====================

function createMockSandbox(
  overrides: Partial<{
    exec: ReturnType<typeof vi.fn>;
    startProcess: ReturnType<typeof vi.fn>;
    createBackup: ReturnType<typeof vi.fn>;
    restoreBackup: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    exposePort: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, success: true })),
    startProcess: vi.fn(async () => ({ id: "process-1" })),
    createBackup: vi.fn(async () => ({ id: "backup-abc", dir: "/workspace" })),
    restoreBackup: vi.fn(async () => ({ success: true, dir: "/workspace", id: "backup-abc" })),
    destroy: vi.fn(async () => undefined),
    exposePort: vi.fn(async (port: number) => ({
      url: `https://${port}-sandbox-preview.test.example`,
      port,
      name: undefined,
    })),
    ...overrides,
  };
}

const defaultProviderConfig: CloudflareProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "test-secret-key",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseRestoreConfig: RestoreConfig = {
  snapshotImageId: "backup-abc",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  sandboxAuthToken: "auth-token-abc",
  controlPlaneUrl: "https://control-plane.test",
  repoOwner: "testowner",
  repoName: "testrepo",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseSnapshotConfig: SnapshotConfig = {
  providerObjectId: "sandbox-456",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

const baseStopConfig: StopConfig = {
  providerObjectId: "sandbox-456",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

function mockGetSandbox() {
  return getSandbox as unknown as ReturnType<typeof vi.fn>;
}

// ==================== Tests ====================

describe("CloudflareSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);
      expect(provider.name).toBe("cloudflare");
      expect(provider.capabilities).toEqual({
        supportsSandboxTimeout: false,
        supportsSnapshots: true,
        supportsRestore: true,
        supportsPersistentResume: false,
        supportsExplicitStop: true,
      });
    });
  });

  describe("createSandbox", () => {
    it("happy path: launches the runtime with assembled env vars", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("sandbox-456");
      expect(result.status).toBe("running");
      expect(result.createdAt).toBeGreaterThan(0);

      expect(sandbox.startProcess).toHaveBeenCalledTimes(1);
      const [command, options] = sandbox.startProcess.mock.calls[0];
      expect(command).toContain("sandbox_runtime.entrypoint");
      expect(options.cwd).toBe("/workspace");

      const envVars = options.env;
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
      expect(envVars.CONTROL_PLANE_URL).toBe("https://control-plane.test");
      expect(envVars.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
      expect(envVars.VCS_HOST).toBe("github.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("x-access-token");

      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig).toEqual({
        session_id: "session-123",
        repo_owner: "testowner",
        repo_name: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("skips preview URLs (with a warning) when SANDBOX_PREVIEW_DOMAIN is unset", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      const result = await provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
      });

      expect(sandbox.exposePort).not.toHaveBeenCalled();
      expect(result.codeServerUrl).toBeUndefined();
    });

    it("exposes code-server and tunnel ports when a preview domain is configured", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, {
        ...defaultProviderConfig,
        previewDomain: "preview.example.com",
      });

      const result = await provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
        sandboxSettings: { tunnelPorts: [9000] },
      });

      expect(sandbox.exposePort).toHaveBeenCalledWith(8080, { hostname: "preview.example.com" });
      expect(sandbox.exposePort).toHaveBeenCalledWith(9000, { hostname: "preview.example.com" });
      expect(result.codeServerUrl).toBe("https://8080-sandbox-preview.test.example");
      expect(result.codeServerPassword).toBeTruthy();
      expect(result.tunnelUrls).toEqual({ "9000": "https://9000-sandbox-preview.test.example" });
    });

    it("wraps failures in a classified SandboxProviderError", async () => {
      const sandbox = createMockSandbox({
        startProcess: vi.fn(async () => {
          throw new Error("fetch failed: network error");
        }),
      });
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      await expect(provider.createSandbox(baseCreateConfig)).rejects.toBeInstanceOf(
        SandboxProviderError
      );
      await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
        errorType: "transient",
      });
    });
  });

  describe("restoreFromSnapshot", () => {
    it("restores the backup then relaunches the runtime", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      const result = await provider.restoreFromSnapshot(baseRestoreConfig);

      expect(result.success).toBe(true);
      expect(result.sandboxId).toBe("sandbox-456");
      expect(sandbox.restoreBackup).toHaveBeenCalledWith({
        id: "backup-abc",
        dir: "/workspace",
      });
      expect(sandbox.startProcess).toHaveBeenCalledTimes(1);
      const envVars = sandbox.startProcess.mock.calls[0][1].env;
      expect(envVars.RESTORED_FROM_SNAPSHOT).toBe("true");
    });

    it("throws a permanent error when the backup restore reports failure", async () => {
      const sandbox = createMockSandbox({
        restoreBackup: vi.fn(async () => ({ success: false, dir: "/workspace", id: "backup-abc" })),
      });
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      await expect(provider.restoreFromSnapshot(baseRestoreConfig)).rejects.toMatchObject({
        errorType: "permanent",
      });
      expect(sandbox.startProcess).not.toHaveBeenCalled();
    });
  });

  describe("takeSnapshot", () => {
    it("creates a backup and returns its id as the image id", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      const result = await provider.takeSnapshot(baseSnapshotConfig);

      expect(result).toEqual({ success: true, imageId: "backup-abc" });
      expect(sandbox.createBackup).toHaveBeenCalledWith(
        expect.objectContaining({ dir: "/workspace" })
      );
    });

    it("classifies backup failures as SandboxProviderError", async () => {
      const sandbox = createMockSandbox({
        createBackup: vi.fn(async () => {
          throw new Error("HTTP 503");
        }),
      });
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      await expect(provider.takeSnapshot(baseSnapshotConfig)).rejects.toBeInstanceOf(
        SandboxProviderError
      );
    });
  });

  describe("stopSandbox", () => {
    it("destroys the sandbox", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result).toEqual({ success: true });
      expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe("triggerImageBuild", () => {
    it("binds the provider session before launching, and only the launch call carries the callback env", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      const onProviderSessionCreated = vi.fn(async () => {});
      const callOrder: string[] = [];
      onProviderSessionCreated.mockImplementation(async () => {
        callOrder.push("bind");
      });
      sandbox.startProcess.mockImplementation(async () => {
        callOrder.push("launch");
        return { id: "process-1" };
      });

      await provider.triggerImageBuild({
        buildId: "build-1",
        scopeKind: "environment",
        scopeId: "env-1",
        repositories: [{ repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" }],
        callbackUrl: "https://control-plane.test/callback",
        failureCallbackUrl: "https://control-plane.test/callback/failure",
        callbackToken: "callback-token-xyz",
        buildExecutionTimeoutSeconds: 600,
        providerSessionTimeoutSeconds: 900,
        onProviderSessionCreated,
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      });

      expect(callOrder).toEqual(["bind", "launch"]);
      expect(onProviderSessionCreated).toHaveBeenCalledWith("build-env-env-1");

      expect(sandbox.startProcess).toHaveBeenCalledTimes(1);
      const envVars = sandbox.startProcess.mock.calls[0][1].env;
      expect(envVars.OI_REPO_IMAGE_BUILD_ID).toBe("build-1");
      expect(envVars.OI_REPO_IMAGE_CALLBACK_URL).toBe("https://control-plane.test/callback");
      expect(envVars.OI_REPO_IMAGE_FAILURE_CALLBACK_URL).toBe(
        "https://control-plane.test/callback/failure"
      );
      expect(envVars.OI_REPO_IMAGE_CALLBACK_TOKEN).toBe("callback-token-xyz");
      expect(envVars.OI_REPO_IMAGE_PROVIDER_SESSION_ID).toBe("build-env-env-1");
      expect(envVars.IMAGE_BUILD_MODE).toBe("true");
    });

    it("propagates a permanent failure if binding the provider session throws", async () => {
      const sandbox = createMockSandbox();
      mockGetSandbox().mockReturnValue(sandbox);
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);

      await expect(
        provider.triggerImageBuild({
          buildId: "build-1",
          scopeKind: "environment",
          scopeId: "env-1",
          repositories: [{ repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" }],
          callbackUrl: "https://control-plane.test/callback",
          failureCallbackUrl: "https://control-plane.test/callback/failure",
          callbackToken: "callback-token-xyz",
          buildExecutionTimeoutSeconds: 600,
          providerSessionTimeoutSeconds: 900,
          onProviderSessionCreated: vi.fn(async () => {
            throw new Error("D1 write failed");
          }),
          correlation: { request_id: "request-1", trace_id: "trace-1" },
        })
      ).rejects.toBeInstanceOf(SandboxProviderError);
      expect(sandbox.startProcess).not.toHaveBeenCalled();
    });
  });

  describe("deleteProviderImage", () => {
    it("is a no-op (no documented backup-deletion API), and does not throw", async () => {
      const provider = new CloudflareSandboxProvider({} as never, defaultProviderConfig);
      await expect(provider.deleteProviderImage("backup-abc")).resolves.toBeUndefined();
    });
  });
});
