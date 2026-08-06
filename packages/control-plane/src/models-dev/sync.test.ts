import { describe, expect, it } from "vitest";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "@open-inspect/shared/models";
import { fetchModelsDevCatalog, mergeModelOptionsWithModelsDev } from "./sync";

const [defaultProvider, defaultModelId] = DEFAULT_MODEL.split("/");

describe("mergeModelOptionsWithModelsDev", () => {
  it("overlays name and description for a model present in the models.dev response", () => {
    const merged = mergeModelOptionsWithModelsDev({
      [defaultProvider]: {
        id: defaultProvider,
        models: {
          [defaultModelId]: { id: defaultModelId, name: "Live Name", description: "Live desc" },
        },
      },
    });

    const model = merged.flatMap((group) => group.models).find((m) => m.id === DEFAULT_MODEL);
    expect(model).toMatchObject({ name: "Live Name", description: "Live desc" });
  });

  it("falls back to the static bundled metadata when a model is missing from models.dev", () => {
    const merged = mergeModelOptionsWithModelsDev({});
    expect(merged).toEqual(MODEL_OPTIONS);
  });

  it("falls back for an unknown provider without dropping the model", () => {
    const merged = mergeModelOptionsWithModelsDev({
      "some-other-provider": { id: "x", models: {} },
    });
    expect(merged).toEqual(MODEL_OPTIONS);
  });

  it("keeps the static name when models.dev omits it", () => {
    const merged = mergeModelOptionsWithModelsDev({
      [defaultProvider]: {
        id: defaultProvider,
        models: { [defaultModelId]: { id: defaultModelId, description: "Live desc only" } },
      },
    });

    const staticModel = MODEL_OPTIONS.flatMap((g) => g.models).find((m) => m.id === DEFAULT_MODEL)!;
    const model = merged.flatMap((group) => group.models).find((m) => m.id === DEFAULT_MODEL);
    expect(model).toMatchObject({ name: staticModel.name, description: "Live desc only" });
  });
});

describe("fetchModelsDevCatalog", () => {
  it("throws when the response is not ok", async () => {
    const fetchImpl = async () => new Response("", { status: 503 });
    await expect(fetchModelsDevCatalog(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      "models.dev fetch failed: 503"
    );
  });

  it("returns the parsed JSON body on success", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ anthropic: { id: "anthropic", models: {} } }), { status: 200 });
    await expect(fetchModelsDevCatalog(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      anthropic: { id: "anthropic", models: {} },
    });
  });
});
