import { describe, expect, it, vi } from "vitest";
import type { CloudflareSandboxProvider } from "../sandbox/providers/cloudflare-provider";
import { CloudflareImageBuildAdapter } from "./cloudflare-adapter";
import type { ImageBuildPlan } from "./types";

function createProvider(): CloudflareSandboxProvider {
  return {
    triggerImageBuild: vi.fn(async () => undefined),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "cf-backup-1" })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as CloudflareSandboxProvider;
}

function createPlan(buildTimeoutMs = 1_800_001): ImageBuildPlan {
  return {
    // ImageBuildProvider's union is widened here — the "cloudflare" member
    // itself is added to that type in a later wiring step (provider-factory.ts,
    // out of scope for this change), but ImageBuildPlan.provider is not read
    // by CloudflareImageBuildAdapter, so the shape is what matters for the test.
    provider: "cloudflare" as ImageBuildPlan["provider"],
    buildId: "build-1",
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    callbackToken: "callback-token",
    cloneAuth: {
      type: "credential_helper",
      host: "github.com",
      username: "x-access-token",
      token: "clone-token",
    },
    buildTimeoutMs,
    userEnvVars: { FOO: "bar" },
    correlation: {
      request_id: "request-1",
      trace_id: "trace-1",
    },
  };
}

describe("CloudflareImageBuildAdapter", () => {
  it("starts builds through the Cloudflare provider capability", async () => {
    const provider = createProvider();
    const adapter = new CloudflareImageBuildAdapter(provider);
    const bindProviderSession = vi.fn();

    await adapter.startBuild(createPlan(), { bindProviderSession });

    expect(provider.triggerImageBuild).toHaveBeenCalledWith({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "callback-token",
      cloneToken: "clone-token",
      buildExecutionTimeoutSeconds: 1801,
      providerSessionTimeoutSeconds: 2401,
      userEnvVars: { FOO: "bar" },
      onProviderSessionCreated: bindProviderSession,
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
    });
  });

  it("snapshots (backs up) and then explicitly tears down completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new CloudflareImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    const result = await adapter.finalizeSuccessfulBuild({
      buildId: "build-1",
      providerSessionId: "build-env-acme-repo",
      correlation,
    });

    expect(result).toEqual({
      providerImageId: "cf-backup-1",
      providerSessionId: "build-env-acme-repo",
    });
    expect(provider.takeSnapshot).toHaveBeenCalledWith({
      providerObjectId: "build-env-acme-repo",
      sessionId: "build-1",
      reason: "environment_image_build",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "build-env-acme-repo",
      },
      signal: undefined,
    });
    expect(provider.stopSandbox).not.toHaveBeenCalled();

    await adapter.cleanupCompletedBuild?.({
      buildId: "build-1",
      providerSessionId: "build-env-acme-repo",
      correlation,
    });
    expect(provider.stopSandbox).toHaveBeenCalledWith({
      providerObjectId: "build-env-acme-repo",
      sessionId: "build-1",
      reason: "environment_image_build_complete",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "build-env-acme-repo",
      },
    });
  });

  it("tears down failed build sandboxes too", async () => {
    const provider = createProvider();
    const adapter = new CloudflareImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.cleanupFailedBuild({
      buildId: "build-1",
      providerSessionId: "build-env-acme-repo",
      errorMessage: "boom",
      correlation,
    });

    expect(provider.stopSandbox).toHaveBeenCalledWith({
      providerObjectId: "build-env-acme-repo",
      sessionId: "build-1",
      reason: "environment_image_build_complete",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "build-env-acme-repo",
      },
    });
  });

  it("throws when the provider reports it could not stop the sandbox", async () => {
    const provider = createProvider();
    (provider.stopSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "destroy failed",
    });
    const adapter = new CloudflareImageBuildAdapter(provider);

    await expect(
      adapter.cleanupCompletedBuild({
        buildId: "build-1",
        providerSessionId: "build-env-acme-repo",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.toThrow("destroy failed");
  });

  it("deletes provider images through the Cloudflare provider capability", async () => {
    const provider = createProvider();
    const adapter = new CloudflareImageBuildAdapter(provider);

    await adapter.deleteImage({
      image: { providerImageId: "cf-backup-1", providerSessionId: "ignored-session" },
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("cf-backup-1");
  });
});
