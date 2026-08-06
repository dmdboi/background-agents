import type { Env } from "../types";
import type { ImageBuildProvider } from "./model";

/**
 * Central provider policy for image-build support.
 *
 * Cloudflare is the only supported provider, and it always supports image
 * builds, so this is a constant rather than a lookup — kept as a named
 * function so callers don't need to know that.
 */
export function getImageBuildsUnsupportedMessage(_env: Env): string | null {
  return null;
}

export function resolveImageBuildProvider(): ImageBuildProvider {
  return "cloudflare";
}
