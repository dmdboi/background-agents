import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

const OAUTH_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OAUTH_CONCURRENT_ROTATION_DELAY_MS = 500;

/**
 * Where a session's OAuth tokens are read from and rotated back to. A
 * session reads from its own secret scope first — the environment for
 * environment-launched sessions, the repo for repo-launched ones (§6.4/§7.4) —
 * then falls back to global. Each variant carries everything needed to write
 * the rotated tokens back to the same place, so refresh never has to re-derive
 * the identity.
 */
export type TokenSecretSource =
  | { kind: "environment"; environmentId: string }
  | { kind: "repo"; repoId: number; repoOwner: string; repoName: string }
  | { kind: "global" };

type TokenState<TExtra extends Record<string, unknown>> =
  | { type: "cached"; accessToken: string; expiresIn: number; extra: TExtra }
  | { type: "refresh"; refreshToken: string; source: TokenSecretSource };

export type OAuthTokenRefreshResult<TExtra extends Record<string, unknown>> =
  | ({ ok: true; accessToken: string; expiresIn?: number } & TExtra)
  | { ok: false; status: number; error: string };

/**
 * Per-provider glue for {@link OAuthTokenRefreshService}. Everything about
 * *how* a session's OAuth token gets read, cached, and rotated back is
 * identical between providers — only the token endpoint, secret key names,
 * and the odd extra claim (e.g. OpenAI's account id) differ.
 */
export interface OAuthProviderAdapter<
  TTokens,
  TExtra extends Record<string, unknown> = Record<string, never>,
> {
  /** Used in log lines, e.g. "OpenAI" / "xAI". */
  providerLabel: string;
  secretKeys: { refreshToken: string; accessToken: string; expiresAt: string };
  defaultTokenLifetimeMs: number;
  refresh: (refreshToken: string) => Promise<TTokens>;
  isUnauthorizedError: (error: unknown) => boolean;
  getAccessToken: (tokens: TTokens) => string;
  getRefreshToken: (tokens: TTokens, previousRefreshToken: string) => string;
  getExpiresInSeconds: (tokens: TTokens) => number | undefined;
  extractExtra: (tokens: TTokens) => TExtra;
  extraFromSecrets: (secrets: Record<string, string>) => TExtra;
  extraToSecrets: (extra: TExtra) => Record<string, string>;
}

export class OAuthTokenRefreshService<TTokens, TExtra extends Record<string, unknown>> {
  constructor(
    private readonly adapter: OAuthProviderAdapter<TTokens, TExtra>,
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {}

  async refresh(session: SessionRow): Promise<OAuthTokenRefreshResult<TExtra>> {
    const readTokenState = () => this.readTokenState(session);

    let tokenState: TokenState<TExtra> | null;
    try {
      tokenState = await readTokenState();
    } catch (e) {
      this.log.error(`Failed to read ${this.adapter.providerLabel} token state from secrets`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }

    if (!tokenState) {
      return {
        ok: false,
        status: 404,
        error: `${this.adapter.secretKeys.refreshToken} not configured`,
      };
    }

    if (tokenState.type === "cached") {
      return {
        ok: true,
        accessToken: tokenState.accessToken,
        expiresIn: tokenState.expiresIn,
        ...tokenState.extra,
      };
    }

    try {
      return await this.attemptRefresh(tokenState);
    } catch (e) {
      if (this.adapter.isUnauthorizedError(e)) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState);
      }

      this.log.error(`${this.adapter.providerLabel} token refresh failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        status: 502,
        error: `${this.adapter.providerLabel} token refresh failed`,
      };
    }
  }

  private getTokenStateFromSecrets(
    secrets: Record<string, string>,
    source: TokenSecretSource
  ): TokenState<TExtra> | null {
    const {
      refreshToken: refreshTokenKey,
      accessToken: accessTokenKey,
      expiresAt: expiresAtKey,
    } = this.adapter.secretKeys;

    const refreshToken = secrets[refreshTokenKey];
    if (!refreshToken) {
      return null;
    }

    const cachedToken = secrets[accessTokenKey];
    const expiresAt = parseInt(secrets[expiresAtKey] || "0", 10);
    const now = Date.now();

    if (cachedToken && expiresAt - now > OAUTH_TOKEN_REFRESH_BUFFER_MS) {
      return {
        type: "cached",
        accessToken: cachedToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
        extra: this.adapter.extraFromSecrets(secrets),
      };
    }

    return { type: "refresh", refreshToken, source };
  }

  /**
   * The session's own secret source, or null for repo-less sessions with no
   * environment (global-only). Environment-launched sessions resolve to the
   * environment and never read member repo secrets (§6.4/§7.4).
   */
  private async resolveSessionSecretSource(session: SessionRow): Promise<TokenSecretSource | null> {
    if (session.environment_id) {
      return { kind: "environment", environmentId: session.environment_id };
    }
    if (session.repo_owner && session.repo_name) {
      const repoId = await this.ensureRepoId(session);
      return {
        kind: "repo",
        repoId,
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
      };
    }
    return null;
  }

  private async readSecretsForSource(source: TokenSecretSource): Promise<Record<string, string>> {
    switch (source.kind) {
      case "environment":
        return new EnvironmentSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(
          source.environmentId
        );
      case "repo":
        return new RepoSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets(source.repoId);
      case "global":
        return new GlobalSecretsStore(this.db, this.encryptionKey).getDecryptedSecrets();
    }
  }

  private async writeSecretsForSource(
    source: TokenSecretSource,
    secrets: Record<string, string>
  ): Promise<void> {
    switch (source.kind) {
      case "environment":
        await new EnvironmentSecretsStore(this.db, this.encryptionKey).setSecrets(
          source.environmentId,
          secrets
        );
        return;
      case "repo":
        await new RepoSecretsStore(this.db, this.encryptionKey).setSecrets(
          source.repoId,
          source.repoOwner,
          source.repoName,
          secrets
        );
        return;
      case "global":
        await new GlobalSecretsStore(this.db, this.encryptionKey).setSecrets(secrets);
        return;
    }
  }

  private async readTokenState(session: SessionRow): Promise<TokenState<TExtra> | null> {
    const source = await this.resolveSessionSecretSource(session);
    if (source) {
      const secrets = await this.readSecretsForSource(source);
      const state = this.getTokenStateFromSecrets(secrets, source);
      if (state) {
        return state;
      }
    }

    const globalSecrets = await this.readSecretsForSource({ kind: "global" });
    return this.getTokenStateFromSecrets(globalSecrets, { kind: "global" });
  }

  private async attemptRefresh(
    tokenState: Extract<TokenState<TExtra>, { type: "refresh" }>
  ): Promise<OAuthTokenRefreshResult<TExtra>> {
    const tokens = await this.adapter.refresh(tokenState.refreshToken);
    const extra = this.adapter.extractExtra(tokens);
    const expiresIn =
      this.adapter.getExpiresInSeconds(tokens) ?? this.adapter.defaultTokenLifetimeMs / 1000;
    const expiresAt = Date.now() + expiresIn * 1000;

    try {
      const secretsToWrite: Record<string, string> = {
        [this.adapter.secretKeys.refreshToken]: this.adapter.getRefreshToken(
          tokens,
          tokenState.refreshToken
        ),
        [this.adapter.secretKeys.accessToken]: this.adapter.getAccessToken(tokens),
        [this.adapter.secretKeys.expiresAt]: String(expiresAt),
        ...this.adapter.extraToSecrets(extra),
      };

      await this.writeSecretsForSource(tokenState.source, secretsToWrite);

      this.log.info(`${this.adapter.providerLabel} tokens rotated and cached`, {
        source: tokenState.source.kind,
      });
    } catch (e) {
      this.log.error(
        `${this.adapter.providerLabel} token refreshed but failed to persist rotated tokens`,
        {
          source: tokenState.source.kind,
          error: e instanceof Error ? e.message : String(e),
        }
      );
    }

    return {
      ok: true,
      accessToken: this.adapter.getAccessToken(tokens),
      expiresIn,
      ...extra,
    };
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<TokenState<TExtra>, { type: "refresh" }>,
    readTokenState: () => Promise<TokenState<TExtra> | null>
  ): Promise<OAuthTokenRefreshResult<TExtra>> {
    this.log.warn(
      `${this.adapter.providerLabel} refresh was rejected, checking for concurrent rotation`,
      {
        source: tokenState.source.kind,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, OAUTH_CONCURRENT_ROTATION_DELAY_MS));

    try {
      const reread = await readTokenState();

      if (reread?.type === "cached") {
        this.log.info("Using cached access token from concurrent rotation");
        return {
          ok: true,
          accessToken: reread.accessToken,
          expiresIn: reread.expiresIn,
          ...reread.extra,
        };
      }

      if (reread?.type === "refresh" && reread.refreshToken !== tokenState.refreshToken) {
        this.log.info("Detected concurrent token rotation, retrying");
        return this.attemptRefresh(reread);
      }
    } catch (retryErr) {
      this.log.error(`Retry after ${this.adapter.providerLabel} 401 also failed`, {
        error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      });
    }

    return {
      ok: false,
      status: 401,
      error: `${this.adapter.providerLabel} token refresh failed: unauthorized`,
    };
  }
}
