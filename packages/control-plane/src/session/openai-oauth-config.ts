import {
  refreshOpenAIToken,
  extractOpenAIAccountId,
  OpenAITokenRefreshError,
  type OpenAITokenResponse,
} from "../auth/openai";
import type { OAuthProviderAdapter } from "./oauth-token-refresh-service";

export interface OpenAIOAuthExtra extends Record<string, unknown> {
  accountId?: string;
}

export const openAiOAuthAdapter: OAuthProviderAdapter<OpenAITokenResponse, OpenAIOAuthExtra> = {
  providerLabel: "OpenAI",
  secretKeys: {
    refreshToken: "OPENAI_OAUTH_REFRESH_TOKEN",
    accessToken: "OPENAI_OAUTH_ACCESS_TOKEN",
    expiresAt: "OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  },
  defaultTokenLifetimeMs: 60 * 60 * 1000,
  refresh: refreshOpenAIToken,
  isUnauthorizedError: (e) => e instanceof OpenAITokenRefreshError && e.status === 401,
  getAccessToken: (tokens) => tokens.access_token,
  getRefreshToken: (tokens) => tokens.refresh_token,
  getExpiresInSeconds: (tokens) => tokens.expires_in,
  extractExtra: (tokens) => ({ accountId: extractOpenAIAccountId(tokens) }),
  extraFromSecrets: (secrets) => ({ accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID }),
  extraToSecrets: (extra) =>
    extra.accountId ? { OPENAI_OAUTH_ACCOUNT_ID: extra.accountId } : ({} as Record<string, string>),
};
