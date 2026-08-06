/**
 * Public sandbox backend helpers for the web app.
 *
 * Cloudflare is the only supported sandbox provider now; these stay as
 * functions (rather than inlined constants) so call sites don't need to know
 * that.
 */

export type PublicSandboxProvider = "cloudflare";

export function getPublicSandboxProvider(): PublicSandboxProvider {
  return "cloudflare";
}

export function supportsRepoImages(): boolean {
  return true;
}
