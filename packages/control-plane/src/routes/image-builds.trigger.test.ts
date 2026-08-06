import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSandbox } from "@cloudflare/sandbox";
import { createRequestMetrics } from "../db/instrumented-d1";
import { ImageBuildStore } from "../db/image-builds";
import { RepoMetadataStore } from "../db/repo-metadata";
import { CloudflareSandboxProvider } from "../sandbox/providers/cloudflare-provider";
import { imageBuildRoutes } from "./image-builds";
import type { Env } from "../types";
import type { RequestContext, Route } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { RepositoryAccessResult } from "../source-control";
import type * as SourceControlModule from "../source-control";
import type * as IntegrationSettingsResolutionModule from "../session/integration-settings-resolution";

// The repo trigger resolves the repo's actual default branch (never assumes
// "main") and threads it into the build's repository set + fingerprint + the
// build backend. The #757 regression hardcoded "main" in the build backend,
// so these tests pin the resolved branch reaching the Cloudflare backend, and
// that a repo which can't be resolved fails instead of building "main". The
// toggle tests pin the save-hook parity change: toggling a repo's prebuild on
// triggers a build immediately instead of waiting for the cron.

const scmProvider = vi.hoisted(() => ({
  checkRepositoryAccess: vi.fn(),
  generateCredentialHelperAuth: vi.fn(),
}));

const integrationSettings = vi.hoisted(() => ({
  resolveSandboxSettings: vi.fn(),
}));

const finalizationQueue = {
  send: vi.fn(async () => undefined),
} as unknown as Queue;

vi.mock("../source-control", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceControlModule>();
  return {
    ...actual,
    createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
  };
});

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

vi.mock("../session/integration-settings-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof IntegrationSettingsResolutionModule>();
  return {
    ...actual,
    resolveSandboxSettings: integrationSettings.resolveSandboxSettings,
  };
});

const TRIGGER_PATH = "/image-builds/trigger/repo/acme/repo";
const TOGGLE_PATH = "/image-builds/toggle/repo/acme/repo";

function findRoute(method: string, path: string): Route {
  // Match on method as well as pattern so a same-pattern route of another
  // method (or a reordering) can never resolve to the wrong handler.
  const route = imageBuildRoutes.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path)
  );
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function matchFor(route: Route, path: string): RegExpMatchArray {
  const match = path.match(route.pattern);
  if (!match) throw new Error("path did not match route pattern");
  return match;
}

function createContext(waitUntilTasks?: Promise<unknown>[]): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    db: {} as SqlDatabase,
    metrics: createRequestMetrics(),
    executionCtx: {
      waitUntil: (task: Promise<unknown>) => {
        waitUntilTasks?.push(task);
      },
    } as unknown as ExecutionContext,
  };
}

function createCloudflareEnv(): Env {
  return {
    DB: {} as unknown as D1Database,
    SANDBOX: {} as unknown as Env["SANDBOX"],
    SCM_PROVIDER: "github",
    WORKER_URL: "https://cp.test",
    CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET: "code-server-secret",
    IMAGE_BUILD_FINALIZATION_QUEUE: finalizationQueue,
    IMAGE_CALLBACK_TOKEN_PEPPER: "test-callback-pepper",
  } as Env;
}

async function callTrigger(env: Env): Promise<Response> {
  const route = findRoute("POST", TRIGGER_PATH);
  return route.handler(
    new Request(`https://test.local${TRIGGER_PATH}`, { method: "POST" }),
    env,
    matchFor(route, TRIGGER_PATH),
    createContext()
  );
}

async function callToggle(
  env: Env,
  body: unknown,
  waitUntilTasks?: Promise<unknown>[]
): Promise<Response> {
  const route = findRoute("PUT", TOGGLE_PATH);
  return route.handler(
    new Request(`https://test.local${TOGGLE_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    matchFor(route, TOGGLE_PATH),
    createContext(waitUntilTasks)
  );
}

const RESOLVED_REPO: RepositoryAccessResult = {
  repoId: 123,
  repoOwner: "acme",
  repoName: "repo",
  defaultBranch: "develop",
};

const REPO_REPOSITORIES = [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }];

// Spy the store boundary so the tests assert the typed contracts rather than
// the store's SQL text or bound-argument order.
const registerBuildSpy = vi.spyOn(ImageBuildStore.prototype, "registerBuild");
const getActiveBuildSpy = vi.spyOn(ImageBuildStore.prototype, "getActiveBuild");
const hasReadyImageSpy = vi.spyOn(ImageBuildStore.prototype, "hasReadyImageForFingerprint");
const markBuildFailedSpy = vi.spyOn(ImageBuildStore.prototype, "markBuildFailed");
const bindProviderSessionSpy = vi.spyOn(ImageBuildStore.prototype, "bindProviderSession");
const setImageBuildEnabledSpy = vi.spyOn(RepoMetadataStore.prototype, "setImageBuildEnabled");
const triggerImageBuildSpy = vi.spyOn(CloudflareSandboxProvider.prototype, "triggerImageBuild");

function mockGetSandbox() {
  return getSandbox as unknown as ReturnType<typeof vi.fn>;
}

function createMockSandbox() {
  return {
    startProcess: vi.fn(async () => ({ id: "process-1" })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registerBuildSpy.mockResolvedValue(true);
  getActiveBuildSpy.mockResolvedValue(null);
  hasReadyImageSpy.mockResolvedValue(false);
  markBuildFailedSpy.mockResolvedValue(true);
  setImageBuildEnabledSpy.mockResolvedValue(undefined);
  bindProviderSessionSpy.mockResolvedValue(true);
  mockGetSandbox().mockReturnValue(createMockSandbox());
  integrationSettings.resolveSandboxSettings.mockResolvedValue({});
  scmProvider.generateCredentialHelperAuth.mockResolvedValue({
    username: "x-access-token",
    password: "clone-token",
  });
});

describe("POST /image-builds/trigger/repo/:owner/:name", () => {
  it("threads the resolved default branch into the Cloudflare build backend", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);

    const response = await callTrigger(createCloudflareEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: expect.stringContaining("imgb-acme-repo-"),
      status: "building",
      alreadyBuilding: false,
    });

    // Resolution is keyed off the path params, not a hardcoded branch.
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "repo",
    });

    // The resolved branch — not "main" — reaches the Cloudflare backend as the
    // one-element repository set...
    expect(triggerImageBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ repositories: REPO_REPOSITORIES })
    );
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1);
    expect(scmProvider.generateCredentialHelperAuth).toHaveBeenCalled();
    expect(bindProviderSessionSpy).toHaveBeenCalledWith(
      expect.stringContaining("imgb-acme-repo-"),
      "cloudflare",
      expect.any(String)
    );

    // ...and is baked into the persisted fingerprint.
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "repo", id: "acme/repo" },
        provider: "cloudflare",
        repositoriesFingerprint: expect.any(String),
      })
    );
  });

  it("resolves the repo's sandbox settings without an environment layer and clamps the timeout", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    integrationSettings.resolveSandboxSettings.mockResolvedValue({ buildTimeoutSeconds: 5000 });
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);

    const response = await callTrigger(createCloudflareEnv());

    expect(response.status).toBe(200);
    expect(integrationSettings.resolveSandboxSettings).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "repo"
    );
    // 5000s requested clamps to the shared provider-session ceiling.
    expect(triggerImageBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerSessionTimeoutSeconds: expect.any(Number) })
    );
    const [{ providerSessionTimeoutSeconds }] = triggerImageBuildSpy.mock.calls[0];
    expect(providerSessionTimeoutSeconds).toBeLessThan(5000);
  });

  it("reports the in-flight build instead of stacking another", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    getActiveBuildSpy.mockResolvedValue({ id: "imgb-acme-repo-existing" });
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);

    const response = await callTrigger(createCloudflareEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      buildId: "imgb-acme-repo-existing",
      status: "building",
      alreadyBuilding: true,
    });
    expect(registerBuildSpy).not.toHaveBeenCalled();
    expect(sandbox.startProcess).not.toHaveBeenCalled();
  });

  it("returns 404 without building when the repository is not installed", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);

    const response = await callTrigger(createCloudflareEnv());

    expect(response.status).toBe(404);
    expect(sandbox.startProcess).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });

  it("returns 500 without building when repository resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);

    const response = await callTrigger(createCloudflareEnv());

    expect(response.status).toBe(500);
    expect(sandbox.startProcess).not.toHaveBeenCalled();
    expect(registerBuildSpy).not.toHaveBeenCalled();
  });
});

describe("PUT /image-builds/toggle/repo/:owner/:name", () => {
  it("writes the flag and triggers a stale-checked build on toggle-on", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createCloudflareEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enabled: true });
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", true);

    // Save-hook parity with environments: the detached triggerBuildIfStale
    // runs behind waitUntil.
    expect(waitUntilTasks).toHaveLength(1);
    await Promise.all(waitUntilTasks);
    expect(registerBuildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "repo", id: "acme/repo" } })
    );
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1);
  });

  it("skips the build when a ready image already matches the repository set", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(RESOLVED_REPO);
    hasReadyImageSpy.mockResolvedValue(true);
    const sandbox = createMockSandbox();
    mockGetSandbox().mockReturnValue(sandbox);
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createCloudflareEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(200);
    await Promise.all(waitUntilTasks);
    expect(registerBuildSpy).not.toHaveBeenCalled();
    expect(sandbox.startProcess).not.toHaveBeenCalled();
  });

  it("writes the flag without triggering on toggle-off", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createCloudflareEnv(), { enabled: false }, waitUntilTasks);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, enabled: false });
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", false);
    expect(waitUntilTasks).toHaveLength(0);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean enabled", async () => {
    const response = await callToggle(createCloudflareEnv(), { enabled: "yes" });

    expect(response.status).toBe(400);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
  });

  it("returns 404 without writing the flag when enabling an uninstalled repo", async () => {
    scmProvider.checkRepositoryAccess.mockResolvedValue(null);
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createCloudflareEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(404);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
    expect(waitUntilTasks).toHaveLength(0);
  });

  it("returns 500 without writing the flag when enabling and resolution fails", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));
    const waitUntilTasks: Promise<unknown>[] = [];

    const response = await callToggle(createCloudflareEnv(), { enabled: true }, waitUntilTasks);

    expect(response.status).toBe(500);
    expect(setImageBuildEnabledSpy).not.toHaveBeenCalled();
    expect(waitUntilTasks).toHaveLength(0);
  });

  it("disables without resolving so an unresolvable repo stays disableable", async () => {
    scmProvider.checkRepositoryAccess.mockRejectedValue(new Error("github unavailable"));

    const response = await callToggle(createCloudflareEnv(), { enabled: false });

    expect(response.status).toBe(200);
    expect(setImageBuildEnabledSpy).toHaveBeenCalledWith("acme", "repo", false);
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
  });
});
