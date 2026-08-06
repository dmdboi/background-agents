/**
 * Model catalog route — serves the curated model list with live
 * name/description metadata overlaid from models.dev, cached in KV.
 */
import { MODEL_OPTIONS, type ModelCategory } from "@open-inspect/shared/models";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { fetchModelsDevCatalog, mergeModelOptionsWithModelsDev } from "../models-dev/sync";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { type Route, type RequestContext, parsePattern, json } from "./shared";

const logger = createLogger("router:models");

const MODELS_CACHE_KEY = "models-dev:catalog:v1";
const MODELS_CACHE_FRESH_MS = 5 * 60 * 1000; // Serve without revalidation for 5 minutes
const MODELS_CACHE_KV_TTL_SECONDS = 3600; // Keep stale data in KV for 1 hour

interface CachedModelCatalog {
  categories: ModelCategory[];
  cachedAt: string;
  freshUntil: number;
}

/**
 * Fetch models.dev, merge with the curated catalog, and write to KV.
 * Never throws — a models.dev failure just means the cache keeps (or starts
 * with) the static bundled metadata.
 */
async function refreshModelsCache(env: Env, traceId?: string): Promise<CachedModelCatalog> {
  let categories: ModelCategory[] = MODEL_OPTIONS;
  try {
    const catalog = await fetchModelsDevCatalog();
    categories = mergeModelOptionsWithModelsDev(catalog);
  } catch (e) {
    logger.warn("Failed to fetch models.dev, serving static model metadata", {
      trace_id: traceId,
      error: e instanceof Error ? e : String(e),
    });
  }

  const cachedAt = new Date().toISOString();
  const freshUntil = Date.now() + MODELS_CACHE_FRESH_MS;
  const cached: CachedModelCatalog = { categories, cachedAt, freshUntil };

  try {
    await createKvCacheStore(env.REPOS_CACHE).put(MODELS_CACHE_KEY, JSON.stringify(cached), {
      expirationTtl: MODELS_CACHE_KV_TTL_SECONDS,
    });
  } catch (e) {
    logger.warn("Failed to write models catalog cache", {
      trace_id: traceId,
      error: e instanceof Error ? e : String(e),
    });
  }

  return cached;
}

/**
 * Refresh the models.dev-backed cache. Exported for the scheduled (cron) tick.
 */
export async function runModelsDevSync(env: Env): Promise<void> {
  await refreshModelsCache(env);
}

async function handleGetModelsCatalog(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const cacheStore = createKvCacheStore(env.REPOS_CACHE);

  let cached: CachedModelCatalog | null = null;
  try {
    cached = await cacheStore.get<CachedModelCatalog>(MODELS_CACHE_KEY, "json");
  } catch (e) {
    logger.warn("Failed to read models catalog cache", {
      trace_id: ctx.trace_id,
      error: e instanceof Error ? e : String(e),
    });
  }

  if (cached) {
    const isFresh = Date.now() < cached.freshUntil;
    if (!isFresh && ctx.executionCtx) {
      ctx.executionCtx.waitUntil(refreshModelsCache(env, ctx.trace_id));
    }
    return json({ categories: cached.categories, cached: true, cachedAt: cached.cachedAt });
  }

  const refresh = refreshModelsCache(env, ctx.trace_id);
  ctx.executionCtx?.waitUntil(refresh);
  const result = await refresh;

  return json({ categories: result.categories, cached: false, cachedAt: result.cachedAt });
}

export const modelsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/models/catalog"),
    handler: handleGetModelsCatalog,
  },
];
