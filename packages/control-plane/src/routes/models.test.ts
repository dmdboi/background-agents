import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_OPTIONS } from "@open-inspect/shared/models";
import type { Env } from "../types";
import type { RequestContext } from "./shared";
import { modelsRoutes } from "./models";
import type * as ModelsDevSync from "../models-dev/sync";

const { mockCacheGet, mockCachePut, mockFetchModelsDevCatalog, mockLogger } = vi.hoisted(() => ({
  mockCacheGet: vi.fn(),
  mockCachePut: vi.fn(),
  mockFetchModelsDevCatalog: vi.fn(),
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@open-inspect/shared/cache-store", () => ({
  createKvCacheStore: vi.fn(() => ({ get: mockCacheGet, put: mockCachePut })),
}));

vi.mock("../models-dev/sync", async () => {
  const actual = await vi.importActual<typeof ModelsDevSync>("../models-dev/sync");
  return { ...actual, fetchModelsDevCatalog: mockFetchModelsDevCatalog };
});

vi.mock("../logger", () => ({ createLogger: vi.fn(() => mockLogger) }));

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as RequestContext["db"],
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function getHandler() {
  const route = modelsRoutes.find(
    (candidate) => candidate.method === "GET" && candidate.pattern.test("/models/catalog")
  );
  if (!route) throw new Error("No models catalog route found");
  const match = "/models/catalog".match(route.pattern);
  if (!match) throw new Error("Route did not match /models/catalog");
  return { handler: route.handler, match };
}

describe("models catalog route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCachePut.mockResolvedValue(undefined);
    mockFetchModelsDevCatalog.mockResolvedValue({});
  });

  it("populates the cache synchronously on a cold cache and returns the static catalog", async () => {
    const { handler, match } = getHandler();
    const response = await handler(
      new Request("https://test.local/models/catalog"),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ categories: MODEL_OPTIONS, cached: false });
    expect(mockCachePut).toHaveBeenCalledTimes(1);
  });

  it("serves stale cache immediately and refreshes in the background", async () => {
    mockCacheGet.mockResolvedValue({
      categories: MODEL_OPTIONS,
      cachedAt: "2020-01-01T00:00:00.000Z",
      freshUntil: 0,
    });
    const waitUntil = vi.fn();
    const { handler, match } = getHandler();

    const response = await handler(
      new Request("https://test.local/models/catalog"),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      {
        ...createContext(),
        executionCtx: { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ cached: true });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.not.toThrow();
  });

  it("falls back to the static catalog when models.dev fetch fails", async () => {
    mockFetchModelsDevCatalog.mockRejectedValue(new Error("network down"));
    const { handler, match } = getHandler();

    const response = await handler(
      new Request("https://test.local/models/catalog"),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ categories: MODEL_OPTIONS });
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
