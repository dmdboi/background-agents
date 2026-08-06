import { refreshXaiToken, XaiTokenRefreshError, type XaiTokenResponse } from "../auth/xai";
import type { OAuthProviderAdapter } from "./oauth-token-refresh-service";

export const xaiOAuthAdapter: OAuthProviderAdapter<XaiTokenResponse, Record<string, never>> = {
  providerLabel: "xAI",
  secretKeys: {
    refreshToken: "XAI_OAUTH_REFRESH_TOKEN",
    accessToken: "XAI_OAUTH_ACCESS_TOKEN",
    expiresAt: "XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  },
  defaultTokenLifetimeMs: 60 * 60 * 1000,
  refresh: refreshXaiToken,
  isUnauthorizedError: (e) =>
    e instanceof XaiTokenRefreshError &&
    (e.reason === "invalid_grant" || e.reason === "unauthorized"),
  getAccessToken: (tokens) => tokens.access_token,
  getRefreshToken: (tokens, previousRefreshToken) => tokens.refresh_token || previousRefreshToken,
  getExpiresInSeconds: (tokens) => tokens.expires_in,
  extractExtra: () => ({}),
  extraFromSecrets: () => ({}),
  extraToSecrets: () => ({}),
};
