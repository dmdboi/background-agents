import {
  createCloudflareProvider,
  type CloudflareSandboxProvider,
} from "./providers/cloudflare-provider";
import type { Env } from "../types";

/**
 * Construct the sandbox provider from `Env`.
 *
 * Cloudflare is the only supported sandbox provider — see the migration plan
 * for why Modal/Daytona/Vercel/OpenComputer/E2B were removed.
 */
export function createSandboxProviderFromEnv(env: Env): CloudflareSandboxProvider {
  return createCloudflareProvider(env);
}
