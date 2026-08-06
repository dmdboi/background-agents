import { useMemo } from "react";
import useSWR from "swr";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  normalizeValidModels,
  type ModelCategory,
} from "@open-inspect/shared/models";

export const MODEL_PREFERENCES_KEY = "/api/model-preferences";
export const MODEL_CATALOG_KEY = "/api/models/catalog";

interface ModelPreferencesResponse {
  enabledModels: string[];
}

interface ModelCatalogResponse {
  categories: ModelCategory[];
}

/**
 * Model catalog with live name/description from models.dev, falling back to
 * the static bundled catalog while loading or if the endpoint is unreachable.
 */
export function useModelCatalog(): ModelCategory[] {
  const { data } = useSWR<ModelCatalogResponse>(MODEL_CATALOG_KEY, {
    fallbackData: { categories: MODEL_OPTIONS },
  });
  return data?.categories ?? MODEL_OPTIONS;
}

export function useEnabledModels() {
  const { data, isLoading } = useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);
  const categories = useModelCatalog();

  const enabledModels = useMemo<string[]>(() => {
    if (isLoading) return [];
    const normalized = normalizeValidModels(
      Array.isArray(data?.enabledModels) ? data.enabledModels : []
    );
    return normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
  }, [data?.enabledModels, isLoading]);

  const enabledModelOptions: ModelCategory[] = useMemo(() => {
    const enabledSet = new Set(enabledModels);
    return categories
      .map((group) => ({
        ...group,
        models: group.models.filter((m) => enabledSet.has(m.id)),
      }))
      .filter((group) => group.models.length > 0);
  }, [enabledModels, categories]);

  return { enabledModels, enabledModelOptions, loading: isLoading };
}
