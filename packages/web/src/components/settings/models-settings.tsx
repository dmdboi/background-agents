"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { DEFAULT_ENABLED_MODELS, type ModelCategory } from "@open-inspect/shared/models";
import {
  MODEL_PREFERENCES_KEY,
  useEnabledModels,
  useModelCatalog,
} from "@/hooks/use-enabled-models";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const SECRETS_KEY = "/api/secrets";

/**
 * Inline "set the provider's API key" field for a model category whose
 * models authenticate via a plain secret (see ModelCategory.apiKeyEnvVar).
 * Reads/writes the same global secrets store as Settings > Secrets, scoped
 * to this one env var name.
 */
function ProviderApiKeyField({ envVar }: { envVar: string }) {
  const { data, isLoading } = useSWR<{ secrets: { key: string }[] }>(SECRETS_KEY);
  const isSet = data?.secrets?.some((s) => s.key === envVar) ?? false;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const res = await browserApiFetch(SECRETS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { [envVar]: value } }),
      });
      if (res.ok) {
        toast.success(`${envVar} saved`);
        mutate(SECRETS_KEY);
        setEditing(false);
        setValue("");
      } else {
        const data = await res.json();
        toast.error(data.error || `Failed to save ${envVar}`);
      }
    } catch {
      toast.error(`Failed to save ${envVar}`);
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return null;

  if (!editing) {
    return (
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-muted-foreground">
          Requires <code className="font-mono">{envVar}</code>
          {isSet ? " — set globally" : " — not set"}
        </span>
        <Button type="button" variant="subtle" size="xs" onClick={() => setEditing(true)}>
          {isSet ? "Change key" : "Set key"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={envVar}
        className="flex-1 min-w-[200px] h-auto px-2 py-1 text-xs"
      />
      <Button type="button" variant="outline" size="xs" onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </Button>
      <Button
        type="button"
        variant="subtle"
        size="xs"
        onClick={() => {
          setEditing(false);
          setValue("");
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

export function ModelsSettings() {
  const { enabledModels: storedEnabledModels, loading } = useEnabledModels();
  const categories = useModelCatalog();
  const [enabledModels, setEnabledModels] = useState<Set<string>>(
    () => new Set(DEFAULT_ENABLED_MODELS)
  );
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Sync SWR data into local state once on initial load
  if (!loading && !initialized) {
    setEnabledModels(new Set(storedEnabledModels));
    setInitialized(true);
  }

  const toggleModel = (modelId: string) => {
    setEnabledModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        if (next.size <= 1) return prev;
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
    setDirty(true);
  };

  const toggleCategory = (category: ModelCategory, enable: boolean) => {
    setEnabledModels((prev) => {
      const next = new Set(prev);
      for (const model of category.models) {
        if (enable) {
          next.add(model.id);
        } else {
          next.delete(model.id);
        }
      }
      if (next.size === 0) return prev;
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);

    try {
      const res = await browserApiFetch("/api/model-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModels: Array.from(enabledModels) }),
      });

      if (res.ok) {
        mutate(MODEL_PREFERENCES_KEY);
        toast.success("Model preferences saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save preferences");
      }
    } catch {
      toast.error("Failed to save preferences");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading model preferences...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Enabled Models</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Choose which models appear in the model selector across the web UI and Slack bot.
      </p>

      <div className="space-y-6">
        {categories.map((group) => {
          const allEnabled = group.models.every((m) => enabledModels.has(m.id));

          return (
            <div key={group.category}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-foreground uppercase tracking-wider">
                  {group.category}
                </h3>
                <Button
                  type="button"
                  variant="subtle"
                  size="xs"
                  onClick={() => toggleCategory(group, !allEnabled)}
                  className="text-accent hover:text-accent/80"
                >
                  {allEnabled ? "Disable all" : "Enable all"}
                </Button>
              </div>
              {group.apiKeyEnvVar && <ProviderApiKeyField envVar={group.apiKeyEnvVar} />}
              <div className="space-y-2">
                {group.models.map((model) => {
                  const isEnabled = enabledModels.has(model.id);
                  return (
                    <label
                      key={model.id}
                      htmlFor={`model-toggle-${model.id}`}
                      className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer"
                    >
                      <div>
                        <span className="text-sm font-medium text-foreground">{model.name}</span>
                        <span className="text-sm text-muted-foreground ml-2">
                          {model.description}
                        </span>
                      </div>
                      <Switch
                        id={`model-toggle-${model.id}`}
                        checked={isEnabled}
                        onCheckedChange={() => toggleModel(model.id)}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
