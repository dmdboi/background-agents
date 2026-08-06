/**
 * Cloudflare Sandbox provider — wraps the `@cloudflare/sandbox` SDK.
 *
 * Unlike the REST-style providers (Daytona, OpenComputer, Vercel, E2B), there
 * is no separate REST client: `getSandbox()` returns a Durable-Object-backed
 * stub synchronously (no network round trip — the container starts lazily on
 * first operation), and every lifecycle operation is a method call on that
 * stub. The stub is addressed by the logical sandbox id itself, so unlike the
 * REST providers there is no separate provider-assigned object id — the
 * `providerObjectId` returned to callers is always the same string as the
 * `sandboxId`/`sessionId` used to create it.
 *
 * The Worker that deploys this provider must `export { Sandbox } from
 * "@cloudflare/sandbox"` and declare the `containers`/`durable_objects`
 * bindings in wrangler config — that wiring is a later step, not done here.
 *
 * Env-var isolation between concurrent `exec()`/`startProcess()` calls on the
 * same sandbox is not documented as a hard security boundary by Cloudflare —
 * treat it as best-effort process isolation, not a trust boundary.
 */

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import { resolveScmProviderFromEnv, type SourceControlProviderName } from "../../source-control";
import type { Env } from "../../types";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
} from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ImageBuildProviderTriggerConfig,
  type RestoreConfig,
  type RestoreResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("cloudflare-provider");

/**
 * Working directory every sandbox clones/builds into. Fixed by the runtime
 * image (matches the `/workspace` convention shared by every other
 * provider). Backups are taken and restored against this same directory, so
 * a bare backup id — the only thing persisted as `SnapshotResult.imageId` /
 * `RestoreConfig.snapshotImageId` — is enough to reconstruct the
 * `DirectoryBackup` handle `restoreBackup()` needs.
 */
const SANDBOX_WORKSPACE_DIR = "/workspace";

/** Command that launches the long-running agent runtime inside the container. */
const RUNTIME_ENTRYPOINT_COMMAND = "python -m sandbox_runtime.entrypoint";

export interface CloudflareProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for HMAC derivation of code-server passwords. */
  codeServerPasswordSecret: string;
  /**
   * Wildcard custom domain backing `exposePort()` preview URLs
   * (`SANDBOX_PREVIEW_DOMAIN`). Preview URLs are skipped (with a warning)
   * when unset — `.workers.dev` does not support the required wildcard
   * subdomain routing.
   */
  previewDomain?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare";

  readonly capabilities: SandboxProviderCapabilities = {
    // No provider-enforced sandbox TTL is confirmed by the SDK; the control
    // plane's own inactivity/execution timeouts are what bound sandbox life.
    supportsSandboxTimeout: false,
    supportsSnapshots: true,
    supportsRestore: true,
    // Sandboxes sleep after inactivity and resume implicitly on the next
    // operation through getSandbox() — there is no separate explicit-resume
    // call to wire up here.
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly binding: DurableObjectNamespace<Sandbox>,
    private readonly providerConfig: CloudflareProviderConfig
  ) {}

  // -----------------------------------------------------------------------
  // SandboxProvider interface
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const sandbox = getSandbox(this.binding, config.sandboxId);
      const envVars = await this.buildEnvVars(config, {
        fromPrebuiltImage: !!config.prebuiltImageId,
        prebuiltImageSha: config.prebuiltImageSha ?? undefined,
      });

      await sandbox.startProcess(RUNTIME_ENTRYPOINT_COMMAND, {
        cwd: SANDBOX_WORKSPACE_DIR,
        env: envVars,
      });

      const access = await this.buildTunnelUrls(
        sandbox,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        status: "running",
        createdAt: Date.now(),
        ...access,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Cloudflare sandbox", error);
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const sandbox = getSandbox(this.binding, config.sandboxId);
      const envVars = await this.buildEnvVars(config, { restoredFromSnapshot: true });

      const restored = await sandbox.restoreBackup({
        id: config.snapshotImageId,
        dir: SANDBOX_WORKSPACE_DIR,
      });
      if (!restored.success) {
        throw new SandboxProviderError(
          `Cloudflare backup restore did not succeed for backup id=${config.snapshotImageId}`,
          "permanent"
        );
      }

      await sandbox.startProcess(RUNTIME_ENTRYPOINT_COMMAND, {
        cwd: SANDBOX_WORKSPACE_DIR,
        env: envVars,
      });

      const access = await this.buildTunnelUrls(
        sandbox,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings
      );

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        ...access,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to restore Cloudflare sandbox from backup", error);
    }
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const sandbox = getSandbox(this.binding, config.providerObjectId);
      const backup = await sandbox.createBackup({
        dir: SANDBOX_WORKSPACE_DIR,
        name: `${config.sessionId}-${config.reason}`,
      });
      return { success: true, imageId: backup.id };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to back up Cloudflare sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      const sandbox = getSandbox(this.binding, config.providerObjectId);
      await sandbox.destroy();
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to destroy Cloudflare sandbox", error);
    }
  }

  /**
   * Trigger a Cloudflare environment-image build (design §7.3 equivalent).
   *
   * `getSandbox()` is synchronous and lazy, so — unlike the REST providers —
   * there is no separate "create" round trip to bind the provider session id
   * against. The provider session id is deterministic (it's the same
   * `sandboxId` used to address the Durable Object), but the callback
   * contract's ordering rule still applies at the call-site level: the id is
   * bound in D1 via `onProviderSessionCreated` *before* the env carrying
   * `OI_REPO_IMAGE_CALLBACK_TOKEN` (and the other four callback vars) is
   * attached to the single `startProcess()` call that launches the build —
   * never baked in at an earlier "creation" step, since none exists here.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    try {
      const identity = imageBuildSandboxIdentity(config, Date.now());
      const sandbox = getSandbox(this.binding, identity.sandboxId);

      await config.onProviderSessionCreated(identity.sandboxId);

      const envVars = this.buildImageBuildEnvVars(config, identity.sandboxId);

      await sandbox.startProcess(RUNTIME_ENTRYPOINT_COMMAND, {
        cwd: SANDBOX_WORKSPACE_DIR,
        env: envVars,
      });

      log.info("cloudflare.environment_image_build_triggered", {
        ...config.correlation,
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: identity.sandboxId,
      });
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger Cloudflare environment image build", error);
    }
  }

  /**
   * Delete a build's backup artifact.
   *
   * The `@cloudflare/sandbox` SDK (as of 0.12.4) exposes `createBackup()` /
   * `restoreBackup()` but no documented backup-deletion API — backups are
   * garbage-collected by their own `ttl` (default 3 days) instead. This is a
   * best-effort no-op rather than a throw, so image-build cleanup and
   * superseded-image reaping don't fail the whole workflow over a artifact
   * that will expire on its own; it logs so operators can see it happened.
   */
  async deleteProviderImage(providerImageId: string): Promise<void> {
    log.warn("cloudflare.delete_provider_image_unsupported", {
      provider_image_id: providerImageId,
    });
  }

  // -----------------------------------------------------------------------
  // Env var assembly
  // -----------------------------------------------------------------------

  private async buildEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromPrebuiltImage?: boolean;
      prebuiltImageSha?: string;
    } = {}
  ): Promise<Record<string, string>> {
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      codeServerPassword: config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.codeServerPasswordSecret
          )
        : undefined,
    });

    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromPrebuiltImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.prebuiltImageSha ?? "";
    }

    return envVars;
  }

  /**
   * Build-sandbox env assembly plus the callback-contract overlay. Unlike
   * OpenComputer (which bakes the callback env at create time) this mirrors
   * Vercel: the callback vars — including `OI_REPO_IMAGE_PROVIDER_SESSION_ID`,
   * now known — are only attached to the env of the `startProcess()` call
   * that actually launches the build runtime.
   */
  private buildImageBuildEnvVars(
    config: ImageBuildProviderTriggerConfig,
    sandboxId: string
  ): Record<string, string> {
    const envVars = buildImageBuildEnvVars({
      sandboxId,
      repositories: config.repositories,
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      cloneToken: config.cloneToken,
      baseEnvVars: config.userEnvVars,
    });

    Object.assign(
      envVars,
      buildImageBuildCallbackEnv({
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        token: config.callbackToken,
        providerSessionId: sandboxId,
      }),
      { [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds) }
    );

    return envVars;
  }

  // -----------------------------------------------------------------------
  // Preview URLs
  // -----------------------------------------------------------------------

  private async buildTunnelUrls(
    sandbox: Sandbox,
    logicalSandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    if (!this.providerConfig.previewDomain) {
      if (codeServerEnabled || resolveTunnelPorts(sandboxSettings?.tunnelPorts).length > 0) {
        log.warn("cloudflare.preview_domain_not_configured", { sandbox_id: logicalSandboxId });
      }
      return {};
    }

    const previewDomain = this.providerConfig.previewDomain;
    const { codeServerPort } = resolveServicePorts(sandboxSettings);
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;

    if (codeServerEnabled) {
      const exposed = await sandbox.exposePort(codeServerPort, { hostname: previewDomain });
      codeServerUrl = exposed.url;
      codeServerPassword = await deriveCodeServerPassword(
        logicalSandboxId,
        this.providerConfig.codeServerPasswordSecret
      );
      tunnelPorts = tunnelPorts.filter((port) => port !== codeServerPort);
    }

    let tunnelUrls: Record<string, string> | undefined;
    if (tunnelPorts.length > 0) {
      const entries = await Promise.all(
        tunnelPorts.map(async (port) => {
          const exposed = await sandbox.exposePort(port, { hostname: previewDomain });
          return [String(port), exposed.url] as const;
        })
      );
      tunnelUrls = Object.fromEntries(entries);
    }

    return { codeServerUrl, codeServerPassword, tunnelUrls };
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private classifyError(message: string, error: unknown): SandboxProviderError {
    return SandboxProviderError.fromFetchError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link CloudflareSandboxProvider} from `Env`. `SANDBOX` is the
 * Durable Object binding for the `@cloudflare/sandbox` `Sandbox` class,
 * wired up by Terraform/wrangler config in a later step. `options` lets
 * callers override individual provider-config fields (used by tests) without
 * threading every env var through by hand.
 */
export function createCloudflareProvider(
  env: Env,
  options: Partial<CloudflareProviderConfig> = {}
): CloudflareSandboxProvider {
  const binding = env.SANDBOX;
  if (!binding) {
    throw new SandboxProviderError(
      "SANDBOX Durable Object binding is required when SANDBOX_PROVIDER=cloudflare",
      "permanent"
    );
  }

  const codeServerPasswordSecret =
    options.codeServerPasswordSecret ?? env.CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET;
  if (!codeServerPasswordSecret) {
    throw new SandboxProviderError(
      "CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET is required when SANDBOX_PROVIDER=cloudflare",
      "permanent"
    );
  }

  return new CloudflareSandboxProvider(binding, {
    scmProvider: options.scmProvider ?? resolveScmProviderFromEnv(env.SCM_PROVIDER),
    codeServerPasswordSecret,
    previewDomain: options.previewDomain ?? env.SANDBOX_PREVIEW_DOMAIN,
  });
}
