/**
 * models.dev is the live source of truth for model *display metadata*
 * (name, description) — not for which models we offer. The curated model
 * ids, categories, and defaults in `@open-inspect/shared/models` stay
 * human-maintained (sandbox/tool-call compatibility is a judgment call);
 * this module only overlays fresher labels on top of that static list.
 */
import { MODEL_OPTIONS, type ModelCategory } from "@open-inspect/shared/models";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
/** Hourly refresh — MUST match the third entry in wrangler.jsonc's `triggers.crons`. */
export const MODELS_DEV_SYNC_CRON = "23 * * * *";
const MODELS_DEV_FETCH_TIMEOUT_MS = 5000;

interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
}

interface ModelsDevProvider {
  id: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** Fetch the raw models.dev catalog. Throws on network/HTTP failure. */
export async function fetchModelsDevCatalog(
  fetchImpl: typeof fetch = fetch
): Promise<ModelsDevCatalog> {
  const response = await fetchImpl(MODELS_DEV_API_URL, {
    signal: AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`models.dev fetch failed: ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") {
    throw new Error("models.dev returned an unexpected response shape");
  }
  return data as ModelsDevCatalog;
}

/**
 * Merge live models.dev name/description onto the curated `MODEL_OPTIONS`
 * list. Any model missing from `catalog` (unknown provider, renamed model,
 * or a partial/malformed response) keeps its static bundled metadata —
 * this never throws and never drops a curated model.
 */
export function mergeModelOptionsWithModelsDev(catalog: ModelsDevCatalog): ModelCategory[] {
  return MODEL_OPTIONS.map((group) => ({
    ...group,
    models: group.models.map((model) => {
      const [provider, ...modelIdParts] = model.id.split("/");
      const live = catalog[provider]?.models?.[modelIdParts.join("/")];
      if (!live) return model;
      return {
        ...model,
        name: live.name ?? model.name,
        description: live.description ?? model.description,
      };
    }),
  }));
}
