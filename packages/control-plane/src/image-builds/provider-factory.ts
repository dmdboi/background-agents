import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { CloudflareImageBuildAdapter } from "./cloudflare-adapter";
import type { ImageBuildProvider } from "./model";
import type { ImageBuildAdapter } from "./types";

/**
 * Composition boundary for image-build provider adapters.
 *
 * Cloudflare is the only supported provider now; `create()` keeps its
 * `provider`/`operation` signature for call-site stability (image-build
 * records still carry a `provider` column) but the value is otherwise
 * unused — there is nothing left to switch on.
 */
export interface ImageBuildAdapterFactory {
  create(provider: ImageBuildProvider, operation: "start" | "existing_session"): ImageBuildAdapter;
}

export function createImageBuildAdapterFactory(env: Env): ImageBuildAdapterFactory {
  return new EnvImageBuildAdapterFactory(env);
}

class EnvImageBuildAdapterFactory implements ImageBuildAdapterFactory {
  constructor(private readonly env: Env) {}

  create(
    _provider: ImageBuildProvider,
    _operation: "start" | "existing_session"
  ): ImageBuildAdapter {
    return new CloudflareImageBuildAdapter(createSandboxProviderFromEnv(this.env));
  }
}
