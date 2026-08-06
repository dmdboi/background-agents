import { describe, expect, it } from "vitest";
import { getPublicSandboxProvider, supportsRepoImages } from "./sandbox-provider";

describe("sandbox-provider", () => {
  it("is always cloudflare", () => {
    expect(getPublicSandboxProvider()).toBe("cloudflare");
  });

  it("always supports repo images", () => {
    expect(supportsRepoImages()).toBe(true);
  });
});
