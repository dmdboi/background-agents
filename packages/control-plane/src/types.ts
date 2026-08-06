/**
 * Type definitions for Open-Inspect Control Plane.
 */

import type {
  ArtifactType,
  MessageSource,
  MessageStatus,
  ParticipantRole,
  SessionStatus,
} from "@open-inspect/shared";
import { z } from "zod";
import type { Sandbox } from "@cloudflare/sandbox";
import type { ImageBuildFinalizationJob } from "./image-builds/finalization-job";

export type {
  ArtifactType,
  CreateSessionRequest,
  CreateSessionResponse,
  EventResponse,
  EventType,
  GitSyncStatus,
  ListEventsResponse,
  MessageSource,
  MessageStatus,
  ParticipantRole,
  ParticipantPresence,
  SpawnSource,
  SandboxEvent,
  SandboxStatus,
  SessionState,
  SessionStatus,
} from "@open-inspect/shared";
export type { SessionRepositoryState } from "@open-inspect/shared/types/repositories";
export type { ServerMessage } from "@open-inspect/shared/types/server-messages";
export type {
  SessionAttachmentReference,
  ResolvedSessionAttachment,
} from "@open-inspect/shared/types/session-attachments";
export type { ClientMessage } from "@open-inspect/shared/types/websocket";

// Environment bindings
export interface Env {
  // Durable Objects
  SESSION: DurableObjectNamespace;
  // @cloudflare/sandbox Durable Object binding — only present when
  // SANDBOX_PROVIDER=cloudflare. Wired up by Terraform/wrangler config
  // alongside the Worker's `export { Sandbox } from "@cloudflare/sandbox"`.
  SANDBOX?: DurableObjectNamespace<Sandbox>;

  // KV Namespaces
  REPOS_CACHE: KVNamespace; // Short-lived cache for /repos listing

  // Service bindings
  SLACK_BOT?: Fetcher; // Optional - only if slack-bot is deployed

  // Durable Objects
  SCHEDULER?: DurableObjectNamespace; // SchedulerDO for automation engine

  // D1 database
  DB: D1Database;

  // Durable callback-to-finalizer handoff for provider-session image builds.
  IMAGE_BUILD_FINALIZATION_QUEUE?: Queue<ImageBuildFinalizationJob>;

  // R2 buckets
  MEDIA_BUCKET: R2Bucket;

  // Secrets
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BROWSER_AUTH_SECRET?: string;
  TOKEN_ENCRYPTION_KEY: string;
  REPO_SECRETS_ENCRYPTION_KEY?: string;
  ANTHROPIC_API_KEY?: string; // Anthropic API key for Claude models
  // Pepper for image-build callback token hashes.
  IMAGE_CALLBACK_TOKEN_PEPPER?: string;
  // Per-service sig1 verification keys. Absent ⇒ that service cannot
  // authenticate.
  SERVICE_AUTH_SECRET_WEB?: string;
  SERVICE_AUTH_SECRET_SLACK_BOT?: string;
  SERVICE_AUTH_SECRET_GITHUB_BOT?: string;
  SLACK_BOT_TOKEN?: string; // Slack bot token for agent-initiated chat.postMessage calls

  // GitHub App secrets (for git operations)
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;

  // GitLab secrets (for git operations and API access when SCM_PROVIDER=gitlab)
  GITLAB_ACCESS_TOKEN?: string;
  GITLAB_NAMESPACE?: string; // Group namespace to scope repository listing

  // Variables
  DEPLOYMENT_NAME: string;
  APP_NAME?: string; // Display name for user-visible UI, PR footers, and HTTP User-Agent headers
  SCM_PROVIDER?: string; // Source control provider for this deployment (default: github)
  WORKER_URL?: string; // Base URL for the worker (for callbacks)
  WEB_APP_URL?: string; // Base URL for the web app (for PR links)
  ALLOWED_USERS?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_EMAILS?: string;
  ALLOWED_GITHUB_ORGS?: string;
  UNSAFE_ALLOW_ALL_USERS?: string;
  CF_ACCOUNT_ID?: string; // Cloudflare account ID

  // Wildcard custom domain backing @cloudflare/sandbox exposePort() preview URLs
  // (code-server, ttyd, tunnel ports). Required for code-server/tunnel access
  // when SANDBOX_PROVIDER=cloudflare — .workers.dev doesn't support the
  // wildcard subdomain routing exposePort() needs.
  SANDBOX_PREVIEW_DOMAIN?: string;
  // Secret used for HMAC derivation of code-server passwords on the Cloudflare
  // sandbox provider (mirrors *_API_KEY reuse on the REST-style providers,
  // which have no equivalent secret of their own).
  CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET?: string;

  // Sandbox lifecycle configuration
  SANDBOX_INACTIVITY_TIMEOUT_MS?: string; // Inactivity timeout in ms (default: 600000 = 10 min)
  EXECUTION_TIMEOUT_MS?: string; // Max processing time before auto-fail (default: 5400000 = 90 min)
  SECRETS_CAP_ENFORCEMENT?: string; // "enforce" (default) fails spawn/build on oversized secret payloads; set "warn" to only log

  // Logging
  LOG_LEVEL?: string; // "debug" | "info" | "warn" | "error" (default: "info")
}

// Client info (stored in DO memory)
export interface ClientInfo {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
  clientId: string;
  ws: WebSocket;
  lastFetchHistoryAt?: number;
}

export interface SessionResponse {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  branchName: string | null;
  baseSha: string | null;
  currentSha: string | null;
  opencodeSessionId: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ListSessionsResponse {
  sessions: SessionResponse[];
  total: number;
  hasMore: boolean;
}

export interface MessageResponse {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  status: MessageStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ArtifactResponse {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface ParticipantResponse {
  id: string;
  userId: string;
  canonicalUserId?: string | null;
  scmLogin: string | null;
  scmName: string | null;
  role: ParticipantRole;
  joinedAt: number;
}

// GitHub OAuth types
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export const githubTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export type GitHubTokenResponse = z.infer<typeof githubTokenResponseSchema>;
